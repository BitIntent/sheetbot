// frontend/src/config/appConfig.js
/**
 * ===================================
 * 应用配置
 * - 默认值可被 .env 覆盖
 * ===================================
 */
const clampNumber = (value, min, max, fallback) => {
  const num = Number(value)
  if (Number.isNaN(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

const stripTrailingSlash = (url) => String(url || '').replace(/\/$/, '')

const toHttpBase = (raw) => {
  const val = stripTrailingSlash(raw)
  if (!val) return ''
  if (val.startsWith('http')) return val
  return val.replace(/^ws(s)?:\/\//, 'http$1://')
}

const isSameOrigin = (targetUrl, currentOrigin) => {
  if (!targetUrl || !currentOrigin) return false
  try {
    return new URL(targetUrl).origin === new URL(currentOrigin).origin
  } catch {
    return false
  }
}

// 获取 API 基础 URL
export const resolveApiBaseUrl = () => {
  const envApi = toHttpBase(import.meta.env.VITE_API_URL)
  const envWs = toHttpBase(import.meta.env.VITE_WS_URL)
  const browserOrigin = typeof window !== 'undefined' ? stripTrailingSlash(window.location.origin) : ''

  // 开发环境优先使用显式配置，便于本地联调。
  if (import.meta.env.DEV) {
    return envApi || envWs || 'http://localhost:8000'
  }

  // 生产环境优先同源，避免换 IP 后旧构建把请求打到历史地址导致登录态失效。
  if (browserOrigin) {
    if (envApi && isSameOrigin(envApi, browserOrigin)) return envApi
    if (envWs && isSameOrigin(envWs, browserOrigin)) return envWs
    return browserOrigin
  }

  // SSR 或非浏览器环境回退到显式配置。
  return envApi || envWs || ''
}

const appConfig = {
  aiTimeoutSec: clampNumber(import.meta.env.VITE_AI_TIMEOUT_SEC, 10, 300, 90),
  apiBaseUrl: resolveApiBaseUrl(),
  // 已迁移至 DB + GET /api/config/platform；仅作离线/首屏兜底（与后端种子默认一致）
  autoAnalyzeMaxFileSizeMb: clampNumber(import.meta.env.VITE_AUTO_ANALYZE_MAX_FILE_MB, 1, 10240, 20),
  autoAnalyzeMaxRows: Math.round(clampNumber(import.meta.env.VITE_AUTO_ANALYZE_MAX_ROWS, 10000, 5000000, 20000)),
}

export default appConfig
