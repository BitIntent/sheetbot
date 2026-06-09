# backend/app/report/llm_client.py
"""
LLM 客户端 - 使用 Claude Agent SDK 进行单次 LLM 调用
替代直接使用 anthropic 模块的方式
"""
import os
import asyncio
from typing import Optional
from claude_agent_sdk import (
    query, ClaudeAgentOptions,
    AssistantMessage, TextBlock
)
from ..core.config import settings
from ..utils.logger import get_logger
from ..utils.llm_model_descriptor import describe_llm_model_for_log

logger = get_logger("report.llm_client")


async def call_llm_single(
    prompt: str,
    model: str = "claude-sonnet-4-20250514",
    max_tokens: int = 8192,
    timeout: float = 300.0,
    system_prompt: Optional[str] = None,
) -> str:
    """
    使用 Claude Agent SDK 进行单次 LLM 调用。
    
    Args:
        prompt: 用户提示词
        model: 模型名称（保留参数，SDK 会自动使用环境变量中的模型配置）
        max_tokens: 最大 token 数（保留参数，SDK 会自动处理）
        timeout: 超时时间（秒）
        system_prompt: 可选的系统提示词
    
    Returns:
        LLM 返回的文本内容
    
    Raises:
        TimeoutError: 请求超时
        RuntimeError: API 配置错误或其他错误
    """
    credential = settings.ANTHROPIC_CREDENTIAL
    if not credential:
        raise RuntimeError("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 未配置")
    # Claude Agent SDK/CLI 默认读取 ANTHROPIC_API_KEY，这里做兼容映射。
    if not os.getenv("ANTHROPIC_API_KEY") and settings.ANTHROPIC_AUTH_TOKEN:
        os.environ["ANTHROPIC_API_KEY"] = settings.ANTHROPIC_AUTH_TOKEN
    
    # 构建 ClaudeAgentOptions（显式传入 model 便于日志与 SDK 对齐）
    options = ClaudeAgentOptions(
        system_prompt=system_prompt or "你是一位专业的数据分析师。",
        permission_mode="acceptEdits",
        max_turns=1,  # 单次请求，不需要多轮对话
        model=model,
    )
    
    # 如果配置了自定义 base_url，需要通过环境变量传递
    if settings.ANTHROPIC_BASE_URL:
        # 临时设置环境变量（如果 SDK 支持）
        original_base_url = os.environ.get("ANTHROPIC_BASE_URL")
        try:
            os.environ["ANTHROPIC_BASE_URL"] = settings.ANTHROPIC_BASE_URL
            result = await _execute_query(prompt, options, timeout)
        finally:
            # 恢复原始环境变量
            if original_base_url is None:
                os.environ.pop("ANTHROPIC_BASE_URL", None)
            else:
                os.environ["ANTHROPIC_BASE_URL"] = original_base_url
    else:
        result = await _execute_query(prompt, options, timeout)
    
    return result


async def _execute_query(
    prompt: str,
    options: ClaudeAgentOptions,
    timeout: float,
) -> str:
    """执行查询并收集响应文本"""
    logger.info(
        "call_llm_single | llm=%s | prompt_len=%s",
        describe_llm_model_for_log(options),
        len(prompt or ""),
    )
    try:
        response_text = ""
        
        # 使用 asyncio.wait_for 实现超时控制
        async def collect_response():
            nonlocal response_text
            async for message in query(prompt=prompt, options=options):
                # 处理 AssistantMessage 类型
                if isinstance(message, AssistantMessage):
                    if hasattr(message, "content") and message.content:
                        for block in message.content:
                            if isinstance(block, TextBlock):
                                response_text += block.text
                            elif hasattr(block, "text"):
                                # 兼容其他可能有 text 属性的块类型
                                response_text += block.text
                # 处理字典类型的消息（向后兼容）
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
                # 处理其他可能有 content 属性的消息对象
                elif hasattr(message, "content"):
                    content = message.content
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, TextBlock):
                                response_text += block.text
                            elif hasattr(block, "text"):
                                response_text += block.text
                            elif isinstance(block, dict) and block.get("type") == "text":
                                response_text += block.get("text", "")
                    elif isinstance(content, str):
                        response_text += content
        
        await asyncio.wait_for(collect_response(), timeout=timeout)
        
        if not response_text.strip():
            logger.warning("LLM 返回空响应")
        
        return response_text.strip()
        
    except asyncio.TimeoutError:
        raise TimeoutError(f"LLM 请求超时（{timeout}秒）")
    except Exception as e:
        logger.error("LLM 调用失败: err=%s", e)
        raise RuntimeError(f"LLM 调用失败: {e}")
