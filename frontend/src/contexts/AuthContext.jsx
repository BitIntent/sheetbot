/**
 * 认证上下文 - 管理登录状态与 Token
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import * as authApi from '../api/auth'
import { reportClientDiag } from '../utils/clientDiagLogger'

const STORAGE_ACCESS = 'sheetbot_access_token'
const STORAGE_REFRESH = 'sheetbot_refresh_token'
const STORAGE_USER = 'sheetbot_user'

const AuthContext = createContext(null)

function readStorageValue(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key)
}

function writeStorageValue(key, value) {
  localStorage.setItem(key, value)
  sessionStorage.setItem(key, value)
}

function removeStorageValue(key) {
  localStorage.removeItem(key)
  sessionStorage.removeItem(key)
}

// ---------------------------------------------------------------------------
// Cookie 中继消费：landing.html 登录后写入 sheetbot_handoff Cookie，
// 在 workspace React 启动时读取并立即转存到 localStorage/sessionStorage，
// 解决 Chrome 跨页导航 localStorage 偶发不可读的问题。
// ---------------------------------------------------------------------------
function consumeHandoffCookie() {
  if (typeof document === 'undefined') return
  const match = document.cookie.match(/(?:^|;\s*)sheetbot_handoff=([^;]+)/)
  if (!match) return
  try {
    const { at, rt, u } = JSON.parse(decodeURIComponent(match[1]))
    // 立即删除 cookie，防止重复消费
    document.cookie = 'sheetbot_handoff=; path=/; max-age=0; SameSite=Strict'
    if (at && rt) {
      writeStorageValue(STORAGE_ACCESS, at)
      writeStorageValue(STORAGE_REFRESH, rt)
      if (u) writeStorageValue(STORAGE_USER, JSON.stringify(u))
      reportClientDiag('auth_handoff_cookie_consumed', {
        path: typeof window !== 'undefined' ? window.location.pathname : '',
        tokenPrefix: String(at).slice(0, 16),
      })
    }
  } catch (_) {}
}

// 模块加载时立即消费（早于任何 React 渲染）
consumeHandoffCookie()

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [accessToken, setAccessToken] = useState(() => readStorageValue(STORAGE_ACCESS))
  const [refreshToken, setRefreshToken] = useState(() => readStorageValue(STORAGE_REFRESH))
  const [loading, setLoading] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)

  const clearStorage = useCallback(() => {
    reportClientDiag('auth_clear_storage', {
      path: typeof window !== 'undefined' ? window.location.pathname : '',
      hadAccessToken: !!readStorageValue(STORAGE_ACCESS),
      hadRefreshToken: !!readStorageValue(STORAGE_REFRESH),
    })
    removeStorageValue(STORAGE_ACCESS)
    removeStorageValue(STORAGE_REFRESH)
    removeStorageValue(STORAGE_USER)
    setAccessToken(null)
    setRefreshToken(null)
    setUser(null)
  }, [])

  const saveTokens = useCallback((access, refresh, userData) => {
    writeStorageValue(STORAGE_ACCESS, access)
    writeStorageValue(STORAGE_REFRESH, refresh)
    if (userData) {
      writeStorageValue(STORAGE_USER, JSON.stringify(userData))
      setUser(userData)
    }
    setAccessToken(access)
    setRefreshToken(refresh)
  }, [])

  const login = useCallback(async ({ username, password }) => {
    const data = await authApi.login({
      username,
      password,
      device_info: navigator.userAgent
    })
    saveTokens(data.access_token, data.refresh_token, data.user)
    return data
  }, [saveTokens])

  const register = useCallback(async ({ username, email, password }) => {
    const data = await authApi.register({ username, email, password })
    return data
  }, [])

  const logout = useCallback(async () => {
    if (accessToken && refreshToken) {
      try {
        await authApi.logout(accessToken, refreshToken)
      } catch (e) {
        console.warn('退出请求失败:', e)
      }
    }
    clearStorage()
  }, [accessToken, refreshToken, clearStorage])

  const withFreshAccessToken = useCallback(async (runner) => {
    if (typeof runner !== 'function') {
      throw new Error('withFreshAccessToken runner 必须是函数')
    }

    const isAuthError = (error) => {
      if (error?.status === 401) return true
      if (error?.response?.status === 401) return true
      if (error?.res?.status === 401) return true
      const msg = String(error?.message || '')
      return msg.includes('401') || msg.includes('无效的认证凭据') || msg.includes('expired')
    }

    const runWithToken = async (token) => {
      const result = await runner(token)
      // 兼容 runner 直接返回 fetch Response（未主动抛错）的场景
      if (typeof Response !== 'undefined' && result instanceof Response && result.status === 401) {
        const authError = new Error('HTTP 401')
        authError.status = 401
        throw authError
      }
      return result
    }

    try {
      return await runWithToken(accessToken)
    } catch (error) {
      if (!isAuthError(error)) {
        throw error
      }
      if (!refreshToken) {
        setSessionExpired(true)
        const sessionErr = new Error('SESSION_EXPIRED')
        sessionErr.code = 'SESSION_EXPIRED'
        throw sessionErr
      }
      try {
        const refreshed = await authApi.refreshAccessToken(refreshToken)
        const nextAccessToken = refreshed.access_token
        const nextRefreshToken = refreshed.refresh_token || refreshToken
        saveTokens(nextAccessToken, nextRefreshToken, user)
        return runWithToken(nextAccessToken)
      } catch (_) {
        setSessionExpired(true)
        const sessionErr = new Error('SESSION_EXPIRED')
        sessionErr.code = 'SESSION_EXPIRED'
        throw sessionErr
      }
    }
  }, [accessToken, refreshToken, saveTokens, user])

  const handleRelogin = useCallback(() => {
    setSessionExpired(false)
    clearStorage()
    window.location.replace('/landing.html')
  }, [clearStorage])

  useEffect(() => {
    const bootAccessToken = accessToken || readStorageValue(STORAGE_ACCESS)
    const bootRefreshToken = refreshToken || readStorageValue(STORAGE_REFRESH)

    if (bootAccessToken && bootAccessToken !== accessToken) {
      setAccessToken(bootAccessToken)
    }
    if (bootRefreshToken && bootRefreshToken !== refreshToken) {
      setRefreshToken(bootRefreshToken)
    }

    if (!bootAccessToken) {
      reportClientDiag('auth_bootstrap_no_access_token', {
        path: typeof window !== 'undefined' ? window.location.pathname : '',
      })
      setUser(null)
      setLoading(false)
      return
    }
    reportClientDiag('auth_bootstrap_start_get_me', {
      path: typeof window !== 'undefined' ? window.location.pathname : '',
      tokenPrefix: String(bootAccessToken).slice(0, 16),
    })
    authApi.getMe(bootAccessToken)
      .then((u) => {
        if (u) {
          reportClientDiag('auth_bootstrap_get_me_ok', {
            username: u.username || '',
          })
          setUser(u)
          writeStorageValue(STORAGE_USER, JSON.stringify(u))
        } else {
          reportClientDiag('auth_bootstrap_get_me_returned_null')
          clearStorage()
        }
      })
      .catch((e) => {
        reportClientDiag('auth_bootstrap_get_me_error', {
          message: String(e?.message || ''),
        })
        clearStorage()
      })
      .finally(() => setLoading(false))
  }, [accessToken, clearStorage])

  const value = {
    user,
    accessToken,
    refreshToken,
    loading,
    isAuthenticated: !!accessToken && !!user,
    login,
    register,
    logout,
    saveTokens,
    withFreshAccessToken,
    sessionExpired,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
      {sessionExpired && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
        }}>
          <div style={{
            width: 420,
            maxWidth: '90vw',
            background: 'var(--bg-secondary, #1a1a1a)',
            border: '1px solid var(--border-color, #333)',
            borderRadius: 12,
            padding: '18px 20px',
            color: 'var(--text-primary, #e5e5e5)',
          }}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 10 }}>登录会话已过期</div>
            <div style={{ fontSize: 14, lineHeight: 1.7, opacity: 0.9, marginBottom: 16 }}>
              当前登录状态已失效，请重新登录后继续操作。
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleRelogin}
                style={{
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 16px',
                  background: 'linear-gradient(135deg, var(--accent-primary, #217346), #2A9058)',
                  color: '#fff',
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                重新登录
              </button>
            </div>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
