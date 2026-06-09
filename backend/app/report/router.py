# backend/app/report/router.py
"""
报表 API 路由
"""
import json
import re
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.dependencies import get_current_user
from ..core.database import get_db
from ..core.quota import QuotaGuard
from ..core.usage_service import increment_usage
from .analyzer import analyze_file_structure, recommend_template
from .templates import get_all_templates, get_template
from .assembler import generate_report
from .cache import get_cached_report, persist_report_cache
from .share_service import (
    create_share,
    get_shared_report,
    list_user_reports,
    get_user_report_detail,
    delete_user_report,
    upsert_user_report,
    assert_report_share_target_accessible,
)
from .task_manager import report_task_manager
from ..utils.logger import get_logger
from ..files import service as file_service
from ..large_file.storage import large_file_storage
from ..large_file.large_file_duckdb import duckdb_manager

logger = get_logger('report.router')

router = APIRouter(prefix="/api/report", tags=["report"])
SAFE_PUBLIC_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


async def _ensure_user_file_access(db: AsyncSession, user_id: str, file_id: str) -> None:
    try:
        await file_service.assert_active_file_owned(db, user_id, file_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="文件不存在或无权限访问")


def _has_source_tables(file_id: str) -> bool:
    try:
        tables = duckdb_manager.list_available_tables(file_id)
        return any(t.get("type") == "source" for t in tables)
    except Exception:
        return False


def _find_analysis_file_id_by_user_file_id(user_file_id: str) -> Optional[str]:
    """
    通过 user_file_id 反查可用于 DuckDB 分析的会话 file_id。
    仅返回存在 source 表缓存的会话，避免命中结果占位文件。
    """
    try:
        metas = list(large_file_storage.list_files() or [])
    except Exception:
        metas = []

    candidates = [
        m for m in metas
        if getattr(m, "source_file_id", None) == user_file_id
    ]
    candidates.sort(
        key=lambda m: getattr(m, "last_accessed", None) or getattr(m, "created_at", None),
        reverse=True,
    )
    for meta in candidates:
        fid = getattr(meta, "file_id", None)
        if fid and _has_source_tables(fid):
            return fid

    # 懒加载：候选会话存在但尚未入 DuckDB 时，自动加载一次。!
    for meta in candidates:
        fid = getattr(meta, "file_id", None)
        file_path = getattr(meta, "file_path", None)
        if not fid or not file_path:
            continue
        # 若该会话仍在后台加载中，禁止前台懒加载抢跑，避免并发导入冲突
        if not getattr(meta, "duckdb_ready", False):
            logger.info("报表会话仍在后台加载中，跳过懒加载: fid=%s", fid)
            continue
        try:
            duckdb_manager.load_all_sheets(file_path, fid)
            if _has_source_tables(fid):
                return fid
        except Exception as exc:
            logger.warning("报表会话懒加载失败: fid=%s err=%s", fid, exc)
    return None


async def _resolve_report_file_context(
    db: AsyncSession,
    user_id: str,
    file_id: str,
    options: Optional[dict] = None,
) -> tuple[str, str]:
    """
    解析报表请求中的 file_id：
    - user_file_id（文件管理ID）: 用于权限校验与缓存归属
    - analysis_file_id（大文件会话ID）: 用于 DuckDB 分析
    """
    opts = options or {}
    hinted_user_file_id = opts.get("source_file_id") or opts.get("user_file_id")

    # file_id 本身就是用户文件ID
    try:
        await file_service.assert_active_file_owned(db, user_id, file_id)
        analysis_file_id = (
            file_id
            if _has_source_tables(file_id)
            else (_find_analysis_file_id_by_user_file_id(file_id) or file_id)
        )
        return analysis_file_id, file_id
    except ValueError:
        pass

    # file_id 是大文件会话ID
    meta = large_file_storage.get_metadata(file_id)
    if meta and getattr(meta, "source_file_id", None):
        source_file_id = meta.source_file_id
        await file_service.assert_active_file_owned(db, user_id, source_file_id)
        return file_id, source_file_id

    # 回退使用 options 中显式传入的 user_file_id/source_file_id
    if hinted_user_file_id:
        await file_service.assert_active_file_owned(db, user_id, hinted_user_file_id)
        analysis_file_id = _find_analysis_file_id_by_user_file_id(hinted_user_file_id) or hinted_user_file_id
        return analysis_file_id, hinted_user_file_id

    raise HTTPException(status_code=404, detail="文件不存在或无权限访问")


def _is_safe_public_token(token: str) -> bool:
    return bool(token and SAFE_PUBLIC_TOKEN_RE.match(token))


