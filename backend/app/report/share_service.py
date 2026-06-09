# backend/app/report/share_service.py
"""
报表分享服务 — 创建 / 读取 / 管理分享链接与 JSON 快照
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..files.models import SharedReport, UserFile, ReportCache
from ..utils.logger import get_logger
from .cache import DEFAULT_EXPIRES_DAYS, get_cache_by_report_id, persist_report_cache
from .storage import load_report_snapshot, save_report_snapshot, delete_report_snapshot

logger = get_logger("report.share")


async def create_share(
    db: AsyncSession,
    user_id: str,
    source_file_id: Optional[str],
    report_data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    创建分享链接，持久化报表快照。
    Returns: {"share_token": ..., "report_id": ..., "share_url": ...}
    """
    share_token = uuid.uuid4().hex
    validated_source_file_id: Optional[str] = None
    if source_file_id:
        try:
            result = await db.execute(
                select(UserFile.id).where(
                    UserFile.id == source_file_id,
                    UserFile.user_id == user_id,
                    UserFile.status == "active",
                )
            )
            exists = result.scalar_one_or_none()
            if exists:
                validated_source_file_id = source_file_id
            else:
                logger.warning(
                    f"分享报表时 source_file_id 非法或不存在，已置空: "
                    f"user_id={user_id}, source_file_id={source_file_id}"
                )
        except Exception as e:
            logger.warning(f"校验 source_file_id 失败，已置空: {e}")

    cache_record = None
    report_id = report_data.get("report_id")
    if report_id:
        cache_record = await get_cache_by_report_id(db, report_id, user_id=user_id)

    # 尽量使用 user_files.id 持久化缓存，避免 large_file 会话 ID 触发外键错误
    file_id = validated_source_file_id or report_data.get("source_file_id") or report_data.get("user_file_id")
    template_key = report_data.get("template_key", "overview")
    options = report_data.get("options") or {}
    if not cache_record and file_id:
        try:
            cache_record = await persist_report_cache(
                db,
                user_id,
                file_id,
                template_key,
                options,
                report_data,
            )
        except Exception as exc:
            logger.warning(f"分享时报表缓存写入失败，回退快照模式: {exc}")

    if cache_record:
        snapshot_path = cache_record.snapshot_path
        cache_id = cache_record.id
        expires_at = cache_record.expires_at
    else:
        snapshot_path = save_report_snapshot(report_data, suffix=".share")
        cache_id = None
        expires_at = datetime.now(timezone.utc) + timedelta(days=DEFAULT_EXPIRES_DAYS)

    target_report_id = report_data.get("report_id") or str(uuid.uuid4())
    existing_result = await db.execute(
        select(SharedReport).where(
            SharedReport.id == target_report_id,
            SharedReport.user_id == user_id,
        )
    )
    existing = existing_result.scalar_one_or_none()

    if existing:
        # 同一 report 再次分享时复用并刷新记录，保证接口幂等。
        existing.share_token = share_token
        existing.source_file_id = validated_source_file_id
        existing.title = report_data.get("title", "数据报表")
        existing.template_key = report_data.get("template_key", "overview")
        existing.report_snapshot_path = snapshot_path
        existing.report_cache_id = cache_id
        existing.expires_at = expires_at
        existing.is_public = True
        existing.status = "active"
        existing.updated_at = datetime.now(timezone.utc)
        record = existing
    else:
        record = SharedReport(
            id=target_report_id,
            user_id=user_id,
            source_file_id=validated_source_file_id,
            share_token=share_token,
            title=report_data.get("title", "数据报表"),
            template_key=report_data.get("template_key", "overview"),
            report_snapshot_path=snapshot_path,
            report_cache_id=cache_id,
            expires_at=expires_at,
            is_public=True,
            created_at=datetime.now(timezone.utc),
        )
        db.add(record)

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # 并发双击分享时，后写请求可能遇到主键冲突，回退为更新。
        if "Duplicate entry" not in str(exc):
            raise
        retry = await db.execute(
            select(SharedReport).where(
                SharedReport.id == target_report_id,
                SharedReport.user_id == user_id,
            )
        )
        concurrent_record = retry.scalar_one_or_none()
        if not concurrent_record:
            raise
        concurrent_record.share_token = share_token
        concurrent_record.source_file_id = validated_source_file_id
        concurrent_record.title = report_data.get("title", "数据报表")
        concurrent_record.template_key = report_data.get("template_key", "overview")
        concurrent_record.report_snapshot_path = snapshot_path
        concurrent_record.report_cache_id = cache_id
        concurrent_record.expires_at = expires_at
        concurrent_record.is_public = True
        concurrent_record.status = "active"
        concurrent_record.updated_at = datetime.now(timezone.utc)
        record = concurrent_record
        await db.commit()

    logger.info(f"报表分享已创建/更新: token={share_token}, report_id={record.id}")
    return {
        "share_token": share_token,
        "report_id": record.id,
    }


