/**
 * 认证 API 客户端
 */
import appConfig from '../config/appConfig'
import { reportClientDiag } from '../utils/clientDiagLogger'

const getBaseUrl = () => appConfig.apiBaseUrl || ''

export async function register({ username, email, password, display_name }) {
  const res = await fetch(`${getBaseUrl()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password, display_name: display_name || null })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.detail || '注册失败')
  }
  return data
}

export async function login({ username, password, device_info }) {
  const res = await fetch(`${getBaseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device_info: device_info || null })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.detail || '登录失败')
  }
  return data
}

export async function logout(accessToken, refreshToken) {
  const res = await fetch(`${getBaseUrl()}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ refresh_token: refreshToken })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.detail || '退出失败')
  }
  return data
}

export async function getMe(accessToken) {
  const url = `${getBaseUrl()}/api/auth/me`
  reportClientDiag('auth_me_request', {
    url,
    hasAccessToken: !!accessToken,
    tokenPrefix: String(accessToken || '').slice(0, 16),
  })
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  reportClientDiag('auth_me_response', {
    url,
    status: res.status,
    ok: res.ok,
  })
  if (!res.ok) {
    if (res.status === 401) return null
    throw new Error('获取用户信息失败')
  }
  return res.json()
}

export async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${getBaseUrl()}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.detail || '刷新令牌失败')
    err.status = res.status
    throw err
  }
  return data
}

export async function changePassword(accessToken, { old_password, new_password }) {
  const res = await fetch(`${getBaseUrl()}/api/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ old_password, new_password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || '修改密码失败')
  return data
}

export async function changeEmail(accessToken, { new_email, password }) {
  const res = await fetch(`${getBaseUrl()}/api/auth/change-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ new_email, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || '更新邮箱失败')
  return data
}

export async function forgotPassword({ email }) {
  const res = await fetch(`${getBaseUrl()}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || '发送重置邮件失败')
  return data
}

export async function resetPassword({ token, new_password }) {
  const res = await fetch(`${getBaseUrl()}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, new_password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || '重置密码失败')
  return data
}
