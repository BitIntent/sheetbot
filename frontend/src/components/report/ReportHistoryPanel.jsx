import React, { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useConfig } from '../../contexts/ConfigContext'

export default function ReportHistoryPanel({
  reports = [],
  loading = false,
  actionLoading = '',
  onRefresh,
  onOpenReport,
  onDeleteReport,
}) {
  const { formatInUserTimezone } = useConfig()
  const PAGE_SIZE = 10
  const [page, setPage] = useState(1)

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil((reports?.length || 0) / PAGE_SIZE))
  }, [reports])

  const pageReports = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return (reports || []).slice(start, start + PAGE_SIZE)
  }, [reports, page])

  useEffect(() => {
    setPage(1)
  }, [reports])

  return (
    <div className="report-history-panel">
      <div className="report-history-header">
        <h3>
          历史报表清单
          <button
            className="report-history-refresh-link"
            onClick={onRefresh}
            disabled={loading}
            title={loading ? '刷新中' : '刷新'}
            aria-label={loading ? '刷新中' : '刷新'}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </h3>
      </div>
      <div className="report-history-table-wrap">
        <table className="report-history-table">
          <thead>
            <tr>
              <th>标题</th>
              <th>模板</th>
              <th>浏览量</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {reports.length === 0 ? (
              <tr>
                <td colSpan={5} className="report-history-empty">
                  {loading ? '加载中...' : '暂无历史报表'}
                </td>
              </tr>
            ) : pageReports.map((item) => {
              const reportId = item.report_id
              const openLoading = actionLoading === `open:${reportId}`
              const deleteLoading = actionLoading === `delete:${reportId}`
              return (
                <tr key={reportId}>
                  <td>
                    <button
                      className="report-history-open-link"
                      onClick={() => onOpenReport(reportId)}
                      disabled={!!actionLoading}
                      title="打开报表"
                    >
                      {item.title || '未命名报表'}
                    </button>
                  </td>
                  <td>{item.template_key || '--'}</td>
                  <td>{item.view_count ?? 0}</td>
                  <td>{formatInUserTimezone(item.created_at)}</td>
                  <td>
                    <div className="report-history-row-actions">
                      <button
                        className="report-history-row-btn ui-history-action-btn ui-history-action-btn-open"
                        onClick={() => onOpenReport(reportId)}
                        disabled={!!actionLoading}
                      >
                        {openLoading ? '打开中...' : '打开'}
                      </button>
                      <button
                        className="report-history-row-btn danger ui-history-action-btn ui-history-action-btn-danger"
                        onClick={() => onDeleteReport(reportId)}
                        disabled={!!actionLoading}
                      >
                        {deleteLoading ? '删除中...' : '删除'}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {reports.length > 0 && (
        <div className="report-history-pagination">
          <button
            className="report-history-page-btn"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            上一页
          </button>
          <span className="report-history-page-info">
            第 {page} / {totalPages} 页（共 {reports.length} 条）
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
