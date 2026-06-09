# backend/app/pptx/storage.py
"""
PPTX 文件存储与元数据管理
按日期子目录组织：pptx_files/YYYY-MM-DD/{pptx_id}.json|.pptx
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger("pptx.storage")
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ================================================================
# 存储根目录
# ================================================================

_upload_root = Path(settings.UPLOAD_DIR)
if not _upload_root.is_absolute():
    _upload_root = PROJECT_ROOT / _upload_root
PPTX_DIR = _upload_root / "pptx_files"
PPTX_DIR.mkdir(parents=True, exist_ok=True)


# ================================================================
# 路径索引（pptx_id -> 所在日期目录）
# ================================================================

_index: Dict[str, Path] = {}
_index_lock = threading.Lock()
_index_built = False


def _build_index() -> None:
    """首次调用时扫描 pptx_files/ 全部日期子目录，建立 pptx_id -> date_dir 映射。"""
    global _index_built
    if _index_built:
        return
    with _index_lock:
        if _index_built:
            return
        for meta_file in PPTX_DIR.rglob("*.json"):
            pid = meta_file.stem
            _index[pid] = meta_file.parent
        _index_built = True


def _today_dir() -> Path:
    d = PPTX_DIR / datetime.now().strftime("%Y-%m-%d")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_dir(pptx_id: str) -> Optional[Path]:
    """查索引获取 pptx_id 所在日期目录；miss 则 rglob 兜底。"""
    _build_index()
    d = _index.get(pptx_id)
    if d and (d / f"{pptx_id}.json").exists():
        return d
    # 兜底：索引过期或文件被手动移动
    hits = list(PPTX_DIR.rglob(f"{pptx_id}.json"))
    if hits:
        d = hits[0].parent
        _index[pptx_id] = d
        return d
    return None


def _meta_path(pptx_id: str) -> Optional[Path]:
    d = _resolve_dir(pptx_id)
    return d / f"{pptx_id}.json" if d else None


def _pptx_path(pptx_id: str) -> Optional[Path]:
    d = _resolve_dir(pptx_id)
    return d / f"{pptx_id}.pptx" if d else None


# ================================================================
# 写入
# ================================================================

def save_pptx_meta(
    pptx_id: str,
    user_id: str,
    file_id: str,
    template_key: str,
    slide_plan: Dict[str, Any],
    aippt_slides: Optional[List[Dict[str, Any]]] = None,
    data_elements: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """保存汇报元数据 JSON，返回 pptx_id"""
    date_dir = _today_dir()
    meta = {
        "pptx_id": pptx_id,
        "user_id": user_id,
        "file_id": file_id,
        "template_key": template_key,
        "title": slide_plan.get("title", ""),
        "subtitle": slide_plan.get("subtitle", ""),
        "slide_count": len(slide_plan.get("slides", [])),
        "slides": slide_plan.get("slides", []),
        "aippt_slides": aippt_slides or [],
        "data_elements": data_elements or [],
        "created_at": _utc_now_iso(),
    }
    path = date_dir / f"{pptx_id}.json"
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, default=str)
        _index[pptx_id] = date_dir
        logger.info("保存 PPTX 元数据: %s -> %s", pptx_id, path)
    except Exception as exc:
        logger.error("写入 PPTX 元数据失败: %s", exc)
        raise
    return pptx_id


def pptx_storage_relpaths(pptx_id: str) -> tuple[str, str]:
    """返回相对项目根的 meta.json / .pptx 路径（供 DB 注册）。"""
    d = _resolve_dir(pptx_id)
    if d is None:
        raise ValueError(f"无法解析 PPTX 目录: {pptx_id}")
    pj = d / f"{pptx_id}.json"
    pp = d / f"{pptx_id}.pptx"
    return (
        str(pj.relative_to(PROJECT_ROOT).as_posix()),
        str(pp.relative_to(PROJECT_ROOT).as_posix()),
    )


def get_pptx_file_path(pptx_id: str) -> Path:
    """获取 .pptx 文件路径（供 builder 写入）。
    新文件使用索引中的日期目录（由 save_pptx_meta 预先注册）。
    """
    d = _resolve_dir(pptx_id)
    if d is None:
        d = _today_dir()
        _index[pptx_id] = d
    return d / f"{pptx_id}.pptx"


# ================================================================
# 读取
# ================================================================

def load_pptx_meta(pptx_id: str) -> Optional[Dict[str, Any]]:
    path = _meta_path(pptx_id)
    if not path or not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.warning("加载 PPTX 元数据失败: %s %s", pptx_id, exc)
        return None


def pptx_file_exists(pptx_id: str) -> bool:
    p = _pptx_path(pptx_id)
    return p.exists() if p else False


def list_user_pptx(user_id: str) -> List[Dict[str, Any]]:
    """列出用户的所有汇报（递归扫描日期子目录）"""
    _build_index()
    result: List[Dict[str, Any]] = []
    if not PPTX_DIR.exists():
        return result
    for f in PPTX_DIR.rglob("*.json"):
        try:
            with open(f, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
            if meta.get("user_id") == user_id:
                result.append({
                    "pptx_id": meta["pptx_id"],
                    "title": meta.get("title", ""),
                    "template_key": meta.get("template_key", ""),
                    "slide_count": meta.get("slide_count", 0),
                    "created_at": meta.get("created_at", ""),
                    "file_id": meta.get("file_id"),
                })
        except Exception:
            continue
    result.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return result


# ================================================================
# 更新
# ================================================================

def update_pptx_slides(
    pptx_id: str,
    slides_data: List[Dict[str, Any]],
    slide_field: str = "slides",
) -> bool:
    meta = load_pptx_meta(pptx_id)
    if not meta:
        return False
    meta[slide_field] = slides_data
    if slide_field == "slides":
        meta["slide_count"] = len(slides_data)
    elif slide_field == "pptist_slides":
        meta["pptist_slide_count"] = len(slides_data)
    meta["updated_at"] = _utc_now_iso()
    path = _meta_path(pptx_id)
    if not path:
        return False
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, default=str)
        return True
    except Exception as exc:
        logger.error("更新 PPTX slides 失败: %s", exc)
        return False


# ================================================================
# 删除
# ================================================================

def delete_pptx(pptx_id: str) -> bool:
    deleted = False
    for path in (_meta_path(pptx_id), _pptx_path(pptx_id)):
        if not path:
            continue
        try:
            if path.exists():
                os.remove(path)
                deleted = True
        except Exception as exc:
            logger.warning("删除 PPTX 文件失败: %s %s", path, exc)
    _index.pop(pptx_id, None)
    return deleted


def new_pptx_id() -> str:
    return str(uuid.uuid4())
