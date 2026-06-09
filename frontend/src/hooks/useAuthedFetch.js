import { useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'

/**
 * 统一封装带鉴权的 fetch：
 * - 自动注入 Bearer Token
 * - 复用 withFreshAccessToken 的 401 刷新与重试能力
 */
export function useAuthedFetch() {
  const { withFreshAccessToken } = useAuth()

  return useCallback(async (url, options = {}) => {
    return withFreshAccessToken(async (token) => {
      const headers = {
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }
      return fetch(url, { ...options, headers })
    })
  }, [withFreshAccessToken])
}

