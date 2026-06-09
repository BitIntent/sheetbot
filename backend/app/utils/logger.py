# backend/app/utils/logger.py
"""
统一日志模块
- 后端所有模块日志统一写入 logs/backend/backend-YYYY-MM-DD.log
- 跨自然日自动切换日期分片文件，无需重启进程；同一天内超过大小仍按 .1～.N 滚动（与历史 RotatingFileHandler 行为一致）
- 日志级别支持通过 .env 自定义（BACKEND_LOG_LEVEL / LOG_LEVEL）
- get_logger 在进程内需线程安全：并发首次初始化同一命名 logger 时禁止重复挂载共享 FileHandler（否则每条 INFO 写盘两次）
- 若运行环境将 stdout 重定向/tee 到同一 backend 日志文件，请设 BACKEND_LOG_CONSOLE=false，仅保留文件 Handler，避免双写
"""

import os
import sys
import logging
import threading
import contextvars
from pathlib import Path
from datetime import date
from typing import Optional, Any

from dotenv import load_dotenv

# ============================================================================
# 日志配置
# ============================================================================
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)-20s |%(user_prefix)s %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
MAX_BYTES = 10 * 1024 * 1024  # 10MB
BACKUP_COUNT = 5

# 项目根目录（backend 的上级目录）
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
LOG_DIR = PROJECT_ROOT / "logs"
BACKEND_LOG_DIR = LOG_DIR / "backend"
ENV_PATH = PROJECT_ROOT / ".env"

# 兜底加载根目录 .env（即使先于 core.config 被导入，也能读取日志级别）
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

# 进程内唯一文件 Handler（所有命名 logger 共用，避免跨日多 Handler 指向不同 fd）
_shared_backend_file_handler: Optional["DailyPartitionFileHandler"] = None
_shared_file_handler_lock = threading.Lock()
# 为每个命名 logger 挂载 handler 时加锁，避免并发首次请求时重复 addHandler 导致每条日志写文件两次
_logger_configure_lock = threading.Lock()
_ctx_user_tag: contextvars.ContextVar[str] = contextvars.ContextVar("log_user_tag", default="")


class _UserTagFilter(logging.Filter):
    """将 contextvars 中的用户名注入到日志记录。"""

    def filter(self, record: logging.LogRecord) -> bool:
        user_tag = (_ctx_user_tag.get() or "").strip()
        record.user_prefix = f" @{user_tag}" if user_tag else ""
        return True


_user_tag_filter = _UserTagFilter()


def bind_log_user_tag(user_tag: str) -> Any:
    """绑定当前异步上下文的用户标识。"""
    return _ctx_user_tag.set((user_tag or "").strip())


def reset_log_user_tag(token: Any) -> None:
    """恢复上下文中的用户标识。"""
    if token is not None:
        _ctx_user_tag.reset(token)


def _ensure_log_dir():
    """确保日志目录存在"""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    BACKEND_LOG_DIR.mkdir(parents=True, exist_ok=True)


