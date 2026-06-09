// frontend/src/hooks/useGridItemsBuilder.jsx
/**
 * ===================================
 * 网格元素构建 Hook
 * - 构建列头/行头/单元格列表
 * - 基于可视区域虚拟化
 * - 单元格元素缓存（滚动时复用同一引用）
 * ===================================
 */
import React, { useMemo, useRef } from 'react'

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

const buildHeaderItems = (
  range,
  onSelectCol,
  onHeaderMouseDown,
  onHeaderMouseEnter,
  onHeaderContextMenu,
  onColResizeStart
) => {
  const items = [
    <div key="corner" className="excel-corner" style={{ gridRow: 1, gridColumn: 1 }} />
  ]
  for (let col = range.startCol; col <= range.endCol; col++) {
    items.push(
      <div
        key={`header-${col}`}
        className="excel-header"
        onClick={(e) => onSelectCol(col, e)}
        onMouseDown={(e) => onHeaderMouseDown?.(col, e)}
        onMouseEnter={() => onHeaderMouseEnter?.(col)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onHeaderContextMenu?.(e, col)
        }}
        style={{ gridRow: 1, gridColumn: col + 1 }}
      >
        {toExcelColumnName(col)}
        <div
          className="excel-col-resizer"
          onMouseDown={(e) => {
            e.stopPropagation()
            onColResizeStart?.(e, col)
          }}
        />
      </div>
    )
  }
  return items
}

const buildRowHeader = (
  row,
  isHidden,
  onSelectRow,
  onRowMouseDown,
  onRowMouseEnter,
  onRowContextMenu,
  onRowResizeStart
) => {
  return (
      <div
        key={`row-header-${row}`}
        className="excel-row-header"
        onClick={(e) => onSelectRow(row, e)}
        onMouseDown={(e) => onRowMouseDown?.(row, e)}
        onMouseEnter={() => onRowMouseEnter?.(row)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onRowContextMenu?.(e, row)
        }}
        style={{
          display: isHidden ? 'none' : 'flex',
          gridRow: row + 1,
          gridColumn: 1
        }}
      >
      {row}
      <div
        className="excel-row-resizer"
        onMouseDown={(e) => {
          e.stopPropagation()
          onRowResizeStart?.(e, row)
        }}
      />
    </div>
  )
}

const calcRange = (visibleRows, visibleCols, displayRows, displayCols, buffer) => {
  return {
    startRow: Math.max(1, visibleRows.start - buffer),
    endRow: Math.min(displayRows, visibleRows.end + buffer),
    startCol: Math.max(1, visibleCols.start - buffer),
    endCol: Math.min(displayCols, visibleCols.end + buffer)
  }
}

const CACHE_EVICT_THRESHOLD = 12000

export function useGridItemsBuilder({
  displayRows,
  displayCols,
  visibleRows,
  visibleCols,
  hiddenRows,
  renderCell,
  onSelectRow,
  onSelectCol,
  onRowHeaderMouseDown,
  onRowHeaderMouseEnter,
  onColHeaderMouseDown,
  onColHeaderMouseEnter,
  onRowHeaderContextMenu,
  onColHeaderContextMenu,
  onRowResizeStart,
  onColResizeStart,
  buffer = 60
}) {
  const cellCacheRef = useRef(new Map())
  const renderVersionRef = useRef(0)
  const prevRenderCellRef = useRef(renderCell)

  // ================================================================
  // [perf] 同步缓存失效 — 在 render 阶段而非 commit 阶段
  // renderCell 引用变化 = 数据/样式/编辑状态改变 → 即时清空
  // ================================================================
  if (prevRenderCellRef.current !== renderCell) {
    renderVersionRef.current++
    cellCacheRef.current.clear()
    prevRenderCellRef.current = renderCell
  }

  // ================================================================
  // useMemo 依赖只保留影响输出的项
  // 回调函数不影响数据单元格内容，仅用于 header — 从依赖中移除
  // ================================================================
  return useMemo(() => {
    const range = calcRange(visibleRows, visibleCols, displayRows, displayCols, buffer)
    const hiddenRowSet = new Set(hiddenRows || [])
    const version = renderVersionRef.current
    const cache = cellCacheRef.current

    const items = buildHeaderItems(
      range,
      onSelectCol,
      onColHeaderMouseDown,
      onColHeaderMouseEnter,
      onColHeaderContextMenu,
      onColResizeStart
    )

    for (let row = range.startRow; row <= range.endRow; row++) {
      const isHidden = hiddenRowSet.has(row)
      items.push(buildRowHeader(
        row,
        isHidden,
        onSelectRow,
        onRowHeaderMouseDown,
        onRowHeaderMouseEnter,
        onRowHeaderContextMenu,
        onRowResizeStart
      ))
      if (isHidden) continue

      for (let col = range.startCol; col <= range.endCol; col++) {
        const cacheKey = `${row}:${col}`
        const cached = cache.get(cacheKey)

        if (cached && cached.v === version) {
          items.push(cached.el)
          continue
        }

        const cell = renderCell(row, col)
        if (!cell) continue

        const cellStyle = cell.props?.style || {}
        const finalCellStyle = {
          ...cellStyle,
          gridRow: cellStyle.gridRow || (row + 1),
          gridColumn: cellStyle.gridColumn || (col + 1)
        }

        const element = React.cloneElement(cell, {
          key: `cell-${row}-${col}`,
          style: finalCellStyle
        })

        cache.set(cacheKey, { el: element, v: version })
        items.push(element)
      }
    }

    if (cache.size > CACHE_EVICT_THRESHOLD) {
      const keepMargin = 80
      const rMin = range.startRow - keepMargin
      const rMax = range.endRow + keepMargin
      const cMin = range.startCol - keepMargin
      const cMax = range.endCol + keepMargin
      for (const [key] of cache) {
        const sep = key.indexOf(':')
        const r = +key.slice(0, sep)
        const c = +key.slice(sep + 1)
        if (r < rMin || r > rMax || c < cMin || c > cMax) {
          cache.delete(key)
        }
      }
    }

    return items
    // 回调函数仅用于 header 事件绑定，不影响数据单元格渲染结果
    // 从 deps 中排除 → 避免每次渲染都重建整个列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayCols, displayRows, hiddenRows, renderCell, visibleCols, visibleRows, buffer])
}
