# backend/app/analyze/router.py
"""
数据分析模式路由（原大文件模式）
文件留在服务端，加载到 DuckDB，AI 执行 SQL 分析
"""
from fastapi import APIRouter, UploadFile, File, HTTPException, Query, Depends
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..large_file.storage import large_file_storage
from ..large_file.large_file_agent import large_file_agent_manager
# 旧报表模块已迁移至 backend/app/report/
from ..large_file.schemas import (
    LARGE_FILE_THRESHOLD_BYTES,
    PREVIEW_ROW_COUNT,
    OperationRequest,
    FileStatus
)
from ..core.database import get_db
from ..core.dependencies import get_optional_user
from ..utils.logger import get_logger

logger = get_logger('analyze_router')

router = APIRouter(prefix="/api/analyze", tags=["数据分析"])


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    user_id: str = Depends(get_optional_user)
):
    """
    上传 Excel 文件用于分析
    
    - 文件保存到 uploads/YYYY-MM-DD/ 目录
    - 返回文件ID和预览数据
    - 自动加载到 DuckDB
    """
    logger.info(f"收到文件上传请求: {file.filename}, user_id={user_id}")
    
    # 验证文件类型
    if not file.filename.endswith(('.xlsx', '.xls', '.xlsm')):
        logger.warning(f"文件类型不支持: {file.filename}")
        raise HTTPException(status_code=400, detail="只支持 Excel 文件格式（.xlsx, .xls, .xlsm）")
    
    # 保存文件
    try:
        file_id = await large_file_storage.save_file(file)
        logger.info(f"文件上传成功: {file.filename} -> {file_id}")
        
        # 获取文件状态（包含预览数据）
        file_status = await large_file_storage.get_file_status(file_id)
        
        return {
            "file_id": file_id,
            "file_name": file_status.original_name,
            "file_size": file_status.file_size_bytes,
            "sheet_names": file_status.sheet_names,
            "preview_data": file_status.preview_data,
            "row_count": file_status.row_count,
            "column_count": file_status.column_count,
            "duckdb_ready": file_status.duckdb_ready,
            "upload_time": file_status.upload_time.isoformat()
        }
    except ValueError as e:
        logger.error(f"文件上传失败: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"文件上传失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="文件上传失败，请稍后重试。")


@router.get("/{file_id}/preview")
async def get_file_preview(file_id: str):
    """
    获取文件预览数据
    
    - 返回前 500 行数据
    - 包含文件元数据和 DuckDB 状态
    """
    try:
        file_status = await large_file_storage.get_file_status(file_id)
        
        return {
            "file_id": file_id,
            "file_name": file_status.original_name,
            "file_size": file_status.file_size_bytes,
            "sheet_names": file_status.sheet_names,
            "preview_data": file_status.preview_data,
            "row_count": file_status.row_count,
            "column_count": file_status.column_count,
            "duckdb_ready": file_status.duckdb_ready,
            "upload_time": file_status.upload_time.isoformat()
        }
    except ValueError as e:
        logger.error(f"获取文件预览失败: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"获取文件预览失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="获取文件预览失败，请稍后重试。")


@router.post("/{file_id}/operation/stream")
async def execute_operation_stream(file_id: str, operation: OperationRequest):
    """
    执行 AI 分析操作（SSE 流式响应）
    
    - instruction: 用户指令
    - 返回 SSE 流，包含 AI 分析过程和结果
    """
    logger.info(f"[{file_id}] 收到分析指令: {operation.instruction[:100]}")
    
    # 验证文件是否存在
    try:
        await large_file_storage.get_file_status(file_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    
    # 返回 SSE 流
    return StreamingResponse(
        large_file_agent_manager.handle_operation_stream(file_id, operation),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@router.get("/{file_id}/status")
async def get_file_status(file_id: str):
    """
    获取文件状态
    
    - DuckDB 就绪状态
    - 文件元数据
    - 结果文件列表
    """
    try:
        file_status = await large_file_storage.get_file_status(file_id)
        result_files = await large_file_storage.list_result_files(file_id)
        
        return {
            "file_id": file_id,
            "file_name": file_status.original_name,
            "file_size": file_status.file_size_bytes,
            "sheet_names": file_status.sheet_names,
            "row_count": file_status.row_count,
            "column_count": file_status.column_count,
            "duckdb_ready": file_status.duckdb_ready,
            "upload_time": file_status.upload_time.isoformat(),
            "result_files": result_files
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"获取文件状态失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="获取文件状态失败，请稍后重试。")


@router.get("/{file_id}/results")
async def list_result_files(file_id: str):
    """
    列出结果文件
    
    - 返回所有 AI 生成的结果文件列表
    """
    try:
        result_files = await large_file_storage.list_result_files(file_id)
        return {
            "file_id": file_id,
            "result_files": result_files
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"列出结果文件失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="列出结果文件失败，请稍后重试。")


@router.get("/{file_id}/results/{result_id}/download")
async def download_result_file(file_id: str, result_id: str):
    """
    下载结果文件
    
    - result_id: 结果文件ID
    - 返回文件流
    """
    try:
        file_path, filename = await large_file_storage.get_result_file_path(file_id, result_id)
        
        return FileResponse(
            path=str(file_path),
            filename=filename,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"下载结果文件失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="下载结果文件失败，请稍后重试。")


# 旧报表端点已迁移至 /api/report/ 路由（backend/app/report/router.py）
