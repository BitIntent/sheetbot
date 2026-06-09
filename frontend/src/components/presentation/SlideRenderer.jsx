// frontend/src/components/presentation/SlideRenderer.jsx
/**
 * ============================================================================
 * 幻灯片渲染器 — 将 Slide JSON 渲染为 HTML/CSS
 * 支持 mini（缩略图）和 full（主视图）两种模式
 * 根据 layout 类型分派不同渲染逻辑
 * ============================================================================
 */
import React from 'react'
import appConfig from '../../config/appConfig'
function toHex(color, fallback) {
  if (!color) return fallback
  return color.startsWith('#') ? color : `#${color}`
}

function withApiBase(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  const configured = appConfig.apiBaseUrl || ''
  const base = configured ? configured.replace(/\/$/, '') : ''
  return `${base}${path}`
}

function getTheme(templateKey, templateMetaByKey = {}) {
  const tpl = templateMetaByKey?.[templateKey] || {}
  const colors = tpl?.colors || {}
  return {
    bg: [toHex(colors.bg_start, '#0D1F3C'), toHex(colors.bg_end, '#1B3A6B')],
    text: toHex(colors.text_light, '#FFFFFF'),
    accent: toHex(colors.accent, '#4ECDC4'),
    muted: toHex(colors.text_muted, '#8EACC8'),
    card: toHex(colors.card_bg, '#163058'),
    coverUrl: withApiBase(tpl?.cover_url || `/api/pptx/template-cover/${encodeURIComponent(templateKey || 'business_blue')}`),
  }
}

function SlideStockImage({ slide, mini = false }) {
  const src = slide?.image_data_url
  if (!src || mini) return null
  return (
    <div className="pres-slide-stock-image-wrap">
      <img src={src} alt="stock" className="pres-slide-stock-image" />
    </div>
  )
}

// ── 封面页 ──────────────────────────────────────────────
function CoverSlide({ slide, colors }) {
  return (
    <div className="pres-slide-content pres-slide-cover">
      <div className="pres-cover-center">
        <h1 className="pres-cover-title" style={{ color: colors.accent }}>{slide.title}</h1>
        {slide.subtitle && (
          <p className="pres-cover-subtitle" style={{ color: colors.muted }}>{slide.subtitle}</p>
        )}
      </div>
      <div className="pres-cover-accent-line" style={{ background: colors.accent }} />
    </div>
  )
}

