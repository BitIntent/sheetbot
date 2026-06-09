import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Database, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

function MemoryPanel({ fileId, apiBaseUrl, accessToken, onCleared }) {
  const { withFreshAccessToken } = useAuth()
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const intervalRef = useRef(null)

  const fetchInfo = useCallback(async () => {
    if (!fileId || !apiBaseUrl) return
    try {
      const res = await fetch(`${apiBaseUrl}/api/large-file/session-info/${encodeURIComponent(fileId)}`)
      if (res.ok) {
        setInfo(await res.json())
      }
    } catch (_) { /* ignore */ }
  }, [fileId, apiBaseUrl])

  useEffect(() => {
    fetchInfo()
    intervalRef.current = setInterval(fetchInfo, 15000)
    return () => clearInterval(intervalRef.current)
  }, [fetchInfo])

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    await fetchInfo()
    setLoading(false)
  }, [fetchInfo])

  const handleClear = useCallback(async () => {
    if (!fileId || !apiBaseUrl) return
    setClearing(true)
    try {
      await withFreshAccessToken(async (token) => {
        const res = await fetch(`${apiBaseUrl}/api/large-file/clear-session`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token || accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ source_file_id: fileId }),
        })
        if (!res.ok) {
          const err = new Error(`清理失败: ${res.status}`)
          err.status = res.status
          throw err
        }
        return res
      })
      await fetchInfo()
      onCleared?.()
    } catch (_) { /* ignore */ }
    setClearing(false)
  }, [fileId, apiBaseUrl, accessToken, fetchInfo, onCleared, withFreshAccessToken])

  if (!info) return null

  const srcCount = info.source_tables?.length || 0
  const resCount = info.result_tables?.length || 0
  const totalCount = info.table_count || 0
  const totalRows = info.total_rows || 0

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      color: '#666',
      marginLeft: 8,
      userSelect: 'none',
      position: 'relative',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'none', border: '1px solid #e0e0e0', borderRadius: 4,
          padding: '2px 8px', cursor: 'pointer', fontSize: 12, color: '#555',
        }}
        title="内存会话信息"
      >
        <Database size={12} />
        <span>{totalCount} 表 / {totalRows.toLocaleString()} 行</span>
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>

      {expanded && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: '#fff', border: '1px solid #e0e0e0', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', padding: 12,
          minWidth: 280, zIndex: 999,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: '#333' }}>内存会话</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={handleRefresh}
                disabled={loading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 2,
                  background: 'none', border: '1px solid #ddd', borderRadius: 4,
                  padding: '2px 6px', cursor: 'pointer', fontSize: 11, color: '#666',
                }}
                title="刷新"
              >
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={handleClear}
                disabled={clearing || totalCount === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 2,
                  background: totalCount > 0 ? '#fee2e2' : '#f5f5f5',
                  border: '1px solid #fca5a5', borderRadius: 4,
                  padding: '2px 6px', cursor: totalCount > 0 ? 'pointer' : 'default',
                  fontSize: 11, color: totalCount > 0 ? '#dc2626' : '#999',
                }}
                title="清空所有内存表"
              >
                <Trash2 size={11} />
                <span>{clearing ? '清理中...' : '清空'}</span>
              </button>
            </div>
          </div>

          {srcCount > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>源数据表 ({srcCount})</div>
              {info.source_tables.map((t, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '2px 4px', fontSize: 12, color: '#444',
                  background: i % 2 === 0 ? '#fafafa' : 'transparent', borderRadius: 3,
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{t.name}</span>
                  <span style={{ color: '#888', fontSize: 11 }}>{(t.row_count || 0).toLocaleString()} 行</span>
                </div>
              ))}
            </div>
          )}

          {resCount > 0 && (
            <div>
              <div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>结果表 ({resCount})</div>
              {info.result_tables.map((t, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '2px 4px', fontSize: 12, color: '#444',
                  background: i % 2 === 0 ? '#fafafa' : 'transparent', borderRadius: 3,
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{t.name}</span>
                  <span style={{ color: '#888', fontSize: 11 }}>{(t.row_count || 0).toLocaleString()} 行</span>
                </div>
              ))}
            </div>
          )}

          {totalCount === 0 && (
            <div style={{ fontSize: 14, color: '#999', textAlign: 'center', padding: 8 }}>
              当前无活跃内存表
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default React.memo(MemoryPanel)
