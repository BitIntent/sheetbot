# backend/app/report/aggregator.py
"""
数据聚合查询 — 从 DuckDB 内存表中按报表需求执行 SQL 聚合
新增 execute_plan_sql / validate_sql 支持 LLM 生成的动态 SQL
"""
import math
import re
import time
from typing import Dict, List, Any, Optional
from ..large_file.large_file_duckdb import duckdb_manager
from ..utils.logger import get_logger

logger = get_logger('report.aggregator')

SQL_EXEC_TIMEOUT_SEC = 10

FORBIDDEN_KEYWORDS = re.compile(
    r"\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL|COPY|ATTACH|DETACH|LOAD|INSTALL)\b",
    re.IGNORECASE,
)

DANGEROUS_PATTERNS = re.compile(
    r"(--|;.*\b(DROP|DELETE|UPDATE|INSERT)\b|\/\*|\*\/)",
    re.IGNORECASE,
)
TABLE_PLACEHOLDER_RE = re.compile(r"\{table(?::[^}]+)?\}", re.IGNORECASE)


def _safe_float(val) -> Optional[float]:
    if val is None:
        return None
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return None


def validate_sql(sql: str) -> None:
    """
    校验 SQL 安全性：仅允许 SELECT 查询。
    不通过时抛出 ValueError。
    """
    if not sql or not sql.strip():
        raise ValueError("SQL 不能为空")

    cleaned = sql.strip()

    if FORBIDDEN_KEYWORDS.search(cleaned):
        match = FORBIDDEN_KEYWORDS.search(cleaned)
        raise ValueError(f"SQL 包含禁止的关键字: {match.group(0)}")

    if DANGEROUS_PATTERNS.search(cleaned):
        raise ValueError("SQL 包含危险模式")

    first_word = cleaned.split()[0].upper() if cleaned.split() else ""
    if first_word not in ("SELECT", "WITH"):
        raise ValueError(f"SQL 必须以 SELECT 或 WITH 开头，当前为: {first_word}")


def execute_plan_sql(
    file_id: str,
    sql: str,
    timeout: float = SQL_EXEC_TIMEOUT_SEC,
) -> Dict[str, Any]:
    """
    执行 LLM 生成的 SQL 并返回结构化结果。

    Returns:
        {
            "columns": ["col1", "col2", ...],
            "rows": [{"col1": val1, "col2": val2}, ...],
            "row_count": int,
            "elapsed_ms": float,
        }
    """
    # 1) 先做基础安全校验（原始 SQL）
    validate_sql(sql)
    # 2) 统一解析 report SQL 中的 {table}/{table:工作表名} 占位符
    resolved_sql = sql
    if TABLE_PLACEHOLDER_RE.search(sql):
        try:
            resolved_sql = duckdb_manager._resolve_table_placeholders(file_id, sql, None)
        except Exception as e:
            logger.error("SQL 占位符解析失败: file_id=%s err=%s sql=%s", file_id, e, sql[:200])
            raise
    # 3) 占位符必须被完全替换，否则直接拒绝执行（避免重复 Parser Error）
    if TABLE_PLACEHOLDER_RE.search(resolved_sql):
        raise ValueError("SQL 存在未解析的 {table} 占位符，请检查工作表名称或占位符语法。")
    # 4) 对渲染后的 SQL 再做一次安全校验
    validate_sql(resolved_sql)

    start = time.monotonic()

    try:
        result = duckdb_manager.conn.execute(resolved_sql).fetchall()
        desc = duckdb_manager.conn.description
        columns = [d[0] for d in desc]

        rows = []
        for r in result:
            row = {}
            for i, col_name in enumerate(columns):
                val = r[i]
                if val is None:
                    row[col_name] = None
                elif isinstance(val, float):
                    row[col_name] = round(val, 4) if math.isfinite(val) else None
                elif isinstance(val, (int,)):
                    row[col_name] = val
                else:
                    row[col_name] = str(val)
            rows.append(row)

        elapsed_ms = (time.monotonic() - start) * 1000

        if elapsed_ms > timeout * 1000:
            logger.warning(
                "SQL 执行超时: elapsed=%.0fms timeout=%ss sql=%s",
                elapsed_ms, timeout, resolved_sql[:200],
            )

        return {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "elapsed_ms": round(elapsed_ms, 1),
        }

    except Exception as e:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.error(
            "SQL 执行失败: elapsed=%.0fms err=%s sql=%s",
            elapsed_ms, e, resolved_sql[:200],
        )
        raise


# ── 以下为向后兼容的旧版聚合函数 ──────────────────────────

