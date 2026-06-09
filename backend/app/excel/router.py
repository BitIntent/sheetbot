# backend/app/excel/router.py
"""
普通 Excel 编辑模式路由
前端下载文件到浏览器，使用 ExcelJS 操作，AI 通过工具编辑
"""
import uuid
import json
from fastapi import APIRouter, HTTPException, Request, Depends, UploadFile, File, Form
from fastapi.responses import StreamingResponse
import io

from sqlalchemy.ext.asyncio import AsyncSession

from ..sse_handler import sse_connection_manager
from ..agent.excel_agent import agent_manager
from ..core.database import get_db
from ..core.dependencies import get_optional_user, get_optional_user_info
from ..core.quota import QuotaGuard
from ..core.usage_service import increment_usage
from ..models.schemas import MessageType
from ..utils.logger import get_logger
from .chart_inject import inject_native_charts
from .prompt_suggest import suggest_prompts_for_workbook

logger = get_logger('excel_router')

router = APIRouter(prefix="/api/excel", tags=["Excel编辑"])

def _classify_error_hint(operation_type: str, errors: list) -> str:
    text = " ".join(str(e) for e in (errors or []))
    lower = text.lower()
    op = str(operation_type or "").lower()
    if any(k in lower for k in ("chart", "图表", "datarange", "data_range", "饼图", "柱状图")) or op == "create_chart":
        return "图表数据区需要补齐（分类列/数值列/有效范围）。"
    if any(k in lower for k in ("sumcol", "groupbycol", "数值密度", "唯一", "聚合", "统计")) or "summarize" in op:
        return "统计指标列需要调整为更稳定的业务数值列。"
    if any(k in lower for k in ("startrow", "endrow", "startcol", "endcol", "required", "missing", "参数", "类型")):
        return "参数结构需要微调（范围、行列或类型）。"
    return "当前步骤需要微调参数后继续。"


@router.get("/session")
async def create_session(user_info=Depends(get_optional_user_info)):
    """
    创建新会话
    
    - 生成唯一的 session_id
    - 用于后续 SSE 连接和操作
    """
    user_id, username = user_info
    session_id = str(uuid.uuid4())
    user_tag = username or user_id or "anonymous"
    logger.info(f"创建新会话: session_id={session_id}, user={user_tag}")

    # 提前绑定用户标识，SSE 连接建立时 handler 可直接继承
    if username or user_id:
        sse_connection_manager.bind_user(session_id, username or user_id)

    return {
        "session_id": session_id
    }


@router.post("/command")
async def send_command(
    request: Request,
    _quota=Depends(QuotaGuard("ai_daily")),
    user_info=Depends(get_optional_user_info),
    db: AsyncSession = Depends(get_db),
):
    """发送 AI 指令（通过 SSE 接收结果）"""
    user_id, username = user_info
    payload = await request.json()
    session_id = payload.get("session_id")

    if not session_id:
        raise HTTPException(status_code=400, detail="session_id 不能为空")

    handler = await sse_connection_manager.get_handler(session_id)
    if not handler:
        raise HTTPException(status_code=409, detail="SSE 未连接")

    # 首次 command 绑定用户标识到 session & handler（后续日志自动携带）
    user_tag = username or user_id
    if user_tag:
        sse_connection_manager.bind_user(session_id, user_tag)
        handler.bind_user_tag(user_tag)

    await handler.handle_user_command(payload)
    if user_id:
        await increment_usage(user_id, "ai_count", db)
    context = payload.get("context") if isinstance(payload, dict) else None
    context_version = payload.get("contextVersion") if isinstance(payload, dict) else None
    if isinstance(context, dict):
        sheets = context.get("sheets") if isinstance(context.get("sheets"), list) else []
        logger.info(
            f"[{session_id}] command payload context: version={context_version}, keys={list(context.keys())}, sheets={len(sheets)}, activeSheet={context.get('activeSheet')}"
        )
    else:
        logger.warning(f"[{session_id}] command payload context missing or invalid")
    logger.info(f"[{session_id}] AI 指令已发送")

    return {"status": "ok"}


