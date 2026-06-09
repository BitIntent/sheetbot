# backend/app/notification/router.py
"""
通知系统 API 路由 — CRUD + SSE 实时推送
"""
import asyncio
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select, text, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.dependencies import get_current_user
from ..core.database import get_db
from ..files.models import Notification
from ..report.task_manager import get_notification_queue, remove_notification_queue
from ..utils.logger import get_logger

logger = get_logger("notification")

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """分页获取通知列表"""
    offset = (page - 1) * page_size
    result = await db.execute(
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    notifications = result.scalars().all()

    count_result = await db.execute(
        select(func.count()).select_from(Notification).where(Notification.user_id == user.id)
    )
    total = count_result.scalar() or 0

    return {
        "notifications": [
            _serialize_notification(n) for n in notifications
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/unread-count")
async def get_unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取未读通知数量"""
    result = await db.execute(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == user.id, Notification.is_read == False)
    )
    count = result.scalar() or 0
    return {"unread_count": count}


@router.put("/{notification_id}/read")
async def mark_as_read(
    notification_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """标记单条通知为已读"""
    result = await db.execute(
        update(Notification)
        .where(Notification.id == notification_id, Notification.user_id == user.id)
        .values(is_read=True)
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="通知不存在")
    return {"ok": True}


@router.put("/read-all")
async def mark_all_as_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """全部标记已读"""
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.is_read == False)
        .values(is_read=True)
    )
    await db.commit()
    return {"ok": True}


@router.delete("/{notification_id}")
async def delete_notification(
    notification_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除单条通知"""
    result = await db.execute(
        delete(Notification)
        .where(Notification.id == notification_id, Notification.user_id == user.id)
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="通知不存在")
    return {"ok": True}


@router.get("/stream")
async def notification_stream(
    token: str = Query(..., description="JWT access token"),
    db: AsyncSession = Depends(get_db),
):
    """SSE 长连接，实时推送新通知（通过 query param 传 token，因为 EventSource 不支持自定义 header）"""
    from ..core.security import verify_token as _verify_token

    payload = _verify_token(token, token_type="access")
    if not payload or not payload.get("sub"):
        raise HTTPException(status_code=401, detail="无效 token")
    user_id = payload["sub"]

    result = await db.execute(
        select(Notification.user_id).where(Notification.user_id == user_id).limit(1)
    )
    # 只需确认 user_id 合法即可（无需完整 user 对象）

    async def event_generator():
        queue = get_notification_queue(user_id)
        try:
            yield f"data: {json.dumps({'event': 'connected', 'message': 'SSE 连接已建立'}, ensure_ascii=False)}\n\n"

            while True:
                try:
                    notification = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {json.dumps({'event': 'notification', 'data': notification}, ensure_ascii=False, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'event': 'heartbeat'}, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            remove_notification_queue(user_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ==================== 系统公告（读 system_announcements） ====================

@router.get("/announcements")
async def get_announcements(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户可见的活跃系统公告"""
    plan_row = await db.execute(
        text("SELECT plan_code FROM user_subscriptions "
             "WHERE user_id=:uid AND status='active'"),
        {"uid": user.id},
    )
    plan_code = plan_row.scalar() or "free"

    now = datetime.now(timezone.utc)
    rows = (await db.execute(
        text("""
            SELECT id, title, content, type, target, publish_at, expire_at
            FROM system_announcements
            WHERE is_active=1 AND publish_at <= :now
              AND (expire_at IS NULL OR expire_at > :now)
            ORDER BY publish_at DESC LIMIT 10
        """),
        {"now": now},
    )).mappings().all()

    result = []
    for r in rows:
        target = r["target"]
        if target == "all":
            result.append(dict(r))
        elif target.startswith("plan:") and plan_code == target.split(":", 1)[1]:
            result.append(dict(r))
        elif target.startswith("user:") and user.id == target.split(":", 1)[1]:
            result.append(dict(r))
    return result


def _serialize_notification(n: Notification) -> dict:
    payload = None
    if n.payload:
        try:
            payload = json.loads(n.payload)
        except Exception:
            payload = n.payload

    return {
        "id": n.id,
        "type": n.type,
        "title": n.title,
        "message": n.message,
        "is_read": n.is_read,
        "payload": payload,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }
