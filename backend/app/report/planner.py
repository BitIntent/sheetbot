# backend/app/report/planner.py
"""
LLM 报表规划器 — Phase 1
通过 Claude Agent SDK 学习所有工作表结构后，动态输出报表方案（KPI + 图表 + SQL）
"""
import json
import math
import os
import time
from typing import Any, Dict, List, Optional

from ..core.config import settings
from ..large_file.large_file_duckdb import duckdb_manager
from ..large_file.storage import large_file_storage
from ..utils.context_budget import build_adaptive_prompt, enforce_hard_cap
from ..utils.json_output_guard import extract_json_object, guard_json_output
from ..utils.logger import get_logger

logger = get_logger("report.planner")

PLANNER_TIMEOUT_SEC = 180
# 提速策略：先用短超时 tools 回合快速尝试，失败再回退单次调用。
PLANNER_FAST_TOOLS_TIMEOUT_SEC = 60
PLANNER_FAST_TOOLS_MAX_TURNS = 8
PLANNER_SINGLE_CALL_TIMEOUT_SEC = 45
PLANNER_USE_TOOLS_FIRST = os.getenv("REPORT_PLANNER_USE_TOOLS_FIRST", "false").lower() == "true"
PLANNER_MAX_TOKENS = 8192
SAMPLE_ROWS = 5
MAX_NUMERIC_STATS = 12

SUPPORTED_CHART_TYPES = [
    "line", "bar", "bar_horizontal", "bar_grouped",
    "pie", "radar", "scatter", "heatmap",
    "gauge", "funnel", "treemap",
]

TEMPLATE_MIN_CHARTS = {
    "overview": 4,
    "comparison": 4,
    "trend": 8,
    "ranking": 3,
    "executive": 2,
    "anomaly": 4,
    "segment": 4,
    "funnel": 8,
}

TEMPLATE_MIN_KPIS = {
    "overview": 8,
    "comparison": 8,
    "trend": 8,
    "ranking": 8,
    "executive": 8,
    "anomaly": 8,
    "segment": 8,
    "funnel": 8,
}


def get_template_min_charts(template_key: str) -> int:
    """返回模板最少图表数量。"""
    return TEMPLATE_MIN_CHARTS.get(template_key, 3)


def get_template_min_kpis(template_key: str) -> int:
    """返回模板最少 KPI 数量。"""
    return TEMPLATE_MIN_KPIS.get(template_key, 8)


def _is_id_like_column(col_name: Optional[str]) -> bool:
    """判断列名是否属于 ID/编号类字段。"""
    text = str(col_name or "").strip().lower()
    if not text:
        return False
    tokens = ["id", "编号", "编码", "code", "uuid", "单号", "流水号", "订单号", "订单行id", "客户id", "产品id"]
    return any(tok in text for tok in tokens)


def _pick_fallback_category_column(primary_sheet: Dict[str, Any]) -> Optional[str]:
    """
    为稳健计划选择更有业务意义的分类维度：
    1) 排除 ID/编号类字段
    2) 优先唯一值占比不过高的列（避免明细键）
    """
    text_cols = [c for c in (primary_sheet.get("text_columns") or []) if c]
    if not text_cols:
        return None

    row_count = int(primary_sheet.get("row_count") or 0)
    uniq_map = primary_sheet.get("category_unique_counts") or {}

    filtered = [c for c in text_cols if not _is_id_like_column(c)]
    candidates = filtered if filtered else text_cols

    scored = []
    for col in candidates:
        uniq = int(uniq_map.get(col, 0) or 0)
        ratio = (uniq / row_count) if row_count > 0 else 1.0
        scored.append((col, ratio))
    scored.sort(key=lambda x: x[1])
    return scored[0][0] if scored else candidates[0]


def _planner_model() -> str:
    """
    统一规划器模型选择，优先使用当前环境有效模型，避免硬编码导致跨模型环境失败。
    """
    return settings.ANTHROPIC_EFFECTIVE_MODEL or "claude-sonnet-4-20250514"


