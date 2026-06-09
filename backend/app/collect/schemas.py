# ============================================================================
# 表单收集 - Pydantic 请求/响应模型
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── AI 字段推断 ────────────────────────────────────────────
class AIConfigRequest(BaseModel):
    """发送列头给 LLM，返回智能字段配置"""
    columns: List[str] = Field(..., min_length=1, description="工作表列头列表")
    sheet_name: Optional[str] = None


class FieldConfig(BaseModel):
    key: str
    label: str
    type: str = "text"
    required: bool = False
    placeholder: str = ""
    validation: Dict[str, Any] = Field(default_factory=dict)
    options: List[str] = Field(default_factory=list)


class AIConfigResponse(BaseModel):
    fields: List[FieldConfig]
    suggested_title: str = ""
    suggested_description: str = ""


# ── 表单 CRUD ──────────────────────────────────────────────
class FormCreateRequest(BaseModel):
    title: str
    description: str = ""
    sheet_name: Optional[str] = None
    file_id: Optional[str] = None
    form_config: Dict[str, Any] = Field(default_factory=dict)
    max_submissions: Optional[int] = None
    expires_at: Optional[datetime] = None


class FormUpdateRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    sheet_name: Optional[str] = None
    file_id: Optional[str] = None
    form_config: Optional[Dict[str, Any]] = None
    max_submissions: Optional[int] = None
    expires_at: Optional[datetime] = None


class FormStatusRequest(BaseModel):
    status: str = Field(..., pattern="^(active|closed)$")


class FormResponse(BaseModel):
    id: str
    title: str
    description: str
    share_token: str
    status: str
    submission_count: int
    max_submissions: Optional[int]
    expires_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime
    form_config: Dict[str, Any] = Field(default_factory=dict)
    sheet_name: Optional[str] = None
    file_id: Optional[str] = None


# ── 公开表单 ──────────────────────────────────────────────
class PublicFormResponse(BaseModel):
    """公开表单页面渲染所需数据"""
    title: str
    description: str
    fields: List[FieldConfig]
    status: str
    accepting: bool  # 是否还接受提交


class SubmitRequest(BaseModel):
    data: Dict[str, Any]


class SubmitResponse(BaseModel):
    success: bool
    message: str = ""


# ── 提交记录 ──────────────────────────────────────────────
class SubmissionResponse(BaseModel):
    id: str
    data: Dict[str, Any]
    # DB 中历史数据 synced 可能为 NULL，用 Optional 避免 Pydantic v2 验证异常
    synced: Optional[bool] = False
    submitted_at: datetime
    ip_address: Optional[str] = None


class SubmissionListResponse(BaseModel):
    total: int
    items: List[SubmissionResponse]
    page: int
    page_size: int
