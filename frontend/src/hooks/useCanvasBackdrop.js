// frontend/src/hooks/useCanvasBackdrop.js
/**
 * ===================================
 * Canvas 背板 Hook
 * - 滚动时同步绘制可视单元格（~5ms）
 * - 作为 CSS Grid 背后的视觉预览层
 * - 零交互：pointer-events: none
 * ===================================
 */
import { useCallback, useEffect, useRef } from 'react'
import { formatDefaultDecimalDisplay } from './useCellRender'

// ================================================================
// 二分查找：像素偏移 → 行/列索引
// ================================================================
const findRow = (rowOffsets, rowHeights, y, maxRows) => {
  if (!rowOffsets || y <= 0) return 1
  let lo = 1, hi = maxRows, res = 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rowOffsets[mid] <= y) { res = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  while (res <= maxRows && rowHeights[res] === 0) res++
  return Math.min(res, maxRows)
}

const findCol = (colOffsets, x, maxCols) => {
  if (!colOffsets || x <= 0) return 1
  let lo = 1, hi = maxCols, res = 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (colOffsets[mid] <= x) { res = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return Math.min(res, maxCols)
}

// 规范化颜色值：对象 / 裸 hex / 带 # hex → 统一 #RRGGBB
const normColor = (raw) => {
  if (!raw) return null
  if (typeof raw === 'object') raw = raw.argb || raw.rgb || raw.value
  if (typeof raw !== 'string' || !raw) return null
  if (!raw.startsWith('#') && /^[0-9A-Fa-f]{6,8}$/.test(raw)) return '#' + raw
  return raw
}

// 合并单元格的像素尺寸
const mergeSize = (merge, colWidths, rowHeights) => {
  let w = 0, h = 0
  for (let c = merge.startCol; c <= merge.endCol; c++) w += colWidths[c] || 0
  for (let r = merge.startRow; r <= merge.endRow; r++) h += rowHeights[r] || 0
  return { w, h }
}

const quickCellText = (cell) => {
  if (!cell) return ''
  const v = cell.value
  if (v == null) return ''
  if (typeof v === 'number') return String(formatDefaultDecimalDisplay(v))
  if (typeof v === 'string') {
    return String(formatDefaultDecimalDisplay(v, { parseMode: 'decimalOnly' }))
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'object') {
    const t = v.text ?? v.result ?? v.display ?? v.value ?? ''
    return t == null ? '' : String(t)
  }
  return String(v)
}

const FONT_FAMILY = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
const BORDER_COLOR = 'rgba(128,128,128,0.25)'
const HEADER_BG = '#2A2A2A'
const HEADER_TEXT = '#B3B3B3'
const FAST_SETTLE_MS = 90

const colLabel = (col) => {
  let n = Number(col)
  if (!Number.isFinite(n) || n < 1) return ''
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// ================================================================
// 主 Hook
// ================================================================
export function useCanvasBackdrop({
  enabled = true,
  containerRef,
  canvasRef,
  sheet,
  activeTheme,
  rowOffsets, colOffsets,
  rowHeights, colWidths,
  headerWidth, headerHeight,
  displayRows, displayCols,
  mergedCellMap,
  chartCoverageSet,
  getCellDisplay,
  checkConditionalFormat,
  hasCondRules,
  safeZoom
}) {
  // drawRef 持有最新绘制函数，避免 scroll listener 闭包过期
  const drawRef = useRef(null)

  drawRef.current = function drawFrame(scrollTop, scrollLeft, vw, vh, fastMode = false) {
    if (!enabled) return false
    const canvas = canvasRef.current
    if (!canvas || !rowOffsets || !colOffsets || displayRows < 1 || displayCols < 1 || vw <= 0 || vh <= 0) return false

    const dpr = window.devicePixelRatio || 1
    const cw = Math.ceil(vw)
    const ch = Math.ceil(vh)

    // 按需调整 canvas 物理尺寸
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr
      canvas.height = ch * dpr
      canvas.style.width = cw + 'px'
      canvas.style.height = ch + 'px'
    }
    // GPU 合成层定位到当前滚动偏移
    canvas.style.transform = `translate3d(${scrollLeft}px,${scrollTop}px,0)`

    const ctx = canvas.getContext('2d', { alpha: false })
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const themeBg = activeTheme?.cellBg || '#1F232A'
    const themeText = activeTheme?.textColor || '#E5E7EB'

    // ---- 1. 整体背景 ----
    ctx.fillStyle = themeBg
    ctx.fillRect(0, 0, cw, ch)

    // ---- 2. 可视范围 ----
    const startRow = findRow(rowOffsets, rowHeights, scrollTop, displayRows)
    const endRow = Math.min(displayRows, findRow(rowOffsets, rowHeights, scrollTop + vh + 50, displayRows))
    const startCol = findCol(colOffsets, scrollLeft, displayCols)
    const endCol = Math.min(displayCols, findCol(colOffsets, scrollLeft + vw + 50, displayCols))

    const data = sheet?.data || {}
    const baseFontPx = Math.max(10, 13 * (safeZoom || 1))
    const defaultFont = `${baseFontPx.toFixed(1)}px ${FONT_FAMILY}`

    // ---- 3. 单遍遍历：背景 + 收集边框 + 文本 ----
    ctx.beginPath() // 边框路径（最后统一 stroke）
    ctx.font = defaultFont
    ctx.textBaseline = 'middle'
    let lastFont = defaultFont

    for (let row = startRow; row <= endRow; row++) {
      const rh = rowHeights[row]
      if (!rh) continue
      const cy = headerHeight + rowOffsets[row] - scrollTop
      if (cy + rh < 0 || cy > ch) continue

      for (let col = startCol; col <= endCol; col++) {
        const cellW = colWidths[col]
        const cx = headerWidth + colOffsets[col] - scrollLeft
        if (cx + cellW < 0 || cx > cw) continue

        const key = `${row}:${col}`
        if (chartCoverageSet?.has(key)) continue

        const merge = mergedCellMap?.get(key)
        if (merge && (row !== merge.startRow || col !== merge.startCol)) continue

        // 实际绘制尺寸（合并单元格扩展）
        let drawW = cellW, drawH = rh
        if (merge) ({ w: drawW, h: drawH } = mergeSize(merge, colWidths, rowHeights))

        const cell = data[row]?.[col]

        // ---- 背景色 ----
        let bg = null
        if (!fastMode && cell && hasCondRules) {
          const cf = checkConditionalFormat?.(row, col, cell)
          if (cf?.backgroundColor) bg = normColor(cf.backgroundColor)
        }
        if (!bg && cell?.style?.backgroundColor) {
          bg = normColor(cell.style.backgroundColor)
        } else if (!bg && cell?.style?.fill?.fgColor) {
          bg = normColor(cell.style.fill.fgColor)
        }
        if (bg && bg !== themeBg) {
          ctx.fillStyle = bg
          ctx.fillRect(cx, cy, drawW, drawH)
        }

        // ---- 边框由 GridLinesOverlay 统一绘制，此处不画 ----

        // ---- 文本 ----
        if (!cell || cell.image?.src) continue
        let display
        if (fastMode) {
          display = quickCellText(cell)
        } else {
          try { display = getCellDisplay?.(row, col, cell) } catch { continue }
        }
        if (display == null || display === '') continue

        const text = String(display)
        const cs = cell.style || {}

        // 字体
        const bold = cs.bold ? 'bold ' : ''
        const italic = cs.italic ? 'italic ' : ''
        const fSize = cs.fontSize
          ? Math.max(10, Number(cs.fontSize) * (safeZoom || 1))
          : baseFontPx
        const font = `${italic}${bold}${fSize.toFixed(1)}px ${FONT_FAMILY}`
        if (font !== lastFont) { ctx.font = font; lastFont = font }

        // 文本颜色
        let tc = themeText
        if (hasCondRules) {
          const cf = checkConditionalFormat?.(row, col, cell)
          const cfc = cf?.fontColor || cf?.color
          if (cfc) tc = normColor(typeof cfc === 'object' ? cfc : cfc) || themeText
        }
        if (tc === themeText && cs.fontColor) {
          tc = normColor(cs.fontColor) || themeText
        }
        ctx.fillStyle = tc

        // 对齐
        const padding = 4
        const align = cs.horizontalAlignment || 'left'
        if (align === 'center') { ctx.textAlign = 'center' }
        else if (align === 'right') { ctx.textAlign = 'right' }
        else { ctx.textAlign = 'left' }

        const tx = align === 'center' ? cx + drawW / 2
          : align === 'right' ? cx + drawW - padding
          : cx + padding

        ctx.fillText(text, tx, cy + drawH / 2, drawW - padding * 2)
      }
    }

    // ---- 4. 统一描边边框（行分隔线由 GridLinesOverlay 统一绘制，此处仅竖线）----
    ctx.strokeStyle = BORDER_COLOR
    ctx.lineWidth = 1
    ctx.stroke()

    // ---- 5. 行头 / 列头背景（覆盖 Canvas 对应区域，与 DOM sticky 头保持一致）----
    const headerTop = headerHeight - scrollTop
    if (headerTop > 0) {
      ctx.fillStyle = HEADER_BG
      ctx.fillRect(0, 0, cw, Math.min(headerTop, ch))
    }
    const headerLeft = headerWidth - scrollLeft
    if (headerLeft > 0) {
      ctx.fillStyle = HEADER_BG
      ctx.fillRect(0, 0, Math.min(headerLeft, cw), ch)
    }

    // ---- 6. 行号 / 列标：滚动冻结 DOM 时也保持可见 ----
    ctx.fillStyle = HEADER_TEXT
    ctx.font = `${Math.max(10, 12 * (safeZoom || 1)).toFixed(1)}px ${FONT_FAMILY}`
    ctx.textBaseline = 'middle'

    // 左侧行号（右对齐）
    if (headerLeft > 0) {
      ctx.textAlign = 'right'
      const tx = Math.max(8, headerWidth - 6)
      for (let row = startRow; row <= endRow; row++) {
        const rh = rowHeights[row]
        if (!rh) continue
        const cy = headerHeight + rowOffsets[row] - scrollTop
        if (cy + rh < 0 || cy > ch) continue
        ctx.fillText(String(row), tx, cy + rh / 2)
      }
    }

    // 顶部列标（居中）
    if (headerTop > 0) {
      ctx.textAlign = 'center'
      const ty = Math.max(10, headerHeight / 2)
      for (let col = startCol; col <= endCol; col++) {
        const cellW = colWidths[col]
        const cx = headerWidth + colOffsets[col] - scrollLeft
        if (cx + cellW < 0 || cx > cw) continue
        ctx.fillText(colLabel(col), cx + cellW / 2, ty)
      }
    }
    return true
  }

  const drawFrame = useCallback((scrollTop, scrollLeft, vw, vh, fastMode = false) => {
    return !!drawRef.current?.(scrollTop, scrollLeft, vw, vh, fastMode)
  }, [])

  // 数据/主题/缩放变更时重绘
  // [perf] rowOffsets/colOffsets 是每次 useMemo 都返回的新数组引用，直接作为依赖会导致每次 workbook
  // 更新都触发不必要重绘。改用末尾标量（总行高 / 总列宽）作为代理依赖：内容不变时值不变，
  // 行高/列宽真实变化时才触发重绘，同时 drawRef.current 闭包始终持有最新偏移数组。
  useEffect(() => {
    if (!enabled) return
    const container = containerRef?.current
    if (!container) return
    drawRef.current?.(
      container.scrollTop, container.scrollLeft,
      container.clientWidth, container.clientHeight,
      false
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, containerRef, sheet?.data, activeTheme, safeZoom, displayRows, displayCols,
    rowOffsets[displayRows],  // 总行高标量：行高/行数变化时才改变
    colOffsets[displayCols]]) // 总列宽标量：列宽/列数变化时才改变

  return {
    drawFrame,
    settleDelayMs: FAST_SETTLE_MS
  }
}
