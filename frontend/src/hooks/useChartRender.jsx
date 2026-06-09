// frontend/src/hooks/useChartRender.jsx
/**
 * ===================================
 * 图表渲染 Hook
 * - 解析数据范围
 * - 生成图表数据
 * ===================================
 */
import React, { useCallback, useMemo } from 'react'
import ChartCanvas from '../components/ChartCanvas'

const colToLetter = (col) => {
  let result = ''
  let temp = col
  while (temp > 0) {
    temp--
    result = String.fromCharCode(65 + (temp % 26)) + result
    temp = Math.floor(temp / 26)
  }
  return result
}

const normalizeRangeStr = (dataRange) => {
  if (typeof dataRange === 'string') return dataRange
  if (dataRange?.start && dataRange?.end) {
    return `${colToLetter(dataRange.start.col)}${dataRange.start.row}:${colToLetter(dataRange.end.col)}${dataRange.end.row}`
  }
  return null
}

const isChartVisible = (chart, visibleRows, visibleCols, cellHeight, cellWidth) => {
  const endRow = chart.row + Math.ceil(chart.height / cellHeight)
  const endCol = chart.col + Math.ceil(chart.width / cellWidth)
  return !(chart.row < visibleRows.start || chart.row > visibleRows.end ||
    chart.col < visibleCols.start || chart.col > visibleCols.end ||
    endRow < visibleRows.start || endCol < visibleCols.start)
}

const readHeader = (sheet, row, col, getCellDisplay) => {
  return getCellDisplay(row, col, sheet?.data[row]?.[col])
}

const readCellValue = (row, col, cell, getCellDisplay) => {
  const raw = cell?.value !== undefined ? cell.value : (cell?.formula ? getCellDisplay(row, col, cell) : '')
  if (cell?.formula) return getCellDisplay(row, col, cell)
  return raw
}

const readSingleHeaders = (range, sheet, getCellDisplay) => {
  const headers = []
  // dataRange 包含表头行 → 首行即列标题（非 startRow - 1）
  const headerRow = range.startRow
  for (let col = range.startCol; col <= range.endCol; col++) {
    headers.push(readHeader(sheet, headerRow, col, getCellDisplay))
  }
  return headers
}

const readSingleRows = (range, sheet, getCellDisplay) => {
  const dataRows = []
  const startRow = range.startRow + 1
  for (let row = startRow; row <= range.endRow; row++) {
    const rowData = []
    for (let col = range.startCol; col <= range.endCol; col++) {
      const cell = sheet?.data[row]?.[col]
      const value = readCellValue(row, col, cell, getCellDisplay)
      const numValue = typeof value === 'number' ? value : parseFloat(value)
      rowData.push(isNaN(numValue) ? String(value || '') : numValue)
    }
    dataRows.push(rowData)
  }
  return dataRows
}

const buildSingleRangeData = (range, sheet, getCellDisplay) => {
  return {
    headers: readSingleHeaders(range, sheet, getCellDisplay),
    dataRows: readSingleRows(range, sheet, getCellDisplay)
  }
}

const readMultiHeaders = (ranges, sheet, getCellDisplay) => {
  const [labelRange, valueRange] = ranges
  const labelRow = labelRange.startRow
  const valueRow = valueRange.startRow
  return [
    readHeader(sheet, labelRow, labelRange.startCol, getCellDisplay),
    readHeader(sheet, valueRow, valueRange.startCol, getCellDisplay)
  ]
}

const readMultiRows = (ranges, sheet, getCellDisplay) => {
  const [labelRange, valueRange] = ranges
  const dataRows = []
  const startRow = Math.max(labelRange.startRow, valueRange.startRow)
  const endRow = Math.min(labelRange.endRow, valueRange.endRow)
  for (let row = startRow; row <= endRow; row++) {
    const labelCell = sheet?.data[row]?.[labelRange.startCol]
    const valueCell = sheet?.data[row]?.[valueRange.startCol]
    const label = String(readCellValue(row, labelRange.startCol, labelCell, getCellDisplay) || '')
    const value = readCellValue(row, valueRange.startCol, valueCell, getCellDisplay)
    const numValue = typeof value === 'number' ? value : parseFloat(value)
    dataRows.push([label, isNaN(numValue) ? 0 : numValue])
  }
  return dataRows
}

