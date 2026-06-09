// frontend/src/utils/excelOperations.js
/**
 * Excel Operations Utility
 * 执行 Excel 操作指令
 */
import * as ExcelJS from 'exceljs'
import { resolveApiBaseUrl } from '../config/appConfig'
import { evaluateFormula } from './formulaEngine'
import { validateOperation, normalizeOperationType } from './operationValidator'
import { isKnownOperation, resolveOperationType } from './operationRegistry'
import { normalizeDateValue, normalizeValidationParams } from './dateNormalizer'

// ── 语义名称 → Excel 格式模板映射 ──
// Agent 发送 "number"/"currency"/"percentage" 等名称，
// 必须在进入 SheetBot 数据模型前转为合法 Excel numFmt pattern，
// 否则 Univer 格式引擎把字母 m/e/d/s 当日期 token，数值被显示为日期。
const _NUMFMT_ALIASES = {
  number: '#,##0',
  integer: '0',
  currency: '#,##0.00',
  accounting: '#,##0.00',
  percentage: '0.00%',
  percent: '0.00%',
  scientific: '0.00E+00',
  text: '@',
  date: 'yyyy-mm-dd',
  time: 'h:mm:ss',
  datetime: 'yyyy-mm-dd h:mm:ss',
  general: 'General',
}
function _resolveNumFmt(raw) {
  if (!raw || typeof raw !== 'string') return raw
  return _NUMFMT_ALIASES[raw.toLowerCase()] ?? raw
}

/**
 * 创建工作簿
 */
export function createWorkbook() {
  return {
    sheets: [],
    activeSheet: null
  }
}

/**
 * 去掉字段名外的「」、引号及尾字「列」，与表头字面量对齐（用户常用书名号强调列名）
 */
/**
 * 透视匹配用：去 BOM / 零宽字符并压缩空白，避免「品类」与「品类\u200b」等对不齐
 */
export function normalizePivotIdentifier(name) {
  if (name === null || name === undefined) return ''
  return String(name)
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function stripFieldNameDecorators(name) {
  if (name === null || name === undefined) return ''
  let s = String(name).trim()
  const reQuotedCol1 = /^\u300c(.+)\u300d\u5217$/
  const reQuotedCol2 = /^\u300e(.+)\u300f\u5217$/
  const qm = s.match(reQuotedCol1) || s.match(reQuotedCol2)
  if (qm && qm[1]) return qm[1].trim()
  const pairs = [
    ['\u300c', '\u300d'],
    ['\u300e', '\u300f'],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
    ['"', '"'],
    ["'", "'"]
  ]
  for (let guard = 0; guard < 8; guard++) {
    let changed = false
    for (const [a, b] of pairs) {
      if (s.startsWith(a) && s.endsWith(b) && s.length > a.length + b.length) {
        s = s.slice(a.length, -b.length).trim()
        changed = true
        break
      }
    }
    if (!changed) break
  }
  if (s.endsWith('\u5217') && s.length > 1) {
    s = s.slice(0, -1).trim()
  }
  return s
}

/**
 * 规范化格式样式对象
 * 处理 snake_case -> camelCase 转换和属性名映射
 */
function normalizeFormatStyle(format) {
  if (!format || typeof format !== 'object') return format
  
  const normalized = {}
  
  // 属性名映射：snake_case / 其他变体 -> camelCase
  const propMap = {
    'font_color': 'fontColor',
    'fontcolor': 'fontColor',
    'color': 'fontColor',
    'text_color': 'fontColor',
    'textColor': 'fontColor',
    'background_color': 'backgroundColor',
    'backgroundcolor': 'backgroundColor',
    'bg_color': 'backgroundColor',
    'bgColor': 'backgroundColor',
    'fill_color': 'backgroundColor',
    'fillColor': 'backgroundColor',
    'font_weight': 'bold',
    'fontWeight': 'bold',
    'font_style': 'italic',
    'fontStyle': 'italic',
  }
  
  for (const [key, value] of Object.entries(format)) {
    const normalizedKey = propMap[key] || key
    
    // 处理 bold 属性值（可能是字符串 "bold" 或布尔值）
    if (normalizedKey === 'bold') {
      normalized.bold = value === true || value === 'bold' || value === 'true'
    } else {
      normalized[normalizedKey] = value
    }
  }
  
  return normalized
}

// ------------------------------------------------------------------
// 通用 snake_case -> camelCase 算法（零维护，自动覆盖任何新参数）
// 幂等安全：已经是 camelCase 的 startRow 不含 _[a-z]，不变。
// ------------------------------------------------------------------
const snakeToCamel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

// 列字母转列号（A -> 1, B -> 2, ..., AA -> 27）
const columnLettersToNumber = (letters) => {
  if (!letters || typeof letters !== 'string') return null
  return letters
    .toUpperCase()
    .split('')
    .reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0)
}