async def _persist_cache_with_candidates(
    db: AsyncSession,
    user_id: str,
    template_key: str,
    options: dict,
    report_data: dict,
    fallback_file_id: str,
) -> str:
    """
    按候选 file_id 依次尝试写缓存，优先使用 user_files.id 语义字段。
    """
    candidates = [
        options.get("source_file_id"),
        options.get("user_file_id"),
        report_data.get("source_file_id"),
        report_data.get("user_file_id"),
        fallback_file_id,
    ]
    deduped = []
    for item in candidates:
        if item and item not in deduped:
            deduped.append(item)

    last_error = None
    for candidate in deduped:
        try:
            await persist_report_cache(
                db,
                user_id,
                candidate,
                template_key,
                options,
                report_data,
            )
            return candidate
        except Exception as exc:
            last_error = exc
            logger.warning("缓存写入候选 file_id 失败: user_id=%s file_id=%s err=%s", user_id, candidate, exc)

    raise RuntimeError(f"所有缓存 file_id 候选均失败: {last_error}")


# ────────────────────────────────────────────
# 公开端点（无需 auth）
# ────────────────────────────────────────────
public_router = APIRouter(prefix="/api/share", tags=["share"])


@public_router.get("/report/{share_token}")
async def get_public_report(share_token: str, db: AsyncSession = Depends(get_db)):
    """公开访问报表（无需登录）"""
    if not _is_safe_public_token(share_token):
        raise HTTPException(status_code=404, detail="报表不存在或已过期")
    data = await get_shared_report(db, share_token)
    if not data:
        raise HTTPException(status_code=404, detail="报表不存在或已过期")
    return data


# ────────────────────────────────────────────
# 需要 auth 的端点
# ────────────────────────────────────────────

@router.get("/templates")
async def list_templates():
    """获取所有可用的报表模板"""
    return {"templates": get_all_templates()}


@router.post("/analyze-structure/{file_id}")
async def analyze_structure(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """分析数据结构 + 推荐模板"""
    analysis_file_id, user_file_id = await _resolve_report_file_context(db, user.id, file_id)
    try:
        structure = analyze_file_structure(analysis_file_id)
        recommended = recommend_template(structure)
        return {
            "structure": structure,
            "recommended_template": recommended,
            "templates": get_all_templates(),
            "file_id": user_file_id,
            "analysis_file_id": analysis_file_id,
        }
    except Exception as e:
        logger.error(f"数据结构分析失败: file_id={file_id}, error={e}")
        raise HTTPException(status_code=500, detail="分析失败，请稍后重试。")


@router.post("/generate")
async def generate_report_sse(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _quota=Depends(QuotaGuard("report_monthly")),
):
    """
    生成报表（SSE 流式返回）。
    请求体: { "file_id": "...", "template_key": "overview", "options": {...} }
    """
    body = await request.json()
    file_id = body.get("file_id")
    template_key = body.get("template_key", "auto")
    options = body.get("options") or {}

    if not file_id:
        raise HTTPException(status_code=400, detail="file_id 不能为空")
    await increment_usage(user.id, "report_count", db)
    analysis_file_id, user_file_id = await _resolve_report_file_context(db, user.id, file_id, options)
    options = dict(options)
    options.setdefault("source_file_id", user_file_id)
    options.setdefault("user_file_id", user_file_id)
    options["_runtime_file_id"] = analysis_file_id

    async def event_stream():
        try:
            cache_record, cached_report = await get_cached_report(db, user_file_id, template_key, options)
            if cached_report:
                cached_diag = {}
                if isinstance(cached_report, dict):
                    cached_diag = cached_report.get("insights", {}).get("diagnostics", {}) if isinstance(cached_report.get("insights"), dict) else {}
                # 避免命中“兜底洞察”缓存导致文案长期千篇一律
                if cached_diag.get("insight_source") == "fallback":
                    logger.info(
                        "跳过 fallback 报表缓存: user_id=%s file_id=%s template=%s cache_id=%s reason=%s",
                        user.id,
                        user_file_id,
                        template_key,
                        getattr(cache_record, "id", None),
                        cached_diag.get("fallback_reason") or "unknown",
                    )
                else:
                    # 命中缓存时也同步写入个人报表，确保历史清单可见。
                    try:
                        await upsert_user_report(
                            db=db,
                            user_id=user.id,
                            report_data=cached_report,
                            source_file_id=options.get("source_file_id") or options.get("user_file_id"),
                            report_cache_id=getattr(cache_record, "id", None),
                        )
                    except Exception as save_err:
                        logger.warning("缓存命中同步个人报表失败: %s", save_err)
                    logger.info(
                        "报表缓存命中: user_id=%s file_id=%s template=%s cache_id=%s insight_source=%s fallback_reason=%s",
                        user.id,
                        user_file_id,
                        template_key,
                        getattr(cache_record, "id", None),
                        cached_diag.get("insight_source", "unknown"),
                        cached_diag.get("fallback_reason") or cached_diag.get("stream_reason") or "n/a",
                    )
                    yield f"data: {json.dumps({'event': 'complete', 'data': cached_report}, ensure_ascii=False, default=str)}\n\n"
                    return

            async for event in generate_report(user_file_id, template_key, options):
                if event.get("event") == "complete":
                    try:
                        report_data = event.get("data", {}) or {}
                        insight_diag = {}
                        if isinstance(report_data.get("insights"), dict):
                            insight_diag = report_data["insights"].get("diagnostics", {})
                        # 不缓存 fallback 洞察，避免固定文案反复命中
                        if insight_diag.get("insight_source") == "fallback":
                            logger.info(
                                "跳过 fallback 报表写缓存: user_id=%s report_id=%s file_id=%s template=%s reason=%s",
                                user.id,
                                report_data.get("report_id"),
                                user_file_id,
                                template_key,
                                insight_diag.get("fallback_reason") or "unknown",
                            )
                            # 即使跳过缓存，也要写入个人报表记录，否则历史清单不可见。
                            try:
                                await upsert_user_report(
                                    db=db,
                                    user_id=user.id,
                                    report_data=report_data,
                                    source_file_id=options.get("source_file_id") or options.get("user_file_id"),
                                    report_cache_id=None,
                                )
                            except Exception as save_err:
                                logger.warning("fallback 个人报表保存失败: %s", save_err)
                            yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
                            continue
                        cache_file_id = await _persist_cache_with_candidates(
                            db=db,
                            user_id=user.id,
                            template_key=template_key,
                            options=options,
                            report_data=report_data,
                            fallback_file_id=user_file_id,
                        )
                        await upsert_user_report(
                            db=db,
                            user_id=user.id,
                            report_data=report_data,
                            source_file_id=options.get("source_file_id") or options.get("user_file_id"),
                            report_cache_id=report_data.get("report_id"),
                        )
                        logger.info(
                            "报表生成完成并写入缓存: user_id=%s report_id=%s file_id=%s template=%s insight_source=%s fallback_reason=%s",
                            user.id,
                            report_data.get("report_id"),
                            cache_file_id,
                            template_key,
                            insight_diag.get("insight_source", "unknown"),
                            insight_diag.get("fallback_reason") or insight_diag.get("stream_reason") or "n/a",
                        )
                    except Exception as exc:
                        logger.warning(f"报表缓存失败: {exc}")
                        try:
                            await upsert_user_report(
                                db=db,
                                user_id=user.id,
                                report_data=report_data,
                                source_file_id=options.get("source_file_id") or options.get("user_file_id"),
                                report_cache_id=None,
                            )
                        except Exception as save_err:
                            logger.warning("个人报表保存失败: %s", save_err)
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
        except Exception as e:
            logger.error(f"报表生成流错误: {e}")
            yield f"data: {json.dumps({'event': 'error', 'data': {'message': '报表生成失败，请稍后重试。'}}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{report_id}/share")