const buildMultiRangeData = (ranges, sheet, getCellDisplay) => {
  return {
    headers: readMultiHeaders(ranges, sheet, getCellDisplay),
    dataRows: readMultiRows(ranges, sheet, getCellDisplay)
  }
}

const getValidRanges = (range) => {
  if (Array.isArray(range)) {
    return range.filter(r => r?.startRow && r?.startCol)
  }
  return range ? [range] : []
}

const buildChartData = (ranges, sheet, getCellDisplay) => {
  if (ranges.length >= 2) {
    return buildMultiRangeData(ranges.slice(0, 2), sheet, getCellDisplay)
  }
  if (ranges.length === 1) {
    return buildSingleRangeData(ranges[0], sheet, getCellDisplay)
  }
  return { headers: [], dataRows: [] }
}

// -------------------------------------------------------
// 图表裁剪容器：外层 div 限定在 clientWidth×clientHeight 内
// Chromium 保证 GPU 合成层被 overflow:hidden 祖先裁剪
// 防止 ECharts canvas 的 GPU 层覆盖滚动条
// -------------------------------------------------------
const buildChartElement = (chart, data, position, sheet, rangeStart, clipW, clipH) => {
  return (
    <div
      key={chart.id}
      style={{
        position: 'absolute',
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${clipW}px`,
        height: `${clipH}px`,
        overflow: 'hidden',
        zIndex: 2,
      }}
    >
      <div style={{
        width: `${chart.width}px`,
        height: `${chart.height}px`,
        border: '1px solid #ccc',
        backgroundColor: 'white',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
      }}>
        <ChartCanvas
          chartType={chart.chartType}
          title={chart.title}
          headers={data.headers}
          dataRows={data.dataRows}
          width={chart.width}
          height={chart.height}
          dataRange={chart.dataRange}
          sheet={sheet}
          rangeStartRow={rangeStart.startRow}
          rangeStartCol={rangeStart.startCol}
        />
      </div>
    </div>
  )
}

export function useChartRender({
  sheet,
  visibleRows,
  visibleCols,
  parseRangeStr,
  getCellDisplay,
  cellWidth,
  cellHeight,
  headerWidth,
  headerHeight,
  containerRef,
}) {
  const renderChart = useCallback((chart) => {
    if (!chart?.dataRange) return null
    const rangeStr = normalizeRangeStr(chart.dataRange)
    const range = rangeStr ? parseRangeStr(rangeStr, sheet) : null
    if (!range) return null
    if (!isChartVisible(chart, visibleRows, visibleCols, cellHeight, cellWidth)) return null
    const validRanges = getValidRanges(range)
    if (validRanges.length === 0) return null
    const data = buildChartData(validRanges, sheet, getCellDisplay)
    const left = (chart.col - visibleCols.start) * cellWidth + headerWidth
    const top = (chart.row - visibleRows.start) * cellHeight + headerHeight

    // 裁剪图表到容器可见区域，防止 ECharts GPU 合成层延伸覆盖滚动条
    const cw = containerRef?.current?.clientWidth || 9999
    const ch = containerRef?.current?.clientHeight || 9999
    const clipW = Math.max(1, Math.min(chart.width, cw - left))
    const clipH = Math.max(1, Math.min(chart.height, ch - top))

    return buildChartElement(chart, data, { left, top }, sheet, validRanges[0], clipW, clipH)
  }, [cellHeight, cellWidth, getCellDisplay, headerHeight, headerWidth, parseRangeStr, sheet, visibleCols.start, visibleRows.start, visibleCols, visibleRows, containerRef])

  const chartElements = useMemo(() => {
    if (!sheet?.charts || sheet.charts.length === 0) return null
    return sheet.charts.map(chart => renderChart(chart))
  }, [renderChart, sheet?.charts])

  return { chartElements }
}
