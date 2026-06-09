# backend/app/agent/date_normalizer.py
"""
日期格式规范化模块
确保前后端日期格式一致
"""
import re
from datetime import datetime
from typing import Any, Optional


# 支持的日期格式模式
DATE_FORMAT_PATTERNS = [
    # ISO 格式
    (r'^\d{4}-\d{2}-\d{2}$', '%Y-%m-%d'),  # YYYY-MM-DD
    (r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', '%Y-%m-%dT%H:%M:%S'),  # ISO datetime
    # 中文格式
    (r'^\d{4}年\d{1,2}月\d{1,2}日$', '%Y年%m月%d日'),
    (r'^\d{4}/\d{1,2}/\d{1,2}$', '%Y/%m/%d'),  # YYYY/MM/DD
    (r'^\d{1,2}/\d{1,2}/\d{4}$', '%m/%d/%Y'),  # MM/DD/YYYY
    (r'^\d{4}\.\d{1,2}\.\d{1,2}$', '%Y.%m.%d'),  # YYYY.MM.DD
    # Excel 日期序列号（从1900-01-01开始的天数）
    (r'^\d+\.\d+$', None),  # 可能是 Excel 序列号
]


def normalize_date_value(value: Any) -> Any:
    """
    规范化日期值
    
    Args:
        value: 日期值（可能是字符串、数字、datetime对象等）
    
    Returns:
        规范化后的日期字符串（YYYY-MM-DD格式）或原值（如果不是日期）
    """
    if value is None:
        return value
    
    # 如果已经是标准格式的字符串，直接返回
    if isinstance(value, str):
        value_str = value.strip()
        looks_like_date = bool(re.search(r'\d', value_str)) and any(
            sep in value_str for sep in ('-', '/', '.', '年', '月', '日', 'T', ':')
        )
        # 纯数字字符串（如价格/库存/ID）不做日期推断，避免 7999 -> 7999-02-26
        if not looks_like_date:
            return value

        # 检查是否是标准 ISO 日期格式
        if re.match(r'^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?', value_str):
            # 提取日期部分（去掉时间部分）
            date_part = value_str.split('T')[0]
            return date_part
        
        # 尝试解析各种日期格式
        for pattern, date_format in DATE_FORMAT_PATTERNS:
            if date_format and re.match(pattern, value_str):
                try:
                    dt = datetime.strptime(value_str, date_format)
                    return dt.strftime('%Y-%m-%d')
                except ValueError:
                    continue
        
        # 尝试使用 Python 的 dateutil（如果可用）
        try:
            from dateutil import parser
            dt = parser.parse(value_str)
            return dt.strftime('%Y-%m-%d')
        except (ImportError, ValueError, TypeError):
            pass
    
    # 如果是数字，可能是 Excel 日期序列号
    elif isinstance(value, (int, float)):
        # Excel 日期序列号：从 1900-01-01 开始的天数
        # 但这里我们不确定，所以保持原值
        # 前端会处理 Excel 序列号
        return value
    
    # 如果是 datetime 对象
    elif isinstance(value, datetime):
        return value.strftime('%Y-%m-%d')
    
    # 其他类型，返回原值
    return value


def normalize_date_range(value: Any) -> Optional[dict]:
    """
    规范化日期范围
    
    Args:
        value: 日期范围值（可能是字符串、dict等）
    
    Returns:
        规范化后的日期范围字典，格式：{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
    """
    if value is None:
        return None
    
    if isinstance(value, dict):
        normalized = {}
        if 'start' in value:
            normalized['start'] = normalize_date_value(value['start'])
        if 'end' in value:
            normalized['end'] = normalize_date_value(value['end'])
        if 'min' in value:
            normalized['start'] = normalize_date_value(value['min'])
        if 'max' in value:
            normalized['end'] = normalize_date_value(value['max'])
        return normalized if normalized else None
    
    if isinstance(value, str):
        # 尝试解析日期范围字符串（如 "2024-01-01 to 2024-12-31"）
        range_match = re.match(r'(.+?)\s+(?:to|-|~)\s+(.+)$', value.strip())
        if range_match:
            start_str = range_match.group(1).strip()
            end_str = range_match.group(2).strip()
            return {
                'start': normalize_date_value(start_str),
                'end': normalize_date_value(end_str)
            }
    
    return None


def normalize_validation_params(validation_type: str, validation_params: dict) -> dict:
    """
    规范化数据验证参数中的日期
    
    Args:
        validation_type: 验证类型（如 "date"）
        validation_params: 验证参数字典
    
    Returns:
        规范化后的验证参数字典
    """
    if validation_type != 'date':
        return validation_params
    
    normalized = validation_params.copy()
    
    # 处理日期范围
    if 'min' in normalized:
        normalized['min'] = normalize_date_value(normalized['min'])
    if 'max' in normalized:
        normalized['max'] = normalize_date_value(normalized['max'])
    if 'start' in normalized:
        normalized['start'] = normalize_date_value(normalized['start'])
    if 'end' in normalized:
        normalized['end'] = normalize_date_value(normalized['end'])
    
    # 处理日期范围对象
    if 'range' in normalized:
        normalized['range'] = normalize_date_range(normalized['range'])
    
    return normalized