def _build_resilient_fallback_plan(
    schema_ctx: Dict[str, Any],
    template_key: str,
    reason: str,
) -> Dict[str, Any]:
    """
    Phase1 失败时的稳健兜底规划（可执行 SQL）。
    设计目标：宁可保守，也要保证输出可执行。
    """
    sheets = schema_ctx.get("sheets") or []
    if not sheets:
        raise ValueError("未找到可用于兜底规划的工作表")

    primary = sheets[0]
    sheet_name = primary.get("sheet_name") or "Sheet1"
    table_ref = f"{{table:{sheet_name}}}"
    numeric_cols = [c for c in (primary.get("numeric_columns") or []) if c]
    text_cols = [c for c in (primary.get("text_columns") or []) if c]
    date_cols = [c for c in (primary.get("date_columns") or []) if c]
    columns = [c.get("name") for c in (primary.get("columns") or []) if isinstance(c, dict) and c.get("name")]

    metric_col = numeric_cols[0] if numeric_cols else None
    category_col = _pick_fallback_category_column(primary)
    date_col = date_cols[0] if date_cols else None
    count_col = next((c for c in columns if "ID" in str(c).upper() or "编号" in str(c)), None)
    if not count_col:
        count_col = columns[0] if columns else None

    kpi_plan = _build_fallback_kpi_candidates(schema_ctx, template_key)
    if not kpi_plan:
        kpi_plan = []
        if metric_col:
            kpi_plan.extend([
                {
                    "label": f"总{metric_col}",
                    "sql": f'SELECT SUM("{metric_col}") FROM {table_ref}',
                    "unit": "",
                    "format": ",.2f",
                },
                {
                    "label": f"平均{metric_col}",
                    "sql": f'SELECT AVG("{metric_col}") FROM {table_ref}',
                    "unit": "",
                    "format": ",.2f",
                },
            ])
        if count_col:
            kpi_plan.append(
                {
                    "label": "记录数量",
                    "sql": f'SELECT COUNT(DISTINCT "{count_col}") FROM {table_ref}',
                    "unit": "条",
                    "format": ",.0f",
                }
            )

    chart_plan: List[Dict[str, Any]] = []
    if date_col and metric_col:
        chart_plan.append(
            {
                "title": f"{metric_col}趋势",
                "chart_type": "line",
                "sql": (
                    f'SELECT strftime(date_trunc(\'month\', CAST("{date_col}" AS DATE)), \'%Y-%m\') as month, '
                    f'SUM("{metric_col}") as value '
                    f'FROM {table_ref} '
                    f'WHERE "{date_col}" IS NOT NULL GROUP BY date_trunc(\'month\', CAST("{date_col}" AS DATE)) '
                    f'ORDER BY date_trunc(\'month\', CAST("{date_col}" AS DATE))'
                ),
                "x_field": "month",
                "y_field": "value",
                "insight_hint": "观察趋势变化与拐点",
            }
        )
    if category_col and metric_col:
        chart_plan.append(
            {
                "title": f"{category_col}维度{metric_col}对比",
                "chart_type": "bar",
                "sql": (
                    f'SELECT "{category_col}" as category, SUM("{metric_col}") as value '
                    f'FROM {table_ref} WHERE "{category_col}" IS NOT NULL '
                    f'GROUP BY "{category_col}" ORDER BY value DESC LIMIT 15'
                ),
                "x_field": "category",
                "y_field": "value",
                "insight_hint": "识别头部与尾部维度差异",
            }
        )
        chart_plan.append(
            {
                "title": f"{category_col}维度平均{metric_col}对比",
                "chart_type": "bar_horizontal",
                "sql": (
                    f'SELECT "{category_col}" as category, AVG("{metric_col}") as value '
                    f'FROM {table_ref} WHERE "{category_col}" IS NOT NULL '
                    f'GROUP BY "{category_col}" ORDER BY value DESC LIMIT 15'
                ),
                "x_field": "category",
                "y_field": "value",
                "insight_hint": "观察不同分层的单体效率差异",
            }
        )
        chart_plan.append(
            {
                "title": f"{category_col}维度{metric_col}占比",
                "chart_type": "pie",
                "sql": (
                    f'SELECT "{category_col}" as category, SUM("{metric_col}") as value '
                    f'FROM {table_ref} WHERE "{category_col}" IS NOT NULL '
                    f'GROUP BY "{category_col}" ORDER BY value DESC LIMIT 12'
                ),
                "name_field": "category",
                "value_field": "value",
                "insight_hint": "识别贡献占比结构与头部集中度",
            }
        )

    if not chart_plan and category_col:
        chart_plan.append(
            {
                "title": f"{category_col}分布",
                "chart_type": "bar",
                "sql": (
                    f'SELECT "{category_col}" as category, COUNT(*) as value '
                    f'FROM {table_ref} WHERE "{category_col}" IS NOT NULL '
                    f'GROUP BY "{category_col}" ORDER BY value DESC LIMIT 15'
                ),
                "x_field": "category",
                "y_field": "value",
                "insight_hint": "观察样本分布集中度",
            }
        )
        chart_plan.append(
            {
                "title": f"{category_col}分布占比",
                "chart_type": "pie",
                "sql": (
                    f'SELECT "{category_col}" as category, COUNT(*) as value '
                    f'FROM {table_ref} WHERE "{category_col}" IS NOT NULL '
                    f'GROUP BY "{category_col}" ORDER BY value DESC LIMIT 12'
                ),
                "name_field": "category",
                "value_field": "value",
                "insight_hint": "观察样本结构占比",
            }
        )

    select_cols = columns[: min(8, len(columns))]
    data_sql = (
        f'SELECT {", ".join(f"""\"{c}\"""" for c in select_cols)} FROM {table_ref} LIMIT 30'
        if select_cols
        else f"SELECT * FROM {table_ref} LIMIT 30"
    )

    return {
        "domain": "general",
        "domain_reasoning": "LLM 规划阶段不可用，已回退为稳健模板规划。",
        "analysis_focus": f"基于 {sheet_name} 的核心指标与结构分布（稳健模式）",
        "kpi_plan": kpi_plan,
        "chart_plan": chart_plan,
        "cross_table_analysis": [],
        "data_table": {"title": "明细抽样", "sql": data_sql},
        "_meta": {
            "template_key": template_key if template_key != "auto" else "overview",
            "planner_source": "fallback",
            "planner_fallback_reason": reason,
        },
    }


