# ============================================================================
# 外部系统连接器 - 路由
# 认证端点: /api/connect/*   公开端点: /api/webhook/*
# ============================================================================
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.database import get_db
from ..core.dependencies import get_current_user
from ..core.quota import QuotaGuard
from ..utils.logger import get_logger
from . import service
from .schemas import (
    ConnectorCreateRequest, ConnectorListResponse, ConnectorResponse,
    ConnectorStatusRequest, ConnectorUpdateRequest,
    SyncJobListResponse, SyncJobResponse,
    TestConnectionRequest, TestConnectionResponse,
    WebhookInboundResponse,
)

logger = get_logger("connect.router")
WEBHOOK_MAX_BODY_BYTES = 2 * 1024 * 1024
WEBHOOK_MAX_SKEW_SECONDS = 300
SAFE_ENDPOINT_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def _is_safe_endpoint_token(token: str) -> bool:
    return bool(token and SAFE_ENDPOINT_TOKEN_RE.match(token))


def _ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """将时间统一为 UTC aware，避免序列化丢失时区语义。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ============================================================================
# 认证端点
# ============================================================================
router = APIRouter(prefix="/api/connect", tags=["connect"])


@router.get("/connectors", response_model=ConnectorListResponse)
async def list_connectors(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出当前用户所有连接器"""
    items = await service.list_connectors(db, user.id)
    return ConnectorListResponse(
        total=len(items),
        items=[_connector_to_response(c) for c in items],
    )


