# 大文件数据分析模块

采用"源文件只读 + 结果输出到新文件"架构，实现高性能大型 Excel 文件数据分析。

## ⚠️ 模式隔离原则（最高优先级）

**本模块（large_file/）与普通模式（agent/）完全隔离！**

### 隔离规则

1. **禁止跨模块导入**
   - 本模块不得 import `agent/` 下的任何文件
   - `agent/` 不得 import 本模块下的任何文件

2. **独立的工具体系**
   - 普通模式工具：`agent/excel_tools.py`（返回操作指令给前端）
   - 大文件工具：`large_file/large_file_tools.py`（服务器直接执行）
   - **两套工具完全独立，禁止复用**

3. **独立的 Agent**
   - 普通模式：`agent/excel_agent.py`
   - 大文件模式：`large_file/large_file_agent.py`
   - **System Prompt 完全不同，禁止混用**

4. **修改时的影响检查**
   - 修改本模块时，必须确认不会影响普通模式
   - 如果需要类似功能，必须在两个模块中**分别实现**

### 为什么要隔离？

| 维度 | 普通模式 | 大文件模式 |
|------|----------|------------|
| 数据位置 | 前端内存 | 服务器 DuckDB |
| 操作执行 | 前端 ExcelJS | 后端 DuckDB/pandas |
| 返回结果 | 操作指令 JSON | 执行结果 + 状态 |
| 文件持久化 | 无（用户下载） | 自动管理 |

两种模式的数据流、执行方式、结果格式完全不同，强行复用会导致：
- 代码耦合难以维护
- 修改一方影响另一方
- 测试复杂度指数增长

---

## 核心架构原则

```
┌─────────────────────────────────────────────────────────────────┐
│                    大文件数据分析架构                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌───────────────┐          ┌──────────────────┐              │
│   │   源文件       │          │    结果文件       │              │
│   │  (只读)       │   ───►   │   (新生成)       │              │
│   ├───────────────┤          ├──────────────────┤              │
│   │ ✅ 数据分析   │          │ ✅ 分析结果      │              │
│   │ ✅ 统计计算   │          │ ✅ 透视表        │              │
│   │ ❌ 禁止修改   │          │ ✅ 筛选数据      │              │
│   │ ❌ 禁止编辑   │          │ ✅ 分组统计      │              │
│   └───────────────┘          └──────────────────┘              │
│                                                                 │
│   ┌───────────────┐          ┌──────────────────┐              │
│   │   DuckDB      │          │    openpyxl      │              │
│   │  (分析引擎)   │          │   (输出引擎)     │              │
│   ├───────────────┤          ├──────────────────┤              │
│   │ ⚡ SQL 查询   │          │ 📝 创建新文件    │              │
│   │ ⚡ 聚合计算   │          │ 📝 写入结果      │              │
│   │ ⚡ 透视表     │          │ 💾 保存下载      │              │
│   │ ⚡ 毫秒级     │          │ 📊 小文件快速    │              │
│   └───────────────┘          └──────────────────┘              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 设计哲学

**为什么源文件只读？**
1. **数据安全**：原始数据受保护，不会被意外修改
2. **性能极佳**：无需加载大文件到内存修改，导出到新小文件极快
3. **可追溯**：每次分析都生成新文件，便于对比和回溯
4. **架构简洁**：消除了 openpyxl 加载大文件的性能瓶颈

## 目录结构

```
large_file/
├── __init__.py             # 模块导出
├── large_file_agent.py     # AI Agent（系统提示强调只读原则）
├── large_file_duckdb.py    # DuckDB Excel 管理器（高性能分析）
├── sheet_normalizer.py     # 工作表标准化（非标准表头/混合类型兼容）
├── column_schema_normalizer.py # 列结构标准化（空列名/重复列名/Unnamed）
├── value_coercer.py        # 值清洗与类型归一化（含透视/汇总表分流）
├── large_file_tools.py     # MCP 工具（只读分析 + 导出新文件）
├── storage.py              # 文件存储（支持源文件和结果文件）
├── schemas.py              # 数据模型（FileType 区分文件类型）
└── CLAUDE.md               # 本文档
```

## 文件类型

```python
class FileType(str, Enum):
    SOURCE = "source"   # 源文件（用户上传，只读）
    RESULT = "result"   # 结果文件（系统生成，可下载）
