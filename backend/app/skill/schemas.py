# ============================================================================
# 技能库 - Pydantic 请求/响应模型
# ============================================================================
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ------------------------------------------------------------------
# 技能步骤
# ------------------------------------------------------------------

class SkillStep(BaseModel):
    """单个操作步骤"""
    id: str = Field(..., description="步骤唯一 ID")
    label: str = Field(..., max_length=100, description="步骤显示名称")
    operation_type: str = Field(..., max_length=50, description="原子操作类型")
    params: Dict[str, Any] = Field(default_factory=dict, description="操作参数（可含 {{变量}}）")


# ------------------------------------------------------------------
# 执行范围
# ------------------------------------------------------------------

class SkillScope(BaseModel):
    """技能执行范围"""
    mode: str = Field(default="all_sheets", pattern=r"^(all_sheets|named_sheet)$")
    sheet: Optional[str] = Field(default=None, description="mode=named_sheet 时指定 Sheet 名")


# ------------------------------------------------------------------
# 响应
# ------------------------------------------------------------------

class SkillResponse(BaseModel):
    """技能完整信息"""
    id: str
    name: str
    description: str
    steps: List[SkillStep] = Field(default_factory=list)
    scope: SkillScope = Field(default_factory=SkillScope)
    tags: List[str] = Field(default_factory=list)
    is_preset: bool = False
    sort_order: int = 0


# ------------------------------------------------------------------
# 创建 / 更新
# ------------------------------------------------------------------

class SkillCreate(BaseModel):
    """创建技能"""
    name: str = Field(..., min_length=1, max_length=50)
    description: str = Field(default="", max_length=500)
    steps: List[SkillStep] = Field(default_factory=list)
    scope: SkillScope = Field(default_factory=SkillScope)
    tags: List[str] = Field(default_factory=list)


class SkillUpdate(BaseModel):
    """更新技能（全部可选）"""
    name: Optional[str] = Field(default=None, min_length=1, max_length=50)
    description: Optional[str] = Field(default=None, max_length=500)
    steps: Optional[List[SkillStep]] = None
    scope: Optional[SkillScope] = None
    tags: Optional[List[str]] = None


class SkillListResponse(BaseModel):
    """技能列表响应"""
    skills: List[SkillResponse]
