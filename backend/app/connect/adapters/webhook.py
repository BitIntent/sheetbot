# ============================================================================
# Webhook 适配器 - 被动接收模式
# 外部系统主动推送数据到生成的唯一端点
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import BaseAdapter


class WebhookAdapter(BaseAdapter):
    """
    Webhook 被动接收适配器。
    不主动拉取数据，而是由外部系统推送到生成的唯一 URL。
    test_connection 仅验证配置结构，fetch_data 返回空（数据在 router 中直接处理）。
    """

    async def test_connection(self, config: Dict[str, Any]) -> bool:
        # Webhook 无需主动连接，只要有 endpoint_token 即视为可用
        return bool(config.get("endpoint_token"))

    async def fetch_data(
        self,
        config: Dict[str, Any],
        last_sync_at: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        # Webhook 是被动接收，不主动拉取
        return []

    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        # 字段由推送方决定，首次接收后动态识别
        return ["(由推送方的 JSON 结构动态识别)"]

    def extract_rows(self, payload: Any) -> List[Dict[str, Any]]:
        """
        从 Webhook 推送体中提取数据行。
        支持三种格式：
        1. 单对象: {"name": "...", ...} -> [obj]
        2. 数组: [{"name": "..."}, ...] -> 数组本身
        3. 包装对象: {"data": [...], ...} -> data 数组
        """
        if isinstance(payload, list):
            return [r for r in payload if isinstance(r, dict)]
        if isinstance(payload, dict):
            # 尝试提取 data / items / records / rows 等常见键
            for key in ("data", "items", "records", "rows", "results"):
                if key in payload and isinstance(payload[key], list):
                    return [r for r in payload[key] if isinstance(r, dict)]
            return [payload]
        return []
