/**
 * ============================================================================
 * 系统公告组件 — 顶部横幅 + 新公告弹窗
 * - 登录后拉取活跃公告
 * - localStorage 记录已关闭的公告 ID，避免重复弹窗
 * - info/warning/error 三种类型视觉区分
 * ============================================================================
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { X, Megaphone, AlertTriangle, Info } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import appConfig from '../config/appConfig'

const API_BASE = appConfig.apiBaseUrl || ''
const LS_KEY = 'sheetbot_dismissed_announcements'

function getDismissed() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
function addDismissed(id) {
  const set = new Set(getDismissed())
  set.add(id)
  const arr = [...set].slice(-200)
  localStorage.setItem(LS_KEY, JSON.stringify(arr))
}

const TYPE_STYLES = {
  info:    { icon: Info,           bg: 'rgba(59,130,246,0.12)', border: '#3b82f6', color: '#93bbfd' },
  warning: { icon: AlertTriangle,  bg: 'rgba(245,158,11,0.12)', border: '#f59e0b', color: '#fcd34d' },
  error:   { icon: AlertTriangle,  bg: 'rgba(239,68,68,0.12)',  border: '#ef4444', color: '#fca5a5' },
}

export default function AnnouncementOverlay() {
  const { isAuthenticated, withFreshAccessToken } = useAuth()
  const [announcements, setAnnouncements] = useState([])
  const [modalItem, setModalItem] = useState(null)
  const fetchedRef = useRef(false)

  const fetchAnnouncements = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const data = await withFreshAccessToken(async (token) => {
        const res = await fetch(`${API_BASE}/api/notifications/announcements`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) return []
        return res.json()
      })
      if (!Array.isArray(data) || data.length === 0) return
      const dismissed = new Set(getDismissed())
      const visible = data.filter(a => !dismissed.has(a.id))
      setAnnouncements(visible)
      const first = visible.find(a => a.type === 'warning' || a.type === 'error') || visible[0]
      if (first) setModalItem(first)
    } catch { /* 静默 */ }
  }, [isAuthenticated, withFreshAccessToken])

  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    fetchAnnouncements()
  }, [fetchAnnouncements])

  const dismissBanner = (id) => {
    addDismissed(id)
    setAnnouncements(prev => prev.filter(a => a.id !== id))
  }
  const closeModal = () => {
    if (modalItem) addDismissed(modalItem.id)
    setModalItem(null)
  }

  const banners = announcements.slice(0, 2)

  return (
    <>
      {/* ===== 顶部横幅（最多 2 条） ===== */}
      {banners.map(ann => {
        const ts = TYPE_STYLES[ann.type] || TYPE_STYLES.info
        const Icon = ts.icon
        return (
          <div
            key={ann.id}
            className="announcement-banner"
            style={{ background: ts.bg, borderBottom: `1px solid ${ts.border}` }}
          >
            <Icon size={15} style={{ color: ts.color, flexShrink: 0 }} />
            <span className="announcement-banner-title">{ann.title}</span>
            {ann.content && <span className="announcement-banner-sep">-</span>}
            {ann.content && <span className="announcement-banner-content">{ann.content}</span>}
            <button className="announcement-banner-close" onClick={() => dismissBanner(ann.id)}>
              <X size={14} />
            </button>
          </div>
        )
      })}

      {/* ===== 弹窗（仅首条未读公告） ===== */}
      {modalItem && (
        <div className="announcement-modal-overlay" onClick={closeModal}>
          <div className="announcement-modal" onClick={e => e.stopPropagation()}>
            <div className="announcement-modal-header">
              <Megaphone size={18} style={{ color: (TYPE_STYLES[modalItem.type] || TYPE_STYLES.info).color }} />
              <span>系统公告</span>
              <button className="announcement-modal-close" onClick={closeModal}><X size={16} /></button>
            </div>
            <div className="announcement-modal-body">
              <h3 className="announcement-modal-title">{modalItem.title}</h3>
              {modalItem.content && <p className="announcement-modal-text">{modalItem.content}</p>}
              {modalItem.publish_at && (
                <div className="announcement-modal-date">
                  {new Date(modalItem.publish_at).toLocaleDateString('zh-CN')}
                </div>
              )}
            </div>
            <div className="announcement-modal-footer">
              <button className="announcement-modal-btn" onClick={closeModal}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
