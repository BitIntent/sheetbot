// frontend/src/hooks/useWebSocket.js
/**
 * WebSocket Hook for real-time communication with backend
 */
import { useState, useEffect, useRef, useCallback } from 'react'

const DEFAULT_WS_HOST = 'localhost:8080'

const getWsBaseUrl = () => {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host || DEFAULT_WS_HOST
    return `${protocol}//${host}`
  }
  return `ws://${DEFAULT_WS_HOST}`
}

export function useWebSocket({ sessionId, onMessage, onConnect, onDisconnect }) {
  const [isConnected, setIsConnected] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState(null)
  const wsRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const reconnectAttempts = useRef(0)
  const maxReconnectAttempts = 5
  const connectionIdRef = useRef(null)
  
  // 使用 ref 存储回调函数，避免依赖变化导致重新连接
  const onMessageRef = useRef(onMessage)
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)
  
  // 更新 ref
  useEffect(() => {
    onMessageRef.current = onMessage
    onConnectRef.current = onConnect
    onDisconnectRef.current = onDisconnect
  }, [onMessage, onConnect, onDisconnect])

  const connect = useCallback(() => {
    // 如果已经连接或正在连接，不重复连接
    if (wsRef.current?.readyState === WebSocket.OPEN || 
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return
    }

    // 清理之前的连接
    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch (e) {
        // 忽略关闭错误
      }
    }

    try {
      const wsUrl = `${getWsBaseUrl()}/ws/${sessionId}`
      console.log(`[WS] 正在连接到: ${wsUrl}`)
      const ws = new WebSocket(wsUrl)
      
      ws.onopen = () => {
        console.log('[WS] 已连接')
        setIsConnected(true)
        setIsReady(false)
        setError(null)
        reconnectAttempts.current = 0
        onConnectRef.current?.()
      }
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          if (message?.type === 'connection_ready') {
            setIsReady(true)
          }
          if (message?.connectionId) {
            connectionIdRef.current = message.connectionId
          }
          if (message?.messageId) {
            const ackPayload = {
              messageId: message.messageId,
              connectionId: message.connectionId || connectionIdRef.current
            }
            try {
              ws.send(JSON.stringify({
                type: 'ack',
                payload: ackPayload,
                timestamp: new Date().toISOString()
              }))
            } catch (e) {
              // 忽略 ack 发送失败
            }
          }
          onMessageRef.current?.(message)
        } catch (e) {
          console.error('[WS] 解析消息失败:', e)
        }
      }
      
      ws.onerror = (event) => {
        console.error('[WS] WebSocket错误:', event)
        setError('WebSocket连接错误，请检查后端地址/端口是否可用')
        try {
          ws.close()
        } catch (e) {
          // 忽略关闭错误
        }
      }
      
      ws.onclose = (event) => {
        console.log(`[WS] 连接已关闭 (code: ${event.code}, reason: ${event.reason || 'none'})`)
        setIsConnected(false)
        setIsReady(false)
        onDisconnectRef.current?.(event)
        
        // 只有在非正常关闭时才重连（code 1000 是正常关闭）
        if (event.code !== 1000 && reconnectAttempts.current < maxReconnectAttempts) {
          reconnectAttempts.current++
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current - 1), 10000)
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log(`[WS] 尝试重连 (${reconnectAttempts.current}/${maxReconnectAttempts})...`)
            connect()
          }, delay)
        } else if (event.code === 1000) {
          // 正常关闭，清除错误
          setError(null)
        } else {
          setError('无法连接到服务器')
        }
      }
      
      wsRef.current = ws
    } catch (e) {
      console.error('[WS] 创建WebSocket失败:', e)
      setError('创建WebSocket连接失败')
    }
  }, [sessionId]) // 只依赖 sessionId，回调函数通过 ref 访问

  useEffect(() => {
    // 只在 sessionId 变化时重新连接
    connect()
    
    return () => {
      // 清理重连定时器
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      // 关闭 WebSocket 连接（正常关闭，code 1000）
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, 'Component unmounting')
        } catch (e) {
          // 忽略关闭错误
        }
        wsRef.current = null
      }
    }
  }, [sessionId]) // 只依赖 sessionId，避免无限循环

  const sendMessage = useCallback((type, payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type,
        payload,
        timestamp: new Date().toISOString()
      }))
    } else {
      console.warn('[WS] WebSocket未连接，无法发送消息')
    }
  }, [])

  return {
    sendMessage,
    isConnected,
    isReady,
    error
  }
}
