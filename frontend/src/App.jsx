// frontend/src/App.jsx
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import appConfig, { resolveApiBaseUrl } from './config/appConfig'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import ExcelEditor from './components/ExcelEditor'
import ExcelToolbar from './components/ExcelToolbar'
import FormulaBar from './components/FormulaBar'
import AIAssistant from './components/AIAssistant'
import ErrorBoundary from './components/ErrorBoundary'
import FindReplaceDialog from './components/FindReplaceDialog'
import FilterDialog from './components/FilterDialog'
import FormulaManagerDialog from './components/FormulaManagerDialog'
import StatusBar from './components/StatusBar'
import UniverSheetContainer from './univer/UniverSheetContainer'
import ReportView from './components/report/ReportView'
import PresentationView from './components/presentation/PresentationView'
import BatchWordView from './components/batch-word/BatchWordView'
import ViewPlaceholder from './components/ViewPlaceholder'
import CollectView from './components/collect/CollectView'
import ConnectView from './components/connect/ConnectView'
import SkillManagerPage from './components/SkillManagerPage'
import AnnouncementOverlay from './components/AnnouncementOverlay'
import ChartInsertDialog from './components/ChartInsertDialog'
import './styles/airtable-layout.css'
import './styles/skill.css'
import { useSSE } from './hooks/useSSE'
import { useWorkbookLoader } from './hooks/useWorkbookLoader'
import { useChartRegenAfterImport } from './hooks/useChartRegenAfterImport'
import { loadXlsxWithChartFallback } from './utils/excelChartImportFallback'
import { createWorkbook, executeOperation, readRangeValues, queryUniqueValuesReadonly, aggregateColumn, queryColumnProfile } from './utils/excelOperations'
import { renderChartToDataUrlAsync } from './utils/chartExport'
import { exceljsToWorkbook } from './utils/excelImport'
import { evaluateFormula, setWorkbookContext, resetFormulaErrorCount, clearFormulaErrorCache } from './utils/formulaEngine'
import { useAuth } from './contexts/AuthContext'
import { useConfig } from './contexts/ConfigContext'
import * as filesApi from './api/files'
import * as authApi from './api/auth'
import * as formulaApi from './api/formula'
import { executeSkill } from './utils/skillExecutor'
import { parseQuotaFromError } from './utils/quotaError'
import { flog, setLogUser } from './utils/frontendLogger'
import { useLayoutViewport } from './hooks/useLayoutViewport'
import { v4 as uuidv4 } from 'uuid'
import { BarChart2, Menu, X } from 'lucide-react'

/** 与后端 platform_settings / .env 兜底一致，直至拉取 GET /api/config/platform */
const FALLBACK_AUTO_ANALYZE_SIZE_BYTES = Math.round((appConfig.autoAnalyzeMaxFileSizeMb || 20) * 1024 * 1024)
const FALLBACK_AUTO_ANALYZE_ROW_THRESHOLD = Math.round(appConfig.autoAnalyzeMaxRows || 20000)
const ANALYZE_PREVIEW_PAGE_SIZE = 500
const DEFAULT_WORKSHEET_ROWS = 500
/** 分析视图中不展示的系统内置表，仅内部使用 */
const ANALYZE_META_SHEET = '__SHEETBOT_META__'
const AI_POPUP_AUTO_HIDE_MS = 5000
function filterAnalyzeSheetNames(names) {
  return (names || []).filter(n => n && n !== ANALYZE_META_SHEET)
}
const AUTO_SAVE_DEBOUNCE_MS = 5 * 60 * 1000

// ---- 用户可见错误脱敏：剥离技术细节，保留业务含义 ----
function sanitizeErrorForUser(raw) {
  if (!raw) return '抱歉，操作执行遇到问题，请稍后重试。'
  const s = String(raw)
  if (s.includes('还在学习中') || s.includes('抱歉')) return s
  if (s.includes('配额') || s.includes('quota') || s.includes('登录') || s.includes('过期')) return s
  if (/HTTP \d{3}|status[: ]\d{3}|traceback|stacktrace|Error:|TypeError|SyntaxError/i.test(s)) {
    return '抱歉，操作执行遇到问题，请稍后重试。'
  }
  if (/param|ruleType|startRow|endCol|frozenset|dict|int\b|str\b|\.py\b|\.js\b/i.test(s)) {
    return '抱歉，该操作暂时无法完成，请尝试用更简单的方式描述您的需求。'
  }
  return s
}

/**
 * 写入系统剪贴板，兼容 HTTP 环境（navigator.clipboard 仅在 HTTPS 下可用）
 * 优先使用 Clipboard API，不可用时降级为 execCommand('copy')
 */
function writeTextToSystemClipboard(text) {
  if (text == null || String(text).length === 0) return
  const str = String(text)
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(str).catch(() => fallbackCopy(str))
    return
  }
  fallbackCopy(str)
}
function fallbackCopy(text) {
  const el = document.createElement('textarea')
  el.value = text
  el.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  el.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(el)
  }
}

function stripAiMessagePrefix(text = '') {
  return String(text || '')
    .replace(/^[\s✅❌⚠️⏳📁📊📄🔧]+/g, '')
    .trim()
}

function getAiPopupFromMessage(msg, index = 0) {
  if (!msg) return null
  const content = stripAiMessagePrefix(msg.content)
  if (!content) return null

  if (msg.type === 'error') {
    return { key: msg.id || `error:${content}:${index}`, level: 'error', title: '操作失败', content }
  }
  if (msg.type === 'warning') {
    return { key: msg.id || `warning:${content}:${index}`, level: 'warning', title: '系统提醒', content }
  }
  if (msg.type === 'success') {
    return { key: msg.id || `success:${content}:${index}`, level: 'success', title: '操作完成', content }
  }
  if (msg.type === 'status') {
    // 过滤高频“处理中”播报，仅保留关键状态变化
    if (/处理中|正在/.test(content) && !/完成|就绪|失败|超时|断开|刷新|可开始/.test(content)) {
      return null
    }
    return { key: msg.id || `status:${content}:${index}`, level: 'info', title: '状态更新', content }
  }
  return null
}

function getUsedRange(sheet) {
  if (!sheet?.data) return null
  let minRow = Infinity, maxRow = 0, minCol = Infinity, maxCol = 0
  for (const [rowKey, rowData] of Object.entries(sheet.data)) {
    const rowNum = parseInt(rowKey)
    if (!rowData || Number.isNaN(rowNum)) continue
    for (const colKey of Object.keys(rowData)) {
      const colNum = parseInt(colKey)
      const cell = rowData[colKey]
      if (Number.isNaN(colNum) || !cell) continue
      if (cell.value === undefined && !cell.formula && !cell.style) continue
      if (rowNum < minRow) minRow = rowNum
      if (rowNum > maxRow) maxRow = rowNum
      if (colNum < minCol) minCol = colNum
      if (colNum > maxCol) maxCol = colNum
    }
  }
  if (!maxRow) return null
  return { startRow: minRow, startCol: minCol, endRow: maxRow, endCol: maxCol }
}

function hasCellContentForOneClick(cell) {
  if (!cell) return false
  if (cell.formula) return true
  const value = cell.value
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function isSheetEmptyForOneClick(sheet) {
  if (!sheet?.data) return true
  for (const rowData of Object.values(sheet.data)) {
    if (!rowData || typeof rowData !== 'object') continue
    for (const cell of Object.values(rowData)) {
      if (hasCellContentForOneClick(cell)) return false
    }
  }
  return true
}

function toSortKey(raw) {
  if (raw === null || raw === undefined || raw === '') return { rank: 9, v: 0 }
  if (typeof raw === 'number') return Number.isFinite(raw) ? { rank: 1, v: raw } : { rank: 9, v: 0 }
  if (typeof raw === 'boolean') return { rank: 1, v: raw ? 1 : 0 }
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/[\s,$￥¥]/g, '')
    const n = Number(cleaned)
    if (Number.isFinite(n)) return { rank: 1, v: n }
    return { rank: 2, v: raw.trim().toLocaleLowerCase() }
  }
  if (typeof raw === 'object') {
    if (raw.value !== undefined) return toSortKey(raw.value)
    if (raw.result !== undefined) return toSortKey(raw.result)
  }
  return { rank: 9, v: 0 }
}

