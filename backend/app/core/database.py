# backend/app/core/database.py
"""
MySQL 数据库连接池管理
使用 SQLAlchemy async engine + aiomysql
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy.pool import NullPool
from typing import AsyncGenerator

from fastapi import HTTPException

from .config import settings
from ..utils.logger import get_logger

logger = get_logger('database')

# SQLAlchemy Base
Base = declarative_base()

# 创建异步引擎
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.SQLALCHEMY_ECHO,
    pool_size=10,
    max_overflow=20,
    pool_recycle=3600,
    pool_pre_ping=True,  # 连接健康检查
)

# 创建 session maker
async_session_maker = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI 依赖注入：获取数据库 session
    
    使用方式:
    ```python
    async def endpoint(db: AsyncSession = Depends(get_db)):
        ...
    ```
    """
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except HTTPException:
            await session.rollback()
            raise
        except Exception as e:
            await session.rollback()
            logger.error(f"数据库事务回滚: {e}")
            raise
        finally:
            await session.close()


async def init_db():
    """初始化数据库（创建所有表）"""
    logger.info("正在初始化数据库表...")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("数据库表初始化完成")


async def close_db():
    """关闭数据库连接池"""
    logger.info("正在关闭数据库连接池...")
    await engine.dispose()
    logger.info("数据库连接池已关闭")
