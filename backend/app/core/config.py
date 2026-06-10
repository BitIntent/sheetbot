# backend/app/core/config.py
"""
统一配置管理
从环境变量加载配置
"""
import os
from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

# 尝试从多个位置加载 .env 文件
# 1. 项目根目录（优先，用于部署环境）
# 2. backend/app 目录（本地开发）
env_paths = [
    Path(__file__).parent.parent.parent.parent / ".env",  # 项目根目录 .env
    Path(__file__).parent / ".env",                        # backend/app/.env
]

for env_path in env_paths:
    if env_path.exists():
        load_dotenv(env_path)
        break
else:
    # 如果都不存在，尝试默认加载
    load_dotenv()


class Settings(BaseSettings):
    """应用配置"""
    
    # 应用基础配置
    APP_NAME: str = "SheetBot Excel AI"
    APP_VERSION: str = "2.0.0"
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    # SQL echo switch; decoupled from DEBUG
    SQLALCHEMY_ECHO: bool = os.getenv("SQLALCHEMY_ECHO", "false").lower() == "true"
    
    # 服务端口
    PORT: int = int(os.getenv("PORT", 8080))
    
    # MySQL 数据库配置（从 .env 读取，无默认密码）
    DB_HOST: str = os.getenv("DB_HOST", "localhost")
    DB_PORT: int = int(os.getenv("DB_PORT", 3306))
    DB_NAME: str = os.getenv("DB_NAME", "sheetbot_db")
    DB_USER: str = os.getenv("DB_USER", "sheetbot_user")
    DB_PASS: str = os.getenv("DB_PASS", "")
    
    @property
    def DATABASE_URL(self) -> str:
        """构建 MySQL 连接字符串"""
        # URL encode 密码中的特殊字符
        from urllib.parse import quote_plus
        password_encoded = quote_plus(self.DB_PASS)
        return f"mysql+aiomysql://{self.DB_USER}:{password_encoded}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}?charset=utf8mb4"
    
    # JWT 配置
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "your-secret-key-change-in-production")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    
    # AI Agent 配置
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    ANTHROPIC_AUTH_TOKEN: str = os.getenv("ANTHROPIC_AUTH_TOKEN", "")
    ANTHROPIC_MODEL: str = os.getenv("ANTHROPIC_MODEL", "")
    ANTHROPIC_DEFAULT_SONNET_MODEL: str = os.getenv("ANTHROPIC_DEFAULT_SONNET_MODEL", "")
    ANTHROPIC_BASE_URL: Optional[str] = os.getenv("ANTHROPIC_BASE_URL")
    PEXELS_API_KEY: str = os.getenv("PEXELS_API_KEY", "")
    PEXELS_ALLOW_INSECURE_SSL: bool = os.getenv("PEXELS_ALLOW_INSECURE_SSL", "false").lower() == "true"
    PEXELS_TIMEOUT_SEC: int = int(os.getenv("PEXELS_TIMEOUT_SEC", 10))

    @property
    def ANTHROPIC_CREDENTIAL(self) -> str:
        """返回可用的 Anthropic 鉴权凭据（API_KEY 优先，AUTH_TOKEN 兜底）。"""
        return self.ANTHROPIC_API_KEY or self.ANTHROPIC_AUTH_TOKEN

    @property
    def ANTHROPIC_EFFECTIVE_MODEL(self) -> str:
        """返回显式模型（ANTHROPIC_MODEL）或默认 Sonnet 档。"""
        return (self.ANTHROPIC_MODEL or self.ANTHROPIC_DEFAULT_SONNET_MODEL or "").strip()
    
    # Agent 生命周期配置
    AGENT_IDLE_TTL_SEC: int = int(os.getenv("AGENT_IDLE_TTL_SEC", 60))
    AGENT_CLEANUP_INTERVAL_SEC: int = int(os.getenv("AGENT_CLEANUP_INTERVAL_SEC", 30))
    AGENT_PER_REQUEST_CLOSE: bool = os.getenv("AGENT_PER_REQUEST_CLOSE", "true").lower() == "true"
    
    # PPT 目录页最大条目数（LLM 规划时从源头控制，默认 6）
    PPT_TOC_MAX_ITEMS: int = int(os.getenv("PPT_TOC_MAX_ITEMS", "6"))

    # 报表/PPT 规划时每表最大列数，超限仅分析前 N 列，默认 100
    REPORT_MAX_COLUMNS_PER_TABLE: int = int(os.getenv("REPORT_MAX_COLUMNS_PER_TABLE", "100"))

    # 上下文预算（防 context window / Argument list too long 溢出）
    PROMPT_CHAR_TARGET_TOOLS: int = int(os.getenv("PROMPT_CHAR_TARGET_TOOLS", "32000"))
    PROMPT_CHAR_TARGET_FORCE: int = int(os.getenv("PROMPT_CHAR_TARGET_FORCE", "22000"))
    REPORT_PROMPT_CHAR_TARGET: int = int(os.getenv("REPORT_PROMPT_CHAR_TARGET", "28000"))
    GLOBAL_PROMPT_HARD_CAP: int = int(os.getenv("GLOBAL_PROMPT_HARD_CAP", "100000"))

    # 文件存储配置
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "uploads")

    # 认证邮件 / 找回密码
    SMTP_HOST: str = os.getenv("SMTP_HOST", "smtp.exmail.qq.com")
    SMTP_PORT: int = int(os.getenv("SMTP_PORT", "465"))
    SMTP_USER: str = os.getenv("SMTP_USER", "")
    SMTP_PASSWORD: str = os.getenv("SMTP_PASSWORD", "")
    SMTP_FROM_NAME: str = os.getenv("SMTP_FROM_NAME", "SheetBot Support")
    SMTP_USE_SSL: bool = os.getenv("SMTP_USE_SSL", "true").lower() == "true"
    SMTP_TIMEOUT_SECONDS: int = int(os.getenv("SMTP_TIMEOUT_SECONDS", "15"))
    SHEETBOT_PUBLIC_BASE_URL: str = os.getenv("SHEETBOT_PUBLIC_BASE_URL", "http://localhost")
    PASSWORD_RESET_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("PASSWORD_RESET_TOKEN_EXPIRE_MINUTES", "30"))
    BUSINESS_INQUIRY_NOTIFY_EMAILS: str = os.getenv("BUSINESS_INQUIRY_NOTIFY_EMAILS", "")

    class Config:
        case_sensitive = True


# 全局配置实例
settings = Settings()
