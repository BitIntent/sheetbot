// frontend/src/components/ExcelEditor.jsx
import React, { useRef, useCallback, useMemo, useEffect, useState, useLayoutEffect } from 'react'
import { useDragSelection } from '../hooks/useDragSelection'
import { useCellRender } from '../hooks/useCellRender'
import { useGridLayout } from '../hooks/useGridLayout'
import SelectionOverlay from './SelectionOverlay'
import GridLinesOverlay from './GridLinesOverlay'
import { useChartRender } from '../hooks/useChartRender.jsx'
import { useGridItemsBuilder } from '../hooks/useGridItemsBuilder.jsx'
import { useCanvasBackdrop } from '../hooks/useCanvasBackdrop'
import { evaluateFormula } from '../utils/formulaEngine'

// ============================================================================
// 表格组件
// ============================================================================
// 默认行数和列数（工作表初始化基线）
const DEFAULT_ROWS = 500
const DEFAULT_COLS = 26
const CELL_WIDTH = 100
const CELL_HEIGHT = 25
const HEADER_WIDTH = 40
const HEADER_HEIGHT = 30

const SHEET_THEME_MAP = {
  'sheetbot-dark': { cellBg: '#1F232A', textColor: '#E5E7EB' },
  'excel-classic': { cellBg: '#FFFFFF', textColor: '#111111' },
  'glacier-blue': { cellBg: '#F4F8FF', textColor: '#0F2747' },
  'mint-contrast': { cellBg: '#F2FBF7', textColor: '#113D2E' },
  'oled-night': { cellBg: '#000000', textColor: '#F5F7FA' },
}

const EMPTY_ROWS = []

