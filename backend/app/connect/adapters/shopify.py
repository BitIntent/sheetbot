# ============================================================================
# Shopify 适配器 - REST Admin API
# 支持订单(orders)、产品(products)、客户(customers) 数据同步
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp

from .base import BaseAdapter


# 资源 -> 可用字段映射
_RESOURCE_FIELDS: Dict[str, List[str]] = {
    "orders": [
        "id", "order_number", "email", "created_at",
        "total_price", "currency", "financial_status",
        "fulfillment_status", "customer_name",
    ],
    "products": [
        "id", "title", "product_type", "vendor",
        "created_at", "updated_at", "status",
        "variants_count", "price",
    ],
    "customers": [
        "id", "email", "first_name", "last_name",
        "phone", "orders_count", "total_spent",
        "created_at",
    ],
}


class ShopifyAdapter(BaseAdapter):
    """Shopify REST Admin API 适配器"""

    def _build_url(self, config: Dict[str, Any], resource: str) -> str:
        domain = config["shop_domain"].rstrip("/")
        if not domain.startswith("https://"):
            domain = f"https://{domain}"
        return f"{domain}/admin/api/2024-01/{resource}.json"

    def _build_headers(self, config: Dict[str, Any]) -> Dict[str, str]:
        return {
            "X-Shopify-Access-Token": config.get("api_key", ""),
            "Content-Type": "application/json",
        }

    async def test_connection(self, config: Dict[str, Any]) -> bool:
        url = self._build_url(config, "shop")
        headers = self._build_headers(config)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    return resp.status == 200
        except Exception:
            return False

    async def fetch_data(
        self,
        config: Dict[str, Any],
        last_sync_at: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        resource = config.get("resource", "orders")
        url = self._build_url(config, resource)
        headers = self._build_headers(config)

        params: Dict[str, Any] = {"limit": 250, "status": "any"}
        if last_sync_at:
            params["created_at_min"] = last_sync_at.isoformat()

        rows: List[Dict[str, Any]] = []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url, headers=headers, params=params,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        return rows
                    data = await resp.json()
        except Exception:
            return rows

        items = data.get(resource, [])
        for item in items:
            row = self._flatten(item, resource)
            rows.append(row)
        return rows

    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        resource = config.get("resource", "orders")
        return _RESOURCE_FIELDS.get(resource, _RESOURCE_FIELDS["orders"])

    def _flatten(self, item: Dict, resource: str) -> Dict[str, Any]:
        """将 Shopify 嵌套结构展平为扁平字典"""
        flat: Dict[str, Any] = {}
        for key in _RESOURCE_FIELDS.get(resource, []):
            if key == "customer_name" and "customer" in item:
                customer = item.get("customer", {}) or {}
                flat[key] = f"{customer.get('first_name', '')} {customer.get('last_name', '')}".strip()
            elif key == "variants_count":
                flat[key] = len(item.get("variants", []))
            elif key == "price":
                variants = item.get("variants", [])
                flat[key] = variants[0].get("price", "") if variants else ""
            else:
                flat[key] = item.get(key, "")
        return flat