// 提取简单单列汇总公式中的列字母（如 =SUM(H2:H201)）
const extractSingleColumnRange = (formula) => {
  if (!formula || typeof formula !== 'string') return null
  const cleaned = formula
    .trim()
    .replace(/(?:'[^']+'|[A-Za-z0-9_ ]+)!/g, '')
  const match = cleaned.match(/^=\s*(SUM|AVERAGE|MAX|MIN|COUNT)\s*\(\s*([A-Z]+)\s*\d+\s*:\s*\2\s*\d+\s*\)\s*$/i)
  return match ? match[2].toUpperCase() : null
}

const normalizeCustomFormulaExpression = (expr) => {
  if (typeof expr !== 'string') return expr
  let next = expr.trim()
  if (next.startsWith('=')) next = next.slice(1).trim()
  // 兼容用户习惯：把 [E]、{E} 统一归一为 E
  next = next.replace(/\[([A-Za-z]{1,3})\]/g, '$1')
  next = next.replace(/\{([A-Za-z]{1,3})\}/g, '$1')
  return next
}

// ── dataRange 规范化辅助（对象→A1字符串 + 行列号 ≥1 夹紧）──
// 所有 create_chart 路径的唯一出口，消除重复逻辑 + 修复 0/负数行列号。
function _colNumToLetter(n) {
  let result = ''
  let tmp = Math.max(1, parseInt(n) || 1)
  while (tmp > 0) {
    tmp--
    result = String.fromCharCode(65 + (tmp % 26)) + result
    tmp = Math.floor(tmp / 26)
  }
  return result
}

function _normalizeDataRangeToA1(dataRange) {
  if (typeof dataRange === 'string') {
    // 对 A1 字符串中的 0/负行号做防御性夹紧
    return dataRange.replace(
      /([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)/,
      (_, sc, sr, ec, er) => {
        const safeStartRow = Math.max(1, parseInt(sr))
        const safeEndRow = Math.max(safeStartRow, parseInt(er))
        return `${sc.toUpperCase()}${safeStartRow}:${ec.toUpperCase()}${safeEndRow}`
      }
    )
  }
  if (!dataRange || typeof dataRange !== 'object') return null

  let sr, sc, er, ec

  if (dataRange.start && dataRange.end) {
    sr = dataRange.start.row ?? dataRange.start.rowIndex ?? 1
    sc = dataRange.start.col ?? dataRange.start.colIndex ?? 1
    er = dataRange.end.row ?? dataRange.end.rowIndex ?? 1
    ec = dataRange.end.col ?? dataRange.end.colIndex ?? 1
  } else if (dataRange.ranges && Array.isArray(dataRange.ranges)) {
    // 多范围取第一段（parseRangeA1 只解析第一段，后续段静默丢弃）
    const first = dataRange.ranges.find(r => r?.start && r?.end)
    if (!first) return null
    sr = first.start.row ?? first.start.rowIndex ?? 1
    sc = first.start.col ?? first.start.colIndex ?? 1
    er = first.end.row ?? first.end.rowIndex ?? 1
    ec = first.end.col ?? first.end.colIndex ?? 1
  } else {
    sr = dataRange.startRow ?? 1
    sc = dataRange.startCol ?? 1
    er = dataRange.endRow ?? 1
    ec = dataRange.endCol ?? 1
  }

  // ≥1 下界夹紧，end 须 ≥ start
  sr = Math.max(1, parseInt(sr) || 1)
  sc = Math.max(1, parseInt(sc) || 1)
  er = Math.max(sr, parseInt(er) || sr)
  ec = Math.max(sc, parseInt(ec) || sc)

  return `${_colNumToLetter(sc)}${sr}:${_colNumToLetter(ec)}${er}`
}

/**
 * 规范化操作参数
 * 统一处理 JSON 字符串、嵌套对象、参数命名转换、类型转换等格式问题
 */
function normalizeParams(params, operationType = '') {
  if (!params || typeof params !== 'object') {
    return params
  }

  // 保持数组结构，递归规范化每个元素，避免把数组错误转成 {"0":...} 对象
  if (Array.isArray(params)) {
    return params.map(item => normalizeParams(item, operationType))
  }
  
  const normalized = {}
  
  for (const [key, value] of Object.entries(params)) {
    // 通用 snake_case -> camelCase 算法转换
    const normalizedKey = snakeToCamel(key)
    // 类型转换和规范化
    let normalizedValue = value

    // apply_custom_formula 的 expression 不是 JSON，跳过 JSON 解析并做表达式归一化
    if (operationType === 'apply_custom_formula' && normalizedKey === 'expression') {
      normalized[normalizedKey] = normalizeCustomFormulaExpression(normalizedValue)
      continue
    }
    
    // 处理 JSON 字符串
    if (typeof normalizedValue === 'string' && (normalizedValue.startsWith('{') || normalizedValue.startsWith('['))) {
      try {
        const parsed = JSON.parse(normalizedValue)
        // 特殊处理：如果解析后是数组（如 columns），直接使用，不递归处理
        if (Array.isArray(parsed)) {
          normalizedValue = parsed
        } else {
          normalizedValue = normalizeParams(parsed, operationType)
        }
      } catch (e) {
        // JSON 解析失败，尝试解析 Python 字典格式（容错处理）
        try {
          // 处理 Python 字典格式：{'column': 12, 'order': 'desc'}
          // 将单引号替换为双引号
          const cleaned = normalizedValue.replace(/'/g, '"')
          const parsed = JSON.parse(cleaned)
          if (Array.isArray(parsed)) {
            normalizedValue = parsed
          } else {
            normalizedValue = normalizeParams(parsed, operationType)
          }
        } catch (e2) {
          // Python 格式解析也失败，保持原值
          console.warn(`normalizeParams: 无法解析 JSON 字符串 (${normalizedKey}):`, normalizedValue.substring(0, 100))
          normalizedValue = value
        }
      }
    }
    // 处理数组
    else if (Array.isArray(normalizedValue)) {
      normalizedValue = normalizedValue.map(item => {
        if (typeof item === 'string' && (item.startsWith('{') || item.startsWith('['))) {
          try {
            return normalizeParams(JSON.parse(item), operationType)
          } catch (e) {
            // JSON 解析失败，尝试 Python 字典格式
            try {
              const cleaned = item.replace(/'/g, '"')
              return normalizeParams(JSON.parse(cleaned), operationType)
            } catch (e2) {
              console.warn('normalizeParams: 无法解析数组元素:', item.substring(0, 100))
              return item
            }
          }
        }
        return normalizeParams(item, operationType)
      })
    }
    // 处理对象
    else if (normalizedValue && typeof normalizedValue === 'object') {
      normalizedValue = normalizeParams(normalizedValue, operationType)
    }
    // 类型转换：字符串数字 -> 数字（针对行号、列号等）
    else if (typeof normalizedValue === 'string' && /^-?\d+$/.test(normalizedValue.trim())) {
      // 检查是否是数字字符串（整数）
      const numValue = parseInt(normalizedValue.trim())
      if (!isNaN(numValue)) {
        // 对于行号、列号等参数，转换为数字
        if (['row', 'col', 'startRow', 'startCol', 'endRow', 'endCol', 'targetRow', 'targetCol'].includes(normalizedKey)) {
          normalizedValue = numValue
        }
      }
    }
    // 类型转换：字符串浮点数 -> 数字（针对高度、宽度等）
    else if (typeof normalizedValue === 'string' && /^-?\d+\.?\d*$/.test(normalizedValue.trim())) {
      const numValue = parseFloat(normalizedValue.trim())
      if (!isNaN(numValue)) {
        // 对于高度、宽度等参数，转换为数字
        if (['height', 'width'].includes(normalizedKey)) {
          normalizedValue = numValue
        }
      }
    }
    // 布尔值转换：字符串 "true"/"false" -> 布尔值
    else if (typeof normalizedValue === 'string') {
      const lowerValue = normalizedValue.toLowerCase().trim()
      if (lowerValue === 'true') {
        normalizedValue = true
      } else if (lowerValue === 'false') {
        normalizedValue = false
      }
    }
    
    normalized[normalizedKey] = normalizedValue
  }
  
  // 特殊处理：sort_range 的 sortColumns 参数（复杂对象数组）
  if (operationType === 'sort_range' && normalized.sortColumns !== undefined) {
    if (typeof normalized.sortColumns === 'string') {
      // 如果还是字符串，尝试解析
      try {
        let parsed = JSON.parse(normalized.sortColumns)
        normalized.sortColumns = Array.isArray(parsed) ? parsed : [parsed]
      } catch (e) {
        // JSON 解析失败，尝试 Python 字典格式
        try {
          const cleaned = normalized.sortColumns.replace(/'/g, '"')
          const parsed = JSON.parse(cleaned)
          normalized.sortColumns = Array.isArray(parsed) ? parsed : [parsed]
        } catch (e2) {
          console.warn('normalizeParams: sortColumns 字符串解析失败', { sortColumns: normalized.sortColumns, error: e2 })
          normalized.sortColumns = []
        }
      }
    }
    // 验证并规范化每个元素
    if (Array.isArray(normalized.sortColumns)) {
      normalized.sortColumns = normalized.sortColumns.map((item, idx) => {
        if (typeof item === 'string') {
          // 尝试解析字符串元素
          try {
            let parsed = JSON.parse(item)
            item = parsed
          } catch (e) {
            try {
              const cleaned = item.replace(/'/g, '"')
              item = JSON.parse(cleaned)
            } catch (e2) {
              console.warn(`normalizeParams: sortColumns[${idx}] 解析失败`, { item, error: e2 })
              return null
            }
          }
        }
        // 确保是对象且包含必要字段
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const col = item.column || item.columnIndex || item.col
          const order = item.order || 'asc'
          return {
            column: typeof col === 'number' ? col : parseInt(col) || 0,
            order: order === 'desc' || order === 'descending' ? 'desc' : 'asc'
          }
        }
        return null
      }).filter(item => item !== null && item.column > 0)
    }
  }
  
  // 特殊处理：set_cell_formula 的列对齐（防止公式列与目标列错位）
  if (operationType === 'set_cell_formula' && typeof normalized.formula === 'string' && typeof normalized.col === 'number') {
    const columnLetters = extractSingleColumnRange(normalized.formula)
    const formulaCol = columnLetters ? columnLettersToNumber(columnLetters) : null
    if (formulaCol && formulaCol !== normalized.col) {
      normalized.col = formulaCol
    }
  }

  // 特殊处理：columns 参数（针对 remove_duplicates）
  // 注意：这个处理应该在循环之后，因为循环中可能已经处理了 JSON 字符串
  if (operationType === 'remove_duplicates') {
    if (normalized.columns === undefined || normalized.columns === null) {
      console.warn('normalizeParams: columns 参数缺失', { params, normalized })
    } else if (typeof normalized.columns === 'string') {
      // 如果还是字符串，尝试解析
      try {
        const parsed = JSON.parse(normalized.columns)
        normalized.columns = Array.isArray(parsed) ? parsed : [parsed]
      } catch (e) {
        // JSON 解析失败，尝试 Python 字典格式
        try {
          const cleaned = normalized.columns.replace(/'/g, '"')
          const parsed = JSON.parse(cleaned)
          normalized.columns = Array.isArray(parsed) ? parsed : [parsed]
        } catch (e2) {
          console.warn('normalizeParams: columns 字符串解析失败', { columns: normalized.columns, error: e2 })
        }
      }
    } else if (!Array.isArray(normalized.columns)) {
      // 如果不是数组，尝试转换
      normalized.columns = [normalized.columns]
    }
  }
  
  // 特殊处理：样式参数（style）
  // ExcelJS 格式：{ font: { bold: true, color: "#FF0000" }, fill: { fgColor: { argb: "#00008B" } } } 
  // -> { bold: true, fontColor: "#FF0000", backgroundColor: "#00008B" }
  if (normalized.style && typeof normalized.style === 'object') {
    const style = normalized.style
    const mappedStyle = { ...style }
    
    // 处理 font 对象
    if (style.font && typeof style.font === 'object') {
      const { font, ...rest } = mappedStyle
      const mappedFont = {}
      
      // ExcelJS 属性名 -> 前端属性名映射
      const fontPropertyMap = {
        'color': 'fontColor',           // ExcelJS: color -> 前端: fontColor
        'bold': 'bold',                 // 保持不变
        'italic': 'italic',             // 保持不变
        'underline': 'underline',       // 保持不变
        'strikethrough': 'strikethrough', // 保持不变
        'size': 'fontSize',             // ExcelJS: size -> 前端: fontSize
        'name': 'fontFamily',           // ExcelJS: name -> 前端: fontFamily
      }
      
      // 映射 font 对象中的属性
      Object.keys(font).forEach(key => {
        const mappedKey = fontPropertyMap[key] || key
        mappedFont[mappedKey] = font[key]
      })
      
      Object.assign(mappedStyle, mappedFont, rest)
    }
    
    // 处理 fill 对象（背景色）
    if (style.fill && typeof style.fill === 'object') {
      const fill = style.fill
      
      // ExcelJS fill 格式：{ fgColor: { argb: "#00008B" } } 或 { fgColor: "#00008B" }
      if (fill.fgColor) {
        if (typeof fill.fgColor === 'object') {
          // 格式：{ argb: "#00008B" } 或 { rgb: "#00008B" } 或 { value: "#00008B" }
          if (fill.fgColor.argb) {
            mappedStyle.backgroundColor = fill.fgColor.argb
          } else if (fill.fgColor.rgb) {
            mappedStyle.backgroundColor = fill.fgColor.rgb
          } else if (fill.fgColor.value) {
            mappedStyle.backgroundColor = fill.fgColor.value
          }
        } else if (typeof fill.fgColor === 'string') {
          // 格式：直接是颜色字符串
          mappedStyle.backgroundColor = fill.fgColor
        }
      } else if (fill.color) {
        // 兼容技能翻译层常用格式：{ fill: { type: 'solid', color: '#RRGGBB' } }
        if (typeof fill.color === 'object') {
          if (fill.color.argb) {
            mappedStyle.backgroundColor = fill.color.argb
          } else if (fill.color.rgb) {
            mappedStyle.backgroundColor = fill.color.rgb
          } else if (fill.color.value) {
            mappedStyle.backgroundColor = fill.color.value
          }
        } else if (typeof fill.color === 'string') {
          mappedStyle.backgroundColor = fill.color
        }
      } else if (fill.patternType && fill.fgColor) {
        // 带图案的填充
        if (typeof fill.fgColor === 'object' && fill.fgColor.argb) {
          mappedStyle.backgroundColor = fill.fgColor.argb
        } else if (typeof fill.fgColor === 'string') {
          mappedStyle.backgroundColor = fill.fgColor
        }
      }
      
      // 从 mappedStyle 中删除 fill，因为已经提取了 backgroundColor
      delete mappedStyle.fill
    }
    
    // 处理直接的 backgroundColor 属性（如果存在）
    // 支持多种可能的属性名：backgroundColor, background, bgColor
    // 注意：这个检查应该在 fill 处理之后，因为 fill 可能已经设置了 backgroundColor
    if (style.backgroundColor && !mappedStyle.backgroundColor) {
      mappedStyle.backgroundColor = style.backgroundColor
    } else if (style.background && !mappedStyle.backgroundColor) {
      mappedStyle.backgroundColor = style.background
    } else if (style.bgColor && !mappedStyle.backgroundColor) {
      mappedStyle.backgroundColor = style.bgColor
    }
    
    // 确保 backgroundColor 是字符串格式（如果是对象，提取值）
    if (mappedStyle.backgroundColor && typeof mappedStyle.backgroundColor === 'object') {
      if (mappedStyle.backgroundColor.argb) {
        mappedStyle.backgroundColor = mappedStyle.backgroundColor.argb
      } else if (mappedStyle.backgroundColor.rgb) {
        mappedStyle.backgroundColor = mappedStyle.backgroundColor.rgb
      } else if (mappedStyle.backgroundColor.value) {
        mappedStyle.backgroundColor = mappedStyle.backgroundColor.value
      }
    }
    
    // 确保 backgroundColor 有 # 前缀（如果缺少）
    if (mappedStyle.backgroundColor && typeof mappedStyle.backgroundColor === 'string') {
      const bgColor = mappedStyle.backgroundColor.trim()
      if (bgColor && !bgColor.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(bgColor)) {
        mappedStyle.backgroundColor = '#' + bgColor
      }
    }
    
    // 处理直接的 color 属性（如果存在且没有 fontColor）
    if (style.color && !mappedStyle.fontColor) {
      mappedStyle.fontColor = style.color
      delete mappedStyle.color
    }
    
    normalized.style = mappedStyle
  }
  
  // 特殊处理：图表创建参数（create_chart）
  // 后端可能发送：{ dataRange: {...} } 或 { dataRange: "A1:F10" }
  // 前端期望：{ dataRange: "A1:F10" }（字符串格式）
  if (operationType === 'create_chart') {
    if (normalized.dataRange != null) {
      const converted = _normalizeDataRangeToA1(normalized.dataRange)
      if (converted) {
        normalized.dataRange = converted
      } else {
        console.warn('normalizeParams: dataRange 无法转换为 A1 字符串', { dataRange: normalized.dataRange })
      }
    }
    
    // 确保 width 和 height 是数字类型
    if (normalized.width !== undefined && normalized.width !== null) {
      normalized.width = typeof normalized.width === 'number' ? normalized.width : parseFloat(normalized.width) || 400
    } else {
      normalized.width = 400
    }
    
    if (normalized.height !== undefined && normalized.height !== null) {
      normalized.height = typeof normalized.height === 'number' ? normalized.height : parseFloat(normalized.height) || 300
    } else {
      normalized.height = 300
    }
  }
  
  // 特殊处理：日期相关参数
  // set_cell_value: value 可能是日期字符串
  if (operationType === 'set_cell_value' && normalized.value) {
    normalized.value = normalizeDateValue(normalized.value)
  }
  
  // fill_series: startValue 可能是日期（如果提供了 startValue 参数）
  if (operationType === 'fill_series' && normalized.startValue !== undefined) {
    normalized.startValue = normalizeDateValue(normalized.startValue)
  }
  
  // set_data_validation: validationParams 可能包含日期范围
  if (operationType === 'set_data_validation' && normalized.validationParams) {
    const validationType = normalized.validationType || normalized.type
    if (validationType === 'date') {
      normalized.validationParams = normalizeValidationParams(validationType, normalized.validationParams)
    }
  }
  
  // set_range_values: values 数组中的值可能是日期
  if (operationType === 'set_range_values' && Array.isArray(normalized.values)) {
    normalized.values = normalized.values.map(row => {
      if (Array.isArray(row)) {
        return row.map(cellValue => normalizeDateValue(cellValue))
      }
      return normalizeDateValue(row)
    })
  }
  
  // 特殊处理：条件格式参数（conditional_format）
  // 后端发送格式：{ ruleType: "greaterThan", ruleParams: '{"value": 5000}', formatStyle: '{"fontColor": "#FF0000"}' }
  // 前端期望格式：{ condition: { type: "greaterThan", value: 5000 }, format: { fontColor: "#FF0000" } }
  if (operationType === 'conditional_format') {
    console.log('normalizeParams: 处理 conditional_format', { normalized, originalParams: params })
    
    // 转换 ruleType 和 ruleParams 为 condition 对象
    if (normalized.ruleType) {
      const condition = { type: normalized.ruleType }
      
      // 解析 ruleParams（可能是 JSON 字符串或对象）
      // 注意：如果 ruleParams 在循环中已经被解析，这里应该已经是对象了
      let ruleParams = normalized.ruleParams
      if (typeof ruleParams === 'string') {
        try {
          ruleParams = JSON.parse(ruleParams)
        } catch (e) {
          console.warn('normalizeParams: 解析 ruleParams 失败', { ruleParams, error: e })
          ruleParams = {}
        }
      }
      
      // 将 ruleParams 的属性合并到 condition 中
      if (ruleParams && typeof ruleParams === 'object') {
        Object.assign(condition, ruleParams)
      }
      
      normalized.condition = condition
      delete normalized.ruleType
      delete normalized.ruleParams
      
      console.log('normalizeParams: condition 转换完成', { condition: normalized.condition })
    }
    
    // 转换 formatStyle 为 format 对象
    if (normalized.formatStyle) {
      let format = normalized.formatStyle
      
      // 解析 formatStyle（可能是 JSON 字符串或对象）
      // 注意：如果 formatStyle 在循环中已经被解析，这里应该已经是对象了
      if (typeof format === 'string') {
        try {
          format = JSON.parse(format)
        } catch (e) {
          console.warn('normalizeParams: 解析 formatStyle 失败', { formatStyle: normalized.formatStyle, error: e })
          format = {}
        }
      }
      
      // 如果 format 是对象，规范化属性名（snake_case -> camelCase）
      if (format && typeof format === 'object') {
        normalized.format = normalizeFormatStyle(format)
      } else {
        normalized.format = format
      }
      
      delete normalized.formatStyle
      
      console.log('normalizeParams: format 转换完成', { format: normalized.format })
    }
    
    // 如果 format 对象直接存在（而不是 formatStyle），也需要规范化
    if (normalized.format && typeof normalized.format === 'object' && !normalized.formatStyle) {
      normalized.format = normalizeFormatStyle(normalized.format)
    }
    
    console.log('normalizeParams: conditional_format 处理完成', { normalized })
  }
  
  // 特殊处理：批量操作中的嵌套操作
  if (operationType === 'batch_operations' && normalized.operations) {
    // 先解析 operations（可能是 JSON 字符串）
    let parsedOperations = normalized.operations
    if (typeof normalized.operations === 'string') {
      try {
        parsedOperations = JSON.parse(normalized.operations)
      } catch (e) {
        console.error('normalizeParams: 解析 batch_operations.operations 失败', {
          operations: normalized.operations,
          error: e
        })
        parsedOperations = []
      }
    }
    
    // 确保是数组
    if (Array.isArray(parsedOperations)) {
      normalized.operations = parsedOperations.map(op => {
        if (!op || typeof op !== 'object') return op
        const nt = normalizeOperationType(op.type)
        const next = nt !== op.type ? { ...op, type: nt } : { ...op }
        if (next.params) {
          return { ...next, params: normalizeParams(next.params, next.type) }
        }
        return next
      })
    } else {
      console.error('normalizeParams: batch_operations.operations 必须是数组', {
        operations: parsedOperations,
        type: typeof parsedOperations
      })
      normalized.operations = []
    }
  }
  
  return normalized
}

/**
 * 发送操作错误反馈到后端
 */
async function sendOperationError(operation, errors, workbook) {
  try {
    // 获取 API base URL
    const getApiBaseUrl = () => {
      const base = resolveApiBaseUrl()
      if (base) return String(base).replace(/\/$/, '')
      if (typeof window !== 'undefined' && window.location?.origin) {
        return window.location.origin
      }
      return null
    }
    
    const baseUrl = getApiBaseUrl()
    if (!baseUrl) {
      console.warn('无法获取 API base URL，跳过错误反馈')
      return
    }
    
    // 获取 session ID（如果可用）
    const sessionId = typeof window !== 'undefined' && window.__EXCEL_SESSION_ID__ 
      ? window.__EXCEL_SESSION_ID__
      : null
    
    if (!sessionId) {
      console.warn('无法获取 session ID，跳过错误反馈')
      return
    }
    
    // 发送错误反馈
    const errorPayload = {
      session_id: sessionId,
      operation: operation,
      errors: errors,
      timestamp: new Date().toISOString(),
      workbook_state: {
        sheets: workbook?.sheets?.map(s => s.name) || [],
        activeSheet: workbook?.activeSheet || null
      }
    }
    
    const response = await fetch(`${baseUrl}/api/excel/operation-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(errorPayload)
    })
    
    if (!response.ok) {
      console.warn('发送错误反馈失败:', response.status, response.statusText)
    } else {
      console.log('错误反馈已发送到后端')
    }
  } catch (error) {
    console.warn('发送错误反馈时出错:', error)
  }
}

function notifyUiOperationError(operation, errors, message) {
  if (typeof window === 'undefined') return
  if (typeof window.__EXCEL_ERROR_CALLBACK__ !== 'function') return
  try {
    window.__EXCEL_ERROR_CALLBACK__(operation, errors, message)
  } catch (e) {
    console.warn('调用全局错误回调失败:', e)
  }
}

/**
 * 执行 Excel 操作
 * @param {Object} workbook - 工作簿对象
 * @param {Object} operation - 操作对象
 * @param {Function} onError - 可选的错误回调函数，接收错误信息字符串
 * @returns {Object} 更新后的工作簿对象
 */
export function executeOperation(workbook, operation, onError = null) {
  const startTime = performance.now()

  // ── 操作类型：camelCase / PascalCase -> snake_case（与 LLM 输出对齐） ──
  if (operation && typeof operation.type === 'string') {
    const nt = normalizeOperationType(operation.type)
    if (nt !== operation.type) {
      operation = { ...operation, type: nt }
    }
  }
  
  // ── 先规范化参数（snake_case -> camelCase / JSON 字符串解析） ──
  if (operation && operation.params) {
    operation = { ...operation, params: normalizeParams(operation.params, operation.type) }
  }

  // 验证操作参数（验证器可能会修改 operation.params，规范化参数）
  const validation = validateOperation(workbook, operation)
  if (!validation.isValid) {
    const validationTime = performance.now() - startTime
    const userError = '抱歉，该操作暂时无法完成，请尝试用更简单的方式描述您的需求。'
    console.error(`[excelOperations] validation failed (${validationTime.toFixed(2)}ms):`, validation.errors)
    console.error('[excelOperations] operation:', JSON.stringify(operation, null, 2))
    sendOperationError(operation, validation.errors, workbook)
    if (onError && typeof onError === 'function') {
      onError(userError)
    } else {
      notifyUiOperationError(operation, validation.errors, userError)
    }
    // 返回原workbook，不执行操作
    return workbook
  }
  
  const validationTime = performance.now() - startTime
  console.log(`[excelOperations] ✅ 操作验证通过 (耗时: ${validationTime.toFixed(2)}ms):`, operation.type)
  // 记录规范化后的参数（用于调试）
  if (operation.type === 'create_pivot_table') {
    console.log('[excelOperations] create_pivot_table 规范化后的参数:', {
      rowFields: operation.params.rowFields,
      valueFields: operation.params.valueFields,
      colFields: operation.params.colFields,
      rowFieldsType: typeof operation.params.rowFields,
      valueFieldsType: typeof operation.params.valueFields,
      rowFieldsIsArray: Array.isArray(operation.params.rowFields),
      valueFieldsIsArray: Array.isArray(operation.params.valueFields)
    })
  }
  
  const type = operation.type
  const normalizedParams = _applyRuntimeSectionSpacing(workbook, type, operation.params || {})
  operation = { ...operation, params: normalizedParams }
  
  const newWorkbook = JSON.parse(JSON.stringify(workbook))
  
  // 记录执行开始
  const executeStartTime = performance.now()
  
  let result
  try {
    switch (type) {
      case 'set_cell_value':
        result = setCellValue(newWorkbook, normalizedParams)
        break
      case 'set_cell_formula':
        result = setCellFormula(newWorkbook, normalizedParams)
        break
      case 'set_cell_style':
        result = setCellStyle(newWorkbook, normalizedParams)
        break
      case 'set_range_values':
        result = setRangeValues(newWorkbook, normalizedParams)
        break
      case 'set_range_style':
        result = setRangeStyle(newWorkbook, normalizedParams)
        break
      case 'merge_cells':
        result = mergeCells(newWorkbook, normalizedParams)
        break
      case 'insert_row':
        result = insertRow(newWorkbook, normalizedParams)
        break
      case 'delete_row':
        result = deleteRow(newWorkbook, normalizedParams)
        break
      case 'insert_column':
        result = insertColumn(newWorkbook, normalizedParams)
        break
      case 'delete_column':
        result = deleteColumn(newWorkbook, normalizedParams)
        break
      case 'set_row_height':
        result = setRowHeight(newWorkbook, normalizedParams)
        break
      case 'set_column_width':
        result = setColumnWidth(newWorkbook, normalizedParams)
        break
      case 'add_sheet':
        result = addSheet(newWorkbook, normalizedParams)
        break
      case 'rename_sheet':
        result = renameSheet(newWorkbook, normalizedParams)
        break
      case 'set_active_sheet':
        result = setActiveSheet(newWorkbook, normalizedParams)
        break
      case 'sort_range':
        result = sortRange(newWorkbook, normalizedParams)
        break
      case 'copy_paste':
        result = copyPaste(newWorkbook, normalizedParams)
        break
      case 'clear_cell':
        result = clearCell(newWorkbook, normalizedParams)
        break
      case 'clear_range':
        result = clearRange(newWorkbook, normalizedParams)
        break
      case 'unmerge_cells':
        result = unmergeCells(newWorkbook, normalizedParams)
        break
      case 'hide_row':
        result = hideRow(newWorkbook, normalizedParams)
        break
      case 'hide_column':
        result = hideColumn(newWorkbook, normalizedParams)
        break
      case 'show_row':
        result = showRow(newWorkbook, normalizedParams)
        break
      case 'show_column':
        result = showColumn(newWorkbook, normalizedParams)
        break
      case 'auto_fit_column':
        result = autoFitColumn(newWorkbook, normalizedParams)
        break
      case 'copy_sheet':
        result = copySheet(newWorkbook, normalizedParams)
        break
      case 'filter_data':
        result = filterData(newWorkbook, normalizedParams)
        break
      case 'remove_filter':
        result = removeFilter(newWorkbook, normalizedParams)
        break
      case 'find_replace':
        result = findReplace(newWorkbook, normalizedParams)
        break
      case 'fill_series':
        result = fillSeries(newWorkbook, normalizedParams)
        break
      case 'remove_duplicates':
        result = removeDuplicates(newWorkbook, normalizedParams)
        break
      case 'summarize_by_column':
        result = summarizeByColumn(newWorkbook, normalizedParams)
        break
      case 'summarize_metrics_by_column':
        result = summarizeMetricsByColumn(newWorkbook, normalizedParams)
        break
      case 'conditional_format':
        result = conditionalFormat(newWorkbook, normalizedParams)
        break
      case 'clear_formatting':
        result = clearFormatting(newWorkbook, normalizedParams)
        break
      case 'clear_conditional_format':
        result = clearConditionalFormat(newWorkbook, normalizedParams)
        break
      case 'create_pivot_data':
        result = createPivotData(newWorkbook, normalizedParams)
        break
      case 'calculate_statistics':
        result = calculateStatistics(newWorkbook, normalizedParams)
        break
      case 'set_data_validation':
        result = setDataValidation(newWorkbook, normalizedParams)
        break
      case 'remove_data_validation':
        result = removeDataValidation(newWorkbook, normalizedParams)
        break
      case 'add_comment':
        result = addComment(newWorkbook, normalizedParams)
        break
      case 'delete_comment':
        result = deleteComment(newWorkbook, normalizedParams)
        break
      case 'update_comment':
        result = updateComment(newWorkbook, normalizedParams)
        break
      case 'set_hyperlink':
        result = setHyperlink(newWorkbook, normalizedParams)
        break
      case 'remove_hyperlink':
        result = removeHyperlink(newWorkbook, normalizedParams)
        break
      case 'insert_image':
        result = insertImage(newWorkbook, normalizedParams)
        break
      case 'delete_image':
        result = deleteImage(newWorkbook, normalizedParams)
        break
      case 'update_image':
        result = updateImage(newWorkbook, normalizedParams)
        break
      case 'insert_shape':
        result = insertShape(newWorkbook, normalizedParams)
        break
      case 'delete_shape':
        result = deleteShape(newWorkbook, normalizedParams)
        break
      case 'update_shape':
        result = updateShape(newWorkbook, normalizedParams)
        break
      case 'create_chart':
        result = createChart(newWorkbook, normalizedParams)
        break
      case 'update_chart':
        result = updateChart(newWorkbook, normalizedParams)
        break
      case 'delete_chart':
        result = deleteChart(newWorkbook, normalizedParams)
        break
      case 'create_pivot_table':
        result = createPivotTable(newWorkbook, normalizedParams)
        break
      case 'update_pivot_table':
        result = updatePivotTable(newWorkbook, normalizedParams)
        break
      case 'delete_pivot_table':
        result = deletePivotTable(newWorkbook, normalizedParams)
        break
      case 'batch_operations':
        // 传递错误回调给批量操作（从executeOperation的参数中获取）
        // 注意：onError是从executeOperation的参数中传递的
        result = executeBatchOperations(newWorkbook, normalizedParams.operations, onError)
        break
      case 'query_unique_values':
        // 只读查询操作：返回唯一值列表，不修改数据
        result = queryUniqueValues(newWorkbook, normalizedParams)
        break
      case 'apply_custom_formula':
        result = applyCustomFormula(newWorkbook, normalizedParams)
        break
      default:
        {
          console.warn(`[excelOperations] unknown operation type: ${type}`)
          const userError = '抱歉，该功能目前还在学习中，暂时无法执行。'
          sendOperationError(operation, [userError], newWorkbook)
          if (onError && typeof onError === 'function') {
            onError(userError)
          } else {
            notifyUiOperationError(operation, [userError], userError)
          }
          result = newWorkbook
        }
    }
    
    // 记录执行时间
    const executeTime = performance.now() - executeStartTime
    const totalTime = performance.now() - startTime
    
    if (executeTime > 100) {
      console.log(
        `[excelOperations] 操作执行完成: type=${type}, ` +
        `执行耗时=${executeTime.toFixed(2)}ms, ` +
        `总耗时=${totalTime.toFixed(2)}ms`
      )
    }
    
    return result
  } catch (error) {
    const executeTime = performance.now() - executeStartTime
    const totalTime = performance.now() - startTime
    console.error(`[excelOperations] execution error: type=${type}, elapsed=${totalTime.toFixed(2)}ms`, error)
    // 技术细节仅保留在 console，面向用户的消息不暴露内部实现
    const userError = error.message?.includes('还在学习中')
      ? error.message
      : '抱歉，该操作暂时无法完成，请尝试用更简单的方式描述您的需求。'
    sendOperationError(operation, [error.message], workbook)
    if (onError && typeof onError === 'function') {
      onError(userError)
    } else {
      notifyUiOperationError(operation, [userError], userError)
    }
    return workbook
  }
}

function getSheet(workbook, sheetName) {
  if (!workbook || !workbook.sheets) {
    throw new Error(`工作表数据异常，请刷新页面后重试。`)
  }

  const sheet = workbook.sheets.find(s => s.name === sheetName)
  if (!sheet) {
    const available = workbook.sheets.map(s => `"${s.name}"`).join('、')
    throw new Error(
      `工作表 "${sheetName}" 不存在（当前工作表：${available}）。` +
      `该工作表可能在 AI 处理过程中被删除或重命名，请稍后重试。`
    )
  }

  return sheet
}

const _RUNTIME_LAYOUT_STATE_KEY = '__sheetbotRuntimeLayoutState'
const _RUNTIME_BLOCK_GAP_ROWS = 2

function _toInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

function _getRuntimeLayoutState(workbook) {
  if (!workbook[_RUNTIME_LAYOUT_STATE_KEY] || typeof workbook[_RUNTIME_LAYOUT_STATE_KEY] !== 'object') {
    workbook[_RUNTIME_LAYOUT_STATE_KEY] = { sheetOffsets: {}, lastCreatedSheet: '' }
  }
  if (!workbook[_RUNTIME_LAYOUT_STATE_KEY].sheetOffsets) {
    workbook[_RUNTIME_LAYOUT_STATE_KEY].sheetOffsets = {}
  }
  if (typeof workbook[_RUNTIME_LAYOUT_STATE_KEY].lastCreatedSheet !== 'string') {
    workbook[_RUNTIME_LAYOUT_STATE_KEY].lastCreatedSheet = ''
  }
  return workbook[_RUNTIME_LAYOUT_STATE_KEY]
}

function _sheetUsedMaxRow(workbook, sheetName) {
  if (!sheetName) return 0
  let sheetObj = null
  try {
    sheetObj = getSheet(workbook, sheetName)
  } catch {
    return 0
  }
  const rows = Object.keys(sheetObj?.data || {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
  const dataMax = rows.length ? Math.max(...rows) : 0
  const declared = Number(sheetObj?.rowCount || 0)
  return Math.max(dataMax, Number.isFinite(declared) ? declared : 0)
}

function _isLikelySectionMarker(workbook, sheetName, params, usedMax) {
  const rowNow = _toInt(params.row)
  const colNow = _toInt(params.col)
  const value = params.value
  if (!sheetName || rowNow === null || colNow === null) return false
  if (rowNow <= 1 || colNow !== 1) return false
  if (typeof value !== 'string' || value.trim() === '') return false
  if (value.includes('\n') || value.includes('\t')) return false
  // 结构判定：仅在“尾部附近新增单元格”时视作新块起点，避免依赖标题关键词
  if (rowNow < Math.max(2, usedMax - 1) || rowNow > usedMax + 2) return false
  let sheetObj = null
  try {
    sheetObj = getSheet(workbook, sheetName)
  } catch {
    return false
  }
  const existing = sheetObj?.data?.[rowNow]?.[colNow]
  const existingVal = existing?.value ?? existing?.formula ?? ''
  return String(existingVal).trim() === ''
}

function _shiftRangeRows(rangeLike, delta) {
  if (!delta || !rangeLike) return rangeLike
  if (typeof rangeLike === 'string') {
    const s = rangeLike.trim()
    const m = s.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/)
    if (m) {
      const sr = Math.max(1, Number(m[2]) + delta)
      const er = Math.max(sr, Number(m[4]) + delta)
      return `${m[1]}${sr}:${m[3]}${er}`
    }
    try {
      const obj = JSON.parse(s)
      return _shiftRangeRows(obj, delta)
    } catch {
      return rangeLike
    }
  }
  if (typeof rangeLike === 'object') {
    const out = { ...rangeLike }
    const sr = _toInt(out.startRow)
    const er = _toInt(out.endRow)
    if (sr !== null) out.startRow = Math.max(1, sr + delta)
    if (er !== null) out.endRow = Math.max(out.startRow || 1, er + delta)
    if (out.start && typeof out.start === 'object') {
      const rs = _toInt(out.start.row)
      if (rs !== null) out.start = { ...out.start, row: Math.max(1, rs + delta) }
    }
    if (out.end && typeof out.end === 'object') {
      const re = _toInt(out.end.row)
      if (re !== null) out.end = { ...out.end, row: Math.max(1, re + delta) }
    }
    return out
  }
  return rangeLike
}

function _applyRuntimeSectionSpacing(workbook, opType, params) {
  const p = { ...(params || {}) }
  const state = _getRuntimeLayoutState(workbook)
  const offsets = state.sheetOffsets || {}

  const shiftByDelta = (delta) => {
    const bump = (key) => {
      const v = _toInt(p[key])
      if (v !== null) p[key] = Math.max(1, v + delta)
    }
    if (opType === 'set_cell_value' || opType === 'set_cell_style') {
      bump('row')
      return
    }
    if (
      opType === 'set_range_values' || opType === 'set_range_style' || opType === 'clear_formatting' ||
      opType === 'conditional_format' || opType === 'merge_cells' || opType === 'unmerge_cells'
    ) {
      bump('startRow'); bump('start_row'); bump('endRow'); bump('end_row')
      return
    }
    if (
      opType === 'summarize_metrics_by_column' ||
      opType === 'summarize_by_column' ||
      opType === 'create_pivot_data' ||
      opType === 'create_pivot_table'
    ) {
      bump('targetRow'); bump('target_row')
      return
    }
    if (opType === 'create_chart') {
      bump('row')
      if (p.dataRange !== undefined) p.dataRange = _shiftRangeRows(p.dataRange, delta)
      if (p.data_range !== undefined) p.data_range = _shiftRangeRows(p.data_range, delta)
    }
  }

  const sheetName = String(p.sheet || '').trim()
  const targetSheet = String(p.targetSheet || p.target_sheet || '').trim()
  if (opType === 'add_sheet') {
    const created = String(p.name || '').trim()
    if (created) state.lastCreatedSheet = created
  }

  // 通用目标表继承：有 targetRow 但未指定 target_sheet 时，默认落到最近创建的结果表
  if (
    (opType === 'summarize_metrics_by_column' || opType === 'summarize_by_column' || opType === 'create_pivot_data') &&
    !targetSheet &&
    (_toInt(p.targetRow) !== null || _toInt(p.target_row) !== null) &&
    state.lastCreatedSheet
  ) {
    p.targetSheet = state.lastCreatedSheet
    p.target_sheet = state.lastCreatedSheet
  }

  const effectSheet = String(p.targetSheet || p.target_sheet || '').trim() || sheetName
  const currentDelta = Number(offsets[effectSheet] || 0)
  if (currentDelta) shiftByDelta(currentDelta)

  // 新块起点：按真实已渲染末行推进到 max_row + 3（留2空行）
  if (opType === 'set_cell_value' && effectSheet) {
    const rowNow = _toInt(p.row) || 1
    if (rowNow > 1) {
      const usedMax = _sheetUsedMaxRow(workbook, effectSheet)
      const minRow = usedMax > 0 ? usedMax + _RUNTIME_BLOCK_GAP_ROWS + 1 : rowNow
      if (_isLikelySectionMarker(workbook, effectSheet, p, usedMax) && rowNow < minRow) {
        const extra = minRow - rowNow
        offsets[effectSheet] = Number(offsets[effectSheet] || 0) + extra
        p.row = minRow
      }
    }
  }

  state.sheetOffsets = offsets
  return p
}

// ── 公共 API：检测工作表数据的表头行号 ──
// 供外部组件（AIAssistant/ConnectView 等）获取正确的列标题行，
// 替代硬编码 `data[1]`。逻辑与内部 _findHeaderRow 一致（DISTINCT 计数）。
export function detectSheetHeaderRow(sheetData) {
  if (!sheetData || typeof sheetData !== 'object') return 1
  const rowKeys = Object.keys(sheetData)
    .map(Number).filter(n => !isNaN(n) && n > 0).sort((a, b) => a - b)
  for (let i = 0; i < Math.min(rowKeys.length, 6); i++) {
    const r = rowKeys[i]
    const rd = sheetData[r]
    if (!rd || typeof rd !== 'object') continue
    const seen = new Set()
    for (const c of Object.values(rd)) {
      if (c?.value != null && c.value !== '') seen.add(String(c.value))
    }
    if (seen.size >= 3) return r
  }
  return rowKeys[0] || 1
}

// ── 智能表头行定位：从 startRow 附近找到真正的列标题行 ──
// ExcelJS 对合并从属单元格返回主单元格值 → 用 DISTINCT 计数消除虚高
function _findHeaderRow(sheetData, startRow) {
  // ExcelJS 对合并从属单元格返回主单元格的值，合并标题行所有列
  // 都是相同值 → 旧 _cellCount 虚高 → 误判为表头。
  // 改用 DISTINCT 非空值计数：合并标题行 = 1，真实列标题行 >= 3。
  const _cellCount = (r) => {
    const rd = sheetData?.[r]
    if (!rd || typeof rd !== 'object') return 0
    const seen = new Set()
    for (const c of Object.values(rd)) {
      if (c?.value != null && c.value !== '') seen.add(String(c.value))
    }
    return seen.size
  }
  const safeStart = Math.max(1, parseInt(startRow, 10) || 1)
  const scanTop = Math.max(1, safeStart - 1)
  const scanBottom = safeStart + 12

  // 优先找“像列标题”的行：
  // - 当前行非空列 >= 3（避免把单行大标题当表头）
  // - 下一行也有数据（避免把孤立说明行当表头）
  for (let r = scanTop; r <= scanBottom; r++) {
    const curr = _cellCount(r)
    const next = _cellCount(r + 1)
    if (curr >= 3 && next >= 1) {
      return { headerRow: r, dataStartRow: r + 1 }
    }
  }

  // 回退策略：取扫描窗口里非空列最多的一行作为表头
  let bestRow = safeStart
  let bestCount = -1
  for (let r = scanTop; r <= scanBottom; r++) {
    const cnt = _cellCount(r)
    if (cnt > bestCount) {
      bestCount = cnt
      bestRow = r
    }
  }
  return { headerRow: bestRow, dataStartRow: bestRow + 1 }
}

function setCellValue(workbook, { sheet, row, col, value }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.data[row]) sheetObj.data[row] = {}
  if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
  // 规范化日期值（如果是日期字符串，统一为 YYYY-MM-DD 格式）
  const normalizedValue = normalizeDateValue(value)
  if (typeof normalizedValue === 'number' && Number.isFinite(normalizedValue)) {
    const cell = computedNumberCell(normalizedValue)
    sheetObj.data[row][col].value = cell.value
    if (cell.style?.numberFormat) {
      if (!sheetObj.data[row][col].style) sheetObj.data[row][col].style = {}
      sheetObj.data[row][col].style.numberFormat = cell.style.numberFormat
    }
  } else {
    sheetObj.data[row][col].value = normalizedValue
  }
  delete sheetObj.data[row][col].formula
  return workbook
}

function setCellFormula(workbook, { sheet, row, col, formula }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.data[row]) sheetObj.data[row] = {}
  if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
  sheetObj.data[row][col].formula = formula

  // 尝试对简单聚合公式求值，使预览区能显示计算结果
  const computed = evaluateSimpleFormula(formula, sheetObj)
  if (computed !== null) sheetObj.data[row][col].value = computed

  return workbook
}

// ============================================================================
// 简单公式求值器（前端沙箱用，支持 SUM/AVERAGE/MAX/MIN/COUNT/COUNTA）
// ============================================================================

function evaluateSimpleFormula(formula, sheetObj) {
  if (!formula || typeof formula !== 'string') return null
  const cleaned = formula.trim().replace(/(?:'[^']+'|[A-Za-z0-9_ ]+)!/g, '')

  const match = cleaned.match(
    /^=\s*(SUM|AVERAGE|MAX|MIN|COUNT|COUNTA)\s*\(\s*([A-Z]+)(\d+)\s*:\s*([A-Z]+)(\d+)\s*\)\s*$/i
  )
  if (!match) return null

  const func = match[1].toUpperCase()
  const c1 = columnLettersToNumber(match[2])
  const r1 = parseInt(match[3], 10)
  const c2 = columnLettersToNumber(match[4])
  const r2 = parseInt(match[5], 10)
  if (!c1 || !c2 || !r1 || !r2) return null

  const startRow = Math.min(r1, r2), endRow = Math.max(r1, r2)
  const startCol = Math.min(c1, c2), endCol = Math.max(c1, c2)

  const nums = []
  let totalCells = 0
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      totalCells++
      const v = sheetObj.data?.[r]?.[c]?.value
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v)
        if (!Number.isNaN(n)) nums.push(n)
      }
    }
  }

  if (func === 'COUNT') return nums.length
  if (func === 'COUNTA') {
    let count = 0
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const v = sheetObj.data?.[r]?.[c]?.value
        if (v !== undefined && v !== null && v !== '') count++
      }
    }
    return count
  }

  if (nums.length === 0) return 0

  switch (func) {
    case 'SUM':     return roundComputedNumber(nums.reduce((a, b) => a + b, 0))
    case 'AVERAGE': return roundComputedNumber(nums.reduce((a, b) => a + b, 0) / nums.length)
    case 'MAX':     return roundComputedNumber(Math.max(...nums))
    case 'MIN':     return roundComputedNumber(Math.min(...nums))
    default:        return null
  }
}

function setCellStyle(workbook, { sheet, row, col, style }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.data[row]) sheetObj.data[row] = {}
  if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
  if (!sheetObj.data[row][col].style) sheetObj.data[row][col].style = {}
  
  // 参数已在 normalizeParams 中规范化，直接应用样式
  if (style && typeof style === 'object') {
    const normalizedStyle = { ...style }
    // 兼容别名：align/valign 优先映射到标准字段，避免被旧值覆盖
    if (normalizedStyle.align !== undefined) {
      normalizedStyle.horizontalAlignment = normalizedStyle.align
      delete normalizedStyle.align
    }
    if (normalizedStyle.valign !== undefined) {
      normalizedStyle.verticalAlignment = normalizedStyle.valign
      delete normalizedStyle.valign
    }

    Object.keys(normalizedStyle).forEach(key => {
      if (key === 'numberFormat' && normalizedStyle[key] !== undefined && normalizedStyle[key] !== null && normalizedStyle[key] !== '') {
        sheetObj.data[row][col].style[key] = _resolveNumFmt(String(normalizedStyle[key]))
      } else {
        sheetObj.data[row][col].style[key] = normalizedStyle[key]
      }
    })
  }
  
  return workbook
}

function setRangeValues(workbook, { sheet, startRow, startCol, values }) {
  const sheetObj = getSheet(workbook, sheet)
  
  // 如果 values 是字符串，尝试解析为 JSON
  let parsedValues = values
  if (typeof values === 'string') {
    try {
      // 先尝试直接解析 JSON
      parsedValues = JSON.parse(values)
    } catch (e) {
      // 如果不是有效的 JSON，可能是 Python 列表推导式字符串
      // 例如: "[[\"=E2*D2\"] for _ in range(149)]"
      // 尝试提取其中的数组部分
      console.warn('setRangeValues: JSON 解析失败，尝试其他格式', { values, error: e })
      
      // 检查是否包含 Python 列表推导式模式
      const listComprehensionMatch = values.match(/\[\[.*?\]\]/)
      if (listComprehensionMatch) {
        // 提取数组部分并尝试解析
        try {
          const arrayStr = listComprehensionMatch[0]
          parsedValues = JSON.parse(arrayStr)
        } catch (e2) {
          console.error('setRangeValues: 无法解析 values', { values, error: e2 })
          return workbook
        }
      } else {
        console.error('setRangeValues: 无法解析 values 格式', { values, error: e })
        return workbook
      }
    }
  }
  
  // 确保 parsedValues 是数组
  if (!Array.isArray(parsedValues)) {
    console.error('values must be an array, got:', typeof parsedValues)
    return workbook
  }
  
  parsedValues.forEach((row, i) => {
    // 如果 row 是字符串，尝试解析为数组
    let parsedRow = row
    if (typeof row === 'string') {
      try {
        parsedRow = JSON.parse(row)
      } catch (e) {
        // 如果不是 JSON，当作单个值处理
        parsedRow = [row]
      }
    }
    
    // 确保 parsedRow 是数组
    if (!Array.isArray(parsedRow)) {
      parsedRow = [parsedRow]
    }
    
    parsedRow.forEach((value, j) => {
      const rowNum = startRow + i
      const colNum = startCol + j
      if (!sheetObj.data[rowNum]) sheetObj.data[rowNum] = {}
      if (!sheetObj.data[rowNum][colNum]) sheetObj.data[rowNum][colNum] = {}
      
      // 如果值是公式（以 = 开头），设置为 formula，否则设置为 value
      if (typeof value === 'string' && value.startsWith('=')) {
        sheetObj.data[rowNum][colNum].formula = value
        delete sheetObj.data[rowNum][colNum].value
      } else {
        if (typeof value === 'number' && Number.isFinite(value)) {
          const cell = computedNumberCell(value)
          sheetObj.data[rowNum][colNum].value = cell.value
          if (cell.style?.numberFormat) {
            if (!sheetObj.data[rowNum][colNum].style) sheetObj.data[rowNum][colNum].style = {}
            sheetObj.data[rowNum][colNum].style.numberFormat = cell.style.numberFormat
          }
        } else {
          sheetObj.data[rowNum][colNum].value = value
        }
        delete sheetObj.data[rowNum][colNum].formula
      }
    })
  })
  return workbook
}

function setRangeStyle(workbook, { sheet, startRow, startCol, endRow, endCol, style }) {
  
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj) {
    console.error('setRangeStyle: 找不到工作表', { sheet, availableSheets: workbook.sheets?.map(s => s.name) })
    return workbook
  }
  
  // 参数已在 normalizeParams 中规范化，直接应用样式
  if (!style || typeof style !== 'object') {
    console.warn('setRangeStyle: style 参数无效', { style, styleType: typeof style })
    return workbook
  }
  
  // 移除冗余日志，关键信息已在上面记录
  
  // 确保 sheetObj.data 存在
  if (!sheetObj.data) {
    sheetObj.data = {}
  }
  
  let appliedCount = 0
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (!sheetObj.data[row]) {
        sheetObj.data[row] = {}
      }
      if (!sheetObj.data[row][col]) {
        sheetObj.data[row][col] = {}
      }
      if (!sheetObj.data[row][col].style) {
        sheetObj.data[row][col].style = {}
      }
      
      // 应用样式 - 使用深拷贝确保样式对象被正确复制
      const styleToApply = JSON.parse(JSON.stringify(style))
      if (styleToApply.align !== undefined) {
        styleToApply.horizontalAlignment = styleToApply.align
        delete styleToApply.align
      }
      if (styleToApply.valign !== undefined) {
        styleToApply.verticalAlignment = styleToApply.valign
        delete styleToApply.valign
      }
      
      // 确保样式对象的所有属性都被正确应用
      Object.keys(styleToApply).forEach(key => {
        const value = styleToApply[key]
        // 特别处理 backgroundColor：确保不是 undefined 或 null
        if (key === 'backgroundColor') {
          if (value === undefined || value === null || value === '') {
            console.warn(`setRangeStyle: 跳过无效的 backgroundColor (${row}, ${col})`, {
              value,
              type: typeof value
            })
            return // 跳过无效值
          }
          // 确保 backgroundColor 是字符串格式
          const bgColorValue = typeof value === 'string' ? value : String(value)
          sheetObj.data[row][col].style[key] = bgColorValue
        } else if (key === 'numberFormat') {
          if (value !== undefined && value !== null && value !== '') {
            sheetObj.data[row][col].style[key] = _resolveNumFmt(String(value))
          }
        } else {
          sheetObj.data[row][col].style[key] = value
        }
      })
      
      appliedCount++
    }
  }
  
  
  return workbook
}

function mergeCells(workbook, { sheet, startRow, startCol, endRow, endCol }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.mergedCells) sheetObj.mergedCells = []
  sheetObj.mergedCells.push({ startRow, startCol, endRow, endCol })
  return workbook
}

function insertRow(workbook, { sheet, row, count = 1 }) {
  const sheetObj = getSheet(workbook, sheet)
  const rowNumToShift = Number(row)
  const shift = Number(count) || 1
  const data = sheetObj.data || {}

  const shiftFormulaRowRefs = (formula, pivotRow, delta) => {
    if (!formula || typeof formula !== 'string' || !formula.startsWith('=')) return formula
    return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, absCol, letters, absRow, refRow) => {
      const oldRow = Number(refRow)
      if (!Number.isFinite(oldRow) || oldRow < pivotRow) return m
      return `${absCol}${letters}${absRow}${oldRow + delta}`
    })
  }
  const shiftRangeRows = (startRow, endRow, pivotRow, delta) => {
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) return { startRow, endRow }
    if (endRow < pivotRow) return { startRow, endRow }
    if (startRow >= pivotRow) return { startRow: startRow + delta, endRow: endRow + delta }
    return { startRow, endRow: endRow + delta }
  }

  const newData = {}
  Object.keys(data).forEach(key => {
    const oldRow = Number(key)
    if (!Number.isFinite(oldRow)) return
    const targetRow = oldRow >= rowNumToShift ? oldRow + shift : oldRow
    const rowData = data[key] || {}
    const nextRowData = {}
    Object.keys(rowData).forEach(colKey => {
      const cell = rowData[colKey]
      const nextCell = cell && typeof cell === 'object' ? { ...cell } : cell
      if (nextCell?.formula) {
        nextCell.formula = shiftFormulaRowRefs(nextCell.formula, rowNumToShift, shift)
      }
      nextRowData[colKey] = nextCell
    })
    newData[targetRow] = nextRowData
  })
  sheetObj.data = newData

  if (sheetObj.rowHeights && typeof sheetObj.rowHeights === 'object') {
    const nextRowHeights = {}
    Object.entries(sheetObj.rowHeights).forEach(([k, v]) => {
      const oldRow = Number(k)
      if (!Number.isFinite(oldRow)) return
      const targetRow = oldRow >= rowNumToShift ? oldRow + shift : oldRow
      nextRowHeights[targetRow] = v
    })
    sheetObj.rowHeights = nextRowHeights
  }

  if (Array.isArray(sheetObj.hiddenRows)) {
    sheetObj.hiddenRows = sheetObj.hiddenRows.map((r) => {
      const rowNumber = Number(r)
      if (!Number.isFinite(rowNumber)) return r
      return rowNumber >= rowNumToShift ? rowNumber + shift : rowNumber
    })
  }

  if (Array.isArray(sheetObj.mergedCells)) {
    sheetObj.mergedCells = sheetObj.mergedCells.map((m) => {
      const shifted = shiftRangeRows(Number(m?.startRow), Number(m?.endRow), rowNumToShift, shift)
      return { ...m, startRow: shifted.startRow, endRow: shifted.endRow }
    })
  }

  if (Array.isArray(sheetObj.dataValidations)) {
    sheetObj.dataValidations = sheetObj.dataValidations.map((v) => {
      const shifted = shiftRangeRows(Number(v?.startRow), Number(v?.endRow), rowNumToShift, shift)
      return { ...v, startRow: shifted.startRow, endRow: shifted.endRow }
    })
  }

  if (Array.isArray(sheetObj.conditionalFormats)) {
    sheetObj.conditionalFormats = sheetObj.conditionalFormats.map((cf) => {
      const shifted = shiftRangeRows(Number(cf?.startRow), Number(cf?.endRow), rowNumToShift, shift)
      return { ...cf, startRow: shifted.startRow, endRow: shifted.endRow }
    })
  }

  if (Array.isArray(sheetObj.charts)) {
    sheetObj.charts = sheetObj.charts.map((chart) => {
      const chartRow = Number(chart?.row)
      if (!Number.isFinite(chartRow) || chartRow < rowNumToShift) return chart
      return { ...chart, row: chartRow + shift }
    })
  }

  sheetObj.rowCount = (sheetObj.rowCount || 0) + count
  return workbook
}

function deleteRow(workbook, { sheet, row, count = 1 }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj || !sheetObj.data) {
    console.error('deleteRow: 工作表不存在或数据为空', { sheet, sheetObj })
    return workbook
  }
  const startRowToDelete = Number(row)
  const deleteCount = Number(count) || 1
  const endRowToDelete = startRowToDelete + deleteCount - 1

  const shiftFormulaRowRefs = (formula, deleteEndRow, delta) => {
    if (!formula || typeof formula !== 'string' || !formula.startsWith('=')) return formula
    return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, absCol, letters, absRow, refRow) => {
      const oldRow = Number(refRow)
      if (!Number.isFinite(oldRow)) return m
      if (oldRow > deleteEndRow) return `${absCol}${letters}${absRow}${oldRow + delta}`
      return m
    })
  }
  const shiftRangeRowsForDelete = (startRow, endRow, deleteStart, deleteEnd, delta) => {
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow)) return null
    if (endRow < deleteStart) return { startRow, endRow }
    if (startRow > deleteEnd) return { startRow: startRow + delta, endRow: endRow + delta }

    const topStart = startRow
    const topEnd = Math.min(endRow, deleteStart - 1)
    const hasTop = topEnd >= topStart
    const bottomStart = Math.max(startRow, deleteEnd + 1)
    const bottomEnd = endRow
    const hasBottom = bottomEnd >= bottomStart
    if (!hasTop && !hasBottom) return null

    const nextStart = hasTop ? topStart : deleteStart
    const nextEnd = hasBottom ? (bottomEnd + delta) : topEnd
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd < nextStart) return null
    return { startRow: nextStart, endRow: nextEnd }
  }

  const newData = {}

  Object.keys(sheetObj.data).forEach(key => {
    const rowNum = parseInt(key)
    if (isNaN(rowNum)) {
      // 跳过非数字键（保留非数字键的数据，如果有）
      return
    }
    
    if (rowNum < startRowToDelete) {
      // 删除行之前的行，保持不变
      newData[rowNum] = sheetObj.data[key]
    } else if (rowNum > endRowToDelete) {
      // 删除行之后的行，向上移动
      const newRowNum = rowNum - deleteCount
      newData[newRowNum] = sheetObj.data[key]
    }
    // rowNum >= startRowToDelete && rowNum <= endRowToDelete 的行被删除
  })
  
  // 更新所有公式中的行号引用
  Object.keys(newData).forEach(rowKey => {
    const rowNum = parseInt(rowKey)
    if (isNaN(rowNum)) return
    
    const rowData = newData[rowNum]
    if (!rowData) return
    
    Object.keys(rowData).forEach(colKey => {
      const cell = rowData[colKey]
      if (cell && cell.formula && typeof cell.formula === 'string') {
        cell.formula = shiftFormulaRowRefs(cell.formula, endRowToDelete, -deleteCount)
      }
    })
  })
  
  // 确保数据对象被完全替换，而不是部分更新
  sheetObj.data = newData

  if (sheetObj.rowHeights && typeof sheetObj.rowHeights === 'object') {
    const nextRowHeights = {}
    Object.entries(sheetObj.rowHeights).forEach(([k, v]) => {
      const oldRow = Number(k)
      if (!Number.isFinite(oldRow)) return
      if (oldRow >= startRowToDelete && oldRow <= endRowToDelete) return
      const targetRow = oldRow > endRowToDelete ? oldRow - deleteCount : oldRow
      nextRowHeights[targetRow] = v
    })
    sheetObj.rowHeights = nextRowHeights
  }

  if (Array.isArray(sheetObj.hiddenRows)) {
    sheetObj.hiddenRows = sheetObj.hiddenRows
      .map(Number)
      .filter((r) => Number.isFinite(r) && (r < startRowToDelete || r > endRowToDelete))
      .map((r) => (r > endRowToDelete ? r - deleteCount : r))
  }

  if (Array.isArray(sheetObj.mergedCells)) {
    sheetObj.mergedCells = sheetObj.mergedCells
      .map((m) => {
        const shifted = shiftRangeRowsForDelete(Number(m?.startRow), Number(m?.endRow), startRowToDelete, endRowToDelete, -deleteCount)
        return shifted ? { ...m, startRow: shifted.startRow, endRow: shifted.endRow } : null
      })
      .filter(Boolean)
  }

  if (Array.isArray(sheetObj.dataValidations)) {
    sheetObj.dataValidations = sheetObj.dataValidations
      .map((v) => {
        const shifted = shiftRangeRowsForDelete(Number(v?.startRow), Number(v?.endRow), startRowToDelete, endRowToDelete, -deleteCount)
        return shifted ? { ...v, startRow: shifted.startRow, endRow: shifted.endRow } : null
      })
      .filter(Boolean)
  }

  if (Array.isArray(sheetObj.conditionalFormats)) {
    sheetObj.conditionalFormats = sheetObj.conditionalFormats
      .map((cf) => {
        const shifted = shiftRangeRowsForDelete(Number(cf?.startRow), Number(cf?.endRow), startRowToDelete, endRowToDelete, -deleteCount)
        return shifted ? { ...cf, startRow: shifted.startRow, endRow: shifted.endRow } : null
      })
      .filter(Boolean)
  }

  if (Array.isArray(sheetObj.charts)) {
    sheetObj.charts = sheetObj.charts.map((chart) => {
      const chartRow = Number(chart?.row)
      if (!Number.isFinite(chartRow)) return chart
      if (chartRow > endRowToDelete) return { ...chart, row: chartRow - deleteCount }
      if (chartRow >= startRowToDelete) return { ...chart, row: startRowToDelete }
      return chart
    })
  }

  sheetObj.rowCount = Math.max(0, (sheetObj.rowCount || 0) - deleteCount)
  
  return workbook
}

function insertColumn(workbook, { sheet, col, count = 1 }) {
  const sheetObj = getSheet(workbook, sheet)
  const colNumToLetters = (num) => {
    let n = Number(num) || 0
    if (n <= 0) return 'A'
    let out = ''
    while (n > 0) {
      n -= 1
      out = String.fromCharCode(65 + (n % 26)) + out
      n = Math.floor(n / 26)
    }
    return out
  }
  const shiftRangeColumns = (startCol, endCol, pivotCol, delta) => {
    if (!Number.isFinite(startCol) || !Number.isFinite(endCol)) return { startCol, endCol }
    if (endCol < pivotCol) return { startCol, endCol }
    if (startCol >= pivotCol) return { startCol: startCol + delta, endCol: endCol + delta }
    return { startCol, endCol: endCol + delta }
  }
  const shiftFormulaColRefs = (formula, pivotCol, delta) => {
    if (!formula || typeof formula !== 'string' || !formula.startsWith('=')) return formula
    return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, absCol, letters, absRow, rowNum) => {
      const oldCol = columnLettersToNumber(letters)
      if (!oldCol || oldCol < pivotCol) return m
      const nextCol = oldCol + delta
      return `${absCol}${colNumToLetters(nextCol)}${absRow}${rowNum}`
    })
  }

  Object.keys(sheetObj.data).forEach(rowKey => {
    const rowData = sheetObj.data[rowKey]
    const newRowData = {}
    Object.keys(rowData).forEach(colKey => {
      const oldCol = parseInt(colKey)
      const cell = rowData[colKey]
      const targetCol = oldCol >= col ? oldCol + count : oldCol
      const nextCell = cell && typeof cell === 'object' ? { ...cell } : cell
      if (nextCell?.formula) {
        nextCell.formula = shiftFormulaColRefs(nextCell.formula, col, count)
      }
      newRowData[targetCol] = nextCell
    })
    sheetObj.data[rowKey] = newRowData
  })

  if (sheetObj.colWidths && typeof sheetObj.colWidths === 'object') {
    const nextColWidths = {}
    Object.entries(sheetObj.colWidths).forEach(([k, v]) => {
      const oldCol = Number(k)
      if (!Number.isFinite(oldCol)) return
      const targetCol = oldCol >= col ? oldCol + count : oldCol
      nextColWidths[targetCol] = v
    })
    sheetObj.colWidths = nextColWidths
  }

  if (Array.isArray(sheetObj.mergedCells)) {
    sheetObj.mergedCells = sheetObj.mergedCells.map(m => {
      const startCol = Number(m?.startCol)
      const endCol = Number(m?.endCol)
      const shifted = shiftRangeColumns(startCol, endCol, col, count)
      return { ...m, startCol: shifted.startCol, endCol: shifted.endCol }
    })
  }

  if (Array.isArray(sheetObj.dataValidations)) {
    sheetObj.dataValidations = sheetObj.dataValidations.map(v => {
      const startCol = Number(v?.startCol)
      const endCol = Number(v?.endCol)
      const shifted = shiftRangeColumns(startCol, endCol, col, count)
      return { ...v, startCol: shifted.startCol, endCol: shifted.endCol }
    })
  }

  if (Array.isArray(sheetObj.conditionalFormats)) {
    sheetObj.conditionalFormats = sheetObj.conditionalFormats.map(cf => {
      const startCol = Number(cf?.startCol)
      const endCol = Number(cf?.endCol)
      const shifted = shiftRangeColumns(startCol, endCol, col, count)
      return { ...cf, startCol: shifted.startCol, endCol: shifted.endCol }
    })
  }

  if (Array.isArray(sheetObj.charts)) {
    sheetObj.charts = sheetObj.charts.map(chart => {
      const chartCol = Number(chart?.col)
      if (!Number.isFinite(chartCol) || chartCol < col) return chart
      return { ...chart, col: chartCol + count }
    })
  }

  sheetObj.colCount = (sheetObj.colCount || 0) + count
  return workbook
}

function deleteColumn(workbook, { sheet, col, count = 1 }) {
  const sheetObj = getSheet(workbook, sheet)
  const endCol = col + count - 1
  const colNumToLetters = (num) => {
    let n = Number(num) || 0
    if (n <= 0) return 'A'
    let out = ''
    while (n > 0) {
      n -= 1
      out = String.fromCharCode(65 + (n % 26)) + out
      n = Math.floor(n / 26)
    }
    return out
  }
  const shiftFormulaColRefs = (formula, pivotCol, deleteEndCol, delta) => {
    if (!formula || typeof formula !== 'string' || !formula.startsWith('=')) return formula
    return formula.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, absCol, letters, absRow, rowNum) => {
      const oldCol = columnLettersToNumber(letters)
      if (!oldCol) return m
      if (oldCol > deleteEndCol) {
        return `${absCol}${colNumToLetters(oldCol + delta)}${absRow}${rowNum}`
      }
      // 引用到被删除列时保持原样（简化策略）
      return m
    })
  }
  const shiftRangeColumnsForDelete = (startCol, endColInRange, deleteStart, deleteEnd, delta) => {
    if (!Number.isFinite(startCol) || !Number.isFinite(endColInRange)) return null
    if (endColInRange < deleteStart) {
      return { startCol, endCol: endColInRange }
    }
    if (startCol > deleteEnd) {
      return { startCol: startCol + delta, endCol: endColInRange + delta }
    }

    const leftStart = startCol
    const leftEnd = Math.min(endColInRange, deleteStart - 1)
    const hasLeft = leftEnd >= leftStart
    const rightStart = Math.max(startCol, deleteEnd + 1)
    const rightEnd = endColInRange
    const hasRight = rightEnd >= rightStart
    if (!hasLeft && !hasRight) return null

    const nextStart = hasLeft ? leftStart : deleteStart
    const nextEnd = hasRight ? (rightEnd + delta) : leftEnd
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd < nextStart) return null
    return { startCol: nextStart, endCol: nextEnd }
  }

  Object.keys(sheetObj.data).forEach(rowKey => {
    const rowData = sheetObj.data[rowKey]
    const newRowData = {}
    Object.keys(rowData).forEach(colKey => {
      const oldCol = parseInt(colKey)
      if (oldCol >= col && oldCol <= endCol) return
      const targetCol = oldCol > endCol ? oldCol - count : oldCol
      const cell = rowData[colKey]
      const nextCell = cell && typeof cell === 'object' ? { ...cell } : cell
      if (nextCell?.formula) {
        nextCell.formula = shiftFormulaColRefs(nextCell.formula, col, endCol, -count)
      }
      newRowData[targetCol] = nextCell
    })
    sheetObj.data[rowKey] = newRowData
  })

  if (sheetObj.colWidths && typeof sheetObj.colWidths === 'object') {
    const nextColWidths = {}
    Object.entries(sheetObj.colWidths).forEach(([k, v]) => {
      const oldCol = Number(k)
      if (!Number.isFinite(oldCol)) return
      if (oldCol >= col && oldCol <= endCol) return
      const targetCol = oldCol > endCol ? oldCol - count : oldCol
      nextColWidths[targetCol] = v
    })
    sheetObj.colWidths = nextColWidths
  }

  if (Array.isArray(sheetObj.mergedCells)) {
    sheetObj.mergedCells = sheetObj.mergedCells
      .map(m => {
        const shifted = shiftRangeColumnsForDelete(Number(m?.startCol), Number(m?.endCol), col, endCol, -count)
        return shifted ? { ...m, startCol: shifted.startCol, endCol: shifted.endCol } : null
      })
      .filter(Boolean)
  }

  if (Array.isArray(sheetObj.dataValidations)) {
    sheetObj.dataValidations = sheetObj.dataValidations
      .map(v => {
        const shifted = shiftRangeColumnsForDelete(Number(v?.startCol), Number(v?.endCol), col, endCol, -count)
        return shifted ? { ...v, startCol: shifted.startCol, endCol: shifted.endCol } : null
      })
      .filter(Boolean)
  }

  if (Array.isArray(sheetObj.conditionalFormats)) {
    sheetObj.conditionalFormats = sheetObj.conditionalFormats
      .map(cf => {
        const shifted = shiftRangeColumnsForDelete(Number(cf?.startCol), Number(cf?.endCol), col, endCol, -count)
        return shifted ? { ...cf, startCol: shifted.startCol, endCol: shifted.endCol } : null
      })
      .filter(Boolean)
  }

  if (Array.isArray(sheetObj.charts)) {
    sheetObj.charts = sheetObj.charts.map(chart => {
      const chartCol = Number(chart?.col)
      if (!Number.isFinite(chartCol)) return chart
      if (chartCol > endCol) return { ...chart, col: chartCol - count }
      if (chartCol >= col) return { ...chart, col }
      return chart
    })
  }

  sheetObj.colCount = Math.max(0, (sheetObj.colCount || 0) - count)
  return workbook
}

function setRowHeight(workbook, { sheet, row, height }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.rowHeights) sheetObj.rowHeights = {}
  sheetObj.rowHeights[row] = height
  return workbook
}

function setColumnWidth(workbook, { sheet, col, width }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.colWidths) sheetObj.colWidths = {}
  sheetObj.colWidths[col] = width
  return workbook
}

function addSheet(workbook, { name, position }) {
  const newSheet = {
    name,
    data: {},
    // 不设置默认 rowCount 和 colCount，让它们根据实际数据动态计算
    colWidths: {},
    rowHeights: {}
  }
  if (position >= 0 && position < workbook.sheets.length) {
    workbook.sheets.splice(position, 0, newSheet)
  } else {
    workbook.sheets.push(newSheet)
  }
  // 新创建的工作表自动设置为活动工作表
  workbook.activeSheet = name
  return workbook
}

function renameSheet(workbook, { oldName, newName }) {
  const sheet = workbook.sheets.find(s => s.name === oldName)
  if (sheet) {
    sheet.name = newName
    if (workbook.activeSheet === oldName) {
      workbook.activeSheet = newName
    }
  }
  return workbook
}

function setActiveSheet(workbook, { name }) {
  workbook.activeSheet = name
  return workbook
}

function sortRange(workbook, { sheet, startRow, startCol, endRow, endCol, sortColumns, hasHeader = true }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj || !sheetObj.data) {
    console.error('sortRange: 工作表不存在或数据为空', { sheet })
    return workbook
  }
  
  // 解析 sortColumns 参数（可能是 JSON 字符串）
  let parsedSortColumns = []
  if (sortColumns) {
    try {
      let rawParsed = null
      if (typeof sortColumns === 'string') {
        // 尝试解析 JSON 字符串
        rawParsed = JSON.parse(sortColumns)
      } else if (Array.isArray(sortColumns)) {
        rawParsed = sortColumns
      } else {
        rawParsed = [sortColumns]
      }
      
      // 确保是数组
      if (!Array.isArray(rawParsed)) {
        console.error('sortRange: 解析后不是数组', { rawParsed, sortColumns })
        return workbook
      }
      
      // 确保数组中的每个元素都是对象，而不是字符串
      parsedSortColumns = rawParsed.map(item => {
        if (typeof item === 'string') {
          // 如果元素本身是字符串，尝试再次解析
          try {
            const parsed = JSON.parse(item)
            return typeof parsed === 'object' && parsed !== null ? parsed : item
          } catch {
            // 如果解析失败，尝试解析 Python 字典格式
            try {
              // 处理 Python 字典格式：{'column': 12, 'order': 'desc'}
              const cleaned = item.replace(/'/g, '"')
              return JSON.parse(cleaned)
            } catch {
              console.warn('sortRange: 无法解析排序列配置', { item })
              return item
            }
          }
        }
        return item
      })
      
      console.log('[sortRange] 解析后的 sortColumns', {
        original: sortColumns,
        parsed: parsedSortColumns,
        types: parsedSortColumns.map(item => typeof item)
      })
    } catch (e) {
      // 容错处理：解析失败时使用默认值
      console.warn('sortRange: 解析 sortColumns 失败，使用默认值（按第一列升序）', { sortColumns, error: e })
      parsedSortColumns = [{
        column: startCol || 1,
        order: 'asc'
      }]
    }
  }
  
  // 容错处理：确保 parsedSortColumns 是数组且不为空
  if (!Array.isArray(parsedSortColumns) || parsedSortColumns.length === 0) {
    console.warn('sortRange: sortColumns 缺失或无效，使用默认值（按第一列升序）', { parsedSortColumns })
    parsedSortColumns = [{
      column: startCol || 1,
      order: 'asc'
    }]
  }
  
  // 容错处理：验证并修复每个元素
  parsedSortColumns = parsedSortColumns.map((item, idx) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      console.warn(`sortRange: sortColumns[${idx}] 不是有效对象，跳过`, { item, type: typeof item })
      return null
    }
    
    // 获取列索引（支持多种格式）
    const col = item.column || item.columnIndex || item.col
    if (col === undefined || col === null) {
      console.warn(`sortRange: sortColumns[${idx}] 缺少 column 字段，跳过`, { item })
      return null
    }
    
    // 类型转换：确保 column 是数字
    const colNum = typeof col === 'number' ? col : parseInt(col)
    if (isNaN(colNum) || colNum < 1) {
      console.warn(`sortRange: sortColumns[${idx}].column 无效，跳过`, { col, colNum })
      return null
    }
    
    // 规范化 order 值
    let order = item.order || 'asc'
    if (order === 'ascending') order = 'asc'
    if (order === 'descending') order = 'desc'
    if (order !== 'asc' && order !== 'desc') {
      console.warn(`sortRange: sortColumns[${idx}].order 无效，使用默认值 'asc'`, { order })
      order = 'asc'
    }
    
    return {
      column: colNum,
      order: order
    }
  }).filter(item => item !== null)
  
  // 如果所有元素都被过滤掉了，使用默认值
  if (parsedSortColumns.length === 0) {
    console.warn('sortRange: 所有 sortColumns 元素都无效，使用默认值（按第一列升序）')
    parsedSortColumns = [{
      column: startCol || 1,
      order: 'asc'
    }]
  }
  
  
  const dataRows = []
  const _sr = hasHeader ? _findHeaderRow(sheetObj.data, startRow) : null
  const headerRow = _sr ? _sr.headerRow : null
  const dataStartRow = _sr ? _sr.dataStartRow : startRow
  
  // 验证：确保 dataStartRow <= endRow
  if (dataStartRow > endRow) {
    console.error('sortRange: 数据开始行大于结束行', {
      dataStartRow,
      endRow,
      startRow,
      hasHeader
    })
    return workbook
  }
  
  
  // 收集所有数据行，包括完整的单元格对象（保留公式和样式）
  // 重要：确保包含从 dataStartRow 到 endRow 的所有行，即使某些行可能为空
  for (let row = dataStartRow; row <= endRow; row++) {
    // 检查行是否存在
    const rowExists = sheetObj.data[row] && Object.keys(sheetObj.data[row]).length > 0
    
    const rowData = {}
    // 保存完整的行数据（即使行为空也要保存，确保所有行都参与排序）
    rowData._fullRow = sheetObj.data[row] ? JSON.parse(JSON.stringify(sheetObj.data[row])) : {}
    
    // 为每个排序列计算实际值（如果是公式，先计算结果）
    for (const sortCol of parsedSortColumns) {
      // 确保 sortCol 是对象
      if (typeof sortCol !== 'object' || sortCol === null) {
        console.warn('[sortRange] 跳过无效的 sortCol', { sortCol, type: typeof sortCol })
        continue
      }
      
      // 获取列索引（支持多种格式）
      const colIndex = sortCol.columnIndex || sortCol.column || sortCol.col
      
      // 验证列索引是数字
      if (typeof colIndex !== 'number' || isNaN(colIndex)) {
        console.warn('[sortRange] 列索引无效，跳过', { sortCol, colIndex })
        continue
      }
      const cell = sheetObj.data[row]?.[colIndex]
      
      let cellValue = null
      if (cell) {
        if (cell.formula && typeof cell.formula === 'string') {
          // 如果是公式，计算结果
          try {
            cellValue = evaluateFormula(cell.formula, sheetObj.data)
            // 如果计算结果为空，使用0
            if (cellValue === null || cellValue === undefined || cellValue === '') {
              cellValue = 0
            }
          } catch (e) {
            console.warn(`sortRange: 公式计算失败 (行 ${row}, 列 ${colIndex})`, e)
            cellValue = 0
          }
        } else if (cell.value !== undefined && cell.value !== null) {
          cellValue = cell.value
          // 如果值是对象，尝试提取
          if (typeof cellValue === 'object') {
            if (cellValue.value !== undefined) {
              cellValue = cellValue.value
            } else if (Array.isArray(cellValue) && cellValue.length > 0) {
              cellValue = cellValue[0]
            } else {
              cellValue = 0
            }
          }
        }
      }
      
      // 转换为可比较的值
      if (cellValue === null || cellValue === undefined || cellValue === '') {
        cellValue = 0
      }
      
      // 如果是日期字符串，转换为时间戳
      if (typeof cellValue === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cellValue)) {
        const dateValue = new Date(cellValue).getTime()
        cellValue = isNaN(dateValue) ? 0 : dateValue
      }
      
      rowData[colIndex] = cellValue
      
    }
    
    // 重要：即使行数据为空，也要添加到 dataRows 中，确保所有行都参与排序
    dataRows.push({ row, data: rowData })
    
  }
  
  
  // 验证：确保收集到了所有应该排序的行
  if (dataRows.length !== (endRow - dataStartRow + 1)) {
    console.warn('sortRange: 收集到的行数与预期不符', {
      collected: dataRows.length,
      expected: endRow - dataStartRow + 1,
      dataStartRow,
      endRow,
      collectedRows: dataRows.map(item => item.row),
      missingRows: Array.from({ length: endRow - dataStartRow + 1 }, (_, i) => dataStartRow + i)
        .filter(row => !dataRows.some(item => item.row === row))
    })
  }
  
  
  // 执行排序
  console.log('[sortRange] 开始排序', {
    dataRowsCount: dataRows.length,
    parsedSortColumns,
    parsedSortColumnsTypes: parsedSortColumns.map(item => ({
      type: typeof item,
      keys: Object.keys(item),
      column: item.column,
      order: item.order
    })),
    dataStartRow,
    endRow
  })
  
  dataRows.sort((a, b) => {
    for (const sortCol of parsedSortColumns) {
      // 确保 sortCol 是对象
      if (typeof sortCol !== 'object' || sortCol === null) {
        console.error('[sortRange] sortCol 不是对象', { sortCol, type: typeof sortCol })
        return 0
      }
      
      // 获取列索引（支持多种格式）
      const colIndex = sortCol.columnIndex || sortCol.column || sortCol.col
      
      // 验证列索引是数字
      if (typeof colIndex !== 'number' || isNaN(colIndex)) {
        console.error('[sortRange] 列索引无效', { sortCol, colIndex })
        return 0
      }
      
      // 确定排序方向
      // 优先级：ascending > descending > order > 默认升序
      // ascending: true=升序, false=降序
      // descending: true=降序, false=升序
      // order: "ascending"=升序, "descending"=降序, "desc"=降序
      let ascending = true // 默认升序
      
      if (sortCol.ascending !== undefined) {
        // 如果明确指定了 ascending，直接使用
        ascending = sortCol.ascending
      } else if (sortCol.descending !== undefined) {
        // 如果指定了 descending，转换为 ascending
        ascending = !sortCol.descending // descending=true 表示降序，所以 ascending=false
      } else if (sortCol.order !== undefined) {
        // 如果指定了 order 字符串，转换为 ascending
        const orderStr = String(sortCol.order).toLowerCase()
        ascending = orderStr === 'ascending' || orderStr === 'asc'
        // 明确支持 "desc" 和 "descending"
        if (orderStr === 'desc' || orderStr === 'descending') {
          ascending = false
        }
      }
      
      // 调试日志：记录排序方向判断（仅前几行）
      if (a.row <= dataStartRow + 2 || b.row <= dataStartRow + 2) {
        console.log(`[sortRange] 排序方向判断 (列 ${colIndex})`, {
          sortCol,
          sortColType: typeof sortCol,
          sortColKeys: Object.keys(sortCol),
          ascendingProvided: sortCol.ascending,
          descendingProvided: sortCol.descending,
          orderProvided: sortCol.order,
          finalAscending: ascending,
          finalDescending: !ascending,
          colIndex,
          colIndexType: typeof colIndex
        })
      }
      
      const valA = a.data[colIndex] !== undefined ? a.data[colIndex] : 0
      const valB = b.data[colIndex] !== undefined ? b.data[colIndex] : 0
      
      // 调试日志：记录前几行的值
      if (a.row <= dataStartRow + 2 || b.row <= dataStartRow + 2) {
        console.log(`[sortRange] 值比较 (行 ${a.row} vs ${b.row}, 列 ${colIndex})`, {
          valA,
          valB,
          valAType: typeof valA,
          valBType: typeof valB
        })
      }
      
      // 数值比较 - 确保转换为数字
      let numA = 0
      let numB = 0
      
      if (typeof valA === 'number') {
        numA = isNaN(valA) ? 0 : valA
      } else if (typeof valA === 'string') {
        // 规范化日期值（统一为 YYYY-MM-DD 格式）
        const normalizedValA = normalizeDateValue(valA)
        // 尝试解析为数字
        numA = parseFloat(normalizedValA)
        if (isNaN(numA)) {
          // 如果不是数字，尝试日期
          const dateA = new Date(normalizedValA).getTime()
          numA = isNaN(dateA) ? 0 : dateA
        }
      } else {
        numA = 0
      }
      
      if (typeof valB === 'number') {
        numB = isNaN(valB) ? 0 : valB
      } else if (typeof valB === 'string') {
        // 规范化日期值（统一为 YYYY-MM-DD 格式）
        const normalizedValB = normalizeDateValue(valB)
        // 尝试解析为数字
        numB = parseFloat(normalizedValB)
        if (isNaN(numB)) {
          // 如果不是数字，尝试日期
          const dateB = new Date(normalizedValB).getTime()
          numB = isNaN(dateB) ? 0 : dateB
        }
      } else {
        numB = 0
      }
      
      // 计算比较结果
      // ascending=true: numA - numB（升序：小的在前）
      // ascending=false: numB - numA（降序：大的在前）
      const comparison = ascending ? (numA - numB) : (numB - numA)
      
      // 调试日志：记录比较结果（仅前几行）
      if (a.row <= dataStartRow + 2 || b.row <= dataStartRow + 2) {
        console.log(`[sortRange] 数值比较结果`, {
          rowA: a.row,
          rowB: b.row,
          numA,
          numB,
          ascending,
          comparison
        })
      }
      
      // 数值比较：ascending=true 时 numA-numB（升序），ascending=false 时 numB-numA（降序）
      if (numA !== numB) {
        // 验证：如果要求降序，确保大的值排在前面
        if (!ascending && numA > numB && comparison > 0) {
          console.warn(`sortRange: 降序排序验证失败！`, {
            numA,
            numB,
            comparison,
            ascending,
            expectedComparison: numB - numA
          })
        }
        return comparison
      }
      
      // 如果数值相等，尝试字符串比较
      const strA = String(valA)
      const strB = String(valB)
      if (strA !== strB) {
        return ascending ? (strA < strB ? -1 : 1) : (strA > strB ? -1 : 1)
      }
    }
    return 0
  })
  
  
  // 重新组织数据
  const newData = {}
  if (headerRow !== null) {
    newData[headerRow] = sheetObj.data[headerRow]
  }
  
  // 获取排序列索引用于日志
  const sortColIndex = parsedSortColumns[0]?.columnIndex || parsedSortColumns[0]?.column || parsedSortColumns[0]
  console.log('[sortRange] 排序完成，开始重组数据', {
    sortedRowsCount: dataRows.length,
    firstFewRows: dataRows.slice(0, 5).map(item => ({
      originalRow: item.row,
      sortValue: item.data[sortColIndex],
      sortValueType: typeof item.data[sortColIndex]
    })),
    lastFewRows: dataRows.slice(-5).map(item => ({
      originalRow: item.row,
      sortValue: item.data[sortColIndex],
      sortValueType: typeof item.data[sortColIndex]
    }))
  })
  
  dataRows.forEach((item, index) => {
    const newRow = headerRow !== null ? headerRow + 1 + index : startRow + index
    const originalRow = item.row
    
    // 使用完整的行数据（包括公式和样式）
    const fullRowData = item.data._fullRow
    
    // 如果行号改变了，需要更新公式中的行号引用
    // 公式中的行号引用是相对于当前行的，所以需要根据新行号调整
    if (newRow !== originalRow) {
      const rowOffset = newRow - originalRow
      
      // 遍历该行的所有单元格，更新公式中的行号引用
      Object.keys(fullRowData).forEach(colKey => {
        const colNum = parseInt(colKey)
        if (isNaN(colNum)) return
        
        const cell = fullRowData[colNum]
        if (cell && cell.formula && typeof cell.formula === 'string') {
          // 更新公式中的行号引用
          // 例如：如果原行5的公式是 =D5*E5，排序到新行2，应该变成 =D2*E2
          // 逻辑：计算引用行相对于原行的偏移量，然后应用到新行
          cell.formula = cell.formula.replace(/([A-Z]+)(\d+)/g, (match, colLetter, rowNum) => {
            const refRowNum = parseInt(rowNum)
            if (isNaN(refRowNum)) return match
            
            // 如果引用的行号在排序范围内，需要调整
            if (refRowNum >= dataStartRow && refRowNum <= endRow) {
              // 计算引用行相对于原行的偏移量
              const refOffset = refRowNum - originalRow
              // 计算新的引用行号（保持相对关系）
              const newRefRow = newRow + refOffset
              // 确保新行号在有效范围内
              if (newRefRow >= dataStartRow && newRefRow <= endRow) {
                return `${colLetter}${newRefRow}`
              }
            }
            
            // 如果引用的是排序范围外的行（如表头），保持不变
            return match
          })
        }
      })
    }
    
    newData[newRow] = fullRowData
  })
  
  // 更新工作表数据 - 先清除旧数据，再写入新数据
  // 清除旧的数据行（只清除数据行，保留表头）
  const rowsToDelete = []
  for (let row = dataStartRow; row <= endRow; row++) {
    rowsToDelete.push(row)
    delete sheetObj.data[row]
  }
  
  console.log('[sortRange] 已清除旧数据行', { rowsToDelete })
  
  // 写入新的排序后的数据
  const rowsWritten = []
  Object.keys(newData).forEach(rowKey => {
    const rowNum = parseInt(rowKey)
    if (!isNaN(rowNum)) {
      sheetObj.data[rowNum] = newData[rowNum]
      rowsWritten.push(rowNum)
    }
  })
  
  console.log('[sortRange] 已写入新数据行', {
    rowsWritten,
    rowsWrittenCount: rowsWritten.length,
    expectedCount: dataRows.length + (headerRow !== null ? 1 : 0)
  })
  
  // 确保表头行存在
  if (headerRow !== null) {
    if (newData[headerRow]) {
      sheetObj.data[headerRow] = newData[headerRow]
    } else if (sheetObj.data[headerRow]) {
      // 如果 newData 中没有表头，保留原有的表头
    }
  }
  
  // 验证：检查排序后的数据
  if (parsedSortColumns.length > 0) {
    const sortCol = parsedSortColumns[0]
    if (typeof sortCol !== 'object' || sortCol === null) {
      console.warn('[sortRange] 验证时 sortCol 无效', { sortCol })
    } else {
      const colIndex = sortCol.columnIndex || sortCol.column || sortCol.col
      
      // 确定排序方向
      let expectedOrder = 'asc'
      if (sortCol.order) {
        expectedOrder = String(sortCol.order).toLowerCase()
      } else if (sortCol.ascending === false) {
        expectedOrder = 'desc'
      } else if (sortCol.descending === true) {
        expectedOrder = 'desc'
      }
      const sampleValues = []
      
      // 验证 colIndex 是数字
      if (typeof colIndex === 'number' && !isNaN(colIndex)) {
        for (let row = dataStartRow; row <= Math.min(dataStartRow + 10, endRow); row++) {
          const cell = sheetObj.data[row]?.[colIndex]
          if (cell) {
            let value = cell.formula ? evaluateFormula(cell.formula, sheetObj.data) : cell.value
            // 转换为数字用于验证
            const numValue = typeof value === 'number' ? value : parseFloat(value) || 0
            sampleValues.push({ row, value, numValue })
          }
        }
        
        // 验证排序顺序
        let isCorrectOrder = true
        if (sampleValues.length > 1) {
          for (let i = 1; i < sampleValues.length; i++) {
            if (expectedOrder === 'desc' || expectedOrder === 'descending') {
              // 降序：后面的值应该 <= 前面的值
              if (sampleValues[i].numValue > sampleValues[i-1].numValue) {
                isCorrectOrder = false
                break
              }
            } else {
              // 升序：后面的值应该 >= 前面的值
              if (sampleValues[i].numValue < sampleValues[i-1].numValue) {
                isCorrectOrder = false
                break
              }
            }
          }
        }
        
        console.log('[sortRange] 排序后数据验证', {
          colIndex,
          expectedOrder,
          isCorrectOrder,
          sampleValues: sampleValues.slice(0, 5),
          totalRows: endRow - dataStartRow + 1
        })
        
        if (!isCorrectOrder) {
          console.warn('[sortRange] ⚠️ 排序顺序验证失败！数据可能未正确排序')
        }
      } else {
        console.warn('[sortRange] 验证时列索引无效', { colIndex, sortCol })
      }
    }
  }
  
  console.log('[sortRange] ✅ 排序操作完成', {
    sheet: sheet,
    dataStartRow,
    endRow,
    totalRows: endRow - dataStartRow + 1
  })
  
  return workbook
}

function copyPaste(workbook, { 
  sheet, 
  sourceStartRow, 
  sourceStartCol, 
  sourceEndRow, 
  sourceEndCol,
  targetRow,
  targetCol,
  targetSheet,
  pasteValuesOnly = false
}) {
  const sourceSheetObj = getSheet(workbook, sheet)
  const destSheetObj = getSheet(workbook, targetSheet || sheet)
  
  const sourceRowCount = (sourceEndRow || sourceStartRow) - sourceStartRow + 1
  const sourceColCount = (sourceEndCol || sourceStartCol) - sourceStartCol + 1
  
  for (let i = 0; i < sourceRowCount; i++) {
    for (let j = 0; j < sourceColCount; j++) {
      const sourceRow = sourceStartRow + i
      const sourceCol = sourceStartCol + j
      const targetRowNum = targetRow + i
      const targetColNum = targetCol + j
      
      const sourceCell = sourceSheetObj.data[sourceRow]?.[sourceCol]
      if (sourceCell) {
        if (!destSheetObj.data[targetRowNum]) destSheetObj.data[targetRowNum] = {}
        if (!destSheetObj.data[targetRowNum][targetColNum]) {
          destSheetObj.data[targetRowNum][targetColNum] = {}
        }
        
        if (pasteValuesOnly) {
          // 只粘贴值
          destSheetObj.data[targetRowNum][targetColNum].value = sourceCell.value
          delete destSheetObj.data[targetRowNum][targetColNum].formula
        } else {
          // 粘贴公式和值
          if (sourceCell.formula) {
            // 复制公式，需要调整相对引用
            let formula = sourceCell.formula
            // 简单的相对引用调整：将行号增加 (targetRow - sourceRow)，列号增加 (targetCol - sourceCol)
            const rowDiff = targetRow - sourceRow
            const colDiff = targetCol - sourceCol
            
            // 调整公式中的单元格引用（如 A1 -> A2，如果 rowDiff=1）
            formula = formula.replace(/([A-Z]+)(\d+)/g, (match, col, row) => {
              const colNum = col.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)
              const rowNum = parseInt(row)
              const newColNum = colNum + colDiff
              const newRowNum = rowNum + rowDiff
              
              // 将列号转换回字母
              let newCol = ''
              let temp = newColNum
              while (temp > 0) {
                const remainder = (temp - 1) % 26
                newCol = String.fromCharCode(65 + remainder) + newCol
                temp = Math.floor((temp - 1) / 26)
              }
              
              return `${newCol}${newRowNum}`
            })
            
            destSheetObj.data[targetRowNum][targetColNum].formula = formula
            delete destSheetObj.data[targetRowNum][targetColNum].value
          } else {
            destSheetObj.data[targetRowNum][targetColNum].value = sourceCell.value
            delete destSheetObj.data[targetRowNum][targetColNum].formula
          }
          
          // 复制样式
          if (sourceCell.style) {
            destSheetObj.data[targetRowNum][targetColNum].style = JSON.parse(JSON.stringify(sourceCell.style))
          }
        }
      }
    }
  }
  
  return workbook
}

/**
 * 查询列的唯一值并输出到表格
 */
function queryUniqueValues(workbook, { sheet, column, startRow, endRow, targetRow, targetCol }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj) {
    console.error('queryUniqueValues: 找不到工作表', { sheet })
    return workbook
  }
  
  const uniqueValues = new Set()
  
  // 遍历指定范围收集唯一值
  for (let row = startRow; row <= endRow; row++) {
    const cell = sheetObj.data[row]?.[column]
    if (cell) {
      const value = cell.value ?? cell.formula ?? ''
      if (value !== '' && value !== null && value !== undefined) {
        uniqueValues.add(String(value))
      }
    }
  }
  
  const uniqueList = Array.from(uniqueValues)
  
  console.log('[查询结果] 唯一值:', {
    sheet,
    column,
    range: `${startRow}-${endRow}`,
    count: uniqueList.length,
    values: uniqueList
  })
  
  // 输出到工作表（默认输出到目标列右侧两列）
  const writeRowStart = Number(targetRow) || (Number(startRow) || 1)
  const writeCol = Number(targetCol) || (Number(column) + 2)

  if (!sheetObj.data[writeRowStart]) sheetObj.data[writeRowStart] = {}
  sheetObj.data[writeRowStart][writeCol] = { value: '唯一值' }
  if (!sheetObj.data[writeRowStart][writeCol + 1]) sheetObj.data[writeRowStart][writeCol + 1] = {}
  sheetObj.data[writeRowStart][writeCol + 1] = { value: '计数' }

  const freq = new Map()
  for (let row = startRow; row <= endRow; row++) {
    const cell = sheetObj.data[row]?.[column]
    if (!cell) continue
    const value = cell.value ?? cell.formula ?? ''
    if (value === '' || value === null || value === undefined) continue
    const k = String(value)
    freq.set(k, (freq.get(k) || 0) + 1)
  }

  let writeRow = writeRowStart + 1
  for (const v of uniqueList) {
    if (!sheetObj.data[writeRow]) sheetObj.data[writeRow] = {}
    sheetObj.data[writeRow][writeCol] = { value: v }
    sheetObj.data[writeRow][writeCol + 1] = computedNumberCell(freq.get(v) || 0)
    writeRow += 1
  }

  sheetObj.rowCount = Math.max(sheetObj.rowCount || 0, writeRow)
  sheetObj.colCount = Math.max(sheetObj.colCount || 0, writeCol + 1)

  return workbook
}

// ============================================================================
// 自定义公式（AI Agent 调用）
// ============================================================================

const _COL_REF_RESERVED = new Set([
  'Math', 'NaN', 'Infinity', 'undefined', 'null',
  'true', 'false', 'if', 'else', 'return', 'value',
])

function _letterToCol(letter) {
  let idx = 0
  for (let i = 0; i < letter.length; i++) {
    idx = idx * 26 + (letter.charCodeAt(i) - 64)
  }
  return idx
}

function applyCustomFormula(workbook, { sheet, targetCol, startRow, endRow, expression, formulaParams }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj) return workbook

  const normalizedExpression = normalizeCustomFormulaExpression(expression)
  if (!normalizedExpression || typeof normalizedExpression !== 'string') return workbook

  const colRefs = (normalizedExpression.match(/\b([A-Z]{1,2})\b/g) || [])
    .filter(m => !_COL_REF_RESERVED.has(m))

  for (let r = startRow; r <= endRow; r++) {
    const cellRaw = sheetObj.data[r]?.[targetCol]
    const rawVal = cellRaw?.formula
      ? evaluateFormula(cellRaw.formula, sheetObj.data)
      : cellRaw?.value
    const value = parseFloat(rawVal)

    const ctx = { value: isNaN(value) ? 0 : value }
    for (const letter of colRefs) {
      const ci = _letterToCol(letter)
      const rc = sheetObj.data[r]?.[ci]
      const rv = rc?.formula ? evaluateFormula(rc.formula, sheetObj.data) : rc?.value
      ctx[letter] = parseFloat(rv) || 0
    }
    Object.assign(ctx, formulaParams || {})

    try {
      const fn = new Function(...Object.keys(ctx), `return ${normalizedExpression}`)
      let result = fn(...Object.values(ctx))
      if (typeof result === 'number' && isFinite(result)) {
        result = roundComputedNumber(result)
      }
      if (!sheetObj.data[r]) sheetObj.data[r] = {}
      if (!sheetObj.data[r][targetCol]) sheetObj.data[r][targetCol] = {}
      const cell = computedNumberCell(result)
      sheetObj.data[r][targetCol].value = cell.value
      if (cell.style?.numberFormat) {
        if (!sheetObj.data[r][targetCol].style) sheetObj.data[r][targetCol].style = {}
        sheetObj.data[r][targetCol].style.numberFormat = cell.style.numberFormat
      }
      delete sheetObj.data[r][targetCol].formula
    } catch (err) {
      console.warn(`applyCustomFormula row ${r} 错误:`, { expression: normalizedExpression, err })
    }
  }

  return workbook
}

/**
 * 执行批量操作
 * @param {Object} workbook - 工作簿对象
 * @param {Array} operations - 操作数组
 * @param {Function} onError - 可选的错误回调函数，接收错误信息字符串
 * @returns {Object} 更新后的工作簿对象
 */
function executeBatchOperations(workbook, operations, onError = null) {
  if (!operations) {
    const errorMsg = '批量操作参数缺失'
    console.error('executeBatchOperations: operations 参数缺失', { operations })
    if (onError) {
      onError(errorMsg)
    }
    return workbook
  }
  
  // 解析 operations 参数（可能是 JSON 字符串）
  let parsedOperations = []
  try {
    if (typeof operations === 'string') {
      // 尝试解析 JSON 字符串
      parsedOperations = JSON.parse(operations)
    } else if (Array.isArray(operations)) {
      // 已经是数组，直接使用
      parsedOperations = operations
    } else if (operations && typeof operations === 'object') {
      // 如果是单个对象，包装成数组
      parsedOperations = [operations]
    } else {
      console.error('executeBatchOperations: operations 格式错误', { 
        operations, 
        type: typeof operations,
        isArray: Array.isArray(operations)
      })
      return workbook
    }
  } catch (e) {
    console.error('executeBatchOperations: 解析 operations 失败', { 
      operations, 
      error: e,
      errorMessage: e.message
    })
    return workbook
  }
  
  // 确保 parsedOperations 是数组
  if (!Array.isArray(parsedOperations)) {
    console.error('executeBatchOperations: operations 必须是数组', { 
      parsedOperations, 
      type: typeof parsedOperations,
      isArray: Array.isArray(parsedOperations)
    })
    // 尝试转换为数组
    if (parsedOperations && typeof parsedOperations === 'object') {
      parsedOperations = [parsedOperations]
    } else {
      return workbook
    }
  }
  
  // 最终检查：确保是数组且有 forEach 方法
  if (!parsedOperations || typeof parsedOperations.forEach !== 'function') {
    console.error('executeBatchOperations: parsedOperations 不是有效的数组', {
      parsedOperations,
      type: typeof parsedOperations,
      hasForEach: typeof parsedOperations.forEach === 'function'
    })
    return workbook
  }
  
  
  let result = workbook
  let executedCount = 0
  const errors = []
  
  try {
    for (let index = 0; index < parsedOperations.length; index += 1) {
      const originalOp = parsedOperations[index]
      const op = originalOp
      if (!op || !op.type) {
        const errorMsg = `跳过无效操作 (索引 ${index}): 缺少操作类型`
        console.warn(`executeBatchOperations: ${errorMsg}`, op)
        if (onError) {
          errors.push(errorMsg)
        }
        break
      }
      
      // 为每个操作创建错误回调
      let operationFailed = false
      const operationErrorCallback = (errorMsg) => {
        operationFailed = true
        errors.push(`操作 ${index + 1}/${parsedOperations.length} (${op.type}): ${errorMsg}`)
      }
      
      try {
        // normalizeParams 已由 executeOperation 入口统一执行，此处不再重复
        result = executeOperation(result, { type: op.type, params: op.params || {} }, operationErrorCallback)
        executedCount += 1
        if (operationFailed) {
          // fail-fast：批量操作中任一步失败即停止后续步骤，避免“带伤继续执行”
          break
        }
      } catch (e) {
        const errorMsg = `操作执行失败 (索引 ${index}, 类型 ${op.type}): ${e.message}`
        console.error(`executeBatchOperations: ${errorMsg}`, e)
        errors.push(errorMsg)
        break
      }
    }
  } catch (e) {
    const errorMsg = `批量操作执行失败: ${e.message}`
    console.error('executeBatchOperations: forEach 执行失败', {
      error: e,
      errorMessage: e.message,
      parsedOperations,
      isArray: Array.isArray(parsedOperations)
    })
    errors.push(errorMsg)
    // 如果有错误回调，调用它
    if (onError && errors.length > 0) {
      onError(errors.join('\n'))
    }
    return workbook
  }
  
  // 如果有错误，通过回调通知
  if (onError && errors.length > 0) {
    onError(`批量操作完成，但发生 ${errors.length} 个错误:\n${errors.join('\n')}`)
  }
  
  console.log('executeBatchOperations: 批量操作完成', {
    totalOperations: parsedOperations.length,
    executedOperations: executedCount
  })
  
  return result
}

// ============================================================================
// 缺失的操作函数实现
// ============================================================================

function clearCell(workbook, { sheet, row, col, clearFormat = false }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.data[row]?.[col]) {
    if (clearFormat) {
      delete sheetObj.data[row][col]
    } else {
      delete sheetObj.data[row][col].value
      delete sheetObj.data[row][col].formula
    }
  }
  return workbook
}

function clearRange(workbook, { sheet, startRow, startCol, endRow, endCol, clearFormat = false }) {
  const sheetObj = getSheet(workbook, sheet)
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (sheetObj.data[row]?.[col]) {
        if (clearFormat) {
          delete sheetObj.data[row][col]
        } else {
          delete sheetObj.data[row][col].value
          delete sheetObj.data[row][col].formula
        }
      }
    }
  }
  return workbook
}

function unmergeCells(workbook, { sheet, startRow, startCol, endRow, endCol }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.mergedCells) {
    sheetObj.mergedCells = sheetObj.mergedCells.filter(m => 
      !(m.startRow === startRow && m.startCol === startCol && 
        m.endRow === endRow && m.endCol === endCol)
    )
  }
  return workbook
}

function hideRow(workbook, { sheet, row }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.hiddenRows) sheetObj.hiddenRows = []
  if (!sheetObj.hiddenRows.includes(row)) {
    sheetObj.hiddenRows.push(row)
  }
  return workbook
}

function hideColumn(workbook, { sheet, col }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.hiddenColumns) sheetObj.hiddenColumns = []
  if (!sheetObj.hiddenColumns.includes(col)) {
    sheetObj.hiddenColumns.push(col)
  }
  return workbook
}

function showRow(workbook, { sheet, row }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.hiddenRows) {
    sheetObj.hiddenRows = sheetObj.hiddenRows.filter(r => r !== row)
  }
  return workbook
}

function showColumn(workbook, { sheet, col }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.hiddenColumns) {
    sheetObj.hiddenColumns = sheetObj.hiddenColumns.filter(c => c !== col)
  }
  return workbook
}

function autoFitColumn(workbook, { sheet, col }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.colWidths) sheetObj.colWidths = {}

  // 按列内容计算宽度（近似像素）：字符数 * 10 + 20，限制在 [36, 480]
  const colNum = Number(col)
  const data = sheetObj.data || {}
  const rowNums = Object.keys(data).map(Number).filter(n => Number.isFinite(n))
  let maxChars = 0

  rowNums.forEach((rowNum) => {
    const cell = data?.[rowNum]?.[colNum]
    if (!cell) return
    let raw = ''
    if (cell.formula) {
      raw = String(cell.formula)
    } else if (cell.value && typeof cell.value === 'object') {
      raw = String(cell.value.text ?? cell.value.result ?? cell.value.value ?? '')
    } else {
      raw = String(cell.value ?? '')
    }
    if (raw.length > maxChars) maxChars = raw.length
  })

  // 空列给一个可读默认宽度，非空列按内容估算
  const nextWidth = maxChars > 0 ? Math.ceil(maxChars * 10 + 20) : 100
  sheetObj.colWidths[colNum] = Math.max(36, Math.min(480, nextWidth))
  return workbook
}

function copySheet(workbook, { sourceSheet, targetSheet, position }) {
  const source = getSheet(workbook, sourceSheet)
  if (!source) return workbook
  
  const newSheet = JSON.parse(JSON.stringify(source))
  newSheet.name = targetSheet
  
  if (position >= 0 && position < workbook.sheets.length) {
    workbook.sheets.splice(position, 0, newSheet)
  } else {
    workbook.sheets.push(newSheet)
  }
  return workbook
}

function filterData(workbook, { sheet, startRow, startCol, endRow, endCol, conditions }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj) {
    console.error('filterData: 找不到工作表', { sheet })
    return workbook
  }
  
  if (!sheetObj.data) {
    console.error('filterData: 工作表数据为空', { sheet })
    return workbook
  }
  
  // 初始化 hiddenRows 数组
  // 如果已有筛选，先清除之前的隐藏行（应用新筛选时重置）
  if (!sheetObj.hiddenRows) {
    sheetObj.hiddenRows = []
  } else {
    // 清除之前的筛选结果，重新开始
    sheetObj.hiddenRows = []
  }

  // 计算数据边界（用于范围兜底）
  const rowNums = Object.keys(sheetObj.data || {}).map(Number).filter(n => !Number.isNaN(n))
  let usedMinRow = 1
  let usedMaxRow = 1
  let usedMinCol = 1
  let usedMaxCol = 1
  if (rowNums.length > 0) {
    usedMinRow = Math.min(...rowNums)
    usedMaxRow = Math.max(...rowNums)
    let cMin = Infinity
    let cMax = 0
    for (const rowObj of Object.values(sheetObj.data)) {
      if (!rowObj) continue
      for (const colKey of Object.keys(rowObj)) {
        const c = Number(colKey)
        if (!Number.isNaN(c)) {
          cMin = Math.min(cMin, c)
          cMax = Math.max(cMax, c)
        }
      }
    }
    if (Number.isFinite(cMin) && cMax > 0) {
      usedMinCol = cMin
      usedMaxCol = cMax
    }
  }

  let actualStartRow = Number(startRow) || usedMinRow
  let actualEndRow = Number(endRow) || usedMaxRow
  let actualStartCol = Number(startCol) || usedMinCol
  let actualEndCol = Number(endCol) || usedMaxCol

  // 范围过小或异常时，自动回退到已用范围，避免 {{sheet.range}} 未替换导致无效果
  if (
    actualEndRow <= actualStartRow ||
    actualEndCol < actualStartCol ||
    (actualStartRow === actualEndRow && actualStartCol === actualEndCol && usedMaxRow > usedMinRow)
  ) {
    actualStartRow = usedMinRow
    actualEndRow = usedMaxRow
    actualStartCol = usedMinCol
    actualEndCol = usedMaxCol
  }
  
  // 解析 conditions 参数（可能是 JSON 字符串）
  // 后端可能发送两种格式：
  // 1. 数组格式: [{ column: 6, operator: "greaterThan", value: "5000" }]
  // 2. 对象格式: { "6": { operator: "greaterThan", value: "5000" } }
  let filterConditions = []
  if (conditions) {
    try {
      let parsedConditions = conditions
      if (typeof conditions === 'string') {
        parsedConditions = JSON.parse(conditions)
      }
      
      // 如果是对象格式（键是列号），转换为数组格式
      if (typeof parsedConditions === 'object' && !Array.isArray(parsedConditions)) {
        filterConditions = Object.keys(parsedConditions).map(colKey => {
          const condition = parsedConditions[colKey]
          const column = typeof colKey === 'string' ? parseInt(colKey) : colKey
          
          // 解析 criteria 字段（如 ">6000"）
          let operator = condition.operator
          let value = condition.value
          
          if (condition.criteria && typeof condition.criteria === 'string') {
            const criteriaStr = condition.criteria.trim()
            // 提取操作符
            if (criteriaStr.startsWith('>=')) {
              operator = 'greaterThanOrEqual'
              value = criteriaStr.substring(2).trim()
            } else if (criteriaStr.startsWith('<=')) {
              operator = 'lessThanOrEqual'
              value = criteriaStr.substring(2).trim()
            } else if (criteriaStr.startsWith('<>') || criteriaStr.startsWith('!=')) {
              operator = 'notEqual'
              value = criteriaStr.substring(2).trim()
            } else if (criteriaStr.startsWith('>')) {
              operator = 'greaterThan'
              value = criteriaStr.substring(1).trim()
            } else if (criteriaStr.startsWith('<')) {
              operator = 'lessThan'
              value = criteriaStr.substring(1).trim()
            } else if (criteriaStr.startsWith('=')) {
              operator = 'equal'
              value = criteriaStr.substring(1).trim()
            } else {
              // 默认使用 greaterThan
              operator = 'greaterThan'
              value = criteriaStr
            }
          }
          
          return {
            column: column,
            operator: operator || 'greaterThan',
            value: value || condition
          }
        })
      } else if (Array.isArray(parsedConditions)) {
        // 兼容数组格式：[{ col|column, operator, value }]
        filterConditions = parsedConditions
          .filter(c => c && typeof c === 'object')
          .map(c => ({
            column: c.column ?? c.col,
            operator: c.operator || 'contains',
            value: c.value,
          }))
      } else {
        // 单个条件对象
        filterConditions = [parsedConditions]
      }
    } catch (e) {
      console.error('filterData: 解析 conditions 失败', { conditions, error: e })
      return workbook
    }
  }
  
  
  // 确定数据开始行（如果 startRow 已是数据起始行，则不 +1）
  const dataStartRow = actualStartRow === 1 ? actualStartRow + 1 : actualStartRow
  const rowsToHide = []
  
  // 优化：预先计算所有需要筛选的列的公式结果，避免重复计算
  const columnValuesCache = new Map() // 缓存每行的列值
  
  // 第一遍：计算所有需要筛选的列的公式结果
  for (let row = dataStartRow; row <= actualEndRow; row++) {
    const rowValues = {}
    for (const condition of filterConditions) {
      const column = condition.column ?? condition.col
      if (!rowValues[column]) {
        const cell = sheetObj.data[row]?.[column]
        let cellValue = 0
        
        if (cell) {
          if (cell.formula && typeof cell.formula === 'string') {
            try {
              cellValue = evaluateFormula(cell.formula, sheetObj.data)
              if (cellValue === null || cellValue === undefined || cellValue === '') {
                cellValue = 0
              }
            } catch (e) {
              cellValue = 0
            }
          } else if (cell.value !== undefined && cell.value !== null) {
            cellValue = cell.value
            // 如果值是对象，尝试提取数值
            if (typeof cellValue === 'object') {
              if (cellValue.value !== undefined) {
                cellValue = cellValue.value
              } else if (Array.isArray(cellValue) && cellValue.length > 0) {
                cellValue = cellValue[0]
              } else {
                cellValue = 0
              }
            }
            if (cellValue === '') {
              cellValue = 0
            }
          }
        }
        rowValues[column] = cellValue
      }
    }
    columnValuesCache.set(row, rowValues)
  }
  
  // 第二遍：使用缓存的值进行评估，决定哪些行需要隐藏
  for (let row = dataStartRow; row <= actualEndRow; row++) {
    let shouldHide = false
    
    // 评估每个筛选条件（使用缓存的值）
    const rowValues = columnValuesCache.get(row) || {}
    
    for (const condition of filterConditions) {
      const column = condition.column ?? condition.col
      const { operator, value } = condition
      
      // 从缓存中获取已计算的单元格值
      const cellValue = rowValues[column] || 0
      
      // 转换为数值进行比较
      const numValue = typeof cellValue === 'number' ? cellValue : parseFloat(cellValue)
      const compareValue = typeof value === 'number' ? value : parseFloat(value)
      
      
      // 根据操作符评估条件
      let conditionMet = false
      switch (operator) {
        case 'greaterThan':
        case '>':
          conditionMet = !isNaN(numValue) && !isNaN(compareValue) && numValue > compareValue
          break
        case 'greaterThanOrEqual':
        case '>=':
          conditionMet = !isNaN(numValue) && !isNaN(compareValue) && numValue >= compareValue
          break
        case 'lessThan':
        case '<':
          conditionMet = !isNaN(numValue) && !isNaN(compareValue) && numValue < compareValue
          break
        case 'lessThanOrEqual':
        case '<=':
          conditionMet = !isNaN(numValue) && !isNaN(compareValue) && numValue <= compareValue
          break
        case 'equal':
        case '=':
          conditionMet = numValue === compareValue || String(cellValue) === String(value)
          break
        case 'notEqual':
        case '!=':
        case '<>':
          conditionMet = numValue !== compareValue && String(cellValue) !== String(value)
          break
        case 'contains':
          conditionMet = String(cellValue).includes(String(value))
          break
        case 'notContains':
          conditionMet = !String(cellValue).includes(String(value))
          break
        default:
          console.warn(`filterData: 未知的操作符 ${operator}`)
          conditionMet = false
      }
      
      // 如果条件不满足，隐藏该行
      if (!conditionMet) {
        shouldHide = true
        break
      }
    }
    
    if (shouldHide) {
      rowsToHide.push(row)
    }
  }
  
  // 隐藏不满足条件的行
  rowsToHide.forEach(row => {
    if (!sheetObj.hiddenRows.includes(row)) {
      sheetObj.hiddenRows.push(row)
    }
  })
  
  // 保存筛选信息
  if (!sheetObj.filters) {
    sheetObj.filters = []
  }
  sheetObj.filters.push({
    startRow: actualStartRow,
    startCol: actualStartCol,
    endRow: actualEndRow,
    endCol: actualEndCol,
    conditions: filterConditions
  })
  
  
  return workbook
}

function removeFilter(workbook, { sheet }) {
  const sheetObj = getSheet(workbook, sheet)
  delete sheetObj.filters
  return workbook
}

function findReplace(workbook, { sheet, find, replace, matchCase = false, matchWholeCell = false }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj?.data) return workbook
  
  const regex = new RegExp(
    matchWholeCell ? `^${find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    matchCase ? 'g' : 'gi'
  )
  
  // 获取单元格显示值（公式计算结果或原始值）
  const getDisplayValue = (cell) => {
    if (!cell) return null
    if (cell.formula && typeof cell.formula === 'string') {
      try {
        return evaluateFormula(cell.formula, sheetObj.data)
      } catch {
        return cell.value
      }
    }
    return cell.value
  }
  
  Object.keys(sheetObj.data).forEach(rowKey => {
    const row = sheetObj.data[rowKey]
    if (!row) return
    Object.keys(row).forEach(colKey => {
      const cell = row[colKey]
      if (!cell) return
      
      // 获取显示值（公式计算结果或原始值）
      const displayValue = getDisplayValue(cell)
      if (displayValue === undefined || displayValue === null) return
      
      const displayStr = String(displayValue)
      if (regex.test(displayStr)) {
        // 替换后变成普通值（删除公式）
        cell.value = displayStr.replace(regex, replace)
        delete cell.formula
      }
      regex.lastIndex = 0
    })
  })
  return workbook
}

function fillSeries(workbook, { sheet, startRow, startCol, endRow, endCol, seriesType = 'linear', step = 1, direction = 'down' }) {
  const sheetObj = getSheet(workbook, sheet)
  const startCell = sheetObj.data[startRow]?.[startCol]
  if (!startCell) return workbook
  
  // 如果是 autoFill 类型，需要复制公式并调整相对引用
  if (seriesType === 'autoFill') {
    // 获取起始单元格的公式或值
    const sourceFormula = startCell.formula
    const sourceValue = startCell.value
    
    if (sourceFormula && typeof sourceFormula === 'string') {
      // 复制公式，需要调整相对引用
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          if (row === startRow && col === startCol) continue
          
          if (!sheetObj.data[row]) sheetObj.data[row] = {}
          if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
          
          // 计算行和列的偏移量
          const rowOffset = row - startRow
          const colOffset = col - startCol
          
          // 调整公式中的单元格引用
          let newFormula = sourceFormula
          // 匹配单元格引用（如 A1, B2, D2*E2 等）
          newFormula = newFormula.replace(/([A-Z]+)(\d+)/g, (match, colLetter, rowNum) => {
            // 将列字母转换为数字
            let colNum = 0
            for (let i = 0; i < colLetter.length; i++) {
              colNum = colNum * 26 + (colLetter.charCodeAt(i) - 64)
            }
            
            // 计算新的列号和行号
            const newColNum = colNum + colOffset
            const newRowNum = parseInt(rowNum) + rowOffset
            
            // 将列号转换回字母
            let newColLetter = ''
            let temp = newColNum
            while (temp > 0) {
              const remainder = (temp - 1) % 26
              newColLetter = String.fromCharCode(65 + remainder) + newColLetter
              temp = Math.floor((temp - 1) / 26)
            }
            
            return `${newColLetter}${newRowNum}`
          })
          
          sheetObj.data[row][col].formula = newFormula
          delete sheetObj.data[row][col].value
        }
      }
    } else if (sourceValue !== undefined && sourceValue !== null) {
      // 如果是值，使用线性填充
      const startValue = parseFloat(sourceValue) || 0
      let currentValue = startValue
      
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          if (row === startRow && col === startCol) continue
          
          if (!sheetObj.data[row]) sheetObj.data[row] = {}
          if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
          
          currentValue += step
          sheetObj.data[row][col].value = currentValue
          delete sheetObj.data[row][col].formula
        }
      }
    }
    return workbook
  }
  
  // 原有的 linear 和 date 类型处理
  const startValue = parseFloat(startCell.value) || 0
  let currentValue = startValue
  
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (row === startRow && col === startCol) continue
      
      if (!sheetObj.data[row]) sheetObj.data[row] = {}
      if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
      
      if (seriesType === 'linear') {
        currentValue += step
        sheetObj.data[row][col].value = currentValue
        delete sheetObj.data[row][col].formula
      } else if (seriesType === 'date') {
        // 日期序列实现
        // startValue 可能是日期字符串（YYYY-MM-DD）或 Excel 日期序列号
        let startDate
        if (typeof startValue === 'string') {
          // 解析日期字符串
          startDate = new Date(startValue)
        } else if (typeof startValue === 'number') {
          // Excel 日期序列号：从 1900-01-01 开始的天数
          // Excel 的日期序列号：1 = 1900-01-01
          // JavaScript Date: 0 = 1970-01-01
          // 需要转换：Excel 序列号到 JavaScript 时间戳
          // Excel 1900-01-01 对应的时间戳 = new Date('1900-01-01').getTime()
          const excelEpoch = new Date('1900-01-01').getTime()
          const jsEpoch = new Date('1970-01-01').getTime()
          // Excel 日期序列号转换为 JavaScript 时间戳
          // 注意：Excel 错误地将 1900 年视为闰年，所以需要调整
          const daysSince1900 = startValue - 1 // Excel 序列号从 1 开始
          const daysSince1970 = daysSince1900 - 25569 // 1900-01-01 到 1970-01-01 的天数
          startDate = new Date(jsEpoch + daysSince1970 * 86400000)
        } else {
          startDate = new Date(startValue)
        }
        
        if (isNaN(startDate.getTime())) {
          console.warn('fillSeries: 无法解析起始日期值', { startValue, seriesType })
          return workbook
        }
        
        // 计算当前日期（按步长递增）
        const daysOffset = Math.floor(currentValue - startValue)
        const currentDate = new Date(startDate.getTime() + daysOffset * 86400000)
        
        // 格式化为 YYYY-MM-DD
        sheetObj.data[row][col].value = currentDate.toISOString().split('T')[0]
        delete sheetObj.data[row][col].formula
      }
    }
  }
  return workbook
}

function removeDuplicates(workbook, { sheet, startRow, startCol, endRow, endCol, columns, hasHeader = true }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj) {
    console.error('removeDuplicates: 找不到工作表', { sheet, availableSheets: workbook.sheets?.map(s => s.name) })
    return workbook
  }
  
  if (!sheetObj.data) {
    console.error('removeDuplicates: 工作表数据为空', { sheet })
    return workbook
  }
  
  const seen = new Set()
  const rowsToDelete = []
  
  // 处理 columns 参数：确保是数组
  // columns 可能是绝对列号（1-based）或相对偏移量（0-based）
  // 注意：normalizeParams 应该已经解析了 JSON 字符串，但为了安全，这里再次处理
  let columnsToCheck = []
  
  console.log('removeDuplicates: columns 参数类型', {
    columns,
    type: typeof columns,
    isArray: Array.isArray(columns),
    stringValue: typeof columns === 'string' ? columns : undefined
  })
  
  if (Array.isArray(columns)) {
    columnsToCheck = columns.map(c => {
      if (typeof c === 'number') return c
      const parsed = parseInt(c)
      return Number.isNaN(parsed) ? c : parsed
    })
  } else if (typeof columns === 'string') {
    // 尝试解析字符串为数组（如 "[2]" 或 "2"）
    try {
      const parsed = JSON.parse(columns)
      columnsToCheck = Array.isArray(parsed) 
        ? parsed.map(c => {
          if (typeof c === 'number') return c
          const num = parseInt(c)
          return Number.isNaN(num) ? c : num
        })
        : [(() => {
          const num = parseInt(parsed)
          return Number.isNaN(num) ? parsed : num
        })()]
    } catch (e) {
      // 尝试逗号分隔
      columnsToCheck = columns.split(',').map(c => {
        const trimmed = c.trim()
        const num = parseInt(trimmed)
        return Number.isNaN(num) ? trimmed : num
      }).filter(c => c !== '')
    }
  } else if (columns === null || columns === undefined) {
    // 如果没有指定列，检查所有列（整行重复）
    const totalCols = endCol - startCol + 1
    columnsToCheck = Array.from({ length: totalCols }, (_, i) => startCol + i)
  } else {
    console.error('removeDuplicates: columns 参数格式错误', { columns, type: typeof columns })
    // 如果格式错误，使用所有列作为后备
    const totalCols = endCol - startCol + 1
    columnsToCheck = Array.from({ length: totalCols }, (_, i) => startCol + i)
  }
  
  const _detected = hasHeader ? _findHeaderRow(sheetObj.data, startRow) : null
  const dataStartRow = _detected ? _detected.dataStartRow : startRow
  const headerRow = _detected ? _detected.headerRow : null
  
  // 支持列名：将字符串列名映射为列号
  if (headerRow && columnsToCheck.some(c => typeof c === 'string')) {
    const headerCells = sheetObj.data[headerRow] || {}
    const headerMap = new Map()
    Object.entries(headerCells).forEach(([colKey, cell]) => {
      const label = String(cell?.value || '').trim()
      if (label) {
        headerMap.set(label, parseInt(colKey))
      }
    })
    const resolveColFromHeaderName = (colName) => {
      const raw = String(colName).trim()
      if (headerMap.has(raw)) return headerMap.get(raw)
      const st = stripFieldNameDecorators(raw)
      if (headerMap.has(st)) return headerMap.get(st)
      for (const [label, colNum] of headerMap.entries()) {
        if (stripFieldNameDecorators(String(label).trim()) === st) return colNum
      }
      return 0
    }
    columnsToCheck = columnsToCheck.map(c => {
      if (typeof c !== 'string') return c
      return resolveColFromHeaderName(c) || 0
    }).filter(c => typeof c === 'number' && c > 0)
  }
  
  
  // 判断 columnsToCheck 是绝对列号还是相对偏移量
  // 根据后端代码，columns 是绝对列号（1-based），例如 [2] 表示第2列（B列）
  // 如果 startCol=1（A列），columns=[2] 表示第2列（B列），实际列号 = 2
  // 判断逻辑：如果所有值都在 [startCol, endCol] 范围内，认为是绝对列号
  // 如果所有值都 < startCol，认为是相对偏移量（0-based）
  const isAbsoluteCol = columnsToCheck.length > 0 && columnsToCheck.every(c => c >= startCol && c <= endCol)
  
  // 如果 columnsToCheck 包含所有列（从 startCol 到 endCol），说明 columns 参数可能丢失了
  // 这种情况下，我们应该报错或使用默认行为
  const isAllColumns = columnsToCheck.length === (endCol - startCol + 1) && 
                        columnsToCheck.every((c, i) => c === startCol + i)
  
  if (isAllColumns && columns !== undefined && columns !== null) {
    console.warn('removeDuplicates: columns 参数可能未正确解析，使用了所有列', {
      originalColumns: columns,
      columnsToCheck,
      startCol,
      endCol
    })
  }
  
  console.log('removeDuplicates: 列号判断', {
    columnsToCheck,
    startCol,
    endCol,
    isAbsoluteCol,
    calculatedCols: columnsToCheck.map(c => {
      if (isAbsoluteCol) {
        return c // 绝对列号
      } else {
        // 相对偏移量（0-based）：如果 columns=[2]，表示第2列（相对于startCol），实际列号 = startCol + 2
        return startCol + c
      }
    })
  })
  
  for (let row = dataStartRow; row <= endRow; row++) {
    // 构建行的唯一键（基于指定列的值）
    const key = columnsToCheck.map(colSpec => {
      // colSpec 可能是绝对列号或相对偏移量
      let col
      if (isAbsoluteCol) {
        col = colSpec // 绝对列号（1-based）
      } else {
        // 相对偏移量（0-based）：columns=[2] 表示相对于startCol的第2列
        // 如果 startCol=1，columns=[2] 表示第2列（B列），实际列号 = 1 + 2 = 3（C列）？
        // 不对，如果 columns=[2] 是0-based偏移量，那么：
        // - columns=[0] 表示第1列（A列），实际列号 = startCol + 0 = 1
        // - columns=[1] 表示第2列（B列），实际列号 = startCol + 1 = 2
        // - columns=[2] 表示第3列（C列），实际列号 = startCol + 2 = 3
        // 但后端说"基于第2列（销售员）"，而 startCol=1，所以应该是B列（列号2）
        // 如果 columns=[2] 且 startCol=1，那么可能是：
        // 1. 绝对列号：col = 2（B列）✓
        // 2. 相对偏移量：col = 1 + 2 = 3（C列）✗
        // 所以应该是绝对列号
        col = startCol + colSpec
      }
      
      // 确保列号在有效范围内
      if (col < startCol || col > endCol) {
        console.warn(`removeDuplicates: 列号 ${col} 超出范围 [${startCol}, ${endCol}]`, {
          colSpec,
          isAbsoluteCol,
          calculatedCol: col
        })
        return ''
      }
      
      const cell = sheetObj.data[row]?.[col]
      if (!cell) {
        return ''
      }
      if (cell.formula) {
        // 如果是公式，计算其值
        try {
          const value = evaluateFormula(cell.formula, sheetObj.data)
          return String(value)
        } catch (e) {
          return cell.formula
        }
      }
      return String(cell.value || '')
    }).join('|')
    
    // 空键不算重复
    if (!key || key === '|' || key.split('|').every(k => k === '')) {
      continue
    }
    
    if (seen.has(key)) {
      rowsToDelete.push(row)
    } else {
      seen.add(key)
    }
  }
  
  // 从后往前删除，避免行号变化
  if (rowsToDelete.length > 0) {
    rowsToDelete.reverse().forEach((row, index) => {
      deleteRow(workbook, { sheet, row, count: 1 })
    })
  } else {
    console.log('removeDuplicates: 未发现重复行')
  }
  
  console.log('removeDuplicates: 删除重复行完成', {
    sheet,
    range: `${startRow}:${endRow}`,
    columns: columnsToCheck,
    deletedRows: rowsToDelete.length,
    rowsToDelete,
    finalRowCount: Object.keys(sheetObj.data).length
  })
  
  return workbook
}

function summarizeByColumn(workbook, {
  sheet,
  startRow,
  endRow,
  startCol,
  endCol,
  groupByCol,
  sumCol,
  targetRow,
  includeTotal = true
}) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj) return workbook
  if (!sheetObj.data) sheetObj.data = {}

  const { headerRow, dataStartRow } = _findHeaderRow(sheetObj.data, startRow)
  const groupCol = parseInt(groupByCol) || groupByCol
  const sumColNum = parseInt(sumCol) || sumCol

  const headerGroup = sheetObj.data[headerRow]?.[groupCol]?.value || '分组'
  const metricHeaderRaw = sheetObj.data[headerRow]?.[sumColNum]?.value
  const metricHeader = String(metricHeaderRaw ?? '').trim() || '指标'
  const headerSum = `${metricHeader}总和`

  const preferredStart = targetRow || (endRow + 1)
  let summaryStart = preferredStart

  // 防重：若上一行疑似手工预写了表头且目标行为空，则直接覆盖上一行，避免双表头
  if (preferredStart > 1) {
    const prevRow = sheetObj.data[preferredStart - 1] || {}
    const currRow = sheetObj.data[preferredStart] || {}
    const prevGroup = prevRow[groupCol]?.value
    const prevSum = prevRow[sumColNum]?.value
    const currGroup = currRow[groupCol]?.value
    const currSum = currRow[sumColNum]?.value
    const prevLooksHeader =
      typeof prevGroup === 'string' &&
      prevGroup.trim() &&
      typeof prevSum === 'string' &&
      prevSum.trim() &&
      Number.isNaN(Number(prevGroup)) &&
      Number.isNaN(Number(prevSum))
    const currEmpty =
      (currGroup === undefined || currGroup === null || String(currGroup).trim() === '') &&
      (currSum === undefined || currSum === null || String(currSum).trim() === '')
    if (prevLooksHeader && currEmpty) summaryStart = preferredStart - 1
  }

  // 分组汇总
  const groups = new Map()
  for (let row = dataStartRow; row <= endRow; row++) {
    const keyCell = sheetObj.data[row]?.[groupCol]
    const key = String(keyCell?.value ?? keyCell?.formula ?? '').trim()
    if (!key) continue
    const sumCell = sheetObj.data[row]?.[sumColNum]
    let val = 0
    if (sumCell?.formula) {
      try {
        val = evaluateFormula(sumCell.formula, sheetObj.data)
      } catch {
        val = 0
      }
    } else if (sumCell?.value !== undefined && sumCell?.value !== null) {
      val = typeof sumCell.value === 'number' ? sumCell.value : parseFloat(sumCell.value) || 0
    }
    groups.set(key, (groups.get(key) || 0) + (isNaN(val) ? 0 : val))
  }

  let total = 0
  Array.from(groups.entries()).forEach(([key, val]) => {
    total += val
  })

  // 清理旧内容，避免重复表头/残留数据
  const totalRows = groups.size + (includeTotal ? 1 : 0) + 1
  for (let row = summaryStart; row < summaryStart + totalRows; row++) {
    if (!sheetObj.data[row]) sheetObj.data[row] = {}
    delete sheetObj.data[row][groupCol]
    delete sheetObj.data[row][sumColNum]
  }

  let writeRow = summaryStart

  // 标题行
  if (!sheetObj.data[writeRow]) sheetObj.data[writeRow] = {}
  sheetObj.data[writeRow][groupCol] = { value: headerGroup }
  sheetObj.data[writeRow][sumColNum] = { value: headerSum }
  writeRow += 1

  // 分组汇总写入
  Array.from(groups.entries()).forEach(([key, val]) => {
    if (!sheetObj.data[writeRow]) sheetObj.data[writeRow] = {}
    sheetObj.data[writeRow][groupCol] = { value: key }
    sheetObj.data[writeRow][sumColNum] = computedNumberCell(val)
    writeRow += 1
  })

  if (includeTotal) {
    if (!sheetObj.data[writeRow]) sheetObj.data[writeRow] = {}
    sheetObj.data[writeRow][groupCol] = { value: '总计' }
    sheetObj.data[writeRow][sumColNum] = computedNumberCell(total)
    writeRow += 1
  }

  sheetObj.rowCount = Math.max(sheetObj.rowCount || 0, writeRow - 1)
  sheetObj.colCount = Math.max(sheetObj.colCount || 0, endCol || sumColNum || groupCol)
  return workbook
}

