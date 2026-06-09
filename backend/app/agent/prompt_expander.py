# backend/app/agent/prompt_expander.py
"""
Prompt 扩展引擎 -- 意图识别 + 推断层驱动的指令补全

核心理念：
  用户输入模糊时，系统自动根据已学习的工作表元数据扩展 prompt。
  扩展内容只输出 LLM 从 context_str 推导不出来的推断结果与行为指令，
  不重复 context_str 中已有的原始元数据（列名/行数/工作表枚举等）。

Token 策略：
  - 删除：列名重复、行数重复、工作表枚举重复、语言要求重复
  - 保留：数值/分类列推断结果（语义推断，context_str 无此层）
  - 保留：执行指引（行为约束与路径建议）
  典型扩展从 ~250 tokens 降至 ~70 tokens (-72%)
"""
import re
from typing import Any, Dict, List, Optional, Tuple
from .intent_classifier import Intent, detect_intents


# =====================================================================
#  元数据提取工具
# =====================================================================

def _extract_sheet_meta(excel_state: Dict[str, Any]) -> List[Dict[str, Any]]:
    """从 excel_state 提取每张工作表的结构摘要（含推断所需的样本）"""
    sheets_raw = excel_state.get("sheets") or []
    result = []
    for s in sheets_raw:
        name = s.get("name", "")
        headers_with_col = s.get("headersWithCol") or []
        headers = s.get("headers") or []
        header_names = (
            [h.get("name", "") for h in headers_with_col if h.get("name")]
            if headers_with_col
            else [str(h) for h in headers if h]
        )
        total_rows = s.get("totalDataRows", 0)
        col_count = s.get("colCount", 0)
        sample = s.get("sampleData") or []

        result.append({
            "name": name,
            "headers": header_names,
            "totalRows": total_rows,
            "colCount": col_count,
            "sampleSize": len(sample),
            "sample": sample[:3],
        })
    return result


def _guess_numeric_cols(sheet_meta: Dict[str, Any]) -> List[str]:
    """从样本数据推断数值列（用于智能选取汇总/图表列）"""
    headers = sheet_meta.get("headers", [])
    samples = sheet_meta.get("sample", [])
    if not headers or not samples:
        return []

    numeric_cols = []
    for i, h in enumerate(headers):
        numeric_count = 0
        for row in samples:
            if isinstance(row, (list, tuple)) and i < len(row):
                val = row[i]
                if _is_numeric_like(val):
                    numeric_count += 1
            elif isinstance(row, dict):
                val = row.get(h, row.get(str(i), ""))
                if _is_numeric_like(val):
                    numeric_count += 1
        if numeric_count > 0 and numeric_count >= len(samples) * 0.6:
            numeric_cols.append(h)
    return numeric_cols


def _guess_categorical_cols(sheet_meta: Dict[str, Any]) -> List[str]:
    """从列名推断适合分组的分类列"""
    headers = sheet_meta.get("headers", [])
    cat_keywords = [
        "类", "类型", "类别", "分类", "品类", "名称", "渠道", "区域",
        "地区", "部门", "人员", "销售员", "客户", "产品", "品牌",
        "状态", "等级", "级别", "来源", "方式", "月份", "年份",
        "category", "type", "name", "channel", "region", "department",
    ]
    result = []
    for h in headers:
        hl = h.lower()
        if re.search(r"(id|编号|编码|序号|sku)", hl, re.IGNORECASE):
            continue
        if any(kw in hl for kw in cat_keywords):
            result.append(h)
    return result


def _is_numeric_like(val: Any) -> bool:
    """判断值是否为数值型"""
    if isinstance(val, (int, float)):
        return True
    if isinstance(val, str):
        s = val.strip().replace(",", "").replace("%", "")
        if not s:
            return False
        try:
            float(s)
            return True
        except ValueError:
            return False
    return False


# =====================================================================
#  意图识别
# =====================================================================

def detect_intent(command: str) -> List[str]:
    """
    识别用户指令意图（兼容入口）。

    实际策略已下沉至 intent_classifier.detect_intents，
    这里保留函数名以避免影响现有调用方。
    """
    return detect_intents(command)


def _is_vague_command(command: str, intents: List[str]) -> bool:
    """
    判断用户指令是否足够模糊需要扩展。

    扩展触发条件：
    1. 有明确意图但指令较短（<30字）
    2. 未包含具体列名/区间引用
    """
    text = command.strip()

    if intents == [Intent.UNKNOWN]:
        return False

    if len(text) <= 10:
        return True

    # 已含具体列区间引用，视为明确指令
    if re.search(r'[A-Z]+\d+:[A-Z]+\d+', text):
        return False
    if re.search(r'第\d+列', text):
        return False

    if len(text) <= 30:
        return True

    return False


