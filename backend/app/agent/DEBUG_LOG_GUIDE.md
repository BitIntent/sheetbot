# 字段名匹配失败调试日志指南

## 📋 概述

已添加详细的调试日志来追踪字段名匹配失败的问题。日志分为**后端日志**和**前端日志**两部分。

---

## 🔧 后端日志

### 日志文件位置

后端日志文件位于项目根目录的 `logs/` 文件夹中：

```
D:\dev\python\excel-ai\logs\
├── agent_2026-01-31.log          # Agent 主日志
├── agent.tools_2026-01-31.log    # 工具调用日志
└── agent.param_normalizer_2026-01-31.log  # 参数规范化日志（新增）
```

**注意**：文件名中的日期会根据当前日期变化（格式：`YYYY-MM-DD`）

### 日志查看方式

#### 方式1：查看日志文件（推荐）

直接打开日志文件查看：
- Windows: `D:\dev\python\excel-ai\logs\agent.param_normalizer_2026-01-31.log`
- Linux: `/path/to/excel-ai/logs/agent.param_normalizer_2026-01-31.log`

#### 方式2：查看控制台输出

后端日志也会输出到控制台（标准输出），如果后端服务正在运行，可以直接在终端查看。

### 关键日志标记

后端日志使用以下标记来标识关键信息：

#### 1. `normalize_field_names` 函数日志

**位置**：`backend/app/agent/param_normalizer.py`

**日志内容**：
- ✅ **输入参数**：`fields`、`excel_state` 状态、`sheet_name`、`headers` 数量
- ✅ **字段处理过程**：每个字段的类型和处理结果
- ✅ **输出结果**：规范化后的字段名数组

**示例日志**：
```
2026-01-31 16:30:00 | DEBUG    | agent.param_normalizer | normalize_field_names: 输入 fields=['产品ID'], excel_state=存在, sheet_name=销售明细, headers数量=12, headers=['订单行ID', '下单日期', '客户ID', '产品ID', '渠道']...
2026-01-31 16:30:00 | DEBUG    | agent.param_normalizer | normalize_field_names: 字段 "产品ID" 是字符串，直接使用
2026-01-31 16:30:00 | DEBUG    | agent.param_normalizer | normalize_field_names: 输出 normalized_fields=['产品ID']
```

#### 2. `_normalize_operation` 函数日志

**位置**：`backend/app/agent/excel_tools.py`

**日志内容**：
- ✅ **规范化前状态**：`excel_state` 参数是否存在
- ✅ **上下文获取**：从上下文获取 `excel_state` 的结果
- ✅ **关键参数**：`create_pivot_table` 的 `rowFields`、`colFields`、`valueFields`
- ✅ **规范化后结果**：规范化后的字段名

**示例日志**：
```
2026-01-31 16:30:00 | DEBUG    | agent.tools          | _normalize_operation: 开始规范化操作 type=create_pivot_table, excel_state参数=None
2026-01-31 16:30:00 | DEBUG    | agent.tools          | _normalize_operation: 从上下文获取 excel_state=存在
2026-01-31 16:30:00 | DEBUG    | agent.tools          | _normalize_operation: create_pivot_table 参数 - rowFields=['产品ID'], colFields=['渠道'], valueFields=['数量'], sheet=销售明细
2026-01-31 16:30:00 | DEBUG    | agent.tools          | _normalize_operation: create_pivot_table 规范化后 - rowFields=['产品ID'], colFields=['渠道'], valueFields=['数量']
```

### 关键检查点

在查看后端日志时，重点关注：

1. **`excel_state` 状态**：
   - ✅ 如果显示 `excel_state=存在`，说明 `excel_state` 已正确传递
   - ❌ 如果显示 `excel_state=None`，说明 `excel_state` 未传递或未设置

2. **字段名规范化**：
   - ✅ 如果字段名是字符串（如 `"产品ID"`），应该直接使用
   - ✅ 如果字段名是列号（如 `7`），应该转换为字段名（如 `"销售人员"`）

3. **规范化输出**：
   - ✅ 检查规范化后的字段名是否正确
   - ✅ 检查是否有警告日志（列号超出范围等）

---

## 🌐 前端日志

### 日志位置

前端日志输出到**浏览器控制台**（Browser Console）。

### 如何打开浏览器控制台

#### Chrome/Edge
- 按 `F12` 或 `Ctrl+Shift+I`（Windows/Linux）
- 或右键页面 → "检查" → 切换到 "Console" 标签

#### Firefox
- 按 `F12` 或 `Ctrl+Shift+K`（Windows/Linux）
- 或右键页面 → "检查元素" → 切换到 "控制台" 标签

#### Safari
- 按 `Cmd+Option+I`（Mac）
- 需要先在"偏好设置"中启用"开发"菜单

### 关键日志标记

前端日志使用 `[前端调试]` 标记来标识调试信息。

#### 1. `createPivotTable` 函数日志

**位置**：`frontend/src/utils/excelOperations.js`

**日志内容**：
- ✅ **接收到的原始参数**：`rowFields`、`colFields`、`valueFields` 等
- ✅ **表头信息**：`headers` 数组、`startColNum`、`endColNum`
- ✅ **字段匹配结果**：匹配前后的字段名对比