@router.post("/state")
async def update_state(request: Request):
    """
    更新 Excel 状态
    
    - session_id: 会话ID
    - context: Excel 上下文（sheets, activeSheet, 等）
    """
    payload = await request.json()
    session_id = payload.get("session_id")
    context = payload.get("context", {})
    context_version = payload.get("contextVersion")
    
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id 不能为空")
    
    handler = await sse_connection_manager.get_handler(session_id)
    if not handler:
        raise HTTPException(status_code=409, detail="SSE 未连接")
    
    await handler.handle_excel_state({
        "context": context,
        "contextVersion": context_version,
    })
    logger.debug(f"[{session_id}] Excel 状态已更新: version={context_version}")
    
    return {"status": "ok"}


@router.post("/operation-result")
async def receive_operation_result(request: Request):
    """
    接收前端只读查询的计算结果，回填到等待中的 QueryBridge Future。

    - session_id: 会话ID
    - query_id: 查询标识（由 data_query SSE 消息携带）
    - result: 前端计算后的结果对象
    """
    payload = await request.json()
    session_id = payload.get("session_id")
    query_id = payload.get("query_id")
    result = payload.get("result", {})

    if not session_id or not query_id:
        raise HTTPException(status_code=400, detail="session_id / query_id 不能为空")

    handler = await sse_connection_manager.get_handler(session_id)
    if not handler:
        raise HTTPException(status_code=409, detail="SSE 未连接")

    await handler.resolve_data_query(query_id, result)
    return {"status": "ok"}


@router.post("/suggest-prompts")
async def suggest_prompts(
    request: Request,
    _quota=Depends(QuotaGuard("ai_daily")),
    user_info=Depends(get_optional_user_info),
    db: AsyncSession = Depends(get_db),
):
    """
    根据前端汇总的工作簿元数据，由 LLM 生成 5 条可执行的中文指令建议。
    消耗与发一条 AI 指令相同的日配额（ai_daily / ai_count）。
    """
    user_id, username = user_info
    payload = await request.json()
    metadata = payload.get("metadata")
    if metadata is None or not isinstance(metadata, dict):
        raise HTTPException(status_code=400, detail="metadata 必须为非空对象")

    try:
        suggestions = await suggest_prompts_for_workbook(metadata)
    except Exception as e:
        logger.error("suggest-prompts LLM 失败: %s", e, exc_info=True)
        raise HTTPException(status_code=502, detail="生成指令建议失败，请稍后重试") from e

    if user_id:
        await increment_usage(user_id, "ai_count", db)
    logger.info("suggest-prompts 成功 user=%s count=%s", username or user_id, len(suggestions))
    return {"suggestions": suggestions}


