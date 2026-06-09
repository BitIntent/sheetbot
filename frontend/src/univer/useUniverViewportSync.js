// ================================================================
// Univer 视口同步共享 Hook
// 提供 skeleton、滚动偏移、缩放比、内容区 DOM 偏移
// 供 Images / Charts 等浮层组件复用
// ================================================================
import { useEffect, useRef, useState, useCallback } from 'react'

// ==================== 内容区 DOM 偏移 ====================
// Univer DOM：host > [data-u-comp="app-layout"]
//   header[data-u-comp="headerbar"]    ← Ribbon
//   section > grid > section(grid-rows:[auto 1fr])
//     header                           ← 公式栏（含 Doc canvas，DOM 序靠前）
//     section[data-range-selector]      ← 主电子表格 canvas

function getContentAreaOffset(hostEl) {
  if (!hostEl) return { top: 0, left: 0 }
  const section = hostEl.querySelector('[data-range-selector]')
  if (!section) return { top: 0, left: 0 }
  const hr = hostEl.getBoundingClientRect()
  const cr = section.getBoundingClientRect()
  return { top: cr.top - hr.top, left: cr.left - hr.left }
}

// ==================== 初始逻辑滚动偏移 ====================

export function computeLogicalScroll(scrollState, sk) {
  if (!scrollState || !sk) return { x: 0, y: 0 }
  const { sheetViewStartRow = 0, sheetViewStartColumn = 0, offsetX = 0, offsetY = 0 } = scrollState
  const rha = sk.rowHeightAccumulation || []
  const cwa = sk.columnWidthAccumulation || []
  return {
    x: (sheetViewStartColumn > 0 ? (cwa[sheetViewStartColumn - 1] || 0) : 0) + offsetX,
    y: (sheetViewStartRow > 0 ? (rha[sheetViewStartRow - 1] || 0) : 0) + offsetY,
  }
}

/** 主表格画布区 clientRect（与 getContentAreaOffset 同一 DOM） */
export function getMainSheetViewportClientRect(hostEl) {
  const section = hostEl?.querySelector?.('[data-range-selector]')
  return section?.getBoundingClientRect?.() ?? null
}

/**
 * 拖拽浮层等场景下需与 Univer 模型同步的滚动偏移（syncExecuteCommand 后 React state 尚未更新）
 */
export function getLogicalViewportScroll(univerAPIRef, sk, fallback = { x: 0, y: 0 }) {
  const fws = getActiveFWorksheet(univerAPIRef)
  if (!fws || !sk) return fallback
  try {
    return computeLogicalScroll(fws.getScrollState(), sk)
  } catch {
    return fallback
  }
}

// ==================== 获取当前 FWorksheet ====================

function getActiveFWorksheet(apiRef) {
  const api = apiRef?.current
  if (!api) return null
  return api.getActiveWorkbook?.()?.getActiveSheet?.() || null
}

// ==================== Hook ====================

