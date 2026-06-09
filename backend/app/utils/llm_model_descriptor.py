# -*- coding: utf-8 -*-
"""
LLM 模型描述（用于日志）
统一解析 ClaudeAgentOptions.model / 环境变量 ANTHROPIC_DEFAULT_*_MODEL，便于排查线上实际走向。
"""
from __future__ import annotations

import os
from typing import Any, Optional


def describe_llm_model_for_log(options: Optional[Any] = None) -> str:
    """
    生成写入 logs/backend 的模型摘要字符串。

    优先级：
    1. ClaudeAgentOptions.model + fallback_model（若存在）
    2. 未传 model 时：Claude CLI 主会话与 Claude Agent SDK 一致，不传 --model 则走 **Sonnet 档**
       （见 subprocess 仅在 options.model 存在时追加 --model），故用 ANTHROPIC_DEFAULT_SONNET_MODEL
       作为 effective，并附带三档映射便于核对
    3. 占位说明
    """
    if options is not None:
        explicit = getattr(options, "model", None) or ""
        fallback = getattr(options, "fallback_model", None) or ""
        explicit = str(explicit).strip()
        fallback = str(fallback).strip()
        if explicit and fallback:
            return f"{explicit}(fallback={fallback})"
        if explicit:
            return explicit

    haiku = (os.getenv("ANTHROPIC_DEFAULT_HAIKU_MODEL") or "").strip()
    sonnet = (os.getenv("ANTHROPIC_DEFAULT_SONNET_MODEL") or "").strip()
    opus = (os.getenv("ANTHROPIC_DEFAULT_OPUS_MODEL") or "").strip()
    parts: list[str] = []
    if haiku:
        parts.append(f"haiku->{haiku}")
    if sonnet:
        parts.append(f"sonnet->{sonnet}")
    if opus:
        parts.append(f"opus->{opus}")
    map_str = "档:" + " ".join(parts) if parts else ""

    # 未显式 model：与 headless CLI 默认主模型档一致，按 Sonnet 环境解析
    if sonnet:
        if map_str:
            return f"effective={sonnet}(sonnet) | {map_str}"
        return f"effective={sonnet}(sonnet)"

    if map_str:
        return f"{map_str} | effective=未配置SONNET档"

    return "默认(未配置 model 与 ANTHROPIC_DEFAULT_*_MODEL)"
