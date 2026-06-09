# ============================================================================
# 系统配置 - Pydantic 请求/响应模型
# ============================================================================
from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class NotificationPrefs(BaseModel):
    """通知偏好"""

    sync: bool = True  # 连接器同步成功/失败
    report: bool = True  # 报表生成完成
    collect: bool = True  # 表单新提交


class UserPreferencesResponse(BaseModel):
    """用户偏好响应"""

    timezone: str = "Asia/Shanghai"
    language: str = "zh-CN"
    sheet_theme: str = "sheetbot-dark"
    notification_prefs: Dict[str, Any] = Field(default_factory=dict)


class UserPreferencesUpdate(BaseModel):
    """用户偏好更新请求"""

    timezone: Optional[str] = Field(default=None, max_length=50)
    language: Optional[str] = Field(default=None, max_length=20)
    sheet_theme: Optional[str] = Field(default=None, max_length=40)
    notification_prefs: Optional[Dict[str, Any]] = None


class PlatformPublicResponse(BaseModel):
    """前端读取：大文件/分析视图自动分流阈值（无需登录）"""

    auto_analyze_max_file_mb: int = Field(..., description="超过该 MB 强制「我要分析」")
    auto_analyze_max_rows: int = Field(..., description="超过该行数强制「我要分析」")
