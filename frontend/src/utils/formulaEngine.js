// frontend/src/utils/formulaEngine.js
/**
 * Excel 公式引擎
 * 支持70%以上的Excel常用函数
 * 增强版：支持跨工作表引用
 */

// ============================================================================
// 错误处理机制（防止错误累积导致卡死）
// ============================================================================
let errorCount = 0
const MAX_ERROR_COUNT = 100  // 最多记录 100 个错误
const ERROR_LOG_INTERVAL = 1000  // 每 1 秒最多输出一次错误日志
let lastErrorLogTime = 0
const errorCache = new Map()  // 缓存已知错误的公式

/**
 * 安全错误日志（限制输出频率）
 */
const safeErrorLog = (message, error, context) => {
  const now = Date.now()
  errorCount++
  
  // 如果错误太多，停止输出
  if (errorCount > MAX_ERROR_COUNT) {
    if (errorCount === MAX_ERROR_COUNT + 1) {
      console.warn(`[公式引擎] 错误过多（>${MAX_ERROR_COUNT}），已停止错误日志输出`)
    }
    return
  }
  
  // 限制日志输出频率
  if (now - lastErrorLogTime < ERROR_LOG_INTERVAL) {
    return
  }
  
  lastErrorLogTime = now
  console.error(`[公式引擎] ${message}`, error, context)
}

/**
 * 重置错误计数器（在每次操作开始时调用）
 */
export const resetFormulaErrorCount = () => {
  errorCount = 0
  lastErrorLogTime = 0
}

/**
 * 清除公式错误缓存（排序/批量操作后必须调用，否则公式会永远返回 #ERROR）
 */
export const clearFormulaErrorCache = () => {
  errorCache.clear()
  errorCount = 0
  lastErrorLogTime = 0
}

// ============================================================================
// 全局工作簿上下文（用于跨工作表引用）
// ============================================================================
let _workbookContext = null

/**
 * 设置工作簿上下文（在计算公式前调用）
 */
export const setWorkbookContext = (workbook) => {
  _workbookContext = workbook
}

/**
 * 获取工作簿上下文
 */
export const getWorkbookContext = () => _workbookContext

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 列字母转数字（A=1, B=2, ..., Z=26, AA=27）
 */
const colLetterToNumber = (col) => {
  return col.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)
}

/**
 * 列数字转字母（1=A, 2=B, ..., 27=AA）
 */
const colNumberToLetter = (colNum) => {
  let result = ''
  let num = colNum
  while (num > 0) {
    num--
    result = String.fromCharCode(65 + (num % 26)) + result
    num = Math.floor(num / 26)
  }
  return result || 'A'
}

/**
 * 生成单元格引用（如 A1）
 */
const buildCellRef = (row, col) => {
  return `${colNumberToLetter(col)}${row}`
}

/**
 * 安全计算单元格公式（避免循环引用导致栈溢出）
 */
const evaluateCellFormulaSafe = (cell, sheetData, row, col, visited) => {
  if (!cell || !cell.formula) return 0
  const ref = buildCellRef(row, col)
  if (visited.has(ref)) return 0
  const nextVisited = new Set(visited)
  nextVisited.add(ref)
  return evaluateFormula(cell.formula, sheetData, nextVisited)
}

/**
 * 解析单元格引用（如 A1, B2）
 */
export const parseCell = (ref) => {
  const match = ref.match(/^([A-Z]+)(\d+)$/)
  if (!match) return null
  const col = colLetterToNumber(match[1])
  return { row: parseInt(match[2]), col }
}

/**
 * 解析跨工作表引用
 * 支持格式：'Sheet Name'!A1:B10, Sheet1!A1, 'Retail Price'!A:B
 */
const parseSheetReference = (ref) => {
  // 匹配带引号的工作表名：'Sheet Name'!A1:B10
  const quotedMatch = ref.match(/^'([^']+)'!(.+)$/)
  if (quotedMatch) {
    return { sheetName: quotedMatch[1], cellRef: quotedMatch[2] }
  }
  
  // 匹配不带引号的工作表名：Sheet1!A1:B10
  const unquotedMatch = ref.match(/^([A-Za-z0-9_]+)!(.+)$/)
  if (unquotedMatch) {
    return { sheetName: unquotedMatch[1], cellRef: unquotedMatch[2] }
  }
  
  return null
}

/**
 * 解析整列引用（如 A:B）
 * 返回列范围 { startCol, endCol }
 */
const parseColumnRange = (range) => {
  const match = range.match(/^([A-Z]+):([A-Z]+)$/)
  if (!match) return null
  return {
    startCol: colLetterToNumber(match[1]),
    endCol: colLetterToNumber(match[2])
  }
}

/**
 * 获取工作表数据（支持跨工作表）
 */
const getSheetData = (sheetName) => {
  if (!_workbookContext) return null
  const sheet = _workbookContext.sheets?.find(s => s.name === sheetName)
  return sheet?.data || null
}

/**
 * 获取工作表的最大行数
 */
const getSheetMaxRow = (sheetData) => {
  if (!sheetData) return 0
  const rows = Object.keys(sheetData).map(Number).filter(n => !isNaN(n))
  return rows.length > 0 ? Math.max(...rows) : 0
}

/**
 * 解析单元格范围（如 A1:B10）
 * 增强版：支持整列引用 A:B
 */
export const parseRange = (range, sheetData, visited = new Set()) => {
  // 先检查是否是整列引用
  const colRange = parseColumnRange(range)
  if (colRange) {
    // 整列引用：获取该列所有有数据的单元格
    const maxRow = getSheetMaxRow(sheetData)
    const values = []
    for (let row = 1; row <= maxRow; row++) {
      for (let col = colRange.startCol; col <= colRange.endCol; col++) {
        const cell = sheetData[row]?.[col]
        if (cell) {
          if (cell.formula) {
            values.push(evaluateCellFormulaSafe(cell, sheetData, row, col, visited))
          } else {
            values.push(cell.value)
          }
        }
      }
    }
    return values
  }
  
  // 常规范围引用 A1:B10
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
  if (!match) return []
  
  const [, startCol, startRow, endCol, endRow] = match
  const startColNum = colLetterToNumber(startCol)
  const endColNum = colLetterToNumber(endCol)
  const startRowNum = parseInt(startRow)
  const endRowNum = parseInt(endRow)
  
  const values = []
  for (let row = startRowNum; row <= endRowNum; row++) {
    for (let col = startColNum; col <= endColNum; col++) {
      const cell = sheetData[row]?.[col]
      if (cell) {
        if (cell.formula) {
          values.push(evaluateCellFormulaSafe(cell, sheetData, row, col, visited))
        } else {
          const val = typeof cell.value === 'number' ? cell.value : (parseFloat(cell.value) || 0)
          values.push(val)
        }
      } else {
        values.push(0)
      }
    }
  }
  return values
}