```

## 模块职责

### schemas.py
数据模型定义：
- `FileType`：区分源文件和结果文件
- `FileMetadata`：包含 `file_type`、`source_file_id`、`result_file_ids`
- `FileStatus`：文件状态枚举

### storage.py
文件存储管理器，负责：
- 保存源文件和结果文件
- 维护源文件与结果文件的关联关系
- DuckDB 预加载（仅源文件）
- 获取源文件的所有结果文件

### large_file_tools.py
MCP 工具定义，分为三类：

**只读分析工具（可用）：**
- `query_data` - SQL 查询
- `get_unique_values` - 获取唯一值
- `get_column_statistics` - 列统计
- `create_pivot_table` - 创建透视表（内存）
- `group_by_aggregate` - 分组聚合
- `get_data_preview` - 数据预览
- `get_file_info` - 文件信息
- `get_sheet_info` - 工作表信息

**导出到新文件工具（可用）：**
- `export_query_to_new_file` - SQL 查询结果 → 新文件
- `export_pivot_to_sheet` - 透视表 → 新文件
- `export_statistics_to_sheet` - 数值列统计信息 → 新文件
- `export_grouped_data` - 分组统计 → 新文件

**编辑工具（已禁用，返回友好错误）：**
- `set_cell_value`, `set_range_values` 等
- 调用时返回架构说明，引导使用导出工具

### large_file_agent.py
大文件 AI Agent，负责：
- System Prompt 强调只读原则
- 引导使用分析和导出工具
- 上下文管理

### large_file_duckdb.py
DuckDB Excel 管理器，负责：
- 高效读取 Excel 到内存表
- SQL 查询和聚合
- 透视表计算

### sheet_normalizer.py
工作表标准化模块，负责：
- 非标准表头兼容（空列名/重复列名归一化）
- object 列值清洗（bytes、空值、混合类型）
- DataFrame -> Arrow 稳健转换（失败自动降级重试）

### column_schema_normalizer.py
列结构标准化模块，负责：
- `Unnamed:*` 与空列名归一化
- 重复列名稳定去重（追加 `_2/_3`）

### value_coercer.py
值清洗与类型归一化模块，负责：
- 检测透视/汇总类工作表（关键词 + 列名形态）
- 分流清洗策略：汇总类表优先字符串稳健导入
- 常规表按混合类型自动降级

## 数据流

```
上传阶段：
用户上传 → storage.save_file(type=SOURCE) → 保存 → 异步加载到 DuckDB → 返回预览

分析阶段：
用户指令 → large_file_agent.process_command()
         → 只读工具（DuckDB 查询/聚合）→ 毫秒级响应
         → 禁用工具（编辑操作）       → 返回错误提示

导出阶段：
用户请求导出 → export_xxx 工具
            → DuckDB 计算结果
            → openpyxl 创建新文件（内存）
            → storage.save_file(type=RESULT, source_file_id=xxx)
            → 返回 new_file_id

