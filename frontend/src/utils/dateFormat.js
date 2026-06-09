/**
 * 日期时间格式化工具 - 按用户时区显示
 * 后端返回 ISO 字符串（UTC），前端按用户配置时区转换展示
 */

const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 统一解析后端时间字符串：
 * - 若是无时区的 ISO（如 2026-02-27T03:59:11），按 UTC 解释，避免被浏览器当作本地时区
 */
function normalizeIsoInput(isoStr) {
  if (!isoStr) return isoStr
  const raw = String(isoStr).trim()
  const isIsoLike = /^\d{4}-\d{2}-\d{2}T/.test(raw)
  const hasTimezone = /(Z|[+-]\d{2}:\d{2})$/i.test(raw)
  if (isIsoLike && !hasTimezone) return `${raw}Z`
  return raw
}

/**
 * 将 ISO 时间字符串按指定时区格式化为本地化字符串
 * @param {string} isoStr - ISO 8601 字符串，如 "2024-01-15T08:30:00Z"
 * @param {string} [timezone] - 时区，如 "Asia/Shanghai"，默认 Asia/Shanghai
 * @param {object} [options] - Intl.DateTimeFormatOptions
 * @returns {string} 格式化后的时间字符串
 */
export function formatInUserTimezone(isoStr, timezone = DEFAULT_TIMEZONE, options = {}) {
  if (!isoStr) return '--'
  const dt = new Date(normalizeIsoInput(isoStr))
  if (Number.isNaN(dt.getTime())) return '--'
  const defaultOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...options,
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      ...defaultOptions,
      timeZone: timezone,
    }).format(dt)
  } catch (e) {
    return new Intl.DateTimeFormat('zh-CN', {
      ...defaultOptions,
      timeZone: DEFAULT_TIMEZONE,
    }).format(dt)
  }
}

/**
 * 仅日期（无时分秒）
 */
export function formatDateOnly(isoStr, timezone = DEFAULT_TIMEZONE) {
  return formatInUserTimezone(isoStr, timezone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: undefined,
    minute: undefined,
    second: undefined,
  })
}
