# backend/app/core/security.py
"""
安全相关功能：JWT 生成/验证、密码哈希
使用 bcrypt 直接实现，避免 passlib 与 bcrypt 4.1+ 的兼容性问题
"""
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any

import bcrypt
from jose import JWTError, ExpiredSignatureError, jwt

from .config import settings
from ..utils.logger import get_logger

logger = get_logger('security')

# bcrypt 最大支持 72 字节，超长密码先做 SHA256 再 bcrypt
BCRYPT_MAX_LENGTH = 72


def _prepare_password(password: str) -> bytes:
    """将密码转为 bcrypt 可用的字节，处理超长密码"""
    raw = password.encode("utf-8")
    if len(raw) <= BCRYPT_MAX_LENGTH:
        return raw
    # 超长密码：先 SHA256 再传入 bcrypt（64 字节 hex）
    return hashlib.sha256(raw).hexdigest().encode("utf-8")


def hash_password(password: str) -> str:
    """
    哈希密码
    
    Args:
        password: 明文密码
        
    Returns:
        str: 哈希后的密码
    """
    pwd_bytes = _prepare_password(password)
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    验证密码
    
    Args:
        plain_password: 明文密码
        hashed_password: 哈希后的密码
        
    Returns:
        bool: 密码是否匹配
    """
    pwd_bytes = _prepare_password(plain_password)
    hashed_bytes = hashed_password.encode("utf-8")
    return bcrypt.checkpw(pwd_bytes, hashed_bytes)


def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """
    创建 Access Token
    
    Args:
        data: 要编码的数据（通常包含 user_id）
        expires_delta: 过期时间增量，默认 15 分钟
        
    Returns:
        str: JWT token
    """
    to_encode = data.copy()
    
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    to_encode.update({"exp": expire, "type": "access"})
    
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt


def create_refresh_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """
    创建 Refresh Token
    
    Args:
        data: 要编码的数据（通常包含 user_id）
        expires_delta: 过期时间增量，默认 7 天
        
    Returns:
        str: JWT token
    """
    to_encode = data.copy()
    
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    
    to_encode.update({"exp": expire, "type": "refresh"})
    
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt


def verify_token(token: str, token_type: str = "access") -> Optional[Dict[str, Any]]:
    """
    验证并解码 Token
    
    Args:
        token: JWT token
        token_type: token 类型（access 或 refresh）
        
    Returns:
        Optional[Dict]: 解码后的数据，验证失败返回 None
    """
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        
        # 验证 token 类型
        if payload.get("type") != token_type:
            logger.warning(f"Token 类型不匹配: 期望 {token_type}, 实际 {payload.get('type')}")
            return None
        
        return payload
    except ExpiredSignatureError:
        logger.debug("JWT 已过期（正常轮换）")
        return None
    except JWTError as e:
        # 签名校验失败常见于：管理端 JWT 打到主系统、过期密钥、伪造令牌；access 中间件每请求解析一次，不宜刷 WARNING
        err = str(e).lower()
        if "signature" in err or "verification" in err:
            logger.debug("JWT 签名校验未通过（多为非本系统 access 令牌或错误 Authorization 头）: %s", e)
        else:
            logger.warning("JWT 验证失败: %s", e)
        return None


def hash_refresh_token(token: str) -> str:
    """
    对 Refresh Token 进行哈希（用于数据库存储）
    
    Args:
        token: Refresh token
        
    Returns:
        str: SHA256 哈希值
    """
    return hashlib.sha256(token.encode()).hexdigest()
