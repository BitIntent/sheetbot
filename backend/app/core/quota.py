# backend/app/core/quota.py
"""
套餐配额检查依赖

配额规则唯一真源：数据库 subscription_plans.quota_json（管理后台配置）
本模块仅做「读取 + 比较 + 拦截」，不定义任何套餐规则。

-1 = 无限制, 0 = 功能禁用, >0 = 上限
"""
import json
import time

from fastapi import Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .database import get_db
from .dependencies import get_optional_user
from .usage_service import (
    get_daily_count, get_monthly_sum, count_rows, get_storage_mb,
)

# ==================== 功能元数据（系统内置，非套餐规则） ====================

_KEY_LABELS = {
    "ai_daily": "AI 对话",
    "report_monthly": "报表生成",
    "ppt_monthly": "PPT 汇报",
    "batch_word_monthly": "批量转 Word",
    "form_count": "在线表单",
    "connector_count": "外部连接器",
    "formula_count": "自定义公式",
    "storage_mb": "云存储空间",
    "large_file_rows": "大文件分析",
    "file_size_mb": "单文件大小",
    "form_submissions": "表单提交",
}

_KEY_PERIOD = {
    "ai_daily": "今日",
    "report_monthly": "本月",
    "ppt_monthly": "本月",
    "batch_word_monthly": "本月",
    "form_submissions": "本月",
}

_KEY_UNIT = {
    "ai_daily": "次",
    "report_monthly": "次",
    "ppt_monthly": "次",
    "batch_word_monthly": "次",
    "form_count": "个",
    "connector_count": "个",
    "formula_count": "个",
    "storage_mb": "MB",
    "large_file_rows": "行",
    "file_size_mb": "MB",
    "form_submissions": "条",
}

# 月度累计型配额 -> usage_records 列名
_MONTHLY_COL = {
    "report_monthly": "report_count",
    "ppt_monthly": "ppt_count",
    "batch_word_monthly": "batch_word_count",
    "form_submissions": "form_submit_count",
}

# 库存计数型配额 -> (表名, 过滤条件)
_INVENTORY = {
    "form_count": ("forms", "status IN ('active','published')"),
    "connector_count": ("connectors", "1=1"),
    "formula_count": ("custom_formulas", "1=1"),
}


# ==================== 默认套餐缓存（从 DB 读取，带 TTL） ====================

_default_plan_cache: dict = {"quota": None, "name": None, "ts": 0}
# 30 秒兜底缓存：对于无 user_subscriptions 的边缘场景（如旧存量用户）
# 管理后台改配额后最多 30 秒内全局生效
_CACHE_TTL_SEC = 30


async def _load_default_plan(db: AsyncSession) -> tuple[dict, str]:
    """
    从 subscription_plans 表读取默认套餐（code='free'）。
    带 5 分钟内存缓存，避免每次请求都查 DB。
    """
    now = time.monotonic()
    if _default_plan_cache["quota"] is not None and (now - _default_plan_cache["ts"]) < _CACHE_TTL_SEC:
        return _default_plan_cache["quota"], _default_plan_cache["name"]

    row = (await db.execute(
        text("""
            SELECT quota_json, name
            FROM subscription_plans
            WHERE code = 'free' AND is_active = 1
            LIMIT 1
        """),
    )).mappings().first()

    if row:
        try:
            quota = json.loads(row["quota_json"])
        except Exception:
            quota = {}
        name = row["name"] or "免费版"
    else:
        quota, name = {}, "免费版"

    _default_plan_cache["quota"] = quota
    _default_plan_cache["name"] = name
    _default_plan_cache["ts"] = now
    return quota, name


# ==================== 查询套餐信息 ====================

