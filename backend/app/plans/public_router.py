"""套餐公开 API：供 landing 页动态刷新定价与配额说明"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import SubscriptionPlan
from ..core.database import get_db
from .plan_presentation import PUBLIC_PLAN_CODES, build_public_plan

router = APIRouter(prefix="/api/public/plans", tags=["public-plans"])


@router.get("")
async def list_public_plans(db: AsyncSession = Depends(get_db)):
    """
    返回前台展示的套餐列表（价格单位：元；配额与后台 subscription_plans 一致）。
    landing 页加载后调用此接口刷新静态占位内容。
    """
    rows = (await db.execute(
        select(SubscriptionPlan)
        .where(SubscriptionPlan.is_active.is_(True))
        .where(SubscriptionPlan.code.in_(PUBLIC_PLAN_CODES))
        .order_by(SubscriptionPlan.sort_order)
    )).scalars().all()

    plans = []
    for row in rows:
        card = build_public_plan(row)
        if card:
            plans.append(card)

    # 固定顺序：与 landing 四列布局一致
    order = {code: i for i, code in enumerate(PUBLIC_PLAN_CODES)}
    plans.sort(key=lambda p: order.get(p["code"], 99))
    return {"plans": plans}
