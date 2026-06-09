# backend/app/agent/excel_tools.py
"""
Custom MCP Tools for Excel Operations
定义 Agent 可调用的 Excel 操作工具
"""
import json
import re
from contextvars import ContextVar
from typing import Any, Dict, List, Optional
from claude_agent_sdk import tool, create_sdk_mcp_server
from ..utils.logger import get_logger
from .param_normalizer import normalize_operation_params, camel_to_snake_op_type
from .operation_validator import validate_operation_params

# 工具调用日志
tool_log = get_logger('agent.tools')

# ── 会话级上下文（由 process_command 注入，工具函数读取）──
_tool_log_prefix: ContextVar[str] = ContextVar("tool_log_prefix", default="")
_tool_session_id: ContextVar[str] = ContextVar("tool_session_id", default="")
_tool_excel_state_cache: Dict[str, Dict[str, Any]] = {}
_tool_excel_state_seq: Dict[str, int] = {}
_tool_excel_state_tick = 0
_TOOL_EXCEL_STATE_CACHE_LIMIT = 200


def set_tool_log_prefix(prefix: str):
    """由 ExcelAgent.process_command 在请求开始时调用，注入 [session_id] @user 前缀"""
    _tool_log_prefix.set(prefix)


def _log_prefix() -> str:
    """获取当前上下文的日志前缀"""
    return _tool_log_prefix.get("")


def set_tool_session_id(session_id: str):
    """注入当前会话 ID，供工具读取会话级缓存。"""
    _tool_session_id.set(str(session_id or "").strip())


def set_tool_excel_state_snapshot(session_id: str, excel_state: Optional[Dict[str, Any]]):
    """缓存会话级 excel_state，避免 ContextVar 在异步边界丢失。"""
    global _tool_excel_state_tick
    sid = str(session_id or "").strip()
    if not sid or not isinstance(excel_state, dict):
        return
    _tool_excel_state_cache[sid] = excel_state
    _tool_excel_state_tick += 1
    _tool_excel_state_seq[sid] = _tool_excel_state_tick
    if len(_tool_excel_state_cache) > _TOOL_EXCEL_STATE_CACHE_LIMIT:
        stale_keys = list(_tool_excel_state_cache.keys())[: len(_tool_excel_state_cache) - _TOOL_EXCEL_STATE_CACHE_LIMIT]
        for key in stale_keys:
            _tool_excel_state_cache.pop(key, None)
            _tool_excel_state_seq.pop(key, None)


def _get_tool_excel_state_fallback() -> Dict[str, Any]:
    """优先从 ContextVar 取 excel_state，缺失时回退会话缓存。"""
    from .param_normalizer import get_excel_state

    ctx_state = get_excel_state()
    if isinstance(ctx_state, dict) and (ctx_state.get("sheets") or ctx_state.get("activeSheet")):
        return ctx_state

    sid = _tool_session_id.get("").strip()
    if sid:
        cached = _tool_excel_state_cache.get(sid)
        if isinstance(cached, dict):
            return cached
    # 最后兜底：回退到最近一次可用快照
    if _tool_excel_state_cache:
        latest_sid = max(_tool_excel_state_seq.keys(), key=lambda k: _tool_excel_state_seq.get(k, 0))
        latest = _tool_excel_state_cache.get(latest_sid)
        if isinstance(latest, dict):
            return latest
    return ctx_state if isinstance(ctx_state, dict) else {}


def _recover_excel_state_by_plan(raw_plan: Dict[str, Any]) -> Dict[str, Any]:
    """
    当 ContextVar/session 绑定失效时，根据计划中的 source_sheet 反查缓存快照。
    选择规则：
    1) 覆盖所有 source_sheet 的候选
    2) 若多个候选，取最新快照
    """
    blocks = raw_plan.get("blocks") if isinstance(raw_plan, dict) else None
    if not isinstance(blocks, list) or not blocks:
        return {}
    required_sheets = {
        str(b.get("source_sheet") or b.get("sourceSheet") or "").strip()
        for b in blocks
        if isinstance(b, dict)
    }
    required_sheets = {name for name in required_sheets if name}
    if not required_sheets:
        return {}

    best_sid = ""
    best_seq = -1
    for sid, state in _tool_excel_state_cache.items():
        if not isinstance(state, dict):
            continue
        sheets = state.get("sheets") or []
        available = {str(s.get("name") or "").strip() for s in sheets if isinstance(s, dict)}
        if not required_sheets.issubset(available):
            continue
        seq = _tool_excel_state_seq.get(sid, 0)
        if seq > best_seq:
            best_seq = seq
            best_sid = sid

    if best_sid:
        return _tool_excel_state_cache.get(best_sid) or {}
    return {}


def _parse_list_param(param: Any, default: List[Any] = None) -> List[Any]:
    """
    解析列表参数（可能是字符串或列表）
    处理 LLM 可能返回的 JSON 字符串格式
    
    Args:
        param: 参数值（可能是字符串、列表或其他类型）
        default: 默认值（如果参数为空）
    
    Returns:
        解析后的列表
    """
    if default is None:
        default = []
    
    if isinstance(param, list):
        return param
    if isinstance(param, str):
        param_str = param.strip()
        if param_str.startswith('['):
            try:
                import json
                parsed = json.loads(param_str)
                if isinstance(parsed, list):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass
        # 如果不是 JSON 数组，尝试按逗号分割
        if ',' in param_str:
            return [item.strip() for item in param_str.split(',') if item.strip()]
        # 单个值，转换为单元素数组
        return [param_str] if param_str else default
    return param if param else default


