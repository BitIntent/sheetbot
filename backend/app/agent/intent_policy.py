"""
意图策略模块（Intent Policy）

目标：
1) 将“查询问句是否允许写操作”的判定从 prompt 细节中抽离
2) 用结构化信号（问句形态 + 写操作意图）替代硬编码问句枚举
3) 提供可复用策略，供其它 Agent 场景直接复用
"""
import re
from typing import List, Optional


# 问句结构信号：不依赖具体业务问句
_QUERY_FORM_RE = re.compile(
    r"[?？]|(谁|哪(位|个|些|一)?|什么|多少|几|是否|有没有|怎么|如何|为何|为什么|能否|可否|多高|多低|多大)",
    re.IGNORECASE,
)

# 显式写操作信号：跨领域通用（创建/写入/修改/导出等）
_WRITE_INTENT_RE = re.compile(
    r"(创建|新建|生成|写入|填充|设置|修改|删除|插入|排序|筛选|过滤|美化|标记|高亮|条件格式|图表|透视|汇总表|导出|下载)",
    re.IGNORECASE,
)


def has_query_form_signal(command: str) -> bool:
    """是否具备问句结构信号。"""
    text = str(command or "").strip()
    return bool(text) and bool(_QUERY_FORM_RE.search(text))


def has_write_intent_signal(command: str) -> bool:
    """是否具备显式写操作信号。"""
    text = str(command or "").strip()
    return bool(text) and bool(_WRITE_INTENT_RE.search(text))


def is_read_only_query_request(command: str, intents: Optional[List[str]] = None) -> bool:
    """
    是否应走“只读查询模式”（禁止写操作）。

    判定原则（非问句枚举）：
    - 有查询信号（已识别 query 或问句结构）
    - 且无显式写操作意图
    """
    text = str(command or "").strip()
    if not text:
        return False
    inferred = intents or []
    has_query_signal = ("query" in inferred) or has_query_form_signal(text)
    return has_query_signal and (not has_write_intent_signal(text))

