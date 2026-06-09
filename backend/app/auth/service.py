# backend/app/auth/service.py
"""
用户认证服务
"""
import uuid
import secrets
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from .models import User, RefreshToken
from .schemas import RegisterRequest, LoginRequest
from ..core.security import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    hash_refresh_token,
    verify_token
)
from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger('auth_service')
DEVICE_INFO_MAX_LEN = 255


def _normalize_device_info(device_info: Optional[str]) -> Optional[str]:
    """
    规范化设备信息，防止超长字段导致登录失败。
    """
    if device_info is None:
        return None
    text = str(device_info).strip()
    if not text:
        return None
    if len(text) <= DEVICE_INFO_MAX_LEN:
        return text
    logger.warning(
        "device_info 超长已截断: original_len=%d max_len=%d",
        len(text),
        DEVICE_INFO_MAX_LEN,
    )
    return text[:DEVICE_INFO_MAX_LEN]


class UserService:
    """用户服务"""
    
    @staticmethod
    async def create_user(db: AsyncSession, register_data: RegisterRequest) -> User:
        """
        创建新用户
        
        Args:
            db: 数据库会话
            register_data: 注册数据
            
        Returns:
            User: 创建的用户对象
            
        Raises:
            ValueError: 用户名或邮箱已存在
        """
        # 检查用户名是否已存在
        result = await db.execute(
            text("SELECT id FROM users WHERE username = :username"),
            {"username": register_data.username}
        )
        if result.first():
            raise ValueError("用户名已存在")
        
        # 检查邮箱是否已存在
        result = await db.execute(
            text("SELECT id FROM users WHERE email = :email"),
            {"email": register_data.email}
        )
        if result.first():
            raise ValueError("邮箱已被注册")
        
        # 创建用户
        user_id = str(uuid.uuid4())
        password_hash = hash_password(register_data.password)
        now = datetime.now(timezone.utc)
        
        await db.execute(
            text("""
                INSERT INTO users (id, username, email, password_hash, display_name, is_active, created_at, updated_at)
                VALUES (:id, :username, :email, :password_hash, :display_name, :is_active, :created_at, :updated_at)
            """),
            {
                "id": user_id,
                "username": register_data.username,
                "email": register_data.email,
                "password_hash": password_hash,
                "display_name": register_data.display_name or register_data.username,
                "is_active": True,
                "created_at": now,
                "updated_at": now
            }
        )

        # ── 自动关联免费套餐（让配额查询走实时 DB JOIN，绕开全局缓存）──
        sub_id = str(uuid.uuid4())
        await db.execute(
            text("""
                INSERT INTO user_subscriptions
                    (id, user_id, plan_code, status, started_at, created_at, updated_at)
                VALUES (:id, :uid, 'free', 'active', :now, :now, :now)
            """),
            {"id": sub_id, "uid": user_id, "now": now},
        )

        await db.commit()
        
        # 获取创建的用户
        result = await db.execute(
            text("SELECT * FROM users WHERE id = :id"),
            {"id": user_id}
        )
        user_row = result.first()
        
        user = User(
            id=user_row[0],
            username=user_row[1],
            email=user_row[2],
            password_hash=user_row[3],
            display_name=user_row[4],
            avatar_url=user_row[5],
            is_active=bool(user_row[6]),
            created_at=user_row[7],
            updated_at=user_row[8]
        )
        
        logger.info(f"用户注册成功: {user.username} ({user.id})")
        return user
    
    @staticmethod
    async def authenticate_user(db: AsyncSession, login_data: LoginRequest) -> Optional[User]:
        """
        验证用户凭据
        
        Args:
            db: 数据库会话
            login_data: 登录数据
            
        Returns:
            Optional[User]: 验证成功返回用户对象，失败返回 None
        """
        # 支持用户名或邮箱登录
        result = await db.execute(
            text("""
                SELECT * FROM users 
                WHERE (username = :identifier OR email = :identifier) AND is_active = 1
            """),
            {"identifier": login_data.username}
        )
        user_row = result.first()
        
        if not user_row:
            return None
        
        # 验证密码
        if not verify_password(login_data.password, user_row[3]):
            return None
        
        user = User(
            id=user_row[0],
            username=user_row[1],
            email=user_row[2],
            password_hash=user_row[3],
            display_name=user_row[4],
            avatar_url=user_row[5],
            is_active=bool(user_row[6]),
            created_at=user_row[7],
            updated_at=user_row[8]
        )
        
        logger.info(f"用户登录成功: {user.username} ({user.id})")
        return user
    
    @staticmethod
    async def create_tokens(db: AsyncSession, user: User, device_info: Optional[str] = None) -> Tuple[str, str]:
        """
        为用户创建 Access Token 和 Refresh Token
        
        Args:
            db: 数据库会话
            user: 用户对象
            device_info: 设备信息
            
        Returns:
            Tuple[str, str]: (access_token, refresh_token)
        """
        # 创建 tokens
        access_token = create_access_token(data={"sub": user.id})
        refresh_token = create_refresh_token(data={"sub": user.id})
        
        # 存储 refresh token 到数据库
        token_id = str(uuid.uuid4())
        token_hash = hash_refresh_token(refresh_token)
        expires_at = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
        now = datetime.now(timezone.utc)
        
        safe_device_info = _normalize_device_info(device_info)

        await db.execute(
            text("""
                INSERT INTO refresh_tokens (id, user_id, token_hash, device_info, expires_at, created_at)
                VALUES (:id, :user_id, :token_hash, :device_info, :expires_at, :created_at)
            """),
            {
                "id": token_id,
                "user_id": user.id,
                "token_hash": token_hash,
                "device_info": safe_device_info,
                "expires_at": expires_at,
                "created_at": now
            }
        )
        await db.commit()
        
        return access_token, refresh_token
    
    @staticmethod
    async def refresh_access_token(db: AsyncSession, refresh_token: str) -> Optional[str]:
        """
        使用 Refresh Token 刷新 Access Token
        
        Args:
            db: 数据库会话
            refresh_token: Refresh token
            
        Returns:
            Optional[str]: 新的 access token，失败返回 None
        """
        # 验证 refresh token
        payload = verify_token(refresh_token, token_type="refresh")
        if not payload:
            return None
        
        user_id = payload.get("sub")
        if not user_id:
            return None
        
        # 检查数据库中的 refresh token
        token_hash = hash_refresh_token(refresh_token)
        result = await db.execute(
            text("""
                SELECT * FROM refresh_tokens 
                WHERE token_hash = :token_hash 
                  AND user_id = :user_id 
                  AND revoked_at IS NULL 
                  AND expires_at > :now
            """),
            {
                "token_hash": token_hash,
                "user_id": user_id,
                "now": datetime.now(timezone.utc)
            }
        )
        token_row = result.first()
        
        if not token_row:
            return None
        
        # 创建新的 access token
        new_access_token = create_access_token(data={"sub": user_id})
        
        logger.info(f"Access token 已刷新: user_id={user_id}")
        return new_access_token
    
    @staticmethod
    async def revoke_refresh_token(db: AsyncSession, refresh_token: str) -> bool:
        """
        吊销 Refresh Token
        
        Args:
            db: 数据库会话
            refresh_token: Refresh token
            
        Returns:
            bool: 是否成功吊销
        """
        token_hash = hash_refresh_token(refresh_token)
        now = datetime.now(timezone.utc)
        
        result = await db.execute(
            text("""
                UPDATE refresh_tokens 
                SET revoked_at = :revoked_at 
                WHERE token_hash = :token_hash AND revoked_at IS NULL
            """),
            {"revoked_at": now, "token_hash": token_hash}
        )
        await db.commit()
        
        return result.rowcount > 0

    @staticmethod
    async def revoke_all_user_tokens(db: AsyncSession, user_id: str) -> int:
        """
        吊销用户所有未过期的 Refresh Token（全设备强制下线）

        Returns:
            int: 被吊销的 token 数量
        """
        now = datetime.now(timezone.utc)
        result = await db.execute(
            text("""
                UPDATE refresh_tokens
                SET revoked_at = :now
                WHERE user_id = :user_id AND revoked_at IS NULL AND expires_at > :now
            """),
            {"now": now, "user_id": user_id}
        )
        await db.commit()
        return result.rowcount

    @staticmethod
    async def change_password(db: AsyncSession, user_id: str, old_password: str, new_password: str) -> None:
        """
        修改密码并吊销全部 Refresh Token

        Raises:
            ValueError: 旧密码不正确 / 新旧密码相同
        """
        result = await db.execute(
            text("SELECT password_hash FROM users WHERE id = :id"),
            {"id": user_id}
        )
        row = result.first()
        if not row:
            raise ValueError("用户不存在")

        if not verify_password(old_password, row[0]):
            raise ValueError("当前密码不正确")

        if old_password == new_password:
            raise ValueError("新密码不能与当前密码相同")

        new_hash = hash_password(new_password)
        now = datetime.now(timezone.utc)
        await db.execute(
            text("UPDATE users SET password_hash = :hash, updated_at = :now WHERE id = :id"),
            {"hash": new_hash, "now": now, "id": user_id}
        )
        await UserService.revoke_all_user_tokens(db, user_id)
        logger.info(f"密码已修改并吊销全部 token: user_id={user_id}")

    @staticmethod
    async def change_email(db: AsyncSession, user_id: str, new_email: str, password: str) -> None:
        """
        更新邮箱（需密码确认）

        Raises:
            ValueError: 密码不正确 / 邮箱已被占用 / 新旧邮箱相同
        """
        result = await db.execute(
            text("SELECT password_hash, email FROM users WHERE id = :id"),
            {"id": user_id}
        )
        row = result.first()
        if not row:
            raise ValueError("用户不存在")

        if not verify_password(password, row[0]):
            raise ValueError("密码不正确")

        if row[1] == new_email:
            raise ValueError("新邮箱与当前邮箱相同")

        dup = await db.execute(
            text("SELECT id FROM users WHERE email = :email AND id != :id"),
            {"email": new_email, "id": user_id}
        )
        if dup.first():
            raise ValueError("该邮箱已被其他用户使用")

        now = datetime.now(timezone.utc)
        await db.execute(
            text("UPDATE users SET email = :email, updated_at = :now WHERE id = :id"),
            {"email": new_email, "now": now, "id": user_id}
        )
        await db.commit()
        logger.info(f"邮箱已更新: user_id={user_id}, new_email={new_email}")

    @staticmethod
    async def issue_password_reset_token(
        db: AsyncSession, email: str
    ) -> Optional[Tuple[str, str, str]]:
        """
        创建忘记密码 token。

        Returns:
            Optional[Tuple[email, username, raw_token]]
        """
        result = await db.execute(
            text("""
                SELECT id, username, email, is_active
                FROM users
                WHERE email = :email
                LIMIT 1
            """),
            {"email": email},
        )
        user_row = result.first()
        if not user_row or not bool(user_row[3]):
            return None

        user_id = user_row[0]
        username = user_row[1] or "用户"
        user_email = user_row[2]
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(minutes=settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES)
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

        # 旧 token 立即作废，避免同一账号持有多张有效重置票据。
        await db.execute(
            text("""
                UPDATE password_reset_tokens
                SET used_at = :now
                WHERE user_id = :user_id
                  AND used_at IS NULL
                  AND expires_at > :now
            """),
            {"now": now, "user_id": user_id},
        )
        await db.execute(
            text("""
                INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
                VALUES (:id, :user_id, :token_hash, :expires_at, :created_at)
            """),
            {
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "token_hash": token_hash,
                "expires_at": expires_at,
                "created_at": now,
            },
        )
        await db.commit()
        return user_email, username, raw_token

    @staticmethod
    async def reset_password_with_token(db: AsyncSession, token: str, new_password: str) -> None:
        """
        使用重置 token 更新密码。
        """
        now = datetime.now(timezone.utc)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

        result = await db.execute(
            text("""
                SELECT id, user_id, expires_at, used_at
                FROM password_reset_tokens
                WHERE token_hash = :token_hash
                  AND used_at IS NULL
                  AND expires_at > :now
                LIMIT 1
            """),
            {"token_hash": token_hash, "now": now},
        )
        token_row = result.first()
        if not token_row:
            raise ValueError("重置链接无效或已过期")

        user_id = token_row[1]
        password_hash = hash_password(new_password)

        await db.execute(
            text("""
                UPDATE users
                SET password_hash = :password_hash, updated_at = :updated_at
                WHERE id = :user_id
            """),
            {"password_hash": password_hash, "updated_at": now, "user_id": user_id},
        )
        await db.execute(
            text("""
                UPDATE password_reset_tokens
                SET used_at = :used_at
                WHERE id = :id
            """),
            {"used_at": now, "id": token_row[0]},
        )
        await db.execute(
            text("""
                UPDATE refresh_tokens
                SET revoked_at = :now
                WHERE user_id = :user_id
                  AND revoked_at IS NULL
                  AND expires_at > :now
            """),
            {"now": now, "user_id": user_id},
        )
        await db.commit()
        logger.info("通过重置链接修改密码成功: user_id=%s", user_id)