function isDateLikeValue(text) {
  const t = String(text || '')
    .trim()
    .replace(/\\"/g, '"')
    .replace(/^["']+|["']+$/g, '')
  if (!t) return false
  if (/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.test(t)) return true
  if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(t)) return true
  return false
}

function isDateLikeFormat(format) {
  const f = String(format || '').toLowerCase()
  if (!f) return false
  return /(y|m|d|年|月|日)/.test(f) && !/(#|0\.0|%|currency|￥|¥|\$)/.test(f)
}

function excelSerialToYMD(serial) {
  const n = Number(serial)
  if (!Number.isFinite(n)) return ''
  const dt = new Date(Math.round((n - 25569) * 86400000))
  if (Number.isNaN(dt.getTime())) return ''
  return `${dt.getUTCFullYear()}/${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`
}

function normalizeDateText(raw) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.getFullYear()}/${raw.getMonth() + 1}/${raw.getDate()}`
  }
  const text = String(raw ?? '')
    .trim()
    .replace(/\\"/g, '"')
    .replace(/^["']+|["']+$/g, '')
  if (!text) return ''
  const anyMatch = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (anyMatch) return `${anyMatch[1]}/${Number(anyMatch[2])}/${Number(anyMatch[3])}`
  const normalized = text
    .replace('年', '/')
    .replace('月', '/')
    .replace('日', '')
    .replace(/-/g, '/')
  const m = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/)
  if (!m) return text
  return `${m[1]}/${Number(m[2])}/${Number(m[3])}`
}

function buildFindRegex(find, matchCase, matchWholeCell) {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = matchWholeCell ? `^${escaped}$` : escaped
  return new RegExp(pattern, matchCase ? 'g' : 'gi')
}

function getSortedRows(sheet) {
  return Object.keys(sheet?.data || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

function getSortedCols(rowData) {
  return Object.keys(rowData || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

function createBlankWorkbookState() {
  const wb = createWorkbook()
  wb.sheets = [{
    name: 'Sheet1',
    data: {},
    rowCount: DEFAULT_WORKSHEET_ROWS,
    colCount: 26,
    colWidths: {},
    rowHeights: {}
  }]
  wb.activeSheet = 'Sheet1'
  return wb
}

function getWorkbookMaxRowCount(excelWb) {
  if (!excelWb?.worksheets?.length) return 0
  return excelWb.worksheets
    .filter(ws => ws?.name !== '__SHEETBOT_META__')
    .reduce((maxRows, ws) => {
      const rowCount = Number(
        ws.actualRowCount ||
        ws.rowCount ||
        ws.lastRow?.number ||
        ws.dimensions?.bottom ||
        0
      )
      return Math.max(maxRows, Number.isFinite(rowCount) ? rowCount : 0)
    }, 0)
}

function getWorkbookCellDiffMap(beforeWb, afterWb) {
  const diffMap = {}
  const beforeSheets = new Map((beforeWb?.sheets || []).map(s => [s.name, s]))
  const afterSheets = new Map((afterWb?.sheets || []).map(s => [s.name, s]))
  const sheetNames = new Set([...beforeSheets.keys(), ...afterSheets.keys()])

  for (const sheetName of sheetNames) {
    const beforeData = beforeSheets.get(sheetName)?.data || {}
    const afterData = afterSheets.get(sheetName)?.data || {}
    const rowKeys = new Set([...Object.keys(beforeData), ...Object.keys(afterData)])
    let hasSheetChange = false

    for (const rowKey of rowKeys) {
      const beforeRow = beforeData[rowKey] || {}
      const afterRow = afterData[rowKey] || {}
      const colKeys = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)])

      for (const colKey of colKeys) {
        const beforeCell = beforeRow[colKey] ?? null
        const afterCell = afterRow[colKey] ?? null
        if (JSON.stringify(beforeCell) !== JSON.stringify(afterCell)) {
          if (!diffMap[sheetName]) diffMap[sheetName] = {}
          diffMap[sheetName][`${rowKey}:${colKey}`] = true
          hasSheetChange = true
        }
      }
    }

    if (!hasSheetChange && diffMap[sheetName]) {
      delete diffMap[sheetName]
    }

    // 非单元格结构变更（如筛选、列宽、行高、合并）也视为有效变更
    const beforeSheet = beforeSheets.get(sheetName) || {}
    const afterSheet = afterSheets.get(sheetName) || {}
    const beforeMeta = JSON.stringify({
      rowCount: beforeSheet.rowCount || 0,
      colCount: beforeSheet.colCount || 0,
      hiddenRows: beforeSheet.hiddenRows || [],
      hiddenColumns: beforeSheet.hiddenColumns || [],
      filters: beforeSheet.filters || [],
      colWidths: beforeSheet.colWidths || {},
      rowHeights: beforeSheet.rowHeights || {},
      mergedCells: beforeSheet.mergedCells || [],
      conditionalFormats: beforeSheet.conditionalFormats || [],
    })
    const afterMeta = JSON.stringify({
      rowCount: afterSheet.rowCount || 0,
      colCount: afterSheet.colCount || 0,
      hiddenRows: afterSheet.hiddenRows || [],
      hiddenColumns: afterSheet.hiddenColumns || [],
      filters: afterSheet.filters || [],
      colWidths: afterSheet.colWidths || {},
      rowHeights: afterSheet.rowHeights || {},
      mergedCells: afterSheet.mergedCells || [],
      conditionalFormats: afterSheet.conditionalFormats || [],
    })
    if (beforeMeta !== afterMeta) {
      if (!diffMap[sheetName]) diffMap[sheetName] = {}
      diffMap[sheetName].__meta__ = true
    }
  }

  return diffMap
}

const TOOL_LABEL_MAP = {
  add_sheet: '创建工作表',
  rename_sheet: '重命名工作表',
  set_active_sheet: '切换工作表',
  set_cell_value: '写入单元格',
  set_range_values: '批量填充数据',
  set_range_style: '设置样式',
  auto_fit_column: '调整列宽',
  create_chart: '生成图表',
  create_pivot_table: '创建透视表',
  calculate_statistics: '统计计算',
  conditional_format: '条件格式',
  sort_range: '排序',
  filter_data: '筛选数据',
  merge_cells: '合并单元格',
  insert_row: '插入行',
  insert_rows: '插入行',
  delete_row: '删除行',
  delete_rows: '删除行',
  insert_column: '插入列',
  delete_column: '删除列',
  summarize_by_column: '分类汇总',
  summarize_metrics_by_column: '指标汇总',
  batch_operations: '批量操作',
}

function getToolDisplayLabel(rawName) {
  if (!rawName) return '处理中'
  const normalized = String(rawName)
    .replace(/^mcp__excel-tools__/, '')
    .replace(/^mcp__large-file-tools__/, '')
    .trim()
  return TOOL_LABEL_MAP[normalized] || normalized
}

function toCompactThinkingMessage(rawMessage) {
  const text = String(rawMessage || '').trim()
  const match = text.match(/正在执行[:：]\s*([a-zA-Z0-9_\-:]+)/)
  if (match?.[1]) return `🔧 正在执行：${getToolDisplayLabel(match[1])}`
  return text
}

function sanitizeAssistantMessage(rawMessage) {
  const lines = String(rawMessage || '')
    .split('\n')
    .map(line => line.trimEnd())
  const filtered = lines.filter((line) => {
    if (!line) return true
    // 过滤模型/SDK 偶发的空占位文本，避免聊天区出现“(no content)”噪音消息
    if (/^\(\s*no\s+content\s*\)$/i.test(line.trim())) return false
    if (/^🔧\s*正在执行[:：]\s*正在执行:\s*mcp__/i.test(line)) return false
    if (/^🔧\s*正在执行[:：]\s*mcp__/i.test(line)) return false
    return true
  })
  return filtered.join('\n').trim()
}

function hasCompletionClaimText(message) {
  const text = String(message || '').trim()
  if (!text) return false
  return /(✅\s*操作已完成|操作已完成|已成功|已完成|创建完成|生成完成)/.test(text)
}

function isTransientExecutionMessage(msg) {
  if (!msg || typeof msg !== 'object') return false
  // 显式标记为持久化的消息，不参与中间态清理
  if (msg.persistent === true) return false
  if (['thinking', 'status', 'backend_progress'].includes(msg.type)) return true
  if (msg.type === 'assistant') {
    const text = String(msg.content || '').trim()
    // 这类“正在执行”提示是中间态，不应在任务结束后残留
    return /(🔧\s*)?正在执行[:：]/.test(text)
  }
  return false
}

function removeTransientExecutionMessages(messages) {
  return (messages || []).filter((m) => !isTransientExecutionMessage(m))
}

function App() {
  const { user, accessToken, refreshToken, saveTokens } = useAuth()
  const { preferences } = useConfig()
  const [autoAnalyzeThresholds, setAutoAnalyzeThresholds] = useState(() => ({
    sizeBytes: FALLBACK_AUTO_ANALYZE_SIZE_BYTES,
    rowThreshold: FALLBACK_AUTO_ANALYZE_ROW_THRESHOLD,
  }))
  const [sessionId] = useState(() => uuidv4())
  const [workbook, setWorkbook] = useState(() => createBlankWorkbookState())
  const [activeSheet, setActiveSheet] = useState('Sheet1')
  const [selection, setSelection] = useState({
    startRow: 1,
    startCol: 1,
    endRow: 1,
    endCol: 1,
    extraCells: []
  })
  const [editingCell, setEditingCell] = useState(null)
  const [formulaBarValue, setFormulaBarValue] = useState('')
  const [aiPanelOpen, setAiPanelOpen] = useState(true)
  const [aiMessages, setAiMessages] = useState([])
  const [aiPopupQueue, setAiPopupQueue] = useState([])
  const [activeAiPopup, setActiveAiPopup] = useState(null)
  const [isAiProcessing, setIsAiProcessing] = useState(false)
  // 执行进度追踪：{ phase: 'thinking'|'executing', opCount: number, lastOpDesc: string }
  const [executionProgress, setExecutionProgress] = useState(null)
  const editorRef = useRef(null)
  /** Univer 模式下 flush 到 SheetBot JSON，供 SSE / 发指令前合并 */
  const univerEditorRef = useRef(null)
  /** 与 Univer inject 对齐：在 setState 提交前同步写入用户选中的表，避免分析模式首次灌表 wantSheet 仍指向第一张 */
  const glideActiveSheetRef = useRef(null)
  /** 普通视图操作后期望激活的目标表：用于抵御 Univer 延迟快照回写造成的反向覆盖 */
  const pendingPreferredActiveSheetRef = useRef(null)
  const univerModeRef = useRef(false)
  const workbookRevisionRef = useRef(0)
  // 只读查询桥接：保持对最新 workbook 的引用，供 data_query handler 读取
  const workbookLatestRef = useRef(workbook)
  const aiMessagesRef = useRef([])
  const readyMessageShownRef = useRef(false)
  const processingTimeoutRef = useRef(null)
  const operationCompleteTimeoutRef = useRef(null)
  const aiResponseIdleTimeoutRef = useRef(null)
  const currentRequestIdRef = useRef(null)
  const requestExecutionStatsRef = useRef(new Map())
  const failedOperationRequestsRef = useRef(new Set())
  const operationErrorThrottleRef = useRef(new Map())
  const noOpWarningThrottleRef = useRef(new Map())
  const disconnectNoticeTimeoutRef = useRef(null)
  /** pushAiMessage 已入队 toast 的消息 id，避免与下方 fallback effect 重复入队 */
  const toastQueuedFromPushRef = useRef(new Set())
  /** 仅在新消息追加时跑兜底入队，避免 removeThinking 等导致末尾 id 回退重复弹窗 */
  const aiMessagesLenForToastRef = useRef(0)
  const aiPopupTimerRef = useRef(null)
  // 工作表元数据预缓存：文件加载后提前提取，减少首次命令发送耗时
  const workbookMetaCacheRef = useRef(null)
  const workbookSourceForCacheRef = useRef(null)
  // 上下文版本号：保证后端只消费最新上下文快照
  const contextVersionRef = useRef(0)

  useEffect(() => {
    aiMessagesRef.current = aiMessages
  }, [aiMessages])

  // ── 单张工作表元数据提取（标题行智能检测 + 样本数据截取）──
  // maxSampleRows: 非活动表传 5，活动表传 20，与 context_str 策略对齐
  const computeSheetMeta = useCallback((s, maxSampleRows = 5) => {
    const rowKeys = Object.keys(s.data || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
    const firstRow = rowKeys.length > 0 ? rowKeys[0] : 1
    const lastRow = rowKeys.length > 0 ? rowKeys[rowKeys.length - 1] : 1

    // ExcelJS 合并从属单元格复制主单元格值 → 合并标题行所有列值相同
    // 改用 DISTINCT 计数：合并标题行 = 1，真实列标题行 >= 3
    const _countNonEmpty = (row) => {
      const rd = s.data?.[row]
      if (!rd || typeof rd !== 'object') return 0
      const seen = new Set()
      for (const c of Object.values(rd)) {
        if (c?.value != null && c.value !== '') seen.add(String(c.value))
      }
      return seen.size
    }
    const _hasWideMerge = (row) => (s.mergedCells || []).some(m =>
      m.startRow <= row && m.endRow >= row
      && ((m.endCol || m.endColumn || 0) - (m.startCol || m.startColumn || 0) + 1) >= 3
    )

    let headerRow = firstRow
    let titleRow = null
    const maxSkip = Math.min(rowKeys.length - 1, 5)
    for (let i = 0; i < maxSkip; i++) {
      const curr = rowKeys[i]
      const next = rowKeys[i + 1]
      const cc = _countNonEmpty(curr)
      const nc = _countNonEmpty(next)
      const shouldSkip = cc === 0
        || (cc <= 2 && nc >= 3)
        || (_hasWideMerge(curr) && cc <= 2)
      if (!shouldSkip) break
      if (titleRow === null && cc > 0) titleRow = curr
      headerRow = next
    }

    const dataStartRow = headerRow + 1
    const dataEndRow = lastRow
    const totalDataRows = Math.max(0, dataEndRow - dataStartRow + 1)

    let maxCol = 0
    if (s.data && Object.keys(s.data).length > 0) {
      for (const rowKey of Object.keys(s.data)) {
        const rowData = s.data[rowKey]
        if (rowData && typeof rowData === 'object') {
          const colKeys = Object.keys(rowData).map(Number).filter(n => !isNaN(n))
          if (colKeys.length > 0) maxCol = Math.max(maxCol, Math.max(...colKeys))
        }
      }
    }
    const colCount = maxCol > 0 ? maxCol : (s.colCount || 26)

    const _cellText = (c) => {
      if (c?.formula) {
        try {
          const r = evaluateFormula(c.formula, s.data)
          return r != null ? String(r) : ''
        } catch { return c?.value || '' }
      }
      return c?.value ?? ''
    }

    const sortedRows = rowKeys
    const dataRows = sortedRows.filter(r => r > headerRow)
    const rowsToInclude = dataRows.slice(0, maxSampleRows)

    return {
      name: s.name,
      rowCount: s.rowCount || 0,
      colCount,
      firstRow,
      headerRow,
      ...(titleRow != null ? { titleRow } : {}),
      lastRow,
      dataStartRow,
      dataEndRow,
      totalDataRows,
      headers: s.data[headerRow] ? Object.entries(s.data[headerRow])
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, c]) => _cellText(c)) : [],
      headersWithCol: s.data[headerRow] ? Object.entries(s.data[headerRow])
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([col, c]) => ({ col: Number(col), name: _cellText(c) }))
        .filter(h => h.name !== undefined && h.name !== null) : [],
      sampleData: rowsToInclude.map(rowNum => {
        const cols = s.data[rowNum] || {}
        return Object.values(cols).map(c => {
          if (c?.formula) {
            try {
              const result = evaluateFormula(c.formula, s.data)
              if (result === '#ERROR' || result === '#VALUE!' || result === '#DIV/0!' || result === '#REF!') return c?.value || ''
              return result !== null && result !== undefined ? String(result) : ''
            } catch { return c?.value || '' }
          }
          return c?.value || ''
        })
      }),
    }
  }, [])

  // 工作簿变化时预提取所有 sheet 元数据（5行样本），存入缓存
  // 首次命令发送时非活动表直接读缓存，仅活动表做 20行样本计算
  useEffect(() => {
    if (!workbook?.sheets?.length) {
      workbookMetaCacheRef.current = null
      workbookSourceForCacheRef.current = null
      return
    }
    const compute = () => {
      workbookMetaCacheRef.current = workbook.sheets.map(s => computeSheetMeta(s, 5))
      workbookSourceForCacheRef.current = workbook
    }
    if (typeof requestIdleCallback !== 'undefined') {
      const id = requestIdleCallback(compute, { timeout: 2000 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(compute, 0)
    return () => clearTimeout(id)
  }, [workbook, computeSheetMeta])

  useEffect(() => {
    const base = String(appConfig.apiBaseUrl || '').replace(/\/$/, '')
    const url = base ? `${base}/api/config/platform` : '/api/config/platform'
    fetch(url, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        const mb = Number(data.auto_analyze_max_file_mb)
        const rows = Number(data.auto_analyze_max_rows)
        if (!Number.isFinite(mb) || !Number.isFinite(rows)) return
        setAutoAnalyzeThresholds({
          sizeBytes: Math.round(mb * 1024 * 1024),
          rowThreshold: Math.round(rows),
        })
      })
      .catch(() => {})
  }, [])

  // 统一系统消息入口：触发时即判断 AI 面板状态并分流到弹框
  const pushAiMessage = useCallback((type, content, options = {}) => {
    const normalized = String(content || '').trim()
    if (!type || !normalized) return
    const {
      id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      revealPanel = false,
      dedupe,
      dedupeTail = 8,
      persistent = false,
      upsertById = false,
    } = options

    /** 相同文案的 warning/error/success 每次操作都应出现，默认不去重 */
    const dedupeResolved =
      dedupe !== undefined ? dedupe : !['error', 'warning', 'success'].includes(type)

    const currentMessages = aiMessagesRef.current || []
    const existingIndex = currentMessages.findIndex((m) => m?.id === id)
    let isDuplicate = false
    if (dedupeResolved && !(upsertById && existingIndex >= 0)) {
      const tail = currentMessages.slice(-Math.max(1, dedupeTail))
      isDuplicate = tail.some(
        (m) => m?.type === type && String(m?.content || '').trim() === normalized
      )
    }

    if (isDuplicate) return

    const nextMessage = { id, type, content: normalized, ts: Date.now(), persistent: Boolean(persistent) }

    if (revealPanel) {
      setAiPanelOpen(true)
    }

    if (!aiPanelOpen) {
      const popup = getAiPopupFromMessage(nextMessage, 0)
      if (popup) {
        toastQueuedFromPushRef.current.add(nextMessage.id)
        setAiPopupQueue((prev) => [...prev, { ...popup, key: `pop:${nextMessage.id}` }].slice(-8))
      }
    }

    setAiMessages((prev) => {
      if (upsertById) {
        const idx = prev.findIndex((m) => m?.id === id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = { ...prev[idx], ...nextMessage }
          return updated
        }
      }
      return [...prev, nextMessage]
    })
  }, [aiPanelOpen])

  const pushSystemMessage = useCallback((type, content, options = {}) => {
    if (!['error', 'warning', 'success', 'status', 'assistant'].includes(type)) return
    pushAiMessage(type, content, options)
  }, [pushAiMessage])

  const pushOperationErrorOnce = useCallback((operation, message, options = {}) => {
    const opType = operation?.type || 'unknown'
    const text = String(message || '').trim()
    if (!text) return
    const windowMs = Number(options.windowMs || 3000)
    const now = Date.now()
    const key = `${opType}::${text}`
    const cache = operationErrorThrottleRef.current
    const lastTs = Number(cache.get(key) || 0)
    if (now - lastTs < windowMs) return
    cache.set(key, now)
    if (cache.size > 200) {
      const staleBefore = now - windowMs * 2
      for (const [k, ts] of cache.entries()) {
        if (Number(ts) < staleBefore) cache.delete(k)
      }
    }
    pushSystemMessage('error', text, { dedupe: false })
  }, [pushSystemMessage])

  const reportNoOpSuccessToBackend = useCallback(async (requestId, source = '') => {
    try {
      const baseUrl = (() => {
        const resolved = resolveApiBaseUrl()
        if (resolved) return resolved
        if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin
        return null
      })()
      if (!baseUrl || !sessionId) return

      const payload = {
        session_id: sessionId,
        operation: {
          type: '__no_op_completion__',
          params: { source, requestId: requestId || null },
        },
        errors: [
          'Agent 返回了“已完成/已成功”语义文本，但前端统计到本次请求执行的操作数为 0（no operations rendered/applied）'
        ],
        timestamp: new Date().toISOString(),
        workbook_state: {
          sheets: (workbook?.sheets || []).map(s => s?.name).filter(Boolean),
          activeSheet: workbook?.activeSheet || null,
        },
      }
      await fetch(`${String(baseUrl).replace(/\/$/, '')}/api/excel/operation-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (e) {
      flog.warn('App', '上报 no-op 成功文案失败:', e)
    }
  }, [sessionId, workbook?.sheets, workbook?.activeSheet])

  const maybeWarnNoOpCompletion = useCallback((trackedRequestId, source = '') => {
    if (!trackedRequestId) return
    const stats = requestExecutionStatsRef.current.get(trackedRequestId)
    const shouldWarn = Number(stats?.operationCount || 0) === 0 && Boolean(stats?.hasCompletionClaim)
    if (!shouldWarn) return
    const now = Date.now()
    const throttleKey = `${trackedRequestId}:${source || 'unknown'}`
    const cache = noOpWarningThrottleRef.current
    const lastTs = Number(cache.get(throttleKey) || 0)
    if (now - lastTs < 5000) return
    cache.set(throttleKey, now)
    pushSystemMessage(
      'error',
      '本次操作未产生表格变化，可能是系统理解偏差。请重试，或尝试用更明确的方式描述您的需求。',
      { dedupe: false }
    )
    reportNoOpSuccessToBackend(trackedRequestId, source)
  }, [pushSystemMessage, reportNoOpSuccessToBackend])

  const pushUserMessage = useCallback((content, options = {}) => {
    pushAiMessage('user', content, { dedupe: false, ...options })
  }, [pushAiMessage])

  /** Univer 编辑 debounce 回写 React workbook（供收集/下载/Agent 状态一致） */
  const handleUniverWorkbookChange = useCallback((wb, meta) => {
    if (!wb) return
    setWorkbook(wb)
    // 仅做兜底同步：避免 Univer 的延迟回写把“已切换到的新表”反向覆盖回旧表。
    if (wb.activeSheet) {
      setActiveSheet((prev) => {
        if (prev === wb.activeSheet) return prev
        const source = meta?.source || 'unknown'
        const preferred = pendingPreferredActiveSheetRef.current
        const preferredExistsInWorkbook = typeof preferred === 'string' && preferred
          ? (Array.isArray(wb.sheets) ? wb.sheets.some((s) => s?.name === preferred) : false)
          : false
        const prevExistsInWorkbook = Array.isArray(wb.sheets)
          ? wb.sheets.some((s) => s?.name === prev)
          : false

        // 若存在待激活目标表且已进入当前 workbook，则优先激活该表，抵御延迟回写。
        if (preferredExistsInWorkbook && prev !== preferred) {
          return preferred
        }

        // source=univer 时，若当前 activeSheet 仍有效，优先保留当前选择，不被回写反向覆盖。
        if (source === 'univer' && prevExistsInWorkbook) {
          return prev
        }

        return wb.activeSheet
      })
    }
    // 若目标表已稳定激活，清理一次性标记，避免影响后续正常切表。
    if (
      pendingPreferredActiveSheetRef.current &&
      wb.activeSheet === pendingPreferredActiveSheetRef.current
    ) {
      pendingPreferredActiveSheetRef.current = null
    }
    // 文件加载后 Univer 会触发一次归一化回写（非用户编辑），这里同步刷新“已保存快照”避免误判脏数据
    if (meta?.source === 'univer') {
      const pendingFileId = pendingUniverBaselineFileIdRef.current
      const currentFileId = selectedSidebarFileRef.current?.id
      if (pendingFileId && currentFileId && pendingFileId === currentFileId) {
        lastSavedSnapshotRef.current = JSON.stringify(wb)
        pendingUniverBaselineFileIdRef.current = null
      }
    }
    if (meta?.revision != null) workbookRevisionRef.current = meta.revision
    if (typeof window !== 'undefined') window.__EXCEL_WORKBOOK__ = wb
  }, [])

  // ==================== 图表操作回调 ====================

  const handleChartUpdate = useCallback((chartId, updates) => {
    setWorkbook(prev => {
      if (!prev) return prev
      const wb = JSON.parse(JSON.stringify(prev))
      const sheet = wb.sheets?.find(s => s.name === activeSheet)
      if (!sheet?.charts) return prev
      const chart = sheet.charts.find(c => c.id === chartId)
      if (!chart) return prev
      const oldRow = Number(chart.row) || 1
      const oldCol = Number(chart.col) || 1
      Object.assign(chart, updates)

      // 图表移动后清理旧锚点的“历史图表快照图片”（避免原位置残留不可选幽灵图表）
      const nextRow = Number(chart.row) || oldRow
      const nextCol = Number(chart.col) || oldCol
      const moved = nextRow !== oldRow || nextCol !== oldCol
      if (moved && sheet?.data?.[oldRow]?.[oldCol]?.image) {
        const img = sheet.data[oldRow][oldCol].image
        const imgW = Number(img?.width) || 0
        const imgH = Number(img?.height) || 0
        // 仅清理“图表尺度”快照，避免误删普通小图片
        const looksLikeChartSnapshot = imgW >= 280 && imgH >= 180
        if (looksLikeChartSnapshot) {
          delete sheet.data[oldRow][oldCol].image
          if (Object.keys(sheet.data[oldRow][oldCol]).length === 0) {
            delete sheet.data[oldRow][oldCol]
          }
          if (sheet.data[oldRow] && Object.keys(sheet.data[oldRow]).length === 0) {
            delete sheet.data[oldRow]
          }
        }
      }
      return wb
    })
  }, [activeSheet])

  const handleChartDelete = useCallback((chartId) => {
    setWorkbook(prev => {
      if (!prev) return prev
      const wb = JSON.parse(JSON.stringify(prev))
      const sheet = wb.sheets?.find(s => s.name === activeSheet)
      if (!sheet?.charts) return prev
      sheet.charts = sheet.charts.filter(c => c.id !== chartId)
      return wb
    })
  }, [activeSheet])

  const handleChartCreate = useCallback((config) => {
    setWorkbook(prev => {
      const op = { type: 'create_chart', params: { sheet: activeSheet, ...config } }
      return executeOperation(prev, op)
    })
  }, [activeSheet])

  /** Univer 真源：同步导出 JSON（供脏检查、beforeunload 等非保存场景） */
  const getFlushedWorkbookSync = useCallback((applyToState) => {
    if (!univerModeRef.current || !univerEditorRef.current?.flushToSheetbot) return null
    const flushed = univerEditorRef.current.flushToSheetbot()
    if (!flushed) return null
    if (applyToState) {
      setWorkbook(flushed)
      if (typeof window !== 'undefined') window.__EXCEL_WORKBOOK__ = flushed
    }
    return flushed
  }, [])

  /** Univer 真源：异步导出 JSON（commit 后等一帧，保证模型写入完成），保存场景优先使用 */
  const getFlushedWorkbookAsync = useCallback(async () => {
    if (!univerModeRef.current) return null
    const editor = univerEditorRef.current
    if (!editor?.flushToSheetbotAsync) {
      return editor?.flushToSheetbot?.() ?? null
    }
    const flushed = await editor.flushToSheetbotAsync()
    if (flushed && typeof window !== 'undefined') {
      window.__EXCEL_WORKBOOK__ = flushed
    }
    return flushed
  }, [])
  
  // 撤销/重做历史记录
  const [history, setHistory] = useState([JSON.stringify(workbook)])
  const [historyIndex, setHistoryIndex] = useState(0)
  const clipboardRef = useRef(null) // 剪贴板数据
  const lastFindRef = useRef(null)
  const fileInputRef = useRef(null)
  const formatBrushRef = useRef(null) // 格式刷缓存的样式
  const [formatBrushActive, setFormatBrushActive] = useState(false) // 格式刷激活状态
  const [isCutMode, setIsCutMode] = useState(false) // 是否为剪切模式
  const [canPaste, setCanPaste] = useState(false) // 剪贴板是否有内容
  
  // ========== 平台视图状态 ==========
  const [platformView, setPlatformView] = useState('normal') // normal | analyze | report | reportCard | collect | connect | share | skill
  const [unsavedConfirm, setUnsavedConfirm] = useState(null) // { targetView } | { type: 'switchFile', sourceFile, nextFile, options } | null
  // ========== 大文件模式状态 ==========
  const [currentFileName, setCurrentFileName] = useState('') // 当前打开的文件名（不含扩展名）
  const [largeFileMode, setLargeFileMode] = useState(false) // 是否处于大文件模式
  useEffect(() => {
    /* 小文件普通编辑 或 大文件「我要分析」Canvas 均为 Univer 真源 */
    univerModeRef.current = !largeFileMode || (largeFileMode && platformView === 'analyze')
  }, [largeFileMode, platformView])

  /* Univer Ribbon 迁入顶栏：html 类配合 CSS 放行 overflow（不依赖 :has） */
  useEffect(() => {
    const on = !largeFileMode && platformView === 'normal'
    const root = document.documentElement
    if (on) root.classList.add('sheetbot-univer-ribbon-embed')
    else root.classList.remove('sheetbot-univer-ribbon-embed')
    return () => root.classList.remove('sheetbot-univer-ribbon-embed')
  }, [largeFileMode, platformView])

  const [largeFileInfo, setLargeFileInfo] = useState(null) // 大文件信息 {file_id, original_name, ...}
  const [largeFilePreview, setLargeFilePreview] = useState(null) // 大文件预览数据
  const [isLargeFileUploading, setIsLargeFileUploading] = useState(false) // 上传中状态
  const [uploadedLargeFiles, setUploadedLargeFiles] = useState([]) // 当前会话已上传的文件列表
  const [resultFiles, setResultFiles] = useState([]) // 当前源文件关联的结果文件列表
  const [selectedSidebarFile, setSelectedSidebarFile] = useState(null) // 当前左侧选中的文件
  const latestSidebarIntentRef = useRef(null) // 记录用户最近一次点击的文件（用于跨异步时序）
  const [pendingSidebarFileId, setPendingSidebarFileId] = useState(null) // 左侧文件切换中的目标文件
  const [isGridDataLoading, setIsGridDataLoading] = useState(false) // 表格数据加载中（打开文件/加载大表）
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error
  const saveStatusRef = useRef('idle')
  saveStatusRef.current = saveStatus
  const autoSaveTimerRef = useRef(null)
  const lastSavedSnapshotRef = useRef('')
  const saveResetTimerRef = useRef(null)
  const handleManualSaveRef = useRef(null)
  const handleSidebarFileSelectRef = useRef(null)
  const loadWorkbookFromSidebarRef = useRef(null)
  const pendingUniverBaselineFileIdRef = useRef(null) // 文件切换后，等待 Univer 首次归一化回写作为基线
  const [pendingNormalReload, setPendingNormalReload] = useState(null)
  const [skillSandboxPending, setSkillSandboxPending] = useState(false) // skill 视图存在未持久化变更
  const [skillPreviewRefreshToken, setSkillPreviewRefreshToken] = useState(0) // 强制刷新 skill 预览
  const [skillPreviewTouchedMap, setSkillPreviewTouchedMap] = useState({}) // 本次 skill 执行变更单元格
  const [skillActionNotice, setSkillActionNotice] = useState('') // Skill 按钮区结果提示
  const skillSandboxSnapshotRef = useRef('')
  const skillSandboxFileIdRef = useRef(null)
  const normalModeSnapshotRef = useRef(null)
  const analyzeFormulaWorkbookRef = useRef(null)
  const sortDirectionRef = useRef('desc')

  // ---- 首编辑自动草稿 ----
  const isEnsuringDraftRef = useRef(false)
  const pendingEditsRef = useRef([])
  const draftCreatedRef = useRef(false)

  // 工作表缩放（普通视图 & 我要分析）
  const [sheetZoom, setSheetZoom] = useState(() => {
    if (typeof window === 'undefined') return 1
    const raw = window.localStorage.getItem('sheet_zoom')
    const saved = Number(raw)
    /* 旧版默认写入 1.4，与现产品 100% 冲突：精确 1.4 视为历史默认并迁到 1 */
    if (raw != null && Number.isFinite(saved) && Math.abs(saved - 1.4) < 1e-6) {
      window.localStorage.setItem('sheet_zoom', '1')
      return 1
    }
    return Number.isFinite(saved) && saved > 0 ? saved : 1
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('sheet_zoom', String(sheetZoom))
  }, [sheetZoom])

  useEffect(() => {
    glideActiveSheetRef.current = activeSheet
  }, [activeSheet])

  // 选中真实文件后重置草稿标记
  useEffect(() => {
    if (selectedSidebarFile?.id) {
      latestSidebarIntentRef.current = selectedSidebarFile
      draftCreatedRef.current = false
      pendingEditsRef.current = []
    }
  }, [selectedSidebarFile?.id])

  const activeSheetObj = useMemo(() => {
    return workbook.sheets.find(s => s.name === activeSheet) || workbook.sheets[0]
  }, [workbook, activeSheet])

  const aiCurrentSheetCount = useMemo(() => {
    return Array.isArray(workbook?.sheets) ? workbook.sheets.length : 0
  }, [workbook?.sheets])

  const currentSheetIsEmpty = useMemo(() => {
    return isSheetEmptyForOneClick(activeSheetObj)
  }, [activeSheetObj])

  const effectiveSelection = useMemo(() => {
    const isSingle = selection.startRow === selection.endRow && selection.startCol === selection.endCol
    const used = isSingle ? getUsedRange(activeSheetObj) : null
    return used || selection
  }, [selection, activeSheetObj])
  
  // 对话框状态
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [formulaManagerOpen, setFormulaManagerOpen] = useState(false)
  const [chartInsertOpen, setChartInsertOpen] = useState(false)
  const [customFormulas, setCustomFormulas] = useState([])

  const loadCustomFormulas = useCallback(async () => {
    if (!accessToken) return
    try {
      const data = await formulaApi.listFormulas(accessToken)
      setCustomFormulas(data.formulas || [])
    } catch { /* 静默失败，不阻塞主流程 */ }
  }, [accessToken])

  // 登录后首次加载自定义公式
  useEffect(() => { loadCustomFormulas() }, [loadCustomFormulas])

  const handleApplyCustomFormulaFromContextMenu = useCallback((formulaId, range) => {
    const list = Array.isArray(customFormulas) ? customFormulas : []
    if (!list.length) {
      pushSystemMessage('warning', '暂无自定义公式，请先在“自定义公式管理”中创建')
      return
    }

    const resolvedFormulaId = String(formulaId || '')
    if (!resolvedFormulaId) return

    const formula = list.find((f) => String(f?.id || f?.name) === String(resolvedFormulaId))
    if (!formula?.expression) {
      pushSystemMessage('warning', '未找到可用的自定义公式')
      return
    }

    const targetRange = range || selection
    if (!targetRange) return
    const startRow = Math.min(targetRange.startRow, targetRange.endRow)
    const endRow = Math.max(targetRange.startRow, targetRange.endRow)
    const startCol = Math.min(targetRange.startCol, targetRange.endCol)
    const endCol = Math.max(targetRange.startCol, targetRange.endCol)

    const params = {}
    ;(formula.params || []).forEach((p) => {
      const key = p?.name
      if (!key) return
      const dv = p?.default
      params[key] = dv != null ? dv : 0
    })

    const letterToCol = (letters = '') =>
      String(letters)
        .toUpperCase()
        .split('')
        .reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0)

    const readNumber = (sheetData, row, col) => {
      const raw = sheetData?.[row]?.[col]?.value
      const num = Number(raw)
      return Number.isFinite(num) ? num : 0
    }

    const colRefs = Array.from(String(formula.expression).matchAll(/\b([A-Z]{1,3})\b/g)).map((m) => m[1])
    const uniqueColRefs = Array.from(new Set(colRefs.filter(Boolean)))

    setWorkbook((prev) => {
      const wb = JSON.parse(JSON.stringify(prev || {}))
      const sheet = wb?.sheets?.find((s) => s.name === activeSheet)
      if (!sheet) return prev
      sheet.data = sheet.data || {}

      for (let r = startRow; r <= endRow; r += 1) {
        for (let c = startCol; c <= endCol; c += 1) {
          const ctx = { value: readNumber(sheet.data, r, c), ...params }
          uniqueColRefs.forEach((ref) => {
            ctx[ref] = readNumber(sheet.data, r, letterToCol(ref))
          })
          try {
            const fn = new Function(...Object.keys(ctx), `return ${formula.expression}`)
            const out = fn(...Object.values(ctx))
            if (!sheet.data[r]) sheet.data[r] = {}
            const nextValue = Number.isFinite(Number(out)) ? Number(Number(out).toFixed(2)) : out
            sheet.data[r][c] = { ...(sheet.data[r][c] || {}), value: nextValue }
          } catch (_) {
            // 单元格公式计算异常时跳过，不中断整段批量写入
          }
        }
      }
      return wb
    })
    pushSystemMessage('success', `已应用公式：${formula.label || formula.name || '自定义公式'}`)
  }, [activeSheet, customFormulas, pushSystemMessage, selection])

  const handleOpenHelp = useCallback(() => {
    window.open('/help/toc', '_blank', 'noopener,noreferrer')
  }, [])
  
  // Airtable 布局状态
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const {
    isMobileViewport,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileGestureHandlers,
  } = useLayoutViewport({
    aiPanelOpen,
    setAiPanelOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
  })
  const effectiveSidebarCollapsed = isMobileViewport ? false : sidebarCollapsed
  // 同步用户标识到前端日志工具（console 输出自动携带 @username）
  useEffect(() => {
    setLogUser(user?.username || user?.email || '')
  }, [user?.username, user?.email])
  const [openSqlBuilderSignal, setOpenSqlBuilderSignal] = useState(0)

  useEffect(() => {
    if (platformView === 'collect') {
      document.body.classList.add('collect-view-active')
    } else {
      document.body.classList.remove('collect-view-active')
    }
    return () => {
      document.body.classList.remove('collect-view-active')
    }
  }, [platformView])

  // 兜底：仅处理直接 setAiMessages 写入、未经过 pushAiMessage 入队；且仅在列表变长时（新追加一条）
  useEffect(() => {
    if (aiPanelOpen) {
      aiMessagesLenForToastRef.current = aiMessages.length
      return
    }
    const prevLen = aiMessagesLenForToastRef.current
    aiMessagesLenForToastRef.current = aiMessages.length
    if (aiMessages.length <= prevLen) return

    const last = aiMessages[aiMessages.length - 1]
    if (!last) return
    if (toastQueuedFromPushRef.current.has(last.id)) {
      toastQueuedFromPushRef.current.delete(last.id)
      return
    }
    const popup = getAiPopupFromMessage(last, aiMessages.length - 1)
    if (!popup) return
    setAiPopupQueue((prev) => [...prev, { ...popup, key: `pop:${last.id}` }].slice(-8))
  }, [aiMessages, aiPanelOpen])

  useEffect(() => {
    if (aiPanelOpen) {
      toastQueuedFromPushRef.current.clear()
      aiMessagesLenForToastRef.current = aiMessages.length
      setAiPopupQueue([])
      setActiveAiPopup(null)
      if (aiPopupTimerRef.current) {
        clearTimeout(aiPopupTimerRef.current)
        aiPopupTimerRef.current = null
      }
    }
  }, [aiPanelOpen])

  useEffect(() => {
    if (activeAiPopup || !aiPopupQueue.length) return
    const [next, ...rest] = aiPopupQueue
    setActiveAiPopup(next)
    setAiPopupQueue(rest)
  }, [aiPopupQueue, activeAiPopup])

  useEffect(() => {
    if (!activeAiPopup) return
    if (aiPopupTimerRef.current) clearTimeout(aiPopupTimerRef.current)
    aiPopupTimerRef.current = setTimeout(() => {
      setActiveAiPopup(null)
      aiPopupTimerRef.current = null
    }, AI_POPUP_AUTO_HIDE_MS)
    return () => {
      if (aiPopupTimerRef.current) {
        clearTimeout(aiPopupTimerRef.current)
        aiPopupTimerRef.current = null
      }
    }
  }, [activeAiPopup])

  useEffect(() => {
    if (platformView !== 'collect') return undefined

    const isDotsOnly = (text) => /^[.\u00B7\u2022\u2026\u22EF\s]{3,6}$/.test(text || '')
    const hasMoreHint = (value) => /(more|ellipsis|更多)/i.test(value || '')

    const sanitizeCollectFloatingButtons = () => {
      const root = document.querySelector('.content-excel-panel')
      if (!root) return
      const nodes = root.querySelectorAll('button, [role="button"]')
      nodes.forEach((node) => {
        const text = (node.textContent || '').trim()
        const title = node.getAttribute('title') || ''
        const aria = node.getAttribute('aria-label') || ''
        if (isDotsOnly(text) || hasMoreHint(title) || hasMoreHint(aria)) {
          node.style.display = 'none'
          node.setAttribute('data-collect-pruned', 'true')
        }
      })
    }

    sanitizeCollectFloatingButtons()
    const observer = new MutationObserver(() => sanitizeCollectFloatingButtons())
    observer.observe(document.body, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [platformView])

  const getCurrentSheet = useCallback(() => {
    return workbook.sheets.find(s => s.name === activeSheet) || workbook.sheets[0]
  }, [workbook, activeSheet])

  const getSelectedCellValue = useCallback(() => {
    const sheet = getCurrentSheet()
    if (!sheet) return ''
    const cell = sheet.data[selection.startRow]?.[selection.startCol]
    if (!cell) return ''
    if (cell.formula) return cell.formula
    let raw = cell.value
    if (raw && typeof raw === 'object') {
      raw = raw.text ?? raw.result ?? raw.value ?? raw.display ?? ''
    }
    const numberFormat = cell?.style?.numberFormat
    if (isDateLikeFormat(numberFormat)) {
      if (typeof raw === 'number') {
        return excelSerialToYMD(raw) || raw
      }
      return normalizeDateText(raw)
    }
    if (isDateLikeValue(raw)) {
      return normalizeDateText(raw)
    }
    return raw ?? ''
  }, [getCurrentSheet, selection])

  useEffect(() => {
    setFormulaBarValue(getSelectedCellValue())
  }, [selection, getSelectedCellValue])

  // 更新公式引擎的工作簿上下文（用于跨工作表引用）
  useEffect(() => {
    setWorkbookContext(workbook)
  }, [workbook])
  
  // 注册错误反馈回调（供 excelOperations.js 使用）
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__EXCEL_SESSION_ID__ = sessionId
      window.__EXCEL_ERROR_CALLBACK__ = async (operation, errors, message = '') => {
        // 错误反馈已由 excelOperations.js 中的 sendOperationError 处理
        // 这里追加可见 UI 反馈，避免“只在日志可见”
        flog.warn('App', 'operation error:', { operation, errors, message })
        const raw = message || (Array.isArray(errors) ? errors.join('; ') : String(errors || ''))
        pushOperationErrorOnce(operation, sanitizeErrorForUser(raw))
      }
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete window.__EXCEL_SESSION_ID__
        delete window.__EXCEL_ERROR_CALLBACK__
      }
    }
  }, [sessionId, pushOperationErrorOnce])

  // 初始化历史记录
  useEffect(() => {
    if (history.length === 0) {
      setHistory([JSON.stringify(workbook)])
      setHistoryIndex(0)
    }
  }, []) // 只在组件挂载时执行一次

  const handleWebSocketMessage = useCallback((message) => {
    const { type, payload } = message
    const messageRequestId = message?.requestId
    const currentRequestId = currentRequestIdRef.current
    const isRequestMismatch = messageRequestId && currentRequestId && messageRequestId !== currentRequestId
    
    switch (type) {
      case 'ai_response':
        if (isRequestMismatch) {
          return
        }
        const sanitizedMessage = sanitizeAssistantMessage(payload.message)
        const trackedRequestId = messageRequestId || currentRequestIdRef.current
        if (trackedRequestId) {
          const prevStats = requestExecutionStatsRef.current.get(trackedRequestId) || { operationCount: 0, hasCompletionClaim: false }
          requestExecutionStatsRef.current.set(trackedRequestId, {
            ...prevStats,
            hasCompletionClaim: prevStats.hasCompletionClaim || hasCompletionClaimText(sanitizedMessage),
          })
        }
        setAiMessages(prev => {
          if (!sanitizedMessage) return prev
          const isReadyMessage = sanitizedMessage.includes('AI 助手已就绪')
          if (isReadyMessage) {
            if (readyMessageShownRef.current) {
              return prev
            }
            readyMessageShownRef.current = true
          }
          if (payload.streaming && prev.length > 0 && prev[prev.length - 1].type === 'assistant') {
            const updated = [...prev]
            let newContent = sanitizedMessage
            // 如果新消息以完成标志开头，在前面添加换行
            if (newContent?.startsWith('✅') || newContent?.startsWith('操作完成') || newContent?.startsWith('完成')) {
              newContent = '\n\n' + newContent
            }
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: updated[updated.length - 1].content + newContent
            }
            return updated
          }
          return [...prev, { type: 'assistant', content: sanitizedMessage }]
        })
        if (aiResponseIdleTimeoutRef.current) {
          clearTimeout(aiResponseIdleTimeoutRef.current)
        }
        aiResponseIdleTimeoutRef.current = setTimeout(() => {
          if (messageRequestId && currentRequestIdRef.current !== messageRequestId) {
            return
          }
          const trackedRequestId = messageRequestId || currentRequestIdRef.current
          maybeWarnNoOpCompletion(trackedRequestId, 'ai_response_idle')
          if (trackedRequestId) {
            requestExecutionStatsRef.current.delete(trackedRequestId)
            failedOperationRequestsRef.current.delete(trackedRequestId)
          }
          if (processingTimeoutRef.current) {
            clearTimeout(processingTimeoutRef.current)
            processingTimeoutRef.current = null
          }
          setIsAiProcessing(false)
          setExecutionProgress(null)
          setAiMessages(prev => removeTransientExecutionMessages(prev))
          currentRequestIdRef.current = null
        }, 600)
        break
        
      case 'ai_thinking':
        if (isRequestMismatch) {
          return
        }
        {
          const thinkDesc = toCompactThinkingMessage(payload.message || '处理中...')
          setExecutionProgress(prev => ({
            phase: prev?.phase === 'executing' ? 'executing' : 'thinking',
            opCount: prev?.opCount || 0,
            lastOpDesc: thinkDesc,
          }))
        }
        setAiMessages(prev => [
          ...removeTransientExecutionMessages(prev),
          {
            type: 'thinking',
            content: toCompactThinkingMessage(payload.message || '处理中...')
          }
        ])
        break
        
      case 'excel_operation':
        if (isRequestMismatch) {
          flog.warn('App', '操作消息请求ID不匹配，忽略', {
            messageRequestId,
            currentRequestId
          })
          return
        }
        {
          const trackedRequestId = messageRequestId || currentRequestIdRef.current
          if (trackedRequestId && failedOperationRequestsRef.current.has(trackedRequestId)) {
            flog.warn('App', '请求已熔断，跳过后续操作', {
              requestId: trackedRequestId,
              operationType: payload.operation?.type,
            })
            return
          }
        }
        
        {
          const trackedRequestId = messageRequestId || currentRequestIdRef.current
          const operationType = payload.operation?.type
          if (trackedRequestId) {
            const prevStats = requestExecutionStatsRef.current.get(trackedRequestId) || {
              operationCount: 0,
              chartCount: 0,
              chartLimitNotified: false,
              hasCompletionClaim: false,
            }
            // 图表上限硬约束：同一请求最多执行 3 个图表，避免“多图低价值噪声”
            if (operationType === 'create_chart' && Number(prevStats.chartCount || 0) >= 3) {
              if (!prevStats.chartLimitNotified) {
                requestExecutionStatsRef.current.set(trackedRequestId, {
                  ...prevStats,
                  chartLimitNotified: true,
                })
                setAiMessages((prevMessages) => [
                  ...prevMessages,
                  {
                    type: 'warning',
                    content: '本次分析已达到图表上限（3个），已自动跳过其余图表生成请求。',
                  },
                ])
              }
              flog.warn('App', '图表上限触发，跳过 create_chart', {
                requestId: trackedRequestId,
                chartCount: prevStats.chartCount,
              })
              return
            }
            requestExecutionStatsRef.current.set(trackedRequestId, {
              ...prevStats,
              operationCount: Number(prevStats.operationCount || 0) + 1,
              chartCount: Number(prevStats.chartCount || 0) + (operationType === 'create_chart' ? 1 : 0),
            })
          }
        }

        {
          const opLabel = getToolDisplayLabel(payload.operation?.type)
          setExecutionProgress(prev => ({
            phase: 'executing',
            opCount: (prev?.opCount || 0) + 1,
            lastOpDesc: opLabel,
          }))
        }

        flog.info('App', '收到操作消息', {
          type: payload.operation?.type,
          params: payload.operation?.params,
          requestId: messageRequestId
        })
        
        setWorkbook(prev => {
          // 创建错误回调函数，将错误信息添加到AI助手窗口
          const errorCallback = (errorMessage) => {
            const trackedRequestId = messageRequestId || currentRequestIdRef.current
            if (trackedRequestId) {
              failedOperationRequestsRef.current.add(trackedRequestId)
            }
            flog.error('App', 'operation execution error', {
              operationType: payload.operation.type,
              error: errorMessage,
              requestId: trackedRequestId,
            })
            setAiMessages(prevMessages => [...prevMessages, {
              type: 'error',
              content: errorMessage
            }])
          }
          
          try {
            // 关键：SSE 连续操作必须基于 React 当前累积状态 prev 计算。
            // 这里不能每条操作都 flush Univer 画布，否则会把尚未完成回灌的旧快照覆盖掉，
            // 导致“日志显示执行成功，但表格仍为空”。
            const base = prev
            const newWorkbook = executeOperation(base, payload.operation, errorCallback)
            
            flog.info('App', '操作执行完成', {
              operationType: payload.operation.type,
              sheetChanged: newWorkbook.activeSheet !== prev.activeSheet,
              activeSheet: newWorkbook.activeSheet
            })
            
            // 立即更新调试 API（不等待 useEffect）
            if (typeof window !== 'undefined') {
              window.__EXCEL_WORKBOOK__ = newWorkbook
            }
            
            // 如果操作设置了活动工作表，自动切换
            // createPivotTable 和 addSheet 都会设置 workbook.activeSheet
            if (newWorkbook.activeSheet && newWorkbook.activeSheet !== prev.activeSheet) {
              glideActiveSheetRef.current = newWorkbook.activeSheet
              pendingPreferredActiveSheetRef.current = newWorkbook.activeSheet
              requestAnimationFrame(() => {
                setActiveSheet(newWorkbook.activeSheet)
              })
            } else if (payload.operation.type === 'set_active_sheet' && payload.operation.params.name) {
              glideActiveSheetRef.current = payload.operation.params.name
              pendingPreferredActiveSheetRef.current = payload.operation.params.name
              requestAnimationFrame(() => {
                setActiveSheet(payload.operation.params.name)
              })
            }
            
            // 对于排序操作，强制触发界面更新
            if (payload.operation.type === 'sort_range') {
              flog.info('App', '排序操作完成，强制触发界面更新')
              // 使用 setTimeout 确保状态更新后触发重新渲染
              setTimeout(() => {
                // 触发一个微小的状态更新来强制重新渲染
                setWorkbook(current => ({ ...current }))
              }, 0)
            }
            
            return newWorkbook
          } catch (error) {
            flog.error('App', 'operation execution error', {
              operationType: payload.operation.type,
              error: error.message,
              stack: error.stack
            })
            const userMsg = error.message?.includes('还在学习中')
              ? error.message
              : '抱歉，该操作暂时无法完成，请尝试用更简单的方式描述您的需求。'
            errorCallback(userMsg)
            return prev
          }
        })
        if (aiResponseIdleTimeoutRef.current) {
          clearTimeout(aiResponseIdleTimeoutRef.current)
          aiResponseIdleTimeoutRef.current = null
        }
        if (operationCompleteTimeoutRef.current) {
          clearTimeout(operationCompleteTimeoutRef.current)
        }
        operationCompleteTimeoutRef.current = setTimeout(() => {
          if (messageRequestId && currentRequestIdRef.current !== messageRequestId) {
            return
          }
          const trackedRequestId = messageRequestId || currentRequestIdRef.current
          if (processingTimeoutRef.current) {
            clearTimeout(processingTimeoutRef.current)
            processingTimeoutRef.current = null
          }
          setIsAiProcessing(false)
          setExecutionProgress(null)
          setAiMessages(prev => removeTransientExecutionMessages(prev))
          if (trackedRequestId) {
            failedOperationRequestsRef.current.delete(trackedRequestId)
          }
          currentRequestIdRef.current = null
        }, 300)
        break
        
      case 'operation_complete':
        if (isRequestMismatch) {
          return
        }
        {
          const trackedRequestId = messageRequestId || currentRequestIdRef.current
          if (trackedRequestId) {
            if (payload?.success !== false) {
              maybeWarnNoOpCompletion(trackedRequestId, 'operation_complete')
            }
            requestExecutionStatsRef.current.delete(trackedRequestId)
            failedOperationRequestsRef.current.delete(trackedRequestId)
          }
        }
        if (processingTimeoutRef.current) {
          clearTimeout(processingTimeoutRef.current)
          processingTimeoutRef.current = null
        }
        if (operationCompleteTimeoutRef.current) {
          clearTimeout(operationCompleteTimeoutRef.current)
          operationCompleteTimeoutRef.current = null
        }
        if (aiResponseIdleTimeoutRef.current) {
          clearTimeout(aiResponseIdleTimeoutRef.current)
          aiResponseIdleTimeoutRef.current = null
        }
        setIsAiProcessing(false)
        // 有操作执行过：短暂显示完成状态
        setExecutionProgress(prev => {
          if (prev?.opCount > 0) {
            setTimeout(() => setExecutionProgress(null), 800)
            return { phase: 'done', opCount: prev.opCount, lastOpDesc: '' }
          }
          return null
        })
        setAiMessages(prev => removeTransientExecutionMessages(prev))
        currentRequestIdRef.current = null
        // 强制触发 Univer 画布最终刷新：绕过节流，确保最后一条操作可见
        requestAnimationFrame(() => {
          univerEditorRef.current?.forceInject?.()
        })
        break
        
      case 'ai_error':
        if (isRequestMismatch) {
          return
        }
        {
          const trackedRequestId = messageRequestId || currentRequestIdRef.current
          if (trackedRequestId) {
            requestExecutionStatsRef.current.delete(trackedRequestId)
            failedOperationRequestsRef.current.delete(trackedRequestId)
          }
        }
        if (processingTimeoutRef.current) {
          clearTimeout(processingTimeoutRef.current)
          processingTimeoutRef.current = null
        }
        if (operationCompleteTimeoutRef.current) {
          clearTimeout(operationCompleteTimeoutRef.current)
          operationCompleteTimeoutRef.current = null
        }
        if (aiResponseIdleTimeoutRef.current) {
          clearTimeout(aiResponseIdleTimeoutRef.current)
          aiResponseIdleTimeoutRef.current = null
        }
        setIsAiProcessing(false)
        // 先显示失败状态 2 秒，再隐藏
        setExecutionProgress(prev => ({
          phase: 'error',
          opCount: prev?.opCount || 0,
          lastOpDesc: '',
        }))
        setTimeout(() => setExecutionProgress(null), 2000)
        // 解析错误信息，脱敏后推送
        let errorMessage = payload.error
        if (typeof payload.error === 'string') {
          try {
            const errorObj = JSON.parse(payload.error)
            if (errorObj.error?.code === '1305' || errorObj.error?.message?.includes('请求过多')) {
              errorMessage = '请求过于频繁，请稍等片刻后重试。'
            } else if (errorObj.error?.message) {
              errorMessage = errorObj.error.message
            }
          } catch (e) {
            // 非 JSON 格式
          }
        }
        pushSystemMessage('error', sanitizeErrorForUser(errorMessage))
        currentRequestIdRef.current = null
        break

      case 'data_query':
        // 后端只读工具通过 QueryBridge 请求前端计算
        {
          const { query_id, operation } = payload || {}
          if (!query_id || !operation) break
          const wb = workbookLatestRef.current
          const opType = operation.type
          const p = operation.params || {}
          let result
          try {
            if (opType === 'query_unique_values') {
              result = queryUniqueValuesReadonly(wb, p)
            } else if (opType === 'read_range_values') {
              result = readRangeValues(wb, p)
            } else if (opType === 'aggregate_column') {
              result = aggregateColumn(wb, p)
            } else if (opType === 'query_column_profile') {
              result = queryColumnProfile(wb, p)
            } else {
              result = { error: `未知查询类型: ${opType}` }
            }
          } catch (err) {
            result = { error: err.message }
          }
          // 异步回传结果到后端
          const baseUrl = (appConfig.apiBaseUrl || window.location.origin).replace(/\/$/, '')
          fetch(`${baseUrl}/api/excel/operation-result`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
            },
            body: JSON.stringify({ session_id: sessionId, query_id, result }),
          }).catch(err => flog.error('App', 'data_query 回传失败:', err))
        }
        break
    }
  }, [pushSystemMessage, sessionId, accessToken])
  
  const { sendCommand, sendState, isConnected, isReady } = useSSE({
    sessionId,
    accessToken,
    onMessage: handleWebSocketMessage,
    onConnect: () => {
      if (disconnectNoticeTimeoutRef.current) {
        clearTimeout(disconnectNoticeTimeoutRef.current)
        disconnectNoticeTimeoutRef.current = null
      }
    },
    onDisconnect: () => {
      if (!isAiProcessing) {
        return
      }
      if (disconnectNoticeTimeoutRef.current) {
        clearTimeout(disconnectNoticeTimeoutRef.current)
      }
      disconnectNoticeTimeoutRef.current = setTimeout(() => {
        if (processingTimeoutRef.current) {
          clearTimeout(processingTimeoutRef.current)
          processingTimeoutRef.current = null
        }
        setIsAiProcessing(false)
        setExecutionProgress(null)
        setAiMessages(prev => removeTransientExecutionMessages(prev))
        pushSystemMessage('error', '连接已断开，已中止当前请求，请重试。')
      }, 1200)
    }
  })

  // 防抖：避免重复请求
  const sendCommandTimeoutRef = useRef(null)
  
  const handleSendCommand = useCallback((command) => {
    if (!command.trim() || !isConnected || !isReady) return
    
    // 如果正在处理，忽略新请求
    if (isAiProcessing) {
      flog.warn('App', '正在处理中，忽略重复请求')
      return
    }
    
    // 重置公式引擎错误计数器（防止错误累积）
    resetFormulaErrorCount()

    const requestId = uuidv4()
      currentRequestIdRef.current = requestId
      failedOperationRequestsRef.current.delete(requestId)
      requestExecutionStatsRef.current.set(requestId, { operationCount: 0, hasCompletionClaim: false })
      if (requestExecutionStatsRef.current.size > 50) {
        const staleKeys = Array.from(requestExecutionStatsRef.current.keys()).slice(0, 25)
        staleKeys.forEach((key) => requestExecutionStatsRef.current.delete(key))
      }
      pushUserMessage(command)
      setIsAiProcessing(true)
      setExecutionProgress({ phase: 'thinking', opCount: 0, lastOpDesc: '' })
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current)
      }
      processingTimeoutRef.current = setTimeout(() => {
        if (currentRequestIdRef.current !== requestId) {
          return
        }
        setIsAiProcessing(false)
        setExecutionProgress(null)
        setAiMessages(prev => removeTransientExecutionMessages(prev))
        pushSystemMessage('error', '请求超时未返回，请重试或检查网络连接。')
        failedOperationRequestsRef.current.delete(requestId)
        currentRequestIdRef.current = null
      }, appConfig.aiTimeoutSec * 1000)

      let workbookForAgent = workbook
      if (univerModeRef.current && univerEditorRef.current?.flushToSheetbot) {
        const flushed = univerEditorRef.current.flushToSheetbot()
        if (flushed) {
          workbookForAgent = flushed
          setWorkbook(flushed)
        }
      }
      
      // 非活动表用预缓存（5行样本），活动表实时计算（20行样本）
      const isCacheFresh = workbookMetaCacheRef.current
        && workbookSourceForCacheRef.current === workbookForAgent
      const excelState = {
        sheets: workbookForAgent.sheets.map((s) => {
          const isActive = s.name === activeSheet
          if (!isActive && isCacheFresh) {
            const cached = workbookMetaCacheRef.current.find(c => c.name === s.name)
            if (cached) return cached
          }
          return computeSheetMeta(s, isActive ? 20 : 5)
        }),
        activeSheet,
        selection,
        customFormulas: customFormulas.map(f => ({
          name: f.name,
          label: f.label,
          expression: f.expression,
          description: f.description,
          params: f.params,
        })),
      }
      const contextVersion = (contextVersionRef.current || 0) + 1
      contextVersionRef.current = contextVersion
      
      ;(async () => {
        try {
          // 双通道兜底：先更新后端会话态，再发送命令
          await sendState({ context: excelState, contextVersion })
        } catch (stateErr) {
          flog.warn('App', '命令前状态同步失败（将继续尝试发送命令）', stateErr)
        }
        await sendCommand({
          command,
          context: excelState,
          contextVersion,
          requestId
        })
      })().catch((err) => {
        if (currentRequestIdRef.current !== requestId) {
          return
        }
        setIsAiProcessing(false)
        setExecutionProgress(null)
        setAiMessages(prev => removeTransientExecutionMessages(prev))
        const { isQuota, message } = parseQuotaFromError(err)
        pushSystemMessage('error', isQuota ? message : '请求发送失败，请检查网络或重试。')
        failedOperationRequestsRef.current.delete(requestId)
        currentRequestIdRef.current = null
      })
  }, [isConnected, isReady, sendCommand, sendState, workbook, activeSheet, selection, isAiProcessing, pushSystemMessage, pushUserMessage, computeSheetMeta])

  const { requestChartRegenAfterImport } = useChartRegenAfterImport({
    largeFileMode,
    platformView,
    isConnected,
    isReady,
    isAiProcessing,
    workbook,
    handleSendCommand,
    setAiPanelOpen,
    pushSystemMessage,
  })

  // ---- 单元格变更（内部实现，无文件守卫） ----
  const applyCellChange = useCallback((row, col, value) => {
    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const sheetIndex = newWorkbook.sheets.findIndex(s => s.name === activeSheet)
      if (sheetIndex === -1) return prev

      const sheet = newWorkbook.sheets[sheetIndex]
      if (!sheet.data[row]) sheet.data[row] = {}

      const existingStyle = sheet.data[row][col]?.style

      if (typeof value === 'string' && value.startsWith('=')) {
        sheet.data[row][col] = { formula: value, style: existingStyle }
      } else {
        sheet.data[row][col] = { value, style: existingStyle }
      }

      return newWorkbook
    })
  }, [activeSheet])

  // ---- 草稿命名：未命名工作簿_YYYYMMDD_HHmm.xlsx ----
  const buildDraftFilename = useCallback(() => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
    return `未命名工作簿_${stamp}.xlsx`
  }, [])

  // ---- 首编辑自动创建草稿（异步，带锁） ----
  const ensureDraftBeforeEdit = useCallback(async () => {
    if (selectedSidebarFile?.id) return true
    if (draftCreatedRef.current) return true
    if (isEnsuringDraftRef.current) return false
    if (!accessToken) return false

    isEnsuringDraftRef.current = true
    try {
      const ExcelJS = await import('exceljs')
      const excelWb = new ExcelJS.Workbook()
      excelWb.addWorksheet('Sheet1')
      const buffer = await excelWb.xlsx.writeBuffer()
      const filename = buildDraftFilename()
      const blob = new Blob(
        [buffer],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )
      const result = await filesApi.uploadFile(accessToken, blob, null, filename)
      const selectFn = handleSidebarFileSelectRef.current
      if (selectFn) {
        await selectFn({ ...result, type: 'file', name: result.file_name }, {
          preservePlatformView: true,
          skipAutoAnalyze: true,
        })
      }
      draftCreatedRef.current = true

      const queued = pendingEditsRef.current.splice(0)
      queued.forEach(({ row, col, value }) => applyCellChange(row, col, value))

      return true
    } catch (err) {
      flog.error('App', '自动创建草稿失败:', err)
      pushSystemMessage('error', '自动创建草稿失败，请稍后重试。')
      pendingEditsRef.current = []
      return false
    } finally {
      isEnsuringDraftRef.current = false
    }
  }, [accessToken, selectedSidebarFile?.id, buildDraftFilename, applyCellChange])

  // ---- 对外暴露的 handleCellChange（带文件守卫） ----
  const handleCellChange = useCallback((row, col, value) => {
    if (selectedSidebarFile?.id || draftCreatedRef.current) {
      applyCellChange(row, col, value)
      return
    }
    // 无文件：入队；仅在未锁定时触发草稿创建（锁定中说明已在创建，队列会被回放）
    pendingEditsRef.current.push({ row, col, value })
    if (!isEnsuringDraftRef.current) {
      ensureDraftBeforeEdit()
    }
  }, [selectedSidebarFile?.id, applyCellChange, ensureDraftBeforeEdit])

  const handleSelectionChange = useCallback((newSelection) => {
    setSelection({
      ...newSelection,
      extraCells: Array.isArray(newSelection?.extraCells) ? newSelection.extraCells : []
    })
  }, [])

  // 保存到历史记录
  const saveToHistory = useCallback((wb) => {
    const wbStr = JSON.stringify(wb)
    setHistory(prev => {
      const newHistory = prev.slice(0, historyIndex + 1)
      newHistory.push(wbStr)
      // 限制历史记录最多50条
      if (newHistory.length > 50) {
        newHistory.shift()
        return newHistory
      }
      return newHistory
    })
    setHistoryIndex(prev => Math.min(prev + 1, 49))
  }, [historyIndex])

  // 撤销
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const prevWb = JSON.parse(history[historyIndex - 1])
      setWorkbook(prevWb)
      setHistoryIndex(prev => prev - 1)
    }
  }, [history, historyIndex])

  // 重做
  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextWb = JSON.parse(history[historyIndex + 1])
      setWorkbook(nextWb)
      setHistoryIndex(prev => prev + 1)
    }
  }, [history, historyIndex])

  // 复制
  // --------------------------------------------------------------------------
  // 从 cell 对象提取可读文本（用于系统剪贴板）
  // --------------------------------------------------------------------------
  const extractCellText = useCallback((cell) => {
    if (!cell) return ''
    const v = cell.formula ?? cell.value ?? ''
    if (typeof v === 'object' && v !== null) return String(v.text ?? v.result ?? v.value ?? v.display ?? '')
    return String(v)
  }, [])

  const handleCopy = useCallback(() => {
    const sheet = getCurrentSheet()
    if (!sheet) return
    
    const { startRow, startCol, endRow, endCol } = selection
    const copiedData = []
    
    for (let row = startRow; row <= endRow; row++) {
      const rowData = []
      for (let col = startCol; col <= endCol; col++) {
        const cell = sheet.data[row]?.[col]
        rowData.push(cell ? JSON.parse(JSON.stringify(cell)) : null)
      }
      copiedData.push(rowData)
    }
    
    clipboardRef.current = {
      data: copiedData,
      startRow,
      startCol,
      endRow,
      endCol
    }
    setIsCutMode(false)
    setCanPaste(true)

    // 写入系统剪贴板（Tab 分隔，换行为行分隔），使内容可粘贴到记事本/Excel 等外部程序
    const text = copiedData
      .map(row => row.map(extractCellText).join('\t'))
      .join('\n')
    writeTextToSystemClipboard(text)
  }, [getCurrentSheet, selection, extractCellText])

  // 剪切
  const handleCut = useCallback(() => {
    const sheet = getCurrentSheet()
    if (!sheet) return
    
    const { startRow, startCol, endRow, endCol } = selection
    const copiedData = []
    
    for (let row = startRow; row <= endRow; row++) {
      const rowData = []
      for (let col = startCol; col <= endCol; col++) {
        const cell = sheet.data[row]?.[col]
        rowData.push(cell ? JSON.parse(JSON.stringify(cell)) : null)
      }
      copiedData.push(rowData)
    }
    
    clipboardRef.current = {
      data: copiedData,
      startRow,
      startCol,
      endRow,
      endCol
    }
    setIsCutMode(true)
    setCanPaste(true)
  }, [getCurrentSheet, selection])

  // 粘贴内部实现（无守卫）
  const applyPaste = useCallback((clipboard, sel, wasCut) => {
    const sheet = getCurrentSheet()
    if (!sheet) return

    const { startRow, startCol } = sel
    const { data, startRow: srcStartRow, startCol: srcStartCol, endRow: srcEndRow, endCol: srcEndCol } = clipboard

    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const sheetIndex = newWorkbook.sheets.findIndex(s => s.name === activeSheet)
      if (sheetIndex === -1) return prev

      const targetSheet = newWorkbook.sheets[sheetIndex]

      if (wasCut) {
        for (let row = srcStartRow; row <= srcEndRow; row++) {
          for (let col = srcStartCol; col <= srcEndCol; col++) {
            if (targetSheet.data[row]) {
              delete targetSheet.data[row][col]
            }
          }
        }
      }

      data.forEach((rowData, rowIdx) => {
        rowData.forEach((cell, colIdx) => {
          const targetRow = startRow + rowIdx
          const targetCol = startCol + colIdx

          if (!targetSheet.data[targetRow]) {
            targetSheet.data[targetRow] = {}
          }

          if (cell) {
            if (cell.formula) {
              const rowDiff = targetRow - srcStartRow - rowIdx
              const colDiff = targetCol - srcStartCol - colIdx

              let formula = cell.formula
              formula = formula.replace(/([A-Z]+)(\d+)/g, (match, colLetter, rowNum) => {
                const colNum = colLetter.split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0)
                const newColNum = colNum + colDiff
                const newRowNum = parseInt(rowNum) + rowDiff

                let newCol = ''
                let temp = newColNum
                while (temp > 0) {
                  const remainder = (temp - 1) % 26
                  newCol = String.fromCharCode(65 + remainder) + newCol
                  temp = Math.floor((temp - 1) / 26)
                }

                return `${newCol}${newRowNum}`
              })

              targetSheet.data[targetRow][targetCol] = { ...cell, formula }
            } else {
              targetSheet.data[targetRow][targetCol] = JSON.parse(JSON.stringify(cell))
            }
          }
        })
      })

      saveToHistory(newWorkbook)
      return newWorkbook
    })

    if (wasCut) {
      clipboardRef.current = null
      setIsCutMode(false)
      setCanPaste(false)
    }
  }, [getCurrentSheet, activeSheet, saveToHistory])

  // 粘贴（带文件守卫）
  const handlePaste = useCallback(() => {
    if (!clipboardRef.current) return

    if (!selectedSidebarFile?.id && !draftCreatedRef.current) {
      const snapshotClipboard = JSON.parse(JSON.stringify(clipboardRef.current))
      const snapshotSelection = { ...selection }
      const wasCut = isCutMode
      ensureDraftBeforeEdit().then((ok) => {
        if (!ok) return
        clipboardRef.current = snapshotClipboard
        applyPaste(snapshotClipboard, snapshotSelection, wasCut)
      })
      return
    }

    applyPaste(clipboardRef.current, selection, isCutMode)
  }, [selectedSidebarFile?.id, selection, isCutMode, ensureDraftBeforeEdit, applyPaste])

  // ============================================================================
  // 键盘快捷键：Ctrl+C/V/Z/Y 复制粘贴撤销重做
  // ============================================================================
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 忽略输入框中的快捷键
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      // 忽略编辑中的单元格
      if (editingCell) return
      
      // Ctrl+X / Cmd+X 剪切
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        e.preventDefault()
        handleCut()
      }
      // Ctrl+C / Cmd+C 复制
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault()
        handleCopy()
      }
      // Ctrl+V / Cmd+V 粘贴
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        e.preventDefault()
        handlePaste()
      }
      // Ctrl+Z / Cmd+Z 撤销
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z 重做
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        handleRedo()
      }
      // Ctrl+Y / Cmd+Y 重做（Windows 习惯）
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault()
        handleRedo()
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingCell, handleCut, handleCopy, handlePaste, handleUndo, handleRedo])

  // ============================================================================
  // 格式刷功能
  // ============================================================================
  const handleFormatBrush = useCallback(() => {
    if (formatBrushActive) {
      // 如果已激活，取消激活
      setFormatBrushActive(false)
      formatBrushRef.current = null
    } else {
      // 激活格式刷，缓存当前选中单元格的样式
      const sheet = getCurrentSheet()
      if (!sheet) return
      const cell = sheet.data[selection.startRow]?.[selection.startCol]
      if (cell?.style) {
        formatBrushRef.current = JSON.parse(JSON.stringify(cell.style))
        setFormatBrushActive(true)
      }
    }
  }, [formatBrushActive, getCurrentSheet, selection])

  // 应用格式刷（当点击单元格时调用）
  const applyFormatBrush = useCallback(() => {
    if (!formatBrushActive || !formatBrushRef.current) return false
    
    const style = formatBrushRef.current
    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const sheetIndex = newWorkbook.sheets.findIndex(s => s.name === activeSheet)
      if (sheetIndex === -1) return prev
      
      const sheet = newWorkbook.sheets[sheetIndex]
      const { startRow, startCol, endRow, endCol } = selection
      
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          if (!sheet.data[row]) sheet.data[row] = {}
          if (!sheet.data[row][col]) sheet.data[row][col] = {}
          sheet.data[row][col].style = JSON.parse(JSON.stringify(style))
        }
      }
      
      saveToHistory(newWorkbook)
      return newWorkbook
    })
    
    // 应用后取消激活
    setFormatBrushActive(false)
    formatBrushRef.current = null
    return true
  }, [formatBrushActive, activeSheet, selection, saveToHistory])

  // ============================================================================
  // 排序功能
  // ============================================================================
  const handleSort = useCallback((direction) => {
    const effectiveDirection = direction || (sortDirectionRef.current === 'asc' ? 'desc' : 'asc')
    sortDirectionRef.current = effectiveDirection

    if (univerModeRef.current && univerEditorRef.current?.sortByColumn) {
      const colIndex = (selection.startCol ?? 1) - 1
      univerEditorRef.current.sortByColumn(colIndex, effectiveDirection === 'asc')
      return
    }

    const sheet = getCurrentSheet()
    if (!sheet) return

    clearFormulaErrorCache()

    const usedRange = getUsedRange(sheet)
    if (!usedRange) return

    const sortColumn = selection.startCol === selection.endCol
      ? selection.startCol
      : selection.endCol
    const dataStartRow = usedRange.startRow === 1 ? 2 : usedRange.startRow

    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const sheetIndex = newWorkbook.sheets.findIndex(s => s.name === activeSheet)
      if (sheetIndex === -1) return prev

      const targetSheet = newWorkbook.sheets[sheetIndex]

      // ----------------------------------------------------------------
      // 第一步：在原始数据上，把所有公式烘焙为计算值
      // 这样行移动后不存在"引用漂移"问题
      // ----------------------------------------------------------------
      for (let row = dataStartRow; row <= usedRange.endRow; row++) {
        const rowData = targetSheet.data[row]
        if (!rowData) continue
        for (const colKey of Object.keys(rowData)) {
          const cell = rowData[colKey]
          if (!cell?.formula) continue
          try {
            const val = evaluateFormula(cell.formula, targetSheet.data)
            const isError = typeof val === 'string' && val.startsWith('#')
            if (val !== null && val !== undefined && !isError) {
              cell.value = val
            }
          } catch { /* 保留原值 */ }
          delete cell.formula
        }
      }

      // ----------------------------------------------------------------
      // 第二步：收集数据行 + 排序键
      // ----------------------------------------------------------------
      const sortableRows = []
      for (let row = dataStartRow; row <= usedRange.endRow; row++) {
        const fullRow = targetSheet.data[row] || {}
        const rawValue = fullRow[sortColumn]?.value ?? null
        sortableRows.push({ row, fullRow, key: toSortKey(rawValue) })
      }

      sortableRows.sort((a, b) => {
        if (a.key.rank !== b.key.rank) return a.key.rank - b.key.rank
        if (a.key.v < b.key.v) return -1
        if (a.key.v > b.key.v) return 1
        return a.row - b.row
      })

      if (effectiveDirection === 'desc') sortableRows.reverse()

      // ----------------------------------------------------------------
      // 第三步：写回（无需任何公式偏移）
      // ----------------------------------------------------------------
      sortableRows.forEach((item, idx) => {
        targetSheet.data[dataStartRow + idx] = item.fullRow
      })

      clearFormulaErrorCache()
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [getCurrentSheet, selection, activeSheet, saveToHistory])

  // 查找/替换处理
  const handleFindReplace = useCallback(({ find, replace, matchCase, matchWholeCell, replaceAll }) => {
    if (!find) return // 如果没有查找内容，不执行
    if (replaceAll) {
      setWorkbook(prev => {
        const newWorkbook = executeOperation(prev, {
          type: 'find_replace',
          params: {
            sheet: activeSheet,
            find,
            replace: replace || find,
            matchCase: matchCase || false,
            matchWholeCell: matchWholeCell || false
          }
        })
        saveToHistory(newWorkbook)
        return newWorkbook
      })
      return
    }

    const sheet = activeSheetObj
    if (!sheet?.data) return
    const regex = buildFindRegex(find, matchCase || false, matchWholeCell || false)

    const selected = selection
    const selectedCell = sheet.data[selected.startRow]?.[selected.startCol]
    // 获取单元格显示值（公式计算结果或原始值）
    const getDisplayValue = (cell) => {
      if (!cell) return null
      if (cell.formula) {
        try {
          return evaluateFormula(cell.formula, sheet.data)
        } catch {
          return cell.value
        }
      }
      return cell.value
    }
    const selectedDisplayValue = getDisplayValue(selectedCell)
    if (selectedDisplayValue !== undefined && selectedDisplayValue !== null && regex.test(String(selectedDisplayValue))) {
      setWorkbook(prev => {
        const newWorkbook = JSON.parse(JSON.stringify(prev))
        const targetSheet = newWorkbook.sheets.find(s => s.name === activeSheet)
        if (!targetSheet?.data[selected.startRow]) return prev
        if (!targetSheet.data[selected.startRow][selected.startCol]) return prev
        const cell = targetSheet.data[selected.startRow][selected.startCol]
        // 用显示值进行替换，替换后变成普通值
        const displayVal = String(selectedDisplayValue)
        cell.value = displayVal.replace(regex, replace || find)
        delete cell.formula
        saveToHistory(newWorkbook)
        return newWorkbook
      })
      return
    }

    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const targetSheet = newWorkbook.sheets.find(s => s.name === activeSheet)
      if (!targetSheet?.data) return prev
      // 获取单元格显示值（公式计算结果或原始值）
      const getDisplayVal = (cell) => {
        if (!cell) return null
        if (cell.formula) {
          try {
            return evaluateFormula(cell.formula, targetSheet.data)
          } catch {
            return cell.value
          }
        }
        return cell.value
      }
      
      const rows = getSortedRows(targetSheet)
      for (const row of rows) {
        const rowData = targetSheet.data[row] || {}
        const cols = getSortedCols(rowData)
        for (const col of cols) {
          const cell = rowData[col]
          if (!cell) continue
          
          // 使用显示值（公式计算结果）进行匹配
          const displayVal = getDisplayVal(cell)
          if (displayVal === undefined || displayVal === null) continue
          
          if (regex.test(String(displayVal))) {
            // 替换后变成普通值
            cell.value = String(displayVal).replace(regex, replace || find)
            delete cell.formula
            saveToHistory(newWorkbook)
            return newWorkbook
          }
          regex.lastIndex = 0
        }
      }
      return newWorkbook
    })
  }, [activeSheet, activeSheetObj, selection, saveToHistory])

  const handleFindOnly = useCallback(({ find, matchCase = false, matchWholeCell = false }) => {
    if (!find || !activeSheetObj?.data) return
    const regex = buildFindRegex(find, matchCase, matchWholeCell)
    const rows = getSortedRows(activeSheetObj)
    const last = lastFindRef.current
    const sameQuery = last && last.find === find && last.matchCase === matchCase && last.matchWholeCell === matchWholeCell
    let startRow = sameQuery ? last.row : rows[0]
    let startCol = sameQuery ? last.col + 1 : -1

    // 获取单元格显示值（公式计算结果或原始值）
    const getDisplayVal = (cell) => {
      if (!cell) return null
      if (cell.formula) {
        try {
          return evaluateFormula(cell.formula, activeSheetObj.data)
        } catch {
          return cell.value
        }
      }
      return cell.value
    }
    
    const trySearch = (fromRow, fromCol) => {
      for (const row of rows) {
        if (row < fromRow) continue
        const rowData = activeSheetObj.data[row] || {}
        const cols = getSortedCols(rowData)
        for (const col of cols) {
          if (row === fromRow && col <= fromCol) continue
          const cell = rowData[col]
          if (!cell) continue
          
          // 使用显示值（公式计算结果）进行匹配
          const displayVal = getDisplayVal(cell)
          if (displayVal === undefined || displayVal === null) continue
          
          if (regex.test(String(displayVal))) {
            lastFindRef.current = { find, matchCase, matchWholeCell, row, col }
            setSelection({ startRow: row, startCol: col, endRow: row, endCol: col })
            return true
          }
          regex.lastIndex = 0
        }
      }
      return false
    }

    if (trySearch(startRow, startCol)) return
    trySearch(rows[0], -1)
  }, [activeSheetObj, setSelection])

  // 筛选处理
  const handleFilter = useCallback((filterParams) => {
    const normalizedConditions = Array.isArray(filterParams?.conditions)
      ? filterParams.conditions.reduce((acc, item) => {
          if (!item) return acc
          const col = Number(item.column)
          if (!Number.isFinite(col)) return acc
          acc[col] = {
            operator: item.operator,
            value: item.value
          }
          return acc
        }, {})
      : (filterParams?.conditions || {})

    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'filter_data',
        params: {
          sheet: activeSheet,
          ...filterParams,
          conditions: normalizedConditions
        }
      })
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleRowHeightChange = useCallback((row, height, commit = false) => {
    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'set_row_height',
        params: { sheet: activeSheet, row, height }
      })
      if (commit) saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleSetSelectedRowsHeight = useCallback(() => {
    const { startRow, endRow } = selection
    const targetRows = []
    for (let row = startRow; row <= endRow; row++) targetRows.push(row)
    const currentHeight = getCurrentSheet()?.rowHeights?.[startRow] || 24
    const input = window.prompt('请输入行高（像素，建议 18-80）', String(currentHeight))
    if (input == null) return

    const nextHeight = Number(input)
    if (!Number.isFinite(nextHeight) || nextHeight < 0) {
      pushSystemMessage('warning', '行高无效，请输入大于等于 0 的数字。')
      return
    }

    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const sheetIndex = newWorkbook.sheets.findIndex(s => s.name === activeSheet)
      if (sheetIndex === -1) return prev
      const targetSheet = newWorkbook.sheets[sheetIndex]
      if (!targetSheet.rowHeights) targetSheet.rowHeights = {}
      targetRows.forEach((row) => {
        targetSheet.rowHeights[row] = nextHeight
      })
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [selection, getCurrentSheet, activeSheet, saveToHistory])

  const handleColWidthChange = useCallback((col, width, commit = false) => {
    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'set_column_width',
        params: { sheet: activeSheet, col, width }
      })
      if (commit) saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleInsertRow = useCallback((row, position = 'before') => {
    const insertAt = position === 'after' ? row + 1 : row
    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'insert_row',
        params: { sheet: activeSheet, row: insertAt, count: 1 }
      })
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleDeleteRow = useCallback((row, count = 1) => {
    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'delete_row',
        params: { sheet: activeSheet, row, count }
      })
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleInsertCol = useCallback((col, position = 'before') => {
    const insertAt = position === 'after' ? col + 1 : col
    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'insert_column',
        params: { sheet: activeSheet, col: insertAt, count: 1 }
      })
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleDeleteCol = useCallback((col, count = 1) => {
    setWorkbook(prev => {
      const newWorkbook = executeOperation(prev, {
        type: 'delete_column',
        params: { sheet: activeSheet, col, count }
      })
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, saveToHistory])

  const handleFormatChange = useCallback((formatType, value) => {
    // 处理对话框打开
    if (formatType === 'find') {
      setFindReplaceOpen(true)
      return
    }
    if (formatType === 'filter') {
      setFilterOpen(true)
      return
    }
    
    setWorkbook(prev => {
      const newWorkbook = JSON.parse(JSON.stringify(prev))
      const sheetIndex = newWorkbook.sheets.findIndex(s => s.name === activeSheet)
      if (sheetIndex === -1) return prev
      
      const sheet = newWorkbook.sheets[sheetIndex]
      const { startRow, startCol, endRow, endCol } = selection
      const extraCells = Array.isArray(selection.extraCells) ? selection.extraCells : []
      const selectedCellMap = new Map()
      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          selectedCellMap.set(`${row}:${col}`, { row, col })
        }
      }
      extraCells.forEach(({ row, col }) => {
        if (!row || !col) return
        selectedCellMap.set(`${row}:${col}`, { row, col })
      })
      const selectedCells = Array.from(selectedCellMap.values())
      const anchorCellStyle = sheet.data?.[startRow]?.[startCol]?.style || {}
      const resolveToggleValue = (styleKey) => {
        if (typeof value === 'boolean') return value
        return !Boolean(anchorCellStyle?.[styleKey])
      }
      const boldTarget = resolveToggleValue('bold')
      const italicTarget = resolveToggleValue('italic')
      const underlineTarget = resolveToggleValue('underline')
      const shouldToggleBorder = formatType === 'border' && value === 'all'
      const hasAnyBorderSide = (cellStyle) => {
        const b = cellStyle?.border
        return Boolean(b?.top || b?.bottom || b?.left || b?.right)
      }
      const shouldClearAllBorders =
        shouldToggleBorder &&
        selectedCells.length > 0 &&
        selectedCells.every(({ row: r, col: c }) => hasAnyBorderSide(sheet.data?.[r]?.[c]?.style))
      
      // 应用格式到选中区域（主选区 + Ctrl 多选单元格）
      for (const { row, col } of selectedCells) {
          if (!sheet.data[row]) sheet.data[row] = {}
          if (!sheet.data[row][col]) sheet.data[row][col] = {}
          if (!sheet.data[row][col].style) sheet.data[row][col].style = {}
          
          switch (formatType) {
            case 'bold':
              sheet.data[row][col].style.bold = boldTarget
              break
            case 'italic':
              sheet.data[row][col].style.italic = italicTarget
              break
            case 'underline':
              sheet.data[row][col].style.underline = underlineTarget
              break
            case 'strikethrough':
              sheet.data[row][col].style.strikethrough = value
              break
            case 'fontSize':
              sheet.data[row][col].style.fontSize = value
              break
            case 'fontColor':
              sheet.data[row][col].style.fontColor = value
              break
            case 'backgroundColor':
              sheet.data[row][col].style.backgroundColor = value
              break
            case 'align':
              sheet.data[row][col].style.horizontalAlignment = value
              break
            case 'verticalAlign':
              sheet.data[row][col].style.verticalAlignment = value
              break
            case 'wrapText':
              sheet.data[row][col].style.wrapText = value
              break
            case 'border': {
              // --------------------------------
              // 清除边框后的副作用清理：
              //   1. style 对象为空 → 删除 style 属性本身，防止空 style:{} 残留
              //   2. 无数据 + 无样式 → 删除整个单元格条目，防止空白 inline style 覆盖 CSS/条件格式背景
              // --------------------------------
              const _cleanCell = (rr, cc) => {
                const _c = sheet.data[rr]?.[cc]
                if (!_c) return
                if (_c.style && Object.keys(_c.style).length === 0) delete _c.style
                const _noData = (_c.value === undefined || _c.value === null || _c.value === '') && !_c.formula
                if (_noData && !_c.style) {
                  delete sheet.data[rr][cc]
                  if (sheet.data[rr] && Object.keys(sheet.data[rr]).length === 0) delete sheet.data[rr]
                }
              }
              if (value === 'all') {
                if (shouldClearAllBorders) {
                  delete sheet.data[row][col].style.border
                  _cleanCell(row, col)
                } else {
                  const borderStyle = { style: 'thin', color: '#000000' }
                  sheet.data[row][col].style.border = {
                    top: borderStyle,
                    left: borderStyle,
                    right: borderStyle,
                    bottom: borderStyle
                  }
                }
              } else if (value === 'none') {
                delete sheet.data[row][col].style.border
                _cleanCell(row, col)
              }
              break
            }
            case 'numberFormat':
              sheet.data[row][col].style.numberFormat = value
              break
            case 'merge':
              // 合并单元格逻辑
              if (value) {
                if (!sheet.mergedCells) sheet.mergedCells = []
                sheet.mergedCells.push({ startRow, startCol, endRow, endCol })
              }
              break
            case 'insert':
              // 插入行列逻辑
              if (value === 'row') {
                // 插入行
                const newData = {}
                Object.keys(sheet.data).forEach(key => {
                  const rowNum = parseInt(key)
                  if (rowNum >= startRow) {
                    newData[rowNum + 1] = sheet.data[key]
                  } else {
                    newData[key] = sheet.data[key]
                  }
                })
                sheet.data = newData
                sheet.rowCount = (sheet.rowCount || 0) + 1
              } else if (value === 'column') {
                // 插入列
                Object.keys(sheet.data).forEach(key => {
                  const rowData = sheet.data[key]
                  const newRowData = {}
                  Object.keys(rowData).forEach(colKey => {
                    const colNum = parseInt(colKey)
                    if (colNum >= startCol) {
                      newRowData[colNum + 1] = rowData[colKey]
                    } else {
                      newRowData[colKey] = rowData[colKey]
                    }
                  })
                  sheet.data[key] = newRowData
                })
                sheet.colCount = (sheet.colCount || 0) + 1
              }
              break
            case 'delete':
              // 删除行列逻辑
              if (value === 'row') {
                const newData = {}
                Object.keys(sheet.data).forEach(key => {
                  const rowNum = parseInt(key)
                  if (rowNum < startRow || rowNum > endRow) {
                    if (rowNum > endRow) {
                      newData[rowNum - (endRow - startRow + 1)] = sheet.data[key]
                    } else {
                      newData[key] = sheet.data[key]
                    }
                  }
                })
                sheet.data = newData
                sheet.rowCount = Math.max(0, (sheet.rowCount || 0) - (endRow - startRow + 1))
              } else if (value === 'column') {
                Object.keys(sheet.data).forEach(key => {
                  const rowData = sheet.data[key]
                  const newRowData = {}
                  Object.keys(rowData).forEach(colKey => {
                    const colNum = parseInt(colKey)
                    if (colNum < startCol || colNum > endCol) {
                      if (colNum > endCol) {
                        newRowData[colNum - (endCol - startCol + 1)] = rowData[colKey]
                      } else {
                        newRowData[colKey] = rowData[colKey]
                      }
                    }
                  })
                  sheet.data[key] = newRowData
                })
                sheet.colCount = Math.max(0, (sheet.colCount || 0) - (endCol - startCol + 1))
              }
              break
          }
      }
      
      saveToHistory(newWorkbook)
      return newWorkbook
    })
  }, [activeSheet, selection, saveToHistory])

  const handleAddSheet = useCallback(() => {
    const newName = `Sheet${workbook.sheets.length + 1}`
    setWorkbook(prev => ({
      ...prev,
      sheets: [...prev.sheets, {
        name: newName,
        data: {},
        rowCount: DEFAULT_WORKSHEET_ROWS,
        colCount: 26,
        colWidths: {},
        rowHeights: {}
      }]
    }))
    setActiveSheet(newName)
  }, [workbook.sheets.length])

  const handleDeleteSheet = useCallback((sheetName) => {
    if (isAiProcessing) {
      // 使用 pushSystemMessage：pushAiWarningMessage 在本 hook 之后定义，引用会触发 TDZ
      pushSystemMessage('warning', 'AI 正在处理任务，暂时无法删除工作表，请等待任务完成后再操作。', {
        revealPanel: true,
      })
      return
    }
    if (workbook.sheets.length <= 1) return
    setWorkbook(prev => ({
      ...prev,
      sheets: prev.sheets.filter(s => s.name !== sheetName)
    }))
    if (activeSheet === sheetName) {
      setActiveSheet(workbook.sheets[0].name)
    }
  }, [workbook.sheets, activeSheet, isAiProcessing, pushSystemMessage])

  const handleOpenFile = useCallback(async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    // 提取文件名（不含扩展名）
    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '')
    setCurrentFileName(nameWithoutExt)
    const ExcelJS = await import('exceljs')
    const arrayBuffer = await file.arrayBuffer()
    const excelWb = new ExcelJS.Workbook()
    const chartsDegraded = await loadXlsxWithChartFallback(excelWb, arrayBuffer)
    const newWorkbook = exceljsToWorkbook(excelWb)
    setWorkbook(newWorkbook)
    setActiveSheet(newWorkbook.activeSheet)
    setHistory([JSON.stringify(newWorkbook)])
    setHistoryIndex(0)
    setSelectedSidebarFile(null)
    lastSavedSnapshotRef.current = JSON.stringify(newWorkbook)
    setSaveStatus('idle')
    setPlatformView('normal')
    setLargeFileMode(false)
    event.target.value = ''
    if (chartsDegraded) {
      requestChartRegenAfterImport()
    }
  }, [requestChartRegenAfterImport])

  const handleOpen = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleSave = useCallback(async (format) => {
    let wb = workbook
    const flushed = getFlushedWorkbookSync(true)
    if (flushed) wb = flushed
    const baseName = currentFileName || 'workbook'
    if (format === 'json') {
      const dataStr = JSON.stringify(wb, null, 2)
      const blob = new Blob([dataStr], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${baseName}.json`
      a.click()
      URL.revokeObjectURL(url)
    } else if (format === 'xlsx') {
      const { saveAs } = await import('file-saver')
      let buffer = await buildWorkbookXlsxBuffer(wb)
      buffer = await injectNativeCharts(buffer, wb)
      const blob = new Blob([buffer], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      })
      saveAs(blob, `${baseName}.xlsx`)
    }
  }, [workbook, currentFileName, getFlushedWorkbookSync])

  function normalizeColorToArgb(color) {
    if (!color) return undefined
    const raw = String(color).trim().replace('#', '')
    if (raw.length === 8) return raw.toUpperCase()
    if (raw.length === 6) return `FF${raw.toUpperCase()}`
    return undefined
  }

  function buildExcelCellStyle(style) {
    if (!style) return undefined
    const excelStyle = {}

    if (
      style.bold !== undefined ||
      style.italic !== undefined ||
      style.underline !== undefined ||
      style.fontSize !== undefined ||
      style.fontColor
    ) {
      const font = {}
      if (style.bold !== undefined) font.bold = !!style.bold
      if (style.italic !== undefined) font.italic = !!style.italic
      if (style.underline !== undefined) font.underline = !!style.underline
      if (style.strikethrough !== undefined) font.strike = !!style.strikethrough
      if (style.fontSize !== undefined) font.size = Number(style.fontSize) || undefined
      const fontArgb = normalizeColorToArgb(style.fontColor)
      if (fontArgb) font.color = { argb: fontArgb }
      if (Object.keys(font).length > 0) excelStyle.font = font
    }

    if (style.backgroundColor) {
      const bgArgb = normalizeColorToArgb(style.backgroundColor)
      if (bgArgb) {
        excelStyle.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgArgb }
        }
      }
    }

    const horizontalAlignment = style.horizontalAlignment || style.horizontalAlign
    const verticalAlignment = style.verticalAlignment || style.verticalAlign
    if (horizontalAlignment || verticalAlignment || style.wrapText !== undefined) {
      excelStyle.alignment = {}
      if (horizontalAlignment) excelStyle.alignment.horizontal = horizontalAlignment
      if (verticalAlignment) excelStyle.alignment.vertical = verticalAlignment
      if (style.wrapText !== undefined) excelStyle.alignment.wrapText = !!style.wrapText
    }

    if (style.numberFormat) {
      excelStyle.numFmt = style.numberFormat
    }

    if (style.border && typeof style.border === 'object') {
      const normalizeBorderSide = (side) => {
        if (!side || typeof side !== 'object') return undefined
        const next = { ...side }
        const colorStr = typeof next.color === 'string' ? next.color : next.color?.argb
        const colorArgb = normalizeColorToArgb(colorStr)
        if (colorArgb) {
          next.color = { argb: colorArgb }
        } else {
          delete next.color
        }
        return next
      }
      excelStyle.border = {
        top: normalizeBorderSide(style.border.top),
        right: normalizeBorderSide(style.border.right),
        bottom: normalizeBorderSide(style.border.bottom),
        left: normalizeBorderSide(style.border.left)
      }
    }

    return Object.keys(excelStyle).length > 0 ? excelStyle : undefined
  }

  function getCellCommentText(cell) {
    if (!cell) return ''
    if (typeof cell.note === 'string' && cell.note.trim()) return cell.note.trim()
    if (typeof cell.comment === 'string' && cell.comment.trim()) return cell.comment.trim()
    if (Array.isArray(cell.comments) && cell.comments.length > 0) {
      const first = cell.comments[0]
      if (typeof first === 'string' && first.trim()) return first.trim()
      if (typeof first?.text === 'string' && first.text.trim()) return first.text.trim()
    }
    return ''
  }

  function getCellHyperlink(cell) {
    if (!cell) return null
    if (typeof cell.hyperlink === 'string' && cell.hyperlink.trim()) {
      const url = cell.hyperlink.trim()
      return { url, text: cell.value !== undefined && cell.value !== null ? String(cell.value) : url }
    }
    if (cell.hyperlink && typeof cell.hyperlink === 'object') {
      const urlRaw = cell.hyperlink.url || cell.hyperlink.hyperlink || cell.hyperlink.target
      const url = typeof urlRaw === 'string' ? urlRaw.trim() : ''
      if (!url) return null
      const textRaw = cell.hyperlink.text
      const text = typeof textRaw === 'string' && textRaw.trim()
        ? textRaw.trim()
        : (cell.value !== undefined && cell.value !== null ? String(cell.value) : url)
      return { url, text }
    }
    return null
  }

  function toExcelCellValue(cell) {
    if (cell?.formula) {
      return { formula: cell.formula.substring(1) }
    }
    const hyperlink = getCellHyperlink(cell)
    if (hyperlink?.url) {
      const displayText = cell?.value !== undefined && cell?.value !== null && String(cell.value) !== ''
        ? String(cell.value)
        : (hyperlink.text || hyperlink.url)
      return {
        text: displayText,
        hyperlink: hyperlink.url
      }
    }
    return cell?.value
  }

  function applyCellMetaToExcelCell(excelCell, cell) {
    const excelStyle = buildExcelCellStyle(cell?.style)
    if (excelStyle) {
      excelCell.style = excelStyle
    }
    const commentText = getCellCommentText(cell)
    if (commentText) {
      excelCell.note = commentText
    }
  }

  function toExcelDataValidation(rule) {
    const v = rule?.validation
    if (!v || typeof v !== 'object') return null
    const type = v.type || v.validationType
    if (!type) return null

    const params = v.params || v.validationParams || v
    const validation = {
      type,
      allowBlank: params?.allowBlank !== undefined ? !!params.allowBlank : true
    }

    if (params?.operator) validation.operator = params.operator
    if (params?.showErrorMessage !== undefined) validation.showErrorMessage = !!params.showErrorMessage
    if (params?.errorStyle) validation.errorStyle = params.errorStyle
    if (params?.errorTitle) validation.errorTitle = params.errorTitle
    if (params?.error) validation.error = params.error
    if (params?.showInputMessage !== undefined) validation.showInputMessage = !!params.showInputMessage
    if (params?.promptTitle) validation.promptTitle = params.promptTitle
    if (params?.prompt) validation.prompt = params.prompt

    let formulae
    if (Array.isArray(params?.formulae) && params.formulae.length > 0) {
      formulae = params.formulae
    } else if (type === 'list') {
      if (Array.isArray(params?.values) && params.values.length > 0) {
        formulae = [`"${params.values.join(',')}"`]
      } else if (typeof params?.source === 'string' && params.source.trim()) {
        formulae = [params.source.trim()]
      }
    } else if (params?.min !== undefined && params?.max !== undefined) {
      formulae = [params.min, params.max]
    } else if (params?.start !== undefined && params?.end !== undefined) {
      formulae = [params.start, params.end]
    } else if (params?.value !== undefined) {
      formulae = [params.value]
    } else if (params?.formula !== undefined) {
      formulae = [params.formula]
    }
    if (formulae?.length) validation.formulae = formulae

    return validation
  }

  async function buildWorkbookXlsxBuffer(currentWorkbook) {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()

    const toExcelTabColor = (hex) => {
      const raw = String(hex || '').trim()
      if (!raw) return undefined
      const normalized = raw.startsWith('#') ? raw.slice(1) : raw
      if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined
      return { argb: `FF${normalized.toUpperCase()}` }
    }

    const parseImageSource = (src) => {
      const raw = String(src || '').trim()
      if (!raw) return null
      // data:image/png;base64,xxxx
      const dataUrlMatch = raw.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/)
      if (dataUrlMatch) {
        const extRaw = dataUrlMatch[1].toLowerCase()
        const extension = extRaw === 'jpeg' ? 'jpg' : extRaw
        return { base64: dataUrlMatch[2], extension }
      }
      // 纯 base64（无法可靠判断格式，默认 png）
      if (!raw.startsWith('http://') && !raw.startsWith('https://') && raw.length > 200) {
        return { base64: raw, extension: 'png' }
      }
      return null
    }

    currentWorkbook.sheets.forEach(sheetData => {
      const ws = wb.addWorksheet(sheetData.name)
      const tabColor = toExcelTabColor(sheetData?.tabColor)
      if (tabColor) {
        ws.properties.tabColor = tabColor
      }
      ws.state = sheetData?.hidden ? 'hidden' : 'visible'
      const imageIdCache = new Map()
      const pendingCellImages = []
      const chartAnchorSet = new Set(
        (sheetData.charts || []).map((c) => `${(Number(c?.row) || 1)}:${(Number(c?.col) || 1)}`)
      )
      Object.entries(sheetData.data || {}).forEach(([rowStr, rowData]) => {
        const rowNum = parseInt(rowStr)
        Object.entries(rowData || {}).forEach(([colStr, cell]) => {
          const colNum = parseInt(colStr)
          const excelCell = ws.getCell(rowNum, colNum)
          excelCell.value = toExcelCellValue(cell)
          applyCellMetaToExcelCell(excelCell, cell)
          const imageSrc = typeof cell?.image?.src === 'string' ? cell.image.src : ''
          if (imageSrc) {
            pendingCellImages.push({
              rowNum,
              colNum,
              src: imageSrc,
              width: Number(cell?.image?.width) || undefined,
              height: Number(cell?.image?.height) || undefined,
              rowSpan: Math.max(1, Number(cell?.image?.rowSpan) || 1),
              colSpan: Math.max(1, Number(cell?.image?.colSpan) || 1),
            })
          }
        })
      })

      ;(sheetData.dataValidations || []).forEach(rule => {
        const startRow = Number(rule?.startRow)
        const startCol = Number(rule?.startCol)
        const endRow = Number(rule?.endRow)
        const endCol = Number(rule?.endCol)
        if (!Number.isFinite(startRow) || !Number.isFinite(startCol) || !Number.isFinite(endRow) || !Number.isFinite(endCol)) {
          return
        }
        const excelValidation = toExcelDataValidation(rule)
        if (!excelValidation) return
        for (let r = startRow; r <= endRow; r++) {
          for (let c = startCol; c <= endCol; c++) {
            ws.getCell(r, c).dataValidation = { ...excelValidation }
          }
        }
      })

      ;(sheetData.mergedCells || []).forEach(range => {
        const startRow = Number(range?.startRow)
        const startCol = Number(range?.startCol)
        const endRow = Number(range?.endRow)
        const endCol = Number(range?.endCol)
        if (!Number.isFinite(startRow) || !Number.isFinite(startCol) || !Number.isFinite(endRow) || !Number.isFinite(endCol)) {
          return
        }
        try {
          ws.mergeCells(startRow, startCol, endRow, endCol)
        } catch {
          // 忽略重复或冲突合并，避免导出中断
        }
      })

      Object.entries(sheetData.colWidths || {}).forEach(([colStr, width]) => {
        const colNum = parseInt(colStr)
        if (!Number.isFinite(colNum) || !width) return
        ws.getColumn(colNum).width = Number(width) / 8
      })
      Object.entries(sheetData.rowHeights || {}).forEach(([rowStr, height]) => {
        const rowNum = parseInt(rowStr)
        if (!Number.isFinite(rowNum) || !height) return
        ws.getRow(rowNum).height = Number(height) * 0.75
      })

      // 写回“单元格图片”（普通视图导入的本地嵌入图片）
      pendingCellImages.forEach((img) => {
        // 与可编辑图表锚点重合的图片视为历史图表快照，导出时跳过，避免与 chart 叠加
        if (chartAnchorSet.has(`${img.rowNum}:${img.colNum}`)) {
          return
        }
        const payload = parseImageSource(img.src)
        if (!payload) return
        const cacheKey = `${payload.extension}:${payload.base64.slice(0, 128)}:${payload.base64.length}`
        let imageId = imageIdCache.get(cacheKey)
        if (!imageId) {
          imageId = wb.addImage(payload)
          imageIdCache.set(cacheKey, imageId)
        }
        const tl = { col: img.colNum - 1, row: img.rowNum - 1 }
        if (img.rowSpan > 1 || img.colSpan > 1) {
          ws.addImage(imageId, {
            tl,
            br: {
              col: tl.col + img.colSpan,
              row: tl.row + img.rowSpan,
            },
          })
          return
        }
        ws.addImage(imageId, {
          tl,
          ext: {
            width: img.width || 96,
            height: img.height || 96,
          },
        })
      })

    })

    const metaSheet = wb.addWorksheet('__SHEETBOT_META__')
    metaSheet.state = 'hidden'
    const charts = {}
    currentWorkbook.sheets.forEach(sheet => {
      if (sheet?.charts?.length) charts[sheet.name] = sheet.charts
    })
    metaSheet.getCell(1, 1).value = JSON.stringify({ version: 1, charts })

    return wb.xlsx.writeBuffer()
  }

  // ---- 向 xlsx 注入原生 Excel 图表（后端 openpyxl 生成） ----
  // 降级策略：后端不可用时，回退到 ECharts PNG 图片嵌入方案
  async function injectNativeCharts(xlsxBuffer, currentWorkbook) {
    const chartsMap = {}
    let hasCharts = false
    currentWorkbook.sheets.forEach(sheet => {
      if (sheet?.charts?.length) {
        chartsMap[sheet.name] = sheet.charts
        hasCharts = true
      }
    })
    if (!hasCharts) return xlsxBuffer

    try {
      const baseUrl = (appConfig.apiBaseUrl || window.location.origin).replace(/\/$/, '')
      const formData = new FormData()
      formData.append('file', new Blob([xlsxBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }), 'workbook.xlsx')
      formData.append('charts', JSON.stringify(chartsMap))

      const res = await fetch(`${baseUrl}/api/excel/inject-charts`, {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) throw new Error(`inject-charts 后端返回 ${res.status}`)

      const blob = await res.blob()
      return await blob.arrayBuffer()
    } catch (err) {
      // 降级：嵌入 ECharts PNG 图片（保证导出不中断）
      flog.warn('Save', '原生图表注入降级为图片嵌入:', err.message)
      return _fallbackEmbedChartImages(xlsxBuffer, currentWorkbook)
    }
  }

  // ---- 降级：ECharts PNG 嵌入（仅在后端不可用时启用） ----
  async function _fallbackEmbedChartImages(xlsxBuffer, currentWorkbook) {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(xlsxBuffer)

    for (const sheetData of currentWorkbook.sheets) {
      if (!sheetData.charts?.length) continue
      const ws = wb.getWorksheet(sheetData.name)
      if (!ws) continue
      for (const chart of sheetData.charts) {
        const dataUrl = await renderChartToDataUrlAsync(chart, sheetData)
        if (!dataUrl) continue
        const base64 = dataUrl.split(',')[1]
        const imageId = wb.addImage({ base64, extension: 'png' })
        ws.addImage(imageId, {
          tl: { col: (chart.col || 1) - 1, row: (chart.row || 1) - 1 },
          ext: { width: chart.width || 600, height: chart.height || 400 }
        })
      }
    }
    return wb.xlsx.writeBuffer()
  }

  const withFreshAccessToken = useCallback(async (runner) => {
    const isAuthError = (error) => {
      if (error?.status === 401) return true
      const msg = String(error?.message || '')
      return msg.includes('401') || msg.includes('无效的认证凭据') || msg.includes('expired')
    }

    try {
      return await runner(accessToken)
    } catch (error) {
      if (!isAuthError(error) || !refreshToken) {
        throw error
      }
      const refreshed = await authApi.refreshAccessToken(refreshToken)
      const nextAccessToken = refreshed.access_token
      const nextRefreshToken = refreshed.refresh_token || refreshToken
      saveTokens(nextAccessToken, nextRefreshToken, user)
      return runner(nextAccessToken)
    }
  }, [accessToken, refreshToken, saveTokens, user])

  const selectedSidebarFileRef = useRef(selectedSidebarFile)
  selectedSidebarFileRef.current = selectedSidebarFile
  const currentFileNameRef = useRef(currentFileName)
  currentFileNameRef.current = currentFileName
  const platformViewRef = useRef(platformView)
  platformViewRef.current = platformView
  const largeFileModeRef = useRef(largeFileMode)
  largeFileModeRef.current = largeFileMode

  const handleManualSave = useCallback(async (silent = false, { force = false, targetFile = null } = {}) => {
    const file = targetFile || selectedSidebarFileRef.current
    flog.info('Save', 'START', { silent, force, hasToken: !!accessToken, fileId: file?.id, view: platformViewRef.current, largeFile: largeFileModeRef.current, status: saveStatusRef.current, univerMode: univerModeRef.current })
    if (!accessToken || !file?.id || largeFileModeRef.current) {
      flog.warn('Save', 'BLOCKED: precondition')
      return false
    }
    if (saveStatusRef.current === 'saving') { flog.warn('Save', 'BLOCKED: already saving'); return false }
    if (!force && platformViewRef.current !== 'normal') { flog.warn('Save', 'BLOCKED: view', platformViewRef.current); return false }
    try {
      if (saveResetTimerRef.current) clearTimeout(saveResetTimerRef.current)
      setSaveStatus('saving')

      let wbForSave = null
      if (univerModeRef.current) {
        flog.info('Save', 'flushing Univer...')
        wbForSave = await getFlushedWorkbookAsync()
        if (wbForSave) {
          const sheetCount = wbForSave.sheets?.length ?? 0
          const dataRows = wbForSave.sheets?.reduce((s, sh) => s + Object.keys(sh.data || {}).length, 0) ?? 0
          flog.info('Save', 'flush OK', { sheetCount, dataRows })
        } else {
          flog.error('Save', 'flush returned null')
          setSaveStatus('error')
          if (!silent) pushSystemMessage('error', '无法从表格导出最新数据，请稍候再试。')
          return false
        }
      }
      if (!wbForSave) {
        flog.warn('Save', 'no workbook data to save')
        setSaveStatus('idle')
        return false
      }
      // 若内容快照未变化，则无需再次上传，避免“自动保存已完成后手动保存”触发并发门禁误拦截
      const wbSnapshot = JSON.stringify(wbForSave)
      if (!force && wbSnapshot === lastSavedSnapshotRef.current) {
        flog.info('Save', 'SKIP upload: snapshot unchanged')
        setSaveStatus('saved')
        if (!silent) pushSystemMessage('success', '已是最新，无需重复保存')
        saveResetTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1200)
        return true
      }

      flog.info('Save', 'building xlsx buffer...')
      let buffer = await buildWorkbookXlsxBuffer(wbForSave)
      buffer = await injectNativeCharts(buffer, wbForSave)
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      })
      const filename = file.file_name || `${currentFileNameRef.current || 'workbook'}.xlsx`
      flog.info('Save', 'uploading', { fileId: file.id, filename, bytes: blob.size })
      const resp = await withFreshAccessToken((token) =>
        filesApi.saveFileContent(token, file.id, blob, filename, {
          // 内容版本只能使用 accessed_at；缺失时让后端跳过并发校验（兼容旧 schema）。
          expectedContentVersion: file.accessed_at || null,
          expectedUpdatedAt: file.updated_at || null,
        })
      )
      flog.info('Save', 'SUCCESS', resp)
      lastSavedSnapshotRef.current = wbSnapshot
      // 同步最新版本戳：accessed_at 不存在时**不再回退** updated_at，避免下次保存交叉比对触发 409
      if (resp?.updated_at || resp?.accessed_at) {
        const nextFile = {
          ...(selectedSidebarFileRef.current?.id === file.id ? selectedSidebarFileRef.current : file),
          updated_at: resp.updated_at || file.updated_at,
          accessed_at: resp.accessed_at || file.accessed_at,
          file_size: resp.file_size != null ? resp.file_size : file.file_size,
        }
        // 关键：立即更新 ref，下一次同步触发的 save 不会再读到旧 accessed_at（消除 setState 异步窗）
        if (selectedSidebarFileRef.current?.id === file.id) {
          selectedSidebarFileRef.current = nextFile
        }
        setSelectedSidebarFile(prev => (prev?.id === file.id ? nextFile : prev))
      }
      setSaveStatus('saved')
      if (!silent) pushSystemMessage('success', `已保存 (${(blob.size / 1024).toFixed(1)} KB)`)
      saveResetTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
      return true
    } catch (error) {
      flog.error('Save', 'FAILED', error)
      setSaveStatus('error')
      if (error?.status === 409) {
        flog.warn('Save', '409 详情', {
          client_content_version: error?.detail?.client_content_version,
          server_content_version: error?.detail?.server_content_version,
          server_updated_at: error?.detail?.server_updated_at,
        })
        const msg = error?.detail?.message || '文件已被其他操作更新，当前保存已被安全拦截。请先刷新文件后再保存。'
        if (!silent) pushSystemMessage('error', msg)
        return false
      }
      if (!silent) {
        pushSystemMessage('error', error?.status === 401 ? '保存失败，登录可能已过期，请重新登录。' : sanitizeErrorForUser(error.message))
      }
      return false
    }
  }, [accessToken, withFreshAccessToken, pushSystemMessage, getFlushedWorkbookAsync])

  useEffect(() => { handleManualSaveRef.current = handleManualSave }, [handleManualSave])

  const resetSkillSandboxState = useCallback(() => {
    setSkillSandboxPending(false)
    setSkillPreviewTouchedMap({})
    setSkillActionNotice('')
    skillSandboxSnapshotRef.current = ''
    skillSandboxFileIdRef.current = null
  }, [])

  const handlePersistSkillSandbox = useCallback(async () => {
    if (!skillSandboxPending) return true
    const saved = await handleManualSaveRef.current?.(false, { force: true })
    if (!saved) return false
    setSkillSandboxPending(false)
    setSkillPreviewTouchedMap({})
    setSkillActionNotice('已写回服务器文件。')
    skillSandboxSnapshotRef.current = ''
    skillSandboxFileIdRef.current = null
    pushSystemMessage('success', 'Skill 沙箱执行结果已写回服务器文件。')
    return true
  }, [skillSandboxPending])

  const handleDiscardSkillSandbox = useCallback(() => {
    if (!skillSandboxPending || !skillSandboxSnapshotRef.current) return
    try {
      const restored = JSON.parse(skillSandboxSnapshotRef.current)
      setWorkbook(restored)
      setSkillSandboxPending(false)
      setSkillPreviewTouchedMap({})
      setSkillActionNotice('已回滚本次操作。')
      skillSandboxSnapshotRef.current = ''
      skillSandboxFileIdRef.current = null
      pushSystemMessage('warning', '已放弃本次 Skill 沙箱执行结果。')
    } catch (error) {
      pushSystemMessage('error', '操作回滚失败，请稍后重试。')
    }
  }, [skillSandboxPending])

  // 切换到其他文件时，清空 skill 沙箱挂起状态，避免跨文件误写回
  useEffect(() => {
    if (!skillSandboxPending) return
    const pendingFileId = skillSandboxFileIdRef.current
    if (pendingFileId && selectedSidebarFile?.id && pendingFileId !== selectedSidebarFile.id) {
      resetSkillSandboxState()
    }
  }, [selectedSidebarFile?.id, skillSandboxPending, resetSkillSandboxState])

  const canManualSave = !!accessToken &&
    !!selectedSidebarFile?.id &&
    platformView === 'normal' &&
    !largeFileMode &&
    !isGridDataLoading &&
    !isLargeFileUploading
  const isAnalyzeReadonly = largeFileMode && platformView === 'analyze'

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      if (saveResetTimerRef.current) clearTimeout(saveResetTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!canManualSave) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      setSaveStatus('idle')
      return
    }
    const snapshot = JSON.stringify(workbook)
    if (snapshot === lastSavedSnapshotRef.current) return

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      handleManualSave(true)
    }, AUTO_SAVE_DEBOUNCE_MS)

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [workbook, canManualSave, handleManualSave])

  // ---- 未保存检测 ----
  const checkUnsavedChanges = useCallback(() => {
    if (!selectedSidebarFile?.id || largeFileMode) return false
    if (platformView !== 'normal') return false
    // 非保存场景不主动 flush，避免打断编辑态并引入格式归一化导致的误判
    const snapshot = JSON.stringify(workbook)
    return snapshot !== lastSavedSnapshotRef.current
  }, [selectedSidebarFile?.id, largeFileMode, platformView, workbook])

  // ---- 首屏空白工作簿脏检测 ----
  // 原理：空白工作簿的单元格 data 完全为空（无 v/f 字段）。
  //       只要任意单元格出现值或公式，即判定用户有过有效编辑。
  //       Univer 模式下直接调用 flushToSheetbot() 读取 Canvas 当前状态，
  //       规避 600ms 防抖时序窗口，同时完全避开"命令类型过滤"的误判陷阱。
  const checkBlankWorkbookDirty = useCallback(() => {
    if (selectedSidebarFile?.id || largeFileMode || platformView !== 'normal') return false
    const wbToCheck = univerModeRef.current
      ? (univerEditorRef.current?.flushToSheetbot?.() ?? workbook)
      : workbook
    // SheetBot 单元格格式：{ value, formula, style }，检查 value / formula 字段
    return (wbToCheck?.sheets ?? []).some((sheet) =>
      Object.values(sheet.data ?? {}).some((row) =>
        Object.values(row ?? {}).some(
          (cell) => cell?.value != null || cell?.formula != null
        )
      )
    )
  }, [selectedSidebarFile?.id, largeFileMode, platformView, workbook])

  // 规避 TDZ：视图切换回调定义早于 prepare 回调
  function prepareSelectedFileForLargeModeDeferred(...args) {
    return prepareSelectedFileForLargeMode(...args)
  }

  // ---- 带未保存守卫的视图切换 ----
  const handlePlatformViewChange = useCallback((targetView) => {
    if (targetView === platformView) return
    if (platformView === 'normal' && checkUnsavedChanges()) {
      setUnsavedConfirm({ targetView })
      return
    }
    if (platformView === 'normal' && checkBlankWorkbookDirty()) {
      setUnsavedConfirm({ type: 'newBlank', targetView })
      return
    }
    // "我要汇报"需要先将当前选中文件准备到内存态，避免切过去后仍停留空首页
    if (targetView === 'report' && selectedSidebarFile?.id && !largeFileMode) {
      prepareSelectedFileForLargeModeDeferred('report')
      return
    }
    setPlatformView(targetView)
  }, [
    platformView,
    checkUnsavedChanges,
    checkBlankWorkbookDirty,
    selectedSidebarFile?.id,
    largeFileMode,
    prepareSelectedFileForLargeModeDeferred,
  ])

  // 特殊视图切换动作的分发器（通过 ref 延迟引用，避免声明顺序问题）
  const viewSwitchActionsRef = useRef({})
  const dispatchViewSwitch = useCallback((target) => {
    if (!target) return
    const actions = viewSwitchActionsRef.current
    if (target === '_analyze_inner' && actions.analyze) {
      actions.analyze()
    } else if (target === '_report_inner' && actions.report) {
      actions.report()
    } else {
      setPlatformView(target)
    }
  }, [])

  const handleUnsavedConfirmSave = useCallback(async () => {
    const confirmState = unsavedConfirm
    setUnsavedConfirm(null)
    if (!confirmState) return

    if (confirmState.type === 'switchFile') {
      const saved = await handleManualSaveRef.current?.(false, {
        force: true,
        targetFile: confirmState.sourceFile,
      })
      if (saved) {
        await handleSidebarFileSelectRef.current?.(confirmState.nextFile, {
          ...confirmState.options,
          skipUnsavedConfirm: true,
        })
      } else {
        pushSystemMessage('error', '保存失败，请手动重试后再切换文件。')
      }
      return
    }

    // ---- 首屏空白工作簿另存为新建工作簿 ----
    if (confirmState.type === 'newBlank') {
      let wbForSave = workbook
      if (univerModeRef.current) {
        wbForSave = await getFlushedWorkbookAsync()
        if (!wbForSave) {
          pushSystemMessage('error', '无法导出表格数据，请稍后再试。')
          return
        }
      }
      try {
        let buffer = await buildWorkbookXlsxBuffer(wbForSave)
        buffer = await injectNativeCharts(buffer, wbForSave)
        const blob = new Blob(
          [buffer],
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        )
        // 命名规则：新建工作簿_YYYYMMDDHHmmss.xlsx
        const stamp = new Date().toISOString()
          .replace(/[-:T.Z]/g, '')
          .slice(0, 14)
        const filename = `新建工作簿_${stamp}.xlsx`
        const result = await withFreshAccessToken((token) =>
          filesApi.uploadFile(token, blob, null, filename)
        )
        lastSavedSnapshotRef.current = JSON.stringify(wbForSave)
        pushSystemMessage('success', `已保存为「${filename}」`)

        // 加载新文件（同时刷新侧边栏）
        await handleSidebarFileSelectRef.current?.(
          { ...result, type: 'file', name: result.file_name },
          { skipUnsavedConfirm: true, skipAutoAnalyze: true }
        )

        // 若用户原本想切换到某个侧边栏文件，则再加载那个文件
        if (confirmState.nextFile && confirmState.nextFile.id !== result.id) {
          await handleSidebarFileSelectRef.current?.(confirmState.nextFile, {
            ...confirmState.nextFileOptions,
            skipUnsavedConfirm: true,
          })
        }
      } catch (err) {
        pushSystemMessage('error', `保存失败: ${err.message}`)
        return
      }
      const target = confirmState?.targetView
      if (target) dispatchViewSwitch(target)
      return
    }

    const target = confirmState?.targetView
    if (!target) return
    const saved = await handleManualSaveRef.current?.(false, { force: true })
    if (saved) {
      dispatchViewSwitch(target)
    } else {
      pushSystemMessage('error', '保存失败，请手动重试后再切换视图。')
    }
  }, [unsavedConfirm, workbook, dispatchViewSwitch, pushSystemMessage, getFlushedWorkbookAsync, withFreshAccessToken])

  const handleUnsavedConfirmDiscard = useCallback(async () => {
    const confirmState = unsavedConfirm
    setUnsavedConfirm(null)
    if (!confirmState) return

    if (confirmState.type === 'switchFile') {
      lastSavedSnapshotRef.current = JSON.stringify(workbook)
      await handleSidebarFileSelectRef.current?.(confirmState.nextFile, {
        ...confirmState.options,
        skipUnsavedConfirm: true,
      })
      return
    }

    // 不保存：直接继续，checkBlankWorkbookDirty 依据单元格内容判断，无需额外重置
    if (confirmState.type === 'newBlank') {
      if (confirmState.nextFile) {
        await handleSidebarFileSelectRef.current?.(confirmState.nextFile, {
          ...confirmState.nextFileOptions,
          skipUnsavedConfirm: true,
        })
      }
      const target = confirmState?.targetView
      if (target) dispatchViewSwitch(target)
      return
    }

    const target = confirmState?.targetView
    if (!target) return
    lastSavedSnapshotRef.current = JSON.stringify(workbook)
    dispatchViewSwitch(target)
  }, [unsavedConfirm, workbook, dispatchViewSwitch])

  const handleUnsavedConfirmCancel = useCallback(() => {
    if (unsavedConfirm?.type === 'switchFile' || unsavedConfirm?.type === 'newBlank') {
      setPendingSidebarFileId(null)
    }
    setUnsavedConfirm(null)
  }, [unsavedConfirm])

  // ---- beforeunload：浏览器关闭/刷新时提示 ----
  useEffect(() => {
    const handler = (e) => {
      if (largeFileMode || platformView !== 'normal') return
      let isDirty = false
      if (selectedSidebarFile?.id) {
        isDirty = JSON.stringify(workbook) !== lastSavedSnapshotRef.current
      } else {
        // 空白工作簿：检查是否有实际单元格内容（SheetBot 格式用 value/formula）
        isDirty = (workbook?.sheets ?? []).some((sheet) =>
          Object.values(sheet.data ?? {}).some((row) =>
            Object.values(row ?? {}).some(
              (cell) => cell?.value != null || cell?.formula != null
            )
          )
        )
      }
      if (isDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [selectedSidebarFile?.id, largeFileMode, platformView, workbook])

  // ========== 大文件处理函数 ==========
  const getApiBaseUrl = useCallback(() => {
    const apiUrl = resolveApiBaseUrl()
    if (apiUrl) return String(apiUrl).replace(/\/$/, '')
    return window.location.origin
  }, [])

  const pushAiWarningMessage = useCallback((content) => {
    pushSystemMessage('warning', content, { revealPanel: true })
  }, [pushSystemMessage])

  const handleRenameSheet = useCallback(async (oldName, newName) => {
    const trimmed = newName?.trim()
    if (!trimmed || trimmed === oldName) return
    if (isAiProcessing) {
      pushAiWarningMessage('AI 正在处理任务，暂时无法重命名工作表，请等待任务完成后再操作。')
      return
    }
    if (trimmed.length > 31) {
      pushAiWarningMessage('工作表名称不能超过 31 个字符')
      return
    }
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      pushAiWarningMessage('工作表名称不能包含 \\ / : * ? " < > | 等字符')
      return
    }
    if (workbook.sheets.some(s => s.name === trimmed && s.name !== oldName)) {
      pushAiWarningMessage(`工作表 "${trimmed}" 已存在，请使用其他名称`)
      return
    }

    const applyRenameToState = () => {
      setWorkbook(prev => ({
        ...prev,
        sheets: prev.sheets.map(s => s.name === oldName ? { ...s, name: trimmed } : s),
      }))
      if (activeSheet === oldName) setActiveSheet(trimmed)
      // 同步更新普通模式快照，防止切回普通视图时回滚
      const snap = normalModeSnapshotRef.current
      if (snap) {
        snap.workbook = {
          ...snap.workbook,
          sheets: snap.workbook.sheets.map(s => s.name === oldName ? { ...s, name: trimmed } : s),
        }
        if (snap.activeSheet === oldName) snap.activeSheet = trimmed
      }
    }

    if (largeFileMode && largeFileInfo?.file_id) {
      try {
        const baseUrl = getApiBaseUrl()
        const res = await withFreshAccessToken(async (token) => {
          const r = await fetch(`${baseUrl}/api/large-file/${largeFileInfo.file_id}/rename-sheet`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ old_name: oldName, new_name: trimmed }),
          })
          if (!r.ok) {
            const errBody = await r.json().catch(() => ({}))
            const d = errBody?.detail
            throw new Error(typeof d === 'string' ? d : (d?.message || '重命名失败，请稍后重试。'))
          }
          return r.json()
        })
        applyRenameToState()
        if (res.sheet_names) {
          setLargeFileInfo(prev => prev ? { ...prev, sheet_names: filterAnalyzeSheetNames(res.sheet_names) } : prev)
        }
      } catch (e) {
        pushAiWarningMessage(`重命名工作表失败: ${e.message}`)
      }
      return
    }

    applyRenameToState()
    setTimeout(() => handleManualSaveRef.current?.(true, { force: true }), 500)
  }, [activeSheet, workbook.sheets, largeFileMode, largeFileInfo, getApiBaseUrl, withFreshAccessToken, pushAiWarningMessage, isAiProcessing])

  const fetchPrepareStatus = useCallback(async (userFileId) => {
    const baseUrl = getApiBaseUrl()
    return withFreshAccessToken(async (token) => {
      const res = await fetch(`${baseUrl}/api/large-file/prepare-status/${encodeURIComponent(userFileId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        const detail = errBody?.detail
        let msg
        if (typeof detail === 'object' && detail?.message) {
          msg = detail.message
        } else if (typeof detail === 'string' && detail) {
          msg = detail
        } else {
          msg = '获取准备状态失败，请稍后重试。'
        }
        const e = new Error(msg)
        e.status = res.status
        throw e
      }
      return res.json()
    })
  }, [getApiBaseUrl, withFreshAccessToken])

  // 规避 TDZ：prepare 回调定义早于 initializeAnalyzeWorkbook
  function initializeAnalyzeWorkbookDeferred(...args) {
    return initializeAnalyzeWorkbook(...args)
  }

  const prepareSelectedFileForLargeMode = useCallback(async (targetView, fileNodeOverride = null) => {
    const sourceFile = fileNodeOverride || latestSidebarIntentRef.current || selectedSidebarFile
    if (!accessToken) {
      pushSystemMessage('error', '请先登录后再使用该功能。')
      return
    }
    if (!sourceFile?.id) {
      pushSystemMessage('warning', '请先在左侧文件管理中选择一个文件，再执行此操作。')
      return
    }

    setIsLargeFileUploading(true)
    setLargeFileInfo(prev => ({
      ...(prev || {}),
      file_id: prev?.file_id || '',
      original_name: sourceFile.file_name || sourceFile.name || '',
      duckdb_ready: false,
      duckdb_load_progress: 2,
      duckdb_load_stage: '正在连接服务器...',
    }))
    // 让 React 将上面的状态渲染出来后再发起网络请求
    await new Promise(r => setTimeout(r, 0))
    try {
      const baseUrl = getApiBaseUrl()

      let status = await withFreshAccessToken(async (token) => {
        const prepareRes = await fetch(`${baseUrl}/api/large-file/prepare`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_file_id: sourceFile.id, target_view: targetView }),
        })
        if (!prepareRes.ok) {
          const errBody = await prepareRes.json().catch(() => ({}))
          const detail = errBody?.detail
          let msg
          if (typeof detail === 'object' && detail?.message) {
            msg = detail.message
          } else if (typeof detail === 'string' && detail) {
            msg = detail
          } else {
            msg = '操作失败，请稍后重试。'
          }
          const e = new Error(msg)
          e.status = prepareRes.status
          throw e
        }
        return prepareRes.json()
      })

      if (!normalModeSnapshotRef.current) {
        normalModeSnapshotRef.current = {
          workbook: JSON.parse(JSON.stringify(workbook)),
          activeSheet,
          history: [...history],
          historyIndex,
          currentFileName,
          selection: { ...selection },
        }
      }

      const buildFileInfo = (s) => ({
        file_id: s.file_id,
        original_name: s.original_name || sourceFile.file_name || sourceFile.name,
        file_size: s.file_size || 0,
        source_file_id: sourceFile.id,
        user_file_id: sourceFile.id,
        duckdb_ready: !!s.duckdb_ready,
        first_page_ready: !!s.first_page_ready,
        sheet_names: filterAnalyzeSheetNames(s.sheet_names),
        row_count: s.row_count || 0,
        col_count: s.col_count || 0,
        duckdb_load_progress: s.duckdb_load_progress ?? 0,
        duckdb_load_stage: s.duckdb_load_stage || '正在准备...',
      })

      setLargeFileMode(true)
      setPlatformView(targetView)
      setLargeFileInfo(buildFileInfo(status))
      setResultFiles(status.result_files || [])
      analyzeFormulaWorkbookRef.current = normalModeSnapshotRef.current?.workbook || null

      // 后台异步加载：轮询进度，首页就绪时提前渲染
      // firstPageRendered 仅用于控制轮询中的提前预览，不再影响最终的强制刷新
      let firstPageRendered = false
      if (!status.duckdb_ready) {
        let pollCount = 0
        const maxPollCount = 300
        while (pollCount < maxPollCount) {
          await new Promise(resolve => setTimeout(resolve, 800))
          status = await fetchPrepareStatus(sourceFile.id)
          setLargeFileInfo(prev => prev ? { ...prev, ...buildFileInfo(status) } : prev)
          pollCount += 1

          // 首页就绪 → 提前渲染第一屏，无需等待全量加载完成
          const statusSheets = filterAnalyzeSheetNames(status.sheet_names)
          if (status.first_page_ready && !firstPageRendered && status.file_id && statusSheets.length) {
            firstPageRendered = true
            initializeAnalyzeWorkbookDeferred(status.file_id, statusSheets, {
              isResultSheet: false,
              fallbackColCount: status.col_count || 26,
              activeSheet: statusSheets[0],
              normalWorkbook: analyzeFormulaWorkbookRef.current,
            })
          }

          if (status.duckdb_ready) break
        }
      }

      // 准备完成后强制刷新工作表
      // 修复：不依赖 firstPageRendered 判断——缓存命中时 duckdb_ready+first_page_ready 同时为 true，
      // 会跳过轮询循环，导致 initializeAnalyzeWorkbook 从未被调用，工作表停留在旧文件数据
      const statusSheets = filterAnalyzeSheetNames(status.sheet_names)
      if (status.file_id && statusSheets.length) {
        await initializeAnalyzeWorkbookDeferred(status.file_id, statusSheets, {
          isResultSheet: false,
          fallbackColCount: status.col_count || 26,
          activeSheet: statusSheets[0],
          normalWorkbook: analyzeFormulaWorkbookRef.current,
        })
      }

      if (!status.duckdb_ready && !status.first_page_ready) {
        pushSystemMessage('warning', '数据准备超时，请稍后重试。')
      } else if (status.duckdb_ready) {
        const targetLabel = targetView === 'reportCard'
          ? '报表'
          : targetView === 'report'
            ? '汇报'
            : '分析'
        const messageId = uuidv4()
        const messageContent = `已完成数据准备：${status.original_name || sourceFile.name}，可开始${targetLabel}。`
        pushSystemMessage('assistant', messageContent, { id: messageId, dedupe: false })
        setTimeout(() => {
          setAiMessages(prev => prev.filter(msg => msg.id !== messageId))
        }, 3000)
      }
    } catch (error) {
      flog.error('LargeFile', '准备分析文件失败:', error)
      pushSystemMessage('error', sanitizeErrorForUser(error.message))
    } finally {
      setIsLargeFileUploading(false)
    }
  }, [accessToken, selectedSidebarFile, getApiBaseUrl, fetchPrepareStatus, workbook, activeSheet, history, historyIndex, currentFileName, selection, largeFileInfo, withFreshAccessToken, pushSystemMessage])

  const enterAnalyzeViewInner = useCallback(() => {
    const targetFile = latestSidebarIntentRef.current || selectedSidebarFile
    prepareSelectedFileForLargeMode('analyze', targetFile || null)
  }, [prepareSelectedFileForLargeMode, selectedSidebarFile])

  const handleEnterAnalyzeView = useCallback(() => {
    if (platformView === 'normal' && checkUnsavedChanges()) {
      setUnsavedConfirm({ targetView: '_analyze_inner' })
      return
    }
    if (platformView === 'normal' && checkBlankWorkbookDirty()) {
      setUnsavedConfirm({ type: 'newBlank', targetView: '_analyze_inner' })
      return
    }
    enterAnalyzeViewInner()
  }, [platformView, checkUnsavedChanges, checkBlankWorkbookDirty, enterAnalyzeViewInner])

  const enterReportViewInner = useCallback(() => {
    setPlatformView('reportCard')
    if (selectedSidebarFile?.id) {
      prepareSelectedFileForLargeMode('reportCard')
    }
  }, [selectedSidebarFile?.id, prepareSelectedFileForLargeMode])

  const handleEnterReportView = useCallback(() => {
    if (platformView === 'normal' && checkUnsavedChanges()) {
      setUnsavedConfirm({ targetView: '_report_inner' })
      return
    }
    if (platformView === 'normal' && checkBlankWorkbookDirty()) {
      setUnsavedConfirm({ type: 'newBlank', targetView: '_report_inner' })
      return
    }
    enterReportViewInner()
  }, [platformView, checkUnsavedChanges, checkBlankWorkbookDirty, enterReportViewInner])

  viewSwitchActionsRef.current = { analyze: enterAnalyzeViewInner, report: enterReportViewInner }

  const handlePrepareReportFromSelectedFile = useCallback(() => {
    prepareSelectedFileForLargeMode('reportCard')
  }, [prepareSelectedFileForLargeMode])

  const handlePreparePresentationFromSelectedFile = useCallback(() => {
    prepareSelectedFileForLargeMode('report')
  }, [prepareSelectedFileForLargeMode])

  const handleNotificationNavigateToReport = useCallback(() => {
    setPlatformView('reportCard')
  }, [setPlatformView])

  const handleSwitchNormalView = useCallback(() => {
    const fileSize = Number(largeFileInfo?.file_size || 0)
    const rowCount = Number(largeFileInfo?.row_count || 0)
    const exceedsNormalThreshold = (
      fileSize >= autoAnalyzeThresholds.sizeBytes ||
      rowCount >= autoAnalyzeThresholds.rowThreshold
    )
    if (largeFileMode && largeFileInfo?.file_id && exceedsNormalThreshold) {
      const limitMb = Math.round(autoAnalyzeThresholds.sizeBytes / 1024 / 1024)
      pushSystemMessage('warning', `当前文件规模较大（${Math.round(fileSize / 1024 / 1024)}MB / ${rowCount.toLocaleString()}行），为避免普通视图卡顿已禁止切换。系统规则：当文件大小 ≥ ${limitMb}MB 或行数 ≥ ${autoAnalyzeThresholds.rowThreshold.toLocaleString()} 时，将锁定在“数据分析”视图。`, { dedupe: false })
      return
    }

    if (largeFileInfo?.file_id) {
      const baseUrl = getApiBaseUrl()
      withFreshAccessToken(async (token) => {
        await fetch(`${baseUrl}/api/large-file/clear-session`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_file_id: largeFileInfo.file_id }),
        })
      }).catch(() => {})
    }
    setPlatformView('normal')
    setLargeFileMode(false)
    setIsLargeFileUploading(false)
    setLargeFileInfo(null)
    setLargeFilePreview(null)
    setResultFiles([])
    analyzeFormulaWorkbookRef.current = null
    normalModeSnapshotRef.current = null
    // 无条件从服务器重新加载当前文件，杜绝缓存不一致
    if (selectedSidebarFile?.id) {
      setPendingNormalReload({ file: selectedSidebarFile, ts: Date.now() })
    }
  }, [largeFileMode, largeFileInfo, getApiBaseUrl, withFreshAccessToken, selectedSidebarFile, pushSystemMessage, autoAnalyzeThresholds])

  const handleRefreshAnalyzeStatus = useCallback(async () => {
    if (!selectedSidebarFile?.id) return
    try {
      const status = await fetchPrepareStatus(selectedSidebarFile.id)
      setLargeFileInfo(prev => prev ? {
        ...prev,
        duckdb_ready: !!status.duckdb_ready,
        duckdb_load_progress: status.duckdb_load_progress,
        duckdb_load_stage: status.duckdb_load_stage,
      } : prev)
      pushSystemMessage('assistant', `分析状态已刷新：${status.duckdb_load_stage || (status.duckdb_ready ? '就绪' : '准备中')}`)
    } catch (error) {
      pushSystemMessage('warning', '刷新分析状态失败，请稍后重试。')
    }
  }, [selectedSidebarFile, fetchPrepareStatus, pushSystemMessage])

  // ============================================================================
  // 大文件预览构建工具
  // ============================================================================
  const buildSheetFromPreview = (preview, options = {}) => {
    if (!preview) return null
    const sheetName = preview.sheet_name || options.sheetName || 'Sheet'
    const normalWorkbook = options.normalWorkbook
    const sourceSheet = normalWorkbook?.sheets?.find?.(s => s?.name === sheetName) || null
    const sheet = {
      name: sheetName,
      data: {},
      rowCount: (preview.preview_rows || 0) + 1,
      colCount: preview.total_cols || preview.headers?.length || 26,
      colWidths: {},
      rowHeights: {},
      isResultSheet: options.isResultSheet || false,
      resultFileId: options.resultFileId || null,
      pageOffset: Math.max(0, Number(preview.offset) || 0),
      pageLimit: Math.max(1, Number(preview.limit) || ANALYZE_PREVIEW_PAGE_SIZE),
      totalRows: Math.max(0, Number(preview.total_rows || preview.row_count) || 0),
      hasMore: !!preview.has_more,
      needsPreviewLoad: false
    }
    // 表头
    preview.headers?.forEach((header, idx) => {
      if (!sheet.data[1]) sheet.data[1] = {}
      const headerStyle = preview.styles?.[0]?.[idx] || {}
      const normalizedHeaderStyle = {
        ...headerStyle,
        horizontalAlignment: headerStyle.horizontalAlignment || headerStyle.horizontalAlign,
        verticalAlignment: headerStyle.verticalAlignment || headerStyle.verticalAlign
      }
      sheet.data[1][idx + 1] = {
        value: header,
        style: Object.keys(normalizedHeaderStyle).length > 0 ? normalizedHeaderStyle : undefined
      }
    })
    // 数据
    preview.data?.forEach((row, rowIdx) => {
      const rowNum = rowIdx + 2
      if (!sheet.data[rowNum]) sheet.data[rowNum] = {}
      row.forEach((cell, colIdx) => {
        const snapshotCell = sourceSheet?.data?.[rowNum]?.[colIdx + 1] || null
        const cellStyle = preview.styles?.[rowIdx + 1]?.[colIdx]
        const normalizedCellStyle = cellStyle ? {
          ...cellStyle,
          horizontalAlignment: cellStyle.horizontalAlignment || cellStyle.horizontalAlign,
          verticalAlignment: cellStyle.verticalAlignment || cellStyle.verticalAlign
        } : undefined
        const nextCell = {
          style: normalizedCellStyle || snapshotCell?.style
        }
        if (snapshotCell?.formula) {
          nextCell.formula = snapshotCell.formula
          if (snapshotCell.value !== undefined) nextCell.value = snapshotCell.value
        } else if (typeof cell === 'string' && cell.startsWith('=')) {
          nextCell.formula = cell
        } else {
          nextCell.value = cell
        }
        sheet.data[rowNum][colIdx + 1] = nextCell
      })
    })
    return sheet
  }

  const fetchSheetPreview = useCallback(async (fileId, sheetName, options = {}) => {
    const {
      offset = 0,
      limit = ANALYZE_PREVIEW_PAGE_SIZE
    } = options
    const baseUrl = getApiBaseUrl()
    const params = new URLSearchParams()
    if (sheetName) params.set('sheet_name', sheetName)
    params.set('offset', String(Math.max(0, Number(offset) || 0)))
    params.set('limit', String(Math.max(1, Number(limit) || ANALYZE_PREVIEW_PAGE_SIZE)))
    const url = `${baseUrl}/api/large-file/preview/${fileId}?${params.toString()}`
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new Error(`预览失败: ${response.status}`)
    }
    return response.json()
  }, [getApiBaseUrl, accessToken])

  const createSheetPlaceholder = useCallback((name, options = {}) => {
    const colCount = options.fallbackColCount || 26
    return {
      name,
      data: {},
      rowCount: DEFAULT_WORKSHEET_ROWS,
      colCount,
      colWidths: {},
      rowHeights: {},
      isResultSheet: options.isResultSheet || false,
      resultFileId: options.resultFileId || null,
      needsPreviewLoad: true
    }
  }, [])

  // 统一大文件分析表 upsert：减少重复分支，避免“占位表未被预览覆盖”
  const upsertAnalyzeSheetAndActivate = useCallback((nextSheet, options = {}) => {
    if (!nextSheet?.name) return
    const {
      forceIsResultSheet = null,
      forceResultFileId = null,
    } = options
    setWorkbook(prev => {
      const sheets = [...(prev?.sheets || [])]
      const idx = sheets.findIndex(s => s.name === nextSheet.name)
      if (idx >= 0) {
        const existing = sheets[idx]
        const isResultSheet = forceIsResultSheet != null
          ? !!forceIsResultSheet
          : !!(existing?.isResultSheet ?? nextSheet.isResultSheet)
        const resultFileId = forceResultFileId != null
          ? forceResultFileId
          : (existing?.resultFileId ?? nextSheet.resultFileId ?? null)
        sheets[idx] = {
          ...existing,
          ...nextSheet,
          isResultSheet,
          resultFileId,
        }
      } else {
        sheets.push(nextSheet)
      }
      return {
        ...prev,
        sheets,
        activeSheet: nextSheet.name,
      }
    })
    setActiveSheet(nextSheet.name)
  }, [])

  // 统一解析分析视图中的 sheet -> file_id 映射（结果表走结果文件，普通表走源文件）
  const resolveAnalyzeSheetFileId = useCallback((sheet) => {
    if (sheet?.isResultSheet) return sheet?.resultFileId || null
    return largeFileInfo?.file_id || null
  }, [largeFileInfo?.file_id])

  const loadAnalyzeSheetPage = useCallback(async (fileId, sheetName, options = {}) => {
    if (!fileId || !sheetName) return null
    const offset = Math.max(0, Number(options.offset) || 0)
    const limit = Math.max(1, Number(options.limit) || ANALYZE_PREVIEW_PAGE_SIZE)
    const preview = await fetchSheetPreview(fileId, sheetName, { offset, limit })
    const nextSheet = buildSheetFromPreview(preview, {
      sheetName,
      isResultSheet: !!options.isResultSheet,
      resultFileId: options.resultFileId || null,
      normalWorkbook: options.normalWorkbook || analyzeFormulaWorkbookRef.current || null
    })
    if (!nextSheet) return null
    nextSheet.pageOffset = preview.offset || offset
    nextSheet.pageLimit = preview.limit || limit
    nextSheet.totalRows = preview.total_rows || nextSheet.rowCount || 0
    nextSheet.hasMore = !!preview.has_more
    nextSheet.needsPreviewLoad = false
    setLargeFilePreview(preview)
    upsertAnalyzeSheetAndActivate(nextSheet)
    return nextSheet
  }, [fetchSheetPreview, upsertAnalyzeSheetAndActivate])

  const initializeAnalyzeWorkbook = useCallback(async (fileId, sheetNames, options = {}) => {
    if (!fileId || !sheetNames?.length) return
    const placeholders = sheetNames.map(name => createSheetPlaceholder(name, options))
    const initialActive = options.activeSheet || sheetNames[0]
    setWorkbook({
      sheets: placeholders,
      activeSheet: initialActive
    })
    setActiveSheet(initialActive)
    await loadAnalyzeSheetPage(fileId, initialActive, { offset: 0, limit: ANALYZE_PREVIEW_PAGE_SIZE, ...options })
  }, [createSheetPlaceholder, loadAnalyzeSheetPage])

  const loadAllSheetPreviews = useCallback(async (fileId, sheetNames, options = {}) => {
    if (!fileId || !sheetNames?.length) return []
    const previews = await Promise.all(
      sheetNames.map(async (name) => {
        try {
          const preview = await fetchSheetPreview(fileId, name, { offset: 0, limit: ANALYZE_PREVIEW_PAGE_SIZE })
          return buildSheetFromPreview(preview, {
            sheetName: name,
            isResultSheet: options.isResultSheet,
            resultFileId: options.resultFileId
          })
        } catch (error) {
          flog.warn('LargeFile', `预览失败: ${name}`, error)
          return createSheetPlaceholder(name, options)
        }
      })
    )
    return previews.filter(Boolean)
  }, [fetchSheetPreview, createSheetPlaceholder])

  // 上传进度状态
  const [uploadProgress, setUploadProgress] = useState(0)
  
  const handleLargeFileUpload = useCallback(async (file) => {
    if (!file) return
    
    // 设置当前文件名（不含扩展名）
    setCurrentFileName(file.name.replace(/\.[^/.]+$/, ''))
    
    const fileSizeMB = file.size / 1024 / 1024
    const THRESHOLD_MB = 50
    
    // 小文件提示
    if (fileSizeMB < THRESHOLD_MB) {
      const confirmContinue = window.confirm(
        `此文件大小为 ${fileSizeMB.toFixed(2)} MB，小于 ${THRESHOLD_MB} MB。\n\n` +
        `建议使用普通模式处理小文件，体验更好。\n\n` +
        `是否仍要使用大文件模式？`
      )
      if (!confirmContinue) return
    }
    
    setIsLargeFileUploading(true)
    setUploadProgress(0)
    
    // 创建一个带进度的上传消息
    const uploadMsgId = Date.now()
    setAiMessages(prev => [...prev, { 
      id: uploadMsgId,
      type: 'upload_progress',
      filename: file.name,
      progress: 0,
      content: `📤 正在上传 "${file.name}" (${fileSizeMB.toFixed(2)} MB)...` 
    }])
    
    try {
      const formData = new FormData()
      formData.append('file', file)
      
      const baseUrl = getApiBaseUrl()
      
      // 使用 XMLHttpRequest 支持上传进度
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        
        // 上传进度事件
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const percentComplete = Math.round((event.loaded / event.total) * 100)
            setUploadProgress(percentComplete)
            
            // 更新进度消息
            const loadedMB = (event.loaded / 1024 / 1024).toFixed(2)
            const totalMB = (event.total / 1024 / 1024).toFixed(2)
            setAiMessages(prev => {
              const filtered = prev.filter(m => m.id !== uploadMsgId)
              return [...filtered, { 
                id: uploadMsgId,
                type: 'upload_progress',
                filename: file.name,
                progress: percentComplete,
                content: `📤 正在上传 "${file.name}" · ${percentComplete}% (${loadedMB}/${totalMB} MB)` 
              }]
            })
          }
        })
        
        // 上传完成事件
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText)
              resolve(response)
            } catch (e) {
              reject(new Error('解析响应失败'))
            }
          } else {
            try {
              const errorData = JSON.parse(xhr.responseText)
              const detail = errorData?.detail
              const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
              const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || `上传失败: ${xhr.status}`))
              reject(new Error(msg))
            } catch (e) {
              reject(new Error(`上传失败: ${xhr.status}`))
            }
          }
        })
        
        // 上传错误事件
        xhr.addEventListener('error', () => {
          reject(new Error('网络错误，上传失败'))
        })
        
        // 上传超时事件
        xhr.addEventListener('timeout', () => {
          reject(new Error('上传超时'))
        })
        
        // 发送请求
        xhr.open('POST', `${baseUrl}/api/large-file/upload`)
        xhr.timeout = 600000 // 10分钟超时
        if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
        xhr.send(formData)
      })
      
      // 上传完成，更新消息
      setAiMessages(prev => {
        const filtered = prev.filter(m => m.id !== uploadMsgId)
        return [...filtered, { 
          type: 'assistant', 
          content: `✅ 文件上传完成！正在处理数据...` 
        }]
      })
      
      // 进入大文件模式，并切换到「我要分析」视图
      analyzeFormulaWorkbookRef.current = null
      setLargeFileMode(true)
      setPlatformView('analyze')
      // 确保 largeFileInfo 包含 duckdb 相关字段（主菜单下方绿条依赖）
      setLargeFileInfo({
        ...result,
        file_id: result.file_id,
        duckdb_ready: result.duckdb_ready || false,
        duckdb_load_progress: result.duckdb_load_progress ?? 0,
        duckdb_load_stage: result.duckdb_load_stage || '正在加载数据到内存...'
      })
      setLargeFilePreview(result.preview)
      setResultFiles([]) // 清空之前的结果文件
      
      // 添加到已上传文件列表
      setUploadedLargeFiles(prev => {
        // 避免重复添加
        const exists = prev.some(f => f.file_id === result.file_id)
        if (exists) return prev
        return [...prev, {
          file_id: result.file_id,
          original_name: result.original_name,
          file_size: result.file_size,
          row_count: result.row_count,
          sheet_names: filterAnalyzeSheetNames(result.sheet_names),
          uploaded_at: new Date().toISOString(),
        }]
      })
      
      // 更新 workbook：只预加载当前工作表第一页，其余工作表按点击懒加载（不展示系统内置表）
      const resultSheets = filterAnalyzeSheetNames(result.sheet_names)
      if (resultSheets.length) {
        const activeName = result.preview?.sheet_name || resultSheets[0]
        await initializeAnalyzeWorkbook(result.file_id, resultSheets, {
          isResultSheet: false,
          fallbackColCount: result.col_count || 26,
          activeSheet: activeName
        })
      } else if (result.preview) {
        const activeSheet = buildSheetFromPreview(result.preview, { isResultSheet: false })
        if (activeSheet) {
          setWorkbook({
            sheets: [activeSheet],
            activeSheet: activeSheet.name
          })
          setActiveSheet(activeSheet.name)
        }
      } else {
        // 预览生成失败，创建空的占位工作表
        const fallbackSheets = filterAnalyzeSheetNames(result.sheet_names).length ? filterAnalyzeSheetNames(result.sheet_names) : ['Sheet1']
        const emptySheets = fallbackSheets.map((sheetName, idx) => ({
          name: sheetName,
          data: {},
          rowCount: DEFAULT_WORKSHEET_ROWS,
          colCount: result.col_count || 26,
          colWidths: {},
          rowHeights: {}
        }))
        
        setWorkbook({
          sheets: emptySheets,
          activeSheet: emptySheets[0]?.name || 'Sheet1'
        })
        setActiveSheet(emptySheets[0]?.name || 'Sheet1')
        
        // 提示用户预览加载失败
        pushSystemMessage('warning', '⚠️ 预览加载失败，但文件已成功上传。您可以直接发送指令操作数据。')
      }
      
      // 构建每个工作表的行数信息（用于完成提示，不含系统内置表）
      const sheetInfo = resultSheets.map(name => {
        const rows = result.sheet_row_counts?.[name] || 0
        return `${name}(${rows.toLocaleString()}行)`
      }).join(', ') || ''
      
      // 检查 DuckDB 是否就绪（大文件异步加载）
      let duckdbReady = result.duckdb_ready
      if (!duckdbReady) {
        // 进度由主菜单下方绿条展示，不往 AI 助手塞加载消息
        
        // 轮询等待 DuckDB 加载完成
        const maxWaitMs = 300000 // 最多等待 5 分钟
        const pollIntervalMs = 2000 // 每 2 秒检查一次
        let actualLoadTime = null // 后端返回的实际加载耗时
        let pollCount = 0
        
        while (!duckdbReady) {
          const elapsedMs = Date.now() - Date.parse(result.uploaded_at || new Date().toISOString())
          if (elapsedMs > maxWaitMs) {
            break // 超时退出
          }
          
          // 第一次立即检查，之后每 2 秒检查一次
          if (pollCount > 0) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
          }
          pollCount++
          
          try {
            const statusRes = await fetch(`${baseUrl}/api/large-file/status/${result.file_id}`, {
              headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
            })
            if (statusRes.ok) {
              const statusData = await statusRes.json()
              duckdbReady = statusData.duckdb_ready
              
              // 更新 largeFileInfo 状态，确保 duckdb_ready 字段同步
              setLargeFileInfo(prev => prev ? {
                ...prev,
                duckdb_ready: statusData.duckdb_ready,
                duckdb_load_progress: statusData.duckdb_load_progress,
                duckdb_load_stage: statusData.duckdb_load_stage
              } : null)
              
              // 获取后端计算的实际加载耗时
              if (statusData.duckdb_load_time_seconds != null) {
                actualLoadTime = statusData.duckdb_load_time_seconds
              }
              
              // 进度由主菜单下方绿条展示，largeFileInfo 已通过 setLargeFileInfo 更新
            }
          } catch (e) {
            flog.warn('LargeFile', '轮询 DuckDB 状态失败:', e)
          }
        }
        
        if (!duckdbReady) {
          pushSystemMessage('warning', '⚠️ 数据加载超时，请刷新页面后重试。')
          return
        }
        
        // 确保 largeFileInfo 的 duckdb_ready 已更新
        setLargeFileInfo(prev => prev ? { ...prev, duckdb_ready: true } : null)
        
        // DuckDB 加载完成提示 - 使用后端返回的实际耗时
        const loadTimeDisplay = actualLoadTime != null 
          ? `${Math.round(actualLoadTime)} 秒` 
          : '已完成'
        pushSystemMessage(
          'assistant',
          `✅ 数据加载完成！(耗时 ${loadTimeDisplay})\n\n` +
            `⚠️ 前端显示前 500 行预览，所有操作将在服务器执行。\n` +
            `💡 您现在可以输入指令让 AI 处理数据，完成后点击下载获取完整文件。`
        )
      } else {
        // DuckDB 已就绪（加载很快或已缓存）
        // 确保 largeFileInfo 的 duckdb_ready 已更新
        setLargeFileInfo(prev => prev ? { ...prev, duckdb_ready: true } : null)
        
        pushSystemMessage(
          'assistant',
          `✅ 文件上传成功！\n\n` +
            `📄 文件名: ${result.original_name}\n` +
            `📊 总行数: ${result.row_count.toLocaleString()} 行\n` +
            `📋 工作表: ${sheetInfo}\n\n` +
            `⚠️ 前端显示前 500 行预览，所有操作将在服务器执行。\n` +
            `💡 您现在可以输入指令让 AI 处理数据，完成后点击下载获取完整文件。`
        )
      }
      
    } catch (error) {
      flog.error('LargeFile', '大文件上传失败:', error)
      pushSystemMessage('error', sanitizeErrorForUser(error.message) || '上传失败，请稍后重试。')
    } finally {
      setIsLargeFileUploading(false)
      setUploadProgress(0)
    }
  }, [getApiBaseUrl, initializeAnalyzeWorkbook, pushSystemMessage])

  const inferLargeFileIntentType = useCallback((rawCommand) => {
    const text = String(rawCommand || '').trim().toLowerCase()
    if (!text) return 'analysis'

    const planningHints = [
      '先给方案', '先别执行', '不要执行', '只给思路', '计划', 'plan'
    ]
    if (planningHints.some(k => text.includes(k))) {
      return 'planning'
    }

    const infoHints = [
      '文件信息', '工作表信息', '有哪些工作表', '字段', '列名', '列标题', '预览',
      'show sheets', 'sheet list', 'headers', 'columns', 'preview', 'file info'
    ]
    if (infoHints.some(k => text.includes(k))) {
      return 'info'
    }
    return 'analysis'
  }, [])

  const handleLargeFileOperation = useCallback(async (command) => {
    if (!largeFileInfo?.file_id || !command.trim()) return
    
    setIsAiProcessing(true)
    setExecutionProgress({ phase: 'thinking', opCount: 0, lastOpDesc: '' })
    pushUserMessage(command)
    
    // 创建一个临时消息 ID，用于实时更新状态
    const tempMsgId = Date.now()
    let currentAssistantMsg = ''
    
    // 辅助函数：更新预览数据到 workbook
    const updateWorkbookFromPreview = (preview) => {
      if (!preview) {
        flog.warn('LargeFile', 'updateWorkbookFromPreview: preview 为空')
        return
      }
      
      flog.info('LargeFile', 'updateWorkbookFromPreview:', {
        sheetName: preview.sheet_name,
        rows: preview.preview_rows,
        cols: preview.total_cols
      })
      
      setLargeFilePreview(preview)
      
      const updatedSheet = buildSheetFromPreview(preview, { isResultSheet: false })
      if (!updatedSheet) return
      upsertAnalyzeSheetAndActivate(updatedSheet)
    }
    
    // 处理 SSE 事件的函数
    const processSSEEvent = (eventType, data) => {
      flog.info('SSE', `处理事件: ${eventType}`)
      
      switch (eventType) {
        case 'status': {
          const statusMsg = data.message || '处理中...'
          setAiMessages(prev => {
            const filtered = prev.filter(m => m.id !== tempMsgId)
            return [...filtered, { id: tempMsgId, type: 'status', content: `⏳ ${statusMsg}` }]
          })
          break
        }
        
        case 'thinking': {
          const thinkingMsg = toCompactThinkingMessage(data.content || '思考中...')
          setAiMessages(prev => {
            const filtered = prev.filter(m => m.id !== tempMsgId)
            return [...filtered, { id: tempMsgId, type: 'thinking', content: `💭 ${thinkingMsg}` }]
          })
          break
        }
        
        case 'tool_call': {
          const toolCallMsg = getToolDisplayLabel(data.tool_name || data.message || '执行工具')
          setAiMessages(prev => {
            const filtered = prev.filter(m => m.id !== tempMsgId)
            return [...filtered, { id: tempMsgId, type: 'thinking', content: `🔧 正在执行：${toolCallMsg}` }]
          })
          break
        }
        
        case 'tool_result': {
          const resultIcon = data.success !== false ? '✅' : '❌'
          const toolName = getToolDisplayLabel(data.tool_name || '工具')
          const toolResult = data.result || '完成'
          if (data.success === false) {
            setAiMessages(prev => {
              const filtered = prev.filter(m => m.id !== tempMsgId)
              return [...filtered, { id: tempMsgId, type: 'tool_result', content: `${resultIcon} ${toolName}: ${toolResult}` }]
            })
          }
          
          // 检查是否有新生成的结果文件（后端已解析并放在 new_file 字段）
          if (data.new_file) {
            const newResultFile = {
              file_id: data.new_file.file_id,
              filename: data.new_file.filename,
              row_count: data.new_file.row_count || 0,
              col_count: data.new_file.col_count || 0,
              created_at: new Date().toISOString(),
              sheet_names: data.new_file.sheet_name ? [data.new_file.sheet_name] : []
            }
            setResultFiles(prev => {
              if (prev.length === 0) return [newResultFile]
              if (prev[0].file_id !== newResultFile.file_id) return [newResultFile]
              const existingSheets = prev[0].sheet_names || []
              const mergedSheets = newResultFile.sheet_names?.length
                ? Array.from(new Set([...existingSheets, ...filterAnalyzeSheetNames(newResultFile.sheet_names)]))
                : existingSheets
              return [{ ...prev[0], ...newResultFile, sheet_names: mergedSheets }]
            })
            flog.info('SSE', '检测到新结果文件:', newResultFile)

            if (data.new_file.sheet_name) {
              const resultFileId = data.new_file.file_id
              const sheetName = data.new_file.sheet_name
              setWorkbook(prev => {
                const existingSheets = prev?.sheets || []
                const exists = existingSheets.some(s => s.name === sheetName)
                const nextSheets = exists
                  ? existingSheets
                  : [...existingSheets, createSheetPlaceholder(sheetName, { isResultSheet: true, resultFileId })]
                return {
                  ...prev,
                  sheets: nextSheets,
                  activeSheet: sheetName
                }
              })
              setActiveSheet(sheetName)
              fetchSheetPreview(resultFileId, sheetName)
                .then(preview => {
                  const resultSheet = buildSheetFromPreview(preview, {
                    isResultSheet: true,
                    resultFileId: resultFileId,
                    headerBg: '#d4edda'
                  })
                  if (!resultSheet) return
                  upsertAnalyzeSheetAndActivate(resultSheet, {
                    forceIsResultSheet: true,
                    forceResultFileId: resultFileId
                  })
                })
                .catch(error => {
                  flog.warn('SSE', '结果工作表预览失败:', error)
                })
            }
          }
          break
        }
        
        case 'text': {
          const textContent = data.content || ''
          currentAssistantMsg += textContent
          const msgToShow = currentAssistantMsg
          setAiMessages(prev => {
            const filtered = prev.filter(m => m.id !== tempMsgId)
            return [...filtered, { id: tempMsgId, type: 'assistant', content: msgToShow }]
          })
          break
        }
        
        case 'preview': {
          flog.info('SSE', '收到 preview 事件, preview 存在:', !!data.preview)
          if (data.preview) {
            flog.info('SSE', '预览数据:', {
              rows: data.preview.preview_rows,
              hasStyles: !!data.preview.styles,
              headersCount: data.preview.headers?.length
            })
            updateWorkbookFromPreview(data.preview)
          } else {
            flog.warn('SSE', 'preview 事件中没有 preview 数据')
          }
          break
        }
        
        case 'done': {
          const doneMsg = currentAssistantMsg || data.message || '操作完成'
          setAiMessages(prev => {
            const filtered = removeTransientExecutionMessages(prev.filter(m => m.id !== tempMsgId))
            return [...filtered, { type: 'assistant', content: doneMsg }]
          })
          break
        }
        
        case 'error': {
          const errorMsg = data.message || '发生未知错误'
          setAiMessages(prev => {
            const filtered = removeTransientExecutionMessages(prev.filter(m => m.id !== tempMsgId))
            return [...filtered, { type: 'error', content: `❌ ${errorMsg}` }]
          })
          break
        }
        
        case 'warning': {
          const warningMsg = data.message || '警告'
          setAiMessages(prev => {
            const filtered = prev.filter(m => m.id !== tempMsgId)
            return [...filtered, { id: tempMsgId, type: 'warning', content: `⚠️ ${warningMsg}` }]
          })
          break
        }
        
        case 'backend_progress': {
          // 后端操作进度反馈（包含 SQL、执行时间等详细信息）
          const steps = data.steps || []
          const toolName = data.tool_name || '操作'
          const executionTime = data.execution_time_ms
          const sqlExecuted = data.sql_executed
          
          // 构建进度消息内容
          let progressContent = `📊 **${toolName}**\n`
          
          // 显示执行步骤
          if (steps.length > 0) {
            progressContent += steps.join('\n') + '\n'
          }
          
          // 显示 SQL 语句（如果有）
          if (sqlExecuted) {
            const sqlPreview = sqlExecuted.length > 300 ? sqlExecuted.slice(0, 300) + '...' : sqlExecuted
            progressContent += `\n📝 **执行的 SQL:**\n\`\`\`sql\n${sqlPreview}\n\`\`\`\n`
          }
          
          // 显示执行时间
          if (executionTime !== undefined) {
            const timeStr = executionTime < 1000 
              ? `${executionTime.toFixed(0)}ms` 
              : `${(executionTime / 1000).toFixed(2)}s`
            progressContent += `⏱️ 总耗时: ${timeStr}`
          }
          
          // 使用唯一ID避免覆盖
          const progressMsgId = `progress-${Date.now()}`
          setAiMessages(prev => {
            return [...prev, { id: progressMsgId, type: 'backend_progress', content: progressContent }]
          })
          flog.info('SSE', '后端进度:', { toolName, steps: steps.length, executionTime, sqlExecuted: !!sqlExecuted })
          break
        }
        
        default:
          flog.warn('SSE', '未知事件类型:', eventType, data)
      }
    }
    
    try {
      const baseUrl = getApiBaseUrl()
      
      // 使用流式 API
      const opHeaders = { 'Content-Type': 'application/json' }
      if (accessToken) opHeaders['Authorization'] = `Bearer ${accessToken}`
      const response = await fetch(`${baseUrl}/api/large-file/operation/stream`, {
        method: 'POST',
        headers: opHeaders,
        body: JSON.stringify({
          file_id: largeFileInfo.file_id,
          command,
          intent_type: inferLargeFileIntentType(command),
          session_id: sessionId,
          active_sheet: activeSheet,
        }),
      })
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const detail = errorData?.detail
        if (typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')) {
          throw new Error(detail.message)
        }
        const msg = typeof detail === 'string' ? detail : (detail?.message || '操作失败，请稍后重试。')
        throw new Error(msg)
      }
      
      // 读取 SSE 流
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEventType = null
      let currentDataLines = []
      
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          flog.info('SSE', '流结束')
          break
        }
        
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        
        for (const line of lines) {
          // 空行表示事件结束
          if (line === '' || line === '\r') {
            if (currentEventType && currentDataLines.length > 0) {
              const dataStr = currentDataLines.join('')
              try {
                const eventData = JSON.parse(dataStr)
                processSSEEvent(currentEventType, eventData)
              } catch (e) {
                flog.warn('SSE', 'JSON 解析失败:', dataStr.slice(0, 200), e)
              }
            }
            currentEventType = null
            currentDataLines = []
            continue
          }
          
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            currentDataLines.push(line.slice(6))
          } else if (line.startsWith('data:')) {
            currentDataLines.push(line.slice(5))
          }
        }
      }
      
    } catch (error) {
      console.error('large file operation error:', error)
      const isQuota = error.message?.includes('配额') || error.message?.includes('quota')
      const userMsg = isQuota ? error.message : '抱歉，操作执行遇到问题，请稍后重试。'
      setAiMessages(prev => {
        const filtered = prev.filter(m => m.id !== tempMsgId)
        return [...filtered, { type: 'error', content: userMsg }]
      })
    } finally {
      setIsAiProcessing(false)
      setExecutionProgress(null)
    }
  }, [largeFileInfo, sessionId, activeSheet, getApiBaseUrl, fetchSheetPreview, createSheetPlaceholder, pushUserMessage, inferLargeFileIntentType])

  const handleDownloadLargeFile = useCallback(async (fileId = null, filename = null, clearMemory = false) => {
    // 重构后：分析模式仅下载结果文件，不再下载源文件
    const resultFile = resultFiles[0]
    const targetFileId = fileId || resultFile?.file_id
    const targetFilename = filename || resultFile?.filename || '分析结果.xlsx'
    
    // 如果是下载结果文件（非源文件），默认清空会话内存
    const isResultFile = fileId && resultFiles.some(f => f.file_id === fileId)
    const shouldClearMemory = clearMemory || isResultFile
    
    if (!targetFileId) {
      pushSystemMessage('warning', '当前没有可下载的分析结果。请先在“数据分析”中生成结果工作表。')
      return
    }
    
    try {
      const baseUrl = getApiBaseUrl()
      // 如果需要清空内存，添加 clear_memory 参数
      const downloadUrl = shouldClearMemory 
        ? `${baseUrl}/api/large-file/download/${targetFileId}?clear_memory=true`
        : `${baseUrl}/api/large-file/download/${targetFileId}`
      
      // 创建隐藏的 a 标签触发下载
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = targetFilename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      
      // 显示下载消息
      const memoryMsg = shouldClearMemory ? '\n💡 会话内存已释放，可以开始新的分析任务' : ''
      pushSystemMessage('assistant', `✅ 正在下载文件: ${targetFilename}${memoryMsg}`)
      
      // 如果清空了内存，同时清空前端的结果文件列表
      if (shouldClearMemory) {
        setResultFiles([])
        // 移除所有结果工作表，只保留源数据工作表
        setWorkbook(prev => ({
          ...prev,
          sheets: prev.sheets.filter(s => !s.isResultSheet)
        }))
      }
    } catch (error) {
      console.error('下载失败:', error)
      pushSystemMessage('error', '下载失败，请稍后重试。')
    }
  }, [largeFileInfo, resultFiles, getApiBaseUrl, pushSystemMessage])

  const handleDownloadAnalyzeResults = useCallback(async () => {
    if (!largeFileMode || platformView !== 'analyze' || !largeFileInfo?.file_id) {
      pushSystemMessage('warning', '请先进入“数据分析”并选择分析文件。')
      return
    }
    try {
      const baseUrl = getApiBaseUrl()
      const saveRes = await fetch(`${baseUrl}/api/large-file/save-result/${largeFileInfo.file_id}`, {
        method: 'POST',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      })
      if (!saveRes.ok) {
        const errBody = await saveRes.json().catch(() => ({}))
        const d = errBody?.detail
        throw new Error(typeof d === 'string' ? d : (d?.message || '导出失败，请稍后重试。'))
      }
      const saved = await saveRes.json()
      const resultFileId = saved.file_id
      const resultFilename = saved.filename || `${(largeFileInfo.original_name || '分析结果').replace(/\.[^/.]+$/, '')}_分析结果.xlsx`
      const a = document.createElement('a')
      a.href = `${baseUrl}/api/large-file/download/${encodeURIComponent(resultFileId)}`
      a.download = resultFilename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)

      pushSystemMessage('assistant', `✅ 已开始下载分析结果文件（仅含结果工作表 + 分析元数据）：${resultFilename}`)
    } catch (error) {
      pushSystemMessage('warning', '下载分析结果失败，请稍后重试。')
    }
  }, [largeFileMode, platformView, largeFileInfo, getApiBaseUrl, pushSystemMessage])

  // 刷新结果文件列表
  const refreshResultFiles = useCallback(async () => {
    if (!largeFileInfo?.file_id) return
    
    try {
      const baseUrl = getApiBaseUrl()
      const response = await fetch(`${baseUrl}/api/large-file/results/${largeFileInfo.file_id}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      })
      if (response.ok) {
        const data = await response.json()
        setResultFiles(data.result_files || [])
      }
    } catch (error) {
      console.error('刷新结果文件列表失败:', error)
    }
  }, [largeFileInfo, getApiBaseUrl, accessToken])

  // 预览结果文件
  const handlePreviewResultFile = useCallback(async (fileId) => {
    if (!fileId) return
    
    try {
      const target = resultFiles.find(f => f.file_id === fileId)
      let sheetNames = target?.sheet_names
      
      if (!sheetNames || sheetNames.length === 0) {
        const preview = await fetchSheetPreview(fileId)
        sheetNames = filterAnalyzeSheetNames(preview?.sheet_names || [preview?.sheet_name].filter(Boolean))
      }
      
      const resultSheets = await loadAllSheetPreviews(fileId, sheetNames || [], {
        isResultSheet: true,
        resultFileId: fileId
      })
      
      if (resultSheets.length > 0) {
        setWorkbook(prev => {
          const existingSheets = prev?.sheets || []
          const existingNames = new Set(existingSheets.map(s => s.name))
          const merged = [
            ...existingSheets,
            ...resultSheets.filter(s => !existingNames.has(s.name))
          ]
          return {
            ...prev,
            sheets: merged,
            activeSheet: resultSheets[0].name
          }
        })
        setActiveSheet(resultSheets[0].name)
        
        pushSystemMessage('assistant', `📊 已加载结果工作表: ${resultSheets.map(s => s.name).join(', ')}`)
      }
    } catch (error) {
      console.error('预览结果文件失败:', error)
      pushSystemMessage('error', '预览失败，请稍后重试。')
    }
  }, [fetchSheetPreview, loadAllSheetPreviews, resultFiles, pushSystemMessage])

  const handleCloseResultSheet = useCallback(async (sheetName) => {
    if (!largeFileInfo?.file_id || !sheetName) return
    
    const confirmClose = window.confirm(`确定要关闭结果工作表 "${sheetName}" 吗？\n关闭后将释放内存并从结果文件中移除。`)
    if (!confirmClose) return
    
    try {
      const baseUrl = getApiBaseUrl()
      // 使用新的 close-sheet API，同时释放 DuckDB 内存和删除结果文件中的工作表
      const closeHeaders = { 'Content-Type': 'application/json' }
      if (accessToken) closeHeaders['Authorization'] = `Bearer ${accessToken}`
      const response = await fetch(
        `${baseUrl}/api/large-file/close-sheet`,
        {
          method: 'POST',
          headers: closeHeaders,
          body: JSON.stringify({
            source_file_id: largeFileInfo.file_id,
            sheet_name: sheetName
          })
        }
      )
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}))
        const d = errBody?.detail
        throw new Error(typeof d === 'string' ? d : (d?.message || '关闭失败，请稍后重试。'))
      }
      const result = await response.json()
      
      // 更新工作表列表
      const nextSheets = workbook.sheets.filter(sheet => sheet.name !== sheetName)
      const nextActive = nextSheets[0]?.name || ''
      setWorkbook(prev => ({
        ...prev,
        sheets: nextSheets,
        activeSheet: nextActive
      }))
      setActiveSheet(nextActive)
      
      // 更新结果文件列表
      if (result.result_file_deleted) {
        setResultFiles([])
      } else if (result.remaining_sheets) {
        setResultFiles(prev => prev.map(file => ({
          ...file,
          sheet_names: filterAnalyzeSheetNames(result.remaining_sheets)
        })))
      }
      
      // 显示关闭成功消息（包含内存释放信息）
      const memoryMsg = result.memory_released ? '（已释放内存）' : ''
      pushSystemMessage('assistant', `✅ 已关闭结果工作表: ${sheetName} ${memoryMsg}`)
    } catch (error) {
      console.error('关闭结果工作表失败:', error)
      pushSystemMessage('error', '关闭失败，请稍后重试。')
    }
  }, [largeFileInfo, getApiBaseUrl, workbook, pushSystemMessage])

  const handleExitLargeFileMode = useCallback(() => {
    const confirmExit = window.confirm(
      '确定要退出大文件模式吗？\n\n' +
      '⚠️ 退出后将返回普通模式，服务器上的文件仍会保留7天。\n' +
      '💡 如需保存处理结果，请先点击下载。'
    )
    if (!confirmExit) return
    
    setLargeFileMode(false)
    setPlatformView('normal')
    setLargeFileInfo(null)
    setLargeFilePreview(null)
    setResultFiles([]) // 清空结果文件列表
    
    const blankWorkbook = createBlankWorkbookState()
    setWorkbook(blankWorkbook)
    setActiveSheet(blankWorkbook.activeSheet)
    setHistory([JSON.stringify(blankWorkbook)])
    setHistoryIndex(0)
    setCurrentFileName('')
    setSelection({
      startRow: 1,
      startCol: 1,
      endRow: 1,
      endCol: 1
    })
    
    pushSystemMessage('assistant', '已退出大文件模式，返回普通模式。')
  }, [pushSystemMessage])

  // 切换到已上传的大文件
  const handleSelectLargeFile = useCallback(async (fileId) => {
    if (!fileId) return
    
    // 如果选择的是当前文件，不做操作
    if (largeFileInfo?.file_id === fileId) return
    
    setIsLargeFileUploading(true)
    setIsGridDataLoading(true)
    
    try {
      const baseUrl = getApiBaseUrl()
      
      // 获取文件状态
      const statusRes = await fetch(`${baseUrl}/api/large-file/status/${fileId}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      })
      
      if (!statusRes.ok) {
        throw new Error('文件不存在或已过期')
      }
      
      const status = await statusRes.json()
      
      // 更新状态，切换到「我要分析」视图
      setLargeFileMode(true)
      setPlatformView('analyze')
      setLargeFileInfo({
        file_id: status.file_id,
        original_name: status.original_name,
        file_size: status.file_size,
        source_file_id: status.source_file_id || null,
        user_file_id: status.user_file_id || null,
        duckdb_ready: status.duckdb_ready || false,
        sheet_names: filterAnalyzeSheetNames(status.sheet_names),
        row_count: status.row_count || 0,
        col_count: status.col_count || 0,
      })
      
      const statusSheets = filterAnalyzeSheetNames(status.sheet_names)
      if (statusSheets.length) {
        await initializeAnalyzeWorkbook(fileId, statusSheets, {
          isResultSheet: false,
          fallbackColCount: status.col_count || 26,
          activeSheet: statusSheets[0]
        })
      }

      // 追加结果文件工作表（如果存在）
      try {
        const resultsRes = await fetch(`${baseUrl}/api/large-file/results/${fileId}`, {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        })
        if (resultsRes.ok) {
          const resultsData = await resultsRes.json()
          const resultFile = resultsData.result_files?.[0]
          if (resultFile?.file_id && resultFile.sheet_names?.length) {
            const resultFileSheets = filterAnalyzeSheetNames(resultFile.sheet_names)
            const resultSheets = await loadAllSheetPreviews(resultFile.file_id, resultFileSheets, {
              isResultSheet: true,
              resultFileId: resultFile.file_id
            })
            setWorkbook(prev => ({
              ...prev,
              sheets: [...prev.sheets, ...resultSheets]
            }))
            setResultFiles((resultsData.result_files || []).map(file => ({
              ...file,
              sheet_names: filterAnalyzeSheetNames(file.sheet_names)
            })))
          }
        }
      } catch (error) {
        console.warn('加载结果工作表失败:', error)
      }
      
      // 构建每个工作表的行数信息
      const sheetInfo = filterAnalyzeSheetNames(status.sheet_names).map(name => {
        const rows = status.sheet_row_counts?.[name] || 0
        return `${name}(${rows.toLocaleString()}行)`
      }).join(', ') || ''
      
      pushSystemMessage(
        'assistant',
        `✅ 已切换到文件: ${status.original_name}\n` +
          `📊 总行数: ${status.row_count.toLocaleString()} 行\n` +
          `📋 工作表: ${sheetInfo}`
      )
      
    } catch (error) {
      console.error('切换文件失败:', error)
      pushSystemMessage('error', '切换文件失败，请稍后重试。')
      
      // 从列表中移除失效的文件
      setUploadedLargeFiles(prev => prev.filter(f => f.file_id !== fileId))
    } finally {
      setIsLargeFileUploading(false)
      setIsGridDataLoading(false)
    }
  }, [largeFileInfo, getApiBaseUrl, initializeAnalyzeWorkbook, loadAllSheetPreviews, pushSystemMessage])

  // 大文件模式下的命令发送
  const handleSendCommandWrapper = useCallback((command) => {
    if (largeFileMode) {
      handleLargeFileOperation(command)
    } else {
      handleSendCommand(command)
    }
  }, [largeFileMode, handleLargeFileOperation, handleSendCommand])

  // 大文件模式下切换工作表
  const handleSelectSheetWrapper = useCallback(async (sheetName) => {
    if (!sheetName || sheetName === ANALYZE_META_SHEET) {
      return
    }
    glideActiveSheetRef.current = sheetName
    if (!largeFileMode) {
      setActiveSheet(sheetName)
      return
    }
    // 勿在此处 setWorkbook 仅改 activeSheet：会改变 inject 签名并全量 dispose/createWorkbook，
    // 与底栏切表打架且 wantSheet 若校验过严会恒回落到第一张表。
    setActiveSheet(sheetName)
    // 分析模式：工作表按需懒加载（服务端分页）
    const targetSheet = workbook.sheets.find(s => s.name === sheetName)
    const targetFileId = resolveAnalyzeSheetFileId(targetSheet)
    if (targetFileId && (targetSheet?.needsPreviewLoad || !targetSheet?.data || Object.keys(targetSheet.data).length === 0)) {
      try {
        setIsGridDataLoading(true)
        await loadAnalyzeSheetPage(targetFileId, sheetName, {
          offset: 0,
          limit: ANALYZE_PREVIEW_PAGE_SIZE,
          isResultSheet: !!targetSheet?.isResultSheet,
          resultFileId: targetSheet?.resultFileId || null
        })
        return
      } catch (error) {
        console.warn(`加载工作表预览失败: ${sheetName}`, error)
      } finally {
        setIsGridDataLoading(false)
      }
    }
  }, [largeFileMode, workbook.sheets, loadAnalyzeSheetPage, resolveAnalyzeSheetFileId])

  // 保护：如果 activeSheet 意外落在系统元数据表，自动切回首个可见表
  useEffect(() => {
    if (activeSheet !== ANALYZE_META_SHEET) return
    const fallback = workbook.sheets.find(s => s?.name && s.name !== ANALYZE_META_SHEET)?.name
    if (fallback) setActiveSheet(fallback)
  }, [activeSheet, workbook.sheets])

  const analyzeActiveSheet = useMemo(() => {
    if (platformView !== 'analyze' || !largeFileMode) return null
    return workbook.sheets.find(s => s.name === activeSheet) || null
  }, [platformView, largeFileMode, workbook.sheets, activeSheet])

  const analyzePageInfo = useMemo(() => {
    if (!analyzeActiveSheet) return null
    const previewForActiveSheet = (largeFilePreview && largeFilePreview.sheet_name === analyzeActiveSheet.name)
      ? largeFilePreview
      : null

    const sheetPageLimit = Number(analyzeActiveSheet.pageLimit)
    const previewPageLimit = Number(previewForActiveSheet?.limit)
    const pageLimit = Math.max(
      1,
      Number.isFinite(sheetPageLimit) && sheetPageLimit > 0
        ? sheetPageLimit
        : (Number.isFinite(previewPageLimit) && previewPageLimit > 0 ? previewPageLimit : ANALYZE_PREVIEW_PAGE_SIZE)
    )

    const sheetPageOffset = Number(analyzeActiveSheet.pageOffset)
    const previewPageOffset = Number(previewForActiveSheet?.offset)
    const pageOffset = Math.max(
      0,
      Number.isFinite(sheetPageOffset) && sheetPageOffset >= 0
        ? sheetPageOffset
        : (Number.isFinite(previewPageOffset) && previewPageOffset >= 0 ? previewPageOffset : 0)
    )

    const sheetTotalRows = Number(analyzeActiveSheet.totalRows)
    const previewTotalRows = Number(previewForActiveSheet?.total_rows ?? previewForActiveSheet?.row_count)
    const totalRows = Math.max(
      0,
      Number.isFinite(sheetTotalRows) && sheetTotalRows > 0
        ? sheetTotalRows
        : (Number.isFinite(previewTotalRows) && previewTotalRows > 0 ? previewTotalRows : 0)
    )
    const currentPage = Math.floor(pageOffset / pageLimit) + 1
    const totalPages = Math.max(1, Math.ceil(totalRows / pageLimit))
    const computedHasMore = totalRows > 0 ? (pageOffset + pageLimit < totalRows) : false
    const previewHasMore = previewForActiveSheet ? !!previewForActiveSheet.has_more : false
    return {
      pageLimit,
      pageOffset,
      totalRows,
      currentPage,
      totalPages,
      // 双通道兜底：sheet 元数据 + 最新 preview，避免“按钮常灰”
      hasMore: computedHasMore || !!analyzeActiveSheet.hasMore || previewHasMore
    }
  }, [analyzeActiveSheet, largeFilePreview])

  const handleAnalyzePageChange = useCallback(async (direction) => {
    if (!analyzeActiveSheet || !largeFileMode || platformView !== 'analyze') return
    const step = Number(direction)
    if (!Number.isFinite(step) || step === 0) return
    const pageLimit = Math.max(1, Number(analyzeActiveSheet.pageLimit) || ANALYZE_PREVIEW_PAGE_SIZE)
    const currentOffset = Math.max(0, Number(analyzeActiveSheet.pageOffset) || 0)
    const targetOffset = Math.max(0, currentOffset + step * pageLimit)
    if (targetOffset === currentOffset) return

    const targetFileId = resolveAnalyzeSheetFileId(analyzeActiveSheet)
    if (!targetFileId) return

    try {
      setIsGridDataLoading(true)
      await loadAnalyzeSheetPage(targetFileId, analyzeActiveSheet.name, {
        offset: targetOffset,
        limit: pageLimit,
        isResultSheet: !!analyzeActiveSheet.isResultSheet,
        resultFileId: analyzeActiveSheet.resultFileId || null
      })
    } catch (error) {
      pushSystemMessage('warning', '数据加载失败，请稍后重试。')
    } finally {
      setIsGridDataLoading(false)
    }
  }, [analyzeActiveSheet, largeFileMode, platformView, loadAnalyzeSheetPage, pushSystemMessage, resolveAnalyzeSheetFileId])

  const handleOpenAnalyzeSqlBuilder = useCallback(() => {
    if (!(largeFileMode && platformView === 'analyze')) {
      pushSystemMessage('warning', '请先进入“数据分析”模式后再使用 SQL 查询。')
      return
    }
    setAiPanelOpen(true)
    setOpenSqlBuilderSignal(prev => prev + 1)
  }, [largeFileMode, platformView, pushSystemMessage])

  const loadWorkbookFromSidebar = useWorkbookLoader({
    accessToken,
    isLargeFileUploading,
    isGridDataLoading,
    withFreshAccessToken,
    prepareSelectedFileForLargeMode,
    getWorkbookMaxRowCount,
    largeFileAutoAnalyzeSizeBytes: autoAnalyzeThresholds.sizeBytes,
    largeFileAutoAnalyzeRowThreshold: autoAnalyzeThresholds.rowThreshold,
    setIsGridDataLoading,
    pushSystemMessage,
    setSelectedSidebarFile,
    setWorkbook,
    setActiveSheet,
    setCurrentFileName,
    setHistory,
    setHistoryIndex,
    setSaveStatus,
    setPlatformView,
    setLargeFileMode,
    setLargeFileInfo,
    setLargeFilePreview,
    setResultFiles,
    normalModeSnapshotRef,
    lastSavedSnapshotRef,
    largeFileMode,
    largeFileInfo,
    onChartsDegraded: requestChartRegenAfterImport,
  })
  loadWorkbookFromSidebarRef.current = loadWorkbookFromSidebar

  // 从 analyze 切回 normal 且快照失效时，等状态就绪后重新加载文件
  useEffect(() => {
    if (!pendingNormalReload) return
    setPendingNormalReload(null)
    loadWorkbookFromSidebar(pendingNormalReload.file, {
      preservePlatformView: false,
      skipAutoAnalyze: true,
    })
  }, [pendingNormalReload, loadWorkbookFromSidebar])

  const handleSidebarFileSelect = useCallback(async (fileNode, options = {}) => {
    if (fileNode?.id) {
      latestSidebarIntentRef.current = fileNode
      setPendingSidebarFileId(fileNode.id)
    }
    // 正在加载/上传时，把最近一次点击排队，待空闲后再执行，避免“点击了但仍停留旧工作簿”。
    if (isGridDataLoading || isLargeFileUploading) {
      return
    }
    const nextFileId = fileNode?.id
    const currentFileId = selectedSidebarFile?.id
    const isSwitchingToAnotherFile = !!nextFileId && !!currentFileId && nextFileId !== currentFileId

    if (!largeFileMode && platformView === 'normal' && !options.skipUnsavedConfirm) {
      if (isSwitchingToAnotherFile && checkUnsavedChanges()) {
        setUnsavedConfirm({
          type: 'switchFile',
          sourceFile: selectedSidebarFile,
          nextFile: fileNode,
          options: {
            preservePlatformView: options.preservePlatformView,
            skipAutoAnalyze: options.skipAutoAnalyze,
            silentBusy: options.silentBusy,
            skipPrepare: options.skipPrepare,
          },
        })
        return
      }
      // 首屏空白工作簿有编辑内容时，点击文件也需要提示保存
      if (!currentFileId && nextFileId && checkBlankWorkbookDirty()) {
        setUnsavedConfirm({
          type: 'newBlank',
          targetView: null,
          nextFile: fileNode,
          nextFileOptions: {
            preservePlatformView: options.preservePlatformView,
            skipAutoAnalyze: options.skipAutoAnalyze,
            silentBusy: options.silentBusy,
            skipPrepare: options.skipPrepare,
          },
        })
        return
      }
    }

    const keepViewByDefault = ['analyze', 'report', 'reportCard', 'collect', 'connect', 'skill', 'batchWord'].includes(platformView)

    // 在"我要报表"/"我要汇报"视图选择文件，直接触发 DuckDB 准备，进入操作模式
    if ((platformView === 'reportCard' || platformView === 'report') && !options.skipPrepare) {
      const targetView = platformView === 'reportCard' ? 'reportCard' : 'report'
      setSelectedSidebarFile(fileNode)
      try {
        await prepareSelectedFileForLargeMode(targetView, fileNode)
      } finally {
        setPendingSidebarFileId(null)
      }
      return
    }

    try {
      // 标记：普通模式下，首次打开文件或切换文件后，接收 Univer 首次归一化回写作为“已保存基线”
      // 修复：首个打开文件时 currentFileId 为空，不走 isSwitching 分支，导致首次切换出现误报“未保存”
      if (platformView === 'normal' && nextFileId && (isSwitchingToAnotherFile || !currentFileId)) {
        pendingUniverBaselineFileIdRef.current = nextFileId
      }
      return await loadWorkbookFromSidebar(fileNode, {
        preservePlatformView: keepViewByDefault,
        ...options,
      })
    } finally {
      setPendingSidebarFileId(null)
    }
  }, [
    selectedSidebarFile?.id,
    selectedSidebarFile,
    largeFileMode,
    platformView,
    isGridDataLoading,
    isLargeFileUploading,
    checkUnsavedChanges,
    checkBlankWorkbookDirty,
    setUnsavedConfirm,
    loadWorkbookFromSidebar,
    prepareSelectedFileForLargeMode,
  ])

  handleSidebarFileSelectRef.current = handleSidebarFileSelect

  const buildPreferredWorkbookFilename = useCallback((preferredName = '') => {
    const isoStamp = new Date().toISOString()
    const stamp = isoStamp
      .replaceAll('-', '')
      .replaceAll(':', '')
      .replaceAll('.', '')
      .replace('T', '')
      .replace('Z', '')
      .slice(0, 14)
    const safeName = String(preferredName || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '')
      .slice(0, 31)
    return safeName ? `${safeName}.xlsx` : `一键生表_${stamp}.xlsx`
  }, [])

  const createAndSelectWorkbookFile = useCallback(async (preferredName = '') => {
    const ExcelJS = await import('exceljs')
    const excelWb = new ExcelJS.Workbook()
    excelWb.addWorksheet('Sheet1')

    const buffer = await excelWb.xlsx.writeBuffer()
    const filename = buildPreferredWorkbookFilename(preferredName)
    const workbookBlob = new Blob(
      [buffer],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    )

    const result = await filesApi.uploadFile(accessToken, workbookBlob, null, filename)
    await handleSidebarFileSelect({ ...result, type: 'file', name: result.file_name }, {
      preservePlatformView: true,
      skipAutoAnalyze: true,
    })
    return result.file_name || filename
  }, [accessToken, buildPreferredWorkbookFilename, handleSidebarFileSelect])

  const ensureActiveWorkbookFile = useCallback(async (preferredName = '', reason = '执行指令') => {
    if (selectedSidebarFile?.id) return true
    if (!accessToken) {
      pushAiWarningMessage('请先登录后再执行该操作。')
      return false
    }
    if (largeFileMode || isLargeFileUploading || isGridDataLoading) {
      pushAiWarningMessage('当前文件处理中，请稍后再试。')
      return false
    }

    try {
      const finalName = await createAndSelectWorkbookFile(preferredName)
      pushSystemMessage('assistant', `已自动创建工作簿“${finalName}”，开始${reason}。`)
      return true
    } catch (error) {
      pushAiWarningMessage('自动创建工作簿失败，请稍后重试。')
      return false
    }
  }, [
    accessToken,
    selectedSidebarFile?.id,
    largeFileMode,
    isLargeFileUploading,
    isGridDataLoading,
    createAndSelectWorkbookFile,
    pushAiWarningMessage,
    pushSystemMessage,
  ])

  const handleEnsureWorkbookForOneClickSheet = useCallback((preferredName = '') => {
    return ensureActiveWorkbookFile(preferredName, '执行指令')
  }, [ensureActiveWorkbookFile])

  const handleCollectWorkbookSynced = useCallback(async () => {
    if (!selectedSidebarFile?.id) return
    await handleSidebarFileSelect(selectedSidebarFile, {
      preservePlatformView: true,
      skipAutoAnalyze: true,
      silentBusy: true,
    })
  }, [selectedSidebarFile, handleSidebarFileSelect])

  const handleViewQuickStart = useCallback(() => {
    pushAiWarningMessage('请先在左侧文件树选择需要操作的文件')
  }, [pushAiWarningMessage])

  const handleClearBackendMessages = useCallback(() => {
    setAiMessages([])
  }, [])

  const handleSidebarFileDeleted = useCallback((fileNode) => {
    if (!fileNode?.id) return
    const deletedFileId = fileNode.id
    const isActiveFile = selectedSidebarFile?.id === deletedFileId
    if (!isActiveFile) return

    const blankWorkbook = createBlankWorkbookState()
    setWorkbook(blankWorkbook)
    setActiveSheet(blankWorkbook.activeSheet)
    setHistory([JSON.stringify(blankWorkbook)])
    setHistoryIndex(0)
    setCurrentFileName('')
    setSelectedSidebarFile(null)
    setPendingSidebarFileId(null)
    setLargeFileMode(false)
    setLargeFileInfo(null)
    setLargeFilePreview(null)
    setResultFiles([])
    normalModeSnapshotRef.current = null
    setPlatformView('normal')
    setSelection({
      startRow: 1,
      startCol: 1,
      endRow: 1,
      endCol: 1
    })
    pushSystemMessage('assistant', `当前活动文件“${fileNode.name || fileNode.file_name || ''}”已删除，工作区已清空。`)
  }, [selectedSidebarFile, pushSystemMessage])

  // 切换视图时重置AI助手窗口
  const prevPlatformViewRef = useRef(null)
  useEffect(() => {
    // 如果视图发生变化（排除首次渲染），清空AI助手消息
    if (prevPlatformViewRef.current !== null && prevPlatformViewRef.current !== platformView) {
      setAiMessages([])
      // 同时重置AI助手相关的其他状态
      setIsAiProcessing(false)
      setExecutionProgress(null)
      readyMessageShownRef.current = false
    }
    prevPlatformViewRef.current = platformView
  }, [platformView])

  // 批量转Word视图不涉及 AI 助手交互：进入时自动关闭
  // 其余视图不强制自动打开，尊重用户手动关闭状态
  useEffect(() => {
    if (platformView === 'batchWord') {
      if (aiPanelOpen) {
        setAiPanelOpen(false)
      }
      return
    }
  }, [platformView, aiPanelOpen])

  // 开发环境：暴露 workbook 到 window 用于调试
  useEffect(() => {
    // 始终暴露调试 API（不依赖 NODE_ENV，方便调试）
    window.__EXCEL_WORKBOOK__ = workbook
    workbookLatestRef.current = workbook
    window.__EXCEL_DEBUG__ = {
      getCellStyle: (sheetName, row, col) => {
        const sheet = workbook.sheets.find(s => s.name === sheetName)
        return sheet?.data?.[row]?.[col]?.style
      },
      getFirstRowStyles: (sheetName) => {
        const sheet = workbook.sheets.find(s => s.name === sheetName)
        const styles = {}
        for (let col = 1; col <= 6; col++) {
          styles[col] = sheet?.data?.[1]?.[col]?.style
        }
        return styles
      },
        checkFirstRow: (sheetName) => {
          // 优先使用传入的 sheetName，否则尝试 '销售数据' 或 'Sheet1'
          const targetSheetName = sheetName || '销售数据'
          const sheet = workbook.sheets.find(s => 
            s.name === targetSheetName || 
            s.name === '销售数据' || 
            s.name === 'Sheet1'
          )
          if (!sheet) {
            console.log('❌ 找不到工作表')
            console.log('可用工作表:', workbook.sheets.map(s => s.name))
            return null
          }
          console.log(`✅ 找到工作表: ${sheet.name}`)
          const result = {}
          for (let col = 1; col <= 6; col++) {
            const cell = sheet.data?.[1]?.[col]
            result[`列${col}`] = {
              value: cell?.value,
              style: cell?.style,
              hasStyle: !!cell?.style,
              backgroundColor: cell?.style?.backgroundColor,
              fontColor: cell?.style?.fontColor,
              bold: cell?.style?.bold,
              styleKeys: cell?.style ? Object.keys(cell?.style) : []
            }
          }
          console.table(result)
          return result
        },
      getSheet: (sheetName) => {
        return workbook.sheets.find(s => s.name === sheetName)
      },
      listSheets: () => {
        return workbook.sheets.map(s => s.name)
      }
    }
  }, [workbook])

  return (
    <div
      className={`app-layout${isMobileViewport ? ' is-mobile-viewport' : ''}${mobileSidebarOpen ? ' mobile-sidebar-open' : ''}`}
      {...mobileGestureHandlers}
    >
      {isMobileViewport && (
        <>
          <button
            type="button"
            className={`mobile-sidebar-toggle${mobileSidebarOpen ? ' open' : ''}`}
            onClick={() => setMobileSidebarOpen((prev) => !prev)}
            aria-label={mobileSidebarOpen ? '关闭侧边栏' : '打开侧边栏'}
            aria-expanded={mobileSidebarOpen}
            aria-controls="sheetbot-left-sidebar"
          >
            {mobileSidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          {mobileSidebarOpen && (
            <button
              type="button"
              className="mobile-sidebar-backdrop"
              onClick={() => setMobileSidebarOpen(false)}
              aria-label="关闭侧边栏遮罩"
            />
          )}
        </>
      )}
      {/* ===== 左侧导航栏 ===== */}
      <Sidebar
        sheets={workbook.sheets}
        activeSheet={activeSheet}
        onSheetSelect={handleSelectSheetWrapper}
        onAddSheet={handleAddSheet}
        onDeleteSheet={handleDeleteSheet}
        onRenameSheet={handleRenameSheet}
        onCloseResultSheet={handleCloseResultSheet}
        largeFileMode={largeFileMode}
        largeFileInfo={largeFileInfo}
        currentFileName={currentFileName}
        onOpen={handleOpen}
        onOpenHelp={handleOpenHelp}
        collapsed={effectiveSidebarCollapsed}
        onToggleCollapse={() => {
          if (isMobileViewport) return
          setSidebarCollapsed(prev => !prev)
        }}
        onFileSelect={(fileNode) => {
          handleSidebarFileSelect(fileNode)
          if (isMobileViewport) {
            setMobileSidebarOpen(false)
          }
        }}
        onFileDeleted={handleSidebarFileDeleted}
        selectedFileId={selectedSidebarFile?.id || null}
        pendingFileId={pendingSidebarFileId}
        onNotificationNavigateToReport={handleNotificationNavigateToReport}
        fileSelectionLocked={isLargeFileUploading || isGridDataLoading}
        onOpenSkillManager={() => setPlatformView('skill')}
        platformView={platformView}
        mobileOpen={mobileSidebarOpen}
        isMobileViewport={isMobileViewport}
      />

      {/* ===== 主内容区 ===== */}
      <div className="main-content">
        {/* 系统公告横幅 */}
        <AnnouncementOverlay />
        {/* 顶部头部栏 */}
        <Header
          embedUniverRibbon={!largeFileMode && platformView === 'normal'}
          onOpenUniverMoreFunctions={() => univerEditorRef.current?.openUniverMoreFunctions?.()}
          onInsertUniverFunction={(name) => univerEditorRef.current?.insertUniverFunction?.(name)}
          activeSheet={activeSheet}
          onInsertRow={() => handleInsertRow(selection.startRow, 'before')}
          onFilter={() => {
            if (univerModeRef.current && univerEditorRef.current?.toggleAutoFilter) {
              univerEditorRef.current.toggleAutoFilter()
            } else {
              setFilterOpen(true)
            }
          }}
          onSort={handleSort}
          onSortCurrentAsc={() => {
            if (univerModeRef.current && univerEditorRef.current?.sortRangeAsc) {
              univerEditorRef.current.sortRangeAsc()
            } else {
              handleSort('asc')
            }
          }}
          onSortExtAsc={() => {
            if (univerModeRef.current && univerEditorRef.current?.sortRangeAscExt) {
              univerEditorRef.current.sortRangeAscExt()
            } else {
              handleSort('asc')
            }
          }}
          onSortCurrentDesc={() => {
            if (univerModeRef.current && univerEditorRef.current?.sortRangeDesc) {
              univerEditorRef.current.sortRangeDesc()
            } else {
              handleSort('desc')
            }
          }}
          onSortExtDesc={() => {
            if (univerModeRef.current && univerEditorRef.current?.sortRangeDescExt) {
              univerEditorRef.current.sortRangeDescExt()
            } else {
              handleSort('desc')
            }
          }}
          onSortCustom={() => {
            if (univerModeRef.current && univerEditorRef.current?.sortRangeCustom) {
              univerEditorRef.current.sortRangeCustom()
            }
          }}
          onSetRowHeight={handleSetSelectedRowsHeight}
          onFindReplace={() => setFindReplaceOpen(true)}
          onOpenFormulaManager={() => setFormulaManagerOpen(true)}
          onInsertChart={() => setChartInsertOpen(true)}
          onToggleAI={() => {
            if (platformView === 'batchWord') return
            setAiPanelOpen(!aiPanelOpen)
          }}
          aiPanelOpen={aiPanelOpen}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={historyIndex > 0}
          canRedo={historyIndex < history.length - 1}
          onCut={handleCut}
          onCopy={handleCopy}
          onPaste={handlePaste}
          canPaste={canPaste}
          formatBrushActive={formatBrushActive}
          onFormatBrush={handleFormatBrush}
          onSave={handleSave}
          onAnalyzeDownload={handleDownloadAnalyzeResults}
          onFormatChange={handleFormatChange}
          largeFileMode={largeFileMode}
          largeFileInfo={largeFileInfo}
          isLargeFileUploading={isLargeFileUploading}
          onManualSave={() => handleManualSave(false)}
          canManualSave={canManualSave}
          saveStatus={saveStatus}
          onRefreshAnalyzeStatus={handleRefreshAnalyzeStatus}
          onOpenAnalyzeSqlBuilder={handleOpenAnalyzeSqlBuilder}
          onSwitchNormalView={handleSwitchNormalView}
          onEnterAnalyzeView={handleEnterAnalyzeView}
          onEnterReportView={handleEnterReportView}
          isConnected={isConnected}
          platformView={platformView}
          onPlatformViewChange={handlePlatformViewChange}
          analyzeFileId={largeFileInfo?.file_id}
          apiBaseUrl={getApiBaseUrl()}
          accessToken={accessToken}
          onSessionCleared={() => setResultFiles([])}
          onAnalyzePrevPage={() => handleAnalyzePageChange(-1)}
          onAnalyzeNextPage={() => handleAnalyzePageChange(1)}
          canAnalyzePrevPage={!!analyzePageInfo && analyzePageInfo.pageOffset > 0}
          canAnalyzeNextPage={!!analyzePageInfo && analyzePageInfo.hasMore}
          analyzePageLabel={analyzePageInfo
            ? `第 ${analyzePageInfo.currentPage}/${analyzePageInfo.totalPages} 页 · ${analyzePageInfo.totalRows.toLocaleString()} 行`
            : '第 1/1 页'}
          sheetZoom={sheetZoom}
          onSheetZoomChange={(next) => {
            const v = Number(next)
            if (!Number.isFinite(v)) return
            setSheetZoom(Math.max(0.6, Math.min(2.0, v)))
          }}
        />

        {/* 进度条已合并到 HeaderTopRow 绿色线上，此处不再独立渲染 */}

        {/* 内容区域：公式栏 + Excel + AI助手 或 视图占位。 */}
        <div className="content-area">
          {platformView === 'reportCard' ? (
            <div className="content-excel-panel content-placeholder-panel">
              <ReportView
                fileId={largeFileMode ? (largeFileInfo?.user_file_id || largeFileInfo?.source_file_id || null) : null}
                largeFileInfo={largeFileInfo}
                isPreparing={isLargeFileUploading}
                onClose={() => setPlatformView('normal')}
                onPrepareFromSelectedFile={selectedSidebarFile?.id ? handlePrepareReportFromSelectedFile : null}
                pushSystemMessage={pushSystemMessage}
                onQuickStart={handleViewQuickStart}
              />
            </div>
          ) : platformView === 'batchWord' ? (
            <div className="content-excel-panel content-placeholder-panel">
              <BatchWordView
                workbook={workbook}
                activeSheet={activeSheet}
                onClose={() => setPlatformView('normal')}
                selectedSidebarFile={selectedSidebarFile}
                onSelectSidebarFile={handleSidebarFileSelect}
                pushSystemMessage={pushSystemMessage}
              />
            </div>
          ) : platformView === 'report' ? (
            <div className="content-excel-panel">
              <PresentationView
                fileId={largeFileMode ? (largeFileInfo?.file_id || null) : null}
                largeFileInfo={largeFileInfo}
                isPreparing={isLargeFileUploading}
                onClose={() => setPlatformView('normal')}
                onPrepareFromSelectedFile={selectedSidebarFile?.id ? handlePreparePresentationFromSelectedFile : null}
                setAiMessages={setAiMessages}
                pushSystemMessage={pushSystemMessage}
                onQuickStart={handleViewQuickStart}
              />
            </div>
          ) : platformView === 'collect' ? (
            <div className="content-excel-panel">
              <CollectView
                workbook={workbook}
                activeSheet={activeSheet}
                fileId={selectedSidebarFile?.id}
                currentFileName={currentFileName}
                onWorkbookSynced={handleCollectWorkbookSynced}
                onQuickStart={handleViewQuickStart}
                onAiHint={pushAiWarningMessage}
                pushSystemMessage={pushSystemMessage}
              />
            </div>
          ) : platformView === 'connect' ? (
            <div className="content-excel-panel">
              <ConnectView
                workbook={workbook}
                activeSheet={activeSheet}
                fileId={selectedSidebarFile?.id}
                currentFileName={currentFileName}
                onQuickStart={handleViewQuickStart}
                onAiHint={pushAiWarningMessage}
                pushSystemMessage={pushSystemMessage}
              />
            </div>
          ) : platformView === 'skill' ? (
            <div className="content-excel-panel">
              <SkillManagerPage
                onBack={() => setPlatformView('normal')}
                accessToken={accessToken}
                workbook={workbook}
                activeSheet={activeSheet}
                selectedSidebarFile={selectedSidebarFile}
                currentFileName={currentFileName}
                skillSandboxPending={skillSandboxPending}
                skillActionNotice={skillActionNotice}
                skillPreviewRefreshToken={skillPreviewRefreshToken}
                skillPreviewTouchedMap={skillPreviewTouchedMap}
                onPersistSkillSandbox={handlePersistSkillSandbox}
                onDiscardSkillSandbox={handleDiscardSkillSandbox}
                onRunSkill={(skill) => {
                  try {
                    if (!skillSandboxPending) {
                      skillSandboxSnapshotRef.current = JSON.stringify(workbook)
                      skillSandboxFileIdRef.current = selectedSidebarFile?.id || null
                    }
                    let baseWb = workbook
                    if (univerModeRef.current && univerEditorRef.current?.flushToSheetbot) {
                      const flushed = univerEditorRef.current.flushToSheetbot()
                      if (flushed) baseWb = flushed
                    }
                    const updated = executeSkill(skill, baseWb, (wb, op) => executeOperation(wb, op))
                    // 强制产生新引用，确保 Skill 预览窗口总能实时刷新
                    setWorkbook(JSON.parse(JSON.stringify(updated)))
                    setSkillPreviewRefreshToken(v => v + 1)
                    const diffMap = getWorkbookCellDiffMap(baseWb, updated)
                    setSkillPreviewTouchedMap(diffMap)
                    const changed = Object.keys(diffMap).length > 0
                    setSkillSandboxPending(changed)
                    const stepTypes = new Set((skill?.steps || []).map(s => s?.operation_type))
                    let actionMsg = `已执行 ${skill?.steps?.length || 0} 个步骤。`
                    if (stepTypes.has('validate_list')) {
                      actionMsg = '已设置下拉验证。预览区显示 DV 标记，交互下拉请在普通视图使用。'
                    } else if (stepTypes.has('filter_data')) {
                      actionMsg = '已应用筛选，预览区已隐藏不匹配行。'
                    } else if (stepTypes.has('query_unique')) {
                      actionMsg = '已统计值次数并输出到目标位置。'
                    }
                    setSkillActionNotice(changed ? actionMsg : '执行完成：未检测到可视变化，请检查参数与目标位置。')
                    if (!changed) {
                      pushSystemMessage('warning', 'Skill 已执行但未检测到单元格值变化（若执行的是样式类操作，预览表格可能不显示明显变化）。')
                    }
                  } catch (e) {
                    console.error('[Skill] 执行失败:', e)
                  }
                }}
              />
            </div>
          ) : platformView === 'share' ? (
            <div className="content-excel-panel content-placeholder-panel">
              <ViewPlaceholder viewKey={platformView} />
            </div>
          ) : platformView === 'analyze' && !largeFileMode ? (
            /* 我要分析：等待上传文件 */
            <div className="content-excel-panel content-placeholder-panel">
              <div className="view-placeholder">
                <div className="view-placeholder-card">
                  <div className="view-placeholder-icon">
                    <BarChart2 size={48} />
                  </div>
                  <h2 className="view-placeholder-title">数据分析</h2>
                  <p className="view-placeholder-desc">
                    专注大文件的高价值分析，后端转成内存数据库，与 AI 联动，增强企业级数据分析能力。
                  </p>
                  <p className="view-placeholder-desc" style={{ marginTop: 12, color: 'var(--accent-primary)' }}>
                    请先在左侧文件树选择文件，然后点击顶部「数据分析」开始加载到 DuckDB。
                  </p>
                </div>
              </div>
            </div>
          ) : (
          /* Excel 面板 */
          <div className="content-excel-panel">
            {/* 公式栏（Univer 自带公式栏时隐藏 SheetBot 顶栏，避免双栏） */}
            {largeFileMode && platformView !== 'analyze' && (
            <div className="content-formula-bar">
              <span className="formula-label">fx</span>
              <input
                type="text"
                className="formula-input"
                value={formulaBarValue}
                onChange={(e) => setFormulaBarValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const targetRow = editingCell?.row ?? selection.startRow
                    const targetCol = editingCell?.col ?? selection.startCol
                    if (targetRow && targetCol) {
                      handleCellChange(targetRow, targetCol, formulaBarValue)
                      setEditingCell(null)
                      if (formulaBarValue.startsWith('=')) {
                        setWorkbook(prev => {
                          saveToHistory(prev)
                          return prev
                        })
                      }
                    }
                  }
                }}
                placeholder="输入公式或值"
                disabled={isAnalyzeReadonly}
              />
            </div>
            )}

            {/* Excel 编辑器 */}
            <div className="content-excel-editor">
              {(isGridDataLoading || isLargeFileUploading) && (
                <div className="excel-loading-overlay">
                  <div className="excel-loading-badge">数据加载中...</div>
                </div>
              )}
              <ErrorBoundary>
                {!largeFileMode || (largeFileMode && platformView === 'analyze') ? (
                  <UniverSheetContainer
                    key={`univer-${largeFileMode ? (largeFileInfo?.file_id || selectedSidebarFile?.id || 'lf') : (selectedSidebarFile?.id || 'draft')}-${largeFileMode ? 'anlz' : 'std'}`}
                    ref={univerEditorRef}
                    workbook={workbook}
                    customFormulas={customFormulas}
                    activeSheet={activeSheet}
                    sheetTheme={preferences.sheet_theme || 'excel-classic'}
                    readOnly={isAnalyzeReadonly}
                    onWorkbookChange={handleUniverWorkbookChange}
                    onChartUpdate={handleChartUpdate}
                    onChartDelete={handleChartDelete}
                    onOpenChartInsert={() => setChartInsertOpen(true)}
                    onApplyCustomFormula={handleApplyCustomFormulaFromContextMenu}
                    fileId={largeFileMode ? (largeFileInfo?.file_id || selectedSidebarFile?.id || 'draft') : (selectedSidebarFile?.id || 'draft')}
                    onUniverSelectionChange={setSelection}
                    onUniverActiveSheetChange={handleSelectSheetWrapper}
                    glideActiveSheetRef={glideActiveSheetRef}
                    viewZoom={sheetZoom}
                  />
                ) : (
                <ExcelEditor
                  ref={editorRef}
                  workbook={workbook}
                  activeSheet={activeSheet}
                  selection={selection}
                  onSelectionChange={handleSelectionChange}
                  onCellChange={handleCellChange}
                  onRowHeightChange={handleRowHeightChange}
                  onColWidthChange={handleColWidthChange}
                  onInsertRow={handleInsertRow}
                  onDeleteRow={handleDeleteRow}
                  onInsertCol={handleInsertCol}
                  onDeleteCol={handleDeleteCol}
                  editingCell={editingCell}
                  onEditingCellChange={setEditingCell}
                  formatBrushActive={formatBrushActive}
                  onApplyFormatBrush={applyFormatBrush}
                  onCopy={handleCopy}
                  onPaste={handlePaste}
                  canPaste={canPaste}
                  readOnly={isAnalyzeReadonly}
                  zoom={sheetZoom}
                  customFormulas={customFormulas}
                  sheetTheme={preferences.sheet_theme || 'excel-classic'}
                />
                )}
              </ErrorBoundary>
            </div>
          </div>
          )}
          {aiPanelOpen && platformView !== 'skill' && platformView !== 'batchWord' && (
            <div className="content-ai-panel">
              <AIAssistant
                open={aiPanelOpen}
                messages={aiMessages}
                isProcessing={isAiProcessing || isLargeFileUploading}
                isConnected={isConnected}
                isReady={isReady}
                onSendCommand={handleSendCommandWrapper}
                onClearBackendMessages={handleClearBackendMessages}
                onClose={() => setAiPanelOpen(false)}
                largeFileMode={largeFileMode}
                largeFileInfo={largeFileInfo}
                currentFileName={currentFileName}
                currentSheetCount={aiCurrentSheetCount}
                activeSheet={activeSheet}
                workbook={workbook}
                hasSelectedWorkbook={!!selectedSidebarFile?.id}
                currentSheetIsEmpty={currentSheetIsEmpty}
                onEnsureWorkbookForOneClickSheet={handleEnsureWorkbookForOneClickSheet}
                platformView={platformView}
                openSqlBuilderSignal={openSqlBuilderSignal}
                customFormulas={customFormulas}
                accessToken={accessToken}
                onOpenFormulaManager={() => setFormulaManagerOpen(true)}
                executionProgress={executionProgress}
              />
            </div>
          )}
        </div>

        {/* 底部状态栏 */}
        <StatusBar
          selection={selection}
          sheet={activeSheetObj}
        />
      </div>

      {/* ===== 对话框组件 ===== */}
      <FindReplaceDialog
        isOpen={findReplaceOpen}
        onClose={() => setFindReplaceOpen(false)}
        onFind={handleFindOnly}
        onReplace={handleFindReplace}
      />
      <FilterDialog
        isOpen={filterOpen}
        onClose={() => setFilterOpen(false)}
        onApply={handleFilter}
        selection={effectiveSelection}
      />
      <FormulaManagerDialog
        open={formulaManagerOpen}
        onClose={() => { setFormulaManagerOpen(false); loadCustomFormulas() }}
        accessToken={accessToken}
      />
      <ChartInsertDialog
        isOpen={chartInsertOpen}
        onClose={() => setChartInsertOpen(false)}
        onCreate={handleChartCreate}
        workbook={workbook}
        activeSheet={activeSheet}
        univerEditorRef={univerEditorRef}
      />
      {unsavedConfirm && (
        <div className="unsaved-confirm-overlay" onClick={handleUnsavedConfirmCancel}>
          <div className="unsaved-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="unsaved-confirm-title">未保存的更改</div>
            <div className="unsaved-confirm-body">
              {unsavedConfirm.type === 'newBlank'
                ? '当前工作表有未保存的内容，是否保存为新建工作簿？'
                : '当前工作表有未保存的内容，是否在离开前保存？'
              }
            </div>
            <div className="unsaved-confirm-actions">
              <button className="unsaved-btn cancel" onClick={handleUnsavedConfirmCancel}>取消</button>
              <button className="unsaved-btn discard" onClick={handleUnsavedConfirmDiscard}>不保存</button>
              <button className="unsaved-btn save" onClick={handleUnsavedConfirmSave}>
                {unsavedConfirm.type === 'newBlank' ? '保存为新工作簿' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
      {!aiPanelOpen && activeAiPopup && (
        <div className={`ai-popup-toast ${activeAiPopup.level}`}>
          <button
            type="button"
            className="ai-popup-toast-close"
            onClick={() => {
              setActiveAiPopup(null)
            }}
            aria-label="关闭提示"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
          <div className="ai-popup-toast-title">{activeAiPopup.title}</div>
          <div className="ai-popup-toast-content">{activeAiPopup.content}</div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={handleOpenFile}
        style={{ display: 'none' }}
      />
    </div>
  )
}

export default App
