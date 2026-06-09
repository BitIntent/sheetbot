# ============================================================================
# 系统配置 - 用户偏好模型
# user_preferences: 时区、语言、通知偏好等
# ============================================================================
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from sqlalchemy import Column, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from ..core.database import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class UserPreferences(Base):
    """用户偏好表"""

    __tablename__ = "user_preferences"

    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    timezone = Column(String(50), nullable=False, default="Asia/Shanghai")
    language = Column(String(20), nullable=False, default="zh-CN")
    notification_prefs = Column(Text, nullable=False, default="{}")

    created_at = Column(DateTime, default=_utc_now, nullable=False)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)

    def get_notification_prefs(self) -> Dict[str, Any]:
        """解析 notification_prefs JSON"""
        if not self.notification_prefs:
            return {}
        try:
            return json.loads(self.notification_prefs)
        except (json.JSONDecodeError, TypeError):
            return {}

    def set_notification_prefs(self, data: Dict[str, Any]) -> None:
        """设置 notification_prefs JSON"""
        self.notification_prefs = json.dumps(data or {})


class PlatformSetting(Base):
    """
    全平台运行参数（KV，与管理后台「系统配置」同步）
    主系统与管理后台共用同一 MySQL 表。
    """

    __tablename__ = "platform_settings"

    config_key = Column(String(64), primary_key=True, nullable=False)
    config_value = Column(String(512), nullable=False)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)
