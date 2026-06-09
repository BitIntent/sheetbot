# backend/app/files/models.py
"""
文件管理相关数据模型
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, BigInteger, Integer, Boolean, DateTime, ForeignKey, Index, Text
from sqlalchemy.orm import relationship

from ..core.database import Base


def utc_now():
    """返回当前 UTC 时间"""
    return datetime.now(timezone.utc)


class Folder(Base):
    """文件夹表 — 支持嵌套目录"""
    __tablename__ = "folders"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    parent_id = Column(String(36), ForeignKey("folders.id", ondelete="CASCADE"), nullable=True)

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    # 关系
    user = relationship("User", back_populates="folders")
    parent = relationship("Folder", remote_side=[id], backref="children")
    files = relationship("UserFile", back_populates="folder")

    __table_args__ = (
        Index('idx_folder_user', 'user_id'),
        Index('idx_folder_parent', 'parent_id'),
    )


class UserFile(Base):
    """统一文件注册表（核心）"""
    __tablename__ = "user_files"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    # 文件基础信息
    file_name = Column(String(255), nullable=False)
    file_type = Column(String(20), nullable=False, default='upload')  # upload | result | blank
    file_format = Column(String(10), default='xlsx')
    file_size = Column(BigInteger, default=0)
    storage_path = Column(String(500), nullable=False)

    # 目录归属
    folder_id = Column(String(36), ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)

    # 星标收藏
    is_starred = Column(Boolean, default=False)

    # 来源关系（结果文件指向源文件）
    source_file_id = Column(String(36), ForeignKey("user_files.id", ondelete="SET NULL"), nullable=True)

    # 视图偏好（上次打开用的视图）
    last_view = Column(String(20), default='normal')  # normal | analyze

    # 数据摘要（快速展示，无需读文件）
    sheet_names = Column(String(2000), nullable=True)  # JSON stored as string
    row_count = Column(Integer, default=0)
    col_count = Column(Integer, default=0)

    # DuckDB 状态（仅分析模式使用）
    duckdb_ready = Column(Boolean, default=False)

    # 生命周期
    status = Column(String(20), default='active')  # active | archived | deleted
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)
    accessed_at = Column(DateTime, default=utc_now, nullable=False)

    # 关系
    user = relationship("User", back_populates="files")
    folder = relationship("Folder", back_populates="files")
    source_file = relationship("UserFile", remote_side=[id], foreign_keys=[source_file_id])

    # 索引
    __table_args__ = (
        Index('idx_user_status', 'user_id', 'status'),
        Index('idx_folder', 'folder_id'),
        Index('idx_source', 'source_file_id'),
        Index('idx_starred', 'user_id', 'is_starred'),
    )


class SharedReport(Base):
    """报表持久化 + 公开分享"""
    __tablename__ = "shared_reports"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source_file_id = Column(String(36), ForeignKey("user_files.id", ondelete="SET NULL"), nullable=True)
    report_cache_id = Column(String(36), ForeignKey("report_cache.id", ondelete="SET NULL"), nullable=True)

    share_token = Column(String(64), unique=True, index=True, nullable=False)
    title = Column(String(500), nullable=False, default="数据报表")
    template_key = Column(String(50), nullable=False, default="overview")
    report_snapshot_path = Column(String(500), nullable=False)

    is_public = Column(Boolean, default=True)
    view_count = Column(Integer, default=0)
    status = Column(String(20), default="active")

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)
    expires_at = Column(DateTime, nullable=True)

    # 关系
    user = relationship("User", backref="reports")
    source_file = relationship("UserFile", foreign_keys=[source_file_id])
    cache = relationship("ReportCache", back_populates="shared_reports")

    __table_args__ = (
        Index('idx_report_user', 'user_id'),
        Index('idx_report_token', 'share_token'),
        Index('idx_report_status', 'status'),
        Index('idx_report_cache', 'report_cache_id'),
    )


class ReportCache(Base):
    """缓存生成报表的快照，避免重复计算"""
    __tablename__ = "report_cache"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    file_id = Column(String(36), ForeignKey("user_files.id", ondelete="CASCADE"), nullable=False)
    template_key = Column(String(50), nullable=False)
    options_hash = Column(String(1000), nullable=False, default="")
    snapshot_path = Column(String(500), nullable=False)
    status = Column(String(20), default="active")
    expires_at = Column(DateTime, nullable=False)

    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    shared_reports = relationship("SharedReport", back_populates="cache")

    __table_args__ = (
        Index('idx_cache_user', 'user_id'),
        Index('idx_cache_file_template', 'file_id', 'template_key', 'options_hash'),
        Index('idx_cache_status', 'status'),
        Index('idx_cache_expires', 'expires_at'),
    )


class ReportTask(Base):
    """异步报表生成任务"""
    __tablename__ = "report_tasks"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    file_id = Column(String(36), nullable=False)
    template_key = Column(String(50), nullable=False)
    options_json = Column(Text, nullable=True)
    status = Column(String(20), default="pending")  # pending, running, completed, failed, interrupted
    progress = Column(Integer, default=0)
    progress_message = Column(String(255), nullable=True)
    report_cache_id = Column(String(36), nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)
    completed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index('idx_task_user_status', 'user_id', 'status'),
    )


class UserPptx(Base):
    """PPTX 汇报注册表（磁盘 JSON/PPTX 的路径索引，供管理端列表与检索）"""
    __tablename__ = "user_pptx"

    pptx_id = Column(String(64), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(500), nullable=False, default="")
    template_key = Column(String(100), nullable=False, default="")
    source_file_id = Column(String(36), nullable=True)
    meta_rel_path = Column(String(512), nullable=False)
    pptx_rel_path = Column(String(512), nullable=False)
    slide_count = Column(Integer, default=0, nullable=False)
    pptx_size_bytes = Column(BigInteger, default=0, nullable=False)
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        Index("idx_user_pptx_user", "user_id"),
        Index("idx_user_pptx_status", "status"),
        Index("idx_user_pptx_created", "created_at"),
    )


class BatchWordExport(Base):
    """批量转 Word ZIP 导出注册表"""
    __tablename__ = "batch_word_exports"

    task_id = Column(String(64), primary_key=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    template_id = Column(String(64), nullable=True)
    template_file_name = Column(String(500), nullable=False, default="")
    source_file_id = Column(String(36), nullable=True)
    filename_pattern = Column(String(500), nullable=True)
    zip_rel_path = Column(String(512), nullable=False)
    total = Column(Integer, default=0, nullable=False)
    zip_size_bytes = Column(BigInteger, default=0, nullable=False)
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime, default=utc_now, nullable=False)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        Index("idx_bwe_user", "user_id"),
        Index("idx_bwe_status", "status"),
        Index("idx_bwe_created", "created_at"),
    )


class Notification(Base):
    """用户通知"""
    __tablename__ = "notifications"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(50), nullable=False)  # report_completed, report_failed, system
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=True)
    is_read = Column(Boolean, default=False)
    payload = Column(Text, nullable=True)  # JSON: {task_id, report_id, file_name, ...}
    created_at = Column(DateTime, default=utc_now, nullable=False)

    __table_args__ = (
        Index('idx_notif_user_read', 'user_id', 'is_read'),
        Index('idx_notif_created', 'created_at'),
    )