export function useUniverViewportSync(univerAPIRef, hostRef, extraDeps = []) {
  const [vpScroll, setVpScroll] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [contentOffset, setContentOffset] = useState({ top: 0, left: 0 })
  const [renderTick, setRenderTick] = useState(0)
  const skRef = useRef(null)
  /** 同步布尔：卸载/切视图后立即禁止 setState，避免与 Univer 销毁竞态触发 [redi] */
  const aliveRef = useRef(true)

  const syncMeta = useCallback(() => {
    if (!aliveRef.current) return
    let fws = null
    try {
      fws = getActiveFWorksheet(univerAPIRef)
    } catch {
      return
    }
    if (!fws) return

    let sk = null
    try {
      sk = fws.getSkeleton?.() || null
    } catch {
      return
    }
    if (sk && sk !== skRef.current) {
      skRef.current = sk
      if (aliveRef.current) setRenderTick((t) => t + 1)
    }

    try {
      const z = fws.getZoom?.() || 1
      if (aliveRef.current) {
        setZoom((prev) => (Math.abs(prev - z) < 0.001 ? prev : z))
      }
    } catch { /* not ready */ }

    const off = getContentAreaOffset(hostRef?.current)
    if (aliveRef.current) {
      setContentOffset((prev) =>
        prev.top === off.top && prev.left === off.left ? prev : off
      )
    }
  }, [univerAPIRef, hostRef])

  /**
   * 与 cellToOverlayXY 同一套逻辑偏移。
   * 不订阅 fws.onScroll：切「我要分析」/普通视图时 Univer 销毁过程中 onScroll 仍可能回调，内部 [redi] 会炸整页。
   * 滚动条场景由下方定时轮询覆盖。
   */
  const applyScrollFromFacade = useCallback((fws) => {
    if (!aliveRef.current || !fws) return
    let sk = null
    try {
      sk = fws.getSkeleton?.() || skRef.current
    } catch {
      return
    }
    if (!sk) return
    let next = { x: 0, y: 0 }
    try {
      next = computeLogicalScroll(fws.getScrollState(), sk)
    } catch {
      return
    }
    if (!aliveRef.current) return
    setVpScroll((prev) => {
      if (!aliveRef.current) return prev
      return prev.x === next.x && prev.y === next.y ? prev : { x: next.x, y: next.y }
    })
  }, [])

  useEffect(() => {
    aliveRef.current = true
    syncMeta()

    try {
      const fws = getActiveFWorksheet(univerAPIRef)
      if (fws) applyScrollFromFacade(fws)
    } catch { /* 父级尚未挂载 API */ }

    const SCROLL_POLL_MS = 50
    const scrollTimer = setInterval(() => {
      if (!aliveRef.current) return
      try {
        const ws = getActiveFWorksheet(univerAPIRef)
        applyScrollFromFacade(ws)
      } catch { /* 切换视图窗口期 */ }
    }, SCROLL_POLL_MS)

    const metaTimer = setInterval(() => {
      if (!aliveRef.current) return
      syncMeta()
    }, 250)

    return () => {
      aliveRef.current = false
      clearInterval(scrollTimer)
      clearInterval(metaTimer)
    }
  }, [univerAPIRef, hostRef, ...extraDeps, syncMeta, applyScrollFromFacade])

  return { vpScroll, zoom, contentOffset, skRef, renderTick }
}

// ==================== 坐标转换工具 ====================

/** 行列（1-indexed）→ overlay 绝对 CSS 像素 */
export function cellToOverlayXY(row, col, sk, vpScroll, zoom, contentOffset) {
  if (!sk) return { left: 0, top: 0 }
  const rha = sk.rowHeightAccumulation || []
  const cwa = sk.columnWidthAccumulation || []
  const hW = sk.rowHeaderWidthAndMarginLeft || 46
  const hH = sk.columnHeaderHeightAndMarginTop || 20
  const r0 = Math.max(0, row - 1)
  const c0 = Math.max(0, col - 1)
  const startX = c0 > 0 ? (cwa[c0 - 1] || 0) : 0
  const startY = r0 > 0 ? (rha[r0 - 1] || 0) : 0
  return {
    left: contentOffset.left + (hW + startX - vpScroll.x) * zoom,
    top: contentOffset.top + (hH + startY - vpScroll.y) * zoom,
  }
}

/** overlay CSS 像素 → 最近行列（1-indexed），用于拖拽落点计算 */
export function overlayXYToCell(left, top, sk, vpScroll, zoom, contentOffset) {
  if (!sk) return { row: 1, col: 1 }
  const rha = sk.rowHeightAccumulation || []
  const cwa = sk.columnWidthAccumulation || []
  const hW = sk.rowHeaderWidthAndMarginLeft || 46
  const hH = sk.columnHeaderHeightAndMarginTop || 20
  const logX = (left - contentOffset.left) / zoom - hW + vpScroll.x
  const logY = (top - contentOffset.top) / zoom - hH + vpScroll.y

  let col = 1
  for (let i = 0; i < cwa.length; i++) {
    if (cwa[i] > logX) { col = i + 1; break }
    col = i + 2
  }
  let row = 1
  for (let i = 0; i < rha.length; i++) {
    if (rha[i] > logY) { row = i + 1; break }
    row = i + 2
  }
  return { row: Math.max(1, row), col: Math.max(1, col) }
}