def _parse_dict_param(param: Any, default: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    解析字典参数（可能是字符串或字典）
    处理 LLM 可能返回的 JSON 字符串格式
    
    Args:
        param: 参数值（可能是字符串、字典或其他类型）
        default: 默认值（如果参数为空）
    
    Returns:
        解析后的字典
    """
    if default is None:
        default = {}
    
    if isinstance(param, dict):
        return param
    if isinstance(param, str):
        param_str = param.strip()
        if param_str.startswith('{'):
            try:
                import json
                parsed = json.loads(param_str)
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass
    return param if param else default


def _split_csv_like_row(row_text: str) -> List[str]:
    """按 CSV 规则拆分一行（容错版，支持不规范引号）。"""
    tokens: List[str] = []
    current: List[str] = []
    in_quotes = False
    quote_char = ""
    i = 0
    while i < len(row_text):
        ch = row_text[i]
        if ch in ('"', "'"):
            if in_quotes and ch == quote_char:
                in_quotes = False
                quote_char = ""
            elif not in_quotes:
                in_quotes = True
                quote_char = ch
            else:
                current.append(ch)
        elif ch == ',' and not in_quotes:
            tokens.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    tokens.append("".join(current).strip())
    return tokens


def _parse_loose_2d_array(raw: str) -> Optional[List[List[Any]]]:
    """
    宽松解析二维数组字符串：
    - 允许局部坏转义/未加引号裸词（如 Valve）
    - 行内按逗号分列，数字转为数值，其它按字符串保留
    """
    text = raw.strip()
    if not (text.startswith('[') and text.endswith(']')):
        return None

    rows_raw: List[str] = []
    depth = 0
    row_start = -1
    for idx, ch in enumerate(text):
        if ch == '[':
            depth += 1
            if depth == 2:
                row_start = idx
        elif ch == ']':
            if depth == 2 and row_start >= 0:
                rows_raw.append(text[row_start:idx + 1])
                row_start = -1
            depth -= 1

    if not rows_raw:
        return None

    parsed_rows: List[List[Any]] = []
    for row in rows_raw:
        body = row[1:-1].strip()
        if not body:
            parsed_rows.append([])
            continue

        cols = _split_csv_like_row(body)
        parsed_cols: List[Any] = []
        for col in cols:
            token = col.strip()
            if not token or token in ('\\""', '\\"', '""', "''"):
                parsed_cols.append("")
                continue

            token = token.replace('\\"', '"').strip()

            if (token.startswith('"') and token.endswith('"')) or (token.startswith("'") and token.endswith("'")):
                token = token[1:-1]
                parsed_cols.append(token)
                continue

            if re.fullmatch(r"-?\d+", token):
                parsed_cols.append(int(token))
                continue
            if re.fullmatch(r"-?\d+\.\d+", token):
                parsed_cols.append(float(token))
                continue

            lowered = token.lower()
            if lowered == 'true':
                parsed_cols.append(True)
            elif lowered == 'false':
                parsed_cols.append(False)
            elif lowered == 'null':
                parsed_cols.append(None)
            else:
                parsed_cols.append(token)
        parsed_rows.append(parsed_cols)

    return parsed_rows


def _coerce_set_range_values(values_param: Any) -> tuple[Any, Optional[str]]:
    """
    尝试将 set_range_values 的 values 参数纠正为二维数组。
    返回值: (纠正后的值, 纠正说明)
    """
    if isinstance(values_param, list):
        return values_param, None
    if not isinstance(values_param, str):
        return values_param, None

    raw = values_param.strip()
    if not raw.startswith('['):
        return values_param, None

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return parsed, "values 参数由字符串成功解析为数组"
    except Exception:
        pass

    # 常见坏格式修复：首列编码缺失结束引号（如 ["P003,"华为...）
    repaired = re.sub(r'(\["[A-Za-z]{1,4}\d{2,}),"', r'\1","', raw)
    # 常见坏格式修复：异常转义空字符串（如 ,\\"",899）
    repaired = re.sub(r',\s*\\+""\s*,', ',"",', repaired)

    try:
        parsed = json.loads(repaired)
        if isinstance(parsed, list):
            return parsed, "values 参数存在断引号，已自动修复并解析"
    except Exception:
        pass

    # 最后一层容错：宽松二维数组解析（容忍裸词、坏转义）
    loose = _parse_loose_2d_array(repaired)
    if isinstance(loose, list):
        return loose, "values 参数存在格式噪声，已通过宽松解析自动修复"

    return values_param, None


def _log_tool_call(tool_name: str, args: Dict[str, Any]) -> None:
    """记录工具调用"""
    pfx = _log_prefix()
    tool_log.info(f'{pfx}Tool Call: {tool_name}')
    tool_log.debug(f'{pfx}Tool Args: {args}')


def _log_tool_result(tool_name: str, result: Dict[str, Any]) -> None:
    """记录工具结果"""
    pfx = _log_prefix()
    op_type = result.get('operation', {}).get('type', 'unknown')
    tool_log.info(f'{pfx}Tool Result: {tool_name} -> {op_type}')


def _normalize_operation(operation: Dict[str, Any], excel_state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    规范化操作参数，确保类型与前端期望一致
    
    Args:
        operation: 操作字典，包含 type 和 params
        excel_state: Excel 状态（用于字段名转换），如果为 None 则从上下文获取
    
    Returns:
        规范化后的操作字典
    """
    try:
        op_type = operation.get("type", "")
        params = operation.get("params", {})
        
        pfx = _log_prefix()
        tool_log.debug(
            f'{pfx}_normalize_operation: 开始规范化操作 type={op_type}, '
            f'excel_state参数={"存在" if excel_state is not None else "None"}'
        )
        
        # 如果没有传递 excel_state，尝试从上下文获取
        if excel_state is None:
            from .param_normalizer import get_excel_state
            excel_state = get_excel_state()
            tool_log.debug(
                f'{pfx}_normalize_operation: 从上下文获取 excel_state={"存在" if excel_state else "None"}'
            )
        else:
            tool_log.debug(f'{pfx}_normalize_operation: 使用传入的 excel_state')
        
        # 记录关键参数（用于调试字段名规范化）
        if op_type == 'create_pivot_table':
            tool_log.debug(
                f'{pfx}_normalize_operation: create_pivot_table 参数 - '
                f'rowFields={params.get("rowFields", [])}, '
                f'colFields={params.get("colFields", [])}, '
                f'valueFields={params.get("valueFields", [])}, '
                f'sheet={params.get("sheet", "")}'
            )
        
        # 规范化参数（传递 excel_state 用于字段名转换）
        normalized_params = normalize_operation_params(op_type, params, excel_state)
        
        # 🔍 调试日志：记录规范化后的关键参数
        if op_type == 'create_pivot_table':
            tool_log.debug(
                f'{pfx}_normalize_operation: create_pivot_table 规范化后 - '
                f'rowFields={normalized_params.get("rowFields", [])}, '
                f'colFields={normalized_params.get("colFields", [])}, '
                f'valueFields={normalized_params.get("valueFields", [])}'
            )
        
        return {
            "type": op_type,
            "params": normalized_params
        }
    except Exception as e:
        # 如果规范化失败，记录错误但返回原始 operation
        tool_log.warning(f'{_log_prefix()}参数规范化失败: {e}, operation={operation}', exc_info=True)
        return operation


def _create_tool_result(
    operation: Dict[str, Any],
    description: str = "",
    excel_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    创建标准格式的工具返回值
    将 operation 编码到 text 中，因为 SDK 可能过滤自定义 content 类型
    
    Args:
        operation: 操作字典
        description: 描述文本
        excel_state: Excel 状态（用于参数规范化）
    """
    return _create_tool_result_with_operations([operation], description, excel_state)


def _create_tool_result_with_operations(
    operations: List[Dict[str, Any]],
    description: str = "",
    excel_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    创建包含多个操作的工具返回值
    
    Args:
        operations: 操作列表
        description: 描述文本
        excel_state: Excel 状态（用于参数规范化）
    
    Returns:
        包含多个操作的工具返回值
    """
    import json
    # 规范化所有操作参数（传递 excel_state 用于字段名转换）
    normalized_operations = [_normalize_operation(op, excel_state) for op in operations]
    
    content = []
    
    if description:
        content.append({"type": "text", "text": description})
    
    # 添加所有操作到 content
    # 仅使用 text 编码，避免 SDK 对自定义 content.type=operation 打告警。
    for normalized_operation in normalized_operations:
        # 编码到 text 中（Agent 侧会解析 __EXCEL_OPERATION__ 前缀）
        operation_json = json.dumps(normalized_operation, ensure_ascii=False)
        content.append({"type": "text", "text": f"__EXCEL_OPERATION__:{operation_json}"})
    
    return {"content": content}


# ============================================================
# 通用工具预校验（LLM 可见的错误反馈 → 自然重试闭环）
# ============================================================
def _prevalidate_args(
    tool_name: str,
    args: Dict[str, Any],
    required: List[str],
    int_keys: Optional[List[str]] = None,
) -> Optional[str]:
    """
    通用必填参数 + 类型预校验。
    返回 None 表示通过；返回 str 表示错误文本（直接回传给 LLM）。
    int_keys 中的键会尝试 int() 强转，失败则报错。
    """
    missing = [k for k in required if k not in args or args[k] is None]
    if missing:
        return (
            f"[{tool_name}] ERROR: missing required params: {missing}. "
            f"Please provide all of: {required}"
        )
    if int_keys:
        for k in int_keys:
            v = args.get(k)
            if v is not None and not isinstance(v, (int, float)):
                try:
                    args[k] = int(v)
                except (ValueError, TypeError):
                    return f"[{tool_name}] ERROR: '{k}' must be integer, got: {v!r}"
    return None


def _reject(error_text: str) -> Dict[str, Any]:
    """返回 LLM 可见的错误 tool result"""
    return {"type": "text", "text": error_text}


# ============================================================
# Cell Operations Tools
# ============================================================

@tool("set_cell_value",
    """Set a value to a specific cell. Use this to write text, numbers, or dates to cells.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置单元格值
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表的第[行号]行第[列号]列设置了值：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **值**：[值内容]
    
    [可选：说明设置该值的目的或效果]
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始，A=1, B=2, ...）
    - value: 要设置的值（文本、数字或日期）""",
    {"sheet": str, "row": int, "col": int, "value": str})
async def set_cell_value(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set value to a cell"""
    _log_tool_call("set_cell_value", args)
    err = _prevalidate_args("set_cell_value", args, ["sheet", "row", "col", "value"], ["row", "col"])
    if err:
        return _reject(err)
    operation = {
        "type": "set_cell_value",
        "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "value": args["value"]}
    }
    result = _create_tool_result(operation, f"Operation: set_cell_value at {args['sheet']}!R{args['row']}C{args['col']} = {args['value']}")
    _log_tool_result("set_cell_value", {"operation": operation})
    return result


@tool("set_cell_formula",
    """Set a formula to a specific cell. Formulas should start with '='. Supports common Excel formulas like SUM, AVERAGE, COUNT, IF, VLOOKUP, etc.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置单元格公式
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表的第[行号]行第[列号]列设置了公式：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **公式**：[公式内容]
    - ✅ **功能**：[公式的作用说明，如"计算总金额"、"查找匹配值"等]
    
    [可选：说明公式的计算逻辑或使用提示]
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - formula: Excel公式（必须以'='开头）""",
    {"sheet": str, "row": int, "col": int, "formula": str})
async def set_cell_formula(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set formula to a cell"""
    _log_tool_call("set_cell_formula", args)
    formula = args["formula"]
    if not formula.startswith("="):
        formula = "=" + formula
    operation = {
        "type": "set_cell_formula",
        "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "formula": formula}
    }
    result = _create_tool_result(operation, f"Operation: set_cell_formula at {args['sheet']}!R{args['row']}C{args['col']} = {formula}")
    _log_tool_result("set_cell_formula", {"operation": operation})
    return result


@tool("set_cell_style",
    """Apply styling to a specific cell. Style object can include: bold (bool), fontColor (string like '#FFFFFF'), backgroundColor (string like '#00008B'), fontSize (int), horizontalAlignment ('left'/'center'/'right'), verticalAlignment ('top'/'middle'/'bottom'), numberFormat. For numberFormat, use 'currency' for currency format (¥1,000.00), 'percentage' for percentage, 'number' for number with thousand separators, or Excel format strings like '#,##0.00'.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置单元格样式
    
    ✅ **操作已完成！**
    
    我已成功为"[工作表名]"工作表的第[行号]行第[列号]列设置了样式：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **字体加粗**：[是/否]
    - ✅ **背景色**：[颜色代码]（[颜色名称]）
    - ✅ **文字颜色**：[颜色代码]（[颜色名称]）
    - ✅ **字体大小**：[字号]（如果设置了）
    - ✅ **数字格式**：[格式类型]（如果设置了）
    
    样式已应用，单元格现在更加[效果描述，如"醒目"、"易读"等]。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - style: 样式对象，包含 bold, backgroundColor, fontColor, fontSize, horizontalAlignment, verticalAlignment, numberFormat 等""",
    {"sheet": str, "row": int, "col": int, "style": dict})
async def set_cell_style(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set style to a cell"""
    _log_tool_call("set_cell_style", args)
    base_params = {
        "sheet": args["sheet"],
        "row": args["row"],
        "col": args["col"],
        "style": args["style"]
    }
    normalized_params = normalize_operation_params("set_cell_style", base_params)
    operation = {
        "type": "set_cell_style",
        "params": normalized_params
    }
    result = _create_tool_result(operation, f"Operation: set_cell_style at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("set_cell_style", {"operation": operation})
    return result


@tool("clear_cell",
    """Clear the content and/or formatting of a specific cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：清除单元格内容
    
    ✅ **操作已完成！**
    
    我已成功清除了"[工作表名]"工作表的第[行号]行第[列号]列：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **清除内容**：[是/否]
    - ✅ **清除格式**：[是/否]
    
    单元格已清空，可以重新输入数据。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - clear_format: 是否清除格式（默认False，只清除内容）""",
    {"sheet": str, "row": int, "col": int, "clear_format": bool})
async def clear_cell(args: Dict[str, Any]) -> Dict[str, Any]:
    """Clear a cell"""
    _log_tool_call("clear_cell", args)
    operation = {
        "type": "clear_cell",
        "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "clearFormat": args.get("clear_format", False)}
    }
    result = _create_tool_result(operation, f"Operation: clear_cell at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("clear_cell", {"operation": operation})
    return result


# ============================================================
# Range Operations Tools
# ============================================================

@tool("set_range_values",
    """Set values to a range of cells. Values should be a 2D array matching the range dimensions.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：填充范围值
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表的[范围描述]填充了值：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **填充内容**：[描述填充的内容，如"公式"、"数据"等]
    - ✅ **范围大小**：[行数]行 x [列数]列，共[总数]个单元格
    
    [可选：说明填充的目的或效果，如"所有单元格已自动计算"、"数据已批量填充"等]
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row: 起始行号（从1开始）
    - start_col: 起始列号（从1开始）
    - values: 二维数组，包含要填充的值""",
    {"sheet": str, "start_row": int, "start_col": int, "values": list})
async def set_range_values(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set values to a range"""
    _log_tool_call("set_range_values", args)
    err = _prevalidate_args("set_range_values", args, ["sheet", "start_row", "start_col", "values"], ["start_row", "start_col"])
    if err:
        return _reject(err)
    values, repair_note = _coerce_set_range_values(args.get("values"))
    if repair_note:
        tool_log.warning(f"{_log_prefix()}set_range_values 参数纠正: {repair_note}")
    base_params = {
        "sheet": args["sheet"],
        "startRow": args["start_row"],
        "startCol": args["start_col"],
        "values": values
    }
    normalized_params = normalize_operation_params("set_range_values", base_params)
    operation = {
        "type": "set_range_values",
        "params": normalized_params
    }
    result = _create_tool_result(operation, f"Operation: set_range_values starting at {args['sheet']}!R{args['start_row']}C{args['start_col']}")
    _log_tool_result("set_range_values", {"operation": operation})
    return result


@tool("set_range_style",
    """Apply styling to a cell range. Typically used inside batch_operations for bulk formatting.

    Style properties (all optional, include only those needed):
    - bold: true/false
    - backgroundColor: "#hex" (e.g. "#217346")
    - fontColor: "#hex"
    - fontSize: int (points)
    - horizontalAlignment: "left" | "center" | "right"
    - verticalAlignment: "top" | "middle" | "bottom"
    - numberFormat: "number" | "currency" | "percentage" | "integer" | or Excel pattern like "#,##0.00"
    - borderStyle: "thin" | "medium" | "thick"
    - borderColor: "#hex"

    Parameters:
    - sheet, start_row, start_col, end_row, end_col: target range (1-based)
    - style: dict of style properties above

    Common mistakes:
    - Using raw color names ("red") instead of hex ("#FF0000").
    - Applying style row-by-row instead of using batch_operations with full ranges.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "style": dict})
async def set_range_style(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set style to a range"""
    _log_tool_call("set_range_style", args)
    err = _prevalidate_args("set_range_style", args,
        ["sheet", "start_row", "start_col", "end_row", "end_col", "style"],
        ["start_row", "start_col", "end_row", "end_col"])
    if err:
        return _reject(err)
    # 构造基础参数（snake_case -> camelCase）
    base_params = {
        "sheet": args["sheet"],
        "startRow": args["start_row"],
        "startCol": args["start_col"],
        "endRow": args["end_row"],
        "endCol": args["end_col"],
        "style": args["style"]
    }
    # 规范化参数（确保类型正确，特别是 style 如果是 JSON 字符串会被解析为 dict）
    normalized_params = normalize_operation_params("set_range_style", base_params)
    operation = {
        "type": "set_range_style",
        "params": normalized_params
    }
    result = _create_tool_result(operation, f"Operation: set_range_style from R{args['start_row']}C{args['start_col']} to R{args['end_row']}C{args['end_col']}")
    _log_tool_result("set_range_style", {"operation": operation})
    return result


@tool("clear_range",
    """Clear content and/or formatting from a range of cells.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：清除范围内容
    
    ✅ **操作已完成！**
    
    我已成功清除了"[工作表名]"工作表的[范围描述]：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **范围大小**：[行数]行 x [列数]列，共[总数]个单元格
    - ✅ **清除内容**：[是/否]
    - ✅ **清除格式**：[是/否]
    
    范围已清空，可以重新输入数据。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 范围坐标（从1开始）
    - clear_format: 是否清除格式（默认False，只清除内容）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "clear_format": bool})
async def clear_range(args: Dict[str, Any]) -> Dict[str, Any]:
    """Clear a range"""
    _log_tool_call("clear_range", args)
    operation = {
        "type": "clear_range",
        "params": {"sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"], "endRow": args["end_row"], "endCol": args["end_col"], "clearFormat": args.get("clear_format", False)}
    }
    result = _create_tool_result(operation, f"Operation: clear_range from R{args['start_row']}C{args['start_col']} to R{args['end_row']}C{args['end_col']}")
    _log_tool_result("clear_range", {"operation": operation})
    return result


@tool("merge_cells",
    """Merge a range of cells into one cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：合并单元格
    
    ✅ **操作已完成！**
    
    我已成功合并了"[工作表名]"工作表的单元格：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **合并范围**：[行数]行 x [列数]列，共[总数]个单元格
    
    单元格已合并为一个单元格，适合用于表头或标题。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 要合并的范围坐标（从1开始）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int})
async def merge_cells(args: Dict[str, Any]) -> Dict[str, Any]:
    """Merge cells"""
    _log_tool_call("merge_cells", args)
    err = _prevalidate_args("merge_cells", args,
        ["sheet", "start_row", "start_col", "end_row", "end_col"],
        ["start_row", "start_col", "end_row", "end_col"])
    if err:
        return _reject(err)
    operation = {
        "type": "merge_cells",
        "params": {"sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"], "endRow": args["end_row"], "endCol": args["end_col"]}
    }
    result = _create_tool_result(operation, f"Operation: merge_cells from R{args['start_row']}C{args['start_col']} to R{args['end_row']}C{args['end_col']}")
    _log_tool_result("merge_cells", {"operation": operation})
    return result


@tool("unmerge_cells",
    """Unmerge previously merged cells.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：取消合并单元格
    
    ✅ **操作已完成！**
    
    我已成功取消了"[工作表名]"工作表的单元格合并：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    
    单元格已恢复为独立单元格，可以分别编辑。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 要取消合并的范围坐标（从1开始）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int})
async def unmerge_cells(args: Dict[str, Any]) -> Dict[str, Any]:
    """Unmerge cells"""
    _log_tool_call("unmerge_cells", args)
    operation = {
        "type": "unmerge_cells",
        "params": {"sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"], "endRow": args["end_row"], "endCol": args["end_col"]}
    }
    result = _create_tool_result(operation, f"Operation: unmerge_cells from R{args['start_row']}C{args['start_col']} to R{args['end_row']}C{args['end_col']}")
    _log_tool_result("unmerge_cells", {"operation": operation})
    return result


# ============================================================
# Row/Column Operations Tools
# ============================================================

@tool("insert_rows",
    """Insert one or more rows at the specified position.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：插入行
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表插入了[数量]行：
    - ✅ **插入位置**：第[行号]行
    - ✅ **插入数量**：[数量]行
    
    新行已插入，原有数据已向下移动。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 插入位置的行号（从1开始）
    - count: 插入的行数（默认1）""",
    {"sheet": str, "row": int, "count": int})
async def insert_rows(args: Dict[str, Any]) -> Dict[str, Any]:
    """Insert rows"""
    _log_tool_call("insert_rows", args)
    operation = {"type": "insert_row", "params": {"sheet": args["sheet"], "row": args["row"], "count": args.get("count", 1)}}
    result = _create_tool_result(operation, f"Operation: insert_rows {args.get('count', 1)} rows at row {args['row']}")
    _log_tool_result("insert_rows", {"operation": operation})
    return result


@tool("delete_rows",
    """Delete one or more rows at the specified position.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除行
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的[数量]行：
    - ✅ **删除位置**：从第[行号]行开始
    - ✅ **删除数量**：[数量]行
    
    行已删除，后续数据已向上移动。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 删除起始行号（从1开始）
    - count: 删除的行数（默认1）""",
    {"sheet": str, "row": int, "count": int})
async def delete_rows(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete rows"""
    _log_tool_call("delete_rows", args)
    operation = {"type": "delete_row", "params": {"sheet": args["sheet"], "row": args["row"], "count": args.get("count", 1)}}
    result = _create_tool_result(operation, f"Operation: delete_rows {args.get('count', 1)} rows starting at row {args['row']}")
    _log_tool_result("delete_rows", {"operation": operation})
    return result


@tool("insert_columns",
    """Insert one or more columns at the specified position.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：插入列
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表插入了[数量]列：
    - ✅ **插入位置**：第[列号]列（[列字母]列）
    - ✅ **插入数量**：[数量]列
    
    新列已插入，原有数据已向右移动。
    
    **参数说明：**
    - sheet: 工作表名称
    - col: 插入位置的列号（从1开始，A=1）
    - count: 插入的列数（默认1）""",
    {"sheet": str, "col": int, "count": int})
async def insert_columns(args: Dict[str, Any]) -> Dict[str, Any]:
    """Insert columns"""
    _log_tool_call("insert_columns", args)
    operation = {"type": "insert_column", "params": {"sheet": args["sheet"], "col": args["col"], "count": args.get("count", 1)}}
    result = _create_tool_result(operation, f"Operation: insert_columns {args.get('count', 1)} columns at column {args['col']}")
    _log_tool_result("insert_columns", {"operation": operation})
    return result


@tool("delete_columns",
    """Delete one or more columns at the specified position.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除列
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的[数量]列：
    - ✅ **删除位置**：从第[列号]列（[列字母]列）开始
    - ✅ **删除数量**：[数量]列
    
    列已删除，后续数据已向左移动。
    
    **参数说明：**
    - sheet: 工作表名称
    - col: 删除起始列号（从1开始，A=1）
    - count: 删除的列数（默认1）""",
    {"sheet": str, "col": int, "count": int})
async def delete_columns(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete columns"""
    _log_tool_call("delete_columns", args)
    operation = {"type": "delete_column", "params": {"sheet": args["sheet"], "col": args["col"], "count": args.get("count", 1)}}
    result = _create_tool_result(operation, f"Operation: delete_columns {args.get('count', 1)} columns starting at column {args['col']}")
    _log_tool_result("delete_columns", {"operation": operation})
    return result


@tool("set_row_height",
    """Set the height of a specific row.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置行高
    
    ✅ **操作已完成！**
    
    我已成功设置了"[工作表名]"工作表的行高：
    - ✅ **行号**：第[行号]行
    - ✅ **行高**：[高度]像素
    
    行高已调整，内容显示更加美观。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - height: 行高（像素）""",
    {"sheet": str, "row": int, "height": float})
async def set_row_height(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set row height"""
    _log_tool_call("set_row_height", args)
    operation = {"type": "set_row_height", "params": {"sheet": args["sheet"], "row": args["row"], "height": args["height"]}}
    result = _create_tool_result(operation, f"Operation: set_row_height row {args['row']} to {args['height']}")
    _log_tool_result("set_row_height", {"operation": operation})
    return result


@tool("set_column_width",
    """Set the width of a specific column.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置列宽
    
    ✅ **操作已完成！**
    
    我已成功设置了"[工作表名]"工作表的列宽：
    - ✅ **列号**：第[列号]列（[列字母]列）
    - ✅ **列宽**：[宽度]像素
    
    列宽已调整，内容显示更加完整。
    
    **参数说明：**
    - sheet: 工作表名称
    - col: 列号（从1开始，A=1）
    - width: 列宽（像素）""",
    {"sheet": str, "col": int, "width": float})
async def set_column_width(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set column width"""
    _log_tool_call("set_column_width", args)
    operation = {"type": "set_column_width", "params": {"sheet": args["sheet"], "col": args["col"], "width": args["width"]}}
    result = _create_tool_result(operation, f"Operation: set_column_width column {args['col']} to {args['width']}")
    _log_tool_result("set_column_width", {"operation": operation})
    return result


@tool("hide_rows",
    """Hide one or more rows.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：隐藏行
    
    ✅ **操作已完成！**
    
    我已成功隐藏了"[工作表名]"工作表的行：
    - ✅ **隐藏范围**：第[起始行]行到第[结束行]行，共[数量]行
    
    行已隐藏，不会在视图中显示，但数据仍然保留。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, end_row: 要隐藏的行范围（从1开始）""",
    {"sheet": str, "start_row": int, "end_row": int})
async def hide_rows(args: Dict[str, Any]) -> Dict[str, Any]:
    """Hide rows"""
    _log_tool_call("hide_rows", args)
    operation = {"type": "hide_row", "params": {"sheet": args["sheet"], "startRow": args["start_row"], "endRow": args["end_row"]}}
    result = _create_tool_result(operation, f"Operation: hide_rows from {args['start_row']} to {args['end_row']}")
    _log_tool_result("hide_rows", {"operation": operation})
    return result


@tool("hide_columns",
    """Hide one or more columns.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：隐藏列
    
    ✅ **操作已完成！**
    
    我已成功隐藏了"[工作表名]"工作表的列：
    - ✅ **隐藏范围**：第[起始列]列（[起始列字母]列）到第[结束列]列（[结束列字母]列），共[数量]列
    
    列已隐藏，不会在视图中显示，但数据仍然保留。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_col, end_col: 要隐藏的列范围（从1开始，A=1）""",
    {"sheet": str, "start_col": int, "end_col": int})
async def hide_columns(args: Dict[str, Any]) -> Dict[str, Any]:
    """Hide columns"""
    _log_tool_call("hide_columns", args)
    operation = {"type": "hide_column", "params": {"sheet": args["sheet"], "startCol": args["start_col"], "endCol": args["end_col"]}}
    result = _create_tool_result(operation, f"Operation: hide_columns from {args['start_col']} to {args['end_col']}")
    _log_tool_result("hide_columns", {"operation": operation})
    return result


@tool("show_rows",
    """Show previously hidden rows.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：显示行
    
    ✅ **操作已完成！**
    
    我已成功显示了"[工作表名]"工作表的行：
    - ✅ **显示范围**：第[起始行]行到第[结束行]行，共[数量]行
    
    行已显示，现在可以在视图中看到这些行的内容。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, end_row: 要显示的行范围（从1开始）""",
    {"sheet": str, "start_row": int, "end_row": int})
async def show_rows(args: Dict[str, Any]) -> Dict[str, Any]:
    """Show rows"""
    _log_tool_call("show_rows", args)
    operation = {"type": "show_row", "params": {"sheet": args["sheet"], "startRow": args["start_row"], "endRow": args["end_row"]}}
    result = _create_tool_result(operation, f"Operation: show_rows from {args['start_row']} to {args['end_row']}")
    _log_tool_result("show_rows", {"operation": operation})
    return result


@tool("show_columns",
    """Show previously hidden columns.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：显示列
    
    ✅ **操作已完成！**
    
    我已成功显示了"[工作表名]"工作表的列：
    - ✅ **显示范围**：第[起始列]列（[起始列字母]列）到第[结束列]列（[结束列字母]列），共[数量]列
    
    列已显示，现在可以在视图中看到这些列的内容。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_col, end_col: 要显示的列范围（从1开始，A=1）""",
    {"sheet": str, "start_col": int, "end_col": int})
async def show_columns(args: Dict[str, Any]) -> Dict[str, Any]:
    """Show columns"""
    _log_tool_call("show_columns", args)
    operation = {"type": "show_column", "params": {"sheet": args["sheet"], "startCol": args["start_col"], "endCol": args["end_col"]}}
    result = _create_tool_result(operation, f"Operation: show_columns from {args['start_col']} to {args['end_col']}")
    _log_tool_result("show_columns", {"operation": operation})
    return result


@tool("auto_fit_column",
    """Auto-fit column width based on content.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：自动调整列宽
    
    ✅ **操作已完成！**
    
    我已成功自动调整了"[工作表名]"工作表的列宽：
    - ✅ **列号**：第[列号]列（[列字母]列）
    - ✅ **调整方式**：根据内容自动调整宽度
    
    列宽已自动调整，确保所有内容都能完整显示。
    
    **参数说明：**
    - sheet: 工作表名称
    - col: 列号（从1开始，A=1）""",
    {"sheet": str, "col": int})
async def auto_fit_column(args: Dict[str, Any]) -> Dict[str, Any]:
    """Auto fit column width"""
    _log_tool_call("auto_fit_column", args)
    operation = {"type": "auto_fit_column", "params": {"sheet": args["sheet"], "col": args["col"]}}
    result = _create_tool_result(operation, f"Operation: auto_fit_column {args['col']}")
    _log_tool_result("auto_fit_column", {"operation": operation})
    return result


# ============================================================
# Sheet Operations Tools
# ============================================================

@tool("add_sheet",
    """Add a new worksheet. The new sheet becomes the active sheet.

    For analysis tasks: create only ONE result sheet named exactly the target analysis sheet name.
    Do NOT create multiple result sheets like "Summary1", "Summary2".

    Parameters:
    - name: sheet name (string, required)
    - position: insertion index (optional, -1 = append at end)

    Common mistakes:
    - Creating multiple sheets for one analysis task -> use one shared result sheet.
    - Calling add_sheet before create_pivot_table -> unnecessary, pivot auto-creates.""",
    {"name": str, "position": int})
async def add_sheet(args: Dict[str, Any]) -> Dict[str, Any]:
    """Add a new sheet"""
    _log_tool_call("add_sheet", args)
    sheet_name = args["name"]
    
    # 创建新工作表操作
    add_operation = {"type": "add_sheet", "params": {"name": sheet_name, "position": args.get("position", -1)}}
    
    # 自动设置为活动工作表
    set_active_operation = {"type": "set_active_sheet", "params": {"name": sheet_name}}
    
    operations = [add_operation, set_active_operation]
    result = _create_tool_result_with_operations(operations, f"Operation: add_sheet '{sheet_name}' and set as active")
    _log_tool_result("add_sheet", {"operation": add_operation})
    return result


@tool("rename_sheet",
    """Rename an existing worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：重命名工作表
    
    ✅ **操作已完成！**
    
    我已成功重命名了工作表：
    - ✅ **原名称**：[旧名称]
    - ✅ **新名称**：[新名称]
    
    工作表名称已更新。
    
    **参数说明：**
    - old_name: 原工作表名称
    - new_name: 新工作表名称""",
    {"old_name": str, "new_name": str})
async def rename_sheet(args: Dict[str, Any]) -> Dict[str, Any]:
    """Rename a sheet"""
    _log_tool_call("rename_sheet", args)
    operation = {"type": "rename_sheet", "params": {"oldName": args["old_name"], "newName": args["new_name"]}}
    result = _create_tool_result(operation, f"Operation: rename_sheet '{args['old_name']}' to '{args['new_name']}'")
    _log_tool_result("rename_sheet", {"operation": operation})
    return result


@tool("copy_sheet",
    """Copy an existing worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：复制工作表
    
    ✅ **操作已完成！**
    
    我已成功复制了工作表：
    - ✅ **源工作表**：[源名称]
    - ✅ **新工作表**：[新名称]
    - ✅ **状态**：新工作表已自动设置为活动工作表
    
    工作表已复制，包含所有数据和格式。
    
    **参数说明：**
    - source_name: 源工作表名称
    - new_name: 新工作表名称""",
    {"source_name": str, "new_name": str})
async def copy_sheet(args: Dict[str, Any]) -> Dict[str, Any]:
    """Copy a sheet"""
    _log_tool_call("copy_sheet", args)
    new_name = args["new_name"]
    
    # 复制工作表操作
    copy_operation = {"type": "copy_sheet", "params": {"sourceName": args["source_name"], "newName": new_name}}
    
    # 自动设置为活动工作表
    set_active_operation = {"type": "set_active_sheet", "params": {"name": new_name}}
    
    operations = [copy_operation, set_active_operation]
    result = _create_tool_result_with_operations(operations, f"Operation: copy_sheet '{args['source_name']}' to '{new_name}' and set as active")
    _log_tool_result("copy_sheet", {"operation": copy_operation})
    return result


@tool("set_active_sheet",
    """Switch to a different worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：切换工作表
    
    ✅ **操作已完成！**
    
    我已成功切换到"[工作表名]"工作表：
    - ✅ **当前活动工作表**：[工作表名]
    
    您现在可以查看和编辑该工作表的内容。
    
    **参数说明：**
    - name: 要切换的工作表名称""",
    {"name": str})
async def set_active_sheet(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set active sheet"""
    _log_tool_call("set_active_sheet", args)
    operation = {"type": "set_active_sheet", "params": {"name": args["name"]}}
    result = _create_tool_result(operation, f"Operation: set_active_sheet '{args['name']}'")
    _log_tool_result("set_active_sheet", {"operation": operation})
    return result


# ============================================================
# Data Operations Tools
# ============================================================

@tool("sort_range",
    """Sort data in a range by one or more columns. This is an in-place operation on source data.

    Parameters:
    - sheet: worksheet name
    - start_row, start_col, end_row, end_col: data range (1-based)
    - sort_columns: list of {"column": int, "order": "asc"|"desc"} (column is 1-based)
    - has_header: true if first row is header (default true; header row is excluded from sort)

    Correct call example:
      sort_range(sheet="Sales", start_row=1, start_col=1, end_row=200, end_col=8,
        sort_columns=[{"column": 7, "order": "desc"}], has_header=true)

    Common mistakes:
    - Sorting only the target column instead of the full row range -> data misalignment.
    - Setting has_header=false when header exists -> header gets sorted into data.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "sort_columns": list, "has_header": bool})
async def sort_range(args: Dict[str, Any]) -> Dict[str, Any]:
    """Sort a range of data"""
    _log_tool_call("sort_range", args)
    err = _prevalidate_args("sort_range", args,
        ["sheet", "start_row", "start_col", "end_row", "end_col", "sort_columns"],
        ["start_row", "start_col", "end_row", "end_col"])
    if err:
        return _reject(err)
    # 规范化 sort_columns 参数（可能是 JSON 字符串）
    normalized_sort_columns = _parse_list_param(args.get("sort_columns", []))
    operation = {
        "type": "sort_range",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"], "sortColumns": normalized_sort_columns,
            "hasHeader": args.get("has_header", True)
        }
    }
    result = _create_tool_result(operation, f"Operation: sort_range by columns {args['sort_columns']}")
    _log_tool_result("sort_range", {"operation": operation})
    return result


@tool("filter_data",
    """Filter (show/hide rows) based on conditions. Hides rows that do not match.

    Parameters:
    - sheet: worksheet name
    - start_row, start_col, end_row, end_col: data range (1-based, include header)
    - conditions: dict where key is column number (int) and value is filter criteria object
      Criteria: {"operator": ">"|"<"|">="|"<="|"="|"!="|"contains", "value": ...}

    Correct call example:
      filter_data(sheet="Sales", start_row=1, start_col=1, end_row=200, end_col=8,
        conditions={"7": {"operator": ">", "value": 5000}})

    Common mistakes:
    - Using column name as key instead of column number.
    - Omitting the range -> filter applies to nothing.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "conditions": dict})
async def filter_data(args: Dict[str, Any]) -> Dict[str, Any]:
    """Filter data"""
    _log_tool_call("filter_data", args)
    # 规范化 conditions 参数（可能是 JSON 字符串）
    normalized_conditions = _parse_dict_param(args.get("conditions", {}))
    operation = {
        "type": "filter_data",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"], "conditions": normalized_conditions
        }
    }
    result = _create_tool_result(operation, f"Operation: filter_data with conditions {args['conditions']}")
    _log_tool_result("filter_data", {"operation": operation})
    return result


@tool("remove_filter",
    """Remove all filters from the sheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：清除筛选
    
    ✅ **操作已完成！**
    
    我已成功清除了"[工作表名]"工作表的所有筛选：
    - ✅ **工作表**：[工作表名]
    
    所有筛选已清除，所有数据行现在都可见。
    
    **参数说明：**
    - sheet: 工作表名称""",
    {"sheet": str})
async def remove_filter(args: Dict[str, Any]) -> Dict[str, Any]:
    """Remove filter"""
    _log_tool_call("remove_filter", args)
    operation = {"type": "remove_filter", "params": {"sheet": args["sheet"]}}
    result = _create_tool_result(operation, f"Operation: remove_filter from {args['sheet']}")
    _log_tool_result("remove_filter", {"operation": operation})
    return result


@tool("find_replace",
    """Find and replace values in a range or entire sheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：查找替换
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表中执行了查找替换：
    - ✅ **查找内容**：[查找内容]
    - ✅ **替换为**：[替换内容]
    - ✅ **匹配方式**：[是否区分大小写] / [是否完全匹配单元格]
    
    所有匹配的内容已替换。
    
    **参数说明：**
    - sheet: 工作表名称
    - find: 要查找的内容
    - replace: 替换为的内容
    - match_case: 是否区分大小写（默认False）
    - match_entire_cell: 是否完全匹配单元格（默认False）""",
    {"sheet": str, "find": str, "replace": str, "match_case": bool, "match_entire_cell": bool})
async def find_replace(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find and replace"""
    _log_tool_call("find_replace", args)
    operation = {
        "type": "find_replace",
        "params": {
            "sheet": args["sheet"], "find": args["find"], "replace": args["replace"],
            "matchCase": args.get("match_case", False), "matchEntireCell": args.get("match_entire_cell", False)
        }
    }
    result = _create_tool_result(operation, f"Operation: find_replace '{args['find']}' with '{args['replace']}'")
    _log_tool_result("find_replace", {"operation": operation})
    return result


@tool("copy_paste",
    """Copy a range and paste to another location.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：复制粘贴
    
    ✅ **操作已完成！**
    
    我已成功复制并粘贴了数据：
    - ✅ **源位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **目标位置**：[目标工作表名]!R[目标行]C[目标列]
    - ✅ **粘贴方式**：[仅值/包含格式]
    
    数据已复制到目标位置。
    
    **参数说明：**
    - sheet: 源工作表名称
    - source_start_row, source_start_col, source_end_row, source_end_col: 源范围坐标
    - target_row, target_col: 目标位置坐标
    - target_sheet: 目标工作表名称（可选，默认同源工作表）
    - paste_values_only: 是否仅粘贴值（默认False，包含格式）""",
    {"sheet": str, "source_start_row": int, "source_start_col": int, "source_end_row": int, "source_end_col": int, "target_row": int, "target_col": int, "target_sheet": str, "paste_values_only": bool})
async def copy_paste(args: Dict[str, Any]) -> Dict[str, Any]:
    """Copy and paste"""
    _log_tool_call("copy_paste", args)
    operation = {
        "type": "copy_paste",
        "params": {
            "sheet": args["sheet"], "sourceStartRow": args["source_start_row"], "sourceStartCol": args["source_start_col"],
            "sourceEndRow": args["source_end_row"], "sourceEndCol": args["source_end_col"],
            "targetRow": args["target_row"], "targetCol": args["target_col"],
            "targetSheet": args.get("target_sheet", args["sheet"]), "pasteValuesOnly": args.get("paste_values_only", False)
        }
    }
    result = _create_tool_result(operation, f"Operation: copy_paste from R{args['source_start_row']}C{args['source_start_col']} to R{args['target_row']}C{args['target_col']}")
    _log_tool_result("copy_paste", {"operation": operation})
    return result


@tool("fill_series",
    """Fill a series of values (numbers, dates, or patterns) in a range.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：填充序列
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表的[范围描述]填充了序列：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **序列类型**：[序列类型，如"等差数列"、"日期序列"等]
    - ✅ **填充方向**：[方向，如"向下"、"向右"等]
    - ✅ **步长**：[步长值]
    
    序列已填充，数据已自动生成。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 填充范围坐标
    - direction: 填充方向（'down'/'right'，默认'down'）
    - series_type: 序列类型（'linear'/'date'等，默认'linear'）
    - step: 步长（默认1）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "direction": str, "series_type": str, "step": float})
async def fill_series(args: Dict[str, Any]) -> Dict[str, Any]:
    """Fill series"""
    _log_tool_call("fill_series", args)
    operation = {
        "type": "fill_series",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"],
            "direction": args.get("direction", "down"), "seriesType": args.get("series_type", "linear"), "step": args.get("step", 1)
        }
    }
    result = _create_tool_result(operation, f"Operation: fill_series {args.get('series_type', 'linear')} {args.get('direction', 'down')}")
    _log_tool_result("fill_series", {"operation": operation})
    return result


@tool("remove_duplicates",
    """Remove duplicate rows in-place. WARNING: destructive operation, deletes rows permanently.

    For read-only queries like "how many unique values", use query_unique_values instead.

    Parameters:
    - sheet: worksheet name
    - start_row, start_col, end_row, end_col: data range (1-based)
    - columns: list of column numbers to check for duplicates (1-based)
    - has_header: true if first row is header (default true; header is preserved)

    Common mistakes:
    - Using this for counting unique values -> use query_unique_values (read-only).
    - Omitting columns -> defaults may remove rows you want to keep.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "columns": list, "has_header": bool})
async def remove_duplicates(args: Dict[str, Any]) -> Dict[str, Any]:
    """Remove duplicates"""
    _log_tool_call("remove_duplicates", args)
    # 规范化 columns 参数（可能是 JSON 字符串）
    normalized_columns = _parse_list_param(args.get("columns", []))
    operation = {
        "type": "remove_duplicates",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"],
            "columns": normalized_columns, "hasHeader": args.get("has_header", True)
        }
    }
    result = _create_tool_result(operation, f"Operation: remove_duplicates based on columns {args['columns']}")
    _log_tool_result("remove_duplicates", {"operation": operation})
    return result


# ============================================================
# Data Query Tools (Read-Only)
# 这些工具通过 QueryBridge 向前端请求全表数据，返回精确结果给模型。
# 纯只读，不修改工作表。
# ============================================================

import json as _json
from .query_bridge import get_current_bridge


async def _bridge_query(tool_name: str, operation: Dict[str, Any]) -> Dict[str, Any]:
    """通过 QueryBridge 请求前端执行只读查询并返回精确结果"""
    bridge = get_current_bridge()
    if not bridge:
        _log_tool_call(tool_name, operation.get("params", {}))
        return {"content": [{"type": "text", "text": f"[{tool_name}] 查询桥不可用，无法获取全表数据"}]}

    _log_tool_call(tool_name, operation.get("params", {}))
    result = await bridge.query_frontend(operation)

    if "error" in result:
        text = f"[{tool_name}] 查询失败: {result['error']}"
    else:
        text = _json.dumps(result, ensure_ascii=False)
    return {"content": [{"type": "text", "text": text}]}


@tool("query_unique_values",
    """Query unique values from a column. This is a READ-ONLY operation.
    Returns the actual unique values and their counts from the FULL data range (not just the sample).
    Use when user asks 'how many types/categories' or 'what are the unique values'.
    DO NOT use remove_duplicates for queries - that DELETES data!

    The tool scans the full data range on the frontend and returns precise results.

    **参数说明：**
    - sheet: 工作表名称
    - column: 列号（从1开始）
    - start_row, end_row: 数据范围（必须使用上下文中的 dataStartRow / dataEndRow）""",
    {"sheet": str, "column": int, "start_row": int, "end_row": int})
async def query_unique_values(args: Dict[str, Any]) -> Dict[str, Any]:
    """Query unique values from a column (read-only, full-range via frontend)"""
    result = await _bridge_query("query_unique_values", {
        "type": "query_unique_values",
        "params": {
            "sheet": args["sheet"],
            "column": args["column"],
            "startRow": args["start_row"],
            "endRow": args["end_row"],
        },
    })
    # 防止超高基数列（如订单ID）把数千唯一值塞回模型上下文，触发 token 爆炸。
    # 仅保留高频 Top-K 明细，完整 uniqueCount 仍保留用于精确判断是否有重复。
    items = result.get("items")
    if isinstance(items, list):
        max_items = 200
        trimmed_items = []
        for item in items[:max_items]:
            if not isinstance(item, dict):
                continue
            v = str(item.get("value", ""))
            if len(v) > 120:
                v = f"{v[:117]}..."
            trimmed_items.append({
                "value": v,
                "count": item.get("count", 0),
            })
        result["items"] = trimmed_items
        result["itemsReturned"] = len(trimmed_items)
        result["itemsTruncated"] = len(items) > max_items
        if len(items) > max_items:
            result["itemsOmitted"] = len(items) - max_items
    return result


@tool("read_range_values",
    """Read cell values from an arbitrary rectangular range. READ-ONLY, does not modify data.
    Returns a 2D array of the actual cell values from the full workbook (not limited to the sample).
    Use when you need to inspect specific rows/cells beyond the sample data.

    **限制**: 单次最多返回 500 行。超出请分批调用或改用 aggregate_column。

    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 矩形范围坐标（从1开始）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int})
async def read_range_values(args: Dict[str, Any]) -> Dict[str, Any]:
    """Read cell values from a range (read-only, full-range via frontend)"""
    return await _bridge_query("read_range_values", {
        "type": "read_range_values",
        "params": {
            "sheet": args["sheet"],
            "startRow": args["start_row"],
            "startCol": args["start_col"],
            "endRow": args["end_row"],
            "endCol": args["end_col"],
        },
    })


@tool("aggregate_column",
    """Compute an aggregate statistic on a single column. READ-ONLY, does not modify data.
    Scans the full data range on the frontend and returns an exact numeric result.

    Supported operations: sum, avg, count, min, max, median, countDistinct, countIf.
    For countIf, provide a 'condition' string like '>100', '==A', '!=0'.

    **参数说明：**
    - sheet: 工作表名称
    - column: 列号（从1开始）
    - start_row, end_row: 数据范围
    - operation: sum | avg | count | min | max | median | countDistinct | countIf
    - condition: （仅 countIf 需要）条件表达式，如 '>100'""",
    {"sheet": str, "column": int, "start_row": int, "end_row": int,
     "operation": str, "condition": str})
async def aggregate_column(args: Dict[str, Any]) -> Dict[str, Any]:
    """Aggregate a column (read-only, full-range via frontend)"""
    return await _bridge_query("aggregate_column", {
        "type": "aggregate_column",
        "params": {
            "sheet": args["sheet"],
            "column": args["column"],
            "startRow": args["start_row"],
            "endRow": args["end_row"],
            "operation": args["operation"],
            "condition": args.get("condition", ""),
        },
    })


@tool("query_column_profile",
    """Get a statistical profile of a column. READ-ONLY, does not modify data.
    Returns: uniqueCount, topValues (value+count pairs), min, max, sum, avg, nullCount.
    One call gives a comprehensive overview of the column. Prefer this over multiple aggregate_column calls.

    **参数说明：**
    - sheet: 工作表名称
    - column: 列号（从1开始）
    - start_row, end_row: 数据范围""",
    {"sheet": str, "column": int, "start_row": int, "end_row": int})
async def query_column_profile(args: Dict[str, Any]) -> Dict[str, Any]:
    """Profile a column (read-only, full-range via frontend)"""
    return await _bridge_query("query_column_profile", {
        "type": "query_column_profile",
        "params": {
            "sheet": args["sheet"],
            "column": args["column"],
            "startRow": args["start_row"],
            "endRow": args["end_row"],
        },
    })


# ============================================================
# Formatting Operations Tools
# ============================================================

_SUPPORTED_RULE_TYPES = frozenset({
    "greaterThan", "lessThan", "between",
    "equal", "text", "textEquals",
    "containsText", "notContainsText", "beginsWith", "endsWith",
    "duplicate", "duplicateValues", "uniqueValues",
    "top10", "bottom10",
    "greaterThanAverage", "aboveAverage", "belowAverage",
    "colorScale",
})

_CF_REJECT_HINT = (
    "ERROR: rule_type '{rt}' is NOT supported. "
    "Supported values: {allowed}. "
    "For compound/multi-column conditions (AND/OR across columns), "
    "do NOT use conditional_format. Instead: "
    "1) read_range_values to get relevant columns, "
    "2) identify matching rows yourself, "
    "3) batch_operations with set_range_style for each matching row."
)

@tool("conditional_format",
    """Apply conditional formatting to a range.

    Supported rule_type (exhaustive list):
      greaterThan  - rule_params: {"value": N}
      lessThan     - rule_params: {"value": N}
      between      - rule_params: {"min": N, "max": N}
      equal        - rule_params: {"value": "text_or_number"}
      text / containsText / notContainsText / beginsWith / endsWith
                   - rule_params: {"value": "search_text"}
      duplicate    - rule_params: {}
      uniqueValues - rule_params: {}
      top10        - rule_params: {"rank": N}
      bottom10     - rule_params: {"rank": N}
      aboveAverage - rule_params: {}
      belowAverage - rule_params: {}
      colorScale   - rule_params: {"minColor": "#hex", "maxColor": "#hex"} (2-color)
                     or add "midColor" for 3-color. colorScale ignores format_style.

    NOT supported: dataBar, custom, formula, iconSet.

    Parameter constraints:
    - rule_type must be one of the above; unknown types are rejected.
    - format_style: {"backgroundColor": "#hex", "fontColor": "#hex", "bold": true} etc.
      colorScale does not use format_style.
    - rule_params accepts dict or JSON string.

    Correct call example:
      conditional_format(sheet="Sheet1", start_row=2, start_col=3, end_row=100, end_col=3,
        rule_type="greaterThan", rule_params={"value": 1000},
        format_style={"backgroundColor": "#C6EFCE", "fontColor": "#006100"})

    Common mistakes:
    - Using unsupported rule_type like "formula" or "dataBar" -> rejected.
    - Passing format_style with colorScale -> ignored; put colors in rule_params.
    - Omitting rule_params for types that require a value.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "rule_type": str, "rule_params": dict, "format_style": dict})
async def conditional_format(args: Dict[str, Any]) -> Dict[str, Any]:
    """Apply conditional formatting"""
    _log_tool_call("conditional_format", args)
    err = _prevalidate_args("conditional_format", args,
        ["sheet", "start_row", "start_col", "end_row", "end_col", "rule_type"],
        ["start_row", "start_col", "end_row", "end_col"])
    if err:
        return _reject(err)
    rt = str(args.get("rule_type", "")).strip()
    if rt not in _SUPPORTED_RULE_TYPES:
        msg = _CF_REJECT_HINT.format(rt=rt, allowed=", ".join(sorted(_SUPPORTED_RULE_TYPES)))
        _log_tool_result("conditional_format", {"rejected": rt})
        return {"type": "text", "text": msg}
    normalized_rule_params = _parse_dict_param(args.get("rule_params", {}))
    normalized_format_style = _parse_dict_param(args.get("format_style", {}))
    operation = {
        "type": "conditional_format",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"],
            "ruleType": rt, "ruleParams": normalized_rule_params, "formatStyle": normalized_format_style
        }
    }
    result = _create_tool_result(operation, f"Operation: conditional_format {rt}")
    _log_tool_result("conditional_format", {"operation": operation})
    return result


@tool("clear_formatting",
    """Clear all formatting from a range while keeping values.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：清除格式
    
    ✅ **操作已完成！**
    
    我已成功清除了"[工作表名]"工作表的[范围描述]的所有格式：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **范围大小**：[行数]行 x [列数]列
    
    格式已清除，但数据内容保持不变。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 清除范围坐标（从1开始）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int})