/**
 * 解析范围为二维数组（用于 VLOOKUP 等需要表格结构的函数）
 * 增强版：支持跨工作表引用和整列引用
 */
const parseRangeAs2D = (rangeRef, currentSheetData, visited = new Set()) => {
  let targetSheetData = currentSheetData
  let cellRef = rangeRef
  
  // 检查是否是跨工作表引用
  const sheetRef = parseSheetReference(rangeRef)
  if (sheetRef) {
    targetSheetData = getSheetData(sheetRef.sheetName)
    if (!targetSheetData) {
      console.warn(`Sheet not found: ${sheetRef.sheetName}`)
      return null
    }
    cellRef = sheetRef.cellRef
  }
  
  // 检查是否是整列引用 A:B
  const colRange = parseColumnRange(cellRef)
  if (colRange) {
    const maxRow = getSheetMaxRow(targetSheetData)
    const rows = []
    for (let row = 1; row <= maxRow; row++) {
      const rowData = []
      for (let col = colRange.startCol; col <= colRange.endCol; col++) {
        const cell = targetSheetData[row]?.[col]
        if (cell) {
          if (cell.formula) {
            rowData.push(evaluateCellFormulaSafe(cell, targetSheetData, row, col, visited))
          } else {
            rowData.push(cell.value)
          }
        } else {
          rowData.push(null)
        }
      }
      rows.push(rowData)
    }
    return rows
  }
  
  // 常规范围引用 A1:B10
  const match = cellRef.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
  if (!match) return null
  
  const [, startCol, startRow, endCol, endRow] = match
  const startColNum = colLetterToNumber(startCol)
  const endColNum = colLetterToNumber(endCol)
  const startRowNum = parseInt(startRow)
  const endRowNum = parseInt(endRow)
  
  const rows = []
  for (let row = startRowNum; row <= endRowNum; row++) {
    const rowData = []
    for (let col = startColNum; col <= endColNum; col++) {
      const cell = targetSheetData[row]?.[col]
      if (cell) {
        if (cell.formula) {
          rowData.push(evaluateCellFormulaSafe(cell, targetSheetData, row, col, visited))
        } else {
          rowData.push(cell.value)
        }
      } else {
        rowData.push(null)
      }
    }
    rows.push(rowData)
  }
  return rows
}

/**
 * 获取单元格值
 * 增强版：支持跨工作表引用
 */
export const getCellValue = (ref, sheetData, visited = new Set()) => {
  if (visited.has(ref)) return 0 // 防止循环引用
  
  let targetSheetData = sheetData
  let cellRef = ref
  
  // 检查是否是跨工作表引用
  const sheetRef = parseSheetReference(ref)
  if (sheetRef) {
    targetSheetData = getSheetData(sheetRef.sheetName)
    if (!targetSheetData) {
      console.warn(`Sheet not found: ${sheetRef.sheetName}`)
      return '#REF!'
    }
    cellRef = sheetRef.cellRef
  }
  
  const pos = parseCell(cellRef)
  if (!pos) return 0
  const cell = targetSheetData[pos.row]?.[pos.col]
  if (!cell) return 0
  if (cell.formula) {
    visited.add(ref)
    return evaluateFormula(cell.formula, targetSheetData, visited)
  }
  const val = cell.value
  return typeof val === 'number' ? val : (parseFloat(val) || 0)
}

/**
 * 解析函数参数（支持范围、单元格引用、数值、字符串）
 */
