/**
 * 通知上下文 — 管理 SSE 连接 + 未读计数 + 通知 CRUD
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'
import { resolveApiBaseUrl } from '../config/appConfig'

const API_BASE = resolveApiBaseUrl()
const NotificationContext = createContext(null)

export function NotificationProvider({ children }) {
  const { isAuthenticated, withFreshAccessToken } = useAuth()
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [streamError, setStreamError] = useState('')
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const [retrySeed, setRetrySeed] = useState(0)
  const eventSourceRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const reconnectAttemptsRef = useRef(0)
  const listenersRef = useRef(new Set())

  const apiFetch = useCallback(async (path, options = {}) => {
    return withFreshAccessToken(async (token) => {
      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json()
    })
  }, [withFreshAccessToken])

  const fetchUnreadCount = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const data = await apiFetch('/api/notifications/unread-count')
      setUnreadCount(data.unread_count || 0)
    } catch (e) {
      console.warn('获取未读数失败:', e)
    }
  }, [isAuthenticated, apiFetch])

  const fetchNotifications = useCallback(async (page = 1) => {
    if (!isAuthenticated) return
    try {
      const data = await apiFetch(`/api/notifications?page=${page}&page_size=30`)
      setNotifications(data.notifications || [])
      return data
    } catch (e) {
      console.warn('获取通知列表失败:', e)
      return { notifications: [], total: 0 }
    }
  }, [isAuthenticated, apiFetch])

  const markAsRead = useCallback(async (id) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'PUT' })
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (e) {
      console.warn('标记已读失败:', e)
    }
  }, [apiFetch])

  const markAllAsRead = useCallback(async () => {
    try {
      await apiFetch('/api/notifications/read-all', { method: 'PUT' })
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
      setUnreadCount(0)
    } catch (e) {
      console.warn('全部标记已读失败:', e)
    }
  }, [apiFetch])

  const deleteNotification = useCallback(async (id) => {
    try {
      await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' })
      setNotifications(prev => {
        const target = prev.find(n => n.id === id)
        if (target && !target.is_read) setUnreadCount(c => Math.max(0, c - 1))
        return prev.filter(n => n.id !== id)
      })
    } catch (e) {
      console.warn('删除通知失败:', e)
    }
  }, [apiFetch])

  const addListener = useCallback((callback) => {
    listenersRef.current.add(callback)
    return () => listenersRef.current.delete(callback)
  }, [])

  // SSE 连接
  useEffect(() => {
    if (!isAuthenticated) return
    let disposed = false

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (disposed) return
      clearReconnectTimer()
      reconnectAttemptsRef.current += 1
      setReconnectAttempts(reconnectAttemptsRef.current)
      reconnectTimerRef.current = setTimeout(() => {
        connect()
      }, 5000)
    }

    const connect = async () => {
      if (disposed) return
      if (eventSourceRef.current) {
        eventSourceRef.current.onopen = null
        eventSourceRef.current.onmessage = null
        eventSourceRef.current.onerror = null
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      try {
        // 每次连接/重连前都获取最新可用 access token，避免使用过期 token 持续 401
        const token = await withFreshAccessToken(async (freshToken) => freshToken)
        if (disposed || !token) {
          scheduleReconnect()
          return
        }
        const url = `${API_BASE}/api/notifications/stream?token=${encodeURIComponent(token)}`
        const es = new EventSource(url)
        eventSourceRef.current = es
        es.onopen = () => {
          reconnectAttemptsRef.current = 0
          setReconnectAttempts(0)
          setStreamError('')
        }

        es.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            if (msg.event === 'notification') {
              const notif = msg.data
              setNotifications(prev => [notif, ...prev])
              setUnreadCount(prev => prev + 1)
              listenersRef.current.forEach(cb => {
                try { cb(notif) } catch (e) { console.warn(e) }
              })
            }
          } catch (e) {
            // heartbeat or parse error
          }
        }

        es.onerror = () => {
          // 仅处理“当前活动连接”的错误，忽略被主动关闭的旧连接回调。
          if (disposed || eventSourceRef.current !== es) return
          eventSourceRef.current = null
          es.close()
          if (reconnectAttemptsRef.current >= 2) {
            setStreamError('通知连接异常，正在自动重连。你也可以点击“立即重试”。')
          }
          scheduleReconnect()
        }
      } catch (e) {
        const msg = String(e?.message || '')
        if (msg.includes('SESSION_EXPIRED')) {
          setStreamError('登录会话已过期，通知流已暂停，请重新登录。')
          return
        }
        console.warn('通知 SSE 建立失败，将重试:', e)
        if (reconnectAttemptsRef.current >= 2) {
          setStreamError('通知流重连失败，可能是网络波动或令牌失效。')
        }
        scheduleReconnect()
      }
    }

    fetchUnreadCount()
    fetchNotifications()
    connect()

    return () => {
      disposed = true
      clearReconnectTimer()
      if (eventSourceRef.current) {
        eventSourceRef.current.onopen = null
        eventSourceRef.current.onmessage = null
        eventSourceRef.current.onerror = null
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    }
  }, [isAuthenticated, withFreshAccessToken, fetchUnreadCount, fetchNotifications, retrySeed])

  const value = {
    notifications,
    unreadCount,
    fetchNotifications,
    fetchUnreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    addListener,
    notificationStreamError: streamError,
    reconnectNotificationStream: () => setRetrySeed((v) => v + 1),
  }

  return (
    <NotificationContext.Provider value={value}>
      {children}
      {streamError && (
        <div style={{
          position: 'fixed',
          right: 20,
          bottom: 24,
          maxWidth: 420,
          background: 'rgba(138, 77, 20, 0.95)',
          color: '#fff',
          borderRadius: 10,
          padding: '10px 12px',
          zIndex: 9998,
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          fontSize: 13,
          lineHeight: 1.6,
        }}>
          <div>{streamError}</div>
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <button
              onClick={() => {
                reconnectAttemptsRef.current = 0
                setReconnectAttempts(0)
                setStreamError('')
                if (eventSourceRef.current) {
                  eventSourceRef.current.onopen = null
                  eventSourceRef.current.onmessage = null
                  eventSourceRef.current.onerror = null
                  eventSourceRef.current.close()
                  eventSourceRef.current = null
                }
                setRetrySeed((v) => v + 1)
              }}
              style={{
                border: '1px solid rgba(255,255,255,0.4)',
                background: 'transparent',
                color: '#fff',
                borderRadius: 6,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              立即重试
            </button>
          </div>
        </div>
      )}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider')
  return ctx
}
