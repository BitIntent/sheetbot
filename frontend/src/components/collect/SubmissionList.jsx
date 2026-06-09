// ============================================================================
// 提交数据列表 - 分页表格 + 同步按钮
// ============================================================================
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw, Download, Loader2 } from 'lucide-react'
import { useConfig } from '../../contexts/ConfigContext'
import { useAuthedFetch } from '../../hooks/useAuthedFetch'
import { getCollectApiBase } from './collectApi'

export default function SubmissionList({ formId, formConfig, onSync }) {
  const authedFetch = useAuthedFetch()
  const { formatInUserTimezone } = useConfig()
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const pageSize = 15

  const fieldLabels = useMemo(() => {
    const config = formConfig || {}
    return (config.fields || []).map(f => ({ key: f.key, label: f.label }))
  }, [formConfig])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authedFetch(
        `${getCollectApiBase()}/api/collect/forms/${formId}/submissions?page=${page}&page_size=${pageSize}`,
      )
      if (res.ok) {
        const data = await res.json()
        setItems(data.items || [])
        setTotal(data.total || 0)
      }
    } catch (e) {
      console.warn('[SubmissionList] 加载失败', e)
    } finally {
      setLoading(false)
    }
  }, [authedFetch, formId, page])

  useEffect(() => { loadData() }, [loadData])

  // 定时轮询（每 15s）
  useEffect(() => {
    const timer = setInterval(loadData, 15000)
    return () => clearInterval(timer)
  }, [loadData])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const count = await onSync?.()
      if (count > 0) loadData()
    } finally {
      setSyncing(false)
    }
  }

  const totalPages = Math.ceil(total / pageSize) || 1

  return (
    <div className="submission-list">
      <div className="sl-header">
        <h4 className="sl-title">
          提交数据
          <span className="sl-count">({total} 条)</span>
        </h4>
        <div className="sl-actions">
          <button className="collect-btn-ghost sl-btn" onClick={loadData} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            <span>刷新</span>
          </button>
          <button className="collect-btn-primary sl-btn" onClick={handleSync} disabled={syncing}>
            {syncing ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            <span>同步到工作表</span>
          </button>
        </div>
      </div>

      {items.length === 0 && !loading ? (
        <div className="sl-empty">暂无提交数据</div>
      ) : (
        <div className="sl-table-wrap">
          <table className="sl-table">
            <thead>
              <tr>
                <th>#</th>
                {fieldLabels.map(f => <th key={f.key}>{f.label}</th>)}
                <th>提交时间</th>
                <th>已同步</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.id}>
                  <td>{(page - 1) * pageSize + idx + 1}</td>
                  {fieldLabels.map(f => (
                    <td key={f.key}>{item.data?.[f.key] ?? ''}</td>
                  ))}
                  <td>{formatInUserTimezone(item.submitted_at)}</td>
                  <td>
                    <span className={`sl-sync-badge ${item.synced ? 'synced' : 'pending'}`}>
                      {item.synced ? '已同步' : '待同步'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="sl-pagination">
          <button
            className="sl-page-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            上一页
          </button>
          <span className="sl-page-info">
            {page} / {totalPages}
          </span>
          <button
            className="sl-page-btn"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}