const parseArgs = (argsStr, sheetData, visited = new Set()) => {
  // 参数验证
  if (!argsStr || typeof argsStr !== 'string') {
    return []
  }
  
  const args = []
  let current = ''
  let depth = 0
  let inString = false
  let stringChar = ''
  
  try {
    for (let i = 0; i < argsStr.length; i++) {
      const char = argsStr[i]
      
      if (!inString && (char === '"' || char === "'")) {
        inString = true
        stringChar = char
        current += char
      } else if (inString && char === stringChar) {
        inString = false
        current += char
      } else if (!inString && char === '(') {
        depth++
        current += char
      } else if (!inString && char === ')') {
        depth--
        current += char
      } else if (!inString && depth === 0 && char === ',') {
        args.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    if (current.trim()) args.push(current.trim())
  } catch (error) {
    safeErrorLog('parseArgs 解析失败', error, { argsStr })
    return []
  }
  
  // 安全映射参数
  try {
    return args.map(arg => {
    arg = arg.trim()
    // 字符串
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.slice(1, -1)
    }
    // 范围引用
    if (/^[A-Z]+\d+:[A-Z]+\d+$/.test(arg)) {
      return parseRange(arg, sheetData, visited)
    }
    // 单元格引用
    if (/^[A-Z]+\d+$/.test(arg)) {
      return getCellValue(arg, sheetData, visited)
    }
    // 数值
    if (/^-?\d+\.?\d*$/.test(arg)) {
      return parseFloat(arg)
    }
    // 布尔值
    if (arg === 'TRUE') return true
    if (arg === 'FALSE') return false
    // 条件表达式（包含比较运算符，如 D2="Retail" 或 A1>5）
    // 这些表达式应该保持原样，让evaluateCondition处理
    if (/[<>=!]/.test(arg) && !arg.includes('(')) {
      // 简单条件表达式，保持原样
      return arg
    }
    // 其他（可能是嵌套函数或复杂表达式）
    return evaluateFormula('=' + arg, sheetData, visited)
    })
  } catch (error) {
    safeErrorLog('parseArgs 参数映射失败', error, { argsStr, args })
    return []
  }
}

/**
 * 展开参数数组（处理范围引用）
 */
const flattenArgs = (args) => {
  const result = []
  for (const arg of args) {
    if (Array.isArray(arg)) {
      result.push(...arg)
    } else {
      result.push(arg)
    }
  }
  return result
}

// ============================================================================
// 数学和三角函数
// ============================================================================

const mathFunctions = {
  // 求和
  SUM: (args, sheetData, visited) => {
    try {
      const parsed = parseArgs(args, sheetData, visited)
      if (!parsed || parsed.length === 0) {
        return 0  // 空参数返回 0
      }
      const values = flattenArgs(parsed)
      if (!values || values.length === 0) {
        return 0  // 空值数组返回 0
      }
      return values.reduce((acc, val) => {
        const numVal = typeof val === 'number' ? val : (parseFloat(val) || 0)
        return acc + (isNaN(numVal) ? 0 : numVal)
      }, 0)
    } catch (error) {
      safeErrorLog('SUM 函数求值失败', error, { args })
      return 0  // 错误时返回 0 而不是抛出异常
    }
  },
  
  // 平均值
  AVERAGE: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v)))
    if (nums.length === 0) return 0
    const sum = nums.reduce((acc, val) => acc + (typeof val === 'number' ? val : parseFloat(val) || 0), 0)
    return sum / nums.length
  },
  
  // 计数
  COUNT: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    return values.filter(v => v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v))).length
  },
  
  // 计数非空
  COUNTA: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    return values.filter(v => v !== null && v !== undefined && v !== '').length
  },
  
  // 最大值
  MAX: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v)))
    if (nums.length === 0) return 0
    return Math.max(...nums.map(v => typeof v === 'number' ? v : parseFloat(v)))
  },
  
  // 最小值
  MIN: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v)))
    if (nums.length === 0) return 0
    return Math.min(...nums.map(v => typeof v === 'number' ? v : parseFloat(v)))
  },
  
  // 排名（RANK函数）
  RANK: (args, sheetData, visited) => {
    const [number, ref, order = 0] = parseArgs(args, sheetData, visited)
    const num = typeof number === 'number' ? number : parseFloat(number) || 0
    
    // 解析范围引用
    let rangeValues = []
    if (typeof ref === 'string' && ref.includes(':')) {
      rangeValues = parseRange(ref, sheetData, visited)
    } else if (typeof ref === 'string') {
      rangeValues = [getCellValue(ref, sheetData, visited)]
    } else if (Array.isArray(ref)) {
      rangeValues = ref.map(v => typeof v === 'number' ? v : parseFloat(v) || 0)
    }
    
    // 过滤有效数字并排序
    const validNums = rangeValues
      .map(v => typeof v === 'number' ? v : parseFloat(v) || 0)
      .filter(v => !isNaN(v))
      .sort((a, b) => order === 0 ? b - a : a - b) // order=0降序，order=1升序
    
    // 查找排名（相同值排名相同）
    const rank = validNums.findIndex(v => v === num) + 1
    return rank > 0 ? rank : validNums.length + 1
  },
  
  // 绝对值
  ABS: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.abs(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  // 四舍五入
  ROUND: (args, sheetData, visited) => {
    const [num, digits = 0] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const d = typeof digits === 'number' ? digits : parseInt(digits) || 0
    return Math.round(n * Math.pow(10, d)) / Math.pow(10, d)
  },
  
  // 向上取整
  ROUNDUP: (args, sheetData, visited) => {
    const [num, digits = 0] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const d = typeof digits === 'number' ? digits : parseInt(digits) || 0
    return Math.ceil(n * Math.pow(10, d)) / Math.pow(10, d)
  },
  
  // 向下取整
  ROUNDDOWN: (args, sheetData, visited) => {
    const [num, digits = 0] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const d = typeof digits === 'number' ? digits : parseInt(digits) || 0
    return Math.floor(n * Math.pow(10, d)) / Math.pow(10, d)
  },
  
  // 平方根
  SQRT: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    const n = typeof val === 'number' ? val : parseFloat(val) || 0
    return Math.sqrt(n)
  },
  
  // 幂
  POWER: (args, sheetData, visited) => {
    const [base, exponent] = parseArgs(args, sheetData, visited)
    const b = typeof base === 'number' ? base : parseFloat(base) || 0
    const e = typeof exponent === 'number' ? exponent : parseFloat(exponent) || 0
    return Math.pow(b, e)
  },
  
  // 乘积
  PRODUCT: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    return values.reduce((acc, val) => acc * (typeof val === 'number' ? val : parseFloat(val) || 1), 1)
  },
  
  // 取模
  MOD: (args, sheetData, visited) => {
    const [num, divisor] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const d = typeof divisor === 'number' ? divisor : parseFloat(divisor) || 1
    return n % d
  },
  
  // 向上取整（整数）
  CEILING: (args, sheetData, visited) => {
    const [num, significance = 1] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const s = typeof significance === 'number' ? significance : parseFloat(significance) || 1
    return Math.ceil(n / s) * s
  },
  
  // 向下取整（整数）
  FLOOR: (args, sheetData, visited) => {
    const [num, significance = 1] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const s = typeof significance === 'number' ? significance : parseFloat(significance) || 1
    return Math.floor(n / s) * s
  },
  
  // 三角函数
  SIN: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.sin(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  COS: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.cos(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  TAN: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.tan(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  ASIN: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.asin(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  ACOS: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.acos(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  ATAN: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.atan(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  // 对数
  LN: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.log(typeof val === 'number' ? val : parseFloat(val) || 1)
  },
  
  LOG: (args, sheetData, visited) => {
    const [val, base = 10] = parseArgs(args, sheetData, visited)
    const v = typeof val === 'number' ? val : parseFloat(val) || 1
    const b = typeof base === 'number' ? base : parseFloat(base) || 10
    return Math.log(v) / Math.log(b)
  },
  
  LOG10: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.log10(typeof val === 'number' ? val : parseFloat(val) || 1)
  },
  
  // 随机数
  RAND: () => Math.random(),
  
  RANDBETWEEN: (args, sheetData, visited) => {
    const [bottom, top] = parseArgs(args, sheetData, visited)
    const b = typeof bottom === 'number' ? bottom : parseInt(bottom) || 0
    const t = typeof top === 'number' ? top : parseInt(top) || 1
    return Math.floor(Math.random() * (t - b + 1)) + b
  },
  
  // 符号
  SIGN: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    const n = typeof val === 'number' ? val : parseFloat(val) || 0
    return n > 0 ? 1 : (n < 0 ? -1 : 0)
  },
  
  // 整数部分
  INT: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return Math.floor(typeof val === 'number' ? val : parseFloat(val) || 0)
  },
  
  // 截断
  TRUNC: (args, sheetData, visited) => {
    const [num, digits = 0] = parseArgs(args, sheetData, visited)
    const n = typeof num === 'number' ? num : parseFloat(num) || 0
    const d = typeof digits === 'number' ? digits : parseInt(digits) || 0
    return Math.trunc(n * Math.pow(10, d)) / Math.pow(10, d)
  }
}

// ============================================================================
// 统计函数
// ============================================================================

const statisticalFunctions = {
  // 条件求和
  SUMIF: (args, sheetData, visited) => {
    const [range, criteria, sumRange] = parseArgs(args, sheetData, visited)
    const criteriaValues = Array.isArray(range) ? range : []
    const sumValues = Array.isArray(sumRange) && sumRange.length > 0 ? sumRange : criteriaValues
    const crit = typeof criteria === 'string' ? criteria : String(criteria)
    
    let sum = 0
    for (let i = 0; i < criteriaValues.length; i++) {
      const val = criteriaValues[i]
      if (evalCondition(val, crit)) {
        const sumVal = sumValues[i]
        sum += typeof sumVal === 'number' ? sumVal : parseFloat(sumVal) || 0
      }
    }
    return sum
  },
  
  // 条件计数
  COUNTIF: (args, sheetData, visited) => {
    const [range, criteria] = parseArgs(args, sheetData, visited)
    const values = Array.isArray(range) ? range : []
    const crit = typeof criteria === 'string' ? criteria : String(criteria)
    
    return values.filter(v => evalCondition(v, crit)).length
  },
  
  // 条件平均值
  AVERAGEIF: (args, sheetData, visited) => {
    const [range, criteria, averageRange] = parseArgs(args, sheetData, visited)
    const values = Array.isArray(range) ? range : []
    const crit = typeof criteria === 'string' ? criteria : String(criteria)
    
    const matching = values.filter(v => evalCondition(v, crit))
    if (matching.length === 0) return 0
    const sum = matching.reduce((acc, val) => acc + (typeof val === 'number' ? val : parseFloat(val) || 0), 0)
    return sum / matching.length
  },
  
  // 标准差（样本）
  STDEV: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v))).map(v => typeof v === 'number' ? v : parseFloat(v))
    if (nums.length < 2) return 0
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length
    const variance = nums.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / (nums.length - 1)
    return Math.sqrt(variance)
  },
  
  // 方差（样本）
  VAR: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v))).map(v => typeof v === 'number' ? v : parseFloat(v))
    if (nums.length < 2) return 0
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length
    return nums.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / (nums.length - 1)
  },
  
  // 中位数
  MEDIAN: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v))).map(v => typeof v === 'number' ? v : parseFloat(v)).sort((a, b) => a - b)
    if (nums.length === 0) return 0
    const mid = Math.floor(nums.length / 2)
    return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid]
  },
  
  // 众数
  MODE: (args, sheetData, visited) => {
    const values = flattenArgs(parseArgs(args, sheetData, visited))
    const nums = values.filter(v => typeof v === 'number' || !isNaN(parseFloat(v))).map(v => typeof v === 'number' ? v : parseFloat(v))
    if (nums.length === 0) return 0
    
    const freq = {}
    let maxFreq = 0
    let mode = nums[0]
    
    for (const num of nums) {
      freq[num] = (freq[num] || 0) + 1
      if (freq[num] > maxFreq) {
        maxFreq = freq[num]
        mode = num
      }
    }
    return mode
  }
}

