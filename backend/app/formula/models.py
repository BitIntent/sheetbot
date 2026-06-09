# ============================================================================
# 自定义公式 - 数据库模型
# custom_formulas: 用户空间的自定义公式持久化
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


class CustomFormula(Base):
    """用户自定义公式表"""

    __tablename__ = "custom_formulas"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_user_formula_name"),
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
    label = Column(String(100), nullable=False)
    description = Column(Text, nullable=False, default="")
    expression = Column(Text, nullable=False)
    params = Column(Text, nullable=False, default="[]")
    is_preset = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime, default=_utc_now, nullable=False)
    updated_at = Column(DateTime, default=_utc_now, onupdate=_utc_now, nullable=False)

    # ------------------------------------------------------------------
    # JSON 序列化/反序列化
    # ------------------------------------------------------------------

    def get_params(self) -> list:
        if not self.params:
            return []
        try:
            return json.loads(self.params)
        except (json.JSONDecodeError, TypeError):
            return []

    def set_params(self, data: list) -> None:
        self.params = json.dumps(data or [], ensure_ascii=False)
