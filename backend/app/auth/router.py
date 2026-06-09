# backend/app/auth/router.py
"""
用户认证路由
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from .schemas import (
    RegisterRequest,
    RegisterResponse,
    LoginRequest,
    LoginResponse,
    RefreshTokenRequest,
    LogoutRequest,
    TokenResponse,
    UserResponse,
    ChangePasswordRequest,
    ChangeEmailRequest,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    MessageResponse,
)
from .service import UserService
from .email_service import AuthEmailService
from ..core.database import get_db
from ..core.dependencies import get_current_user
from ..core.config import settings
from ..auth.models import User
from ..utils.logger import get_logger

logger = get_logger('auth_router')

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(
    register_data: RegisterRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    用户注册
    
    - 创建新用户账户
    - 用户名和邮箱必须唯一
    - 密码至少 6 个字符
    """
    try:
        user = await UserService.create_user(db, register_data)
        # 为新用户创建预设目录
        try:
            from ..files.service import create_default_folders
            await create_default_folders(db, user.id)
        except Exception as e:
            logger.warning(f"创建预设目录失败: {e}")
        try:
            await AuthEmailService.send_register_success_email(
                to_email=user.email,
                username=user.display_name or user.username,
            )
        except Exception as e:
            logger.warning(f"发送注册成功邮件失败(不影响注册): {e}")
        return RegisterResponse(
            user=UserResponse.model_validate(user),
            message="注册成功，请登录"
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"注册失败: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="注册失败，请稍后重试"
        )


@router.post("/login", response_model=LoginResponse)
async def login(
    login_data: LoginRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    用户登录
    
    - 支持用户名或邮箱登录
    - 返回 Access Token 和 Refresh Token
    - Access Token 有效期 15 分钟
    - Refresh Token 有效期 7 天
    """
    # 验证用户凭据
    user = await UserService.authenticate_user(db, login_data)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误"
        )
    
    # 创建 tokens
    try:
        access_token, refresh_token = await UserService.create_tokens(
            db, 
            user, 
            device_info=login_data.device_info
        )
        
        return LoginResponse(
            user=UserResponse.model_validate(user),
            access_token=access_token,
            refresh_token=refresh_token,
            token_type="bearer",
            expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
        )
    except Exception as e:
        logger.error(f"登录失败: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="登录失败，请稍后重试"
        )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    refresh_data: RefreshTokenRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    刷新 Access Token
    
    - 使用 Refresh Token 获取新的 Access Token
    - Refresh Token 必须有效且未被吊销
    """
    new_access_token = await UserService.refresh_access_token(db, refresh_data.refresh_token)
    
    if not new_access_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的 Refresh Token"
        )
    
    return TokenResponse(
        access_token=new_access_token,
        refresh_token=refresh_data.refresh_token,  # 保持原 refresh token
        token_type="bearer",
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    )


@router.post("/logout")
async def logout(
    body: LogoutRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    用户退出登录
    
    - 吊销 Refresh Token
    - 前端应同时清除本地存储的 tokens
    """
    success = await UserService.revoke_refresh_token(db, body.refresh_token)
    
    if success:
        logger.info(f"用户退出登录: {current_user.username}")
        return {"message": "退出成功"}
    else:
        return {"message": "退出成功（Token 已失效）"}


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(current_user: User = Depends(get_current_user)):
    """
    获取当前用户信息
    
    - 需要有效的 Access Token
    - 用于验证 token 有效性和获取用户信息
    """
    return UserResponse.model_validate(current_user)


@router.post("/change-password", response_model=MessageResponse)
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    修改密码

    - 校验当前密码
    - 更新密码哈希
    - 吊销该用户所有 Refresh Token（全设备强制重新登录）
    """
    try:
        await UserService.change_password(
            db, current_user.id, body.old_password, body.new_password
        )
        return MessageResponse(message="密码已修改，所有设备需重新登录")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"修改密码失败: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="修改密码失败，请稍后重试",
        )


@router.post("/change-email", response_model=MessageResponse)
async def change_email(
    body: ChangeEmailRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    更新邮箱

    - 需密码确认
    - 检查邮箱唯一性
    """
    try:
        await UserService.change_email(
            db, current_user.id, body.new_email, body.password
        )
        return MessageResponse(message="邮箱已更新")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"更新邮箱失败: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="更新邮箱失败，请稍后重试",
        )


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    发送密码重置邮件。

    注意：不暴露邮箱是否已注册，避免账户枚举。
    """
    try:
        issued = await UserService.issue_password_reset_token(db, body.email)
        if issued:
            user_email, username, raw_token = issued
            reset_link = AuthEmailService.build_password_reset_link(raw_token)
            await AuthEmailService.send_password_reset_email(
                to_email=user_email,
                username=username,
                reset_link=reset_link,
            )
        return MessageResponse(message="如果该邮箱已注册，重置邮件将发送至该邮箱")
    except Exception as e:
        logger.error(f"忘记密码处理失败: {e}")
        return MessageResponse(message="如果该邮箱已注册，重置邮件将发送至该邮箱")


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    使用重置令牌设置新密码。
    """
    try:
        await UserService.reset_password_with_token(
            db,
            token=body.token,
            new_password=body.new_password,
        )
        return MessageResponse(message="密码重置成功，请使用新密码登录")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"重置密码失败: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="重置密码失败，请稍后重试",
        )
