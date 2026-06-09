# backend/app/report/assembler.py
"""
报表组装器 — LLM 两阶段动态规划架构
  Phase 1: LLM 智能规划 (planner.py)
  Phase 2: SQL 批量执行 + 图表构建
  Phase 3: LLM 深度洞察 (insight_generator.py)
"""
import uuid
from datetime import datetime
from typing import Dict, List, Any, Optional, AsyncIterator
import json

from .planner import (
    generate_report_plan,
    collect_schema_context,
    _build_resilient_fallback_plan,
    get_template_min_charts,
)
from .aggregator import execute_plan_sql, query_data_table
from .chart_builder import build_chart_from_plan, DEFAULT_PALETTE
from .insight_generator import generate_report_insights, generate_chart_insights_via_llm
from .templates import get_template
from ..utils.logger import get_logger

logger = get_logger('report.assembler')


def _is_table_placeholder_error(err: Exception) -> bool:
    msg = str(err or "")
    return ("{table" in msg) or ("工作表未找到" in msg) or ("占位符" in msg)


def _execute_single_chart(runtime_file_id: str, chart_item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """执行单个图表查询并构建图表对象。"""
    sql = str(chart_item.get("sql", "")).strip()
    if not sql:
        return None
    result = execute_plan_sql(runtime_file_id, sql)
    return build_chart_from_plan(chart_item, result, DEFAULT_PALETTE)


def _expand_chart_candidates(base_plans: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    扩展图表候选池：在同一 SQL 基础上派生不同图型，避免补图阶段候选不足。
    """
    expanded: List[Dict[str, Any]] = []
    seen_keys = set()

    def _append(plan_item: Dict[str, Any]) -> None:
        sql = str(plan_item.get("sql", "")).strip()
        chart_type = str(plan_item.get("chart_type", "")).strip()
        title = str(plan_item.get("title", "")).strip()
        key = (title, chart_type, sql)
        if not sql or key in seen_keys:
            return
        seen_keys.add(key)
        expanded.append(plan_item)

    for raw in base_plans:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        _append(item)

        base_type = str(item.get("chart_type", "bar")).strip().lower()
        x_field = item.get("x_field")
        y_field = item.get("y_field")
        name_field = item.get("name_field")
        value_field = item.get("value_field")
        has_dim_metric = bool((x_field and y_field) or (name_field and value_field))

        # ------------------------------------------------------------------
        # 同 SQL 多图型派生：提升图表数量上限，避免“只有3图可补”。
        # ------------------------------------------------------------------
        if has_dim_metric:
            if base_type in {"bar", "line", "bar_horizontal"}:
                for t, suffix in [("bar", "柱状图"), ("bar_horizontal", "横向对比"), ("line", "趋势图"), ("pie", "占比图")]:
                    derived = dict(item)
                    derived["chart_type"] = t
                    if t == "pie":
                        derived["name_field"] = name_field or x_field
                        derived["value_field"] = value_field or y_field
                    derived["title"] = f'{item.get("title", "分析图")}·{suffix}'
                    _append(derived)
            elif base_type == "pie":
                for t, suffix in [("bar", "对比图"), ("bar_horizontal", "横向对比"), ("line", "趋势图")]:
                    derived = dict(item)
                    derived["chart_type"] = t
                    if not derived.get("x_field"):
                        derived["x_field"] = derived.get("name_field")
                    if not derived.get("y_field"):
                        derived["y_field"] = derived.get("value_field")
                    derived["title"] = f'{item.get("title", "分析图")}·{suffix}'
                    _append(derived)

    return expanded


def _is_id_like_field_name(field_name: Optional[str]) -> bool:
    """识别 ID/编号类字段名。"""
    text = str(field_name or "").strip().lower()
    if not text:
        return False
    tokens = ["id", "编号", "编码", "code", "uuid", "单号", "流水号", "订单号", "订单行id", "客户id", "产品id"]
    return any(tok in text for tok in tokens)


def _is_bad_chart_dimension(chart_item: Dict[str, Any]) -> bool:
    """
    识别业务意义较差的维度配置（例如订单行ID作为分类维度）。
    """
    if not isinstance(chart_item, dict):
        return False
    x_field = chart_item.get("x_field")
    name_field = chart_item.get("name_field")
    title = str(chart_item.get("title", "")).lower()
    if _is_id_like_field_name(x_field) or _is_id_like_field_name(name_field):
        return True
    return "id维度" in title or "编号维度" in title


def _fill_minimum_charts_if_needed(
    *,
    runtime_file_id: str,
    template_key: str,
    plan: Dict[str, Any],
    schema_ctx: Dict[str, Any],
    charts: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    执行层图表兜底：若实际生成数量不足，使用稳健计划补齐。
    """
    min_required = get_template_min_charts(template_key)
    if len(charts) >= min_required:
        return charts

    fallback_plan = _build_resilient_fallback_plan(
        schema_ctx=schema_ctx,
        template_key=template_key,
        reason="runtime_chart_under_minimum",
    )
    base_candidate_plans = (fallback_plan.get("chart_plan") or []) + (plan.get("chart_plan") or [])
    candidate_plans = _expand_chart_candidates(base_candidate_plans)

    existing_titles = {str(c.get("title", "")).strip() for c in charts if isinstance(c, dict)}
    built_charts = list(charts)
    for chart_item in candidate_plans:
        if len(built_charts) >= min_required:
            break
        if not isinstance(chart_item, dict):
            continue
        if _is_bad_chart_dimension(chart_item):
            logger.warning("执行层补图跳过低价值维度图表: title=%s", chart_item.get("title"))
            continue
        title = str(chart_item.get("title", "")).strip()
        if title and title in existing_titles:
            continue
        try:
            chart = _execute_single_chart(runtime_file_id, chart_item)
            if chart:
                built_charts.append(chart)
                if title:
                    existing_titles.add(title)
        except Exception as err:
            logger.warning("执行层补图失败: title=%s err=%s", chart_item.get("title"), err)

    if len(built_charts) > len(charts):
        logger.info(
            "执行层图表补齐生效: template=%s original=%d filled=%d min_required=%d candidate_count=%d",
            template_key,
            len(charts),
            len(built_charts),
            min_required,
            len(candidate_plans),
        )
    logger.info(
        "执行层图表数量检查: template=%s final=%d required=%d",
        template_key,
        len(built_charts),
        min_required,
    )
    return built_charts


async def generate_report(
    file_id: str,
    template_key: str,
    options: Optional[Dict[str, Any]] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """
    流式生成报表，逐步 yield 各阶段结果。+
    """
    report_id = str(uuid.uuid4())
    opts = options or {}
    runtime_file_id = opts.get("_runtime_file_id") or opts.get("runtime_file_id") or file_id

    raw_custom_prompt = opts.get("custom_prompt", "")
    custom_prompt = ""
    if raw_custom_prompt and isinstance(raw_custom_prompt, str):
        custom_prompt = raw_custom_prompt.replace("\x00", "").replace("\r", "").strip()[:800]

    yield {"event": "progress", "data": {"report_id": report_id, "stage": "planning", "message": "AI 正在分析数据结构并规划报表方案...", "progress": 5}}

    # ── Phase 1: LLM 智能规划。──────────────────────────────

    template = get_template(template_key if template_key != "auto" else "overview")
    style_hint = template.get("style_hint", "")

    try:
        plan = await generate_report_plan(
            runtime_file_id, template_key, style_hint, custom_prompt
        )
    except Exception as e:
        logger.error("Phase1 规划失败: file_id=%s err=%s", file_id, e)
        yield {"event": "error", "data": {"report_id": report_id, "message": f"报表规划失败: {e}"}}
        return

    actual_template_key = template_key if template_key != "auto" else plan.get("_meta", {}).get("template_key", "overview")
    domain_context = {
        "domain": plan.get("domain", "general"),
        "confidence": 0.9,
        "domain_reasoning": plan.get("domain_reasoning", ""),
        "analysis_focus": plan.get("analysis_focus", ""),
        "source": "llm_planner",
    }
    schema_ctx = collect_schema_context(runtime_file_id)

    yield {"event": "progress", "data": {
        "report_id": report_id,
        "stage": "querying",
        "message": "正在执行数据查询...",
        "progress": 25,
        "template_key": actual_template_key,
        "template_name": template["name"],
        "domain": domain_context["domain"],
    }}

    # ── Phase 2: SQL 执行 + 图表构建 ──────────────────────

    # 2a. KPI 查询
    kpis = []
    sql_hard_fail = False
    for kpi_item in plan.get("kpi_plan", []):
        if sql_hard_fail:
            break
        sql = kpi_item.get("sql", "")
        if not sql:
            continue
        try:
            result = execute_plan_sql(runtime_file_id, sql)
            if result["rows"]:
                first_row = result["rows"][0]
                val_col = result["columns"][0] if result["columns"] else None
                if val_col:
                    raw_val = first_row.get(val_col)
                    fmt = kpi_item.get("format", ",.2f")
                    try:
                        formatted = format(float(raw_val), fmt) if raw_val is not None else "--"
                    except (ValueError, TypeError):
                        formatted = str(raw_val) if raw_val is not None else "--"
                    kpis.append({
                        "label": kpi_item.get("label", val_col),
                        "value": raw_val,
                        "formatted": formatted,
                        "unit": kpi_item.get("unit", ""),
                        "field": val_col,
                    })
        except Exception as e:
            logger.warning("KPI SQL 执行失败: label=%s err=%s", kpi_item.get("label"), e)
            if _is_table_placeholder_error(e):
                sql_hard_fail = True
                logger.warning("检测到表占位符/表映射硬错误，后续 SQL 步骤将熔断跳过。")

    yield {"event": "kpis", "data": {"report_id": report_id, "kpis": kpis}}

    yield {"event": "progress", "data": {"report_id": report_id, "stage": "charting", "message": "正在生成图表...", "progress": 45}}

    # 2b. 图表查询 + 构建
    charts = []
    all_chart_plans = plan.get("chart_plan", []) + plan.get("cross_table_analysis", [])

    for chart_item in all_chart_plans:
        if sql_hard_fail:
            break
        if _is_bad_chart_dimension(chart_item):
            logger.warning("图表计划跳过低价值维度: title=%s", chart_item.get("title"))
            continue
        try:
            chart = _execute_single_chart(runtime_file_id, chart_item)
            if chart:
                charts.append(chart)
        except Exception as e:
            logger.warning("图表 SQL 执行/构建失败: title=%s err=%s", chart_item.get("title"), e)
            if _is_table_placeholder_error(e):
                sql_hard_fail = True
                logger.warning("检测到表占位符/表映射硬错误，后续图表 SQL 已熔断。")

    if not sql_hard_fail:
        charts = _fill_minimum_charts_if_needed(
            runtime_file_id=runtime_file_id,
            template_key=actual_template_key,
            plan=plan,
            schema_ctx=schema_ctx,
            charts=charts,
        )

    yield {"event": "charts", "data": {"report_id": report_id, "charts": charts}}

    # ── Phase 3: LLM 洞察 ─────────────────────────────────

    yield {"event": "progress", "data": {"report_id": report_id, "stage": "insight", "message": "AI 正在生成深度分析...", "progress": 70}}

    # 3a. 图表级洞察 (LLM)
    chart_insights = await generate_chart_insights_via_llm(
        charts, plan, domain_context, custom_prompt, runtime_file_id, report_id
    )
    for item in chart_insights:
        idx = item.get("chart_index", -1)
        if isinstance(idx, int) and 0 <= idx < len(charts):
            charts[idx]["insights"] = item.get("bullets", [])

    # 3b. 总体洞察 (LLM)
    insights = await generate_report_insights(
        runtime_file_id, actual_template_key, kpis, charts, schema_ctx,
        report_id=report_id, custom_prompt=custom_prompt,
        domain_context=domain_context, plan=plan,
    )

    logger.info(
        "报表洞察完成: report_id=%s source=%s",
        report_id, insights.get("diagnostics", {}).get("insight_source", "unknown"),
    )

    yield {"event": "insights", "data": {"report_id": report_id, "insights": insights}}

    # ── 明细数据表 ──────────────────────────────────────────

    data_table_plan = plan.get("data_table", {})
    data_table = {"headers": [], "rows": []}
    if data_table_plan.get("sql") and not sql_hard_fail:
        try:
            dt_result = execute_plan_sql(runtime_file_id, data_table_plan["sql"])
            data_table = {
                "headers": dt_result.get("columns", []),
                "rows": dt_result.get("rows", [])[:50],
            }
        except Exception as e:
            logger.warning("明细表查询失败: err=%s", e)

    # ── 组装最终报表 ──────────────────────────────────────

    meta = None
    try:
        from ..large_file.storage import large_file_storage
        display_file_id = opts.get("source_file_id") or opts.get("user_file_id") or file_id
        meta = large_file_storage.get_metadata(display_file_id) or large_file_storage.get_metadata(runtime_file_id)
    except Exception:
        pass

    report = {
        "report_id": report_id,
        "file_id": opts.get("source_file_id") or opts.get("user_file_id") or file_id,
        "runtime_file_id": runtime_file_id,
        "title": f"{meta.original_name if meta else '数据'} — {template['name']}",
        "template_key": actual_template_key,
        "template_name": template["name"],
        "domain_context": domain_context,
        "plan_summary": {
            "domain": plan.get("domain"),
            "analysis_focus": plan.get("analysis_focus"),
            "kpi_count": len(kpis),
            "chart_count": len(charts),
            "cross_table_count": len(plan.get("cross_table_analysis", [])),
        },
        "created_at": datetime.now().isoformat(),
        "status": "completed",
        "kpis": kpis,
        "charts": charts,
        "chart_insights": chart_insights,
        "insights": insights,
        "data_table": data_table,
        "structure_summary": schema_ctx.get("summary", {}) if isinstance(schema_ctx, dict) else {},
        "primary_sheet": schema_ctx["sheets"][0]["sheet_name"] if schema_ctx.get("sheets") else "",
    }

    yield {"event": "complete", "data": report}