async def clear_formatting(args: Dict[str, Any]) -> Dict[str, Any]:
    """Clear formatting"""
    _log_tool_call("clear_formatting", args)
    operation = {
        "type": "clear_formatting",
        "params": {"sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"], "endRow": args["end_row"], "endCol": args["end_col"]}
    }
    result = _create_tool_result(operation, f"Operation: clear_formatting from R{args['start_row']}C{args['start_col']} to R{args['end_row']}C{args['end_col']}")
    _log_tool_result("clear_formatting", {"operation": operation})
    return result


# ============================================================
# Data Analysis Tools
# ============================================================

@tool("create_pivot_data",
    """Create pivot/aggregated data from a range and write to a target location.

    Use when: user asks for pivot table, cross-tab, or grouped aggregation with a single value field.

    Parameters:
    - sheet: source worksheet name
    - start_row, start_col, end_row, end_col: source data range (1-based, include header row)
    - row_fields: list of column numbers for row grouping (required, at least 1)
    - col_fields: list of column numbers for column grouping (optional, default [])
    - value_field: single column number (int) for aggregation (required)
    - aggregate_function: 'sum' | 'avg' | 'count' | 'max' | 'min' (default 'sum')
    - target_sheet: destination sheet name (optional; auto-created if not exists)
    - target_row, target_col: write position (optional, default 1,1)

    Parameter constraints:
    - value_field is a single int, NOT a list.
    - row_fields must contain actual data column numbers from the source range.
    - Do NOT use ID/code columns as value_field; use business numeric columns.

    Correct call example:
      create_pivot_data(sheet="Sales", start_row=1, start_col=1, end_row=200, end_col=8,
        row_fields=[2], value_field=5, aggregate_function="sum",
        target_sheet="Pivot Result", target_row=1, target_col=1)

    Common mistakes:
    - Passing value_field as a list [5] instead of int 5 -> type error.
    - Using a text/ID column as value_field -> meaningless sum.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "row_fields": list, "col_fields": list, "value_field": int, "aggregate_function": str, "target_sheet": str, "target_row": int, "target_col": int})
async def create_pivot_data(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create pivot table data"""
    _log_tool_call("create_pivot_data", args)
    err = _prevalidate_args("create_pivot_data", args,
        ["sheet", "start_row", "start_col", "end_row", "end_col", "row_fields", "value_field"],
        ["start_row", "start_col", "end_row", "end_col"])
    if err:
        return _reject(err)
    source_sheet = args["sheet"]
    target_sheet = args.get("target_sheet", source_sheet)
    
    # 规范化 row_fields 和 col_fields 参数（可能是 JSON 字符串）
    normalized_row_fields = _parse_list_param(args.get("row_fields", []))
    normalized_col_fields = _parse_list_param(args.get("col_fields", []))
    
    # 创建透视数据操作
    pivot_operation = {
        "type": "create_pivot_data",
        "params": {
            "sheet": source_sheet, "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"],
            "rowFields": normalized_row_fields, "colFields": normalized_col_fields,
            "valueField": args["value_field"], "aggregateFunction": args.get("aggregate_function", "sum"),
            "targetSheet": target_sheet,
            "targetRow": args.get("target_row", 1), "targetCol": args.get("target_col", 1)
        }
    }
    
    operations = [pivot_operation]
    
    # 如果目标工作表不同于源工作表，自动设置为活动工作表
    if target_sheet != source_sheet:
        set_active_operation = {"type": "set_active_sheet", "params": {"name": target_sheet}}
        operations.append(set_active_operation)
    
    result = _create_tool_result_with_operations(operations, f"Operation: create_pivot_data with row fields {args['row_fields']}, value field {args['value_field']}")
    _log_tool_result("create_pivot_data", {"operation": pivot_operation})
    return result