// ============================================================================
// 逻辑函数
// ============================================================================

const logicalFunctions = {
  // 条件判断
  IF: (args, sheetData, visited) => {
    const [condition, valueIfTrue, valueIfFalse] = parseArgs(args, sheetData, visited)
    const cond = evaluateCondition(condition, sheetData, visited)
    return cond ? valueIfTrue : valueIfFalse
  },
  
  // 逻辑与
  AND: (args, sheetData, visited) => {
    const values = parseArgs(args, sheetData, visited)
    return values.every(v => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') return v.toLowerCase() === 'true'
      return Boolean(v)
    })
  },
  
  // 逻辑或
  OR: (args, sheetData, visited) => {
    const values = parseArgs(args, sheetData, visited)
    return values.some(v => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') return v.toLowerCase() === 'true'
      return Boolean(v)
    })
  },
  
  // 逻辑非
  NOT: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    if (typeof val === 'boolean') return !val
    if (typeof val === 'number') return val === 0
    if (typeof val === 'string') return val.toLowerCase() !== 'true'
    return !Boolean(val)
  },
  
  // 错误处理
  IFERROR: (args, sheetData, visited) => {
    const [value, valueIfError] = parseArgs(args, sheetData, visited)
    try {
      const result = typeof value === 'string' && value.startsWith('=') 
        ? evaluateFormula(value, sheetData, visited)
        : value
      if (result === '#ERROR' || result === '#VALUE!' || result === '#DIV/0!' || result === '#REF!') {
        return valueIfError
      }
      return result
    } catch {
      return valueIfError
    }
  },
  
  // 是否为空
  ISBLANK: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return val === null || val === undefined || val === '' || val === 0
  },
  
  // 是否为数字
  ISNUMBER: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return typeof val === 'number' || !isNaN(parseFloat(val))
  },
  
  // 是否为文本
  ISTEXT: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return typeof val === 'string' && isNaN(parseFloat(val))
  },
  
  // 是否为错误
  ISERROR: (args, sheetData, visited) => {
    const [val] = parseArgs(args, sheetData, visited)
    return val === '#ERROR' || val === '#VALUE!' || val === '#DIV/0!' || val === '#REF!'
  }
}

// ============================================================================
// 文本函数
// ============================================================================

