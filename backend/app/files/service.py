# backend/app/files/service.py
"""
文件/文件夹业务逻辑
"""
import uuid
import os
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List

from sqlalchemy import select, update, delete, and_
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Folder, UserFile
from ..utils.logger import get_logger

logger = get_logger('file_service')

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def normalize_storage_path(storage_path: str) -> str:
    """将存储路径标准化为项目相对路径（uploads/...）。"""
    p = Path(storage_path)
    if p.is_absolute():
        try:
            p = p.resolve().relative_to(PROJECT_ROOT)
        except Exception:
            return p.as_posix()
    s = p.as_posix().lstrip("./")
    return s


def resolve_storage_path(storage_path: str) -> Path:
    """将数据库中的相对/旧路径解析为磁盘绝对路径。"""
    p = Path(storage_path)
    if p.is_absolute():
        return p
    s = normalize_storage_path(storage_path)
    return PROJECT_ROOT / s


# ==================== Folder Service ====================

async def create_folder(
    db: AsyncSession, user_id: str, name: str, parent_id: Optional[str] = None
) -> Folder:
    """创建文件夹"""
    if parent_id:
        parent = await db.execute(
            select(Folder).where(Folder.id == parent_id, Folder.user_id == user_id)
        )
        if not parent.scalar_one_or_none():
            raise ValueError("父文件夹不存在")

    folder = Folder(
        id=str(uuid.uuid4()),
        user_id=user_id,
        name=name,
        parent_id=parent_id,
    )
    db.add(folder)
    await db.flush()
    return folder


async def list_folders(
    db: AsyncSession, user_id: str, parent_id: Optional[str] = None
) -> List[Folder]:
    """列出文件夹（指定父级）"""
    stmt = select(Folder).where(Folder.user_id == user_id)
    if parent_id:
        stmt = stmt.where(Folder.parent_id == parent_id)
    else:
        stmt = stmt.where(Folder.parent_id.is_(None))
    stmt = stmt.order_by(Folder.name)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_all_folders(db: AsyncSession, user_id: str) -> List[Folder]:
    """获取用户所有文件夹"""
    result = await db.execute(
        select(Folder).where(Folder.user_id == user_id).order_by(Folder.name)
    )
    return list(result.scalars().all())


async def rename_folder(
    db: AsyncSession, user_id: str, folder_id: str, new_name: str
) -> Optional[Folder]:
    """重命名文件夹"""
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == user_id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        return None
    folder.name = new_name
    await db.flush()
    return folder


async def rename_file(
    db: AsyncSession, user_id: str, file_id: str, new_name: str
) -> Optional[UserFile]:
    """重命名文件（仅修改显示名称，不修改磁盘路径）"""
    result = await db.execute(
        select(UserFile).where(UserFile.id == file_id, UserFile.user_id == user_id)
    )
    f = result.scalar_one_or_none()
    if not f:
        return None
    f.file_name = new_name
    await db.flush()
    return f


async def delete_folder(db: AsyncSession, user_id: str, folder_id: str) -> bool:
    """
    删除文件夹（级联处理）：
    - 子文件夹由数据库 CASCADE 处理
    - 子文件的 folder_id 由数据库 SET NULL 处理
    """
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == user_id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        return False
    await db.delete(folder)
    await db.flush()
    return True


async def move_folder(
    db: AsyncSession, user_id: str, folder_id: str, parent_id: Optional[str]
) -> Optional[Folder]:
    """
    移动文件夹到新的父级。
    校验：不能移动到自身或其子文件夹下（防止循环引用）。
    """
    result = await db.execute(
        select(Folder).where(Folder.id == folder_id, Folder.user_id == user_id)
    )
    folder = result.scalar_one_or_none()
    if not folder:
        return None

    if parent_id == folder_id:
        raise ValueError("不能将文件夹移动到自身")

    if parent_id:
        target = await db.execute(
            select(Folder).where(Folder.id == parent_id, Folder.user_id == user_id)
        )
        if not target.scalar_one_or_none():
            raise ValueError("目标文件夹不存在")

        # 检查 parent_id 是否是 folder_id 的子孙（防止循环）
        all_folders = await get_all_folders(db, user_id)
        children_ids = set()
        def collect_children(pid):
            for f in all_folders:
                if f.parent_id == pid and f.id not in children_ids:
                    children_ids.add(f.id)
                    collect_children(f.id)
        collect_children(folder_id)

        if parent_id in children_ids:
            raise ValueError("不能将文件夹移动到其子文件夹中")

    folder.parent_id = parent_id
    await db.flush()
    return folder


async def create_default_folders(db: AsyncSession, user_id: str):
    """为新用户创建预设目录"""
    for name in ["项目文档", "分析报告"]:
        folder = Folder(
            id=str(uuid.uuid4()),
            user_id=user_id,
            name=name,
            parent_id=None,
        )
        db.add(folder)
    await db.flush()


# ==================== File Service ====================