// 综合分析表每个汇总块最多允许的数据行数（含表头）
// 超出此值按 sum 降序只取 TOP N，防止日期/高基数维度写入数千行
const _COMPREHENSIVE_MAX_ROWS = 60

function summarizeMetricsByColumn(workbook, {
  sheet,
  startRow,
  endRow,
  groupByCol,
  sumCol,
  targetSheet,
  targetRow,
  targetCol = 1,
  includeTotal = true
}) {
  const toSheetName = (input) => {
    if (typeof input === 'string' && input.trim()) return input.trim()
    if (input && typeof input === 'object') {
      if (typeof input.name === 'string' && input.name.trim()) return input.name.trim()
      if (typeof input.sheet === 'string' && input.sheet.trim()) return input.sheet.trim()
      if (typeof input.sheetName === 'string' && input.sheetName.trim()) return input.sheetName.trim()
    }
    return ''
  }

  const sourceSheetName =
    toSheetName(sheet) ||
    workbook?.activeSheet ||
    workbook?.sheets?.[0]?.name ||
    ''
  const sourceSheet = getSheet(workbook, sourceSheetName)
  if (!sourceSheet) return workbook
  if (!sourceSheet.data) sourceSheet.data = {}

  const targetSheetName = toSheetName(targetSheet) || sourceSheetName
  let target = workbook?.sheets?.find(s => s.name === targetSheetName) || null
  let createdTargetSheet = false
  if (!target) {
    target = {
      name: targetSheetName,
      data: {},
      colWidths: {},
      rowHeights: {},
    }
    workbook.sheets.push(target)
    createdTargetSheet = true
  }
  if (!target.data) target.data = {}

  const { headerRow, dataStartRow } = _findHeaderRow(sourceSheet.data, startRow)
  const preferredStart = targetRow || (endRow + 1)
  let summaryStart = preferredStart

  const groupHeader = sourceSheet.data[headerRow]?.[groupByCol]?.value || '分组'
  const metricHeaderRaw = sourceSheet.data[headerRow]?.[sumCol]?.value
  const metricHeader = String(metricHeaderRaw ?? '').trim() || '指标'
  const sumHeader = `${metricHeader}总和`
  const countHeader = '记录数'
  const avgHeader = `平均${metricHeader}`
  let metricNonEmptyCount = 0
  let metricNumericCount = 0

  // 防重：若上一行疑似手工预写了表头且目标行为空，则直接覆盖上一行，避免双表头
  if (preferredStart > 1) {
    const prevRow = target.data[preferredStart - 1] || {}
    const currRow = target.data[preferredStart] || {}
    const prevCells = [
      prevRow[targetCol]?.value,
      prevRow[targetCol + 1]?.value,
      prevRow[targetCol + 2]?.value,
      prevRow[targetCol + 3]?.value,
    ]
    const currCells = [
      currRow[targetCol]?.value,
      currRow[targetCol + 1]?.value,
      currRow[targetCol + 2]?.value,
      currRow[targetCol + 3]?.value,
    ]
    const prevLooksHeader = prevCells.every((v) => typeof v === 'string' && String(v).trim() !== '')
    const currEmpty = currCells.every((v) => v === undefined || v === null || String(v).trim() === '')
    if (prevLooksHeader && currEmpty) summaryStart = preferredStart - 1
  }

  const groups = new Map()
  for (let row = dataStartRow; row <= endRow; row++) {
    const keyCell = sourceSheet.data[row]?.[groupByCol]
    const key = String(keyCell?.value ?? keyCell?.formula ?? '').trim()
    if (!key) continue
    const sumCell = sourceSheet.data[row]?.[sumCol]
    let val = 0
    if (sumCell?.formula) {
      metricNonEmptyCount += 1
      try {
        val = evaluateFormula(sumCell.formula, sourceSheet.data)
        if (typeof val === 'number' && Number.isFinite(val)) {
          metricNumericCount += 1
        }
      } catch {
        val = 0
      }
    } else if (sumCell?.value !== undefined && sumCell?.value !== null) {
      const rawVal = sumCell.value
      if (rawVal !== '' && rawVal !== null && rawVal !== undefined) {
        metricNonEmptyCount += 1
      }
      if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
        metricNumericCount += 1
      }
      val = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal) || 0
    }
    const current = groups.get(key) || { sum: 0, count: 0 }
    current.sum += isNaN(val) ? 0 : val
    current.count += 1
    groups.set(key, current)
  }

  const numericRatio = metricNonEmptyCount > 0 ? (metricNumericCount / metricNonEmptyCount) : 0
  const useCountOnly = (metricNonEmptyCount > 0 && numericRatio < 0.5)
  if (useCountOnly) {
    console.warn('summarizeMetricsByColumn: 指标列疑似ID/非数值，自动降级为记录数统计', {
      sheet: sourceSheetName, metricHeader, sumCol, metricNonEmptyCount, metricNumericCount, numericRatio,
    })
  }

  // 综合分析表：组数超出预算时按指标值降序只保留 TOP N，避免日期/高基数维度写入数千行
  const targetSheetNameStr = String(targetSheet || sheet || '').trim()
  const isComprehensiveTarget = targetSheetNameStr === '\u7efc\u5408\u5206\u6790'
  if (isComprehensiveTarget && groups.size > _COMPREHENSIVE_MAX_ROWS) {
    const sorted = Array.from(groups.entries()).sort((a, b) => {
      const va = useCountOnly ? b[1].count : b[1].sum
      const vb = useCountOnly ? a[1].count : a[1].sum
      return va - vb
    })
    groups.clear()
    sorted.slice(0, _COMPREHENSIVE_MAX_ROWS).forEach(([k, v]) => groups.set(k, v))
  }

  // 清理旧内容，避免重复表头/残留数据
  const metricCols = useCountOnly ? 2 : 4
  const totalRows = groups.size + (includeTotal ? 1 : 0) + 1
  for (let row = summaryStart; row < summaryStart + totalRows; row++) {
    if (!target.data[row]) target.data[row] = {}
    for (let col = targetCol; col <= targetCol + metricCols - 1; col++) {
      delete target.data[row][col]
    }
  }

  let writeRow = summaryStart
  if (!target.data[writeRow]) target.data[writeRow] = {}
  target.data[writeRow][targetCol] = { value: groupHeader }
  if (useCountOnly) {
    target.data[writeRow][targetCol + 1] = { value: countHeader }
  } else {
    target.data[writeRow][targetCol + 1] = { value: sumHeader }
    target.data[writeRow][targetCol + 2] = { value: countHeader }
    target.data[writeRow][targetCol + 3] = { value: avgHeader }
  }
  writeRow += 1

  let totalSum = 0
  let totalCount = 0
  Array.from(groups.entries()).forEach(([key, metric]) => {
    if (!target.data[writeRow]) target.data[writeRow] = {}
    const avg = metric.count > 0 ? metric.sum / metric.count : 0
    target.data[writeRow][targetCol] = { value: key }
    if (useCountOnly) {
      target.data[writeRow][targetCol + 1] = computedNumberCell(metric.count)
    } else {
      target.data[writeRow][targetCol + 1] = computedNumberCell(metric.sum)
      target.data[writeRow][targetCol + 2] = computedNumberCell(metric.count)
      target.data[writeRow][targetCol + 3] = computedNumberCell(avg)
    }
    totalSum += metric.sum
    totalCount += metric.count
    writeRow += 1
  })

  if (includeTotal) {
    if (!target.data[writeRow]) target.data[writeRow] = {}
    target.data[writeRow][targetCol] = { value: '总计' }
    if (useCountOnly) {
      target.data[writeRow][targetCol + 1] = computedNumberCell(totalCount)
    } else {
      target.data[writeRow][targetCol + 1] = computedNumberCell(totalSum)
      target.data[writeRow][targetCol + 2] = computedNumberCell(totalCount)
      // 业务约束：平均列不参与总计展示，避免语义误导
      target.data[writeRow][targetCol + 3] = { value: '' }
    }
    writeRow += 1
  }

  target.rowCount = Math.max(target.rowCount || 0, writeRow - 1)
  target.colCount = Math.max(target.colCount || 0, targetCol + metricCols - 1)
  if (createdTargetSheet) {
    workbook.activeSheet = targetSheetName
  }
  return workbook
}

