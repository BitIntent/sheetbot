// ============================================================================
// 玩数据 Skill - 翻译层（Adapter）
//
// 将用户友好的技能参数（A1:C10 范围、颜色选择器值、布尔开关等）
// 翻译为底层 executeOperation() 所需的原始参数格式
// ============================================================================

// ============================================================================
// 解析工具：A1 表示法 -> 数字坐标
// ============================================================================

/**
 * 列字母 -> 列号 ("A"->1, "B"->2, "Z"->26, "AA"->27)
 */
export function letterToCol(letters) {
  if (!letters) return 1
  const s = letters.toUpperCase().trim()
  let col = 0
  for (let i = 0; i < s.length; i++) {
    col = col * 26 + (s.charCodeAt(i) - 64)
  }
  return col || 1
}

/**
 * 列号 -> 列字母 (1->"A", 2->"B", 27->"AA")
 */
export function colToLetter(col) {
  let n = Number(col) || 0
  if (n <= 0) return 'A'
  let out = ''
  while (n > 0) {
    n -= 1
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

/**
 * 解析单元格引用 "B5" -> { row: 5, col: 2 }
 */
export function parseCell(cellRef) {
  if (!cellRef || typeof cellRef !== 'string') return { row: 1, col: 1 }
  const m = cellRef.trim().match(/^([A-Za-z]+)(\d+)$/)
  if (!m) return { row: 1, col: 1 }
  return { row: parseInt(m[2]) || 1, col: letterToCol(m[1]) }
}

/**
 * 解析范围 "A1:C10" -> { startRow, startCol, endRow, endCol }
 * 也兼容单个单元格 "A1" -> 起止相同
 */
export function parseRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') {
    return { startRow: 1, startCol: 1, endRow: 1, endCol: 1 }
  }
  const parts = rangeStr.trim().split(':')
  const start = parseCell(parts[0])
  const end = parts.length > 1 ? parseCell(parts[1]) : { ...start }
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  }
}

// ============================================================================
// 主题预设
// ============================================================================

const HEADER_THEMES = {
  blue:   { bg: '#2563EB', font: '#FFFFFF' },
  green:  { bg: '#16A34A', font: '#FFFFFF' },
  orange: { bg: '#EA580C', font: '#FFFFFF' },
  dark:   { bg: '#1F2937', font: '#F9FAFB' },
  purple: { bg: '#7C3AED', font: '#FFFFFF' },
}

const NUMBER_FORMAT_MAP = {
  general: 'General',
  number:  '#,##0.00',
  percent: '0.00%',
  currency: '"$"#,##0.00',
  date:    'yyyy-mm-dd',
  text:    '@',
}

// ============================================================================
// 翻译核心：将新版技能 -> 一个或多个底层操作
// 返回值：单个 { type, params } 或数组 [{ type, params }, ...]
// ============================================================================

export function translateSkillOp(skillType, params) {
  const translator = TRANSLATORS[skillType]
  if (!translator) {
    console.warn(`[SkillTranslator] 未知技能类型: ${skillType}`)
    return null
  }
  return translator(params)
}

// ============================================================================
// 翻译器注册表
// ============================================================================

