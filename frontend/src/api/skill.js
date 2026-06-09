/**
 * 技能库 API - CRUD 操作
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
  const err = new Error(data.detail || fallbackMessage)
  err.status = res.status
  return err
}

// ----------------------------------------------------------------
// 列表（首次调用时后端自动播种预设技能）
// ----------------------------------------------------------------
export async function listSkills(token) {
  const res = await fetch(`${getBaseUrl()}/api/skill/list`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取技能列表失败')
  return res.json()
}

// ----------------------------------------------------------------
// 创建
// ----------------------------------------------------------------
export async function createSkill(token, body) {
  const res = await fetch(`${getBaseUrl()}/api/skill`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await buildHttpError(res, '创建技能失败')
  return res.json()
}

// ----------------------------------------------------------------
// 更新
// ----------------------------------------------------------------
export async function updateSkill(token, skillId, body) {
  const res = await fetch(`${getBaseUrl()}/api/skill/${skillId}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await buildHttpError(res, '更新技能失败')
  return res.json()
}

// ----------------------------------------------------------------
// 删除
// ----------------------------------------------------------------
export async function deleteSkill(token, skillId) {
  const res = await fetch(`${getBaseUrl()}/api/skill/${skillId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '删除技能失败')
}
