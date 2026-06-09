"""
报表洞察兜底引擎。
职责：当 LLM 结果不可用或质量不足时，生成数据驱动的结构化洞察。
"""
import math
from typing import Any, Dict, List, Optional


FALLBACK_REASON_LABELS = {
    "json_parse_failed": "AI 结果格式异常，已自动切换为稳健模式",
    "json_block_not_found": "AI 未返回结构化结果，已自动切换为稳健模式",
    "low_quality_response": "AI 输出质量未达标，已自动切换为稳健模式",
    "exception": "AI 服务暂时不可用，已自动切换为稳健模式",
}

TEMPLATE_RETRY_SUGGESTIONS = {
    "overview": ["comparison", "executive"],
    "comparison": ["trend", "executive"],
    "trend": ["comparison", "anomaly"],
    "ranking": ["comparison", "executive"],
    "executive": ["overview", "comparison"],
    "anomaly": ["trend", "comparison"],
    "segment": ["comparison", "overview"],
    "funnel": ["trend", "comparison"],
}


def safe_num(v: Any) -> Optional[float]:
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except Exception:
        return None


def _render_kpi_text(item: Dict[str, Any]) -> str:
    label = str(item.get("label", "指标"))
    formatted = str(item.get("formatted", "--")).strip()
    unit = str(item.get("unit", "") or "").strip()
    if unit and formatted.endswith(unit):
        unit = ""
    if unit == "%" and formatted.endswith("%"):
        unit = ""
    return f"{label}: {formatted}{unit}"


def build_data_driven_fallback(
    template_key: str,
    kpis: Optional[List[Dict[str, Any]]] = None,
    charts: Optional[List[Dict[str, Any]]] = None,
    custom_prompt: Optional[str] = None,
) -> Dict[str, Any]:
    kpis = kpis or []
    charts = charts or []
    top_kpis = [k for k in kpis if str(k.get("label", "")).strip()][:4]
    chart_titles = [str(c.get("title", "")).strip() for c in charts if str(c.get("title", "")).strip()][:3]

    summary_parts = []
    if top_kpis:
        summary_parts.append(f"核心指标: " + ", ".join(f'{k["label"]}={k.get("formatted", "--")}' for k in top_kpis[:3]))
    if chart_titles:
        summary_parts.append(f"围绕 {'、'.join(chart_titles)} 展开分析")
    if custom_prompt:
        summary_parts.append(f"分析视角: {custom_prompt[:40]}")
    summary = "。".join(summary_parts) + "。" if summary_parts else "报告已完成结构化分析，请查看图表获取详细洞察。"

    findings = []
    for item in top_kpis:
        findings.append(_render_kpi_text(item))
    if chart_titles:
        findings.append(f"已生成 {len(charts)} 张图表: {'、'.join(chart_titles)}")
    findings = findings[:6] if findings else ["数据已完成加载并形成可视化图表。"]

    numeric_kpis = []
    for item in top_kpis:
        v = safe_num(item.get("value"))
        if v is not None:
            numeric_kpis.append((str(item.get("label", "指标")), v))

    anomaly_warnings = []
    if numeric_kpis:
        top_name, top_val = sorted(numeric_kpis, key=lambda x: abs(x[1]), reverse=True)[0]
        anomaly_warnings.append(f"{top_name} 当前值为 {top_val:,.2f}，建议核查统计口径与分组粒度是否一致。")
    if chart_titles:
        anomaly_warnings.append(f"图表覆盖 {len(charts)} 个主题，建议统一时间与区域口径，避免跨图结论偏差。")
    anomaly_warnings = anomaly_warnings[:3] if anomaly_warnings else ["暂未识别到可量化异常，请重点排查缺失值与聚合维度。"]

    trend_forecast = []
    if numeric_kpis:
        pivot_name, pivot_val = numeric_kpis[0]
        trend_forecast.append(f"若 {pivot_name} 延续当前水平，短期将围绕 {pivot_val:,.2f} 附近波动，建议按周跟踪偏离率。")
    trend_forecast.append("建议建立阈值预警（如环比波动 >10%）并设置责任人，避免异常集中暴露。")
    trend_forecast = trend_forecast[:3]

    recommendations = [
        "优先围绕高波动指标建立“日监控-周复盘”机制，先定位异常来源再调整策略。",
        "按高贡献维度与低效维度分层配置资源，将改进目标量化到责任团队和时间窗口。",
        "针对头部与尾部维度建立差异化策略：头部保增长、尾部做诊断与修复，避免资源平均分配。",
    ]

    detail_paragraphs: List[str] = []
    if top_kpis:
        detail_paragraphs.append(
            "核心指标层面，"
            + "，".join(_render_kpi_text(item) for item in top_kpis[:3])
            + "。建议将指标拆分到渠道/区域/客群三个维度复核，识别结构性贡献与稀释来源。"
        )
    if chart_titles:
        detail_paragraphs.append(
            f"图表层面已覆盖 {len(charts)} 个分析主题（{'、'.join(chart_titles)}），"
            "建议统一时间窗口与口径后执行横向对比，优先锁定贡献差异最大的两个维度做专项优化。"
        )

    return {
        "summary": summary[:200],
        "key_findings": findings,
        "anomaly_warnings": anomaly_warnings,
        "trend_forecast": trend_forecast,
        "recommendations": recommendations[:4],
        "detail_paragraphs": detail_paragraphs[:3],
    }


def fallback_insights(
    reason: str,
    detail: Optional[str] = None,
    template_key: str = "overview",
    kpis: Optional[List[Dict[str, Any]]] = None,
    charts: Optional[List[Dict[str, Any]]] = None,
    custom_prompt: Optional[str] = None,
) -> Dict[str, Any]:
    data_driven = build_data_driven_fallback(template_key, kpis=kpis, charts=charts, custom_prompt=custom_prompt)
    fallback_reason_label = FALLBACK_REASON_LABELS.get(reason, "AI 洞察已回退为稳健模式")
    suggested_templates = TEMPLATE_RETRY_SUGGESTIONS.get(template_key, ["comparison", "executive"])
    payload = {
        "summary": data_driven["summary"],
        "key_findings": data_driven["key_findings"],
        "anomaly_warnings": data_driven.get("anomaly_warnings", []),
        "trend_forecast": data_driven.get("trend_forecast", []),
        "recommendations": data_driven["recommendations"],
        "detail_paragraphs": data_driven["detail_paragraphs"],
        "diagnostics": {
            "insight_source": "fallback",
            "fallback_reason": reason,
            "fallback_reason_label": fallback_reason_label,
            "suggested_template_keys": suggested_templates,
            "retry_hint": "可切换模板后重新生成，以获得更贴合场景的深度解读。",
        },
    }
    if detail:
        payload["diagnostics"]["fallback_detail"] = detail
    return payload