// ---- conditional_format: 前端可渲染的 condition.type 白名单 ----
const _CF_SUPPORTED_TYPES = new Set([
  'greaterThan', 'lessThan', 'between',
  'equal', 'text', 'textEquals',
  'containsText', 'notContainsText', 'beginsWith', 'endsWith',
  'duplicate', 'duplicateValues', 'uniqueValues',
  'top10', 'bottom10',
  'greaterThanAverage', 'aboveAverage', 'belowAverage',
  'colorScale',
])

function conditionalFormat(workbook, { sheet, startRow, startCol, endRow, endCol, condition, format }) {
  const condType = condition?.type || ''
  if (!_CF_SUPPORTED_TYPES.has(condType)) {
    console.error(`[excelOperations] conditional_format: unsupported type "${condType}", supported: ${[..._CF_SUPPORTED_TYPES].join(', ')}`)
    throw new Error('抱歉，该条件格式功能目前还在学习中，暂时无法执行。')
  }
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.conditionalFormats) sheetObj.conditionalFormats = []

  // 同一范围 + 同一规则类型重复下发时，保留最新规则，避免旧阈值遮蔽新阈值。
  sheetObj.conditionalFormats = sheetObj.conditionalFormats.filter((rule) => {
    if (!rule || typeof rule !== 'object') return true
    const sameRange =
      Number(rule.startRow) === Number(startRow) &&
      Number(rule.startCol) === Number(startCol) &&
      Number(rule.endRow) === Number(endRow) &&
      Number(rule.endCol) === Number(endCol)
    const sameType = String(rule?.condition?.type || '') === String(condType)
    return !(sameRange && sameType)
  })

  sheetObj.conditionalFormats.push({ startRow, startCol, endRow, endCol, condition, format })
  return workbook
}

