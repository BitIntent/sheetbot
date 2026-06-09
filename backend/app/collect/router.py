# ============================================================================
# 表单收集 - 路由
# 认证端点: /api/collect/*   公开端点: /api/public/form/*
# ============================================================================
from __future__ import annotations

import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.config import settings
from ..core.database import get_db
from ..core.dependencies import get_current_user
from ..core.quota import QuotaGuard, get_user_quota, get_user_plan_name
from ..core.usage_service import get_monthly_sum, increment_usage
from ..utils.logger import get_logger
from . import service
from .form_ai import infer_form_config
from .schemas import (
    AIConfigRequest, AIConfigResponse,
    FormCreateRequest, FormResponse, FormStatusRequest, FormUpdateRequest,
    PublicFormResponse, FieldConfig,
    SubmissionListResponse, SubmissionResponse,
    SubmitRequest, SubmitResponse,
)

logger = get_logger("collect.router")
SAFE_PUBLIC_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")

def _normalize_options(options_raw) -> list[str]:
    """兼容 options 为字符串数组或对象数组({label,value})"""
    if not isinstance(options_raw, list):
        return []
    result: list[str] = []
    for item in options_raw:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            text = str(item.get("label") or item.get("value") or "").strip()
        else:
            text = str(item).strip()
        if text:
            result.append(text)
    return result


def _normalize_field_configs(fields_raw) -> list[FieldConfig]:
    """将 LLM 返回字段配置归一化后再交给 Pydantic 校验"""
    normalized: list[FieldConfig] = []
    for idx, raw in enumerate(fields_raw or [], 1):
        if not isinstance(raw, dict):
            continue
        field_data = dict(raw)
        if not field_data.get("key"):
            field_data["key"] = f"col_{idx}"
        field_data["options"] = _normalize_options(field_data.get("options", []))
        normalized.append(FieldConfig(**field_data))
    return normalized


def _is_safe_public_token(token: str) -> bool:
    return bool(token and SAFE_PUBLIC_TOKEN_RE.match(token))


# ============================================================================
# 认证端点
# ============================================================================
router = APIRouter(prefix="/api/collect", tags=["collect"])


@router.post("/forms/ai-config", response_model=AIConfigResponse)
async def ai_config(
    body: AIConfigRequest,
    user: User = Depends(get_current_user),
):
    """发送列头给 LLM，返回智能字段配置"""
    result = await infer_form_config(body.columns)
    return AIConfigResponse(
        fields=_normalize_field_configs(result.get("fields", [])),
        suggested_title=result.get("suggested_title", ""),
        suggested_description=result.get("suggested_description", ""),
    )


