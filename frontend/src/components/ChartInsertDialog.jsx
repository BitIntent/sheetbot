// ================================================================
// 图表插入对话框
// 图表类型视觉选择 + 数据范围（打开时同步 Univer 当前选区）+ 放置位置 A1 + 预览
// ================================================================
import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { X, BarChart3, LineChart, PieChart, ScatterChart, Activity, Radar, BarChart } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { buildEchartsOption, parseRange, extractChartData } from '../univer/chartEchartsBuilder.js'

// ==================== 图表类型定义 ====================

const CHART_TYPES = [
  { value: 'column', label: '柱状图', Icon: BarChart3 },
  { value: 'bar', label: '条形图', Icon: BarChart },
  { value: 'line', label: '折线图', Icon: LineChart },
  { value: 'area', label: '面积图', Icon: Activity },
  { value: 'pie', label: '饼图', Icon: PieChart },
  { value: 'doughnut', label: '环形图', Icon: PieChart },
  { value: 'scatter', label: '散点图', Icon: ScatterChart },
  { value: 'radar', label: '雷达图', Icon: Radar },
]

// ==================== 列号 / A1 单元格 ====================

function colToLetter(col) {
  let r = '', t = col
  while (t > 0) { t--; r = String.fromCharCode(65 + (t % 26)) + r; t = Math.floor(t / 26) }
  return r
}

function letterToCol(letters) {
  let n = 0
  const s = String(letters).toUpperCase()
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64)
  }
  return n
}

/** 解析 "M2" -> { row, col }，失败返回 null */
function parsePlacementCell(s) {
  const m = String(s).trim().match(/^([A-Za-z]+)(\d+)$/i)
  if (!m) return null
  const col = letterToCol(m[1])
  const row = parseInt(m[2], 10)
  if (col < 1 || row < 1) return null
  return { row, col }
}

/** 选区右侧第一列、首行在表头下时取第 2 行（与 M2 类默认一致） */
function defaultPlacementFromRange(sr, sc, er, ec) {
  const endCol = Math.max(sc, ec)
  const startRow = Math.min(sr, er)
  const placeCol = endCol + 1
  const placeRow = startRow === 1 ? 2 : startRow
  return `${colToLetter(placeCol)}${placeRow}`
}

/** 读取 Univer 当前激活选区（1-based，与名称框一致）
 *  Facade FRange：getRow/getColumn 为起始格（0-based），getLastRow/getLastColumn 为结束格（0-based）
 *  勿用 getRange().rangeData，与 FRange 内部结构不一致会导致只得到单格（如 E1:E1）
 */
function readUniverSelection(univerEditorRef) {
  try {
    const api = univerEditorRef?.current?.getUniverAPI?.()
    const fSheet = api?.getActiveWorkbook?.()?.getActiveSheet?.()
    const ar = fSheet?.getSelection?.()?.getActiveRange?.()
    if (!ar || typeof ar.getRow !== 'function' || typeof ar.getLastRow !== 'function') return null
    return {
      sr: ar.getRow() + 1,
      sc: ar.getColumn() + 1,
      er: ar.getLastRow() + 1,
      ec: ar.getLastColumn() + 1,
    }
  } catch {
    return null
  }
}

function selectionToRangeString(box) {
  if (!box) return ''
  const { sr, sc, er, ec } = box
  return `${colToLetter(sc)}${sr}:${colToLetter(ec)}${er}`
}

// ==================== 样式常量 ====================

const OVERLAY = {
  position: 'fixed', inset: 0, zIndex: 9999,
  background: 'rgba(0,0,0,0.55)', display: 'flex',
  alignItems: 'center', justifyContent: 'center',
}
const DIALOG = {
  background: '#1f2937', borderRadius: 10, width: 640,
  maxHeight: '85vh', overflow: 'auto', color: '#e5e7eb',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
}
const INPUT = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #4b5563', background: '#111827',
  color: '#e5e7eb', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
}

// ==================== 组件 ====================

