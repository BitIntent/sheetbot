# ============================================================================
# 平台级运行参数（platform_settings 表）读写
# ============================================================================
from __future__ import annotations

from typing import Dict, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import PlatformSetting


KEY_AUTO_ANALYZE_MAX_FILE_MB = "auto_analyze_max_file_mb"
KEY_AUTO_ANALYZE_MAX_ROWS = "auto_analyze_max_rows"

DEFAULT_MAX_FILE_MB = 20
DEFAULT_MAX_ROWS = 20000


def _clamp_mb(v: int) -> int:
    return max(1, min(10240, v))


def _clamp_rows(v: int) -> int:
    return max(10000, min(5_000_000, v))


async def seed_platform_defaults(db: AsyncSession) -> None:
    """幂等：缺 key 则插入默认值"""
    defaults = {
        KEY_AUTO_ANALYZE_MAX_FILE_MB: str(DEFAULT_MAX_FILE_MB),
        KEY_AUTO_ANALYZE_MAX_ROWS: str(DEFAULT_MAX_ROWS),
    }
    for k, val in defaults.items():
        row = (await db.execute(select(PlatformSetting).where(PlatformSetting.config_key == k))).scalar_one_or_none()
        if row is None:
            db.add(PlatformSetting(config_key=k, config_value=val))


async def get_auto_analyze_thresholds(db: AsyncSession) -> Tuple[int, int]:
    """返回 (max_file_mb, max_rows)，始终落在合法区间"""
    await seed_platform_defaults(db)
    result = await db.execute(
        select(PlatformSetting).where(
            PlatformSetting.config_key.in_([KEY_AUTO_ANALYZE_MAX_FILE_MB, KEY_AUTO_ANALYZE_MAX_ROWS])
        )
    )
    rows = {r.config_key: r.config_value for r in result.scalars().all()}
    try:
        mb = int(float(rows.get(KEY_AUTO_ANALYZE_MAX_FILE_MB, DEFAULT_MAX_FILE_MB)))
    except (TypeError, ValueError):
        mb = DEFAULT_MAX_FILE_MB
    try:
        rws = int(float(rows.get(KEY_AUTO_ANALYZE_MAX_ROWS, DEFAULT_MAX_ROWS)))
    except (TypeError, ValueError):
        rws = DEFAULT_MAX_ROWS
    return _clamp_mb(mb), _clamp_rows(rws)


async def update_auto_analyze_thresholds(db: AsyncSession, max_file_mb: int, max_rows: int) -> Dict[str, int]:
    mb = _clamp_mb(int(max_file_mb))
    rws = _clamp_rows(int(max_rows))
    for key, val in ((KEY_AUTO_ANALYZE_MAX_FILE_MB, str(mb)), (KEY_AUTO_ANALYZE_MAX_ROWS, str(rws))):
        row = (await db.execute(select(PlatformSetting).where(PlatformSetting.config_key == key))).scalar_one_or_none()
        if row:
            row.config_value = val
        else:
            db.add(PlatformSetting(config_key=key, config_value=val))
    return {"auto_analyze_max_file_mb": mb, "auto_analyze_max_rows": rws}
