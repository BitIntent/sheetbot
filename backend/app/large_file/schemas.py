# 大型文件处理相关数据模型
from pydantic import BaseModel, Field
from typing import Optional, Dict, List, Any
from enum import Enum
from datetime import datetime


class FileStatus(str, Enum):
    """文件状态枚举"""
    UPLOADING = "uploading"
    READY = "ready"
    PROCESSING = "processing"
    ERROR = "error"
    DELETED = "deleted"


class FileMetadata(BaseModel):
    """文件元数据"""
    file_id: str
    original_name: str
    file_path: str
    file_size: int  # 字节
    source_file_id: Optional[str] = None  # 结果文件关联的源文件ID
    status: FileStatus = FileStatus.READY
    created_at: datetime = Field(default_factory=datetime.now)
    last_accessed: datetime = Field(default_factory=datetime.now)
    sheet_names: List[str] = []
    sheet_row_counts: Dict[str, int] = {}  # 每个工作表的行数 {sheet_name: row_count}
    row_count: int = 0  # 所有工作表行数总和
    col_count: int = 0
    error_message: Optional[str] = None
    duckdb_ready: bool = False  # 全部工作表是否加载完成
    first_page_ready: bool = False  # 第一张工作表是否已加载（可提前渲染）
    duckdb_load_started_at: Optional[datetime] = None
    duckdb_load_finished_at: Optional[datetime] = None
    duckdb_load_stage: Optional[str] = None
    duckdb_load_progress: Optional[int] = None


class UploadResponse(BaseModel):
    """上传响应"""
    file_id: str
    original_name: str
    file_size: int
    sheet_names: List[str]
    sheet_row_counts: Dict[str, int] = {}  # 每个工作表的行数 {sheet_name: row_count}
    row_count: int  # 所有工作表行数总和
    col_count: int
    preview: Dict[str, Any]  # TOP500 预览数据
    duckdb_ready: bool = False  # DuckDB 是否加载完成（大文件异步加载）


class PreviewResponse(BaseModel):
    """预览数据响应"""
    file_id: str
    sheet_name: str
    headers: List[str]
    data: List[List[Any]]  # TOP500 行数据
    total_rows: int
    total_cols: int


class OperationRequest(BaseModel):
    """操作请求"""
    file_id: str
    command: str
    session_id: Optional[str] = None


class OperationResponse(BaseModel):
    """操作响应"""
    success: bool
    message: str
    preview: Optional[Dict[str, Any]] = None  # 更新后的预览
    error: Optional[str] = None


class FileStatusResponse(BaseModel):
    """文件状态响应"""
    file_id: str
    status: FileStatus
    original_name: str
    file_size: int
    sheet_names: List[str]
    sheet_row_counts: Dict[str, int] = {}  # 每个工作表的行数
    row_count: int  # 所有工作表行数总和
    col_count: int
    created_at: datetime
    last_accessed: datetime
    error_message: Optional[str] = None
    duckdb_ready: bool = False  # DuckDB 是否加载完成
    duckdb_load_stage: Optional[str] = None  # DuckDB 加载阶段描述
    duckdb_load_progress: Optional[int] = None  # DuckDB 加载进度 (0-100)
    duckdb_load_time_seconds: Optional[float] = None  # DuckDB 加载耗时（秒）


# 大文件阈值常量
LARGE_FILE_THRESHOLD_MB = 50
LARGE_FILE_THRESHOLD_BYTES = LARGE_FILE_THRESHOLD_MB * 1024 * 1024  # 50MB

# 预览行数
PREVIEW_ROW_COUNT = 500
