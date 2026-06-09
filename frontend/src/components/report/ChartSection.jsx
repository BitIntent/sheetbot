import React, { useRef, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'

function getChartInsights(chart) {
  const option = chart?.option || {}
  const series = Array.isArray(option.series) ? option.series : []
  if (!series.length) return ['图表已生成，可结合业务上下文进一步分析。']

  const titleText = option?.title?.text || chart?.title || '当前图表'
  const firstSeries = series[0] || {}
  const chartType = firstSeries.type || chart?.type || 'bar'
  const categoryAxis = option?.xAxis?.type === 'category'
    ? (option?.xAxis?.data || [])
    : (option?.yAxis?.type === 'category' ? (option?.yAxis?.data || []) : [])

  const parseValue = (item) => {
    if (typeof item === 'number') return item
    if (item && typeof item === 'object' && typeof item.value === 'number') return item.value
    return null
  }
  const parseName = (item, idx) => {
    if (item && typeof item === 'object' && item.name) return String(item.name)
    if (Array.isArray(categoryAxis) && categoryAxis[idx] != null) return String(categoryAxis[idx])
    return `第${idx + 1}项`
  }

  const points = (Array.isArray(firstSeries.data) ? firstSeries.data : [])
    .map((item, idx) => ({ name: parseName(item, idx), value: parseValue(item) }))
    .filter((p) => typeof p.value === 'number' && Number.isFinite(p.value))

  if (!points.length) {
    return [`${titleText} 暂无可计算数值，请先检查数据字段映射与聚合方式。`]
  }

  const values = points.map((p) => p.value)
  const total = values.reduce((sum, cur) => sum + cur, 0)
  const avg = total / values.length
  const maxPoint = points.reduce((a, b) => (a.value >= b.value ? a : b))
  const minPoint = points.reduce((a, b) => (a.value <= b.value ? a : b))
  const sorted = [...points].sort((a, b) => b.value - a.value)
  const top3 = sorted.slice(0, 3)
  const top3Ratio = total > 0 ? (top3.reduce((s, p) => s + p.value, 0) / total) * 100 : 0
  const std = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / values.length)
  const cv = avg === 0 ? 0 : std / Math.abs(avg)
  const delta = values[values.length - 1] - values[0]
  const deltaPct = values[0] === 0 ? 0 : (delta / Math.abs(values[0])) * 100

  const insights = []
  if (chartType === 'line') {
    const trendText = delta > 0 ? '上升' : delta < 0 ? '下降' : '平稳'
    insights.push(`${titleText} 整体呈${trendText}趋势：从 ${points[0].name} 到 ${points[points.length - 1].name} 变化 ${delta.toFixed(2)}（${deltaPct.toFixed(1)}%）。`)
    insights.push(`峰值出现在 ${maxPoint.name}（${maxPoint.value.toFixed(2)}），低点在 ${minPoint.name}（${minPoint.value.toFixed(2)}），建议结合该时段业务动作做复盘。`)
    insights.push(cv > 0.35
      ? '序列波动较大，建议在高波动区间补充异常预警与原因标注，降低经营不确定性。'
      : '序列波动可控，可作为稳定经营指标持续跟踪，并结合同比/环比观察变化质量。')
  } else if (chartType === 'pie') {
    insights.push(`${titleText} 头部项为 ${maxPoint.name}（${maxPoint.value.toFixed(2)}），占总体 ${(total > 0 ? (maxPoint.value / total) * 100 : 0).toFixed(1)}%。`)
    insights.push(`TOP3 项（${top3.map((p) => p.name).join('、')}）合计占比 ${top3Ratio.toFixed(1)}%，${top3Ratio > 70 ? '集中度较高，需关注结构性风险。' : '结构相对均衡，可继续优化长尾潜力。'}`)
    insights.push(`尾部项 ${minPoint.name} 占比偏低（${(total > 0 ? (minPoint.value / total) * 100 : 0).toFixed(1)}%），可评估是否需要专项提升策略。`)
  } else {
    insights.push(`${titleText} 中，${maxPoint.name} 贡献最高（${maxPoint.value.toFixed(2)}），${minPoint.name} 最低（${minPoint.value.toFixed(2)}）。`)
    insights.push(`TOP3 贡献占比 ${top3Ratio.toFixed(1)}%，${top3Ratio > 65 ? '头部驱动明显，建议控制对少数维度的依赖。' : '分布较均衡，适合进行精细化分层运营。'}`)
    insights.push(cv > 0.4
      ? '不同维度差异明显，建议优先定位高低表现差距背后的资源、策略或渠道因素。'
      : '维度间差距适中，可结合业务目标进一步识别增量突破点。')
  }

  if (series.length > 1) {
    insights.push(`当前图包含 ${series.length} 个指标系列，建议关注各系列在关键维度上的同向/背离变化，避免单指标决策偏差。`)
  }

  return insights.slice(0, 3)
}