const ExcelEditor = React.forwardRef(({
  workbook,
  activeSheet,
  selection,
  onSelectionChange,
  onCellChange,
  onRowHeightChange,
  onColWidthChange,
  onInsertRow,
  onDeleteRow,
  onInsertCol,
  onDeleteCol,
  editingCell,
  onEditingCellChange,
  formatBrushActive,
  onApplyFormatBrush,
  onCopy,
  onPaste,
  canPaste = false,
  readOnly = false,
  zoom = 1,
  customFormulas: externalFormulas = [],
  sheetTheme = 'sheetbot-dark',
}, ref) => {
  const safeZoom = (() => {
    const z = Number(zoom)
    if (!Number.isFinite(z)) return 1
    return Math.max(0.6, Math.min(2.0, z))
  })()

  const CELL_W = CELL_WIDTH * safeZoom
  const CELL_H = CELL_HEIGHT * safeZoom
  const HEADER_W = HEADER_WIDTH * safeZoom
  const HEADER_H = HEADER_HEIGHT * safeZoom

  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const editingRef = useRef(null)
  const pendingEditInputRef = useRef(null)
  const headerDragRef = useRef(null)
  const resizeRef = useRef(null)
  const contextMenuRef = useRef(null)
  const anchorCellRef = useRef({ row: 1, col: 1 })  // Shift+点击的锚点单元格
  const [contextMenu, setContextMenu] = useState(null)
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 })
  // [perf] 拖拽列宽/行高时的本地预览状态，避免每帧 mousemove 都触发 App.jsx setWorkbook
  const [dragPreview, setDragPreview] = useState(null) // { type:'col'|'row', index, size } | null

  // 公式列表由外部 prop 注入（App.jsx 从 API 加载）
  const customFormulas = externalFormulas
  
  const sheet = workbook.sheets.find(s => s.name === activeSheet) || workbook.sheets[0]
  const activeTheme = SHEET_THEME_MAP[sheetTheme] || SHEET_THEME_MAP['sheetbot-dark']
  const enableCanvasScrollOptimize = true
  // 始终启用 Canvas 背板，确保普通视图与我要分析视图的行分隔线一致渲染

  // [perf] 用 useMemo 保护行列数计算，避免每次渲染都遍历 sheet.data（O(rows×cols)）
  const { actualRowCount, actualColCount } = useMemo(() => {
    let rowCount = DEFAULT_ROWS
    let colCount = DEFAULT_COLS
    if (sheet?.data && Object.keys(sheet.data).length > 0) {
      const rowNumbers = Object.keys(sheet.data).map(Number).filter(Number.isFinite)
      if (rowNumbers.length > 0) rowCount = Math.max(...rowNumbers, DEFAULT_ROWS)
      let maxCol = DEFAULT_COLS
      Object.values(sheet.data).forEach(rowData => {
        if (rowData && typeof rowData === 'object') {
          const cols = Object.keys(rowData).map(Number).filter(Number.isFinite)
          if (cols.length > 0) maxCol = Math.max(maxCol, ...cols)
        }
      })
      colCount = maxCol
    } else if (sheet?.rowCount) {
      rowCount = DEFAULT_ROWS
    } else if (sheet?.colCount) {
      colCount = sheet.colCount
    }
    return { actualRowCount: rowCount, actualColCount: colCount }
  }, [sheet?.data, sheet?.rowCount, sheet?.colCount])

  const displayRows = actualRowCount
  const displayCols = actualColCount
  
  const hiddenRows = useMemo(() => sheet?.hiddenRows ?? EMPTY_ROWS, [sheet?.hiddenRows])
  const hiddenRowSet = useMemo(() => new Set(hiddenRows), [hiddenRows])
  const colWidths = useMemo(() => {
    const widths = new Array(displayCols + 1)
    const custom = sheet?.colWidths || {}
    for (let col = 1; col <= displayCols; col++) {
      const base = Number(custom[col] ?? CELL_WIDTH)
      widths[col] = (Number.isFinite(base) ? base : CELL_WIDTH) * safeZoom
    }
    // [perf] 拖拽预览：覆盖当前拖拽列的宽度，不触及 workbook
    if (dragPreview?.type === 'col') widths[dragPreview.index] = dragPreview.size
    return widths
  }, [displayCols, sheet?.colWidths, safeZoom, dragPreview])
  const rowHeights = useMemo(() => {
    const heights = new Array(displayRows + 1)
    const custom = sheet?.rowHeights || {}
    for (let row = 1; row <= displayRows; row++) {
      const base = Number(custom[row] ?? CELL_HEIGHT)
      heights[row] = hiddenRowSet.has(row) ? 0 : ((Number.isFinite(base) ? base : CELL_HEIGHT) * safeZoom)
    }
    // [perf] 拖拽预览：覆盖当前拖拽行的高度，不触及 workbook
    if (dragPreview?.type === 'row') heights[dragPreview.index] = dragPreview.size
    return heights
  }, [displayRows, hiddenRowSet, sheet?.rowHeights, safeZoom, dragPreview])
  const colOffsets = useMemo(() => {
    const offsets = new Array(displayCols + 1)
    let acc = 0
    for (let col = 1; col <= displayCols; col++) {
      offsets[col] = acc
      acc += colWidths[col]
    }
    return offsets
  }, [displayCols, colWidths])
  const rowOffsets = useMemo(() => {
    const offsets = new Array(displayRows + 1)
    let acc = 0
    for (let row = 1; row <= displayRows; row++) {
      offsets[row] = acc
      acc += rowHeights[row]
    }
    return offsets
  }, [displayRows, rowHeights])
  const totalRowsHeight = useMemo(() => {
    const lastHeight = rowHeights[displayRows] || 0
    return (rowOffsets[displayRows] || 0) + lastHeight
  }, [displayRows, rowHeights, rowOffsets])
  const totalColsWidth = useMemo(() => {
    const lastWidth = colWidths[displayCols] || 0
    return (colOffsets[displayCols] || 0) + lastWidth
  }, [colOffsets, colWidths, displayCols])

  const drawFrameRef = useRef(null)
  const canvasSettleDelayRef = useRef(90)

  const bridgeDrawFrame = useCallback((scrollTop, scrollLeft, vw, vh, fastMode = false) => {
    drawFrameRef.current?.(scrollTop, scrollLeft, vw, vh, fastMode)
  }, [])

  const {
    gridWidth,
    gridHeight,
    visibleRows,
    visibleCols,
    handleScroll
  } = useGridLayout({
    containerRef,
    displayRows,
    displayCols,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    colOffsets,
    colWidths,
    rowOffsets,
    rowHeights,
    totalRowsHeight,
    totalColsWidth,
    useCanvasScrollMode: enableCanvasScrollOptimize,
    drawFrame: bridgeDrawFrame,
    canvasSettleDelayMs: canvasSettleDelayRef.current,
    buffer: 5
  })
  
  // 让滚动中的网格保持旧内容，避免“先空白后填充”
  // [perf] 直接使用最新可视范围，RAF 节流已保证帧率
  
  const handleCellClick = useCallback((row, col, e) => {
    // 先更新选区
    if (e && (e.ctrlKey || e.metaKey)) {
      const toKey = (r, c) => `${r}:${c}`
      const fromKey = (k) => {
        const [r, c] = String(k).split(':').map(Number)
        return { row: r, col: c }
      }

      const selectedSet = new Set([
        toKey(selection.startRow, selection.startCol),
        ...((selection.extraCells || []).map(({ row: r, col: c }) => toKey(r, c)))
      ])
      const clickedKey = toKey(row, col)
      if (selectedSet.has(clickedKey)) selectedSet.delete(clickedKey)
      else selectedSet.add(clickedKey)

      if (selectedSet.size === 0) {
        onSelectionChange({ startRow: row, startCol: col, endRow: row, endCol: col, extraCells: [] })
      } else {
        const currentPrimary = toKey(selection.startRow, selection.startCol)
        const primaryKey = selectedSet.has(currentPrimary)
          ? currentPrimary
          : (selectedSet.has(clickedKey) ? clickedKey : Array.from(selectedSet)[0])
        const primary = fromKey(primaryKey)
        const extras = Array.from(selectedSet)
          .filter(k => k !== primaryKey)
          .map(fromKey)
        onSelectionChange({
          startRow: primary.row,
          startCol: primary.col,
          endRow: primary.row,
          endCol: primary.col,
          extraCells: extras
        })
      }

      anchorCellRef.current = { row, col }
      return
    }

    if (e && e.shiftKey) {
      // Shift+点击：从锚点单元格到当前单元格的范围选择
      const anchor = anchorCellRef.current
      onSelectionChange({
        startRow: Math.min(anchor.row, row),
        startCol: Math.min(anchor.col, col),
        endRow: Math.max(anchor.row, row),
        endCol: Math.max(anchor.col, col),
        extraCells: []
      })
      // Shift+点击后应用格式刷
      if (formatBrushActive && onApplyFormatBrush) {
        setTimeout(() => onApplyFormatBrush(), 0)
      }
    } else {
      // 普通点击：选中单个单元格，并更新锚点
      anchorCellRef.current = { row, col }
      onSelectionChange({ startRow: row, startCol: col, endRow: row, endCol: col, extraCells: [] })
      // 单击后应用格式刷（单个单元格）
      if (formatBrushActive && onApplyFormatBrush) {
        setTimeout(() => onApplyFormatBrush(), 0)
      }
    }
  }, [onSelectionChange, formatBrushActive, onApplyFormatBrush, selection])
  
  const handleCellDoubleClick = useCallback((row, col) => {
    if (readOnly) return
    const currentCell = sheet?.data?.[row]?.[col]
    if (currentCell?.image?.src) return
    // 双击时也更新锚点
    anchorCellRef.current = { row, col }
    onSelectionChange({ startRow: row, startCol: col, endRow: row, endCol: col })
    onEditingCellChange({ row, col })
  }, [onEditingCellChange, onSelectionChange, readOnly, sheet?.data])

  useEffect(() => {
    if (!editingCell) return
    const el = editingRef.current
    if (!el) return
    el.focus()
    if (pendingEditInputRef.current !== null && pendingEditInputRef.current !== undefined) {
      el.textContent = pendingEditInputRef.current
      pendingEditInputRef.current = null
    }
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, [editingCell])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (editingCell) return
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey

      // 单元格已选中时，直接键入可进入编辑态（无需双击）
      const isSingleCellSelection =
        selection.startRow === selection.endRow &&
        selection.startCol === selection.endCol
      const isPrintableKey = e.key && e.key.length === 1
      const isImeProcessKey = e.key === 'Process'
      if (
        !readOnly &&
        isSingleCellSelection &&
        !hasModifier &&
        (isPrintableKey || isImeProcessKey)
      ) {
        e.preventDefault()
        pendingEditInputRef.current = isPrintableKey ? e.key : ''
        onEditingCellChange({ row: selection.startRow, col: selection.startCol })
        return
      }

      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (readOnly) return
      e.preventDefault()
      const { startRow, startCol, endRow, endCol } = selection
      const touched = new Set()
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          touched.add(`${row}:${col}`)
          onCellChange(row, col, '')
        }
      }
      ;(selection.extraCells || []).forEach(({ row, col }) => {
        const key = `${row}:${col}`
        if (touched.has(key)) return
        onCellChange(row, col, '')
      })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingCell, onCellChange, onEditingCellChange, selection, readOnly])

  const handleRowHeaderClick = useCallback((row, e) => {
    // 如果按了 Ctrl/Cmd，支持多选
    if (e && (e.ctrlKey || e.metaKey)) {
      // 检查当前选择是否是整行选择
      const isFullRowSelection = selection.startCol === 1 && selection.endCol === displayCols
      
      if (isFullRowSelection) {
        // 扩展选择范围以包含当前行
        const newStartRow = Math.min(selection.startRow, row)
        const newEndRow = Math.max(selection.endRow, row)
        onSelectionChange({
          startRow: newStartRow,
          startCol: 1,
          endRow: newEndRow,
          endCol: displayCols,
          extraCells: []
        })
      } else {
        // 当前不是整行选择，切换到整行选择并包含当前行
        onSelectionChange({
          startRow: row,
          startCol: 1,
          endRow: row,
          endCol: displayCols,
          extraCells: []
        })
      }
    } else {
      // 普通点击，选中单行
      onSelectionChange({
        startRow: row,
        startCol: 1,
        endRow: row,
        endCol: displayCols,
        extraCells: []
      })
    }
  }, [displayCols, onSelectionChange, selection])

  const handleColHeaderClick = useCallback((col, e) => {
    // 如果按了 Ctrl/Cmd，支持多选
    if (e && (e.ctrlKey || e.metaKey)) {
      // 检查当前选择是否是整列选择
      const isFullColSelection = selection.startRow === 1 && selection.endRow === displayRows
      
      if (isFullColSelection) {
        // 扩展选择范围以包含当前列
        const newStartCol = Math.min(selection.startCol, col)
        const newEndCol = Math.max(selection.endCol, col)
        onSelectionChange({
          startRow: 1,
          startCol: newStartCol,
          endRow: displayRows,
          endCol: newEndCol,
          extraCells: []
        })
      } else {
        // 当前不是整列选择，切换到整列选择并包含当前列
        onSelectionChange({
          startRow: 1,
          startCol: col,
          endRow: displayRows,
          endCol: col,
          extraCells: []
        })
      }
    } else {
      // 普通点击，选中单列
      onSelectionChange({
        startRow: 1,
        startCol: col,
        endRow: displayRows,
        endCol: col,
        extraCells: []
      })
    }
  }, [displayRows, onSelectionChange, selection])

  const startHeaderDrag = useCallback((type, index, e) => {
    // 右键点击不触发拖拽选择，由 contextMenu 处理
    if (e && e.button === 2) return
    
    onEditingCellChange(null)
    headerDragRef.current = { type, start: index }
    document.body.classList.add('excel-no-select')
    
    // 检查是否按了 Ctrl/Cmd，如果是，执行多选逻辑
    if (e && (e.ctrlKey || e.metaKey)) {
      // Ctrl+点击时，不重置选择，而是扩展选择
      // 多选逻辑在 handleRowHeaderClick/handleColHeaderClick 中处理
      return
    }
    
    if (type === 'row') {
      onSelectionChange({
        startRow: index,
        startCol: 1,
        endRow: index,
        endCol: displayCols,
        extraCells: []
      })
    } else {
      onSelectionChange({
        startRow: 1,
        startCol: index,
        endRow: displayRows,
        endCol: index,
        extraCells: []
      })
    }
  }, [displayCols, displayRows, onEditingCellChange, onSelectionChange])

  const updateHeaderDrag = useCallback((type, index) => {
    const drag = headerDragRef.current
    if (!drag || drag.type !== type) return
    if (type === 'row') {
      const start = Math.min(drag.start, index)
      const end = Math.max(drag.start, index)
      onSelectionChange({
        startRow: start,
        startCol: 1,
        endRow: end,
        endCol: displayCols,
        extraCells: []
      })
    } else {
      const start = Math.min(drag.start, index)
      const end = Math.max(drag.start, index)
      onSelectionChange({
        startRow: 1,
        startCol: start,
        endRow: displayRows,
        endCol: end,
        extraCells: []
      })
    }
  }, [displayCols, displayRows, onSelectionChange])

  const {
    isDragging,
    handleMouseDown: handleCellMouseDown,
    handleMouseMove: handleContainerMouseMove
  } = useDragSelection({
    containerRef,
    displayRows,
    displayCols,
    onSelectionChange,
    onDragEnd: formatBrushActive ? onApplyFormatBrush : undefined,  // 拖拽结束时应用格式刷
    editingCell,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    colOffsets,
    colWidths,
    rowOffsets,
    rowHeights
  })
  
  const handleCellKeyDown = useCallback((e, row, col) => {
    if (readOnly) return
    if (e.key === 'Enter') {
      e.preventDefault()
      onCellChange(row, col, e.target.textContent)
      onEditingCellChange(null)
    } else if (e.key === 'Escape') {
      onEditingCellChange(null)
    }
  }, [onCellChange, onEditingCellChange, readOnly])
  const startResize = useCallback((type, index, clientX, clientY) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const scrollLeft = container.scrollLeft
    const scrollTop = container.scrollTop
    if (type === 'col') {
      const baseOffset = HEADER_W + (colOffsets?.[index] ?? (index - 1) * CELL_W)
      const pointer = clientX - rect.left + scrollLeft
      resizeRef.current = { type, index, baseOffset, pointer }
    } else {
      const baseOffset = HEADER_H + (rowOffsets?.[index] ?? (index - 1) * CELL_H)
      const pointer = clientY - rect.top + scrollTop
      resizeRef.current = { type, index, baseOffset, pointer }
    }
    document.body.classList.add('excel-no-select')
  }, [CELL_H, CELL_W, HEADER_H, HEADER_W, colOffsets, rowOffsets])

  // [perf] 拖拽中只更新 ExcelEditor 内部的 dragPreview state，驱动 colWidths/rowHeights useMemo
  // 重算 CSS Grid template，不触发 App.jsx 的 setWorkbook + executeOperation 深拷贝
  const updateResize = useCallback((clientX, clientY) => {
    const resize = resizeRef.current
    if (!resize) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const scrollLeft = container.scrollLeft
    const scrollTop = container.scrollTop
    const minCol = 40 * safeZoom
    const minRow = 18 * safeZoom
    if (resize.type === 'col') {
      const pointer = clientX - rect.left + scrollLeft
      const next = Math.max(minCol, pointer - resize.baseOffset)
      resizeRef.current.pointer = pointer
      resizeRef.current.size = next
      setDragPreview({ type: 'col', index: resize.index, size: next })
    } else {
      const pointer = clientY - rect.top + scrollTop
      const next = Math.max(minRow, pointer - resize.baseOffset)
      resizeRef.current.pointer = pointer
      resizeRef.current.size = next
      setDragPreview({ type: 'row', index: resize.index, size: next })
    }
  }, [safeZoom])

  // 释放鼠标：清空预览，将最终尺寸写回 workbook（只触发一次 setWorkbook）
  const commitResize = useCallback(() => {
    const resize = resizeRef.current
    if (!resize) return
    if (resize.type === 'col') {
      const next = Math.max(40 * safeZoom, resize.size ?? CELL_W)
      onColWidthChange?.(resize.index, next / safeZoom, true)
    } else {
      const next = Math.max(18 * safeZoom, resize.size ?? CELL_H)
      onRowHeightChange?.(resize.index, next / safeZoom, true)
    }
    resizeRef.current = null
    setDragPreview(null)
    document.body.classList.remove('excel-no-select')
  }, [onColWidthChange, onRowHeightChange, safeZoom, CELL_W, CELL_H])

  useEffect(() => {
    const handleMove = (e) => {
      if (!resizeRef.current) return
      updateResize(e.clientX, e.clientY)
    }
    const handleUp = () => {
      if (!resizeRef.current) return
      commitResize()
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [commitResize, updateResize])

  const handleHeaderContextMenu = useCallback((e, type, index) => {
    e.preventDefault()
    e.stopPropagation() // 阻止事件冒泡，避免触发点击事件重置选择
    
    // 检测当前选择是否是多行/多列
    let isMultiSelection = false
    let selectionStart = index
    let selectionEnd = index
    let selectionCount = 1
    
    if (type === 'row') {
      // 检查是否选择了多行（选择范围跨越整行）
      if (selection.startRow !== selection.endRow && 
          selection.startCol === 1 && 
          selection.endCol === displayCols) {
        isMultiSelection = true
        selectionStart = selection.startRow
        selectionEnd = selection.endRow
        selectionCount = selectionEnd - selectionStart + 1
      }
    } else {
      // 检查是否选择了多列（选择范围跨越整列）
      if (selection.startCol !== selection.endCol && 
          selection.startRow === 1 && 
          selection.endRow === displayRows) {
        isMultiSelection = true
        selectionStart = selection.startCol
        selectionEnd = selection.endCol
        selectionCount = selectionEnd - selectionStart + 1
      }
    }
    
    const x = e.clientX
    const y = e.clientY
    setMenuPosition({ x, y }) // 先设置初始位置，避免跳动
    setContextMenu({
      type,
      index,
      isMultiSelection,
      selectionStart,
      selectionEnd,
      selectionCount,
      x,
      y
    })
  }, [selection, displayCols, displayRows])

  useEffect(() => {
    if (!contextMenu) return
    const handleClose = () => setContextMenu(null)
    window.addEventListener('click', handleClose)
    return () => window.removeEventListener('click', handleClose)
  }, [contextMenu])

  // ============================================================================
  // 自定义公式状态
  // ============================================================================
  const [selectedFormula, setSelectedFormula] = useState(null)
  const [formulaParams, setFormulaParams] = useState({})
  const [formulaSubmenuOpen, setFormulaSubmenuOpen] = useState(false)

  // ============================================================================
  // 右键菜单智能定位（确保菜单始终在可视区域内）
  // ============================================================================
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      return
    }
    
    const menu = contextMenuRef.current
    const menuRect = menu.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const padding = 8 // 距离边缘的最小间距
    
    let x = contextMenu.x
    let y = contextMenu.y
    
    // 如果菜单右边超出视口，向左调整
    if (x + menuRect.width + padding > viewportWidth) {
      x = Math.max(padding, viewportWidth - menuRect.width - padding)
    }
    
    // 如果菜单底部超出视口，向上调整
    if (y + menuRect.height + padding > viewportHeight) {
      y = Math.max(padding, viewportHeight - menuRect.height - padding)
    }
    
    // 确保左边和顶部不超出
    x = Math.max(padding, x)
    y = Math.max(padding, y)
    
    setMenuPosition({ x, y })
  }, [contextMenu, selectedFormula]) // selectedFormula 变化时菜单高度会变，需要重新计算

  // ============================================================================
  // 单元格右键菜单处理
  // ============================================================================
  const handleCellContextMenu = useCallback((e, row, col) => {
    e.preventDefault()
    e.stopPropagation()

    // 右键目标不在当前选区内时，将选区移到该单元格（保证复制/粘贴作用于正确格子）
    const inCurrentSelection =
      row >= selection.startRow && row <= selection.endRow &&
      col >= selection.startCol && col <= selection.endCol
    if (!inCurrentSelection) {
      anchorCellRef.current = { row, col }
      onSelectionChange({ startRow: row, startCol: col, endRow: row, endCol: col, extraCells: [] })
    }

    const x = e.clientX
    const y = e.clientY
    setSelectedFormula(null)
    setFormulaParams({})
    setFormulaSubmenuOpen(false)
    setMenuPosition({ x, y })
    setContextMenu({ type: 'cell', row, col, x, y })
  }, [selection, onSelectionChange])

  // 选择公式并初始化参数
  const handleSelectFormula = useCallback((formula) => {
    setSelectedFormula(formula)
    const params = {}
    formula.params?.forEach(p => {
      params[p.name] = p.default
    })
    setFormulaParams(params)
  }, [])

  // 更新公式参数
  const handleParamChange = useCallback((paramName, value) => {
    setFormulaParams(prev => ({
      ...prev,
      [paramName]: parseFloat(value) || 0
    }))
  }, [])

  // ---- 列引用解析：提取表达式中的列字母 ----
  const JS_RESERVED = useMemo(() => new Set([
    'Math', 'NaN', 'Infinity', 'undefined', 'null',
    'true', 'false', 'if', 'else', 'return', 'value',
  ]), [])

  const parseColumnRefs = useCallback((expression) => {
    const matches = (expression || '').match(/\b([A-Z]{1,2})\b/g) || []
    return [...new Set(matches.filter(m => !JS_RESERVED.has(m)))]
  }, [JS_RESERVED])

  const letterToColIndex = useCallback((letter) => {
    let idx = 0
    for (let i = 0; i < letter.length; i++) {
      idx = idx * 26 + (letter.charCodeAt(i) - 64)
    }
    return idx
  }, [])

  const getCellNumericValue = useCallback((row, col) => {
    const cell = sheet?.data?.[row]?.[col]
    if (!cell) return NaN
    const raw = cell.formula
      ? evaluateFormula(cell.formula, sheet.data)
      : cell.value
    return parseFloat(raw)
  }, [sheet])

  // 执行公式计算（支持单元格右键选区 & 列头整列两种场景）
  const executeFormula = useCallback(() => {
    if (!selectedFormula) return

    const isColumnMode = contextMenu?.type !== 'cell'
    let startRow, endRow, targetCols

    if (isColumnMode) {
      // 列头右键：作用于整列数据区（跳过第 1 行表头）
      const colIdx = contextMenu?.index || 1
      startRow = 2
      endRow = displayRows
      targetCols = [colIdx]
    } else {
      startRow = selection.startRow
      endRow = selection.endRow
      targetCols = []
      for (let c = selection.startCol; c <= selection.endCol; c++) targetCols.push(c)
    }

    const colRefs = parseColumnRefs(selectedFormula.expression)

    for (let r = startRow; r <= endRow; r++) {
      for (const c of targetCols) {
        const value = getCellNumericValue(r, c)

        // 构建计算上下文
        const ctx = { value: isNaN(value) ? 0 : value, ...formulaParams }
        for (const letter of colRefs) {
          ctx[letter] = getCellNumericValue(r, letterToColIndex(letter))
        }

        // 至少要有一个有效数值来源
        const hasNumericInput = !isNaN(value) || colRefs.some(l => !isNaN(getCellNumericValue(r, letterToColIndex(l))))
        if (!hasNumericInput) continue

        try {
          const fn = new Function(...Object.keys(ctx), `return ${selectedFormula.expression}`)
          let result = fn(...Object.values(ctx))
          if (typeof result === 'number' && isFinite(result)) {
            result = Number.isInteger(result) ? result : parseFloat(result.toFixed(2))
          }
          onCellChange(r, c, result)
        } catch (err) {
          console.warn('公式计算错误:', err)
        }
      }
    }

    setContextMenu(null)
    setSelectedFormula(null)
    setFormulaParams({})
    setFormulaSubmenuOpen(false)
  }, [selectedFormula, contextMenu, selection, displayRows, formulaParams, onCellChange, parseColumnRefs, letterToColIndex, getCellNumericValue])

  // 二级菜单快速应用：使用公式默认参数直接对当前选区写回结果
  const applyCustomFormulaFromMenu = useCallback((formula) => {
    if (!formula || readOnly) return
    const params = {}
    formula.params?.forEach((p) => {
      const n = Number(p?.default)
      params[p.name] = Number.isFinite(n) ? n : 0
    })
    const colRefs = parseColumnRefs(formula.expression)
    const startRow = selection.startRow
    const endRow = selection.endRow
    const targetCols = []
    for (let c = selection.startCol; c <= selection.endCol; c++) targetCols.push(c)

    for (let r = startRow; r <= endRow; r++) {
      for (const c of targetCols) {
        const value = getCellNumericValue(r, c)
        const ctx = { value: Number.isNaN(value) ? 0 : value, ...params }
        for (const letter of colRefs) {
          ctx[letter] = getCellNumericValue(r, letterToColIndex(letter))
        }
        try {
          const fn = new Function(...Object.keys(ctx), `return ${formula.expression}`)
          let result = fn(...Object.values(ctx))
          if (typeof result === 'number' && Number.isFinite(result)) {
            result = Number.isInteger(result) ? result : Number(result.toFixed(2))
          }
          onCellChange(r, c, result)
        } catch (err) {
          console.warn('自定义公式执行失败:', err)
        }
      }
    }
    setContextMenu(null)
    setSelectedFormula(null)
    setFormulaParams({})
    setFormulaSubmenuOpen(false)
  }, [
    readOnly, selection, parseColumnRefs, getCellNumericValue, letterToColIndex, onCellChange,
  ])

  // 返回公式列表
  const handleBackToList = useCallback(() => {
    setSelectedFormula(null)
    setFormulaParams({})
  }, [])


  useEffect(() => {
    const handleHeaderMouseUp = () => {
      if (!headerDragRef.current) return
      headerDragRef.current = null
      document.body.classList.remove('excel-no-select')
    }
    window.addEventListener('mouseup', handleHeaderMouseUp)
    return () => window.removeEventListener('mouseup', handleHeaderMouseUp)
  }, [])


  const {
    getCellDisplay,
    getCellEditValue,
    checkConditionalFormat
  } = useCellRender({ sheet })
  
  // 解析范围字符串（如 "A1:F10" 或 "A2:A10,D2:D10" 或 "销售数据!$A$1:$F$150" 或 "$A:$A"）
  const parseRangeStr = useCallback((rangeStr, sheet = null) => {
    const parseCol = (colStr) => {
      // 移除 $ 符号（绝对引用）
      const cleanCol = colStr.replace(/\$/g, '')
      return cleanCol.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)
    }
    
    // 获取工作表实际数据范围
    const getSheetDataRange = () => {
      if (!sheet || !sheet.data) {
        return { startRow: 1, endRow: 1000 } // 默认范围
      }
      
      const rowKeys = Object.keys(sheet.data)
        .map(Number)
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => a - b)
      
      if (rowKeys.length === 0) {
        return { startRow: 1, endRow: 1000 } // 默认范围
      }
      
      return {
        startRow: 1, // 表头行
        endRow: Math.max(...rowKeys) // 最后一行数据
      }
    }
    
    // 移除工作表名称前缀（如 "销售数据!" 或 "Sheet1!"）
    let cleanRangeStr = rangeStr
    if (rangeStr.includes('!')) {
      const parts = rangeStr.split('!')
      cleanRangeStr = parts[parts.length - 1] // 取最后一部分（范围部分）
    }
    
    // 解析单个范围（支持整列引用）
    const parseSingleRange = (range) => {
      // 再次移除工作表名称前缀（因为每个范围可能都有）
      let cleanRange = range
      if (range.includes('!')) {
        const parts = range.split('!')
        cleanRange = parts[parts.length - 1] // 取最后一部分（范围部分）
      }
      
      // 尝试匹配标准格式：$A$1:$F$150 或 A1:F150
      let match = cleanRange.match(/\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)/i)
      if (match) {
        return {
          startRow: parseInt(match[2]),
          startCol: parseCol(match[1]),
          endRow: parseInt(match[4]),
          endCol: parseCol(match[3])
        }
      }
      
      // 尝试匹配整列格式：$A:$A 或 A:A 或 $A:$F（支持单列和多列）
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
      
      console.warn('parseRangeStr: 无法解析范围', { original: range, cleaned: cleanRange })
      return null
    }
    
    // 检查是否包含多个范围（用逗号分隔）
    if (cleanRangeStr.includes(',')) {
      // 多个范围，返回数组
      const ranges = cleanRangeStr.split(',').map(r => r.trim())
      return ranges.map(range => parseSingleRange(range)).filter(r => r !== null)
    } else {
      // 单个范围
      return parseSingleRange(cleanRangeStr)
    }
  }, [])

  const { chartElements } = useChartRender({
    sheet,
    visibleRows,
    visibleCols,
    parseRangeStr,
    getCellDisplay,
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    headerWidth: HEADER_W,
    headerHeight: HEADER_H,
    containerRef,
  })

  const validationTipMap = useMemo(() => {
    const rules = sheet?.dataValidations
    if (!Array.isArray(rules) || rules.length === 0) return {}
    const tipMap = {}
    rules.forEach(rule => {
      const startRow = Number(rule?.startRow)
      const startCol = Number(rule?.startCol)
      const endRow = Number(rule?.endRow)
      const endCol = Number(rule?.endCol)
      if (!Number.isFinite(startRow) || !Number.isFinite(startCol) || !Number.isFinite(endRow) || !Number.isFinite(endCol)) {
        return
      }
      const v = rule?.validation || {}
      const type = v.type || v.validationType || ''
      const params = v.params || v.validationParams || v
      let tip = '数据验证'
      if (type === 'list') {
        const values = Array.isArray(params?.values) ? params.values : []
        tip = values.length ? `下拉验证: ${values.join(', ')}` : '下拉验证'
      } else if (type) {
        tip = `数据验证: ${type}`
      }
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          tipMap[`${r}:${c}`] = tip
        }
      }
    })
    return tipMap
  }, [sheet?.dataValidations])

  const validationRuleMap = useMemo(() => {
    const rules = sheet?.dataValidations
    if (!Array.isArray(rules) || rules.length === 0) return {}
    const ruleMap = {}
    rules.forEach(rule => {
      const startRow = Number(rule?.startRow)
      const startCol = Number(rule?.startCol)
      const endRow = Number(rule?.endRow)
      const endCol = Number(rule?.endCol)
      if (!Number.isFinite(startRow) || !Number.isFinite(startCol) || !Number.isFinite(endRow) || !Number.isFinite(endCol)) {
        return
      }
      const v = rule?.validation || {}
      const type = v.type || v.validationType || ''
      const params = v.params || v.validationParams || v
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          ruleMap[`${r}:${c}`] = { type, params }
        }
      }
    })
    return ruleMap
  }, [sheet?.dataValidations])

  
  // ====================================================================
  // [perf] 合并单元格 / 图表覆盖预查找表 — O(1) 替代 renderCell 内 O(n) 扫描
  // ====================================================================
  const mergedCellMap = useMemo(() => {
    const map = new Map()
    for (const merge of (sheet?.mergedCells || [])) {
      for (let r = merge.startRow; r <= merge.endRow; r++) {
        for (let c = merge.startCol; c <= merge.endCol; c++) {
          map.set(`${r}:${c}`, merge)
        }
      }
    }
    return map
  }, [sheet?.mergedCells])

  const chartCoverageSet = useMemo(() => {
    const set = new Set()
    for (const chart of (sheet?.charts || [])) {
      const rEnd = chart.row + Math.ceil(chart.height / 25)
      const cEnd = chart.col + Math.ceil(chart.width / 100)
      for (let r = chart.row; r <= rEnd; r++) {
        for (let c = chart.col; c <= cEnd; c++) {
          set.add(`${r}:${c}`)
        }
      }
    }
    return set
  }, [sheet?.charts])

  // [perf] 预计算默认字号，避免每个单元格重复计算
  const defaultZoomedFontPx = useMemo(
    () => `${Math.max(10, 13 * safeZoom).toFixed(1)}px`,
    [safeZoom]
  )
  // [perf] 是否存在条件格式规则 — 无规则时跳过 checkConditionalFormat
  const hasCondRules = !!(sheet?.conditionalFormats?.length)

  // ====================================================================
  // Canvas 背板：滚动时同步绘制，消除 React 异步渲染期间的视觉空白
  // ====================================================================
  const backdropBridge = useCanvasBackdrop({
    enabled: enableCanvasScrollOptimize,
    containerRef, canvasRef, sheet, activeTheme,
    rowOffsets, colOffsets, rowHeights, colWidths,
    headerWidth: HEADER_W, headerHeight: HEADER_H,
    displayRows, displayCols,
    mergedCellMap, chartCoverageSet,
    getCellDisplay, checkConditionalFormat,
    hasCondRules, safeZoom
  })

  useEffect(() => {
    if (!backdropBridge) return
    drawFrameRef.current = backdropBridge.drawFrame || null
    canvasSettleDelayRef.current = backdropBridge.settleDelayMs || 90
  }, [backdropBridge])

  const renderCell = useCallback((row, col) => {
    const cellKey = `${row}:${col}`

    // O(1) 合并单元格查找（必须在快速路径之前）
    const mergeInfo = mergedCellMap.get(cellKey) || null
    if (mergeInfo && (row !== mergeInfo.startRow || col !== mergeInfo.startCol)) {
      return null
    }

    // O(1) 图表覆盖检测
    if (chartCoverageSet.has(cellKey)) {
      return (
        <div
          key={`${row}-${col}`}
          className="excel-cell chart-overlay"
          style={{ backgroundColor: 'transparent', border: 'none' }}
        />
      )
    }

    const isEditing = editingCell?.row === row && editingCell?.col === col
    const cell = sheet?.data[row]?.[col]

    // ====================================================================
    // [perf] 快速路径 A：空单元格 — 跳过全部样式/属性计算
    // 对于 5K 行表格滚动跳转，空单元格占比可达 30-60%
    // ====================================================================
    if (!cell && !isEditing && !mergeInfo) {
      return (
        <div
          key={`${row}-${col}`}
          className="excel-cell"
          data-row={row}
          data-col={col}
          style={{ backgroundColor: activeTheme.cellBg, color: activeTheme.textColor, fontSize: defaultZoomedFontPx }}
        />
      )
    }

    // ====================================================================
    // [perf] 快速路径 B：简单数据单元格 — 有值但无复杂格式
    // 跳过边框映射、条件格式、注释、超链接等 10+ 步计算
    // ====================================================================
    const cellStyle = cell?.style || {}
    if (
      cell && !isEditing && !mergeInfo
      && !hasCondRules
      && !cellStyle.border
      && !cellStyle.backgroundColor && !cellStyle.fill
      && !cell.note && !(cell.comments?.length)
      && !cell.hyperlink && !cell.image?.src
      && !validationTipMap[cellKey]
    ) {
      let fc = activeTheme.textColor
      if (cellStyle.fontColor) {
        const raw = typeof cellStyle.fontColor === 'object'
          ? (cellStyle.fontColor.rgb || cellStyle.fontColor.argb || cellStyle.fontColor.value)
          : cellStyle.fontColor
        if (typeof raw === 'string' && raw) {
          fc = raw.startsWith('#') ? raw : (/^[0-9A-Fa-f]{6}$/.test(raw) ? '#' + raw : raw)
        }
      }
      const display = getCellDisplay(row, col, cell)
      return (
        <div
          key={`${row}-${col}`}
          className="excel-cell"
          data-row={row}
          data-col={col}
          style={{
            backgroundColor: activeTheme.cellBg,
            color: fc,
            fontWeight: cellStyle.bold ? 'bold' : 'normal',
            fontStyle: cellStyle.italic ? 'italic' : 'normal',
            textAlign: cellStyle.horizontalAlignment || 'left',
            fontSize: defaultZoomedFontPx
          }}
        >
          {display}
        </div>
      )
    }

    // ====================================================================
    // 完整路径：有复杂格式的单元格
    // ====================================================================
    const validationTip = validationTipMap[`${row}:${col}`] || ''
    const validationRule = validationRuleMap[`${row}:${col}`]
    const commentText = (() => {
      if (!cell) return ''
      if (typeof cell.note === 'string' && cell.note.trim()) return cell.note.trim()
      if (Array.isArray(cell.comments) && cell.comments.length > 0) {
        const first = cell.comments[0]
        if (typeof first === 'string') return first.trim()
        if (typeof first?.text === 'string') return first.text.trim()
      }
      return ''
    })()
    const hyperlinkUrl = (() => {
      if (!cell?.hyperlink) return ''
      if (typeof cell.hyperlink === 'string') return cell.hyperlink.trim()
      if (typeof cell.hyperlink?.url === 'string') return cell.hyperlink.url.trim()
      if (typeof cell.hyperlink?.hyperlink === 'string') return cell.hyperlink.hyperlink.trim()
      if (typeof cell.hyperlink?.target === 'string') return cell.hyperlink.target.trim()
      return ''
    })()
    const hasValidation = !!validationTip
    const hasComment = !!commentText
    const hasHyperlink = !!hyperlinkUrl
    const imageSrc = typeof cell?.image?.src === 'string' ? cell.image.src : ''
    const hasImage = !!imageSrc

    const conditionalFormat = hasCondRules ? checkConditionalFormat(row, col, cell) : null
    
    
    // 背景色优先级：条件格式 > 单元格样式 > null（CSS 提供主题默认）
    // 只有非默认色才写 inline style，避免覆盖 CSS 主题背景或条件格式
    let backgroundColor = null
    let backgroundColorSource = 'default'
    
    if (conditionalFormat?.backgroundColor) {
      backgroundColor = conditionalFormat.backgroundColor
      backgroundColorSource = 'conditionalFormat'
    } else if (cellStyle.backgroundColor) {
      // 检查 backgroundColor 是否为有效值（非空字符串、非 null、非 undefined）
      let bgColor = cellStyle.backgroundColor
      if (bgColor !== '' && bgColor !== null && bgColor !== undefined) {
        // 确保颜色值有 # 前缀（如果缺少）
        if (typeof bgColor === 'string' && !bgColor.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(bgColor)) {
          bgColor = '#' + bgColor
        }
        backgroundColor = bgColor
        backgroundColorSource = 'cellStyle.backgroundColor'
      }
    } else if (cellStyle.fill && typeof cellStyle.fill === 'object') {
      // 处理 ExcelJS 格式的 fill 对象（备用方案）
      const fill = cellStyle.fill
      if (fill.fgColor) {
        if (typeof fill.fgColor === 'object') {
          if (fill.fgColor.argb) {
            backgroundColor = fill.fgColor.argb
            backgroundColorSource = 'cellStyle.fill.fgColor.argb'
          } else if (fill.fgColor.rgb) {
            backgroundColor = fill.fgColor.rgb
            backgroundColorSource = 'cellStyle.fill.fgColor.rgb'
          } else if (fill.fgColor.value) {
            backgroundColor = fill.fgColor.value
            backgroundColorSource = 'cellStyle.fill.fgColor.value'
          }
        } else if (typeof fill.fgColor === 'string') {
          backgroundColor = fill.fgColor
          backgroundColorSource = 'cellStyle.fill.fgColor'
        }
      }
    }
    
    
    let fontColor = activeTheme.textColor // 默认值
    if (conditionalFormat?.fontColor || conditionalFormat?.color) {
      let fColor = conditionalFormat.fontColor || conditionalFormat.color
      // 处理对象格式的 fontColor：{rgb: 'FFFFFF'} 或 {argb: 'FFFFFF'}
      if (typeof fColor === 'object' && fColor !== null) {
        if (fColor.rgb) {
          fColor = fColor.rgb
        } else if (fColor.argb) {
          fColor = fColor.argb
        } else if (fColor.value) {
          fColor = fColor.value
        } else {
          fColor = null
        }
      }
      // 确保颜色值有 # 前缀（如果缺少）
      if (typeof fColor === 'string' && fColor !== '' && fColor !== null && fColor !== undefined) {
        if (!fColor.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(fColor)) {
          fColor = '#' + fColor
        }
        fontColor = fColor
      } else {
        fontColor = activeTheme.textColor
      }
    } else if (cellStyle.fontColor) {
      let fColor = cellStyle.fontColor
      // 处理对象格式的 fontColor：{rgb: 'FFFFFF'} 或 {argb: 'FFFFFF'}
      if (typeof fColor === 'object' && fColor !== null) {
        if (fColor.rgb) {
          fColor = fColor.rgb
        } else if (fColor.argb) {
          fColor = fColor.argb
        } else if (fColor.value) {
          fColor = fColor.value
        } else {
          fColor = null // 无法提取，使用默认值
        }
      }
      // 确保颜色值有 # 前缀（如果缺少）
      if (typeof fColor === 'string' && fColor !== '' && fColor !== null && fColor !== undefined) {
        if (!fColor.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(fColor)) {
          fColor = '#' + fColor
        }
        fontColor = fColor
      } else if (fColor === null || fColor === undefined) {
        // 如果提取失败，使用默认值
        fontColor = activeTheme.textColor
      }
    }
    
    
    // 构建最终样式对象
    // 使用内联样式确保优先级高于 CSS 类样式
    // 优先级：条件格式 > 单元格样式 > 默认值
    const resolveBaseFontSize = () => {
      const raw = conditionalFormat?.fontSize ?? cellStyle.fontSize
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isFinite(num) && num > 0) return num
      return 13
    }

    // 字号需要随 zoom 等比例缩放，否则只会“格子变大，字不变”
    const zoomedFontPx = `${Math.max(10, resolveBaseFontSize() * safeZoom).toFixed(1)}px`
    const finalStyle = {
      backgroundColor: activeTheme.cellBg,
      color: fontColor || 'black',
      // 字体加粗：优先使用条件格式，其次单元格样式
      fontWeight: (conditionalFormat?.bold !== undefined ? conditionalFormat.bold : cellStyle.bold) ? 'bold' : 'normal',
      // 字体斜体：优先使用条件格式，其次单元格样式
      fontStyle: (conditionalFormat?.italic !== undefined ? conditionalFormat.italic : cellStyle.italic) ? 'italic' : 'normal',
      // 水平对齐：优先使用条件格式，其次单元格样式
      textAlign: conditionalFormat?.horizontalAlignment || cellStyle.horizontalAlignment || 'left',
      justifyContent: (() => {
        const align = conditionalFormat?.horizontalAlignment || cellStyle.horizontalAlignment || 'left'
        if (align === 'center') return 'center'
        if (align === 'right') return 'flex-end'
        return 'flex-start'
      })(),
      // 垂直对齐
      alignItems: (() => {
        const vAlign = cellStyle.verticalAlignment || 'middle'
        if (vAlign === 'top') return 'flex-start'
        if (vAlign === 'bottom') return 'flex-end'
        return 'center'
      })(),
      // 自动换行
      whiteSpace: cellStyle.wrapText ? 'pre-wrap' : 'nowrap',
      wordBreak: cellStyle.wrapText ? 'break-word' : 'normal',
      overflow: cellStyle.wrapText ? 'hidden' : 'hidden',
      // 字体大小：优先使用条件格式，其次单元格样式；并随 zoom 缩放
      fontSize: zoomedFontPx
    }
    
    // 应用其他条件格式样式（如下划线、删除线等）
    if (conditionalFormat?.underline) {
      finalStyle.textDecoration = 'underline'
    } else if (conditionalFormat?.strikethrough) {
      finalStyle.textDecoration = 'line-through'
    } else if (cellStyle.underline) {
      finalStyle.textDecoration = 'underline'
    } else if (cellStyle.strikethrough) {
      finalStyle.textDecoration = 'line-through'
    }
    
    // 应用边框样式：直接使用 border CSS 属性，视觉权重清晰
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
    
    // 只有非默认背景色才写 inline style（防止白色/主题色覆盖 CSS 主题背景）
    const _isDefaultBg = (c) => !c || c === 'white' || c === '#ffffff' || c === '#fff'
      || c === '#FFFFFF' || c === activeTheme.cellBg
    if (backgroundColor && !_isDefaultBg(backgroundColor)) {
      finalStyle.backgroundColor = backgroundColor
      finalStyle['--cell-bg-color'] = backgroundColor
      finalStyle.background = backgroundColor
    }
    
    
    if (isEditing) {
      const editingInlineStyle = {
        ...finalStyle,
        width: '100%',
        height: '100%',
        border: 'none',
        outline: 'none',
        fontFamily: 'inherit',
      }
      const listValues = (() => {
        if (!validationRule || validationRule.type !== 'list') return []
        const values = Array.isArray(validationRule.params?.values) ? validationRule.params.values : []
        return values.map(v => String(v)).filter(Boolean)
      })()
      if (!readOnly && listValues.length > 0) {
        const currentValue = cell?.value !== undefined && cell?.value !== null ? String(cell.value) : ''
        return (
          <select
            key={`${row}-${col}`}
            className="excel-cell editing"
            value={currentValue}
            autoFocus
            onBlur={() => onEditingCellChange(null)}
            onChange={(e) => {
              onCellChange(row, col, e.target.value)
              onEditingCellChange(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onEditingCellChange(null)
            }}
            style={editingInlineStyle}
          >
            {currentValue && !listValues.includes(currentValue) ? <option value={currentValue}>{currentValue}</option> : null}
            {listValues.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        )
      }
      return (
        <div
          key={`${row}-${col}`}
          className="excel-cell editing"
          ref={editingRef}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          onBlur={(e) => {
            if (!readOnly) onCellChange(row, col, e.target.textContent)
            onEditingCellChange(null)
          }}
          onKeyDown={(e) => handleCellKeyDown(e, row, col)}
          dangerouslySetInnerHTML={{ __html: getCellEditValue(cell) }}
          style={editingInlineStyle}
        />
      )
    }
    
    // backgroundColor 已在 _isDefaultBg 过滤后只保留非默认色
    const hasCustomBg = !!backgroundColor && !_isDefaultBg(backgroundColor)
    
    const hasUserBorder = !!(cellStyle.border && (
      (cellStyle.border.top?.style) || (cellStyle.border.bottom?.style) ||
      (cellStyle.border.left?.style) || (cellStyle.border.right?.style)
    ))
    const cellClassName = [
      'excel-cell',
      hasCustomBg ? 'has-custom-bg' : '',
      hasUserBorder ? 'has-user-border' : '',
      hasValidation ? 'excel-cell-has-validation' : '',
      hasComment ? 'excel-cell-has-comment' : '',
      hasHyperlink ? 'excel-cell-has-link' : '',
      hasImage ? 'excel-cell-has-image' : '',
      formatBrushActive ? 'format-brush-cursor' : ''
    ].filter(Boolean).join(' ')
    
    // 如果有自定义背景色，强制设置内联样式和 CSS 变量
    if (hasCustomBg) {
      finalStyle.backgroundColor = backgroundColor
      finalStyle.background = backgroundColor
      // 设置 CSS 变量供 CSS 使用
      finalStyle['--cell-bg-color'] = backgroundColor
    }
    
    // 合并单元格样式（使用 grid-column 和 grid-row 跨度）
    if (mergeInfo) {
      const colSpan = mergeInfo.endCol - mergeInfo.startCol + 1
      const rowSpan = mergeInfo.endRow - mergeInfo.startRow + 1
      // col + 1 因为第一列是行头
      finalStyle.gridColumn = `${col + 1} / span ${colSpan}`
      finalStyle.gridRow = `${row + 1} / span ${rowSpan}`
      finalStyle.zIndex = 5
    }
    
    return (
      <div
        key={`${row}-${col}`}
        className={cellClassName}
        data-row={row}
        data-col={col}
        style={finalStyle}
        title={[
          hasHyperlink ? `超链接: ${hyperlinkUrl}` : '',
          validationTip ? `验证: ${validationTip}` : '',
          commentText ? `批注: ${commentText}` : ''
        ].filter(Boolean).join(' | ') || undefined}
      >
        {hasImage ? (
          <img
            src={imageSrc}
            alt=""
            className="excel-cell-image"
            draggable={false}
          />
        ) : (
          getCellDisplay(row, col, cell)
        )}
      </div>
    )
  }, [sheet, activeTheme, validationTipMap, validationRuleMap, editingCell,
      handleCellKeyDown, onCellChange, onEditingCellChange, getCellDisplay, getCellEditValue, 
      checkConditionalFormat, formatBrushActive, 
      colOffsets, rowOffsets, readOnly,
      mergedCellMap, chartCoverageSet,
      defaultZoomedFontPx, hasCondRules, safeZoom])

  // ====================================================================
  // [perf] grid 级事件委托 — 替代每个单元格上的独立 handler
  // ====================================================================
  const resolveCellFromEvent = useCallback((e) => {
    const el = e.target.closest('[data-row]')
    if (!el) return null
    return { row: +el.dataset.row, col: +el.dataset.col }
  }, [])

  const handleGridClick = useCallback((e) => {
    const pos = resolveCellFromEvent(e)
    if (!pos) return
    handleCellClick(pos.row, pos.col, e)
  }, [resolveCellFromEvent, handleCellClick])

  const handleGridDblClick = useCallback((e) => {
    const pos = resolveCellFromEvent(e)
    if (!pos) return
    handleCellDoubleClick(pos.row, pos.col)
  }, [resolveCellFromEvent, handleCellDoubleClick])

  const handleGridMouseDown = useCallback((e) => {
    const pos = resolveCellFromEvent(e)
    if (!pos) return
    handleCellMouseDown(e, pos.row, pos.col)
  }, [resolveCellFromEvent, handleCellMouseDown])

  const handleGridContextMenu = useCallback((e) => {
    const pos = resolveCellFromEvent(e)
    if (!pos) return
    handleCellContextMenu(e, pos.row, pos.col)
  }, [resolveCellFromEvent, handleCellContextMenu])

  const gridHeightAdjusted = useMemo(() => {
    return HEADER_H + totalRowsHeight
  }, [HEADER_H, totalRowsHeight])
  // [perf] 使用 CSS repeat() 压缩连续相同轨道，减轻浏览器解析开销
  const gridRowTemplate = useMemo(() => {
    const parts = [`${HEADER_H}px`]
    let runHeight = rowHeights[1]
    let runCount = 1
    for (let row = 2; row <= displayRows; row++) {
      const h = rowHeights[row]
      if (h === runHeight) {
        runCount++
      } else {
        parts.push(runCount > 1 ? `repeat(${runCount},${runHeight}px)` : `${runHeight}px`)
        runHeight = h
        runCount = 1
      }
    }
    if (displayRows >= 1) {
      parts.push(runCount > 1 ? `repeat(${runCount},${runHeight}px)` : `${runHeight}px`)
    }
    return parts.join(' ')
  }, [HEADER_H, displayRows, rowHeights])
  const gridColTemplate = useMemo(() => {
    const parts = [`${HEADER_W}px`]
    let runWidth = colWidths[1]
    let runCount = 1
    for (let col = 2; col <= displayCols; col++) {
      const w = colWidths[col]
      if (w === runWidth) {
        runCount++
      } else {
        parts.push(runCount > 1 ? `repeat(${runCount},${runWidth}px)` : `${runWidth}px`)
        runWidth = w
        runCount = 1
      }
    }
    if (displayCols >= 1) {
      parts.push(runCount > 1 ? `repeat(${runCount},${runWidth}px)` : `${runWidth}px`)
    }
    return parts.join(' ')
  }, [HEADER_W, displayCols, colWidths])
  // ====================================================================
  // [perf] memoize header 回调 — 避免 useGridItemsBuilder 每渲染重建
  // ====================================================================
  const stableRowMouseDown = useCallback((row, e) => startHeaderDrag('row', row, e), [startHeaderDrag])
  const stableRowMouseEnter = useCallback((row) => updateHeaderDrag('row', row), [updateHeaderDrag])
  const stableColMouseDown = useCallback((col, e) => startHeaderDrag('col', col, e), [startHeaderDrag])
  const stableColMouseEnter = useCallback((col) => updateHeaderDrag('col', col), [updateHeaderDrag])
  const stableRowCtxMenu = useCallback((e, row) => handleHeaderContextMenu(e, 'row', row), [handleHeaderContextMenu])
  const stableColCtxMenu = useCallback((e, col) => handleHeaderContextMenu(e, 'column', col), [handleHeaderContextMenu])
  const stableRowResize = useCallback((e, row) => startResize('row', row, e.clientX, e.clientY), [startResize])
  const stableColResize = useCallback((e, col) => startResize('col', col, e.clientX, e.clientY), [startResize])

  const gridItems = useGridItemsBuilder({
    displayRows,
    displayCols,
    visibleRows,
    visibleCols,
    hiddenRows,
    renderCell,
    onSelectRow: handleRowHeaderClick,
    onSelectCol: handleColHeaderClick,
    onRowHeaderMouseDown: stableRowMouseDown,
    onRowHeaderMouseEnter: stableRowMouseEnter,
    onColHeaderMouseDown: stableColMouseDown,
    onColHeaderMouseEnter: stableColMouseEnter,
    onRowHeaderContextMenu: stableRowCtxMenu,
    onColHeaderContextMenu: stableColCtxMenu,
    onRowResizeStart: stableRowResize,
    onColResizeStart: stableColResize,
    buffer: 15
  })
  
  return (
    // ----------------------------------------------------------------
    // excel-container：滚动容器（overflow:auto）
    // excel-canvas：内容画布（position:relative），图表直接渲染在此层内
    // 图表与单元格同层，随内容滚动，滚动条永远不会被覆盖
    // ----------------------------------------------------------------
    <div
      ref={containerRef}
      className={`excel-container ${isDragging ? 'is-dragging' : ''}`}
      data-tour="excel-editor"
      onMouseMove={handleContainerMouseMove}
      onScroll={handleScroll}
    >
        <div
          className="excel-canvas"
          style={{ position: 'relative', width: `${gridWidth}px`, height: `${gridHeightAdjusted}px`, backgroundColor: activeTheme.cellBg }}
        >
        {enableCanvasScrollOptimize && (
          <canvas
            ref={canvasRef}
            className="scroll-canvas"
          />
        )}
        <div
          className="excel-grid"
          style={{
            gridTemplateColumns: gridColTemplate,
            gridTemplateRows: gridRowTemplate,
            position: 'relative',
            zIndex: 1
          }}
          onClick={handleGridClick}
          onDoubleClick={handleGridDblClick}
          onMouseDown={handleGridMouseDown}
          onContextMenu={handleGridContextMenu}
        >
          {gridItems}
        </div>
        <GridLinesOverlay
          gridWidth={gridWidth}
          gridHeight={gridHeightAdjusted}
          headerWidth={HEADER_W}
          headerHeight={HEADER_H}
          rowOffsets={rowOffsets}
          rowHeights={rowHeights}
          colOffsets={colOffsets}
          colWidths={colWidths}
          displayRows={displayRows}
          displayCols={displayCols}
        />
        <SelectionOverlay
          selection={selection}
          cellWidth={CELL_W}
          cellHeight={CELL_H}
          headerWidth={HEADER_W}
          headerHeight={HEADER_H}
          colOffsets={colOffsets}
          colWidths={colWidths}
          rowOffsets={rowOffsets}
          rowHeights={rowHeights}
        />
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="excel-context-menu"
            style={{ top: menuPosition.y, left: menuPosition.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.type === 'row' ? (
              <>
                <button onClick={() => { onInsertRow?.(contextMenu.index, 'before'); setContextMenu(null) }}>向上插入行</button>
                <button onClick={() => { onInsertRow?.(contextMenu.index, 'after'); setContextMenu(null) }}>向下插入行</button>
                <div className="divider" />
                {contextMenu.isMultiSelection ? (
                  <button onClick={() => { 
                    onDeleteRow?.(contextMenu.selectionStart, contextMenu.selectionCount); 
                    setContextMenu(null) 
                  }}>
                    删除选中的 {contextMenu.selectionCount} 行
                  </button>
                ) : (
                  <button onClick={() => { onDeleteRow?.(contextMenu.index); setContextMenu(null) }}>删除当前行</button>
                )}
              </>
            ) : contextMenu.type === 'cell' ? (
              <>
                <button
                  onClick={() => {
                    onCopy?.()
                    setContextMenu(null)
                  }}
                >
                  复制
                </button>
                {!readOnly && (
                  <button
                    onClick={() => {
                      onPaste?.()
                      setContextMenu(null)
                    }}
                    disabled={!canPaste}
                  >
                    粘贴
                  </button>
                )}
                {!readOnly && customFormulas.length > 0 && (
                  <>
                    <div className="divider" />
                    <div
                      className="excel-context-submenu-wrap"
                      onMouseEnter={() => setFormulaSubmenuOpen(true)}
                      onMouseLeave={() => setFormulaSubmenuOpen(false)}
                    >
                      <button
                        className="excel-context-submenu-trigger"
                        onClick={() => setFormulaSubmenuOpen((v) => !v)}
                      >
                        <span>引用自定义公式</span>
                        <span aria-hidden>▶</span>
                      </button>
                      {formulaSubmenuOpen && (
                        <div className="excel-context-submenu">
                          {customFormulas.map((formula) => (
                            <button
                              key={formula.id || formula.name}
                              onClick={() => applyCustomFormulaFromMenu(formula)}
                              title={formula.description}
                            >
                              {formula.label || formula.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <button onClick={() => { onInsertCol?.(contextMenu.index, 'before'); setContextMenu(null) }}>向左插入列</button>
                <button onClick={() => { onInsertCol?.(contextMenu.index, 'after'); setContextMenu(null) }}>向右插入列</button>
                <div className="divider" />
                {contextMenu.isMultiSelection ? (
                  <button onClick={() => { 
                    onDeleteCol?.(contextMenu.selectionStart, contextMenu.selectionCount); 
                    setContextMenu(null) 
                  }}>
                    删除选中的 {contextMenu.selectionCount} 列
                  </button>
                ) : (
                  <button onClick={() => { onDeleteCol?.(contextMenu.index); setContextMenu(null) }}>删除当前列</button>
                )}
                {customFormulas.length > 0 && (
                  <>
                    <div className="divider" />
                    <div className="menu-header">自定义公式</div>
                    {selectedFormula ? (
                      <>
                        <button className="back-btn" onClick={handleBackToList}>← 返回列表</button>
                        <div className="formula-detail">
                          <div className="formula-name">{selectedFormula.label}</div>
                          <div className="formula-desc">{selectedFormula.description}</div>
                          <div className="formula-expr">表达式: {selectedFormula.expression}</div>
                        </div>
                        <div className="formula-params">
                          {selectedFormula.params?.map(param => (
                            <div key={param.name} className="param-row">
                              <span className="param-label">{param.label}:</span>
                              <input
                                type="number"
                                className="param-input"
                                value={formulaParams[param.name] ?? param.default}
                                onChange={(e) => handleParamChange(param.name, e.target.value)}
                                step={param.type === 'percent' ? 0.01 : 1}
                              />
                              {param.type === 'percent' && <span className="param-hint">({(formulaParams[param.name] * 100).toFixed(0)}%)</span>}
                            </div>
                          ))}
                          <button className="formula-execute" onClick={executeFormula}>
                            应用到 {String.fromCharCode(64 + contextMenu.index)} 列全部数据
                          </button>
                        </div>
                      </>
                    ) : (
                      customFormulas.map(formula => (
                        <button
                          key={formula.name}
                          onClick={() => handleSelectFormula(formula)}
                          title={formula.description}
                        >
                          {formula.label}
                        </button>
                      ))
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}
        {chartElements}
      </div>
      {/* ↑ 关闭 excel-canvas ↑ */}
    </div>
  )
})

ExcelEditor.displayName = 'ExcelEditor'

// ============================================================================
// React.memo 阻断 AI 流式 token（setAiMessages）引发的无关重渲染
// 只比较会真正影响表格渲染的 props，回调函数引用变化不触发重渲染
// ============================================================================
export default React.memo(ExcelEditor, (prev, next) =>
  prev.workbook === next.workbook
  && prev.activeSheet === next.activeSheet
  && prev.selection === next.selection
  && prev.editingCell === next.editingCell
  && prev.formatBrushActive === next.formatBrushActive
  && prev.canPaste === next.canPaste
  && prev.readOnly === next.readOnly
  && prev.zoom === next.zoom
  && prev.sheetTheme === next.sheetTheme
  && prev.customFormulas === next.customFormulas
)