**示例日志**：
```javascript
[前端调试] createPivotTable: 接收到的原始参数 {
  sheet: "销售明细",
  sourceRange: {startRow: 1, startCol: 1, endRow: 201, endCol: 12},
  rowFields: ["产品ID"],
  colFields: ["渠道"],
  valueFields: ["数量"],
  rowFieldsArray: ["产品ID"],
  colFieldsArray: ["渠道"],
  valueFieldsArray: ["数量"]
}

[前端调试] createPivotTable: 表头信息 {
  headers: ["订单行ID", "下单日期", "客户ID", "产品ID", "渠道", ...],
  headersCount: 12,
  startColNum: 1,
  endColNum: 12,
  sourceSheetName: "销售明细"
}

[前端调试] createPivotTable: 字段匹配结果 {
  rowFieldsArray: ["产品ID"],
  matchedRowFields: ["产品ID"],
  colFieldsArray: ["渠道"],
  matchedColFields: ["渠道"],
  valueFieldsArray: ["数量"],
  matchedValueFields: ["数量"]
}
```

#### 2. `findFieldName` 函数日志

**位置**：`frontend/src/utils/excelOperations.js`

**日志内容**：
- ✅ **输入参数**：`fieldName`、`headers` 数量、`startColNum`
- ✅ **匹配过程**：精确匹配、模糊匹配、部分匹配的每一步
- ✅ **匹配结果**：成功或失败

**示例日志**：
```javascript
[前端调试] findFieldName: 输入 fieldName="产品ID" (类型: string), headers数量=12, startColNum=1
[前端调试] findFieldName: 精确匹配成功 "产品ID"
```

### 关键检查点

在查看前端日志时，重点关注：

1. **接收到的参数格式**：
   - ✅ 检查 `rowFieldsArray`、`colFieldsArray`、`valueFieldsArray` 的内容
   - ✅ 检查字段名是字符串还是数字（列号）

2. **表头信息**：
   - ✅ 检查 `headers` 数组是否包含所有字段名
   - ✅ 检查 `headersCount` 是否正确

3. **字段匹配**：
   - ✅ 检查 `matchedRowFields`、`matchedColFields`、`matchedValueFields` 是否为空数组
   - ✅ 如果匹配失败，查看 `findFieldName` 的详细日志

---

## 🔍 问题诊断流程

### 步骤1：检查后端规范化是否生效

1. 打开后端日志文件：`logs/agent.param_normalizer_2026-01-31.log`
2. 搜索 `normalize_field_names`
3. 检查：
   - `excel_state` 是否为 `存在`
   - 输入字段名格式（字符串还是列号）
   - 输出字段名是否正确

### 步骤2：检查参数传递

1. 打开后端日志文件：`logs/agent.tools_2026-01-31.log`
2. 搜索 `_normalize_operation`
3. 检查：
   - `excel_state参数` 是否为 `None`
   - 从上下文获取 `excel_state` 是否成功
   - 规范化前后的字段名对比

### 步骤3：检查前端接收

1. 打开浏览器控制台
2. 搜索 `[前端调试] createPivotTable`
3. 检查：
   - 接收到的 `rowFieldsArray` 格式
   - `headers` 数组内容
   - 字段匹配结果

### 步骤4：检查字段匹配

1. 在浏览器控制台搜索 `[前端调试] findFieldName`
2. 检查：
   - 每个字段的匹配过程
   - 匹配失败的原因

---

## 📝 日志级别说明

### 后端日志级别

- **DEBUG**：详细的调试信息（包括字段名规范化过程）
- **INFO**：一般信息（工具调用、操作生成等）
- **WARNING**：警告信息（列号超出范围、字段名匹配失败等）
- **ERROR**：错误信息（异常、失败等）

### 前端日志级别

- **console.log**：一般信息（参数、匹配结果等）
- **console.warn**：警告信息（字段名匹配失败等）
- **console.error**：错误信息（严重错误）

---

## 🎯 常见问题排查

### 问题1：后端日志显示 `excel_state=None`

**可能原因**：
- `excel_state` 未传递到 `_normalize_operation()`
- 上下文中的 `excel_state` 未设置

**解决方法**：
- 检查 `excel_agent.py` 中是否在工具函数调用前设置了 `excel_state`
- 检查 `_validate_and_add_operation()` 是否调用了 `set_excel_state()`

### 问题2：前端日志显示字段名匹配失败

**可能原因**：
- 后端传递的字段名格式不对（列号而不是字段名）
- 字段名与表头不完全匹配（空格、大小写等）

**解决方法**：
- 检查后端日志，确认规范化后的字段名
- 检查前端 `headers` 数组，确认字段名是否存在

### 问题3：字段名是列号而不是字符串

**可能原因**：
- 后端规范化未生效
- `excel_state` 为空，无法将列号转换为字段名

**解决方法**：
- 检查后端日志，确认 `normalize_field_names()` 是否被调用
- 检查 `excel_state` 是否正确传递

---

## 📞 需要帮助？

如果日志显示的问题不明确，请提供：
1. 后端日志片段（特别是 `normalize_field_names` 和 `_normalize_operation` 的日志）
2. 前端控制台日志片段（特别是 `[前端调试]` 标记的日志）
3. 具体的错误信息或异常行为
