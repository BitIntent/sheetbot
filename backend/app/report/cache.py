"""Caching helpers for generated reports."""
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..files.models import ReportCache, SharedReport, UserFile
from ..utils.logger import get_logger
from .storage import delete_report_snapshot, load_report_snapshot, save_report_snapshot

logger = get_logger("report.cache")
CACHE_SCHEMA_VERSION = "report-cache-v4"
# 仅用于填充 DB expires_at 字段，实际清理已改为人工删除
DEFAULT_EXPIRES_DAYS = 365


def _normalize_options(options: Optional[Dict[str, Any]]) -> str:
    try:
        normalized = dict(options or {})
        normalized["__cache_schema_version"] = CACHE_SCHEMA_VERSION
        return json.dumps(normalized, ensure_ascii=False, sort_keys=True)
    except Exception:
        return ""


def _now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def get_cached_report(
    db: AsyncSession,
    file_id: str,
    template_key: str,
    options: Optional[Dict[str, Any]],
) -> Tuple[Optional[ReportCache], Optional[Dict[str, Any]]]:
    options_hash = _normalize_options(options)
    conditions = [
        ReportCache.file_id == file_id,
        ReportCache.options_hash == options_hash,
        ReportCache.status == "active",
    ]
    stmt = select(ReportCache).where(*conditions)
    if template_key != "auto":
        stmt = stmt.where(ReportCache.template_key == template_key)
    stmt = stmt.order_by(ReportCache.created_at.desc())
    result = await db.execute(stmt)
    record = result.scalar_one_or_none()
    if not record:
        return None, None

    snapshot = load_report_snapshot(record.snapshot_path)
    if not snapshot:
        await db.execute(
            update(ReportCache)
            .where(ReportCache.id == record.id)
            .values(status="stale", updated_at=datetime.now(timezone.utc))
        )
        await db.commit()
        return None, None

    return record, snapshot


async def get_cache_by_report_id(
    db: AsyncSession,
    report_id: str,
    user_id: Optional[str] = None,
) -> Optional[ReportCache]:
    conditions = [ReportCache.id == report_id]
    if user_id:
        conditions.append(ReportCache.user_id == user_id)
    result = await db.execute(select(ReportCache).where(*conditions))
    return result.scalar_one_or_none()


async def persist_report_cache(
    db: AsyncSession,
    user_id: str,
    file_id: str,
    template_key: str,
    options: Optional[Dict[str, Any]],
    report: Dict[str, Any],
) -> ReportCache:
    file_check = await db.execute(
        select(UserFile.id).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    exists = file_check.scalar_one_or_none()
    if not exists:
        raise ValueError(f"invalid user_file_id for report cache: {file_id}")

    options_hash = _normalize_options(options)
    snapshot_path = save_report_snapshot(report)
    expires_at = (_now_naive() + timedelta(days=DEFAULT_EXPIRES_DAYS))
    stored_template = report.get("template_key") or template_key
    cache_record = ReportCache(
        id=report.get("report_id"),
        user_id=user_id,
        file_id=file_id,
        template_key=stored_template,
        options_hash=options_hash,
        snapshot_path=snapshot_path,
        status="active",
        expires_at=expires_at,
    )
    db.add(cache_record)
    await db.commit()
    await db.refresh(cache_record)
    return cache_record


async def save_report_cache(
    user_id: str,
    file_id: str,
    template_key: str,
    options: Optional[Dict[str, Any]],
    report: Dict[str, Any],
) -> Optional[str]:
    """独立 session 版缓存写入（供 task_manager 使用）。"""
    from ..core.database import async_session_maker

    try:
        async with async_session_maker() as session:
            file_check = await session.execute(
                select(UserFile.id).where(
                    UserFile.id == file_id,
                    UserFile.user_id == user_id,
                    UserFile.status == "active",
                )
            )
            if not file_check.scalar_one_or_none():
                logger.warning("save_report_cache: file_id 无效 %s", file_id)
                snapshot_path = save_report_snapshot(report)
                cache_record = ReportCache(
                    id=report.get("report_id"),
                    user_id=user_id,
                    file_id=file_id,
                    template_key=template_key,
                    options_hash=_normalize_options(options),
                    snapshot_path=snapshot_path,
                    status="active",
                    expires_at=(_now_naive() + timedelta(days=DEFAULT_EXPIRES_DAYS)),
                )
                try:
                    session.add(cache_record)
                    await session.commit()
                    return cache_record.id
                except Exception:
                    await session.rollback()
                    return None

            options_hash = _normalize_options(options)
            snapshot_path = save_report_snapshot(report)
            stored_template = report.get("template_key") or template_key
            cache_record = ReportCache(
                id=report.get("report_id"),
                user_id=user_id,
                file_id=file_id,
                template_key=stored_template,
                options_hash=options_hash,
                snapshot_path=snapshot_path,
                status="active",
                expires_at=(_now_naive() + timedelta(days=DEFAULT_EXPIRES_DAYS)),
            )
            session.add(cache_record)
            await session.commit()
            return cache_record.id
    except Exception as e:
        logger.warning("save_report_cache 失败: %s", e)
        return None


async def cleanup_expired_cache(db: AsyncSession) -> None:
    # 按产品要求：禁用自动过期清理，改为人工删除。
    return
