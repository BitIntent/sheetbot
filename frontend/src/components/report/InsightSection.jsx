import React from 'react'

export default function InsightSection({ insights }) {
  if (!insights) return null
  const diagnostics = insights?.diagnostics || {}
  const isFallback = diagnostics?.insight_source === 'fallback'
  const templateLabelMap = {
    overview: '经营概览',
    comparison: '对比分析',
    trend: '趋势深潜',
    ranking: '排行榜单',
    executive: '管理层摘要',
    anomaly: '异常诊断',
    segment: '客户分层',
    funnel: '漏斗转化',
  }
  const reasonLabel = diagnostics?.fallback_reason_label || '当前结果由稳健模式生成'
  const fallbackDetail = diagnostics?.fallback_detail
  const suggested = Array.isArray(diagnostics?.suggested_template_keys)
    ? diagnostics.suggested_template_keys.map((k) => templateLabelMap[k] || k)
    : []

  const handleSwitchTemplate = () => {
    window.dispatchEvent(new CustomEvent('report:view-action', { detail: { action: 'template' } }))
  }

  const handleRetryCurrent = () => {
    window.dispatchEvent(new CustomEvent('report:view-action', { detail: { action: 'generate' } }))
  }

  return (
    <div className="report-insight-section report-fade-in">
      {isFallback && (
        <div className="report-fallback-notice" role="status" aria-live="polite">
          <div className="report-fallback-title">本次解读已切换为稳健模式</div>
          <p className="report-fallback-reason">原因：{reasonLabel}</p>
          {fallbackDetail && <p className="report-fallback-detail">技术详情：{fallbackDetail}</p>}
          <p className="report-fallback-hint">
            {diagnostics?.retry_hint || '建议切换模板后重试，可获得更贴合场景的深度洞察。'}
            {suggested.length > 0 ? ` 推荐模板：${suggested.join('、')}` : ''}
          </p>
          <div className="report-fallback-actions">
            <button className="report-fallback-btn report-fallback-btn-primary" onClick={handleSwitchTemplate}>
              切换模板重试
            </button>
            <button className="report-fallback-btn" onClick={handleRetryCurrent}>
              当前模板重试
            </button>
          </div>
        </div>
      )}
      {insights.summary && (
        <div className="report-insight-summary">
          <h3>总体概述</h3>
          <p>{insights.summary}</p>
        </div>
      )}

      {insights.key_findings?.length > 0 && (
        <div className="report-insight-block">
          <h3>关键发现</h3>
          <ul className="report-insight-list">
            {insights.key_findings.map((f, i) => (
              <li key={i} className="report-insight-item report-finding">{f}</li>
            ))}
          </ul>
        </div>
      )}

      {insights.anomaly_warnings?.length > 0 && (
        <div className="report-insight-block">
          <h3>异常预警</h3>
          <ul className="report-insight-list">
            {insights.anomaly_warnings.map((w, i) => (
              <li key={i} className="report-insight-item report-finding">{w}</li>
            ))}
          </ul>
        </div>
      )}

      {insights.trend_forecast?.length > 0 && (
        <div className="report-insight-block">
          <h3>趋势预测</h3>
          <ul className="report-insight-list">
            {insights.trend_forecast.map((t, i) => (
              <li key={i} className="report-insight-item report-finding">{t}</li>
            ))}
          </ul>
        </div>
      )}

      {insights.detail_paragraphs?.length > 0 && (
        <div className="report-insight-details">
          {insights.detail_paragraphs.map((p, i) => (
            <div key={i} className="report-insight-paragraph">
              <h4>{p.title}</h4>
              <p>{p.content}</p>
            </div>
          ))}
        </div>
      )}

      {insights.recommendations?.length > 0 && (
        <div className="report-insight-block">
          <h3>行动建议</h3>
          <ul className="report-insight-list">
            {insights.recommendations.map((r, i) => (
              <li key={i} className="report-insight-item report-recommendation">{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