// ── 目录页 ──────────────────────────────────────────────
function TocSlide({ slide, colors }) {
  return (
    <div className="pres-slide-content pres-slide-toc">
      <h2 className="pres-slide-heading" style={{ color: colors.accent }}>{slide.title || '目录'}</h2>
      <ul className="pres-toc-list">
        {(slide.bullets || []).map((item, i) => (
          <li key={i} className="pres-toc-item" style={{ color: colors.text }}>
            <span className="pres-toc-number" style={{ color: colors.accent }}>{String(i + 1).padStart(2, '0')}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── KPI 页 ──────────────────────────────────────────────
function KpiSlide({ slide, colors }) {
  const kpis = slide.kpis || []
  return (
    <div className="pres-slide-content pres-slide-kpi">
      <h2 className="pres-slide-heading" style={{ color: colors.accent }}>{slide.title}</h2>
      <div className="pres-kpi-grid">
        {kpis.map((kpi, i) => (
          <div key={i} className="pres-kpi-card" style={{ background: colors.card }}>
            <div className="pres-kpi-label" style={{ color: colors.muted }}>{kpi.label}</div>
            <div className="pres-kpi-value" style={{ color: colors.accent }}>{kpi.value || '--'}</div>
            {kpi.unit && <div className="pres-kpi-unit" style={{ color: colors.muted }}>{kpi.unit}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 图表页 ──────────────────────────────────────────────
function ChartSlide({ slide, colors }) {
  const chart = slide.chart || {}
  const rows = Array.isArray(chart.data) ? chart.data : []
  const hasChartData = rows.length > 0
  const chartImageUrl = chart.image_data_url

  const renderSimpleChart = () => {
    const xField = chart.x_field
    const yField = chart.y_field
    if (!xField || !yField) return null

    const labels = []
    const values = []
    for (const row of rows.slice(0, 12)) {
      if (!row || row[xField] == null || row[yField] == null) continue
      const num = Number(row[yField])
      if (!Number.isFinite(num)) continue
      labels.push(String(row[xField]))
      values.push(num)
    }
    if (!values.length) return null

    const max = Math.max(...values, 1)
    const min = Math.min(...values, 0)
    const range = Math.max(max - min, 1)

    if (chart.chart_type === 'line') {
      const points = values.map((v, i) => {
        const x = (i / Math.max(values.length - 1, 1)) * 100
        const y = 90 - ((v - min) / range) * 70
        return `${x},${y}`
      }).join(' ')
      return (
        <svg viewBox="0 0 100 100" className="pres-chart-mini-svg">
          <polyline points={points} fill="none" stroke={colors.accent} strokeWidth="2.4" />
        </svg>
      )
    }

    return (
      <svg viewBox="0 0 100 100" className="pres-chart-mini-svg">
        {values.map((v, i) => {
          const width = 80 / values.length
          const h = ((v - min) / range) * 70
          const x = 10 + i * width
          const y = 90 - h
          return (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={Math.max(width - 1.2, 2)}
              height={Math.max(h, 2)}
              fill={colors.accent}
              opacity="0.9"
              rx="0.6"
            />
          )
        })}
      </svg>
    )
  }

  return (
    <div className="pres-slide-content pres-slide-chart">
      <h2 className="pres-slide-heading" style={{ color: colors.accent }}>{slide.title}</h2>
      {chartImageUrl ? (
        <div className="pres-chart-placeholder" style={{ borderColor: colors.accent }}>
          <img
            src={chartImageUrl}
            alt={chart.title || 'chart'}
            className="pres-chart-preview-img"
          />
        </div>
      ) : hasChartData ? (
        <div className="pres-chart-placeholder" style={{ borderColor: colors.accent }}>
          {renderSimpleChart() || (
            <span style={{ color: colors.muted }}>
              {chart.chart_type ? `${chart.chart_type} - ${chart.title || ''}` : '图表区域'}
            </span>
          )}
        </div>
      ) : (
        <div className="pres-chart-placeholder" style={{ borderColor: colors.accent }}>
          <span style={{ color: colors.muted }}>
            {chart.chart_type ? `${chart.chart_type} - ${chart.title || ''}` : '图表区域'}
          </span>
        </div>
      )}
      {slide.bullets?.length > 0 && (
        <ul className="pres-slide-bullets">
          {slide.bullets.map((b, i) => (
            <li key={i} style={{ color: colors.text }}>{b}</li>
          ))}
        </ul>
      )}
      <SlideStockImage slide={slide} />
    </div>
  )
}

// ── 表格页 ──────────────────────────────────────────────
function TableSlide({ slide, colors }) {
  const table = slide.table || {}
  const cols = table.columns || []
  const rows = table.rows || []
  return (
    <div className="pres-slide-content pres-slide-table">
      <h2 className="pres-slide-heading" style={{ color: colors.accent }}>{slide.title}</h2>
      {cols.length > 0 ? (
        <div className="pres-table-wrap">
          <table className="pres-data-table">
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th key={i} style={{ background: colors.card, color: colors.accent }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 10).map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ color: colors.text }}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pres-chart-placeholder" style={{ borderColor: colors.accent }}>
          <span style={{ color: colors.muted }}>数据表格区域</span>
        </div>
      )}
      <SlideStockImage slide={slide} />
    </div>
  )
}

// ── 总结页 ──────────────────────────────────────────────
function SummarySlide({ slide, colors }) {
  return (
    <div className="pres-slide-content pres-slide-summary">
      <h2 className="pres-slide-heading" style={{ color: colors.accent }}>{slide.title || '总结与建议'}</h2>
      <ul className="pres-summary-list">
        {(slide.bullets || []).map((b, i) => (
          <li key={i} style={{ color: colors.text }}>
            <span className="pres-summary-bullet" style={{ background: colors.accent }} />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <SlideStockImage slide={slide} />
    </div>
  )
}

// ── 通用内容页 ──────────────────────────────────────────
function ContentSlide({ slide, colors }) {
  return (
    <div className="pres-slide-content pres-slide-generic">
      <h2 className="pres-slide-heading" style={{ color: colors.accent }}>{slide.title}</h2>
      {slide.subtitle && (
        <p className="pres-slide-subtitle" style={{ color: colors.muted }}>{slide.subtitle}</p>
      )}
      {slide.bullets?.length > 0 && (
        <ul className="pres-slide-bullets">
          {slide.bullets.map((b, i) => (
            <li key={i} style={{ color: colors.text }}>{b}</li>
          ))}
        </ul>
      )}
      <SlideStockImage slide={slide} />
    </div>
  )
}

// ── 渲染分派 ────────────────────────────────────────────
const LAYOUT_MAP = {
  cover: CoverSlide,
  toc: TocSlide,
  kpi: KpiSlide,
  chart: ChartSlide,
  table: TableSlide,
  summary: SummarySlide,
  content: ContentSlide,
}

export default function SlideRenderer({ slide, templateKey, templateMetaByKey, mini = false }) {
  if (!slide) return null

  const colors = getTheme(templateKey, templateMetaByKey)
  const Comp = LAYOUT_MAP[slide.layout] || ContentSlide
  const coverUrl = colors.coverUrl
  const isCover = slide.layout === 'cover'

  return (
    <div
      className={`pres-slide ${mini ? 'pres-slide-mini' : ''}`}
      style={{
        background: isCover
          ? `url("${coverUrl}") center/cover no-repeat, linear-gradient(135deg, ${colors.bg[0]}, ${colors.bg[1]})`
          : `linear-gradient(135deg, ${colors.bg[0]}, ${colors.bg[1]})`,
      }}
    >
      <Comp slide={slide} colors={colors} />
    </div>
  )
}
