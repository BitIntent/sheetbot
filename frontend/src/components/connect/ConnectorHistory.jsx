// ============================================================================
// 连接器历史列表 - 复用 report-history-table 样式
// ============================================================================
import React, { useState } from 'react'
import { Loader2, Trash2, RefreshCw, FolderOpen } from 'lucide-react'
import { useConfig } from '../../contexts/ConfigContext'

const PAGE_SIZE = 10

const TYPE_LABELS = {
  shopify: 'Shopify',
  dingtalk: '钉钉',
  wecom: '企业微信',
  database: '数据库',
  webhook: 'Webhook',
  custom_api: '自定义 API',
}

const STATUS_CLS = {
  active: 'active',
  paused: 'draft',
  error: 'closed',
}

export default function ConnectorHistory({ connectors, loading, onOpen, onDelete, onRefresh }) {
  const { formatInUserTimezone } = useConfig()
  const [page, setPage] = useState(1)
  const total = connectors.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const slice = connectors.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div className="form-history connect-history">
      <div className="fh-header">
        <span className="fh-title">
          历史连接器
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

      {loading && !connectors.length ? (
        <div className="fh-loading"><Loader2 size={20} className="spin" /></div>
      ) : (
        <div className="report-history-table-wrap">
          <table className="report-history-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>状态</th>
                <th>上次同步</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {!slice.length ? (
                <tr><td colSpan={5} className="report-history-empty">暂无连接器</td></tr>
              ) : slice.map(c => (
                <tr key={c.id}>
                  <td>
                    <button className="report-history-open-link" onClick={() => onOpen(c)}>
                      {c.name || '未命名'}
                    </button>
                  </td>
                  <td>{TYPE_LABELS[c.type] || c.type}</td>
                  <td>
                    <span className={`fh-status ${STATUS_CLS[c.status] || ''}`}>
                      {c.status === 'active' ? '运行中' : c.status === 'paused' ? '已暂停' : '异常'}
                    </span>
                  </td>
                  <td>{c.last_sync_at ? formatInUserTimezone(c.last_sync_at) : '-'}</td>
                  <td>
                    <div className="report-history-row-actions">
                      <button
                        className="ui-history-action-btn ui-history-action-btn-open"
                        onClick={() => onOpen(c)}
                        title="打开"
                      >
                        <FolderOpen size={12} />
                        <span>打开</span>
                      </button>
                      <button
                        className="ui-history-action-btn ui-history-action-btn-danger"
                        onClick={() => onDelete(c.id)}
                        title="删除"
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
          {totalPages > 1 && (
            <div className="report-history-pagination">
              <button
                className="report-history-page-btn"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >上一页</button>
              <span className="report-history-page-info">{page} / {totalPages}</span>
              <button
                className="report-history-page-btn"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
              >下一页</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