export default function ChartInsertDialog({ isOpen, onClose, onCreate, workbook, activeSheet, univerEditorRef }) {
  const [chartType, setChartType] = useState('column')
  const [title, setTitle] = useState('')
  const [dataRange, setDataRange] = useState('')
  const [placementCell, setPlacementCell] = useState('M2')

  const sheet = useMemo(() => {
    const sheets = workbook?.sheets || []
    return sheets.find(s => s.name === activeSheet) || sheets[0]
  }, [workbook, activeSheet])

  const applySelectionToForm = useCallback(() => {
    const box = readUniverSelection(univerEditorRef)
    if (!box) return
    setDataRange(selectionToRangeString(box))
    setPlacementCell(defaultPlacementFromRange(box.sr, box.sc, box.er, box.ec))
  }, [univerEditorRef])

  useEffect(() => {
    if (!isOpen) return
    setTitle('')
    setChartType('column')
    applySelectionToForm()
  }, [isOpen, applySelectionToForm])

  const previewOption = useMemo(() => {
    if (!dataRange.trim()) return null
    const mockChart = { chartType, dataRange: dataRange.trim(), title }
    return buildEchartsOption(mockChart, sheet)
  }, [chartType, dataRange, title, sheet])

  const dataSummary = useMemo(() => {
    const range = parseRange(dataRange.trim())
    if (!range) return null
    const { headers, labels, matrix } = extractChartData(range, sheet)
    return { rows: matrix.length, cols: headers.length, headers }
  }, [dataRange, sheet])

  const handleCreate = useCallback(() => {
    if (!dataRange.trim()) return
    const pos = parsePlacementCell(placementCell)
    if (!pos) return
    onCreate({
      chartType,
      title,
      dataRange: dataRange.trim(),
      row: pos.row,
      col: pos.col,
      width: 420,
      height: 300,
    })
    onClose()
  }, [chartType, title, dataRange, placementCell, onCreate, onClose])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && dataRange.trim() && parsePlacementCell(placementCell)) handleCreate()
    if (e.key === 'Escape') onClose()
  }, [handleCreate, onClose, dataRange, placementCell])

  const placementOk = !!parsePlacementCell(placementCell)
  const canSubmit = dataRange.trim() && placementOk

  if (!isOpen) return null

  return (
    <div style={OVERLAY} onMouseDown={onClose}>
      <div style={DIALOG} onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px 12px', borderBottom: '1px solid #374151' }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>插入图表</span>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, display: 'block' }}>图表类型</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {CHART_TYPES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setChartType(value)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                    padding: '10px 6px', borderRadius: 8, cursor: 'pointer',
                    border: chartType === value ? '2px solid #3b82f6' : '1px solid #4b5563',
                    background: chartType === value ? '#1e3a5f' : '#111827',
                    color: chartType === value ? '#93c5fd' : '#9ca3af',
                    transition: 'all 0.15s',
                  }}
                >
                  <Icon size={20} />
                  <span style={{ fontSize: 11 }}>{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4, display: 'block' }}>数据范围</label>
              <input
                style={INPUT}
                value={dataRange}
                onChange={(e) => setDataRange(e.target.value)}
                placeholder="打开对话框前在表格中选区，或手动输入如 E1:L17"
                autoFocus
              />
              {dataSummary && (
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                  {dataSummary.rows} 行 x {dataSummary.cols} 列 ({dataSummary.headers.join(', ')})
                </div>
              )}
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4, display: 'block' }}>图表标题</label>
              <input
                style={INPUT}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="(可选)"
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4, display: 'block' }}>放置位置</label>
            <input
              style={INPUT}
              value={placementCell}
              onChange={(e) => setPlacementCell(e.target.value.toUpperCase())}
              placeholder="如 M2（选区右侧第一空列，表头下默认第 2 行）"
            />
            {!placementOk && placementCell.trim() && (
              <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>格式应为列字母+行号，例如 M2</div>
            )}
          </div>

          {previewOption && (
            <div style={{ background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
              <ReactECharts
                option={previewOption}
                style={{ width: '100%', height: 220 }}
                opts={{ renderer: 'canvas' }}
                notMerge
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 18px', borderRadius: 6, border: '1px solid #4b5563',
                background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 13,
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canSubmit}
              style={{
                padding: '8px 22px', borderRadius: 6, border: 'none',
                background: canSubmit ? '#3b82f6' : '#374151',
                color: canSubmit ? '#fff' : '#6b7280',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
                fontSize: 13, fontWeight: 500,
              }}
            >
              插入图表
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}