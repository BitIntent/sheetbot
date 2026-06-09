# backend/app/utils/context_budget.py
"""
上下文预算管理 — 统一 schema 压缩与 prompt 长度控制
防止 LLM context window / Argument list too long 溢出
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Tuple

from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger("context_budget")

# ---------------------------------------------------------------------------
# 压缩参数（与 pptx/planner 对齐，可通过 config 覆盖）
# ---------------------------------------------------------------------------
SCHEMA_MAX_SHEETS = 10
SCHEMA_MAX_COLUMNS = 36
SCHEMA_MAX_SAMPLE_ROWS = 3
SCHEMA_MAX_NUMERIC_STATS = 8
SCHEMA_MAX_CATEGORY_COLUMNS = 8
SCHEMA_MAX_VALUE_LEN = 80


def _safe_truncate(value: Any, max_len: int = SCHEMA_MAX_VALUE_LEN) -> Any:
    """限制样本文本长度，防止 prompt 异常膨胀。"""
    if value is None:
        return None
    text = str(value)
    if len(text) <= max_len:
        return text
    return f"{text[:max_len]}..."


def compact_schema_context(
    schema_ctx: Dict[str, Any],
    tight: bool = False,
    *,
    sheet_limit: Optional[int] = None,
    col_limit: Optional[int] = None,
    sample_row_limit: Optional[int] = None,
    stat_limit: Optional[int] = None,
    category_limit: Optional[int] = None,
    value_limit: Optional[int] = None,
) -> Dict[str, Any]:
    """
    压缩 schema 上下文，避免超长 prompt 触发 context window / 参数过长。
    tight=True 时进一步收紧，专用于回退阶段。
    """
    _sheet = 6 if tight else (sheet_limit or SCHEMA_MAX_SHEETS)
    _col = 24 if tight else (col_limit or SCHEMA_MAX_COLUMNS)
    _sample = 1 if tight else (sample_row_limit or SCHEMA_MAX_SAMPLE_ROWS)
    _stat = 5 if tight else (stat_limit or SCHEMA_MAX_NUMERIC_STATS)
    _cat = 5 if tight else (category_limit or SCHEMA_MAX_CATEGORY_COLUMNS)
    _val = 48 if tight else (value_limit or SCHEMA_MAX_VALUE_LEN)

    compact_sheets: List[Dict[str, Any]] = []
    raw_sheets = schema_ctx.get("sheets", []) or []
    for sheet in raw_sheets[:_sheet]:
        columns = sheet.get("columns", [])[:_col]
        numeric_stats = sheet.get("numeric_stats", {}) or {}
        category_unique_counts = sheet.get("category_unique_counts", {}) or {}
        sample_rows = sheet.get("sample_rows", [])[:_sample]

        compact_sample_rows = []
        for row in sample_rows:
            if not isinstance(row, dict):
                continue
            compact_row = {}
            for idx, (k, v) in enumerate(row.items()):
                if idx >= _col:
                    break
                compact_row[str(k)] = _safe_truncate(v, _val)
            compact_sample_rows.append(compact_row)

        item: Dict[str, Any] = {
            "sheet_name": sheet.get("sheet_name", ""),
            "table_name": sheet.get("table_name", ""),
            "row_count": sheet.get("row_count", 0),
            "columns": columns,
            "numeric_columns": (sheet.get("numeric_columns", []) or [])[:_col],
            "date_columns": (sheet.get("date_columns", []) or [])[:_col],
            "text_columns": (sheet.get("text_columns", []) or [])[:_col],
            "numeric_stats": dict(list(numeric_stats.items())[:_stat]),
            "category_unique_counts": dict(list(category_unique_counts.items())[:_cat]),
            "sample_rows": compact_sample_rows,
        }
        if sheet.get("columns_truncated"):
            item["columns_truncated"] = sheet["columns_truncated"]
        compact_sheets.append(item)

    return {
        "file_id": schema_ctx.get("file_id", ""),
        "file_name": schema_ctx.get("file_name", ""),
        "total_sheets": len(compact_sheets),
        "sheets": compact_sheets,
    }


def build_adaptive_prompt(
    raw_schema_ctx: Dict[str, Any],
    prompt_builder: Callable[[Dict[str, Any]], str],
    target_chars: int,
    module_name: str = "unknown",
) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """
    自适应构建 prompt：按长度阈值逐级压缩 schema。
    返回 (prompt_text, selected_ctx, info)。
    """
    profile_builders = [
        ("none", lambda: raw_schema_ctx),
        ("compact", lambda: compact_schema_context(raw_schema_ctx, tight=False)),
        ("tight", lambda: compact_schema_context(raw_schema_ctx, tight=True)),
    ]

    original_prompt = prompt_builder(raw_schema_ctx)
    original_chars = len(original_prompt)
    original_sheets = len((raw_schema_ctx.get("sheets") or []))

    selected_profile = profile_builders[-1][0]
    selected_ctx = profile_builders[-1][1]()
    selected_prompt = prompt_builder(selected_ctx)

    for profile_name, builder in profile_builders:
        candidate_ctx = builder()
        candidate_prompt = prompt_builder(candidate_ctx)
        selected_profile = profile_name
        selected_ctx = candidate_ctx
        selected_prompt = candidate_prompt
        if len(candidate_prompt) <= target_chars:
            break

    info = {
        "module": module_name,
        "target_chars": target_chars,
        "original_chars": original_chars,
        "selected_chars": len(selected_prompt),
        "original_sheets": original_sheets,
        "selected_sheets": len((selected_ctx.get("sheets") or [])),
        "selected_profile": selected_profile,
        "compressed": selected_profile != "none",
    }
    logger.info(
        "上下文预算 自适应压缩: module=%s profile=%s compressed=%s "
        "original_chars=%d selected_chars=%d target_chars=%d",
        module_name, selected_profile, info["compressed"],
        original_chars, len(selected_prompt), target_chars,
    )
    return selected_prompt, selected_ctx, info


def enforce_hard_cap(prompt: str, hard_cap: Optional[int] = None) -> str:
    """
    全局硬顶：任何 prompt 超过 hard_cap 时截断尾部（保留头部结构）。
    仅作最后防线，正常应通过压缩控制在 cap 内。
    """
    cap = hard_cap or settings.GLOBAL_PROMPT_HARD_CAP
    if len(prompt) <= cap:
        return prompt
    logger.warning("上下文预算 触发硬顶截断: len=%d cap=%d", len(prompt), cap)
    return prompt[:cap] + "\n\n[... 已截断以符合系统限制 ...]"
