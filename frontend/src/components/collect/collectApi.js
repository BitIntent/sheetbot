/**
 * 收集模块 API 基础地址解析
 */
import { resolveApiBaseUrl } from '../../config/appConfig'

export function getCollectApiBase() {
  const resolved = resolveApiBaseUrl()
  if (resolved) return String(resolved).replace(/\/$/, '')
  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/$/, '')
  }
  return ''
}

