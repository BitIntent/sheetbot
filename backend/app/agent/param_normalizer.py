# backend/app/agent/param_normalizer.py
"""
参数规范化模块
确保工具函数传递给前端的参数类型与前端期望一致
统一处理字段名格式不一致和范围参数格式不匹配问题
"""
import json
import re
from typing import Any, Dict, List, Optional, Union
from contextvars import ContextVar
from .date_normalizer import normalize_date_value, normalize_validation_params
from .operation_registry import resolve_operation_type
from ..utils.logger import get_logger

# 日志记录器
_normalizer_log = get_logger('agent.param_normalizer')

# ------------------------------------------------------------------
# 列名 / 表名装饰剥离（用户常用「」强调，与表头字面量不一致）
# ------------------------------------------------------------------
def strip_field_name_decorators(name: str) -> str:
    """
    去掉用户输入外层书名号、引号及尾缀「列」，用于与表头比对。
    例如 「状态」列 -> 状态；\"销售额\" -> 销售额
    """
    if not isinstance(name, str):
        return ''
    s = name.strip()
    # 「字段名」列 —— 结尾「列」在右书名号之外
    _m = re.match(r'^\u300c(.+)\u300d\u5217$', s) or re.match(r'^\u300e(.+)\u300f\u5217$', s)
    if _m:
        return _m.group(1).strip()
    # 迭代剥最外层配对符号（最多 8 层防止环）
    _pairs = (
        ('\u300c', '\u300d'), ('\u300e', '\u300f'),  # 「」『』
        ('\u201c', '\u201d'), ('\u2018', '\u2019'),  # “” ‘’
        ('"', '"'), ("'", "'"),
    )
    for _ in range(8):
        changed = False
        for a, b in _pairs:
            if s.startswith(a) and s.endswith(b) and len(s) > len(a) + len(b):
                s = s[len(a):-len(b)].strip()
                changed = True
                break
        if not changed:
            break
    if s.endswith('\u5217') and len(s) > 1:  # 列
        s = s[:-1].strip()
    return s


def resolve_field_name_to_header(raw: str, headers: List[str]) -> str:
    """
    将用户/模型给出的字段名字符串对齐为 headers 中的规范字符串（若可匹配）。
    """
    if not raw or not headers:
        return strip_field_name_decorators(raw) if raw else ''
    header_strs = [str(h) for h in headers if h is not None]
    t = raw.strip()
    st = strip_field_name_decorators(t)
    if t in header_strs:
        return t
    if st in header_strs:
        return st
    for h in header_strs:
        if strip_field_name_decorators(str(h).strip()) == st:
            return h
    return st


# 全局上下文变量，用于存储当前的 Excel 状态
_excel_state_context: ContextVar[Optional[Dict[str, Any]]] = ContextVar('excel_state', default=None)


def set_excel_state(excel_state: Optional[Dict[str, Any]]):
    """
    设置当前的 Excel 状态（用于字段名转换）
    
    Args:
        excel_state: Excel 状态字典
    """
    _excel_state_context.set(excel_state)


def get_excel_state() -> Optional[Dict[str, Any]]:
    """
    获取当前的 Excel 状态
    
    Returns:
        Excel 状态字典，如果未设置则返回 None
    """
    return _excel_state_context.get()


