# backend/app/files/ugc_registry_service.py
"""
PPTX / 批量 Word 导出 —— 数据库注册表（路径索引 + 列表真源）
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import BatchWordExport, UserPptx


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def upsert_user_pptx(
    session: AsyncSession,
    *,
    pptx_id: str,
    user_id: str,
    title: str,
    template_key: str,
    source_file_id: str,
    meta_rel_path: str,
    pptx_rel_path: str,
    slide_count: int,
    pptx_size_bytes: int,
) -> None:
    row = await session.get(UserPptx, pptx_id)
    now = _utc_now()
    if row is None:
        session.add(
            UserPptx(
                pptx_id=pptx_id,
                user_id=user_id,
                title=title or "",
                template_key=template_key or "",
                source_file_id=source_file_id or None,
                meta_rel_path=meta_rel_path,
                pptx_rel_path=pptx_rel_path,
                slide_count=int(slide_count or 0),
                pptx_size_bytes=int(pptx_size_bytes or 0),
                status="active",
                created_at=now,
                updated_at=now,
            )
        )
    else:
        row.user_id = user_id
        row.title = title or ""
        row.template_key = template_key or ""
        row.source_file_id = source_file_id or None
        row.meta_rel_path = meta_rel_path
        row.pptx_rel_path = pptx_rel_path
        row.slide_count = int(slide_count or 0)
        row.pptx_size_bytes = int(pptx_size_bytes or 0)
        row.status = "active"
        row.updated_at = now


async def mark_user_pptx_deleted(session: AsyncSession, pptx_id: str) -> None:
    row = await session.get(UserPptx, pptx_id)
    if row:
        row.status = "deleted"
        row.updated_at = _utc_now()


async def update_user_pptx_slide_count(
    session: AsyncSession, pptx_id: str, slide_count: int
) -> None:
    row = await session.get(UserPptx, pptx_id)
    if row:
        row.slide_count = int(slide_count or 0)
        row.updated_at = _utc_now()


async def upsert_batch_word_export(
    session: AsyncSession,
    *,
    task_id: str,
    user_id: str,
    template_id: Optional[str],
    template_file_name: str,
    source_file_id: str,
    filename_pattern: Optional[str],
    zip_rel_path: str,
    total: int,
    zip_size_bytes: int,
) -> None:
    row = await session.get(BatchWordExport, task_id)
    now = _utc_now()
    if row is None:
        session.add(
            BatchWordExport(
                task_id=task_id,
                user_id=user_id,
                template_id=template_id or None,
                template_file_name=template_file_name or "",
                source_file_id=source_file_id or None,
                filename_pattern=filename_pattern or None,
                zip_rel_path=zip_rel_path,
                total=int(total or 0),
                zip_size_bytes=int(zip_size_bytes or 0),
                status="active",
                created_at=now,
                updated_at=now,
            )
        )
    else:
        row.user_id = user_id
        row.template_id = template_id or None
        row.template_file_name = template_file_name or ""
        row.source_file_id = source_file_id or None
        row.filename_pattern = filename_pattern or None
        row.zip_rel_path = zip_rel_path
        row.total = int(total or 0)
        row.zip_size_bytes = int(zip_size_bytes or 0)
        row.status = "active"
        row.updated_at = now


async def mark_batch_word_export_deleted(session: AsyncSession, task_id: str) -> None:
    row = await session.get(BatchWordExport, task_id)
    if row:
        row.status = "deleted"
        row.updated_at = _utc_now()


async def count_active_user_pptx(session: AsyncSession) -> int:
    q = select(func.count()).select_from(UserPptx).where(UserPptx.status == "active")
    return int(await session.scalar(q) or 0)


async def count_active_batch_word_exports(session: AsyncSession) -> int:
    q = select(func.count()).select_from(BatchWordExport).where(
        BatchWordExport.status == "active"
    )
    return int(await session.scalar(q) or 0)
