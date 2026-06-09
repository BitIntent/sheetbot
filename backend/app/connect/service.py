# ============================================================================
# 外部系统连接器 - 业务逻辑
# CRUD / 手动同步 / 测试连接
# ============================================================================
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..utils.logger import get_logger
from ..files import service as file_service
from .models import Connector, SyncJob

logger = get_logger("connect.service")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ── 连接器 CRUD ─────────────────────────────────────────────

async def create_connector(
    db: AsyncSession,
    user_id: str,
    *,
    name: str,
    type: str,
    config: Dict[str, Any],
    field_mapping: Dict[str, str],
    file_id: Optional[str] = None,
    sheet_name: Optional[str] = None,
    sync_interval: int = 0,
) -> Connector:
    """创建新连接器"""
    if file_id:
        await file_service.assert_active_file_owned(db, user_id, file_id)

    # Webhook 类型自动生成 endpoint_token
    if type == "webhook" and "endpoint_token" not in config:
        config["endpoint_token"] = uuid.uuid4().hex

    connector = Connector(
        id=str(uuid.uuid4()),
        user_id=user_id,
        file_id=file_id,
        sheet_name=sheet_name,
        name=name,
        type=type,
        config=json.dumps(config, ensure_ascii=False),
        field_mapping=json.dumps(field_mapping, ensure_ascii=False),
        sync_interval=sync_interval,
        status="paused",
    )
    db.add(connector)
    await db.flush()
    return connector


async def list_connectors(
    db: AsyncSession,
    user_id: str,
) -> List[Connector]:
    """列出用户所有连接器（按创建时间倒序）"""
    result = await db.execute(
        select(Connector)
        .where(Connector.user_id == user_id)
        .order_by(Connector.created_at.desc())
    )
    return list(result.scalars().all())


async def get_connector(
    db: AsyncSession,
    connector_id: str,
    user_id: str,
) -> Optional[Connector]:
    """获取用户的连接器"""
    result = await db.execute(
        select(Connector).where(
            Connector.id == connector_id,
            Connector.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


async def assert_connector_owned(
    db: AsyncSession,
    connector_id: str,
    user_id: str,
) -> Connector:
    """断言连接器归属于当前用户。"""
    connector = await get_connector(db, connector_id, user_id)
    if not connector:
        raise ValueError("连接器不存在")
    return connector


async def get_connector_by_id(
    db: AsyncSession,
    connector_id: str,
) -> Optional[Connector]:
    """按 ID 获取连接器（不校验 user_id，调度器内部使用）"""
    result = await db.execute(
        select(Connector).where(Connector.id == connector_id)
    )
    return result.scalar_one_or_none()


async def update_connector(
    db: AsyncSession,
    connector: Connector,
    **kwargs: Any,
) -> Connector:
    """更新连接器字段"""
    next_file_id = kwargs.get("file_id")
    if next_file_id:
        await file_service.assert_active_file_owned(db, connector.user_id, next_file_id)

    json_fields = ("config", "field_mapping")
    for key, value in kwargs.items():
        if value is None:
            continue
        if key in json_fields and isinstance(value, dict):
            setattr(connector, key, json.dumps(value, ensure_ascii=False))
        else:
            setattr(connector, key, value)
    await db.flush()
    return connector


async def delete_connector(db: AsyncSession, connector: Connector) -> None:
    await db.delete(connector)
    await db.flush()


# ── 同步任务 ────────────────────────────────────────────────

async def create_sync_job(
    db: AsyncSession,
    connector_id: str,
) -> SyncJob:
    """创建同步任务记录"""
    job = SyncJob(
        id=str(uuid.uuid4()),
        connector_id=connector_id,
        status="running",
    )
    db.add(job)
    await db.flush()
    return job


async def complete_sync_job(
    db: AsyncSession,
    job: SyncJob,
    *,
    status: str,
    rows_synced: int = 0,
    error_message: Optional[str] = None,
) -> SyncJob:
    """完成同步任务"""
    job.status = status
    job.rows_synced = rows_synced
    job.error_message = error_message
    job.completed_at = _utc_now()
    await db.flush()
    return job


async def list_sync_jobs(
    db: AsyncSession,
    connector_id: str,
    page: int = 1,
    page_size: int = 10,
) -> Tuple[List[SyncJob], int]:
    """分页获取同步记录"""
    total_q = await db.execute(
        select(func.count()).select_from(SyncJob)
        .where(SyncJob.connector_id == connector_id)
    )
    total = total_q.scalar() or 0

    offset = (page - 1) * page_size
    result = await db.execute(
        select(SyncJob)
        .where(SyncJob.connector_id == connector_id)
        .order_by(SyncJob.started_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    items = list(result.scalars().all())
    return items, total


# ── 获取活跃需同步的连接器 ──────────────────────────────────

async def get_due_connectors(
    db: AsyncSession,
) -> List[Connector]:
    """获取所有 active 且 sync_interval > 0 且到期需同步的连接器"""
    result = await db.execute(
        select(Connector).where(
            Connector.status == "active",
            Connector.sync_interval > 0,
        )
    )
    connectors = list(result.scalars().all())

    now = _utc_now()
    due = []
    for c in connectors:
        if not c.last_sync_at:
            due.append(c)
            continue
        elapsed_minutes = (now - c.last_sync_at).total_seconds() / 60
        if elapsed_minutes >= c.sync_interval:
            due.append(c)
    return due


# ── Webhook 查找 ────────────────────────────────────────────

async def get_connector_by_webhook_token(
    db: AsyncSession,
    endpoint_token: str,
) -> Optional[Connector]:
    """通过 webhook endpoint_token 查找连接器"""
    result = await db.execute(
        select(Connector).where(
            Connector.type == "webhook",
            Connector.status == "active",
        )
    )
    for c in result.scalars().all():
        config = json.loads(c.config) if isinstance(c.config, str) else c.config
        if config.get("endpoint_token") == endpoint_token:
            return c
    return None