@router.post("/forms", response_model=FormResponse)
async def create_form(
    body: FormCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _quota=Depends(QuotaGuard("form_count")),
):
    """创建并发布表单"""
    try:
        form = await service.create_form(
            db, user.id,
            title=body.title,
            description=body.description,
            sheet_name=body.sheet_name,
            file_id=body.file_id,
            form_config=body.form_config,
            max_submissions=body.max_submissions,
            expires_at=body.expires_at,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return _form_to_response(form)


@router.get("/forms", response_model=list[FormResponse])
async def list_forms(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出当前用户所有表单"""
    forms = await service.list_forms(db, user.id)
    return [_form_to_response(f) for f in forms]


@router.get("/forms/{form_id}", response_model=FormResponse)
async def get_form(
    form_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取表单详情"""
    try:
        form = await service.assert_form_owned(db, form_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="表单不存在")
    return _form_to_response(form)


@router.put("/forms/{form_id}", response_model=FormResponse)
async def update_form(
    form_id: str,
    body: FormUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新表单配置"""
    try:
        form = await service.assert_form_owned(db, form_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="表单不存在")

    if body.file_id is not None and body.file_id != form.file_id:
        try:
            await service.file_service.assert_active_file_owned(db, user.id, body.file_id)
        except ValueError as e:
            raise HTTPException(status_code=403, detail=str(e))

    form = await service.update_form(
        db, form,
        allow_none_keys={"file_id", "sheet_name"},
        title=body.title,
        description=body.description,
        sheet_name=body.sheet_name,
        file_id=body.file_id,
        form_config=body.form_config,
        max_submissions=body.max_submissions,
        expires_at=body.expires_at,
    )
    return _form_to_response(form)


@router.put("/forms/{form_id}/status", response_model=FormResponse)
async def update_form_status(
    form_id: str,
    body: FormStatusRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """切换表单状态 (active/closed)"""
    try:
        form = await service.assert_form_owned(db, form_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="表单不存在")
    form = await service.update_form(db, form, status=body.status)
    return _form_to_response(form)


@router.delete("/forms/{form_id}", status_code=204)
async def delete_form(
    form_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除表单"""
    try:
        form = await service.assert_form_owned(db, form_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="表单不存在")
    await service.delete_form(db, form)


@router.get("/forms/{form_id}/submissions", response_model=SubmissionListResponse)
async def list_submissions(
    form_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """分页获取提交数据"""
    try:
        await service.assert_form_owned(db, form_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="表单不存在")

    items, total = await service.list_submissions(db, form_id, page, page_size)
    return SubmissionListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[_submission_to_response(s) for s in items],
    )


@router.post("/forms/{form_id}/sync")
async def sync_submissions(
    form_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """将未同步提交批量追加到工作表文件"""
    try:
        form = await service.assert_form_owned(db, form_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="表单不存在")

    upload_dir = getattr(settings, "UPLOAD_DIR", "uploads")
    result = await service.sync_submissions_to_xlsx(db, form, upload_dir)
    if not result.get("success"):
        code = result.get("code")
        message = result.get("message", "同步失败")
        if code in {"NO_FILE_BINDING", "TARGET_SHEET_MISSING"}:
            raise HTTPException(status_code=400, detail=message)
        if code in {"FILE_NOT_FOUND", "XLSX_MISSING"}:
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=500, detail=message)
    return result


# ============================================================================
# 公开端点（无需认证）
# ============================================================================
public_router = APIRouter(prefix="/api/public/form", tags=["public-form"])


@public_router.get("/{share_token}", response_model=PublicFormResponse)
async def get_public_form(
    share_token: str,
    db: AsyncSession = Depends(get_db),
):
    """获取公开表单配置（渲染表单用）"""
    if not _is_safe_public_token(share_token):
        raise HTTPException(status_code=404, detail="表单不存在或已删除")
    form = await service.get_form_by_token(db, share_token)
    if not form:
        raise HTTPException(status_code=404, detail="表单不存在或已删除")

    config = json.loads(form.form_config) if form.form_config else {}
    fields_raw = config.get("fields", [])

    return PublicFormResponse(
        title=form.title,
        description=form.description or "",
        fields=_normalize_field_configs(fields_raw),
        status=form.status,
        accepting=service.is_form_accepting(form),
    )


@public_router.post("/{share_token}/submit", response_model=SubmitResponse)
async def submit_public_form(
    share_token: str,
    body: SubmitRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """提交公开表单数据"""
    if not _is_safe_public_token(share_token):
        raise HTTPException(status_code=404, detail="表单不存在")
    form = await service.get_form_by_token(db, share_token)
    if not form:
        raise HTTPException(status_code=404, detail="表单不存在")

    if not service.is_form_accepting(form):
        return SubmitResponse(success=False, message="表单已关闭或已达提交上限")

    # ---- 表单所有者的月度提交配额检查 ----
    owner_id = form.user_id
    owner_quotas = await get_user_quota(owner_id, db)
    limit = owner_quotas.get("form_submissions")
    if limit is not None and limit != -1:
        if limit == 0:
            return SubmitResponse(success=False, message="表单所有者当前套餐暂不支持收集提交")
        current = await get_monthly_sum(owner_id, "form_submit_count", db)
        if current >= limit:
            plan_name = await get_user_plan_name(owner_id, db)
            return SubmitResponse(
                success=False,
                message=f"该表单本月已收集 {current} 条提交，所有者「{plan_name}」配额为 {limit} 条/月，暂无法继续收集。",
            )

    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent", "")[:500]

    await service.submit_form(db, form, body.data, ip_address=ip, user_agent=ua)
    await increment_usage(owner_id, "form_submit_count", db)
    return SubmitResponse(success=True, message="提交成功")


# ============================================================================
# 响应转换
# ============================================================================

def _form_to_response(form: Form) -> FormResponse:
    config = json.loads(form.form_config) if form.form_config else {}
    return FormResponse(
        id=form.id,
        title=form.title,
        description=form.description or "",
        share_token=form.share_token,
        status=form.status,
        submission_count=form.submission_count or 0,
        max_submissions=form.max_submissions,
        expires_at=form.expires_at,
        created_at=form.created_at,
        updated_at=form.updated_at,
        form_config=config,
        sheet_name=form.sheet_name,
        file_id=form.file_id,
    )


def _submission_to_response(sub: FormSubmission) -> SubmissionResponse:
    data = json.loads(sub.data) if isinstance(sub.data, str) else sub.data
    return SubmissionResponse(
        id=sub.id,
        data=data,
        synced=sub.synced,
        submitted_at=sub.submitted_at,
        ip_address=sub.ip_address,
    )
