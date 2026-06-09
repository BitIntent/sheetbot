// frontend/src/components/SelectionOverlay.jsx
/**
 * ===================================
 * 选区绘制组件
 * - 独立渲染选区层
 * ===================================
 */
import React from 'react'

function SelectionOverlay({
  selection,
  cellWidth,
  cellHeight,
  headerWidth,
  headerHeight,
  colOffsets,
  colWidths,
  rowOffsets,
  rowHeights
}) {
  if (!selection) return null
  const { startRow, startCol, endRow, endCol, extraCells = [] } = selection
  if (!startRow || !startCol || !endRow || !endCol) return null

  const buildRect = (sr, sc, er, ec) => {
    const topOffset = rowOffsets?.[sr] ?? (sr - 1) * cellHeight
    const endOffset = rowOffsets?.[er] ?? (er - 1) * cellHeight
    const endHeight = rowHeights?.[er] ?? cellHeight
    const leftOffset = colOffsets?.[sc] ?? (sc - 1) * cellWidth
    const endLeftOffset = colOffsets?.[ec] ?? (ec - 1) * cellWidth
    const endWidth = colWidths?.[ec] ?? cellWidth
    return {
      top: `${headerHeight + topOffset}px`,
      left: `${headerWidth + leftOffset}px`,
      width: `${(endLeftOffset - leftOffset) + endWidth}px`,
      height: `${(endOffset - topOffset) + endHeight}px`
    }
  }

  return (
    <>
      <div className="excel-selection" style={buildRect(startRow, startCol, endRow, endCol)} />
      {extraCells.map(({ row, col }) => (
        <div
          key={`extra-${row}-${col}`}
          className="excel-selection extra"
          style={buildRect(row, col, row, col)}
        />
      ))}
    </>
  )
}

export default SelectionOverlay
