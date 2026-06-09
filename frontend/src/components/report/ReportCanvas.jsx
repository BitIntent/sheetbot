import React, { forwardRef } from 'react'
import KPICard from './KPICard'
import ChartSection from './ChartSection'
import InsightSection from './InsightSection'
import DataTable from './DataTable'
import { useConfig } from '../../contexts/ConfigContext'

const ReportCanvas = forwardRef(function ReportCanvas({ report, exportTheme = 'dark', exportMode = 'screen' }, ref) {
  if (!report) return null

  const { formatInUserTimezone } = useConfig()
  const { title, template_name, kpis, charts, insights, data_table, created_at, domain_context } = report
  const domainLabelMap = {
    retail: '零售/电商',
    manufacturing: '制造/供应链',
    finance: '财务/经营',
    general: '通用业务',
  }
  const domainLabel = domainLabelMap[domain_context?.domain] || domain_context?.domain || null
  const confidencePercent = Number.isFinite(Number(domain_context?.confidence))
    ? Math.round(Number(domain_context.confidence) * 100)
    : null
  const evidenceKeywords = Array.isArray(domain_context?.evidence_keywords)
    ? domain_context.evidence_keywords.slice(0, 6)
    : []

  return (
    <div
      className={`report-canvas ${exportTheme === 'light' ? 'report-canvas-export-light' : ''} ${exportMode === 'pdf' ? 'report-canvas-export-pdf' : ''}`}
      ref={ref}
    >
      {/* 报表头部 */}
      <div className="report-canvas-header report-export-block" data-export-block="true" data-export-kind="header">
        <h1 className="report-canvas-title">{title || '数据分析报表'}</h1>
        <div className="report-canvas-meta">
          <span className="report-canvas-template">{template_name}</span>
          {created_at && (
            <span className="report-canvas-date">
              {formatInUserTimezone(created_at, { year: 'numeric', month: 'long', day: 'numeric' })}
            </span>
          )}
        </div>
        {domainLabel && (
          <div className="report-domain-context">
            <span className="report-domain-chip">
              识别行业：{domainLabel}
              {confidencePercent !== null ? `（置信度 ${confidencePercent}%）` : ''}
            </span>
            {evidenceKeywords.length > 0 && (
              <span className="report-domain-evidence">
                关键词：{evidenceKeywords.join('、')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* KPI 卡片区 */}
      {kpis?.length > 0 && (
        <section className="report-section report-section-kpis report-export-block" data-export-block="true" data-export-kind="kpis">
          <div className="report-kpi-grid">
            {kpis.slice(0, 8).map((kpi, i) => (
              <KPICard
                key={i}
                label={kpi.label}
                value={kpi.value}
                unit={kpi.unit}
                index={i}
                exportTheme={exportTheme}
              />
            ))}
          </div>
        </section>
      )}

      {/* 图表区 */}
      {charts?.length > 0 && (
        <section className="report-section report-section-charts">
          <div className="report-charts-grid">
            {charts.map((chart, i) => (
              <ChartSection key={i} chart={chart} index={i} exportTheme={exportTheme} exportMode={exportMode} />
            ))}
          </div>
        </section>
      )}

      {/* AI 洞察区 */}
      {insights && (
        <section className="report-section report-section-insights report-export-block" data-export-block="true" data-export-kind="insights">
          <InsightSection insights={insights} />
        </section>
      )}

      {/* 明细数据 */}
      {data_table?.rows?.length > 0 && (
        <section className="report-section report-section-table report-export-block" data-export-block="true" data-export-kind="table">
          <DataTable
            headers={data_table.headers}
            rows={data_table.rows}
            title="数据明细"
          />
        </section>
      )}

      {/* 页脚 */}
      <div className="report-canvas-footer report-export-block" data-export-block="true" data-export-kind="footer">
        <span>由 SheetBot AI 自动生成</span>
      </div>
    </div>
  )
})

export default ReportCanvas
