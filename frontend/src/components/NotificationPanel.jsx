/**
 * 通知面板 — 从铃铛图标弹出的浮层，显示通知列表
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { X, Check, CheckCheck, Trash2, Bell, FileBarChart, Megaphone } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useNotifications } from '../contexts/NotificationContext'
import appConfig from '../config/appConfig'

const TYPE_ICON_MAP = {
  report_completed: <FileBarChart size={16} style={{ color: '#34D399' }} />,
  report_failed: <FileBarChart size={16} style={{ color: '#F87171' }} />,
  system: <Bell size={16} style={{ color: '#60A5FA' }} />,
  announcement: <Megaphone size={16} style={{ color: '#FBBF24' }} />,
}

function timeAgo(isoStr) {
  if (!isoStr) return ''
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

export default function NotificationPanel({ open, onClose, onNavigate }) {
  const { notifications, markAsRead, markAllAsRead, deleteNotification, unreadCount } = useNotifications()
  const { isAuthenticated, withFreshAccessToken } = useAuth()
  const [announcements, setAnnouncements] = useState([])
  const panelRef = useRef(null)

  const loadAnnouncements = useCallback(async () => {
    if (!isAuthenticated || !open) return
    try {
      const data = await withFreshAccessToken(async (token) => {
        const base = appConfig.apiBaseUrl || ''
        const res = await fetch(`${base}/api/notifications/announcements`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return res.ok ? res.json() : []
      })
      setAnnouncements(Array.isArray(data) ? data.slice(0, 5) : [])
    } catch { setAnnouncements([]) }
  }, [isAuthenticated, withFreshAccessToken, open])

  useEffect(() => { loadAnnouncements() }, [loadAnnouncements])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  if (!open) return null

  const handleNavigate = (notif) => {
    if (!notif.is_read) markAsRead(notif.id)
    if (notif.type === 'report_completed' && onNavigate) {
      onNavigate(notif.payload)
    }
  }

  const handleClick = (notif) => {
    handleNavigate(notif)
  }

  const handleLinkClick = (notif, e) => {
    e.stopPropagation()
    handleClick(notif)
  }

  return (
    <div className="notification-panel" ref={panelRef}>
      <div className="notification-panel-header">
        <span className="notification-panel-title">
          通知 {unreadCount > 0 && <span className="notification-badge-inline">{unreadCount}</span>}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {unreadCount > 0 && (
            <button className="notification-panel-action" onClick={markAllAsRead} title="全部已读">
              <CheckCheck size={14} />
            </button>
          )}
          <button className="notification-panel-action" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="notification-panel-body">
        {/* 系统公告区 */}
        {announcements.length > 0 && (
          <div className="notification-section-label">系统公告</div>
        )}
        {announcements.map(ann => (
          <div key={`ann-${ann.id}`} className="notification-item unread" style={{ borderLeft: '3px solid #FBBF24' }}>
            <div className="notification-item-icon">
              {TYPE_ICON_MAP.announcement}
            </div>
            <div className="notification-item-content">
              <div className="notification-item-title">{ann.title}</div>
              {ann.content && <div className="notification-item-msg">{ann.content}</div>}
              <div className="notification-item-time">
                {ann.publish_at ? new Date(ann.publish_at).toLocaleDateString('zh-CN') : ''}
              </div>
            </div>
          </div>
        ))}
        {announcements.length > 0 && notifications.length > 0 && (
          <div className="notification-section-label">消息通知</div>
        )}
        {notifications.length === 0 && announcements.length === 0 ? (
          <div className="notification-empty">
            <Bell size={28} style={{ opacity: 0.3 }} />
            <p>暂无通知</p>
          </div>
        ) : notifications.length === 0 ? null : (
          notifications.map(notif => (
            <div
              key={notif.id}
              className={`notification-item ${notif.is_read ? 'read' : 'unread'}`}
              onClick={() => handleClick(notif)}
            >
              <div className="notification-item-icon">
                {TYPE_ICON_MAP[notif.type] || <Bell size={16} />}
              </div>
              <div className="notification-item-content">
                <div className="notification-item-title">{notif.title}</div>
                {notif.message && <div className="notification-item-msg">{notif.message}</div>}
                {notif.type === 'report_completed' && onNavigate && (
                  <button
                    className="notification-inline-link"
                    onClick={(e) => handleLinkClick(notif, e)}
                  >
                    查看“数据报表”
                  </button>
                )}
                <div className="notification-item-time">{timeAgo(notif.created_at)}</div>
              </div>
              <button
                className="notification-item-delete"
                onClick={(e) => { e.stopPropagation(); deleteNotification(notif.id) }}
                title="删除"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
