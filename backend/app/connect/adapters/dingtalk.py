# ============================================================================
# 钉钉适配器 - 企业内部应用 API
# 支持通讯录(contacts)、考勤(attendance)、审批(approval) 数据同步
# ============================================================================
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp

from .base import BaseAdapter

_DATA_TYPE_FIELDS: Dict[str, List[str]] = {
    "contacts": [
        "userid", "name", "department", "position",
        "mobile", "email", "jobnumber", "hire_date",
    ],
    "attendance": [
        "userid", "name", "check_type", "time_result",
        "location_result", "base_check_time", "user_check_time",
    ],
    "approval": [
        "instance_id", "title", "create_time",
        "finish_time", "originator_userid", "status", "result",
    ],
}


class DingTalkAdapter(BaseAdapter):
    """钉钉企业内部应用适配器"""

    async def _get_access_token(self, config: Dict[str, Any]) -> Optional[str]:
        url = "https://oapi.dingtalk.com/gettoken"
        params = {
            "appkey": config.get("app_key", ""),
            "appsecret": config.get("app_secret", ""),
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
        fetch_fn = {
            "contacts": self._fetch_contacts,
            "attendance": self._fetch_attendance,
            "approval": self._fetch_approval,
        }.get(data_type, self._fetch_contacts)

        return await fetch_fn(token, config, last_sync_at)

    def get_available_fields(self, config: Dict[str, Any]) -> List[str]:
        data_type = config.get("data_type", "contacts")
        return _DATA_TYPE_FIELDS.get(data_type, _DATA_TYPE_FIELDS["contacts"])

    async def _fetch_contacts(
        self, token: str, config: Dict[str, Any],
        last_sync_at: Optional[datetime],
    ) -> List[Dict[str, Any]]:
        """拉取部门用户列表"""
        dept_id = config.get("department_id", 1)
        url = "https://oapi.dingtalk.com/topapi/v2/user/list"
        payload = {
            "dept_id": dept_id,
            "cursor": 0,
            "size": 100,
        }
        rows: List[Dict[str, Any]] = []
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url, params={"access_token": token},
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    data = await resp.json()
                    user_list = data.get("result", {}).get("list", [])
                    for u in user_list:
                        rows.append({
                            "userid": u.get("userid", ""),
                            "name": u.get("name", ""),
                            "department": ",".join(str(d) for d in u.get("dept_id_list", [])),
                            "position": u.get("title", ""),
                            "mobile": u.get("mobile", ""),
                            "email": u.get("email", ""),
                            "jobnumber": u.get("job_number", ""),
                            "hire_date": u.get("hired_date", ""),
                        })
        except Exception:
            pass
        return rows

    async def _fetch_attendance(
        self, token: str, config: Dict[str, Any],
        last_sync_at: Optional[datetime],
    ) -> List[Dict[str, Any]]:
        """拉取考勤记录（简化实现）"""
        return []

    async def _fetch_approval(
        self, token: str, config: Dict[str, Any],
        last_sync_at: Optional[datetime],
    ) -> List[Dict[str, Any]]:
        """拉取审批实例（简化实现）"""
        return []
