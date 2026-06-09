# ============================================================================
# 表单收集 - 数据模型
# forms: 表单定义  |  form_submissions: 提交记录
# ============================================================================
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column, String, Text, Boolean, Integer, DateTime, ForeignKey,
)
from sqlalchemy.orm import relationship

from ..core.database import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Form(Base):
    """表单定义"""
    __tablename__ = "forms"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    file_id = Column(String(36), ForeignKey("user_files.id", ondelete="SET NULL"), nullable=True)

    sheet_name = Column(String(255), nullable=True)
    title = Column(String(500), nullable=False, default="")
    description = Column(Text, nullable=True)
    share_token = Column(String(64), unique=True, nullable=False, index=True,
                         default=lambda: uuid.uuid4().hex)

    # JSON 序列化的字段配置 {"fields": [...]}
    form_config = Column(Text, nullable=False, default="{}")

    status = Column(String(20), nullable=False, default="draft")  # draft | active | closed
    max_submissions = Column(Integer, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    submission_count = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=_utc_now, nullable=False)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)

    submissions = relationship(
        "FormSubmission", back_populates="form",
        cascade="all, delete-orphan", lazy="dynamic",
    )


class FormSubmission(Base):
    """表单提交记录"""
    __tablename__ = "form_submissions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    form_id = Column(String(36), ForeignKey("forms.id", ondelete="CASCADE"), nullable=False, index=True)

    # JSON 键值对 {"col_1": "张三", "col_2": "13800138000"}
    data = Column(Text, nullable=False, default="{}")

    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(500), nullable=True)
    synced = Column(Boolean, nullable=False, default=False)

    submitted_at = Column(DateTime, default=_utc_now, nullable=False)

    form = relationship("Form", back_populates="submissions")
