# ==============================================================================
# 大型Excel文件处理模块
# 与现有前端处理架构完全隔离，所有操作在后端完成
# 使用 DuckDB + openpyxl 混合架构：
#   - DuckDB: 高性能数据查询和聚合（毫秒级）
#   - openpyxl: 样式和公式操作（秒级）
# ==============================================================================

from .storage import LargeFileStorage, large_file_storage
from .large_file_agent import LargeFileAgent, LargeFileAgentManager
from .large_file_duckdb import DuckDBExcelManager, duckdb_manager

__all__ = [
    'LargeFileStorage',
    'large_file_storage',
    'LargeFileAgent',
    'LargeFileAgentManager',
    'DuckDBExcelManager',
    'duckdb_manager',
]