@tool("calculate_statistics",
    """Calculate descriptive statistics (sum, avg, count, min, max, median, std) for a numeric column range.

    Parameters:
    - sheet: worksheet name
    - start_row, start_col, end_row, end_col: data range (1-based, single column recommended)
    - output_row: row to write results (must be > end_row to avoid overwriting data; auto-corrected if inside data range)
    - output_col: column to write results (optional)

    Parameter constraints:
    - output_row MUST be after end_row (data protection rule). If omitted or inside data range, it is auto-corrected to end_row + 2.
    - For multi-column statistics, call once per column or use aggregate_column for read-only queries.

    Common mistakes:
    - Setting output_row=1 -> overwrites source data (auto-corrected but wasteful).
    - Applying to text columns -> results are meaningless.""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "output_row": int, "output_col": int})
async def calculate_statistics(args: Dict[str, Any]) -> Dict[str, Any]:
    """Calculate statistics"""
    _log_tool_call("calculate_statistics", args)
    # 数据保护：outputRow 禁止落入源数据区域，强制修正到 endRow+2
    end_row = int(args.get("end_row", 1))
    output_row = args.get("output_row")
    if output_row is not None:
        output_row = int(output_row)
        if output_row <= end_row:
            output_row = end_row + 2
    else:
        output_row = end_row + 2
    operation = {
        "type": "calculate_statistics",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"],
            "outputRow": output_row, "outputCol": args.get("output_col")
        }
    }
    result = _create_tool_result(operation, "Operation: calculate_statistics for range")
    _log_tool_result("calculate_statistics", {"operation": operation})
    return result


@tool("summarize_by_column",
    """Group by a column and sum another column, appending summary rows.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：按列分组汇总
    
    ✅ **操作已完成！**
    
    我已成功创建了分组汇总：
    - ✅ **分组字段**：[分组字段名]（第[列号]列）
    - ✅ **汇总字段**：[汇总字段名]（第[列号]列）
    - ✅ **汇总位置**：第[目标行]行
    - ✅ **包含总计**：[是/否]
    
    汇总数据已添加到工作表中，显示了各分组的汇总结果。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, end_row: 数据行范围
    - start_col, end_col: 数据列范围
    - group_by_col: 分组列号
    - sum_col: 汇总列号
    - target_row: 汇总结果插入位置（可选）
    - include_total: 是否包含总计行（默认True）""",
    {"sheet": str, "start_row": int, "end_row": int, "start_col": int, "end_col": int, "group_by_col": int, "sum_col": int, "target_row": int, "include_total": bool})
async def summarize_by_column(args: Dict[str, Any]) -> Dict[str, Any]:
    """Summarize by column"""
    _log_tool_call("summarize_by_column", args)
    operation = {
        "type": "summarize_by_column",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "endRow": args["end_row"],
            "startCol": args["start_col"], "endCol": args["end_col"],
            "groupByCol": args["group_by_col"], "sumCol": args["sum_col"],
            "targetRow": args.get("target_row"), "includeTotal": args.get("include_total", True)
        }
    }
    result = _create_tool_result(operation, "Operation: summarize_by_column")
    _log_tool_result("summarize_by_column", {"operation": operation})
    return result


@tool("summarize_metrics_by_column",
    """Group by one column, compute sum/count/avg for a numeric column. Output: grouped table with 4 columns (group, sum, count, avg).

    Use when: user asks for "grouped summary", "by-category totals", or analysis that needs aggregation before charting.

    Parameters:
    - sheet: source worksheet name
    - start_row: first data row (usually headerRow from excel_state)
    - end_row: last data row
    - group_by_col: column number to group by (int, 1-based)
    - sum_col: column number to aggregate (int, 1-based, must be numeric business column)
    - target_sheet: destination sheet (optional; for analysis use a separate sheet like the target analysis sheet)
    - target_row: row to start writing (if previous set_cell_value wrote title at row R, use R+1 here; no gap allowed)
    - target_col: column to start writing (default 1)
    - include_total: whether to append a total row (default false)

    Parameter constraints:
    - sum_col must point to a numeric business column, NOT ID/code columns.
    - target_row must be > any existing data in target area to avoid overwriting.
    - start_row should be headerRow (includes header for label extraction).

    Correct call example:
      summarize_metrics_by_column(sheet="Sales", start_row=1, end_row=200,
        group_by_col=3, sum_col=7, target_sheet="Analysis", target_row=2, target_col=1)

    Common mistakes:
    - Setting target_row to a row that already has data -> overwrites user data.
    - Using an ID column as sum_col -> meaningless aggregation.
    - Leaving a blank row between title and table header -> misaligned output.""",
    {"sheet": str, "start_row": int, "end_row": int, "group_by_col": int, "sum_col": int, "target_sheet": str, "target_row": int, "target_col": int, "include_total": bool})
async def summarize_metrics_by_column(args: Dict[str, Any]) -> Dict[str, Any]:
    """Summarize metrics by column"""
    _log_tool_call("summarize_metrics_by_column", args)
    err = _prevalidate_args(
        "summarize_metrics_by_column",
        args,
        ["sheet", "start_row", "end_row", "group_by_col", "sum_col"],
        ["start_row", "end_row", "group_by_col", "sum_col"],
    )
    if err:
        return _reject(err)
    source_sheet = args["sheet"]
    target_sheet = args.get("target_sheet", source_sheet)
    
    # 创建汇总操作
    summarize_operation = {
        "type": "summarize_metrics_by_column",
        "params": {
            "sheet": source_sheet, "startRow": args["start_row"], "endRow": args["end_row"],
            "groupByCol": args["group_by_col"], "sumCol": args["sum_col"],
            "targetSheet": target_sheet,
            "targetRow": args.get("target_row"), "targetCol": args.get("target_col", 1),
            "includeTotal": args.get("include_total", True)
        }
    }
    
    operations = [summarize_operation]
    
    # 如果目标工作表不同于源工作表，自动设置为活动工作表
    if target_sheet != source_sheet:
        set_active_operation = {"type": "set_active_sheet", "params": {"name": target_sheet}}
        operations.append(set_active_operation)
    
    result = _create_tool_result_with_operations(operations, "Operation: summarize_metrics_by_column")
    _log_tool_result("summarize_metrics_by_column", {"operation": summarize_operation})
    return result


# ============================================================
# Data Validation Tools
# ============================================================

@tool("set_data_validation",
    """Set data validation rules for a range. Types: 'list', 'number', 'date', 'textLength', 'custom'.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置数据验证
    
    ✅ **操作已完成！**
    
    我已成功为"[工作表名]"工作表的[范围描述]设置了数据验证：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    - ✅ **验证类型**：[验证类型，如"列表"、"数字范围"、"日期"等]
    - ✅ **验证规则**：[规则描述，如"允许值：A, B, C"、"范围：1-100"等]
    
    数据验证已设置，用户只能输入符合规则的数据。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 验证范围坐标
    - validation_type: 验证类型（'list', 'number', 'date', 'textLength', 'custom'）
    - validation_params: 验证参数字典""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int, "validation_type": str, "validation_params": dict})
