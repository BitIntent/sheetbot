// frontend/src/hooks/useGridLayout.js
/**
 * ===================================
 * 网格布局 Hook
 * - 计算可视区域（同步响应滚动）
 * - 计算网格宽高
 * ===================================
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const createRange = (start, end) => ({ start, end })

const clamp = (value, min, max) => {
  return Math.max(min, Math.min(max, value))
}

const calcVisibleRange = (scrollOffset, viewSize, itemSize, maxItems, buffer) => {
  const startIndex = Math.floor(scrollOffset / itemSize) + 1
  const visibleCount = Math.ceil(viewSize / itemSize)
  const start = clamp(startIndex - buffer, 1, maxItems)
  const end = clamp(startIndex + visibleCount + buffer, 1, maxItems)
  return createRange(start, end)
}

const findColByOffset = (colOffsets, colWidths, x, maxCols) => {
  if (!colOffsets || !colWidths) return 1
  if (x <= 0) return 1
  let low = 1
  let high = maxCols
  let result = 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (colOffsets[mid] <= x) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return Math.min(result, maxCols)
}

const calcVisibleRangeWithColOffsets = (scrollLeft, viewSize, colOffsets, colWidths, maxCols, buffer) => {
  const startIndex = findColByOffset(colOffsets, colWidths, scrollLeft, maxCols)
  const endIndex = findColByOffset(colOffsets, colWidths, scrollLeft + viewSize, maxCols)
  const start = clamp(startIndex - buffer, 1, maxCols)
  const end = clamp(endIndex + buffer, 1, maxCols)
  return createRange(start, end)
}

const findRowByOffset = (rowOffsets, rowHeights, y, maxRows) => {
  if (!rowOffsets || !rowHeights) return 1
  if (y <= 0) return 1
  let low = 1
  let high = maxRows
  let result = 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (rowOffsets[mid] <= y) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  while (result <= maxRows && rowHeights[result] === 0) {
    result += 1
  }
  return Math.min(result, maxRows)
}

const calcVisibleRangeWithOffsets = (scrollTop, viewSize, rowOffsets, rowHeights, maxRows, buffer) => {
  const startIndex = findRowByOffset(rowOffsets, rowHeights, scrollTop, maxRows)
  const endIndex = findRowByOffset(rowOffsets, rowHeights, scrollTop + viewSize, maxRows)
  const start = clamp(startIndex - buffer, 1, maxRows)
  const end = clamp(endIndex + buffer, 1, maxRows)
  return createRange(start, end)
}

// 范围是否相等（避免无意义 setState 触发重渲染）
const rangeEqual = (a, b) => a.start === b.start && a.end === b.end

export function useGridLayout({
  containerRef,
  displayRows,
  displayCols,
  cellWidth,
  cellHeight,
  headerWidth,
  headerHeight,
  colOffsets,
  colWidths,
  rowOffsets,
  rowHeights,
  totalRowsHeight,
  totalColsWidth,
  drawFrame,
  useCanvasScrollMode = true,
  canvasSettleDelayMs = 90,
  buffer = 5
}) {
  const [visibleRows, setVisibleRows] = useState(createRange(1, 50))
  const [visibleCols, setVisibleCols] = useState(createRange(1, 26))
  const prevRowsRef = useRef(visibleRows)
  const prevColsRef = useRef(visibleCols)
  const settleTimerRef = useRef(null)
  const rafRef = useRef(null)

  const gridWidth = headerWidth + (totalColsWidth ?? (displayCols * cellWidth))
  const gridHeight = headerHeight + (totalRowsHeight ?? (displayRows * cellHeight))

  const updateVisible = useCallback((scrollTop, scrollLeft, clientWidth, clientHeight) => {
    const nextRows = rowOffsets && rowHeights
      ? calcVisibleRangeWithOffsets(scrollTop, clientHeight, rowOffsets, rowHeights, displayRows, buffer)
      : calcVisibleRange(scrollTop, clientHeight, cellHeight, displayRows, buffer)
    const nextCols = colOffsets && colWidths
      ? calcVisibleRangeWithColOffsets(scrollLeft, clientWidth, colOffsets, colWidths, displayCols, buffer)
      : calcVisibleRange(scrollLeft, clientWidth, cellWidth, displayCols, buffer)
    // 仅范围实际改变时才 setState，避免无效渲染
    if (!rangeEqual(nextRows, prevRowsRef.current)) {
      prevRowsRef.current = nextRows
      setVisibleRows(nextRows)
    }
    if (!rangeEqual(nextCols, prevColsRef.current)) {
      prevColsRef.current = nextCols
      setVisibleCols(nextCols)
    }
  }, [buffer, cellHeight, cellWidth, displayCols, displayRows, rowHeights, rowOffsets, colOffsets, colWidths])

  // [perf] 同步响应滚动 — 消除 RAF 的 1 帧延迟
  // 浏览器 scroll 事件已天然对齐帧率，无需额外节流
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const scrollTop = container.scrollTop
    const scrollLeft = container.scrollLeft
    const clientWidth = container.clientWidth
    const clientHeight = container.clientHeight

    if (!useCanvasScrollMode) {
      updateVisible(scrollTop, scrollLeft, clientWidth, clientHeight)
      return
    }

    // 滚动期间：Canvas 先行，DOM 更新延后到停滚，避免 React 重排风暴
    const canvasDrawn = drawFrame?.(scrollTop, scrollLeft, clientWidth, clientHeight, true) === true
    if (!canvasDrawn) {
      updateVisible(scrollTop, scrollLeft, clientWidth, clientHeight)
      return
    }

    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(() => {
      drawFrame?.(container.scrollTop, container.scrollLeft, container.clientWidth, container.clientHeight, false)
      updateVisible(container.scrollTop, container.scrollLeft, container.clientWidth, container.clientHeight)
    }, canvasSettleDelayMs)

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
      })
    }
  }, [updateVisible, containerRef, drawFrame, canvasSettleDelayMs, useCanvasScrollMode])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    drawFrame?.(container.scrollTop, container.scrollLeft, container.clientWidth, container.clientHeight, false)
    updateVisible(container.scrollTop, container.scrollLeft, container.clientWidth, container.clientHeight)
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [updateVisible, containerRef, drawFrame])

  return {
    gridWidth,
    gridHeight,
    visibleRows,
    visibleCols,
    handleScroll
  }
}
