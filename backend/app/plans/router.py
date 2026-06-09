# backend/app/plans/router.py
"""套餐只读 API（不含支付）"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.database import get_db
from ..core.dependencies import get_current_user

router = APIRouter(prefix="/api/plans", tags=["plans"])


@router.get("/my")
async def my_subscription(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户的有效套餐与到期时间（只读）。"""
    row = (await db.execute(
        text("""
            SELECT sp.code, sp.name, us.expires_at
            FROM user_subscriptions us
            JOIN subscription_plans sp ON sp.code = us.plan_code
            WHERE us.user_id = :uid AND us.status = 'active'
              AND (us.expires_at IS NULL OR us.expires_at > NOW())
            LIMIT 1
        """),
        {"uid": user.id},
    )).mappings().first()
    if not row:
        return {"plan_code": "free", "plan_name": "免费版", "expires_at": None}
    return {
        "plan_code": row["code"],
        "plan_name": row["name"],
        "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
    }
