# backend/app/report/insight_generator.py
"""
AI 洞察生成器 — 调用 Claude 生成结构化分析文字
Phase 3: 图表级解读 + 总体报表洞察均由 LLM 驱动
"""
import json
import math
import os
from typing import Dict, List, Any, Optional
from ..utils.logger import get_logger
from .insight_fallback_engine import fallback_insights
from .insight_prompt_builder import build_chart_insight_prompt, build_report_insight_prompt
from .insight_quality_gate import sanitize_chart_insights, report_insight_needs_fallback, get_report_quality_issue

logger = get_logger('report.insight')
AI_INSIGHT_TOTAL_TIMEOUT_SEC = 300
AI_INSIGHT_IDLE_TIMEOUT_SEC = 25
AI_INSIGHT_MAX_CHARS = 20000
REPORT_INSIGHT_USE_TOOLS_FIRST = os.getenv("REPORT_INSIGHT_USE_TOOLS_FIRST", "false").lower() == "true"


# ─────────────────────────────────────────────────────────
# Phase 3a: 图表级 LLM 洞察
# ─────────────────────────────────────────────────────────

async def generate_chart_insights_via_llm(
    charts: List[Dict[str, Any]],
    plan: Dict[str, Any],
    domain_context: Dict[str, Any],
    custom_prompt: Optional[str] = None,
    file_id: Optional[str] = None,
    report_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    LLM 驱动的图表级洞察：为每张图表生成 3 条结构化解读。
    使用 Claude Agent SDK 进行单次请求批量处理所有图表。
    """
    if not charts:
        return []

    prompt = build_chart_insight_prompt(
        charts=charts,
        plan=plan,
        domain_context=domain_context,
        custom_prompt=custom_prompt,
    )

    try:
        from .llm_client import call_llm_single
        from .llm_executor import call_llm_with_tools

        if file_id:
            try:
                raw_text = await call_llm_with_tools(
                    file_id=file_id,
                    prompt=prompt,
                    system_prompt="你是一位资深数据分析师，擅长为图表生成精炼的数据解读。",
                    timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                    max_turns=12,
                    session_prefix="report_chart_insight",
                )
            except Exception as tools_err:
                logger.warning("图表洞察 tools 调用失败，回退单次调用: report_id=%s err=%s", report_id, tools_err)
                raw_text = await call_llm_single(
                    prompt=prompt,
                    model="claude-sonnet-4-20250514",
                    max_tokens=4096,
                    timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                    system_prompt="你是一位资深数据分析师，擅长为图表生成精炼的数据解读。",
                )
        else:
            raw_text = await call_llm_single(
                prompt=prompt,
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                system_prompt="你是一位资深数据分析师，擅长为图表生成精炼的数据解读。",
            )

        result = _parse_json_array(raw_text)
        if isinstance(result, list):
            return sanitize_chart_insights(result, charts, _deterministic_chart_bullets)

        logger.warning("图表洞察 JSON 解析失败，回退规则引擎: raw=%s", raw_text[:200])

    except Exception as e:
        logger.warning("图表洞察 LLM 调用失败，回退规则引擎: err=%s", e)

    return _rule_based_chart_insights_fallback(charts, domain_context)


def _parse_json_array(raw: str) -> Optional[list]:
    text = raw.strip()
    try:
        result = json.loads(text)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    import re
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return None


def _extract_json_object(raw: str) -> Optional[dict]:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            obj = json.loads(text[start:end])
            return obj if isinstance(obj, dict) else None
        except Exception:
            return None
    return None


def _split_text_sentences(text: str) -> List[str]:
    """将自然语言文本切分为句子列表。"""
    cleaned = (text or "").replace("\r", "\n")
    parts = []
    for line in cleaned.split("\n"):
        line = line.strip(" -\t")
        if not line:
            continue
        chunks = [x.strip() for x in line.replace("；", "。").replace("!", "。").replace("?", "。").split("。")]
        for item in chunks:
            if item:
                parts.append(item)
    return parts


def _coerce_non_json_report_text(raw_text: str) -> Optional[Dict[str, Any]]:
    """
    将非 JSON 的 AI 文本尽量转换为结构化洞察。
    目标：避免二次修复失败后直接退化为低信息量 fallback。
    """
    text = (raw_text or "").strip()
    if not text:
        return None

    sentences = _split_text_sentences(text)
    if not sentences:
        return None

    key_findings: List[str] = []
    anomaly_warnings: List[str] = []
    trend_forecast: List[str] = []
    recommendations: List[str] = []
    detail_paragraphs: List[str] = []

    for s in sentences:
        lower = s.lower()
        if any(k in s for k in ["建议", "应当", "可考虑", "优化", "提升", "推进"]) or any(
            kw in lower for kw in ["recommend", "action", "optimiz", "improv"]
        ):
            recommendations.append(s)
            continue
        if any(k in s for k in ["风险", "异常", "偏差", "预警", "波动"]) or any(
            kw in lower for kw in ["risk", "anomal", "warning"]
        ):
            anomaly_warnings.append(s)
            continue
        if any(k in s for k in ["趋势", "预计", "预测", "后续", "持续"]) or any(
            kw in lower for kw in ["trend", "forecast", "outlook"]
        ):
            trend_forecast.append(s)
            continue
        key_findings.append(s)

    if not key_findings and len(sentences) >= 2:
        key_findings = sentences[:3]
    if not recommendations and len(sentences) >= 3:
        recommendations = sentences[-2:]

    summary = "；".join(sentences[:2])[:180]
    detail_paragraphs = ["。".join(sentences[:4])[:320]] if sentences else []

    return {
        "summary": summary or "已完成数据洞察抽取。",
        "key_findings": key_findings[:5],
        "anomaly_warnings": anomaly_warnings[:4],
        "trend_forecast": trend_forecast[:4],
        "recommendations": recommendations[:4],
        "detail_paragraphs": detail_paragraphs[:2],
    }


async def _repair_json_with_llm(raw_text: str) -> Optional[dict]:
    """使用轻量修复提示将非标准输出转为合法 JSON。"""
    from .llm_client import call_llm_single

    compact = (raw_text or "")[:12000]
    repair_prompt = f"""请将以下文本修复为合法 JSON 对象，并严格保留这些顶层字段:
summary, key_findings, anomaly_warnings, trend_forecast, recommendations, detail_paragraphs

规则:
1. 仅输出 JSON，不要解释
2. 缺失字段补空数组（summary 补空字符串）
3. 不允许输出 Markdown 代码块

原始文本:
{compact}
"""
    try:
        fixed = await call_llm_single(
            prompt=repair_prompt,
            model="claude-sonnet-4-20250514",
            max_tokens=2500,
            timeout=45,
            system_prompt="你是严格 JSON 修复器。",
        )
        return _extract_json_object(fixed)
    except Exception:
        return None


async def _retry_low_quality_report_insight(
    *,
    quality_issue: str,
    current_result: Dict[str, Any],
    template_key: str,
    kpis: List[Dict[str, Any]],
    charts: List[Dict[str, Any]],
    structure: Dict[str, Any],
    custom_prompt: Optional[str],
    domain_context: Optional[Dict[str, Any]],
    plan: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """
    当首次 AI 洞察质量不达标时，进行一次强化重试，尽量避免直接降级到稳健模式。
    """
    from .llm_client import call_llm_single

    base_prompt = build_report_insight_prompt(
        template_key=template_key,
        kpis=kpis,
        charts=charts,
        structure=structure,
        custom_prompt=custom_prompt,
        domain_context=domain_context,
        plan=plan,
    )
    retry_prompt = f"""{base_prompt}

## 上次输出质量问题
- issue: {quality_issue}
- current_summary: {str(current_result.get('summary', ''))[:280]}
- current_key_findings_count: {len(current_result.get('key_findings', []) if isinstance(current_result.get('key_findings'), list) else [])}

## 强制修正规则（必须满足）
1. summary 必须 80-120 字，且包含至少 2 个具体数字
2. key_findings 至少 3 条，且每条都含至少 1 个数字证据
3. recommendations 至少 3 条，且每条必须是“对象+动作+目标”
4. 只能输出 JSON，不要解释文字
"""
    try:
        retried = await call_llm_single(
            prompt=retry_prompt,
            model="claude-sonnet-4-20250514",
            max_tokens=3200,
            timeout=90,
            system_prompt="你是严格的数据分析报告生成器。输出必须可被机器解析且满足质量约束。",
        )
        retried_result = _extract_json_object(retried)
        if retried_result is None:
            return None
        for key in ["summary", "key_findings", "anomaly_warnings", "trend_forecast", "recommendations", "detail_paragraphs"]:
            if key not in retried_result:
                retried_result[key] = [] if key != "summary" else "暂无摘要"
        return retried_result
    except Exception as err:
        logger.warning("AI 洞察低质重试失败: issue=%s err=%s", quality_issue, err)
        return None


def _format_num(value: float) -> str:
    abs_val = abs(value)
    if abs_val >= 100000000:
        return f"{value / 100000000:.2f}亿"
    if abs_val >= 10000:
        return f"{value / 10000:.2f}万"
    if abs_val >= 100:
        return f"{value:,.0f}"
    return f"{value:.2f}"


def _extract_points(chart: Dict[str, Any]) -> List[Dict[str, Any]]:
    option = chart.get("option", {}) if isinstance(chart, dict) else {}
    series = option.get("series", []) if isinstance(option, dict) else []
    if not series:
        return []

    first_series = series[0] if isinstance(series[0], dict) else {}
    data = first_series.get("data", [])
    x_axis = option.get("xAxis", {})
    labels = x_axis.get("data", []) if isinstance(x_axis, dict) else []
    points: List[Dict[str, Any]] = []
    for idx, item in enumerate(data):
        name = labels[idx] if idx < len(labels) else f"第{idx + 1}项"
        val: Optional[float] = None
        if isinstance(item, (int, float)):
            val = float(item)
        elif isinstance(item, dict):
            if item.get("name"):
                name = str(item.get("name"))
            raw = item.get("value")
            if isinstance(raw, (int, float)):
                val = float(raw)
        if val is not None and math.isfinite(val):
            points.append({"name": str(name), "value": val})
    return points


def _deterministic_chart_bullets(chart: Dict[str, Any]) -> List[str]:
    title = str(chart.get("title", "当前图表"))
    chart_type = str(chart.get("type", "bar"))
    points = _extract_points(chart)
    if not points:
        return [f"{title} 当前没有可用于解读的有效数值，建议先核对字段映射与聚合口径。"]

    values = [p["value"] for p in points]
    total = sum(values)
    avg = total / len(values)
    top = max(points, key=lambda x: x["value"])
    bottom = min(points, key=lambda x: x["value"])
    top3 = sorted(points, key=lambda x: x["value"], reverse=True)[:3]
    top3_ratio = (sum(p["value"] for p in top3) / total * 100.0) if total else 0.0

    if chart_type == "line" and len(points) >= 2:
        delta = values[-1] - values[0]
        delta_pct = (delta / abs(values[0]) * 100.0) if values[0] else 0.0
        trend = "上升" if delta > 0 else ("下降" if delta < 0 else "持平")
        return [
            f"{title}整体呈{trend}趋势：从{points[0]['name']}到{points[-1]['name']}变动{_format_num(delta)}（{delta_pct:.1f}%）。",
            f"峰值在{top['name']}（{_format_num(top['value'])}），低点在{bottom['name']}（{_format_num(bottom['value'])}），建议复盘对应时段动作。",
            f"当前均值约{_format_num(avg)}，建议围绕高于均值阶段提炼可复制打法，并对低于均值阶段做专项修正。",
        ]

    return [
        f"{title}中，最高项为{top['name']}（{_format_num(top['value'])}），最低项为{bottom['name']}（{_format_num(bottom['value'])}）。",
        f"TOP3 项（{'、'.join(p['name'] for p in top3)}）合计占比{top3_ratio:.1f}%，{('头部集中度偏高，需降低结构依赖。' if top3_ratio >= 70 else '结构相对均衡，可挖掘长尾增量。')}",
        f"整体均值约{_format_num(avg)}，建议将低于均值维度纳入改进清单，并持续跟踪资源投入产出比。",
    ]


def _rule_based_chart_insights_fallback(
    charts: List[Dict[str, Any]],
    domain_context: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """规则引擎兜底：为每张图表生成基础解读。"""
    results = []
    for idx, chart in enumerate(charts):
        title = chart.get("title", f"图表{idx+1}")
        ctype = chart.get("type", "bar")
        bullets = _deterministic_chart_bullets(chart)
        results.append({
            "chart_index": idx,
            "title": title,
            "type": ctype,
            "bullets": bullets,
        })
    return results


# ─────────────────────────────────────────────────────────
# Phase 3b: 总体报表 LLM 洞察
# ─────────────────────────────────────────────────────────

async def generate_report_insights(
    file_id: str,
    template_key: str,
    kpis: List[Dict[str, Any]],
    charts: List[Dict[str, Any]],
    structure: Dict[str, Any],
    report_id: Optional[str] = None,
    custom_prompt: Optional[str] = None,
    domain_context: Optional[Dict[str, Any]] = None,
    plan: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """调用 AI 生成报表总体洞察。"""
    prompt = build_report_insight_prompt(
        template_key=template_key,
        kpis=kpis,
        charts=charts,
        structure=structure,
        custom_prompt=custom_prompt,
        domain_context=domain_context,
        plan=plan,
    )

    try:
        from .llm_client import call_llm_single
        from .llm_executor import call_llm_with_tools

        response_content = ""
        stream_reason = ""

        if REPORT_INSIGHT_USE_TOOLS_FIRST:
            try:
                response_content = await call_llm_with_tools(
                    file_id=file_id,
                    prompt=prompt,
                    system_prompt="你是一位资深数据分析师和行业专家，擅长将复杂数据转为结构化业务洞察。",
                    timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                    max_turns=20,
                    max_chars=AI_INSIGHT_MAX_CHARS,
                    session_prefix="report_insight",
                )
                stream_reason = "tools_single_call"
            except Exception as tools_err:
                logger.warning("总体洞察 tools 调用失败，回退单次调用: report_id=%s err=%s", report_id, tools_err)
                response_content = await call_llm_single(
                    prompt=prompt,
                    model="claude-sonnet-4-20250514",
                    max_tokens=5000,
                    timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                    system_prompt="你是一位资深数据分析师和行业专家，擅长将复杂数据转为结构化业务洞察。",
                )
                stream_reason = "single_call_fallback_from_tools"
        else:
            try:
                response_content = await call_llm_single(
                    prompt=prompt,
                    model="claude-sonnet-4-20250514",
                    max_tokens=5000,
                    timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                    system_prompt="你是一位资深数据分析师和行业专家，擅长将复杂数据转为结构化业务洞察。",
                )
                stream_reason = "single_call"
            except Exception as single_err:
                logger.warning("总体洞察单次调用失败，回退 tools 调用: report_id=%s err=%s", report_id, single_err)
                response_content = await call_llm_with_tools(
                    file_id=file_id,
                    prompt=prompt,
                    system_prompt="你是一位资深数据分析师和行业专家，擅长将复杂数据转为结构化业务洞察。",
                    timeout=AI_INSIGHT_TOTAL_TIMEOUT_SEC,
                    max_turns=20,
                    max_chars=AI_INSIGHT_MAX_CHARS,
                    session_prefix="report_insight",
                )
                stream_reason = "tools_fallback_after_single"

        text_char_count = len(response_content)
        logger.info(
            "AI 洞察调用完成: report_id=%s reason=%s chars=%s",
            report_id, stream_reason, text_char_count,
        )

        result = _extract_json_object(response_content)
        if result is None:
            logger.warning("AI 洞察 JSON 解析失败，尝试本地结构化转换: report_id=%s", report_id)
            result = _coerce_non_json_report_text(response_content)
        if result is None:
            logger.warning("本地结构化转换失败，尝试 LLM 修复: report_id=%s", report_id)
            result = await _repair_json_with_llm(response_content)
        if result is not None:

            for key in ["summary", "key_findings", "anomaly_warnings", "trend_forecast", "recommendations", "detail_paragraphs"]:
                if key not in result:
                    result[key] = [] if key != "summary" else "暂无摘要"

            if report_insight_needs_fallback(result):
                issue = get_report_quality_issue(result) or "insight_quality_gate_failed"
                logger.warning("AI 洞察质量不足，尝试强化重试: report_id=%s issue=%s", report_id, issue)
                retried = await _retry_low_quality_report_insight(
                    quality_issue=issue,
                    current_result=result,
                    template_key=template_key,
                    kpis=kpis,
                    charts=charts,
                    structure=structure,
                    custom_prompt=custom_prompt,
                    domain_context=domain_context,
                    plan=plan,
                )
                if retried is not None and not report_insight_needs_fallback(retried):
                    diagnostics = retried.get("diagnostics", {})
                    diagnostics["insight_source"] = "ai"
                    diagnostics["stream_reason"] = "quality_retry_single_call"
                    diagnostics["response_chars"] = len(json.dumps(retried, ensure_ascii=False))
                    retried["diagnostics"] = diagnostics
                    logger.info("AI 洞察质量重试成功: report_id=%s", report_id)
                    return retried
                logger.warning("AI 洞察重试后仍低质，使用数据驱动兜底: report_id=%s", report_id)
                return fallback_insights(
                    "low_quality_response", issue,
                    template_key=template_key, kpis=kpis, charts=charts, custom_prompt=custom_prompt,
                )

            diagnostics = result.get("diagnostics", {})
            diagnostics["insight_source"] = "ai"
            diagnostics["stream_reason"] = stream_reason
            diagnostics["response_chars"] = text_char_count
            if diagnostics.get("stream_reason") == stream_reason and _extract_json_object(response_content) is None:
                diagnostics["coerce_mode"] = "non_json_text_to_structured"
            result["diagnostics"] = diagnostics
            return result

        return fallback_insights(
            "json_parse_failed", "json_extract_and_repair_failed",
            template_key=template_key, kpis=kpis, charts=charts, custom_prompt=custom_prompt,
        )

    except Exception as e:
        logger.error("AI 洞察生成异常: report_id=%s err=%s", report_id, e)
        return fallback_insights(
            "exception", str(e),
            template_key=template_key, kpis=kpis, charts=charts, custom_prompt=custom_prompt,
        )


# ── 向后兼容导出 (assembler 旧版可能引用) ──────────────────

def generate_structured_chart_insights(
    charts: List[Dict[str, Any]],
    template_key: str = "overview",
    domain_context: Optional[Dict[str, Any]] = None,
    custom_prompt: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """向后兼容的同步图表洞察（规则引擎兜底）。"""
    return _rule_based_chart_insights_fallback(charts, domain_context or {})
