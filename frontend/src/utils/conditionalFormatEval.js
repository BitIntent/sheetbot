/**
 * ============================================================
 *  条件格式求值（DOM 网格与 Univer 快照共用）
 *  支持类型：greaterThan / lessThan / between / equal / text
 *            containsText / notContainsText / beginsWith / endsWith
 *            greaterThanAverage / aboveAverage / belowAverage
 *            top10 / bottom10 / duplicate / uniqueValues
 * ============================================================
 */
import { evaluateFormula } from './formulaEngine'

// ---- 辅助：从嵌套对象中提取纯标量 ----
function unwrapObjectValue(rawValue, depth = 0) {
  if (rawValue === null || rawValue === undefined) return ''
  if (typeof rawValue !== 'object') return rawValue
  if (depth > 3) return ''
  const candidateKeys = ['text', 'result', 'name', 'value', 'display', 'label']
  for (const key of candidateKeys) {
    if (rawValue[key] !== undefined && rawValue[key] !== null) {
      return unwrapObjectValue(rawValue[key], depth + 1)
    }
  }
  if (Array.isArray(rawValue.richText)) {
    return rawValue.richText.map((item) => item?.text || '').join('')
  }
  if (typeof rawValue.hyperlink === 'string' && rawValue.text) {
    return String(rawValue.text)
  }
  try { return JSON.stringify(rawValue) } catch { return '' }
}

// ---- 颜色工具：解析 #RRGGBB → [r,g,b]，线性插值 ----
function parseHexRgb(hex) {
  if (!hex || typeof hex !== 'string') return null
  const h = hex.replace('#', '')
  const body = h.length === 8 ? h.slice(2) : h
  if (body.length !== 6) return null
  const r = parseInt(body.slice(0, 2), 16)
  const g = parseInt(body.slice(2, 4), 16)
  const b = parseInt(body.slice(4, 6), 16)
  return [r, g, b]
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ]
}