async def set_data_validation(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set data validation"""
    _log_tool_call("set_data_validation", args)
    # 规范化 validation_params 参数（可能是 JSON 字符串）
    normalized_validation_params = _parse_dict_param(args.get("validation_params", {}))
    operation = {
        "type": "set_data_validation",
        "params": {
            "sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"],
            "endRow": args["end_row"], "endCol": args["end_col"],
            "validationType": args["validation_type"], "validationParams": normalized_validation_params
        }
    }
    result = _create_tool_result(operation, f"Operation: set_data_validation {args['validation_type']}")
    _log_tool_result("set_data_validation", {"operation": operation})
    return result


@tool("remove_data_validation",
    """Remove data validation from a range.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：移除数据验证
    
    ✅ **操作已完成！**
    
    我已成功移除了"[工作表名]"工作表的[范围描述]的数据验证：
    - ✅ **位置**：[工作表名]!R[起始行]C[起始列]:R[结束行]C[结束列]
    
    数据验证已移除，现在可以输入任意数据。
    
    **参数说明：**
    - sheet: 工作表名称
    - start_row, start_col, end_row, end_col: 要移除验证的范围坐标（从1开始）""",
    {"sheet": str, "start_row": int, "start_col": int, "end_row": int, "end_col": int})
async def remove_data_validation(args: Dict[str, Any]) -> Dict[str, Any]:
    """Remove data validation"""
    _log_tool_call("remove_data_validation", args)
    operation = {
        "type": "remove_data_validation",
        "params": {"sheet": args["sheet"], "startRow": args["start_row"], "startCol": args["start_col"], "endRow": args["end_row"], "endCol": args["end_col"]}
    }
    result = _create_tool_result(operation, "Operation: remove_data_validation")
    _log_tool_result("remove_data_validation", {"operation": operation})
    return result


# ============================================================
# Comment Operations Tools
# ============================================================

@tool("add_comment",
    """Add a comment to a specific cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：添加注释
    
    ✅ **操作已完成！**
    
    我已成功为"[工作表名]"工作表的第[行号]行第[列号]列添加了注释：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **注释内容**：[注释内容]
    - ✅ **作者**：[作者名]
    
    注释已添加，鼠标悬停在该单元格上即可查看。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - comment: 注释内容
    - author: 作者名称（可选，默认"User"）""",
    {"sheet": str, "row": int, "col": int, "comment": str, "author": str})
async def add_comment(args: Dict[str, Any]) -> Dict[str, Any]:
    """Add comment to a cell"""
    _log_tool_call("add_comment", args)
    operation = {"type": "add_comment", "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "comment": args["comment"], "author": args.get("author", "User")}}
    result = _create_tool_result(operation, f"Operation: add_comment at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("add_comment", {"operation": operation})
    return result


@tool("delete_comment",
    """Delete a comment from a specific cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除注释
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的第[行号]行第[列号]列的注释：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    
    注释已删除。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）""",
    {"sheet": str, "row": int, "col": int})
async def delete_comment(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete comment from a cell"""
    _log_tool_call("delete_comment", args)
    operation = {"type": "delete_comment", "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"]}}
    result = _create_tool_result(operation, f"Operation: delete_comment at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("delete_comment", {"operation": operation})
    return result


@tool("update_comment",
    """Update an existing comment on a specific cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：更新注释
    
    ✅ **操作已完成！**
    
    我已成功更新了"[工作表名]"工作表的第[行号]行第[列号]列的注释：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **新注释内容**：[注释内容]
    
    注释已更新。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - comment: 新的注释内容""",
    {"sheet": str, "row": int, "col": int, "comment": str})
async def update_comment(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update comment on a cell"""
    _log_tool_call("update_comment", args)
    operation = {"type": "update_comment", "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "comment": args["comment"]}}
    result = _create_tool_result(operation, f"Operation: update_comment at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("update_comment", {"operation": operation})
    return result


# ============================================================
# Hyperlink Operations Tools
# ============================================================

@tool("set_hyperlink",
    """Set a hyperlink to a specific cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：设置超链接
    
    ✅ **操作已完成！**
    
    我已成功为"[工作表名]"工作表的第[行号]行第[列号]列设置了超链接：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **链接地址**：[URL]
    - ✅ **显示文本**：[显示文本]
    
    超链接已设置，点击该单元格即可打开链接。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - url: 链接地址
    - text: 显示文本（可选，默认使用URL）""",
    {"sheet": str, "row": int, "col": int, "url": str, "text": str})
async def set_hyperlink(args: Dict[str, Any]) -> Dict[str, Any]:
    """Set hyperlink to a cell"""
    _log_tool_call("set_hyperlink", args)
    operation = {"type": "set_hyperlink", "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "url": args["url"], "text": args.get("text", args["url"])}}
    result = _create_tool_result(operation, f"Operation: set_hyperlink at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("set_hyperlink", {"operation": operation})
    return result


@tool("remove_hyperlink",
    """Remove a hyperlink from a specific cell.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：移除超链接
    
    ✅ **操作已完成！**
    
    我已成功移除了"[工作表名]"工作表的第[行号]行第[列号]列的超链接：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    
    超链接已移除，单元格内容保持不变。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）""",
    {"sheet": str, "row": int, "col": int})
async def remove_hyperlink(args: Dict[str, Any]) -> Dict[str, Any]:
    """Remove hyperlink from a cell"""
    _log_tool_call("remove_hyperlink", args)
    operation = {"type": "remove_hyperlink", "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"]}}
    result = _create_tool_result(operation, f"Operation: remove_hyperlink at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("remove_hyperlink", {"operation": operation})
    return result


# ============================================================
# Image Operations Tools
# ============================================================

@tool("insert_image",
    """Insert an image into the worksheet at a specific position.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：插入图片
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表插入了图片：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **图片地址**：[图片URL]
    - ✅ **尺寸**：[宽度] x [高度]像素
    
    图片已插入到工作表中。
    
    **参数说明：**
    - sheet: 工作表名称
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - image_url: 图片URL地址
    - width: 图片宽度（像素，默认100）
    - height: 图片高度（像素，默认100）""",
    {"sheet": str, "row": int, "col": int, "image_url": str, "width": float, "height": float})
async def insert_image(args: Dict[str, Any]) -> Dict[str, Any]:
    """Insert image"""
    _log_tool_call("insert_image", args)
    operation = {"type": "insert_image", "params": {"sheet": args["sheet"], "row": args["row"], "col": args["col"], "imageUrl": args["image_url"], "width": args.get("width", 100), "height": args.get("height", 100)}}
    result = _create_tool_result(operation, f"Operation: insert_image at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("insert_image", {"operation": operation})
    return result


@tool("delete_image",
    """Delete an image from the worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除图片
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的图片：
    - ✅ **图片ID**：[图片ID]
    
    图片已删除。
    
    **参数说明：**
    - sheet: 工作表名称
    - image_id: 图片ID""",
    {"sheet": str, "image_id": str})
async def delete_image(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete image"""
    _log_tool_call("delete_image", args)
    operation = {"type": "delete_image", "params": {"sheet": args["sheet"], "imageId": args["image_id"]}}
    result = _create_tool_result(operation, f"Operation: delete_image {args['image_id']}")
    _log_tool_result("delete_image", {"operation": operation})
    return result


@tool("update_image",
    """Update an existing image's position or size.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：更新图片
    
    ✅ **操作已完成！**
    
    我已成功更新了"[工作表名]"工作表的图片：
    - ✅ **图片ID**：[图片ID]
    - ✅ **新位置**：[工作表名]!R[行号]C[列号]（如果更新了位置）
    - ✅ **新尺寸**：[宽度] x [高度]像素（如果更新了尺寸）
    
    图片已更新。
    
    **参数说明：**
    - sheet: 工作表名称
    - image_id: 图片ID
    - row: 新行号（可选）
    - col: 新列号（可选）
    - width: 新宽度（可选）
    - height: 新高度（可选）""",
    {"sheet": str, "image_id": str, "row": int, "col": int, "width": float, "height": float})
async def update_image(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update image"""
    _log_tool_call("update_image", args)
    operation = {"type": "update_image", "params": {"sheet": args["sheet"], "imageId": args["image_id"], "row": args.get("row"), "col": args.get("col"), "width": args.get("width"), "height": args.get("height")}}
    result = _create_tool_result(operation, f"Operation: update_image {args['image_id']}")
    _log_tool_result("update_image", {"operation": operation})
    return result


# ============================================================
# Shape Operations Tools
# ============================================================

@tool("insert_shape",
    """Insert a shape (rectangle, circle, line, arrow, etc.) into the worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：插入形状
    
    ✅ **操作已完成！**
    
    我已成功在"[工作表名]"工作表插入了形状：
    - ✅ **位置**：[工作表名]!R[行号]C[列号]
    - ✅ **形状类型**：[形状类型，如"矩形"、"圆形"、"箭头"等]
    - ✅ **尺寸**：[宽度] x [高度]像素
    
    形状已插入到工作表中。
    
    **参数说明：**
    - sheet: 工作表名称
    - shape_type: 形状类型（'rectangle', 'circle', 'line', 'arrow'等）
    - row: 行号（从1开始）
    - col: 列号（从1开始）
    - width: 宽度（像素，默认100）
    - height: 高度（像素，默认100）
    - style: 样式对象（可选）""",
    {"sheet": str, "shape_type": str, "row": int, "col": int, "width": float, "height": float, "style": dict})
async def insert_shape(args: Dict[str, Any]) -> Dict[str, Any]:
    """Insert shape"""
    _log_tool_call("insert_shape", args)
    operation = {"type": "insert_shape", "params": {"sheet": args["sheet"], "shapeType": args["shape_type"], "row": args["row"], "col": args["col"], "width": args.get("width", 100), "height": args.get("height", 100), "style": args.get("style", {})}}
    result = _create_tool_result(operation, f"Operation: insert_shape {args['shape_type']} at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("insert_shape", {"operation": operation})
    return result


@tool("delete_shape",
    """Delete a shape from the worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除形状
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的形状：
    - ✅ **形状ID**：[形状ID]
    
    形状已删除。
    
    **参数说明：**
    - sheet: 工作表名称
    - shape_id: 形状ID""",
    {"sheet": str, "shape_id": str})
async def delete_shape(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete shape"""
    _log_tool_call("delete_shape", args)
    operation = {"type": "delete_shape", "params": {"sheet": args["sheet"], "shapeId": args["shape_id"]}}
    result = _create_tool_result(operation, f"Operation: delete_shape {args['shape_id']}")
    _log_tool_result("delete_shape", {"operation": operation})
    return result


@tool("update_shape",
    """Update an existing shape's properties.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：更新形状
    
    ✅ **操作已完成！**
    
    我已成功更新了"[工作表名]"工作表的形状：
    - ✅ **形状ID**：[形状ID]
    - ✅ **新位置**：[工作表名]!R[行号]C[列号]（如果更新了位置）
    - ✅ **新尺寸**：[宽度] x [高度]像素（如果更新了尺寸）
    
    形状已更新。
    
    **参数说明：**
    - sheet: 工作表名称
    - shape_id: 形状ID
    - row: 新行号（可选）
    - col: 新列号（可选）
    - width: 新宽度（可选）
    - height: 新高度（可选）
    - style: 新样式（可选）""",
    {"sheet": str, "shape_id": str, "row": int, "col": int, "width": float, "height": float, "style": dict})
async def update_shape(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update shape"""
    _log_tool_call("update_shape", args)
    operation = {"type": "update_shape", "params": {"sheet": args["sheet"], "shapeId": args["shape_id"], "row": args.get("row"), "col": args.get("col"), "width": args.get("width"), "height": args.get("height"), "style": args.get("style")}}
    result = _create_tool_result(operation, f"Operation: update_shape {args['shape_id']}")
    _log_tool_result("update_shape", {"operation": operation})
    return result


# ============================================================
# Chart Operations Tools
# ============================================================

@tool("create_chart",
    """Create a chart from structured data (preferably summarized/aggregated data, not raw detail rows).

    Supported chart_type: column | line | pie | bar | area | scatter | doughnut

    Parameters:
    - sheet: worksheet containing the data
    - chart_type: one of the supported types above
    - data_range: {"startRow": int, "startCol": int, "endRow": int, "endCol": int} (1-based, header row included)
    - title: chart title string
    - row: chart anchor row (1-based, should be outside data area)
    - col: chart anchor column (1-based, typically dataMaxCol + 2)
    - width, height: optional, default 400x300

    Parameter constraints:
    - data_range must cover at least 2 columns (label + value) for pie/doughnut.
    - data_range endRow must NOT include total/subtotal rows.
    - row/col must be outside the data area to avoid covering cells.
    - Prefer summarized data over raw detail; raw detail > 60 rows will be auto-capped.
    - For multiple charts on same sheet, space them vertically (increment row by ~18).

    Correct call example:
      create_chart(sheet="Analysis", chart_type="column",
        data_range={"startRow": 2, "startCol": 1, "endRow": 8, "endCol": 4},
        title="Sales by Channel", row=2, col=6)

    Common mistakes:
    - Using unsupported chart_type like "donut" -> use "doughnut".
    - data_range pointing to raw 500-row detail -> chart unreadable; summarize first.
    - Placing chart at row=1, col=1 -> covers data cells.
    - Including total row in data_range -> distorts pie chart proportions.""",
    {"sheet": str, "chart_type": str, "data_range": dict, "title": str, "row": int, "col": int, "width": float, "height": float})
async def create_chart(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create chart"""
    _log_tool_call("create_chart", args)
    err = _prevalidate_args(
        "create_chart",
        args,
        ["sheet", "chart_type", "data_range", "title", "row", "col"],
        ["row", "col"],
    )
    if err:
        return _reject(err)
    # 基本参数解析（处理 JSON 字符串格式）
    # 注意：范围参数规范化将由 _normalize_operation 统一处理
    normalized_data_range = _parse_dict_param(args.get("data_range", {}))
    operation = {
        "type": "create_chart",
        "params": {
            "sheet": args["sheet"], "chartType": args["chart_type"], "dataRange": normalized_data_range,
            "title": args.get("title", ""), "row": args["row"], "col": args["col"],
            "width": args.get("width", 400), "height": args.get("height", 300)
        }
    }
    result = _create_tool_result(operation, f"Operation: create_chart {args['chart_type']} at {args['sheet']}!R{args['row']}C{args['col']}")
    _log_tool_result("create_chart", {"operation": operation})
    return result


@tool("update_chart",
    """Update an existing chart's properties or data.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：更新图表
    
    ✅ **操作已完成！**
    
    我已成功更新了"[工作表名]"工作表的图表：
    - ✅ **图表ID**：[图表ID]
    - ✅ **更新内容**：[更新内容描述，如"数据范围"、"标题"、"样式"等]
    
    图表已更新。
    
    **参数说明：**
    - sheet: 工作表名称
    - chart_id: 图表ID
    - data_range: 新数据范围（可选）
    - title: 新标题（可选）
    - style: 新样式（可选）""",
    {"sheet": str, "chart_id": str, "data_range": dict, "title": str, "style": dict})
async def update_chart(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update chart"""
    _log_tool_call("update_chart", args)
    # 规范化 data_range 和 style 参数（可能是 JSON 字符串）
    normalized_data_range = _parse_dict_param(args.get("data_range")) if args.get("data_range") else None
    normalized_style = _parse_dict_param(args.get("style")) if args.get("style") else None
    operation = {
        "type": "update_chart",
        "params": {
            "sheet": args["sheet"],
            "chartId": args["chart_id"],
            "dataRange": normalized_data_range,
            "title": args.get("title"),
            "style": normalized_style
        }
    }
    result = _create_tool_result(operation, f"Operation: update_chart {args['chart_id']}")
    _log_tool_result("update_chart", {"operation": operation})
    return result


@tool("delete_chart",
    """Delete a chart from the worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除图表
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的图表：
    - ✅ **图表ID**：[图表ID]
    
    图表已删除。
    
    **参数说明：**
    - sheet: 工作表名称
    - chart_id: 图表ID""",
    {"sheet": str, "chart_id": str})
async def delete_chart(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete chart"""
    _log_tool_call("delete_chart", args)
    operation = {"type": "delete_chart", "params": {"sheet": args["sheet"], "chartId": args["chart_id"]}}
    result = _create_tool_result(operation, f"Operation: delete_chart {args['chart_id']}")
    _log_tool_result("delete_chart", {"operation": operation})
    return result


# ============================================================
# Pivot Table Operations Tools
# ============================================================

@tool("create_pivot_table",
    """Create a pivot table with multiple value fields and aggregations.

    Use when: user needs multi-field pivot (multiple value columns with different aggregations).
    For single value field, prefer create_pivot_data (simpler).

    Sheet creation: target_sheet is auto-created if it does not exist. No need to call add_sheet first.

    Parameters:
    - sheet: source worksheet name
    - source_range: {"startRow": int, "startCol": int, "endRow": int, "endCol": int} (1-based, include header)
    - row_fields: list of column numbers or column names for row grouping (required)
    - col_fields: list of column numbers or names for column headers (optional, default [])
    - value_fields: list of column numbers or names to aggregate (required)
    - value_aggregations: dict mapping field name to aggregation, e.g. {"Amount": "sum", "Qty": "count"}
    - target_sheet: destination sheet name (optional; auto-created if missing)
    - target_row, target_col: insertion position (default 1, 1)

    Parameter constraints:
    - source_range must include the header row.
    - row_fields and value_fields must reference columns that exist in source_range.
    - value_aggregations keys should match value_fields names exactly.

    Correct call example:
      create_pivot_table(sheet="Sales", source_range={"startRow":1,"startCol":1,"endRow":200,"endCol":10},
        row_fields=["Channel"], value_fields=["Revenue","OrderCount"],
        value_aggregations={"Revenue":"sum","OrderCount":"count"},
        target_sheet="Pivot", target_row=1, target_col=1)

    Common mistakes:
    - Calling add_sheet before this tool -> unnecessary, target_sheet is auto-created.
    - Mismatched value_aggregations keys vs value_fields -> aggregation defaults to sum.
    - source_range missing header row -> field names unresolvable.""",
    {"sheet": str, "source_range": dict, "row_fields": list, "col_fields": list, "value_fields": list, "value_aggregations": dict, "target_sheet": str, "target_row": int, "target_col": int})
async def create_pivot_table(args: Dict[str, Any]) -> Dict[str, Any]:
    """Create pivot table"""
    _log_tool_call("create_pivot_table", args)
    source_sheet = args["sheet"]
    target_sheet = args.get("target_sheet", source_sheet)
    
    # 基本参数解析（处理 JSON 字符串格式）
    # 注意：字段名转换和范围参数规范化将由 _normalize_operation 统一处理
    normalized_row_fields = _parse_list_param(args.get("row_fields", []))
    normalized_col_fields = _parse_list_param(args.get("col_fields", []))
    normalized_value_fields = _parse_list_param(args.get("value_fields", []))
    normalized_value_aggregations = _parse_dict_param(args.get("value_aggregations", {}))
    normalized_source_range = _parse_dict_param(args.get("source_range", {}))
    
    # 创建透视表操作
    # 参数规范化（字段名转换、范围格式标准化）将在 _normalize_operation 中统一处理
    pivot_operation = {
        "type": "create_pivot_table",
        "params": {
            "sheet": source_sheet, "sourceRange": normalized_source_range,
            "rowFields": normalized_row_fields, "colFields": normalized_col_fields,
            "valueFields": normalized_value_fields, "valueAggregations": normalized_value_aggregations,
            "targetSheet": target_sheet,
            "targetRow": args.get("target_row", 1), "targetCol": args.get("target_col", 1)
        }
    }
    
    operations = [pivot_operation]
    
    # 始终设置为活动工作表，确保用户可以看到新创建的透视表
    # 注意：如果 target_sheet 未指定，前端 createPivotTable 会创建新工作表并设置名称
    # 前端会设置 workbook.activeSheet，但为了确保一致性，后端也生成 set_active_sheet 操作
    # 如果 target_sheet 未提供，前端会创建新工作表，名称格式为：源工作表名+"透视表"
    # 在这种情况下，前端 createPivotTable 会设置 workbook.activeSheet，后端操作可能使用错误的名称
    # 因此，只有在 target_sheet 明确提供时才生成 set_active_sheet 操作
    # 否则，依赖前端 createPivotTable 函数设置的 workbook.activeSheet
    if target_sheet and target_sheet != source_sheet:
        set_active_operation = {"type": "set_active_sheet", "params": {"name": target_sheet}}
        operations.append(set_active_operation)
    
    result = _create_tool_result_with_operations(operations, f"Operation: create_pivot_table with row fields {args['row_fields']}")
    _log_tool_result("create_pivot_table", {"operation": pivot_operation})
    return result


@tool("update_pivot_table",
    """Update an existing pivot table's configuration.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：更新数据透视表
    
    ✅ **操作已完成！**
    
    我已成功更新了"[工作表名]"工作表的数据透视表：
    - ✅ **透视表ID**：[透视表ID]
    - ✅ **更新内容**：[更新内容描述，如"行字段"、"列字段"、"值字段"等]
    
    数据透视表已更新。
    
    **参数说明：**
    - sheet: 工作表名称
    - pivot_table_id: 透视表ID
    - row_fields: 新行字段列表（可选）
    - col_fields: 新列字段列表（可选）
    - value_fields: 新值字段列表（可选）""",
    {"sheet": str, "pivot_table_id": str, "row_fields": list, "col_fields": list, "value_fields": list})
async def update_pivot_table(args: Dict[str, Any]) -> Dict[str, Any]:
    """Update pivot table"""
    _log_tool_call("update_pivot_table", args)
    # 规范化字段参数（可能是 JSON 字符串）
    normalized_row_fields = _parse_list_param(args.get("row_fields")) if args.get("row_fields") else None
    normalized_col_fields = _parse_list_param(args.get("col_fields")) if args.get("col_fields") else None
    normalized_value_fields = _parse_list_param(args.get("value_fields")) if args.get("value_fields") else None
    operation = {
        "type": "update_pivot_table",
        "params": {
            "sheet": args["sheet"],
            "pivotTableId": args["pivot_table_id"],
            "rowFields": normalized_row_fields,
            "colFields": normalized_col_fields,
            "valueFields": normalized_value_fields
        }
    }
    result = _create_tool_result(operation, f"Operation: update_pivot_table {args['pivot_table_id']}")
    _log_tool_result("update_pivot_table", {"operation": operation})
    return result


@tool("delete_pivot_table",
    """Delete a pivot table from the worksheet.
    
    **输出格式示例（必须按照此格式回复）：**
    
    🔧 正在执行：删除数据透视表
    
    ✅ **操作已完成！**
    
    我已成功删除了"[工作表名]"工作表的数据透视表：
    - ✅ **透视表ID**：[透视表ID]
    
    数据透视表已删除。
    
    **参数说明：**
    - sheet: 工作表名称
    - pivot_table_id: 透视表ID""",
    {"sheet": str, "pivot_table_id": str})
async def delete_pivot_table(args: Dict[str, Any]) -> Dict[str, Any]:
    """Delete pivot table"""
    _log_tool_call("delete_pivot_table", args)
    operation = {"type": "delete_pivot_table", "params": {"sheet": args["sheet"], "pivotTableId": args["pivot_table_id"]}}
    result = _create_tool_result(operation, f"Operation: delete_pivot_table {args['pivot_table_id']}")
    _log_tool_result("delete_pivot_table", {"operation": operation})
    return result


# ============================================================
# Batch Operations Tool
# ============================================================

@tool("batch_operations",
    """Execute multiple operations atomically in one call. Use for styling, formatting, and multi-step changes that should apply together.

    Parameters:
    - operations: list of {"type": str, "params": dict}

    Each sub-operation type must be a valid operation name (e.g. set_range_style, set_cell_value, auto_fit_column).
    Sub-operation params follow the same rules as calling that tool directly.

    Use when: applying table beautification (header style + data style + column width in one batch),
    or any sequence of 3+ formatting operations on the same sheet.

    Parameter constraints:
    - Each sub-operation must have both "type" and "params" keys.
    - Sub-operation types are validated; unknown types are rejected.
    - If any sub-operation fails, subsequent operations are skipped (fail-fast).

    Correct call example:
      batch_operations(operations=[
        {"type": "set_range_style", "params": {"sheet":"Sheet1","startRow":1,"startCol":1,"endRow":1,"endCol":5,
          "bold":true,"backgroundColor":"#217346","fontColor":"#FFFFFF"}},
        {"type": "set_range_style", "params": {"sheet":"Sheet1","startRow":2,"startCol":1,"endRow":100,"endCol":5,
          "borderStyle":"thin","borderColor":"#D9D9D9"}},
        {"type": "auto_fit_column", "params": {"sheet":"Sheet1","col":1,"endCol":5}}
      ])

    Common mistakes:
    - Missing "type" or "params" in a sub-operation -> rejected.
    - Using snake_case type names inconsistently -> use the canonical name from tool list.""",
    {"operations": list})
async def batch_operations(args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute batch operations"""
    _log_tool_call("batch_operations", args)
    
    import json
    operations = args.get("operations")
    if operations is None:
        return _reject("[batch_operations] ERROR: missing required param 'operations'")

    # 解析 JSON 字符串
    if isinstance(operations, str):
        try:
            operations = json.loads(operations)
        except (json.JSONDecodeError, ValueError) as e:
            return _reject(f"[batch_operations] ERROR: failed to parse operations JSON: {e}")

    if not isinstance(operations, list):
        return _reject(f"[batch_operations] ERROR: 'operations' must be a list, got {type(operations).__name__}")

    if not operations:
        return _reject("[batch_operations] ERROR: 'operations' list is empty")

    # 规范化 + 严格校验每个子操作（未知类型/缺参直接拒绝，避免“假成功”）
    normalized_operations = []
    skipped_errors: List[tuple] = []
    for idx, op in enumerate(operations):
        if not isinstance(op, dict) or "type" not in op:
            skipped_errors.append((idx, f"invalid format: {type(op).__name__}, expected dict with 'type'"))
            continue
        op_type = camel_to_snake_op_type(op.get("type"))
        op_params = op.get("params", {})
        if not isinstance(op_params, dict):
            skipped_errors.append((idx, f"{op_type}: params must be object, got {type(op_params).__name__}"))
            continue
        try:
            normalized_params = normalize_operation_params(op_type, op_params.copy())
        except Exception as e:
            skipped_errors.append((idx, f"{op_type}: normalize failed: {e}"))
            continue

        validation = validate_operation_params(op_type, normalized_params)
        if not validation.is_valid:
            skipped_errors.append((idx, f"{op_type}: {'; '.join(validation.errors)}"))
            continue

        normalized_operations.append({"type": op_type, "params": normalized_params})

    if skipped_errors:
        warn = "\n".join(f"  - op[{i}]: {err}" for i, err in skipped_errors)
        return _reject(
            f"[batch_operations] ERROR: {len(skipped_errors)} invalid sub-operations detected. "
            f"Please fix and retry:\n{warn}"
        )

    operation = {"type": "batch_operations", "params": {"operations": normalized_operations}}
    result = _create_tool_result(operation, f"Operation: batch_operations with {len(normalized_operations)} operations")
    _log_tool_result("batch_operations", {"operation": operation})
    return result


# ============================================================
# 自定义公式工具
# ============================================================

@tool("apply_custom_formula",
    """对指定列的数据范围应用用户自定义公式。支持单单元格计算和多列联动。

    **表达式语法**：
    - `value`：当前目标列单元格的数值
    - 列字母（A, B, C ... Z, AA）：同行对应列的数值
    - 自定义参数名（如 rate, discount）：常量参数
    
    **单单元格示例**：expression="value * (1 - rate)", formula_params={"rate": 0.13}
    **多列联动示例**：expression="C - D"（同行 C 列减 D 列）
    
    **使用场景**：当用户说"F列采用XX公式计算"或上下文中包含自定义公式列表时使用。
    从上下文的 customFormulas 字段读取可用公式名和表达式，然后调用此工具。
    
    **参数说明**：
    - sheet: 工作表名称
    - target_col: 结果写入的目标列号（从1开始）
    - start_row: 数据起始行（从1开始，通常为2，跳过表头）
    - end_row: 数据结束行
    - expression: JS 表达式字符串
    - formula_params: 常量参数字典（如 {"rate": 0.13}），无参数时传 {}""",
    {"sheet": str, "target_col": int, "start_row": int, "end_row": int,
     "expression": str, "formula_params": dict})
async def apply_custom_formula(args: Dict[str, Any]) -> Dict[str, Any]:
    """对指定范围应用自定义公式"""
    _log_tool_call("apply_custom_formula", args)
    operation = {
        "type": "apply_custom_formula",
        "params": {
            "sheet": args["sheet"],
            "targetCol": int(args["target_col"]),
            "startRow": int(args["start_row"]),
            "endRow": int(args["end_row"]),
            "expression": args["expression"],
            "formulaParams": _parse_dict_param(args.get("formula_params", {})),
        }
    }
    result = _create_tool_result(
        operation,
        f"Operation: apply_custom_formula on col {args['target_col']} "
        f"rows {args['start_row']}-{args['end_row']} expression={args['expression']}"
    )
    _log_tool_result("apply_custom_formula", {"operation": operation})
    return result


# ============================================================
# Create MCP Server with all tools
# ============================================================

# =====================================================================
#  确定性分析计划工具（四层架构核心）
# =====================================================================

@tool("submit_analysis_plan",
    """Submit a structured analysis plan. The deterministic compiler generates all operations.

    Use this tool for: smart analysis, auto analysis, comprehensive analysis, data analysis with charts.
    When user says "分析数据", "智能分析", "生成图表并总结", you MUST use this tool.

    Parameter: plan (JSON string):
    {"blocks":[{"source_sheet":"sheet name","group_by_col":"grouping column name (must match context headers exactly)","metric_col":"metric column name (must be numeric)","aggregation":"sum","chart_type":"auto","title":"optional title"}],"include_insights":true}

    aggregation: sum/avg/count/max/min
    chart_type: auto/column/bar/line/pie/area/scatter/doughnut (recommend auto)
    blocks: 1-5 items, ordered by priority

    Example: submit_analysis_plan(plan='{"blocks":[{"source_sheet":"销售数据","group_by_col":"产品名称","metric_col":"总金额","aggregation":"sum","chart_type":"auto"}],"include_insights":true}')

    Common errors:
    - group_by_col picked ID/编号 column (should pick business category like 产品名称/渠道/区域)
    - metric_col picked text column (should pick numeric like 金额/数量/单价)
    - Column name does not exactly match context headers""",
    {"plan": str})
async def submit_analysis_plan(args: Dict[str, Any]) -> Dict[str, Any]:
    """Submit structured analysis plan for deterministic compilation"""
    plan = args.get("plan", "")
    _log_tool_call("submit_analysis_plan", args)
    import json as _json
    prefix = _log_prefix()

    # 解析 JSON
    try:
        if isinstance(plan, str):
            raw = _json.loads(plan)
        elif isinstance(plan, dict):
            raw = plan
        else:
            return {"content": [{"type": "text", "text": f"ERROR: plan 参数必须是 JSON 字符串或字典，收到 {type(plan).__name__}"}]}
    except _json.JSONDecodeError as e:
        return {"content": [{"type": "text", "text": f"ERROR: plan JSON 解析失败: {e}"}]}

    tool_log.info(f"{prefix}submit_analysis_plan 收到计划: {_json.dumps(raw, ensure_ascii=False)[:500]}")

    # 导入编译器和契约
    from .plan_contract import parse_analysis_plan, validate_analysis_plan
    from .plan_compiler import compile_analysis_plan

    # 解析计划
    analysis_plan = parse_analysis_plan(raw)

    # 获取 excel_state（优先 ContextVar，异步边界丢失时回退会话缓存）
    excel_state = _get_tool_excel_state_fallback()
    if not (excel_state.get("sheets") or []):
        recovered = _recover_excel_state_by_plan(raw)
        if recovered.get("sheets"):
            excel_state = recovered
            tool_log.info(
                f"{prefix}submit_analysis_plan 通过计划反查恢复上下文: sheets={len(excel_state.get('sheets') or [])}"
            )
    if not (excel_state.get("sheets") or []):
        sid = _tool_session_id.get("").strip()
        tool_log.warning(
            f"{prefix}submit_analysis_plan 未获取到工作表上下文（excel_state.sheets 为空, sid={sid or 'N/A'}, cache={len(_tool_excel_state_cache)}）"
        )

    # 提取验证所需元数据
    sheets = excel_state.get("sheets") or []
    available_sheets = [s.get("name", "") for s in sheets if s.get("name")]
    headers_by_sheet = {}
    sample_by_sheet = {}
    for s in sheets:
        name = s.get("name", "")
        if name:
            headers_by_sheet[name] = [str(h) for h in s.get("headers", [])]
            sample_by_sheet[name] = s.get("sampleData", [])

    # 验证计划
    validation = validate_analysis_plan(
        analysis_plan,
        available_sheets,
        headers_by_sheet,
        sample_by_sheet,
    )

    if not validation.is_valid:
        err_text = "计划验证失败:\n" + "\n".join(f"- {e}" for e in validation.errors)
        if validation.warnings:
            err_text += "\n注意:\n" + "\n".join(f"- {w}" for w in validation.warnings)
        tool_log.warning(f"{prefix}submit_analysis_plan 验证失败: {err_text}")
        return {"content": [{"type": "text", "text": f"ERROR: {err_text}"}]}

    if validation.warnings:
        tool_log.info(f"{prefix}submit_analysis_plan 验证警告: {validation.warnings}")

    # 编译计划为操作序列
    validated_plan = validation.plan
    operations = compile_analysis_plan(validated_plan, excel_state)

    tool_log.info(f"{prefix}submit_analysis_plan 编译完成: {len(operations)} 个操作")

    # 返回全部操作（复用现有操作返回机制）
    return _create_tool_result_with_operations(
        operations,
        f"分析计划已编译为 {len(operations)} 个操作",
        excel_state,
    )


all_tools = [
    # Cell operations
    set_cell_value, set_cell_formula, set_cell_style, clear_cell,
    # Range operations
    set_range_values, set_range_style, clear_range, merge_cells, unmerge_cells,
    # Row/Column operations
    insert_rows, delete_rows, insert_columns, delete_columns,
    set_row_height, set_column_width, hide_rows, hide_columns, show_rows, show_columns, auto_fit_column,
    # Sheet operations
    add_sheet, rename_sheet, copy_sheet, set_active_sheet,
    # Data operations
    sort_range, filter_data, remove_filter, find_replace, copy_paste, fill_series, remove_duplicates,
    # Data query (read-only)
    query_unique_values,
    # Formatting operations
    conditional_format, clear_formatting,
    # Data analysis
    create_pivot_data, calculate_statistics, summarize_by_column, summarize_metrics_by_column,
    # Data validation
    set_data_validation, remove_data_validation,
    # Comment operations
    add_comment, delete_comment, update_comment,
    # Hyperlink operations
    set_hyperlink, remove_hyperlink,
    # Image operations
    insert_image, delete_image, update_image,
    # Shape operations
    insert_shape, delete_shape, update_shape,
    # Chart operations
    create_chart, update_chart, delete_chart,
    # Pivot table operations
    create_pivot_table, update_pivot_table, delete_pivot_table,
    # Batch
    batch_operations,
    # Custom formula
    apply_custom_formula,
    # Deterministic plan execution
    submit_analysis_plan,
]

# Create the MCP server
excel_tools_server = create_sdk_mcp_server(
    name="excel-tools",
    version="1.0.0",
    tools=all_tools
)

# Tool names for allowed_tools configuration
EXCEL_TOOL_NAMES = [
    # Cell operations
    "mcp__excel-tools__set_cell_value",
    "mcp__excel-tools__set_cell_formula",
    "mcp__excel-tools__set_cell_style",
    "mcp__excel-tools__clear_cell",
    # Range operations
    "mcp__excel-tools__set_range_values",
    "mcp__excel-tools__set_range_style",
    "mcp__excel-tools__clear_range",
    "mcp__excel-tools__merge_cells",
    "mcp__excel-tools__unmerge_cells",
    # Row/Column operations
    "mcp__excel-tools__insert_rows",
    "mcp__excel-tools__delete_rows",
    "mcp__excel-tools__insert_columns",
    "mcp__excel-tools__delete_columns",
    "mcp__excel-tools__set_row_height",
    "mcp__excel-tools__set_column_width",
    "mcp__excel-tools__hide_rows",
    "mcp__excel-tools__hide_columns",
    "mcp__excel-tools__show_rows",
    "mcp__excel-tools__show_columns",
    "mcp__excel-tools__auto_fit_column",
    # Sheet operations
    "mcp__excel-tools__add_sheet",
    "mcp__excel-tools__rename_sheet",
    "mcp__excel-tools__copy_sheet",
    "mcp__excel-tools__set_active_sheet",
    # Data operations
    "mcp__excel-tools__sort_range",
    "mcp__excel-tools__filter_data",
    "mcp__excel-tools__remove_filter",
    "mcp__excel-tools__find_replace",
    "mcp__excel-tools__copy_paste",
    "mcp__excel-tools__fill_series",
    "mcp__excel-tools__remove_duplicates",
    # Data query (read-only, via frontend QueryBridge)
    "mcp__excel-tools__query_unique_values",
    "mcp__excel-tools__read_range_values",
    "mcp__excel-tools__aggregate_column",
    "mcp__excel-tools__query_column_profile",
    # Formatting operations
    "mcp__excel-tools__conditional_format",
    "mcp__excel-tools__clear_formatting",
    # Data analysis
    "mcp__excel-tools__create_pivot_data",
    "mcp__excel-tools__calculate_statistics",
    "mcp__excel-tools__summarize_by_column",
    "mcp__excel-tools__summarize_metrics_by_column",
    # Data validation
    "mcp__excel-tools__set_data_validation",
    "mcp__excel-tools__remove_data_validation",
    # Comment operations
    "mcp__excel-tools__add_comment",
    "mcp__excel-tools__delete_comment",
    "mcp__excel-tools__update_comment",
    # Hyperlink operations
    "mcp__excel-tools__set_hyperlink",
    "mcp__excel-tools__remove_hyperlink",
    # Image operations
    "mcp__excel-tools__insert_image",
    "mcp__excel-tools__delete_image",
    "mcp__excel-tools__update_image",
    # Shape operations
    "mcp__excel-tools__insert_shape",
    "mcp__excel-tools__delete_shape",
    "mcp__excel-tools__update_shape",
    # Chart operations
    "mcp__excel-tools__create_chart",
    "mcp__excel-tools__update_chart",
    "mcp__excel-tools__delete_chart",
    # Pivot table operations
    "mcp__excel-tools__create_pivot_table",
    "mcp__excel-tools__update_pivot_table",
    "mcp__excel-tools__delete_pivot_table",
    # Batch operations
    "mcp__excel-tools__batch_operations",
    # Custom formula
    "mcp__excel-tools__apply_custom_formula",
    # Deterministic plan execution
    "mcp__excel-tools__submit_analysis_plan",
]