def normalize_param_value(value: Any, expected_type: type) -> Any:
    """
    规范化单个参数值
    
    Args:
        value: 参数值（可能是 JSON 字符串）
        expected_type: 期望的类型（dict, list, int, float, str, bool, Any）
    
    Returns:
        规范化后的参数值
    """
    # 如果期望类型是 Any，跳过类型检查，直接返回原值或尝试 JSON 解析
    if expected_type == Any or expected_type is Any:
        # 对于 Any 类型，尝试智能解析 JSON 字符串
        if isinstance(value, str):
            value_str = value.strip()
            if value_str.startswith('{'):
                try:
                    parsed = json.loads(value_str)
                    if isinstance(parsed, dict):
                        return parsed
                except (json.JSONDecodeError, ValueError):
                    pass
            elif value_str.startswith('['):
                try:
                    parsed = json.loads(value_str)
                    if isinstance(parsed, list):
                        return parsed
                except (json.JSONDecodeError, ValueError):
                    pass
        return value
    
    # 如果已经是期望的类型，直接返回
    if isinstance(value, expected_type):
        return value
    
    # 如果期望类型是 list，且值是字符串
    if expected_type == list and isinstance(value, str):
        value_str = value.strip()
        # 尝试解析 JSON 数组字符串（如 '["a", "b"]'）
        if value_str.startswith('['):
            try:
                parsed = json.loads(value_str)
                if isinstance(parsed, list):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass
        # 如果不是 JSON 数组，但期望是数组，将单个字符串转换为数组
        # 这对于 rowFields、valueFields 等字段很有用
        if value_str and not value_str.startswith('['):
            # 尝试按逗号分割（处理 "a,b,c" 格式）
            if ',' in value_str:
                return [item.strip() for item in value_str.split(',') if item.strip()]
            # 单个值，转换为单元素数组
            return [value_str]
    
    # 如果期望类型是 dict，且值是字符串，尝试解析 JSON
    if expected_type == dict and isinstance(value, str):
        value_str = value.strip()
        if value_str.startswith('{'):
            try:
                parsed = json.loads(value_str)
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass
    
    # 类型转换
    if expected_type == int and isinstance(value, (str, float)):
        try:
            return int(float(value))
        except (ValueError, TypeError):
            pass
    elif expected_type == float and isinstance(value, (str, int)):
        try:
            return float(value)
        except (ValueError, TypeError):
            pass
    elif expected_type == bool and isinstance(value, str):
        lower_value = value.lower().strip()
        if lower_value in ('true', '1', 'yes', 'on'):
            return True
        elif lower_value in ('false', '0', 'no', 'off'):
            return False
    
    # 如果无法转换，返回原值（让验证器处理错误）
    return value


def normalize_range_params(range_param: Union[Dict[str, Any], str, None]) -> Optional[Dict[str, Any]]:
    """
    规范化范围参数，统一转换为标准格式
    
    支持的输入格式：
    1. { startRow, startCol, endRow, endCol } - 后端常用格式
    2. { start: { row, col }, end: { row, col } } - 嵌套对象格式
    3. 字符串格式 "A1:B10" - Excel 范围字符串（保持原样）
    
    输出格式：
    { start: { row: int, col: int }, end: { row: int, col: int } }
    
    Args:
        range_param: 范围参数（可能是多种格式）
    
    Returns:
        规范化后的范围参数字典，如果输入无效则返回 None
    """
    if range_param is None:
        return None
    
    # 如果是字符串，保持原样（前端会处理）
    if isinstance(range_param, str):
        return range_param
    
    # 如果是字典，进行格式转换
    if isinstance(range_param, dict):
        # 格式1: { startRow, startCol, endRow, endCol }
        if 'startRow' in range_param or 'startCol' in range_param:
            start_row = range_param.get('startRow', range_param.get('start', 1))
            start_col = range_param.get('startCol', range_param.get('startCol', 1))
            end_row = range_param.get('endRow', range_param.get('end', 1))
            end_col = range_param.get('endCol', range_param.get('endCol', 1))
            
            return {
                'start': {'row': int(start_row), 'col': int(start_col)},
                'end': {'row': int(end_row), 'col': int(end_col)}
            }
        
        # 格式2: { start: { row, col }, end: { row, col } }
        elif 'start' in range_param and 'end' in range_param:
            start = range_param.get('start', {})
            end = range_param.get('end', {})
            
            return {
                'start': {
                    'row': int(start.get('row', start.get('rowIndex', 1))),
                    'col': int(start.get('col', start.get('colIndex', 1)))
                },
                'end': {
                    'row': int(end.get('row', end.get('rowIndex', 1))),
                    'col': int(end.get('col', end.get('colIndex', 1)))
                }
            }
        
        # 如果已经是标准格式，直接返回
        elif 'start' in range_param or 'end' in range_param:
            return range_param
    
    return None


