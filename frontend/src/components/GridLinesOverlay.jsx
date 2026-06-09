// frontend/src/components/GridLinesOverlay.jsx
/**
 * ===================================
 * 网格线叠加层
 * - 行分隔线：SVG 绘制，覆盖全网格（虚拟化时 CSS border-bottom 无法覆盖无 DOM 的行）
 * - 竖线：SVG 绘制
 * - pointer-events: none，不阻挡交互
 * ===================================
 */
import React from 'react'

const LINE_COLOR = 'rgba(128, 128, 128, 0.25)'

export default function GridLinesOverlay({
  gridWidth,
  gridHeight,
  headerWidth,
  headerHeight,
  rowOffsets,
  rowHeights,
  colOffsets,
  colWidths,
  displayRows,
  displayCols
}) {
  if (!rowOffsets || !rowHeights || !colOffsets || !colWidths || displayRows < 1 || displayCols < 1) {
    return null
  }

  const lines = []

  for (let r = 1; r <= displayRows; r++) {
    const rh = rowHeights[r] || 0
    const by = headerHeight + (rowOffsets[r] || 0) + rh
    lines.push(
      <line
        key={`h-${r}`}
        x1={headerWidth}
        y1={by}
        x2={gridWidth}
        y2={by}
        stroke={LINE_COLOR}
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    )
  }
  const lastBy = displayRows >= 1
    ? headerHeight + (rowOffsets[displayRows] || 0) + (rowHeights[displayRows] || 0)
    : -1
  if (displayRows >= 1 && gridHeight > headerHeight && Math.abs(gridHeight - lastBy) > 1) {
    lines.push(
      <line
        key="h-bottom"
        x1={headerWidth}
        y1={Math.max(headerHeight, gridHeight - 0.5)}
        x2={gridWidth}
        y2={Math.max(headerHeight, gridHeight - 0.5)}
        stroke={LINE_COLOR}
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    )
  }

  for (let c = 1; c <= displayCols; c++) {
    const cw = colWidths[c] || 0
    const rx = headerWidth + (colOffsets[c] || 0) + cw
    lines.push(
      <line
        key={`v-${c}`}
        x1={rx}
        y1={headerHeight}
        x2={rx}
        y2={gridHeight}
        stroke={LINE_COLOR}
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    )
  }

  return (
    <svg
      width={gridWidth}
      height={gridHeight}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 2
      }}
      preserveAspectRatio="none"
    >
      {lines}
    </svg>
  )
}
