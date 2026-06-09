# backend/app/agent/query_bridge.py
"""
========================================================================
前端数据查询桥接器

普通模式下，全表数据在浏览器内存（workbook JSON），后端 MCP 工具无法直接访问。
QueryBridge 实现「后端请求 → 前端计算 → 结果回传」的异步闭环：

  MCP Tool (await) ──→ SSE Queue ──→ Frontend
       ↑                                │
       └── Future.set_result ←── POST /operation-result

每个 SSE session 一个 bridge 实例，生命周期与 SSE 连接一致。
========================================================================
"""
import asyncio
import json
import uuid as _uuid
from contextvars import ContextVar
from typing import Any, Dict, Optional

from ..utils.logger import get_logger

logger = get_logger("query_bridge")

# ── 会话级 contextvar（在 SSE handler 中设置，MCP 工具函数中读取）──
_current_bridge: ContextVar[Optional["QueryBridge"]] = ContextVar(
    "current_query_bridge", default=None
)


def get_current_bridge() -> Optional["QueryBridge"]:
    return _current_bridge.get(None)


def set_current_bridge(bridge: Optional["QueryBridge"]):
    _current_bridge.set(bridge)


# ── QueryBridge ──

_QUERY_TIMEOUT_SEC = 15


class QueryBridge:
    """Session-scoped 前端数据查询桥接器"""

    def __init__(self, sse_queue: asyncio.Queue, session_id: str = ""):
        self._sse_queue = sse_queue
        self._session_id = session_id
        self._pending: Dict[str, asyncio.Future] = {}

    async def query_frontend(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        向前端发出只读查询请求，阻塞等待结果返回。

        Args:
            operation: 查询操作字典，如 {"type": "aggregate_column", "params": {...}}

        Returns:
            前端计算后的结果字典
        """
        query_id = str(_uuid.uuid4())
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[query_id] = future

        await self._sse_queue.put({
            "type": "data_query",
            "payload": {
                "query_id": query_id,
                "operation": operation,
            },
        })
        logger.debug(
            f"[{self._session_id}] data_query 已入队: "
            f"query_id={query_id}, op={operation.get('type')}"
        )

        try:
            result = await asyncio.wait_for(future, timeout=_QUERY_TIMEOUT_SEC)
            return result
        except asyncio.TimeoutError:
            logger.warning(
                f"[{self._session_id}] data_query 超时: query_id={query_id}"
            )
            return {"error": f"前端查询超时（{_QUERY_TIMEOUT_SEC}s）"}
        finally:
            self._pending.pop(query_id, None)

    def resolve(self, query_id: str, result: Dict[str, Any]):
        """
        前端 POST 回来的结果，通过此方法唤醒等待中的 Future。
        """
        future = self._pending.get(query_id)
        if future and not future.done():
            future.set_result(result)
            logger.debug(
                f"[{self._session_id}] data_query 已回填: query_id={query_id}"
            )
        else:
            logger.warning(
                f"[{self._session_id}] data_query 无匹配 future: query_id={query_id}"
            )

    def cleanup(self):
        """取消所有挂起的查询（SSE 断开时调用）"""
        for qid, future in list(self._pending.items()):
            if not future.done():
                future.cancel()
        self._pending.clear()
