# backend/app/agent/operation_validator.py
"""
操作参数验证模块
验证Agent生成的Excel操作参数的有效性

所有已知操作类型由 operation_registry 统一定义（单一真相源）。
本模块为纯验证器，不做任何参数变换 —— 职责单一。
"""
import json
import re
from typing import Any, Dict, List, Optional
from dataclasses import dataclass
from .operation_registry import (
    KNOWN_OPERATION_TYPES, READ_ONLY_OPERATIONS,
    resolve_operation_type, is_known_operation, get_required_params,
)
from ..utils.logger import get_logger

logger = get_logger('agent.validator')

# Excel限制常量
MAX_ROW = 1000000  # Excel最大行数
MAX_COL = 16384    # Excel最大列数（XFD）
MIN_ROW = 1
MIN_COL = 1


@dataclass
class ValidationResult:
    """验证结果"""
    is_valid: bool
    errors: List[str]
    
    def __bool__(self):
        return self.is_valid
    
    @classmethod
    def success(cls):
        return cls(is_valid=True, errors=[])
    
    @classmethod
    def failure(cls, *errors: str):
        return cls(is_valid=False, errors=list(errors))


def validate_sheet_exists(sheet_name: str, excel_state: Optional[Dict[str, Any]] = None) -> ValidationResult:
    """验证工作表是否存在"""
    if not sheet_name or not isinstance(sheet_name, str):
        return ValidationResult.failure(f"工作表名称无效: {sheet_name}")
    
    if excel_state:
        sheets = excel_state.get('sheets', [])
        sheet_names = [s.get('name') for s in sheets if isinstance(s, dict)]
        if sheet_name not in sheet_names:
            return ValidationResult.failure(
                f"工作表 '{sheet_name}' 不存在。可用工作表: {', '.join(sheet_names) if sheet_names else '无'}"
            )
    
    return ValidationResult.success()


def validate_row_number(row: Any) -> ValidationResult:
    """验证行号"""
    try:
        row_int = int(row) if not isinstance(row, int) else row
    except (ValueError, TypeError):
        return ValidationResult.failure(f"行号必须是整数，收到: {row} (类型: {type(row).__name__})")
    
    if row_int < MIN_ROW or row_int > MAX_ROW:
        return ValidationResult.failure(f"行号必须在 {MIN_ROW} 到 {MAX_ROW} 之间，收到: {row_int}")
    
    return ValidationResult.success()


def validate_col_number(col: Any) -> ValidationResult:
    """验证列号"""
    try:
        col_int = int(col) if not isinstance(col, int) else col
    except (ValueError, TypeError):
        return ValidationResult.failure(f"列号必须是整数，收到: {col} (类型: {type(col).__name__})")
    
    if col_int < MIN_COL or col_int > MAX_COL:
        return ValidationResult.failure(f"列号必须在 {MIN_COL} 到 {MAX_COL} 之间，收到: {col_int}")
    
    return ValidationResult.success()


def validate_cell_position(
    sheet: str, 
    row: Any, 
    col: Any, 
    excel_state: Optional[Dict[str, Any]] = None
) -> ValidationResult:
    """验证单元格位置"""
    errors = []
    
    # 验证工作表
    sheet_result = validate_sheet_exists(sheet, excel_state)
    if not sheet_result.is_valid:
        errors.extend(sheet_result.errors)
    
    # 验证行号
    row_result = validate_row_number(row)
    if not row_result.is_valid:
        errors.extend(row_result.errors)
    
    # 验证列号
    col_result = validate_col_number(col)
    if not col_result.is_valid:
        errors.extend(col_result.errors)
    
    if errors:
        return ValidationResult.failure(*errors)
    
    return ValidationResult.success()


def validate_range(
    sheet: str,
    start_row: Any,
    start_col: Any,
    end_row: Any,
    end_col: Any,
    excel_state: Optional[Dict[str, Any]] = None
) -> ValidationResult:
    """验证单元格范围"""
    errors = []
    
    # 验证工作表
    sheet_result = validate_sheet_exists(sheet, excel_state)
    if not sheet_result.is_valid:
        errors.extend(sheet_result.errors)
    
    # 验证并转换行号和列号
    try:
        start_row_int = int(start_row) if not isinstance(start_row, int) else start_row
        start_col_int = int(start_col) if not isinstance(start_col, int) else start_col
        end_row_int = int(end_row) if not isinstance(end_row, int) else end_row
        end_col_int = int(end_col) if not isinstance(end_col, int) else end_col
    except (ValueError, TypeError) as e:
        return ValidationResult.failure(f"范围参数类型错误: {e}")
    
    # 验证行号范围
    if start_row_int < MIN_ROW or start_row_int > MAX_ROW:
        errors.append(f"起始行号必须在 {MIN_ROW} 到 {MAX_ROW} 之间，收到: {start_row_int}")
    if end_row_int < MIN_ROW or end_row_int > MAX_ROW:
        errors.append(f"结束行号必须在 {MIN_ROW} 到 {MAX_ROW} 之间，收到: {end_row_int}")
    if start_row_int > end_row_int:
        errors.append(f"起始行号 ({start_row_int}) 不能大于结束行号 ({end_row_int})")
    
    # 验证列号范围
    if start_col_int < MIN_COL or start_col_int > MAX_COL:
        errors.append(f"起始列号必须在 {MIN_COL} 到 {MAX_COL} 之间，收到: {start_col_int}")
    if end_col_int < MIN_COL or end_col_int > MAX_COL:
        errors.append(f"结束列号必须在 {MIN_COL} 到 {MAX_COL} 之间，收到: {end_col_int}")
    if start_col_int > end_col_int:
        errors.append(f"起始列号 ({start_col_int}) 不能大于结束列号 ({end_col_int})")
    
    if errors:
        return ValidationResult.failure(*errors)
    
    return ValidationResult.success()


