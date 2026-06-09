# ============================================================================
# 系统配置 - 用户偏好 CRUD
# ============================================================================
from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import UserPreferences


DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_LANGUAGE = "zh-CN"
DEFAULT_SHEET_THEME = "sheetbot-dark"
DEFAULT_NOTIFICATION_PREFS = {
    "sync": True,
    "report": True,
    "collect": True,
    "sheet_theme": DEFAULT_SHEET_THEME,
}
VALID_SHEET_THEMES = {
    "sheetbot-dark",
    "excel-classic",
    "glacier-blue",
    "mint-contrast",
    "oled-night",
}


def extract_sheet_theme(notification_prefs: Dict[str, Any]) -> str:
    """从通知偏好中提取表格主题，带合法性校验。"""
    theme = str((notification_prefs or {}).get("sheet_theme") or DEFAULT_SHEET_THEME)
    if theme not in VALID_SHEET_THEMES:
        return DEFAULT_SHEET_THEME
    return theme


async def get_preferences(db: AsyncSession, user_id: str) -> UserPreferences:
    """获取或创建用户偏好（不存在则创建默认）"""
    result = await db.execute(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    )
    prefs = result.scalar_one_or_none()
    if prefs:
        return prefs

    prefs = UserPreferences(
        user_id=user_id,
        timezone=DEFAULT_TIMEZONE,
        language=DEFAULT_LANGUAGE,
    )
    prefs.set_notification_prefs(DEFAULT_NOTIFICATION_PREFS)
    db.add(prefs)
    await db.flush()
    return prefs


async def update_preferences(
    db: AsyncSession,
    user_id: str,
    *,
    timezone: Optional[str] = None,
    language: Optional[str] = None,
    sheet_theme: Optional[str] = None,
    notification_prefs: Optional[Dict[str, Any]] = None,
) -> UserPreferences:
    """更新用户偏好"""
    prefs = await get_preferences(db, user_id)
    if timezone is not None:
        prefs.timezone = timezone
    if language is not None:
        prefs.language = language
    if notification_prefs is not None:
        merged = prefs.get_notification_prefs()
        merged.update(notification_prefs)
        if "sheet_theme" not in merged:
            merged["sheet_theme"] = DEFAULT_SHEET_THEME
        prefs.set_notification_prefs(merged)
    if sheet_theme is not None:
        merged = prefs.get_notification_prefs()
        merged["sheet_theme"] = (
            sheet_theme if sheet_theme in VALID_SHEET_THEMES else DEFAULT_SHEET_THEME
        )
        prefs.set_notification_prefs(merged)
    await db.flush()
    return prefs
