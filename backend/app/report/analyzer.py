# backend/app/report/analyzer.py
"""
数据结构分析器 — 分析 DuckDB 内存表结构，识别字段类型
保留字段分类与非业务指标过滤逻辑，供 planner / chart_builder 使用。
recommend_template / infer_business_domain_context 保留向后兼容但已由 LLM 接管。
"""
import json
import math
import re
from typing import Dict, List, Any, Optional, Tuple
from ..large_file.large_file_duckdb import duckdb_manager
from ..large_file.storage import large_file_storage
from ..utils.logger import get_logger

logger = get_logger('report.analyzer')


NUMERIC_TYPES = {'INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'NUMERIC', 'REAL', 'SMALLINT', 'TINYINT', 'HUGEINT'}
DATE_TYPES = {'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP_S', 'TIMESTAMP_MS', 'TIMESTAMP_NS'}
DOMAIN_KEYWORDS = {
    "retail": ["销售", "渠道", "客户", "商品", "sku", "店", "门店", "转化", "订单", "复购", "客单"],
    "manufacturing": ["产量", "生产", "工单", "库存", "交付", "供应", "良率", "产线", "在制", "仓储"],
    "finance": ["成本", "利润", "毛利", "费用", "现金", "收入", "预算", "应收", "应付", "税"],
}

NON_BUSINESS_METRIC_KEYWORDS = [
    "电话", "手机号", "手机", "联系电话", "固话", "tel", "phone", "mobile",
    "邮箱", "email", "邮编", "zipcode", "zip",
    "身份证", "证件号", "护照", "税号",
    "编码", "编号", "序列号", "sn", "serial", "code", "id", "uid",
    "订单号", "单号", "流水号", "交易号", "票据号",
    "银行卡", "卡号", "账号", "account",
    "qq", "微信", "wechat", "imei", "imsi", "mac",
]

PHONE_PATTERN = re.compile(r"^1\d{10}$")
ID18_PATTERN = re.compile(r"^\d{17}[\dXx]$")
UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")


def _is_numeric(col_type: str) -> bool:
    return any(t in col_type.upper() for t in NUMERIC_TYPES)


def _is_date(col_type: str) -> bool:
    return any(t in col_type.upper() for t in DATE_TYPES)


def _is_category(col_type: str, unique_count: int, total_rows: int) -> bool:
    if _is_numeric(col_type) or _is_date(col_type):
        return False
    if total_rows == 0:
        return False
    ratio = unique_count / total_rows
    return ratio < 0.5 and unique_count <= 200


def _is_non_business_metric(field_name: str) -> bool:
    normalized = str(field_name or "").strip().lower()
    if not normalized:
        return True

    compact = normalized.replace("_", "").replace("-", "").replace(" ", "")
    if any(k in compact for k in NON_BUSINESS_METRIC_KEYWORDS):
        return True

    if re.search(r"(^id$|^id[_\-]|[_\-]id$|^code[_\-]|[_\-]code$)", compact):
        return True

    return False


def is_business_metric_field(field_name: str) -> bool:
    """对外暴露：字段是否可作为业务指标参与报表图表分析。"""
    return not _is_non_business_metric(field_name)


def _looks_like_identifier_column(
    table_name: str,
    field_name: str,
    total_rows: int,
) -> bool:
    if total_rows <= 0:
        return False
    try:
        uq = duckdb_manager.execute_fetchone(
            f'SELECT COUNT(DISTINCT "{field_name}") FROM "{table_name}" WHERE "{field_name}" IS NOT NULL'
        )
        distinct_count = int(uq[0]) if uq and uq[0] is not None else 0
        ratio = distinct_count / total_rows if total_rows else 0
        return total_rows >= 100 and ratio >= 0.9
    except Exception:
        return False


def _looks_like_identifier_value_shape(
    table_name: str,
    field_name: str,
) -> bool:
    try:
        rows = duckdb_manager.execute_fetchall(
            f'SELECT CAST("{field_name}" AS VARCHAR) '
            f'FROM "{table_name}" '
            f'WHERE "{field_name}" IS NOT NULL '
            f'LIMIT 300'
        )
    except Exception:
        return False

    samples = [str(r[0]).strip() for r in rows if r and r[0] is not None]
    if len(samples) < 20:
        return False

    total = len(samples)
    phone_hits = sum(1 for v in samples if PHONE_PATTERN.fullmatch(v))
    id18_hits = sum(1 for v in samples if ID18_PATTERN.fullmatch(v))
    uuid_hits = sum(1 for v in samples if UUID_PATTERN.fullmatch(v))

    pure_digits = [v for v in samples if v.isdigit()]
    long_digit_hits = sum(1 for v in pure_digits if 12 <= len(v) <= 24)
    fixed_long_digit_hits = sum(1 for v in pure_digits if len(v) in {15, 16, 17, 18, 19, 20})

    if phone_hits / total >= 0.7:
        return True
    if id18_hits / total >= 0.6:
        return True
    if uuid_hits / total >= 0.5:
        return True
    if pure_digits and (long_digit_hits / len(pure_digits) >= 0.8):
        return True
    if pure_digits and (fixed_long_digit_hits / len(pure_digits) >= 0.7):
        return True

    return False


def analyze_file_structure(file_id: str) -> Dict[str, Any]:
    """
    分析 DuckDB 中已加载工作表的结构，返回字段分类。
    """
    tables = duckdb_manager.list_available_tables(file_id)
    source_tables = [t for t in tables if t.get('type') == 'source']
    result_tables = [t for t in tables if t.get('type') == 'result']

    sheets_analysis = []

    for tbl in source_tables + result_tables:
        table_name = tbl.get('table_name')
        sheet_name = tbl.get('name', '')
        tbl_type = tbl.get('type', 'source')
        if not table_name:
            continue

        try:
            desc = duckdb_manager.execute_fetchall(f'DESCRIBE "{table_name}"')
            row_count_result = duckdb_manager.execute_fetchone(f'SELECT COUNT(*) FROM "{table_name}"')
            total_rows = row_count_result[0] if row_count_result else 0

            time_fields = []
            numeric_fields = []
            category_fields = []
            all_columns = []

            for col_name, col_type, *_ in desc:
                col_upper = col_type.upper()
                all_columns.append({"name": col_name, "type": col_type})

                if _is_date(col_upper):
                    time_fields.append(col_name)
                elif _is_numeric(col_upper):
                    if _is_non_business_metric(col_name):
                        continue
                    if _looks_like_identifier_column(table_name, col_name, total_rows):
                        continue
                    if _looks_like_identifier_value_shape(table_name, col_name):
                        continue
                    numeric_fields.append(col_name)
                else:
                    try:
                        uq = duckdb_manager.execute_fetchone(
                            f'SELECT COUNT(DISTINCT "{col_name}") FROM "{table_name}"'
                        )
                        unique_count = uq[0] if uq else 0
                    except Exception:
                        unique_count = 0
                    if _is_category(col_upper, unique_count, total_rows):
                        category_fields.append(col_name)

            for col in all_columns:
                if col["type"].upper() == "VARCHAR" and col["name"] not in time_fields:
                    try:
                        sample = duckdb_manager.execute_fetchall(
                            f'SELECT TRY_CAST("{col["name"]}" AS DATE) FROM "{table_name}" WHERE "{col["name"]}" IS NOT NULL LIMIT 20'
                        )
                        success = sum(1 for r in sample if r[0] is not None)
                        if len(sample) > 0 and success / len(sample) >= 0.8:
                            time_fields.append(col["name"])
                            if col["name"] in category_fields:
                                category_fields.remove(col["name"])
                    except Exception:
                        pass

            numeric_stats = {}
            for nf in numeric_fields[:10]:
                try:
                    stats = duckdb_manager.execute_fetchone(
                        f'SELECT MIN("{nf}"), MAX("{nf}"), AVG("{nf}"), SUM("{nf}") FROM "{table_name}" WHERE "{nf}" IS NOT NULL'
                    )
                    if stats and stats[0] is not None:
                        max_abs = max(abs(float(stats[0])), abs(float(stats[1]))) if stats[1] is not None else 0
                        magnitude = int(math.log10(max_abs)) if max_abs > 0 else 0
                        numeric_stats[nf] = {
                            "min": float(stats[0]) if stats[0] is not None else 0,
                            "max": float(stats[1]) if stats[1] is not None else 0,
                            "avg": float(stats[2]) if stats[2] is not None else 0,
                            "sum": float(stats[3]) if stats[3] is not None else 0,
                            "magnitude": magnitude,
                        }
                except Exception:
                    pass

            sheets_analysis.append({
                "sheet_name": sheet_name,
                "table_name": table_name,
                "table_type": tbl_type,
                "row_count": total_rows,
                "columns": all_columns,
                "time_fields": time_fields,
                "numeric_fields": numeric_fields,
                "category_fields": category_fields,
                "numeric_stats": numeric_stats,
            })

        except Exception as e:
            logger.warning(f"分析工作表 {sheet_name} 失败: {e}")

    has_time = any(len(s["time_fields"]) > 0 for s in sheets_analysis)
    has_category = any(len(s["category_fields"]) > 0 for s in sheets_analysis)
    has_numeric = any(len(s["numeric_fields"]) > 0 for s in sheets_analysis)

    return {
        "file_id": file_id,
        "sheets": sheets_analysis,
        "summary": {
            "total_sheets": len(sheets_analysis),
            "has_time_dimension": has_time,
            "has_category_dimension": has_category,
            "has_numeric_fields": has_numeric,
        },
    }


def recommend_template(structure: Dict[str, Any]) -> str:
    """基于数据结构特征推荐最佳模板 (向后兼容，LLM 已接管此功能)"""
    summary = structure.get("summary", {})
    sheets = structure.get("sheets", [])

    has_time = summary.get("has_time_dimension", False)
    has_category = summary.get("has_category_dimension", False)
    total_category_fields = sum(len(s.get("category_fields", [])) for s in sheets)
    total_numeric_fields = sum(len(s.get("numeric_fields", [])) for s in sheets)

    if has_time and total_numeric_fields >= 3:
        return "trend"
    if has_category and total_category_fields >= 2 and total_numeric_fields >= 2:
        return "comparison"
    if has_category and total_numeric_fields >= 1:
        return "ranking"
    if has_time or has_category:
        return "overview"
    return "executive"


def group_compatible_fields(
    numeric_fields: List[str],
    numeric_stats: Dict[str, Dict[str, Any]],
) -> List[List[str]]:
    """
    按量级和语义分组，确保同一图表只包含量级差异 <= 2 的同类指标。
    """
    if not numeric_fields:
        return []

    annotated = []
    for f in numeric_fields:
        stats = numeric_stats.get(f, {})
        mag = stats.get("magnitude", 0)
        unit = _guess_unit(f)
        annotated.append((f, mag, unit))

    groups: List[List[str]] = []
    used = set()

    for i, (f, mag, unit) in enumerate(annotated):
        if f in used:
            continue
        group = [f]
        used.add(f)
        for j in range(i + 1, len(annotated)):
            f2, mag2, unit2 = annotated[j]
            if f2 in used:
                continue
            if unit == unit2 and abs(mag - mag2) <= 2:
                group.append(f2)
                used.add(f2)
        groups.append(group)

    return groups


def _guess_unit(field_name: str) -> str:
    name = field_name.lower()
    if any(k in name for k in ["额", "金额", "价格", "单价", "price", "amount", "revenue", "cost"]):
        return "currency"
    if any(k in name for k in ["率", "比", "折扣", "rate", "ratio", "percent"]):
        return "percent"
    if any(k in name for k in ["数量", "件", "个", "count", "qty", "quantity"]):
        return "count"
    return "general"


def infer_business_domain_context(
    structure: Dict[str, Any],
    template_key: str,
    domain_override: Optional[str] = None,
) -> Dict[str, Any]:
    """
    领域识别 (向后兼容，LLM Phase 1 已接管此功能)
    """
    if domain_override in {"retail", "manufacturing", "finance", "general"}:
        return {
            "domain": domain_override,
            "confidence": 1.0,
            "scores": {domain_override: 1.0},
            "evidence_keywords": ["manual_override"],
            "template_key": template_key,
            "source": "user_override",
        }

    corpus = []
    for sheet in structure.get("sheets", []):
        sheet_name = str(sheet.get("sheet_name", ""))
        corpus.append(sheet_name)
        for col in sheet.get("columns", []):
            corpus.append(str(col.get("name", "")))
        corpus.extend([str(x) for x in sheet.get("category_fields", [])])
        corpus.extend([str(x) for x in sheet.get("numeric_fields", [])])
    text = " ".join(corpus).lower()

    scores = {"retail": 0.0, "manufacturing": 0.0, "finance": 0.0, "general": 0.2}
    evidences = {k: [] for k in scores.keys()}

    for domain, words in DOMAIN_KEYWORDS.items():
        for w in words:
            if w.lower() in text:
                scores[domain] += 1.0
                evidences[domain].append(w)

    if template_key in ["ranking", "comparison", "overview"]:
        scores["retail"] += 0.3
    if template_key in ["executive", "trend"]:
        scores["finance"] += 0.2

    best_domain = max(scores.items(), key=lambda kv: kv[1])[0]
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    top = ranked[0][1]
    confidence = 0.5 if top <= 0 else min(0.98, max(0.35, (top - second) / (top + 1e-6)))

    return {
        "domain": best_domain,
        "confidence": round(confidence, 3),
        "scores": {k: round(v, 3) for k, v in scores.items()},
        "evidence_keywords": evidences.get(best_domain, [])[:12],
        "template_key": template_key,
        "source": "auto_infer",
    }
