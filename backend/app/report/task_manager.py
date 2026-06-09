# backend/app/report/task_manager.py
"""
异步报表任务管理器
使用 asyncio.Task 在进程内异步执行报表生成，支持页面刷新后继续
"""
import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.database import async_session_maker
from ..files.models import ReportTask, Notification, utc_now
from ..files import service as file_service
from ..utils.logger import get_logger

logger = get_logger("report.task_manager")

_notification_queues: Dict[str, asyncio.Queue] = {}


def get_notification_queue(user_id: str) -> asyncio.Queue:
    if user_id not in _notification_queues:
        _notification_queues[user_id] = asyncio.Queue()
    return _notification_queues[user_id]


def remove_notification_queue(user_id: str):
    _notification_queues.pop(user_id, None)


class ReportTaskManager:
    """单例任务管理器，管理 asyncio.Task 字典。"""

    _instance: Optional["ReportTaskManager"] = None
    _tasks: Dict[str, asyncio.Task]

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._tasks = {}
        return cls._instance

    async def startup(self):
        """应用启动时标记 pending/running 任务为 interrupted。"""
        try:
            async with async_session_maker() as session:
                stmt = (
                    update(ReportTask)
                    .where(ReportTask.status.in_(["pending", "running"]))
                    .values(
                        status="interrupted",
                        error_message="服务重启，任务被中断，请重新生成",
                        updated_at=utc_now(),
                    )
                )
                result = await session.execute(stmt)
                await session.commit()
                if result.rowcount:
                    logger.info("已标记 %d 个中断任务", result.rowcount)
        except Exception as e:
            logger.warning("startup 标记中断任务失败: %s", e)

    async def submit_task(
        self,
        user_id: str,
        file_id: str,
        template_key: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> str:
        """提交异步报表生成任务，返回 task_id。"""
        async with async_session_maker() as session:
            await file_service.assert_active_file_owned(session, user_id, file_id)

        task_id = str(uuid.uuid4())

        async with async_session_maker() as session:
            task_record = ReportTask(
                id=task_id,
                user_id=user_id,
                file_id=file_id,
                template_key=template_key,
                options_json=json.dumps(options or {}, ensure_ascii=False),
                status="pending",
                progress=0,
                progress_message="排队中...",
            )
            session.add(task_record)
            await session.commit()

        asyncio_task = asyncio.create_task(
            self._run_task(task_id, user_id, file_id, template_key, options or {})
        )
        self._tasks[task_id] = asyncio_task
        asyncio_task.add_done_callback(lambda t: self._tasks.pop(task_id, None))

        logger.info("任务已提交: task_id=%s file_id=%s template=%s", task_id, file_id, template_key)
        return task_id

    async def get_task_status(self, task_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """查询任务状态。"""
        async with async_session_maker() as session:
            result = await session.execute(
                select(ReportTask).where(
                    ReportTask.id == task_id,
                    ReportTask.user_id == user_id,
                )
            )
            task = result.scalar_one_or_none()
            if not task:
                return None
            return {
                "task_id": task.id,
                "status": task.status,
                "progress": task.progress,
                "progress_message": task.progress_message,
                "report_cache_id": task.report_cache_id,
                "error_message": task.error_message,
                "created_at": task.created_at.isoformat() if task.created_at else None,
                "completed_at": task.completed_at.isoformat() if task.completed_at else None,
            }

    async def assert_task_owned(self, task_id: str, user_id: str) -> Dict[str, Any]:
        """断言任务归属于当前用户并返回状态。"""
        status = await self.get_task_status(task_id, user_id)
        if not status:
            raise ValueError("任务不存在")
        return status

    async def list_user_tasks(self, user_id: str, limit: int = 20) -> list:
        """列出用户的任务。"""
        async with async_session_maker() as session:
            result = await session.execute(
                select(ReportTask)
                .where(ReportTask.user_id == user_id)
                .order_by(ReportTask.created_at.desc())
                .limit(limit)
            )
            tasks = result.scalars().all()
            return [
                {
                    "task_id": t.id,
                    "file_id": t.file_id,
                    "template_key": t.template_key,
                    "status": t.status,
                    "progress": t.progress,
                    "progress_message": t.progress_message,
                    "report_cache_id": t.report_cache_id,
                    "error_message": t.error_message,
                    "created_at": t.created_at.isoformat() if t.created_at else None,
                    "completed_at": t.completed_at.isoformat() if t.completed_at else None,
                }
                for t in tasks
            ]

    async def _run_task(
        self,
        task_id: str,
        user_id: str,
        file_id: str,
        template_key: str,
        options: Dict[str, Any],
    ):
        """实际执行报表生成的后台协程。"""
        from .assembler import generate_report
        from .cache import save_report_cache
        from .share_service import upsert_user_report

        logger.info("任务开始执行: task_id=%s", task_id)
        report_data = None

        try:
            await self._update_task(task_id, status="running", progress=5, progress_message="开始生成...")

            async for event in generate_report(file_id, template_key, options):
                evt_type = event.get("event")
                data = event.get("data", {})

                if evt_type == "progress":
                    await self._update_task(
                        task_id,
                        progress=data.get("progress", 0),
                        progress_message=data.get("message", ""),
                    )
                elif evt_type == "error":
                    raise RuntimeError(data.get("message", "未知错误"))
                elif evt_type == "complete":
                    report_data = data

            if not report_data:
                raise RuntimeError("报表生成未返回完整数据")

            # 缓存报表
            cache_id = None
            try:
                cache_file_id = (
                    (options or {}).get("source_file_id")
                    or (options or {}).get("user_file_id")
                    or (report_data or {}).get("source_file_id")
                    or (report_data or {}).get("user_file_id")
                    or file_id
                )
                cache_id = await save_report_cache(
                    user_id, cache_file_id, template_key, options, report_data,
                )
            except Exception as e:
                logger.warning("报表缓存失败: task_id=%s err=%s", task_id, e)

            try:
                async with async_session_maker() as session:
                    await upsert_user_report(
                        db=session,
                        user_id=user_id,
                        report_data=report_data,
                        source_file_id=(options or {}).get("source_file_id") or (options or {}).get("user_file_id"),
                        report_cache_id=cache_id,
                    )
            except Exception as e:
                logger.warning("个人报表保存失败: task_id=%s err=%s", task_id, e)

            await self._update_task(
                task_id,
                status="completed",
                progress=100,
                progress_message="生成完成",
                report_cache_id=cache_id,
                completed_at=datetime.now(timezone.utc),
            )

            # 发送通知
            await self._create_notification(
                user_id, task_id,
                "report_completed",
                "报表生成完成",
                f"报表已成功生成",
                {
                    "task_id": task_id,
                    "report_cache_id": cache_id,
                    "file_id": file_id,
                    "template_key": template_key,
                    "report_title": report_data.get("title", "数据报表"),
                },
            )

            logger.info("任务完成: task_id=%s cache_id=%s", task_id, cache_id)

        except Exception as e:
            logger.error("任务失败: task_id=%s err=%s", task_id, e)
            await self._update_task(
                task_id,
                status="failed",
                progress=0,
                progress_message="生成失败",
                error_message=str(e)[:500],
                completed_at=datetime.now(timezone.utc),
            )
            await self._create_notification(
                user_id, task_id,
                "report_failed",
                "报表生成失败",
                f"错误: {str(e)[:200]}",
                {"task_id": task_id, "file_id": file_id, "template_key": template_key},
            )

    async def _update_task(self, task_id: str, **kwargs):
        try:
            async with async_session_maker() as session:
                kwargs["updated_at"] = utc_now()
                await session.execute(
                    update(ReportTask).where(ReportTask.id == task_id).values(**kwargs)
                )
                await session.commit()
        except Exception as e:
            logger.warning("更新任务状态失败: task_id=%s err=%s", task_id, e)

    async def _create_notification(
        self,
        user_id: str,
        task_id: str,
        notif_type: str,
        title: str,
        message: str,
        payload: Dict[str, Any],
    ):
        try:
            notif_id = str(uuid.uuid4())
            async with async_session_maker() as session:
                notif = Notification(
                    id=notif_id,
                    user_id=user_id,
                    type=notif_type,
                    title=title,
                    message=message,
                    payload=json.dumps(payload, ensure_ascii=False),
                )
                session.add(notif)
                await session.commit()

            # 推送到 SSE queue
            queue = _notification_queues.get(user_id)
            if queue:
                await queue.put({
                    "id": notif_id,
                    "type": notif_type,
                    "title": title,
                    "message": message,
                    "payload": payload,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                })

        except Exception as e:
            logger.warning("创建通知失败: user_id=%s err=%s", user_id, e)


report_task_manager = ReportTaskManager()
