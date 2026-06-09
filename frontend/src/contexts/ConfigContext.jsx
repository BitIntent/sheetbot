/**
 * 系统配置上下文 - 用户偏好（时区、语言、通知）+ 时间格式化
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import i18n from 'i18next'
import { useAuth } from './AuthContext'
import * as configApi from '../api/config'
import { formatInUserTimezone as _formatInUserTimezone } from '../utils/dateFormat'

const ConfigContext = createContext(null)
const SHEET_THEME_STORAGE_KEY = 'sheet_theme'

const DEFAULT_PREFS = {
  timezone: 'Asia/Shanghai',
  language: 'zh-CN',
  sheet_theme: 'excel-classic',
  notification_prefs: { sync: true, report: true, collect: true },
}

function getStoredSheetTheme() {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(SHEET_THEME_STORAGE_KEY)
}

function resolveSheetTheme(data) {
  return (
    data?.sheet_theme ||
    data?.notification_prefs?.sheet_theme ||
    getStoredSheetTheme() ||
    DEFAULT_PREFS.sheet_theme
  )
}

export function ConfigProvider({ children }) {
  const { accessToken, isAuthenticated, withFreshAccessToken } = useAuth()
  const [preferences, setPreferences] = useState(() => ({
    ...DEFAULT_PREFS,
    sheet_theme: getStoredSheetTheme() || DEFAULT_PREFS.sheet_theme,
  }))
  const [loading, setLoading] = useState(true)

  const fetchPreferences = useCallback(async () => {
    if (!isAuthenticated || !accessToken) {
      setPreferences(DEFAULT_PREFS)
      setLoading(false)
      return
    }
    try {
      const data = await withFreshAccessToken((token) => configApi.getPreferences(token))
      const prefs = {
        timezone: data.timezone || DEFAULT_PREFS.timezone,
        language: data.language || DEFAULT_PREFS.language,
        sheet_theme: resolveSheetTheme(data),
        notification_prefs: data.notification_prefs || DEFAULT_PREFS.notification_prefs,
      }
      setPreferences(prefs)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SHEET_THEME_STORAGE_KEY, prefs.sheet_theme)
      }
      if (prefs.language && prefs.language !== i18n.language) {
        i18n.changeLanguage(prefs.language)
      }
    } catch (e) {
      console.warn('获取配置失败:', e)
      setPreferences(DEFAULT_PREFS)
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, accessToken, withFreshAccessToken])

  useEffect(() => {
    fetchPreferences()
  }, [fetchPreferences])

  const updatePreferences = useCallback(
    async (partial) => {
      const prev = preferences
      const nextTheme = partial?.sheet_theme || partial?.notification_prefs?.sheet_theme
      setPreferences((curr) => ({
        ...curr,
        ...(nextTheme ? { sheet_theme: nextTheme } : {}),
        ...partial,
        notification_prefs: partial.notification_prefs
          ? { ...(curr.notification_prefs || {}), ...partial.notification_prefs }
          : curr.notification_prefs,
      }))
      if (nextTheme && typeof window !== 'undefined') {
        window.localStorage.setItem(SHEET_THEME_STORAGE_KEY, nextTheme)
      }
      if (!isAuthenticated || !accessToken) return { ...prev, ...partial }
      try {
        const data = await withFreshAccessToken((token) =>
          configApi.updatePreferences(token, partial)
        )
        const nextPrefs = {
          timezone: data.timezone || DEFAULT_PREFS.timezone,
          language: data.language || DEFAULT_PREFS.language,
          sheet_theme: resolveSheetTheme(data),
          notification_prefs: data.notification_prefs || DEFAULT_PREFS.notification_prefs,
        }
        setPreferences(nextPrefs)
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(SHEET_THEME_STORAGE_KEY, nextPrefs.sheet_theme)
        }
        return data
      } catch (e) {
        // 主题切换失败时不回滚视觉状态，确保用户“立即可见”；
        // 其他配置仍回滚，避免无感失败。
        if (!nextTheme) {
          setPreferences(prev)
        } else {
          setPreferences((curr) => ({
            ...prev,
            sheet_theme: nextTheme,
            notification_prefs: {
              ...(prev.notification_prefs || {}),
              ...(curr.notification_prefs || {}),
              sheet_theme: nextTheme,
            },
          }))
        }
        throw e
      }
    },
    [isAuthenticated, accessToken, withFreshAccessToken, preferences]
  )

  const formatInUserTimezone = useCallback(
    (isoStr, options) => {
      return _formatInUserTimezone(isoStr, preferences.timezone, options)
    },
    [preferences.timezone]
  )

  const value = {
    preferences,
    loading,
    fetchPreferences,
    updatePreferences,
    formatInUserTimezone,
  }

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
}

export function useConfig() {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider')
  return ctx
}