def normalize_field_names(
    fields: Union[List[Any], str, None],
    excel_state: Optional[Dict[str, Any]] = None,
    sheet_name: Optional[str] = None
) -> List[str]:
    """
    规范化字段名参数，将列号转换为字段名
    
    支持的输入格式：
    1. 字段名数组：["销售人员", "产品ID"] - 直接返回
    2. 列号数组：[7, 2] - 转换为字段名（需要 Excel 状态）
    3. 混合格式：[7, "产品ID"] - 列号转换为字段名，字段名保持不变
    4. 字符串格式："销售人员,产品ID" 或 '["销售人员"]' - 解析为数组
    
    Args:
        fields: 字段参数（可能是字段名、列号或字符串）
        excel_state: Excel 状态（包含表头信息），用于列号转换
        sheet_name: 工作表名称，用于获取表头
    
    Returns:
        规范化后的字段名数组（字符串）
    """
    if fields is None:
        return []
    
    # 如果是字符串，尝试解析
    if isinstance(fields, str):
        fields_str = fields.strip()
        # 尝试解析 JSON 数组字符串
        if fields_str.startswith('['):
            try:
                parsed = json.loads(fields_str)
                if isinstance(parsed, list):
                    fields = parsed
                else:
                    fields = [parsed]
            except (json.JSONDecodeError, ValueError):
                # 如果不是 JSON，尝试按逗号分割
                fields = [item.strip() for item in fields_str.split(',') if item.strip()]
        else:
            # 按逗号分割
            fields = [item.strip() for item in fields_str.split(',') if item.strip()]
    
    # 确保是列表
    if not isinstance(fields, list):
        fields = [fields]
    
    # 获取表头信息（用于列号转换）
    headers = []
    if excel_state and sheet_name:
        # 从 excel_state 中获取表头
        sheets = excel_state.get('sheets', [])
        for sheet in sheets:
            if sheet.get('name') == sheet_name:
                headers = sheet.get('headers', [])
                break
    
    # 🔍 调试日志：记录规范化输入和 excel_state 状态
    _normalizer_log.debug(
        f'normalize_field_names: 输入 fields={fields}, '
        f'excel_state={"存在" if excel_state else "None"}, '
        f'sheet_name={sheet_name}, '
        f'headers数量={len(headers)}, '
        f'headers={headers[:5] if headers else []}...'  # 只记录前5个表头
    )
    
    # 规范化每个字段
    normalized_fields = []
    for field in fields:
        if field is None:
            continue
        
        # 字符串：去掉「」等装饰并对齐到表头中的规范列名
        if isinstance(field, str):
            header_strs = [str(h) for h in headers] if headers else []
            if header_strs:
                resolved = resolve_field_name_to_header(field, header_strs)
            else:
                resolved = strip_field_name_decorators(field)
            normalized_fields.append(resolved)
            _normalizer_log.debug(
                f'normalize_field_names: 字段 "{field}" -> "{resolved}"'
            )
        # 如果是数字（列号），转换为字段名
        elif isinstance(field, (int, float)):
            col_index = int(field)
            # 列号从1开始，数组索引从0开始
            if headers and 1 <= col_index <= len(headers):
                field_name = headers[col_index - 1]
                if field_name:
                    normalized_fields.append(str(field_name))
                    _normalizer_log.debug(
                        f'normalize_field_names: 列号 {col_index} -> 字段名 "{field_name}"'
                    )
                else:
                    normalized_fields.append(str(col_index))
                    _normalizer_log.warning(
                        f'normalize_field_names: 列号 {col_index} 对应的表头为空，保持列号'
                    )
            else:
                # 如果列号超出范围，保持原样（让前端处理错误）
                normalized_fields.append(str(col_index))
                _normalizer_log.warning(
                    f'normalize_field_names: 列号 {col_index} 超出范围 '
                    f'(表头数量: {len(headers)}), 保持列号'
                )
        else:
            # 其他类型，转换为字符串
            normalized_fields.append(str(field))
            _normalizer_log.debug(f'normalize_field_names: 字段 {field} 转换为字符串 "{str(field)}"')
    
    # 🔍 调试日志：记录规范化输出
    _normalizer_log.debug(
        f'normalize_field_names: 输出 normalized_fields={normalized_fields}'
    )
    
    return normalized_fields


# ------------------------------------------------------------------
# 通用 snake_case -> camelCase 算法（零维护，自动覆盖任何新参数）
# ------------------------------------------------------------------
def snake_to_camel(key: str) -> str:
    """
    通用 snake_case -> camelCase 转换。
    已经是 camelCase / 单词的键名不含 '_' 分段，不变（幂等安全）。
    """
    parts = key.split('_')
    if len(parts) == 1:
        return key
    return parts[0] + ''.join(p.capitalize() for p in parts[1:])


def _convert_keys(params: Dict[str, Any]) -> Dict[str, Any]:
    """将参数字典的 snake_case 键名统一转换为 camelCase（单层）"""
    return {snake_to_camel(k): v for k, v in params.items()}