# =====================================================================
#  扩展策略（只输出推断结果 + 行为指令，不重复 context_str 的原始元数据）
# =====================================================================

def _expand_analyze(
    command: str,
    active_sheet: Dict[str, Any],
    all_sheets: List[Dict[str, Any]],
) -> str:
    """扩展"分析"类意图：多表综合分析或单表快速推断"""
    numeric = _guess_numeric_cols(active_sheet)
    categorical = _guess_categorical_cols(active_sheet)
    total_rows = active_sheet["totalRows"]

    parts = [command, "\n[分析建议]"]
    if numeric:
        parts.append(f"- 推断数值指标列: {', '.join(numeric[:4])}")
    if categorical:
        parts.append(f"- 推断分组维度列: {', '.join(categorical[:4])}")

    is_auto_analyze = bool(re.search(r"(智能|自动|全面).*分析", command))
    current_scope = bool(re.search(r"(当前数据|当前工作表|当前表|本表|该表)", command))
    multi_sheet = len(all_sheets) > 1 and not current_scope
    data_sheets = [s for s in all_sheets if s.get("totalRows", 0) > 0]

    if multi_sheet and is_auto_analyze:
        # 多表综合分析：明确要求新建汇总工作表
        sheet_names = [s["name"] for s in data_sheets]
        parts.append("\n[执行指引 — 多工作表综合分析]")
        parts.append(
            "- 全程只使用**一张**结果表，固定名为「综合分析」（已存在则清空复用）；"
            "禁止再 add_sheet「渠道汇总1」「渠道汇总」等第二张结果页"
        )
        parts.append(
            f"- 按以下工作表逐一处理（各表依赖自身列标题，禁止混用）：{', '.join(sheet_names)}"
        )
        parts.append(
            "- 每表一块：A列写「xxx分析」占第R行后，下一行立刻 `summarize_metrics_by_column`，"
            "`target_sheet`=`综合分析` 且 `target_row`=R+1；禁止在 R 与 R+1 之间插入说明句（避免空行与表头错位）"
        )
        parts.append("- 每块汇总后配 1 张图（同表多块则多块多图），图表 sheet=「综合分析」")
        parts.append(
            "- **块间距（强制）**：每写完一个数据块+图表后，`cursor_row = max_row + 3`（留 2 行空白），"
            "下一个「xxx分析」标题写在 `cursor_row`。违反间距会导致块重叠。"
        )
        parts.append("- 最后可追加「关键发现」文字块；该段不算独立数据块、勿为其单独建表或重复制图")
        parts.append("- 禁止把分析结果写回原数据工作表")
        if total_rows > 100 and numeric and categorical:
            parts.append(f"- 数据量较大（{total_rows}行），务必先汇总降维再出图")
    else:
        # 单表分析（含自动出图指引）
        if current_scope:
            parts.append("\n[范围约束]")
            parts.append("- 用户已限定“当前数据/当前工作表”，只分析当前活动表，禁止扩展到其他工作表")
        if is_auto_analyze:
            parts.append("\n[执行指引]")
            parts.append(
                "- 智能分析并出图：优先 `add_sheet` 固定名称「综合分析」承载汇总与图表，"
                "勿再建「渠道汇总1」等额外结果表；`target_sheet` 与图表 `sheet` 均指向该表"
            )
            if total_rows > 100 and numeric and categorical:
                parts.append(f"- 数据量较大（{total_rows}行），先汇总降维再出图")
                parts.append(f"- 推荐: 按「{categorical[0]}」分组汇总「{numeric[0]}」→ 图表")
            parts.append("- 为每个有意义的汇总结果配套图表（最多3张），末尾给出关键发现")
        elif numeric and categorical:
            parts.append(f"- 建议: 按「{categorical[0]}」分组查看「{numeric[0]}」的分布规律")

    return "\n".join(parts)


def _expand_beautify(
    command: str,
    active_sheet: Dict[str, Any],
    **_: Any,
) -> str:
    """扩展"美化"类意图：只输出样式执行指引，不重复列名/行数"""
    parts = [command, "\n[执行指引]"]
    parts.append("- 表头加粗 + 深色背景 + 白色文字")
    parts.append("- 数值列设置合适格式（货币/百分比/千分位）")
    parts.append("- 自动调整列宽 + 淡色交替行背景 + 细框线")
    return "\n".join(parts)