def collect_schema_context(file_id: str) -> Dict[str, Any]:
    """
    收集所有已加载工作表的结构 + 抽样数据 + 数值统计。
    返回结构化 context 字典，直接用于构建 LLM prompt。
    """
    tables = duckdb_manager.list_available_tables(file_id)
    source_tables = [t for t in tables if t.get("type") == "source"]

    sheets_ctx: List[Dict[str, Any]] = []

    for tbl in source_tables:
        table_name = tbl.get("table_name")
        sheet_name = tbl.get("name", "")
        if not table_name:
            continue

        try:
            desc = duckdb_manager.conn.execute(
                f'DESCRIBE "{table_name}"'
            ).fetchall()
            row_count_r = duckdb_manager.conn.execute(
                f'SELECT COUNT(*) FROM "{table_name}"'
            ).fetchone()
            total_rows = row_count_r[0] if row_count_r else 0

            columns: List[Dict[str, str]] = []
            numeric_cols: List[str] = []
            date_cols: List[str] = []
            text_cols: List[str] = []

            NUMERIC_TYPES = {
                "INTEGER", "BIGINT", "DOUBLE", "FLOAT", "DECIMAL",
                "NUMERIC", "REAL", "SMALLINT", "TINYINT", "HUGEINT",
            }
            DATE_TYPES = {
                "DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE",
                "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS",
            }

            max_cols = settings.REPORT_MAX_COLUMNS_PER_TABLE
            desc_limited = desc[:max_cols]
            total_cols = len(desc)
            if total_cols > max_cols:
                logger.info(
                    "表 %s 列数超限: total=%d limit=%d，仅分析前 %d 列",
                    sheet_name, total_cols, max_cols, max_cols,
                )

            for col_name, col_type, *_ in desc_limited:
                col_upper = col_type.upper()
                columns.append({"name": col_name, "type": col_type})
                if any(t in col_upper for t in NUMERIC_TYPES):
                    numeric_cols.append(col_name)
                elif any(t in col_upper for t in DATE_TYPES):
                    date_cols.append(col_name)
                else:
                    text_cols.append(col_name)

            # 抽样数据（仅前 N 列，控制 prompt 体积）
            sample_rows: List[Dict[str, Any]] = []
            try:
                col_names = [d[0] for d in desc_limited]
                cols_sql = ", ".join(f'"{c}"' for c in col_names)
                sample_sql = f'SELECT {cols_sql} FROM "{table_name}" LIMIT {SAMPLE_ROWS}'
                result = duckdb_manager.conn.execute(sample_sql).fetchall()
                for row in result:
                    r = {}
                    for i, cn in enumerate(col_names):
                        val = row[i]
                        if val is None:
                            r[cn] = None
                        elif isinstance(val, float):
                            r[cn] = round(val, 4) if math.isfinite(val) else None
                        else:
                            r[cn] = str(val)
                    sample_rows.append(r)
            except Exception as e:
                logger.warning("抽样数据失败: table=%s err=%s", table_name, e)

            # 数值统计
            numeric_stats: Dict[str, Dict[str, Any]] = {}
            for nc in numeric_cols[:MAX_NUMERIC_STATS]:
                try:
                    stats_sql = (
                        f'SELECT MIN("{nc}"), MAX("{nc}"), AVG("{nc}"), '
                        f'SUM("{nc}"), COUNT(DISTINCT "{nc}") '
                        f'FROM "{table_name}" WHERE "{nc}" IS NOT NULL'
                    )
                    sr = duckdb_manager.conn.execute(stats_sql).fetchone()
                    if sr and sr[0] is not None:
                        numeric_stats[nc] = {
                            "min": _safe_num(sr[0]),
                            "max": _safe_num(sr[1]),
                            "avg": _safe_num(sr[2]),
                            "sum": _safe_num(sr[3]),
                            "distinct_count": int(sr[4]) if sr[4] else 0,
                        }
                except Exception:
                    pass

            # 文本列唯一值数量（帮助 LLM 判断是否适合做分类维度）
            category_info: Dict[str, int] = {}
            for tc in text_cols[:8]:
                try:
                    uq = duckdb_manager.conn.execute(
                        f'SELECT COUNT(DISTINCT "{tc}") FROM "{table_name}" '
                        f'WHERE "{tc}" IS NOT NULL'
                    ).fetchone()
                    if uq:
                        category_info[tc] = int(uq[0])
                except Exception:
                    pass

            ctx: Dict[str, Any] = {
                "sheet_name": sheet_name,
                "table_name": table_name,
                "row_count": total_rows,
                "columns": columns,
                "numeric_columns": numeric_cols,
                "date_columns": date_cols,
                "text_columns": text_cols,
                "sample_rows": sample_rows,
                "numeric_stats": numeric_stats,
                "category_unique_counts": category_info,
            }
            if total_cols > max_cols:
                ctx["columns_truncated"] = total_cols - max_cols
            sheets_ctx.append(ctx)

        except Exception as e:
            logger.warning("收集工作表结构失败: sheet=%s err=%s", sheet_name, e)

    meta = None
    try:
        meta = large_file_storage.get_metadata(file_id)
    except Exception:
        pass

    return {
        "file_id": file_id,
        "file_name": meta.original_name if meta else "",
        "sheets": sheets_ctx,
        "total_sheets": len(sheets_ctx),
    }


