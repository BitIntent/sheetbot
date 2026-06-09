"""
报表 LLM 执行器（tools 模式）

目标：
1) 为报表模块提供统一的 Claude Agent SDK + MCP tools 调用入口
2) 对齐“我要分析”的工具化调用思路
3) 保留上层业务对 prompt / JSON 解析的控制权
"""
import asyncio
import time
import uuid
from typing import Optional

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    TextBlock,
)

from ..large_file.large_file_tools import large_file_mcp, LARGE_FILE_TOOL_NAMES
from ..utils.logger import get_logger
from ..utils.llm_model_descriptor import describe_llm_model_for_log

logger = get_logger("report.llm_executor")


_DANGEROUS_TOOLS = [
    "Bash", "BashOutput", "KillBash",
    "Write", "Edit", "Read",
    "Glob", "Grep",
    "WebFetch", "WebSearch",
    "NotebookEdit",
    "Task",
]


async def call_llm_with_tools(
    *,
    file_id: str,
    prompt: str,
    system_prompt: str,
    timeout: float = 300.0,
    max_turns: int = 20,
    max_chars: Optional[int] = None,
    session_prefix: str = "report",
) -> str:
    """
    使用 Claude Agent SDK + large-file MCP tools 执行一次请求并返回文本。
    """
    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        mcp_servers={"large-file-tools": large_file_mcp},
        allowed_tools=LARGE_FILE_TOOL_NAMES,
        disallowed_tools=_DANGEROUS_TOOLS,
        permission_mode="acceptEdits",
        max_turns=max_turns,
    )
    logger.info(
        "call_llm_with_tools | llm=%s | file_id=%s | prompt_len=%s",
        describe_llm_model_for_log(options),
        file_id,
        len(prompt or ""),
    )

    full_prompt = (
        "你可以按需调用工具完成分析。\n"
        "若调用工具，请确保传入正确的 file_id。\n"
        f"当前 file_id: {file_id}\n\n"
        f"{prompt}"
    )

    started_at = time.monotonic()
    session_id = f"{session_prefix}_{file_id}_{uuid.uuid4().hex[:8]}"
    response_text = ""
    client: Optional[ClaudeSDKClient] = None

    try:
        client = ClaudeSDKClient(options)
        await client.__aenter__()

        await asyncio.wait_for(
            client.query(full_prompt, session_id=session_id),
            timeout=timeout,
        )

        async def collect_response() -> None:
            nonlocal response_text
            async for message in client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            response_text += block.text
                        elif hasattr(block, "text"):
                            response_text += block.text
                elif isinstance(message, dict):
                    msg_type = message.get("type")
                    if msg_type == "text":
                        response_text += message.get("content", "")
                    elif msg_type == "message":
                        content = message.get("content", [])
                        if isinstance(content, list):
                            for item in content:
                                if isinstance(item, dict) and item.get("type") == "text":
                                    response_text += item.get("text", "")

                if max_chars and len(response_text) >= max_chars:
                    logger.warning(
                        "tools LLM 响应达到 max_chars 限制并截断: file_id=%s max_chars=%d",
                        file_id,
                        max_chars,
                    )
                    break

        await asyncio.wait_for(collect_response(), timeout=timeout)
        return response_text.strip()

    except asyncio.TimeoutError as exc:
        elapsed = time.monotonic() - started_at
        logger.error("tools LLM 超时: file_id=%s elapsed=%.2fs", file_id, elapsed)
        raise TimeoutError(f"tools LLM 请求超时（{timeout}秒）") from exc
    except Exception as exc:
        elapsed = time.monotonic() - started_at
        logger.error("tools LLM 调用失败: file_id=%s elapsed=%.2fs err=%s", file_id, elapsed, exc)
        raise RuntimeError(f"tools LLM 调用失败: {exc}") from exc
    finally:
        if client:
            try:
                await asyncio.wait_for(client.__aexit__(None, None, None), timeout=5.0)
            except Exception:
                pass
