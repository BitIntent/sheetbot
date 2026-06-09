# 大型Excel文件 AI Agent
# 独立于现有 excel_agent.py，专门处理大文件操作
import os
import json
import asyncio
import time
from typing import Any, Dict, List, Optional, AsyncIterator, Callable
from dataclasses import dataclass, field
from claude_agent_sdk import (
    ClaudeSDKClient, ClaudeAgentOptions,
    AssistantMessage, TextBlock, ToolUseBlock, ToolResultBlock, UserMessage
)
from .large_file_tools import large_file_mcp, LARGE_FILE_TOOL_NAMES, workbook_cache
from .storage import large_file_storage
from .schemas import FileMetadata, FileStatus, PREVIEW_ROW_COUNT
from ..utils.logger import AgentLogger
from ..utils.llm_model_descriptor import describe_llm_model_for_log
from ..core.config import settings


@dataclass
class LargeFileContext:
    """大文件上下文信息"""
    file_id: str = ""
    original_name: str = ""
    file_size: int = 0
    sheet_names: List[str] = field(default_factory=list)
    active_sheet: str = ""
    row_count: int = 0
    col_count: int = 0
    headers: List[str] = field(default_factory=list)
    
    def to_context_string(self) -> str:
        """转换为上下文字符串"""
        if not self.file_id:
            return "当前没有打开的大型Excel文件。"
        
        parts = [
            f"【大文件数据分析模式】",
            f"源文件: {self.original_name} (只读)",
            f"文件大小: {self.file_size / 1024 / 1024:.2f} MB",
            f"文件ID: {self.file_id}",
            f"工作表: {', '.join(self.sheet_names)}",
            f"当前工作表: {self.active_sheet}",
            f"总行数: {self.row_count}",
            f"总列数: {self.col_count}",
        ]
        
        if self.headers:
            parts.append(f"【{self.active_sheet}】工作表的列标题: {', '.join(str(h) for h in self.headers)}")
        
        parts.append(f"\n架构说明：")
        parts.append(f"- 源文件只读：禁止直接编辑，只能用于数据分析")
        parts.append(f"- 结果输出到新文件：使用导出工具将分析结果保存到新 Excel 文件")
        parts.append(f"- 前端显示前 {PREVIEW_ROW_COUNT} 行预览，但你可以分析全部数据")
        
        return "\n".join(parts)
    
    @classmethod
    def from_metadata(cls, meta: FileMetadata, headers: List[str] = None) -> 'LargeFileContext':
        """从文件元数据创建上下文"""
        return cls(
            file_id=meta.file_id,
            original_name=meta.original_name,
            file_size=meta.file_size,
            sheet_names=meta.sheet_names,
            active_sheet=meta.sheet_names[0] if meta.sheet_names else "",
            row_count=meta.row_count,
            col_count=meta.col_count,
            headers=headers or [],
        )


