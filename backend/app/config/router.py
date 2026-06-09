# ============================================================================
# 系统配置 - 用户偏好 API
# GET/PUT /api/config/preferences
# ============================================================================
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.database import get_db
from ..core.dependencies import get_current_user
from . import service
from .platform_runtime import get_auto_analyze_thresholds
from .schemas import PlatformPublicResponse, UserPreferencesResponse, UserPreferencesUpdate

router = APIRouter(prefix="/api/config", tags=["config"])


@router.get("/platform", response_model=PlatformPublicResponse)
async def get_platform_config(db: AsyncSession = Depends(get_db)):
    """
    大文件/分析视图自动分流阈值（由 platform_settings 表维护）。
    公开接口，供主站前端启动时拉取；未落库时由服务层写入默认种子。
    """
    mb, rows = await get_auto_analyze_thresholds(db)
    return PlatformPublicResponse(auto_analyze_max_file_mb=mb, auto_analyze_max_rows=rows)


@router.get("/preferences", response_model=UserPreferencesResponse)
async def get_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户偏好"""
    prefs = await service.get_preferences(db, user.id)
    return UserPreferencesResponse(
        timezone=prefs.timezone,
        language=prefs.language,
        sheet_theme=service.extract_sheet_theme(prefs.get_notification_prefs()),
        notification_prefs=prefs.get_notification_prefs(),
    )


@router.put("/preferences", response_model=UserPreferencesResponse)
async def update_preferences(
    body: UserPreferencesUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新当前用户偏好"""
    prefs = await service.update_preferences(
        db,
        user.id,
        timezone=body.timezone,
        language=body.language,
        sheet_theme=body.sheet_theme,
        notification_prefs=body.notification_prefs,
    )
    await db.commit()
    return UserPreferencesResponse(
        timezone=prefs.timezone,
        language=prefs.language,
        sheet_theme=service.extract_sheet_theme(prefs.get_notification_prefs()),
        notification_prefs=prefs.get_notification_prefs(),
    )
