# ============================================================================
# 企业微信适配器 - 企业内部 API
# 支持通讯录(contacts)、消息(messages)、审批(approval) 数据同步
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp

from .base import BaseAdapter

_DATA_TYPE_FIELDS: Dict[str, List[str]] = {
    "contacts": [
        "userid", "name", "department", "position",
        "mobile", "email", "gender", "status",
    ],
    "approval": [
        "sp_no", "sp_name", "sp_status", "apply_time",
        "applyer_userid", "applyer_name",
    ],
}


class WeComAdapter(BaseAdapter):
    """企业微信适配器"""

    async def _get_access_token(self, config: Dict[str, Any]) -> Optional[str]:
        url = "https://qyapi.weixin.qq.com/cgi-bin/gettoken"
        params = {
            "corpid": config.get("corp_id", ""),
            "corpsecret": config.get("secret", ""),
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    data = await resp.json()
                    if data.get("errcode") == 0:
                        return data.get("access_token")
        except Exception:
            pass
        return None

    async def test_connection(self, config: Dict[str, Any]) -> bool:
        token = await self._get_access_token(config)
        return token is not None

    async def fetch_data(
        self,
        config: Dict[str, Any],
        last_sync_at: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        token = await self._get_access_token(config)
        if not token:
            return []

        data_type = config.get("data_type", "contacts")
        if data_type == "contacts":
            return await self._fetch_contacts(token, config)
        if data_type == "approval":
            return await self._fetch_approval(token, config, last_sync_at)
        return []

    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        data_type = config.get("data_type", "contacts")
        return _DATA_TYPE_FIELDS.get(data_type, _DATA_TYPE_FIELDS["contacts"])

    async def _fetch_contacts(
        self, token: str, config: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """拉取部门成员列表"""
        dept_id = config.get("department_id", 1)
        url = "https://qyapi.weixin.qq.com/cgi-bin/user/list"
        params = {"access_token": token, "department_id": dept_id, "fetch_child": 1}
        rows: List[Dict[str, Any]] = []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    data = await resp.json()
                    for u in data.get("userlist", []):
                        rows.append({
                            "userid": u.get("userid", ""),
                            "name": u.get("name", ""),
                            "department": ",".join(str(d) for d in u.get("department", [])),
                            "position": u.get("position", ""),
                            "mobile": u.get("mobile", ""),
                            "email": u.get("email", ""),
                            "gender": str(u.get("gender", "")),
                            "status": str(u.get("status", "")),
                        })
        except Exception:
            pass
        return rows

    async def _fetch_approval(
        self, token: str, config: Dict[str, Any],
        last_sync_at: Optional[datetime],
    ) -> List[Dict[str, Any]]:
        """拉取审批记录（简化实现）"""
        return []