def validate_required_params(params: Dict[str, Any], required: List[str]) -> ValidationResult:
    """验证必需参数是否存在"""
    missing = [p for p in required if p not in params or params[p] is None]
    if missing:
        return ValidationResult.failure(f"缺少必需参数: {', '.join(missing)}")
    return ValidationResult.success()


def _normalize_param_value(param_value: Any, expected_type: type) -> Any:
    """
    规范化参数值
    如果参数是 JSON 字符串且期望类型是 dict 或 list，尝试解析它
    """
    if isinstance(param_value, str) and (expected_type == dict or expected_type == list):
        # 尝试解析 JSON 字符串
        if param_value.strip().startswith('{') or param_value.strip().startswith('['):
            try:
                parsed = json.loads(param_value)
                if isinstance(parsed, expected_type):
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass
    return param_value


def validate_param_type(param_value: Any, param_name: str, expected_type: type) -> ValidationResult:
    """验证参数类型"""
    # 先尝试规范化参数值（处理 JSON 字符串）
    normalized_value = _normalize_param_value(param_value, expected_type)
    
    if not isinstance(normalized_value, expected_type):
        return ValidationResult.failure(
            f"参数 '{param_name}' 类型错误: 期望 {expected_type.__name__}，收到 {type(param_value).__name__}"
        )
    return ValidationResult.success()


def validate_string_param(param_value: Any, param_name: str, min_length: int = 0, max_length: Optional[int] = None) -> ValidationResult:
    """验证字符串参数"""
    if not isinstance(param_value, str):
        return ValidationResult.failure(f"参数 '{param_name}' 必须是字符串，收到: {type(param_value).__name__}")
    
    if len(param_value) < min_length:
        return ValidationResult.failure(f"参数 '{param_name}' 长度不能小于 {min_length}")
    
    if max_length and len(param_value) > max_length:
        return ValidationResult.failure(f"参数 '{param_name}' 长度不能大于 {max_length}")
    
    return ValidationResult.success()


def validate_numeric_param(
    param_value: Any, 
    param_name: str, 
    min_value: Optional[float] = None, 
    max_value: Optional[float] = None
) -> ValidationResult:
    """验证数值参数"""
    try:
        num_value = float(param_value) if not isinstance(param_value, (int, float)) else param_value
    except (ValueError, TypeError):
        return ValidationResult.failure(f"参数 '{param_name}' 必须是数字，收到: {type(param_value).__name__}")
    
    if min_value is not None and num_value < min_value:
        return ValidationResult.failure(f"参数 '{param_name}' 不能小于 {min_value}，收到: {num_value}")
    
    if max_value is not None and num_value > max_value:
        return ValidationResult.failure(f"参数 '{param_name}' 不能大于 {max_value}，收到: {num_value}")
    
    return ValidationResult.success()


def validate_array_param(param_value: Any, param_name: str, min_length: int = 0) -> ValidationResult:
    """验证数组参数"""
    parse_error = None
    original_preview = None
    # 如果参数是 JSON 字符串，尝试解析
    if isinstance(param_value, str):
        value_str = param_value.strip()
        original_preview = value_str[:200]
        if value_str.startswith('['):
            try:
                parsed = json.loads(value_str)
                if isinstance(parsed, list):
                    param_value = parsed
            except (json.JSONDecodeError, ValueError):
                parse_error = "JSON 解析失败"
        # 如果不是 JSON 数组，但期望是数组，将单个字符串转换为数组
        elif value_str and not value_str.startswith('['):
            # 尝试按逗号分割（处理 "a,b,c" 格式）
            if ',' in value_str:
                param_value = [item.strip() for item in value_str.split(',') if item.strip()]
            else:
                # 单个值，转换为单元素数组
                param_value = [value_str]
    
    if not isinstance(param_value, list):
        if parse_error:
            return ValidationResult.failure(
                f"参数 '{param_name}' 必须是数组；检测到字符串但 {parse_error}。"
                f"请传入合法二维数组，例如 [[\"A\",1],[\"B\",2]]。"
                f"当前内容预览: {original_preview}"
            )
        return ValidationResult.failure(f"参数 '{param_name}' 必须是数组，收到: {type(param_value).__name__}")
    
    if len(param_value) < min_length:
        return ValidationResult.failure(f"参数 '{param_name}' 数组长度不能小于 {min_length}")
    
    return ValidationResult.success()