async def list_files(
    db: AsyncSession,
    user_id: str,
    folder_id: Optional[str] = "__unset__",
    starred: Optional[bool] = None,
) -> List[UserFile]:
    """列出文件（支持按文件夹、星标过滤）"""
    stmt = select(UserFile).where(
        UserFile.user_id == user_id,
        UserFile.status == "active",
    )
    if folder_id != "__unset__":
        if folder_id:
            stmt = stmt.where(UserFile.folder_id == folder_id)
        else:
            stmt = stmt.where(UserFile.folder_id.is_(None))
    if starred is not None:
        stmt = stmt.where(UserFile.is_starred == starred)
    stmt = stmt.order_by(UserFile.updated_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def search_files(
    db: AsyncSession, user_id: str, query: str, limit: int = 50
) -> List[UserFile]:
    """搜索文件（按名称模糊匹配）"""
    stmt = (
        select(UserFile)
        .where(
            UserFile.user_id == user_id,
            UserFile.status == "active",
            UserFile.file_name.ilike(f"%{query}%"),
        )
        .order_by(UserFile.accessed_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def toggle_star(
    db: AsyncSession, user_id: str, file_id: str
) -> Optional[UserFile]:
    """切换文件星标状态"""
    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    f = result.scalar_one_or_none()
    if not f:
        return None
    f.is_starred = not f.is_starred
    await db.flush()
    return f


async def move_file(
    db: AsyncSession, user_id: str, file_id: str, folder_id: Optional[str]
) -> Optional[UserFile]:
    """移动文件到指定文件夹"""
    if folder_id:
        folder_result = await db.execute(
            select(Folder).where(Folder.id == folder_id, Folder.user_id == user_id)
        )
        if not folder_result.scalar_one_or_none():
            raise ValueError("目标文件夹不存在")

    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    f = result.scalar_one_or_none()
    if not f:
        return None
    f.folder_id = folder_id
    await db.flush()
    return f


async def soft_delete_file(
    db: AsyncSession, user_id: str, file_id: str
) -> bool:
    """软删除文件，并清理磁盘文件"""
    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    f = result.scalar_one_or_none()
    if not f:
        return False

    # 先清理物理文件（失败不阻断软删除）
    try:
        resolved = resolve_storage_path(f.storage_path) if f.storage_path else None
        if resolved and os.path.exists(resolved):
            os.remove(resolved)
            logger.info(f"已删除物理文件: {resolved}")
    except Exception as e:
        logger.warning(f"删除物理文件失败: {f.storage_path}, error={e}")

    f.status = "deleted"
    await db.flush()
    return True


async def get_file_tree(db: AsyncSession, user_id: str) -> dict:
    """
    获取完整的文件树（文件夹 + 文件）
    返回 { folders: [...], files: [...] }，由前端组装成树
    """
    folders = await get_all_folders(db, user_id)
    files = await list_files(db, user_id, folder_id="__unset__")
    return {"folders": folders, "files": files}


async def get_file_by_id(
    db: AsyncSession, user_id: str, file_id: str
) -> Optional[UserFile]:
    """获取用户可访问的文件记录"""
    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    return result.scalar_one_or_none()


async def assert_active_file_owned(
    db: AsyncSession,
    user_id: str,
    file_id: str,
) -> UserFile:
    """断言文件存在且归属于当前用户。"""
    file_obj = await get_file_by_id(db, user_id, file_id)
    if not file_obj:
        raise ValueError("文件不存在或无权限访问")
    return file_obj


async def upload_file_record(
    db: AsyncSession,
    user_id: str,
    file_name: str,
    file_size: int,
    storage_path: str,
    folder_id: Optional[str] = None,
    file_format: str = "xlsx",
    sheet_names: Optional[str] = None,
    row_count: int = 0,
    col_count: int = 0,
) -> UserFile:
    """创建上传文件记录"""
    if folder_id:
        folder_result = await db.execute(
            select(Folder).where(Folder.id == folder_id, Folder.user_id == user_id)
        )
        if not folder_result.scalar_one_or_none():
            raise ValueError("目标文件夹不存在")

    f = UserFile(
        id=str(uuid.uuid4()),
        user_id=user_id,
        file_name=file_name,
        file_type="upload",
        file_format=file_format,
        file_size=file_size,
        storage_path=storage_path,
        folder_id=folder_id,
        sheet_names=sheet_names,
        row_count=row_count,
        col_count=col_count,
    )
    db.add(f)
    await db.flush()
    return f


async def update_file_content(
    db: AsyncSession,
    user_id: str,
    file_id: str,
    *,
    storage_path: str,
    file_size: int,
    file_format: str,
    sheet_names: Optional[str],
    row_count: int = 0,
    col_count: int = 0,
) -> Optional[UserFile]:
    """更新文件内容（覆盖保存）"""
    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user_id,
            UserFile.status == "active",
        )
    )
    file_obj = result.scalar_one_or_none()
    if not file_obj:
        return None

    file_obj.storage_path = storage_path
    file_obj.file_size = file_size
    file_obj.file_format = file_format
    file_obj.sheet_names = sheet_names
    file_obj.row_count = row_count
    file_obj.col_count = col_count
    # 与并发版本校验保持一致：内容版本戳使用秒级精度，避免微秒精度差引发伪冲突
    file_obj.accessed_at = datetime.now(timezone.utc).replace(microsecond=0)
    await db.flush()
    return file_obj
