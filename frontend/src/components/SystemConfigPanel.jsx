/**
 * 系统配置面板 - 从设置图标弹出的浮层
 * 时区、语言、通知偏好
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { X, Settings } from 'lucide-react'
import { useConfig } from '../contexts/ConfigContext'

const TIMEZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: '中国 (UTC+8)' },
  { value: 'Asia/Hong_Kong', label: '香港 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '日本 (UTC+9)' },
  { value: 'America/New_York', label: '美东 (UTC-5/-4)' },
  { value: 'America/Los_Angeles', label: '美西 (UTC-8/-7)' },
  { value: 'Europe/London', label: '伦敦 (UTC+0/+1)' },
  { value: 'UTC', label: 'UTC' },
]

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const SHEET_THEME_OPTIONS = [
  { value: 'excel-classic', label: 'MS Excel 经典（默认·白底）' },
  { value: 'glacier-blue', label: '冰川蓝（专业分析推荐）' },
  { value: 'mint-contrast', label: '薄荷对比（长时录入推荐）' },
  { value: 'sheetbot-dark', label: 'SheetBot 深色' },
  { value: 'oled-night', label: 'OLED 夜间（高对比）' },
]

export default function SystemConfigPanel({ open, onClose }) {
  const { t } = useTranslation()
  const { preferences, updatePreferences, loading } = useConfig()
  const panelRef = useRef(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)
  const [localTimezone, setLocalTimezone] = useState(preferences.timezone)
  const [localLanguage, setLocalLanguage] = useState(preferences.language)
  const [localSheetTheme, setLocalSheetTheme] = useState(preferences.sheet_theme || 'excel-classic')
  const [localNotif, setLocalNotif] = useState({ ...preferences.notification_prefs })

  useEffect(() => {
    if (open) {
      setLocalTimezone(preferences.timezone)
      setLocalLanguage(preferences.language)
      setLocalSheetTheme(preferences.sheet_theme || 'excel-classic')
      setLocalNotif({ ...preferences.notification_prefs })
    }
  }, [open, preferences])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await updatePreferences({
        timezone: localTimezone,
        language: localLanguage,
        notification_prefs: { ...localNotif, sheet_theme: localSheetTheme },
      })
      showToast(t('systemConfig.saveSuccess'))
      i18n.changeLanguage(localLanguage)
      onClose?.()
    } catch (e) {
      showToast(e?.message || t('systemConfig.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [localTimezone, localLanguage, localSheetTheme, localNotif, updatePreferences, showToast, t, onClose])

  const handleSheetThemeChange = useCallback(async (themeValue) => {
    setLocalSheetTheme(themeValue)
    try {
      await updatePreferences({
        notification_prefs: { ...localNotif, sheet_theme: themeValue },
      })
    } catch (e) {
      showToast(e?.message || t('systemConfig.saveFailed'))
    }
  }, [localNotif, showToast, t, updatePreferences])

  if (!open) return null

  return (
    <div className="system-config-panel" ref={panelRef}>
      <div className="system-config-panel-header">
        <span className="system-config-panel-title">
          <Settings size={16} style={{ marginRight: 6 }} />
          {t('systemConfig.title')}
        </span>
        <button className="system-config-panel-action" onClick={onClose} title="关闭">
          <X size={14} />
        </button>
      </div>
      <div className="system-config-panel-body">
        {loading ? (
          <div className="system-config-loading">{t('systemConfig.loading')}</div>
        ) : (
          <>
            <div className="system-config-section">
              <label className="system-config-label">{t('systemConfig.timezone')}</label>
              <select
                className="system-config-select"
                value={localTimezone}
                onChange={(e) => setLocalTimezone(e.target.value)}
              >
                {TIMEZONE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="system-config-section">
              <label className="system-config-label">{t('systemConfig.language')}</label>
              <select
                className="system-config-select"
                value={localLanguage}
                onChange={(e) => setLocalLanguage(e.target.value)}
              >
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="system-config-section">
              <label className="system-config-label">{t('systemConfig.sheetTheme')}</label>
              <select
                className="system-config-select"
                value={localSheetTheme}
                onChange={(e) => handleSheetThemeChange(e.target.value)}
              >
                {SHEET_THEME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="system-config-section">
              <label className="system-config-label">{t('systemConfig.notificationPrefs')}</label>
              <div className="system-config-checkboxes">
                <label className="system-config-check">
                  <input
                    type="checkbox"
                    checked={!!localNotif.sync}
                    onChange={(e) => setLocalNotif((p) => ({ ...p, sync: e.target.checked }))}
                  />
                  <span>{t('systemConfig.sync')}</span>
                </label>
                <label className="system-config-check">
                  <input
                    type="checkbox"
                    checked={!!localNotif.report}
                    onChange={(e) => setLocalNotif((p) => ({ ...p, report: e.target.checked }))}
                  />
                  <span>{t('systemConfig.report')}</span>
                </label>
                <label className="system-config-check">
                  <input
                    type="checkbox"
                    checked={!!localNotif.collect}
                    onChange={(e) => setLocalNotif((p) => ({ ...p, collect: e.target.checked }))}
                  />
                  <span>{t('systemConfig.collect')}</span>
                </label>
              </div>
            </div>
            <div className="system-config-actions">
              <button
                className="system-config-save-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? t('systemConfig.saving') : t('systemConfig.save')}
              </button>
            </div>
            {toast && <div className="system-config-toast">{toast}</div>}
          </>
        )}
      </div>
    </div>
  )
}
