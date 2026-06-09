# backend/app/agent/ask_detector.py
"""
追问判定器 -- 独立模块

从 Agent 输出文本判断是否在向用户提问 / 索取补充信息。
从 sse_handler 抽取，职责单一，便于独立测试与迭代。

设计原则：
  宁可漏判（不追问）也不误判（卡住流程）。
  Agent 的"执行说明"绝不标记为追问。
"""
import re
from typing import List

# ── 明确的追问语义模式 ──
_ASK_PATTERNS: List[str] = [
    r'[?\uff1f]\s*$',
    r'请问',
    r'请补充',
    r'请确认',
    r'请告诉我',
    r'请说明',
    r'请选择',
    r'请提供',
    r'您(想|要|希望|需要).{0,15}(吗|呢)',
    r'(是否|能否|可否|要不要)',
]

# ── 执行 / 规划语义模式（与追问互斥时降权） ──
_EXEC_PATTERNS: List[str] = [
    r'我(将|来|需要|先)',
    r'让我',
    r'正在(执行|处理|分析|操作)',
    r'开始(处理|执行|分析)',
    r'执行以下',
    r'现在(开始|执行)',
    r'接下来',
    r'(已完成|已成功|操作完成)',
]


def is_asking_user(text: str) -> bool:
    """
    判断文本是否在向用户提问。

    Returns:
        True  = Agent 在追问，应标记 awaiting_followup
        False = 非追问（执行说明 / 汇报结果 / 其他）
    """
    if not text or not isinstance(text, str):
        return False

    stripped = text.strip()

    has_ask = any(re.search(p, stripped) for p in _ASK_PATTERNS)
    if not has_ask:
        return False

    has_exec = any(re.search(p, stripped) for p in _EXEC_PATTERNS)
    if has_exec:
        # 同时有执行语义 + 追问语义时，仅当句尾是问号才算追问
        return bool(re.search(r'[?\uff1f]\s*$', stripped))

    return True
