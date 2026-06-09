// frontend/src/utils/dateNormalizer.js
/**
 * 日期格式规范化模块
 * 确保前后端日期格式一致
 */

/**
 * 规范化日期值
 * 将各种日期格式统一转换为 YYYY-MM-DD 格式
 */
export function normalizeDateValue(value) {
  if (value === null || value === undefined) {
    return value
  }
  
  // 如果已经是标准格式的字符串，直接返回
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const looksLikeDate =
      /\d/.test(trimmed) &&
      (trimmed.includes('-') ||
        trimmed.includes('/') ||
        trimmed.includes('.') ||
        trimmed.includes('年') ||
        trimmed.includes('月') ||
        trimmed.includes('日') ||
        trimmed.includes('T') ||
        trimmed.includes(':'))

    // 纯数字字符串（如价格/库存/ID）不做日期推断，避免 7999 -> 7999-02-26
    if (!looksLikeDate) {
      return value
    }

    // 检查是否是标准 ISO 日期格式 (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(trimmed)) {
      // 年份 < 1930 的 ISO 字符串几乎必然是"数值被误转为 Excel 序列号日期"的残留产物
      // （如数量 2 → "1900-01-02"，价格 500 → "1901-05-15"），不做日期规范化，原样返回
      const isoYear = parseInt(trimmed.slice(0, 4), 10)
      if (isoYear < 1930) return value
      return trimmed.split('T')[0]
    }
    
    // 尝试解析各种日期格式
    // 格式：YYYY/MM/DD, MM/DD/YYYY, YYYY.MM.DD, YYYY年MM月DD日等
    const dateFormats = [
      /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,  // YYYY/MM/DD
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,  // MM/DD/YYYY
      /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/,  // YYYY.MM.DD
      /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, // YYYY年MM月DD日
    ]
    
    for (const pattern of dateFormats) {
      const match = trimmed.match(pattern)
      if (match) {
        let year, month, day
        if (pattern === dateFormats[0]) {
          // YYYY/MM/DD
          year = match[1]
          month = match[2].padStart(2, '0')
          day = match[3].padStart(2, '0')
        } else if (pattern === dateFormats[1]) {
          // MM/DD/YYYY
          month = match[1].padStart(2, '0')
          day = match[2].padStart(2, '0')
          year = match[3]
        } else if (pattern === dateFormats[2]) {
          // YYYY.MM.DD
          year = match[1]
          month = match[2].padStart(2, '0')
          day = match[3].padStart(2, '0')
        } else if (pattern === dateFormats[3]) {
          // YYYY年MM月DD日
          year = match[1]
          month = match[2].padStart(2, '0')
          day = match[3].padStart(2, '0')
        }
        
        // 验证日期有效性
        const date = new Date(`${year}-${month}-${day}`)
        if (!isNaN(date.getTime())) {
          return `${year}-${month}-${day}`
        }
      }
    }
    
    // 禁止宽松 Date 兜底：
    // 像 "7.5"、"10/2" 这类业务数字在不同运行时会被 Date 误解析为日期，
    // 造成占比/金额被写成 2001-07-04 等错误值。
    // 仅对显式日期格式做规范化，其余字符串保持原样。
    return value
  }
  
  // 如果是数字，可能是 Excel 日期序列号（从1900-01-01开始的天数）
  if (typeof value === 'number') {
    // Excel 日期序列号：1 = 1900-01-01
    // 但这里我们不确定，所以保持原值
    // 如果确实是日期序列号，前端会在显示时转换
    return value
  }
  
  // 如果是 Date 对象
  if (value instanceof Date) {
    return value.toISOString().split('T')[0]
  }
  
  // 其他类型，返回原值
  return value
}

/**
 * 规范化日期范围
 */
export function normalizeDateRange(value) {
  if (value === null || value === undefined) {
    return null
  }
  
  if (typeof value === 'object' && !Array.isArray(value)) {
    const normalized = {}
    if (value.start !== undefined) {
      normalized.start = normalizeDateValue(value.start)
    }
    if (value.end !== undefined) {
      normalized.end = normalizeDateValue(value.end)
    }
    if (value.min !== undefined) {
      normalized.start = normalizeDateValue(value.min)
    }
    if (value.max !== undefined) {
      normalized.end = normalizeDateValue(value.max)
    }
    return Object.keys(normalized).length > 0 ? normalized : null
  }
  
  if (typeof value === 'string') {
    // 尝试解析日期范围字符串（如 "2024-01-01 to 2024-12-31"）
    const rangeMatch = value.match(/(.+?)\s+(?:to|-|~)\s+(.+)$/)
    if (rangeMatch) {
      return {
        start: normalizeDateValue(rangeMatch[1].trim()),
        end: normalizeDateValue(rangeMatch[2].trim())
      }
    }
  }
  
  return null
}

/**
 * 规范化数据验证参数中的日期
 */
export function normalizeValidationParams(validationType, validationParams) {
  if (validationType !== 'date') {
    return validationParams
  }
  
  if (!validationParams || typeof validationParams !== 'object') {
    return validationParams
  }
  
  const normalized = { ...validationParams }
  
  // 处理日期范围
  if (normalized.min !== undefined) {
    normalized.min = normalizeDateValue(normalized.min)
  }
  if (normalized.max !== undefined) {
    normalized.max = normalizeDateValue(normalized.max)
  }
  if (normalized.start !== undefined) {
    normalized.start = normalizeDateValue(normalized.start)
  }
  if (normalized.end !== undefined) {
    normalized.end = normalizeDateValue(normalized.end)
  }
  
  // 处理日期范围对象
  if (normalized.range) {
    normalized.range = normalizeDateRange(normalized.range)
  }
  
  return normalized
}
