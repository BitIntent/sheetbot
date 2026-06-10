// frontend/src/hooks/useSSE.js
/**
 * SSE Hook for real-time communication with backend
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { resolveApiBaseUrl } from '../config/appConfig'

const getApiBaseUrl = () => {
  const base = resolveApiBaseUrl()
  if (base) return String(base).replace(/\/$/, '')
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'http://localhost:8080'
}

export function useSSE({ sessionId, accessToken, onMessage, onConnect, onDisconnect }) {
  const [isConnected, setIsConnected] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState(null)
  const esRef = useRef(null)

  const onMessageRef = useRef(onMessage)
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)

  useEffect(() => {
    onMessageRef.current = onMessage
    onConnectRef.current = onConnect
    onDisconnectRef.current = onDisconnect
  }, [onMessage, onConnect, onDisconnect])

  useEffect(() => {
    if (!sessionId) return
    
    let es = null
    
    try {
      const baseUrl = getApiBaseUrl()
      // 对 sessionId 进行 URI 编码，防止特殊字符导致 URI 解析错误
      const encodedSessionId = encodeURIComponent(sessionId)
      const url = `${baseUrl}/sse/${encodedSessionId}`
      
      // 验证 URL 格式
      new URL(url) // 如果 URL 无效会抛出异常
      
      es = new EventSource(url)
      esRef.current = es
    } catch (e) {
      console.error('[SSE] 构建 URL 失败:', e)
      setError(new Error(`无法连接到服务器: ${e.message}`))
      return
    }

    // 确保 es 已创建
    if (!es) return

    es.onopen = () => {
      setIsConnected(true)
      onConnectRef.current?.()
    }

    es.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message?.type === 'connection_ready') {
          setIsReady(true)
        }
        onMessageRef.current?.(message)
      } catch (e) {
        setError(e)
      }
    }

    es.onerror = () => {
      setIsConnected(false)
      setIsReady(false)
      onDisconnectRef.current?.()
    }

    return () => {
      if (es) {
        es.close()
      }
      esRef.current = null
    }
  }, [sessionId])

  const sendCommand = useCallback(async (payload) => {
    const baseUrl = getApiBaseUrl()
    const headers = { 'Content-Type': 'application/json' }
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
    const res = await fetch(`${baseUrl}/api/excel/command`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ session_id: sessionId, ...payload })
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Command failed: ${res.status}${detail ? ` - ${detail}` : ''}`)
    }
  }, [sessionId, accessToken])

  const sendState = useCallback(async (payload) => {
    const context = payload?.context ?? payload
    const contextVersion = payload?.contextVersion
    const baseUrl = getApiBaseUrl()
    const res = await fetch(`${baseUrl}/api/excel/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, context, contextVersion })
    })
    if (!res.ok) {
      throw new Error(`State update failed: ${res.status}`)
    }
  }, [sessionId])

  return {
    isConnected,
    isReady,
    error,
    sendCommand,
    sendState
  }
}
