# ============================================================================
# 外部系统连接器 - 数据模型
# connectors: 连接器配置  |  sync_jobs: 同步执行记录
# ============================================================================
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column, String, Text, Integer, DateTime, ForeignKey,
)
from sqlalchemy.orm import relationship

from ..core.database import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ── 连接器类型常量 ──────────────────────────────────────────
CONNECTOR_TYPES = (
    "shopify", "dingtalk", "wecom",
    "database", "webhook", "custom_api",
)

CONNECTOR_STATUSES = ("active", "paused", "error")
SYNC_STATUSES = ("running", "success", "error")


class Connector(Base):
    """外部系统连接器配置"""
    __tablename__ = "connectors"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    file_id = Column(String(36), ForeignKey("user_files.id", ondelete="SET NULL"), nullable=True)

    sheet_name = Column(String(255), nullable=True)
    name = Column(String(500), nullable=False, default="")
    type = Column(String(30), nullable=False)

    # JSON: 类型特定配置（API Key / OAuth / 数据库连接串等）
    config = Column(Text, nullable=False, default="{}")
    # JSON: 外部字段 -> Excel 列的映射
    field_mapping = Column(Text, nullable=False, default="{}")

    sync_interval = Column(Integer, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="paused")

    last_sync_at = Column(DateTime, nullable=True)
    last_sync_status = Column(String(20), nullable=True)
    last_sync_message = Column(Text, nullable=True)

    created_at = Column(DateTime, default=_utc_now, nullable=False)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)

    jobs = relationship(
        "SyncJob", back_populates="connector",
        cascade="all, delete-orphan", lazy="dynamic",
    )


class SyncJob(Base):
    """同步执行记录"""
    __tablename__ = "sync_jobs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    connector_id = Column(String(36), ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False, index=True)

    status = Column(String(20), nullable=False, default="running")
    rows_synced = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)

    started_at = Column(DateTime, default=_utc_now, nullable=False)
    completed_at = Column(DateTime, nullable=True)

    connector = relationship("Connector", back_populates="jobs")