const TRANSLATORS = {

  // ------------------------------------------------------------------
  // 1. 字体与样式
  // ------------------------------------------------------------------

  set_font: (p) => {
    const r = parseRange(p.range)
    const font = {}
    if (p.bold !== undefined) font.bold = p.bold
    if (p.italic !== undefined) font.italic = p.italic
    if (p.underline !== undefined) font.underline = p.underline
    if (p.strikethrough !== undefined) font.strikethrough = p.strikethrough
    if (p.fontSize !== undefined) font.size = p.fontSize
    if (p.fontColor) font.color = p.fontColor
    if (p.fontFamily) font.name = p.fontFamily
    return { type: 'set_range_style', params: { ...r, style: { font } } }
  },

  set_fill: (p) => {
    const r = parseRange(p.range)
    return { type: 'set_range_style', params: { ...r, style: { fill: { type: 'solid', color: p.fillColor } } } }
  },

  set_alignment: (p) => {
    const r = parseRange(p.range)
    const style = {}
    if (p.horizontal) style.align = p.horizontal
    if (p.vertical) style.verticalAlignment = p.vertical
    if (p.wrapText !== undefined) style.wrapText = p.wrapText
    if (p.indent) style.indent = p.indent
    if (p.textRotation) style.textRotation = p.textRotation
    return { type: 'set_range_style', params: { ...r, style } }
  },

  set_border: (p) => {
    const r = parseRange(p.range)
    const borderDef = { style: p.borderStyle || 'thin', color: p.borderColor || '#000000' }
    const border = {}
    const pos = p.borderPosition || 'all'
    if (pos === 'all' || pos === 'top' || pos === 'outside') border.top = borderDef
    if (pos === 'all' || pos === 'bottom' || pos === 'outside') border.bottom = borderDef
    if (pos === 'all' || pos === 'left' || pos === 'outside') border.left = borderDef
    if (pos === 'all' || pos === 'right' || pos === 'outside') border.right = borderDef
    return { type: 'set_range_style', params: { ...r, style: { border } } }
  },

  set_number_format: (p) => {
    const r = parseRange(p.range)
    let fmt = NUMBER_FORMAT_MAP[p.format] || 'General'
    if (p.format === 'custom' && p.customFormat) fmt = p.customFormat
    if (p.format === 'number' && p.decimals !== undefined) {
      fmt = p.decimals > 0 ? `#,##0.${'0'.repeat(p.decimals)}` : '#,##0'
    }
    if (p.format === 'percent' && p.decimals !== undefined) {
      fmt = p.decimals > 0 ? `0.${'0'.repeat(p.decimals)}%` : '0%'
    }
    return { type: 'set_range_style', params: { ...r, style: { numberFormat: fmt } } }
  },

  clear_format: (p) => {
    const r = parseRange(p.range)
    return { type: 'clear_formatting', params: r }
  },

  // ------------------------------------------------------------------
  // 2. 快捷样式
  // ------------------------------------------------------------------

  header_beautify: (p) => {
    const r = parseRange(p.range)
    const theme = HEADER_THEMES[p.theme] || HEADER_THEMES.blue
    const fontColor = p.fontColor || theme.font
    return { type: 'set_range_style', params: {
      ...r,
      style: {
        font: { bold: true, color: fontColor },
        fill: { type: 'solid', color: theme.bg },
        align: 'center',
        verticalAlignment: 'middle',
        border: { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } },
      },
    }}
  },

  zebra_stripe: (p) => {
    const r = parseRange(p.range)
    const ops = []
    for (let row = r.startRow; row <= r.endRow; row++) {
      const isEven = (row - r.startRow) % 2 === 1
      ops.push({
        type: 'set_range_style',
        params: {
          startRow: row, startCol: r.startCol, endRow: row, endCol: r.endCol,
          style: { fill: { type: 'solid', color: isEven ? p.color2 : p.color1 } },
        },
      })
    }
    return ops
  },

  percent_format: (p) => {
    const r = parseRange(p.range)
    const dec = p.decimals ?? 1
    const fmt = dec > 0 ? `0.${'0'.repeat(dec)}%` : '0%'
    return { type: 'set_range_style', params: { ...r, style: { numberFormat: fmt } } }
  },

  currency_format: (p) => {
    const r = parseRange(p.range)
    const sym = p.symbol || '¥'
    const dec = p.decimals ?? 2
    const fmt = dec > 0 ? `"${sym}"#,##0.${'0'.repeat(dec)}` : `"${sym}"#,##0`
    return { type: 'set_range_style', params: { ...r, style: { numberFormat: fmt } } }
  },

  date_format: (p) => {
    const r = parseRange(p.range)
    return { type: 'set_range_style', params: { ...r, style: { numberFormat: p.datePattern || 'yyyy-mm-dd' } } }
  },

  wrap_text: (p) => {
    const r = parseRange(p.range)
    return { type: 'set_range_style', params: { ...r, style: { wrapText: true } } }
  },

  // ------------------------------------------------------------------
  // 3. 条件格式
  // ------------------------------------------------------------------

  cond_highlight: (p) => {
    const r = parseRange(p.range)
    const condition = { type: p.operator || 'greaterThan', value: p.value }
    if (p.operator === 'between' && p.value2) condition.value2 = p.value2
    const format = {
      fill: { type: 'solid', color: p.highlightColor || '#FEE2E2' },
      font: { color: p.fontColor || '#B91C1C' },
    }
    return { type: 'conditional_format', params: { ...r, condition, format } }
  },

  cond_color_scale: (p) => {
    const r = parseRange(p.range)
    const condition = { type: 'colorScale', minColor: p.minColor, maxColor: p.maxColor }
    return { type: 'conditional_format', params: { ...r, condition, format: {} } }
  },

  cond_data_bar: (p) => {
    const r = parseRange(p.range)
    const condition = { type: 'dataBar', barColor: p.barColor }
    return { type: 'conditional_format', params: { ...r, condition, format: {} } }
  },

  clear_cond_format: (p) => {
    const r = parseRange(p.range)
    return { type: 'clear_conditional_format', params: r }
  },

  // ------------------------------------------------------------------
  // 4. 单元格编辑
  // ------------------------------------------------------------------

  set_value: (p) => {
    const c = parseCell(p.cell)
    return { type: 'set_cell_value', params: { ...c, value: p.value } }
  },

  batch_fill: (p) => {
    const r = parseRange(p.range)
    const rows = []
    for (let ri = r.startRow; ri <= r.endRow; ri++) {
      const row = []
      for (let ci = r.startCol; ci <= r.endCol; ci++) row.push(p.value)
      rows.push(row)
    }
    return { type: 'set_range_values', params: { startRow: r.startRow, startCol: r.startCol, values: rows } }
  },

  set_values: (p) => {
    const c = parseCell(p.startCell)
    let values = p.values
    if (typeof values === 'string') {
      try { values = JSON.parse(values) } catch { values = [[values]] }
    }
    return { type: 'set_range_values', params: { startRow: c.row, startCol: c.col, values } }
  },

  set_formula: (p) => {
    const c = parseCell(p.cell)
    let formula = p.formula || ''
    if (formula && !formula.startsWith('=')) formula = '=' + formula
    return { type: 'set_cell_formula', params: { ...c, formula } }
  },

  find_replace: (p) => ({
    type: 'find_replace',
    params: { find: p.find, replace: p.replace, matchCase: p.matchCase, matchWholeCell: p.matchWholeCell },
  }),

  clear_content: (p) => {
    const r = parseRange(p.range)
    return { type: 'clear_range', params: { ...r, clearFormat: p.clearFormat || false } }
  },

  clear_cell: (p) => {
    const c = parseCell(p.cell)
    return { type: 'clear_cell', params: { ...c, clearFormat: p.clearFormat || false } }
  },

  copy_paste: (p) => {
    const src = parseRange(p.sourceRange)
    const tgt = parseCell(p.targetCell)
    return { type: 'copy_paste', params: {
      sourceStartRow: src.startRow, sourceStartCol: src.startCol,
      sourceEndRow: src.endRow, sourceEndCol: src.endCol,
      targetRow: tgt.row, targetCol: tgt.col,
      pasteValuesOnly: p.valuesOnly || false,
    }}
  },

  // ------------------------------------------------------------------
  // 5. 快捷公式
  // ------------------------------------------------------------------

  quick_sum: (p) => buildQuickFormula('SUM', p),
  quick_average: (p) => buildQuickFormula('AVERAGE', p),
  quick_count: (p) => buildQuickFormula('COUNTA', p),
  quick_max: (p) => buildQuickFormula('MAX', p),
  quick_min: (p) => buildQuickFormula('MIN', p),

  custom_formula: (p) => ({
    type: 'apply_custom_formula',
    params: {
      targetCol: letterToCol(p.targetColumn),
      startRow: p.startRow,
      endRow: p.endRow,
      expression: p.expression,
    },
  }),

  // ------------------------------------------------------------------
  // 6. 行操作
  // ------------------------------------------------------------------

  insert_rows: (p) => ({ type: 'insert_row', params: { row: p.row, count: p.count || 1 } }),
  delete_rows: (p) => ({ type: 'delete_row', params: { row: p.row, count: p.count || 1 } }),
  set_row_height: (p) => ({ type: 'set_row_height', params: { row: p.row, height: p.height || 24 } }),
  hide_rows: (p) => ({ type: 'hide_row', params: { row: p.row } }),
  show_rows: (p) => ({ type: 'show_row', params: { row: p.row } }),

  // ------------------------------------------------------------------
  // 7. 列操作
  // ------------------------------------------------------------------

  insert_columns: (p) => ({ type: 'insert_column', params: { col: letterToCol(p.column), count: p.count || 1 } }),
  delete_columns: (p) => ({ type: 'delete_column', params: { col: letterToCol(p.column), count: p.count || 1 } }),
  set_column_width: (p) => ({ type: 'set_column_width', params: { col: letterToCol(p.column), width: p.width || 18 } }),
  auto_fit_column: (p) => ({ type: 'auto_fit_column', params: { col: letterToCol(p.column) } }),
  hide_columns: (p) => ({ type: 'hide_column', params: { col: letterToCol(p.column) } }),
  show_columns: (p) => ({ type: 'show_column', params: { col: letterToCol(p.column) } }),

  // ------------------------------------------------------------------
  // 8. 单元格操作
  // ------------------------------------------------------------------

  merge_cells: (p) => {
    const r = parseRange(p.range)
    return { type: 'merge_cells', params: r }
  },

  unmerge_cells: (p) => {
    const r = parseRange(p.range)
    return { type: 'unmerge_cells', params: r }
  },

  freeze_panes: (p) => {
    const c = parseCell(p.cell)
    return { type: 'freeze_panes', params: { row: c.row, col: c.col } }
  },

  unfreeze_panes: () => ({ type: 'freeze_panes', params: { row: 0, col: 0 } }),

  fill_series: (p) => {
    const r = parseRange(p.range)
    return { type: 'fill_series', params: {
      ...r, seriesType: p.seriesType || 'linear', step: p.step ?? 1, direction: p.direction || 'down',
    }}
  },

  // ------------------------------------------------------------------
  // 9. 批注与链接
  // ------------------------------------------------------------------

  add_comment: (p) => {
    const c = parseCell(p.cell)
    return { type: 'add_comment', params: { ...c, comment: p.text } }
  },

  update_comment: (p) => {
    const c = parseCell(p.cell)
    return { type: 'update_comment', params: { ...c, comment: p.text } }
  },

  delete_comment: (p) => {
    const c = parseCell(p.cell)
    return { type: 'delete_comment', params: c }
  },

  set_hyperlink: (p) => {
    const c = parseCell(p.cell)
    return { type: 'set_hyperlink', params: { ...c, url: p.url, text: p.displayText } }
  },

  remove_hyperlink: (p) => {
    const c = parseCell(p.cell)
    return { type: 'remove_hyperlink', params: c }
  },

  // ------------------------------------------------------------------
  // 10. 数据验证
  // ------------------------------------------------------------------

  validate_list: (p) => {
    const r = parseRange(p.range)
    const items = typeof p.items === 'string'
      ? p.items
        .split(/[，,]/)
        .map(s => s.trim())
        .filter(Boolean)
      : (Array.isArray(p.items) ? p.items : [])
    return {
      type: 'set_data_validation',
      params: {
        ...r,
        validationType: 'list',
        validationParams: { values: items },
      },
    }
  },

  validate_number: (p) => {
    const r = parseRange(p.range)
    return {
      type: 'set_data_validation',
      params: {
        ...r,
        validationType: 'decimal',
        validationParams: { min: p.min, max: p.max },
      },
    }
  },

  clear_validation: (p) => {
    const r = parseRange(p.range)
    return { type: 'remove_data_validation', params: r }
  },

  // ------------------------------------------------------------------
  // 11. 数据处理
  // ------------------------------------------------------------------

  sort_range: (p) => {
    const r = parseRange(p.range)
    return { type: 'sort_range', params: {
      ...r,
      sortColumns: [{ col: letterToCol(p.sortByColumn), order: p.order || 'asc' }],
      hasHeader: p.hasHeader !== false,
    }}
  },

  multi_sort: (p) => {
    const r = parseRange(p.range)
    let rules = p.sortRules
    if (typeof rules === 'string') {
      try { rules = JSON.parse(rules) } catch { rules = [] }
    }
    const sortColumns = (rules || []).map(rule => ({
      col: letterToCol(rule.column || rule.col),
      order: rule.order || 'asc',
    }))
    return { type: 'sort_range', params: { ...r, sortColumns, hasHeader: p.hasHeader !== false } }
  },

  remove_duplicates: (p) => {
    const r = parseRange(p.range)
    const cols = typeof p.byColumns === 'string'
      ? p.byColumns.split(',').map(s => String(letterToCol(s.trim())))
      : (p.byColumns || [])
    return { type: 'remove_duplicates', params: { ...r, columns: cols, hasHeader: p.hasHeader !== false } }
  },

  filter_data: (p) => {
    const r = parseRange(p.range)
    const col = letterToCol(p.column)
    const opMap = { equals: 'equal' }
    const operator = opMap[p.operator] || p.operator || 'contains'
    return { type: 'filter_data', params: {
      ...r,
      // 统一成对象格式，匹配 operationValidator 与 filterData 双端约定
      conditions: { [String(col)]: { operator, value: p.value } },
    }}
  },

  clear_filter: () => ({ type: 'remove_filter', params: {} }),

  query_unique: (p) => {
    const targetCol = letterToCol(p.column)
    const out = p.outputCell ? parseCell(p.outputCell) : { row: p.startRow || 1, col: targetCol + 2 }
    return {
      type: 'query_unique_values',
      params: {
        column: targetCol,
        startRow: p.startRow || 1,
        endRow: p.endRow || 100,
        targetRow: out.row,
        targetCol: out.col,
      },
    }
  },

  // ------------------------------------------------------------------
  // 12. 数据分析
  // ------------------------------------------------------------------

  pivot_table: (p) => {
    const src = parseRange(p.sourceRange)
    const tgt = parseCell(p.targetCell || 'A1')
    let rowFields = typeof p.rowFields === 'string' ? p.rowFields.split(',').map(s => s.trim()) : (p.rowFields || [])
    let valueFields = p.valueFields
    if (typeof valueFields === 'string') {
      try { valueFields = JSON.parse(valueFields) } catch { valueFields = [] }
    }
    return { type: 'create_pivot_table', params: {
      sourceRange: src, rowFields, colFields: [],
      valueFields: valueFields || [], targetSheet: p.targetSheet || '',
      targetRow: tgt.row, targetCol: tgt.col,
    }}
  },

  pivot_data: (p) => {
    const src = parseRange(p.sourceRange)
    const tgt = parseCell(p.targetCell || 'A1')
    const rowFields = typeof p.rowFields === 'string' ? p.rowFields.split(',').map(s => s.trim()) : (p.rowFields || [])
    const colFields = typeof p.colFields === 'string' && p.colFields
      ? p.colFields.split(',').map(s => s.trim()) : (p.colFields || [])
    return { type: 'create_pivot_data', params: {
      ...src, rowFields, colFields,
      valueField: p.valueField || '', aggregateFunction: p.aggregateFunc || 'sum',
      targetSheet: p.targetSheet || '', targetRow: tgt.row, targetCol: tgt.col,
    }}
  },

  calc_statistics: (p) => {
    const r = parseRange(p.range)
    const out = parseCell(p.outputCell || 'A1')
    return { type: 'calculate_statistics', params: { ...r, outputRow: out.row, outputCol: out.col } }
  },

  summarize_column: (p) => {
    const r = parseRange(p.range)
    const out = p.outputCell ? parseCell(p.outputCell) : null
    return { type: 'summarize_by_column', params: {
      ...r,
      groupByCol: letterToCol(p.groupByColumn),
      sumCol: letterToCol(p.sumColumn),
      targetRow: out ? out.row : r.endRow + 1,
      includeTotal: p.includeTotal !== false,
    }}
  },

  summarize_metrics: (p) => {
    const r = parseRange(p.range)
    const tgt = p.targetCell ? parseCell(p.targetCell) : { row: 1, col: 1 }
    return { type: 'summarize_metrics_by_column', params: {
      startRow: r.startRow, endRow: r.endRow,
      groupByCol: letterToCol(p.groupByColumn),
      sumCol: letterToCol(p.sumColumn),
      targetSheet: p.targetSheet || '',
      targetRow: tgt.row, targetCol: tgt.col,
      includeTotal: p.includeTotal !== false,
    }}
  },
}

// ============================================================================
// 内部工具：构建快捷公式操作
// ============================================================================

function buildQuickFormula(funcName, p) {
  const c = parseCell(p.outputCell)
  const dataRange = p.dataRange || 'A1:A10'
  return { type: 'set_cell_formula', params: { ...c, formula: `=${funcName}(${dataRange})` } }
}
