// ================================================================
// Univer 图片叠加层
// 坐标体系：[data-range-selector] DOM 偏移 + skeleton 逻辑像素 * zoom
// ================================================================
import React, { useMemo } from 'react'
import { useUniverViewportSync, cellToOverlayXY } from './useUniverViewportSync.js'

// ==================== 数据采集 ====================

function collectImageCells(sheet) {
  const data = sheet?.data
  if (!data || typeof data !== 'object') return []
  const items = []
  const rKeys = Object.keys(data)
  for (let ri = 0; ri < rKeys.length; ri++) {
    const row = Number(rKeys[ri])
    if (!Number.isFinite(row) || row < 1) continue
    const rowData = data[rKeys[ri]]
    if (!rowData || typeof rowData !== 'object') continue
    const cKeys = Object.keys(rowData)
    for (let ci = 0; ci < cKeys.length; ci++) {
      const col = Number(cKeys[ci])
      if (!Number.isFinite(col) || col < 1) continue
      const cell = rowData[cKeys[ci]]
      const src = typeof cell?.image?.src === 'string' ? cell.image.src.trim() : ''
      if (!src) continue
      items.push({
        row, col,
        rowSpan: Math.max(1, Number(cell.image?.rowSpan) || 1),
        colSpan: Math.max(1, Number(cell.image?.colSpan) || 1),
        width: Number(cell.image?.width) || 0,
        height: Number(cell.image?.height) || 0,
        src,
      })
    }
  }
  return items
}

// ==================== 组件 ====================

export default function UniverImagesOverlay({ workbook, activeSheet, univerAPIRef, hostRef }) {
  const { vpScroll, zoom, contentOffset, skRef, renderTick } = useUniverViewportSync(
    univerAPIRef, hostRef, [workbook, activeSheet]
  )
  /**
   * 抑制“图表导出快照图片”残影：
   * 某些文件会同时包含可编辑 chart 元数据 + 历史导出的静态 chart 图片（cell.image），
   * 两者初始重合，移动可编辑图表后会在原位露出不可选的“幽灵图表”。
   * 这里按 sheet 维度记录已识别的快照图片 key，后续持续隐藏。
   */
  const suppressedChartSnapshotKeysRef = React.useRef(new Map())

  const sheet = useMemo(() => {
    const sheets = workbook?.sheets || []
    return sheets.find(s => s.name === activeSheet) || sheets[0]
  }, [workbook, activeSheet])

  const items = useMemo(() => {
    void renderTick
    const sk = skRef.current
    if (!sheet || !sk) return []

    const images = collectImageCells(sheet)
    if (!images.length) return []
    const chartAnchors = new Set(
      (Array.isArray(sheet?.charts) ? sheet.charts : [])
        .map((c) => `${Number(c?.row) || 1}:${Number(c?.col) || 1}`)
    )
    const sheetName = String(sheet?.name || '')
    if (!suppressedChartSnapshotKeysRef.current.has(sheetName)) {
      suppressedChartSnapshotKeysRef.current.set(sheetName, new Set())
    }
    const suppressed = suppressedChartSnapshotKeysRef.current.get(sheetName)

    const rha = sk.rowHeightAccumulation || []
    const cwa = sk.columnWidthAccumulation || []
    const z = zoom

    const out = []
    images.forEach((img, idx) => {
      const anchor = `${img.row}:${img.col}`
      // 当前锚点有可编辑图表时，识别为历史快照并加入抑制集合
      const imageKey = `${img.row}:${img.col}:${String(img.src).slice(0, 96)}`
      if (chartAnchors.has(anchor)) {
        suppressed.add(imageKey)
      }
      if (suppressed.has(imageKey)) {
        return
      }
      const pos = cellToOverlayXY(img.row, img.col, sk, vpScroll, zoom, contentOffset)
      const r0 = img.row - 1
      const c0 = img.col - 1
      const endC0 = c0 + img.colSpan - 1
      const endR0 = r0 + img.rowSpan - 1
      const startX = c0 > 0 ? (cwa[c0 - 1] || 0) : 0
      const startY = r0 > 0 ? (rha[r0 - 1] || 0) : 0
      const cellW = ((cwa[endC0] || startX) - startX) || 100
      const cellH = ((rha[endR0] || startY) - startY) || 25

      out.push({
        ...img,
        left: pos.left,
        top: pos.top,
        width: (img.width || cellW) * z,
        height: (img.height || cellH) * z,
        key: `${img.row}-${img.col}-${idx}`,
      })
    })
    return out
  }, [sheet, vpScroll, zoom, contentOffset, renderTick, skRef])

  if (!items.length) return null

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {items.map(img => (
        <div
          key={img.key}
          style={{
            position: 'absolute',
            left: img.left,
            top: img.top,
            width: img.width,
            height: img.height,
            zIndex: 18,
            pointerEvents: 'none',
          }}
        >
          <img
            src={img.src}
            alt=""
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>
      ))}
    </div>
  )
}