async def share_report(
    report_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """创建分享链接"""
    body = await request.json()
    report_data = body.get("report_data")
    if not report_data:
        raise HTTPException(status_code=400, detail="report_data 不能为空")

    # 仅使用 user_files.id 语义字段，避免将 large_file 会话 file_id 误当外键
    source_file_id = (
        body.get("source_file_id")
        or report_data.get("source_file_id")
        or report_data.get("user_file_id")
    )
    report_data["report_id"] = report_id
    try:
        await assert_report_share_target_accessible(db, user.id, report_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    result = await create_share(db, user.id, source_file_id, report_data)
    return result


@router.get("/list")
async def list_reports(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出当前用户的所有报表"""
    reports = await list_user_reports(db, user.id)
    logger.info("历史报表查询: user_id=%s count=%s", user.id, len(reports or []))
    return {"reports": reports}


@router.get("/{report_id}")
async def get_report_detail(
    report_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户某个报表详情。"""
    data = await get_user_report_detail(db, user.id, report_id)
    if not data:
        raise HTTPException(status_code=404, detail="报表不存在或已删除")
    return data


@router.delete("/{report_id}")
async def delete_report(
    report_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除（软删）当前用户报表。"""
    deleted = await delete_user_report(db, user.id, report_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="报表不存在或已删除")
    return {"ok": True}


# ────────────────────────────────────────────
# 异步报表生成
# ────────────────────────────────────────────

@router.post("/generate-async")
async def generate_report_async(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """提交异步报表生成任务"""
    body = await request.json()
    file_id = body.get("file_id")
    template_key = body.get("template_key", "auto")
    options = body.get("options") or {}

    if not file_id:
        raise HTTPException(status_code=400, detail="file_id 不能为空")
    analysis_file_id, user_file_id = await _resolve_report_file_context(db, user.id, file_id, options)
    options = dict(options)
    options.setdefault("source_file_id", user_file_id)
    options.setdefault("user_file_id", user_file_id)
    options["_runtime_file_id"] = analysis_file_id

    try:
        task_id = await report_task_manager.submit_task(
            user_id=user.id,
            file_id=user_file_id,
            template_key=template_key,
            options=options,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    return {"task_id": task_id, "status": "pending", "message": "报表生成任务已提交"}


@router.get("/task/{task_id}")
async def get_task_status(
    task_id: str,
    user: User = Depends(get_current_user),
):
    """查询任务状态"""
    try:
        status = await report_task_manager.assert_task_owned(task_id, user.id)
    except ValueError:
        raise HTTPException(status_code=404, detail="任务不存在")
    return status


@router.get("/tasks")
async def list_tasks(
    user: User = Depends(get_current_user),
):
    """列出用户的所有报表任务"""
    tasks = await report_task_manager.list_user_tasks(user.id)
    return {"tasks": tasks}
