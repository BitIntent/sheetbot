# ============================================================================
# 自定义公式 - REST API
# GET    /api/formula/list
# POST   /api/formula
# PUT    /api/formula/{formula_id}
# DELETE /api/formula/{formula_id}
# ============================================================================
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.database import get_db
from ..core.dependencies import get_current_user
from ..core.quota import QuotaGuard
from . import service
from .schemas import (
    FormulaCreate,
    FormulaListResponse,
    FormulaParam,
    FormulaResponse,
    FormulaUpdate,
)

router = APIRouter(prefix="/api/formula", tags=["formula"])


def _to_response(f) -> FormulaResponse:
    """ORM -> Pydantic"""
    return FormulaResponse(
        id=f.id,
        name=f.name,
        label=f.label,
        description=f.description or "",
        expression=f.expression,
        params=[FormulaParam(**p) for p in f.get_params()],
        is_preset=f.is_preset,
        sort_order=f.sort_order,
    )


@router.get("/list", response_model=FormulaListResponse)
async def list_formulas(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户所有自定义公式"""
    formulas = await service.list_formulas(db, user.id)
    return FormulaListResponse(formulas=[_to_response(f) for f in formulas])


@router.post("", response_model=FormulaResponse, status_code=201)
async def create_formula(
    body: FormulaCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _quota=Depends(QuotaGuard("formula_count")),
):
    """新建公式"""
    formula = await service.create_formula(db, user.id, body)
    if formula is None:
        raise HTTPException(status_code=409, detail="同名公式已存在")
    await db.commit()
    return _to_response(formula)


@router.put("/{formula_id}", response_model=FormulaResponse)
async def update_formula(
    formula_id: str,
    body: FormulaUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """修改公式"""
    formula = await service.update_formula(db, user.id, formula_id, body)
    if not formula:
        raise HTTPException(status_code=404, detail="公式不存在")
    await db.commit()
    return _to_response(formula)


@router.delete("/{formula_id}")
async def delete_formula(
    formula_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除公式（预设公式不可删除）"""
    ok = await service.delete_formula(db, user.id, formula_id)
    if not ok:
        raise HTTPException(status_code=400, detail="公式不存在或为预设公式，无法删除")
    await db.commit()
    return {"detail": "已删除"}
