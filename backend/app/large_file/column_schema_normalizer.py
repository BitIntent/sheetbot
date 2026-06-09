"""
列结构标准化。

职责：
1) 归一化列名（空列名、Unnamed 列、重复列名）
2) 保证 DuckDB 建表时列名稳定可复现
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple


def normalize_columns(columns: Iterable[Any]) -> List[str]:
    """列名标准化：去空白、空名补齐、重复名去重。"""
    normalized, _ = normalize_columns_with_decisions(columns)
    return normalized


def normalize_columns_with_decisions(columns: Iterable[Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
    """列名标准化并返回列级决策明细。"""
    used: Dict[str, int] = {}
    result: List[str] = []
    decisions: List[Dict[str, Any]] = []

    for idx, raw in enumerate(columns, start=1):
        raw_text = str(raw).strip() if raw is not None else ""
        base = _normalize_single_column_name(raw, idx)
        counter = used.get(base, 0)
        if counter == 0:
            name = base
            deduped = False
        else:
            name = f"{base}_{counter + 1}"
            deduped = True
        used[base] = counter + 1
        result.append(name)
        decisions.append(
            {
                "index": idx,
                "raw": raw_text or None,
                "normalized_base": base,
                "final": name,
                "empty_filled": (not raw_text or raw_text.lower().startswith("unnamed:")),
                "deduped": deduped,
            }
        )

    return result, decisions


def _normalize_single_column_name(raw: Any, idx: int) -> str:
    text = str(raw).strip() if raw is not None else ""
    # pandas 常见空列名形态：Unnamed: 3
    if not text or text.lower().startswith("unnamed:"):
        return f"列{idx}"
    return text
