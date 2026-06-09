# backend/app/core/usage_service.py
"""
用量追踪：查询当前使用量 + 按日 upsert 递增
usage_records 表按 (user_id, record_date) 组织，每日一行
"""
import uuid as _uuid
from datetime import date, datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# 允许递增的列白名单（防 SQL 注入）
_COUNTER_COLUMNS = (
    "ai_count", "report_count", "ppt_count",
    "batch_word_count", "large_file_count", "form_submit_count",
)


# ==================== 查询 ====================

async def get_daily_count(user_id: str, column: str, db: AsyncSession) -> int:
    """当日某列的值"""
    today = date.today().isoformat()
    r = await db.execute(
        text(f"SELECT {column} FROM usage_records WHERE user_id=:uid AND record_date=:d"),
        {"uid": user_id, "d": today},
    )
    row = r.mappings().first()
    return row[column] if row else 0


async def get_monthly_sum(user_id: str, column: str, db: AsyncSession) -> int:
    """当月（自然月）某列的累计值"""
    first_day = date.today().replace(day=1).isoformat()
    r = await db.execute(
        text(f"SELECT COALESCE(SUM({column}),0) FROM usage_records "
             "WHERE user_id=:uid AND record_date>=:d"),
        {"uid": user_id, "d": first_day},
    )
    return int(r.scalar() or 0)


async def count_rows(user_id: str, table: str, db: AsyncSession,
                     condition: str = "1=1") -> int:
    """COUNT(*) 活跃资源数（表单、连接器、公式等库存型配额）"""
    r = await db.execute(
        text(f"SELECT COUNT(*) FROM {table} WHERE user_id=:uid AND ({condition})"),
        {"uid": user_id},
    )
    return int(r.scalar() or 0)


async def get_storage_mb(user_id: str, db: AsyncSession) -> float:
    """用户所有活跃文件的存储占用（MB）"""
    r = await db.execute(
        text("SELECT COALESCE(SUM(file_size),0)/1048576.0 "
             "FROM user_files WHERE user_id=:uid AND status='active'"),
        {"uid": user_id},
    )
    return round(float(r.scalar() or 0), 2)


# ==================== 递增（按日 upsert） ====================

async def increment_usage(user_id: str, column: str, db: AsyncSession,
                          delta: int = 1) -> None:
    """对 usage_records 今日行做 UPDATE，若无行则 INSERT"""
    if column not in _COUNTER_COLUMNS:
        return
    today = date.today().isoformat()
    r = await db.execute(
        text(f"UPDATE usage_records SET {column}={column}+:d "
             "WHERE user_id=:uid AND record_date=:dt"),
        {"uid": user_id, "d": delta, "dt": today},
    )
    if r.rowcount == 0:
        cols_csv = ", ".join(_COUNTER_COLUMNS)
        vals_csv = ", ".join(
            str(delta) if c == column else "0" for c in _COUNTER_COLUMNS
        )
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        await db.execute(
            text(
                f"INSERT INTO usage_records "
                f"(id, user_id, record_date, {cols_csv}, storage_mb_used, created_at) "
                f"VALUES (:id, :uid, :dt, {vals_csv}, 0, :created_at)"
            ),
            {
                "id": str(_uuid.uuid4()),
                "uid": user_id,
                "dt": today,
                "created_at": now,
            },
        )
    await db.commit()
