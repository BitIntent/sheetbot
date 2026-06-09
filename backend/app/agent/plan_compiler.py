# backend/app/agent/plan_compiler.py
"""
确定性计划编译器 -- 将结构化分析计划编译为 Excel 操作序列

架构定位：
  LLM 只决定"分析什么"（维度、指标、聚合方式）。
  本模块决定"怎么执行"（行位置、图表锚点、数据范围、排版布局）。
  所有布局参数由编译器内部常量控制，不受 LLM 输出波动影响。

确定性保证：
  相同 plan + 相同 excel_state → 100% 相同的 operations 序列。
  无随机性、无模型依赖、无外部状态。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .plan_contract import AnalysisPlan, AnalysisBlock


# =====================================================================
#  布局常量（确定性，不可被 LLM 修改）
# =====================================================================

_TARGET_SHEET = "综合分析"
_BANNER_START_COL = 1
_BLOCK_GAP_ROWS = 3                # 块间空行数
_SUMMARY_PADDING_ROWS = 2         # 汇总表尾部留白（总计行 + 空行缓冲）
_CHART_ANCHOR_COL_OFFSET = 2       # 图表锚列 = 数据区最右列 + offset
_CHART_WIDTH = 600
_CHART_HEIGHT = 400
_INSIGHT_TITLE = "关键发现"
_INSIGHT_MAX_ITEMS = 3
_MAX_GROUPS_ESTIMATE = 24          # 分组数上限估算（压缩布局，降低图表与统计间距）

# 图表类型自动选择阈值
_CHART_AUTO_THRESHOLDS = {
    "bar": 6,        # <= 6 类别用水平条形
    "column": 20,    # <= 20 类别用柱状
    "line": 80,      # <= 80 类别用折线
    "area": 999,     # 更大用面积
}

_TEMPORAL_COL_RE = re.compile(
    r"(日期|时间|年月|月份|月|周|星期|季度|年|date|time|month|week|quarter|year)",
    re.IGNORECASE,
)
_RATIO_COL_RE = re.compile(
    r"(占比|比例|份额|比率|渗透率|转化率|增长率|rate|ratio|percent|pct|share)",
    re.IGNORECASE,
)


# =====================================================================
#  工具函数
# =====================================================================

def _col_num_to_letter(n: int) -> str:
    """列号（1-based）转 Excel 列字母"""
    out = []
    while n > 0:
        n, rem = divmod(n - 1, 26)
        out.append(chr(65 + rem))
    return "".join(reversed(out))


def _is_number_like(value: Any) -> bool:
    """宽松数值判定（兼容字符串数字）"""
    if isinstance(value, (int, float)):
        return True
    if value is None:
        return False
    s = str(value).strip().replace(",", "")
    if not s:
        return False
    try:
        float(s)
        return True
    except ValueError:
        return False


def _is_temporal_like(value: Any) -> bool:
    """时间值判定（yyyy-mm / yyyy/mm / yyyy年m月 / Q1 等）"""
    if value is None:
        return False
    s = str(value).strip()
    if not s:
        return False
    temporal_patterns = (
        r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$",
        r"^\d{4}年\d{1,2}月(\d{1,2}日)?$",
        r"^\d{1,2}月(\d{1,2}日)?$",
        r"^\d{4}Q[1-4]$",
        r"^Q[1-4]$",
        r"^\d{4}年$",
    )
    return any(re.match(p, s) for p in temporal_patterns)


def _extract_col_samples(sample_rows: List[List[Any]], col_num: int, limit: int = 30) -> List[Any]:
    """从 sampleData 提取指定列样本值（col_num 为 1-based）"""
    if not sample_rows or col_num <= 0:
        return []
    idx = col_num - 1
    out: List[Any] = []
    for row in sample_rows:
        if not isinstance(row, list) or idx >= len(row):
            continue
        v = row[idx]
        if v is None or str(v).strip() == "":
            continue
        out.append(v)
        if len(out) >= limit:
            break
    return out


def _estimate_group_rows(total_rows: int, group_samples: List[Any]) -> int:
    """
    估算汇总后分组行数（用于 chart dataRange 高度预算）。
    优先依赖样本去重率，避免对大明细表一刀切按 60 行预算。
    """
    safe_total = max(1, int(total_rows or 1))
    if not group_samples:
        return min(safe_total, _MAX_GROUPS_ESTIMATE)
    non_empty = [str(v).strip() for v in group_samples if str(v).strip()]
    if not non_empty:
        return min(safe_total, _MAX_GROUPS_ESTIMATE)
    distinct_ratio = len(set(non_empty)) / max(1, len(non_empty))
    estimated = int(round(safe_total * distinct_ratio))
    estimated = max(4, estimated)
    return min(estimated, _MAX_GROUPS_ESTIMATE)


def _pick_diverse_chart_type(candidates: List[str], used_types: set[str]) -> str:
    """优先选择候选中尚未使用的图表类型，避免同质化"""
    for c in candidates:
        if c not in used_types:
            return c
    return candidates[0]


def _select_chart_type(
    data_rows: int,
    value_col_count: int = 1,
    group_by_col: str = "",
    metric_col: str = "",
    group_samples: Optional[List[Any]] = None,
    used_types: Optional[set[str]] = None,
) -> str:
    """基于数据属性自动选择图表类型（含去同质化）"""
    used = used_types or set()
    group_samples = group_samples or []
    group_name = str(group_by_col or "")
    metric_name = str(metric_col or "")

    temporal_hit = bool(_TEMPORAL_COL_RE.search(group_name)) or any(_is_temporal_like(v) for v in group_samples[:10])
    ratio_hit = bool(_RATIO_COL_RE.search(metric_name))
    numeric_group_ratio = (
        sum(1 for v in group_samples if _is_number_like(v)) / len(group_samples)
        if group_samples
        else 0.0
    )

    # 1) 多指标或时间维度：优先趋势图
    if value_col_count > 1 and data_rows >= 12:
        return _pick_diverse_chart_type(["line", "area", "column"], used)
    if temporal_hit:
        if data_rows >= 40:
            return _pick_diverse_chart_type(["area", "line", "column"], used)
        return _pick_diverse_chart_type(["line", "column", "area"], used)

    # 2) 占比指标 + 低基数：优先环图/饼图
    if ratio_hit and data_rows <= 12:
        return _pick_diverse_chart_type(["doughnut", "pie", "bar"], used)

    # 3) 数值型分组轴更偏趋势表达
    if numeric_group_ratio >= 0.8 and 8 <= data_rows <= _CHART_AUTO_THRESHOLDS["line"]:
        return _pick_diverse_chart_type(["line", "column", "area"], used)

    # 4) 默认按规模分层
    if value_col_count > 1 and data_rows >= 12:
        return _pick_diverse_chart_type(["line", "column"], used)
    if data_rows <= _CHART_AUTO_THRESHOLDS["bar"]:
        return _pick_diverse_chart_type(["bar", "column", "doughnut"], used)
    if data_rows <= _CHART_AUTO_THRESHOLDS["column"]:
        return _pick_diverse_chart_type(["column", "bar", "line"], used)
    if data_rows <= _CHART_AUTO_THRESHOLDS["line"]:
        return _pick_diverse_chart_type(["line", "area", "column"], used)
    return _pick_diverse_chart_type(["area", "line"], used)


def _resolve_col_number(
    col_name: str,
    headers: List[str],
    headers_with_col: List[Dict[str, Any]] = None,
) -> Optional[int]:
    """将列名解析为 1-based 列号"""
    # 优先从 headersWithCol 精确匹配
    if headers_with_col:
        for h in headers_with_col:
            if str(h.get("name", "")).strip() == col_name:
                return int(h.get("col", 0))

    # 按位置索引
    for idx, h in enumerate(headers):
        if str(h).strip() == col_name:
            return idx + 1
    return None


def _build_banner_title(block: AnalysisBlock) -> str:
    """生成分隔标题文本"""
    if block.title:
        return block.title
    return f"{block.group_by_col}{block.metric_col}分析"


# =====================================================================
#  核心编译器
# =====================================================================

def compile_analysis_plan(
    plan: AnalysisPlan,
    excel_state: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    将分析计划编译为确定性的操作序列。

    Args:
        plan: 经过验证的分析计划
        excel_state: 前端传来的 excel 状态（sheets/activeSheet/headerRow 等）

    Returns:
        操作列表，每项格式为 {"type": "...", "params": {...}}
    """
    operations: List[Dict[str, Any]] = []
    sheets_meta = _extract_sheets_meta(excel_state)

    # ── Step 1: 创建目标工作表 ──
    operations.append({
        "type": "add_sheet",
        "params": {"name": plan.target_sheet},
    })

    # ── Step 2: 逐块编译 ──
    cursor_row = 1
    chart_row_cursor = 1
    block_titles: List[str] = []
    used_chart_types: set[str] = set()

    for idx, block in enumerate(plan.blocks):
        meta = sheets_meta.get(block.source_sheet)
        if not meta:
            continue

        headers = meta["headers"]
        headers_with_col = meta.get("headers_with_col", [])
        header_row = meta["header_row"]
        data_start_row = meta["data_start_row"]
        data_end_row = meta["data_end_row"]
        total_data_rows = meta.get("total_data_rows", data_end_row - data_start_row + 1)

        group_col_num = _resolve_col_number(block.group_by_col, headers, headers_with_col)
        metric_col_num = _resolve_col_number(block.metric_col, headers, headers_with_col)
        if not group_col_num or not metric_col_num:
            continue

        # ── 2a: 分隔标题 ──
        title = _build_banner_title(block)
        block_titles.append(title)
        operations.append({
            "type": "set_cell_value",
            "params": {
                "sheet": plan.target_sheet,
                "row": cursor_row,
                "col": _BANNER_START_COL,
                "value": title,
            },
        })
        # 标题加粗样式
        operations.append({
            "type": "set_range_style",
            "params": {
                "sheet": plan.target_sheet,
                "startRow": cursor_row,
                "startCol": _BANNER_START_COL,
                "endRow": cursor_row,
                "endCol": _BANNER_START_COL + 3,
                "style": {"bold": True, "fontSize": 13},
            },
        })

        # ── 2b: 汇总操作（必须传 startRow/endRow，否则前端无法定位数据边界） ──
        summarize_row = cursor_row + 1
        operations.append({
            "type": "summarize_metrics_by_column",
            "params": {
                "sheet": block.source_sheet,
                "startRow": header_row,
                "endRow": data_end_row,
                "groupByCol": group_col_num,
                "sumCol": metric_col_num,
                "targetSheet": plan.target_sheet,
                "targetRow": summarize_row,
            },
        })

        # ── 2c: 图表操作 ──
        # 分组数上限：不超过源数据行数和全局上限
        group_samples = _extract_col_samples(meta.get("sample_data", []), group_col_num)
        est_groups = _estimate_group_rows(total_data_rows, group_samples)
        chart_type = block.chart_type
        if chart_type == "auto":
            chart_type = _select_chart_type(
                est_groups,
                value_col_count=1,
                group_by_col=block.group_by_col,
                metric_col=block.metric_col,
                group_samples=group_samples,
                used_types=used_chart_types,
            )
        used_chart_types.add(str(chart_type))

        # 数据范围：汇总表头 + 预估分组行 + 总计行 + 缓冲
        data_range_end_row = summarize_row + est_groups + _SUMMARY_PADDING_ROWS
        data_range_str = f"A{summarize_row}:B{data_range_end_row}"

        # 图表锚点：数据区右侧
        chart_col = _BANNER_START_COL + _CHART_ANCHOR_COL_OFFSET + 2

        operations.append({
            "type": "create_chart",
            "params": {
                "sheet": plan.target_sheet,
                "chartType": chart_type,
                "dataRange": data_range_str,
                "title": title,
                "row": chart_row_cursor,
                "col": chart_col,
                "width": _CHART_WIDTH,
                "height": _CHART_HEIGHT,
            },
        })

        # ── 2d: 更新游标 ──
        cursor_row = data_range_end_row + _BLOCK_GAP_ROWS
        chart_row_cursor += int(_CHART_HEIGHT / 20) + 2

    # ── Step 3: 关键发现 ──
    if plan.include_insights and block_titles:
        insight_ops = _compile_insights(
            plan.target_sheet,
            cursor_row,
            block_titles[:_INSIGHT_MAX_ITEMS],
        )
        operations.extend(insight_ops)

    # ── Step 4: 激活目标工作表 ──
    operations.append({
        "type": "set_active_sheet",
        "params": {"name": plan.target_sheet},
    })

    return operations


