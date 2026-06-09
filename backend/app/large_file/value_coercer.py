"""
单元格值清洗与类型归一化。

职责：
1) 检测“透视/汇总类”非标准工作表
2) 对 object 列执行稳定清洗
3) 在风险场景下主动降级字符串，避免 DuckDB/Arrow 类型抖动
"""

from __future__ import annotations

import re
from typing import Any, Dict

import pandas as pd


SUMMARY_SHEET_KEYWORDS = ("透视", "汇总", "summary", "pivot", "指标")


def detect_sheet_profile(sheet_name: str, df: pd.DataFrame) -> Dict[str, Any]:
    """识别工作表形态，供类型清洗策略分流。"""
    sn = (sheet_name or "").strip().lower()
    keyword_hit = any(k in sn for k in SUMMARY_SHEET_KEYWORDS)

    row_count = int(len(df))
    col_count = int(len(df.columns))
    is_small_matrix = row_count <= 500 and col_count <= 80

    # 透视/汇总表常见特征：列名包含分隔符，且规模偏小
    split_like_cols = 0
    for col in df.columns:
        c = str(col)
        if "|" in c or "/" in c or "(" in c or ")" in c:
            split_like_cols += 1
    split_ratio = (split_like_cols / max(col_count, 1)) if col_count else 0.0

    is_summary_like = keyword_hit or (is_small_matrix and split_ratio >= 0.35)

    return {
        "sheet_name": sheet_name,
        "row_count": row_count,
        "col_count": col_count,
        "keyword_hit": keyword_hit,
        "split_ratio": round(split_ratio, 3),
        "is_summary_like": is_summary_like,
    }


def normalize_dataframe_values(
    df: pd.DataFrame,
    logger: Any,
    *,
    sheet_name: str = "",
) -> pd.DataFrame:
    """清洗 DataFrame 的 object 列值。"""
    profile = detect_sheet_profile(sheet_name, df)
    normalized_df = df.copy()
    column_decisions = []

    if profile["is_summary_like"]:
        logger.info(
            "检测到非标准汇总类工作表，启用稳健字符串清洗: sheet=%s rows=%d cols=%d split_ratio=%.3f",
            profile["sheet_name"],
            profile["row_count"],
            profile["col_count"],
            profile["split_ratio"],
        )

    for col in normalized_df.columns:
        series = normalized_df[col]
        if series.dtype != "object":
            continue

        normalized = series.map(_normalize_object_value)
        full_values = [v for v in normalized.tolist() if v is not None]
        value_types = {type(v) for v in full_values}

        force_string = profile["is_summary_like"]
        action = "keep"
        reason = "type_stable"
        if force_string or len(value_types) > 1:
            numeric_decision = _try_numeric_preserve(normalized)
            if numeric_decision["should_keep_numeric"]:
                normalized = numeric_decision["series"]
                action = "numeric_cast"
                reason = numeric_decision["reason"]
                logger.info(
                    "列 [%s] 命中数值保留策略: numeric_ratio=%.3f",
                    col,
                    numeric_decision["numeric_ratio"],
                )
            else:
                if len(value_types) > 1:
                    logger.warning(f"列 [{col}] 存在混合类型 {value_types}，将统一转字符串导入 DuckDB")
                    reason = "mixed_types"
                elif force_string:
                    reason = "summary_sheet_strategy"
                normalized = normalized.map(lambda x: None if x is None else str(x))
                action = "stringify"

        column_decisions.append(
            {
                "column": col,
                "action": action,
                "reason": reason,
                "types": sorted([t.__name__ for t in value_types]) if value_types else [],
            }
        )

        normalized_df[col] = normalized

    object_col_count = sum(1 for c in normalized_df.columns if normalized_df[c].dtype == "object")
    stringify_cols = [d["column"] for d in column_decisions if d["action"] == "stringify"]
    strategy = "summary_robust" if profile["is_summary_like"] else "standard"
    logger.info(
        "导入诊断摘要: sheet=%s strategy=%s object_cols=%d stringify_cols=%d reasons=%s",
        sheet_name or "default",
        strategy,
        object_col_count,
        len(stringify_cols),
        sorted({d["reason"] for d in column_decisions}) if column_decisions else ["none"],
    )
    for decision in column_decisions:
        logger.info(
            "导入诊断-列决策: sheet=%s col=%s action=%s reason=%s types=%s",
            sheet_name or "default",
            decision["column"],
            decision["action"],
            decision["reason"],
            decision["types"],
        )

    return normalized_df


def _normalize_object_value(val: Any) -> Any:
    """object 列值清洗：统一空值、bytes。"""
    if val is None:
        return None
    try:
        if pd.isna(val):
            return None
    except Exception:
        pass
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="replace")
    return val


def _to_numeric_or_none(val: Any) -> float | None:
    """将常见数值展示文本归一化为 float。"""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)

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
    except (ValueError, TypeError):
        return None
    if is_percent:
        return num / 100.0
    return num


def _try_numeric_preserve(series: pd.Series) -> Dict[str, Any]:
    """
    汇总类/混合类型列的稳健策略：
    若可解析数值占比足够高，则保留数值语义而不是 stringify。
    """
    non_null = series[series.notna()]
    total = int(len(non_null))
    if total == 0:
        return {
            "should_keep_numeric": False,
            "series": series,
            "numeric_ratio": 0.0,
            "reason": "empty_series",
        }

    numeric_vals = non_null.map(_to_numeric_or_none)
    numeric_mask = numeric_vals.notna()
    numeric_count = int(numeric_mask.sum())
    numeric_ratio = numeric_count / max(total, 1)

    # 85% 以上可解析为数值：认为该列本质是数值列，保留 numeric 语义。
    if numeric_ratio >= 0.85 and numeric_count > 0:
        casted = series.copy()
        casted.loc[numeric_mask.index] = numeric_vals
        casted = pd.to_numeric(casted, errors="coerce")
        return {
            "should_keep_numeric": True,
            "series": casted,
            "numeric_ratio": round(numeric_ratio, 3),
            "reason": "numeric_preserve",
        }

    return {
        "should_keep_numeric": False,
        "series": series,
        "numeric_ratio": round(numeric_ratio, 3),
        "reason": "low_numeric_ratio",
    }
