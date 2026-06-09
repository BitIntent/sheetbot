# backend/app/pptx/router.py
"""
PPTX 汇报 API 路由
SSE 流式生成 / 下载 / 列表 / 编辑 / 删除
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse, FileResponse

from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.database import async_session_maker, get_db
from ..core.dependencies import get_current_user
from ..core.quota import QuotaGuard
from ..core.usage_service import increment_usage
from ..files import ugc_registry_service as ugc_registry
from ..large_file.large_file_duckdb import duckdb_manager
from ..large_file.storage import large_file_storage
from ..report.aggregator import execute_plan_sql
from ..utils.logger import get_logger

from .planner import generate_slide_plan
from .builder import build_pptx, render_chart_data_url, render_stock_image_data_url, resolve_cover_image_path
from .pptist_converter import convert_slide_plan
from .templates import get_pptx_template, get_all_pptx_templates
from .storage import (
    new_pptx_id, save_pptx_meta, load_pptx_meta,
    get_pptx_file_path, pptx_storage_relpaths,
    list_user_pptx, update_pptx_slides, delete_pptx,
)

logger = get_logger("pptx.router")

router = APIRouter(prefix="/api/pptx", tags=["pptx"])


# ============================================================
# 模板列表
# ============================================================

@router.get("/templates")
async def get_templates():
    """获取所有 PPTX 模板"""
    return {"templates": get_all_pptx_templates()}


@router.get("/template-cover/{template_key}")
async def get_template_cover(template_key: str):
    """获取模板封面背景图（供前端在线预览使用）"""
    cover_path = resolve_cover_image_path(template_key)
    if not cover_path or not cover_path.exists():
        raise HTTPException(404, "模板封面不存在")
    return FileResponse(path=str(cover_path), media_type="image/png")


# ============================================================
# SSE 流式生成
# ============================================================

def _sse_event(event: str, data: dict) -> str:
    return f"data: {json.dumps({'event': event, 'data': data}, ensure_ascii=False)}\n\n"


def _resolve_runtime_file_id(
    file_id: str | None,
    analysis_file_id: str | None = None,
    user_file_id: str | None = None,
) -> str:
    """
    解析用于 DuckDB 查询的运行时 file_id（analysis_file_id）。
    兼容旧版仅传 file_id 的请求。
    """
    def _has_source_tables(candidate: str | None) -> bool:
        if not candidate:
            return False
        try:
            tables = duckdb_manager.list_available_tables(candidate)
            return any(t.get("type") == "source" for t in tables)
        except Exception:
            return False

    if _has_source_tables(analysis_file_id):
        return analysis_file_id  # 新协议优先
    if _has_source_tables(file_id):
        return file_id

    hinted_user_file_id = user_file_id or file_id
    if hinted_user_file_id:
        try:
            metas = list(large_file_storage.list_files() or [])
            candidates = [
                m for m in metas
                if getattr(m, "source_file_id", None) == hinted_user_file_id
            ]
            candidates.sort(
                key=lambda m: getattr(m, "last_accessed", None) or getattr(m, "created_at", None),
                reverse=True,
            )
            for meta in candidates:
                candidate_id = getattr(meta, "file_id", None)
                if _has_source_tables(candidate_id):
                    logger.info(
                        "PPTX 路由 file_id 兜底命中: input=%s user_file_id=%s resolved=%s",
                        file_id,
                        hinted_user_file_id,
                        candidate_id,
                    )
                    return candidate_id
        except Exception as e:
            logger.warning("PPTX 路由 file_id 兜底失败: input=%s err=%s", file_id, e)

    return analysis_file_id or file_id or user_file_id or ""


@router.post("/generate")
async def generate_pptx(
    request: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _quota=Depends(QuotaGuard("ppt_monthly")),
):
    """SSE 流式生成 PPTX"""
    await increment_usage(user.id, "ppt_count", db)
    file_id = request.get("file_id")
    analysis_file_id = request.get("analysis_file_id")
    user_file_id = request.get("user_file_id")
    template_key = request.get("template_key", "business_blue")
    custom_prompt = request.get("custom_prompt", "")
    runtime_file_id = _resolve_runtime_file_id(
        file_id=file_id,
        analysis_file_id=analysis_file_id,
        user_file_id=user_file_id,
    )
    if not runtime_file_id:
        raise HTTPException(400, "缺少可用的 file_id（analysis_file_id / file_id / user_file_id）")

    async def event_stream():
        pptx_id = new_pptx_id()

        # ── Phase 1: LLM 规划 ──────────────────────────
        yield _sse_event("progress", {
            "pptx_id": pptx_id,
            "stage": "planning",
            "message": "AI 正在规划汇报结构...",
            "progress": 5,
        })

        try:
            plan = await generate_slide_plan(runtime_file_id, template_key, custom_prompt, user_file_id=user_file_id)
        except Exception as e:
            logger.error("PPTX 规划失败: %s", e)
            yield _sse_event("error", {"message": f"规划失败: {e}"})
            yield "data: [DONE]\n\n"
            return

        yield _sse_event("progress", {
            "pptx_id": pptx_id,
            "stage": "querying",
            "message": "正在查询数据...",
            "progress": 25,
        })

        # ── Phase 2: SQL 执行，填充数据 ─────────────────
        slides = plan.get("slides", [])
        tpl = get_pptx_template(template_key)
        colors = tpl.get("colors", {})
        for si, slide_data in enumerate(slides):
            try:
                _fill_slide_data(runtime_file_id, slide_data, colors)
            except Exception as e:
                logger.warning("Slide %d 数据填充失败: %s", si, e)

            pct = 25 + int((si + 1) / max(len(slides), 1) * 35)
            yield _sse_event("progress", {
                "pptx_id": pptx_id,
                "stage": "querying",
                "message": f"查询数据 ({si + 1}/{len(slides)})...",
                "progress": pct,
            })

        yield _sse_event("progress", {
            "pptx_id": pptx_id,
            "stage": "building",
            "message": "正在生成 PPTX 文件...",
            "progress": 65,
        })

        # ── Phase 3: 生成 .pptx 文件 ───────────────────
        try:
            output_path = get_pptx_file_path(pptx_id)
            build_pptx(plan, template_key, output_path)
        except Exception as e:
            logger.error("PPTX 构建失败: %s", e)
            yield _sse_event("error", {"message": f"PPTX 构建失败: {e}"})
            yield "data: [DONE]\n\n"
            return

        yield _sse_event("progress", {
            "pptx_id": pptx_id,
            "stage": "saving",
            "message": "保存元数据...",
            "progress": 90,
        })

        # ── Phase 4: PPTist 格式转换 ─────────────────
        try:
            pptist_data = convert_slide_plan(plan)
        except Exception as e:
            logger.warning("PPTist 转换失败，回退旧格式: %s", e)
            pptist_data = {"aippt_slides": [], "data_elements": []}

        # ── Phase 5: 保存元数据（含 PPTist 结构）─────────
        try:
            meta_file_id = user_file_id or file_id or runtime_file_id
            save_pptx_meta(
                pptx_id,
                str(user.id),
                meta_file_id,
                template_key,
                plan,
                aippt_slides=pptist_data.get("aippt_slides", []),
                data_elements=pptist_data.get("data_elements", []),
            )
            meta_rel, pptx_rel = pptx_storage_relpaths(pptx_id)
            out_p = get_pptx_file_path(pptx_id)
            sz = int(out_p.stat().st_size) if out_p.exists() else 0
            async with async_session_maker() as db_sess:
                try:
                    await ugc_registry.upsert_user_pptx(
                        db_sess,
                        pptx_id=pptx_id,
                        user_id=str(user.id),
                        title=str(plan.get("title") or ""),
                        template_key=template_key,
                        source_file_id=str(meta_file_id or ""),
                        meta_rel_path=meta_rel,
                        pptx_rel_path=pptx_rel,
                        slide_count=len(slides),
                        pptx_size_bytes=sz,
                    )
                    await db_sess.commit()
                except Exception as db_e:
                    logger.warning("user_pptx 注册表写入失败: %s", db_e)
                    await db_sess.rollback()
        except Exception as e:
            logger.warning("保存 PPTX 元数据失败: %s", e)

        # ── 完成 ───────────────────────────────────────
        yield _sse_event("complete", {
            "pptx_id": pptx_id,
            "title": plan.get("title", ""),
            "subtitle": plan.get("subtitle", ""),
            "template_key": template_key,
            "slides": slides,
            "slide_count": len(slides),
            "download_url": f"/api/pptx/download/{pptx_id}",
            "aippt_slides": pptist_data.get("aippt_slides", []),
            "data_elements": pptist_data.get("data_elements", []),
        })
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


_TABLE_PLACEHOLDER_RE = re.compile(r"\{table(?::([^}]+))?\}", re.IGNORECASE)


def _rewrite_mysql_format_to_round(sql: str) -> str:
    """
    将 MySQL 风格 FORMAT(expr, n) 改写为 DuckDB 可执行的 ROUND(expr, n)。
    仅处理函数调用级别，不改写列名/别名中的 FORMAT 文本。
    """
    if not sql or "format(" not in sql.lower():
        return sql

    lower = sql.lower()
    out = []
    i = 0
    n = len(sql)

    while i < n:
        pos = lower.find("format(", i)
        if pos < 0:
            out.append(sql[i:])
            break

        # 追加前缀
        out.append(sql[i:pos])

        # 解析 FORMAT( ... ) 的括号范围
        start = pos + len("format(")
        depth = 1
        j = start
        while j < n and depth > 0:
            ch = sql[j]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            j += 1

        # 括号不完整则原样保留剩余文本
        if depth != 0:
            out.append(sql[pos:])
            break

        inner = sql[start:j - 1]  # 去掉最后的 ')'

        # 在最外层逗号处分割参数
        depth2 = 0
        split_at = -1
        for k, ch in enumerate(inner):
            if ch == "(":
                depth2 += 1
            elif ch == ")":
                depth2 -= 1
            elif ch == "," and depth2 == 0:
                split_at = k

        if split_at > 0:
            expr = inner[:split_at].strip()
            digits = inner[split_at + 1:].strip()
            # DuckDB ROUND 第二参为整型，做显式 CAST 增强稳健性
            out.append(f"ROUND({expr}, CAST({digits} AS INTEGER))")
        else:
            # 不符合双参数结构时，保守原样输出
            out.append(sql[pos:j])

        i = j

    rewritten = "".join(out)
    if rewritten != sql:
        logger.info("PPTX SQL 兼容改写 FORMAT->ROUND: %s -> %s", sql[:140], rewritten[:140])
    return rewritten


def _mysql_datefmt_to_strftime(fmt: str) -> str:
    """
    MySQL DATE_FORMAT 格式符 -> strftime 格式符（常用子集）
    """
    mapping = {
        "%Y": "%Y",  # 4位年
        "%y": "%y",  # 2位年
        "%m": "%m",  # 月(01-12)
        "%c": "%-m", # 月(1-12)
        "%d": "%d",  # 日(01-31)
        "%e": "%-d", # 日(1-31)
        "%H": "%H",  # 小时(00-23)
        "%h": "%I",  # 小时(01-12)
        "%i": "%M",  # 分钟
        "%s": "%S",  # 秒
        "%M": "%B",  # 月名
        "%b": "%b",  # 月简称
        "%W": "%A",  # 星期名
        "%a": "%a",  # 星期简称
    }
    out = fmt
    for k, v in mapping.items():
        out = out.replace(k, v)
    return out


def _rewrite_mysql_date_format(sql: str) -> str:
    """
    将 MySQL DATE_FORMAT(expr, '%Y-%m') 改写为
    strftime(TRY_CAST(expr AS DATE), '%Y-%m')（DuckDB 兼容）
    """
    if not sql or "date_format(" not in sql.lower():
        return sql

    lower = sql.lower()
    out = []
    i = 0
    n = len(sql)

    while i < n:
        pos = lower.find("date_format(", i)
        if pos < 0:
            out.append(sql[i:])
            break
        out.append(sql[i:pos])

        start = pos + len("date_format(")
        depth = 1
        j = start
        while j < n and depth > 0:
            ch = sql[j]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            j += 1
        if depth != 0:
            out.append(sql[pos:])
            break

        inner = sql[start:j - 1]
        depth2 = 0
        split_at = -1
        for k, ch in enumerate(inner):
            if ch == "(":
                depth2 += 1
            elif ch == ")":
                depth2 -= 1
            elif ch == "," and depth2 == 0:
                split_at = k
                break

        if split_at > 0:
            expr = inner[:split_at].strip()
            fmt = inner[split_at + 1:].strip().strip('"').strip("'")
            fmt2 = _mysql_datefmt_to_strftime(fmt)
            out.append(f"strftime(TRY_CAST({expr} AS DATE), '{fmt2}')")
        else:
            out.append(sql[pos:j])

        i = j

    rewritten = "".join(out)
    if rewritten != sql:
        logger.info("PPTX SQL 兼容改写 DATE_FORMAT->strftime: %s -> %s", sql[:140], rewritten[:140])
    return rewritten


def _rewrite_numeric_agg_to_try_cast(sql: str) -> str:
    """
    将 SUM/AVG/MIN/MAX("列") 改写为 SUM/AVG/MIN/MAX(TRY_CAST("列" AS DOUBLE))。
    仅在明显是裸列聚合时改写，尽量不干扰复杂表达式。
    """
    if not sql:
        return sql
    pattern = re.compile(
        r"\b(SUM|AVG|MIN|MAX)\(\s*\"([^\"]+)\"\s*\)",
        flags=re.IGNORECASE,
    )

    def _repl(match: re.Match) -> str:
        fn = match.group(1).upper()
        col = match.group(2)
        return f'{fn}(TRY_CAST("{col}" AS DOUBLE))'

    rewritten = pattern.sub(_repl, sql)
    if rewritten != sql:
        logger.info("PPTX SQL 兼容改写 聚合->TRY_CAST: %s -> %s", sql[:140], rewritten[:140])
    return rewritten


def _resolve_plan_sql(file_id: str, sql: str) -> str:
    """
    将 LLM 计划 SQL 中的占位符替换为真实 DuckDB 表名：
    - {table} -> 默认源表
    - {table:工作表名} -> 指定工作表对应表
    """
    if not sql:
        return sql

    sql = _rewrite_mysql_date_format(sql)
    sql = _rewrite_mysql_format_to_round(sql)
    if "{table" not in sql.lower():
        return sql

    tables = duckdb_manager.list_available_tables(file_id)
    if not tables:
        return sql

    source_tables = [t for t in tables if t.get("type") == "source"]
    default_table = (source_tables[0] if source_tables else tables[0]).get("table_name")

    table_by_sheet = {}
    for t in tables:
        name = str(t.get("name", "")).strip()
        table_name = t.get("table_name")
        if not name or not table_name:
            continue
        table_by_sheet[name.lower()] = table_name

    def _replace(match: re.Match) -> str:
        sheet_name = (match.group(1) or "").strip().strip('"').strip("'")
        target = default_table
        if sheet_name:
            target = table_by_sheet.get(sheet_name.lower(), default_table)
        if not target:
            return match.group(0)
        return f'"{target}"'

    resolved = _TABLE_PLACEHOLDER_RE.sub(_replace, sql)
    if resolved != sql:
        logger.info("PPTX SQL 占位符已替换: %s -> %s", sql[:140], resolved[:140])
    return resolved


def _to_numeric_or_none(val: Any) -> Optional[float]:
    """将常见文本数值（千分位/货币/百分比）归一化为 float。"""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        try:
            return float(val)
        except Exception:
            return None

    text = str(val).strip()
    if not text:
        return None
    text = text.replace(",", "").replace("，", "")
    text = text.replace("￥", "").replace("¥", "").replace("$", "")
    is_percent = text.endswith("%")
    if is_percent:
        text = text[:-1]
    text = re.sub(r"[^\d.\-+eE]", "", text)
    if text in {"", "-", "+", ".", "-.", "+."}:
        return None
    try:
        num = float(text)
    except Exception:
        return None
    return num / 100.0 if is_percent else num


def _resolve_chart_fields(chart: Dict[str, Any], rows: List[Dict[str, Any]]) -> tuple[str, str]:
    """基于 rows 自动补全/修正 x_field 与 y_field。"""
    first_row = rows[0] if rows else {}
    keys = [k for k in first_row.keys() if k]
    x_field = str(chart.get("x_field") or "").strip()
    y_field = str(chart.get("y_field") or "").strip()

    if not x_field or x_field not in first_row:
        x_field = keys[0] if keys else ""

    if not y_field or y_field not in first_row:
        best_field = ""
        best_ratio = -1.0
        for k in keys:
            if k == x_field:
                continue
            col_vals = [_to_numeric_or_none(r.get(k)) for r in rows]
            numeric_count = sum(1 for v in col_vals if v is not None)
            ratio = numeric_count / max(len(rows), 1)
            if ratio > best_ratio:
                best_ratio = ratio
                best_field = k
        y_field = best_field

    return x_field, y_field


def _normalize_chart_rows(chart: Dict[str, Any], rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    图表数据稳健归一化：
    - 自动修正 x/y 字段
    - y 列统一转 float
    - 丢弃无法解析的坏行，避免渲染阶段出现“全 0 假图”
    """
    if not rows or not isinstance(rows[0], dict):
        return {"rows": [], "x_field": "", "y_field": "", "dropped": 0}

    x_field, y_field = _resolve_chart_fields(chart, rows)
    if not x_field or not y_field:
        return {"rows": [], "x_field": x_field, "y_field": y_field, "dropped": len(rows)}

    normalized_rows: List[Dict[str, Any]] = []
    dropped = 0
    for row in rows:
        if not isinstance(row, dict):
            dropped += 1
            continue
        x_raw = row.get(x_field)
        y_raw = row.get(y_field)
        x_text = str(x_raw).strip() if x_raw is not None else ""
        y_num = _to_numeric_or_none(y_raw)
        if not x_text or y_num is None:
            dropped += 1
            continue
        fixed = dict(row)
        fixed[x_field] = x_text
        fixed[y_field] = y_num
        normalized_rows.append(fixed)

    return {
        "rows": normalized_rows,
        "x_field": x_field,
        "y_field": y_field,
        "dropped": dropped,
    }


