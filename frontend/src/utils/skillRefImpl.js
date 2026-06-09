// ============================================================================
// 玩数据 Skill - openpyxl 参考实现映射表
//
// 为通用 SKILL.md 导出提供 Python openpyxl 代码片段
// 每个技能类型对应一个参数化模板函数
// 覆盖高频 30+ 个技能，其余回退到自然语言描述
// ============================================================================

// ============================================================================
// 工具：将 #RRGGBB 颜色转为 openpyxl 的 RRGGBB（去掉 #）
// ============================================================================

function hexColor(color) {
  if (!color) return '000000'
  return color.replace('#', '')
}

// ============================================================================
// 工具：将 params 中的关键值格式化为可读字符串
// ============================================================================

function boolPy(v) { return v ? 'True' : 'False' }

function rangeComment(range) {
  if (!range) return 'A1:Z100'
  return String(range).replace(/\{\{([^}]+)\}\}/g, '<$1>')
}

// ============================================================================
// 参考实现模板注册表
// 返回 { code: string, imports: string[] }
// ============================================================================

const IMPL = {

  // ------------------------------------------------------------------
  // 字体与样式
  // ------------------------------------------------------------------

  set_font: (p) => ({
    imports: ['from openpyxl.styles import Font'],
    code: [
      `font = Font(`,
      `    name="${p.fontFamily || 'Arial'}",`,
      `    size=${p.fontSize || 11},`,
      `    bold=${boolPy(p.bold)},`,
      `    italic=${boolPy(p.italic)},`,
      `    underline=${ p.underline ? '"single"' : 'None'},`,
      `    strike=${boolPy(p.strikethrough)},`,
      `    color="${hexColor(p.fontColor)}"`,
      `)`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.font = font`,
    ].join('\n'),
  }),

  set_fill: (p) => ({
    imports: ['from openpyxl.styles import PatternFill'],
    code: [
      `fill = PatternFill(start_color="${hexColor(p.fillColor)}", end_color="${hexColor(p.fillColor)}", fill_type="solid")`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.fill = fill`,
    ].join('\n'),
  }),

  set_alignment: (p) => ({
    imports: ['from openpyxl.styles import Alignment'],
    code: [
      `alignment = Alignment(horizontal="${p.horizontal || 'center'}", vertical="${p.vertical || 'center'}", wrap_text=${boolPy(p.wrapText)})`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.alignment = alignment`,
    ].join('\n'),
  }),

  set_border: (p) => ({
    imports: ['from openpyxl.styles import Border, Side'],
    code: [
      `side = Side(style="${p.borderStyle || 'thin'}", color="${hexColor(p.borderColor)}")`,
      `border = Border(top=side, bottom=side, left=side, right=side)`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.border = border`,
    ].join('\n'),
  }),

  set_number_format: (p) => {
    const fmtMap = { general: 'General', number: '#,##0.00', percent: '0.00%', currency: '"$"#,##0.00', date: 'yyyy-mm-dd', text: '@' }
    const fmt = fmtMap[p.format] || p.customFormat || 'General'
    return {
      imports: [],
      code: [
        `for row in ws["${rangeComment(p.range)}"]:`,
        `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
        `        cell.number_format = '${fmt}'`,
      ].join('\n'),
    }
  },

  clear_format: (p) => ({
    imports: ['from openpyxl.styles import Font, PatternFill, Alignment, Border'],
    code: [
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.font = Font()`,
      `        cell.fill = PatternFill()`,
      `        cell.alignment = Alignment()`,
      `        cell.border = Border()`,
      `        cell.number_format = 'General'`,
    ].join('\n'),
  }),

  // ------------------------------------------------------------------
  // 快捷样式
  // ------------------------------------------------------------------

  header_beautify: (p) => ({
    imports: ['from openpyxl.styles import Font, PatternFill, Alignment, Border, Side'],
    code: [
      `# 表头美化：加粗 + 填充色 + 居中 + 边框`,
      `theme_colors = {"blue": "2563EB", "green": "16A34A", "orange": "EA580C", "dark": "1F2937", "purple": "7C3AED"}`,
      `bg = theme_colors.get("${p.theme || 'blue'}", "2563EB")`,
      `font = Font(bold=True, color="${hexColor(p.fontColor || '#FFFFFF')}")`,
      `fill = PatternFill(start_color=bg, end_color=bg, fill_type="solid")`,
      `align = Alignment(horizontal="center", vertical="center")`,
      `side = Side(style="thin")`,
      `border = Border(top=side, bottom=side, left=side, right=side)`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.font = font`,
      `        cell.fill = fill`,
      `        cell.alignment = align`,
      `        cell.border = border`,
    ].join('\n'),
  }),

  zebra_stripe: (p) => ({
    imports: ['from openpyxl.styles import PatternFill'],
    code: [
      `color_odd = PatternFill(start_color="${hexColor(p.color1 || '#FFFFFF')}", fill_type="solid")`,
      `color_even = PatternFill(start_color="${hexColor(p.color2 || '#F0F4FF')}", fill_type="solid")`,
      `for idx, row in enumerate(ws["${rangeComment(p.range)}"]):`,
      `    fill = color_even if idx % 2 == 1 else color_odd`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.fill = fill`,
    ].join('\n'),
  }),

  // ------------------------------------------------------------------
  // 单元格编辑
  // ------------------------------------------------------------------

  set_value: (p) => ({
    imports: [],
    code: `ws["${p.cell || 'A1'}"] = ${JSON.stringify(p.value ?? '')}`,
  }),

  batch_fill: (p) => ({
    imports: [],
    code: [
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.value = ${JSON.stringify(p.value ?? '')}`,
    ].join('\n'),
  }),

  set_formula: (p) => ({
    imports: [],
    code: `ws["${p.cell || 'A1'}"] = '${p.formula || '=SUM(A1:A10)'}'`,
  }),

  find_replace: (p) => ({
    imports: [],
    code: [
      `# 查找替换：遍历所有单元格`,
      `for row in ws.iter_rows():`,
      `    for cell in row:`,
      `        if cell.value and isinstance(cell.value, str):`,
      `            if ${p.matchCase ? '' : 'cell.value.lower().find(' + JSON.stringify((p.find || '').toLowerCase()) + ') >= 0'}${p.matchCase ? JSON.stringify(p.find || '') + ' in cell.value' : ''}:`,
      `                cell.value = cell.value.replace(${JSON.stringify(p.find || '')}, ${JSON.stringify(p.replace || '')})`,
    ].join('\n'),
  }),

  clear_content: (p) => ({
    imports: [],
    code: [
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    for cell in (row if hasattr(row, '__iter__') else [row]):`,
      `        cell.value = None`,
    ].join('\n'),
  }),

  copy_paste: (p) => ({
    imports: [],
    code: [
      `# 复制 ${rangeComment(p.sourceRange)} 到 ${p.targetCell || 'E1'}`,
      `src_data = []`,
      `for row in ws["${rangeComment(p.sourceRange)}"]:`,
      `    src_data.append([cell.value for cell in (row if hasattr(row, '__iter__') else [row])])`,
      `target = ws["${p.targetCell || 'E1'}"]`,
      `start_row, start_col = target.row, target.column`,
      `for r_idx, row_data in enumerate(src_data):`,
      `    for c_idx, val in enumerate(row_data):`,
      `        ws.cell(row=start_row + r_idx, column=start_col + c_idx, value=val)`,
    ].join('\n'),
  }),

  // ------------------------------------------------------------------
  // 快捷公式
  // ------------------------------------------------------------------

  quick_sum: (p) => ({
    imports: [],
    code: `ws["${p.outputCell || 'B11'}"] = '=SUM(${p.dataRange || 'B2:B10'})'`,
  }),

  quick_average: (p) => ({
    imports: [],
    code: `ws["${p.outputCell || 'B11'}"] = '=AVERAGE(${p.dataRange || 'B2:B10'})'`,
  }),

  quick_count: (p) => ({
    imports: [],
    code: `ws["${p.outputCell || 'B11'}"] = '=COUNTA(${p.dataRange || 'B2:B10'})'`,
  }),

  quick_max: (p) => ({
    imports: [],
    code: `ws["${p.outputCell || 'B11'}"] = '=MAX(${p.dataRange || 'B2:B10'})'`,
  }),

  quick_min: (p) => ({
    imports: [],
    code: `ws["${p.outputCell || 'B11'}"] = '=MIN(${p.dataRange || 'B2:B10'})'`,
  }),

  // ------------------------------------------------------------------
  // 行列操作
  // ------------------------------------------------------------------

  insert_rows: (p) => ({
    imports: [],
    code: `ws.insert_rows(${p.row || 1}, amount=${p.count || 1})`,
  }),

  delete_rows: (p) => ({
    imports: [],
    code: `ws.delete_rows(${p.row || 1}, amount=${p.count || 1})`,
  }),

  insert_columns: (p) => ({
    imports: ['from openpyxl.utils import column_index_from_string'],
    code: `ws.insert_cols(column_index_from_string("${p.column || 'A'}"), amount=${p.count || 1})`,
  }),

  delete_columns: (p) => ({
    imports: ['from openpyxl.utils import column_index_from_string'],
    code: `ws.delete_cols(column_index_from_string("${p.column || 'A'}"), amount=${p.count || 1})`,
  }),

  set_row_height: (p) => ({
    imports: [],
    code: `ws.row_dimensions[${p.row || 1}].height = ${p.height || 24}`,
  }),

  set_column_width: (p) => ({
    imports: [],
    code: `ws.column_dimensions["${p.column || 'A'}"].width = ${p.width || 18}`,
  }),

  hide_rows: (p) => ({
    imports: [],
    code: `ws.row_dimensions[${p.row || 1}].hidden = True`,
  }),

  show_rows: (p) => ({
    imports: [],
    code: `ws.row_dimensions[${p.row || 1}].hidden = False`,
  }),

  hide_columns: (p) => ({
    imports: [],
    code: `ws.column_dimensions["${p.column || 'A'}"].hidden = True`,
  }),

  show_columns: (p) => ({
    imports: [],
    code: `ws.column_dimensions["${p.column || 'A'}"].hidden = False`,
  }),

  auto_fit_column: (p) => ({
    imports: ['from openpyxl.utils import get_column_letter'],
    code: [
      `col_letter = "${p.column || 'A'}"`,
      `max_len = 0`,
      `for cell in ws[col_letter]:`,
      `    if cell.value:`,
      `        max_len = max(max_len, len(str(cell.value)))`,
      `ws.column_dimensions[col_letter].width = max_len + 2`,
    ].join('\n'),
  }),

  // ------------------------------------------------------------------
  // 单元格操作
  // ------------------------------------------------------------------

  merge_cells: (p) => ({
    imports: [],
    code: `ws.merge_cells("${rangeComment(p.range)}")`,
  }),

  unmerge_cells: (p) => ({
    imports: [],
    code: `ws.unmerge_cells("${rangeComment(p.range)}")`,
  }),

  freeze_panes: (p) => ({
    imports: [],
    code: `ws.freeze_panes = "${p.cell || 'B2'}"`,
  }),

  unfreeze_panes: () => ({
    imports: [],
    code: `ws.freeze_panes = None`,
  }),

  // ------------------------------------------------------------------
  // 批注与链接
  // ------------------------------------------------------------------

  add_comment: (p) => ({
    imports: ['from openpyxl.comments import Comment'],
    code: `ws["${p.cell || 'A1'}"].comment = Comment(${JSON.stringify(p.text || '')}, "SheetBot")`,
  }),

  delete_comment: (p) => ({
    imports: [],
    code: `ws["${p.cell || 'A1'}"].comment = None`,
  }),

  set_hyperlink: (p) => ({
    imports: [],
    code: [
      `ws["${p.cell || 'A1'}"].hyperlink = "${p.url || ''}"`,
      `ws["${p.cell || 'A1'}"].value = ${JSON.stringify(p.displayText || p.url || '')}`,
    ].join('\n'),
  }),

  remove_hyperlink: (p) => ({
    imports: [],
    code: `ws["${p.cell || 'A1'}"].hyperlink = None`,
  }),

  // ------------------------------------------------------------------
  // 数据处理
  // ------------------------------------------------------------------

  sort_range: (p) => ({
    imports: ['from openpyxl.utils import column_index_from_string'],
    code: [
      `# openpyxl 不直接支持排序，需要读取数据后排序再写回`,
      `data = []`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    data.append([cell.value for cell in row])`,
      `header = data[0] if ${boolPy(p.hasHeader !== false)} else None`,
      `body = data[1:] if header else data`,
      `sort_col = column_index_from_string("${p.sortByColumn || 'A'}") - ws["${rangeComment(p.range)}"][0][0].column`,
      `body.sort(key=lambda r: (r[sort_col] is None, r[sort_col]), reverse=${'desc' === p.order ? 'True' : 'False'})`,
      `all_data = ([header] + body) if header else body`,
      `for r_idx, row_data in enumerate(all_data):`,
      `    for c_idx, val in enumerate(row_data):`,
      `        ws.cell(row=ws["${rangeComment(p.range)}"][0][0].row + r_idx,`,
      `                column=ws["${rangeComment(p.range)}"][0][0].column + c_idx, value=val)`,
    ].join('\n'),
  }),

  remove_duplicates: (p) => ({
    imports: ['from openpyxl.utils import column_index_from_string'],
    code: [
      `# 去重：读取数据 -> 按指定列去重 -> 写回`,
      `data = []`,
      `for row in ws["${rangeComment(p.range)}"]:`,
      `    data.append([cell.value for cell in row])`,
      `header = data[0] if ${boolPy(p.hasHeader !== false)} else None`,
      `body = data[1:] if header else data`,
      `seen = set()`,
      `unique = []`,
      `for row in body:`,
      `    key = tuple(row)  # 按所有列去重`,
      `    if key not in seen:`,
      `        seen.add(key)`,
      `        unique.append(row)`,
      `# 写回去重后的数据`,
    ].join('\n'),
  }),
}

// ============================================================================
// 导出接口
// ============================================================================

/**
 * 获取指定技能类型的 openpyxl 参考实现
 * @param {string} skillType - 技能类型（如 'set_font'）
 * @param {object} params - 用户配置的参数
 * @returns {{ code: string, imports: string[] } | null}
 */
export function getRefImpl(skillType, params) {
  const generator = IMPL[skillType]
  if (!generator) return null
  try {
    return generator(params || {})
  } catch {
    return null
  }
}

/**
 * 检查指定技能类型是否有参考实现
 */
export function hasRefImpl(skillType) {
  return skillType in IMPL
}