def _compile_insights(
    target_sheet: str,
    start_row: int,
    block_titles: List[str],
) -> List[Dict[str, Any]]:
    """编译关键发现操作"""
    ops: List[Dict[str, Any]] = []

    # 标题行
    ops.append({
        "type": "set_cell_value",
        "params": {
            "sheet": target_sheet,
            "row": start_row,
            "col": _BANNER_START_COL,
            "value": _INSIGHT_TITLE,
        },
    })
    ops.append({
        "type": "set_range_style",
        "params": {
            "sheet": target_sheet,
            "startRow": start_row,
            "startCol": _BANNER_START_COL,
            "endRow": start_row,
            "endCol": _BANNER_START_COL + 3,
            "style": {"bold": True, "fontSize": 13},
        },
    })

    # 逐条洞察（模板化，不含具体业务结论）
    values: List[List[str]] = []
    for idx, title in enumerate(block_titles, 1):
        values.append([
            f"{idx}. 已完成「{title}」汇总与图表，请重点关注头部与尾部类别差异。",
            "", "", "",
        ])

    if values:
        ops.append({
            "type": "set_range_values",
            "params": {
                "sheet": target_sheet,
                "startRow": start_row + 1,
                "startCol": _BANNER_START_COL,
                "values": values,
            },
        })

    return ops


# =====================================================================
#  元数据提取
# =====================================================================

def _extract_sheets_meta(excel_state: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """从 excel_state 提取每张工作表的元数据"""
    result: Dict[str, Dict[str, Any]] = {}
    sheets = excel_state.get("sheets") or []

    for sheet in sheets:
        name = sheet.get("name", "")
        if not name:
            continue

        headers = sheet.get("headers", [])
        headers_str = [str(h) for h in headers]

        header_row = sheet.get("headerRow", sheet.get("firstRow", 1))
        data_start_row = sheet.get("dataStartRow", header_row + 1)
        data_end_row = sheet.get("dataEndRow", sheet.get("lastRow", 1))
        total_data_rows = sheet.get("totalDataRows", max(0, data_end_row - data_start_row + 1))

        result[name] = {
            "headers": headers_str,
            "headers_with_col": sheet.get("headersWithCol", []),
            "header_row": header_row,
            "data_start_row": data_start_row,
            "data_end_row": data_end_row,
            "total_data_rows": total_data_rows,
            "col_count": sheet.get("colCount", len(headers)),
            "sample_data": sheet.get("sampleData", []),
        }

    return result
