// frontend/src/hooks/useCellRender.js
/**
 * ===================================
 * 单元格渲染 Hook
 * - 公式计算
 * - 数字格式化
 * - 条件格式
 * ===================================
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { evaluateFormula } from '../utils/formulaEngine'
import {
  getConditionalFormatStyleAt,
  prepareConditionalFormatRules,
} from '../utils/conditionalFormatEval'

export const formatDefaultDecimalDisplay = (
  rawValue,
  { parseMode = 'none' } = {}
) => {
  if (rawValue === null || rawValue === undefined || rawValue === '') return ''

  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) return String(rawValue)
    return Number.isInteger(rawValue) ? rawValue : rawValue.toFixed(2)
  }

  if (typeof rawValue !== 'string') return rawValue

  const text = rawValue.trim()
  if (!text) return rawValue

  if (parseMode === 'decimalOnly' && /^-?\d+\.\d+$/.test(text)) {
    const n = Number(text)
    return Number.isFinite(n) ? n.toFixed(2) : rawValue
  }

  if (parseMode === 'all') {
    // 仅当字符串为纯数字时解析，避免 "1省XX市XX县100号" 被截断为 1
    if (/^-?\d+\.?\d*$/.test(text)) {
      const n = parseFloat(rawValue)
      if (!isNaN(n)) return Number.isInteger(n) ? n : n.toFixed(2)
    }
    return rawValue
  }

  return rawValue
}

export function useCellRender({ sheet }) {
  const formulaCacheRef = useRef(new Map())
  const prevDataRef = useRef(null)
  const prevSheetNameRef = useRef(null)

  // 同步清除（渲染期间），确保排序后首帧就使用新数据
  if (prevDataRef.current !== sheet?.data || prevSheetNameRef.current !== sheet?.name) {
    formulaCacheRef.current = new Map()
    prevDataRef.current = sheet?.data
    prevSheetNameRef.current = sheet?.name
  }

  const conditionalFormatRules = useMemo(
    () => prepareConditionalFormatRules(sheet),
    [sheet?.conditionalFormats, sheet?.data]
  )

  const isDateLikeFormat = useCallback((numberFormat) => {
    const fmt = String(numberFormat || '').toLowerCase()
    if (!fmt) return false
    // 常见 Excel 日期格式：yyyy/m/d, m/d/yy, yyyy-mm-dd, yyyy年m月d日 等
    return /(y|m|d|年|月|日)/.test(fmt) && !/(#|0\.0|%|currency|￥|¥|\$)/.test(fmt)
  }, [])

  const normalizeDateLikeText = useCallback((value) => {
    let text = String(value ?? '').trim()
    if (!text) return ''
    // 兼容后端/导入链路中可能出现的包裹引号： "2017-04-14T00:00:00.000Z"
    text = text.replace(/^["']+|["']+$/g, '').trim()
    // 兼容转义引号：\"2017-04-14T00:00:00.000Z\"
    text = text.replace(/\\"/g, '"').replace(/^["']+|["']+$/g, '').trim()
    return text
  }, [])

  const extractYmd = useCallback((value) => {
    const text = normalizeDateLikeText(value)
    if (!text) return null
    const m = text.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/)
    if (!m) return null
    return `${m[1]}/${Number(m[2])}/${Number(m[3])}`
  }, [normalizeDateLikeText])

  const extractYmdTime = useCallback((value) => {
    const text = normalizeDateLikeText(value)
    if (!text) return null
    const m = text.match(
      /(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
    )
    if (!m) return null
    const ymd = `${m[1]}/${Number(m[2])}/${Number(m[3])}`
    const hh = m[4]
    const mm = m[5]
    const ss = m[6]
    if (hh !== undefined && mm !== undefined) {
      const h2 = String(Number(hh)).padStart(2, '0')
      const m2 = String(Number(mm)).padStart(2, '0')
      if (ss !== undefined) {
        const s2 = String(Number(ss)).padStart(2, '0')
        return `${ymd} ${h2}:${m2}:${s2}`
      }
      return `${ymd} ${h2}:${m2}`
    }
    return ymd
  }, [normalizeDateLikeText])

  const isDateLikeString = useCallback((value) => {
    if (extractYmdTime(value)) return true
    const text = normalizeDateLikeText(value)
    if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(text)) return true
    return false
  }, [extractYmdTime, normalizeDateLikeText])

  const formatDateYMD = useCallback((date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    return `${y}/${m}/${d}`
  }, [])

  const formatDateOrDateTime = useCallback((date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    const hh = date.getUTCHours()
    const mm = date.getUTCMinutes()
    const ss = date.getUTCSeconds()
    const ymd = `${y}/${m}/${d}`
    if (hh || mm || ss) {
      const h2 = String(hh).padStart(2, '0')
      const m2 = String(mm).padStart(2, '0')
      if (ss) {
        const s2 = String(ss).padStart(2, '0')
        return `${ymd} ${h2}:${m2}:${s2}`
      }
      return `${ymd} ${h2}:${m2}`
    }
    return ymd
  }, [])

  const excelSerialToDate = useCallback((serial) => {
    const n = Number(serial)
    if (!Number.isFinite(n)) return null
    const ms = Math.round((n - 25569) * 86400000)
    const dt = new Date(ms)
    return Number.isNaN(dt.getTime()) ? null : dt
  }, [])

  const formatNumber = useCallback((value, numberFormat) => {
    if (value === null || value === undefined || value === '') return ''
    // 日期格式优先，避免日期字符串先被 parseFloat 短路
    const formatStr = String(numberFormat).toLowerCase()
    if (numberFormat === 'date' || formatStr.includes('date') || isDateLikeFormat(numberFormat) || isDateLikeString(value)) {
      if (value instanceof Date) {
        return formatDateOrDateTime(value)
      }
      if (typeof value === 'number') {
        const asDate = excelSerialToDate(value)
        if (asDate) return formatDateOrDateTime(asDate)
      }
      if (typeof value === 'string') {
        const text = normalizeDateLikeText(value)
        if (isDateLikeString(text)) {
          const ymdTime = extractYmdTime(text)
          if (ymdTime) return ymdTime
          const normalized = text
            .replace('年', '/')
            .replace('月', '/')
            .replace('日', '')
            .replace(/-/g, '/')
          const date = new Date(normalized)
          if (!Number.isNaN(date.getTime())) return formatDateYMD(date)
          const matched = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/)
          if (matched) return `${matched[1]}/${Number(matched[2])}/${Number(matched[3])}`
          return normalized
        }
        return text
      }
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return formatDateOrDateTime(date)
      return String(value)
    }

    // 防止 "1省XX市XX县100号" 等混合字符串被 parseFloat 截断为 1
    if (typeof value === 'string') {
      const trimmed = String(value).trim()
      if (/^\d/.test(trimmed) && !/^-?\d+\.?\d*$/.test(trimmed)) return value
    }
    const numValue = typeof value === 'number' ? value : parseFloat(value)
    if (isNaN(numValue)) return String(value)
    // 默认保留两位小数（固定两位显示）
    if (!numberFormat) {
      return formatDefaultDecimalDisplay(numValue)
    }

    // 货币格式检测（支持多种格式字符串）
    const isCurrency = numberFormat === 'currency' ||
      numberFormat === '货币' ||
      formatStr === 'currency' ||
      formatStr.includes('currency') ||
      formatStr.includes('¥') ||
      formatStr.includes('￥') ||
      formatStr.includes('cny') ||
      formatStr.includes('rmb') ||
      formatStr.includes('$') ||
      formatStr.includes('#,##0.00') ||
      formatStr.includes('#,##0') ||
      formatStr.match(/¥\s*#,##0\.00/) ||
      formatStr.match(/￥\s*#,##0\.00/)

    if (isCurrency) {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(numValue)
    }

    // 百分比格式
    if (numberFormat === 'percentage' || numberFormat === '百分比' || formatStr.includes('percentage') || formatStr.includes('percent')) {
      const percentValue = numValue < 1 && numValue > -1 ? numValue : numValue / 100
      return new Intl.NumberFormat('zh-CN', {
        style: 'percent',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(percentValue)
    }
    
    // 数字格式（带千分位分隔符）
    if (numberFormat === 'number' || 
        formatStr.includes('thousand') || 
        formatStr.includes('#,##0') ||
        formatStr.includes('comma')) {
      return new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(numValue)
    }
    
    // Excel 格式字符串解析（简化版）
    if (formatStr.includes('#') || formatStr.includes('0')) {
      // 如果包含 #,##0.00 或类似格式，使用千分位和两位小数
      if (formatStr.includes(',') && formatStr.includes('.')) {
        return new Intl.NumberFormat('zh-CN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(numValue)
      }
      // 如果只包含千分位
      if (formatStr.includes(',')) {
        return new Intl.NumberFormat('zh-CN', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        }).format(numValue)
      }
    }
    
    return numValue
  }, [excelSerialToDate, formatDateOrDateTime, isDateLikeFormat, isDateLikeString, normalizeDateLikeText, extractYmdTime])

  const unwrapObjectValue = useCallback((rawValue, depth = 0) => {
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
      return rawValue.richText.map(item => item?.text || '').join('')
    }
    if (typeof rawValue.hyperlink === 'string' && rawValue.text) {
      return String(rawValue.text)
    }

    try {
      return JSON.stringify(rawValue)
    } catch {
      return ''
    }
  }, [])

  const getCellDisplay = useCallback((row, col, cell) => {
    if (!cell) return ''
    let value
    if (cell.formula) {
      try {
        if (row && col) {
          const key = `${row}:${col}:${cell.formula}`
          if (formulaCacheRef.current.has(key)) {
            value = formulaCacheRef.current.get(key)
          } else {
            value = evaluateFormula(cell.formula, sheet?.data || {})
            // 只缓存成功的结果
            if (value !== '#ERROR' && value !== '#VALUE!' && value !== '#DIV/0!' && value !== '#REF!') {
              formulaCacheRef.current.set(key, value)
            }
          }
        } else {
          value = evaluateFormula(cell.formula, sheet?.data || {})
        }
      } catch (error) {
        // 公式求值失败，返回单元格原始值或空
        console.warn(`[单元格渲染] 公式求值失败: ${cell.formula}`, error)
        value = cell.value ?? ''
      }
    } else {
      value = cell.value ?? ''
    }
    if (value && typeof value === 'object') value = unwrapObjectValue(value)
    if (cell?.style?.numberFormat) {
      // 公式结果为较大数值时，不按日期格式渲染（避免 SUM/AVERAGE 等被误显为日期）
      const fmt = String(cell.style.numberFormat || '').toLowerCase()
      if (cell.formula && typeof value === 'number' && value > 10000 && isDateLikeFormat(cell.style.numberFormat)) {
        return formatDefaultDecimalDisplay(value)
      }
      return formatNumber(value, cell.style.numberFormat)
    }
    // 无显式 numberFormat 时，仍需避免把日期字符串误转为年份
    if (value instanceof Date) {
      return formatDateOrDateTime(value)
    }
    if (typeof value === 'string' && isDateLikeString(value)) {
      const ymdTime = extractYmdTime(value)
      if (ymdTime) return ymdTime
      const normalized = normalizeDateLikeText(value)
        .replace('年', '/')
        .replace('月', '/')
        .replace('日', '')
        .replace(/-/g, '/')
      const matched = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/)
      if (matched) return `${matched[1]}/${Number(matched[2])}/${Number(matched[3])}`
      return normalized
    }
    // 默认对数值保留两位小数（固定两位显示）
    if (typeof value === 'number') {
      return formatDefaultDecimalDisplay(value)
    }
    return formatDefaultDecimalDisplay(value, { parseMode: 'all' })
  }, [formatNumber, sheet?.data, unwrapObjectValue, formatDateOrDateTime, isDateLikeString, normalizeDateLikeText, extractYmdTime])

  const getCellEditValue = useCallback((cell) => {
    if (!cell) return ''
    const rawValue = cell.formula || cell.value || ''
    return typeof rawValue === 'object' ? unwrapObjectValue(rawValue) : rawValue
  }, [unwrapObjectValue])

  const checkConditionalFormat = useCallback(
    (row, col, cell) =>
      getConditionalFormatStyleAt(row, col, cell, conditionalFormatRules, sheet?.data),
    [conditionalFormatRules, sheet?.data]
  )

  return {
    getCellDisplay,
    getCellEditValue,
    checkConditionalFormat
  }
}
