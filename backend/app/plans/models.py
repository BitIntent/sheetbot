# backend/app/plans/models.py
"""
套餐与订阅相关 ORM 模型（开源版：不含管理后台专属表）
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, String, Text,
)
from sqlalchemy.orm import relationship

from ..core.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class SubscriptionPlan(Base):
    """套餐定义"""

    __tablename__ = "subscription_plans"

    id = Column(String(36), primary_key=True, default=_uuid)
    code = Column(String(30), unique=True, nullable=False, index=True)
    name = Column(String(100), nullable=False)
    price_monthly = Column(Integer, default=0, nullable=False, comment="分（人民币 × 100）")
    price_yearly = Column(Integer, default=0, nullable=False, comment="分（人民币 × 100）")
    quota_json = Column(Text, nullable=False, default="{}")
    is_active = Column(Boolean, default=True, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=_now, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)

    subscriptions = relationship("UserSubscription", back_populates="plan", lazy="noload")


class UserSubscription(Base):
    """用户套餐绑定"""

    __tablename__ = "user_subscriptions"

    id = Column(String(36), primary_key=True, default=_uuid)
    user_id = Column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"),
        unique=True, nullable=False, index=True,
    )
    plan_code = Column(
        String(30), ForeignKey("subscription_plans.code", ondelete="RESTRICT"),
        nullable=False, default="free",
    )
    status = Column(String(20), nullable=False, default="active")
    started_at = Column(DateTime, default=_now, nullable=False)
    expires_at = Column(DateTime, nullable=True)
    granted_by = Column(String(36), nullable=True)
    notes = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=_now, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)

    plan = relationship("SubscriptionPlan", back_populates="subscriptions", lazy="noload")


class UsageRecord(Base):
    """每日用量快照"""

    __tablename__ = "usage_records"

    id = Column(String(36), primary_key=True, default=_uuid)
    user_id = Column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    record_date = Column(String(10), nullable=False, index=True, comment="YYYY-MM-DD")
    ai_count = Column(Integer, default=0, nullable=False)
    report_count = Column(Integer, default=0, nullable=False)
    ppt_count = Column(Integer, default=0, nullable=False)
    batch_word_count = Column(Integer, default=0, nullable=False)
    large_file_count = Column(Integer, default=0, nullable=False)
    form_submit_count = Column(Integer, default=0, nullable=False)
    storage_mb_used = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=_now, nullable=False)


class SystemAnnouncement(Base):
    """系统公告"""

    __tablename__ = "system_announcements"

    id = Column(String(36), primary_key=True, default=_uuid)
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=False)
    type = Column(String(20), nullable=False, default="info")
    target = Column(String(100), nullable=False, default="all")
    is_active = Column(Boolean, default=True, nullable=False)
    publish_at = Column(DateTime, default=_now, nullable=False)
    expire_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now, nullable=False)
