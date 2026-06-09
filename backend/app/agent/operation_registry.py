# backend/app/agent/operation_registry.py
"""
操作注册表 —— 单一真相源

所有前端可执行的操作类型、必填参数、别名映射统一在此定义。
后端验证器 (operation_validator) 与参数规范化器 (param_normalizer)
均从本模块获取白名单与元数据，杜绝"前后端操作列表不同步"。
"""
from typing import Dict, FrozenSet, List, Optional

# =====================================================================
#  操作 Schema 注册表
#  键 = 前端 executeOperation switch/case 中的规范 snake_case 名称
#  required = 验证器必须检查的参数列表（camelCase，已规范化后的形态）
# =====================================================================
OPERATION_SCHEMAS: Dict[str, Dict[str, List[str]]] = {
    # ── Cell ──
    'set_cell_value':    {'required': ['sheet', 'row', 'col', 'value']},
    'set_cell_formula':  {'required': ['sheet', 'row', 'col', 'formula']},
    'set_cell_style':    {'required': ['sheet', 'row', 'col', 'style']},
    'clear_cell':        {'required': ['sheet', 'row', 'col']},

    # ── Range ──
    'set_range_values':  {'required': ['sheet', 'startRow', 'startCol', 'values']},
    'set_range_style':   {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'style']},
    'clear_range':       {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'merge_cells':       {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'unmerge_cells':     {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},

    # ── Row / Column ──
    'insert_row':        {'required': ['sheet', 'row']},
    'delete_row':        {'required': ['sheet', 'row']},
    'insert_column':     {'required': ['sheet', 'col']},
    'delete_column':     {'required': ['sheet', 'col']},
    'set_row_height':    {'required': ['sheet', 'row', 'height']},
    'set_column_width':  {'required': ['sheet', 'col', 'width']},
    'hide_row':          {'required': ['sheet']},
    'hide_column':       {'required': ['sheet']},
    'show_row':          {'required': ['sheet']},
    'show_column':       {'required': ['sheet']},
    'auto_fit_column':   {'required': ['sheet', 'col']},

    # ── Sheet ──
    'add_sheet':         {'required': ['name']},
    'rename_sheet':      {'required': ['oldName', 'newName']},
    'copy_sheet':        {'required': ['sourceName', 'newName']},
    'set_active_sheet':  {'required': ['name']},

    # ── Data ──
    'sort_range':        {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'filter_data':       {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'conditions']},
    'remove_filter':     {'required': ['sheet']},
    'find_replace':      {'required': ['sheet', 'find', 'replace']},
    'copy_paste':        {'required': ['sheet', 'sourceStartRow', 'sourceStartCol',
                                       'sourceEndRow', 'sourceEndCol', 'targetRow', 'targetCol']},
    'fill_series':       {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'remove_duplicates': {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},

    # ── Formatting ──
    'conditional_format':       {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'clear_formatting':         {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'clear_conditional_format': {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},

    # ── Analysis ──
    'create_pivot_data':           {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol',
                                                 'rowFields', 'valueField']},
    'calculate_statistics':        {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},
    'summarize_by_column':         {'required': ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol']},
    'summarize_metrics_by_column': {'required': ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol']},

    # ── Data Validation ──
    'set_data_validation':    {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'validationType']},
    'remove_data_validation': {'required': ['sheet', 'startRow', 'startCol', 'endRow', 'endCol']},

    # ── Comment ──
    'add_comment':    {'required': ['sheet', 'row', 'col', 'comment']},
    'delete_comment': {'required': ['sheet', 'row', 'col']},
    'update_comment': {'required': ['sheet', 'row', 'col', 'comment']},

    # ── Hyperlink ──
    'set_hyperlink':    {'required': ['sheet', 'row', 'col', 'url']},
    'remove_hyperlink': {'required': ['sheet', 'row', 'col']},

    # ── Image ──
    'insert_image': {'required': ['sheet', 'row', 'col', 'imageUrl']},
    'delete_image': {'required': ['sheet', 'imageId']},
    'update_image': {'required': ['sheet', 'imageId']},

    # ── Shape ──
    'insert_shape': {'required': ['sheet', 'shapeType', 'row', 'col']},
    'delete_shape': {'required': ['sheet', 'shapeId']},
    'update_shape': {'required': ['sheet', 'shapeId']},

    # ── Chart ──
    'create_chart': {'required': ['sheet', 'row', 'col', 'chartType', 'dataRange']},
    'update_chart': {'required': ['sheet', 'chartId']},
    'delete_chart': {'required': ['sheet', 'chartId']},

    # ── Pivot Table ──
    'create_pivot_table': {'required': ['sheet', 'sourceRange', 'rowFields', 'valueFields']},
    'update_pivot_table': {'required': ['sheet', 'pivotTableId']},
    'delete_pivot_table': {'required': ['sheet', 'pivotTableId']},

    # ── Query (前端有 case 但只读) ──
    'query_unique_values': {'required': ['sheet', 'column']},

    # ── Custom Formula ──
    'apply_custom_formula': {'required': ['sheet', 'targetCol', 'startRow', 'endRow', 'expression']},

    # ── Batch (元操作) ──
    'batch_operations': {'required': ['operations']},
}

# =====================================================================
#  别名映射
#  后端 @tool 装饰器名称使用复数（insert_rows），
#  前端 executeOperation switch 使用单数（insert_row）。
#  本映射在参数规范化阶段自动解析，避免类型漏匹配。
# =====================================================================
OPERATION_ALIASES: Dict[str, str] = {
    'insert_rows':    'insert_row',
    'delete_rows':    'delete_row',
    'insert_columns': 'insert_column',
    'delete_columns': 'delete_column',
    'hide_rows':      'hide_row',
    'hide_columns':   'hide_column',
    'show_rows':      'show_row',
    'show_columns':   'show_column',
}

# =====================================================================
#  只读操作集合
#  这些操作在后端注册为 MCP 工具，但不会向前端发送执行指令。
#  验证器遇到这些类型时直接放行，不做参数校验。
# =====================================================================
READ_ONLY_OPERATIONS: FrozenSet[str] = frozenset({
    'query_unique_values',
    'read_range_values',
    'aggregate_column',
    'query_column_profile',
})

# =====================================================================
#  导出集合
# =====================================================================
KNOWN_OPERATION_TYPES: FrozenSet[str] = frozenset(OPERATION_SCHEMAS.keys())


def resolve_operation_type(op_type: str) -> str:
    """将别名解析为规范操作类型名（幂等安全）"""
    return OPERATION_ALIASES.get(op_type, op_type)


def is_known_operation(op_type: str) -> bool:
    """判断是否为已注册操作（含别名 + 只读）"""
    canonical = resolve_operation_type(op_type)
    return canonical in KNOWN_OPERATION_TYPES or op_type in READ_ONLY_OPERATIONS


def get_required_params(op_type: str) -> Optional[List[str]]:
    """获取操作的必填参数列表；未注册返回 None"""
    canonical = resolve_operation_type(op_type)
    schema = OPERATION_SCHEMAS.get(canonical)
    return schema['required'] if schema else None
