# ============================================================================
# 自定义公式 - CRUD 与预设播种
# ============================================================================
from __future__ import annotations

import json
import uuid
from typing import List, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from .models import CustomFormula
from .schemas import FormulaCreate, FormulaUpdate

# ------------------------------------------------------------------
# 系统预设公式（单单元格 + 多列联动）
# ------------------------------------------------------------------

PRESET_FORMULAS: list[dict] = [
    # ---- 单单元格公式 ----
    {
        "name": "TAX_DEDUCT",
        "label": "税后金额",
        "description": "计算扣除税费后的金额。value 为当前单元格数值。",
        "expression": "value * (1 - rate)",
        "params": [{"name": "rate", "label": "税率", "default": 0.13, "type": "percent"}],
        "sort_order": 0,
    },
    {
        "name": "MARKUP",
        "label": "加价计算",
        "description": "在原价基础上按比例加价。",
        "expression": "value * (1 + rate)",
        "params": [{"name": "rate", "label": "加价率", "default": 0.2, "type": "percent"}],
        "sort_order": 1,
    },
    {
        "name": "DISCOUNT",
        "label": "折扣计算",
        "description": "计算折扣后的价格。",
        "expression": "value * discount",
        "params": [{"name": "discount", "label": "折扣", "default": 0.85, "type": "percent"}],
        "sort_order": 2,
    },
    {
        "name": "COMMISSION",
        "label": "提成计算",
        "description": "计算销售提成金额。",
        "expression": "value * rate",
        "params": [{"name": "rate", "label": "提成比例", "default": 0.05, "type": "percent"}],
        "sort_order": 3,
    },
    {
        "name": "COMPOUND_INTEREST",
        "label": "复利计算",
        "description": "计算复利终值。",
        "expression": "value * Math.pow(1 + rate, periods)",
        "params": [
            {"name": "rate", "label": "年利率", "default": 0.05, "type": "percent"},
            {"name": "periods", "label": "期数", "default": 12, "type": "number"},
        ],
        "sort_order": 4,
    },
    {
        "name": "UNIT_CONVERT",
        "label": "单位换算",
        "description": "按倍数进行单位换算。",
        "expression": "value * multiplier",
        "params": [{"name": "multiplier", "label": "换算系数", "default": 1000, "type": "number"}],
        "sort_order": 5,
    },
    {
        "name": "WEIGHTED_ROI",
        "label": "加权投资回报",
        "description": "综合利率、通胀、风险溢价、税率的投资终值。",
        "expression": "value * Math.pow(1 + rate - inflation + riskPremium, years) * (1 - taxRate) * (1 + volatility * 0.1)",
        "params": [
            {"name": "rate", "label": "年化利率", "default": 0.08, "type": "percent"},
            {"name": "inflation", "label": "通胀率", "default": 0.03, "type": "percent"},
            {"name": "riskPremium", "label": "风险溢价", "default": 0.02, "type": "percent"},
            {"name": "years", "label": "投资年限", "default": 5, "type": "number"},
            {"name": "taxRate", "label": "资本利得税", "default": 0.2, "type": "percent"},
            {"name": "volatility", "label": "波动系数", "default": 0.15, "type": "percent"},
        ],
        "sort_order": 6,
    },
    # ---- 多列联动公式 ----
    {
        "name": "PROFIT",
        "label": "利润计算",
        "description": "收入列 - 成本列（表达式中直接用列字母引用同行值，如 C - D）。",
        "expression": "C - D",
        "params": [],
        "sort_order": 7,
    },
    {
        "name": "GROSS_MARGIN",
        "label": "毛利率",
        "description": "(收入 - 成本) / 收入 * 100，结果为百分比数值。",
        "expression": "(C - D) / C * 100",
        "params": [],
        "sort_order": 8,
    },
    {
        "name": "TAX_TOTAL",
        "label": "含税合计",
        "description": "单价(C) x 数量(D) x (1 + 税率)。",
        "expression": "C * D * (1 + rate)",
        "params": [{"name": "rate", "label": "税率", "default": 0.13, "type": "percent"}],
        "sort_order": 9,
    },
]


# ------------------------------------------------------------------
# CRUD
# ------------------------------------------------------------------

async def list_formulas(db: AsyncSession, user_id: str) -> List[CustomFormula]:
    """获取用户全部公式（含预设），按 sort_order 排序"""
    await _ensure_presets(db, user_id)
    result = await db.execute(
        select(CustomFormula)
        .where(CustomFormula.user_id == user_id)
        .order_by(CustomFormula.sort_order, CustomFormula.created_at)
    )
    return list(result.scalars().all())


async def create_formula(
    db: AsyncSession, user_id: str, data: FormulaCreate
) -> CustomFormula:
    """新增用户自定义公式（name 唯一约束冲突时返回 None）"""
    existing = await db.execute(
        select(CustomFormula.id).where(
            CustomFormula.user_id == user_id,
            CustomFormula.name == data.name,
        )
    )
    if existing.scalar_one_or_none() is not None:
        return None

    formula = CustomFormula(
        id=str(uuid.uuid4()),
        user_id=user_id,
        name=data.name,
        label=data.label,
        description=data.description,
        expression=data.expression,
        is_preset=False,
    )
    formula.set_params([p.model_dump() for p in data.params])
    db.add(formula)
    await db.flush()
    return formula


async def update_formula(
    db: AsyncSession, user_id: str, formula_id: str, data: FormulaUpdate
) -> Optional[CustomFormula]:
    """修改公式"""
    formula = await _get_by_id(db, user_id, formula_id)
    if not formula:
        return None
    if data.label is not None:
        formula.label = data.label
    if data.description is not None:
        formula.description = data.description
    if data.expression is not None:
        formula.expression = data.expression
    if data.params is not None:
        formula.set_params([p.model_dump() for p in data.params])
    await db.flush()
    return formula


async def delete_formula(
    db: AsyncSession, user_id: str, formula_id: str
) -> bool:
    """删除公式（预设公式不可删）"""
    formula = await _get_by_id(db, user_id, formula_id)
    if not formula or formula.is_preset:
        return False
    await db.delete(formula)
    await db.flush()
    return True


async def get_formula_by_name(
    db: AsyncSession, user_id: str, name: str
) -> Optional[CustomFormula]:
    """按 name 查询（供 AI Agent 工具调用）"""
    await _ensure_presets(db, user_id)
    result = await db.execute(
        select(CustomFormula).where(
            CustomFormula.user_id == user_id,
            CustomFormula.name == name,
        )
    )
    return result.scalar_one_or_none()


# ------------------------------------------------------------------
# 预设播种
# ------------------------------------------------------------------

async def _ensure_presets(db: AsyncSession, user_id: str) -> None:
    """首次访问时播种预设公式"""
    result = await db.execute(
        select(CustomFormula.id).where(
            CustomFormula.user_id == user_id,
            CustomFormula.is_preset == True,  # noqa: E712
        ).limit(1)
    )
    if result.scalar_one_or_none() is not None:
        return

    for preset in PRESET_FORMULAS:
        formula = CustomFormula(
            id=str(uuid.uuid4()),
            user_id=user_id,
            name=preset["name"],
            label=preset["label"],
            description=preset["description"],
            expression=preset["expression"],
            is_preset=True,
            sort_order=preset["sort_order"],
        )
        formula.set_params(preset["params"])
        db.add(formula)
    await db.flush()


async def _get_by_id(
    db: AsyncSession, user_id: str, formula_id: str
) -> Optional[CustomFormula]:
    result = await db.execute(
        select(CustomFormula).where(
            CustomFormula.id == formula_id,
            CustomFormula.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()