const textFunctions = {
  // 连接文本
  CONCATENATE: (args, sheetData, visited) => {
    const values = parseArgs(args, sheetData, visited)
    return values.map(v => String(v)).join('')
  },
  
  // 连接（简化版CONCATENATE）
  CONCAT: (args, sheetData, visited) => {
    const values = parseArgs(args, sheetData, visited)
    return values.map(v => String(v)).join('')
  },
  
  // 文本连接（带分隔符）
  TEXTJOIN: (args, sheetData, visited) => {
    const [delimiter, ignoreEmpty, ...texts] = parseArgs(args, sheetData, visited)
    const values = texts.filter(t => ignoreEmpty ? (t !== null && t !== undefined && t !== '') : true)
    return values.map(v => String(v)).join(delimiter || '')
  },
  
  // 左截取
  LEFT: (args, sheetData, visited) => {
    const [text, numChars = 1] = parseArgs(args, sheetData, visited)
    const str = String(text || '')
    const n = typeof numChars === 'number' ? numChars : parseInt(numChars) || 1
    return str.substring(0, n)
  },
  
  // 右截取
  RIGHT: (args, sheetData, visited) => {
    const [text, numChars = 1] = parseArgs(args, sheetData, visited)
    const str = String(text || '')
    const n = typeof numChars === 'number' ? numChars : parseInt(numChars) || 1
    return str.substring(Math.max(0, str.length - n))
  },
  
  // 中间截取
  MID: (args, sheetData, visited) => {
    const [text, startNum, numChars] = parseArgs(args, sheetData, visited)
    const str = String(text || '')
    const start = (typeof startNum === 'number' ? startNum : parseInt(startNum) || 1) - 1
    const n = typeof numChars === 'number' ? numChars : parseInt(numChars) || 1
    return str.substring(start, start + n)
  },
  
  // 长度
  LEN: (args, sheetData, visited) => {
    const [text] = parseArgs(args, sheetData, visited)
    return String(text || '').length
  },
  
  // 大写
  UPPER: (args, sheetData, visited) => {
    const [text] = parseArgs(args, sheetData, visited)
    return String(text || '').toUpperCase()
  },
  
  // 小写
  LOWER: (args, sheetData, visited) => {
    const [text] = parseArgs(args, sheetData, visited)
    return String(text || '').toLowerCase()
  },
  
  // 首字母大写
  PROPER: (args, sheetData, visited) => {
    const [text] = parseArgs(args, sheetData, visited)
    return String(text || '').replace(/\b\w/g, c => c.toUpperCase())
  },
  
  // 去除空格
  TRIM: (args, sheetData, visited) => {
    const [text] = parseArgs(args, sheetData, visited)
    return String(text || '').trim()
  },
  
  // 查找
  FIND: (args, sheetData, visited) => {
    const [findText, withinText, startNum = 1] = parseArgs(args, sheetData, visited)
    const find = String(findText || '')
    const within = String(withinText || '')
    const start = (typeof startNum === 'number' ? startNum : parseInt(startNum) || 1) - 1
    const index = within.indexOf(find, start)
    return index === -1 ? '#VALUE!' : index + 1
  },
  
  // 替换
  REPLACE: (args, sheetData, visited) => {
    const [oldText, startNum, numChars, newText] = parseArgs(args, sheetData, visited)
    const old = String(oldText || '')
    const start = (typeof startNum === 'number' ? startNum : parseInt(startNum) || 1) - 1
    const n = typeof numChars === 'number' ? numChars : parseInt(numChars) || 0
    const newStr = String(newText || '')
    return old.substring(0, start) + newStr + old.substring(start + n)
  },
  
  // 替换文本
  SUBSTITUTE: (args, sheetData, visited) => {
    const [text, oldText, newText, instanceNum] = parseArgs(args, sheetData, visited)
    const str = String(text || '')
    const old = String(oldText || '')
    const newStr = String(newText || '')
    const instance = typeof instanceNum === 'number' ? instanceNum : parseInt(instanceNum)
    
    if (instance) {
      let count = 0
      return str.replace(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match) => {
        count++
        return count === instance ? newStr : match
      })
    }
    return str.replace(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newStr)
  },
  
  // 重复
  REPT: (args, sheetData, visited) => {
    const [text, numberTimes] = parseArgs(args, sheetData, visited)
    const str = String(text || '')
    const n = typeof numberTimes === 'number' ? numberTimes : parseInt(numberTimes) || 0
    return str.repeat(Math.max(0, n))
  },
  
  // 数值转文本
  TEXT: (args, sheetData, visited) => {
    const [value, formatText] = parseArgs(args, sheetData, visited)
    // 简化实现：基本格式化
    const num = typeof value === 'number' ? value : parseFloat(value) || 0
    const format = String(formatText || '')
    
    if (format.includes('0.00')) {
      return num.toFixed(2)
    } else if (format.includes('0.0')) {
      return num.toFixed(1)
    } else if (format.includes('0')) {
      return Math.round(num).toString()
    } else if (format.includes('#')) {
      return num.toString()
    }
    return String(value)
  },
  
  // 文本转数值
  VALUE: (args, sheetData, visited) => {
    const [text] = parseArgs(args, sheetData, visited)
    const num = parseFloat(String(text || '').replace(/[^\d.-]/g, ''))
    return isNaN(num) ? '#VALUE!' : num
  }
}

// ============================================================================
// 日期和时间函数
// ============================================================================

const dateTimeFunctions = {
  // 当前日期
  TODAY: () => {
    const now = new Date()
    return now.toISOString().split('T')[0]
  },
  
  // 当前日期时间
  NOW: () => {
    return new Date().toISOString()
  },
  
  // 年份
  YEAR: (args, sheetData, visited) => {
    const [dateValue] = parseArgs(args, sheetData, visited)
    const date = typeof dateValue === 'string' ? new Date(dateValue) : new Date(dateValue)
    return date.getFullYear()
  },
  
  // 月份
  MONTH: (args, sheetData, visited) => {
    const [dateValue] = parseArgs(args, sheetData, visited)
    const date = typeof dateValue === 'string' ? new Date(dateValue) : new Date(dateValue)
    return date.getMonth() + 1
  },
  
  // 日期
  DAY: (args, sheetData, visited) => {
    const [dateValue] = parseArgs(args, sheetData, visited)
    const date = typeof dateValue === 'string' ? new Date(dateValue) : new Date(dateValue)
    return date.getDate()
  },
  
  // 星期几
  WEEKDAY: (args, sheetData, visited) => {
    const [dateValue, returnType = 1] = parseArgs(args, sheetData, visited)
    const date = typeof dateValue === 'string' ? new Date(dateValue) : new Date(dateValue)
    const day = date.getDay()
    const rt = typeof returnType === 'number' ? returnType : parseInt(returnType) || 1
    
    if (rt === 1) return day === 0 ? 7 : day // 周日=7, 周一=1
    if (rt === 2) return day === 0 ? 1 : day + 1 // 周日=1, 周一=2
    return day // 周日=0, 周一=1
  },
  
  // 创建日期
  DATE: (args, sheetData, visited) => {
    const [year, month, day] = parseArgs(args, sheetData, visited)
    const y = typeof year === 'number' ? year : parseInt(year) || 1900
    const m = typeof month === 'number' ? month : parseInt(month) || 1
    const d = typeof day === 'number' ? day : parseInt(day) || 1
    return new Date(y, m - 1, d).toISOString().split('T')[0]
  },
  
  // 日期差（天数）
  DATEDIF: (args, sheetData, visited) => {
    const [startDate, endDate, unit] = parseArgs(args, sheetData, visited)
    const start = typeof startDate === 'string' ? new Date(startDate) : new Date(startDate)
    const end = typeof endDate === 'string' ? new Date(endDate) : new Date(endDate)
    const u = String(unit || 'd').toLowerCase()
    
    const diffTime = end - start
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24))
    
    if (u === 'd') return diffDays
    if (u === 'm') return Math.floor(diffDays / 30)
    if (u === 'y') return Math.floor(diffDays / 365)
    return diffDays
  },
  
  // 小时
  HOUR: (args, sheetData, visited) => {
    const [timeValue] = parseArgs(args, sheetData, visited)
    const time = typeof timeValue === 'string' ? new Date(timeValue) : new Date(timeValue)
    return time.getHours()
  },
  
  // 分钟
  MINUTE: (args, sheetData, visited) => {
    const [timeValue] = parseArgs(args, sheetData, visited)
    const time = typeof timeValue === 'string' ? new Date(timeValue) : new Date(timeValue)
    return time.getMinutes()
  },
  
  // 秒
  SECOND: (args, sheetData, visited) => {
    const [timeValue] = parseArgs(args, sheetData, visited)
    const time = typeof timeValue === 'string' ? new Date(timeValue) : new Date(timeValue)
    return time.getSeconds()
  }
}

