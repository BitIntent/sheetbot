// ================================================================
// Univer 图表浮层（ECharts）
// skeleton 定位 + scroll/zoom 同步 + 拖拽/缩放/删除交互
// ================================================================
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { Trash2, GripHorizontal } from 'lucide-react'
import {
  useUniverViewportSync,
  cellToOverlayXY,
  overlayXYToCell,
  getMainSheetViewportClientRect,
  getLogicalViewportScroll,
} from './useUniverViewportSync.js'
import { SetScrollRelativeCommand } from '@univerjs/sheets-ui'
import { buildEchartsOption } from './chartEchartsBuilder.js'

// ==================== 拖拽靠边自动滚动（与滚动条/ wheel 同源命令） ====================

const EDGE_SCROLL_MARGIN = 56
const EDGE_SCROLL_MAX_STEP = 72

function edgeScrollDelta(clientX, clientY, rect) {
  let offsetX = 0
  let offsetY = 0
  if (!rect || rect.width < 8 || rect.height < 8) return { offsetX, offsetY }
  const E = EDGE_SCROLL_MARGIN
  const M = EDGE_SCROLL_MAX_STEP
  const left = clientX - rect.left
  const right = rect.right - clientX
  const top = clientY - rect.top
  const bottom = rect.bottom - clientY
  if (left < E) offsetX = -M * Math.max(0, (E - left) / E)
  if (right < E) offsetX = M * Math.max(0, (E - right) / E)
  if (top < E) offsetY = -M * Math.max(0, (E - top) / E)
  if (bottom < E) offsetY = M * Math.max(0, (E - bottom) / E)
  return {
    offsetX: Math.round(offsetX),
    offsetY: Math.round(offsetY),
  }
}

// ==================== 单个图表卡片 ====================

