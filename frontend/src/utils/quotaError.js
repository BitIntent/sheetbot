// frontend/src/utils/quotaError.js
/**
 * 统一配额错误解析
 * 后端 QuotaGuard 返回结构化 detail，此工具提取并格式化为用户友好消息
 */

/**
 * 判断 HTTP 响应或 Error 是否为配额/权限错误
 * @param {Response|Error|object} resOrErr - fetch Response、Error、或已解析的 error body
 * @returns {boolean}
 */
export function isQuotaError(resOrErr) {
  if (!resOrErr) return false
  const status = resOrErr.status || resOrErr.statusCode
  if (status === 429 || status === 403 || status === 401) return true
  const code = resOrErr?.detail?.code || resOrErr?.code
  return code === 'quota_exceeded' || code === 'feature_disabled' || code === 'auth_required'
}

/**
 * 从 fetch Response 解析配额错误详情
 * @param {Response} res - fetch Response（非 ok）
 * @returns {Promise<{isQuota: boolean, message: string, detail: object|null}>}
 */
export async function parseQuotaResponse(res) {
  const status = res.status
  let body = null
  try {
    body = await res.json()
  } catch {
    return { isQuota: false, message: `请求失败 (${status})`, detail: null }
  }

  const detail = body?.detail
  if (!detail || typeof detail === 'string') {
    return { isQuota: false, message: detail || `请求失败 (${status})`, detail: null }
  }

  const code = detail.code
  if (code === 'quota_exceeded' || code === 'feature_disabled' || code === 'auth_required') {
    return { isQuota: true, message: detail.message, detail }
  }
  return { isQuota: false, message: detail.message || `请求失败 (${status})`, detail }
}

/**
 * 从 Error 对象中提取配额信息（适用于 buildHttpError 或 throw new Error 场景）
 * @param {Error} err
 * @returns {{isQuota: boolean, message: string, detail: object|null}}
 */
export function parseQuotaFromError(err) {
  if (!err) return { isQuota: false, message: '未知错误', detail: null }

  // files.js 的 buildHttpError 会把 detail 挂到 err.detail
  if (err.detail && typeof err.detail === 'object') {
    const code = err.detail.code
    if (code === 'quota_exceeded' || code === 'feature_disabled' || code === 'auth_required') {
      return { isQuota: true, message: err.detail.message, detail: err.detail }
    }
  }

  // useSSE sendCommand 的 "Command failed: 429 - {...}" 格式
  const msg = err.message || ''
  if (msg.includes('429') || msg.includes('403')) {
    const jsonMatch = msg.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0])
        const detail = parsed.detail || parsed
        if (detail.message) {
          return { isQuota: true, message: detail.message, detail }
        }
      } catch { /* 解析失败使用回退 */ }
    }
    if (msg.includes('429')) {
      return { isQuota: true, message: '已达到使用上限，请升级套餐后继续使用。', detail: null }
    }
    if (msg.includes('403')) {
      return { isQuota: true, message: '当前套餐未开通此功能，请升级套餐。', detail: null }
    }
  }
  if (msg.includes('401')) {
    return { isQuota: true, message: '登录已过期，请重新登录。', detail: null }
  }

  return { isQuota: false, message: msg || '请求失败', detail: null }
}