@router.post("/operation-error")
async def receive_operation_error(request: Request):
    """
    接收前端操作错误反馈并通知 Agent
    
    - session_id: 会话ID
    - operation: 失败的操作
    - errors: 错误列表
    - workbook_state: 当前工作簿状态
    """
    try:
        payload = await request.json()
        session_id = payload.get("session_id")
        operation = payload.get("operation", {})
        errors = payload.get("errors", [])
        timestamp = payload.get("timestamp")
        workbook_state = payload.get("workbook_state", {})
        
        if not session_id:
            raise HTTPException(status_code=400, detail="session_id 不能为空")
        
        op_type = operation.get('type', 'unknown')
        user_tag = sse_connection_manager.get_user_tag(session_id) if session_id else ""

        # 记录错误日志
        logger.warning(
            f"[{session_id}] 前端操作验证失败: "
            f"operation={op_type}, "
            f"errors={errors}, "
            f"workbook_state_sheets={list(workbook_state.get('sheets', {}).keys()) if isinstance(workbook_state.get('sheets'), dict) else 'N/A'}"
        )
        
        # 记录详细的操作参数（用于调试）
        logger.debug(
            f"[{session_id}] 操作参数详情: {json.dumps(operation, ensure_ascii=False, indent=2)}"
        )
        
        # 通知 Agent 操作失败（错误反馈闭环）
        handler = await sse_connection_manager.get_handler(session_id)
        if handler:
            # 构建提示型消息（避免生硬失败观感）
            error_details = "\n".join(f"  • {err}" for err in errors) if errors else "当前步骤参数需调整"
            scene_hint = _classify_error_hint(op_type, errors)
            error_message = (
                "提示：当前步骤需要调整，我已为你定位到可恢复路径。\n\n"
                f"**涉及操作**: {op_type}\n"
                f"**问题类型**: {scene_hint}\n"
                f"**建议修正**:\n{error_details}\n\n"
                "你可以继续描述目标，我会按修正后的路径自动完成。"
            )
            
            # 发送错误消息到前端（显示在 AI 助手窗口）
            await handler._send_message(MessageType.AI_ERROR, {
                "error": error_message,
                "operationType": op_type,
                "errors": errors
            })
            
            logger.info(f"[{session_id}] 已将操作错误反馈到前端: {op_type}")
        else:
            logger.warning(f"[{session_id}] 无法发送错误反馈：SSE 未连接")
        
        return {"status": "ok", "message": "错误反馈已接收并通知"}
    except Exception as e:
        logger.error(f"接收操作错误反馈时出错: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="处理请求失败，请稍后重试。")


@router.post("/inject-charts")
async def inject_charts(
    file: UploadFile = File(..., description="ExcelJS 生成的 xlsx 文件"),
    charts: str = Form(..., description="图表元数据 JSON，格式: { sheetName: [chartMeta, ...] }"),
):
    """
    向 xlsx 文件注入原生 Excel 图表对象（替代图片嵌入）

    - file: 前端 ExcelJS 生成的基础 xlsx（含数据/样式，无图表）
    - charts: JSON 字符串，结构为 { sheetName: [{ chartType, dataRange, title, row, col, width, height }] }

    返回注入原生图表后的 xlsx 文件流。
    """
    try:
        xlsx_bytes = await file.read()
        charts_by_sheet = json.loads(charts)

        if not isinstance(charts_by_sheet, dict):
            raise HTTPException(status_code=400, detail="charts 格式错误，期望 { sheetName: [...] }")

        result_bytes = inject_native_charts(xlsx_bytes, charts_by_sheet)

        return StreamingResponse(
            io.BytesIO(result_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": 'attachment; filename="workbook.xlsx"'},
        )
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail="charts JSON 解析失败，请稍后重试。")
    except Exception as e:
        logger.error(f"[inject-charts] 注入失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="操作失败，请稍后重试。")


@router.get("/tools")
async def list_tools():
    """
    列出可用的 Excel 工具
    
    - 按类别组织工具列表
    - 用于前端展示工具能力
    """
    from ..agent.excel_tools import EXCEL_TOOL_NAMES
    
    # 工具分类
    tool_categories = {
        "cell": [],
        "range": [],
        "row_column": [],
        "sheet": [],
        "data": [],
        "formatting": [],
        "analysis": [],
        "validation": [],
        "comment": [],
        "hyperlink": [],
        "image": [],
        "shape": [],
        "chart": [],
        "pivot_table": [],
        "batch": []
    }
    
    for tool_name in EXCEL_TOOL_NAMES:
        short_name = tool_name.replace("mcp__excel-tools__", "")
        
        if short_name.startswith("set_cell") or short_name == "clear_cell":
            tool_categories["cell"].append(short_name)
        elif short_name.startswith("set_range") or short_name in ["clear_range", "merge_cells", "unmerge_cells"]:
            tool_categories["range"].append(short_name)
        elif any(x in short_name for x in ["row", "column", "auto_fit"]):
            tool_categories["row_column"].append(short_name)
        elif short_name in ["add_sheet", "rename_sheet", "copy_sheet", "set_active_sheet"]:
            tool_categories["sheet"].append(short_name)
        elif short_name in ["sort_range", "filter_data", "remove_filter", "find_replace", "copy_paste", "fill_series", "remove_duplicates"]:
            tool_categories["data"].append(short_name)
        elif short_name in ["conditional_format", "clear_formatting"]:
            tool_categories["formatting"].append(short_name)
        elif short_name in ["create_pivot_data", "calculate_statistics"]:
            tool_categories["analysis"].append(short_name)
        elif "validation" in short_name:
            tool_categories["validation"].append(short_name)
        elif "comment" in short_name:
            tool_categories["comment"].append(short_name)
        elif "hyperlink" in short_name:
            tool_categories["hyperlink"].append(short_name)
        elif "image" in short_name:
            tool_categories["image"].append(short_name)
        elif "shape" in short_name:
            tool_categories["shape"].append(short_name)
        elif "chart" in short_name:
            tool_categories["chart"].append(short_name)
        elif "pivot_table" in short_name:
            tool_categories["pivot_table"].append(short_name)
        elif short_name == "batch_operations":
            tool_categories["batch"].append(short_name)
    
    return {
        "total": len(EXCEL_TOOL_NAMES),
        "categories": tool_categories
    }
