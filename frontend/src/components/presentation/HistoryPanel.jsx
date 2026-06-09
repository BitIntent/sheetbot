// frontend/src/components/presentation/HistoryPanel.jsx
/**
 * ============================================================================
 * 历史汇报列表
 * ============================================================================
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Trash2, FolderOpen, RefreshCw } from 'lucide-react'
import { useConfig } from '../../contexts/ConfigContext'

export default function HistoryPanel({
  items,
  loading,
  onOpen,
  onDelete,
  onRefresh,
}) {
  const { formatInUserTimezone } = useConfig()
  const PAGE_SIZE = 10
  const [page, setPage] = useState(1)

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil((items?.length || 0) / PAGE_SIZE))
  }, [items])

  const pageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return (items || []).slice(start, start + PAGE_SIZE)
  }, [items, page])

  useEffect(() => {
    setPage(1)
  }, [items])

  return (
    <div className="pres-history-panel">
      <div className="pres-history-header">
        <h3 className="pres-history-title">
          历史汇报清单
          <button
            className="pres-history-refresh-link"
            onClick={onRefresh}
            disabled={loading}
            title={loading ? '刷新中' : '刷新'}
            aria-label={loading ? '刷新中' : '刷新'}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </h3>
      </div>

      {items.length === 0 && !loading && (
        <p className="pres-history-empty">暂无历史汇报</p>
      )}

      {items.length > 0 && (
        <div className="report-history-table-wrap">
          <table className="report-history-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>模板</th>
                <th>页数</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) => (
                <tr key={item.pptx_id}>
                  <td>
                    <button className="report-history-open-link" onClick={() => onOpen(item)}>
                      {item.title || '无标题'}
                    </button>
                  </td>
                  <td>{item.template_key}</td>
                  <td>{item.slide_count}</td>
                  <td>{formatInUserTimezone(item.created_at)}</td>
                  <td>
                    <div className="report-history-row-actions">
                      <button className="ui-history-action-btn ui-history-action-btn-open" onClick={() => onOpen(item)}>
                        <FolderOpen size={12} />
                        <span>打开</span>
                      </button>
                      <button className="ui-history-action-btn ui-history-action-btn-danger" onClick={() => onDelete(item.pptx_id)}>
                        <Trash2 size={12} />
                        <span>删除</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length > 0 && (
        <div className="report-history-pagination">
          <button
            className="report-history-page-btn"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            上一页
          </button>
          <span className="report-history-page-info">
            第 {page} / {totalPages} 页（共 {items.length} 条）
          </span>
          <button
            className="report-history-page-btn"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}
