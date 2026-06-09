# ============================================================================
# 技能库 - CRUD 与预设播种
# ============================================================================
from __future__ import annotations

import uuid
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Skill
from .schemas import SkillCreate, SkillUpdate

# ------------------------------------------------------------------
# 系统预设技能
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# 预设技能：一个稍简单（3 步）、一个稍复杂（5 步），均实用且可执行
# ------------------------------------------------------------------

PRESET_SKILLS: list[dict] = [
    {
        "name": "REPORT_QUICK_STYLE",
        "description": "报表快速美化：表头加粗蓝底白字、数据区斑马纹、外边框。适合日常报表一键标准化。",
        "tags": ["格式", "报表"],
        "scope": {"mode": "all_sheets"},
        "steps": [
            {
                "id": "step-preset-001-1",
                "label": "表头美化",
                "operation_type": "header_beautify",
                "params": {
                    "range": "{{sheet.firstColLetter}}1:{{sheet.lastColLetter}}1",
                    "theme": "blue",
                    "fontColor": "#FFFFFF",
                },
            },
            {
                "id": "step-preset-001-2",
                "label": "斑马纹",
                "operation_type": "zebra_stripe",
                "params": {
                    "range": "{{sheet.range}}",
                    "color1": "#FFFFFF",
                    "color2": "#F0F4FF",
                },
            },
            {
                "id": "step-preset-001-3",
                "label": "外边框",
                "operation_type": "set_border",
                "params": {
                    "range": "{{sheet.range}}",
                    "borderStyle": "thin",
                    "borderColor": "#000000",
                    "borderPosition": "outside",
                },
            },
        ],
        "sort_order": 0,
    },
    {
        "name": "DATA_CLEAN_ENHANCED",
        "description": "数据清洗增强：表头美化、去重、按首列排序、斑马纹、异常值高亮。适合导入数据后的标准化清洗。",
        "tags": ["数据", "清洗"],
        "scope": {"mode": "all_sheets"},
        "steps": [
            {
                "id": "step-preset-002-1",
                "label": "表头美化",
                "operation_type": "header_beautify",
                "params": {
                    "range": "{{sheet.firstColLetter}}1:{{sheet.lastColLetter}}1",
                    "theme": "green",
                    "fontColor": "#FFFFFF",
                },
            },
            {
                "id": "step-preset-002-2",
                "label": "删除重复行",
                "operation_type": "remove_duplicates",
                "params": {
                    "range": "{{sheet.range}}",
                    "byColumns": "{{sheet.firstColLetter}}",
                    "hasHeader": True,
                },
            },
            {
                "id": "step-preset-002-3",
                "label": "按首列排序",
                "operation_type": "sort_range",
                "params": {
                    "range": "{{sheet.range}}",
                    "sortByColumn": "{{sheet.firstColLetter}}",
                    "order": "asc",
                    "hasHeader": True,
                },
            },
            {
                "id": "step-preset-002-4",
                "label": "斑马纹",
                "operation_type": "zebra_stripe",
                "params": {
                    "range": "{{sheet.range}}",
                    "color1": "#FFFFFF",
                    "color2": "#E8F5E9",
                },
            },
            {
                "id": "step-preset-002-5",
                "label": "数值大于 1000 高亮",
                "operation_type": "cond_highlight",
                "params": {
                    "range": "{{sheet.range}}",
                    "operator": "greaterThan",
                    "value": "1000",
                    "highlightColor": "#FEE2E2",
                    "fontColor": "#B91C1C",
                },
            },
        ],
        "sort_order": 1,
    },
    {
        "name": "SALES_INSIGHT_SNAPSHOT",
        "description": "数据分析实战：按品类统计频次、按品类汇总金额、自动高亮高值并加数据条。适合销售/库存周报快速洞察。",
        "tags": ["数据", "分析"],
        "scope": {"mode": "all_sheets"},
        "steps": [
            {
                "id": "step-preset-003-1",
                "label": "统计品类出现次数（D列 -> J列）",
                "operation_type": "query_unique",
                "params": {
                    "column": "D",
                    "startRow": 2,
                    "endRow": "{{sheet.lastRow}}",
                    "outputCell": "J2",
                },
            },
            {
                "id": "step-preset-003-2",
                "label": "按品类汇总销售额（D列分组，E列求和）",
                "operation_type": "summarize_metrics",
                "params": {
                    "range": "D1:E{{sheet.lastRow}}",
                    "groupByColumn": "D",
                    "sumColumn": "E",
                    "targetSheet": "分析结果",
                    "targetCell": "A1",
                    "includeTotal": True,
                },
            },
            {
                "id": "step-preset-003-3",
                "label": "对金额列应用条件数据条",
                "operation_type": "cond_data_bar",
                "params": {
                    "range": "E2:E{{sheet.lastRow}}",
                    "barColor": "#60A5FA",
                },
            },
            {
                "id": "step-preset-003-4",
                "label": "高金额高亮（>10000）",
                "operation_type": "cond_highlight",
                "params": {
                    "range": "E2:E{{sheet.lastRow}}",
                    "operator": "greaterThan",
                    "value": "10000",
                    "highlightColor": "#FEE2E2",
                    "fontColor": "#B91C1C",
                },
            },
        ],
        "sort_order": 2,
    },
]


