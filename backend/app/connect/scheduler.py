# ============================================================================
# 外部系统连接器 - 定时同步调度器
# 基于 asyncio 的轻量级调度，无重外部依赖
# 在 FastAPI lifespan 中启动/停止
# ============================================================================
from __future__ import annotations

import asyncio

from ..core.database import async_session_maker
from ..utils.logger import get_logger
from . import service
from .sync_engine import execute_sync

logger = get_logger("connect.scheduler")

# 扫描间隔（秒）
_SCAN_INTERVAL = 60


class SyncScheduler:
    """asyncio 定时同步调度器"""

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        """启动调度循环"""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("同步调度器已启动 (间隔=%ds)", _SCAN_INTERVAL)

    async def stop(self) -> None:
        """停止调度循环"""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("同步调度器已停止")

    async def _loop(self) -> None:
        """主调度循环：扫描到期连接器并触发同步"""
        while self._running:
            try:
                await self._scan_and_sync()
            except Exception as e:
                logger.error("调度扫描异常: %s", e)
            await asyncio.sleep(_SCAN_INTERVAL)

    async def _scan_and_sync(self) -> None:
        """扫描所有到期连接器并逐个执行同步"""
        async with async_session_maker() as db:
            due = await service.get_due_connectors(db)
            if not due:
                return

            logger.info("发现 %d 个到期连接器，开始同步", len(due))
            for connector in due:
                try:
                    result = await execute_sync(db, connector)
                    logger.info(
                        "定时同步完成: connector=%s, status=%s, rows=%s",
                        connector.id, result["status"], result["rows_synced"],
                    )
                except Exception as e:
                    logger.error("定时同步失败: connector=%s, err=%s", connector.id, e)
            await db.commit()


# 全局单例
sync_scheduler = SyncScheduler()
