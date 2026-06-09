import React, { useState } from 'react'
import { Loader2, RefreshCw, Download, Pencil, Trash2 } from 'lucide-react'
import { useConfig } from '../../contexts/ConfigContext'

const PAGE_SIZE = 10

export default function BatchWordHistoryPanel({
  items,
  loading,
  onRefresh,
  onEdit,
  onDelete,
  onDownload,
}) {
  const { formatInUserTimezone } = useConfig()
  const [page, setPage] = useState(1)
  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div className="form-history connect-history">
      <div className="fh-header">
        <span className="fh-title">
          历史转换清单
          <button
            className="fh-refresh-link"
            onClick={onRefresh}
            disabled={loading}
            title={loading ? '刷新中' : '刷新'}
            aria-label={loading ? '刷新中' : '刷新'}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </span>
      </div>

      {loading && !items.length ? (
        <div className="fh-loading"><Loader2 size={20} className="spin" /></div>
      ) : (
        <div className="report-history-table-wrap">
          <table className="report-history-table">
            <thead>
              <tr>
                <th>任务ID</th>
                <th>模板文件名</th>
                <th>生成数量</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {!slice.length ? (
                <tr><td colSpan={5} className="report-history-empty">暂无历史转换</td></tr>
              ) : slice.map((item) => (
                <tr key={item.task_id}>
                  <td>{item.task_id}</td>
                  <td>{item.template_file_name || '-'}</td>
                  <td>{item.total ?? 0}</td>
                  <td>{item.created_at ? formatInUserTimezone(item.created_at) : '-'}</td>
                  <td>
                    <div className="report-history-row-actions">
                      <button
                        className="ui-history-action-btn ui-history-action-btn-open"
                        onClick={() => onEdit(item)}
                        title="修改"
                      >
                        <Pencil size={12} />
                        <span>修改</span>
                      </button>
                      <button
                        className="ui-history-action-btn ui-history-action-btn-danger"
                        onClick={() => onDelete(item)}
                        title="删除"
                      >
                        <Trash2 size={12} />
                        <span>删除</span>
                      </button>
                      <button
                        className="ui-history-action-btn ui-history-action-btn-open"
                        onClick={() => onDownload(item.download_url)}
                        title="导出ZIP"
                      >
                        <Download size={12} />
                        <span>导出</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="report-history-pagination">
              <button
                className="report-history-page-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >上一页</button>
              <span className="report-history-page-info">{page} / {totalPages}</span>
              <button
                className="report-history-page-btn"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >下一页</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