function clearFormatting(workbook, { sheet, startRow, startCol, endRow, endCol }) {
  const sheetObj = getSheet(workbook, sheet)
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (sheetObj.data[row]?.[col]?.style) {
        delete sheetObj.data[row][col].style
      }
    }
  }
  return workbook
}

function clearConditionalFormat(workbook, { sheet, startRow, startCol, endRow, endCol }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!Array.isArray(sheetObj.conditionalFormats) || sheetObj.conditionalFormats.length === 0) {
    return workbook
  }

  const overlaps = (rule) => {
    const rs = Number(rule?.startRow)
    const re = Number(rule?.endRow)
    const cs = Number(rule?.startCol)
    const ce = Number(rule?.endCol)
    if (![rs, re, cs, ce].every(Number.isFinite)) return false
    return !(re < startRow || rs > endRow || ce < startCol || cs > endCol)
  }

  sheetObj.conditionalFormats = sheetObj.conditionalFormats.filter(rule => !overlaps(rule))
  return workbook
}

function createPivotData(workbook, { 
  sheet, startRow, startCol, endRow, endCol, 
  rowFields, colFields = [], valueField, aggregateFunction = 'sum',
  targetSheet, targetRow = 1, targetCol = 1 
}) {
  // 兼容 sheet / targetSheet 传对象（如 { name: 'Sheet1' }）
  const toSheetName = (input) => {
    if (typeof input === 'string' && input.trim()) return input.trim()
    if (input && typeof input === 'object') {
      if (typeof input.name === 'string' && input.name.trim()) return input.name.trim()
      if (typeof input.sheet === 'string' && input.sheet.trim()) return input.sheet.trim()
      if (typeof input.sheetName === 'string' && input.sheetName.trim()) return input.sheetName.trim()
    }
    return ''
  }
  const normalizeFieldList = (fieldLike) => {
    if (Array.isArray(fieldLike)) return fieldLike.filter(Boolean)
    if (typeof fieldLike === 'string') return fieldLike.split(',').map(s => s.trim()).filter(Boolean)
    return fieldLike ? [fieldLike] : []
  }
  const normalizeAgg = (agg) => String(agg || 'sum').toLowerCase()
  const getAggResult = (values, agg) => {
    if (!values.length) return 0
    if (agg === 'sum') return roundComputedNumber(values.reduce((a, b) => a + b, 0))
    if (agg === 'average') return roundComputedNumber(values.reduce((a, b) => a + b, 0) / values.length)
    if (agg === 'count') return values.length
    if (agg === 'max') return roundComputedNumber(Math.max(...values))
    if (agg === 'min') return roundComputedNumber(Math.min(...values))
    return roundComputedNumber(values.reduce((a, b) => a + b, 0))
  }
  const valueToText = (v) => (v === undefined || v === null ? '' : String(v))

  let sourceSheetName =
    toSheetName(sheet) ||
    workbook?.activeSheet ||
    workbook?.sheets?.[0]?.name ||
    ''
  let sourceSheetObj = getSheet(workbook, sourceSheetName)
  if (!sourceSheetObj) {
    sourceSheetName = workbook?.sheets?.[0]?.name || sourceSheetName
    sourceSheetObj = getSheet(workbook, sourceSheetName)
    if (!sourceSheetObj) return workbook
  }

  const targetSheetName = toSheetName(targetSheet) || sourceSheetName
  let targetSheetObj = getSheet(workbook, targetSheetName)
  let createdTargetSheet = false
  if (!targetSheetObj) {
    targetSheetObj = { name: targetSheetName, data: {}, colWidths: {}, rowHeights: {} }
    workbook.sheets.push(targetSheetObj)
    createdTargetSheet = true
  }

  const rowFieldsArray = normalizeFieldList(rowFields)
  const colFieldsArray = normalizeFieldList(colFields)
  if (!rowFieldsArray.length || !valueField) {
    console.error('createPivotData: rowFields 和 valueField 为必填')
    return workbook
  }

  // 读取表头
  const headers = []
  for (let col = startCol; col <= endCol; col++) {
    const cell = sourceSheetObj.data[startRow]?.[col]
    headers.push(cell?.value !== undefined && cell?.value !== null ? String(cell.value) : '')
  }
  if (!headers.length) return workbook

  // 字段严格匹配（支持大小写/列号）；未命中直接中止，避免输出脏透视表
  const matchedRowFields = rowFieldsArray.map(field => resolvePivotFieldName(field, headers, startCol))
  if (matchedRowFields.some(f => !f)) {
    console.error('createPivotData: 行字段未匹配', { rowFieldsArray, headers, matchedRowFields })
    return workbook
  }
  const matchedColFields = colFieldsArray.map(field => resolvePivotFieldName(field, headers, startCol))
  if (matchedColFields.some(f => !f)) {
    console.error('createPivotData: 列字段未匹配', { colFieldsArray, headers, matchedColFields })
    return workbook
  }
  const matchedValueField = resolvePivotFieldName(valueField, headers, startCol)
  if (!matchedValueField) {
    console.error('createPivotData: 值字段未匹配', { valueField, headers })
    return workbook
  }

  // 读取数据行
  const data = []
  for (let row = startRow + 1; row <= endRow; row++) {
    const rowData = {}
    for (let col = startCol; col <= endCol; col++) {
      const cell = sourceSheetObj.data[row]?.[col]
      rowData[headers[col - startCol]] = cell?.value ?? cell?.formula ?? ''
    }
    data.push(rowData)
  }

  // 构建透视缓存：rowKey -> colKey -> [values]
  const pivotData = {}
  const allColKeySet = new Set()
  for (const row of data) {
    const rowKey = matchedRowFields.map(field => valueToText(row[field])).join('|')
    const colKey = matchedColFields.length > 0
      ? matchedColFields.map(field => valueToText(row[field])).join('|')
      : '总计'
    const raw = row[matchedValueField]
    const value = Number(raw)
    const num = Number.isNaN(value) ? 0 : value

    if (!pivotData[rowKey]) pivotData[rowKey] = {}
    if (!pivotData[rowKey][colKey]) pivotData[rowKey][colKey] = []
    pivotData[rowKey][colKey].push(num)
    allColKeySet.add(colKey)
  }

  const sortedRowKeys = Object.keys(pivotData).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const sortedColKeys = Array.from(allColKeySet).sort((a, b) => a.localeCompare(b, 'zh-CN'))

  // 写入表头行（固定列结构）
  const agg = normalizeAgg(aggregateFunction)
  if (!targetSheetObj.data[targetRow]) targetSheetObj.data[targetRow] = {}
  matchedRowFields.forEach((field, idx) => {
    targetSheetObj.data[targetRow][targetCol + idx] = { value: field }
  })
  sortedColKeys.forEach((colKey, idx) => {
    const colHeader = matchedColFields.length > 0
      ? `${colKey}(${agg})`
      : `${matchedValueField}(${agg})`
    targetSheetObj.data[targetRow][targetCol + matchedRowFields.length + idx] = { value: colHeader }
  })

  // 写入数据行（按全局列键顺序稳定输出）
  let currentRow = targetRow + 1
  for (const rowKey of sortedRowKeys) {
    if (!targetSheetObj.data[currentRow]) targetSheetObj.data[currentRow] = {}
    const rowParts = rowKey.split('|')
    rowParts.forEach((part, idx) => {
      targetSheetObj.data[currentRow][targetCol + idx] = { value: part }
    })
    sortedColKeys.forEach((colKey, colIdx) => {
      const values = pivotData[rowKey]?.[colKey] || []
      const aggResult = getAggResult(values, agg)
      targetSheetObj.data[currentRow][targetCol + matchedRowFields.length + colIdx] = {
        ...computedNumberCell(aggResult),
      }
    })
    currentRow += 1
  }

  if (createdTargetSheet) {
    workbook.activeSheet = targetSheetName
  }
  return workbook
}

