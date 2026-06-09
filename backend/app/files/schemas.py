# backend/app/files/schemas.py
"""
文件/文件夹 Pydantic schemas
"""
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


# ==================== Folder ====================

class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    parent_id: Optional[str] = None


class FolderRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class FolderMoveRequest(BaseModel):
    parent_id: Optional[str] = Field(None, description="目标父文件夹 ID，null 表示移到根目录")


class FolderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    parent_id: Optional[str]
    created_at: datetime
    updated_at: datetime


# ==================== File ====================

class FileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    file_name: str
    file_type: str
    file_format: str
    file_size: int
    folder_id: Optional[str]
    is_starred: bool
    last_view: str
    sheet_names: Optional[str]
    row_count: int
    col_count: int
    status: str
    created_at: datetime
    updated_at: datetime
    accessed_at: datetime


class FileRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class FileMoveRequest(BaseModel):
    folder_id: Optional[str] = Field(None, description="目标文件夹 ID，null 表示移到根目录")


class FileStarResponse(BaseModel):
    id: str
    is_starred: bool


# ==================== Tree (combined) ====================

class FileTreeItem(BaseModel):
    """文件树项（文件或文件夹）"""
    id: str
    name: str
    type: str  # "folder" | "file"
    parent_id: Optional[str] = None
    # folder-only
    children: Optional[List["FileTreeItem"]] = None
    # file-only
    file_type: Optional[str] = None
    file_format: Optional[str] = None
    file_size: Optional[int] = None
    is_starred: Optional[bool] = None
    last_view: Optional[str] = None
    sheet_names: Optional[str] = None
    row_count: Optional[int] = None
    col_count: Optional[int] = None
    updated_at: Optional[datetime] = None


class FileUploadResponse(BaseModel):
    id: str
    file_name: str
    file_size: int
    sheet_names: Optional[str] = None
    updated_at: Optional[datetime] = None
    accessed_at: Optional[datetime] = None
    message: str = "上传成功"
