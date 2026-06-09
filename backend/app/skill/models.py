# ============================================================================
# 技能库 - 数据库模型
# skills: 用户空间的可视化操作技能持久化
# ============================================================================
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer,
    String, Text, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from ..core.database import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Skill(Base):
    """用户技能表 - 每条记录是一套可执行的原子操作序列"""

    __tablename__ = "skills"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_user_skill_name"),
    )

    id = Column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = Column(String(50), nullable=False)
    description = Column(Text, nullable=False, default="")
    # JSON 序列化的步骤数组 [{id, label, operation_type, params}]
    steps = Column(Text, nullable=False, default="[]")
    # 执行范围配置 {"mode": "all_sheets"} 或 {"mode": "named_sheet", "sheet": "Sheet1"}
    scope = Column(Text, nullable=False, default='{"mode":"all_sheets"}')
    # JSON 数组，分类标签
    tags = Column(Text, nullable=False, default="[]")
    is_preset = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=_utc_now, nullable=False)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)

    # ------------------------------------------------------------------
    # JSON 序列化/反序列化
    # ------------------------------------------------------------------

    def get_steps(self) -> list:
        if not self.steps:
            return []
        try:
            return json.loads(self.steps)
        except (json.JSONDecodeError, TypeError):
            return []

    def set_steps(self, data: list) -> None:
        self.steps = json.dumps(data or [], ensure_ascii=False)

    def get_scope(self) -> dict:
        if not self.scope:
            return {"mode": "all_sheets"}
        try:
            return json.loads(self.scope)
        except (json.JSONDecodeError, TypeError):
            return {"mode": "all_sheets"}

    def set_scope(self, data: dict) -> None:
        self.scope = json.dumps(data or {"mode": "all_sheets"}, ensure_ascii=False)

    def get_tags(self) -> list:
        if not self.tags:
            return []
        try:
            return json.loads(self.tags)
        except (json.JSONDecodeError, TypeError):
            return []

    def set_tags(self, data: list) -> None:
        self.tags = json.dumps(data or [], ensure_ascii=False)