function rgbToHex([r, g, b]) {
  const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0').toUpperCase()
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// ---- 范围内收集所有数值（top/bottom/average 共用） ----
function collectNumericValues(sheetData, cf) {
  const values = []
  for (let r = cf.startRow; r <= cf.endRow; r++) {
    for (let c = cf.startCol; c <= cf.endCol; c++) {
      const cell = sheetData[r]?.[c]
      if (!cell) continue
      const raw = cell.formula ? evaluateFormula(cell.formula, sheetData) : (cell.value ?? '')
      const num = typeof raw === 'number' ? raw : parseFloat(raw)
      if (!Number.isNaN(num)) values.push(num)
    }
  }
  return values
}

// ---- 范围内收集所有字符串值（duplicate/unique 共用） ----
function collectStringValues(sheetData, cf) {
  const freq = new Map()
  for (let r = cf.startRow; r <= cf.endRow; r++) {
    for (let c = cf.startCol; c <= cf.endCol; c++) {
      const cell = sheetData[r]?.[c]
      if (!cell) continue
      const raw = cell.formula ? evaluateFormula(cell.formula, sheetData) : (cell.value ?? '')
      const s = String(raw ?? '').trim()
      if (s === '') continue
      freq.set(s, (freq.get(s) || 0) + 1)
    }
  }
  return freq
}

/**
 * 预处理：将条件格式规则转换为可快速查表的结构
 * @param {object} sheet — Sheet JSON（含 data、conditionalFormats）
 */
export function prepareConditionalFormatRules(sheet) {
  if (!sheet?.conditionalFormats || sheet.conditionalFormats.length === 0) return []
  const rules = []
  const sheetData = sheet?.data || {}

  for (const cf of sheet.conditionalFormats) {
    const condition = cf.condition || {}
    const type = condition.type || ''
    const entry = { ...cf, condition, average: null, compareValue: null, threshold: null, freqMap: null }

    // --- 均值类 ---
    if (type === 'greaterThanAverage' || type === 'aboveAverage' || type === 'belowAverage') {
      const vals = collectNumericValues(sheetData, cf)
      entry.average = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    }
    // --- top N / bottom N ---
    else if (type === 'top10' || type === 'bottom10') {
      const rank = Math.max(1, parseInt(condition.rank ?? condition.count ?? condition.value ?? 10, 10) || 10)
      const vals = collectNumericValues(sheetData, cf)
      if (vals.length > 0) {
        const sorted = [...vals].sort((a, b) => b - a)
        entry.threshold = type === 'top10'
          ? sorted[Math.min(rank, sorted.length) - 1]
          : sorted[Math.max(sorted.length - rank, 0)]
        entry._isTop = type === 'top10'
        entry._rank = rank
        entry._sortedVals = sorted
      }
    }
    // --- 重复值 / 唯一值 ---
    else if (type === 'duplicate' || type === 'duplicateValues' || type === 'uniqueValues') {
      entry.freqMap = collectStringValues(sheetData, cf)
    }
    // --- colorScale（2~3 色渐变） ---
    else if (type === 'colorScale') {
      const vals = collectNumericValues(sheetData, cf)
      if (vals.length > 0) {
        entry._csMin = Math.min(...vals)
        entry._csMax = Math.max(...vals)
        const colors = condition.colors || condition.colorScale
        entry._csMinColor = parseHexRgb(Array.isArray(colors) ? colors[0] : (condition.minColor || '#F8696B')) || [248, 105, 107]
        entry._csMidColor = Array.isArray(colors) && colors.length >= 3
          ? parseHexRgb(colors[1])
          : (condition.midColor ? parseHexRgb(condition.midColor) : null)
        entry._csMaxColor = parseHexRgb(Array.isArray(colors) ? colors[colors.length - 1] : (condition.maxColor || '#63BE7B')) || [99, 190, 123]
      }
    }
    // --- between ---
    else if (type === 'between') {
      entry._min = parseFloat(condition.min ?? condition.value ?? condition.low ?? 0)
      entry._max = parseFloat(condition.max ?? condition.value2 ?? condition.high ?? 0)
    }
    // --- 普通单值比较 ---
    else if (condition.value !== undefined && condition.value !== null) {
      entry.compareValue = parseFloat(condition.value)
    }

    rules.push(entry)
  }
  return rules
}

/**
 * 逐单元格求值：给定行列，返回命中的格式或 null
 */
export function getConditionalFormatStyleAt(row, col, cell, rules, sheetData) {
  if (!rules?.length) return null
  const data = sheetData || {}

  let cellValue = cell?.formula ? evaluateFormula(cell.formula, data) : (cell?.value ?? '')
  if (cellValue != null && typeof cellValue === 'object') cellValue = unwrapObjectValue(cellValue)
  const numValue = typeof cellValue === 'number' ? cellValue : parseFloat(cellValue)
  const cellStr = String(cellValue ?? '').trim()

  // Excel 语义：后写入规则优先（覆盖旧规则）
  for (let idx = rules.length - 1; idx >= 0; idx -= 1) {
    const cf = rules[idx]
    if (row < cf.startRow || row > cf.endRow || col < cf.startCol || col > cf.endCol) continue
    const condition = cf.condition || {}
    const type = condition.type || ''
    let hit = false

    switch (type) {
      // ---- 均值 ----
      case 'greaterThanAverage':
      case 'aboveAverage':
        hit = !Number.isNaN(numValue) && numValue > (cf.average ?? 0)
        break
      case 'belowAverage':
        hit = !Number.isNaN(numValue) && numValue < (cf.average ?? 0)
        break

      // ---- 比较 ----
      case 'greaterThan':
        hit = !Number.isNaN(numValue) && !Number.isNaN(cf.compareValue) && numValue > cf.compareValue
        break
      case 'lessThan':
        hit = !Number.isNaN(numValue) && !Number.isNaN(cf.compareValue) && numValue < cf.compareValue
        break
      case 'between':
        hit = !Number.isNaN(numValue) && numValue >= cf._min && numValue <= cf._max
        break

      // ---- 精确 / 文本 ----
      case 'equal':
      case 'text':
      case 'textEquals': {
        const cv = String(condition.value).trim()
        hit = cellStr === cv || (!Number.isNaN(numValue) && !Number.isNaN(cf.compareValue) && numValue === cf.compareValue)
        break
      }
      case 'containsText':
        hit = cellStr.includes(String(condition.value ?? '').trim())
        break
      case 'notContainsText':
        hit = !cellStr.includes(String(condition.value ?? '').trim())
        break
      case 'beginsWith':
        hit = cellStr.startsWith(String(condition.value ?? '').trim())
        break
      case 'endsWith':
        hit = cellStr.endsWith(String(condition.value ?? '').trim())
        break

      // ---- top N / bottom N ----
      case 'top10':
        if (cf.threshold != null && !Number.isNaN(numValue)) {
          hit = numValue >= cf.threshold
        }
        break
      case 'bottom10':
        if (cf.threshold != null && !Number.isNaN(numValue)) {
          hit = numValue <= cf.threshold
        }
        break

      // ---- 重复 / 唯一 ----
      case 'duplicate':
      case 'duplicateValues':
        if (cf.freqMap && cellStr) {
          hit = (cf.freqMap.get(cellStr) || 0) > 1
        }
        break
      case 'uniqueValues':
        if (cf.freqMap && cellStr) {
          hit = (cf.freqMap.get(cellStr) || 0) === 1
        }
        break

      // ---- 色阶（colorScale）：非 boolean hit，直接返回插值色 ----
      case 'colorScale': {
        if (cf._csMin != null && cf._csMax != null && !Number.isNaN(numValue)) {
          const range = cf._csMax - cf._csMin
          const t = range > 0 ? Math.max(0, Math.min(1, (numValue - cf._csMin) / range)) : 0.5
          let interpolated
          if (cf._csMidColor) {
            interpolated = t <= 0.5
              ? lerpColor(cf._csMinColor, cf._csMidColor, t * 2)
              : lerpColor(cf._csMidColor, cf._csMaxColor, (t - 0.5) * 2)
          } else {
            interpolated = lerpColor(cf._csMinColor, cf._csMaxColor, t)
          }
          return { backgroundColor: rgbToHex(interpolated) }
        }
        break
      }

      default:
        if (type) {
          console.warn(`[conditionalFormatEval] 不支持的条件格式类型: "${type}"，已跳过该规则`)
        }
        break
    }

    if (hit && cf.format) return cf.format
  }
  return null
}

/**
 * 将条件格式合并进 SheetBot 单元格 style（供 Univer 内联样式）
 */
export function mergeConditionalFormatIntoSheetbotStyle(sbCellStyle, cfFormat) {
  if (!cfFormat || typeof cfFormat !== 'object') return sbCellStyle || {}
  const base = { ...(sbCellStyle && typeof sbCellStyle === 'object' ? sbCellStyle : {}) }
  if (cfFormat.backgroundColor) base.backgroundColor = cfFormat.backgroundColor
  if (cfFormat.fontColor || cfFormat.color) base.fontColor = cfFormat.fontColor || cfFormat.color
  if (cfFormat.bold != null) base.bold = cfFormat.bold
  if (cfFormat.italic != null) base.italic = cfFormat.italic
  if (cfFormat.fontSize != null) base.fontSize = cfFormat.fontSize
  return base
}

/**
 * 快速摘要：对工作簿所有 sheet 的条件格式烘焙结果做哈希，
 * 检测编辑后颜色是否变化（决定是否需要强制重灌 Univer）。
 */
export function computeConditionalFormatDigest(workbook) {
  if (!workbook?.sheets) return ''
  const parts = []
  for (const sheet of workbook.sheets) {
    if (!sheet?.conditionalFormats?.length) continue
    const rules = prepareConditionalFormatRules(sheet)
    if (!rules.length) continue
    const data = sheet.data || {}
    for (const cf of rules) {
      for (let r = cf.startRow; r <= cf.endRow; r++) {
        for (let c = cf.startCol; c <= cf.endCol; c++) {
          const cell = data[r]?.[c]
          const fmt = getConditionalFormatStyleAt(r, c, cell, rules, data)
          if (fmt) {
            parts.push(`${r}:${c}:${fmt.backgroundColor || ''}:${fmt.fontColor || fmt.color || ''}`)
          }
        }
      }
    }
  }
  return parts.join('|')
}
