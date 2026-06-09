// ============================================================================
// 连接器详情 - 状态/手动同步/日志
// ============================================================================
import React, { useState, useEffect, useCallback } from 'react'
import {
  Play, Pause, RefreshCw, Loader2, CheckCircle, XCircle, Clock,
  Copy, ExternalLink,
} from 'lucide-react'
import FieldMappingPanel from './FieldMappingPanel'
import { useConfig } from '../../contexts/ConfigContext'

const STATUS_MAP = {
  active: { label: '运行中', cls: 'active' },
  paused: { label: '已暂停', cls: 'paused' },
  error: { label: '异常', cls: 'error' },
}

const JOB_STATUS_ICON = {
  success: <CheckCircle size={14} style={{ color: '#22c55e' }} />,
  error: <XCircle size={14} style={{ color: '#ef4444' }} />,
  running: <Loader2 size={14} className="spin" />,
}

export default function ConnectorDetail({
  connector,
  columns,
  onToggleStatus,
  onSync,
  onUpdateMapping,
  onEdit,
  onBack,
  authedFetch,
  apiBase,
}) {
  const { formatInUserTimezone } = useConfig()
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [jobs, setJobs] = useState([])
  const [jobsPage, setJobsPage] = useState(1)
  const [jobsTotal, setJobsTotal] = useState(0)

  const status = STATUS_MAP[connector.status] || STATUS_MAP.paused

  // ── 加载同步历史 ─────────────────────────────────────
  const loadJobs = useCallback(async () => {
    try {
      const res = await authedFetch(
        `${apiBase}/api/connect/connectors/${connector.id}/jobs?page=${jobsPage}&page_size=5`
      )
      if (res.ok) {
        const data = await res.json()
        setJobs(data.items || [])
        setJobsTotal(data.total || 0)
      }
    } catch (e) {
      console.warn('[ConnectorDetail] 加载同步历史失败', e)
    }
  }, [authedFetch, apiBase, connector.id, jobsPage])

  useEffect(() => { loadJobs() }, [loadJobs])

  // ── 手动同步 ─────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true)
    setSyncMsg('')
    try {
      const result = await onSync(connector.id)
      setSyncMsg(result?.message || '同步完成')
      loadJobs()
    } catch (e) {
      setSyncMsg(`同步失败: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  // ── Webhook URL ──────────────────────────────────────
  const webhookUrl = connector.type === 'webhook'
    ? `${window.location.origin}/api/webhook/${connector.config?.endpoint_token || ''}`
    : null

  const copyWebhookUrl = () => {
    if (webhookUrl) navigator.clipboard?.writeText(webhookUrl)
  }

  const totalJobPages = Math.max(1, Math.ceil(jobsTotal / 5))

  return (
    <div className="connect-detail">
      {/* 头部 */}
      <div className="connect-detail-header">
        <div className="connect-detail-title-row">
          <h3 className="connect-detail-title">{connector.name}</h3>
          <span className={`connect-detail-status ${status.cls}`}>{status.label}</span>
        </div>
        <div className="connect-detail-actions">
          {connector.status === 'active' ? (
            <button className="collect-btn-ghost" onClick={() => onToggleStatus(connector.id, 'paused')}>
              <Pause size={14} /> 暂停
            </button>
          ) : (
            <button className="collect-btn-ghost" onClick={() => onToggleStatus(connector.id, 'active')}>
              <Play size={14} /> 启用
            </button>
          )}
          <button className="collect-btn-ghost" onClick={handleSync} disabled={syncing}>
            {syncing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            手动同步
          </button>
          <button className="collect-btn-ghost" onClick={() => onEdit(connector)}>编辑配置</button>
          <button className="collect-btn-ghost" onClick={onBack}>返回列表</button>
        </div>
      </div>

      {syncMsg && <p className="connect-sync-msg">{syncMsg}</p>}

      {/* Webhook URL */}
      {webhookUrl && (
        <div className="connect-webhook-url-section">
          <label className="connect-config-label">Webhook 推送地址</label>
          <div className="connect-webhook-url-row">
            <input className="connect-config-input" value={webhookUrl} readOnly />
            <button className="collect-btn-ghost" onClick={copyWebhookUrl} title="复制">
              <Copy size={14} />
            </button>
          </div>
          <span className="connect-config-hint">将此地址配置到外部系统，数据推送后将自动同步到表格</span>
        </div>
      )}

      {/* 基本信息 */}
      <div className="connect-detail-info">
        <div className="connect-detail-info-item">
          <span className="connect-detail-info-label">同步频率</span>
          <span>{connector.sync_interval ? `每 ${connector.sync_interval} 分钟` : '仅手动'}</span>
        </div>
        <div className="connect-detail-info-item">
          <span className="connect-detail-info-label">上次同步</span>
          <span>{connector.last_sync_at ? formatInUserTimezone(connector.last_sync_at) : '-'}</span>
        </div>
        <div className="connect-detail-info-item">
          <span className="connect-detail-info-label">同步结果</span>
          <span>{connector.last_sync_message || '-'}</span>
        </div>
      </div>

      {/* 字段映射 */}
      <FieldMappingPanel
        mapping={connector.field_mapping || {}}
        availableFields={[]}
        columns={columns}
        onChange={(m) => onUpdateMapping(connector.id, m)}
      />

      {/* 同步历史 */}
      <div className="connect-jobs-section">
        <h4 className="connect-jobs-title">同步历史</h4>
        <div className="report-history-table-wrap">
          <table className="report-history-table">
            <thead>
              <tr>
                <th>状态</th>
                <th>同步行数</th>
                <th>开始时间</th>
                <th>完成时间</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length ? (
                <tr><td colSpan={5} className="report-history-empty">暂无同步记录</td></tr>
              ) : jobs.map(j => (
                <tr key={j.id}>
                  <td>{JOB_STATUS_ICON[j.status] || j.status}</td>
                  <td>{j.rows_synced}</td>
                  <td>{formatInUserTimezone(j.started_at)}</td>
                  <td>{j.completed_at ? formatInUserTimezone(j.completed_at) : '-'}</td>
                  <td className="connect-job-error">{j.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalJobPages > 1 && (
            <div className="report-history-pagination">
              <button
                className="report-history-page-btn"
                disabled={jobsPage <= 1}
                onClick={() => setJobsPage(p => p - 1)}
              >上一页</button>
              <span className="report-history-page-info">{jobsPage} / {totalJobPages}</span>
              <button
                className="report-history-page-btn"
                disabled={jobsPage >= totalJobPages}
                onClick={() => setJobsPage(p => p + 1)}
              >下一页</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
