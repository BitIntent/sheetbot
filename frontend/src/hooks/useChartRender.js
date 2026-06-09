// frontend/src/hooks/useChartRender.js
/**
 * ===================================
 * 图表渲染 Hook
 * - 解析数据范围
 * - 计算可见性
 * - 输出图表节点
 * ===================================
 */
import { useCallback, useMemo } from 'react'
import ChartCanvas from '../components/ChartCanvas'

const colToLetter = (col) => {
  let result = ''
  let num = col
  while (num > 0) {
    num--
    result = String.fromCharCode(65 + (num % 26)) + result
    num = Math.floor(num / 26)
  }
  return result
}

const getSheetDataRange = (sheet) => {
  if (!sheet || !sheet.data) {
    return { startRow: 1, endRow: 1000 }
  }
  const rowKeys = Object.keys(sheet.data)
    .map(Number)
    .filter(n => !isNaN(n) && n > 0)
    .sort((a, b) => a - b)
  if (rowKeys.length === 0) {
    return { startRow: 1, endRow: 1000 }
  }
  return { startRow: 1, endRow: Math.max(...rowKeys) }
}

const parseCol = (colStr) => {
  const cleanCol = colStr.replace(/\$/g, '')
  return cleanCol.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)
}

const parseSingleRange = (range, sheet) => {
  let cleanRange = range
  if (range.includes('!')) {
    const parts = range.split('!')
    cleanRange = parts[parts.length - 1]
  }
  let match = cleanRange.match(/\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/i)
  if (match) {
    return {
      startRow: parseInt(match[2]),
      startCol: parseCol(match[1]),
      endRow: parseInt(match[4]),
      endCol: parseCol(match[3])
    }
  }
  match = cleanRange.match(/\$?([A-Z]+)\s*:\s*\$?([A-Z]+)/i)
  if (match) {
    const dataRange = getSheetDataRange(sheet)
    return {
      startRow: dataRange.startRow,
      startCol: parseCol(match[1]),
      endRow: dataRange.endRow,
      endCol: parseCol(match[2])
    }
  }
  return null
}

const parseRangeStr = (rangeStr, sheet) => {
  let cleanRangeStr = rangeStr
  if (rangeStr.includes('!')) {
    const parts = rangeStr.split('!')
    cleanRangeStr = parts[parts.length - 1]
  }
  if (cleanRangeStr.includes(',')) {
    const ranges = cleanRangeStr.split(',').map(r => r.trim())
    return ranges.map(r => parseSingleRange(r, sheet)).filter(r => r !== null)
  }
  return parseSingleRange(cleanRangeStr, sheet)
}

const isChartVisible = (chart, visibleRows, visibleCols, cellWidth, cellHeight) => {
  const chartStartRow = chart.row
  const chartEndRow = chart.row + Math.ceil(chart.height / cellHeight)
  const chartStartCol = chart.col
  const chartEndCol = chart.col + Math.ceil(chart.width / cellWidth)
  return !(
    chartStartRow < visibleRows.start ||
    chartStartRow > visibleRows.end ||
    chartStartCol < visibleCols.start ||
    chartStartCol > visibleCols.end
  )
}

