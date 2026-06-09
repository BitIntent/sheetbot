/**
 * 自定义公式 API - CRUD 操作
 */
import appConfig from '../config/appConfig'

const getBaseUrl = () => appConfig.apiBaseUrl || ''

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function buildHttpError(res, fallbackMessage) {
  const data = await res.json().catch(() => ({}))
  const detail = data?.detail
  const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
  const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || fallbackMessage))
  const err = new Error(msg)
  err.status = res.status
  err.detail = detail
  err.isQuota = isQuota
  return err
}

// ----------------------------------------------------------------
// 列表（首次调用时后端自动播种预设公式）
// ----------------------------------------------------------------
export async function listFormulas(token) {
  const res = await fetch(`${getBaseUrl()}/api/formula/list`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取公式列表失败')
  return res.json()
}

// ----------------------------------------------------------------
// 创建
// ----------------------------------------------------------------
export async function createFormula(token, body) {
  const res = await fetch(`${getBaseUrl()}/api/formula`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await buildHttpError(res, '创建公式失败')
  return res.json()
}

// ----------------------------------------------------------------
// 更新
// ----------------------------------------------------------------
export async function updateFormula(token, formulaId, body) {
  const res = await fetch(`${getBaseUrl()}/api/formula/${formulaId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await buildHttpError(res, '更新公式失败')
  return res.json()
}

// ----------------------------------------------------------------
// 删除
// ----------------------------------------------------------------
export async function deleteFormula(token, formulaId) {
  const res = await fetch(`${getBaseUrl()}/api/formula/${formulaId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '删除公式失败')
}
