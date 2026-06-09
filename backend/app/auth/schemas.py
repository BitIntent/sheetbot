# backend/app/auth/schemas.py
"""
用户认证相关的 Pydantic Schemas
"""
from typing import Optional
from datetime import datetime
from pydantic import BaseModel, EmailStr, Field


# ==================== 请求 Schemas ====================

class RegisterRequest(BaseModel):
    """用户注册请求"""
    username: str = Field(..., min_length=3, max_length=50, description="用户名")
    email: EmailStr = Field(..., description="邮箱")
    password: str = Field(..., min_length=6, description="密码")
    display_name: Optional[str] = Field(None, max_length=100, description="显示名称")


class LoginRequest(BaseModel):
    """用户登录请求"""
    username: str = Field(..., description="用户名或邮箱")
    password: str = Field(..., description="密码")
    device_info: Optional[str] = Field(None, description="设备信息")


class RefreshTokenRequest(BaseModel):
    """刷新 Token 请求"""
    refresh_token: str = Field(..., description="Refresh Token")


class LogoutRequest(BaseModel):
    """退出登录请求"""
    refresh_token: str = Field(..., description="Refresh Token")


class ChangePasswordRequest(BaseModel):
    """修改密码请求"""
    old_password: str = Field(..., min_length=1, description="当前密码")
    new_password: str = Field(..., min_length=6, description="新密码")


class ChangeEmailRequest(BaseModel):
    """更新邮箱请求（需密码确认）"""
    new_email: EmailStr = Field(..., description="新邮箱")
    password: str = Field(..., min_length=1, description="当前密码确认")


class ForgotPasswordRequest(BaseModel):
    """忘记密码请求"""
    email: EmailStr = Field(..., description="注册邮箱")


class ResetPasswordRequest(BaseModel):
    """重置密码请求"""
    token: str = Field(..., min_length=16, description="重置令牌")
    new_password: str = Field(..., min_length=6, description="新密码")


# ==================== 响应 Schemas ====================


class MessageResponse(BaseModel):
    """通用消息响应"""
    message: str

class TokenResponse(BaseModel):
    """Token 响应"""
    access_token: str = Field(..., description="Access Token")
    refresh_token: str = Field(..., description="Refresh Token")
    token_type: str = Field(default="bearer", description="Token 类型")
    expires_in: int = Field(..., description="Access Token 过期时间（秒）")


class UserResponse(BaseModel):
    """用户信息响应"""
    id: str
    username: str
    email: str
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    is_active: bool = True
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class LoginResponse(BaseModel):
    """登录响应"""
    user: UserResponse
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class RegisterResponse(BaseModel):
    """注册响应"""
    user: UserResponse
    message: str = "注册成功"