def _fill_slide_data(file_id: str, slide_data: dict, colors: dict):
    """执行 slide 中的 SQL 并填充数据"""
    # 页面素材图（用于在线预览与导出一致化）
    image_query = (slide_data.get("image_query") or "").strip()
    if image_query:
        img_data_url = render_stock_image_data_url(image_query)
        if img_data_url:
            slide_data["image_data_url"] = img_data_url

    # KPI SQL
    kpis = slide_data.get("kpis") or []
    for kpi in kpis:
        sql = _resolve_plan_sql(file_id, kpi.get("sql", ""))
        if not sql:
            continue
        try:
            result = execute_plan_sql(file_id, sql)
            rows = result.get("rows", [])
            if rows and rows[0]:
                raw_val = rows[0][0] if isinstance(rows[0], (list, tuple)) else list(rows[0].values())[0]
                kpi["value"] = _format_value(raw_val)
        except Exception as e:
            logger.warning("KPI SQL 执行失败: %s", e)
            kpi["value"] = "--"

    # 图表 SQL
    chart = slide_data.get("chart")
    if chart and chart.get("sql"):
        try:
            resolved_sql = _resolve_plan_sql(file_id, chart["sql"])
            resolved_sql = _rewrite_numeric_agg_to_try_cast(resolved_sql)
            result = execute_plan_sql(file_id, resolved_sql)
            raw_rows = result.get("rows", [])
            normalized = _normalize_chart_rows(chart, raw_rows)
            chart["x_field"] = normalized["x_field"] or chart.get("x_field", "")
            chart["y_field"] = normalized["y_field"] or chart.get("y_field", "")
            chart["data"] = normalized["rows"]
            if normalized["dropped"] > 0:
                logger.info(
                    "Chart 数据归一化: title=%s kept=%d dropped=%d x=%s y=%s",
                    chart.get("title", ""),
                    len(chart["data"]),
                    normalized["dropped"],
                    chart.get("x_field", ""),
                    chart.get("y_field", ""),
                )
            if not chart["data"]:
                chart["render_issue"] = "chart_no_valid_numeric_rows"
                logger.warning(
                    "Chart 数据为空（归一化后）: title=%s sql=%s",
                    chart.get("title", ""),
                    str(resolved_sql)[:180],
                )
            chart_img = render_chart_data_url(chart, colors)
            if chart_img:
                chart["image_data_url"] = chart_img
            elif chart.get("data"):
                chart["render_issue"] = "chart_render_failed"
                logger.warning("Chart 图像渲染失败: title=%s", chart.get("title", ""))
        except Exception as e:
            logger.warning(
                "Chart SQL 执行失败: title=%s err=%s sql=%s",
                chart.get("title", ""),
                e,
                str(chart.get("sql", ""))[:180],
            )
            chart["data"] = []
            chart["render_issue"] = "chart_sql_failed"

    # 表格 SQL
    table = slide_data.get("table")
    if table and table.get("sql"):
        try:
            resolved_sql = _resolve_plan_sql(file_id, table["sql"])
            result = execute_plan_sql(file_id, resolved_sql)
            rows = result.get("rows", [])
            if rows:
                if isinstance(rows[0], dict):
                    row_keys = list(rows[0].keys())
                    requested_cols = table.get("columns") or []
                    cols = requested_cols if requested_cols else row_keys

                    # 先按列名语义匹配，再按位置兜底，避免“表头有值但数据全空”
                    key_index = {_normalize_col_key(k): k for k in row_keys}
                    aligned_keys: list[str] = []
                    for idx, col in enumerate(cols):
                        direct = key_index.get(_normalize_col_key(col))
                        if direct:
                            aligned_keys.append(direct)
                        elif idx < len(row_keys):
                            aligned_keys.append(row_keys[idx])
                        else:
                            aligned_keys.append("")

                    table["columns"] = cols
                    table["rows"] = [
                        [str(r.get(k, "")) if k else "" for k in aligned_keys]
                        for r in rows[:table.get("max_rows", 10)]
                    ]
                else:
                    table["rows"] = [[str(v) for v in row] for row in rows[:table.get("max_rows", 10)]]
        except Exception as e:
            logger.warning("Table SQL 执行失败: %s", e)
            table["rows"] = []


