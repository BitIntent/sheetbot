// ================================================================
// ECharts Option 构建器
// 从 sheet.charts[] 数据模型 + sheet.data 生成完整 ECharts option
// 支持：column / bar / line / area / pie / doughnut / scatter / radar
// ================================================================
import { evaluateFormula } from '../utils/formulaEngine'

// ==================== 范围解析 ====================

function colLetterToNum(letters) {
  return letters.split('').reduce((acc, c) => acc * 26 + c.toUpperCase().charCodeAt(0) - 64, 0)
}

export function parseRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') return null
  const clean = rangeStr.replace(/^[^!]*!/, '')
  const m = clean.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i)
  if (!m) return null
  return {
    startRow: parseInt(m[2], 10),
    startCol: colLetterToNum(m[1]),
    endRow: parseInt(m[4], 10),
    endCol: colLetterToNum(m[3]),
  }
}

export function normalizeDataRange(dataRange) {
  if (typeof dataRange === 'string') return dataRange
  if (dataRange?.start && dataRange?.end) {
    const toL = (n) => { let r = '', t = n; while (t > 0) { t--; r = String.fromCharCode(65 + (t % 26)) + r; t = Math.floor(t / 26) } return r }
    return `${toL(dataRange.start.col)}${dataRange.start.row}:${toL(dataRange.end.col)}${dataRange.end.row}`
  }
  return null
}

// ==================== 数据提取 ====================

function readCell(row, col, sheet) {
  const cell = sheet?.data?.[row]?.[col]
  if (!cell) return ''
  if (cell.formula && (cell.value === undefined || cell.value === null || cell.value === '')) {
    try { return evaluateFormula(cell.formula, sheet.data) } catch { /* fallback */ }
  }
  return cell.value ?? ''
}

// 匹配汇总行标签（总计/合计/小计等）的正则，与 excelOperations.js 保持一致
const TOTAL_ROW_RE = /^(总计|合计|小计|汇总|total|grand\s+total|subtotal|sub\s+total|sum)$/i

/**
 * 从范围提取结构化数据：headers（列名）+ labels（行标签）+ 数值矩阵
 * 智能检测第一行是否为表头、第一列是否为标签列
 * excludeRows: Set<number> 绝对行号集合，跳过这些行（总计行中间夹着的情况）
 */
export function extractChartData(range, sheet, excludeRows) {
  if (!range) return { headers: [], labels: [], matrix: [] }

  const { startRow, startCol, endRow, endCol } = range
  const numCols = endCol - startCol + 1
  const skipRows = excludeRows instanceof Set ? excludeRows : new Set(excludeRows || [])

  const raw = []
  const rawRowNums = []
  for (let r = startRow; r <= endRow; r++) {
    if (skipRows.has(r)) continue
    const row = []
    for (let c = startCol; c <= endCol; c++) {
      row.push(readCell(r, c, sheet))
    }
    raw.push(row)
    rawRowNums.push(r)
  }
  if (!raw.length) return { headers: [], labels: [], matrix: [] }

  // 跳过前导空行（防御性：createChart 自愈可能未覆盖所有入口）
  while (raw.length > 1 && raw[0].every(v => v === '' || v == null)) {
    raw.shift()
    rawRowNums.shift()
  }
  // 裁剪尾部空行
  while (raw.length > 1 && raw[raw.length - 1].every(v => v === '' || v == null)) {
    raw.pop()
    rawRowNums.pop()
  }

  // 裁剪尾部空列：LLM 有时 endCol 多传 1 列，导致生成 "S4" 等幽灵系列
  let effectiveCols = raw[0].length
  while (effectiveCols > 1 && raw.every(r => {
    const v = r[effectiveCols - 1]
    return v === '' || v == null
  })) {
    raw.forEach(r => r.pop())
    effectiveCols--
  }

  const numRows = raw.length
  const actualNumCols = effectiveCols
  const isStr = (v) => typeof v === 'string' && v !== '' && isNaN(Number(v))
  // 合并从属单元格复制主单元格值 → 同一字符串充满整行 → 旧 count 虚高。
  // 改用 DISTINCT 计数：合并标题行只有 1 个独立字符串，列标题行 >= 3 个。
  const _firstRowStrs = new Set(raw[0].filter(isStr))
  const firstRowStrCount = _firstRowStrs.size
  const hasHeader = numRows > 1 && firstRowStrCount > actualNumCols / 2
  const firstColStrCount = raw.slice(hasHeader ? 1 : 0).filter(r => isStr(r[0])).length
  const dataRowCount = numRows - (hasHeader ? 1 : 0)
  const hasLabelCol = actualNumCols > 1 && dataRowCount > 0 && firstColStrCount > dataRowCount / 2

  const dataColStart = hasLabelCol ? 1 : 0
  const dataRowStart = hasHeader ? 1 : 0

  // 提取类别列标题（如"渠道""品类"）——首行第一格，后续用于 x 轴名称
  const categoryTitle = (hasHeader && hasLabelCol) ? String(raw[0][0] || '') : ''

  const headers = hasHeader
    ? raw[0].slice(dataColStart).map((v, i) => String(v || `S${i + 1}`))
    : Array.from({ length: actualNumCols - dataColStart }, (_, i) => `S${i + 1}`)

  // 数据行再次过滤：跳过标签列匹配总计关键词的行（防御性二次过滤）
  const dataRows = raw.slice(dataRowStart).filter(r => {
    if (!hasLabelCol) return true
    const label = String(r[0] ?? '').trim()
    return !TOTAL_ROW_RE.test(label)
  })

  const labels = dataRows.map((r, i) =>
    hasLabelCol ? String(r[0] || `${i + 1}`) : `${i + 1}`
  )

  const matrix = dataRows.map(r =>
    r.slice(dataColStart).map(v => {
      const n = typeof v === 'number' ? v : parseFloat(v)
      return Number.isFinite(n) ? n : 0
    })
  )

  return { headers, labels, matrix, categoryTitle }
}

