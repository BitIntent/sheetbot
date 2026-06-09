# ============================================================================
# 连接器适配器 - 工厂注册
# get_adapter(type) 按类型返回对应适配器实例
# ============================================================================
from __future__ import annotations

from .base import BaseAdapter
from .shopify import ShopifyAdapter
from .dingtalk import DingTalkAdapter
from .wecom import WeComAdapter
from .database import DatabaseAdapter
from .webhook import WebhookAdapter
from .custom_api import CustomAPIAdapter

_REGISTRY: dict[str, BaseAdapter] = {
    "shopify": ShopifyAdapter(),
    "dingtalk": DingTalkAdapter(),
    "wecom": WeComAdapter(),
    "database": DatabaseAdapter(),
    "webhook": WebhookAdapter(),
    "custom_api": CustomAPIAdapter(),
}


def get_adapter(connector_type: str) -> BaseAdapter:
    """按类型获取适配器实例"""
    adapter = _REGISTRY.get(connector_type)
    if not adapter:
        raise ValueError(f"不支持的连接器类型: {connector_type}")
    return adapter
