"""
查询语义解析器（LLM First）。

职责：
- 仅做自然语言 -> 结构化槽位的语义抽取
- 不执行工具、不改写数据、不参与计算
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Dict, List, Optional

from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, TextBlock

from ..core.config import settings


_ALLOWED_QUERY_MODE = {
    "extreme_rank",
    "entity_total",
    "unique_count",
    "aggregate",
    "trend_compare",
    "unknown",
}
_ALLOWED_SORT_ORDER = {"asc", "desc"}
_ALLOWED_AGG_OP = {"sum", "avg", "max", "min", "count"}
_ALLOWED_TREND_MODE = {"mom", "yoy"}


def _default_slots() -> Dict[str, Any]:
    return {
        "query_mode": "unknown",
        "sort_order": None,
        "top_n": None,
        "rank_positions": [],
        "need_ratio": False,
        "aggregate_op": None,
        "trend_mode": None,
        "target_entity": None,
        "group_by_hint": None,
        "metric_hint": None,
    }


def _extract_first_json_object(raw: str) -> Optional[Dict[str, Any]]:
    txt = str(raw or "").strip()
    if not txt:
        return None
    try:
        obj = json.loads(txt)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    block = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", txt, re.IGNORECASE)
    if block:
        try:
            obj = json.loads(block.group(1))
            if isinstance(obj, dict):
                return obj
        except Exception:
            return None

    obj_match = re.search(r"(\{[\s\S]*\})", txt)
    if obj_match:
        try:
            obj = json.loads(obj_match.group(1))
            if isinstance(obj, dict):
                return obj
        except Exception:
            return None
    return None


def _sanitize_slots(obj: Dict[str, Any], header_names: Optional[List[str]] = None) -> Dict[str, Any]:
    slots = _default_slots()
    header_set = {str(h).strip() for h in (header_names or []) if str(h).strip()}

    query_mode = str(obj.get("query_mode") or "").strip().lower()
    if query_mode in _ALLOWED_QUERY_MODE:
        slots["query_mode"] = query_mode

    sort_order = str(obj.get("sort_order") or "").strip().lower()
    if sort_order in _ALLOWED_SORT_ORDER:
        slots["sort_order"] = sort_order

    top_n = obj.get("top_n")
    if isinstance(top_n, (int, float)) and int(top_n) >= 1:
        slots["top_n"] = int(top_n)

    rank_positions = obj.get("rank_positions")
    if isinstance(rank_positions, list):
        cleaned = []
        for item in rank_positions:
            if isinstance(item, (int, float)) and int(item) >= 1:
                cleaned.append(int(item))
            elif isinstance(item, str):
                try:
                    val = int(item.strip())
                    if val >= 1:
                        cleaned.append(val)
                except Exception:
                    continue
        if cleaned:
            slots["rank_positions"] = sorted(set(cleaned))

    need_ratio = obj.get("need_ratio")
    if isinstance(need_ratio, bool):
        slots["need_ratio"] = need_ratio

    aggregate_op = str(obj.get("aggregate_op") or "").strip().lower()
    if aggregate_op in _ALLOWED_AGG_OP:
        slots["aggregate_op"] = aggregate_op

    trend_mode = str(obj.get("trend_mode") or "").strip().lower()
    if trend_mode in _ALLOWED_TREND_MODE:
        slots["trend_mode"] = trend_mode

    target_entity = obj.get("target_entity")
    if isinstance(target_entity, str):
        target_entity = target_entity.strip()
        if target_entity:
            slots["target_entity"] = target_entity

    group_by_hint = obj.get("group_by_hint")
    if isinstance(group_by_hint, str):
        group_by_hint = group_by_hint.strip()
        if group_by_hint and (not header_set or group_by_hint in header_set):
            slots["group_by_hint"] = group_by_hint

    metric_hint = obj.get("metric_hint")
    if isinstance(metric_hint, str):
        metric_hint = metric_hint.strip()
        if metric_hint and (not header_set or metric_hint in header_set):
            slots["metric_hint"] = metric_hint

    return slots


async def infer_query_semantics_with_llm(
    command: str,
    headers_with_col: List[Dict[str, Any]],
    timeout_sec: float = 12.0,
) -> Dict[str, Any]:
    """
    LLM 先行语义抽取。
    若 LLM 不可用或输出非法，返回默认空槽位，不抛异常。
    """
    slots = _default_slots()
    cmd = str(command or "").strip()
    if not cmd:
        return slots
    if not settings.ANTHROPIC_CREDENTIAL:
        return slots

    headers = [str(h.get("name", "")).strip() for h in headers_with_col if str(h.get("name", "")).strip()]
    prompt = (
        "你是查询语义解析器。将用户问题抽取为 JSON 槽位。\n"
        "只输出 JSON，不要解释。\n"
        "字段：\n"
        "- query_mode: extreme_rank | entity_total | unique_count | aggregate | trend_compare | unknown\n"
        "- sort_order: desc | asc | null\n"
        "- top_n: 正整数或 null\n"
        "- rank_positions: 正整数数组\n"
        "- need_ratio: true/false\n"
        "- aggregate_op: sum | avg | max | min | count | null\n"
        "- trend_mode: mom | yoy | null\n"
        "- target_entity: 字符串或 null\n\n"
        "- group_by_hint: 从可用列名中选择最可能的分组列名，否则 null\n"
        "- metric_hint: 从可用列名中选择最可能的指标列名，否则 null\n\n"
        f"可用列名：{headers}\n"
        f"用户问题：{cmd}\n"
        "输出 JSON："
    )
    options = ClaudeAgentOptions(
        system_prompt="只做语义槽位抽取。禁止工具调用。禁止输出解释文本。",
        permission_mode="acceptEdits",
        max_turns=1,
        model=settings.ANTHROPIC_EFFECTIVE_MODEL or None,
    )

    try:
        text = ""

        async def _collect() -> None:
            nonlocal text
            async for msg in query(prompt=prompt, options=options):
                if isinstance(msg, AssistantMessage) and getattr(msg, "content", None):
                    for block in msg.content:
                        if isinstance(block, TextBlock):
                            text += block.text

        await asyncio.wait_for(_collect(), timeout=timeout_sec)
        parsed = _extract_first_json_object(text)
        if not parsed:
            return slots
        return _sanitize_slots(parsed, headers)
    except Exception:
        return slots

