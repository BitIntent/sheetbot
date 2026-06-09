// ============================================================================
// 历史表单列表
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Trash2, Loader2, RefreshCw, Pencil } from 'lucide-react'
import { useConfig } from '../../contexts/ConfigContext'

export default function FormHistoryPanel({ forms, loading, onOpen, onEdit, onDelete, onRefresh }) {
  const { formatInUserTimezone } = useConfig()
  const PAGE_SIZE = 10
  const [page, setPage] = useState(1)

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil((forms?.length || 0) / PAGE_SIZE))
  }, [forms])

  const pageForms = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return (forms || []).slice(start, start + PAGE_SIZE)
  }, [forms, page])

  useEffect(() => {
    setPage(1)
  }, [forms])

  if (!forms.length && !loading) return null

  return (
    <div className="form-history">
      <div className="report-history-header">
        <h3>
          历史表单清单
          <button
            className="fh-refresh-link"
            onClick={onRefresh}
            disabled={loading}
            title={loading ? '刷新中' : '刷新'}
            aria-label={loading ? '刷新中' : '刷新'}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </h3>
      </div>
      {loading && !forms.length ? (
        <div className="fh-loading"><Loader2 size={20} className="spin" /></div>
      ) : (
        <div className="report-history-table-wrap">
          <table className="report-history-table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>提交数</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {forms.length === 0 ? (
                <tr>
                  <td colSpan={5} className="report-history-empty">
                    {loading ? '加载中...' : '暂无历史表单'}
                  </td>
                </tr>
              ) : pageForms.map((form) => (
                <tr key={form.id}>
                  <td>
                    <button
                      className="report-history-open-link"
                      onClick={() => onOpen(form)}
                      title="打开表单"
                    >
                      {form.title}
                    </button>
                  </td>
                  <td>
                    <span className={`fh-status ${form.status}`}>
                      {form.status === 'active' ? '收集中' : form.status === 'closed' ? '已关闭' : '草稿'}
                    </span>
                  </td>
                  <td>{form.submission_count || 0} 条</td>
                  <td>{formatInUserTimezone(form.created_at, { year: 'numeric', month: '2-digit', day: '2-digit' })}</td>
                  <td>
                    <div className="report-history-row-actions">
                      <button
                        className="ui-history-action-btn ui-history-action-btn-open"
                        onClick={() => onOpen(form)}
                      >
                        <FolderOpen size={12} />
                        <span>打开</span>
                      </button>
                      <button
                        className="ui-history-action-btn ui-history-action-btn-edit"
                        onClick={() => onEdit?.(form)}
                      >
                        <Pencil size={12} />
                        <span>修改</span>
                      </button>
                      <button
                        className="ui-history-action-btn ui-history-action-btn-danger"
                        onClick={() => onDelete(form.id)}
                      >
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
      {forms.length > 0 && (
        <div className="report-history-pagination">
          <button
            className="report-history-page-btn"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            上一页
          </button>
          <span className="report-history-page-info">
            第 {page} / {totalPages} 页（共 {forms.length} 条）
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
