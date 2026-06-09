# ============================================================================
# 外部系统连接器 - 同步执行引擎
# execute_sync: 主动拉取同步（定时/手动触发）
# execute_webhook_sync: 被动 Webhook 推送处理
# ============================================================================
from __future__ import annotations

import json
from datetime import timezone
from pathlib import Path
from typing import Any, Dict, List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..utils.logger import get_logger
from . import service
from .adapters import get_adapter
from .adapters.webhook import WebhookAdapter
from .models import Connector
from .writer import write_rows_to_xlsx

logger = get_logger("connect.sync_engine")
PROJECT_ROOT = Path(__file__).resolve().parents[3]


async def execute_sync(
    db: AsyncSession,
    connector: Connector,
) -> Dict[str, Any]:
    """
    执行一次完整同步:
    1. 创建 sync_job
    2. 调适配器 fetch_data
    3. 字段映射 + 写入 Excel
    4. 更新 connector 状态
    """
    job = await service.create_sync_job(db, connector.id)

    try:
        adapter = get_adapter(connector.type)
        config = _parse_json(connector.config)
        field_mapping = _parse_json(connector.field_mapping)

        rows = await adapter.fetch_data(config, connector.last_sync_at)
        if not rows:
            await service.complete_sync_job(db, job, status="success", rows_synced=0)
            await _update_connector_sync(db, connector, "success", 0, config=config)
            return {"status": "success", "rows_synced": 0, "message": "无新数据"}

        xlsx_path = await _resolve_xlsx_path(db, connector.file_id, connector.user_id)
        if not xlsx_path:
            msg = "关联文件不存在或路径无效"
            await service.complete_sync_job(db, job, status="error", error_message=msg)
            await _update_connector_sync(db, connector, "error", 0, msg)
            return {"status": "error", "rows_synced": 0, "message": msg}

        deduplicate = bool(config.get("deduplicate_by_primary_key"))
        primary_key = (config.get("primary_key", "") or "").strip() or None
        written = write_rows_to_xlsx(
            xlsx_path,
            connector.sheet_name,
            field_mapping,
            rows,
            primary_key=primary_key,
            deduplicate=deduplicate,
        )

        await service.complete_sync_job(db, job, status="success", rows_synced=written)
        await _update_connector_sync(db, connector, "success", written, config=config)
        return {"status": "success", "rows_synced": written, "message": f"同步 {written} 行"}

    except Exception as e:
        error_msg = str(e)[:500]
        logger.error("同步失败: connector=%s, err=%s", connector.id, e)
        await service.complete_sync_job(db, job, status="error", error_message=error_msg)
        await _update_connector_sync(db, connector, "error", 0, error_msg)
        return {"status": "error", "rows_synced": 0, "message": error_msg}


async def execute_webhook_sync(
    db: AsyncSession,
    connector: Connector,
    payload: Any,
) -> int:
    """处理 Webhook 推送数据并写入 Excel"""
    adapter = get_adapter("webhook")
    if not isinstance(adapter, WebhookAdapter):
        return 0

    rows = adapter.extract_rows(payload)
    if not rows:
        return 0

    field_mapping = _parse_json(connector.field_mapping)
    xlsx_path = await _resolve_xlsx_path(db, connector.file_id, connector.user_id)
    if not xlsx_path:
        logger.warning("Webhook: 关联文件不存在, connector=%s", connector.id)
        return 0

    # 自动映射: 如果没有配置 field_mapping，用数据本身的 key 作为映射
    if not field_mapping and rows:
        field_mapping = {k: k for k in rows[0].keys()}

    written = write_rows_to_xlsx(xlsx_path, connector.sheet_name, field_mapping, rows)
    await _update_connector_sync(db, connector, "success", written)
    return written


# ── 内部工具 ────────────────────────────────────────────────

def _parse_json(raw) -> Dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    return raw if isinstance(raw, dict) else {}


async def _resolve_xlsx_path(
    db: AsyncSession,
    file_id: str | None,
    user_id: str,
) -> Path | None:
    """根据 file_id 解析出物理文件路径"""
    if not file_id:
        return None

    from ..files.models import UserFile
    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    user_file = result.scalar_one_or_none()
    if not user_file:
        return None

    upload_root = Path(settings.UPLOAD_DIR)
    if not upload_root.is_absolute():
        upload_root = PROJECT_ROOT / upload_root
    raw_path = Path(str(user_file.storage_path).strip())

    if raw_path.is_absolute():
        xlsx_path = raw_path
    elif raw_path.parts and raw_path.parts[0] == upload_root.name:
        xlsx_path = PROJECT_ROOT / raw_path
    else:
        xlsx_path = upload_root / raw_path

    return xlsx_path if xlsx_path.exists() else None


async def _update_connector_sync(
    db: AsyncSession,
    connector: Connector,
    status: str,
    rows: int,
    message: str | None = None,
    config: Dict[str, Any] | None = None,
) -> None:
    """更新连接器的最后同步状态"""
    from datetime import datetime
    next_config = None
    if isinstance(config, dict) and connector.type == "database":
        next_cursor = config.get("_next_cursor")
        if next_cursor not in (None, ""):
            cfg = dict(config)
            cfg.pop("_next_cursor", None)
            cfg["last_cursor"] = next_cursor
            next_config = cfg

    await service.update_connector(
        db, connector,
        last_sync_at=datetime.now(timezone.utc),
        last_sync_status=status,
        last_sync_message=message or f"同步 {rows} 行",
        config=next_config,
    )
