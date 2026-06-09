"""
LLM JSON 输出守卫。

统一提供：
1) 多策略 JSON 提取（纯文本、代码块、平衡括号、首末大括号）
2) 截断片段平衡修复（轻量补全）
3) 统一回退编排（direct -> force_json -> json_repair）
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional


ParseValidator = Callable[[Dict[str, Any]], None]
AsyncPlanFallback = Callable[[], Awaitable[Dict[str, Any]]]


def extract_json_object(raw_text: str, preview_chars: int = 500) -> Dict[str, Any]:
    """从 LLM 输出中提取单个 JSON 对象。"""
    text = (raw_text or "").strip()
    errors: List[str] = []

    for candidate in _extract_json_candidates(text):
        if not candidate:
            continue
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
            errors.append(f"candidate_not_object:{type(obj).__name__}")
        except json.JSONDecodeError as exc:
            errors.append(str(exc))

    balanced = _balance_json_fragment(text)
    if balanced:
        try:
            obj = json.loads(balanced)
            if isinstance(obj, dict):
                return obj
            errors.append(f"balanced_not_object:{type(obj).__name__}")
        except json.JSONDecodeError as exc:
            errors.append(f"balanced:{exc}")

    err_tail = errors[-1] if errors else "unknown"
    raise ValueError(
        f"无法从 LLM 输出中解析 JSON 对象: {text[:preview_chars]} | last_error={err_tail}"
    )


async def guard_json_output(
    raw_text: str,
    *,
    validator: Optional[ParseValidator] = None,
    force_json_fallback: Optional[AsyncPlanFallback] = None,
    repair_json_fallback: Optional[AsyncPlanFallback] = None,
    logger: Optional[Any] = None,
    module_name: str = "json_output_guard",
    preview_chars: int = 500,
) -> Dict[str, Any]:
    """
    统一 JSON 容错编排：
    direct_parse -> force_json_fallback -> repair_json_fallback
    """
    errors: List[str] = []

    try:
        plan = extract_json_object(raw_text, preview_chars=preview_chars)
        if validator:
            validator(plan)
        return plan
    except Exception as exc:
        errors.append(f"direct_parse={exc}")
        if logger:
            logger.warning("%s 直接解析失败: %s", module_name, exc)

    if force_json_fallback is not None:
        try:
            plan = await force_json_fallback()
            if validator:
                validator(plan)
            return plan
        except Exception as exc:
            errors.append(f"force_json={exc}")
            if logger:
                logger.warning("%s 强制 JSON 回退失败: %s", module_name, exc)

    if repair_json_fallback is not None:
        try:
            plan = await repair_json_fallback()
            if validator:
                validator(plan)
            return plan
        except Exception as exc:
            errors.append(f"json_repair={exc}")
            if logger:
                logger.warning("%s JSON 修复回退失败: %s", module_name, exc)

    raise ValueError(" | ".join(errors))


def _extract_json_candidates(text: str) -> List[str]:
    """生成 JSON 提取候选，按成功率从高到低排序。"""
    candidates: List[str] = []

    def _append(v: str) -> None:
        s = (v or "").strip()
        if s and s not in candidates:
            candidates.append(s)

    _append(text)

    code_block = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if code_block:
        _append(code_block.group(1))

    cleaned = re.sub(r"```(?:json)?\s*", "", text)
    cleaned = re.sub(r"```\s*$", "", cleaned, flags=re.MULTILINE)
    _append(cleaned)

    balanced_raw = _extract_balanced_json_object(text)
    if balanced_raw:
        _append(balanced_raw)
    balanced_cleaned = _extract_balanced_json_object(cleaned)
    if balanced_cleaned:
        _append(balanced_cleaned)

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        _append(text[start : end + 1])

    return candidates


def _extract_balanced_json_object(text: str) -> Optional[str]:
    """提取首个大括号平衡的 JSON 对象字符串。"""
    if not text:
        return None

    start = -1
    depth = 0
    in_string = False
    escaped = False

    for idx, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
            continue
        if ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                return text[start : idx + 1]

    return None


def _balance_json_fragment(text: str) -> Optional[str]:
    """对截断 JSON 片段做轻量括号/引号平衡。"""
    start = text.find("{")
    if start == -1:
        return None

    fragment = text[start:]
    if fragment.count('"') % 2 != 0:
        fragment += '"'

    open_braces = fragment.count("{")
    close_braces = fragment.count("}")
    if open_braces > close_braces:
        fragment += "}" * (open_braces - close_braces)
    elif close_braces > open_braces:
        excess = close_braces - open_braces
        while excess > 0 and fragment:
            if fragment.endswith("}"):
                excess -= 1
            fragment = fragment[:-1]
    return fragment