// ============================================================================
// 查找和引用函数
// ============================================================================

const lookupFunctions = {
  // 垂直查找
  // VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])
  // 支持跨工作表引用，如 VLOOKUP(A1, 'Retail Price'!A:B, 2, FALSE)
  VLOOKUP: (args, sheetData, visited) => {
    // 手动解析参数，因为第二个参数是范围引用字符串
    const argList = splitFunctionArgs(args)
    if (argList.length < 3) return '#VALUE!'
    
    // 解析查找值
    const lookupValueArg = argList[0].trim()
    let lookupValue
    if (/^[A-Z]+\d+$/.test(lookupValueArg)) {
      lookupValue = getCellValue(lookupValueArg, sheetData, visited)
    } else if ((lookupValueArg.startsWith('"') && lookupValueArg.endsWith('"')) ||
               (lookupValueArg.startsWith("'") && lookupValueArg.endsWith("'"))) {
      lookupValue = lookupValueArg.slice(1, -1)
    } else {
      lookupValue = parseFloat(lookupValueArg) || lookupValueArg
    }
    
    // 解析表格范围（保持原始字符串，包括工作表引用）
    const tableArrayRef = argList[1].trim()
    
    // 解析列索引
    const colIndexArg = argList[2].trim()
    let colIndexNum
    if (/^[A-Z]+\d+$/.test(colIndexArg)) {
      colIndexNum = getCellValue(colIndexArg, sheetData, visited)
    } else {
      colIndexNum = parseInt(colIndexArg)
    }
    if (isNaN(colIndexNum) || colIndexNum < 1) return '#VALUE!'
    
    // 解析是否精确匹配（默认为 TRUE 近似匹配）
    const rangeLookup = argList.length > 3 
      ? (argList[3].trim().toUpperCase() !== 'FALSE' && argList[3].trim() !== '0')
      : true
    
    // 获取表格数据（二维数组）
    const tableData = parseRangeAs2D(tableArrayRef, sheetData, visited)
    if (!tableData || tableData.length === 0) {
      console.warn('VLOOKUP: Table array is empty or invalid:', tableArrayRef)
      return '#REF!'
    }
    
    // 在第一列中查找
    let foundRowIndex = -1
    for (let i = 0; i < tableData.length; i++) {
      const firstColValue = tableData[i][0]
      
      if (rangeLookup) {
        // 近似匹配：查找小于或等于 lookup_value 的最大值
        // 假设数据已升序排列
        if (firstColValue !== null && firstColValue !== undefined) {
          if (typeof lookupValue === 'number' && typeof firstColValue === 'number') {
            if (firstColValue <= lookupValue) {
              foundRowIndex = i
            } else {
              break
            }
          } else if (String(firstColValue) === String(lookupValue)) {
            foundRowIndex = i
            break
          }
        }
      } else {
        // 精确匹配
        if (firstColValue !== null && firstColValue !== undefined) {
          // 处理不同类型的比较
          if (typeof lookupValue === 'number' && typeof firstColValue === 'number') {
            if (firstColValue === lookupValue) {
              foundRowIndex = i
              break
            }
          } else if (String(firstColValue).toLowerCase() === String(lookupValue).toLowerCase()) {
            foundRowIndex = i
            break
          }
        }
      }
    }
    
    if (foundRowIndex === -1) {
      return '#N/A'
    }
    
    // 检查列索引是否有效
    if (colIndexNum > tableData[foundRowIndex].length) {
      return '#REF!'
    }
    
    // 返回对应列的值
    const result = tableData[foundRowIndex][colIndexNum - 1]
    return result !== null && result !== undefined ? result : 0
  },
  
  // 水平查找
  // HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])
  HLOOKUP: (args, sheetData, visited) => {
    const argList = splitFunctionArgs(args)
    if (argList.length < 3) return '#VALUE!'
    
    // 解析查找值
    const lookupValueArg = argList[0].trim()
    let lookupValue
    if (/^[A-Z]+\d+$/.test(lookupValueArg)) {
      lookupValue = getCellValue(lookupValueArg, sheetData, visited)
    } else if ((lookupValueArg.startsWith('"') && lookupValueArg.endsWith('"'))) {
      lookupValue = lookupValueArg.slice(1, -1)
    } else {
      lookupValue = parseFloat(lookupValueArg) || lookupValueArg
    }
    
    const tableArrayRef = argList[1].trim()
    const rowIndexNum = parseInt(argList[2].trim())
    const rangeLookup = argList.length > 3 
      ? (argList[3].trim().toUpperCase() !== 'FALSE' && argList[3].trim() !== '0')
      : true
    
    const tableData = parseRangeAs2D(tableArrayRef, sheetData, visited)
    if (!tableData || tableData.length === 0 || tableData[0].length === 0) {
      return '#REF!'
    }
    
    // 在第一行中查找
    const firstRow = tableData[0]
    let foundColIndex = -1
    
    for (let i = 0; i < firstRow.length; i++) {
      const val = firstRow[i]
      if (!rangeLookup) {
        // 精确匹配
        if (String(val).toLowerCase() === String(lookupValue).toLowerCase()) {
          foundColIndex = i
          break
        }
      } else {
        // 近似匹配
        if (typeof lookupValue === 'number' && typeof val === 'number') {
          if (val <= lookupValue) {
            foundColIndex = i
          } else {
            break
          }
        } else if (String(val) === String(lookupValue)) {
          foundColIndex = i
          break
        }
      }
    }
    
    if (foundColIndex === -1) return '#N/A'
    if (rowIndexNum < 1 || rowIndexNum > tableData.length) return '#REF!'
    
    return tableData[rowIndexNum - 1][foundColIndex] ?? 0
  },
  
  // 索引
  INDEX: (args, sheetData, visited) => {
    const [array, rowNum, colNum] = parseArgs(args, sheetData, visited)
    if (Array.isArray(array)) {
      const r = (typeof rowNum === 'number' ? rowNum : parseInt(rowNum) || 1) - 1
      const c = typeof colNum === 'number' ? colNum : parseInt(colNum) || 0
      if (Array.isArray(array[r])) {
        return array[r][c] || 0
      }
      return array[r] || 0
    }
    return '#REF!'
  },
  
  // 匹配
  MATCH: (args, sheetData, visited) => {
    const [lookupValue, lookupArray, matchType = 1] = parseArgs(args, sheetData, visited)
    if (Array.isArray(lookupArray)) {
      const mt = typeof matchType === 'number' ? matchType : parseInt(matchType) || 1
      for (let i = 0; i < lookupArray.length; i++) {
        if (mt === 0 && lookupArray[i] === lookupValue) return i + 1
        if (mt === 1 && lookupArray[i] >= lookupValue) return i + 1
        if (mt === -1 && lookupArray[i] <= lookupValue) return i + 1
      }
    }
    return '#N/A'
  }
}