def _expand_chart(
    command: str,
    active_sheet: Dict[str, Any],
    **_: Any,
) -> str:
    """扩展"图表"类意图：输出推断列 + 制图路径建议"""
    numeric = _guess_numeric_cols(active_sheet)
    categorical = _guess_categorical_cols(active_sheet)
    total_rows = active_sheet["totalRows"]

    parts = [command]
    hints = []
    if numeric:
        hints.append(f"推断值轴列: {', '.join(numeric[:3])}")
    if categorical:
        hints.append(f"推断分类轴列: {', '.join(categorical[:3])}")
    if hints:
        parts.append(f"\n[图表建议] {'; '.join(hints)}")

    if total_rows > 80:
        parts.append(f"[执行指引] 数据 {total_rows} 行较多，先汇总后出图（禁止明细直出）")
        if categorical and numeric:
            parts.append(f"- 推荐: 按「{categorical[0]}」分组汇总「{numeric[0]}」后制图")
    elif categorical and numeric:
        parts.append(f"[执行指引] 推荐用「{categorical[0]}」作分类轴，「{numeric[0]}」作数值轴")

    return "\n".join(parts)


def _expand_summary(
    command: str,
    active_sheet: Dict[str, Any],
    **_: Any,
) -> str:
    """扩展"汇总"类意图：输出推断列，仅在用户未明确分组时给出建议"""
    numeric = _guess_numeric_cols(active_sheet)
    categorical = _guess_categorical_cols(active_sheet)

    parts = [command]
    hints = []
    if categorical:
        hints.append(f"适合分组列: {', '.join(categorical[:3])}")
    if numeric:
        hints.append(f"适合汇总列: {', '.join(numeric[:3])}")
    if hints:
        parts.append(f"\n[汇总建议] {'; '.join(hints)}")

    if categorical and numeric and "按" not in command and "根据" not in command:
        parts.append(f"[执行指引] 推荐按「{categorical[0]}」分组，汇总「{numeric[0]}」的总和/平均")

    return "\n".join(parts)


def _expand_conditional_format(
    command: str,
    active_sheet: Dict[str, Any],
    **_: Any,
) -> str:
    """扩展"条件格式"类意图：仅输出推断数值列"""
    numeric = _guess_numeric_cols(active_sheet)
    if numeric:
        return f"{command}\n[建议] 推断适合条件格式的数值列: {', '.join(numeric[:4])}"
    return command


def _expand_dedup(
    command: str,
    active_sheet: Dict[str, Any],
    **_: Any,
) -> str:
    """扩展"去重"类意图：仅在未指定依据列时补充默认行为"""
    if not re.search(r"(按|根据|依据).{0,10}(列|字段)", command):
        return f"{command}\n[执行指引] 用户未指定去重依据列，默认按所有列完全重复去重"
    return command


def _expand_sort(
    command: str,
    active_sheet: Dict[str, Any],
    **_: Any,
) -> str:
    """扩展"排序"类意图：在未指定排序列时推荐数值列"""
    if re.search(r"(按|根据).{0,10}(列|字段)", command):
        return command
    numeric = _guess_numeric_cols(active_sheet)
    if numeric:
        return f"{command}\n[执行指引] 用户未指定排序列，推荐按「{numeric[0]}」降序排列"
    return command


# 意图 -> 扩展函数映射
_EXPANDER_MAP = {
    Intent.ANALYZE: _expand_analyze,
    Intent.BEAUTIFY: _expand_beautify,
    Intent.CHART: _expand_chart,
    Intent.SUMMARY: _expand_summary,
    Intent.PIVOT: _expand_summary,
    Intent.CONDITIONAL_FORMAT: _expand_conditional_format,
    Intent.DEDUP: _expand_dedup,
    Intent.SORT: _expand_sort,
    Intent.FILTER: _expand_sort,
}


# =====================================================================
#  公开 API
# =====================================================================

def expand_user_prompt(
    command: str,
    excel_state: Optional[Dict[str, Any]] = None,
) -> Tuple[str, bool]:
    """
    根据工作表元数据扩展用户 prompt。

    Args:
        command: 用户原始指令
        excel_state: 前端传入的 Excel 状态

    Returns:
        (expanded_command, was_expanded)
    """
    if not command or not excel_state:
        return command, False

    intents = detect_intent(command)

    if intents == [Intent.UNKNOWN]:
        return command, False

    if not _is_vague_command(command, intents):
        return command, False

    all_sheets = _extract_sheet_meta(excel_state)
    if not all_sheets:
        return command, False

    active_name = excel_state.get("activeSheet", "")
    active_sheet = next(
        (s for s in all_sheets if s["name"] == active_name),
        all_sheets[0],
    )

    if not active_sheet.get("headers"):
        return command, False

    for intent in intents:
        expander = _EXPANDER_MAP.get(intent)
        if expander:
            expanded = expander(
                command,
                active_sheet=active_sheet,
                all_sheets=all_sheets,
            )
            return expanded, expanded != command

    return command, False