# ------------------------------------------------------------------
# CRUD
# ------------------------------------------------------------------

async def list_skills(db: AsyncSession, user_id: str) -> List[Skill]:
    """获取用户全部技能（含预设），按 sort_order 排序"""
    await _ensure_presets(db, user_id)
    result = await db.execute(
        select(Skill)
        .where(Skill.user_id == user_id)
        .order_by(Skill.sort_order, Skill.created_at)
    )
    return list(result.scalars().all())


async def create_skill(
    db: AsyncSession, user_id: str, data: SkillCreate
) -> Optional[Skill]:
    """新增用户自定义技能（name 唯一约束冲突时返回 None）"""
    existing = await db.execute(
        select(Skill.id).where(
            Skill.user_id == user_id,
            Skill.name == data.name,
        )
    )
    if existing.scalar_one_or_none() is not None:
        return None

    skill = Skill(
        id=str(uuid.uuid4()),
        user_id=user_id,
        name=data.name,
        description=data.description,
        is_preset=False,
    )
    skill.set_steps([s.model_dump() for s in data.steps])
    skill.set_scope(data.scope.model_dump())
    skill.set_tags(data.tags)
    db.add(skill)
    await db.flush()
    return skill


async def update_skill(
    db: AsyncSession, user_id: str, skill_id: str, data: SkillUpdate
) -> Optional[Skill]:
    """修改技能"""
    skill = await _get_by_id(db, user_id, skill_id)
    if not skill:
        return None
    if data.name is not None:
        skill.name = data.name
    if data.description is not None:
        skill.description = data.description
    if data.steps is not None:
        skill.set_steps([s.model_dump() for s in data.steps])
    if data.scope is not None:
        skill.set_scope(data.scope.model_dump())
    if data.tags is not None:
        skill.set_tags(data.tags)
    await db.flush()
    return skill


async def delete_skill(
    db: AsyncSession, user_id: str, skill_id: str
) -> bool:
    """删除技能（预设技能不可删）"""
    skill = await _get_by_id(db, user_id, skill_id)
    if not skill or skill.is_preset:
        return False
    await db.delete(skill)
    await db.flush()
    return True


# ------------------------------------------------------------------
# 预设播种
# ------------------------------------------------------------------

async def _ensure_presets(db: AsyncSession, user_id: str) -> None:
    """确保用户预设技能与当前版本定义一致（新增/更新/清理旧预设）"""
    result = await db.execute(
        select(Skill).where(
            Skill.user_id == user_id,
            Skill.is_preset == True,  # noqa: E712
        )
    )
    existing_presets = list(result.scalars().all())
    existing_by_name = {s.name: s for s in existing_presets}
    target_names = {p["name"] for p in PRESET_SKILLS}

    for preset in PRESET_SKILLS:
        existing = existing_by_name.get(preset["name"])
        if existing:
            # 同名预设：按最新模板覆盖，确保老用户也能拿到新版预设
            existing.description = preset["description"]
            existing.sort_order = preset["sort_order"]
            existing.set_steps(preset["steps"])
            existing.set_scope(preset["scope"])
            existing.set_tags(preset["tags"])
            continue

        # 新预设：补种
        skill = Skill(
            id=str(uuid.uuid4()),
            user_id=user_id,
            name=preset["name"],
            description=preset["description"],
            is_preset=True,
            sort_order=preset["sort_order"],
        )
        skill.set_steps(preset["steps"])
        skill.set_scope(preset["scope"])
        skill.set_tags(preset["tags"])
        db.add(skill)

    # 清理历史遗留预设（例如旧版 REPORT_FORMAT / DATA_CLEAN）
    for legacy in existing_presets:
        if legacy.name not in target_names:
            await db.delete(legacy)
    await db.flush()


async def _get_by_id(
    db: AsyncSession, user_id: str, skill_id: str
) -> Optional[Skill]:
    result = await db.execute(
        select(Skill).where(
            Skill.id == skill_id,
            Skill.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()