function calculateStatistics(workbook, { sheet, startRow, startCol, endRow, endCol, outputRow, outputCol }) {
  const sheetObj = getSheet(workbook, sheet)

  // ── 数据保护守卫：禁止统计结果覆盖源数据区域 ──
  const safeOutputRow = (typeof outputRow === 'number' && outputRow > endRow)
    ? outputRow
    : endRow + 2
  const safeOutputCol = (typeof outputCol === 'number') ? outputCol : startCol

  if (typeof outputRow === 'number' && outputRow >= startRow && outputRow <= endRow) {
    console.warn(
      '[calculateStatistics] outputRow 落入数据区(%d~%d)，已自动修正到 %d',
      startRow, endRow, safeOutputRow
    )
  }

  const values = []
  for (let row = startRow; row <= endRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      const cell = sheetObj.data[row]?.[col]
      const val = parseFloat(cell?.value) || 0
      if (!isNaN(val)) values.push(val)
    }
  }
  if (values.length === 0) return workbook

  const sum = values.reduce((a, b) => a + b, 0)
  const avg = sum / values.length
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)]
  const variance = values.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / values.length
  const stdDev = Math.sqrt(variance)

  const stats = [
    { label: '总和', value: roundComputedNumber(sum) },
    { label: '平均值', value: roundComputedNumber(avg) },
    { label: '计数', value: values.length },
    { label: '最小值', value: roundComputedNumber(min) },
    { label: '最大值', value: roundComputedNumber(max) },
    { label: '中位数', value: roundComputedNumber(median) },
    { label: '标准差', value: roundComputedNumber(stdDev) },
  ]

  stats.forEach((stat, idx) => {
    const r = safeOutputRow + idx
    if (!sheetObj.data[r]) sheetObj.data[r] = {}
    sheetObj.data[r][safeOutputCol] = { value: stat.label }
    sheetObj.data[r][safeOutputCol + 1] = computedNumberCell(stat.value)
  })

  return workbook
}

function setDataValidation(workbook, {
  sheet, startRow, startCol, endRow, endCol,
  validation, validationType, validationParams,
}) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.dataValidations) sheetObj.dataValidations = []
  
  // 规范化验证参数（特别是日期验证）
  let normalizedValidation = validation
  if ((!normalizedValidation || typeof normalizedValidation !== 'object') && validationType) {
    normalizedValidation = {
      type: validationType,
      params: validationParams || {},
    }
  }
  if (normalizedValidation && typeof normalizedValidation === 'object') {
    const finalValidationType = normalizedValidation.type || normalizedValidation.validationType || validationType
    const finalValidationParams =
      normalizedValidation.params ||
      normalizedValidation.validationParams ||
      validationParams ||
      normalizedValidation
    normalizedValidation = {
      ...normalizedValidation,
      type: finalValidationType,
      params: normalizeValidationParams(finalValidationType, finalValidationParams)
    }
  }
  
  sheetObj.dataValidations.push({ startRow, startCol, endRow, endCol, validation: normalizedValidation })
  return workbook
}

function removeDataValidation(workbook, { sheet, startRow, startCol, endRow, endCol }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.dataValidations) {
    sheetObj.dataValidations = sheetObj.dataValidations.filter(v => 
      !(v.startRow === startRow && v.startCol === startCol && 
        v.endRow === endRow && v.endCol === endCol)
    )
  }
  return workbook
}

function addComment(workbook, { sheet, row, col, comment }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.data[row]) sheetObj.data[row] = {}
  if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
  if (!sheetObj.data[row][col].comments) sheetObj.data[row][col].comments = []
  sheetObj.data[row][col].comments.push({ text: comment, author: 'System', date: new Date().toISOString() })
  return workbook
}

function deleteComment(workbook, { sheet, row, col, commentId }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.data[row]?.[col]?.comments) {
    sheetObj.data[row][col].comments = sheetObj.data[row][col].comments.filter(c => c.id !== commentId)
  }
  return workbook
}

function updateComment(workbook, { sheet, row, col, commentId, comment }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.data[row]?.[col]?.comments) {
    const commentObj = sheetObj.data[row][col].comments.find(c => c.id === commentId)
    if (commentObj) {
      commentObj.text = comment
    }
  }
  return workbook
}

function setHyperlink(workbook, { sheet, row, col, url, text }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.data[row]) sheetObj.data[row] = {}
  if (!sheetObj.data[row][col]) sheetObj.data[row][col] = {}
  const normalizedText = typeof text === 'string' && text.trim() ? text.trim() : undefined
  sheetObj.data[row][col].hyperlink = normalizedText ? { url, text: normalizedText } : { url }
  return workbook
}

function removeHyperlink(workbook, { sheet, row, col }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.data[row]?.[col]?.hyperlink) {
    delete sheetObj.data[row][col].hyperlink
  }
  return workbook
}

function insertImage(workbook, { sheet, row, col, imagePath, width, height, offsetX = 0, offsetY = 0 }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.images) sheetObj.images = []
  sheetObj.images.push({ row, col, imagePath, width, height, offsetX, offsetY })
  return workbook
}

function deleteImage(workbook, { sheet, imageId }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.images) {
    sheetObj.images = sheetObj.images.filter(img => img.id !== imageId)
  }
  return workbook
}

function updateImage(workbook, { sheet, imageId, width, height, offsetX, offsetY }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.images) {
    const image = sheetObj.images.find(img => img.id === imageId)
    if (image) {
      if (width !== undefined) image.width = width
      if (height !== undefined) image.height = height
      if (offsetX !== undefined) image.offsetX = offsetX
      if (offsetY !== undefined) image.offsetY = offsetY
    }
  }
  return workbook
}

function insertShape(workbook, { sheet, row, col, shapeType, width, height, style }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.shapes) sheetObj.shapes = []
  sheetObj.shapes.push({ row, col, shapeType, width, height, style })
  return workbook
}

function deleteShape(workbook, { sheet, shapeId }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.shapes) {
    sheetObj.shapes = sheetObj.shapes.filter(shape => shape.id !== shapeId)
  }
  return workbook
}

function updateShape(workbook, { sheet, shapeId, width, height, style }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.shapes) {
    const shape = sheetObj.shapes.find(s => s.id === shapeId)
    if (shape) {
      if (width !== undefined) shape.width = width
      if (height !== undefined) shape.height = height
      if (style) Object.assign(shape.style, style)
    }
  }
  return workbook
}

// ── 图表智能定位 ──
// 默认列宽 72px，行高 20px（Univer 默认近似值），用于将像素尺寸转为行列跨度。
const _COL_PX = 72
const _ROW_PX = 20

function _resolveChartPosition(sheetObj, dataRangeMeta, reqRow, reqCol, chartW, chartH) {
  const charts = sheetObj.charts || []

  // 工作表整体数据区边界（遍历所有非空单元格取最大行列）
  let dataMaxRow = dataRangeMeta?.endRow ?? 1
  let dataMaxCol = dataRangeMeta?.endCol ?? 1
  const data = sheetObj.data || {}
  for (const rKey of Object.keys(data)) {
    const r = Number(rKey)
    if (!Number.isFinite(r)) continue
    const rowObj = data[rKey]
    if (!rowObj || typeof rowObj !== 'object') continue
    for (const cKey of Object.keys(rowObj)) {
      const c = Number(cKey)
      if (!Number.isFinite(c)) continue
      const cell = rowObj[cKey]
      if (cell?.value != null && cell.value !== '') {
        if (r > dataMaxRow) dataMaxRow = r
        if (c > dataMaxCol) dataMaxCol = c
      }
    }
  }

  // 图表占据的行列跨度（向上取整 + 1 行间距）
  const chartRowSpan = Math.ceil(chartH / _ROW_PX) + 1
  const chartColSpan = Math.ceil(chartW / _COL_PX) + 1

  // 默认锚定列：数据区右侧 2 列（给数据区留一点空隙）
  const anchorCol = dataMaxCol + 2

  // 收集同一列带（anchorCol 附近）已有图表占据的行区间
  const occupied = charts.map(c => {
    const cRow = c.row || 1
    const cCol = c.col || 1
    const cRowEnd = cRow + Math.ceil((c.height || 300) / _ROW_PX)
    const cColEnd = cCol + Math.ceil((c.width || 400) / _COL_PX)
    return { row: cRow, col: cCol, rowEnd: cRowEnd, colEnd: cColEnd }
  })

  // 检查两个矩形是否重叠
  const overlaps = (r, c, rEnd, cEnd) =>
    occupied.some(o => r < o.rowEnd && rEnd > o.row && c < o.colEnd && cEnd > o.col)

  // 检查是否与数据区重叠
  const hitsData = (r, c) => r <= dataMaxRow && c <= dataMaxCol

  // 情况 1：Agent 给了合法位置且不重叠、不覆盖数据区 → 直接使用
  if (reqRow >= 1 && reqCol >= 1) {
    const rEnd = reqRow + chartRowSpan
    const cEnd = reqCol + chartColSpan
    if (!hitsData(reqRow, reqCol) && !overlaps(reqRow, reqCol, rEnd, cEnd)) {
      return { chartRow: reqRow, chartCol: reqCol }
    }
  }

  // 情况 2：自动寻位 — 从 (row=1, col=anchorCol) 开始，逐步下移找到无重叠位置
  let tryRow = 1
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rEnd = tryRow + chartRowSpan
    const cEnd = anchorCol + chartColSpan
    if (!overlaps(tryRow, anchorCol, rEnd, cEnd)) {
      return { chartRow: tryRow, chartCol: anchorCol }
    }
    // 找到与当前位置重叠的最低边界，跳到其下方
    let maxBottom = tryRow + 1
    for (const o of occupied) {
      if (tryRow < o.rowEnd && rEnd > o.row && anchorCol < o.colEnd && cEnd > o.col) {
        maxBottom = Math.max(maxBottom, o.rowEnd + 1)
      }
    }
    tryRow = maxBottom
  }

  return { chartRow: tryRow, chartCol: anchorCol }
}

function _resolveComprehensiveChartPosition(sheetObj, dataRangeMeta, chartW, chartH) {
  const charts = sheetObj.charts || []
  const chartRowSpan = Math.ceil(chartH / _ROW_PX) + 1
  const chartColSpan = Math.ceil(chartW / _COL_PX) + 1
  const slotCol = Math.max(1, Number(dataRangeMeta?.startCol || 1))
  let tryRow = Math.max(1, Number(dataRangeMeta?.endRow || 1) + 2)

  const occupied = charts.map(c => {
    const cRow = c.row || 1
    const cCol = c.col || 1
    const cRowEnd = cRow + Math.ceil((c.height || 300) / _ROW_PX)
    const cColEnd = cCol + Math.ceil((c.width || 400) / _COL_PX)
    return { row: cRow, col: cCol, rowEnd: cRowEnd, colEnd: cColEnd }
  })

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rEnd = tryRow + chartRowSpan
    const cEnd = slotCol + chartColSpan
    let overlap = false
    let maxBottom = tryRow
    for (const o of occupied) {
      const colIntersects = slotCol < o.colEnd && cEnd > o.col
      const rowIntersects = tryRow < o.rowEnd && rEnd > o.row
      if (colIntersects && rowIntersects) {
        overlap = true
        maxBottom = Math.max(maxBottom, o.rowEnd + 1)
      }
    }
    if (!overlap) {
      return { chartRow: tryRow, chartCol: slotCol }
    }
    tryRow = maxBottom
  }
  return { chartRow: tryRow, chartCol: slotCol }
}

