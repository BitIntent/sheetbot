# backend/app/agent/plan_contract.py
"""
LLM 输出契约 -- 结构化计划的 Schema 定义与验证

架构定位：
  LLM 不再逐步调用 10-20 个工具，而是调用 submit_analysis_plan 提交结构化计划。
  本模块定义计划的合法结构，拒绝不合规的输入，确保下游编译器输入可控。

设计原则：
  - LLM 只决定"分析什么"（维度、指标、聚合方式）
  - 编译器决定"怎么执行"（行号、图表位置、排版、数据范围）
  - 验证层确保 LLM 输出在合法边界内
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# =====================================================================
#  合法枚举值
# =====================================================================

VALID_AGGREGATIONS = frozenset({"sum", "avg", "count", "max", "min"})
VALID_CHART_TYPES = frozenset({
    "column", "bar", "line", "pie", "area", "scatter", "doughnut", "auto",
})

# 最大分析块数（防止 LLM 输出过多维度）
MAX_ANALYSIS_BLOCKS = 5
# 最小分析块数
MIN_ANALYSIS_BLOCKS = 1


# =====================================================================
#  数据结构
# =====================================================================

@dataclass
class AnalysisBlock:
    """单个分析维度（一个汇总 + 一张图表）"""
    source_sheet: str
    group_by_col: str           # 列名（字符串）
    metric_col: str             # 指标列名
    aggregation: str = "sum"    # sum/avg/count/max/min
    chart_type: str = "auto"    # auto 时编译器自动选择
    title: str = ""             # 块标题（空则自动生成）


@dataclass
class AnalysisPlan:
    """完整的分析计划"""
    blocks: List[AnalysisBlock] = field(default_factory=list)
    include_insights: bool = True
    target_sheet: str = "综合分析"


# =====================================================================
#  验证结果
# =====================================================================

@dataclass
class PlanValidationResult:
    """计划验证结果"""
    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    plan: Optional[AnalysisPlan] = None


# =====================================================================
#  ID/编码列检测（禁止作为分组维度）
# =====================================================================

_ID_COL_RE = re.compile(
    r"(^id$|id$|_id$|编号$|编码$|代码$|^sku$|^code$|^no$|^num$)",
    re.IGNORECASE,
)

_CODE_VALUE_RE = re.compile(
    r"^[A-Z]{1,4}[-_]?\d{3,}$|^\d{6,}$",
    re.IGNORECASE,
)


def _is_id_like_column(col_name: str, sample_values: List[Any] = None) -> bool:
    """判断列名是否为 ID/编码型，不适合做分组维度"""
    if _ID_COL_RE.search(col_name):
        return True
    if sample_values:
        code_count = sum(1 for v in sample_values[:10] if isinstance(v, str) and _CODE_VALUE_RE.match(v.strip()))
        if code_count >= 5:
            return True
    return False


# =====================================================================
#  从原始 dict 解析计划
# =====================================================================

def parse_analysis_plan(raw: Dict[str, Any]) -> AnalysisPlan:
    """将 LLM 输出的 dict 解析为 AnalysisPlan 对象"""
    blocks_raw = raw.get("blocks") or []
    blocks = []
    for b in blocks_raw:
        if not isinstance(b, dict):
            continue
        blocks.append(AnalysisBlock(
            source_sheet=str(b.get("source_sheet") or b.get("sourceSheet") or "").strip(),
            group_by_col=str(b.get("group_by_col") or b.get("groupByCol") or "").strip(),
            metric_col=str(b.get("metric_col") or b.get("metricCol") or "").strip(),
            aggregation=str(b.get("aggregation") or "sum").strip().lower(),
            chart_type=str(b.get("chart_type") or b.get("chartType") or "auto").strip().lower(),
            title=str(b.get("title") or "").strip(),
        ))

    return AnalysisPlan(
        blocks=blocks,
        include_insights=bool(raw.get("include_insights", raw.get("includeInsights", True))),
        target_sheet=str(raw.get("target_sheet") or raw.get("targetSheet") or "综合分析").strip(),
    )


# =====================================================================
#  验证计划
# =====================================================================

def validate_analysis_plan(
    plan: AnalysisPlan,
    available_sheets: List[str],
    headers_by_sheet: Dict[str, List[str]],
    sample_by_sheet: Dict[str, List[List[Any]]] = None,
) -> PlanValidationResult:
    """
    验证分析计划的合法性

    Args:
        plan: 解析后的计划
        available_sheets: 可用工作表名列表
        headers_by_sheet: {表名: 列标题列表}
        sample_by_sheet: {表名: 样本数据行列表}（可选，用于 ID 列检测）

    Returns:
        PlanValidationResult
    """
    errors: List[str] = []
    warnings: List[str] = []

    if not plan.blocks:
        errors.append("计划不包含任何分析块（blocks 为空）")
        return PlanValidationResult(is_valid=False, errors=errors)

    if len(plan.blocks) > MAX_ANALYSIS_BLOCKS:
        errors.append(f"分析块数量超限：{len(plan.blocks)} > {MAX_ANALYSIS_BLOCKS}")
        return PlanValidationResult(is_valid=False, errors=errors)

    seen_dims = set()

    for i, block in enumerate(plan.blocks):
        prefix = f"blocks[{i}]"

        # 源工作表存在性
        if block.source_sheet not in available_sheets:
            errors.append(f"{prefix}: 源工作表 '{block.source_sheet}' 不存在，可用: {available_sheets}")
            continue

        headers = headers_by_sheet.get(block.source_sheet, [])

        # 分组列存在性
        if block.group_by_col not in headers:
            col_idx = _try_parse_col_index(block.group_by_col)
            if col_idx is not None and 0 <= col_idx < len(headers):
                block.group_by_col = headers[col_idx]
                warnings.append(f"{prefix}: group_by_col 按索引 {col_idx} 映射为 '{block.group_by_col}'")
            else:
                errors.append(f"{prefix}: 分组列 '{block.group_by_col}' 不存在于 '{block.source_sheet}'，可用: {headers}")
                continue

        # ID 列检测
        samples = (sample_by_sheet or {}).get(block.source_sheet, [])
        col_idx = headers.index(block.group_by_col)
        sample_vals = [row[col_idx] for row in samples if col_idx < len(row)] if samples else []
        if _is_id_like_column(block.group_by_col, sample_vals):
            errors.append(f"{prefix}: 分组列 '{block.group_by_col}' 是 ID/编码型列，不适合做分组维度")
            continue

        # 指标列存在性
        if block.metric_col not in headers:
            col_idx_m = _try_parse_col_index(block.metric_col)
            if col_idx_m is not None and 0 <= col_idx_m < len(headers):
                block.metric_col = headers[col_idx_m]
                warnings.append(f"{prefix}: metric_col 按索引映射为 '{block.metric_col}'")
            else:
                errors.append(f"{prefix}: 指标列 '{block.metric_col}' 不存在于 '{block.source_sheet}'，可用: {headers}")
                continue

        # 聚合方式
        if block.aggregation not in VALID_AGGREGATIONS:
            errors.append(f"{prefix}: 聚合方式 '{block.aggregation}' 不合法，可选: {sorted(VALID_AGGREGATIONS)}")

        # 图表类型
        if block.chart_type not in VALID_CHART_TYPES:
            block.chart_type = "auto"
            warnings.append(f"{prefix}: 图表类型已回退为 auto")

        # 去重检测
        dim_key = (block.source_sheet, block.group_by_col, block.metric_col)
        if dim_key in seen_dims:
            warnings.append(f"{prefix}: 重复维度 ({block.source_sheet}, {block.group_by_col}, {block.metric_col})，已跳过")
            block.source_sheet = ""  # 标记为无效，编译器跳过
        else:
            seen_dims.add(dim_key)

    # 过滤掉被标记为无效的 block
    plan.blocks = [b for b in plan.blocks if b.source_sheet]

    if not plan.blocks:
        errors.append("所有分析块均未通过验证，无有效维度可分析")

    return PlanValidationResult(
        is_valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
        plan=plan if len(errors) == 0 else None,
    )


def _try_parse_col_index(val: str) -> Optional[int]:
    """尝试将字符串解析为列索引（0-based）"""
    try:
        return int(val) - 1
    except (ValueError, TypeError):
        return None
