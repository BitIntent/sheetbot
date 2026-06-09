"""
报表洞察 Prompt 构建器。
职责：集中维护图表级与总体洞察的提示词结构。
"""
from typing import Any, Dict, List, Optional


def _render_kpi_text(item: Dict[str, Any]) -> str:
    label = str(item.get("label", "指标"))
    formatted = str(item.get("formatted", "--")).strip()
    unit = str(item.get("unit", "") or "").strip()
    if unit and formatted.endswith(unit):
        unit = ""
    if unit == "%" and formatted.endswith("%"):
        unit = ""
    return f"{label}: {formatted}{unit}"


def _extract_chart_data_summary(option: dict, series: list) -> str:
    parts = []
    x_axis = option.get("xAxis", {})
    if isinstance(x_axis, dict) and x_axis.get("data"):
        labels = x_axis["data"]
        parts.append(f"X轴: {labels[:5]}{'...' if len(labels) > 5 else ''}")

    for si, s in enumerate(series[:3]):
        if not isinstance(s, dict):
            continue
        s_name = s.get("name", f"系列{si}")
        data = s.get("data", [])
        if not data:
            continue
        if isinstance(data[0], dict):
            top3 = sorted(data, key=lambda x: x.get("value", 0), reverse=True)[:3]
            parts.append(f"{s_name} TOP3: " + ", ".join(f'{d.get("name")}={d.get("value")}' for d in top3))
        elif isinstance(data[0], (int, float)):
            nums = [x for x in data if isinstance(x, (int, float))]
            if nums:
                parts.append(f"{s_name}: min={min(nums):.1f}, max={max(nums):.1f}, 共{len(nums)}项")
    return "; ".join(parts) if parts else ""


def build_chart_insight_prompt(
    charts: List[Dict[str, Any]],
    plan: Dict[str, Any],
    domain_context: Dict[str, Any],
    custom_prompt: Optional[str] = None,
) -> str:
    chart_desc_parts = []
    for i, chart in enumerate(charts):
        title = chart.get("title", f"图表{i+1}")
        ctype = chart.get("chart_type") or chart.get("type", "bar")
        hint = chart.get("insight_hint", "")

        option = chart.get("option", {})
        series = option.get("series", []) if isinstance(option, dict) else []
        data_summary = _extract_chart_data_summary(option, series)

        part = f"### 图表 {i}: {title} (类型: {ctype})\n"
        if hint:
            part += f"分析方向提示: {hint}\n"
        if data_summary:
            part += f"数据摘要: {data_summary}\n"
        chart_desc_parts.append(part)

    domain = domain_context.get("domain", "general")
    analysis_focus = plan.get("analysis_focus") or domain_context.get("analysis_focus", "")
    prompt = f"""你是资深数据分析师，请为以下 {len(charts)} 张图表各生成 3 条高价值解读。

## 业务领域: {domain}
## 分析重点: {analysis_focus}

{chr(10).join(chart_desc_parts)}

## 要求
1. 每张图必须返回 3 条，且顺序固定为：关键发现、异常预警、行动建议
2. 每条 30-90 字，必须引用至少一个具体数字（如绝对值、占比、变化率）
3. 禁止空话（如“请结合业务进一步分析”），禁止重复同义句
4. 优先指出头部/尾部、波动拐点、集中度或结构失衡
5. 行动建议必须可执行，包含对象、动作、目标三要素
6. 禁止使用emoji

返回 JSON 数组:
[
  {{"chart_index": 0, "bullets": ["关键发现...", "异常预警...", "行动建议..."]}},
  ...
]

只输出 JSON，不要任何其他文字。"""

    if custom_prompt:
        prompt += f"\n\n用户指定的分析视角: {custom_prompt}\n请从此视角切入解读每张图表。"
    return prompt


def build_report_insight_prompt(
    template_key: str,
    kpis: List[Dict[str, Any]],
    charts: List[Dict[str, Any]],
    structure: Dict[str, Any],
    custom_prompt: Optional[str] = None,
    domain_context: Optional[Dict[str, Any]] = None,
    plan: Optional[Dict[str, Any]] = None,
) -> str:
    kpi_summary = [f"- {_render_kpi_text(k)}" for k in kpis[:8]]
    chart_summary = [f"- {c['title']} ({c.get('type', 'bar')})" for c in charts[:8]]

    domain = (domain_context or {}).get("domain", "general")
    domain_reasoning = (domain_context or {}).get("domain_reasoning", "")
    analysis_focus = (plan or {}).get("analysis_focus", "") or (domain_context or {}).get("analysis_focus", "")

    sheets_summary = []
    for s in (structure.get("sheets", []) if isinstance(structure, dict) else [])[:5]:
        row_count = s.get("row_count", 0)
        cols = s.get("columns", s.get("numeric_columns", []))
        col_names = [c.get("name", str(c)) if isinstance(c, dict) else str(c) for c in (cols[:6] if isinstance(cols, list) else [])]
        sheets_summary.append(f"- {s.get('sheet_name', '')}: {row_count}行, 列={col_names}")

    template_style = {
        "overview": "全面经营分析报告",
        "comparison": "多维度对比分析报告",
        "trend": "趋势深度分析报告",
        "ranking": "排行榜分析报告",
        "executive": "管理层摘要简报",
        "anomaly": "异常诊断分析报告",
        "segment": "客户分层分析报告",
        "funnel": "漏斗转化分析报告",
    }
    prompt = f"""你是一位资深数据分析师和行业专家，请根据以下数据生成{template_style.get(template_key, '数据分析报告')}洞察。

## 业务领域: {domain}
{"## 领域判断依据: " + domain_reasoning if domain_reasoning else ""}
{"## 分析重点: " + analysis_focus if analysis_focus else ""}

## 数据概况
{chr(10).join(sheets_summary)}

## 核心指标
{chr(10).join(kpi_summary)}

## 已生成图表
{chr(10).join(chart_summary)}

## 要求
1. 站在专业数据分析师视角，用严谨而有洞察力的语言
2. 总体概述控制在80-120字，必须包含至少2个关键数字
3. 关键发现 3-5 条：每条必须有数字证据（绝对值/占比/变化率至少一种）
4. 异常预警 2-3 条：指出潜在风险、影响范围、建议监控阈值
5. 趋势预测 2-3 条：给出短期趋势判断及依据，不得编造未来绝对值
6. 行动建议 3 条：每条必须包含“对象 + 动作 + 目标”
7. 根据数据写2-3段详细分析段落，每段标题+内容，避免套话
8. 禁止使用emoji，保持专业严肃；所有数字引用必须准确，不能编造

返回 JSON 格式:
{{
    "summary": "总体概述...",
    "key_findings": ["发现1", "发现2", ...],
    "anomaly_warnings": ["预警1", "预警2", ...],
    "trend_forecast": ["预测1", "预测2", ...],
    "recommendations": ["建议1", "建议2", ...],
    "detail_paragraphs": [
        {{"title": "段落标题", "content": "段落详细分析内容..."}},
        ...
    ]
}}"""
    if custom_prompt:
        prompt += f"\n\n## 用户指定的分析视角\n{custom_prompt}\n请严格按照上述视角组织你的分析内容。"
    return prompt
