# backend/app/plans/seed.py
"""
默认套餐种子数据（启动时幂等写入）
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import SubscriptionPlan

CORE_PLAN_CODES = frozenset({"free", "pro", "premium", "enterprise"})
DEPRECATED_PLAN_CODES = frozenset({"starter"})

DEFAULT_QUOTAS = {
    "free": {
        "storage_mb": 100, "file_size_mb": 10, "ai_daily": 20,
        "report_monthly": 3, "ppt_monthly": 1, "batch_word_monthly": 0,
        "form_count": 1, "form_submissions": 50, "connector_count": 0,
        "formula_count": 5, "large_file_rows": 0,
    },
    "pro": {
        "storage_mb": 5120, "file_size_mb": 100, "ai_daily": 200,
        "report_monthly": -1, "ppt_monthly": -1, "batch_word_monthly": 20,
        "form_count": 10, "form_submissions": 500, "connector_count": 3,
        "formula_count": 50, "large_file_rows": -1,
    },
    "premium": {
        "storage_mb": 51200, "file_size_mb": 500, "ai_daily": -1,
        "report_monthly": -1, "ppt_monthly": -1, "batch_word_monthly": -1,
        "form_count": -1, "form_submissions": -1, "connector_count": -1,
        "formula_count": -1, "large_file_rows": -1,
    },
    "enterprise": {
        "storage_mb": -1, "file_size_mb": -1, "ai_daily": -1,
        "report_monthly": -1, "ppt_monthly": -1, "batch_word_monthly": -1,
        "form_count": -1, "form_submissions": -1, "connector_count": -1,
        "formula_count": -1, "large_file_rows": -1,
    },
}

DEFAULT_PLANS = [
    {"code": "free", "name": "免费版", "price_monthly": 0, "price_yearly": 0, "sort_order": 1},
    {"code": "pro", "name": "专业版", "price_monthly": 2900, "price_yearly": 28800, "sort_order": 2},
    {"code": "premium", "name": "尊享版", "price_monthly": 7900, "price_yearly": 78800, "sort_order": 3},
    {"code": "enterprise", "name": "企业私有化部署", "price_monthly": 0, "price_yearly": 0, "sort_order": 4},
]


async def seed_default_plans(db: AsyncSession) -> None:
    """启动时幂等写入默认套餐"""
    for plan_def in DEFAULT_PLANS:
        exists = (await db.execute(
            select(SubscriptionPlan).where(SubscriptionPlan.code == plan_def["code"])
        )).scalar_one_or_none()
        if not exists:
            db.add(SubscriptionPlan(
                **plan_def,
                quota_json=json.dumps(DEFAULT_QUOTAS.get(plan_def["code"], {}), ensure_ascii=False),
            ))
        else:
            default_keys = DEFAULT_QUOTAS.get(plan_def["code"], {})
            try:
                current_quota = json.loads(exists.quota_json or "{}")
            except Exception:
                current_quota = {}
            missing = {k: v for k, v in default_keys.items() if k not in current_quota}
            if missing:
                current_quota.update(missing)
                exists.quota_json = json.dumps(current_quota, ensure_ascii=False)
    await _cleanup_deprecated_plans(db)
    await db.commit()


async def _cleanup_deprecated_plans(db: AsyncSession) -> None:
    """废弃套餐：用户迁回 free 后删除记录"""
    for code in DEPRECATED_PLAN_CODES:
        plan = (await db.execute(
            select(SubscriptionPlan).where(SubscriptionPlan.code == code)
        )).scalar_one_or_none()
        if not plan:
            continue
        await db.execute(
            text("""
                UPDATE user_subscriptions
                SET plan_code = 'free', updated_at = :now
                WHERE plan_code = :code
            """),
            {"code": code, "now": datetime.now(timezone.utc)},
        )
        await db.delete(plan)