class LargeFileAgent:
    """大型Excel文件 AI Agent 类"""
    
    EXPORT_TOOL_NAMES = {
        "export_query_to_sheet",
        "export_query_to_new_file",
        "export_pivot_to_sheet",
        "export_statistics_to_sheet",
        "export_grouped_data",
    }
    NON_EXPORT_INFO_TOOLS = {
        "get_file_info",
        "get_sheet_info",
        "get_data_preview",
        "get_cell_value",
        "get_range_values",
    }
    
    SYSTEM_PROMPT = """你是一位专业的大型Excel文件数据分析助手。你正在操作的是存储在服务器上的大型Excel文件（超过50MB）。

## 🚨 最高优先级规则（必须严格遵守）：

### 1. 安全边界：
你**只能**处理与Excel电子表格相关的请求。以下行为**严格禁止**：
- **禁止执行任何系统命令**
- **禁止访问文件系统**
- **禁止网络操作**
- **禁止代码执行**
- **禁止讨论非Excel话题**

### 2. 🔴 核心架构原则（数据安全红线）：

**源文件只读，结果输出到新文件**

| 文件类型 | 操作权限 | 说明 |
|---------|---------|-----|
| 源文件（用户上传） | 只读 | 禁止任何修改，仅用于数据分析 |
| 结果文件（系统生成） | 可操作 | 分析结果自动保存到新文件 |

**为什么这样设计？**
1. **数据安全**：原始数据受保护，不会被意外修改
2. **性能极佳**：无需加载大文件到内存修改，导出到新小文件极快
3. **可追溯**：每次分析都生成新文件，便于对比和回溯

当用户请求超出Excel操作范围时，回复：
"抱歉，我是大型Excel文件数据分析助手，只能帮助您分析当前的Excel文件。"

### 3. 🔴 字段验证规则（强制执行）：

**在执行任何操作之前，必须验证用户提到的字段/列名是否存在！**

当用户的请求中包含字段名（如"筛选班级大于1000"中的"班级"），你**必须**：

1. **先检查字段是否存在**：对照上下文中提供的"列标题"列表
2. **字段不存在时**：
   - ❌ **禁止**自动替换为其他相似字段
   - ❌ **禁止**猜测用户意图并执行其他操作
   - ✅ **必须**明确告知用户该字段不存在
   - ✅ **必须**列出当前可用的字段列表供用户选择
   - ✅ **必须**等待用户确认后再继续执行

**示例对话**：
```
用户：筛选班级大于1000的数据
AI（正确）：
  ❌ 字段"班级"在当前工作表中不存在。
  
  📋 当前可用的列有：
  - 订单ID、下单日期、客户ID、产品ID、数量...
  - 销售额(净额)、折扣额、渠道、销售人员...
  
  请问您想筛选哪个字段？或者是否想查找其他工作表？

AI（错误）：帮您筛选"销售额(净额)"大于1000的数据...（这是错误的！）
```

**为什么这样设计？**
- 用户可能拼错了字段名，需要纠正
- 用户可能选错了工作表
- 自动替换字段会导致完全不同的分析结果，误导用户

## 大文件模式特点：
1. **数据在服务器上**：文件存储在服务器，用 DuckDB 高速分析
2. **源文件只读**：所有编辑操作被禁用，保护原始数据
3. **结果输出新文件**：分析结果自动保存到新的 Excel 文件
4. **用户下载结果**：新文件生成后，用户可立即下载查看

## 🚀 可用工具（全部高性能）：

### 📖 数据分析工具（只读，从源文件读取）：

| 任务 | 工具 | 说明 |
|-----|-----|-----|
| 数据预览 | `get_data_preview` | 快速获取前 N 行 |
| 数据查询/筛选 | `query_data` | 使用 SQL，支持 WHERE、ORDER BY、LIMIT |
| 获取唯一值 | `get_unique_values` | 获取某列的去重值列表 |
| 列统计信息 | `get_column_statistics` | 计数、求和、平均、最大、最小值 |
| 分组聚合 | `group_by_aggregate` | SQL GROUP BY，支持多列分组 |
| 创建透视表 | `create_pivot_table` | 在内存中计算透视表 |
| 文件信息 | `get_file_info` | 获取文件基本信息 |
| 工作表信息 | `get_sheet_info` | 获取工作表信息 |

### 📤 导出工具（生成新文件）：

| 任务 | 工具 | 说明 |
|-----|-----|-----|
| 导出查询结果 | `export_query_to_new_file` | SQL 查询结果 → 新文件 |
| 导出透视表 | `export_pivot_to_sheet` | 透视表 → 新文件 |
| 导出统计信息 | `export_statistics_to_sheet` | 数值列统计信息 → 新文件 |
| 导出分组统计 | `export_grouped_data` | 分组聚合结果 → 新文件 |

### ❌ 禁用的编辑工具（返回错误提示）：

以下工具在大文件模式下被禁用，调用会返回友好的错误提示：
- `set_cell_value`, `set_range_values`, `set_cell_formula`
- `set_cell_style`, `set_range_style`
- `insert_rows`, `delete_rows`, `insert_columns`, `delete_columns`
- `sort_range`, `find_replace`, `remove_duplicates`
- `add_sheet`, `rename_sheet`, `delete_sheet`, `copy_sheet`
- `merge_cells`, `unmerge_cells`, `add_conditional_format`

**替代方案**：
- 排序 → 使用 `query_data` + `ORDER BY` + `export_query_to_new_file`
- 去重 → 使用 `query_data` + `DISTINCT` + `export_query_to_new_file`
- 筛选 → 使用 `query_data` + `WHERE` + `export_query_to_new_file`

## SQL 查询语法示例：

```sql
-- 使用 {table} 占位符引用当前工作表
SELECT * FROM {table} WHERE 区域 = '华东' LIMIT 100

-- 分组统计
SELECT 区域, SUM(销售额) as 总额 FROM {table} GROUP BY 区域

-- 排序
SELECT * FROM {table} ORDER BY 销售额 DESC

-- 去重
SELECT DISTINCT 产品名称, 类别 FROM {table}

-- 多条件筛选
SELECT * FROM {table} WHERE 销售额 > 10000 AND 区域 IN ('华东', '华南')
```

## 🔗 跨工作表联合查询（重要！）：

当需要关联多个工作表时，使用 `{table:工作表名}` 格式引用其他表：

```sql
-- 关联销售明细和客户明细
SELECT 
    s.订单ID,
    s.下单日期,
    s.产品ID,
    s."销售额(净额)" as 销售额,
    c.客户名称,
    c.客户分层,
    c.大区
FROM {table:销售明细} s
INNER JOIN {table:客户明细} c ON s.客户ID = c.客户ID
WHERE c.大区 = '华南' AND c.客户分层 = '高端'
ORDER BY s.下单日期 DESC

-- 三表关联（销售 + 客户 + 产品）
SELECT 
    s.下单日期,
    c.客户名称,
    p.产品名称,
    p.类别,
    s."销售额(净额)" as 销售额
FROM {table:销售明细} s
JOIN {table:客户明细} c ON s.客户ID = c.客户ID
JOIN {table:产品明细} p ON s.产品ID = p.产品ID
WHERE c.大区 = '华南'
LIMIT 100
```

**注意事项**：
- 中文列名包含特殊字符（如括号）时需用双引号：`"销售额(净额)"`
- 工作表名必须与文件中的完全一致（区分大小写）
- 系统会自动加载引用的工作表到 DuckDB

## 🔄 结果表二次加工（重要！）：

**结果表存在于内存中，不在源文件中！**

当你创建透视表、执行SQL查询等操作后，结果会：
1. 保存到结果文件（用于下载）
2. **同时注册到内存**，可以通过 `{table:结果_xxx}` 语法引用

**二次加工示例**：
```sql
-- 对透视表结果进行筛选
SELECT * FROM {table:结果_透视表_渠道_产品ID_成交单价} WHERE 渠道 = '天猫'

-- 对查询结果进行聚合
SELECT 渠道, COUNT(*) as 数量 FROM {table:结果_SQL查询_01} GROUP BY 渠道
```

**关键理解**：
- `get_file_info` 返回的 `sheet_names` 是源文件的工作表
- `get_file_info` 返回的 `result_tables` 是内存中的结果表（支持二次加工）
- 以 `结果_` 开头的表名都是内存结果表，**无需检查源文件是否存在**
- 直接使用 `{table:结果_xxx}` 语法查询即可

**禁止**：
- ❌ 看到 `{table:结果_xxx}` 就说"工作表不存在"
- ❌ 检查源文件的 sheet_names 来判断结果表是否存在
- ✅ 直接执行查询，让系统自动从内存加载

## 典型工作流程：

### 场景 1：创建数据透视表
```
1. get_unique_values(file_id, "区域")     # 获取行维度
2. get_unique_values(file_id, "产品名称") # 获取列维度
3. export_pivot_to_sheet(                 # 创建并导出
     file_id, row_field="区域", 
     column_field="产品名称", 
     value_field="销售额", 
     agg_func="SUM",
     target_sheet="透视表"
   )
4. 告诉用户："透视表已创建到新文件 XXX，请下载查看"
```

### 场景 2：数据筛选并导出
```
1. query_data(file_id, "SELECT * FROM {table} WHERE 销售额 > 10000")  # 预览
2. export_query_to_new_file(                                          # 导出
     file_id, 
     sql="SELECT * FROM {table} WHERE 销售额 > 10000",
     target_sheet="高销售额数据"
   )
3. 告诉用户："已筛选 X 条数据到新文件 XXX，请下载查看"
```

### 场景 3：分组统计
```
1. group_by_aggregate(file_id, ["区域"], {"销售额_总计": "SUM(销售额)"})
2. export_grouped_data(
     file_id,
     group_columns=["区域"],
     agg_expressions={"销售额_总计": "SUM(销售额)"},
     target_sheet="区域统计"
   )
3. 告诉用户："分组统计结果已保存到新文件 XXX，请下载查看"
```

### 场景 4：查看/导出统计信息
```
1. export_statistics_to_sheet(           # 直接导出（推荐）
     file_id,
     columns=["销售额", "数量", "折扣率"]  # 可选，为空则自动检测所有数值列
   )
2. 告诉用户："统计信息已导出到新工作表，可以查看和下载"
```

**重要**：当用户请求"查看统计信息"时，使用 `export_statistics_to_sheet` 而不是 `get_column_statistics`！

## 🔴 最重要的输出规则（必须遵守）：

**所有操作结果必须创建新工作表！**

无论用户是否明确要求，任何查询、筛选、排序、统计、透视表等操作的结果都**必须**使用导出工具创建新工作表。

❌ 错误做法：只返回查询结果给用户看，不创建工作表
✅ 正确做法：执行查询后，立即使用导出工具将结果保存到新工作表

**示例**：
- 用户说"查询销售额大于1万的数据" → **必须调用 export_query_to_new_file 创建工作表**
- 用户说"按区域统计销售额" → **必须调用 export_grouped_data 创建工作表**
- 用户说"排序" → **必须调用 export_query_to_new_file 创建工作表**
- 用户说"查看统计信息" → **必须调用 export_statistics_to_sheet 创建工作表**

## 响应格式：
1. 简要说明要做什么
2. 执行数据分析工具（可选，用于预览）
3. **必须**：使用导出工具创建新工作表（这一步不能省略！）
4. **必须告诉用户**：
   - "分析结果已保存到新工作表：`工作表名`"
   - "您可以在左侧工作表标签中查看结果"
   - "点击下载按钮可保存完整结果文件"

## 🔒 安全规则（严格遵守）：

**禁止向用户暴露任何技术实现细节！**

以下信息**绝对禁止**出现在用户界面：
- 技术栈名称：DuckDB、openpyxl、pandas、pyarrow 等
- 内部实现：内存表、缓存机制、引擎名称
- 系统架构：文件ID、表名格式、内部路径
- 性能归因：禁止说"DuckDB 的威力"、"高性能引擎"等

**正确示例**：
- ✅ "处理 100 万行数据仅需 58 毫秒"
- ❌ "这就是 DuckDB 高性能引擎的威力"

**错误示例**：
- ❌ "数据已加载到 DuckDB 内存表"
- ❌ "使用 pandas 读取 Excel"
- ❌ "file_id=xxx, table_name=xxx"

## 重要提醒：
- **每次操作都必须创建新工作表**，即使用户没有要求
- 结果存储在内存中，下载时才保存到文件
- 用户可以多次分析，每次都会生成新的工作表
- 关闭工作表会释放对应的内存

始终友好、精确、**高效**地执行数据分析操作，并**确保每次都创建新工作表供用户预览**。"""

    def __init__(self, session_id: str = 'default'):
        """初始化 Agent"""
        self.session_id = session_id
        self.client: Optional[ClaudeSDKClient] = None
        self.context = LargeFileContext()
        self._message_callback: Optional[Callable] = None
        self.log = AgentLogger(f'large_file.{session_id}')
        self._close_lock = asyncio.Lock()
        self._closed = False
        self._last_active_ts = time.monotonic()
        self._processing = False  # 标记是否正在处理请求
        
    async def initialize(self):
        """初始化 Claude SDK Client"""
        self._closed = False
        self.log.set_llm_model_for_log(describe_llm_model_for_log(None))
        self.log.logger.info(self.log.fmt('初始化 LargeFileAgent'))
        
        try:
            api_key = os.getenv("ANTHROPIC_API_KEY")
            auth_token = os.getenv("ANTHROPIC_AUTH_TOKEN")
            credential = api_key or auth_token
            if not credential:
                raise ValueError("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 环境变量未设置")
            # Claude Agent SDK/CLI 默认读取 ANTHROPIC_API_KEY，这里做兼容映射。
            if not api_key and auth_token:
                os.environ["ANTHROPIC_API_KEY"] = auth_token
            
            # 安全配置：只允许大文件工具
            DANGEROUS_TOOLS = [
                "Bash", "BashOutput", "KillBash",
                "Write", "Edit", "Read",
                "Glob", "Grep",
                "WebFetch", "WebSearch",
                "NotebookEdit",
                "Task",
            ]
            
            options = ClaudeAgentOptions(
                system_prompt=self.SYSTEM_PROMPT,
                mcp_servers={"large-file-tools": large_file_mcp},
                allowed_tools=LARGE_FILE_TOOL_NAMES,
                disallowed_tools=DANGEROUS_TOOLS,
                permission_mode="acceptEdits",
                max_turns=50,  # 增加轮次限制，确保复杂任务能完成
                model=settings.ANTHROPIC_EFFECTIVE_MODEL or None,
            )
            self.log.set_llm_model_for_log(describe_llm_model_for_log(options))
            
            self.client = ClaudeSDKClient(options)
            await self.client.__aenter__()
            
            self.log.logger.info(self.log.fmt('LargeFileAgent 初始化完成'))
            
        except Exception as e:
            self.log.logger.error(self.log.fmt(f'LargeFileAgent 初始化失败: {e}'))
            raise
    
    async def set_file_context(self, file_id: str, active_sheet: str = None):
        """异步设置当前操作的文件上下文"""
        self.log.logger.info(f'[{self.session_id}] 开始设置文件上下文: file_id={file_id}, active_sheet={active_sheet}')
        
        meta = large_file_storage.get_metadata(file_id)
        if not meta:
            raise ValueError(f"文件不存在: {file_id}")
        
        from .large_file_duckdb import duckdb_manager
        
        # ========================================
        # 确定目标工作表（三种情况）
        # ========================================
        # 1. 源文件工作表：active_sheet in meta.sheet_names
        # 2. 结果表：active_sheet 以 "结果_" 开头，存在于 DuckDB 内存
        # 3. 回退：使用源文件第一个工作表
        # ========================================
        target_sheet = None
        is_result_table = False
        
        if active_sheet:
            if active_sheet in meta.sheet_names:
                # 情况1：源文件工作表
                target_sheet = active_sheet
                self.log.logger.info(f'[{self.session_id}] 目标工作表为源文件工作表: {target_sheet}')
            elif active_sheet.startswith('结果_'):
                # 情况2：结果表 - 检查是否在 DuckDB 内存中
                result_table_name = duckdb_manager.get_result_table_name(file_id, active_sheet)
                if result_table_name:
                    target_sheet = active_sheet
                    is_result_table = True
                    self.log.logger.info(f'[{self.session_id}] 目标工作表为内存结果表: {target_sheet}')
                else:
                    self.log.logger.warning(f'[{self.session_id}] 结果表 {active_sheet} 在 DuckDB 内存中不存在，回退到源文件第一个工作表')
            else:
                self.log.logger.warning(f'[{self.session_id}] 工作表 {active_sheet} 不存在，回退到源文件第一个工作表')
        
        # 情况3：回退到源文件第一个工作表
        if not target_sheet and meta.sheet_names:
            target_sheet = meta.sheet_names[0]
            self.log.logger.info(f'[{self.session_id}] 使用默认工作表: {target_sheet}')
        
        # ========================================
        # 获取表头
        # ========================================
        headers = []
        try:
            if is_result_table:
                # 结果表：从 DuckDB 结果表获取列名
                result_table_name = duckdb_manager.get_result_table_name(file_id, target_sheet)
                if result_table_name:
                    self.log.logger.info(f'[{self.session_id}] 从 DuckDB 结果表获取表头: {result_table_name}')
                    columns = duckdb_manager.conn.execute(f'DESCRIBE "{result_table_name}"').fetchall()
                    headers = [col[0] for col in columns]
            elif duckdb_manager.is_loaded(file_id, target_sheet):
                # 源文件工作表已加载到 DuckDB
                self.log.logger.info(f'[{self.session_id}] 从 DuckDB 缓存获取表头: sheet={target_sheet}')
                table_name = duckdb_manager._get_table_name(file_id, target_sheet)
                columns = duckdb_manager.conn.execute(f'DESCRIBE "{table_name}"').fetchall()
                headers = [col[0] for col in columns]
            else:
                # 回退到预览获取
                self.log.logger.info(f'[{self.session_id}] DuckDB 未加载工作表 {target_sheet}，从预览获取表头')
                preview = await large_file_storage.get_preview(file_id, sheet_name=target_sheet, max_rows=1)
                if preview:
                    headers = preview.get('headers', [])
        except Exception as e:
            self.log.logger.warning(f'[{self.session_id}] 获取表头失败: {e}，使用空表头')
        
        self.context = LargeFileContext.from_metadata(meta, headers)
        
        # 设置活动工作表（保持用户选中的工作表，包括结果表）
        if target_sheet:
            self.context.active_sheet = target_sheet
        
        self.log.logger.info(f'[{self.session_id}] 文件上下文设置完成: active_sheet={self.context.active_sheet}, is_result_table={is_result_table}, headers_count={len(headers)}, headers={headers[:5]}...')
    
    # 保留异步别名以保持向后兼容
    async def set_file_context_async(self, file_id: str, active_sheet: str = None):
        return await self.set_file_context(file_id, active_sheet)
    
    def update_activity(self):
        """更新活动时间戳"""
        self._last_active_ts = time.monotonic()

    @staticmethod
    def _normalize_tool_name(tool_name: Any) -> str:
        raw = str(tool_name or "").strip()
        if not raw:
            return ""
        if "__" in raw:
            raw = raw.split("__")[-1]
        return raw.lower()

    def _requires_export_sheet(self, command: str, called_tools: set[str]) -> bool:
        """
        判定本轮是否必须创建新工作表：
        - 只要触发了分析类工具（非纯信息类），就必须导出
        - 或者用户语义明显是分析/汇总/查询
        """
        normalized_called = {
            self._normalize_tool_name(name) for name in called_tools if name
        }
        analysis_tools = normalized_called - self.NON_EXPORT_INFO_TOOLS
        if analysis_tools:
            return True

        text = str(command or "").lower()
        analysis_keywords = [
            "分析", "统计", "汇总", "分组", "透视", "筛选", "排序",
            "查询", "sql", "求和", "平均", "最大", "最小", "sum(", "avg(", "group by"
        ]
        return any(k in text for k in analysis_keywords)
    
    def is_idle(self, idle_seconds: float = 60.0) -> bool:
        """检查是否空闲（正在处理请求时不算空闲）"""
        idle_time = time.monotonic() - self._last_active_ts
        self.log.logger.debug(f'[{self.session_id}] is_idle检查: _processing={self._processing}, idle_time={idle_time:.1f}s, threshold={idle_seconds}s')
        if self._processing:
            return False
        return idle_time > idle_seconds
    
    async def process_command(
        self,
        command: str,
        require_export_sheet: Optional[bool] = None
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        处理用户命令
        
        Args:
            command: 用户命令
            
        Yields:
            消息字典
        """
        # 检查 Agent 是否已关闭
        if self._closed:
            self.log.logger.warning(self.log.fmt('Agent 已关闭，尝试重新初始化'))
            self._closed = False
            self.client = None
        
        if not self.client:
            try:
                await self.initialize()
            except Exception as e:
                self.log.logger.error(self.log.fmt(f'Agent 初始化失败: {e}'))
                yield {"type": "error", "content": f"Agent 初始化失败: {str(e)}"}
                return
        
        self.update_activity()
        self._processing = True  # 标记开始处理
        self.log.logger.info(self.log.fmt(f'收到命令: {command[:100]}...'))
        self.log.logger.info(self.log.fmt('_processing 已设置为 True'))
        
        # 构建带上下文的提示
        context_str = self.context.to_context_string()
        full_prompt = f"""当前文件上下文：
{context_str}

用户请求：{command}

执行硬约束（代码级）：如果本轮是分析/查询/汇总类请求，必须至少成功创建一个新的结果工作表（调用导出工具并返回 result_file_id + sheet_name）；否则本轮视为失败，必须返回错误并提示用户重试。"""
        
        try:
            # 使用与 excel_agent.py 相同的 API 调用方式
            self.log.logger.info(self.log.fmt('准备发送请求到 Claude API...'))
            # 诊断 SDK 内部状态
            if hasattr(self.client, '_query') and self.client._query:
                q = self.client._query
                self.log.logger.info(self.log.fmt(f'SDK 内部状态: _closed={getattr(q, "_closed", "N/A")}, _initialized={getattr(q, "_initialized", "N/A")}'))
                # 检查消息流状态
                if hasattr(q, '_message_receive'):
                    mr = q._message_receive
                    self.log.logger.info(self.log.fmt(f'_message_receive 类型: {type(mr).__name__}'))
                # 检查 TaskGroup 状态
                if hasattr(q, '_tg') and q._tg:
                    tg = q._tg
                    self.log.logger.info(self.log.fmt(f'TaskGroup 状态: cancel_scope.cancel_called={tg.cancel_scope.cancel_called if hasattr(tg, "cancel_scope") else "N/A"}'))
                else:
                    self.log.logger.warning(self.log.fmt('TaskGroup (_tg) 不存在或为 None！'))
                # 检查 transport 状态
                if hasattr(q, 'transport') and q.transport:
                    t = q.transport
                    proc = getattr(t, '_process', None)
                    if proc:
                        # 检查子进程是否还在运行
                        returncode = proc.returncode if hasattr(proc, 'returncode') else 'N/A'
                        pid = proc.pid if hasattr(proc, 'pid') else 'N/A'
                        self.log.logger.info(self.log.fmt(f'transport: _process.pid={pid}, returncode={returncode}'))
                    else:
                        self.log.logger.warning(self.log.fmt('transport._process 为 None！'))
                else:
                    self.log.logger.warning(self.log.fmt('transport 不存在！'))
            else:
                self.log.logger.warning(self.log.fmt('SDK _query 对象不存在！'))
            
            await self.client.query(full_prompt, session_id=self.session_id)
            self.log.logger.info(self.log.fmt('请求已发送到 Claude API'))
        except Exception as e:
            import traceback
            self.log.logger.error(self.log.fmt(f'发送命令失败: {e}'))
            self.log.logger.error(self.log.fmt(f'堆栈: {traceback.format_exc()}'))
            self._processing = False
            yield {"type": "error", "content": f"发送命令失败: {str(e)}"}
            return
        
        try:
            text_blocks: List[str] = []
            message_count = 0
            called_tools: set[str] = set()
            export_sheet_created = False
            tool_use_name_by_id: Dict[str, str] = {}
            self.log.logger.info(self.log.fmt('开始接收响应...'))
            self.log.logger.info(self.log.fmt(f'client 状态: client={self.client is not None}, _closed={self._closed}'))
            
            # 再次检查子进程状态（在 receive_response 之前）
            if hasattr(self.client, '_query') and self.client._query:
                q = self.client._query
                if hasattr(q, 'transport') and q.transport:
                    proc = getattr(q.transport, '_process', None)
                    if proc:
                        returncode = proc.returncode if hasattr(proc, 'returncode') else 'N/A'
                        self.log.logger.info(self.log.fmt(f'receive_response 前: _process.returncode={returncode}'))
                # 检查消息流状态
                if hasattr(q, '_message_receive'):
                    mr = q._message_receive
                    # 检查流的统计信息
                    stats = getattr(mr, '_state', None)
                    buffer_size = getattr(mr, '_buffer', None)
                    self.log.logger.info(self.log.fmt(f'_message_receive 状态: _state={stats}, buffer={buffer_size is not None}'))
            
            # 记录消息间隔，用于诊断
            last_message_time = time.monotonic()
            
            async for message in self.client.receive_response():
                # 检查并记录消息间隔
                current_time = time.monotonic()
                interval = current_time - last_message_time
                if interval > 30:
                    self.log.logger.warning(self.log.fmt(f'消息间隔较长: {interval:.1f}秒'))
                last_message_time = current_time
                
                # 检查 Agent 是否被关闭
                if self._closed:
                    self.log.logger.warning(self.log.fmt('Agent 已被关闭，中断响应接收'))
                    break
                message_count += 1
                self.update_activity()
                self.log.logger.info(self.log.fmt(f'收到消息 #{message_count}: {type(message).__name__}'))
                
                if isinstance(message, AssistantMessage):
                    self.log.logger.info(self.log.fmt(f'AssistantMessage 包含 {len(message.content)} 个块'))
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            text_blocks.append(block.text or "")
                        elif isinstance(block, ToolUseBlock):
                            tool_name = block.name
                            normalized_tool_name = self._normalize_tool_name(tool_name)
                            if normalized_tool_name:
                                called_tools.add(normalized_tool_name)
                            tool_use_id = getattr(block, 'id', None)
                            if tool_use_id:
                                tool_use_name_by_id[str(tool_use_id)] = normalized_tool_name or str(tool_name or "")
                            tool_input = getattr(block, 'input', {})
                            self.log.logger.info(self.log.fmt(f'工具调用: {tool_name}'))
                            self.log.logger.debug(self.log.fmt(f'工具参数: {tool_input}'))
                            yield {
                                "type": "tool_use",
                                "tool_name": tool_name,
                                "tool_input": tool_input,
                            }
                        elif isinstance(block, ToolResultBlock):
                            # 解析工具结果
                            try:
                                content = block.content
                                if isinstance(content, str):
                                    result = json.loads(content)
                                elif isinstance(content, list) and content:
                                    # 从 content 列表中提取文本
                                    for item in content:
                                        if isinstance(item, dict) and item.get('type') == 'text':
                                            result = json.loads(item.get('text', '{}'))
                                            break
                                    else:
                                        result = content
                                else:
                                    result = content
                                tool_use_id = getattr(block, 'tool_use_id', 'unknown')
                                tool_name = tool_use_name_by_id.get(str(tool_use_id), "")
                                if tool_name in self.EXPORT_TOOL_NAMES and isinstance(result, dict):
                                    data = result.get("data") or {}
                                    if result.get("success") and data.get("result_file_id") and data.get("sheet_name"):
                                        export_sheet_created = True
                                self.log.logger.debug(self.log.fmt(f'工具结果: {tool_use_id}, success={result.get("success", False)}'))
                                yield {
                                    "type": "tool_result",
                                    "tool_name": tool_use_id,
                                    "result": result,
                                }
                            except Exception as e:
                                self.log.logger.warning(self.log.fmt(f'解析工具结果失败: {str(e)}'))
                                yield {
                                    "type": "tool_result",
                                    "content": str(block.content),
                                }
                elif isinstance(message, UserMessage):
                    # UserMessage 中可能包含 ToolResultBlock
                    for block in message.content:
                        if isinstance(block, ToolResultBlock):
                            try:
                                content = block.content
                                if isinstance(content, str):
                                    result = json.loads(content)
                                elif isinstance(content, list) and content:
                                    for item in content:
                                        if isinstance(item, dict) and item.get('type') == 'text':
                                            result = json.loads(item.get('text', '{}'))
                                            break
                                    else:
                                        result = content
                                else:
                                    result = content
                                tool_use_id = getattr(block, 'tool_use_id', 'unknown')
                                tool_name = tool_use_name_by_id.get(str(tool_use_id), "")
                                if tool_name in self.EXPORT_TOOL_NAMES and isinstance(result, dict):
                                    data = result.get("data") or {}
                                    if result.get("success") and data.get("result_file_id") and data.get("sheet_name"):
                                        export_sheet_created = True
                                yield {
                                    "type": "tool_result",
                                    "tool_name": tool_use_id,
                                    "result": result,
                                }
                            except Exception:
                                pass
            
            self.log.logger.info(self.log.fmt(f'响应接收完成，共收到 {message_count} 条消息'))
            if require_export_sheet is None:
                must_export = self._requires_export_sheet(command, called_tools)
            else:
                must_export = bool(require_export_sheet)
            if must_export and not export_sheet_created:
                self.log.logger.warning(
                    self.log.fmt(
                        '强约束触发：分析请求未生成新工作表，判定失败 '
                        f'(called_tools={sorted(list(called_tools))}, require_export_sheet={require_export_sheet})'
                    )
                )
                yield {
                    "type": "error",
                    "content": "本次分析未成功创建新工作表，已按强约束拦截。请重试，我将直接导出结果到新的工作表。"
                }
            else:
                for text in text_blocks:
                    if text:
                        self.log.logger.info(
                            self.log.fmt(f'yield text: {text[:80] if text else "(空)"}...')
                        )
                        yield {
                            "type": "text",
                            "content": text,
                        }
            
            # 注意：大文件模式下源文件是只读的，不需要保存工作簿
            # 所有编辑操作都被禁用，结果输出到新文件
            self.log.logger.debug(self.log.fmt('大文件只读模式：无需保存源文件'))
            
            self._processing = False  # 标记处理完成
            self.log.logger.info(self.log.fmt('命令处理完成'))
            
            # 关键修复：每次请求后关闭 Claude client，下次请求重新创建
            # 这样可以避免 SDK 内部状态问题导致多轮对话失败
            # 注意：使用超时保护，避免 __aexit__ 阻塞导致 SSE 响应未完成
            self.log.logger.info(self.log.fmt('关闭 Claude client...'))
            if self.client:
                try:
                    import asyncio
                    # 使用 5 秒超时，避免无限等待
                    await asyncio.wait_for(
                        self.client.__aexit__(None, None, None),
                        timeout=5.0
                    )
                    self.log.logger.debug(self.log.fmt('Claude client 已关闭'))
                except asyncio.TimeoutError:
                    self.log.logger.warning(self.log.fmt('关闭 client 超时，强制清理'))
                except Exception as e:
                    self.log.logger.debug(self.log.fmt(f'关闭 client 时出现非致命错误: {e}'))
                finally:
                    self.client = None
            self.log.logger.info(self.log.fmt('处理流程结束'))
            
        except Exception as e:
            import traceback
            error_detail = str(e)
            self.log.logger.error(self.log.fmt(f'命令处理失败: {error_detail}'))
            self.log.logger.debug(self.log.fmt(f'堆栈: {traceback.format_exc()}'))
            # 大文件只读模式：无需保存源文件
            self._processing = False  # 标记处理完成
            yield {
                "type": "error",
                "content": f"处理失败: {error_detail}",
            }
    
    async def close(self):
        """关闭 Agent"""
        async with self._close_lock:
            if self._closed:
                return
            self._closed = True
            
            if self.client:
                try:
                    # 尝试优雅关闭，但不强制使用 __aexit__
                    # 因为在不同任务中调用会导致 cancel scope 错误
                    if hasattr(self.client, 'disconnect'):
                        await self.client.disconnect()
                    self.log.logger.info(self.log.fmt('Agent 已关闭'))
                except Exception as e:
                    # 忽略关闭时的错误，只记录警告
                    self.log.logger.debug(self.log.fmt(f'关闭时出现非致命错误: {e}'))
                finally:
                    self.client = None


class LargeFileAgentManager:
    """大型文件 Agent 管理器"""
    
    _instance: Optional['LargeFileAgentManager'] = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        
        self._agents: Dict[str, LargeFileAgent] = {}
        self._lock = asyncio.Lock()
        self._cleanup_task: Optional[asyncio.Task] = None
        self.log = AgentLogger('large_file.manager')
    
    async def start(self):
        """启动管理器"""
        if self._cleanup_task is None or self._cleanup_task.done():
            cleanup_interval = self._get_cleanup_interval()
            idle_timeout = self._get_idle_timeout()
            self.log.logger.info(f'LargeFileAgentManager 启动 (cleanup_interval={cleanup_interval}s, idle_timeout={idle_timeout}s)')
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())
    
    async def stop(self):
        """停止管理器"""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        
        # 关闭所有 Agent
        async with self._lock:
            for agent in self._agents.values():
                await agent.close()
            self._agents.clear()
        
        self.log.logger.info('LargeFileAgentManager 停止')
    
    def _get_cleanup_interval(self) -> int:
        """
        获取清理间隔时间（秒）
        
        大文件处理需要更长的间隔，默认 300 秒（5分钟）
        可通过 LARGE_FILE_AGENT_CLEANUP_INTERVAL_SEC 环境变量覆盖
        """
        return int(os.getenv('LARGE_FILE_AGENT_CLEANUP_INTERVAL_SEC', '300'))
    
    def _get_idle_timeout(self) -> int:
        """
        获取空闲超时时间（秒）
        
        大文件处理需要更长的超时，默认 600 秒（10分钟）
        可通过 LARGE_FILE_AGENT_IDLE_TTL_SEC 环境变量覆盖
        """
        return int(os.getenv('LARGE_FILE_AGENT_IDLE_TTL_SEC', '600'))
    
    async def _cleanup_loop(self):
        """
        定期清理空闲 Agent
        
        注意：大文件处理场景下，Claude API 响应可能需要较长时间。
        为避免在处理期间错误清理 Agent，我们使用较长的超时时间。
        """
        cleanup_interval = self._get_cleanup_interval()
        self.log.logger.debug(f'[manager] 清理循环启动，间隔={cleanup_interval}秒')
        
        while True:
            try:
                self.log.logger.debug(f'[manager] 等待 {cleanup_interval} 秒后执行清理...')
                await asyncio.sleep(cleanup_interval)
                self.log.logger.debug('[manager] 开始执行清理检查')
                await self._cleanup_idle_agents()
                self.log.logger.debug('[manager] 清理检查完成')
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log.logger.error(f'清理循环错误: {e}')
    
    async def _cleanup_idle_agents(self):
        """
        清理空闲的 Agent
        
        同时检查 _processing 标志，正在处理请求的 Agent 不会被清理。
        """
        self.log.logger.debug('[manager] === _cleanup_idle_agents 开始执行 (新版本) ===')
        idle_timeout = self._get_idle_timeout()
        self.log.logger.debug(f'[manager] 使用 idle_timeout={idle_timeout}s')
        
        async with self._lock:
            idle_agents = []
            agent_count = len(self._agents)
            
            if agent_count > 0:
                self.log.logger.debug(f'[manager] 检查 {agent_count} 个 Agent (idle_timeout={idle_timeout}s)')
            
            for sid, agent in self._agents.items():
                is_processing = agent._processing
                idle_time = time.monotonic() - agent._last_active_ts
                is_idle = agent.is_idle(idle_seconds=idle_timeout)
                
                self.log.logger.debug(f'[manager] Agent {sid[:8]}... processing={is_processing}, idle_time={idle_time:.1f}s, is_idle={is_idle}')
                
                # 只有在不处理请求且空闲超时的情况下才清理
                if is_idle and not is_processing:
                    self.log.logger.debug(f'[manager] Agent {sid[:8]}... 将被清理')
                    idle_agents.append(sid)
        
        for sid in idle_agents:
            self.log.logger.debug(f'[manager] 空闲超时，关闭 Agent: {sid}')
            await self.remove_agent(sid)
    
    async def get_or_create_agent(self, session_id: str, file_id: str, active_sheet: str = None) -> LargeFileAgent:
        """获取或创建 Agent"""
        async with self._lock:
            existing_agent = self._agents.get(session_id)
            agent_exists = existing_agent is not None
            agent_closed = existing_agent._closed if existing_agent else None
            agent_client = existing_agent.client is not None if existing_agent else None
            
            self.log.logger.debug(f'[manager] get_or_create: session={session_id[:8]}... exists={agent_exists}, closed={agent_closed}, has_client={agent_client}')
            
            # 如果 Agent 不存在或已关闭，创建新的
            if existing_agent is None or existing_agent._closed:
                if existing_agent is not None:
                    self.log.logger.info(f'Agent {session_id[:8]}... 已关闭，重新创建')
                    del self._agents[session_id]
                
                agent = LargeFileAgent(session_id)
                await agent.initialize()
                self._agents[session_id] = agent
                self.log.logger.info(f'创建新 Agent: {session_id}')
            else:
                agent = existing_agent
                # 检查 client 是否有效
                if agent.client is None:
                    self.log.logger.warning(f'Agent {session_id[:8]}... client 为 None，重新初始化')
                    await agent.initialize()
                self.log.logger.info(f'复用现有 Agent: {session_id}')
        
        # 设置文件上下文（传递活动工作表）
        await agent.set_file_context_async(file_id, active_sheet)
        
        return agent
    
    async def remove_agent(self, session_id: str):
        """移除 Agent"""
        agent = None
        async with self._lock:
            if session_id in self._agents:
                agent = self._agents.pop(session_id)
                self.log.logger.debug(f'[manager] 移除 Agent: {session_id}')
        
        if agent:
            await agent.close()
            self.log.logger.debug(f'[manager] Agent 关闭完成: {session_id}')


# 全局单例
large_file_agent_manager = LargeFileAgentManager()
