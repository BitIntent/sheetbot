"""Access 日志输出工具。"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
ACCESS_LOG_DIR = PROJECT_ROOT / "logs" / "access"
_LOCK = threading.Lock()


def write_access_log(payload: Dict[str, Any]) -> None:
    """按天写入 JSONL access 日志。"""
    ACCESS_LOG_DIR.mkdir(parents=True, exist_ok=True)
    current_day = datetime.now().strftime("%Y-%m-%d")
    log_path = ACCESS_LOG_DIR / f"access-{current_day}.log"
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    with _LOCK:
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line)