const buildHeadersAndRows = (range, sheet, getCellDisplay) => {
  const headers = []
  const dataRows = []
  const isMultiple = Array.isArray(range)
  if (isMultiple) {
    const validRanges = range.filter(r => r && r.startRow !== undefined && r.startCol !== undefined)
    if (validRanges.length >= 2) {
      const labelRange = validRanges[0]
      const valueRange = validRanges[1]
      // dataRange 包含表头行 → 首行即列标题
      const labelHeaderRow = labelRange.startRow
      const valueHeaderRow = valueRange.startRow
      headers.push(
        getCellDisplay(sheet?.data[labelHeaderRow]?.[labelRange.startCol]),
        getCellDisplay(sheet?.data[valueHeaderRow]?.[valueRange.startCol])
      )
      const dataStartRow = Math.max(labelRange.startRow + 1, valueRange.startRow + 1)
      const dataEndRow = Math.min(labelRange.endRow, valueRange.endRow)
      for (let row = dataStartRow; row <= dataEndRow; row++) {
        const rowData = []
        const labelCell = sheet?.data[row]?.[labelRange.startCol]
        const valueCell = sheet?.data[row]?.[valueRange.startCol]
        const labelValue = labelCell?.formula ? getCellDisplay(labelCell) : (labelCell?.value ?? '')
        const valueValue = valueCell?.formula ? getCellDisplay(valueCell) : (valueCell?.value ?? '')
        rowData.push(String(labelValue ?? ''))
        const numValue = typeof valueValue === 'number' ? valueValue : parseFloat(valueValue)
        rowData.push(isNaN(numValue) ? 0 : numValue)
        dataRows.push(rowData)
      }
      return { headers, dataRows }
    }
    if (validRanges.length === 1) {
      return buildHeadersAndRows(validRanges[0], sheet, getCellDisplay)
    }
    return { headers, dataRows }
  }
  const singleRange = range
  if (!singleRange) return { headers, dataRows }
  // dataRange 包含表头行 → 首行即列标题
  const headerRow = singleRange.startRow
  for (let col = singleRange.startCol; col <= singleRange.endCol; col++) {
    headers.push(getCellDisplay(sheet?.data[headerRow]?.[col]))
  }
  const dataStartRow = singleRange.startRow + 1
  for (let row = dataStartRow; row <= singleRange.endRow; row++) {
    const rowData = []
    for (let col = singleRange.startCol; col <= singleRange.endCol; col++) {
      const cell = sheet?.data[row]?.[col]
      const rawValue = cell?.formula ? getCellDisplay(cell) : (cell?.value ?? '')
      if (typeof rawValue === 'number') {
        rowData.push(rawValue)
      } else if (typeof rawValue === 'string') {
        const numValue = parseFloat(rawValue)
        rowData.push(isNaN(numValue) ? rawValue : numValue)
      } else {
        rowData.push(String(rawValue || ''))
      }
    }
    dataRows.push(rowData)
  }
  return { headers, dataRows }
}

export function useChartRender({
  sheet,
  visibleRows,
  visibleCols,
  getCellDisplay,
  cellWidth,
  cellHeight,
  headerWidth,
  headerHeight
}) {
  const renderChart = useCallback((chart) => {
    if (!chart || !chart.dataRange) return null
    if (!isChartVisible(chart, visibleRows, visibleCols, cellWidth, cellHeight)) return null
    let rangeStr = chart.dataRange
    if (typeof chart.dataRange === 'object' && chart.dataRange.start && chart.dataRange.end) {
      rangeStr = `${colToLetter(chart.dataRange.start.col)}${chart.dataRange.start.row}:${colToLetter(chart.dataRange.end.col)}${chart.dataRange.end.row}`
    }
    const range = parseRangeStr(rangeStr, sheet)
    if (!range) return null
    const { headers, dataRows } = buildHeadersAndRows(range, sheet, getCellDisplay)
    const left = (chart.col - 1) * cellWidth + headerWidth
    const top = (chart.row - 1) * cellHeight + headerHeight
    return (
      <div
        key={chart.id}
        className="excel-chart"
        style={{
          position: 'absolute',
          left: `${left}px`,
          top: `${top}px`,
          width: `${chart.width}px`,
          height: `${chart.height}px`,
          border: '1px solid #ccc',
          backgroundColor: 'white',
          zIndex: 10,
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}
      >
        <ChartCanvas
          chartType={chart.chartType}
          title={chart.title}
          headers={headers}
          dataRows={dataRows}
          width={chart.width}
          height={chart.height}
          dataRange={chart.dataRange}
          sheet={sheet}
          rangeStartRow={Array.isArray(range) ? (range[0]?.startRow || range[1]?.startRow || 1) : (range?.startRow || 1)}
          rangeStartCol={Array.isArray(range) ? (range[0]?.startCol || range[1]?.startCol || 1) : (range?.startCol || 1)}
        />
      </div>
    )
  }, [cellHeight, cellWidth, getCellDisplay, headerHeight, headerWidth, sheet, visibleCols, visibleRows])

  const chartElements = useMemo(() => {
    if (!sheet?.charts || sheet.charts.length === 0) return null
    return sheet.charts.map(chart => renderChart(chart))
  }, [renderChart, sheet?.charts])

  return { chartElements }
}
// frontend/src/hooks/useChartRender.js
/**
 * ===================================
 * 图表渲染 Hook
 * - 解析范围
 * - 生成图表元素
 * ===================================
 */
import React, { useCallback, useMemo } from 'react'
import ChartCanvas from '../components/ChartCanvas'

const parseCol = (colStr) => {
  const cleanCol = colStr.replace(/\$/g, '')
  return cleanCol.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)
}