async def upsert_user_report(
    db: AsyncSession,
    user_id: str,
    report_data: Dict[str, Any],
    source_file_id: Optional[str] = None,
    report_cache_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    创建/更新用户个人报表记录（默认不公开），用于“历史报表清单”。
    """
    target_report_id = report_data.get("report_id") or str(uuid.uuid4())
    snapshot_path = save_report_snapshot(report_data, suffix=".saved")
    title = report_data.get("title", "数据报表")
    template_key = report_data.get("template_key", "overview")
    expires_at = datetime.now(timezone.utc) + timedelta(days=DEFAULT_EXPIRES_DAYS)

    result = await db.execute(
        select(SharedReport).where(
            SharedReport.id == target_report_id,
            SharedReport.user_id == user_id,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        old_snapshot = existing.report_snapshot_path
        existing.title = title
        existing.template_key = template_key
        existing.source_file_id = source_file_id or existing.source_file_id
        existing.report_cache_id = report_cache_id or existing.report_cache_id
        existing.report_snapshot_path = snapshot_path
        existing.expires_at = expires_at
        existing.status = "active"
        existing.updated_at = datetime.now(timezone.utc)
        if not existing.share_token:
            existing.share_token = uuid.uuid4().hex
        # 保持默认私有，分享接口再显式打开
        existing.is_public = bool(existing.is_public and existing.share_token)
        record = existing
        if old_snapshot and old_snapshot != snapshot_path:
            delete_report_snapshot(old_snapshot)
    else:
        record = SharedReport(
            id=target_report_id,
            user_id=user_id,
            source_file_id=source_file_id,
            share_token=uuid.uuid4().hex,
            title=title,
            template_key=template_key,
            report_snapshot_path=snapshot_path,
            report_cache_id=report_cache_id,
            expires_at=expires_at,
            is_public=False,
            status="active",
            created_at=datetime.now(timezone.utc),
        )
        db.add(record)

    await db.commit()
    logger.info("个人报表已保存: report_id=%s user_id=%s public=%s", record.id, user_id, record.is_public)
    return {"report_id": record.id}


async def get_shared_report(
    db: AsyncSession,
    share_token: str,
) -> Optional[Dict[str, Any]]:
    """
    通过 share_token 获取公开报表数据（无需登录）。
    同时递增 view_count。
    """
    result = await db.execute(
        select(SharedReport).where(
            SharedReport.share_token == share_token,
            SharedReport.status == "active",
            SharedReport.is_public == True,
        )
    )
    record = result.scalar_one_or_none()
    if not record:
        return None

    await db.execute(
        update(SharedReport)
        .where(SharedReport.id == record.id)
        .values(view_count=SharedReport.view_count + 1)
    )
    await db.commit()

    snapshot_path = record.report_snapshot_path
    if record.report_cache_id:
        cache = await get_cache_by_report_id(db, record.report_cache_id, user_id=record.user_id)
        if not cache or cache.status != "active":
            return None
        snapshot_path = cache.snapshot_path

    snapshot = load_report_snapshot(snapshot_path)
    if not snapshot:
        return None

    snapshot["share_token"] = share_token
    snapshot["view_count"] = record.view_count + 1
    return snapshot


async def list_user_reports(
    db: AsyncSession,
    user_id: str,
) -> list:
    """列出用户的所有报表（包含已分享与未分享缓存报表）。"""
    shared_result = await db.execute(
        select(SharedReport).where(
            SharedReport.user_id == user_id,
            SharedReport.status == "active",
        ).order_by(SharedReport.created_at.desc())
    )
    shared_records = shared_result.scalars().all()
    shared_items = [
        {
            "report_id": r.id,
            "title": r.title,
            "template_key": r.template_key,
            "share_token": r.share_token,
            "source_file_id": r.source_file_id,
            "view_count": r.view_count,
            "is_shared": True,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in shared_records
    ]

    shared_ids = {item["report_id"] for item in shared_items}
    cache_result = await db.execute(
        select(ReportCache).where(
            ReportCache.user_id == user_id,
            ReportCache.status == "active",
        ).order_by(ReportCache.created_at.desc())
    )
    cache_records = cache_result.scalars().all()

    cache_items = []
    for cache in cache_records:
        if cache.id in shared_ids:
            continue
        snapshot = load_report_snapshot(cache.snapshot_path) or {}
        cache_items.append(
            {
                "report_id": cache.id,
                "title": snapshot.get("title") or "数据报表",
                "template_key": snapshot.get("template_key") or cache.template_key,
                "share_token": None,
                "source_file_id": cache.file_id,
                "view_count": 0,
                "is_shared": False,
                "created_at": cache.created_at.isoformat() if cache.created_at else None,
            }
        )

    all_items = shared_items + cache_items
    all_items.sort(key=lambda x: x.get("created_at") or "", reverse=True)
    return all_items


async def get_user_report_detail(
    db: AsyncSession,
    user_id: str,
    report_id: str,
) -> Optional[Dict[str, Any]]:
    """按 report_id 获取用户报表详情。"""
    result = await db.execute(
        select(SharedReport).where(
            SharedReport.id == report_id,
            SharedReport.user_id == user_id,
            SharedReport.status == "active",
        )
    )
    record = result.scalar_one_or_none()
    if record:
        snapshot_path = record.report_snapshot_path
        if record.report_cache_id:
            cache = await get_cache_by_report_id(db, record.report_cache_id, user_id=user_id)
            if cache and cache.status == "active":
                snapshot_path = cache.snapshot_path

        snapshot = load_report_snapshot(snapshot_path)
        if not snapshot:
            return None

        snapshot["report_id"] = record.id
        snapshot["share_token"] = record.share_token
        snapshot["source_file_id"] = record.source_file_id
        snapshot["template_key"] = record.template_key
        snapshot["title"] = snapshot.get("title") or record.title
        snapshot["created_at"] = record.created_at.isoformat() if record.created_at else None
        return snapshot

    # 兜底：未分享报表从缓存读取
    cache_result = await db.execute(
        select(ReportCache).where(
            ReportCache.id == report_id,
            ReportCache.user_id == user_id,
            ReportCache.status == "active",
        )
    )
    cache = cache_result.scalar_one_or_none()
    if not cache:
        return None

    snapshot = load_report_snapshot(cache.snapshot_path)
    if not snapshot:
        return None

    snapshot["report_id"] = cache.id
    snapshot["share_token"] = None
    snapshot["source_file_id"] = cache.file_id
    snapshot["template_key"] = snapshot.get("template_key") or cache.template_key
    snapshot["title"] = snapshot.get("title") or "数据报表"
    snapshot["created_at"] = cache.created_at.isoformat() if cache.created_at else None
    return snapshot


async def delete_user_report(
    db: AsyncSession,
    user_id: str,
    report_id: str,
) -> bool:
    """删除用户报表（优先删分享记录，未分享则删缓存记录）。"""
    result = await db.execute(
        select(SharedReport).where(
            SharedReport.id == report_id,
            SharedReport.user_id == user_id,
            SharedReport.status == "active",
        )
    )
    record = result.scalar_one_or_none()
    if not record:
        cache_result = await db.execute(
            select(ReportCache).where(
                ReportCache.id == report_id,
                ReportCache.user_id == user_id,
                ReportCache.status == "active",
            )
        )
        cache = cache_result.scalar_one_or_none()
        if not cache:
            return False
        cache.status = "deleted"
        cache.updated_at = datetime.now(timezone.utc)
        delete_report_snapshot(cache.snapshot_path)
        await db.commit()
        return True

    record.status = "deleted"
    record.is_public = False
    record.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return True


async def assert_report_share_target_accessible(
    db: AsyncSession,
    user_id: str,
    report_id: str,
) -> None:
    """断言 report_id 不会指向其他用户资源。"""
    shared_result = await db.execute(
        select(SharedReport.id).where(SharedReport.id == report_id)
    )
    shared_id = shared_result.scalar_one_or_none()
    if shared_id:
        own_shared = await db.execute(
            select(SharedReport.id).where(
                SharedReport.id == report_id,
                SharedReport.user_id == user_id,
            )
        )
        if not own_shared.scalar_one_or_none():
            raise ValueError("报表不存在或无权限访问")
        return

    cache_result = await db.execute(
        select(ReportCache.id).where(ReportCache.id == report_id)
    )
    cache_id = cache_result.scalar_one_or_none()
    if cache_id:
        own_cache = await db.execute(
            select(ReportCache.id).where(
                ReportCache.id == report_id,
                ReportCache.user_id == user_id,
                ReportCache.status == "active",
            )
        )
        if not own_cache.scalar_one_or_none():
            raise ValueError("报表不存在或无权限访问")