def _safe_num(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return round(f, 4) if math.isfinite(f) else None
    except Exception:
        return None


def _build_planner_prompt(
    schema_ctx: Dict[str, Any],
    template_key: str,
    style_hint: str,
    custom_prompt: Optional[str] = None,
) -> str:
    """构建 Phase 1 LLM prompt。"""

    sheets_desc = []
    for s in schema_ctx.get("sheets", []):
        header = f'### 工作表: "{s["sheet_name"]}" (DuckDB 表名: "{s["table_name"]}", {s["row_count"]} 行)'
        if s.get("columns_truncated"):
            shown = settings.REPORT_MAX_COLUMNS_PER_TABLE
            header += f" [仅展示前 {shown} 列，后续 {s['columns_truncated']} 列已省略]"
        lines = [header]
        col_lines = []
        for c in s.get("columns", []):
            col_lines.append(f'  - "{c["name"]}" ({c["type"]})')
        lines.append("列:\n" + "\n".join(col_lines))

        if s.get("numeric_stats"):
            stat_lines = []
            for nc, st in s["numeric_stats"].items():
                stat_lines.append(
                    f'  - "{nc}": min={st["min"]}, max={st["max"]}, '
                    f'avg={st["avg"]}, sum={st["sum"]}, distinct={st["distinct_count"]}'
                )
            lines.append("数值统计:\n" + "\n".join(stat_lines))

        if s.get("category_unique_counts"):
            cat_lines = []
            for tc, cnt in s["category_unique_counts"].items():
                cat_lines.append(f'  - "{tc}": {cnt} 个唯一值')
            lines.append("分类维度:\n" + "\n".join(cat_lines))

        if s.get("sample_rows"):
            lines.append(
                "抽样数据 (前5行):\n"
                + json.dumps(s["sample_rows"], ensure_ascii=False, indent=2)
            )

        sheets_desc.append("\n".join(lines))

    all_sheets = "\n\n".join(sheets_desc)

    prompt = f"""你是一位资深数据分析师，需要根据以下数据库表结构为用户生成一份专业的数据分析报表方案。

## 数据源

文件: {schema_ctx.get("file_name", "未知")}
共 {schema_ctx.get("total_sheets", 0)} 张工作表

{all_sheets}

## 分析风格

模板偏好: {template_key}
风格指引: {style_hint}

## 要求

请输出一个 JSON 对象作为报表方案，严格遵循以下规则：

1. **SQL 语法**: 必须是 DuckDB SQL，表名和列名用双引号包裹，列名必须精确匹配上方提供的列名
2. **KPI**: 规划 4-8 个有业务意义的 KPI 指标，每个包含一条聚合 SQL
3. **图表**: 规划 4-10 张图表，每张包含完整的查询 SQL 和字段映射
4. **跨表分析**: 如果多张表之间存在可关联字段（如相同含义的ID、名称），规划 JOIN 查询
5. **领域识别**: 根据字段名和数据特征推断业务领域
6. **图表类型**: 从以下类型选择: {', '.join(SUPPORTED_CHART_TYPES)}
7. **不要编造列名**: 所有 SQL 中引用的列名必须严格来自上方提供的列定义

## 输出格式（严格 JSON）

```json
{{
  "domain": "retail|manufacturing|finance|general",
  "domain_reasoning": "简要说明为什么判断为该领域...",
  "analysis_focus": "本次报表的分析重点和切入角度...",
  "kpi_plan": [
    {{
      "label": "KPI显示名称",
      "sql": "SELECT ... FROM ...",
      "unit": "元|%|个|条",
      "format": ",.2f"
    }}
  ],
  "chart_plan": [
    {{
      "title": "图表标题",
      "chart_type": "line|bar|pie|...",
      "sql": "SELECT ... FROM ... GROUP BY ... ORDER BY ...",
      "x_field": "X轴字段名",
      "y_field": "Y轴字段名",
      "series_field": "可选-系列分组字段",
      "name_field": "可选-饼图名称字段",
      "value_field": "可选-饼图值字段",
      "insight_hint": "该图表应关注的分析方向"
    }}
  ],
  "cross_table_analysis": [
    {{
      "title": "跨表分析标题",
      "chart_type": "bar_grouped|...",
      "sql": "SELECT ... FROM table1 a JOIN table2 b ON ... GROUP BY ...",
      "x_field": "...",
      "y_field": "...",
      "series_field": "...",
      "join_reasoning": "说明关联逻辑"
    }}
  ],
  "data_table": {{
    "title": "明细表标题",
    "sql": "SELECT ... FROM ... LIMIT 30"
  }}
}}
```

只输出 JSON，不要包含 ```json 标记或任何其他文字。"""

    if custom_prompt:
        prompt += f"\n\n## 用户自定义分析视角\n{custom_prompt}\n请将上述视角作为报表分析的核心切入点，所有KPI和图表都应围绕此视角展开。"

    return prompt


def _build_strict_json_prompt(base_prompt: str) -> str:
    """构建强制 JSON 输出提示词。"""
    strict_prompt = (
        base_prompt
        + "\n\n【最终输出硬性约束】\n"
          "1) 你的回复第一个字符必须是 '{'，最后一个字符必须是 '}'。\n"
          "2) 不要输出任何解释、说明、前言、后记、Markdown 代码块。\n"
          "3) 若无法确定某字段，请填空字符串或空数组，但仍必须返回合法 JSON 对象。\n"
    )
    return enforce_hard_cap(strict_prompt)


async def _repair_json_fallback(raw_text: str) -> Dict[str, Any]:
    """当输出夹杂解释或轻微语法错误时，执行“仅 JSON 修复”回退。"""
    from .llm_client import call_llm_single

    repair_prompt = f"""你是 JSON 修复器。请把以下文本修复为“单个合法 JSON 对象”。

硬性约束：
1) 输出第一字符必须是 '{{'，最后字符必须是 '}}'
2) 只输出 JSON，不要解释文字，不要 markdown
3) 不可改写业务语义；仅做结构修复（去前后缀、补引号/逗号、闭合括号）

待修复文本：
{raw_text}
"""
    repaired = await call_llm_single(
        prompt=repair_prompt,
        model=_planner_model(),
        max_tokens=PLANNER_MAX_TOKENS,
        timeout=45,
        system_prompt="你是严格 JSON 修复器，只输出合法 JSON。",
    )
    return extract_json_object(repaired)


async def _force_json_fallback(prompt_text: str) -> Dict[str, Any]:
    """当首轮解析失败时，使用单次调用强制输出纯 JSON。"""
    from .llm_client import call_llm_single

    strict_prompt = _build_strict_json_prompt(prompt_text)
    raw = await call_llm_single(
        prompt=strict_prompt,
        model=_planner_model(),
        max_tokens=PLANNER_MAX_TOKENS,
        timeout=PLANNER_SINGLE_CALL_TIMEOUT_SEC,
        system_prompt="你是一位资深数据分析师，擅长根据数据库表结构生成专业的数据分析报表方案。",
    )
    return extract_json_object(raw)


async def generate_report_plan(
    file_id: str,
    template_key: str,
    style_hint: str,
    custom_prompt: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Phase 1: 调用 Claude API 生成报表规划 JSON。
    使用 Claude Agent SDK 进行单次请求。
    """
    from .llm_client import call_llm_single
    from .llm_executor import call_llm_with_tools

    raw_schema_ctx = collect_schema_context(file_id)

    if not raw_schema_ctx.get("sheets"):
        raise ValueError("未找到可分析的工作表数据")

    target_chars = settings.REPORT_PROMPT_CHAR_TARGET

    def _prompt_builder(ctx):
        return _build_planner_prompt(ctx, template_key, style_hint, custom_prompt)

    prompt_text, schema_ctx, compress_info = build_adaptive_prompt(
        raw_schema_ctx=raw_schema_ctx,
        prompt_builder=_prompt_builder,
        target_chars=target_chars,
        module_name="report_planner",
    )
    prompt_text = enforce_hard_cap(prompt_text)

    logger.info(
        "Phase1 上下文预算: compressed=%s profile=%s original_chars=%d selected_chars=%d",
        compress_info.get("compressed"), compress_info.get("selected_profile"),
        compress_info.get("original_chars"), compress_info.get("selected_chars"),
    )

    start_t = time.monotonic()
    logger.info(
        "Phase1 LLM 规划开始: file_id=%s template=%s sheets=%d custom_prompt=%s",
        file_id, template_key, len(schema_ctx["sheets"]), bool(custom_prompt),
    )

    try:
        # 默认走“单次严格 JSON 直出”，避免 tools 探索式输出污染 JSON 解析。
        strict_prompt = _build_strict_json_prompt(prompt_text)
        if PLANNER_USE_TOOLS_FIRST:
            logger.info(
                "Phase1 启用 tools-first 路径: timeout=%ss turns=%s",
                PLANNER_FAST_TOOLS_TIMEOUT_SEC,
                PLANNER_FAST_TOOLS_MAX_TURNS,
            )
            raw_text = await call_llm_with_tools(
                file_id=file_id,
                prompt=prompt_text,
                system_prompt="你是一位资深数据分析师，擅长根据数据库表结构生成专业的数据分析报表方案。",
                timeout=PLANNER_FAST_TOOLS_TIMEOUT_SEC,
                max_turns=PLANNER_FAST_TOOLS_MAX_TURNS,
                max_chars=12000,
                session_prefix="report_planner",
            )
        else:
            logger.info(
                "Phase1 使用 strict-json 直出路径: model=%s timeout=%ss",
                _planner_model(),
                PLANNER_SINGLE_CALL_TIMEOUT_SEC,
            )
            raw_text = await call_llm_single(
                prompt=strict_prompt,
                model=_planner_model(),
                max_tokens=PLANNER_MAX_TOKENS,
                timeout=PLANNER_SINGLE_CALL_TIMEOUT_SEC,
                system_prompt="你是一位资深数据分析师，擅长根据数据库表结构生成专业的数据分析报表方案。",
            )

        elapsed = time.monotonic() - start_t
        logger.info(
            "Phase1 LLM 规划完成: file_id=%s elapsed=%.2fs chars=%d",
            file_id, elapsed, len(raw_text),
        )

        async def _force() -> Dict[str, Any]:
            return await _force_json_fallback(prompt_text)

        async def _repair() -> Dict[str, Any]:
            return await _repair_json_fallback(raw_text)

        plan = await guard_json_output(
            raw_text,
            validator=_validate_plan,
            force_json_fallback=_force,
            repair_json_fallback=_repair,
            logger=logger,
            module_name="report.planner",
        )

        normalized_template = template_key if template_key != "auto" else plan.get("_meta", {}).get("template_key", "overview")
        plan = _ensure_minimum_charts(
            plan=plan,
            schema_ctx=schema_ctx,
            template_key=normalized_template,
        )
        plan = _ensure_minimum_kpis(
            plan=plan,
            schema_ctx=schema_ctx,
            template_key=normalized_template,
        )

        plan["_meta"] = {
            "file_id": file_id,
            "template_key": template_key,
            "schema_context_sheets": len(schema_ctx["sheets"]),
            "elapsed_seconds": round(elapsed, 2),
            "model": _planner_model(),
        }

        return plan

    except TimeoutError:
        elapsed = time.monotonic() - start_t
        logger.error("Phase1 LLM 规划超时: file_id=%s elapsed=%.2fs，回退稳健规划", file_id, elapsed)
        return _build_resilient_fallback_plan(schema_ctx, template_key, reason="timeout")
    except Exception as e:
        elapsed = time.monotonic() - start_t
        logger.error(
            "Phase1 LLM 规划失败: file_id=%s elapsed=%.2fs err=%s，回退稳健规划",
            file_id, elapsed, e,
        )
        return _build_resilient_fallback_plan(schema_ctx, template_key, reason="exception")


def _ensure_minimum_charts(
    plan: Dict[str, Any],
    schema_ctx: Dict[str, Any],
    template_key: str,
) -> Dict[str, Any]:
    """
    保证规划图表数量不低于模板基线，避免生成单图报表。
    补图来源：稳健 fallback 计划，确保 SQL 可执行性。
    """
    min_charts = TEMPLATE_MIN_CHARTS.get(template_key, 3)
    chart_plan = list(plan.get("chart_plan") or [])
    if len(chart_plan) >= min_charts:
        return plan

    fallback_plan = _build_resilient_fallback_plan(
        schema_ctx=schema_ctx,
        template_key=template_key,
        reason="chart_plan_under_minimum",
    )
    fallback_charts = fallback_plan.get("chart_plan") or []

    existing_sql = {str(c.get("sql", "")).strip() for c in chart_plan if isinstance(c, dict)}
    for chart in fallback_charts:
        if not isinstance(chart, dict):
            continue
        sql = str(chart.get("sql", "")).strip()
        if not sql or sql in existing_sql:
            continue
        chart_plan.append(chart)
        existing_sql.add(sql)
        if len(chart_plan) >= min_charts:
            break

    if len(chart_plan) > len(plan.get("chart_plan") or []):
        logger.info(
            "Phase1 图表补齐生效: template=%s original=%d filled=%d min_required=%d",
            template_key,
            len(plan.get("chart_plan") or []),
            len(chart_plan),
            min_charts,
        )
    plan["chart_plan"] = chart_plan
    return plan


def _build_fallback_kpi_candidates(
    schema_ctx: Dict[str, Any],
    template_key: str,
) -> List[Dict[str, Any]]:
    """
    基于结构上下文构建稳健 KPI 候选，确保最少 KPI 数量可达标。
    """
    sheets = schema_ctx.get("sheets") or []
    if not sheets:
        return []

    primary = sheets[0]
    sheet_name = primary.get("sheet_name") or "Sheet1"
    table_ref = f"{{table:{sheet_name}}}"
    columns = [c.get("name") for c in (primary.get("columns") or []) if isinstance(c, dict) and c.get("name")]
    numeric_cols = [c for c in (primary.get("numeric_columns") or []) if c]
    text_cols = [c for c in (primary.get("text_columns") or []) if c]
    row_count = int(primary.get("row_count") or 0)

    candidates: List[Dict[str, Any]] = []

    candidates.append({
        "label": "记录数量",
        "sql": f"SELECT COUNT(*) FROM {table_ref}",
        "unit": "条",
        "format": ",.0f",
    })

    # 优先业务数值列，最多取 2 列，避免 KPI 语义发散。
    selected_numeric = numeric_cols[:2]
    for metric in selected_numeric:
        candidates.extend([
            {
                "label": f"总{metric}",
                "sql": f'SELECT SUM("{metric}") FROM {table_ref}',
                "unit": "",
                "format": ",.2f",
            },
            {
                "label": f"平均{metric}",
                "sql": f'SELECT AVG("{metric}") FROM {table_ref}',
                "unit": "",
                "format": ",.2f",
            },
            {
                "label": f"最大{metric}",
                "sql": f'SELECT MAX("{metric}") FROM {table_ref}',
                "unit": "",
                "format": ",.2f",
            },
            {
                "label": f"最小{metric}",
                "sql": f'SELECT MIN("{metric}") FROM {table_ref}',
                "unit": "",
                "format": ",.2f",
            },
        ])

    # 若数值列不足，补充稳健的结构类 KPI（均为单值 SQL）。
    fallback_categories = []
    preferred_category = _pick_fallback_category_column(primary)
    if preferred_category:
        fallback_categories.append(preferred_category)
    for col in text_cols:
        if col not in fallback_categories:
            fallback_categories.append(col)
    for cat_col in fallback_categories[:2]:
        candidates.append({
            "label": f"{cat_col}分类数",
            "sql": f'SELECT COUNT(DISTINCT "{cat_col}") FROM {table_ref}',
            "unit": "类",
            "format": ",.0f",
        })

    if columns:
        first_col = columns[0]
        candidates.append({
            "label": f"{first_col}非空记录",
            "sql": f'SELECT COUNT("{first_col}") FROM {table_ref}',
            "unit": "条",
            "format": ",.0f",
        })

    if row_count > 0 and selected_numeric:
        metric = selected_numeric[0]
        # 输出占比型 KPI，增强管理层可读性。
        candidates.append({
            "label": f"{metric}缺失率",
            "sql": (
                f'SELECT (1 - (COUNT("{metric}") * 1.0 / NULLIF(COUNT(*), 0))) * 100 '
                f"FROM {table_ref}"
            ),
            "unit": "%",
            "format": ".2f",
        })

    min_kpis = get_template_min_kpis(template_key)
    deduped: List[Dict[str, Any]] = []
    seen = set()
    for item in candidates:
        label = str(item.get("label", "")).strip()
        sql = str(item.get("sql", "")).strip()
        if not label or not sql:
            continue
        key = (label, sql)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
        if len(deduped) >= max(min_kpis, 10):
            break
    return deduped


def _build_structured_kpi_baseline(
    schema_ctx: Dict[str, Any],
    template_key: str,
) -> List[Dict[str, Any]]:
    """
    构建固定语义顺序的 KPI 基线（优先保证前 8 张卡片稳定）：
    规模 -> 效率 -> 分布 -> 质量
    """
    sheets = schema_ctx.get("sheets") or []
    if not sheets:
        return []

    primary = sheets[0]
    sheet_name = primary.get("sheet_name") or "Sheet1"
    table_ref = f"{{table:{sheet_name}}}"
    columns = [c.get("name") for c in (primary.get("columns") or []) if isinstance(c, dict) and c.get("name")]
    numeric_cols = [c for c in (primary.get("numeric_columns") or []) if c]
    text_cols = [c for c in (primary.get("text_columns") or []) if c]
    preferred_category = _pick_fallback_category_column(primary)
    primary_metric = numeric_cols[0] if numeric_cols else None

    fallback_categories: List[str] = []
    if preferred_category:
        fallback_categories.append(preferred_category)
    for col in text_cols:
        if col not in fallback_categories:
            fallback_categories.append(col)

    baseline: List[Dict[str, Any]] = [
        {"label": "记录数量", "sql": f"SELECT COUNT(*) FROM {table_ref}", "unit": "条", "format": ",.0f"},
    ]

    if primary_metric:
        baseline.extend([
            {"label": f"总{primary_metric}", "sql": f'SELECT SUM("{primary_metric}") FROM {table_ref}', "unit": "", "format": ",.2f"},
            {"label": f"平均{primary_metric}", "sql": f'SELECT AVG("{primary_metric}") FROM {table_ref}', "unit": "", "format": ",.2f"},
            {"label": f"最大{primary_metric}", "sql": f'SELECT MAX("{primary_metric}") FROM {table_ref}', "unit": "", "format": ",.2f"},
            {"label": f"最小{primary_metric}", "sql": f'SELECT MIN("{primary_metric}") FROM {table_ref}', "unit": "", "format": ",.2f"},
        ])

    for cat_col in fallback_categories[:2]:
        baseline.append({
            "label": f"{cat_col}分类数",
            "sql": f'SELECT COUNT(DISTINCT "{cat_col}") FROM {table_ref}',
            "unit": "类",
            "format": ",.0f",
        })

    if primary_metric:
        baseline.append({
            "label": f"{primary_metric}缺失率",
            "sql": (
                f'SELECT (1 - (COUNT("{primary_metric}") * 1.0 / NULLIF(COUNT(*), 0))) * 100 '
                f"FROM {table_ref}"
            ),
            "unit": "%",
            "format": ".2f",
        })
    elif columns:
        first_col = columns[0]
        baseline.append({
            "label": f"{first_col}非空记录",
            "sql": f'SELECT COUNT("{first_col}") FROM {table_ref}',
            "unit": "条",
            "format": ",.0f",
        })

    min_kpis = get_template_min_kpis(template_key)
    fallback = _build_fallback_kpi_candidates(schema_ctx, template_key)
    merged: List[Dict[str, Any]] = []
    seen = set()
    for item in baseline + fallback:
        label = str(item.get("label", "")).strip()
        sql = str(item.get("sql", "")).strip()
        if not label or not sql:
            continue
        key = (label, sql)
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
        if len(merged) >= min_kpis:
            break
    return merged


def _ensure_minimum_kpis(
    plan: Dict[str, Any],
    schema_ctx: Dict[str, Any],
    template_key: str,
) -> Dict[str, Any]:
    """
    保证规划 KPI 数量不低于模板基线，避免前端只出现少量卡片。
    """
    min_kpis = get_template_min_kpis(template_key)
    original_kpis = list(plan.get("kpi_plan") or [])
    structured_baseline = _build_structured_kpi_baseline(schema_ctx, template_key)
    fallback_candidates = _build_fallback_kpi_candidates(schema_ctx, template_key)

    merged: List[Dict[str, Any]] = []
    seen = set()
    for source in (structured_baseline, original_kpis, fallback_candidates):
        for item in source:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label", "")).strip()
            sql = str(item.get("sql", "")).strip()
            if not label or not sql:
                continue
            key = (label, sql)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

    final_kpis = merged[: max(min_kpis, 12)]
    if len(final_kpis) < min_kpis:
        final_kpis = merged

    logger.info(
        "Phase1 KPI 结构化编排: template=%s original=%d baseline=%d final=%d min_required=%d",
        template_key,
        len(original_kpis),
        len(structured_baseline),
        len(final_kpis),
        min_kpis,
    )
    plan["kpi_plan"] = final_kpis
    return plan


def _validate_plan(plan: Dict[str, Any]) -> None:
    """校验 plan 结构完整性。"""
    if not isinstance(plan, dict):
        raise ValueError("plan 必须是 dict")

    if "kpi_plan" not in plan or not isinstance(plan["kpi_plan"], list):
        plan["kpi_plan"] = []
    if "chart_plan" not in plan or not isinstance(plan["chart_plan"], list):
        plan["chart_plan"] = []
    if "cross_table_analysis" not in plan:
        plan["cross_table_analysis"] = []
    if "data_table" not in plan:
        plan["data_table"] = {"title": "明细数据", "sql": ""}

    for kpi in plan["kpi_plan"]:
        if not kpi.get("sql"):
            logger.warning("KPI 缺少 sql: %s", kpi.get("label"))
        if not kpi.get("label"):
            kpi["label"] = "未命名指标"

    for chart in plan["chart_plan"] + plan.get("cross_table_analysis", []):
        if not chart.get("sql"):
            logger.warning("图表缺少 sql: %s", chart.get("title"))
        if chart.get("chart_type") not in SUPPORTED_CHART_TYPES:
            chart["chart_type"] = "bar"
        if not chart.get("title"):
            chart["title"] = "未命名图表"