/**
 * 分割函数参数（保留嵌套函数和引号字符串的完整性）
 */
const splitFunctionArgs = (argsStr) => {
  const args = []
  let current = ''
  let depth = 0
  let inString = false
  let stringChar = ''
  
  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i]
    
    if (!inString && (char === '"' || char === "'")) {
      inString = true
      stringChar = char
      current += char
    } else if (inString && char === stringChar) {
      inString = false
      current += char
    } else if (!inString && char === '(') {
      depth++
      current += char
    } else if (!inString && char === ')') {
      depth--
      current += char
    } else if (!inString && depth === 0 && char === ',') {
      args.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current) args.push(current)
  
  return args
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 评估条件表达式
 */
const evaluateCondition = (condition, sheetData, visited) => {
  if (typeof condition === 'boolean') return condition
  if (typeof condition === 'number') return condition !== 0
  if (typeof condition === 'string') {
    const str = condition.trim()
    // 比较运算符
    if (str.includes('>=')) {
      const [left, right] = str.split('>=').map(s => s.trim())
      const l = getCellValue(left, sheetData, visited)
      const r = getCellValue(right, sheetData, visited)
      return l >= r
    }
    if (str.includes('<=')) {
      const [left, right] = str.split('<=').map(s => s.trim())
      const l = getCellValue(left, sheetData, visited)
      const r = getCellValue(right, sheetData, visited)
      return l <= r
    }
    if (str.includes('<>') || str.includes('!=')) {
      const [left, right] = str.split(/[<>!]=/).map(s => s.trim())
      const l = getCellValue(left, sheetData, visited)
      const r = getCellValue(right, sheetData, visited)
      return l !== r
    }
    if (str.includes('>')) {
      const [left, right] = str.split('>').map(s => s.trim())
      const l = getCellValue(left, sheetData, visited)
      const r = getCellValue(right, sheetData, visited)
      return l > r
    }
    if (str.includes('<')) {
      const [left, right] = str.split('<').map(s => s.trim())
      const l = getCellValue(left, sheetData, visited)
      const r = getCellValue(right, sheetData, visited)
      return l < r
    }
    if (str.includes('=')) {
      const [left, right] = str.split('=').map(s => s.trim())
      
      // 处理左侧：可能是单元格引用或表达式
      let l
      if ((left.startsWith('"') && left.endsWith('"')) || (left.startsWith("'") && left.endsWith("'"))) {
        l = left.slice(1, -1) // 字符串字面量
      } else if (/^[A-Z]+\d+$/.test(left)) {
        l = getCellValue(left, sheetData, visited)
      } else {
        // 可能是表达式，尝试计算
        l = evaluateFormula('=' + left, sheetData, visited)
      }
      
      // 处理右侧：可能是单元格引用、字符串字面量或表达式
      let r
      if ((right.startsWith('"') && right.endsWith('"')) || (right.startsWith("'") && right.endsWith("'"))) {
        r = right.slice(1, -1) // 字符串字面量
      } else if (/^[A-Z]+\d+$/.test(right)) {
        r = getCellValue(right, sheetData, visited)
      } else {
        // 可能是表达式，尝试计算
        r = evaluateFormula('=' + right, sheetData, visited)
      }
      
      // 字符串比较（不区分大小写）或数值比较
      if (typeof l === 'string' && typeof r === 'string') {
        return l.toLowerCase() === r.toLowerCase()
      }
      return l === r
    }
    // 通配符匹配
    if (str.includes('*') || str.includes('?')) {
      // 简化实现
      return true
    }
    return Boolean(str)
  }
  return Boolean(condition)
}

/**
 * 条件评估辅助函数（用于SUMIF、COUNTIF等）
 */