def _resolve_effective_level(level: Optional[int]) -> int:
    """
    统一日志级别解析：
    - 优先使用显式传入 level
    - 然后读取 BACKEND_LOG_LEVEL（推荐）
    - 最后回退 LOG_LEVEL
    - 都无效时回退 WARNING
    """
    if level is not None:
        return level

    env_level_raw = (os.getenv("BACKEND_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "WARNING").strip()
    if env_level_raw.isdigit():
        return int(env_level_raw)

    env_level_name = env_level_raw.upper()
    return getattr(logging, env_level_name, logging.WARNING)


class DailyPartitionFileHandler(logging.Handler):
    """
    按日历日切换日志文件路径，同日超过 max_bytes 时按 .1～.backupCount 滚动。
    与标准 RotatingFileHandler 的差别：basename 中的日期随自然日更新。
    """

    def __init__(
        self,
        log_dir: Path,
        filename_prefix: str = "backend",
        max_bytes: int = MAX_BYTES,
        backup_count: int = BACKUP_COUNT,
        encoding: str = "utf-8",
    ):
        super().__init__()
        self.log_dir = log_dir
        self.filename_prefix = filename_prefix
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self.encoding = encoding
        self._current_date: Optional[date] = None
        self._current_base_path: Optional[Path] = None
        self.stream = None
        # Handler 基类在部分 Python 版本无实例级 terminator，需显式设置
        self.terminator = "\n"

    def _path_for_date(self, d: date) -> Path:
        return self.log_dir / f"{self.filename_prefix}-{d.strftime('%Y-%m-%d')}.log"

    def close(self):
        self.acquire()
        try:
            if self.stream:
                self.stream.flush()
                self.stream.close()
                self.stream = None
        finally:
            self.release()
        super().close()

    def _open_for_date(self, d: date) -> None:
        _ensure_log_dir()
        path = self._path_for_date(d)
        if self.stream:
            self.stream.flush()
            self.stream.close()
            self.stream = None
        self._current_date = d
        self._current_base_path = path
        self.stream = open(path, "a", encoding=self.encoding, buffering=1)

    def _do_size_rollover(self) -> None:
        """同日体积超限：base.log -> base.log.1，序号后移（对齐 RotatingFileHandler）"""
        if self.stream:
            self.stream.flush()
            self.stream.close()
            self.stream = None
        base = str(self._current_base_path)
        if not base:
            return
        if self.backup_count > 0:
            for i in range(self.backup_count - 1, 0, -1):
                sfn = f"{base}.{i}"
                dfn = f"{base}.{i + 1}"
                if os.path.exists(sfn):
                    if os.path.exists(dfn):
                        os.remove(dfn)
                    os.rename(sfn, dfn)
            dfn = f"{base}.1"
            if os.path.exists(base):
                if os.path.exists(dfn):
                    os.remove(dfn)
                os.rename(base, dfn)
        self.stream = open(base, "a", encoding=self.encoding, buffering=1)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.acquire()
            try:
                d = date.today()
                if self._current_date != d:
                    self._open_for_date(d)
                msg = self.format(record)
                msg_bytes = len((msg + self.terminator).encode(self.encoding, errors="replace"))
                if self.stream is None:
                    self._open_for_date(d)
                if self.stream and self.max_bytes > 0:
                    try:
                        pos = self.stream.tell()
                    except OSError:
                        pos = 0
                    if pos + msg_bytes >= self.max_bytes:
                        self._do_size_rollover()
                if self.stream is None:
                    self._open_for_date(d)
                self.stream.write(msg + self.terminator)
                self.stream.flush()
            finally:
                self.release()
        except Exception:
            self.handleError(record)


def _get_shared_file_handler(formatter: logging.Formatter) -> DailyPartitionFileHandler:
    global _shared_backend_file_handler
    with _shared_file_handler_lock:
        if _shared_backend_file_handler is None:
            h = DailyPartitionFileHandler(BACKEND_LOG_DIR)
            h.setLevel(logging.NOTSET)
            h.setFormatter(formatter)
            _shared_backend_file_handler = h
        return _shared_backend_file_handler


def _env_flag_true(key: str, default: str = "true") -> bool:
    return (os.getenv(key, default) or default).strip().lower() in ("1", "true", "yes", "on")


def get_logger(name: str, level: Optional[int] = None) -> logging.Logger:
    """获取标准日志记录器"""
    _ensure_log_dir()
    with _logger_configure_lock:
        logger = logging.getLogger(name)
        if logger.handlers:
            return logger

        effective_level = _resolve_effective_level(level)
        logger.setLevel(effective_level)
        logger.propagate = False

        formatter = logging.Formatter(LOG_FORMAT, DATE_FORMAT)
        logger.addFilter(_user_tag_filter)

        file_handler = _get_shared_file_handler(formatter)
        if file_handler not in logger.handlers:
            logger.addHandler(file_handler)

        # 若将 stdout tee 到 logs/backend/*.log，控制台 Handler 会让同一条记录再写一遍文件
        if _env_flag_true("BACKEND_LOG_CONSOLE", "true"):
            console_handler = logging.StreamHandler(sys.stdout)
            console_handler.setLevel(effective_level)
            console_handler.setFormatter(formatter)
            if console_handler not in logger.handlers:
                logger.addHandler(console_handler)

        return logger


class AgentLogger:
    """
    Agent 专用日志记录器
    记录工具规划、调用、执行、回调等详细信息
    """

    def __init__(self, session_id: Optional[str] = None, user_tag: str = ""):
        self.session_id = session_id or "global"
        self.user_tag = user_tag
        self._llm_model_for_log: str = ""
        self.logger = get_logger("agent")
        self.tool_logger = get_logger("agent.tools")
        self.ws_logger = get_logger("websocket")

    def set_user_tag(self, user_tag: str) -> None:
        """延迟绑定用户标识（首次收到含 auth 的请求时调用）"""
        if user_tag:
            self.user_tag = user_tag

    def set_llm_model_for_log(self, label: str) -> None:
        """绑定当前会话 LLM 模型摘要（Claude Agent SDK 初始化成功后写入）"""
        self._llm_model_for_log = (label or "").strip()

    def _fmt(self, msg: str) -> str:
        """格式化消息，附带 session_id 与用户标识"""
        llm = f" | llm={self._llm_model_for_log}" if self._llm_model_for_log else ""
        return f"[{self.session_id}]{llm} {msg}"

    def fmt(self, msg: str) -> str:
        """公开版 _fmt，供外部模块（excel_agent 等）统一格式化日志前缀"""
        return self._fmt(msg)

    # ========================================================================
    # Agent 生命周期日志
    # ========================================================================
    def agent_init_start(self):
        self.logger.info(self._fmt("Agent 初始化开始"))

    def agent_init_success(self):
        self.logger.info(self._fmt("Agent 初始化成功"))

    def agent_init_failed(self, error: str, details: str = ""):
        self.logger.error(self._fmt(f"Agent 初始化失败: {error}"))
        if details:
            self.logger.debug(self._fmt(f"错误详情:\n{details}"))

    def agent_close(self):
        self.logger.info(self._fmt("Agent 已关闭"))

    # ========================================================================
    # 命令处理日志
    # ========================================================================
    def command_received(self, command: str):
        self.logger.info(self._fmt(f"收到命令: {command[:100]}..."))
        self.logger.debug(self._fmt(f"完整命令: {command}"))

    def command_context(self, context: dict):
        sheets = [s.get("name", "Unknown") for s in context.get("sheets", [])]
        active = context.get("activeSheet", "Unknown")
        self.logger.debug(self._fmt(f"上下文: sheets={sheets}, active={active}"))

    def command_complete(self, success: bool, message: str = ""):
        if success:
            self.logger.info(self._fmt(f"命令处理完成: {message}"))
        else:
            self.logger.warning(self._fmt(f"命令处理失败: {message}"))

    # ========================================================================
    # 工具调用日志
    # ========================================================================
    def tool_planning(self, tool_names: list):
        self.tool_logger.info(self._fmt(f"规划工具调用: {tool_names}"))

    def tool_call_start(self, tool_name: str, args: dict):
        self.tool_logger.info(self._fmt(f"调用工具: {tool_name}"))
        self.tool_logger.debug(self._fmt(f"工具参数: {args}"))

    def tool_call_success(self, tool_name: str, result: dict):
        self.tool_logger.info(self._fmt(f"工具执行成功: {tool_name}"))
        self.tool_logger.debug(self._fmt(f"工具结果: {result}"))

    def tool_call_failed(self, tool_name: str, error: str):
        self.tool_logger.error(self._fmt(f"工具执行失败: {tool_name} - {error}"))

    def tool_result_processed(self, operation_count: int):
        self.tool_logger.info(self._fmt(f"生成操作数: {operation_count}"))

    # ========================================================================
    # AI 响应日志
    # ========================================================================
    def ai_thinking(self, status: str):
        self.logger.debug(self._fmt(f"AI 思考中: {status}"))

    def ai_response(self, content: str, streaming: bool = False):
        mode = "流式" if streaming else "完整"
        preview = content[:100] + "..." if len(content) > 100 else content
        self.logger.debug(self._fmt(f"AI 响应({mode}): {preview}"))

    def ai_error(self, error: str):
        self.logger.error(self._fmt(f"AI 错误: {error}"))

    # ========================================================================
    # WebSocket 日志
    # ========================================================================
    def ws_connected(self):
        self.ws_logger.info(self._fmt("客户端已连接"))

    def ws_disconnected(self):
        self.ws_logger.info(self._fmt("客户端已断开"))

    def ws_message_received(self, msg_type: str):
        self.ws_logger.debug(self._fmt(f"收到消息: type={msg_type}"))

    def ws_message_sent(self, msg_type: str):
        self.ws_logger.debug(self._fmt(f"发送消息: type={msg_type}"))

    def ws_error(self, error: str):
        self.ws_logger.error(self._fmt(f"WebSocket 错误: {error}"))

    # ========================================================================
    # Excel 操作日志
    # ========================================================================
    def operation_generated(self, op_type: str, params: dict):
        self.tool_logger.info(self._fmt(f"生成操作: {op_type}"))
        self.tool_logger.debug(self._fmt(f"操作参数: {params}"))

    def operation_sent(self, op_type: str):
        self.tool_logger.debug(self._fmt(f"发送操作: {op_type}"))