def query_kpi_stats(
    file_id: str,
    sheet_name: str,
    numeric_fields: List[str],
) -> List[Dict[str, Any]]:
    table_name = duckdb_manager._get_cached_table_name(file_id, sheet_name)
    if not table_name:
        return []

    kpis = []
    try:
        total_rows = duckdb_manager.conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
        kpis.append({
            "label": "总记录数",
            "value": total_rows,
            "formatted": f"{total_rows:,}",
            "unit": "条",
            "field": "__row_count__",
        })
    except Exception as e:
        logger.warning(f"查询总行数失败: {e}")

    for field in numeric_fields[:6]:
        try:
            row = duckdb_manager.conn.execute(
                f'SELECT SUM(TRY_CAST("{field}" AS DOUBLE)), '
                f'AVG(TRY_CAST("{field}" AS DOUBLE)), '
                f'MAX(TRY_CAST("{field}" AS DOUBLE)), '
                f'MIN(TRY_CAST("{field}" AS DOUBLE)) '
                f'FROM "{table_name}" WHERE TRY_CAST("{field}" AS DOUBLE) IS NOT NULL'
            ).fetchone()
            if row:
                s, a, mx, mn = [_safe_float(v) for v in row]
                if s is not None:
                    kpis.append({"label": f"{field}(总计)", "value": s, "formatted": f"{s:,.2f}", "unit": "", "field": field})
                if a is not None:
                    kpis.append({"label": f"{field}(平均)", "value": a, "formatted": f"{a:,.2f}", "unit": "", "field": field})
        except Exception as e:
            logger.warning(f"KPI 查询失败 {field}: {e}")

    return kpis


def query_time_series(
    file_id: str,
    sheet_name: str,
    time_field: str,
    value_fields: List[str],
    granularity: str = "month",
) -> Dict[str, Any]:
    table_name = duckdb_manager._get_cached_table_name(file_id, sheet_name)
    if not table_name:
        return {"labels": [], "datasets": []}

    trunc_map = {"year": "year", "quarter": "quarter", "month": "month", "week": "week", "day": "day"}
    trunc = trunc_map.get(granularity, "month")

    date_expr = f'DATE_TRUNC(\'{trunc}\', TRY_CAST("{time_field}" AS DATE))'

    agg_cols = ", ".join(f'SUM(TRY_CAST("{vf}" AS DOUBLE)) AS "{vf}"' for vf in value_fields)
    sql = (
        f'SELECT {date_expr} AS period, {agg_cols} '
        f'FROM "{table_name}" '
        f'WHERE TRY_CAST("{time_field}" AS DATE) IS NOT NULL '
        f'GROUP BY period ORDER BY period'
    )

    try:
        result = duckdb_manager.conn.execute(sql).fetchall()
        columns = [d[0] for d in duckdb_manager.conn.description]
        labels = [str(r[0])[:10] if r[0] else "" for r in result]
        datasets = []
        for i, vf in enumerate(value_fields):
            col_idx = columns.index(vf) if vf in columns else i + 1
            datasets.append({
                "field": vf,
                "data": [_safe_float(r[col_idx]) or 0 for r in result],
            })
        return {"labels": labels, "datasets": datasets}
    except Exception as e:
        logger.warning(f"时间序列查询失败: {e}")
        return {"labels": [], "datasets": []}


def query_category_aggregation(
    file_id: str,
    sheet_name: str,
    category_field: str,
    value_fields: List[str],
    limit: int = 15,
) -> Dict[str, Any]:
    table_name = duckdb_manager._get_cached_table_name(file_id, sheet_name)
    if not table_name:
        return {"labels": [], "datasets": []}

    primary_vf = value_fields[0] if value_fields else None
    agg_cols = ", ".join(f'SUM(TRY_CAST("{vf}" AS DOUBLE)) AS "{vf}"' for vf in value_fields)
    order_col = f'"{primary_vf}"' if primary_vf else f'COUNT(*)'

    sql = (
        f'SELECT "{category_field}", {agg_cols} '
        f'FROM "{table_name}" '
        f'WHERE "{category_field}" IS NOT NULL '
        f'GROUP BY "{category_field}" '
        f'ORDER BY {order_col} DESC LIMIT {limit}'
    )

    try:
        result = duckdb_manager.conn.execute(sql).fetchall()
        columns = [d[0] for d in duckdb_manager.conn.description]
        labels = [str(r[0]) for r in result]
        datasets = []
        for vf in value_fields:
            col_idx = columns.index(vf) if vf in columns else 1
            datasets.append({
                "field": vf,
                "data": [_safe_float(r[col_idx]) or 0 for r in result],
            })
        return {"labels": labels, "datasets": datasets}
    except Exception as e:
        logger.warning(f"分类聚合查询失败: {e}")
        return {"labels": [], "datasets": []}


def query_data_table(
    file_id: str,
    sheet_name: str,
    columns: Optional[List[str]] = None,
    limit: int = 50,
) -> Dict[str, Any]:
    table_name = duckdb_manager._get_cached_table_name(file_id, sheet_name)
    if not table_name:
        return {"headers": [], "rows": []}

    col_expr = ", ".join(f'"{c}"' for c in columns) if columns else "*"
    sql = f'SELECT {col_expr} FROM "{table_name}" LIMIT {limit}'

    try:
        result = duckdb_manager.conn.execute(sql).fetchall()
        desc = duckdb_manager.conn.description
        headers = [d[0] for d in desc]
        rows = []
        for r in result:
            row = {}
            for i, h in enumerate(headers):
                val = r[i]
                if val is None:
                    row[h] = ""
                elif isinstance(val, float):
                    row[h] = round(val, 4) if not (math.isnan(val) or math.isinf(val)) else ""
                else:
                    row[h] = str(val)
            rows.append(row)
        return {"headers": headers, "rows": rows}
    except Exception as e:
        logger.warning(f"明细查询失败: {e}")
        return {"headers": [], "rows": []}
