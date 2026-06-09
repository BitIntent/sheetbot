// frontend/src/hooks/useDragSelection.js
/**
 * ================================
 * 拖拽选区 Hook
 * - 鼠标拖动选择多单元格
 * - 计算坐标映射到行列
 * ================================
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export function useDragSelection({
  containerRef,
  displayRows,
  displayCols,
  onSelectionChange,
  onDragEnd,  // 新增：拖拽结束回调
  editingCell,
  cellWidth,
  cellHeight,
  headerWidth,
  headerHeight,
  colOffsets,
  colWidths,
  rowOffsets,
  rowHeights
}) {
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef(null)
  const dragRafRef = useRef(null)
  const autoScrollRafRef = useRef(null)
  const pointerRef = useRef({ x: 0, y: 0 })

  const normalizeSelection = useCallback((start, end) => {
    if (!start || !end) return null
    return {
      startRow: Math.min(start.row, end.row),
      startCol: Math.min(start.col, end.col),
      endRow: Math.max(start.row, end.row),
      endCol: Math.max(start.col, end.col)
    }
  }, [])

  const findRowByOffset = useCallback((y) => {
    if (!rowOffsets || !rowHeights) {
      return Math.floor((y - headerHeight) / cellHeight) + 1
    }
    const targetY = y - headerHeight
    if (targetY <= 0) return 1
    let low = 1
    let high = displayRows
    let result = 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (rowOffsets[mid] <= targetY) {
        result = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    while (result <= displayRows && rowHeights[result] === 0) {
      result += 1
    }
    return Math.min(result, displayRows)
  }, [cellHeight, displayRows, headerHeight, rowHeights, rowOffsets])

  const findColByOffset = useCallback((x) => {
    if (!colOffsets || !colWidths) {
      return Math.floor((x - headerWidth) / cellWidth) + 1
    }
    const targetX = x - headerWidth
    if (targetX <= 0) return 1
    let low = 1
    let high = displayCols
    let result = 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (colOffsets[mid] <= targetX) {
        result = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return Math.min(result, displayCols)
  }, [cellWidth, colOffsets, colWidths, displayCols, headerWidth])

  const getCellFromPoint = useCallback((clientX, clientY) => {
    const container = containerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    const x = clientX - rect.left + container.scrollLeft
    const y = clientY - rect.top + container.scrollTop
    const colIndex = findColByOffset(x)
    const rowIndex = findRowByOffset(y)
    if (colIndex < 1 || rowIndex < 1) return null
    return {
      row: Math.max(1, Math.min(displayRows, rowIndex)),
      col: Math.max(1, Math.min(displayCols, colIndex))
    }
  }, [containerRef, displayCols, displayRows, findColByOffset, findRowByOffset])

  const updateSelectionByPointer = useCallback((clientX, clientY) => {
    const start = dragStartRef.current
    if (!start) return
    const target = getCellFromPoint(clientX, clientY)
    if (!target) return
    const nextSelection = normalizeSelection(start, target)
    if (!nextSelection) return
    onSelectionChange(nextSelection)
  }, [getCellFromPoint, normalizeSelection, onSelectionChange])

  const handleMouseDown = useCallback((e, row, col) => {
    if (editingCell) return
    // 右键点击不触发拖拽选择，保持当前选择
    if (e.button === 2) return
    // Ctrl/Cmd 点击用于多选，不进入拖拽选区
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    dragStartRef.current = { row, col }
    pointerRef.current = { x: e.clientX, y: e.clientY }
    setIsDragging(true)
    document.body.classList.add('excel-no-select')
    onSelectionChange({ startRow: row, startCol: col, endRow: row, endCol: col })
  }, [editingCell, onSelectionChange])

  const handleMouseMove = useCallback((e) => {
    if (!isDragging || !dragStartRef.current) return
    pointerRef.current = { x: e.clientX, y: e.clientY }
    if (dragRafRef.current) return
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null
      updateSelectionByPointer(e.clientX, e.clientY)
    })
  }, [isDragging, updateSelectionByPointer])

  useEffect(() => {
    if (!isDragging) return
    const handleWindowMove = (e) => {
      handleMouseMove(e)
    }
    window.addEventListener('mousemove', handleWindowMove)
    return () => window.removeEventListener('mousemove', handleWindowMove)
  }, [handleMouseMove, isDragging])

  useEffect(() => {
    if (!isDragging) return
    const container = containerRef.current
    if (!container) return

    const threshold = 24
    const maxStep = 22

    const tick = () => {
      autoScrollRafRef.current = null
      const el = containerRef.current
      if (!el || !dragStartRef.current) return

      const { x, y } = pointerRef.current
      const rect = el.getBoundingClientRect()
      let dx = 0
      let dy = 0

      if (x < rect.left + threshold) {
        dx = -Math.min(maxStep, Math.ceil((rect.left + threshold - x) / 3))
      } else if (x > rect.right - threshold) {
        dx = Math.min(maxStep, Math.ceil((x - (rect.right - threshold)) / 3))
      }

      if (y < rect.top + threshold) {
        dy = -Math.min(maxStep, Math.ceil((rect.top + threshold - y) / 3))
      } else if (y > rect.bottom - threshold) {
        dy = Math.min(maxStep, Math.ceil((y - (rect.bottom - threshold)) / 3))
      }

      if (dx !== 0 || dy !== 0) {
        const prevLeft = el.scrollLeft
        const prevTop = el.scrollTop
        el.scrollLeft = Math.max(0, prevLeft + dx)
        el.scrollTop = Math.max(0, prevTop + dy)
        if (el.scrollLeft !== prevLeft || el.scrollTop !== prevTop) {
          updateSelectionByPointer(x, y)
        }
      }

      if (isDragging) {
        autoScrollRafRef.current = requestAnimationFrame(tick)
      }
    }

    autoScrollRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (autoScrollRafRef.current) {
        cancelAnimationFrame(autoScrollRafRef.current)
        autoScrollRafRef.current = null
      }
    }
  }, [containerRef, isDragging, updateSelectionByPointer])

  useEffect(() => {
    const handleMouseUp = () => {
      if (!isDragging) return
      setIsDragging(false)
      dragStartRef.current = null
      document.body.classList.remove('excel-no-select')
      // 拖拽结束后调用回调（用于格式刷等功能）
      if (onDragEnd) {
        onDragEnd()
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [isDragging, onDragEnd])

  useEffect(() => {
    return () => {
      if (dragRafRef.current) {
        cancelAnimationFrame(dragRafRef.current)
      }
      if (autoScrollRafRef.current) {
        cancelAnimationFrame(autoScrollRafRef.current)
      }
      document.body.classList.remove('excel-no-select')
    }
  }, [])

  return {
    isDragging,
    handleMouseDown,
    handleMouseMove
  }
}
