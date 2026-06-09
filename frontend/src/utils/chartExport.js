// ================================================================
// 图表导出：复用在线 ECharts option，保证导出与在线视觉一致
// ================================================================
import { buildEchartsOption } from '../univer/chartEchartsBuilder'

let _echarts = null

async function getEcharts() {
  if (_echarts) return _echarts
  const mod = await import('echarts')
  _echarts = mod
  return _echarts
}

// ==================== 导出专用样式放大 ====================
// 导出图片分辨率 2x，字号等比放大，保证 Excel 中清晰可读

function scaleOptionForExport(option) {
  if (option.title) {
    option.title = {
      ...option.title,
      textStyle: {
        ...(option.title.textStyle || {}),
        fontSize: 26,
        fontWeight: 600,
      },
    }
  }
  if (option.legend) {
    option.legend = {
      ...option.legend,
      textStyle: { ...(option.legend.textStyle || {}), fontSize: 22 },
      itemWidth: 24,
      itemHeight: 16,
    }
  }
  const scaleAxisLabel = (axes) => {
    if (!axes) return axes
    const arr = Array.isArray(axes) ? axes : [axes]
    arr.forEach(a => {
      a.axisLabel = { ...(a.axisLabel || {}), fontSize: 20 }
      if (a.nameTextStyle) a.nameTextStyle = { ...a.nameTextStyle, fontSize: 20 }
    })
    return arr.length === 1 ? arr[0] : arr
  }
  if (option.xAxis) option.xAxis = scaleAxisLabel(option.xAxis)
  if (option.yAxis) option.yAxis = scaleAxisLabel(option.yAxis)
  if (Array.isArray(option.series)) {
    option.series.forEach(s => {
      if (s.type === 'pie' && s.label) {
        s.label = { ...s.label, fontSize: 22 }
      }
    })
  }
  return option
}

/**
 * 将 chart 渲染为 PNG data URL
 * 直接复用在线 ECharts option，消除"在线 vs 导出"的数据/样式差异
 */
export async function renderChartToDataUrlAsync(chart, sheet) {
  if (!chart || !sheet) return null

  const option = buildEchartsOption(chart, sheet)
  if (!option || (!option.series && !option.xAxis)) return null

  const echarts = await getEcharts()
  const w = chart.width || 600
  const h = chart.height || 400

  const canvas = document.createElement('canvas')
  canvas.width = w * 2
  canvas.height = h * 2

  const instance = echarts.init(canvas, null, {
    width: w * 2,
    height: h * 2,
    devicePixelRatio: 1,
    renderer: 'canvas',
  })

  option.animation = false
  option.backgroundColor = '#fff'
  scaleOptionForExport(option)

  instance.setOption(option)
  const dataUrl = canvas.toDataURL('image/png')
  instance.dispose()
  return dataUrl
}
