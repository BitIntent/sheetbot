// frontend/src/components/SkillManagerPage.jsx
/**
 * ============================================================================
 * 玩数据Skill - 技能库管理页面
 * Aurora Light + Glassmorphism 设计风格
 * 工具栏与AI助手由 HeaderActionBar 在 skill 视图下自动隐藏
 * ============================================================================
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Plus, Upload, Download, Trash2, Play,
  Tag, Search, Check, AlertCircle, Loader,
  Zap, BookOpen, FolderOpen,
  Layers, Settings2, FileCode2, FileSpreadsheet, ChevronDown, Copy, UploadCloud, Undo2,
} from 'lucide-react'
import SkillStepBuilder from './SkillStepBuilder'
import { downloadSkillMd, downloadUniversalSkillMd, fromMarkdown, toMarkdown } from '../utils/skillMdSerializer'
import { colToLetter } from '../utils/skillTranslator'
import * as skillApi from '../api/skill'

// ============================================================================
// 空技能模板
// ============================================================================

function emptySkill() {
  return {
    id: null,
    name: '',
    description: '',
    tags: [],
    scope: { mode: 'all_sheets', sheet: '' },
    steps: [],
  }
}

function colNumToLetter(colNum) {
  let n = Number(colNum) || 0
  if (n <= 0) return 'A'
  let out = ''
  while (n > 0) {
    n -= 1
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

function normalizeColor(color) {
  if (!color) return undefined
  if (typeof color === 'string') {
    const v = color.trim()
    // Excel 常见 ARGB: FFAABBCC -> #AABBCC
    if (/^[A-Fa-f0-9]{8}$/.test(v)) return `#${v.slice(2)}`
    if (/^[A-Fa-f0-9]{6}$/.test(v)) return `#${v}`
    return v
  }
  if (typeof color === 'object') {
    return normalizeColor(color.argb || color.rgb || color.value || color.color)
  }
  return undefined
}

// ============================================================================
// 预览单元格样式 -> inline style 映射（覆盖所有可渲染的样式属性）
// ============================================================================

function buildPreviewCellStyle(cell) {
  const s = cell?.style || {}
  const font = s.font || {}
  const fill = s.fill || {}
  const alignObj = s.alignment || {}
  const borderObj = s.border || {}
  const bg = normalizeColor(
    s.backgroundColor ||
    fill?.fgColor?.argb || fill?.fgColor?.rgb || fill?.fgColor?.value || fill?.fgColor ||
    fill?.color
  )
  const fg = normalizeColor(s.color || font?.color?.argb || font?.color?.rgb || font?.color?.value || font?.color)
  const textAlign = s.align || s.horizontalAlignment || alignObj.horizontal
  const verticalAlign = s.verticalAlignment || alignObj.vertical

  const style = {}
  if (bg) style.backgroundColor = bg
  if (fg) style.color = fg
  if (s.bold || font.bold) style.fontWeight = 700
  if (s.italic || font.italic) style.fontStyle = 'italic'
  if (s.fontSize || font.size) style.fontSize = `${Number(s.fontSize || font.size) || 14}px`
  if (s.fontFamily || font.name) style.fontFamily = s.fontFamily || font.name
  if (textAlign) style.textAlign = textAlign
  if (verticalAlign) style.verticalAlign = verticalAlign

  // 文本装饰：下划线 + 删除线可叠加
  const deco = []
  if (s.underline || font.underline) deco.push('underline')
  if (s.strikethrough || font.strike || font.strikethrough) deco.push('line-through')
  if (deco.length) style.textDecoration = deco.join(' ')

  // 边框：映射四个方向
  const mapBorder = (bd) => {
    if (!bd) return undefined
    const bStyle = bd.style || 'thin'
    const bColor = normalizeColor(bd.color) || '#888'
    const widthMap = { thin: '1px', medium: '2px', thick: '3px', dashed: '1px', dotted: '1px', double: '3px' }
    const styleMap = { thin: 'solid', medium: 'solid', thick: 'solid', dashed: 'dashed', dotted: 'dotted', double: 'double' }
    return `${widthMap[bStyle] || '1px'} ${styleMap[bStyle] || 'solid'} ${bColor}`
  }
  if (borderObj.top) style.borderTop = mapBorder(borderObj.top)
  if (borderObj.bottom) style.borderBottom = mapBorder(borderObj.bottom)
  if (borderObj.left) style.borderLeft = mapBorder(borderObj.left)
  if (borderObj.right) style.borderRight = mapBorder(borderObj.right)

  return style
}

// ============================================================================
// 预览数字格式化：将 cell.value + numberFormat 转为显示文本
// ============================================================================

function formatCellValue(value, numberFormat) {
  if (value === undefined || value === null || value === '') return ''
  const normalizeDateLikeText = (raw) => {
    if (raw === undefined || raw === null || raw === '') return ''
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return `${raw.getFullYear()}/${raw.getMonth() + 1}/${raw.getDate()}`
    }
    let text = String(raw).trim()
    if (!text) return ''
    text = text
      .replace(/\\"/g, '"')
      .replace(/^["']+|["']+$/g, '')
      .trim()
    const m = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (m) return `${m[1]}/${Number(m[2])}/${Number(m[3])}`
    const zh = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (zh) return `${zh[1]}/${Number(zh[2])}/${Number(zh[3])}`
    return ''
  }
  const dateText = normalizeDateLikeText(value)
  if (!numberFormat || numberFormat === 'General') {
    return dateText || String(value)
  }
  const num = Number(value)

  // 百分比格式
  if (!isNaN(num) && numberFormat.includes('%')) {
    const decMatch = numberFormat.match(/0\.(0+)%/)
    const dec = decMatch ? decMatch[1].length : 0
    return (num * 100).toFixed(dec) + '%'
  }

  // 货币格式：提取货币符号
  const curMatch = numberFormat.match(/^"([^"]+)"/)
  if (!isNaN(num) && curMatch) {
    const sym = curMatch[1]
    const decMatch = numberFormat.match(/0\.(0+)/)
    const dec = decMatch ? decMatch[1].length : 0
    return sym + num.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })
  }

  // 千分位数字格式
  if (!isNaN(num) && (numberFormat.includes('#,##0') || numberFormat.includes(','))) {
    const decMatch = numberFormat.match(/0\.(0+)/)
    const dec = decMatch ? decMatch[1].length : 0
    return num.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })
  }

  // 日期格式（简化：识别 yyyy/mm/dd 类模式）
  if (/[ymd]{2,4}/i.test(numberFormat)) {
    if (dateText) return dateText
    if (isNaN(num)) return String(value)
    const d = new Date((num - 25569) * 86400000)
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
      return numberFormat.replace(/yyyy/gi, y).replace(/mm/g, m).replace(/dd/g, day)
    }
  }

  return String(value)
}

// ============================================================================
// 预览条件格式评估：将 sheet 级条件规则应用到单元格样式
// ============================================================================

function evaluateConditionalFormats(sheet) {
  const rules = sheet?.conditionalFormats
  if (!rules || !rules.length) return {}
  const applied = {}
  const toNumberLoose = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
    if (typeof v !== 'string') return NaN
    const text = v.trim().replace(/,/g, '')
    if (!text) return NaN
    if (text.endsWith('%')) {
      const n = Number(text.slice(0, -1))
      return Number.isFinite(n) ? n / 100 : NaN
    }
    const n = Number(text)
    return Number.isFinite(n) ? n : NaN
  }

  for (const rule of rules) {
    const { startRow, startCol, endRow, endCol, condition, format } = rule
    if (!condition) continue

    // 色阶类型：按数值大小渐变色
    if (condition.type === 'colorScale') {
      const nums = []
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const v = toNumberLoose(sheet.data?.[r]?.[c]?.value)
          if (!isNaN(v)) nums.push({ r, c, v })
        }
      }
      if (nums.length) {
        const min = Math.min(...nums.map(n => n.v))
        const max = Math.max(...nums.map(n => n.v))
        const mc = condition.minColor || '#DCFCE7'
        const xc = condition.maxColor || '#FEE2E2'
        const eps = 1e-9
        // 按产品交互预期：仅最小值与最大值着色，中间值不着色
        if (Math.abs(max - min) <= eps) {
          continue
        }
        for (const { r, c, v } of nums) {
          if (Math.abs(v - min) <= eps) {
            applied[`${r}:${c}`] = { backgroundColor: mc }
          } else if (Math.abs(v - max) <= eps) {
            applied[`${r}:${c}`] = { backgroundColor: xc }
          }
        }
      }
      continue
    }

    // 数据条类型：单元格内百分比色块
    if (condition.type === 'dataBar') {
      const nums = []
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const v = toNumberLoose(sheet.data?.[r]?.[c]?.value)
          if (!isNaN(v)) nums.push({ r, c, v })
        }
      }
      if (nums.length) {
        const min = Math.min(...nums.map(n => n.v))
        const max = Math.max(...nums.map(n => n.v))
        const span = max - min
        const barColor = condition.barColor || '#60A5FA'
        for (const { r, c, v } of nums) {
          let pct
          if (span <= 0) {
            // 单值/全相同场景：按值本身当百分比显示（0~100）
            pct = Math.max(0, Math.min(100, v))
          } else {
            pct = Math.max(0, Math.min(100, ((v - min) / span) * 100))
          }
          applied[`${r}:${c}`] = {
            backgroundImage: `linear-gradient(90deg, ${barColor}33 ${pct}%, transparent ${pct}%)`,
          }
        }
      }
      continue
    }

    // 条件高亮类型
    if (!format) continue
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const cell = sheet.data?.[r]?.[c]
        const raw = cell?.value
        const num = toNumberLoose(raw)
        const condNum = toNumberLoose(condition.value)
        const condNum2 = toNumberLoose(condition.value2)
        let match = false

        switch (condition.type) {
          case 'greaterThan': match = !isNaN(num) && !isNaN(condNum) && num > condNum; break
          case 'greaterThanOrEqual': match = !isNaN(num) && !isNaN(condNum) && num >= condNum; break
          case 'lessThan':    match = !isNaN(num) && !isNaN(condNum) && num < condNum; break
          case 'lessThanOrEqual': match = !isNaN(num) && !isNaN(condNum) && num <= condNum; break
          case 'equal':
            if (!isNaN(num) && !isNaN(condNum)) match = num === condNum
            else match = String(raw) === String(condition.value)
            break
          case 'notEqual':
            if (!isNaN(num) && !isNaN(condNum)) match = num !== condNum
            else match = String(raw) !== String(condition.value)
            break
          case 'between':     match = !isNaN(num) && !isNaN(condNum) && !isNaN(condNum2) && num >= condNum && num <= condNum2; break
          case 'contains':    match = String(raw || '').includes(String(condition.value)); break
          case 'notContains': match = !String(raw || '').includes(String(condition.value)); break
          default: break
        }

        if (match) {
          const key = `${r}:${c}`
          const s = {}
          if (format.fill?.color) s.backgroundColor = format.fill.color
          if (format.font?.color) s.color = normalizeColor(format.font.color)
          applied[key] = s
        }
      }
    }
  }
  return applied
}

// ============================================================================
// 预览数据验证提示：将 dataValidations 映射到单元格提示文案
// ============================================================================

function evaluateDataValidations(sheet) {
  const rules = sheet?.dataValidations
  if (!rules || !rules.length) return {}
  const map = {}

  for (const rule of rules) {
    const { startRow, startCol, endRow, endCol, validation } = rule || {}
    if (!startRow || !startCol || !endRow || !endCol) continue
    const v = validation || {}
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
        map[`${r}:${c}`] = tip
      }
    }
  }

  return map
}

function extractPreviewCommentText(cell) {
  if (!cell) return ''
  if (typeof cell.comment === 'string') return cell.comment
  if (typeof cell.note === 'string') return cell.note
  if (Array.isArray(cell.comments) && cell.comments.length > 0) {
    const first = cell.comments[0]
    return first?.text || first?.content || ''
  }
  return ''
}

function getPreviewGridBounds(previewSheet, rowLimit = 50, colLimit = 16) {
  if (!previewSheet?.data) return { rowNums: [], colNums: [] }

  const hiddenRows = new Set((previewSheet.hiddenRows || []).map(Number).filter(n => !Number.isNaN(n)))
  const hiddenCols = new Set((previewSheet.hiddenColumns || []).map(Number).filter(n => !Number.isNaN(n)))
  const dataRowNums = Object.keys(previewSheet.data).map(Number).filter(n => !Number.isNaN(n))
  if (!dataRowNums.length && !Number(previewSheet.rowCount || 0)) return { rowNums: [], colNums: [] }

  // 行预览使用连续区间：可显示“插入后的空行”，再过滤 hiddenRows
  const maxDataRow = dataRowNums.length ? Math.max(...dataRowNums) : 0
  const declaredRowCount = Number(previewSheet.rowCount) || 0
  const maxRow = Math.max(maxDataRow, declaredRowCount, 1)
  const rowNumsAll = Array.from({ length: maxRow }, (_, i) => i + 1).filter(r => !hiddenRows.has(r))
  if (!rowNumsAll.length) return { rowNums: [], colNums: [] }

  const colNumsAll = new Set()
  for (const rowObj of Object.values(previewSheet.data)) {
    if (!rowObj) continue
    for (const colKey of Object.keys(rowObj)) {
      const col = Number(colKey)
      if (!Number.isNaN(col) && !hiddenCols.has(col)) {
        colNumsAll.add(col)
      }
    }
  }
  const sortedCols = [...colNumsAll].sort((a, b) => a - b)
  if (!sortedCols.length) return { rowNums: [], colNums: [] }

  // 关键：使用过滤后的离散行号，避免把 hiddenRows 通过连续区间又“补回来”
  const rowNums = [...rowNumsAll].sort((a, b) => a - b).slice(0, rowLimit)
  const colNums = sortedCols.slice(0, colLimit)
  return { rowNums, colNums }
}

function buildPreviewCell({ previewSheet, rowNum, colNum, condStyles, validationTips, touchedMapForActiveSheet }) {
  const cell = previewSheet.data?.[rowNum]?.[colNum]
  const condKey = `${rowNum}:${colNum}`
  const validationTip = validationTips[condKey]
  if (!cell && !validationTip) return { text: '', style: null }

  // 显示文本：有实值时格式化显示，否则回退到公式文本
  const hasValue = cell?.value !== undefined && cell?.value !== null && cell?.value !== ''
  const nf = cell?.style?.numberFormat
  const rawText = hasValue
    ? formatCellValue(cell?.value, nf)
    : (cell?.formula ? String(cell.formula) : '')

  // 构建样式（含条件格式叠加）
  const baseStyle = buildPreviewCellStyle(cell)
  const condStyle = condStyles[condKey]
  const mergedStyle = condStyle ? { ...baseStyle, ...condStyle } : baseStyle

  // 元数据标记
  const flags = []
  const commentText = extractPreviewCommentText(cell)
  if (commentText) flags.push('comment')
  if (cell?.hyperlink) flags.push('hyperlink')
  if (validationTip) flags.push('validation')

  return {
    text: rawText,
    style: mergedStyle,
    touched: !!touchedMapForActiveSheet[condKey],
    flags,
    validationTip,
    commentText,
    merge: null,
    mergeHidden: false,
  }
}

function buildPreviewRows({ previewSheet, rowNums, colNums, condStyles, validationTips, touchedMapForActiveSheet }) {
  return rowNums.map((rowNum) => (
    colNums.map((colNum) => (
      buildPreviewCell({ previewSheet, rowNum, colNum, condStyles, validationTips, touchedMapForActiveSheet })
    ))
  ))
}

function applyMergedCellsToRows(rows, rowNums, colNums, mergedCells) {
  const mergeRanges = Array.isArray(mergedCells) ? mergedCells : []
  if (mergeRanges.length === 0) return rows

  const rowIndexMap = new Map(rowNums.map((n, i) => [n, i]))
  const colIndexMap = new Map(colNums.map((n, i) => [n, i]))

  mergeRanges.forEach(range => {
    const startRow = Number(range?.startRow)
    const endRow = Number(range?.endRow)
    const startCol = Number(range?.startCol)
    const endCol = Number(range?.endCol)
    if (!Number.isFinite(startRow) || !Number.isFinite(endRow) || !Number.isFinite(startCol) || !Number.isFinite(endCol)) {
      return
    }
    const anchorRowIdx = rowIndexMap.get(startRow)
    const anchorColIdx = colIndexMap.get(startCol)
    // 锚点不在预览视窗内时，跳过，避免误隐藏
    if (anchorRowIdx === undefined || anchorColIdx === undefined) return

    const visibleRowIdxs = []
    for (let r = startRow; r <= endRow; r++) {
      const idx = rowIndexMap.get(r)
      if (idx !== undefined) visibleRowIdxs.push(idx)
    }
    const visibleColIdxs = []
    for (let c = startCol; c <= endCol; c++) {
      const idx = colIndexMap.get(c)
      if (idx !== undefined) visibleColIdxs.push(idx)
    }
    if (visibleRowIdxs.length === 0 || visibleColIdxs.length === 0) return

    const rowSpan = visibleRowIdxs.length
    const colSpan = visibleColIdxs.length
    rows[anchorRowIdx][anchorColIdx].merge = { rowSpan, colSpan }

    visibleRowIdxs.forEach(rIdx => {
      visibleColIdxs.forEach(cIdx => {
        if (rIdx === anchorRowIdx && cIdx === anchorColIdx) return
        rows[rIdx][cIdx].mergeHidden = true
      })
    })
  })

  return rows
}

function buildSkillPreviewGrid(previewSheet, touchedMapForActiveSheet) {
  const { rowNums, colNums } = getPreviewGridBounds(previewSheet)
  if (!rowNums.length || !colNums.length) return { rowNums: [], colNums: [], rows: [], colWidths: [], rowHeights: [] }

  // 条件格式规则 -> 直接样式映射
  const condStyles = evaluateConditionalFormats(previewSheet)
  const validationTips = evaluateDataValidations(previewSheet)
  const rows = buildPreviewRows({
    previewSheet,
    rowNums,
    colNums,
    condStyles,
    validationTips,
    touchedMapForActiveSheet
  })
  applyMergedCellsToRows(rows, rowNums, colNums, previewSheet?.mergedCells)
  const colWidths = colNums.map((colNum) => {
    const raw = previewSheet?.colWidths?.[colNum]
    const width = Number(raw)
    // 预览默认宽度与编辑器保持一致（100px），避免“未设置列被均分”掩盖宽度变化
    return Number.isFinite(width) && width > 0 ? width : 100
  })
  const rowHeights = rowNums.map((rowNum) => {
    const raw = previewSheet?.rowHeights?.[rowNum]
    const height = Number(raw)
    return Number.isFinite(height) && height > 0 ? height : 25
  })
  return { rowNums, colNums, rows, colWidths, rowHeights }
}

// ============================================================================
// 工作簿状态横幅
// ============================================================================

function WorkbookBanner({ hasWorkbook, fileName }) {
  if (hasWorkbook) {
    return (
      <div className="sk-workbook-banner-ok">
        <FileSpreadsheet size={13} />
        <span>当前文件：<strong>{fileName}</strong></span>
      </div>
    )
  }
  return (
    <div className="sk-workbook-banner">
      <FolderOpen size={13} />
      <span>请先在<strong>左侧文件树</strong>选择一个工作簿文件，技能将作用于当前已打开的文件</span>
    </div>
  )
}

// ============================================================================
// 技能卡片
// ============================================================================

function SkillCard({ skill, selected, onSelect, onRun, onExport, onDelete, canRun }) {
  return (
    <div
      className={`sk-card${selected ? ' sk-card--selected' : ''}`}
      onClick={() => onSelect(skill)}
    >
      <div className="sk-card-body">
        <div className="sk-card-header">
          <span className="sk-card-name">{skill.name}</span>
          {skill.is_preset && <span className="sk-card-preset-badge">预设</span>}
        </div>
        <div className="sk-card-desc">{skill.description || '暂无描述'}</div>
        <div className="sk-card-meta">
          <span className="sk-card-steps-count">
            <Layers size={11} />
            {skill.steps?.length || 0} 步
          </span>
          {(skill.tags || []).slice(0, 3).map(tag => (
            <span key={tag} className="sk-card-tag">{tag}</span>
          ))}
        </div>
      </div>
      <div className="sk-card-actions">
        <button
          type="button"
          className={`sk-card-run-btn${!canRun ? ' sk-card-run-btn--disabled' : ''}`}
          title={canRun ? '立即执行' : '请先选择工作簿文件'}
          disabled={!canRun}
          onClick={e => { e.stopPropagation(); if (canRun) onRun(skill) }}
        >
          <Play size={12} />
        </button>
        <button
          type="button"
          className="sk-card-run-btn sk-card-export-btn"
          title="导出 SKILL.md"
          onClick={e => { e.stopPropagation(); onExport?.(skill) }}
        >
          <Download size={12} />
        </button>
        {!skill.is_preset && (
          <button
            type="button"
            className="sk-card-run-btn sk-card-delete-btn"
            title="删除技能"
            onClick={e => { e.stopPropagation(); onDelete?.(skill) }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// 标签输入器
// ============================================================================

function TagInput({ tags, onChange, disabled = false }) {
  const [input, setInput] = useState('')

  const addTag = useCallback(() => {
    const t = input.trim()
    if (!t || tags.includes(t)) return
    onChange([...tags, t])
    setInput('')
  }, [input, tags, onChange])

  return (
    <div className="sk-tag-input">
      {tags.map(tag => (
        <span key={tag} className="sk-tag-pill">
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter(t => t !== tag))}
            disabled={disabled}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="sk-tag-input-field"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
        placeholder="+ 标签 Enter"
        disabled={disabled}
      />
    </div>
  )
}

// ============================================================================
// SkillManagerPage
// ============================================================================

export default function SkillManagerPage({
  accessToken,
  workbook,
  activeSheet,
  onRunSkill,
  selectedSidebarFile,
  currentFileName,
  skillSandboxPending = false,
  skillActionNotice = '',
  skillPreviewRefreshToken = 0,
  skillPreviewTouchedMap = {},
  onPersistSkillSandbox,
  onDiscardSkillSandbox,
}) {
  const [skills, setSkills] = useState([])
  const [selectedSkill, setSelectedSkill] = useState(null)
  const [form, setForm] = useState(emptySkill())
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [mdPanelWidth, setMdPanelWidth] = useState(420)
  const [resizingMdPanel, setResizingMdPanel] = useState(false)
  const [previewMd, setPreviewMd] = useState(false)
  const fileInputRef = useRef(null)
  const resizeStartRef = useRef({ x: 0, width: 420, minWidth: 320, maxWidth: 560 })
  const builderWrapRef = useRef(null)

  // ---- 范围选择交互状态 ----
  const [rangeSelectActive, setRangeSelectActive] = useState(false)
  const [rangeSelectStart, setRangeSelectStart] = useState(null)
  const [rangeSelectEnd, setRangeSelectEnd] = useState(null)
  const rangeSelectCallbackRef = useRef(null)
  const rangeSelectModeRef = useRef('range')

  // 以左侧文件树的实际选中项作为“已选文件”判定，避免 workbook 缺少 fileName 字段导致误判
  const fileName = selectedSidebarFile?.file_name || selectedSidebarFile?.name || currentFileName || ''
  const hasWorkbook = !!selectedSidebarFile?.id
  const sheets = workbook?.sheets?.map(s => s.name) || []
  const activeSheetName = activeSheet || workbook?.activeSheet || sheets[0] || ''
  const previewSheet = workbook?.sheets?.find(s => s.name === activeSheetName) || workbook?.sheets?.[0] || null
  const touchedMapForActiveSheet = skillPreviewTouchedMap?.[activeSheetName] || {}

  const previewGrid = useMemo(() => {
    return buildSkillPreviewGrid(previewSheet, touchedMapForActiveSheet)
  }, [previewSheet, skillPreviewRefreshToken, touchedMapForActiveSheet])

  // ---- 范围选择：从参数输入框触发 ----
  const handleRequestRangeSelect = useCallback((callback, mode) => {
    rangeSelectCallbackRef.current = callback
    rangeSelectModeRef.current = mode || 'range'
    setRangeSelectActive(true)
    setRangeSelectStart(null)
    setRangeSelectEnd(null)
  }, [])

  const handlePreviewCellMouseDown = useCallback((rowNum, colNum) => {
    if (!rangeSelectActive) return
    setRangeSelectStart({ row: rowNum, col: colNum })
    setRangeSelectEnd({ row: rowNum, col: colNum })
  }, [rangeSelectActive])

  const handlePreviewCellMouseOver = useCallback((rowNum, colNum) => {
    if (!rangeSelectActive || !rangeSelectStart) return
    if (rangeSelectModeRef.current === 'cell') return
    setRangeSelectEnd({ row: rowNum, col: colNum })
  }, [rangeSelectActive, rangeSelectStart])

  const handlePreviewCellMouseUp = useCallback(() => {
    if (!rangeSelectActive || !rangeSelectStart) return
    const start = rangeSelectStart
    const end = rangeSelectEnd || start
    const r1 = Math.min(start.row, end.row)
    const c1 = Math.min(start.col, end.col)
    const r2 = Math.max(start.row, end.row)
    const c2 = Math.max(start.col, end.col)

    let result
    if (rangeSelectModeRef.current === 'cell') {
      result = `${colNumToLetter(start.col)}${start.row}`
    } else if (r1 === r2 && c1 === c2) {
      result = `${colNumToLetter(c1)}${r1}`
    } else {
      result = `${colNumToLetter(c1)}${r1}:${colNumToLetter(c2)}${r2}`
    }

    rangeSelectCallbackRef.current?.(result)
    setRangeSelectActive(false)
    setRangeSelectStart(null)
    setRangeSelectEnd(null)
    rangeSelectCallbackRef.current = null
  }, [rangeSelectActive, rangeSelectStart, rangeSelectEnd])

  // 判断单元格是否在当前选择范围内
  const isInRangeSelection = useCallback((rowNum, colNum) => {
    if (!rangeSelectActive || !rangeSelectStart) return false
    const end = rangeSelectEnd || rangeSelectStart
    const r1 = Math.min(rangeSelectStart.row, end.row)
    const c1 = Math.min(rangeSelectStart.col, end.col)
    const r2 = Math.max(rangeSelectStart.row, end.row)
    const c2 = Math.max(rangeSelectStart.col, end.col)
    return rowNum >= r1 && rowNum <= r2 && colNum >= c1 && colNum <= c2
  }, [rangeSelectActive, rangeSelectStart, rangeSelectEnd])

  // ---- 加载技能列表 ----
  const loadSkills = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const data = await skillApi.listSkills(accessToken)
      setSkills(data.skills || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => { loadSkills() }, [loadSkills])

  // ---- 选中技能 -> 填入表单 ----
  const handleSelect = useCallback((skill) => {
    setSelectedSkill(skill)
    setForm({
      id: skill.id,
      name: skill.name,
      description: skill.description || '',
      tags: skill.tags || [],
      scope: skill.scope || { mode: 'all_sheets', sheet: '' },
      steps: skill.steps || [],
    })
    setError('')
    setSuccess('')
  }, [])

  // ---- 新建 ----
  const handleNew = useCallback(() => {
    setSelectedSkill(null)
    setForm(emptySkill())
    setError('')
    setSuccess('')
  }, [])

  // ---- 保存 ----
  const handleSave = useCallback(async () => {
    if (!form.name.trim()) { setError('技能名称不能为空'); return }
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description,
        steps: form.steps,
        scope: { mode: form.scope.mode, sheet: form.scope.sheet || null },
        tags: form.tags,
      }
      const saved = form.id
        ? await skillApi.updateSkill(accessToken, form.id, payload)
        : await skillApi.createSkill(accessToken, payload)
      await loadSkills()
      setSelectedSkill(saved)
      setForm(f => ({ ...f, id: saved.id }))
      setSuccess('保存成功')
      setTimeout(() => setSuccess(''), 3000)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }, [form, accessToken, loadSkills])

  // ---- 删除 ----
  const handleDelete = useCallback(async () => {
    if (!form.id) return
    if (!window.confirm(`确认删除技能「${form.name}」？`)) return
    try {
      await skillApi.deleteSkill(accessToken, form.id)
      await loadSkills()
      setSelectedSkill(null)
      setForm(emptySkill())
      setSuccess('已删除')
      setTimeout(() => setSuccess(''), 2000)
    } catch (e) {
      setError(e.message)
    }
  }, [form, accessToken, loadSkills])

  // ---- 导出 .md ----
  const handleExport = useCallback(() => downloadSkillMd(form), [form])
  const handleExportUniversal = useCallback(() => downloadUniversalSkillMd(form), [form])

  // ---- 导入 .md ----
  const handleImportClick = useCallback(() => fileInputRef.current?.click(), [])

  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const parsed = fromMarkdown(text)
    if (!parsed) { setError('无法解析 .md 文件，请确认格式符合 SKILL.md 标准'); return }
    setSelectedSkill(null)
    setForm({ id: null, ...parsed })
    setError('')
    setSuccess('已导入，请检查后保存')
    e.target.value = ''
  }, [])

  // ---- 拖拽导入 ----
  const handleDragOver = useCallback((e) => { e.preventDefault() }, [])
  const handleDropImport = useCallback(async (e) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file || !file.name.endsWith('.md')) return
    const text = await file.text()
    const parsed = fromMarkdown(text)
    if (!parsed) { setError('无法解析拖入的 .md 文件'); return }
    setSelectedSkill(null)
    setForm({ id: null, ...parsed })
    setSuccess('已导入，请检查后保存')
  }, [])

  // ---- 执行技能 ----
  const handleRun = useCallback((skill) => onRunSkill?.(skill), [onRunSkill])

  // ---- 从卡片导出 SKILL.md ----
  const handleExportFromCard = useCallback((skill) => downloadSkillMd(skill), [])

  // ---- 从卡片删除技能 ----
  const handleDeleteFromCard = useCallback(async (skill) => {
    if (!skill?.id) return
    if (!window.confirm(`确认删除技能「${skill.name}」？`)) return
    try {
      await skillApi.deleteSkill(accessToken, skill.id)
      await loadSkills()
      if (selectedSkill?.id === skill.id) {
        setSelectedSkill(null)
        setForm(emptySkill())
      }
      setSuccess('已删除')
      setTimeout(() => setSuccess(''), 2000)
    } catch (e) {
      setError(e.message)
    }
  }, [accessToken, loadSkills, selectedSkill])

  // ---- 复制 SKILL.md 内容到剪贴板 ----
  const handleCopyMd = useCallback(() => {
    const md = toMarkdown(form)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(md)
        .then(() => { setSuccess('已复制 SKILL.md 内容'); setTimeout(() => setSuccess(''), 2000) })
        .catch(() => fallbackCopy(md))
    } else {
      fallbackCopy(md)
    }
    function fallbackCopy(text) {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setSuccess('已复制 SKILL.md 内容')
        setTimeout(() => setSuccess(''), 2000)
      } catch {
        setError('复制失败')
      }
      document.body.removeChild(ta)
    }
  }, [form])

  // ---- 过滤列表 ----
  const filteredSkills = skills.filter(s => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
  })

  // ---- 右侧 SKILL.md 面板宽度拖拽 ----
  const handleMdResizeStart = useCallback((e) => {
    e.preventDefault()
    const wrapWidth = builderWrapRef.current?.clientWidth || 960
    const minWidth = Math.max(320, Math.floor(wrapWidth / 3))
    const maxWidth = Math.max(minWidth + 80, Math.floor(wrapWidth * 0.72))
    resizeStartRef.current = { x: e.clientX, width: mdPanelWidth, minWidth, maxWidth }
    setResizingMdPanel(true)
  }, [mdPanelWidth])

  useEffect(() => {
    if (!resizingMdPanel) return undefined
    const handleMouseMove = (e) => {
      const delta = resizeStartRef.current.x - e.clientX
      const nextWidth = Math.max(
        resizeStartRef.current.minWidth,
        Math.min(resizeStartRef.current.maxWidth, resizeStartRef.current.width + delta)
      )
      setMdPanelWidth(nextWidth)
    }
    const handleMouseUp = () => setResizingMdPanel(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [resizingMdPanel])

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <div className="sk-page">

      {/* ===== 左侧：技能列表 ===== */}
      <aside
        className="sk-list-panel"
        onDragOver={handleDragOver}
        onDrop={handleDropImport}
      >
        {/* 品牌区 */}
        <div className="sk-brand">
          <div className="sk-brand-icon">
            <Zap size={18} />
          </div>
          <div>
            <div className="sk-brand-title">玩数据 Skill</div>
            <div className="sk-brand-subtitle">灵活组装 · 沙箱执行</div>
          </div>
          <span className="sk-brand-badge">Beta</span>
        </div>

        {/* 工作簿状态横幅 */}
        <WorkbookBanner hasWorkbook={hasWorkbook} fileName={fileName} />

        {/* 搜索 + 操作 */}
        <div className="sk-list-toolbar">
          <div className="sk-search-wrap">
            <Search size={13} className="sk-search-icon" />
            <input
              className="sk-search-input"
              placeholder="搜索技能..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="sk-list-actions">
            <button
              type="button"
              className="sk-btn sk-btn-ghost"
              onClick={handleImportClick}
              title={hasWorkbook ? '导入 .md' : '请先选择工作簿文件'}
              disabled={!hasWorkbook}
            >
              <Upload size={13} />
              导入
            </button>
            <button
              type="button"
              className="sk-btn sk-btn-primary"
              onClick={handleNew}
              title={hasWorkbook ? '新建技能' : '请先选择工作簿文件'}
              disabled={!hasWorkbook}
            >
              <Plus size={13} />
              新建
            </button>
          </div>
        </div>

        {/* 技能卡片列表 */}
        <div className="sk-cards-scroll">
          {loading ? (
            <div className="sk-list-state">
              <Loader size={18} className="sk-spin" />
              <span>加载中...</span>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="sk-list-state sk-list-empty">
              <BookOpen size={28} />
              <span>暂无技能</span>
              <span className="sk-list-empty-hint">点击「新建」或拖入 .md 文件</span>
            </div>
          ) : (
            filteredSkills.map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                selected={selectedSkill?.id === skill.id}
                onSelect={handleSelect}
                onRun={handleRun}
                onExport={handleExportFromCard}
                onDelete={handleDeleteFromCard}
                canRun={hasWorkbook}
              />
            ))
          )}
        </div>

        <div className="sk-drop-hint">
          <FileCode2 size={12} />
          拖拽 .md 文件可快速导入
        </div>

        <input ref={fileInputRef} type="file" accept=".md" style={{ display: 'none' }} onChange={handleFileChange} />
      </aside>

      {/* ===== 右侧：编辑区 ===== */}
      <main className="sk-editor-panel">

        {/* ---- 无工作簿时的显眼门控提示 ---- */}
        {!hasWorkbook && (
          <div className="sk-editor-gate">
            <div className="sk-editor-gate-card">
              <div className="sk-editor-gate-icon">
                <FolderOpen size={40} />
              </div>
              <div className="sk-editor-gate-title">请先选择工作簿文件</div>
              <div className="sk-editor-gate-desc">
                在左侧文件树中点击一个 <strong>.xlsx</strong> 文件<br />
                技能将作用于该工作簿，所有操作按钮随即解锁
              </div>
              <div className="sk-editor-gate-arrow">
                ← 从左侧选择文件
              </div>
            </div>
          </div>
        )}

        {/* ---- 元数据区 ---- */}
        <section className={`sk-meta-section${!hasWorkbook ? ' sk-locked' : ''}`}>
          <input
            className="sk-meta-name"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="技能名称（英文大写，如 MY_SKILL）"
            disabled={!hasWorkbook}
          />
          <textarea
            className="sk-meta-desc"
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            placeholder="描述：这个技能做什么，适合什么场景？"
            rows={2}
            disabled={!hasWorkbook}
          />

          <div className="sk-meta-row">
            <Tag size={12} className="sk-meta-icon" />
            <TagInput
              tags={form.tags}
              onChange={tags => setForm(f => ({ ...f, tags }))}
              disabled={!hasWorkbook}
            />
          </div>

          {/* 适用范围：仅在有工作簿时显示 */}
          {hasWorkbook && (
            <div className="sk-scope-row">
              <Settings2 size={13} className="sk-meta-icon" />
              <span className="sk-scope-label">适用范围</span>
              <select
                className="sk-scope-select"
                value={form.scope.mode}
                onChange={e => setForm(f => ({ ...f, scope: { ...f.scope, mode: e.target.value } }))}
              >
                <option value="all_sheets">所有工作表</option>
                <option value="named_sheet">指定工作表</option>
              </select>

              {form.scope.mode === 'named_sheet' && (
                sheets.length > 0 ? (
                  <select
                    className="sk-scope-select"
                    value={form.scope.sheet || ''}
                    onChange={e => setForm(f => ({ ...f, scope: { ...f.scope, sheet: e.target.value } }))}
                  >
                    <option value="">-- 选择工作表 --</option>
                    {sheets.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                ) : (
                  <div className="sk-scope-no-workbook">
                    <FolderOpen size={13} />
                    请在左侧选择工作簿文件
                  </div>
                )
              )}
            </div>
          )}
        </section>

        {/* ---- 步骤构建器 + 当前工作表预览（左右并排） ---- */}
        <div ref={builderWrapRef} className={`sk-builder-wrap${!hasWorkbook ? ' sk-locked' : ''}`}>
          {/* 步骤构建器主体 */}
          <div className="sk-builder-main">
            <SkillStepBuilder
              steps={form.steps}
              onChange={steps => setForm(f => ({ ...f, steps }))}
              disabled={!hasWorkbook}
              onRequestRangeSelect={handleRequestRangeSelect}
              sheetContext={previewSheet}
            />
          </div>

          {/* 分栏拖拽手柄 */}
          <button
            type="button"
            className={`sk-md-resizer${resizingMdPanel ? ' is-active' : ''}`}
            onMouseDown={handleMdResizeStart}
            title="拖拽调整工作表预览宽度"
            aria-label="拖拽调整工作表预览宽度"
          />

          {/* 当前工作表预览（右侧） - 支持点击/拖拽选择范围 */}
          <div className="sk-md-panel" style={{ width: `${mdPanelWidth}px` }}>
            {rangeSelectActive && (
              <div className="sk-range-select-hint">
                {rangeSelectModeRef.current === 'cell'
                  ? '点击一个单元格完成选择'
                  : '点击起始单元格并拖拽到结束位置'}
              </div>
            )}
            <div className={`sk-sheet-preview-wrap${rangeSelectActive ? ' sk-selecting' : ''}`}>
              {previewGrid.rows.length === 0 ? (
                <div className="sk-sheet-preview-empty">当前工作表暂无可预览数据</div>
              ) : (
                <table className="sk-sheet-preview-table" onMouseUp={handlePreviewCellMouseUp}>
                  <colgroup>
                    <col style={{ width: '42px' }} />
                    {previewGrid.colNums.map((colNum, idx) => {
                      const rawWidth = previewGrid.colWidths?.[idx]
                      const clamped = Number.isFinite(rawWidth) ? Math.max(36, Math.min(480, rawWidth)) : 100
                      return <col key={`w-${colNum}`} style={{ width: `${clamped}px` }} />
                    })}
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="sk-sheet-preview-corner">#</th>
                      {previewGrid.colNums.map((colNum) => (
                        <th key={colNum}>{colNumToLetter(colNum)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewGrid.rows.map((rowCells, rowIdx) => {
                      const rowNum = previewGrid.rowNums[rowIdx]
                      const rowHeight = Number(previewGrid.rowHeights?.[rowIdx])
                      const clampedRowHeight = Number.isFinite(rowHeight) ? Math.max(18, Math.min(240, rowHeight)) : null
                      return (
                        <tr key={rowNum} style={clampedRowHeight ? { height: `${clampedRowHeight}px` } : undefined}>
                          <th>{rowNum}</th>
                          {rowCells.map((cell, colIdx) => {
                            const colNum = previewGrid.colNums[colIdx]
                            if (cell?.mergeHidden) return null
                            const inSel = isInRangeSelection(rowNum, colNum)
                            const flags = cell?.flags || []
                            const cls = [
                              cell?.touched ? 'sk-sheet-cell-touched' : '',
                              inSel ? 'sk-sheet-cell-selected' : '',
                              flags.includes('comment') ? 'sk-cell-has-comment' : '',
                              flags.includes('hyperlink') ? 'sk-cell-has-link' : '',
                              flags.includes('validation') ? 'sk-cell-has-validation' : '',
                            ].filter(Boolean).join(' ')
                            const titleParts = []
                            if (flags.includes('comment') && cell?.commentText) titleParts.push(`批注: ${cell.commentText}`)
                            if (cell?.validationTip) titleParts.push(cell.validationTip)
                            return (
                              <td
                                key={`${rowNum}-${colNum}`}
                                className={cls || undefined}
                                style={cell?.style || undefined}
                                rowSpan={cell?.merge?.rowSpan || undefined}
                                colSpan={cell?.merge?.colSpan || undefined}
                                onMouseDown={() => handlePreviewCellMouseDown(rowNum, colNum)}
                                onMouseOver={() => handlePreviewCellMouseOver(rowNum, colNum)}
                                title={titleParts.length ? titleParts.join(' | ') : undefined}
                              >
                                {cell?.text || ''}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* ---- 底部操作栏 ---- */}
        <footer className="sk-bottom-bar">
          <div className="sk-status">
            {hasWorkbook && skillSandboxPending && (
              <span className="sk-status-sandbox-pending">
                本次 Skill 已成功执行（沙箱环境），您可以选择写回服务器。
              </span>
            )}
            {error && <span className="sk-status-error"><AlertCircle size={13} /> {error}</span>}
            {success && <span className="sk-status-success"><Check size={13} /> {success}</span>}
          </div>
          <div className="sk-bottom-actions-wrap">
            <div className="sk-bottom-actions">
            <button
              type="button"
              className="sk-btn sk-btn-accent sk-btn-sm sk-run-btn"
              onClick={() => { if (form.steps?.length) onRunSkill?.(form) }}
              disabled={!hasWorkbook || !form.steps?.length}
              title={!hasWorkbook ? '请先选择工作簿文件' : !form.steps?.length ? '请先添加执行步骤' : '在沙箱中执行当前技能'}
            >
              <Play size={14} />
              执行 Skill
            </button>
            <button
              type="button"
              className="sk-btn sk-btn-primary sk-btn-sm"
              onClick={onPersistSkillSandbox}
              disabled={!hasWorkbook || !skillSandboxPending}
              title={skillSandboxPending ? '将当前沙箱结果写回服务器文件' : '当前无待写回结果'}
            >
              <UploadCloud size={13} />
              写回服务器
            </button>
            <button
              type="button"
              className="sk-btn sk-btn-danger sk-btn-sm"
              onClick={onDiscardSkillSandbox}
              disabled={!hasWorkbook || !skillSandboxPending}
              title={skillSandboxPending ? '回滚到本次执行前状态' : '当前无可放弃结果'}
            >
              <Undo2 size={13} />
              回滚本次操作
            </button>
            <button
              type="button"
              className="sk-btn sk-btn-ghost sk-btn-sm"
              onClick={handleExportUniversal}
              title="导出通用 SKILL.md（适配 Claude Code / Cursor 等外部 Agent）"
              disabled={!hasWorkbook}
            >
              <FileCode2 size={13} />
              导出通用 SKILL.md
            </button>
            <button
              type="button"
              className="sk-btn sk-btn-accent sk-btn-sm"
              onClick={handleSave}
              disabled={saving || !hasWorkbook}
              title={!hasWorkbook ? '请先选择工作簿文件' : '保存技能'}
            >
              {saving ? <Loader size={13} className="sk-spin" /> : <Check size={13} />}
              保存技能
            </button>
            </div>
            {skillActionNotice && (
              <div className="sk-action-notice" title={skillActionNotice}>
                {skillActionNotice}
              </div>
            )}
          </div>
        </footer>

        {/* ---- SKILL.md 预览（下方） ---- */}
        <div className="sk-md-preview">
          <div className="sk-md-toggle-row">
            <button
              type="button"
              className="sk-md-toggle"
              onClick={() => setPreviewMd(v => !v)}
            >
              <ChevronDown
                size={13}
                style={{ transform: previewMd ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .2s' }}
              />
              预览 SKILL.md
            </button>
            {previewMd && (
              <button
                type="button"
                className="sk-md-copy-btn"
                onClick={handleCopyMd}
                title="复制 SKILL.md 内容"
              >
                <Copy size={12} />
                复制
              </button>
            )}
          </div>
          {previewMd && (
            <pre className="sk-md-content">{toMarkdown(form)}</pre>
          )}
        </div>
      </main>
    </div>
  )
}