export function useChartRender({ sheet, visibleRows, visibleCols, getCellDisplay }) {
  const parseRangeStr = useCallback((rangeStr, sheetData) => {
    const getSheetDataRange = () => {
      if (!sheetData) {
        return { startRow: 1, endRow: 1000 }
      }
      const rowKeys = Object.keys(sheetData)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => a - b)
      if (rowKeys.length === 0) {
        return { startRow: 1, endRow: 1000 }
      }
      return { startRow: 1, endRow: Math.max(...rowKeys) }
    }

    let cleanRangeStr = rangeStr
    if (rangeStr.includes('!')) {
      const parts = rangeStr.split('!')
      cleanRangeStr = parts[parts.length - 1]
    }

    const parseSingleRange = (range) => {
      let cleanRange = range
      if (range.includes('!')) {
        const parts = range.split('!')
        cleanRange = parts[parts.length - 1]
      }
      let match = cleanRange.match(/\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/i)
      if (match) {
        return {
          startRow: parseInt(match[2]),
          startCol: parseCol(match[1]),
          endRow: parseInt(match[4]),
          endCol: parseCol(match[3])
        }
      }
      match = cleanRange.match(/\$?([A-Z]+)\s*:\s*\$?([A-Z]+)/i)
      if (match) {
        const dataRange = getSheetDataRange()
        return {
          startRow: dataRange.startRow,
          startCol: parseCol(match[1]),
          endRow: dataRange.endRow,
          endCol: parseCol(match[2])
        }
      }
      return null
    }

    if (cleanRangeStr.includes(',')) {
      const ranges = cleanRangeStr.split(',').map(r => r.trim())
      return ranges.map(parseSingleRange).filter(r => r !== null)
    }
    return parseSingleRange(cleanRangeStr)
  }, [])

  const renderChart = useCallback((chart) => {
    if (!chart || !chart.dataRange) return null
    let rangeStr = chart.dataRange
    if (typeof chart.dataRange === 'object' && chart.dataRange.start && chart.dataRange.end) {
      const colToLetter = (col) => {
        let result = ''
        while (col > 0) {
          col--
          result = String.fromCharCode(65 + (col % 26)) + result
          col = Math.floor(col / 26)
        }
        return result
      }
      rangeStr = `${colToLetter(chart.dataRange.start.col)}${chart.dataRange.start.row}:${colToLetter(chart.dataRange.end.col)}${chart.dataRange.end.row}`
    }

    const range = parseRangeStr(rangeStr, sheet?.data)
    if (!range) return null

    const chartStartRow = chart.row
    const chartEndRow = chart.row + Math.ceil(chart.height / 25)
    const chartStartCol = chart.col
    const chartEndCol = chart.col + Math.ceil(chart.width / 100)
    if (chartStartRow < visibleRows.start || chartStartRow > visibleRows.end ||
        chartStartCol < visibleCols.start || chartStartCol > visibleCols.end) {
      return null
    }

    const headers = []
    const dataRows = []
    const isMultipleRanges = Array.isArray(range)

    if (isMultipleRanges) {
      const validRanges = range.filter(r => r && r.startRow !== undefined && r.startCol !== undefined)
      if (validRanges.length === 0) return null
      if (validRanges.length >= 2) {
        const labelRange = validRanges[0]
        const valueRange = validRanges[1]
        const labelHeaderRow = labelRange.startRow
        const valueHeaderRow = valueRange.startRow
        headers.push(getCellDisplay(sheet?.data[labelHeaderRow]?.[labelRange.startCol]))
        headers.push(getCellDisplay(sheet?.data[valueHeaderRow]?.[valueRange.startCol]))
        const dataStartRow = Math.max(labelRange.startRow + 1, valueRange.startRow + 1)
        const dataEndRow = Math.min(labelRange.endRow, valueRange.endRow)
        for (let row = dataStartRow; row <= dataEndRow; row++) {
          const rowData = []
          const labelCell = sheet?.data[row]?.[labelRange.startCol]
          rowData.push(labelCell?.formula ? String(getCellDisplay(labelCell)) : String(labelCell?.value ?? ''))
          const valueCell = sheet?.data[row]?.[valueRange.startCol]
          const value = valueCell?.formula ? getCellDisplay(valueCell) : valueCell?.value
          rowData.push(typeof value === 'number' ? value : (parseFloat(value) || 0))
          dataRows.push(rowData)
        }
      }
    } else {
      const singleRange = range
      const headerRow = singleRange.startRow
      for (let col = singleRange.startCol; col <= singleRange.endCol; col++) {
        headers.push(getCellDisplay(sheet?.data[headerRow]?.[col]))
      }
      const dataStartRow = singleRange.startRow + 1
      for (let row = dataStartRow; row <= singleRange.endRow; row++) {
        const rowData = []
        for (let col = singleRange.startCol; col <= singleRange.endCol; col++) {
          const cell = sheet?.data[row]?.[col]
          const rawValue = cell?.value !== undefined ? cell.value : (cell?.formula ? getCellDisplay(cell) : '')
          if (cell?.formula) {
            const formulaValue = getCellDisplay(cell)
            rowData.push(typeof formulaValue === 'number' ? formulaValue : String(formulaValue))
          } else if (typeof rawValue === 'number') {
            rowData.push(rawValue)
          } else if (typeof rawValue === 'string') {
            const numValue = parseFloat(rawValue)
            rowData.push(isNaN(numValue) ? rawValue : numValue)
          } else {
            rowData.push(String(rawValue || ''))
          }
        }
        dataRows.push(rowData)
      }
    }

    const left = (chartStartCol - visibleCols.start) * 100 + 40
    const top = (chartStartRow - visibleRows.start) * 25 + 30

    return (
      <div
        key={chart.id}
        className="excel-chart"
        style={{
          position: 'absolute',
          left: `${left}px`,
          top: `${top}px`,
          width: `${chart.width}px`,
          height: `${chart.height}px`,
          border: '1px solid #ccc',
          backgroundColor: 'white',
          zIndex: 10,
          boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
        }}
      >
        <ChartCanvas
          chartType={chart.chartType}
          title={chart.title}
          headers={headers}
          dataRows={dataRows}
          width={chart.width}
          height={chart.height}
          dataRange={chart.dataRange}
          sheet={sheet}
          rangeStartRow={Array.isArray(range) ? (range[0]?.startRow || range[1]?.startRow || 1) : (range?.startRow || 1)}
          rangeStartCol={Array.isArray(range) ? (range[0]?.startCol || range[1]?.startCol || 1) : (range?.startCol || 1)}
        />
      </div>
    )
  }, [getCellDisplay, parseRangeStr, sheet, visibleCols.start, visibleRows.start, visibleCols, visibleRows])

  const chartElements = useMemo(() => {
    if (!sheet?.charts || sheet.charts.length === 0) return null
    return sheet.charts.map(chart => renderChart(chart))
  }, [renderChart, sheet?.charts])

  return { chartElements }
}