function ChartCard({ chart, option, style, isSelected, onSelect, onDragStart, onResizeStart, onDelete }) {
  const handleMouseDown = useCallback((e) => {
    e.stopPropagation()
    onSelect(chart.id)
  }, [chart.id, onSelect])

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        ...style,
        position: 'absolute',
        zIndex: isSelected ? 22 : 20,
        pointerEvents: 'auto',
        background: 'rgba(255,255,255,0.97)',
        borderRadius: 4,
        boxShadow: isSelected
          ? '0 0 0 2px #3b82f6, 0 4px 12px rgba(0,0,0,0.15)'
          : '0 1px 4px rgba(0,0,0,0.12)',
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {/* 标题拖拽区 */}
      <div
        onMouseDown={(e) => { e.stopPropagation(); onSelect(chart.id); onDragStart(e, chart.id) }}
        style={{
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 6px',
          background: isSelected ? '#eff6ff' : '#f9fafb',
          borderBottom: '1px solid #e5e7eb',
          cursor: 'grab',
          fontSize: 11,
          color: '#6b7280',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <GripHorizontal size={12} />
          {chart.title || chart.chartType}
        </span>
        {isSelected && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(chart.id) }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#ef4444', padding: 0, lineHeight: 1, display: 'flex',
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {/* ECharts 渲染 */}
      <div style={{ width: '100%', height: 'calc(100% - 22px)' }}>
        <ReactECharts
          option={option}
          style={{ width: '100%', height: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge
        />
      </div>

      {/* 右下角缩放手柄 */}
      {isSelected && (
        <div
          onMouseDown={(e) => { e.stopPropagation(); onResizeStart(e, chart.id) }}
          style={{
            position: 'absolute', right: 0, bottom: 0, width: 14, height: 14,
            cursor: 'nwse-resize', zIndex: 5,
            background: 'linear-gradient(135deg, transparent 50%, #3b82f6 50%)',
            borderRadius: '0 0 4px 0',
          }}
        />
      )}
    </div>
  )
}

// ==================== 主 Overlay ====================

export default function UniverChartsOverlay({
  workbook, activeSheet, univerAPIRef, hostRef, onChartUpdate, onChartDelete,
}) {
  const { vpScroll, zoom, contentOffset, skRef, renderTick } = useUniverViewportSync(
    univerAPIRef, hostRef, [workbook, activeSheet]
  )

  const [selectedId, setSelectedId] = useState(null)
  const dragRef = useRef(null)
  /** 拖拽/缩放过程中不写回 workbook，避免全量 inject 把滚动条打回默认区；mouseup 再提交 */
  const dragLiveRef = useRef(null)
  const [dragTick, setDragTick] = useState(0)

  const sheet = useMemo(() => {
    const sheets = workbook?.sheets || []
    return sheets.find(s => s.name === activeSheet) || sheets[0]
  }, [workbook, activeSheet])

  /**
   * 图表 option 与滚动/缩放无关，单独 memo：
   * 避免滚动时每 50ms 重建 option 触发 ECharts 反复 setOption，造成“抖动感”。
   */
  const chartOptionMap = useMemo(() => {
    const map = new Map()
    const charts = Array.isArray(sheet?.charts) ? sheet.charts : []
    charts.forEach((chart) => {
      const option = buildEchartsOption(chart, sheet)
      // 滚动/拖拽过程中不需要播放动画，减少视觉抖动
      map.set(chart.id, { ...option, animation: false })
    })
    return map
  }, [sheet])

  // 点击空白区取消选中
  const handleBackdropMouseDown = useCallback(() => setSelectedId(null), [])

  // ==================== 拖拽移动 ====================

  const handleDragStart = useCallback((e, chartId) => {
    e.preventDefault()
    dragLiveRef.current = null
    setDragTick((t) => t + 1)
    const chart = sheet?.charts?.find(c => c.id === chartId)
    if (!chart) return
    const sk = skRef.current
    const pos = cellToOverlayXY(chart.row, chart.col, sk, vpScroll, zoom, contentOffset)
    dragRef.current = {
      type: 'move', chartId,
      startMouseX: e.clientX, startMouseY: e.clientY,
      startLeft: pos.left, startTop: pos.top,
    }
  }, [sheet, skRef, vpScroll, zoom, contentOffset])

  // ==================== 缩放 ====================

  const handleResizeStart = useCallback((e, chartId) => {
    e.preventDefault()
    dragLiveRef.current = null
    setDragTick((t) => t + 1)
    const chart = sheet?.charts?.find(c => c.id === chartId)
    if (!chart) return
    dragRef.current = {
      type: 'resize', chartId,
      startMouseX: e.clientX, startMouseY: e.clientY,
      startW: chart.width || 400, startH: chart.height || 300,
    }
  }, [sheet])

  // ==================== 全局 mouse move/up ====================

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.startMouseX
      const dy = e.clientY - d.startMouseY

      if (d.type === 'move') {
        const api = univerAPIRef?.current
        const vprect = getMainSheetViewportClientRect(hostRef?.current)
        const { offsetX: sx, offsetY: sy } = edgeScrollDelta(e.clientX, e.clientY, vprect)
        if (api?.syncExecuteCommand && (sx !== 0 || sy !== 0)) {
          try {
            api.syncExecuteCommand(SetScrollRelativeCommand.id, { offsetX: sx, offsetY: sy })
          } catch {
            /* 滚动失败不影响落点 */
          }
        }
        const newLeft = d.startLeft + dx
        const newTop = d.startTop + dy
        const sk = skRef.current
        const scroll = getLogicalViewportScroll(univerAPIRef, sk, vpScroll)
        const cell = overlayXYToCell(newLeft, newTop, sk, scroll, zoom, contentOffset)
        const prev = dragLiveRef.current
        if (
          !prev ||
          prev.chartId !== d.chartId ||
          prev.row !== cell.row ||
          prev.col !== cell.col
        ) {
          dragLiveRef.current = { chartId: d.chartId, row: cell.row, col: cell.col }
          setDragTick((t) => t + 1)
        }
      } else if (d.type === 'resize') {
        const newW = Math.max(200, d.startW + dx / zoom)
        const newH = Math.max(150, d.startH + dy / zoom)
        const rw = Math.round(newW)
        const rh = Math.round(newH)
        const prev = dragLiveRef.current
        if (!prev || prev.chartId !== d.chartId || prev.width !== rw || prev.height !== rh) {
          dragLiveRef.current = { chartId: d.chartId, width: rw, height: rh }
          setDragTick((t) => t + 1)
        }
      }
    }

    const onUp = () => {
      const d = dragRef.current
      const live = dragLiveRef.current
      dragRef.current = null
      if (d?.type === 'move' && live?.chartId === d.chartId && live.row != null && live.col != null) {
        onChartUpdate?.(d.chartId, { row: live.row, col: live.col })
        dragLiveRef.current = { chartId: d.chartId, row: live.row, col: live.col }
      } else if (
        d?.type === 'resize' &&
        live?.chartId === d.chartId &&
        live.width != null &&
        live.height != null
      ) {
        onChartUpdate?.(d.chartId, { width: live.width, height: live.height })
        dragLiveRef.current = {
          chartId: d.chartId,
          width: live.width,
          height: live.height,
        }
      } else {
        dragLiveRef.current = null
      }
      setDragTick((t) => t + 1)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [skRef, vpScroll, zoom, contentOffset, onChartUpdate, univerAPIRef, hostRef])

  // ==================== Delete 快捷键 ====================

  useEffect(() => {
    const onKey = (e) => {
      if (selectedId && (e.key === 'Delete' || e.key === 'Backspace')) {
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
        e.preventDefault()
        onChartDelete?.(selectedId)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, onChartDelete])

  // workbook 异步追上 mouseup 提交前，用 dragLiveRef 顶住避免位置闪回旧格
  useEffect(() => {
    const live = dragLiveRef.current
    if (!live?.chartId) return
    const ch = sheet?.charts?.find((c) => c.id === live.chartId)
    if (!ch) return
    const moveSynced =
      live.row != null &&
      live.col != null &&
      ch.row === live.row &&
      ch.col === live.col
    const cw = ch.width ?? 400
    const chh = ch.height ?? 300
    const resizeSynced =
      live.width != null &&
      live.height != null &&
      cw === live.width &&
      chh === live.height
    if (moveSynced || resizeSynced) {
      dragLiveRef.current = null
      setDragTick((t) => t + 1)
    }
  }, [sheet])

  // ==================== 渲染列表 ====================

  const chartItems = useMemo(() => {
    void renderTick
    const charts = sheet?.charts
    if (!Array.isArray(charts) || !charts.length) return []
    const sk = skRef.current
    if (!sk) return []

    const live = dragLiveRef.current
    return charts.map(chart => {
      const effRow =
        live?.chartId === chart.id && live.row != null ? live.row : (chart.row || 1)
      const effCol =
        live?.chartId === chart.id && live.col != null ? live.col : (chart.col || 1)
      const effW =
        live?.chartId === chart.id && live.width != null ? live.width : (chart.width || 400)
      const effH =
        live?.chartId === chart.id && live.height != null ? live.height : (chart.height || 300)
      const pos = cellToOverlayXY(effRow, effCol, sk, vpScroll, zoom, contentOffset)
      const w = effW * zoom
      const h = effH * zoom
      const option = chartOptionMap.get(chart.id) || buildEchartsOption(chart, sheet)
      return { chart, option, pos, w, h }
    })
  }, [sheet, vpScroll, zoom, contentOffset, renderTick, skRef, dragTick, chartOptionMap])

  if (!chartItems.length) return null

  // 主网格视口盒（相对 host），用于稳定裁剪且不影响命中测试
  const hostRect = hostRef?.current?.getBoundingClientRect?.()
  const vpRect = getMainSheetViewportClientRect(hostRef?.current)
  let viewportBox = null
  if (hostRect && vpRect) {
    viewportBox = {
      left: Math.max(0, vpRect.left - hostRect.left),
      top: Math.max(0, vpRect.top - hostRect.top),
      width: Math.max(0, vpRect.width),
      height: Math.max(0, vpRect.height),
    }
  }

  return (
    <div
      onMouseDown={handleBackdropMouseDown}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {viewportBox ? (
        <div
          style={{
            position: 'absolute',
            left: viewportBox.left,
            top: viewportBox.top,
            width: viewportBox.width,
            height: viewportBox.height,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {chartItems.map(({ chart, option, pos, w, h }) => (
            <ChartCard
              key={chart.id}
              chart={chart}
              option={option}
              style={{
                left: Math.round(pos.left - viewportBox.left),
                top: Math.round(pos.top - viewportBox.top),
                width: Math.round(w),
                height: Math.round(h),
              }}
              isSelected={selectedId === chart.id}
              onSelect={setSelectedId}
              onDragStart={handleDragStart}
              onResizeStart={handleResizeStart}
              onDelete={(id) => { onChartDelete?.(id); setSelectedId(null) }}
            />
          ))}
        </div>
      ) : (
        chartItems.map(({ chart, option, pos, w, h }) => (
          <ChartCard
            key={chart.id}
            chart={chart}
            option={option}
            style={{
              left: Math.round(pos.left),
              top: Math.round(pos.top),
              width: Math.round(w),
              height: Math.round(h),
            }}
            isSelected={selectedId === chart.id}
            onSelect={setSelectedId}
            onDragStart={handleDragStart}
            onResizeStart={handleResizeStart}
            onDelete={(id) => { onChartDelete?.(id); setSelectedId(null) }}
          />
        ))
      )}
    </div>
  )
}
