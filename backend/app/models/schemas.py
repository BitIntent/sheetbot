# backend/app/models/schemas.py
"""
Pydantic models for request/response schemas
"""
from typing import Any, Optional, List, Dict, Union
from pydantic import BaseModel, Field
from enum import Enum
from datetime import datetime


class MessageType(str, Enum):
    """WebSocket message types"""
    # Client -> Server
    USER_COMMAND = "user_command"
    EXCEL_STATE = "excel_state"
    SAVE_REQUEST = "save_request"
    
    # Server -> Client
    AI_RESPONSE = "ai_response"
    EXCEL_OPERATION = "excel_operation"
    AI_THINKING = "ai_thinking"
    AI_ERROR = "ai_error"
    SAVE_RESULT = "save_result"
    OPERATION_COMPLETE = "operation_complete"
    CONNECTION_READY = "connection_ready"
    ACK = "ack"
    
    # 只读数据查询（后端 → 前端请求全表计算结果）
    DATA_QUERY = "data_query"

    # Backend Progress (大文件模式后端操作进度反馈)
    BACKEND_PROGRESS = "backend_progress"


class CellPosition(BaseModel):
    """Cell position model"""
    row: int
    col: int
    sheet: Optional[str] = None


class CellRange(BaseModel):
    """Cell range model"""
    startRow: int
    startCol: int
    endRow: int
    endCol: int
    sheet: Optional[str] = None


class CellStyle(BaseModel):
    """Cell style model"""
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    fontSize: Optional[int] = None
    fontColor: Optional[str] = None
    backgroundColor: Optional[str] = None
    horizontalAlignment: Optional[str] = None  # left, center, right
    verticalAlignment: Optional[str] = None    # top, middle, bottom
    numberFormat: Optional[str] = None
    border: Optional[Dict[str, Any]] = None
    wrapText: Optional[bool] = None


class ExcelOperationType(str, Enum):
    """Excel operation types"""
    # Cell operations
    SET_CELL_VALUE = "set_cell_value"
    SET_CELL_FORMULA = "set_cell_formula"
    SET_CELL_STYLE = "set_cell_style"
    CLEAR_CELL = "clear_cell"
    
    # Range operations
    SET_RANGE_VALUES = "set_range_values"
    SET_RANGE_STYLE = "set_range_style"
    CLEAR_RANGE = "clear_range"
    MERGE_CELLS = "merge_cells"
    UNMERGE_CELLS = "unmerge_cells"
    
    # Row/Column operations
    INSERT_ROW = "insert_row"
    DELETE_ROW = "delete_row"
    INSERT_COLUMN = "insert_column"
    DELETE_COLUMN = "delete_column"
    SET_ROW_HEIGHT = "set_row_height"
    SET_COLUMN_WIDTH = "set_column_width"
    HIDE_ROW = "hide_row"
    HIDE_COLUMN = "hide_column"
    SHOW_ROW = "show_row"
    SHOW_COLUMN = "show_column"
    
    # Sheet operations
    ADD_SHEET = "add_sheet"
    DELETE_SHEET = "delete_sheet"
    RENAME_SHEET = "rename_sheet"
    COPY_SHEET = "copy_sheet"
    SET_ACTIVE_SHEET = "set_active_sheet"
    
    # Data operations
    SORT_RANGE = "sort_range"
    FILTER_DATA = "filter_data"
    REMOVE_FILTER = "remove_filter"
    FIND_REPLACE = "find_replace"
    COPY_PASTE = "copy_paste"
    CUT_PASTE = "cut_paste"
    FILL_SERIES = "fill_series"
    REMOVE_DUPLICATES = "remove_duplicates"
    
    # Formatting operations
    AUTO_FIT_COLUMN = "auto_fit_column"
    AUTO_FIT_ROW = "auto_fit_row"
    CONDITIONAL_FORMAT = "conditional_format"
    CLEAR_FORMATTING = "clear_formatting"
    
    # Data analysis
    CREATE_PIVOT_DATA = "create_pivot_data"
    CALCULATE_STATISTICS = "calculate_statistics"
    SUMMARIZE_BY_COLUMN = "summarize_by_column"
    SUMMARIZE_METRICS_BY_COLUMN = "summarize_metrics_by_column"
    
    # Validation
    SET_DATA_VALIDATION = "set_data_validation"
    REMOVE_DATA_VALIDATION = "remove_data_validation"
    
    # Comment operations
    ADD_COMMENT = "add_comment"
    DELETE_COMMENT = "delete_comment"
    UPDATE_COMMENT = "update_comment"
    
    # Hyperlink operations
    SET_HYPERLINK = "set_hyperlink"
    REMOVE_HYPERLINK = "remove_hyperlink"
    
    # Image operations
    INSERT_IMAGE = "insert_image"
    DELETE_IMAGE = "delete_image"
    UPDATE_IMAGE = "update_image"
    
    # Shape operations
    INSERT_SHAPE = "insert_shape"
    DELETE_SHAPE = "delete_shape"
    UPDATE_SHAPE = "update_shape"
    
    # Chart operations
    CREATE_CHART = "create_chart"
    UPDATE_CHART = "update_chart"
    DELETE_CHART = "delete_chart"
    
    # Pivot table operations
    CREATE_PIVOT_TABLE = "create_pivot_table"
    UPDATE_PIVOT_TABLE = "update_pivot_table"
    DELETE_PIVOT_TABLE = "delete_pivot_table"
    
    # Custom formula
    APPLY_CUSTOM_FORMULA = "apply_custom_formula"
    
    # Batch operations
    BATCH_OPERATIONS = "batch_operations"


class ExcelOperation(BaseModel):
    """Single Excel operation"""
    type: ExcelOperationType
    params: Dict[str, Any] = Field(default_factory=dict)
    description: Optional[str] = None


class WebSocketMessage(BaseModel):
    """WebSocket message model"""
    type: MessageType
    payload: Dict[str, Any] = Field(default_factory=dict)
    timestamp: Optional[str] = None


class UserCommand(BaseModel):
    """User command from AI assistant"""
    command: str
    context: Optional[Dict[str, Any]] = None


class ExcelState(BaseModel):
    """Current Excel state"""
    sheets: List[Dict[str, Any]]
    activeSheet: str
    selection: Optional[CellRange] = None


class AIResponse(BaseModel):
    """AI response model"""
    message: str
    operations: List[ExcelOperation] = Field(default_factory=list)
    thinking: Optional[str] = None


class SaveRequest(BaseModel):
    """Save request model"""
    format: str  # "json" or "xlsx"
    filename: str
    data: Dict[str, Any]


class SaveResult(BaseModel):
    """Save result model"""
    success: bool
    filename: Optional[str] = None
    error: Optional[str] = None
    download_url: Optional[str] = None
