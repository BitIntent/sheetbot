# ============================================================================
# 自定义 API 适配器 - 通用 HTTP 请求
# 用户配置任意 HTTP 端点，定义请求方式、认证、数据路径
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp

from .base import BaseAdapter


class CustomAPIAdapter(BaseAdapter):
    """通用 HTTP API 适配器"""

    async def test_connection(self, config: Dict[str, Any]) -> bool:
        url = config.get("url", "")
        if not url:
            return False
        headers = self._build_headers(config)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.request(
                    "HEAD", url, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=15),
                    ssl=False,
                ) as resp:
                    return resp.status < 500
        except Exception:
            return False

    async def fetch_data(
        self,
        config: Dict[str, Any],
        last_sync_at: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        url = config.get("url", "")
        method = config.get("method", "GET").upper()
        headers = self._build_headers(config)
        body_template = config.get("body_template", "")
        data_path = config.get("data_path", "")

        kwargs: Dict[str, Any] = {
            "headers": headers,
            "timeout": aiohttp.ClientTimeout(total=30),
            "ssl": False,
        }
        if method in ("POST", "PUT", "PATCH") and body_template:
            kwargs["data"] = body_template

        try:
            async with aiohttp.ClientSession() as session:
                async with session.request(method, url, **kwargs) as resp:
                    if resp.status >= 400:
                        return []
                    result = await resp.json()
        except Exception:
            return []

        return self._extract(result, data_path)

    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        return ["(执行请求后自动识别字段)"]

    def _build_headers(self, config: Dict[str, Any]) -> Dict[str, str]:
        """构建请求头（含认证）"""
        headers = dict(config.get("headers", {}))
        auth_type = config.get("auth_type", "")
        auth_config = config.get("auth_config", {})

        if auth_type == "bearer" and auth_config.get("token"):
            headers["Authorization"] = f"Bearer {auth_config['token']}"
        elif auth_type == "api_key":
            key_name = auth_config.get("key_name", "X-API-Key")
            headers[key_name] = auth_config.get("key_value", "")

        if "Content-Type" not in headers:
            headers["Content-Type"] = "application/json"
        return headers

    def _extract(self, data: Any, data_path: str) -> List[Dict[str, Any]]:
        """
        按 data_path 深度提取数据。
        data_path 示例: "data.items" -> data["data"]["items"]
        """
        if not data_path:
            if isinstance(data, list):
                return [r for r in data if isinstance(r, dict)]
            if isinstance(data, dict):
                return [data]
            return []

        current = data
        for key in data_path.split("."):
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return []

        if isinstance(current, list):
            return [r for r in current if isinstance(r, dict)]
        if isinstance(current, dict):
            return [current]
        return []
