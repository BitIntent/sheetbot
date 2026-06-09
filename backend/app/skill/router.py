# ============================================================================
# 技能库 - REST API
# GET    /api/skill/list
# POST   /api/skill
# PUT    /api/skill/{skill_id}
# DELETE /api/skill/{skill_id}
# ============================================================================
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.models import User
from ..core.database import get_db
from ..core.dependencies import get_current_user
from . import service
from .schemas import (
    SkillCreate,
    SkillListResponse,
    SkillResponse,
    SkillScope,
    SkillStep,
    SkillUpdate,
)

router = APIRouter(prefix="/api/skill", tags=["skill"])


def _to_response(s) -> SkillResponse:
    """ORM -> Pydantic"""
    raw_scope = s.get_scope()
    return SkillResponse(
        id=s.id,
        name=s.name,
        description=s.description or "",
        steps=[SkillStep(**step) for step in s.get_steps()],
        scope=SkillScope(**raw_scope),
        tags=s.get_tags(),
        is_preset=s.is_preset,
        sort_order=s.sort_order,
    )


@router.get("/list", response_model=SkillListResponse)
async def list_skills(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户所有技能（含预设）"""
    skills = await service.list_skills(db, user.id)
    return SkillListResponse(skills=[_to_response(s) for s in skills])


@router.post("", response_model=SkillResponse, status_code=201)
async def create_skill(
    body: SkillCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """新建技能"""
    skill = await service.create_skill(db, user.id, body)
    if skill is None:
        raise HTTPException(status_code=409, detail="技能名称已存在")
    return _to_response(skill)


@router.put("/{skill_id}", response_model=SkillResponse)
async def update_skill(
    skill_id: str,
    body: SkillUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新技能"""
    skill = await service.update_skill(db, user.id, skill_id, body)
    if skill is None:
        raise HTTPException(status_code=404, detail="技能不存在")
    return _to_response(skill)


@router.delete("/{skill_id}", status_code=204)
async def delete_skill(
    skill_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除技能（预设技能不可删）"""
    ok = await service.delete_skill(db, user.id, skill_id)
    if not ok:
        raise HTTPException(status_code=400, detail="预设技能不可删除，或技能不存在")
