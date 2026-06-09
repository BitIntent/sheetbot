"""报表快照磁盘持久化：report_files/YYYY-MM-DD/{report_id}.json"""
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger("report.storage")

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _resolve_upload_root() -> Path:
    upload_dir = Path(settings.UPLOAD_DIR)
    if upload_dir.is_absolute():
        return upload_dir
    return PROJECT_ROOT / upload_dir


UPLOAD_ROOT = _resolve_upload_root()
SNAPSHOT_DIR = UPLOAD_ROOT / "report_files"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def _to_storage_path(path: Path) -> str:
    """将磁盘路径标准化为项目相对路径，便于跨服务器迁移。"""
    try:
        return path.resolve().relative_to(PROJECT_ROOT).as_posix()
    except Exception:
        return path.as_posix()


def _resolve_snapshot_path(filepath: str) -> Path:
    path = Path(filepath)
    if path.is_absolute():
        return path
    return PROJECT_ROOT / path


def _today_dir() -> Path:
    d = SNAPSHOT_DIR / datetime.now().strftime("%Y-%m-%d")
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_report_snapshot(report_data: Dict, suffix: Optional[str] = None) -> str:
    report_id = report_data.get("report_id") or str(uuid.uuid4())
    filename = f"{report_id}{suffix or ''}.json"
    date_dir = _today_dir()
    filepath = date_dir / filename
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(report_data, f, ensure_ascii=False, default=str)
        return _to_storage_path(filepath)
    except Exception as exc:
        logger.error(f"写入报表快照失败: {exc}")
        raise


def load_report_snapshot(filepath: str) -> Optional[Dict]:
    resolved_path = _resolve_snapshot_path(filepath)
    try:
        with open(resolved_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.warning(f"加载报表快照失败: {filepath} -> {resolved_path}, error={exc}")
        return None


def delete_report_snapshot(filepath: str) -> None:
    resolved_path = _resolve_snapshot_path(filepath)
    try:
        if os.path.exists(resolved_path):
            os.remove(resolved_path)
    except Exception as exc:
        logger.warning(f"删除报表快照失败: {filepath} -> {resolved_path}, error={exc}")
