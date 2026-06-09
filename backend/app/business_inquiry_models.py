"""
商务咨询数据模型。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, String, Text

from .core.database import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class BusinessInquiry(Base):
    """官网商务咨询记录。"""

    __tablename__ = "business_inquiries"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    product = Column(String(32), nullable=False, index=True, default="sheetbot")
    company_name = Column(String(255), nullable=False, default="")
    contact_name = Column(String(100), nullable=False, default="")
    phone = Column(String(64), nullable=False, default="")
    email = Column(String(255), nullable=True)
    message = Column(Text, nullable=False, default="")
    source_page = Column(String(128), nullable=False, default="site_contact")
    status = Column(String(20), nullable=False, default="pending", index=True)
    admin_note = Column(Text, nullable=True)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=_utc_now, nullable=False, index=True)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)
