"""
报表洞察质量门禁。
职责：拦截空话、缺数字、结构不完整的输出。
"""
from typing import Any, Callable, Dict, List, Optional

GENERIC_INSIGHT_PHRASES = (
    "请查看图表中的数据分布",
    "请查看图表",
    "数据分布和趋势变化",
    "可结合业务上下文",
    "进一步分析",
)

LOW_VALUE_SUMMARY_PHRASES = (
    "报告已完成结构化分析",
    "请查看图表",
    "暂无摘要",
)


def is_low_quality_chart_bullet(text: Any) -> bool:
    if not isinstance(text, str):
        return True
    compact = " ".join(text.split())
    if len(compact) < 14:
        return True
    if any(phrase in compact for phrase in GENERIC_INSIGHT_PHRASES):
        return True
    return not any(ch.isdigit() for ch in compact)


def sanitize_chart_insights(
    llm_items: List[Dict[str, Any]],
    charts: List[Dict[str, Any]],
    deterministic_builder: Callable[[Dict[str, Any]], List[str]],
) -> List[Dict[str, Any]]:
    sanitized = []
    for idx, chart in enumerate(charts):
        matched = next(
            (item for item in llm_items if isinstance(item, dict) and item.get("chart_index") == idx),
            None,
        )
        bullets = matched.get("bullets", []) if isinstance(matched, dict) else []
        if not isinstance(bullets, list) or len(bullets) < 3 or any(is_low_quality_chart_bullet(b) for b in bullets[:3]):
            bullets = deterministic_builder(chart)
        sanitized.append({"chart_index": idx, "bullets": bullets[:3]})
    return sanitized


def _is_low_value_summary(text: Any) -> bool:
    if not isinstance(text, str):
        return True
    compact = " ".join(text.split())
    if len(compact) < 24:
        return True
    if any(phrase in compact for phrase in LOW_VALUE_SUMMARY_PHRASES):
        return True
    return False


def _is_low_value_item(text: Any, require_numeric: bool = True) -> bool:
    if not isinstance(text, str):
        return True
    compact = " ".join(text.split())
    if len(compact) < 14:
        return True
    if any(phrase in compact for phrase in GENERIC_INSIGHT_PHRASES):
        return True
    if require_numeric and not any(ch.isdigit() for ch in compact):
        return True
    return False


def get_report_quality_issue(result: Dict[str, Any]) -> Optional[str]:
    if _is_low_value_summary(result.get("summary")):
        return "summary_low_quality"
    if len(result.get("key_findings", [])) < 3:
        return "key_findings_insufficient"
    if any(_is_low_value_item(x, require_numeric=True) for x in result.get("key_findings", [])[:3]):
        return "key_findings_missing_numeric_evidence"
    if any(_is_low_value_item(x, require_numeric=False) for x in result.get("recommendations", [])[:2]):
        return "recommendations_too_generic"
    return None


def report_insight_needs_fallback(result: Dict[str, Any]) -> bool:
    return get_report_quality_issue(result) is not None
