"""
工作表标准化门面。

职责：
1) 列结构标准化（委托 column_schema_normalizer）
2) 值类型清洗（委托 value_coercer）
3) 提供 DataFrame -> Arrow 稳健转换
"""

from __future__ import annotations

from typing import Any

import pandas as pd
import pyarrow as pa
from .column_schema_normalizer import normalize_columns_with_decisions
from .value_coercer import normalize_dataframe_values


def normalize_dataframe_for_duckdb(
    df: pd.DataFrame, logger: Any, *, sheet_name: str = ""
) -> pd.DataFrame:
    """
    为 DuckDB 导入做标准化：
    - 清理/去重列名
    - 清洗 object 列的脏值与混合类型
    """
    normalized_df = df.copy()
    normalized_columns, schema_decisions = normalize_columns_with_decisions(normalized_df.columns)
    normalized_df.columns = normalized_columns
    renamed_cols = [d for d in schema_decisions if d["raw"] and d["raw"] != d["final"]]
    filled_cols = [d for d in schema_decisions if d["empty_filled"]]
    if renamed_cols or filled_cols:
        logger.info(
            "导入诊断-列结构: sheet=%s renamed=%d empty_filled=%d",
            sheet_name or "default",
            len(renamed_cols),
            len(filled_cols),
        )
        for item in schema_decisions:
            logger.info(
                "导入诊断-列名决策: sheet=%s idx=%d raw=%s final=%s empty_filled=%s deduped=%s",
                sheet_name or "default",
                item["index"],
                item["raw"],
                item["final"],
                item["empty_filled"],
                item["deduped"],
            )
    normalized_df = normalize_dataframe_values(
        normalized_df, logger, sheet_name=sheet_name
    )
    return normalized_df


def dataframe_to_arrow_with_fallback(df: pd.DataFrame, table_name: str, logger: Any) -> pa.Table:
    """
    稳健转换 DataFrame -> Arrow：
    - 首次失败时，将 object 列整体降级为字符串再重试。
    """
    try:
        return pa.Table.from_pandas(df, preserve_index=False)
    except Exception as err:
        logger.warning(
            f"Arrow 转换失败，降级为 object 全量字符串模式重试: table={table_name}, error={err}"
        )
        fallback_df = df.copy()
        for col in fallback_df.columns:
            if fallback_df[col].dtype == "object":
                fallback_df[col] = fallback_df[col].map(
                    lambda x: None if x is None else str(x)
                )
        return pa.Table.from_pandas(fallback_df, preserve_index=False)