@router.post("/connectors", response_model=ConnectorResponse, status_code=201)
async def create_connector(
    body: ConnectorCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _quota=Depends(QuotaGuard("connector_count")),
):
    """创建连接器"""
    try:
        connector = await service.create_connector(
            db, user.id,
            name=body.name,
            type=body.type,
            config=body.config,
            field_mapping=body.field_mapping,
            file_id=body.file_id,
            sheet_name=body.sheet_name,
            sync_interval=body.sync_interval,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return _connector_to_response(connector)


@router.get("/connectors/{connector_id}", response_model=ConnectorResponse)
async def get_connector(
    connector_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """连接器详情"""
    try:
        connector = await service.assert_connector_owned(db, connector_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="连接器不存在")
    return _connector_to_response(connector)


@router.put("/connectors/{connector_id}", response_model=ConnectorResponse)
async def update_connector(
    connector_id: str,
    body: ConnectorUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新连接器配置"""
    try:
        connector = await service.assert_connector_owned(db, connector_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="连接器不存在")
    try:
        connector = await service.update_connector(
            db, connector,
            name=body.name,
            config=body.config,
            field_mapping=body.field_mapping,
            file_id=body.file_id,
            sheet_name=body.sheet_name,
            sync_interval=body.sync_interval,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return _connector_to_response(connector)


@router.put("/connectors/{connector_id}/status", response_model=ConnectorResponse)
async def update_connector_status(
    connector_id: str,
    body: ConnectorStatusRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """切换连接器状态 (active/paused)"""
    try:
        connector = await service.assert_connector_owned(db, connector_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="连接器不存在")
    connector = await service.update_connector(db, connector, status=body.status)
    return _connector_to_response(connector)


@router.delete("/connectors/{connector_id}", status_code=204)
async def delete_connector(
    connector_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除连接器"""
    try:
        connector = await service.assert_connector_owned(db, connector_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="连接器不存在")
    await service.delete_connector(db, connector)


@router.post("/connectors/{connector_id}/sync")
async def trigger_sync(
    connector_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """手动触发同步"""
    try:
        connector = await service.assert_connector_owned(db, connector_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="连接器不存在")

    from .sync_engine import execute_sync
    result = await execute_sync(db, connector)
    return result


@router.get("/connectors/{connector_id}/jobs", response_model=SyncJobListResponse)
async def list_sync_jobs(
    connector_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取同步历史"""
    try:
        await service.assert_connector_owned(db, connector_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="连接器不存在")

    items, total = await service.list_sync_jobs(db, connector_id, page, page_size)
    return SyncJobListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[_job_to_response(j) for j in items],
    )


@router.post("/connectors/test", response_model=TestConnectionResponse)
async def test_connection(
    body: TestConnectionRequest,
    user: User = Depends(get_current_user),
):
    """测试连接（不保存，仅验证配置可达）"""
    from .adapters import get_adapter
    try:
        adapter = get_adapter(body.type)
        ok = await adapter.test_connection(body.config)
        fields = []
        if ok:
            if body.type == "database" and hasattr(adapter, "preview_fields"):
                fields = await adapter.preview_fields(body.config)
            if not fields:
                fields = adapter.get_available_fields(body.config)
        return TestConnectionResponse(
            success=ok,
            message="连接成功" if ok else "连接失败",
            available_fields=fields,
        )
    except Exception as e:
        logger.warning("测试连接失败: type=%s, err=%s", body.type, e)
        err_type = type(e).__name__
        host = body.config.get("host", "")
        port = body.config.get("port", "")
        database = body.config.get("database", "")
        detail = (
            f"连接失败\n"
            f"- 类型: {body.type}\n"
            f"- 主机: {host or '(未填写)'}\n"
            f"- 端口: {port or '(未填写)'}\n"
            f"- 数据库: {database or '(未填写)'}\n"
            f"- 错误类型: {err_type}\n"
            f"- 错误详情: {e}\n"
            f"- 排查建议: 检查主机/端口可达、账号权限、白名单、防火墙和 SQL 语句。"
        )
        return TestConnectionResponse(
            success=False,
            message=detail,
        )


# ============================================================================
# Webhook 公开端点（无需认证）
# ============================================================================
webhook_router = APIRouter(prefix="/api/webhook", tags=["webhook"])


@webhook_router.post("/{endpoint_token}", response_model=WebhookInboundResponse)
async def receive_webhook(
    endpoint_token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """接收外部系统推送的数据"""
    if not _is_safe_endpoint_token(endpoint_token):
        raise HTTPException(status_code=404, detail="Webhook 端点不存在或已停用")
    connector = await service.get_connector_by_webhook_token(db, endpoint_token)
    if not connector:
        raise HTTPException(status_code=404, detail="Webhook 端点不存在或已停用")

    raw_body = await request.body()
    if len(raw_body) > WEBHOOK_MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="请求体过大")

    config = json.loads(connector.config) if isinstance(connector.config, str) else (connector.config or {})
    webhook_secret = (config.get("webhook_secret") or "").strip()
    if webhook_secret:
        timestamp = request.headers.get("x-webhook-timestamp")
        signature = request.headers.get("x-webhook-signature")
        if not timestamp or not signature:
            raise HTTPException(status_code=401, detail="缺少签名头")
        try:
            ts = int(timestamp)
        except ValueError:
            raise HTTPException(status_code=401, detail="时间戳非法")
        now_ts = int(time.time())
        if abs(now_ts - ts) > WEBHOOK_MAX_SKEW_SECONDS:
            raise HTTPException(status_code=401, detail="请求已过期")

        payload_to_sign = f"{timestamp}.".encode("utf-8") + raw_body
        expected = hmac.new(
            webhook_secret.encode("utf-8"),
            payload_to_sign,
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise HTTPException(status_code=401, detail="签名校验失败")

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="请求体必须为 JSON")

    from .sync_engine import execute_webhook_sync
    rows = await execute_webhook_sync(db, connector, payload)
    return WebhookInboundResponse(received=True, rows_queued=rows)


# ============================================================================
# 响应转换
# ============================================================================

def _connector_to_response(c: Connector) -> ConnectorResponse:
    config = json.loads(c.config) if isinstance(c.config, str) else (c.config or {})
    mapping = json.loads(c.field_mapping) if isinstance(c.field_mapping, str) else (c.field_mapping or {})
    return ConnectorResponse(
        id=c.id,
        name=c.name,
        type=c.type,
        config=config,
        field_mapping=mapping,
        file_id=c.file_id,
        sheet_name=c.sheet_name,
        sync_interval=c.sync_interval or 0,
        status=c.status,
        last_sync_at=_ensure_utc(c.last_sync_at),
        last_sync_status=c.last_sync_status,
        last_sync_message=c.last_sync_message,
        created_at=_ensure_utc(c.created_at),
        updated_at=_ensure_utc(c.updated_at),
    )


def _job_to_response(j: SyncJob) -> SyncJobResponse:
    return SyncJobResponse(
        id=j.id,
        connector_id=j.connector_id,
        status=j.status,
        rows_synced=j.rows_synced or 0,
        error_message=j.error_message,
        started_at=_ensure_utc(j.started_at),
        completed_at=_ensure_utc(j.completed_at),
    )