def camel_to_snake_op_type(name: Any) -> Any:
    """
    LLM 偶发输出 camelCase 操作类型（如 setRangeStyle），与工具链 snake_case 对齐。
    已是 snake_case 的字符串不变。
    """
    if not isinstance(name, str) or not name:
        return name
    if not re.search(r"[A-Z]", name):
        return name
    return re.sub(r"([a-z\d])([A-Z])", r"\1_\2", name).lower()


def normalize_operation_params(
    operation_type: str,
    params: Dict[str, Any],
    excel_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    规范化操作参数，确保类型与前端期望一致
    统一处理字段名格式不一致和范围参数格式不匹配问题
    
    Args:
        operation_type: 操作类型
        params: 操作参数（可能包含 JSON 字符串）
        excel_state: Excel 状态（包含表头信息），用于字段名转换
    
    Returns:
        规范化后的参数字典
    """
    # ── 第零步：操作类型别名解析（insert_rows -> insert_row 等） ──
    operation_type = resolve_operation_type(operation_type)

    # ── 第一步：snake_case -> camelCase 键名统一（通用算法，零维护） ──
    params = _convert_keys(params)

    normalized = {}
    
    # 根据操作类型定义参数类型映射（完整覆盖所有 50+ 操作类型）
    param_type_map = {
        # ============ Cell Operations ============
        'set_cell_value': {
            'sheet': str, 'row': int, 'col': int, 'value': Any
        },
        'set_cell_formula': {
            'sheet': str, 'row': int, 'col': int, 'formula': str
        },
        'set_cell_style': {
            'sheet': str, 'row': int, 'col': int, 'style': dict
        },
        'clear_cell': {
            'sheet': str, 'row': int, 'col': int, 'clearFormat': bool
        },
        
        # ============ Range Operations ============
        'set_range_values': {
            'sheet': str, 'startRow': int, 'startCol': int, 'values': list
        },
        'set_range_style': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 
            'endCol': int, 'style': dict
        },
        'clear_range': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 
            'endCol': int, 'clearFormat': bool
        },
        'merge_cells': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int
        },
        'unmerge_cells': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int
        },
        
        # ============ Row/Column Operations ============
        'insert_row': {
            'sheet': str, 'row': int, 'count': int
        },
        'delete_row': {
            'sheet': str, 'row': int, 'count': int
        },
        'insert_column': {
            'sheet': str, 'col': int, 'count': int
        },
        'delete_column': {
            'sheet': str, 'col': int, 'count': int
        },
        'set_row_height': {
            'sheet': str, 'row': int, 'height': float
        },
        'set_column_width': {
            'sheet': str, 'col': int, 'width': float
        },
        'hide_row': {
            'sheet': str, 'startRow': int, 'endRow': int
        },
        'hide_column': {
            'sheet': str, 'startCol': int, 'endCol': int
        },
        'show_row': {
            'sheet': str, 'startRow': int, 'endRow': int
        },
        'show_column': {
            'sheet': str, 'startCol': int, 'endCol': int
        },
        'auto_fit_column': {
            'sheet': str, 'col': int
        },
        
        # ============ Sheet Operations ============
        'add_sheet': {
            'name': str, 'position': int
        },
        'rename_sheet': {
            'oldName': str, 'newName': str
        },
        'copy_sheet': {
            'sourceName': str, 'newName': str, 'position': int
        },
        'set_active_sheet': {
            'name': str
        },
        
        # ============ Data Operations ============
        'sort_range': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int,
            'sortColumns': list, 'hasHeader': bool
        },
        'filter_data': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 
            'endCol': int, 'conditions': dict
        },
        'remove_filter': {
            'sheet': str
        },
        'find_replace': {
            'sheet': str, 'find': str, 'replace': str, 'matchCase': bool, 'matchEntireCell': bool
        },
        'copy_paste': {
            'sheet': str, 'sourceStartRow': int, 'sourceStartCol': int, 
            'sourceEndRow': int, 'sourceEndCol': int,
            'targetRow': int, 'targetCol': int, 'targetSheet': str, 'pasteValuesOnly': bool
        },
        'fill_series': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int,
            'direction': str, 'seriesType': str, 'step': float
        },
        'remove_duplicates': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 
            'endCol': int, 'columns': list, 'hasHeader': bool
        },
        
        # ============ Data Query (Read-Only) ============
        'query_unique_values': {
            'sheet': str, 'column': int, 'startRow': int, 'endRow': int
        },
        
        # ============ Formatting Operations ============
        'conditional_format': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 
            'endCol': int, 'ruleType': str, 'ruleParams': dict, 'formatStyle': dict
        },
        'clear_formatting': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int
        },
        
        # ============ Data Analysis ============
        'create_pivot_data': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int,
            'rowFields': list, 'colFields': list, 'valueField': (int, str),
            'aggregateFunction': str, 'targetSheet': str, 'targetRow': int, 'targetCol': int
        },
        'calculate_statistics': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int,
            'outputRow': int, 'outputCol': int
        },
        'summarize_by_column': {
            'sheet': str, 'startRow': int, 'endRow': int, 'startCol': int, 'endCol': int,
            'groupByCol': int, 'sumCol': int, 'targetRow': int, 'includeTotal': bool
        },
        'summarize_metrics_by_column': {
            'sheet': str, 'startRow': int, 'endRow': int, 'groupByCol': int, 'sumCol': int,
            'targetSheet': str, 'targetRow': int, 'targetCol': int, 'includeTotal': bool
        },
        
        # ============ Data Validation ============
        'set_data_validation': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int,
            'validationType': str, 'validationParams': dict
        },
        'remove_data_validation': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int
        },
        
        # ============ Comment Operations ============
        'add_comment': {
            'sheet': str, 'row': int, 'col': int, 'comment': str, 'author': str
        },
        'delete_comment': {
            'sheet': str, 'row': int, 'col': int
        },
        'update_comment': {
            'sheet': str, 'row': int, 'col': int, 'comment': str
        },
        
        # ============ Hyperlink Operations ============
        'set_hyperlink': {
            'sheet': str, 'row': int, 'col': int, 'url': str, 'text': str
        },
        'remove_hyperlink': {
            'sheet': str, 'row': int, 'col': int
        },
        
        # ============ Image Operations ============
        'insert_image': {
            'sheet': str, 'row': int, 'col': int, 'imageUrl': str, 'width': float, 'height': float
        },
        'delete_image': {
            'sheet': str, 'imageId': str
        },
        'update_image': {
            'sheet': str, 'imageId': str, 'row': int, 'col': int, 'width': float, 'height': float
        },
        
        # ============ Shape Operations ============
        'insert_shape': {
            'sheet': str, 'shapeType': str, 'row': int, 'col': int, 
            'width': float, 'height': float, 'style': dict
        },
        'delete_shape': {
            'sheet': str, 'shapeId': str
        },
        'update_shape': {
            'sheet': str, 'shapeId': str, 'row': int, 'col': int, 
            'width': float, 'height': float, 'style': dict
        },
        
        # ============ Chart Operations ============
        'create_chart': {
            'sheet': str, 'row': int, 'col': int, 'chartType': str, 
            'dataRange': (str, dict), 'title': str, 'width': float, 'height': float
        },
        'update_chart': {
            'sheet': str, 'chartId': str, 'dataRange': (str, dict), 'title': str, 'style': dict
        },
        'delete_chart': {
            'sheet': str, 'chartId': str
        },
        
        # ============ Pivot Table Operations ============
        'create_pivot_table': {
            'sheet': str, 'sourceRange': (str, dict), 'rowFields': list, 
            'valueFields': list, 'colFields': list, 'valueAggregations': dict,
            'targetSheet': str, 'targetRow': int, 'targetCol': int
        },
        'update_pivot_table': {
            'sheet': str, 'pivotTableId': str, 'rowFields': list, 
            'colFields': list, 'valueFields': list
        },
        'delete_pivot_table': {
            'sheet': str, 'pivotTableId': str
        },
        
        # ============ Custom Formula ============
        'apply_custom_formula': {
            'sheet': str, 'targetCol': int, 'startRow': int, 'endRow': int,
            'expression': str, 'formulaParams': dict
        },

        # ============ Clear Conditional Format ============
        'clear_conditional_format': {
            'sheet': str, 'startRow': int, 'startCol': int, 'endRow': int, 'endCol': int
        },

        # ============ Batch Operations ============
        'batch_operations': {
            'operations': list
        },
    }
    
    # 获取该操作类型的参数类型映射
    type_map = param_type_map.get(operation_type, {})
    
    # 规范化每个参数
    for key, value in params.items():
        expected_type = type_map.get(key, Any)
        
        # 特殊处理：日期相关参数
        if key in ('value', 'startValue', 'endValue') and operation_type in ('set_cell_value', 'fill_series'):
            # 尝试规范化日期值
            normalized_value = normalize_date_value(value)
            normalized[key] = normalized_value
            continue
        
        # 特殊处理：batch_operations 中的 operations 列表需要规范化每个操作
        if key == 'operations' and operation_type == 'batch_operations' and isinstance(value, list):
            normalized_operations = []
            for op in value:
                if isinstance(op, dict) and 'type' in op:
                    op_type = resolve_operation_type(camel_to_snake_op_type(op.get('type')))
                    op_params = op.get('params', {})
                    # 递归规范化每个操作的参数
                    normalized_op_params = normalize_operation_params(op_type, op_params.copy())
                    normalized_operations.append({
                        'type': op_type,
                        'params': normalized_op_params
                    })
                else:
                    # 如果操作格式不正确，保持原样
                    normalized_operations.append(op)
            normalized[key] = normalized_operations
            continue
        
        # 特殊处理：set_range_values 中的 values 数组可能包含日期
        if key == 'values' and operation_type == 'set_range_values' and isinstance(value, list):
            normalized_values = []
            for row in value:
                if isinstance(row, list):
                    normalized_row = [normalize_date_value(cell_value) for cell_value in row]
                    normalized_values.append(normalized_row)
                else:
                    normalized_values.append(normalize_date_value(row))
            normalized[key] = normalized_values
            continue
        
        # 特殊处理：数据验证参数中的日期
        if key == 'validationParams' and operation_type == 'set_data_validation':
            validation_type = params.get('validationType', '')
            if isinstance(value, dict):
                normalized[key] = normalize_validation_params(validation_type, value)
                continue
            elif isinstance(value, str):
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, dict):
                        normalized[key] = normalize_validation_params(validation_type, parsed)
                        continue
                except (json.JSONDecodeError, ValueError):
                    pass
        
        # 特殊处理：范围参数规范化（sourceRange, dataRange）
        # 注：snake_case 版本已被 _convert_keys 转换
        if key in ('sourceRange', 'dataRange') and isinstance(value, (dict, str)):
            normalized_range = normalize_range_params(value)
            if normalized_range:
                normalized[key] = normalized_range
                continue
        
        # 特殊处理：sort_range 的 sortColumns 参数（复杂对象数组，不是简单字段名数组）
        if operation_type == 'sort_range' and key == 'sortColumns':
            # sortColumns 结构：[{column: number, order: string}, ...]
            # 需要解析 JSON 字符串，但不需要字段名转换
            normalized_sort_columns = []
            if isinstance(value, str):
                value_str = value.strip()
                if value_str.startswith('['):
                    try:
                        parsed = json.loads(value_str)
                        if isinstance(parsed, list):
                            normalized_sort_columns = parsed
                    except (json.JSONDecodeError, ValueError):
                        _normalizer_log.warning(f'sort_range: 解析 sortColumns JSON 失败: {value_str[:100]}')
                        normalized_sort_columns = []
                else:
                    _normalizer_log.warning(f'sort_range: sortColumns 是字符串但不是 JSON 格式: {value_str[:100]}')
            elif isinstance(value, list):
                normalized_sort_columns = value
            else:
                _normalizer_log.warning(f'sort_range: sortColumns 类型错误: {type(value)}')
                normalized_sort_columns = []
            
            # 验证并规范化每个元素
            validated_sort_columns = []
            for item in normalized_sort_columns:
                if isinstance(item, dict):
                    # 确保 column 和 order 字段存在
                    if 'column' in item or 'columnIndex' in item or 'col' in item:
                        col = item.get('column') or item.get('columnIndex') or item.get('col')
                        order = item.get('order', 'asc')
                        # 规范化 order 值
                        if order in ('asc', 'ascending'):
                            order = 'asc'
                        elif order in ('desc', 'descending'):
                            order = 'desc'
                        validated_sort_columns.append({
                            'column': int(col) if isinstance(col, (int, float)) else col,
                            'order': order
                        })
                    else:
                        _normalizer_log.warning(f'sort_range: sortColumns 元素缺少 column 字段: {item}')
                elif isinstance(item, str):
                    # 尝试解析 Python 字典格式的字符串
                    try:
                        # 处理 Python 字典格式：{'column': 12, 'order': 'desc'}
                        cleaned = item.replace("'", '"')
                        parsed = json.loads(cleaned)
                        if isinstance(parsed, dict) and ('column' in parsed or 'columnIndex' in parsed or 'col' in parsed):
                            col = parsed.get('column') or parsed.get('columnIndex') or parsed.get('col')
                            order = parsed.get('order', 'asc')
                            if order in ('asc', 'ascending'):
                                order = 'asc'
                            elif order in ('desc', 'descending'):
                                order = 'desc'
                            validated_sort_columns.append({
                                'column': int(col) if isinstance(col, (int, float)) else col,
                                'order': order
                            })
                    except (json.JSONDecodeError, ValueError):
                        _normalizer_log.warning(f'sort_range: 无法解析 sortColumns 元素: {item}')

            # 列名为字符串时（含「」书名号）按表头解析为 1-based 列号
            if excel_state is None:
                excel_state = get_excel_state()
            sheet_nm = params.get('sheet', '')
            hdrs: List[str] = []
            if excel_state and sheet_nm:
                for sh in excel_state.get('sheets', []):
                    if sh.get('name') == sheet_nm:
                        hdrs = [str(x) for x in (sh.get('headers') or []) if x is not None]
                        break
            repaired_sort: List[Dict[str, Any]] = []
            for el in validated_sort_columns:
                if not isinstance(el, dict):
                    continue
                col_v = el.get('column')
                if isinstance(col_v, str) and hdrs:
                    names = normalize_field_names([col_v], excel_state, sheet_nm)
                    if names:
                        try:
                            idx = hdrs.index(names[0])
                            repaired_sort.append({**el, 'column': idx + 1})
                            continue
                        except ValueError:
                            _normalizer_log.warning(
                                f'sort_range: 列名 "{col_v}" 未匹配到列号'
                            )
                repaired_sort.append(el)
            validated_sort_columns = repaired_sort

            normalized[key] = validated_sort_columns
            continue
        
        # 特殊处理：标量字段名参数（valueField 只能是单值 int|str，不可走列表路径）
        # 注：_convert_keys 已在入口将 snake_case 转为 camelCase，此处只需 camelCase 版本
        if key == 'valueField':
            sheet_name = params.get('sheet', params.get('targetSheet', ''))
            if excel_state is None:
                excel_state = get_excel_state()
            result = normalize_field_names(
                [value] if not isinstance(value, (list, tuple)) else value,
                excel_state, sheet_name,
            )
            if result:
                scalar = result[0]
                try:
                    normalized[key] = int(scalar)
                except (ValueError, TypeError):
                    normalized[key] = scalar
            else:
                normalized[key] = value
            continue

        # 特殊处理：列表字段名参数（rowFields, colFields, valueFields, columns）
        # 注：sortColumns 已单独处理；snake_case 版本已被 _convert_keys 转换，无需重复
        if key in ('rowFields', 'colFields', 'valueFields', 'columns'):
            sheet_name = params.get('sheet', params.get('targetSheet', ''))
            if excel_state is None:
                excel_state = get_excel_state()
            normalized_fields = normalize_field_names(value, excel_state, sheet_name)
            normalized[key] = normalized_fields
            continue
        
        # 特殊处理：filter_data 的 conditions 参数（键可能是列号）
        if operation_type == 'filter_data' and key == 'conditions' and isinstance(value, dict):
            sheet_name = params.get('sheet', '')
            # 如果没有传递 excel_state，尝试从上下文获取
            if excel_state is None:
                excel_state = get_excel_state()
            
            # 获取表头信息
            headers = []
            if excel_state and sheet_name:
                sheets = excel_state.get('sheets', [])
                for sheet in sheets:
                    if sheet.get('name') == sheet_name:
                        headers = sheet.get('headers', [])
                        break
            
            # 规范化 conditions 字典的键（列号 → 字段名）
            normalized_conditions = {}
            for col_key, condition_value in value.items():
                # 如果键是列号（数字），转换为字段名
                if isinstance(col_key, (int, float)):
                    col_index = int(col_key)
                    if headers and 1 <= col_index <= len(headers):
                        field_name = headers[col_index - 1]
                        if field_name:
                            normalized_conditions[str(field_name)] = condition_value
                        else:
                            # 如果字段名为空，保持列号
                            normalized_conditions[str(col_index)] = condition_value
                    else:
                        # 如果列号超出范围，保持原样
                        normalized_conditions[str(col_index)] = condition_value
                else:
                    # 字符串键可能含「」书名号，对齐到表头字面量
                    sk = str(col_key)
                    if headers:
                        header_strs = [str(h) for h in headers if h is not None]
                        resolved_key = resolve_field_name_to_header(sk, header_strs)
                    else:
                        resolved_key = strip_field_name_decorators(sk)
                    normalized_conditions[str(resolved_key)] = condition_value
            
            normalized[key] = normalized_conditions
            continue
        
        # 如果参数不在类型映射中，尝试智能推断类型
        # 检查是否是 Any 类型（使用 is 比较，因为 Any 是单例）
        if expected_type is Any or expected_type == Any:
            # 如果值是字符串且看起来像 JSON，尝试解析
            if isinstance(value, str):
                value_str = value.strip()
                if value_str.startswith('{'):
                    try:
                        parsed = json.loads(value_str)
                        if isinstance(parsed, dict):
                            normalized[key] = parsed
                            continue
                    except (json.JSONDecodeError, ValueError):
                        pass
                elif value_str.startswith('['):
                    try:
                        parsed = json.loads(value_str)
                        if isinstance(parsed, list):
                            normalized[key] = parsed
                            continue
                    except (json.JSONDecodeError, ValueError):
                        pass
            # 对于 Any 类型，直接使用原值（已在 normalize_param_value 中处理）
            normalized[key] = value
            continue
        
        # 处理联合类型（如 dataRange 可以是 str 或 dict）
        if isinstance(expected_type, tuple):
            # 尝试按顺序转换
            normalized_value = value
            for t in expected_type:
                # 跳过 Any 类型
                if t is Any or t == Any:
                    normalized_value = value
                    break
                normalized_value = normalize_param_value(value, t)
                # 检查转换后的类型（但跳过 Any 类型检查）
                if t is not Any and t != Any and isinstance(normalized_value, t):
                    break
            normalized[key] = normalized_value
        else:
            normalized_value = normalize_param_value(value, expected_type)
            normalized[key] = normalized_value
    
    # ── 出口类型契约验证：最后一道防线，修正上游遗漏的类型不一致 ──
    return _enforce_type_contract(normalized, type_map, operation_type)


# ──────────────────────────────────────────────────────────────
# 出口类型契约 —— 最后一道防线
# ──────────────────────────────────────────────────────────────
def _enforce_type_contract(
    params: Dict[str, Any],
    type_map: Dict[str, Any],
    operation_type: str,
) -> Dict[str, Any]:
    """
    对照 param_type_map，自动修正可修正的类型偏差。
    不可修正的记录 warning，让 validator 拦截。
    """
    if not type_map:
        return params

    for key, value in list(params.items()):
        expected = type_map.get(key)
        if expected is None or expected is Any or expected == Any:
            continue

        # union 类型展开为元组
        types = expected if isinstance(expected, tuple) else (expected,)

        # 已满足任一期望类型 → 跳过
        if any(t is not Any and isinstance(value, t) for t in types):
            continue

        # ── list → 标量（声明 int/str/float 但上游输出了 list） ──
        if isinstance(value, list) and list not in types:
            if len(value) == 1:
                scalar = value[0]
                repaired = False
                for t in types:
                    if t is Any:
                        continue
                    try:
                        params[key] = t(scalar)
                        _normalizer_log.info(
                            f'[{operation_type}] 出口修正: {key} list[1] -> {t.__name__}({scalar})'
                        )
                        repaired = True
                        break
                    except (ValueError, TypeError):
                        continue
                if not repaired:
                    _normalizer_log.warning(
                        f'[{operation_type}] 出口不匹配: {key} 期望 {types} 实际 list({value})'
                    )
            else:
                _normalizer_log.warning(
                    f'[{operation_type}] 出口不匹配: {key} 期望 {types} 实际 list(len={len(value)})'
                )
            continue

        # ── str → int（声明 int 但实际纯数字字符串） ──
        if isinstance(value, str) and int in types:
            try:
                params[key] = int(float(value))
                _normalizer_log.info(
                    f'[{operation_type}] 出口修正: {key} str "{value}" -> int({params[key]})'
                )
                continue
            except (ValueError, TypeError):
                pass

        # ── str → float ──
        if isinstance(value, str) and float in types:
            try:
                params[key] = float(value)
                continue
            except (ValueError, TypeError):
                pass

        # ── int/float → str（声明 str 但实际数字） ──
        if isinstance(value, (int, float)) and str in types and int not in types and float not in types:
            params[key] = str(value)
            continue

        # 无法自动修正
        _normalizer_log.warning(
            f'[{operation_type}] 出口类型不匹配: {key} 期望 {types} '
            f'实际 {type(value).__name__}({repr(value)[:80]})'
        )

    return params