// ==================== 通用样式常量 ====================

const COLORS = [
  '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de',
  '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#48b8d0',
]

const BASE_GRID = { left: 52, right: 20, bottom: 32, containLabel: false }

// ==================== 各图表类型构建 ====================

function buildAxisChart(type, chart, { headers, labels, matrix, categoryTitle }) {
  const isHorizontal = type === 'bar'
  const isArea = type === 'area'
  const seriesType = (type === 'column' || type === 'bar') ? 'bar' : 'line'

  const series = headers.map((name, i) => ({
    name,
    type: seriesType,
    data: matrix.map(row => row[i] ?? 0),
    ...(isArea ? { areaStyle: { opacity: 0.25 } } : {}),
    itemStyle: { color: COLORS[i % COLORS.length] },
  }))

  const catAxis = {
    type: 'category',
    data: labels,
    axisLabel: { rotate: labels.length > 8 ? 30 : 0 },
    ...(categoryTitle ? { name: categoryTitle, nameLocation: 'end', nameGap: 8, nameTextStyle: { fontSize: 11, color: '#888' } } : {}),
  }
  const valAxis = { type: 'value' }

  return {
    tooltip: { trigger: 'axis' },
    legend: headers.length > 1 ? { bottom: 0, textStyle: { fontSize: 11 } } : undefined,
    grid: { ...BASE_GRID, top: chart.title ? 40 : 24, bottom: headers.length > 1 ? 40 : 32 },
    xAxis: isHorizontal ? valAxis : catAxis,
    yAxis: isHorizontal ? catAxis : valAxis,
    series,
  }
}

function buildPieChart(isDoughnut, chart, { headers, labels, matrix }) {
  const data = labels.map((name, i) => ({
    name,
    value: matrix[i]?.[0] ?? 0,
    itemStyle: { color: COLORS[i % COLORS.length] },
  }))

  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie',
      radius: isDoughnut ? ['35%', '60%'] : '60%',
      center: ['50%', chart.title ? '52%' : '48%'],
      data,
      label: { formatter: '{b}\n{d}%', fontSize: 11 },
    }],
  }
}

function buildScatterChart(chart, { headers, labels, matrix }) {
  const series = []
  const colCount = headers.length
  if (colCount >= 2) {
    for (let s = 1; s < colCount; s++) {
      series.push({
        name: headers[s],
        type: 'scatter',
        data: matrix.map(row => [row[0] ?? 0, row[s] ?? 0]),
        itemStyle: { color: COLORS[(s - 1) % COLORS.length] },
      })
    }
  } else {
    series.push({
      type: 'scatter',
      data: matrix.map((row, i) => [i, row[0] ?? 0]),
      itemStyle: { color: COLORS[0] },
    })
  }

  return {
    tooltip: { trigger: 'item' },
    legend: series.length > 1 ? { bottom: 0, textStyle: { fontSize: 11 } } : undefined,
    grid: { ...BASE_GRID, top: chart.title ? 40 : 24, bottom: series.length > 1 ? 40 : 32 },
    xAxis: { type: 'value', name: headers[0] || 'X' },
    yAxis: { type: 'value' },
    series,
  }
}

function buildRadarChart(chart, { headers, labels, matrix }) {
  // matrix.flat() 可能为空数组（无数据行），Math.max(...[]) = -Infinity 会导致轴崩溃。
  // 显式追加 0 保底，再取 max 保证指标轴 ≥ 1。
  const flatValues = matrix.flat().filter(v => Number.isFinite(v))
  const rawMax = flatValues.length > 0 ? Math.max(...flatValues) : 0
  const max = Math.max(1, rawMax) * 1.2
  const indicator = labels.map(name => ({ name, max: Math.ceil(max) }))

  const series = [{
    type: 'radar',
    data: headers.map((name, i) => ({
      name,
      value: matrix.map(row => row[i] ?? 0),
      areaStyle: { opacity: 0.15 },
      lineStyle: { color: COLORS[i % COLORS.length] },
      itemStyle: { color: COLORS[i % COLORS.length] },
    })),
  }]

  return {
    tooltip: {},
    legend: headers.length > 1 ? { bottom: 0, textStyle: { fontSize: 11 } } : undefined,
    radar: { indicator, center: ['50%', chart.title ? '55%' : '50%'], radius: '60%' },
    series,
  }
}

// ==================== 主入口 ====================

export function buildEchartsOption(chart, sheet) {
  const rangeStr = normalizeDataRange(chart.dataRange)
  const range = parseRange(rangeStr)
  if (!range) {
    return { title: { text: chart.title || '(no data)', left: 'center' } }
  }

  const excludeRows = chart._excludeRows ? new Set(chart._excludeRows) : undefined
  const data = extractChartData(range, sheet, excludeRows)
  if (!data.matrix.length) {
    return { title: { text: chart.title || '(empty)', left: 'center' } }
  }

  const t = String(chart.chartType || 'column').toLowerCase()
  let option

  if (t === 'pie') option = buildPieChart(false, chart, data)
  else if (t === 'doughnut' || t === 'donut') option = buildPieChart(true, chart, data)
  else if (t === 'scatter') option = buildScatterChart(chart, data)
  else if (t === 'radar') option = buildRadarChart(chart, data)
  else option = buildAxisChart(t, chart, data)

  if (chart.title) {
    option.title = { text: chart.title, left: 'center', textStyle: { fontSize: 13, fontWeight: 500 } }
  }

  option.animation = false

  return option
}