def _format_value(val) -> str:
    """格式化 KPI 数值"""
    if val is None:
        return "--"
    try:
        num = float(val)
        if abs(num) >= 1_0000_0000:
            return f"{num / 1_0000_0000:.2f}亿"
        if abs(num) >= 1_0000:
            return f"{num / 1_0000:.2f}万"
        if num == int(num):
            return str(int(num))
        return f"{num:,.2f}"
    except (TypeError, ValueError):
        return str(val)


def _normalize_col_key(name: str) -> str:
    """列名归一化：用于 columns 与 SQL 实际返回键名对齐。"""
    if name is None:
        return ""
    s = str(name).strip().lower()
    # 去掉常见分隔符，减少“中文别名/下划线/空格”带来的映射失败
    return re.sub(r"[\s_\-（）()]+", "", s)


# ============================================================
# 幻灯片 CRUD
# ============================================================

@router.get("/slides/{pptx_id}")
async def get_slides(pptx_id: str, user: User = Depends(get_current_user)):
    """获取幻灯片 JSON 数据"""
    meta = load_pptx_meta(pptx_id)
    if not meta:
        raise HTTPException(404, "汇报不存在")
    if meta.get("user_id") != str(user.id):
        raise HTTPException(403, "无权访问")

    # 尝试从存储中获取 PPTist 格式数据，否则实时转换
    aippt_slides = meta.get("aippt_slides", [])
    data_elements = meta.get("data_elements", [])
    pptist_slides = meta.get("pptist_slides", [])

    if not aippt_slides and meta.get("slides"):
        try:
            plan = {
                "title": meta.get("title", ""),
                "subtitle": meta.get("subtitle", ""),
                "slides": meta.get("slides", []),
            }
            pptist_data = convert_slide_plan(plan)
            aippt_slides = pptist_data.get("aippt_slides", [])
            data_elements = pptist_data.get("data_elements", [])
        except Exception as e:
            logger.warning("历史汇报 PPTist 转换失败: %s", e)

    return {
        "pptx_id": meta["pptx_id"],
        "title": meta.get("title", ""),
        "subtitle": meta.get("subtitle", ""),
        "template_key": meta.get("template_key", ""),
        "slides": meta.get("slides", []),
        "slide_count": meta.get("slide_count", 0),
        "download_url": f"/api/pptx/download/{pptx_id}",
        "aippt_slides": aippt_slides,
        "data_elements": data_elements,
        "pptist_slides": pptist_slides,
    }


