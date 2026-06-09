# ============================================================================
# 外部系统连接器 - Pydantic 请求/响应模型
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── 连接器 CRUD ─────────────────────────────────────────────
class ConnectorCreateRequest(BaseModel):
    """创建连接器"""
    name: str = Field(..., min_length=1, max_length=500)
    type: str = Field(..., pattern="^(shopify|dingtalk|wecom|database|webhook|custom_api)$")
    config: Dict[str, Any] = Field(default_factory=dict)
    field_mapping: Dict[str, str] = Field(default_factory=dict)
    file_id: Optional[str] = None
    sheet_name: Optional[str] = None
    sync_interval: int = Field(default=0, ge=0, description="同步频率(分钟), 0=仅手动")


class ConnectorUpdateRequest(BaseModel):
    """更新连接器配置"""
    name: Optional[str] = Field(default=None, max_length=500)
    config: Optional[Dict[str, Any]] = None
    field_mapping: Optional[Dict[str, str]] = None
    file_id: Optional[str] = None
    sheet_name: Optional[str] = None
    sync_interval: Optional[int] = Field(default=None, ge=0)


class ConnectorStatusRequest(BaseModel):
    """切换连接器状态"""
    status: str = Field(..., pattern="^(active|paused)$")


class ConnectorResponse(BaseModel):
    """连接器详情"""
    id: str
    name: str
    type: str
    config: Dict[str, Any] = Field(default_factory=dict)
    field_mapping: Dict[str, str] = Field(default_factory=dict)
    file_id: Optional[str] = None
    sheet_name: Optional[str] = None
    sync_interval: int = 0
    status: str
    last_sync_at: Optional[datetime] = None
    last_sync_status: Optional[str] = None
    last_sync_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ConnectorListResponse(BaseModel):
    """连接器列表"""
    total: int
    items: List[ConnectorResponse]


# ── 测试连接 ────────────────────────────────────────────────
class TestConnectionRequest(BaseModel):
    """测试连接（不保存，仅验证配置可达）"""
    type: str = Field(..., pattern="^(shopify|dingtalk|wecom|database|webhook|custom_api)$")
    config: Dict[str, Any] = Field(default_factory=dict)


class TestConnectionResponse(BaseModel):
    success: bool
    message: str = ""
    available_fields: List[str] = Field(default_factory=list)


# ── 同步记录 ────────────────────────────────────────────────
class SyncJobResponse(BaseModel):
    """单条同步记录"""
    id: str
    connector_id: str
    status: str
    rows_synced: int = 0
    error_message: Optional[str] = None
    started_at: datetime
    completed_at: Optional[datetime] = None


class SyncJobListResponse(BaseModel):
    """同步记录列表"""
    total: int
    items: List[SyncJobResponse]
    page: int
    page_size: int


# ── Webhook 入站 ────────────────────────────────────────────
class WebhookInboundResponse(BaseModel):
    """Webhook 接收确认"""
    received: bool
    rows_queued: int = 0