下载阶段：
用户下载 → GET /api/large-file/download/{file_id} → FileResponse
```

## API 端点

| 端点 | 方法 | 说明 |
|-----|------|-----|
| `/api/large-file/upload` | POST | 上传源文件 |
| `/api/large-file/status/{file_id}` | GET | 获取文件状态（含结果文件列表） |
| `/api/large-file/results/{source_file_id}` | GET | 获取源文件的所有结果文件 |
| `/api/large-file/download/{file_id}` | GET | 下载文件（源文件或结果文件） |
| `/api/large-file/preview/{file_id}` | GET | 预览文件 |

## 性能对比

| 场景 | 旧架构（修改源文件） | 新架构（输出新文件） |
|-----|-------------------|-------------------|
| 创建透视表 | 加载大文件 → 修改 → 保存 (60min+) | DuckDB 计算 → 创建小文件 (秒级) |
| 数据筛选 | 需 openpyxl 操作大文件 | SQL 查询 → 创建小文件 (秒级) |
| 内存占用 | 可能 OOM | 仅结果数据 |
| 源文件安全 | 可能被破坏 | 完全保护 |

## 变更日志

### 2026-03-07
- 二次拆分 `sheet_normalizer.py`：新增 `column_schema_normalizer.py` 与 `value_coercer.py`
- 增加“透视/汇总类”工作表识别与分流清洗，提升非标准表兼容性与导入稳定性。
- 新增 `sheet_normalizer.py`，从 `large_file_duckdb.py` 拆分非标准表兼容逻辑：
  - 列名标准化（空名补齐 + 重复名去重）
  - 混合类型统一清洗并按需降级字符串
  - Arrow 转换失败自动 fallback（object 全量字符串）
- `large_file_duckdb.py` 改为调用标准化模块，降低解析/导入耦合，提升可维护性与健壮性。

### 2026-01-30
- **安全规则**：禁止向用户暴露技术栈信息
  - System Prompt 新增"安全规则"章节
  - 禁止提及：DuckDB、openpyxl、pandas、pyarrow、内部表名、文件ID 等
- **结果表二次/三次加工修复**：支持对结果工作表进行多级加工
  - 修复 `query_data`、`export_query_to_sheet`、`export_query_to_new_file` 工具
  - 修复 `get_data_preview` 工具：检测以"结果_"开头的工作表，直接从 DuckDB 内存获取
  - **关键修复**：`export_query_to_new_file` 现在会调用 `register_result_table()` 注册结果到 DuckDB 内存
  - **关键修复**：`get_file_info` 现在返回 `result_tables` 字段，列出内存中的结果表
  - **关键修复**：`set_file_context` 重构，正确处理三种工作表类型：
    1. 源文件工作表（在 `meta.sheet_names` 中）
    2. 内存结果表（以 `结果_` 开头，通过 `get_result_table_name` 验证）
    3. 回退到源文件第一个工作表
  - **关键修复**：工具层结果表检测增强（v2）
    - 检测两种情况：SQL 中的 `{table:结果_xxx}` 格式 OR `sheet_name` 以 `结果_` 开头
    - 修复 AI 使用 `{table}` + `sheet_name="结果_xxx"` 组合时的加载失败问题
    - 方式 A（`{table:结果_xxx}`）也增加提前验证，统一错误消息格式
  - **关键修复**：`_resolve_table_placeholders` 增强
    - 解析 `{table}` 占位符时，先检查 `default_sheet` 是否为结果表
    - 如果是结果表，优先从结果表缓存中查找表名
  - System Prompt 新增"结果表二次加工"章节，明确告知 AI 结果表存在于内存中
  - 当 SQL 引用结果表时，跳过源文件加载，直接从 DuckDB 内存读取
  - 支持链式加工：透视表结果 → SQL筛选 → 再次聚合（无限级）

### 2026-01-29
- **工作表上下文同步修复**：切换工作表时正确同步列标题
  - `set_file_context()` 现在传入 `active_sheet` 到 DuckDB 获取对应工作表的列
  - 上下文字符串中明确标注列标题属于哪个工作表
- **文件扩展名修复**：下载结果文件时确保有 `.xlsx` 扩展名
  - `main.py` 的 `download_large_file` 函数添加扩展名检查
  - `storage.py` 的 `get_or_create_result_file` 和 `save_memory_results_to_file` 添加扩展名检查
- **字段验证规则**：AI Agent 必须在执行操作前验证字段是否存在
  - 字段不存在时必须询问用户确认，禁止自动替换
  - System Prompt 新增"字段验证规则"章节
- **操作日志功能**：新增 `_操作日志` 工作表，记录每个结果的计算逻辑
  - 字段：序号、结果工作表、操作类型、计算逻辑、生成时间、数据行数、耗时
  - 操作日志工作表放在第一个位置（容易发现）
  - 关闭结果工作表时同步删除对应的日志记录
  - 下载结果文件时包含操作日志
  - `storage.py` 新增 `add_operation_log()`、`remove_operation_log()`、`sync_operation_log_to_file()` 方法
  - **修复**：`sync_operation_log_to_file()` 现在会调用 `_update_file_metadata()` 更新元数据，确保前端能看到操作日志工作表
- **新增工具**：`export_statistics_to_sheet` - 计算数值列统计信息并导出到新工作表
  - 支持指定列或自动检测所有数值列
  - 统计信息包括计数、唯一值数、最小值、最大值、平均值、总和
  - 支持二次加工（注册到 DuckDB）
- **生命周期管理**：实现 DuckDB 表生命周期管理
  - `large_file_duckdb.py` 新增 `unload_sheet()` 卸载单个工作表
  - `large_file_duckdb.py` 新增 `clear_session_cache()` 清空会话所有表
  - `large_file_duckdb.py` 新增 `register_result_table()` 注册结果表支持二次加工
  - `large_file_duckdb.py` 新增 `list_available_tables()` 列出可用表
- **结果二次加工**：支持在结果工作表上进行二次 SQL 查询和透视表操作
  - `_resolve_table_placeholders()` 支持引用结果表
  - `export_query_to_sheet` 和 `export_pivot_to_sheet` 自动注册结果到 DuckDB
- **API 增强**：
  - `POST /api/large-file/close-sheet` 关闭工作表并释放 DuckDB 内存
  - `POST /api/large-file/clear-session` 清空会话所有内存
  - `GET /api/large-file/download/{file_id}?clear_memory=true` 下载后清空内存
- **后端进度反馈**：
  - 工具执行包含详细 `steps`、`execution_time_ms`、`sql_executed`
  - SSE 新增 `backend_progress` 事件类型推送执行进度
  - `schemas.py` 新增 `BACKEND_PROGRESS` 消息类型
- **存储清理**：
  - `storage.py` 新增 `clear_session_memory()` 清空会话内存结果
  - `remove_memory_result()` 增强，返回剩余工作表列表

### 2026-01-26
- **重大架构变更**：实现"源文件只读 + 结果输出到新文件"架构
- 新增 `FileType` 枚举区分源文件和结果文件
- `storage.py` 新增结果文件关联管理
- `large_file_tools.py` 禁用所有编辑工具，新增 `export_grouped_data`
- `large_file_agent.py` 更新 System Prompt 强调只读原则
- `main.py` 新增 `/api/large-file/results/{source_file_id}` 端点
- 前端新增结果文件列表和下载功能

### 2026-01-24
- 重构为 DuckDB + openpyxl 混合架构
- 新增 large_file_duckdb.py - DuckDB Excel 管理器
- 新增 DuckDB 高性能工具

### 2026-01-24 (Earlier)
- 初始实现大文件处理模块