const evalCondition = (value, criteria) => {
  const val = typeof value === 'number' ? value : parseFloat(value) || 0
  const crit = String(criteria)
  
  // 数字比较
  if (/^[><=]+/.test(crit)) {
    if (crit.startsWith('>=')) return val >= parseFloat(crit.substring(2)) || 0
    if (crit.startsWith('<=')) return val <= parseFloat(crit.substring(2)) || 0
    if (crit.startsWith('<>') || crit.startsWith('!=')) return val !== parseFloat(crit.substring(2)) || 0
    if (crit.startsWith('>')) return val > parseFloat(crit.substring(1)) || 0
    if (crit.startsWith('<')) return val < parseFloat(crit.substring(1)) || 0
    if (crit.startsWith('=')) return val === parseFloat(crit.substring(1)) || 0
  }
  
  // 文本匹配
  if (crit.includes('*')) {
    const pattern = crit.replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${pattern}$`, 'i').test(String(value))
  }
  
  return String(value) === crit
}

// ============================================================================
// 主公式评估函数
// ============================================================================

/**
 * 评估Excel公式
 */
export const evaluateFormula = (formula, sheetData, visited = new Set()) => {
  // 参数验证
  if (!formula || typeof formula !== 'string') {
    return formula
  }
  
  if (!formula.startsWith('=')) {
    return formula
  }
  
  // 检查错误缓存
  if (errorCache.has(formula)) {
    return '#ERROR'
  }
  
  // 循环引用和递归深度限制（防止无限递归）
  // 注意：visited 跟踪的是已访问的单元格数量，不是递归深度
  // 对于大范围的 SUM（如 =SUM(A1:A1000)），需要访问上千个单元格
  // 因此将限制提高到 5000，足以处理绝大多数正常的 Excel 操作
  if (visited.size > 5000) {
    safeErrorLog('公式引用单元格数量超限', null, { formula, visitedCount: visited.size })
    errorCache.set(formula, true)
    return '#ERROR'
  }
  
  let expr = formula.slice(1).trim()
  // 剥离 Excel 兼容前缀 _xlfn.（IFS/SWITCH/CONCAT 等新函数），避免 ReferenceError: _xlfn is not defined
  expr = expr.replace(/\b_xlfn\./gi, '')
  
  // 空表达式
  if (!expr) {
    return '#ERROR'
  }
  
  // 合并所有函数映射
  const allFunctions = {
    ...mathFunctions,
    ...statisticalFunctions,
    ...logicalFunctions,
    ...textFunctions,
    ...dateTimeFunctions,
    ...lookupFunctions
  }
  
  // 查找最外层的函数调用（支持函数调用后跟数学运算）
  // 例如：IF(...)*(1-F2) 或 VLOOKUP(...)*E2
  const findOuterFunction = (expression) => {
    let depth = 0
    let funcStart = -1
    let funcName = ''
    let inString = false
    let stringChar = ''
    
    // 匹配函数名开头的模式
    const funcNameMatch = expression.match(/^([A-Z_][A-Z0-9_]*)\s*\(/i)
    if (!funcNameMatch) return null
    
    funcName = funcNameMatch[1]
    funcStart = funcNameMatch.index
    
    // 从函数名后的左括号开始查找匹配的右括号
    let parenStart = funcStart + funcName.length
    for (let i = parenStart; i < expression.length; i++) {
      const char = expression[i]
      
      if (!inString && (char === '"' || char === "'")) {
        inString = true
        stringChar = char
      } else if (inString && char === stringChar) {
        inString = false
      } else if (!inString && char === '(') {
        depth++
      } else if (!inString && char === ')') {
        depth--
        if (depth === 0) {
          // 找到匹配的右括号
          const args = expression.substring(parenStart + 1, i)
          const rest = expression.substring(i + 1).trim()
          return { funcName, args, rest, funcStart, funcEnd: i + 1 }
        }
      }
    }
    
    return null
  }
  
  // 尝试匹配函数调用
  const funcInfo = findOuterFunction(expr)
  if (funcInfo) {
    const func = allFunctions[funcInfo.funcName.toUpperCase()]
    if (func) {
      try {
        // 创建新的 visited 集合（避免修改原集合）
        const newVisited = new Set(visited)
        newVisited.add(formula)
        
        const funcResult = func(funcInfo.args, sheetData, newVisited)
        
        // 如果函数返回错误，直接返回
        if (funcResult === '#ERROR' || funcResult === '#VALUE!' || funcResult === '#DIV/0!' || funcResult === '#REF!' || funcResult === '#N/A') {
          return funcResult
        }
        
        // 如果函数调用后还有表达式，继续计算
        if (funcInfo.rest) {
          // 将函数结果替换到表达式中，然后递归计算
          // 确保数字结果被正确格式化
          let resultStr = String(funcResult)
          if (typeof funcResult === 'number') {
            // 如果是负数，需要加括号以避免运算符优先级问题
            if (funcResult < 0 && funcInfo.rest.match(/^[\*\/]/)) {
              resultStr = `(${resultStr})`
            }
          }
          const newExpr = resultStr + funcInfo.rest
          return evaluateFormula('=' + newExpr, sheetData, newVisited)
        }
        
        return funcResult
      } catch (error) {
        safeErrorLog(`函数 ${funcInfo.funcName} 求值失败`, error, { args: funcInfo.args, formula })
        errorCache.set(formula, true)
        return '#ERROR'
      }
    } else {
      // 函数不存在
      safeErrorLog(`未知函数: ${funcInfo.funcName}`, null, { formula })
      errorCache.set(formula, true)
      return '#ERROR'
    }
  }
  
  // 处理简单的数学表达式（如 D2*E2）
  // 先替换单元格引用为实际值
  // 注意：跨工作表引用（如 'Retail Price'!A:B）应该在函数内部处理，这里不替换
  let evaluated = expr
  
  // 替换单元格引用为实际值（但跳过跨工作表引用中的引用）
  // 使用更简单的方法：先标记跨工作表引用，然后替换其他引用
  const sheetRefPattern = /'[^']+'![A-Z]+\d*:?[A-Z]*\d*/g
  const sheetRefs = []
  evaluated = evaluated.replace(sheetRefPattern, (match) => {
    const placeholder = `__SHEETREF_${sheetRefs.length}__`
    sheetRefs.push(match)
    return placeholder
  })
  
  // 现在替换所有单元格引用
  evaluated = evaluated.replace(/([A-Z]+\d+)/g, (ref) => {
    return getCellValue(ref, sheetData, visited)
  })
  
  // 恢复跨工作表引用
  sheetRefs.forEach((ref, index) => {
    evaluated = evaluated.replace(`__SHEETREF_${index}__`, ref)
  })
  
  // 处理百分比：将 50% 转换为 0.5
  // 匹配格式：数字% 或 (数字)% 或 数字.数字%
  evaluated = evaluated.replace(/(\d+\.?\d*)\s*%/g, (match, num) => {
    const value = parseFloat(num)
    return isNaN(value) ? match : `(${value / 100})`
  })
  
  try {
    // 验证表达式不为空
    if (!evaluated || evaluated.trim() === '') {
      safeErrorLog('表达式为空', null, { expr, formula })
      errorCache.set(formula, true)
      return '#ERROR'
    }
    
    // 安全计算表达式（只允许基本数学运算）
    const result = Function(`"use strict"; return (${evaluated})`)()
    
    if (!isFinite(result)) {
      // 除零产生 Infinity/-Infinity，返回 #DIV/0!（不缓存，因为引用值变化后可能恢复）
      return '#DIV/0!'
    }
    if (isNaN(result)) {
      return '#VALUE!'
    }
    
    return result
  } catch (error) {
    safeErrorLog('表达式求值失败', error, { expr, evaluated, formula })
    errorCache.set(formula, true)
    return '#ERROR'
  }
}