def validate_cell_exists_in_sheet(
    sheet_name: str,
    row: int,
    col: int,
    excel_state: Optional[Dict[str, Any]] = None
) -> ValidationResult:
    """验证单元格是否在工作表的有效范围内（可选验证）"""
    if not excel_state:
        return ValidationResult.success()
    
    sheets = excel_state.get('sheets', [])
    sheet = next((s for s in sheets if s.get('name') == sheet_name), None)
    
    if not sheet:
        return ValidationResult.success()  # 工作表不存在已在其他地方验证
    
    # 检查行号是否在合理范围内（基于工作表数据）
    max_row = sheet.get('lastRow', MAX_ROW)
    if row > max_row + 100:  # 允许超出当前数据范围100行（用于追加数据）
        return ValidationResult.failure(
            f"行号 {row} 超出工作表 '{sheet_name}' 的有效范围（当前最大行: {max_row}）"
        )
    
    return ValidationResult.success()


def validate_range_in_sheet(
    sheet_name: str,
    start_row: int,
    start_col: int,
    end_row: int,
    end_col: int,
    excel_state: Optional[Dict[str, Any]] = None
) -> ValidationResult:
    """验证范围是否在工作表的有效范围内（可选验证）"""
    if not excel_state:
        return ValidationResult.success()
    
    sheets = excel_state.get('sheets', [])
    sheet = next((s for s in sheets if s.get('name') == sheet_name), None)
    
    if not sheet:
        return ValidationResult.success()  # 工作表不存在已在其他地方验证
    
    max_row = sheet.get('lastRow', MAX_ROW)
    # 如果 colCount 为 0 或不存在，尝试从 headers 计算，否则使用默认值
    col_count = sheet.get('colCount', 0)
    if col_count == 0:
        # 尝试从 headers 获取列数
        headers = sheet.get('headers', [])
        if headers:
            col_count = len(headers)
        else:
            # 如果 headers 也不存在，使用默认值（允许较大的列数）
            col_count = MAX_COL
    
    max_col = col_count if col_count > 0 else MAX_COL
    
    if end_row > max_row + 100:  # 允许超出当前数据范围100行
        return ValidationResult.failure(
            f"结束行号 {end_row} 超出工作表 '{sheet_name}' 的有效范围（当前最大行: {max_row}）"
        )
    
    # 允许超出当前列数，因为用户可能正在设置样式到新列
    # 但如果超出太多（比如超过100列），则可能是错误
    if end_col > max_col + 100:
        return ValidationResult.failure(
            f"结束列号 {end_col} 超出工作表 '{sheet_name}' 的有效范围（当前最大列: {max_col}）"
        )
    
    return ValidationResult.success()


def _get_sheet_headers(excel_state: Optional[Dict[str, Any]], sheet_name: str) -> List[str]:
    """从 excel_state 提取工作表表头（若可用）"""
    if not excel_state:
        return []
    sheets = excel_state.get('sheets', [])
    sheet = next((s for s in sheets if s.get('name') == sheet_name), None)
    if not sheet:
        return []
    headers = sheet.get('headers', [])
    if not isinstance(headers, list):
        return []
    return [str(h) for h in headers]


