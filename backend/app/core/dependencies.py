# backend/app/core/dependencies.py
"""
FastAPI 依赖注入
"""
from typing import Optional, Tuple
from fastapi import Depends, HTTPException, status, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import get_db, async_session_maker
from .security import verify_token
from ..auth.models import User
from ..files.models import UserFile
from ..utils.logger import get_logger

logger = get_logger('dependencies')

# ============================================================================
# 用户名缓存（进程级，user_id -> username，避免每次 DB 查询）
# ============================================================================
_username_cache: dict[str, str] = {}
_USERNAME_CACHE_MAX = 2000


async def _resolve_username(user_id: str) -> str:
    """从缓存或 DB 获取 username，解析失败返回空字符串。"""
    if user_id in _username_cache:
        return _username_cache[user_id]
    try:
        async with async_session_maker() as db:
            result = await db.execute(
                select(User.username).where(User.id == user_id)
            )
            username = result.scalar_one_or_none() or ""
    except Exception:
        username = ""
    if len(_username_cache) >= _USERNAME_CACHE_MAX:
        _username_cache.clear()
    _username_cache[user_id] = username
    return username


async def get_current_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db)
) -> User:
    """
    从 Authorization Header 中获取当前用户
    
    Args:
        authorization: Authorization header (Bearer token)
        db: 数据库会话
        
    Returns:
        User: 当前用户对象
        
    Raises:
        HTTPException: 401 未认证
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无效的认证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    if not authorization:
        raise credentials_exception
    
    # 解析 Bearer token
    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise credentials_exception
    except ValueError:
        raise credentials_exception
    
    # 验证 token
    payload = verify_token(token, token_type="access")
    if not payload:
        raise credentials_exception
    
    user_id: str = payload.get("sub")
    if not user_id:
        raise credentials_exception
    
    # 从数据库获取用户（使用 ORM select，避免 SQL 注入）
    result = await db.execute(
        select(User).where(User.id == user_id, User.is_active == True)
    )
    user_obj = result.scalar_one_or_none()
    
    if not user_obj:
        raise credentials_exception
    
    return user_obj


async def get_current_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> UserFile:
    """
    获取当前用户的文件（校验归属权）
    
    Args:
        file_id: 文件ID
        user: 当前用户
        db: 数据库会话
        
    Returns:
        UserFile: 文件对象
        
    Raises:
        HTTPException: 404 文件不存在或无权访问
    """
    result = await db.execute(
        select(UserFile).where(
            UserFile.id == file_id,
            UserFile.user_id == user.id,
            UserFile.status == "active"
        )
    )
    file_obj = result.scalar_one_or_none()
    
    if not file_obj:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="文件不存在或无权访问"
        )
    
    return file_obj


def get_optional_user(authorization: Optional[str] = Header(None)) -> Optional[str]:
    """
    可选的用户认证（不强制要求）
    用于可以匿名访问但也支持认证的端点
    
    Args:
        authorization: Authorization header
        
    Returns:
        Optional[str]: 用户ID，未认证返回 None
    """
    if not authorization:
        return None
    
    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            return None
    except ValueError:
        return None
    
    payload = verify_token(token, token_type="access")
    if not payload:
        return None
    
    return payload.get("sub")


async def get_optional_user_info(
    authorization: Optional[str] = Header(None),
) -> Tuple[str, str]:
    """
    返回 (user_id, username)，未认证时返回 ("", "")。
    username 从进程级缓存获取，避免每次 DB 查询。
    """
    if not authorization:
        return "", ""
    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            return "", ""
    except ValueError:
        return "", ""

    payload = verify_token(token, token_type="access")
    if not payload:
        return "", ""

    user_id = str(payload.get("sub") or "")
    if not user_id:
        return "", ""

    username = await _resolve_username(user_id)
    return user_id, username
