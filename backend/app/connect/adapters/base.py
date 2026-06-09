# ============================================================================
# 连接器适配器 - 抽象基类
# 定义所有适配器的统一接口
# ============================================================================
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional


class BaseAdapter(ABC):
    """连接器适配器抽象基类"""

    @abstractmethod
    async def test_connection(self, config: Dict[str, Any]) -> bool:
        """测试连接是否可达，返回 True/False"""
        ...

    @abstractmethod
    async def fetch_data(
        self,
        config: Dict[str, Any],
        last_sync_at: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        拉取数据（增量）。
        last_sync_at 为上次同步时间，适配器据此只返回新数据。
        返回 [{"field_name": value, ...}, ...]
        """
        ...

    @abstractmethod
    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        """返回该数据源可映射的字段列表"""
        ...