def _to_number(value: Any) -> Optional[float]:
    """尽量把单元格值解析为数值；失败返回 None。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        try:
            n = float(value)
            return n if n == n and abs(n) != float('inf') else None
        except Exception:
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    text = text.replace(',', '')
    text = re.sub(r'^[¥￥$€£\s]+', '', text)
    percent = text.endswith('%')
    if percent:
        text = text[:-1].strip()
    try:
        n = float(text)
        return n / 100.0 if percent else n
    except ValueError:
        return None


def _extract_col_values_from_sample(
    excel_state: Optional[Dict[str, Any]],
    sheet_name: str,
    col_idx: int,
    start_row: int,
    end_row: int,
) -> List[Any]:
    """从 excel_state.sampleData 提取列样本值（最佳努力）。"""
    if not excel_state or col_idx < 1:
        return []
    sheets = excel_state.get('sheets', [])
    sheet = next((s for s in sheets if s.get('name') == sheet_name), None)
    if not sheet:
        return []
    sample_data = sheet.get('sampleData', [])
    if not isinstance(sample_data, list) or not sample_data:
        return []

    data_start_row = int(sheet.get('dataStartRow') or 2)
    start_offset = max(0, int(start_row) - data_start_row)
    end_offset = max(start_offset, int(end_row) - data_start_row)
    rows = sample_data[start_offset:end_offset + 1] if start_offset < len(sample_data) else []
    headers = _get_sheet_headers(excel_state, sheet_name)
    header_name = headers[col_idx - 1] if 0 <= col_idx - 1 < len(headers) else None

    values: List[Any] = []
    for row in rows:
        value = None
        parsed_row = row
        if isinstance(row, str):
            text = row.strip()
            if text.startswith('{') or text.startswith('['):
                try:
                    parsed_row = json.loads(text)
                except Exception:
                    parsed_row = row

        if isinstance(parsed_row, (list, tuple)):
            idx = col_idx - 1
            if 0 <= idx < len(parsed_row):
                value = parsed_row[idx]
        elif isinstance(parsed_row, dict):
            if header_name and header_name in parsed_row:
                value = parsed_row.get(header_name)
            elif str(col_idx) in parsed_row:
                value = parsed_row.get(str(col_idx))
            elif col_idx in parsed_row:
                value = parsed_row.get(col_idx)
        if value is not None and str(value).strip() != '':
            values.append(value)
    return values


def _validate_sum_col_metric_suitability(
    sheet_name: str,
    sum_col: Any,
    start_row: Any,
    end_row: Any,
    excel_state: Optional[Dict[str, Any]] = None
) -> ValidationResult:
    """校验 sum_col 是否适合作为可聚合数值指标（不依赖列名硬编码）。"""
    try:
        sum_col_int = int(sum_col)
        start_row_int = int(start_row)
        end_row_int = int(end_row)
    except (ValueError, TypeError):
        return ValidationResult.success()

    values = _extract_col_values_from_sample(
        excel_state, sheet_name, sum_col_int, start_row_int, end_row_int
    )
    non_empty_count = len(values)
    if non_empty_count < 8:
        return ValidationResult.success()

    numeric_count = sum(1 for v in values if _to_number(v) is not None)
    numeric_ratio = numeric_count / non_empty_count if non_empty_count else 0.0
    distinct_ratio = (
        len({str(v).strip() for v in values if str(v).strip() != ''}) / non_empty_count
        if non_empty_count else 0.0
    )

    # 通用规则：sum/avg 指标列必须有较高数值密度；高唯一且低数值密度常见于标识列
    if numeric_ratio < 0.35:
        if distinct_ratio > 0.85 and non_empty_count >= 10:
            return ValidationResult.failure(
                f"sumCol 列（第{sum_col_int}列）值分布显示为高唯一低数值密度（数值占比 {numeric_ratio:.0%}，唯一占比 {distinct_ratio:.0%}），"
                f"不适合作为总和/平均指标。请改用业务数值列，或改为仅输出记录数统计。"
            )
        return ValidationResult.failure(
            f"sumCol 列（第{sum_col_int}列）数值密度不足（数值占比 {numeric_ratio:.0%}），"
            f"不适合作为总和/平均指标。请改用业务数值列，或改为仅输出记录数统计。"
        )
    return ValidationResult.success()


    # ------------------------------------------------------------------
    # 注意：snake_case -> camelCase 转换已由 param_normalizer 在上游完成。
    # 本模块为纯验证器，不做任何规范化——职责单一。
    # ------------------------------------------------------------------


def validate_operation_params(
    operation_type: str,
    params: Dict[str, Any],
    excel_state: Optional[Dict[str, Any]] = None
) -> ValidationResult:
    """
    根据操作类型验证参数
    
    Args:
        operation_type: 操作类型
        params: 操作参数
        excel_state: Excel状态上下文
    
    Returns:
        ValidationResult: 验证结果
    """
    # 参数已由 param_normalizer 在上游完成规范化（camelCase + 类型修正）
    # 此处直接验证，不做任何变换
    errors = []

    # ── 注册表门控：别名解析 + 白名单拦截 ──
    operation_type = resolve_operation_type(operation_type)
    if operation_type in READ_ONLY_OPERATIONS:
        return ValidationResult.success()
    if not is_known_operation(operation_type):
        return ValidationResult.failure(f"未知操作类型: {operation_type}")

    # 根据操作类型进行详细验证（命中 registry 的类型才会到达此处）
    if operation_type == 'set_cell_value':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'value'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            else:
                # 额外的上下文验证：检查单元格是否在合理范围内
                result = validate_cell_exists_in_sheet(
                    params['sheet'], params['row'], params['col'], excel_state
                )
                if not result.is_valid:
                    errors.extend(result.errors)
    
    elif operation_type == 'set_cell_formula':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'formula'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_string_param(params.get('formula', ''), 'formula', min_length=1)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'set_cell_style':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'style'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_param_type(params.get('style'), 'style', dict)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'set_range_values':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'values'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['startRow'], params['startCol'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_array_param(params.get('values'), 'values')
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'set_range_style':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'style'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            else:
                # 额外的上下文验证：检查范围是否在合理范围内
                result = validate_range_in_sheet(
                    params['sheet'],
                    params['startRow'],
                    params['startCol'],
                    params['endRow'],
                    params['endCol'],
                    excel_state
                )
                if not result.is_valid:
                    errors.extend(result.errors)
            result = validate_param_type(params.get('style'), 'style', dict)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'merge_cells':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type in ['insert_row', 'delete_row']:
        result = validate_required_params(params, ['sheet', 'row'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['row'])
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type in ['insert_column', 'delete_column']:
        result = validate_required_params(params, ['sheet', 'col'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['col'])
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'set_row_height':
        result = validate_required_params(params, ['sheet', 'row', 'height'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['row'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_numeric_param(params.get('height'), 'height', min_value=0)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'set_column_width':
        result = validate_required_params(params, ['sheet', 'col', 'width'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['col'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_numeric_param(params.get('width'), 'width', min_value=0)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type in ['hide_row', 'show_row']:
        result = validate_required_params(params, ['sheet', 'startRow', 'endRow'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['startRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['endRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            if params.get('startRow', 0) > params.get('endRow', 0):
                errors.append(f"起始行号不能大于结束行号")
    
    elif operation_type in ['hide_column', 'show_column']:
        result = validate_required_params(params, ['sheet', 'startCol', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['startCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['endCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            if params.get('startCol', 0) > params.get('endCol', 0):
                errors.append(f"起始列号不能大于结束列号")
    
    elif operation_type == 'add_sheet':
        result = validate_required_params(params, ['name'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_string_param(params.get('name'), 'name', min_length=1, max_length=31)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'rename_sheet':
        result = validate_required_params(params, ['oldName', 'newName'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_string_param(params.get('oldName'), 'oldName', min_length=1)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_string_param(params.get('newName'), 'newName', min_length=1, max_length=31)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'set_active_sheet':
        result = validate_required_params(params, ['name'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            # 验证工作表名称格式，但不验证工作表是否存在
            # 因为 set_active_sheet 可能在 add_sheet 之后立即调用，此时工作表可能还未更新到 excel_state
            result = validate_string_param(params.get('name'), 'name', min_length=1, max_length=31)
            if not result.is_valid:
                errors.extend(result.errors)
            # 注意：不验证工作表是否存在，允许在 add_sheet 之后立即设置活动工作表
    
    elif operation_type == 'sort_range':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
        
        # 验证 sortColumns 参数
        sort_columns = params.get('sortColumns', [])
        if not sort_columns:
            errors.append("sortColumns 参数不能为空，必须指定至少一个排序列")
        elif not isinstance(sort_columns, list):
            errors.append(f"sortColumns 必须是数组，收到类型: {type(sort_columns)}")
        else:
            for idx, item in enumerate(sort_columns):
                if not isinstance(item, dict):
                    errors.append(f"sortColumns[{idx}] 必须是对象，收到类型: {type(item)}")
                else:
                    # 检查 column 字段
                    col = item.get('column') or item.get('columnIndex') or item.get('col')
                    if col is None:
                        errors.append(f"sortColumns[{idx}] 缺少 column 字段")
                    elif not isinstance(col, (int, float)):
                        errors.append(f"sortColumns[{idx}].column 必须是数字，收到: {col} (类型: {type(col)})")
                    
                    # 检查 order 字段
                    order = item.get('order', 'asc')
                    if order not in ('asc', 'desc', 'ascending', 'descending'):
                        errors.append(f"sortColumns[{idx}].order 必须是 'asc' 或 'desc'，收到: {order}")
    
    elif operation_type == 'create_chart':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'chartType', 'dataRange'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            chart_type = str(params.get('chartType', '')).strip().lower()
            valid_chart_types = {'column', 'line', 'pie', 'bar', 'area', 'scatter', 'doughnut', 'donut'}
            if chart_type not in valid_chart_types:
                errors.append(
                    f"chartType 必须是 {sorted(valid_chart_types)} 之一，收到: {params.get('chartType')}"
                )

            data_range = params.get('dataRange')
            if not data_range:
                errors.append("dataRange 参数不能为空")
            elif isinstance(data_range, str):
                if ':' not in data_range:
                    errors.append(f"dataRange 范围格式无效，收到: {data_range}")
            elif isinstance(data_range, dict):
                # 支持两种结构：
                # 1) {start:{row,col}, end:{row,col}}
                # 2) {startRow,startCol,endRow,endCol}
                if 'start' in data_range and 'end' in data_range:
                    start = data_range.get('start') or {}
                    end = data_range.get('end') or {}
                    need_keys = {'row', 'col'}
                    if not isinstance(start, dict) or not isinstance(end, dict):
                        errors.append("dataRange.start/end 必须是对象")
                    elif not need_keys.issubset(start.keys()) or not need_keys.issubset(end.keys()):
                        errors.append("dataRange.start/end 必须包含 row 与 col")
                else:
                    flat_keys = {'startRow', 'startCol', 'endRow', 'endCol'}
                    if not flat_keys.issubset(data_range.keys()):
                        errors.append("dataRange 对象必须包含 startRow/startCol/endRow/endCol")
            else:
                errors.append(f"dataRange 必须是字符串或对象，收到类型: {type(data_range)}")
    
    elif operation_type == 'create_pivot_table':
        result = validate_required_params(params, ['sheet', 'sourceRange', 'rowFields', 'valueFields'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # sourceRange 可以是字符串或对象，只验证存在性
            if 'sourceRange' not in params or not params['sourceRange']:
                errors.append("sourceRange 参数不能为空")
            result = validate_array_param(params.get('rowFields'), 'rowFields', min_length=1)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_array_param(params.get('valueFields'), 'valueFields', min_length=1)
            if not result.is_valid:
                errors.extend(result.errors)
            # colFields 是可选的
            if 'colFields' in params and params['colFields']:
                result = validate_array_param(params.get('colFields'), 'colFields')
                if not result.is_valid:
                    errors.extend(result.errors)
    
    elif operation_type == 'filter_data':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'conditions'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 conditions 参数结构
            conditions = params.get('conditions', {})
            if not isinstance(conditions, dict):
                errors.append(f"conditions 必须是对象，收到类型: {type(conditions)}")
            elif not conditions:
                errors.append("conditions 不能为空，必须指定至少一个筛选条件")
            else:
                for col_key, condition in conditions.items():
                    if not isinstance(condition, dict):
                        errors.append(f"conditions['{col_key}'] 必须是对象，收到类型: {type(condition)}")
                    else:
                        # 验证条件结构（operator 和 value）
                        if 'operator' not in condition and 'value' not in condition:
                            errors.append(f"conditions['{col_key}'] 必须包含 operator 或 value 字段")
    
    elif operation_type == 'remove_duplicates':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 columns 参数（可选，但如果提供必须是数组）
            columns = params.get('columns')
            if columns is not None:
                if not isinstance(columns, list):
                    errors.append(f"columns 必须是数组，收到类型: {type(columns)}")
                elif len(columns) == 0:
                    errors.append("columns 数组不能为空")
                else:
                    for idx, col in enumerate(columns):
                        if not isinstance(col, (int, str)):
                            errors.append(f"columns[{idx}] 必须是数字或字符串，收到类型: {type(col)}")
    
    elif operation_type == 'conditional_format':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'ruleType'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 ruleType（白名单必须与前端 _CF_SUPPORTED_TYPES 及工具层 _SUPPORTED_RULE_TYPES 严格对齐）
            rule_type = params.get('ruleType', '')
            _CF_VALID_RULE_TYPES = frozenset({
                'greaterThan', 'lessThan', 'between',
                'equal', 'text', 'textEquals',
                'containsText', 'notContainsText', 'beginsWith', 'endsWith',
                'duplicate', 'duplicateValues', 'uniqueValues',
                'top10', 'bottom10',
                'greaterThanAverage', 'aboveAverage', 'belowAverage',
                'colorScale',
            })
            if not rule_type:
                errors.append("ruleType 不能为空")
            elif rule_type not in _CF_VALID_RULE_TYPES:
                errors.append(
                    f"不支持的条件格式规则类型: '{rule_type}'。"
                    f"系统支持的类型: {', '.join(sorted(_CF_VALID_RULE_TYPES))}"
                )
            # 验证 ruleParams（可选）
            rule_params = params.get('ruleParams')
            if rule_params is not None and not isinstance(rule_params, dict):
                errors.append(f"ruleParams 必须是对象，收到类型: {type(rule_params)}")
            # 验证 formatStyle（可选）
            format_style = params.get('formatStyle')
            if format_style is not None and not isinstance(format_style, dict):
                errors.append(f"formatStyle 必须是对象，收到类型: {type(format_style)}")
    
    elif operation_type == 'set_data_validation':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'validationType'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 validationType
            validation_type = params.get('validationType', '')
            valid_types = ['list', 'whole', 'decimal', 'date', 'time', 'textLength', 'custom']
            if validation_type and validation_type not in valid_types:
                errors.append(f"validationType 必须是以下之一: {valid_types}，收到: {validation_type}")
            # 验证 validationParams（必需）
            validation_params = params.get('validationParams')
            if validation_params is None:
                errors.append("validationParams 参数不能为空")
            elif not isinstance(validation_params, dict):
                errors.append(f"validationParams 必须是对象，收到类型: {type(validation_params)}")
    
    elif operation_type == 'fill_series':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 direction
            direction = params.get('direction', 'down')
            valid_directions = ['down', 'up', 'right', 'left']
            if direction not in valid_directions:
                errors.append(f"direction 必须是以下之一: {valid_directions}，收到: {direction}")
            # 验证 seriesType
            series_type = params.get('seriesType', 'linear')
            valid_series_types = ['linear', 'growth', 'date', 'autofill']
            if series_type not in valid_series_types:
                errors.append(f"seriesType 必须是以下之一: {valid_series_types}，收到: {series_type}")
            # 验证 step（可选，必须是数字）
            step = params.get('step')
            if step is not None and not isinstance(step, (int, float)):
                errors.append(f"step 必须是数字，收到类型: {type(step)}")
    
    elif operation_type == 'batch_operations':
        operations = params.get('operations', [])
        if not isinstance(operations, list):
            errors.append(f"operations 必须是数组，收到类型: {type(operations)}")
        elif len(operations) == 0:
            errors.append("operations 数组不能为空")
        else:
            # 递归验证每个子操作
            for idx, op in enumerate(operations):
                if not isinstance(op, dict):
                    errors.append(f"operations[{idx}] 必须是对象，收到类型: {type(op)}")
                elif 'type' not in op:
                    errors.append(f"operations[{idx}] 缺少 type 字段")
                elif 'params' not in op:
                    errors.append(f"operations[{idx}] 缺少 params 字段")
                else:
                    # 递归验证子操作（限制递归深度，避免无限递归）
                    sub_result = validate_operation_params(op['type'], op['params'], excel_state)
                    if not sub_result.is_valid:
                        for err in sub_result.errors:
                            errors.append(f"operations[{idx}].{err}")
    
    elif operation_type == 'create_pivot_data':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'rowFields', 'valueField'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['startCol'],
                params['endRow'],
                params['endCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 rowFields
            result = validate_array_param(params.get('rowFields'), 'rowFields', min_length=1)
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证 colFields（可选）
            if 'colFields' in params and params['colFields']:
                result = validate_array_param(params.get('colFields'), 'colFields')
                if not result.is_valid:
                    errors.extend(result.errors)
            # 验证 valueField（必须是数字或字符串）
            value_field = params.get('valueField')
            if value_field is not None and not isinstance(value_field, (int, str)):
                errors.append(f"valueField 必须是数字或字符串，收到类型: {type(value_field)}")
            # 验证 aggregateFunction（可选）
            agg_func = params.get('aggregateFunction', 'sum')
            valid_agg_funcs = ['sum', 'count', 'average', 'max', 'min', 'product', 'stdev', 'var']
            if agg_func not in valid_agg_funcs:
                errors.append(f"aggregateFunction 必须是以下之一: {valid_agg_funcs}，收到: {agg_func}")
    
    elif operation_type == 'update_chart':
        result = validate_required_params(params, ['sheet', 'chartId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # chartId 必须是字符串
            chart_id = params.get('chartId')
            if not isinstance(chart_id, str) or not chart_id:
                errors.append("chartId 必须是非空字符串")
            # dataRange（可选，但如果提供必须有效）
            data_range = params.get('dataRange')
            if data_range is not None:
                if not isinstance(data_range, (str, dict)):
                    errors.append(f"dataRange 必须是字符串或对象，收到类型: {type(data_range)}")
            # style（可选）
            style = params.get('style')
            if style is not None and not isinstance(style, dict):
                errors.append(f"style 必须是对象，收到类型: {type(style)}")
    
    elif operation_type == 'update_pivot_table':
        result = validate_required_params(params, ['sheet', 'pivotTableId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # pivotTableId 必须是字符串
            pivot_id = params.get('pivotTableId')
            if not isinstance(pivot_id, str) or not pivot_id:
                errors.append("pivotTableId 必须是非空字符串")
            # rowFields（可选）
            if 'rowFields' in params and params['rowFields']:
                result = validate_array_param(params.get('rowFields'), 'rowFields')
                if not result.is_valid:
                    errors.extend(result.errors)
            # colFields（可选）
            if 'colFields' in params and params['colFields']:
                result = validate_array_param(params.get('colFields'), 'colFields')
                if not result.is_valid:
                    errors.extend(result.errors)
            # valueFields（可选）
            if 'valueFields' in params and params['valueFields']:
                result = validate_array_param(params.get('valueFields'), 'valueFields')
                if not result.is_valid:
                    errors.extend(result.errors)
    
    # ============ 中等风险工具验证 ============
    
    elif operation_type == 'clear_cell':
        result = validate_required_params(params, ['sheet', 'row', 'col'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'clear_range':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'], params['startRow'], params['startCol'],
                params['endRow'], params['endCol'], excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'unmerge_cells':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'], params['startRow'], params['startCol'],
                params['endRow'], params['endCol'], excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'copy_sheet':
        result = validate_required_params(params, ['sourceName', 'newName'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            # 验证源工作表存在
            result = validate_sheet_exists(params['sourceName'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证新名称有效
            result = validate_string_param(params.get('newName'), 'newName', min_length=1, max_length=31)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'remove_filter':
        result = validate_required_params(params, ['sheet'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'find_replace':
        result = validate_required_params(params, ['sheet', 'find', 'replace'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # find 和 replace 必须是字符串
            if not isinstance(params.get('find'), str):
                errors.append(f"find 必须是字符串，收到类型: {type(params.get('find'))}")
            if not isinstance(params.get('replace'), str):
                errors.append(f"replace 必须是字符串，收到类型: {type(params.get('replace'))}")
    
    elif operation_type == 'copy_paste':
        result = validate_required_params(params, ['sheet', 'sourceStartRow', 'sourceStartCol', 
                                                   'sourceEndRow', 'sourceEndCol', 'targetRow', 'targetCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证源范围
            result = validate_range(
                params['sheet'], params['sourceStartRow'], params['sourceStartCol'],
                params['sourceEndRow'], params['sourceEndCol'], excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 验证目标位置
            result = validate_row_number(params['targetRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['targetCol'])
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type in ('clear_formatting', 'clear_conditional_format'):
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'], params['startRow'], params['startCol'],
                params['endRow'], params['endCol'], excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'calculate_statistics':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'], params['startRow'], params['startCol'],
                params['endRow'], params['endCol'], excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            # 数据保护：outputRow 禁止落入源数据区域
            output_row = params.get('outputRow')
            start_row = params.get('startRow', 1)
            end_row = params.get('endRow', 1)
            if output_row is not None and start_row <= output_row <= end_row:
                logger.warning(
                    "calculate_statistics outputRow=%s 落入数据区(%s~%s)，自动修正为 endRow+2",
                    output_row, start_row, end_row,
                )
                params['outputRow'] = end_row + 2
    
    elif operation_type == 'summarize_by_column':
        result = validate_required_params(params, ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['startRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['endRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['groupByCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['sumCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            else:
                result = _validate_sum_col_metric_suitability(
                    params['sheet'], params['sumCol'], params['startRow'], params['endRow'], excel_state
                )
                if not result.is_valid:
                    errors.extend(result.errors)
    
    elif operation_type == 'summarize_metrics_by_column':
        result = validate_required_params(params, ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['startRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_row_number(params['endRow'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['groupByCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['sumCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            else:
                result = _validate_sum_col_metric_suitability(
                    params['sheet'], params['sumCol'], params['startRow'], params['endRow'], excel_state
                )
                if not result.is_valid:
                    # summarize_metrics_by_column 允许执行期自动降级为“记录数统计”（count-only），
                    # 不在验证阶段硬拦截，避免全链路被致命错误中断。
                    logger.warning(
                        "summarize_metrics_by_column sumCol 不适合作为聚合指标，将在执行期降级 count-only: %s",
                        "; ".join(result.errors),
                    )
    
    elif operation_type == 'remove_data_validation':
        result = validate_required_params(params, ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_range(
                params['sheet'], params['startRow'], params['startCol'],
                params['endRow'], params['endCol'], excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'add_comment':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'comment'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('comment'), str):
                errors.append(f"comment 必须是字符串，收到类型: {type(params.get('comment'))}")
    
    elif operation_type == 'delete_comment':
        result = validate_required_params(params, ['sheet', 'row', 'col'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'update_comment':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'comment'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('comment'), str):
                errors.append(f"comment 必须是字符串，收到类型: {type(params.get('comment'))}")
    
    elif operation_type == 'set_hyperlink':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'url'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('url'), str) or not params.get('url'):
                errors.append("url 必须是非空字符串")
    
    elif operation_type == 'remove_hyperlink':
        result = validate_required_params(params, ['sheet', 'row', 'col'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'insert_image':
        result = validate_required_params(params, ['sheet', 'row', 'col', 'imageUrl'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('imageUrl'), str) or not params.get('imageUrl'):
                errors.append("imageUrl 必须是非空字符串")
    
    elif operation_type == 'delete_image':
        result = validate_required_params(params, ['sheet', 'imageId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('imageId'), str) or not params.get('imageId'):
                errors.append("imageId 必须是非空字符串")
    
    elif operation_type == 'update_image':
        result = validate_required_params(params, ['sheet', 'imageId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('imageId'), str) or not params.get('imageId'):
                errors.append("imageId 必须是非空字符串")
    
    elif operation_type == 'insert_shape':
        result = validate_required_params(params, ['sheet', 'shapeType', 'row', 'col'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_cell_position(params['sheet'], params['row'], params['col'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('shapeType'), str) or not params.get('shapeType'):
                errors.append("shapeType 必须是非空字符串")
    
    elif operation_type == 'delete_shape':
        result = validate_required_params(params, ['sheet', 'shapeId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('shapeId'), str) or not params.get('shapeId'):
                errors.append("shapeId 必须是非空字符串")
    
    elif operation_type == 'update_shape':
        result = validate_required_params(params, ['sheet', 'shapeId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('shapeId'), str) or not params.get('shapeId'):
                errors.append("shapeId 必须是非空字符串")
    
    elif operation_type == 'delete_chart':
        result = validate_required_params(params, ['sheet', 'chartId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('chartId'), str) or not params.get('chartId'):
                errors.append("chartId 必须是非空字符串")
    
    elif operation_type == 'delete_pivot_table':
        result = validate_required_params(params, ['sheet', 'pivotTableId'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            if not isinstance(params.get('pivotTableId'), str) or not params.get('pivotTableId'):
                errors.append("pivotTableId 必须是非空字符串")
    
    elif operation_type == 'query_unique_values':
        result = validate_required_params(params, ['sheet', 'column'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['column'])
            if not result.is_valid:
                errors.extend(result.errors)
    
    elif operation_type == 'auto_fit_column':
        result = validate_required_params(params, ['sheet', 'col'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            result = validate_col_number(params['col'])
            if not result.is_valid:
                errors.extend(result.errors)

    elif operation_type == 'apply_custom_formula':
        result = validate_required_params(params, ['sheet', 'targetCol', 'startRow', 'endRow', 'expression'])
        if not result.is_valid:
            errors.extend(result.errors)
        else:
            result = validate_sheet_exists(params['sheet'], excel_state)
            if not result.is_valid:
                errors.extend(result.errors)
            # 目标列号
            result = validate_col_number(params['targetCol'])
            if not result.is_valid:
                errors.extend(result.errors)
            # 行范围（单列范围）
            result = validate_range(
                params['sheet'],
                params['startRow'],
                params['targetCol'],
                params['endRow'],
                params['targetCol'],
                excel_state
            )
            if not result.is_valid:
                errors.extend(result.errors)
            expr = params.get('expression')
            if not isinstance(expr, str) or not expr.strip():
                errors.append("expression 必须是非空字符串")
            formula_params = params.get('formulaParams')
            if formula_params is not None and not isinstance(formula_params, dict):
                errors.append(f"formulaParams 必须是对象，收到类型: {type(formula_params)}")
    
    # 已注册但没有专用验证分支的操作：用注册表必填参数做通用验证
    else:
        required = get_required_params(operation_type)
        if required:
            result = validate_required_params(params, required)
            if not result.is_valid:
                errors.extend(result.errors)
            elif 'sheet' in params:
                result = validate_sheet_exists(params['sheet'], excel_state)
                if not result.is_valid:
                    errors.extend(result.errors)
    
    if errors:
        error_msg = f"操作 '{operation_type}' 参数验证失败:\n" + "\n".join(f"  - {e}" for e in errors)
        logger.warning(error_msg)
        return ValidationResult.failure(*errors)
    
    return ValidationResult.success()
