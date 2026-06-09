/**
 * 系统配置 API - 用户偏好（时区、语言、通知等）
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

export async function getPreferences(token) {
  const res = await fetch(`${getBaseUrl()}/api/config/preferences`, {
    headers: authHeaders(token),
  })
  if (!res.ok) throw await buildHttpError(res, '获取配置失败')
  return res.json()
}

export async function updatePreferences(token, body) {
  const res = await fetch(`${getBaseUrl()}/api/config/preferences`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await buildHttpError(res, '保存配置失败')
  return res.json()
}
