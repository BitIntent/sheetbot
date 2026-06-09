# backend/app/auth/models.py
"""
用户认证相关数据模型
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import relationship

from ..core.database import Base


def utc_now():
    """返回当前 UTC 时间"""
    return datetime.now(timezone.utc)


class User(Base):
    """用户表"""
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = Column(String(50), nullable=False, unique=True, index=True)
    email = Column(String(255), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=False)
    display_name = Column(String(100), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # 关系
    refresh_tokens = relationship("RefreshToken", back_populates="user", cascade="all, delete-orphan")
    password_reset_tokens = relationship("PasswordResetToken", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")
    files = relationship("UserFile", back_populates="user", cascade="all, delete-orphan")
    folders = relationship("Folder", back_populates="user", cascade="all, delete-orphan")


class RefreshToken(Base):
    """Refresh Token 表（支持吊销、多设备）"""
    __tablename__ = "refresh_tokens"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(255), nullable=False, unique=True)
    device_info = Column(String(255), nullable=True)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    # 关系
    user = relationship("User", back_populates="refresh_tokens")

    # 索引
    __table_args__ = (
        Index('idx_user_id', 'user_id'),
        Index('idx_expires', 'expires_at'),
    )


class PasswordResetToken(Base):
    """密码重置 Token 表"""
    __tablename__ = "password_reset_tokens"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(128), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)

    user = relationship("User", back_populates="password_reset_tokens")


class UserSession(Base):
    """用户会话表（关联 SSE 会话与用户）"""
    __tablename__ = "user_sessions"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String(100), nullable=False, unique=True, index=True)
    platform_view = Column(String(20), default='normal')
    current_file_id = Column(String(36), ForeignKey("user_files.id", ondelete="SET NULL"), nullable=True)
    last_active_at = Column(DateTime, default=utc_now, nullable=False)
    session_metadata = Column(String(2000), nullable=True)  # JSON stored as string

    # 关系
    user = relationship("User", back_populates="sessions")
    current_file = relationship("UserFile", foreign_keys=[current_file_id])

    # 索引
    __table_args__ = (
        Index('idx_user_id', 'user_id'),
        Index('idx_session', 'session_id'),
    )