async def get_user_quota(user_id: str, db: AsyncSession) -> dict:
    """返回用户当前套餐的配额字典（唯一真源：数据库）"""
    row = await db.execute(
        text("""
            SELECT sp.quota_json
            FROM user_subscriptions us
            JOIN subscription_plans sp ON sp.code = us.plan_code
            WHERE us.user_id = :uid AND us.status = 'active'
              AND (us.expires_at IS NULL OR us.expires_at > NOW())
        """),
        {"uid": user_id},
    )
    r = row.mappings().first()
    if r:
        try:
            return json.loads(r["quota_json"])
        except Exception:
            pass
    # 无有效订阅 → 读取数据库中的默认套餐
    default_quota, _ = await _load_default_plan(db)
    return default_quota.copy() if default_quota else {}


async def get_user_plan_name(user_id: str, db: AsyncSession) -> str:
    """返回用户当前套餐的显示名称（唯一真源：数据库）"""
    row = await db.execute(
        text("""
            SELECT sp.name
            FROM user_subscriptions us
            JOIN subscription_plans sp ON sp.code = us.plan_code
            WHERE us.user_id = :uid AND us.status = 'active'
              AND (us.expires_at IS NULL OR us.expires_at > NOW())
        """),
        {"uid": user_id},
    )
    r = row.mappings().first()
    if r:
        return r["name"]
    _, default_name = await _load_default_plan(db)
    return default_name


# ==================== QuotaGuard 依赖工厂 ====================

class QuotaGuard:
    """
    FastAPI 依赖工厂，套餐无关——仅做通用「读取配额值 → 比较 → 拦截」。

        @router.post("/generate")
        async def gen(_quota=Depends(QuotaGuard("report_monthly")), ...):
    """

    def __init__(self, quota_key: str):
        self.quota_key = quota_key

    async def __call__(
        self,
        db: AsyncSession = Depends(get_db),
        user_id: str = Depends(get_optional_user),
    ):
        if not user_id:
            raise HTTPException(401, detail={
                "code": "auth_required",
                "message": "请先登录",
            })

        quotas = await get_user_quota(user_id, db)
        plan_name = await get_user_plan_name(user_id, db)
        limit = quotas.get(self.quota_key)
        feature = _KEY_LABELS.get(self.quota_key, self.quota_key)
        unit = _KEY_UNIT.get(self.quota_key, "")

        # 未配置或 -1 = 不限制
        if limit is None or limit == -1:
            return
        # 0 = 功能禁用
        if limit == 0:
            raise HTTPException(403, detail={
                "code": "feature_disabled",
                "key": self.quota_key,
                "feature": feature,
                "plan_name": plan_name,
                "message": f"您当前为「{plan_name}」，未开通「{feature}」功能，请升级套餐后使用。",
            })

        current = await self._resolve_current(user_id, db)
        if current >= limit:
            period = _KEY_PERIOD.get(self.quota_key, "")
            raise HTTPException(429, detail={
                "code": "quota_exceeded",
                "key": self.quota_key,
                "feature": feature,
                "plan_name": plan_name,
                "limit": limit,
                "current": current,
                "unit": unit,
                "message": (
                    f"您当前为「{plan_name}」，"
                    f"「{feature}」{period}配额为 {limit}{unit}，"
                    f"已使用 {current}{unit}，"
                    f"暂时无法继续使用。请升级套餐以获得更多额度。"
                ),
            })

    async def _resolve_current(self, uid: str, db: AsyncSession) -> int | float:
        k = self.quota_key
        if k == "ai_daily":
            return await get_daily_count(uid, "ai_count", db)
        if k in _MONTHLY_COL:
            return await get_monthly_sum(uid, _MONTHLY_COL[k], db)
        if k in _INVENTORY:
            tbl, cond = _INVENTORY[k]
            return await count_rows(uid, tbl, db, cond)
        if k == "storage_mb":
            return await get_storage_mb(uid, db)
        # large_file_rows / file_size_mb 等非消耗型配额：
        # limit=0 由上层 feature_disabled 拦截，limit>0 视为功能开放（门禁语义）
        return 0