function toLightOption(option) {
  const next = JSON.parse(JSON.stringify(option || {}))
  next.backgroundColor = '#FFFFFF'
  next.textStyle = { ...(next.textStyle || {}), color: '#000000' }
  if (next.title) next.title.textStyle = { ...(next.title.textStyle || {}), color: '#000000' }
  if (next.legend) next.legend.textStyle = { ...(next.legend.textStyle || {}), color: '#000000' }
  if (next.xAxis) {
    const xList = Array.isArray(next.xAxis) ? next.xAxis : [next.xAxis]
    xList.forEach((x) => {
      x.axisLabel = { ...(x.axisLabel || {}), color: '#000000' }
      x.axisLine = { ...(x.axisLine || {}), lineStyle: { ...((x.axisLine || {}).lineStyle || {}), color: '#9CA3AF' } }
      x.splitLine = { ...(x.splitLine || {}), lineStyle: { ...((x.splitLine || {}).lineStyle || {}), color: '#E5E7EB' } }
    })
  }
  if (next.yAxis) {
    const yList = Array.isArray(next.yAxis) ? next.yAxis : [next.yAxis]
    yList.forEach((y) => {
      y.axisLabel = { ...(y.axisLabel || {}), color: '#000000' }
      y.axisLine = { ...(y.axisLine || {}), lineStyle: { ...((y.axisLine || {}).lineStyle || {}), color: '#9CA3AF' } }
      y.splitLine = { ...(y.splitLine || {}), lineStyle: { ...((y.splitLine || {}).lineStyle || {}), color: '#E5E7EB' } }
    })
  }
  if (next.tooltip) {
    next.tooltip = {
      ...next.tooltip,
      backgroundColor: '#FFFFFF',
      borderColor: '#D1D5DB',
      textStyle: { ...(next.tooltip.textStyle || {}), color: '#000000' },
    }
  }
  return next
}

const TALL_CHART_TYPES = new Set(['heatmap', 'radar', 'treemap', 'funnel'])

function getChartHeight(chart, exportMode = 'screen') {
  const t = chart?.type || ''
  if (exportMode === 'pdf') {
    if (TALL_CHART_TYPES.has(t)) return '500px'
    if (t === 'gauge') return '360px'
    return '420px'
  }
  if (TALL_CHART_TYPES.has(t)) return '440px'
  if (t === 'gauge') return '320px'
  return '380px'
}

export default function ChartSection({ chart, index = 0, exportTheme = 'dark', exportMode = 'screen' }) {
  const [visible, setVisible] = useState(false)
  const ref = useRef(null)
  const forceVisible = exportTheme === 'light'

  useEffect(() => {
    if (forceVisible) {
      setVisible(true)
      return
    }
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect() } },
      { threshold: 0.15 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [forceVisible])

  if (!chart || !chart.option) return null
  const insights = Array.isArray(chart?.insights) && chart.insights.length > 0
    ? chart.insights
    : getChartInsights(chart)
  const finalOption = useMemo(
    () => (exportTheme === 'light' ? toLightOption(chart.option) : chart.option),
    [chart.option, exportTheme]
  )

  const renderedVisible = forceVisible || visible
  const chartHeight = getChartHeight(chart, exportMode)

  return (
    <div
      ref={ref}
      className={`report-chart-section report-export-block ${renderedVisible ? 'report-fade-in' : 'report-hidden'} ${forceVisible ? 'report-export-static' : ''}`}
      data-export-block="true"
      data-export-kind="chart"
      style={forceVisible ? undefined : { animationDelay: `${index * 150}ms` }}
    >
      <ReactECharts
        option={finalOption}
        style={{ height: chartHeight, width: '100%' }}
        opts={{ renderer: 'canvas' }}
        notMerge={true}
        lazyUpdate={true}
      />
      <div className="report-chart-insights">
        {insights.map((text, idx) => (
          <p key={idx} className="report-chart-insight-item">- {text}</p>
        ))}
      </div>
    </div>
  )
}
