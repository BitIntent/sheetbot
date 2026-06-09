// frontend/src/utils/operationRegistry.js
/**
 * 操作注册表 -- 前端单一真相源
 *
 * 与后端 operation_registry.py 保持一一对应。
 * operationValidator.js / excelOperations.js 均从此引入白名单，
 * 杜绝前后端操作列表不同步。
 */

// =====================================================================
//  操作 Schema（键 = executeOperation switch/case 中的规范 snake_case）
// =====================================================================
export const OPERATION_SCHEMAS = {
  // ── Cell ──
  set_cell_value:    { required: ['sheet', 'row', 'col', 'value'] },
  set_cell_formula:  { required: ['sheet', 'row', 'col', 'formula'] },
  set_cell_style:    { required: ['sheet', 'row', 'col', 'style'] },
  clear_cell:        { required: ['sheet', 'row', 'col'] },

  // ── Range ──
  set_range_values:  { required: ['sheet', 'startRow', 'startCol', 'values'] },
  set_range_style:   { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'style'] },
  clear_range:       { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  merge_cells:       { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  unmerge_cells:     { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },

  // ── Row / Column ──
  insert_row:        { required: ['sheet', 'row'] },
  delete_row:        { required: ['sheet', 'row'] },
  insert_column:     { required: ['sheet', 'col'] },
  delete_column:     { required: ['sheet', 'col'] },
  set_row_height:    { required: ['sheet', 'row', 'height'] },
  set_column_width:  { required: ['sheet', 'col', 'width'] },
  hide_row:          { required: ['sheet'] },
  hide_column:       { required: ['sheet'] },
  show_row:          { required: ['sheet'] },
  show_column:       { required: ['sheet'] },
  auto_fit_column:   { required: ['sheet', 'col'] },

  // ── Sheet ──
  add_sheet:         { required: ['name'] },
  rename_sheet:      { required: ['oldName', 'newName'] },
  copy_sheet:        { required: ['sourceName', 'newName'] },
  set_active_sheet:  { required: ['name'] },

  // ── Data ──
  sort_range:        { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  filter_data:       { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'conditions'] },
  remove_filter:     { required: ['sheet'] },
  find_replace:      { required: ['sheet', 'find', 'replace'] },
  copy_paste:        { required: ['sheet', 'sourceStartRow', 'sourceStartCol',
                                  'sourceEndRow', 'sourceEndCol', 'targetRow', 'targetCol'] },
  fill_series:       { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  remove_duplicates: { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },

  // ── Formatting ──
  conditional_format:       { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  clear_formatting:         { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  clear_conditional_format: { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },

  // ── Analysis ──
  create_pivot_data:           { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol',
                                            'rowFields', 'valueField'] },
  calculate_statistics:        { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },
  summarize_by_column:         { required: ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol'] },
  summarize_metrics_by_column: { required: ['sheet', 'startRow', 'endRow', 'groupByCol', 'sumCol'] },

  // ── Data Validation ──
  set_data_validation:    { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol', 'validationType'] },
  remove_data_validation: { required: ['sheet', 'startRow', 'startCol', 'endRow', 'endCol'] },

  // ── Comment ──
  add_comment:    { required: ['sheet', 'row', 'col', 'comment'] },
  delete_comment: { required: ['sheet', 'row', 'col'] },
  update_comment: { required: ['sheet', 'row', 'col', 'comment'] },

  // ── Hyperlink ──
  set_hyperlink:    { required: ['sheet', 'row', 'col', 'url'] },
  remove_hyperlink: { required: ['sheet', 'row', 'col'] },

  // ── Image ──
  insert_image: { required: ['sheet', 'row', 'col', 'imageUrl'] },
  delete_image: { required: ['sheet', 'imageId'] },
  update_image: { required: ['sheet', 'imageId'] },

  // ── Shape ──
  insert_shape: { required: ['sheet', 'shapeType', 'row', 'col'] },
  delete_shape: { required: ['sheet', 'shapeId'] },
  update_shape: { required: ['sheet', 'shapeId'] },

  // ── Chart ──
  create_chart: { required: ['sheet', 'row', 'col', 'chartType', 'dataRange'] },
  update_chart: { required: ['sheet', 'chartId'] },
  delete_chart: { required: ['sheet', 'chartId'] },

  // ── Pivot Table ──
  create_pivot_table: { required: ['sheet', 'sourceRange', 'rowFields', 'valueFields'] },
  update_pivot_table: { required: ['sheet', 'pivotTableId'] },
  delete_pivot_table: { required: ['sheet', 'pivotTableId'] },

  // ── Query ──
  query_unique_values: { required: ['sheet', 'column'] },

  // ── Custom Formula ──
  apply_custom_formula: { required: ['sheet', 'targetCol', 'startRow', 'endRow', 'expression'] },

  // ── Batch (meta) ──
  batch_operations: { required: ['operations'] },
}

// =====================================================================
//  别名映射（后端工具名复数 -> 前端规范单数）
// =====================================================================
export const OPERATION_ALIASES = {
  insert_rows:    'insert_row',
  delete_rows:    'delete_row',
  insert_columns: 'insert_column',
  delete_columns: 'delete_column',
  hide_rows:      'hide_row',
  hide_columns:   'hide_column',
  show_rows:      'show_row',
  show_columns:   'show_column',
}

// =====================================================================
//  导出集合
// =====================================================================
export const KNOWN_OPERATIONS = new Set(Object.keys(OPERATION_SCHEMAS))

/**
 * 将别名解析为规范操作类型名（幂等安全）
 */
export function resolveOperationType(type) {
  return OPERATION_ALIASES[type] || type
}

/**
 * 判断是否为已注册操作（含别名）
 */
export function isKnownOperation(type) {
  if (!type || typeof type !== 'string') return false
  const canonical = resolveOperationType(type)
  return KNOWN_OPERATIONS.has(canonical)
}

/**
 * 获取操作的必填参数列表；未注册返回 null
 */
export function getRequiredParams(type) {
  const canonical = resolveOperationType(type)
  const schema = OPERATION_SCHEMAS[canonical]
  return schema ? schema.required : null
}
