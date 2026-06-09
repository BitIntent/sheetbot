// frontend/src/hooks/useGridItemsBuilder.js
/**
 * ===================================
 * 网格渲染 Hook
 * - 生成标题、行号、单元格节点
 * ===================================
 */
import React, { useMemo } from 'react'

const toExcelColumnName = (col) => {
  let n = Number(col)
  if (!Number.isFinite(n) || n <= 0) return ''
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

const buildHeaders = (displayCols) => {
  const items = []
  items.push(<div key="corner" className="excel-corner"></div>)
  for (let col = 1; col <= displayCols; col++) {
    items.push(
      <div key={`header-${col}`} className="excel-header">
        {toExcelColumnName(col)}
      </div>
    )
  }
  return items
}

const isVisible = (row, col, visibleRows, visibleCols) => {
  return row >= visibleRows.start &&
    row <= visibleRows.end &&
    col >= visibleCols.start &&
    col <= visibleCols.end
}

export function useGridItemsBuilder({
  displayRows,
  displayCols,
  visibleRows,
  visibleCols,
  hiddenRows,
  renderCell
}) {
  return useMemo(() => {
    const items = []
    items.push(...buildHeaders(displayCols))
    for (let row = 1; row <= displayRows; row++) {
      const isRowHidden = hiddenRows.includes(row)
      items.push(
        <div
          key={`row-header-${row}`}
          className="excel-row-header"
          style={{
            display: isRowHidden ? 'none' : 'flex',
            visibility: row >= visibleRows.start && row <= visibleRows.end ? 'visible' : 'hidden'
          }}
        >
          {row}
        </div>
      )
      for (let col = 1; col <= displayCols; col++) {
        const cellKey = `cell-${row}-${col}`
        if (!isVisible(row, col, visibleRows, visibleCols)) {
          items.push(
            <div key={cellKey} className="excel-cell" style={{ visibility: 'hidden' }} />
          )
          continue
        }
        const cellElement = renderCell(row, col)
        if (isRowHidden) {
          items.push(
            <div key={cellKey} style={{ display: 'none' }}>
              {cellElement}
            </div>
          )
        } else {
          items.push(cellElement)
        }
      }
    }
    return items
  }, [displayCols, displayRows, hiddenRows, renderCell, visibleCols, visibleRows])
}
// frontend/src/hooks/useGridItemsBuilder.js
/**
 * ===================================
 * 网格渲染 Hook
 * - 构建行列与单元格节点
 * ===================================
 */
import { useCallback, useMemo } from 'react'

export function useGridItemsBuilder({
  sheet,
  selection,
  editingCell,
  visibleRows,
  visibleCols,
  displayRows,
  displayCols,
  getCellDisplay,
  getCellEditValue,
  checkConditionalFormat,
  handleCellClick,
  handleCellDoubleClick,
  handleCellKeyDown,
  handleCellMouseDown,
  onCellChange,
  onEditingCellChange
}) {
  const renderCell = useCallback((row, col) => {
    const isSelected = row >= selection.startRow && row <= selection.endRow &&
      col >= selection.startCol && col <= selection.endCol
    const isEditing = editingCell?.row === row && editingCell?.col === col
    const cell = sheet?.data[row]?.[col]

    const hasChart = sheet?.charts?.some(chart => {
      const chartStartRow = chart.row
      const chartEndRow = chart.row + Math.ceil(chart.height / 25)
      const chartStartCol = chart.col
      const chartEndCol = chart.col + Math.ceil(chart.width / 100)
      return row >= chartStartRow && row <= chartEndRow &&
        col >= chartStartCol && col <= chartEndCol
    })

    if (hasChart) {
      return (
        <div
          key={`${row}-${col}`}
          className="excel-cell chart-overlay"
          style={{ backgroundColor: 'transparent', border: 'none' }}
        />
      )
    }

    const conditionalFormat = checkConditionalFormat(row, col, cell)
    const cellStyle = cell?.style || {}

    // ------------------------------------
    // 背景色：null 表示无显式背景，依赖 CSS .excel-cell { background-color: white }
    // 只有非白色背景才写 inline style，避免覆盖条件格式或父层样式
    // ------------------------------------
    let backgroundColor = null
    if (conditionalFormat?.backgroundColor) {
      backgroundColor = conditionalFormat.backgroundColor
    } else if (cellStyle.backgroundColor) {
      let bgColor = cellStyle.backgroundColor
      if (bgColor !== '' && bgColor !== null && bgColor !== undefined) {
        if (typeof bgColor === 'string' && !bgColor.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(bgColor)) {
          bgColor = '#' + bgColor
        }
        backgroundColor = bgColor
      }
    } else if (cellStyle.fill && typeof cellStyle.fill === 'object') {
      const fill = cellStyle.fill
      if (fill.fgColor) {
        if (typeof fill.fgColor === 'object') {
          backgroundColor = fill.fgColor.argb || fill.fgColor.rgb || fill.fgColor.value || null
        } else if (typeof fill.fgColor === 'string') {
          backgroundColor = fill.fgColor
        }
      }
    }

    let fontColor = 'black'
    const pickFontColor = (input) => {
      let fColor = input
      if (typeof fColor === 'object' && fColor !== null) {
        fColor = fColor.rgb || fColor.argb || fColor.value || null
      }
      if (typeof fColor === 'string' && fColor !== '' && fColor !== null && fColor !== undefined) {
        if (!fColor.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(fColor)) {
          fColor = '#' + fColor
        }
        return fColor
      }
      return null
    }
    const conditionalFont = pickFontColor(conditionalFormat?.fontColor || conditionalFormat?.color)
    const styleFont = pickFontColor(cellStyle.fontColor)
    if (conditionalFont) {
      fontColor = conditionalFont
    } else if (styleFont) {
      fontColor = styleFont
    }

    const finalStyle = {
      color: fontColor || 'black',
      fontWeight: (conditionalFormat?.bold !== undefined ? conditionalFormat.bold : cellStyle.bold) ? 'bold' : 'normal',
      fontStyle: (conditionalFormat?.italic !== undefined ? conditionalFormat.italic : cellStyle.italic) ? 'italic' : 'normal',
      textAlign: conditionalFormat?.horizontalAlignment || cellStyle.horizontalAlignment || 'left',
      fontSize: conditionalFormat?.fontSize ? `${conditionalFormat.fontSize}px` : (cellStyle.fontSize ? `${cellStyle.fontSize}px` : '13px')
    }

    if (conditionalFormat?.underline) {
      finalStyle.textDecoration = 'underline'
    } else if (conditionalFormat?.strikethrough) {
      finalStyle.textDecoration = 'line-through'
    } else if (cellStyle.underline) {
      finalStyle.textDecoration = 'underline'
    } else if (cellStyle.strikethrough) {
      finalStyle.textDecoration = 'line-through'
    }

    // 只在有明确背景色时写 inline style（非白色才覆盖 CSS 默认）
    const isWhite = (c) => !c || c === 'white' || c === '#ffffff' || c === '#fff' || c === '#FFFFFF' || c === '#FFFFFFFF'
    if (backgroundColor && !isWhite(backgroundColor)) {
      finalStyle.backgroundColor = backgroundColor
      finalStyle['--cell-bg-color'] = backgroundColor
      finalStyle.background = backgroundColor
    }

    // ------------------------------------
    // 边框样式渲染：直接使用 border CSS 属性，视觉权重清晰
    // 数据层已对所有选中单元格存储四边，无需依赖邻居绘线
    // ------------------------------------
    if (cellStyle.border) {
      const border = cellStyle.border
      const normColor = (raw) => {
        let c = raw
        if (typeof c === 'object' && c !== null) c = c.argb || c.rgb || c.value
        if (typeof c === 'string' && !c.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(c)) c = `#${c}`
        return c || '#000000'
      }
      const styleMap = { thin: '1px solid', medium: '2px solid', thick: '3px solid', double: '3px double', dashed: '1px dashed', dotted: '1px dotted' }
      const mkBorder = (side) => {
        if (!side?.style) return null
        const color = normColor(side.color)
        return `${styleMap[side.style] || '1px solid'} ${color}`
      }
      const bTop = mkBorder(border.top)
      const bBottom = mkBorder(border.bottom)
      const bLeft = mkBorder(border.left)
      const bRight = mkBorder(border.right)
      if (bTop)    finalStyle.borderTop    = bTop
      if (bBottom) finalStyle.borderBottom = bBottom
      if (bLeft)   finalStyle.borderLeft   = bLeft
      if (bRight)  finalStyle.borderRight  = bRight
    }

    if (isEditing) {
      return (
        <div
          key={`${row}-${col}`}
          className="excel-cell editing"
          contentEditable
          suppressContentEditableWarning
          onBlur={(e) => {
            onCellChange(row, col, e.target.textContent)
            onEditingCellChange(null)
          }}
          onKeyDown={(e) => handleCellKeyDown(e, row, col)}
          dangerouslySetInnerHTML={{ __html: getCellEditValue(cell) }}
        />
      )
    }

    // backgroundColor 已在上方 isWhite 判断后只保留非白色值
    const hasCustomBg = !!backgroundColor && !isWhite(backgroundColor)
    const hasUserBorder = !!(cellStyle.border && (
      cellStyle.border.top?.style || cellStyle.border.bottom?.style ||
      cellStyle.border.left?.style || cellStyle.border.right?.style
    ))
    const cellClassName = [
      'excel-cell',
      isSelected ? 'selected' : '',
      hasCustomBg ? 'has-custom-bg' : '',
      hasUserBorder ? 'has-user-border' : ''
    ].filter(Boolean).join(' ')

    // has-custom-bg 通过 CSS var 双保险（selected 态 !important 覆盖选区色）
    if (hasCustomBg) {
      finalStyle.backgroundColor = backgroundColor
      finalStyle.background = backgroundColor
      finalStyle['--cell-bg-color'] = backgroundColor
    }

    return (
      <div
        key={`${row}-${col}`}
        className={cellClassName}
        onClick={() => handleCellClick(row, col)}
        onDoubleClick={() => handleCellDoubleClick(row, col)}
        onMouseDown={(e) => handleCellMouseDown(e, row, col)}
        style={finalStyle}
        onMouseEnter={(e) => {
          if (hasCustomBg) {
            e.currentTarget.style.setProperty('background-color', backgroundColor, 'important')
            e.currentTarget.style.setProperty('background', backgroundColor, 'important')
          }
        }}
        onMouseLeave={(e) => {
          if (hasCustomBg) {
            e.currentTarget.style.setProperty('background-color', backgroundColor, 'important')
            e.currentTarget.style.setProperty('background', backgroundColor, 'important')
          }
        }}
      >
        {getCellDisplay(cell)}
      </div>
    )
  }, [
    selection,
    editingCell,
    sheet,
    checkConditionalFormat,
    handleCellClick,
    handleCellDoubleClick,
    handleCellKeyDown,
    handleCellMouseDown,
    onCellChange,
    onEditingCellChange,
    getCellDisplay,
    getCellEditValue
  ])

  const gridItems = useMemo(() => {
    const items = []
    const hiddenRows = sheet?.hiddenRows || []

    items.push(<div key="corner" className="excel-corner"></div>)
    for (let col = 1; col <= displayCols; col++) {
      items.push(
        <div key={`header-${col}`} className="excel-header">
          {toExcelColumnName(col)}
        </div>
      )
    }

    const buffer = 10
    const startRow = Math.max(1, visibleRows.start - buffer)
    const endRow = Math.min(displayRows, visibleRows.end + buffer)
    const startCol = Math.max(1, visibleCols.start - buffer)
    const endCol = Math.min(displayCols, visibleCols.end + buffer)

    for (let row = 1; row <= displayRows; row++) {
      const isRowHidden = hiddenRows.includes(row)
      items.push(
        <div
          key={`row-header-${row}`}
          className="excel-row-header"
          style={{
            display: isRowHidden ? 'none' : 'flex',
            visibility: row >= startRow && row <= endRow ? 'visible' : 'hidden'
          }}
        >
          {row}
        </div>
      )
      for (let col = 1; col <= displayCols; col++) {
        const cellKey = `cell-${row}-${col}`
        const shouldRender = row >= startRow && row <= endRow && col >= startCol && col <= endCol
        if (!shouldRender) {
          items.push(
            <div key={cellKey} className="excel-cell" style={{ visibility: 'hidden' }} />
          )
          continue
        }
        const cellElement = renderCell(row, col)
        if (isRowHidden) {
          items.push(
            <div key={cellKey} style={{ display: 'none' }}>
              {cellElement}
            </div>
          )
        } else {
          items.push(cellElement)
        }
      }
    }

    return items
  }, [displayCols, displayRows, renderCell, sheet?.hiddenRows, visibleCols, visibleRows])

  return { gridItems }
}
