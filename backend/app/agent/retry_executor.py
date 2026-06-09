"""
重试执行器（编排辅助层）。

职责：
- 执行“静默修复重试”回合
- 消费工具结果并复用外部校验链路
"""

from __future__ import annotations

from typing import Awaitable, Callable, Set, Any

from claude_agent_sdk import AssistantMessage, ToolUseBlock, ToolResultBlock, UserMessage


async def execute_silent_retry_round(
    *,
    client: Any,
    session_id: str,
    retry_prompt: str,
    query_readonly_mode: bool,
    readonly_tool_set: Set[str],
    process_tool_result: Callable[[ToolResultBlock], Awaitable[None]],
    get_fatal_validation_error: Callable[[], bool],
) -> bool:
    """
    静默执行一次修复回合：
    - 不向前端流式输出文本
    - 只消费工具结果并收集 operation/校验错误

    Returns:
    - query_readonly_aborted: 是否触发查询只读越权短路
    """
    await client.query(retry_prompt, session_id=session_id)
    stop_processing = False
    query_readonly_aborted = False
    async for message in client.receive_response():
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    if query_readonly_mode and block.name not in readonly_tool_set:
                        query_readonly_aborted = True
                        stop_processing = True
                        break
                    if block.name == "AskUserQuestion":
                        # 修复回合禁止追问，继续等待模型给出可执行计划
                        continue
                elif isinstance(block, ToolResultBlock):
                    await process_tool_result(block)
                    if get_fatal_validation_error():
                        stop_processing = True
                        break
        elif isinstance(message, UserMessage):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    await process_tool_result(block)
                    if get_fatal_validation_error():
                        stop_processing = True
                        break
        if stop_processing:
            break
    return query_readonly_aborted