@router.put("/slides/{pptx_id}")
async def update_slides(pptx_id: str, body: dict, user: User = Depends(get_current_user)):
    """更新幻灯片内容"""
    meta = load_pptx_meta(pptx_id)
    if not meta:
        raise HTTPException(404, "汇报不存在")
    if meta.get("user_id") != str(user.id):
        raise HTTPException(403, "无权操作")

    pptist_slides = body.get("pptist_slides")
    if pptist_slides is None:
        pptist_slides = body.get("slides", [])
    if not isinstance(pptist_slides, list):
        raise HTTPException(400, "slides 格式错误")

    if not update_pptx_slides(pptx_id, pptist_slides, slide_field="pptist_slides"):
        raise HTTPException(500, "更新失败")

    meta2 = load_pptx_meta(pptx_id) or {}
    sc = int(meta2.get("pptist_slide_count") or meta2.get("slide_count") or 0)
    async with async_session_maker() as db_sess:
        try:
            await ugc_registry.update_user_pptx_slide_count(db_sess, pptx_id, sc)
            await db_sess.commit()
        except Exception:
            await db_sess.rollback()

    return {"ok": True}


# ============================================================
# 下载
# ============================================================

@router.get("/download/{pptx_id}")
async def download_pptx(pptx_id: str, user: User = Depends(get_current_user)):
    """下载 .pptx 文件"""
    meta = load_pptx_meta(pptx_id)
    if not meta:
        raise HTTPException(404, "汇报不存在")
    if meta.get("user_id") != str(user.id):
        raise HTTPException(403, "无权下载")

    file_path = get_pptx_file_path(pptx_id)
    if not file_path.exists():
        raise HTTPException(404, "PPTX 文件不存在")

    filename = f"{meta.get('title', '汇报')}.pptx"
    return FileResponse(
        path=str(file_path),
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )


# ============================================================
# 列表 & 删除
# ============================================================

@router.get("/list")
async def list_pptx(user: User = Depends(get_current_user)):
    """用户历史汇报列表"""
    items = list_user_pptx(str(user.id))
    return {"items": items}


@router.delete("/{pptx_id}")
async def delete_pptx_endpoint(pptx_id: str, user: User = Depends(get_current_user)):
    """删除汇报"""
    meta = load_pptx_meta(pptx_id)
    if not meta:
        raise HTTPException(404, "汇报不存在")
    if meta.get("user_id") != str(user.id):
        raise HTTPException(403, "无权删除")

    delete_pptx(pptx_id)
    async with async_session_maker() as db_sess:
        try:
            await ugc_registry.mark_user_pptx_deleted(db_sess, pptx_id)
            await db_sess.commit()
        except Exception:
            await db_sess.rollback()
    return {"ok": True}
