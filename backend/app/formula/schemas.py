# ============================================================================
# 自定义公式 - Pydantic 请求/响应模型
# ============================================================================
from __future__ import annotations

from typing import Any, List, Optional

from pydantic import BaseModel, Field


# ------------------------------------------------------------------
# 公式参数定义（常量参数，非列引用）
# ------------------------------------------------------------------

class FormulaParam(BaseModel):
    """公式中的常量参数"""
    name: str = Field(..., max_length=30)
    label: str = Field(..., max_length=50)
    default: float = 0.0
    type: str = Field(default="number", pattern=r"^(number|percent)$")


# ------------------------------------------------------------------
# 响应
# ------------------------------------------------------------------

class FormulaResponse(BaseModel):
    """公式完整信息"""
    id: str
    name: str
    label: str
    description: str
    expression: str
    params: List[FormulaParam] = Field(default_factory=list)
    is_preset: bool = False
    sort_order: int = 0


# ------------------------------------------------------------------
# 创建 / 更新
# ------------------------------------------------------------------

class FormulaCreate(BaseModel):
    """创建公式"""
    name: str = Field(..., min_length=1, max_length=50)
    label: str = Field(..., min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    expression: str = Field(..., min_length=1, max_length=2000)
    params: List[FormulaParam] = Field(default_factory=list)


class FormulaUpdate(BaseModel):
    """更新公式（全部可选）"""
    label: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = Field(default=None, max_length=500)
    expression: Optional[str] = Field(default=None, max_length=2000)
    params: Optional[List[FormulaParam]] = None


class FormulaListResponse(BaseModel):
    """公式列表响应"""
    formulas: List[FormulaResponse]