function createChart(workbook, { sheet, chartType, dataRange, title, row, col, width, height }) {
  const sheetObj = getSheet(workbook, sheet)
  if (!sheetObj.charts) sheetObj.charts = []
  
  // 生成唯一ID
  const chartId = `chart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  
  // 确保 dataRange 是字符串格式
  let dataRangeStr = ''
  if (typeof dataRange === 'string') {
    dataRangeStr = dataRange
  } else if (typeof dataRange === 'object' && dataRange !== null) {
    // 如果是对象，尝试转换（normalizeParams 应该已经处理过了，这里作为备用）
    console.warn('createChart: dataRange 仍然是对象格式，尝试转换', { dataRange })
    if (dataRange.start && dataRange.end) {
      const colToLetter = (col) => {
        let result = ''
        let temp = col
        while (temp > 0) {
          temp--
          result = String.fromCharCode(65 + (temp % 26)) + result
          temp = Math.floor(temp / 26)
        }
        return result
      }
      const startCol = colToLetter(dataRange.start.col || dataRange.start.colIndex || 1)
      const startRow = dataRange.start.row || dataRange.start.rowIndex || 1
      const endCol = colToLetter(dataRange.end.col || dataRange.end.colIndex || 1)
      const endRow = dataRange.end.row || dataRange.end.rowIndex || 1
      dataRangeStr = `${startCol}${startRow}:${endCol}${endRow}`
    } else {
      dataRangeStr = String(dataRange)
    }
  } else {
    dataRangeStr = String(dataRange || '')
  }

  // 图表数据源质量闸门：避免“明细噪声数据”直接成图导致无意义可视化
  const parseRangeA1 = (rangeStr) => {
    if (!rangeStr || typeof rangeStr !== 'string') return null
    const clean = rangeStr.replace(/^[^!]*!/, '')
    const m = clean.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i)
    if (!m) return null
    const parseCol = (letters) =>
      String(letters || '')
        .toUpperCase()
        .split('')
        .reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0)
    return {
      startCol: parseCol(m[1]),
      startRow: parseInt(m[2], 10),
      endCol: parseCol(m[3]),
      endRow: parseInt(m[4], 10),
    }
  }
  const toLetters = (num) => {
    let s = ''
    let n = Number(num || 0)
    while (n > 0) {
      n -= 1
      s = String.fromCharCode(65 + (n % 26)) + s
      n = Math.floor(n / 26)
    }
    return s || 'A'
  }
  const getCellRaw = (r, c) => {
    const cell = sheetObj.data?.[r]?.[c]
    return cell?.value ?? cell?.formula ?? ''
  }
  const isNonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== ''
  const toNumeric = (raw) => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
    if (raw === undefined || raw === null) return NaN
    let text = String(raw).trim()
    if (!text) return NaN
    // 兼容常见展示格式：千分位、货币符号、百分号、中文逗号
    text = text.replace(/[,\s，]/g, '')
    text = text.replace(/[￥¥$€£]/g, '')
    const isPercent = /%$/.test(text)
    text = text.replace(/%$/, '')
    text = text.replace(/[^\d.+-]/g, '')
    if (!text || text === '-' || text === '+' || text === '.' || text === '-.' || text === '+.') return NaN
    const n = Number(text)
    if (!Number.isFinite(n)) return NaN
    return isPercent ? n / 100 : n
  }
  // 合并从属单元格复制主单元格值 → 整行非空数虚高。
  // 改用 DISTINCT 计数，与 _findHeaderRow 对齐。
  const rowNonEmptyCount = (r, startC, endC) => {
    const seen = new Set()
    for (let c = startC; c <= endC; c += 1) {
      const v = getCellRaw(r, c)
      if (isNonEmpty(v)) seen.add(String(v))
    }
    return seen.size
  }

  const rangeMeta = parseRangeA1(dataRangeStr)
  if (!rangeMeta) {
    throw new Error('图表数据范围无效，请先生成结构化汇总表后再创建图表。')
  }

  // 数据范围自愈 0：跳过前导空行（Agent 可能把 dataRange 起始行设在表头上方的空行）
  const MAX_SKIP_EMPTY = 5
  for (let skip = 0; skip < MAX_SKIP_EMPTY && rangeMeta.startRow < rangeMeta.endRow; skip += 1) {
    if (rowNonEmptyCount(rangeMeta.startRow, rangeMeta.startCol, rangeMeta.endCol) === 0) {
      rangeMeta.startRow += 1
    } else {
      break
    }
  }

  // 数据范围自愈 1：若首行是单格标题（如“品类销售分析”），自动跳过标题行。
  const firstRowCells = rowNonEmptyCount(rangeMeta.startRow, rangeMeta.startCol, rangeMeta.endCol)
  const secondRowCells = rowNonEmptyCount(rangeMeta.startRow + 1, rangeMeta.startCol, rangeMeta.endCol)
  if (firstRowCells === 1 && secondRowCells >= 2) {
    rangeMeta.startRow += 1
  }

  // 数据范围自愈 2：若范围横跨多个分组表（中间空列分隔），截断为第一块连续分组。
  const sampleEndRow = Math.min(rangeMeta.endRow, rangeMeta.startRow + 4)
  for (let c = rangeMeta.startCol + 1; c <= rangeMeta.endCol - 1; c += 1) {
    let allEmpty = true
    for (let r = rangeMeta.startRow; r <= sampleEndRow; r += 1) {
      if (isNonEmpty(getCellRaw(r, c))) {
        allEmpty = false
        break
      }
    }
    if (allEmpty) {
      rangeMeta.endCol = c - 1
      break
    }
  }
  // 数据范围自愈 3：向下扩展到连续数据尾部，避免“只取刁5/8行”的截断。
  // 综合分析表禁用向下扩展：该表各数据块紧密相邻，若扩展会穿透到下一块
  // （如日期汇总写入1845行导致图表被判超限）。后端布局引擎已给出宽裕的 endRow 预算。
  const _SEP_ROW_RE = /^=+[^=]*=+$|^-{3,}$/
  const isSepRow = (r) => {
    const txt = String(getCellRaw(r, rangeMeta.startCol) ?? '').trim()
    return txt.length > 0 && _SEP_ROW_RE.test(txt)
  }
  const isComprehensiveSheet = String(sheet || '').trim() === '综合分析'
  if (!isComprehensiveSheet) {
    const rowKeys = Object.keys(sheetObj.data || {}).map((k) => Number(k)).filter((n) => Number.isFinite(n))
    const maxRow = Number(sheetObj.rowCount || 0) > 0 ? Number(sheetObj.rowCount) : (rowKeys.length ? Math.max(...rowKeys) : rangeMeta.endRow)
    for (let r = rangeMeta.endRow + 1; r <= maxRow; r += 1) {
      const labelText = String(getCellRaw(r, rangeMeta.startCol) ?? '').trim()
      if (isSepRow(r)) break
      let hasNumeric = false
      for (let c = rangeMeta.startCol + 1; c <= rangeMeta.endCol; c += 1) {
        const raw = getCellRaw(r, c)
        if (!isNonEmpty(raw)) continue
        const n = typeof raw === 'number' ? raw : parseFloat(raw)
        if (Number.isFinite(n)) {
          hasNumeric = true
          break
        }
      }
      if (!labelText && !hasNumeric) break
      rangeMeta.endRow = r
    }
  }

  // 数据范围自愈 3b：裁剪原始范围尾部的空行（dataRange 可能包含多余空行）
  while (rangeMeta.endRow > rangeMeta.startRow + 1 &&
    rowNonEmptyCount(rangeMeta.endRow, rangeMeta.startCol, rangeMeta.endCol) === 0) {
    rangeMeta.endRow -= 1
  }

  // 数据范围自愈 4：剔除"总计/合计"行 —— 汇总行纳入饼图/柱图会严重失真（占比翻倍、总计扇区）。
  // 规则：扫描标签列，命中汇总关键词的行从 endRow 倒序剔除（尾部），中间出现的行记录跳过。
  const TOTAL_ROW_RE = /^(总计|合计|小计|汇总|total|grand\s+total|subtotal|sub\s+total|sum)$/i
  const isTotalRowLabel = (r) => TOTAL_ROW_RE.test(String(getCellRaw(r, rangeMeta.startCol) ?? '').trim())

  // 尾部倒删（最常见：总计在最后一行）
  while (rangeMeta.endRow > rangeMeta.startRow + 1 && isTotalRowLabel(rangeMeta.endRow)) {
    rangeMeta.endRow -= 1
  }
  // 收集中间夹着的总计行（渲染层跳过）
  const totalRowsToSkip = new Set()
  for (let r = rangeMeta.startRow + 1; r < rangeMeta.endRow; r += 1) {
    if (isTotalRowLabel(r)) totalRowsToSkip.add(r)
  }

  dataRangeStr = `${toLetters(rangeMeta.startCol)}${rangeMeta.startRow}:${toLetters(rangeMeta.endCol)}${rangeMeta.endRow}`
  const requestedTypeLower = String(chartType || 'column').toLowerCase()
  let resolvedTypeLower = requestedTypeLower === 'donut' ? 'doughnut' : requestedTypeLower

  const deriveChartDimensionKey = (rangeStr) => {
    const meta = parseRangeA1(rangeStr)
    if (!meta) return null
    const labelHeader = String(getCellRaw(meta.startRow, meta.startCol) ?? '').trim()
    let valueHeader = ''
    for (let c = meta.startCol + 1; c <= meta.endCol; c += 1) {
      const candidate = String(getCellRaw(meta.startRow, c) ?? '').trim()
      if (candidate) {
        valueHeader = candidate
        break
      }
    }
    if (!labelHeader && !valueHeader) return null
    // 同一工作表的不同槽位允许同表头共存；将列锚点纳入维度 key，避免跨槽位误去重
    return `${String(sheet || '').trim()}|c${meta.startCol}-${meta.endCol}|${labelHeader}|${valueHeader}`
  }

  const dimensionKey = deriveChartDimensionKey(dataRangeStr)
  if (dimensionKey) {
    const duplicated = (sheetObj.charts || []).some((existingChart) => {
      const existingKey = existingChart?._sheetbotDimensionKey || deriveChartDimensionKey(String(existingChart?.dataRange || ''))
      return existingKey === dimensionKey
    })
    if (duplicated) {
      console.warn('createChart: 命中同维度去重，跳过重复图表', { sheet, dataRange: dataRangeStr, dimensionKey })
      return workbook
    }
  }

  // 同表同列槽位行区间高度重叠去重（补图 + 模型各画一张时维度 key 可能因表头脏行不一致）
  // 仅在列区间有交集时判重，避免跨槽位（A/G/M）被误判重复。
  const rowSpanOverlapDup = (sheetObj.charts || []).some((existingChart) => {
    const exStr = String(existingChart?.dataRange || '')
    const em = parseRangeA1(exStr)
    if (!em) return false
    const col0 = Math.max(rangeMeta.startCol, em.startCol)
    const col1 = Math.min(rangeMeta.endCol, em.endCol)
    if (col1 < col0) return false
    const r0 = Math.max(rangeMeta.startRow, em.startRow)
    const r1 = Math.min(rangeMeta.endRow, em.endRow)
    if (r1 < r0) return false
    const inter = r1 - r0 + 1
    const spanUnion =
      Math.max(rangeMeta.endRow, em.endRow) - Math.min(rangeMeta.startRow, em.startRow) + 1
    return spanUnion > 0 && inter / spanUnion >= 0.55
  })
  if (rowSpanOverlapDup) {
    console.warn('createChart: 与已有图表数据区行区间高度重叠，跳过重复图', { sheet, dataRange: dataRangeStr })
    return workbook
  }

  // 饼图自愈：若只给了单列数值区，优先尝试自动补左侧标签列
  if ((resolvedTypeLower === 'pie' || resolvedTypeLower === 'doughnut' || resolvedTypeLower === 'donut')) {
    const pieColCount = Math.max(0, rangeMeta.endCol - rangeMeta.startCol + 1)
    if (pieColCount < 2 && rangeMeta.startCol > 1) {
      const labelCol = rangeMeta.startCol - 1
      let labelRows = 0
      let numericRows = 0
      for (let r = rangeMeta.startRow + 1; r <= rangeMeta.endRow; r++) {
        const labelRaw = sheetObj.data?.[r]?.[labelCol]?.value ?? sheetObj.data?.[r]?.[labelCol]?.formula ?? ''
        const valueRaw = sheetObj.data?.[r]?.[rangeMeta.startCol]?.value ?? sheetObj.data?.[r]?.[rangeMeta.startCol]?.formula
        const labelText = String(labelRaw ?? '').trim()
        if (labelText) labelRows += 1
        const n = toNumeric(valueRaw)
        if (Number.isFinite(n)) numericRows += 1
      }
      if (labelRows > 0 && numericRows > 0) {
        rangeMeta.startCol = labelCol
        dataRangeStr = `${toLetters(rangeMeta.startCol)}${rangeMeta.startRow}:${toLetters(rangeMeta.endCol)}${rangeMeta.endRow}`
      }
    }
  }
  const MAX_CHART_ROWS_HARD = 1200
  const MAX_RAW_DATA_ROWS = 200

  const calcRangeStats = (meta) => {
    const rowCount = Math.max(0, meta.endRow - meta.startRow + 1)
    const colCount = Math.max(0, meta.endCol - meta.startCol + 1)
    let numericCount = 0
    let totalDataCells = 0
    let observedRows = 0
    let rowsWithNumeric = 0
    const firstColValues = []
    for (let r = meta.startRow + 1; r <= meta.endRow; r++) {
      const labelCell = sheetObj.data?.[r]?.[meta.startCol]
      const labelRaw = labelCell?.value ?? labelCell?.formula ?? ''
      const labelText = String(labelRaw ?? '').trim()
      let rowHasData = Boolean(labelText)
      let rowNumericCount = 0
      for (let c = meta.startCol + 1; c <= meta.endCol; c++) {
        const cell = sheetObj.data?.[r]?.[c]
        const raw = cell?.value ?? cell?.formula
        if (raw === undefined || raw === null || raw === '') continue
        rowHasData = true
        totalDataCells += 1
        const n = toNumeric(raw)
        if (Number.isFinite(n)) {
          numericCount += 1
          rowNumericCount += 1
        }
      }
      if (!rowHasData) continue
      observedRows += 1
      firstColValues.push(labelText)
      if (rowNumericCount > 0) rowsWithNumeric += 1
    }
    const numericRatio = totalDataCells > 0 ? numericCount / totalDataCells : 0
    const validLabels = firstColValues.filter(Boolean)
    const distinctLabels = new Set(validLabels)
    const labelUniqRatio = validLabels.length > 0 ? distinctLabels.size / validLabels.length : 1
    const effectiveRows = observedRows || Math.max(0, rowCount - 1)
    const likelyRawDetailRange = effectiveRows > 120 && labelUniqRatio < 0.75
    return {
      rowCount, colCount, numericCount, totalDataCells, observedRows, rowsWithNumeric,
      numericRatio, validLabels, labelUniqRatio, effectiveRows, likelyRawDetailRange
    }
  }

  let stats = calcRangeStats(rangeMeta)
  const colKeys = Object.keys(sheetObj.data?.[rangeMeta.startRow] || {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
  const sheetLastCol = Number(sheetObj.colCount || 0) > 0
    ? Number(sheetObj.colCount)
    : (colKeys.length ? Math.max(...colKeys) : rangeMeta.endCol)
  const locateBestNumericCol = (startCol, endCol) => {
    let bestCol = -1
    let bestNumericRows = 0
    for (let c = startCol; c <= endCol; c++) {
      let numericRows = 0
      for (let r = rangeMeta.startRow + 1; r <= rangeMeta.endRow; r++) {
        const raw = getCellRaw(r, c)
        if (Number.isFinite(toNumeric(raw))) numericRows += 1
      }
      if (numericRows > bestNumericRows) {
        bestNumericRows = numericRows
        bestCol = c
      }
    }
    return { bestCol, bestNumericRows }
  }
  if (stats.numericCount === 0) {
    const narrowProbeEndCol = Math.min(sheetLastCol, Math.max(rangeMeta.endCol, rangeMeta.startCol + 12))
    const narrow = locateBestNumericCol(rangeMeta.startCol + 1, narrowProbeEndCol)
    if (narrow.bestCol > rangeMeta.startCol && narrow.bestNumericRows > 0) {
      rangeMeta.endCol = narrow.bestCol
      dataRangeStr = `${toLetters(rangeMeta.startCol)}${rangeMeta.startRow}:${toLetters(rangeMeta.endCol)}${rangeMeta.endRow}`
      stats = calcRangeStats(rangeMeta)
      console.info('createChart: 窄域自动修复数值列定位', {
        sheet,
        dataRange: dataRangeStr,
        numericRows: narrow.bestNumericRows,
        bestCol: narrow.bestCol
      })
    }
  }
  // 二次兜底：若仍无数值，扩大探测窗口，避免后端 dataRange 列定位偏移导致整图失败。
  if (stats.numericCount === 0) {
    const broadProbeEndCol = Math.min(sheetLastCol, rangeMeta.startCol + 26)
    const broad = locateBestNumericCol(rangeMeta.startCol + 1, broadProbeEndCol)
    if (broad.bestCol > rangeMeta.startCol && broad.bestNumericRows > 0) {
      rangeMeta.endCol = broad.bestCol
      dataRangeStr = `${toLetters(rangeMeta.startCol)}${rangeMeta.startRow}:${toLetters(rangeMeta.endCol)}${rangeMeta.endRow}`
      stats = calcRangeStats(rangeMeta)
      console.info('createChart: 宽域自动修复数值列定位', {
        sheet,
        dataRange: dataRangeStr,
        numericRows: broad.bestNumericRows,
        bestCol: broad.bestCol
      })
    }
  }

  const { rowCount, colCount, numericCount, rowsWithNumeric, numericRatio, validLabels, labelUniqRatio, effectiveRows, likelyRawDetailRange } = stats

  // 全局硬限制：超大行数直接拒绝，避免卡顿与不可读图
  if (effectiveRows > MAX_CHART_ROWS_HARD) {
    throw new Error(`图表数据行数过大（${effectiveRows} 行），请先汇总到 ${MAX_CHART_ROWS_HARD} 行以内再制图。`)
  }
  // 原始明细限制：倾向统计结果数据，明细区仅允许较小样本
  if (likelyRawDetailRange && effectiveRows > MAX_RAW_DATA_ROWS) {
    throw new Error(`检测到原始明细数据（${effectiveRows} 行），请先按维度汇总后再绘制图表（建议 ≤ ${MAX_RAW_DATA_ROWS} 行）。`)
  }

  const isPieLike = resolvedTypeLower === 'pie' || resolvedTypeLower === 'doughnut'
  if (isPieLike) {
    const pieInvalid =
      colCount < 2 ||
      validLabels.length > 60 ||
      effectiveRows > 60 ||
      numericCount === 0 ||
      numericRatio < 0.5 ||
      rowsWithNumeric === 0
    // 饼图不满足可读性/数值条件时，自动降级到柱/条图，避免整次 create_chart 失败。
    if (pieInvalid && colCount >= 2 && numericCount > 0 && rowsWithNumeric > 0) {
      resolvedTypeLower = effectiveRows <= 20 ? 'bar' : 'column'
      console.info('createChart: 饼图自动降级为更稳健类型', {
        sheet,
        from: requestedTypeLower,
        to: resolvedTypeLower,
        dataRange: dataRangeStr,
      })
    }
  }

  if (resolvedTypeLower === 'pie' || resolvedTypeLower === 'doughnut') {
    if (colCount < 2) {
      throw new Error('饼图至少需要“标签列 + 数值列”两列数据。')
    }
    if (validLabels.length > 60 || effectiveRows > 60) {
      throw new Error('饼图分类过多，请先按维度汇总后再绘制。')
    }
    if (numericCount === 0 || numericRatio < 0.5 || rowsWithNumeric === 0) {
      throw new Error('饼图数据列缺少有效数值，请先汇总并清洗数据。')
    }
  }
  if ((resolvedTypeLower === 'column' || resolvedTypeLower === 'bar') && effectiveRows > 80 && labelUniqRatio < 0.6) {
    throw new Error('当前数据更像明细明表，建议先按维度汇总后再创建柱状图。')
  }
  if (numericCount === 0) {
    throw new Error('图表数据范围内未检测到有效数值。')
  }
  
  // 确保 width 和 height 是数字类型
  const chartWidth = typeof width === 'number' ? width : (parseFloat(width) || 400)
  const chartHeight = typeof height === 'number' ? height : (parseFloat(height) || 300)

  // ── 图表定位 ──
  // 综合分析：由前端根据“数据块有效末行 + 2”确定行坐标，列锚定到数据块起始列
  // 其他工作表：沿用通用智能定位（避开数据区 + 防重叠）
  const requestedRow = typeof row === 'number' ? row : (parseInt(row) || 0)
  const requestedCol = typeof col === 'number' ? col : (parseInt(col) || 0)
  const { chartRow: finalRow, chartCol: finalCol } = isComprehensiveSheet
    ? _resolveComprehensiveChartPosition(sheetObj, rangeMeta, chartWidth, chartHeight)
    : _resolveChartPosition(sheetObj, rangeMeta, requestedRow, requestedCol, chartWidth, chartHeight)

  let finalChartType = resolvedTypeLower
  // 普通视图多图去同质化：当模型连续给 column 时，按数据规模切到 bar/line/area。
  if (!isComprehensiveSheet && finalChartType === 'column') {
    const existingTypes = new Set((sheetObj.charts || []).map((c) => String(c.chartType || '').toLowerCase()).filter(Boolean))
    if (existingTypes.has('column') && existingTypes.size === 1) {
      if (effectiveRows <= 8) finalChartType = 'bar'
      else if (effectiveRows <= 40) finalChartType = 'line'
      else finalChartType = 'area'
    }
  }

  // 存储图表信息
  const chart = {
    id: chartId,
    chartType: finalChartType || 'column',
    dataRange: dataRangeStr,
    title: title || '',
    row: finalRow,
    col: finalCol,
    width: chartWidth,
    height: chartHeight,
    _sheetbotDimensionKey: dimensionKey || undefined,
    _excludeRows: totalRowsToSkip.size > 0 ? [...totalRowsToSkip] : undefined,
  }
  
  // 用新数组替换旧引用，确保 React useMemo([sheet]) 能感知 charts 变更，
  // 避免 sheetObj 对象引用不变但内部数组 mutate 导致浮层停滞旧版本。
  sheetObj.charts = [...sheetObj.charts, chart]
  return workbook
}

function updateChart(workbook, { sheet, chartId, chartType, dataRange, position }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.charts) {
    const chart = sheetObj.charts.find(c => c.id === chartId)
    if (chart) {
      if (chartType) chart.chartType = chartType
      if (dataRange) chart.dataRange = dataRange
      if (position) chart.position = position
    }
  }
  return workbook
}

function deleteChart(workbook, { sheet, chartId }) {
  const sheetObj = getSheet(workbook, sheet)
  if (sheetObj.charts) {
    sheetObj.charts = sheetObj.charts.filter(chart => chart.id !== chartId)
  }
  return workbook
}

// ============================================================================
// 透视表辅助函数
// ============================================================================

export const buildPivotHeaders = (sourceSheetObj, startRowNum, startColNum, endColNum) => {
  const headers = []
  for (let col = startColNum; col <= endColNum; col++) {
    const headerValue = sourceSheetObj.data[startRowNum]?.[col]?.value
    const normalizedHeader = headerValue !== undefined && headerValue !== null && String(headerValue).trim()
      ? String(headerValue)
      : `__COL_${col}`
    headers.push(normalizedHeader)
  }
  return headers
}

export const resolvePivotFieldName = (fieldName, headers, startColNum = 1) => {
  if (fieldName === null || fieldName === undefined) return null
  const raw = typeof fieldName === 'string' ? fieldName : String(fieldName)
  const trimmed = raw.trim()
  const stripped = stripFieldNameDecorators(trimmed)
  const strippedNorm = normalizePivotIdentifier(stripped)
  const numValue = typeof fieldName === 'number' ? fieldName : (/^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null)
  if (numValue !== null) {
    const colIndex = numValue - startColNum
    if (colIndex >= 0 && colIndex < headers.length) return headers[colIndex] || null
    if (numValue > 0 && numValue <= headers.length) return headers[numValue - 1] || null
    return null
  }
  for (const h of headers) {
    if (typeof h !== 'string') continue
    if (h === trimmed || h === stripped) return h
    if (stripFieldNameDecorators(h.trim()) === stripped) return h
    if (normalizePivotIdentifier(stripFieldNameDecorators(h.trim())) === strippedNorm) return h
  }
  if (headers.includes(trimmed)) return trimmed
  if (headers.includes(stripped)) return stripped
  const normalized = strippedNorm.toLowerCase()
  const exact = headers.find(h => typeof h === 'string' && normalizePivotIdentifier(stripFieldNameDecorators(h.trim())).toLowerCase() === normalized)
  if (exact) return exact
  const partial = headers.find(h => typeof h === 'string' && (
    h.includes(stripped) || stripped.includes(h) || h.trim().toLowerCase().includes(normalized) || normalized.includes(h.trim().toLowerCase())
  ))
  return partial || null
}

export const buildPivotDataRows = (sourceSheetObj, headers, startRowNum, endRowNum, startColNum, endColNum) => {
  const getCellActualValue = (row, col) => {
    const cell = sourceSheetObj.data[row]?.[col]
    if (!cell) return ''
    if (!cell.formula) return cell.value !== undefined ? cell.value : ''
    try {
      const result = evaluateFormula(cell.formula, sourceSheetObj.data)
      return typeof result === 'number' ? result : (parseFloat(result) || 0)
    } catch (error) {
      console.warn(`公式计算失败: ${cell.formula}`, error)
      return 0
    }
  }
  const data = []
  for (let row = startRowNum + 1; row <= endRowNum; row++) {
    const rowData = {}
    for (let col = startColNum; col <= endColNum; col++) {
      const headerName = headers[col - startColNum]
      rowData[headerName] = getCellActualValue(row, col)
    }
    data.push(rowData)
  }
  return data
}

function dedupeBy(items, keyFn) {
  const seen = new Set()
  const out = []
  items.forEach((item) => {
    const key = keyFn(item)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(item)
  })
  return out
}

function rollbackPivotBuild(workbook, { createdTargetSheet, pivotTableSheetName, sourceSheetName }) {
  if (createdTargetSheet && pivotTableSheetName) {
    workbook.sheets = workbook.sheets.filter(s => s.name !== pivotTableSheetName)
  }
  if (workbook.activeSheet === pivotTableSheetName) {
    workbook.activeSheet = sourceSheetName
  }
}

function pivotValueHeaderLabel(valueFieldDef) {
  const aggLabelMap = {
    sum: '求和',
    avg: '平均值',
    average: '平均值',
    count: '计数',
    min: '最小值',
    max: '最大值',
  }
  const baseName = valueFieldDef?.name || '值'
  const agg = String(valueFieldDef?.agg || 'sum').toLowerCase()
  return `${baseName}(${aggLabelMap[agg] || agg})`
}

function aggregatePivotValues(values, agg) {
  const mode = String(agg || 'sum').toLowerCase()
  if (mode === 'avg' || mode === 'average') {
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
  }
  if (mode === 'count') return values.length
  if (mode === 'min') return values.length > 0 ? Math.min(...values) : 0
  if (mode === 'max') return values.length > 0 ? Math.max(...values) : 0
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : 0
}

function roundComputedNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return Math.abs(rounded) < 1e-9 ? 0 : rounded
}

function computedNumberCell(value) {
  const rounded = roundComputedNumber(value)
  if (typeof rounded !== 'number' || !Number.isFinite(rounded)) return { value: rounded }
  if (Number.isInteger(rounded)) return { value: rounded, style: { numberFormat: '0' } }
  return { value: rounded, style: { numberFormat: '0.00' } }
}

function resolveSheetNameInput(input) {
  if (typeof input === 'string' && input.trim()) return input.trim()
  if (input && typeof input === 'object') {
    if (typeof input.name === 'string' && input.name.trim()) return input.name.trim()
    if (typeof input.sheet === 'string' && input.sheet.trim()) return input.sheet.trim()
    if (typeof input.sheetName === 'string' && input.sheetName.trim()) return input.sheetName.trim()
  }
  return ''
}

function parseListLikeField(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const raw = value.trim()
    if (!raw) return []
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        return raw.split(',').map(item => item.trim()).filter(Boolean)
      }
    }
    return raw.split(',').map(item => item.trim()).filter(Boolean)
  }
  return value ? [value] : []
}

function parsePivotParams(workbook, params) {
  const {
    sheet, sourceRange, source_range,
    rowFields, row_fields,
    colFields, col_fields,
    valueFields, value_fields,
    valueAggregations, value_aggregations,
    targetSheet, target_sheet,
    targetRow,
    target_row,
    targetCol,
    target_col,
  } = params || {}

  const actualSourceRange = sourceRange || source_range
  const actualRowFields = rowFields || row_fields
  const actualColFields = colFields || col_fields || []
  const actualValueFields = valueFields || value_fields
  const actualTargetSheet = targetSheet || target_sheet
  const pickPivotTargetDim = (snake, camel, fallback) => {
    const raw = snake !== undefined && snake !== null ? snake : camel
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 ? n : fallback
  }
  const actualTargetRow = pickPivotTargetDim(target_row, targetRow, 1)
  const actualTargetCol = pickPivotTargetDim(target_col, targetCol, 1)

  const normalizedSheetName =
    resolveSheetNameInput(sheet) ||
    resolveSheetNameInput(actualSourceRange?.sheet) ||
    resolveSheetNameInput(actualSourceRange?.sheetName) ||
    workbook?.activeSheet ||
    workbook?.sheets?.[0]?.name ||
    ''

  const rowFieldsArray = parseListLikeField(actualRowFields)
  const colFieldsArray = parseListLikeField(actualColFields)
  const valueFieldsArray = parseListLikeField(actualValueFields)

  const aggMap = valueAggregations || value_aggregations || {}
  const normalizeAgg = (agg) => String(agg || 'sum').toLowerCase()
  const valueFieldDefs = valueFieldsArray.map((field) => {
    if (field && typeof field === 'object') {
      const name = field.field || field.name || field.valueField
      return { name, agg: normalizeAgg(field.agg || field.aggregate || aggMap[name]) }
    }
    return { name: field, agg: normalizeAgg(aggMap[field]) }
  })

  return {
    actualSourceRange,
    actualRowFields,
    actualColFields,
    actualValueFields,
    actualTargetSheet,
    actualTargetRow,
    actualTargetCol,
    normalizedSheetName,
    rowFieldsArray,
    colFieldsArray,
    valueFieldsArray,
    valueFieldDefs,
    aggMap,
  }
}

function parsePivotSourceRange(workbook, normalizedSheetName, actualSourceRange) {
  const parseCol = (colStr) => colStr.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)

  let sourceSheetName = normalizedSheetName
  let startRowNum
  let endRowNum
  let startColNum
  let endColNum
  let invalid = false

  if (actualSourceRange && typeof actualSourceRange === 'object') {
    if (
      actualSourceRange.startRow !== undefined ||
      actualSourceRange.startCol !== undefined ||
      actualSourceRange.endRow !== undefined ||
      actualSourceRange.endCol !== undefined
    ) {
      startRowNum = actualSourceRange.startRow !== undefined ? actualSourceRange.startRow : 1
      startColNum = actualSourceRange.startCol !== undefined ? actualSourceRange.startCol : 1
      endRowNum = actualSourceRange.endRow !== undefined ? actualSourceRange.endRow : 100
      endColNum = actualSourceRange.endCol !== undefined ? actualSourceRange.endCol : 6
    } else if (actualSourceRange.start || actualSourceRange.end) {
      const start = actualSourceRange.start || {}
      const end = actualSourceRange.end || {}
      startRowNum = start.row || start.rowIndex || start.startRow || 1
      startColNum = start.col || start.colIndex || start.startCol || 1
      endRowNum = end.row || end.rowIndex || end.endRow || 100
      endColNum = end.col || end.colIndex || end.endCol || 6
    } else {
      startRowNum = 1
      startColNum = 1
      endRowNum = 100
      endColNum = 6
    }
    console.log('createPivotTable: 解析对象格式 sourceRange', {
      actualSourceRange,
      startRowNum,
      startColNum,
      endRowNum,
      endColNum,
    })
  } else if (typeof actualSourceRange === 'string') {
    let rangeStr = actualSourceRange.replace(/\$/g, '')
    if (rangeStr.includes('!')) {
      const parts = rangeStr.split('!')
      sourceSheetName = parts[0].replace(/'/g, '')
      rangeStr = parts[1]
    }

    const r1c1Match = rangeStr.match(/R(\d+)C(\d+):R(\d+)C(\d+)/i)
    if (r1c1Match) {
      startRowNum = parseInt(r1c1Match[1])
      startColNum = parseInt(r1c1Match[2])
      endRowNum = parseInt(r1c1Match[3])
      endColNum = parseInt(r1c1Match[4])
    } else {
      const a1Match = rangeStr.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i)
      if (a1Match) {
        const [, startCol, startRow, endCol, endRow] = a1Match
        startRowNum = parseInt(startRow)
        startColNum = parseCol(startCol.toUpperCase())
        endRowNum = parseInt(endRow)
        endColNum = parseCol(endCol.toUpperCase())
      } else {
        invalid = true
      }
    }
    console.log('createPivotTable: 解析字符串格式 sourceRange', {
      actualSourceRange,
      rangeStr,
      startRowNum,
      startColNum,
      endRowNum,
      endColNum,
      invalid,
    })
  } else {
    console.warn('createPivotTable: sourceRange is missing, using default range')
    const sourceSheetObj = getSheet(workbook, sourceSheetName)
    startRowNum = 1
    startColNum = 1
    endRowNum = sourceSheetObj?.rowCount || 100
    endColNum = sourceSheetObj?.colCount || 6
  }

  return { sourceSheetName, startRowNum, startColNum, endRowNum, endColNum, invalid }
}

function safePivotDebugLog(label, payload) {
  try {
    console.log(label, payload)
  } catch (e) {
    console.warn('createPivotTable: debug log failed', e)
  }
}

function ensurePivotTargetSheet(workbook, sourceSheetName, actualTargetSheet) {
  let targetSheetObj = null
  let pivotTableSheetName = null
  let createdTargetSheet = false

  if (actualTargetSheet && String(actualTargetSheet).trim()) {
    const normalizedTargetSheet = String(actualTargetSheet).trim()
    // 这里不能用 getSheet（不存在会抛错），否则会阻断“自动创建目标表”路径。
    targetSheetObj = workbook?.sheets?.find((s) => s?.name === normalizedTargetSheet) || null
    if (targetSheetObj) {
      pivotTableSheetName = normalizedTargetSheet
      safePivotDebugLog('createPivotTable: 使用已存在的工作表', { pivotTableSheetName })
    } else {
      targetSheetObj = {
        name: normalizedTargetSheet,
        data: {},
        colWidths: {},
        rowHeights: {}
      }
      workbook.sheets.push(targetSheetObj)
      createdTargetSheet = true
      pivotTableSheetName = normalizedTargetSheet
      safePivotDebugLog('createPivotTable: 创建指定的目标工作表', { pivotTableSheetName })
    }
    return { targetSheetObj, pivotTableSheetName, createdTargetSheet }
  }

  let baseSheetName = `${sourceSheetName}透视表`
  pivotTableSheetName = baseSheetName
  let counter = 1
  while (workbook.sheets.find(s => s.name === pivotTableSheetName)) {
    pivotTableSheetName = `${baseSheetName}${counter}`
    counter += 1
  }

  targetSheetObj = {
    name: pivotTableSheetName,
    data: {},
    colWidths: {},
    rowHeights: {}
  }
  workbook.sheets.push(targetSheetObj)
  createdTargetSheet = true
  safePivotDebugLog('createPivotTable: 创建新工作表', { pivotTableSheetName })
  return { targetSheetObj, pivotTableSheetName, createdTargetSheet }
}

function resolvePivotFieldGroups(headers, startColNum, rowFieldsArray, colFieldsArray, valueFieldDefs) {
  const matchedRowFields = rowFieldsArray.map(field => {
    const matched = resolvePivotFieldName(field, headers, startColNum)
    if (!matched) {
      safePivotDebugLog('[前端调试] createPivotTable: 行字段未匹配', { field, headers })
    }
    return matched
  }).filter(Boolean)

  const matchedColFields = colFieldsArray.map(field => {
    const matched = resolvePivotFieldName(field, headers, startColNum)
    if (!matched) {
      safePivotDebugLog('[前端调试] createPivotTable: 列字段未匹配', { field, headers })
    }
    return matched
  }).filter(Boolean)

  const uniqueMatchedRowFields = dedupeBy(matchedRowFields, (v) => String(v))
  const uniqueMatchedColFields = dedupeBy(matchedColFields, (v) => String(v))
  const valueFieldNames = valueFieldDefs
    .map(def => def?.name)
    .filter(name => typeof name === 'string' && name.trim())

  const matchedValueFieldDefs = []
  const seenValueHeaders = new Set()
  for (const def of valueFieldDefs) {
    const rawName = def?.name
    if (typeof rawName !== 'string' || !rawName.trim()) continue
    const matched = resolvePivotFieldName(rawName, headers, startColNum)
    if (!matched) {
      safePivotDebugLog('[前端调试] createPivotTable: 值字段未匹配', { field: rawName, headers })
      continue
    }
    if (seenValueHeaders.has(matched)) continue
    seenValueHeaders.add(matched)
    matchedValueFieldDefs.push({
      name: matched,
      agg: String(def?.agg || 'sum').toLowerCase(),
    })
  }

  const uniqueMatchedValueFields = matchedValueFieldDefs.map((d) => d.name)
  const unmatchedRowFields = rowFieldsArray.filter(f => !resolvePivotFieldName(f, headers, startColNum))
  const unmatchedColFields = colFieldsArray.filter(f => !resolvePivotFieldName(f, headers, startColNum))
  const unmatchedValueFields = valueFieldNames.filter(f => !resolvePivotFieldName(f, headers, startColNum))

  return {
    uniqueMatchedRowFields,
    uniqueMatchedColFields,
    uniqueMatchedValueFields,
    matchedValueFieldDefs,
    valueFieldNames,
    unmatchedRowFields,
    unmatchedColFields,
    unmatchedValueFields,
  }
}

function createPivotTable(workbook, params) {
  // ============================================================================
  // 参数解析（兼容 LLM 返回的各种格式变体）
  // ============================================================================
  const parsedParams = parsePivotParams(workbook, params)
  const {
    actualSourceRange,
    actualRowFields,
    actualColFields,
    actualValueFields,
    actualTargetSheet,
    actualTargetRow,
    actualTargetCol,
    normalizedSheetName,
    rowFieldsArray,
    colFieldsArray,
    valueFieldsArray,
    valueFieldDefs,
    aggMap,
  } = parsedParams
  
  safePivotDebugLog('createPivotTable: 原始参数', {
    params,
    actualSourceRange,
    actualRowFields,
    actualColFields,
    actualValueFields
  })
  
  // 🔍 前端调试日志：记录接收到的参数
  safePivotDebugLog('[前端调试] createPivotTable: 接收到的原始参数', {
    sheet: normalizedSheetName,
    sourceRange: actualSourceRange,
    rowFields: actualRowFields,
    colFields: actualColFields,
    valueFields: actualValueFields,
    rowFieldsArray,
    colFieldsArray,
    valueFieldsArray,
    valueAggregations: aggMap
  })
  
  if (rowFieldsArray.length === 0 || valueFieldsArray.length === 0) {
    console.error('createPivotTable: rowFields and valueFields are required')
    return workbook
  }
  
  // 列号 -> 列字母转换函数：列号 -> 列字母 (1 -> A, 2 -> B, ..., 26 -> Z, 27 -> AA)
  const colNumToLetter = (colNum) => {
    let result = ''
    while (colNum > 0) {
      colNum--
      result = String.fromCharCode(65 + (colNum % 26)) + result
      colNum = Math.floor(colNum / 26)
    }
    return result || 'A'
  }
  
  // 解析 sourceRange
  let { sourceSheetName, startRowNum, startColNum, endRowNum, endColNum, invalid } =
    parsePivotSourceRange(workbook, normalizedSheetName, actualSourceRange)
  if (invalid) {
    console.error('createPivotTable: Invalid sourceRange format:', actualSourceRange)
    return workbook
  }
  
  let sourceSheetObj = getSheet(workbook, sourceSheetName)
  if (!sourceSheetObj) {
    // 回退：当前识别的源工作表无效时，退回活动工作表 / 首个工作表
    sourceSheetName = workbook?.activeSheet || workbook?.sheets?.[0]?.name || sourceSheetName
    sourceSheetObj = getSheet(workbook, sourceSheetName)
    if (!sourceSheetObj) return workbook
  }
  
  // 目标工作表创建/复用逻辑隔离，避免主流程分支膨胀
  const { targetSheetObj, pivotTableSheetName, createdTargetSheet } =
    ensurePivotTargetSheet(workbook, sourceSheetName, actualTargetSheet)
  
  // 确保新创建的工作表或透视表工作表自动设置为活动工作表
  workbook.activeSheet = pivotTableSheetName
  
  safePivotDebugLog('createPivotTable: 解析的范围', {
    sourceRange: actualSourceRange,
    startRow: startRowNum, 
    endRow: endRowNum, 
    startCol: startColNum, 
    endCol: endColNum 
  })
  
  const headers = buildPivotHeaders(sourceSheetObj, startRowNum, startColNum, endColNum)
  const data = buildPivotDataRows(sourceSheetObj, headers, startRowNum, endRowNum, startColNum, endColNum)
  
  // 🔍 前端调试日志：记录表头信息
  safePivotDebugLog('[前端调试] createPivotTable: 表头信息', {
    headers,
    headersCount: headers.length,
    startColNum,
    endColNum,
    sourceSheetName
  })
  
  const {
    uniqueMatchedRowFields,
    uniqueMatchedColFields,
    uniqueMatchedValueFields,
    matchedValueFieldDefs,
    valueFieldNames,
    unmatchedRowFields,
    unmatchedColFields,
    unmatchedValueFields,
  } = resolvePivotFieldGroups(headers, startColNum, rowFieldsArray, colFieldsArray, valueFieldDefs)
  
  // 🔍 前端调试日志：记录匹配结果
  safePivotDebugLog('[前端调试] createPivotTable: 字段匹配结果', {
    rowFieldsArray,
    matchedRowFields: uniqueMatchedRowFields,
    colFieldsArray,
    matchedColFields: uniqueMatchedColFields,
    valueFieldsArray,
    matchedValueFields: uniqueMatchedValueFields
  })
  
  safePivotDebugLog('createPivotTable: 读取的数据样本', {
    headers,
    sampleRow: data[0],
    totalRows: data.length,
    rowFields: rowFieldsArray,
    matchedRowFields: uniqueMatchedRowFields,
    colFields: colFieldsArray,
    matchedColFields: uniqueMatchedColFields,
    valueFields: valueFieldsArray,
    matchedValueFields: uniqueMatchedValueFields,
    valueFieldDefs: matchedValueFieldDefs
  })

  // 透视维度为空的源行会产生「空白行键/列键」→ 表头出现「-销售额」、首列为空行且全 0（与 Excel 真透视的「(空白)」噪声同源）。分析场景默认跳过这类不完整维度行。
  const isPivotDimBlank = (v) => {
    if (v === undefined || v === null) return true
    if (typeof v === 'string' && v.trim() === '') return true
    return false
  }

  if (unmatchedRowFields.length > 0) {
    console.error('createPivotTable: 行字段匹配失败', {
      unmatched: unmatchedRowFields,
      availableHeaders: headers
    })
  }
  if (unmatchedColFields.length > 0) {
    console.error('createPivotTable: 列字段匹配失败', {
      unmatched: unmatchedColFields,
      availableHeaders: headers
    })
  }
  if (unmatchedValueFields.length > 0) {
    console.error('createPivotTable: 值字段匹配失败', {
      unmatched: unmatchedValueFields,
      availableHeaders: headers
    })
  }
  
  // 验证字段名是否都存在
  if (uniqueMatchedRowFields.length === 0 || unmatchedRowFields.length > 0) {
    console.error('createPivotTable: 行字段不完整或未匹配，拒绝猜测回退', {
      rowFieldsArray,
      matchedRowFields: uniqueMatchedRowFields,
      unmatchedRowFields,
      headers,
    })
    rollbackPivotBuild(workbook, { createdTargetSheet, pivotTableSheetName, sourceSheetName })
    return workbook
  }
  if (colFieldsArray.length > 0 && (uniqueMatchedColFields.length === 0 || unmatchedColFields.length > 0)) {
    console.error('createPivotTable: 列字段不完整或未匹配，拒绝猜测回退', {
      colFieldsArray,
      matchedColFields: uniqueMatchedColFields,
      unmatchedColFields,
      headers,
    })
    rollbackPivotBuild(workbook, { createdTargetSheet, pivotTableSheetName, sourceSheetName })
    return workbook
  }
  if (uniqueMatchedValueFields.length === 0 || unmatchedValueFields.length > 0) {
    console.error('createPivotTable: 值字段不完整或未匹配，拒绝猜测回退', {
      valueFieldsArray,
      matchedValueFields: uniqueMatchedValueFields,
      unmatchedValueFields,
      headers,
    })
    rollbackPivotBuild(workbook, { createdTargetSheet, pivotTableSheetName, sourceSheetName })
    return workbook
  }
  
  // 创建透视表数据结构
  const pivotData = {}
  let totalValueCount = 0
  let nonZeroValueCount = 0
  
  data.forEach((row, rowIdx) => {
    if (uniqueMatchedRowFields.some((field) => isPivotDimBlank(row[field]))) return
    if (uniqueMatchedColFields.length > 0 && uniqueMatchedColFields.some((field) => isPivotDimBlank(row[field]))) {
      return
    }
    // 构建行键（行字段的组合）
    const rowKey = uniqueMatchedRowFields.map(field => String(row[field] ?? '')).join('|')
    // 构建列键（列字段的组合，如果没有列字段则为'总计'）
    const colKey = uniqueMatchedColFields.length > 0
      ? uniqueMatchedColFields.map(field => String(row[field] ?? '')).join('|')
      : '总计'
    
    if (!pivotData[rowKey]) pivotData[rowKey] = {}
    if (!pivotData[rowKey][colKey]) {
      // 为每个值字段初始化数组
      pivotData[rowKey][colKey] = matchedValueFieldDefs.map(() => [])
    }
    
    // 累加每个值字段的值
    matchedValueFieldDefs.forEach((valueField, idx) => {
      const rawValue = row[valueField.name]
      let value = 0
      
      // 调试：检查字段名是否存在于 row 对象中
      if (rowIdx < 3 && !(valueField.name in row)) {
        console.warn(`createPivotTable: 数据行${rowIdx + 1}，字段名 "${valueField.name}" 不存在于 row 对象中`, {
          availableKeys: Object.keys(row),
          valueFieldName: valueField.name,
          rowData: row
        })
      }
      
      if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        if (typeof rawValue === 'number') {
          value = rawValue
        } else if (typeof rawValue === 'string') {
          // 尝试解析字符串为数字
          const parsed = parseFloat(rawValue)
          value = isNaN(parsed) ? 0 : parsed
        } else {
          value = parseFloat(String(rawValue)) || 0
        }
      } else {
        // 调试：记录为什么值为空
        if (rowIdx < 3) {
          console.log(`createPivotTable: 数据行${rowIdx + 1}，值字段 "${valueField.name}" 的值为空`, {
            rawValue,
            isUndefined: rawValue === undefined,
            isNull: rawValue === null,
            isEmpty: rawValue === '',
            rowData: row
          })
        }
      }
      
      totalValueCount++
      if (value !== 0) {
        nonZeroValueCount++
      }
      
      // 记录所有值（包括0），确保数据完整性
      if (!isNaN(value)) {
        pivotData[rowKey][colKey][idx].push(value)
        
        // 调试日志：前3行数据
        if (rowIdx < 3) {
          console.log(`createPivotTable: 数据行${rowIdx + 1}`, {
            rowKey,
            colKey,
            valueField: valueField.name,
            rawValue,
            parsedValue: value,
            rowDataKeys: Object.keys(row),
            rowData: row
          })
        }
      } else {
        console.warn(`createPivotTable: 数据行${rowIdx + 1}，值字段 "${valueField.name}" 的值无法解析为数字`, {
          rawValue,
          type: typeof rawValue
        })
      }
    })
  })
  
  safePivotDebugLog('createPivotTable: 数据统计', {
    totalRows: data.length,
    totalValueCount,
    nonZeroValueCount,
    zeroValueCount: totalValueCount - nonZeroValueCount
  })
  
  safePivotDebugLog('createPivotTable: 透视表数据结构', {
    pivotDataKeys: Object.keys(pivotData),
    sampleRowKey: Object.keys(pivotData)[0],
    sampleRowData: pivotData[Object.keys(pivotData)[0]],
    allRowKeys: Object.keys(pivotData),
    allColKeys: uniqueMatchedColFields.length > 0 ? 
      Array.from(new Set(Object.values(pivotData).flatMap(row => Object.keys(row)))).sort() :
      ['总计']
  })
  
  // 收集所有唯一的列键（列字段的值）
  const sortedRowKeys = Object.keys(pivotData).sort()
  const allColKeys = new Set()
  sortedRowKeys.forEach(rowKey => {
    Object.keys(pivotData[rowKey]).forEach(colKey => allColKeys.add(colKey))
  })
  const sortedColKeys = Array.from(allColKeys).sort()
  
  // 写入透视表
  let currentRow = actualTargetRow
  
  // 列标题行
  if (uniqueMatchedColFields.length > 0) {
    // 第一行：行字段标题 + 列字段值（作为列标题）
    if (!targetSheetObj.data[currentRow]) targetSheetObj.data[currentRow] = {}
    // 行字段列标题
    uniqueMatchedRowFields.forEach((field, idx) => {
      targetSheetObj.data[currentRow][actualTargetCol + idx] = { value: field }
    })
    // 列字段的值作为列标题（每个列键占1列，如果有多个值字段则展开）
    sortedColKeys.forEach((colKey, colIdx) => {
      const colParts = colKey === '总计' ? ['总计'] : colKey.split('|')
      // 显示列字段值（简化：只显示第一个部分，如果有多个列字段）
      const rawDisp = colParts.length > 0 ? colParts[0] : colKey
      const displayValue = String(rawDisp ?? '').trim() || '(空白)'
      matchedValueFieldDefs.forEach((valueField, valueIdx) => {
        const valueFieldName = pivotValueHeaderLabel(valueField)
        const colNum = actualTargetCol + uniqueMatchedRowFields.length + colIdx * matchedValueFieldDefs.length + valueIdx
        const headerLabel = displayValue === '(空白)'
          ? valueFieldName
          : `${displayValue}-${valueFieldName}`
        targetSheetObj.data[currentRow][colNum] = { value: headerLabel }
      })
    })
    currentRow++
  } else {
    // 只有行字段和值字段标题
    if (!targetSheetObj.data[currentRow]) targetSheetObj.data[currentRow] = {}
    uniqueMatchedRowFields.forEach((field, idx) => {
      targetSheetObj.data[currentRow][actualTargetCol + idx] = { value: field }
    })
    matchedValueFieldDefs.forEach((field, idx) => {
      const valueFieldName = pivotValueHeaderLabel(field)
      targetSheetObj.data[currentRow][actualTargetCol + uniqueMatchedRowFields.length + idx] = { value: valueFieldName }
    })
    currentRow++
  }
  
  // 数据行
  sortedRowKeys.forEach(rowKey => {
    if (!targetSheetObj.data[currentRow]) targetSheetObj.data[currentRow] = {}
    const rowParts = rowKey.split('|')
    
    // 写入行字段值
    rowParts.forEach((part, idx) => {
      targetSheetObj.data[currentRow][actualTargetCol + idx] = { value: part }
    })
    
    // 写入聚合值（按列字段顺序）
    if (uniqueMatchedColFields.length > 0) {
      sortedColKeys.forEach((colKey, colIdx) => {
        const valueArrays = pivotData[rowKey][colKey] || []
        matchedValueFieldDefs.forEach((valueField, valueIdx) => {
          const values = valueArrays[valueIdx] || []
          const result = aggregatePivotValues(values, valueField.agg)
          const colNum = actualTargetCol + uniqueMatchedRowFields.length + colIdx * matchedValueFieldDefs.length + valueIdx
          targetSheetObj.data[currentRow][colNum] = computedNumberCell(result)
        })
      })
    } else {
      // 没有列字段，直接写入值字段
      const valueArrays = pivotData[rowKey]['总计'] || []
      matchedValueFieldDefs.forEach((valueField, fieldIdx) => {
        const values = valueArrays[fieldIdx] || []
        const result = aggregatePivotValues(values, valueField.agg)
        targetSheetObj.data[currentRow][actualTargetCol + uniqueMatchedRowFields.length + fieldIdx] = computedNumberCell(result)
      })
    }
    currentRow++
  })
  
  // 更新工作表行数和列数
  const maxCol = colFieldsArray.length > 0
    ? actualTargetCol + uniqueMatchedRowFields.length + sortedColKeys.length * matchedValueFieldDefs.length - 1
    : actualTargetCol + uniqueMatchedRowFields.length + matchedValueFieldDefs.length - 1
  targetSheetObj.colCount = Math.max(targetSheetObj.colCount || 0, maxCol)
  targetSheetObj.rowCount = Math.max(targetSheetObj.rowCount || 0, currentRow - 1)
  
  safePivotDebugLog('createPivotTable: 透视表已创建', {
    targetSheet: actualTargetSheet || sourceSheetName,
    sourceSheet: sourceSheetName,
    sourceRange: `${colNumToLetter(startColNum)}${startRowNum}:${colNumToLetter(endColNum)}${endRowNum}`,
    parsedRange: {
      startRow: startRowNum,
      endRow: endRowNum,
      startCol: startColNum,
      endCol: endColNum
    },
    targetRange: {
      startRow: actualTargetRow,
      endRow: currentRow - 1,
      startCol: actualTargetCol,
      endCol: maxCol
    },
    rowFields: rowFieldsArray,
    colFields: colFieldsArray,
    valueFields: valueFieldsArray,
    rowKeys: sortedRowKeys,
    colKeys: sortedColKeys,
    pivotDataKeys: Object.keys(pivotData),
    dataRows: data.length
  })
  
  // 验证数据写入
  const debugHeaderOffset = colFieldsArray.length > 0 && valueFieldsArray.length > 1 ? 2 : 1
  safePivotDebugLog('createPivotTable: 验证写入的数据', {
    headerRow: targetSheetObj.data[actualTargetRow],
    firstDataRow: targetSheetObj.data[actualTargetRow + debugHeaderOffset]
  })
  
  return workbook
}

function updatePivotTable(workbook, { sheet, pivotTableId, rowFields, colFields, valueFields }) {
  // 简化实现：透视表更新需要重新创建
  // 实际应用中应该找到对应的透视表并更新
  return workbook
}

function deletePivotTable(workbook, { sheet, pivotTableId }) {
  // 简化实现：透视表删除需要清除对应区域的数据
  // 实际应用中应该找到对应的透视表并删除
  return workbook
}

/**
 * 获取单元格值
 */
export function getCellValue(sheet, row, col) {
  const cell = sheet.data[row]?.[col]
  return cell?.formula || cell?.value || ''
}


// ============================================================================
// 只读查询函数（纯读不写表，供 QueryBridge data_query 使用）
// ============================================================================

function _cellRawValue(cell) {
  if (!cell) return null
  const v = cell.value ?? cell.formula ?? null
  return v === '' ? null : v
}

/**
 * 读取矩形范围内的单元格值，返回二维数组
 */
export function readRangeValues(workbook, { sheet, startRow, startCol, endRow, endCol }) {
  let sheetObj
  try { sheetObj = getSheet(workbook, sheet) } catch (e) { return { error: e.message } }

  const clamped = Math.min(endRow, startRow + 499)
  const rows = []
  for (let r = startRow; r <= clamped; r++) {
    const row = []
    for (let c = startCol; c <= endCol; c++) {
      row.push(_cellRawValue(sheetObj.data[r]?.[c]))
    }
    rows.push(row)
  }
  return { values: rows, rowCount: rows.length, truncated: clamped < endRow }
}

/**
 * 查询列的唯一值（含频次），纯只读不写表
 */
export function queryUniqueValuesReadonly(workbook, { sheet, column, startRow, endRow }) {
  let sheetObj
  try { sheetObj = getSheet(workbook, sheet) } catch (e) { return { error: e.message } }

  const freq = new Map()
  for (let r = startRow; r <= endRow; r++) {
    const v = _cellRawValue(sheetObj.data[r]?.[column])
    if (v == null) continue
    const k = String(v)
    freq.set(k, (freq.get(k) || 0) + 1)
  }

  const items = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }))
  return { uniqueCount: items.length, items }
}

/**
 * 对单列执行聚合（sum/avg/count/min/max/median/countDistinct/countIf）
 */
export function aggregateColumn(workbook, { sheet, column, startRow, endRow, operation, condition }) {
  let sheetObj
  try { sheetObj = getSheet(workbook, sheet) } catch (e) { return { error: e.message } }

  const values = []
  for (let r = startRow; r <= endRow; r++) {
    const v = _cellRawValue(sheetObj.data[r]?.[column])
    if (v != null) values.push(v)
  }

  const nums = values.map(Number).filter(n => !isNaN(n))

  const ops = {
    sum: () => nums.reduce((a, b) => a + b, 0),
    avg: () => nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
    count: () => values.length,
    min: () => nums.length ? Math.min(...nums) : null,
    max: () => nums.length ? Math.max(...nums) : null,
    median: () => {
      if (!nums.length) return null
      const sorted = [...nums].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    },
    countDistinct: () => new Set(values.map(String)).size,
    countIf: () => {
      if (!condition) return 0
      const match = condition.match(/^([><=!]+)\s*(.+)$/)
      if (!match) return 0
      const [, op, rhs] = match
      const rhsNum = Number(rhs)
      const isNumCmp = !isNaN(rhsNum)
      return values.filter(v => {
        const n = Number(v)
        const s = String(v)
        if (op === '>' && isNumCmp) return !isNaN(n) && n > rhsNum
        if (op === '>=' && isNumCmp) return !isNaN(n) && n >= rhsNum
        if (op === '<' && isNumCmp) return !isNaN(n) && n < rhsNum
        if (op === '<=' && isNumCmp) return !isNaN(n) && n <= rhsNum
        if (op === '==' || op === '=') return s === rhs.trim()
        if (op === '!=' || op === '<>') return s !== rhs.trim()
        return false
      }).length
    },
  }

  const fn = ops[operation]
  if (!fn) return { error: `不支持的聚合操作: ${operation}` }
  return { operation, result: fn(), totalRows: endRow - startRow + 1, nonNullCount: values.length }
}

/**
 * 生成列的统计概要（uniqueCount / topValues / min / max / sum / avg / nullCount）
 */
export function queryColumnProfile(workbook, { sheet, column, startRow, endRow }) {
  let sheetObj
  try { sheetObj = getSheet(workbook, sheet) } catch (e) { return { error: e.message } }

  const freq = new Map()
  let nullCount = 0
  const nums = []
  for (let r = startRow; r <= endRow; r++) {
    const v = _cellRawValue(sheetObj.data[r]?.[column])
    if (v == null) { nullCount++; continue }
    const k = String(v)
    freq.set(k, (freq.get(k) || 0) + 1)
    const n = Number(v)
    if (!isNaN(n)) nums.push(n)
  }

  const topValues = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, count]) => ({ value, count }))

  return {
    uniqueCount: freq.size,
    topValues,
    min: nums.length ? Math.min(...nums) : null,
    max: nums.length ? Math.max(...nums) : null,
    sum: nums.reduce((a, b) => a + b, 0),
    avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
    nullCount,
    totalRows: endRow - startRow + 1,
  }
}
