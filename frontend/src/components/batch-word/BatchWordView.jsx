// frontend/src/components/batch-word/BatchWordView.jsx
/**
 * ===================================
 * 批量转 Word 主视图
 * 阶段状态机：home -> upload -> mapping -> generating -> completed
 * ===================================
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { detectSheetHeaderRow } from '../../utils/excelOperations'
import { FileText, ChevronRight, Wand2, Undo2, Redo2, Table, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/AuthContext'
import appConfig from '../../config/appConfig'
import MappingEditor from './MappingEditor'
import FilenameConfigurator from './FilenameConfigurator'
import GeneratePanel from './GeneratePanel'
import BatchWordHistoryPanel from './BatchWordHistoryPanel'
import PlatformViewToolbar from '../PlatformViewToolbar'


export default function BatchWordView({
  workbook,
  activeSheet,
  selectedSidebarFile,
  onSelectSidebarFile,
  pushSystemMessage,
}) {
  const { t } = useTranslation()
  const { withFreshAccessToken } = useAuth()
  const baseUrl = useMemo(() => {
    const c = appConfig.apiBaseUrl || ''
    if (c) return c.replace(/\/$/, '')
    return typeof window !== 'undefined' ? window.location.origin : ''
  }, [])

  // ==================== 阶段状态 ====================
  const [stage, setStage] = useState('home')
  const [templateInfo, setTemplateInfo] = useState(null)
  const [mappings, setMappings] = useState([])
  const [filenamePattern, setFilenamePattern] = useState('文档_{_index}')
  const [generating, setGenerating] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState('')
  const [totalGenerated, setTotalGenerated] = useState(0)
  const [aiLoading, setAiLoading] = useState(false)
  const [editorHtml, setEditorHtml] = useState('')
  const [historyItems, setHistoryItems] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [uploadingTemplate, setUploadingTemplate] = useState(false)
  const editorRef = useRef(null)
  const fileInputRef = useRef(null)
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])
  const skipHistoryRef = useRef(false)

  // 右键上下文菜单
  const [ctxMenu, setCtxMenu] = useState(null)
  const ctxSelectionRef = useRef(null)

  const dedupeMappings = useCallback((items) => {
    const list = Array.isArray(items) ? items : []
    const seenPlaceholder = new Set()
    const out = []
    list.forEach((m) => {
      const placeholder = String(m?.placeholder || '').trim()
      const column = String(m?.column || '').trim()
      const type = String(m?.type || 'text').trim() || 'text'
      if (!placeholder || !column) return
      const k1 = placeholder.toLowerCase()
      if (seenPlaceholder.has(k1)) return
      seenPlaceholder.add(k1)
      out.push({
        ...m,
        placeholder,
        column,
        type,
      })
    })
    return out
  }, [])

  const normalizePreviewImageSrc = useCallback((value) => {
    const text = String(value || '').trim()
    if (!text) return ''
    if (text.startsWith('data:image/')) return text
    if (/^https?:\/\//i.test(text)) return text
    const compact = text.replace(/\s+/g, '')
    if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
      return `data:image/png;base64,${compact}`
    }
    return ''
  }, [])

  const truncatePreviewText = useCallback((value, maxLen = 20) => {
    const text = String(value ?? '').trim()
    if (!text) return ''
    if (text.length <= maxLen) return text
    return `${text.slice(0, maxLen)}...`
  }, [])

  const normalizeDateLikeValue = useCallback((value) => {
    if (value === null || value === undefined) return ''
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const ymd = `${value.getFullYear()}/${value.getMonth() + 1}/${value.getDate()}`
      if (value.getHours() || value.getMinutes() || value.getSeconds()) {
        const hh = String(value.getHours()).padStart(2, '0')
        const mm = String(value.getMinutes()).padStart(2, '0')
        const ss = String(value.getSeconds()).padStart(2, '0')
        if (value.getSeconds()) return `${ymd} ${hh}:${mm}:${ss}`
        return `${ymd} ${hh}:${mm}`
      }
      return ymd
    }
    let text = String(value).trim()
    if (!text) return ''
    text = text
      .replace(/\\"/g, '"')
      .replace(/^["']+|["']+$/g, '')
      .trim()
    const dt = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/)
    if (dt) {
      const [, y, m, d, h, mi, s] = dt
      if (s) return `${y}/${Number(m)}/${Number(d)} ${String(Number(h)).padStart(2, '0')}:${String(Number(mi)).padStart(2, '0')}:${String(Number(s)).padStart(2, '0')}`
      return `${y}/${Number(m)}/${Number(d)} ${String(Number(h)).padStart(2, '0')}:${String(Number(mi)).padStart(2, '0')}`
    }
    const m = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (m) {
      return `${m[1]}/${Number(m[2])}/${Number(m[3])}`
    }
    const zh = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (zh) {
      return `${zh[1]}/${Number(zh[2])}/${Number(zh[3])}`
    }
    return text
  }, [])

  // ==================== 从工作簿提取数据 ====================
  const sheetData = useMemo(() => {
    if (!workbook?.sheets?.length) return { columns: [], rows: [], imageColumns: [] }
    const sheet = workbook.sheets.find(s => s.name === activeSheet) || workbook.sheets[0]
    if (!sheet?.data) return { columns: [], rows: [], imageColumns: [] }

    const isArrayMatrix = Array.isArray(sheet.data)
    const maxCol = Math.min(Number(sheet.colCount || 26), 200)

    const getCellText = (cell) => {
      if (cell && typeof cell === 'object') {
        let v = cell.value ?? cell.text ?? cell.result ?? ''
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          v = v.text ?? v.result ?? v.value ?? v.display ?? ''
        }
        return normalizeDateLikeValue(v)
      }
      return normalizeDateLikeValue(cell)
    }

    const getCell = (rowData, colIndex) => {
      if (!rowData) return null
      return rowData[String(colIndex)] ?? rowData[colIndex] ?? null
    }

    const getHeaderColumns = () => {
      if (isArrayMatrix) {
        const headerRow = sheet.data[0] || []
        return headerRow.map((cell) => getCellText(cell)).filter(Boolean)
      }
      const hRow = detectSheetHeaderRow(sheet.data)
      const headerRowData = sheet.data[String(hRow)] || sheet.data[hRow]
      if (!headerRowData) return []
      const cols = []
      for (let c = 1; c <= maxCol; c++) {
        const cell = getCell(headerRowData, c)
        const text = getCellText(cell)
        if (text) cols.push(text)
      }
      return cols
    }

    const columns = getHeaderColumns()
    if (!columns.length) return { columns: [], rows: [], imageColumns: [] }

    const imageColumns = new Set()
    const rows = []

    if (isArrayMatrix) {
      for (let r = 1; r < sheet.data.length; r++) {
        const row = sheet.data[r] || []
        const obj = {}
        columns.forEach((col, ci) => {
          const cell = row[ci]
          if (cell?.image?.src) {
            obj[col] = cell.image.src
            imageColumns.add(col)
          } else {
            obj[col] = getCellText(cell)
          }
        })
        if (Object.values(obj).some(v => v !== '')) rows.push(obj)
      }
    } else {
      const rowKeys = Object.keys(sheet.data)
        .map(Number)
        .filter(n => Number.isFinite(n) && n >= 2)
        .sort((a, b) => a - b)

      for (const rowNum of rowKeys) {
        const rowData = sheet.data[String(rowNum)] || sheet.data[rowNum]
        if (!rowData) continue
        const obj = {}
        columns.forEach((col, ci) => {
          const colIndex = ci + 1
          const cell = getCell(rowData, colIndex)
          if (cell?.image?.src) {
            obj[col] = cell.image.src
            imageColumns.add(col)
          } else {
            obj[col] = getCellText(cell)
          }
        })
        if (Object.values(obj).some(v => v !== '')) rows.push(obj)
      }
    }

    return { columns, rows, imageColumns: [...imageColumns] }
  }, [workbook, activeSheet, normalizeDateLikeValue])

  // ==================== 辅助：高亮 {字段} ====================
  const highlightPlaceholders = useCallback((html) => {
    if (!html) return ''
    const cleaned = html
      .replace(/<span class="bw-ph-token">(.*?)<\/span>/g, '$1')
      .replace(/<span class='bw-ph-token'>(.*?)<\/span>/g, '$1')
    // 先归一化多层花括号，避免出现 {{{相片}}} 视觉残留
    const normalized = cleaned.replace(/\{\{+\s*([^{}]+?)\s*\}\}+/g, '{$1}')
    return normalized.replace(/(\{[^{}]+\})/g, '<span class="bw-ph-token">$1</span>')
  }, [])

  const applyEditorHtml = useCallback((html, skipHistory = false) => {
    const finalHtml = html || ''
    if (skipHistory) {
      skipHistoryRef.current = true
    }
    setEditorHtml(finalHtml)
    const el = editorRef.current
    if (el && el.innerHTML !== finalHtml) {
      el.innerHTML = finalHtml
    }
  }, [])

  // ==================== 加载编辑区 HTML ====================
  const loadEditorHtml = useCallback(async (templateId) => {
    if (!templateId) return
    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/preview-html`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template_id: templateId,
            mappings: [],
            row_data: {},
            mode: 'annotated',
          }),
        })
      })
      if (res.ok) {
        const data = await res.json()
        applyEditorHtml(highlightPlaceholders(data.html || ''))
      }
    } catch (_) {
      // 加载失败静默
    }
  }, [baseUrl, withFreshAccessToken, highlightPlaceholders, applyEditorHtml])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/history`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      })
      if (!res.ok) return
      const data = await res.json()
      setHistoryItems(Array.isArray(data.items) ? data.items : [])
    } catch (_) {
      // 历史读取失败不阻断主流程
    } finally {
      setHistoryLoading(false)
    }
  }, [baseUrl, withFreshAccessToken])

  // ==================== 模板上传回调 ====================
  const buildInitialMappings = useCallback((placeholders = []) => {
    const excelDefaultMappings = sheetData.columns.map((col) => ({
      placeholder: `{${col}}`,
      column: col,
      type: sheetData.imageColumns.includes(col) ? 'image' : 'text',
    }))
    const initialByPlaceholder = (placeholders || []).map((ph) => {
      const name = ph.replace(/^\{|\}$/g, '')
      const matchCol = sheetData.columns.find((c) => c === name)
      const isImg = matchCol && sheetData.imageColumns.includes(matchCol)
      return {
        placeholder: ph,
        column: matchCol || '',
        type: isImg ? 'image' : 'text',
      }
    })
    return dedupeMappings([...initialByPlaceholder, ...excelDefaultMappings])
  }, [sheetData.columns, sheetData.imageColumns, dedupeMappings])

  const handleUploaded = useCallback((data) => {
    setTemplateInfo(data)
    applyEditorHtml('', true)

    if (data?.has_saved_config) {
      // 已存在保存配置时，严格按已保存配置恢复
      const saved = dedupeMappings(data.saved_mappings || [])
      setMappings(saved.length ? saved : [{ placeholder: '', column: '', type: 'text' }])
    } else {
      // 新增场景：默认罗列全部 Excel 字段，Word 标注使用 {字段名}
      const initial = buildInitialMappings(data.placeholders || [])
      setMappings(initial.length ? initial : [{ placeholder: '', column: '', type: 'text' }])
    }
    if (data.saved_filename_pattern) {
      setFilenamePattern(data.saved_filename_pattern)
    }
    setStage('mapping')
    if (data.saved_editor_html) {
      applyEditorHtml(highlightPlaceholders(data.saved_editor_html))
    } else {
      loadEditorHtml(data.template_id)
    }
  }, [loadEditorHtml, dedupeMappings, buildInitialMappings, applyEditorHtml, highlightPlaceholders])

  const uploadTemplateFile = useCallback(async (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.docx')) {
      pushSystemMessage?.('warning', t('batchWord.errNotDocx'))
      return
    }
    setUploadingTemplate(true)
    setStage('upload')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/upload-template`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(typeof body.detail === 'object' ? (body.detail.message || res.statusText) : (body.detail || body.error || res.statusText))
      }
      const data = await res.json()
      handleUploaded({
        ...data,
        template_file_name: file.name,
      })
    } catch (e) {
      pushSystemMessage?.('error', e.message || t('batchWord.errUploadFailed'))
      setStage('home')
    } finally {
      setUploadingTemplate(false)
    }
  }, [baseUrl, withFreshAccessToken, handleUploaded, t])

  const triggerTemplateUpload = useCallback(() => {
    if (!sheetData.columns.length) {
      pushSystemMessage?.('warning', t('batchWord.noExcelData'))
      return
    }
    fileInputRef.current?.click()
  }, [sheetData.columns.length, t])

  // ==================== AI 一键标注（修改 docx 本体） ====================
  const handleAIAnnotateDoc = useCallback(async () => {
    if (!templateInfo?.template_id) return
    setAiLoading(true)
    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/ai-annotate-doc`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template_id: templateInfo.template_id,
            excel_columns: sheetData.columns,
            sample_row: sheetData.rows[0] || {},
          }),
        })
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(typeof body.detail === 'object' ? (body.detail.message || res.statusText) : (body.detail || body.error || res.statusText))
      }

      const data = await res.json()
      if (data.html) {
        applyEditorHtml(highlightPlaceholders(data.html))
      }
      if (data.mappings?.length) {
        setMappings(dedupeMappings(data.mappings))
      }
    } catch (e) {
      pushSystemMessage?.('error', e.message)
    } finally {
      setAiLoading(false)
    }
  }, [baseUrl, withFreshAccessToken, templateInfo, sheetData.columns, highlightPlaceholders, dedupeMappings, applyEditorHtml])

  const handleEditorUndo = useCallback(() => {
    const stack = undoStackRef.current
    if (stack.length <= 1) return
    const current = stack.pop()
    redoStackRef.current.push(current)
    const prev = stack[stack.length - 1] || ''
    applyEditorHtml(prev, true)
  }, [applyEditorHtml])

  const handleEditorRedo = useCallback(() => {
    const redo = redoStackRef.current
    if (!redo.length) return
    const next = redo.pop()
    undoStackRef.current.push(next)
    applyEditorHtml(next, true)
  }, [applyEditorHtml])

  // ==================== 批量生成 ====================
  const handleGenerate = useCallback(async () => {
    if (!templateInfo?.template_id || !mappings.length) return
    setGenerating(true)
    setStage('generating')

    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/generate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template_id: templateInfo.template_id,
            mappings: dedupeMappings(mappings),
            rows: sheetData.rows,
            filename_pattern: filenamePattern || '文档_{_index}',
            template_file_name: templateInfo?.template_file_name || '',
            source_file_id: selectedSidebarFile?.id || '',
            source_file_name: selectedSidebarFile?.file_name || selectedSidebarFile?.name || '',
          }),
        })
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const detail = body?.detail
        const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
        const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || body?.error || res.statusText))
        throw new Error(msg)
      }

      const data = await res.json()
      setDownloadUrl(data.download_url)
      setTotalGenerated(data.total)
      setStage('completed')
      loadHistory()
    } catch (e) {
      pushSystemMessage?.('error', e.message)
      setStage('mapping')
    } finally {
      setGenerating(false)
    }
  }, [baseUrl, withFreshAccessToken, templateInfo, mappings, sheetData, filenamePattern, loadHistory, selectedSidebarFile, dedupeMappings])

  const handleSaveConfig = useCallback(async () => {
    if (!templateInfo?.template_id) {
      pushSystemMessage?.('warning', t('batchWord.errNeedTemplate'))
      return
    }
    setSavingConfig(true)
    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/save-mappings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template_id: templateInfo.template_id,
            mappings: dedupeMappings(mappings),
            filename_pattern: filenamePattern || '文档_{_index}',
            editor_html: editorHtml || '',
            record_history: true,
            template_file_name: templateInfo?.template_file_name || '',
            source_file_id: selectedSidebarFile?.id || '',
            source_file_name: selectedSidebarFile?.file_name || selectedSidebarFile?.name || '',
          }),
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(typeof body.detail === 'object' ? (body.detail.message || res.statusText) : (body.detail || body.error || res.statusText))
      }
      const data = await res.json()
      if (data?.saved_filename_pattern) {
        setFilenamePattern(data.saved_filename_pattern)
      }
      await loadHistory()
    } catch (e) {
      pushSystemMessage?.('error', e.message || t('batchWord.saveConfigFailed'))
    } finally {
      setSavingConfig(false)
    }
  }, [baseUrl, withFreshAccessToken, templateInfo, mappings, dedupeMappings, filenamePattern, editorHtml, t, selectedSidebarFile, loadHistory])

  // ==================== 重置 ====================
  const handleReset = useCallback(() => {
    setStage('home')
    setTemplateInfo(null)
    setMappings([])
    setFilenamePattern('文档_{_index}')
    setDownloadUrl('')
    setTotalGenerated(0)
    applyEditorHtml('', true)
  }, [applyEditorHtml])

  const handleHistoryDownload = useCallback(async (downloadPath) => {
    if (!downloadPath) return
    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}${downloadPath}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      })
      if (!res.ok) throw new Error(res.statusText)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${downloadPath.split('/').pop()}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (_) {
      pushSystemMessage?.('error', '历史文件下载失败')
    }
  }, [baseUrl, withFreshAccessToken])

  const handleHistoryEdit = useCallback(async (item) => {
    if (!item?.template_id) {
      pushSystemMessage?.('warning', '该记录缺少模板信息，无法修改')
      return
    }
    try {
      if (item.source_file_id && onSelectSidebarFile && selectedSidebarFile?.id !== item.source_file_id) {
        await onSelectSidebarFile(
          {
            id: item.source_file_id,
            file_name: item.source_file_name || '',
            name: item.source_file_name || '',
            type: 'file',
          },
          { preservePlatformView: true, skipAutoAnalyze: true, silentBusy: true }
        )
      }
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/template/${item.template_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(typeof body.detail === 'object' ? (body.detail.message || res.statusText) : (body.detail || body.error || res.statusText))
      }
      const data = await res.json()
      handleUploaded(data)
      if (item.template_file_name) {
        setTemplateInfo((prev) => ({
          ...(prev || {}),
          template_file_name: item.template_file_name,
        }))
      }
      setStage('mapping')
    } catch (e) {
      pushSystemMessage?.('error', e.message || '读取历史模板失败')
    }
  }, [baseUrl, withFreshAccessToken, handleUploaded, onSelectSidebarFile, selectedSidebarFile?.id])

  const handleHistoryDelete = useCallback(async (item) => {
    if (!item?.task_id) return
    const ok = window.confirm('删除后将同时移除服务器中的模板文档、生成压缩包和该条历史记录，是否继续？')
    if (!ok) return
    try {
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/history/${item.task_id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(typeof body.detail === 'object' ? (body.detail.message || res.statusText) : (body.detail || body.error || res.statusText))
      }

      // 如果当前正在编辑被删除模板，则清空状态回首页
      if (templateInfo?.template_id && item.template_id === templateInfo.template_id) {
        handleReset()
      }
      await loadHistory()
    } catch (e) {
      pushSystemMessage?.('error', e.message || '删除历史记录失败')
    }
  }, [baseUrl, withFreshAccessToken, templateInfo, handleReset, loadHistory])

  // ==================== 右键菜单：显示 ====================
  const handleEditorContextMenu = useCallback((e) => {
    const el = editorRef.current
    if (!el) return

    const imgEl = e.target?.closest?.('img')
    if (imgEl && el.contains(imgEl)) {
      e.preventDefault()
      ctxSelectionRef.current = {
        mode: 'image',
        embedId: imgEl.getAttribute('data-embed-id') || '',
      }
      setCtxMenu({ x: e.clientX, y: e.clientY, type: 'image' })
      return
    }

    const sel = window.getSelection()
    const text = (sel?.toString() || '').trim()
    if (!text) return
    if (!sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!el.contains(range.commonAncestorContainer)) return

    e.preventDefault()
    ctxSelectionRef.current = { mode: 'text', text, range: range.cloneRange() }
    setCtxMenu({ x: e.clientX, y: e.clientY, type: 'text' })
  }, [])

  // ==================== 右键菜单：选择字段替换 ====================
  const handleCtxMenuSelect = useCallback(async (fieldName) => {
    setCtxMenu(null)
    const saved = ctxSelectionRef.current
    if (!saved) return
    const el = editorRef.current
    if (!el) return
    const tag = `{${fieldName}}`
    const isImgField = sheetData.imageColumns.includes(fieldName)

    if (saved.mode === 'image') {
      const img = el.querySelector(saved.embedId ? `img[data-embed-id="${saved.embedId}"]` : 'img')
      if (img) {
        const node = document.createTextNode(tag)
        img.replaceWith(node)
      }
      applyEditorHtml(highlightPlaceholders(el.innerHTML || ''))

      setMappings(prev => dedupeMappings([
        ...prev,
        { placeholder: tag, column: fieldName, type: 'image' },
      ]))

      if (templateInfo?.template_id) {
        try {
          await withFreshAccessToken(async (token) => {
            return fetch(`${baseUrl}/api/batch-word/manual-annotate-image`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                template_id: templateInfo.template_id,
                field_name: fieldName,
                embed_id: saved.embedId || null,
              }),
            })
          })
        } catch (_) {
          // 后端同步失败不阻断前端操作
        }
      }
    } else {
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(saved.range)

      const originalText = saved.text
      saved.range.deleteContents()
      const node = document.createTextNode(tag)
      saved.range.insertNode(node)
      saved.range.setStartAfter(node)
      saved.range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(saved.range)

      applyEditorHtml(highlightPlaceholders(el.innerHTML || ''))
      setMappings(prev => dedupeMappings([
        ...prev,
        { placeholder: tag, column: fieldName, type: isImgField ? 'image' : 'text' },
      ]))

      if (templateInfo?.template_id && originalText) {
        try {
          await withFreshAccessToken(async (token) => {
            return fetch(`${baseUrl}/api/batch-word/manual-annotate`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                template_id: templateInfo.template_id,
                original_text: originalText,
                field_name: fieldName,
              }),
            })
          })
        } catch (_) {
          // 后端同步失败不阻断前端操作
        }
      }
    }

    ctxSelectionRef.current = null
  }, [highlightPlaceholders, sheetData.imageColumns, templateInfo, baseUrl, withFreshAccessToken, dedupeMappings, applyEditorHtml])

  // ==================== 点击页面其他区域关闭菜单 ====================
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close, { once: true })
    return () => window.removeEventListener('click', close)
  }, [ctxMenu])

  // ==================== 编辑区失焦：重新高亮 ====================
  const handleEditorBlur = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    applyEditorHtml(highlightPlaceholders(el.innerHTML || ''))
  }, [highlightPlaceholders, applyEditorHtml])

  // ==================== 渲染辅助 ====================
  const noData = !sheetData.columns.length

  // ==================== 顶部动作栏事件 ====================
  useEffect(() => {
    const onBatchWordAction = async (event) => {
      const action = event?.detail?.action
      if (!action) return

      if (action === 'back_list') {
        setStage('home')
        return
      }
      if (action === 'go_upload') {
        triggerTemplateUpload()
        return
      }
      if (action === 'go_mapping') {
        if (!templateInfo?.template_id) {
          pushSystemMessage?.('warning', t('batchWord.errNeedTemplate'))
          return
        }
        setStage('mapping')
        return
      }
      if (action === 'go_generate') {
        if (!templateInfo?.template_id) {
          pushSystemMessage?.('warning', t('batchWord.errNeedTemplate'))
          return
        }
        if (!mappings.some(m => m.placeholder && m.column)) {
          pushSystemMessage?.('warning', t('batchWord.errNeedMapping'))
          return
        }
        if (!sheetData.rows.length) {
          pushSystemMessage?.('warning', t('batchWord.noExcelData'))
          return
        }
        await handleGenerate()
      }
    }

    window.addEventListener('batch-word:view-action', onBatchWordAction)
    return () => window.removeEventListener('batch-word:view-action', onBatchWordAction)
  }, [templateInfo, mappings, sheetData.rows.length, handleGenerate, t, triggerTemplateUpload])

  // ==================== 映射自动保存 ====================
  useEffect(() => {
    if (!templateInfo?.template_id) return
    const timer = setTimeout(async () => {
      try {
        await withFreshAccessToken(async (token) => {
          return fetch(`${baseUrl}/api/batch-word/save-mappings`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              template_id: templateInfo.template_id,
              mappings: dedupeMappings(mappings),
              filename_pattern: filenamePattern || '文档_{_index}',
            }),
          })
        })
      } catch (_) {
        // 自动保存失败不阻断主流程
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [baseUrl, withFreshAccessToken, templateInfo, mappings, dedupeMappings, filenamePattern])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // 非受控 contentEditable 兜底同步：
  // 当模板内容在编辑器挂载前已返回（如历史“修改”场景），在挂载后补写入 DOM。
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (document.activeElement === el) return
    const next = editorHtml || ''
    if (el.innerHTML !== next) {
      el.innerHTML = next
    }
  }, [editorHtml, stage])

  // 编辑历史栈：支持稳定的撤消 / 恢复
  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false
      return
    }
    const html = editorHtml || ''
    const stack = undoStackRef.current
    if (!stack.length || stack[stack.length - 1] !== html) {
      stack.push(html)
      if (stack.length > 100) {
        stack.shift()
      }
      redoStackRef.current = []
    }
  }, [editorHtml])

  return (
    <div className="bw-view">
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          uploadTemplateFile(file)
        }}
      />
      {stage !== 'home' && <PlatformViewToolbar variant="batchWord" />}
      {/* 顶部导航 */}
      <div className="bw-topbar">
        <div className="bw-topbar-stage">
          <span className="bw-stage-prefix">{t('batchWord.currentStep')}</span>
          {['upload', 'mapping', 'generating'].map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <ChevronRight size={14} className="bw-stage-arrow" />}
              <span
                className={`bw-stage-dot ${
                  ((stage === 'home' || stage === 'upload') && s === 'upload')
                  || (stage === 'mapping' && s === 'mapping')
                  || ((stage === 'generating' || stage === 'completed') && s === 'generating')
                    ? 'bw-stage-dot--active'
                    : ''
                }`}
              >
                {`${['①', '②', '③'][i]}${t(`batchWord.stage_${s}`)}`}
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* 主体内容 */}
      <div className="bw-body">
        {/* 首页 */}
        {stage === 'home' && (
          <div className="bw-home">
            <div className="bw-home-icon"><FileText size={48} strokeWidth={1} /></div>
            <h2 className="bw-home-title">{t('batchWord.homeTitle')}</h2>
            <p className="bw-home-desc">{t('batchWord.homeDesc')}</p>
            {noData ? (
              <p className="bw-home-warn">{t('batchWord.noExcelData')}</p>
            ) : (
              <p className="bw-home-info">
                {t('batchWord.dataInfo', { cols: sheetData.columns.length, rows: sheetData.rows.length })}
              </p>
            )}
            <button
              className="bw-btn-primary bw-btn-lg"
              disabled={noData}
              onClick={triggerTemplateUpload}
            >
              {t('batchWord.start')}
            </button>
          </div>
        )}

        {stage === 'home' && (
          <BatchWordHistoryPanel
            items={historyItems}
            loading={historyLoading}
            onRefresh={loadHistory}
            onEdit={handleHistoryEdit}
            onDelete={handleHistoryDelete}
            onDownload={handleHistoryDownload}
          />
        )}

        {/* 上传进行中 */}
        {stage === 'upload' && uploadingTemplate && (
          <div className="bw-upload-section">
            <div className="bw-dropzone-inner">
              <div className="bw-spinner" />
              <span>{t('batchWord.uploading')}</span>
            </div>
          </div>
        )}

        {/* 映射编辑 */}
        {(stage === 'mapping' || stage === 'generating' || stage === 'completed') && (
          <div className="bw-mapping-stage">
            <div className="bw-excel-preview">
              <div className="bw-section-label">
                <Table size={14} />
                <span>{t('batchWord.excelPreviewTitle')}</span>
              </div>
              <div className="bw-excel-preview-table-wrap">
                <table className="bw-excel-preview-table">
                  <thead>
                    <tr>
                      {sheetData.columns.map((col) => (
                        <th key={`preview-head-${col}`}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {sheetData.columns.map((col) => {
                        const value = sheetData.rows[0]?.[col]
                        const src = sheetData.imageColumns.includes(col) ? normalizePreviewImageSrc(value) : ''
                        return (
                          <td key={`preview-cell-${col}`}>
                            {src ? (
                              <img
                                src={src}
                                alt={col}
                                className="bw-excel-preview-image"
                              />
                            ) : (
                              <span className="bw-excel-preview-text">
                                <span title={String(value ?? '').trim()}>
                                  {truncatePreviewText(value) || t('batchWord.previewEmptyCell')}
                                </span>
                              </span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <MappingEditor
              mappings={mappings}
              setMappings={setMappings}
              excelColumns={sheetData.columns}
              imageColumns={sheetData.imageColumns}
            />

            {/* 在线编辑区（高保真 Word 渲染 + 右键标注） */}
            {aiLoading && (
              <div className="bw-ai-loading">
                <div className="bw-spinner" />
                <span>{t('batchWord.annotating')}</span>
              </div>
            )}
            <div className="bw-draft-editor">
              <div className="bw-section-label">
                <Pencil size={14} />
                <span>{t('batchWord.editorTitle')}</span>
                <div className="bw-editor-tools">
                  <button
                    className="bw-btn-ghost bw-btn-ai-annotate"
                    disabled={aiLoading}
                    onClick={handleEditorUndo}
                  >
                    <Undo2 size={14} />
                    <span>{t('batchWord.undo')}</span>
                  </button>
                  <button
                    className="bw-btn-ghost bw-btn-ai-annotate"
                    disabled={aiLoading}
                    onClick={handleEditorRedo}
                  >
                    <Redo2 size={14} />
                    <span>{t('batchWord.redo')}</span>
                  </button>
                  <button
                    className="bw-btn-ghost bw-btn-ai-annotate"
                    disabled={aiLoading}
                    onClick={handleAIAnnotateDoc}
                  >
                    <Wand2 size={14} />
                    <span>{t('batchWord.aiAnnotateDoc')}</span>
                  </button>
                </div>
              </div>
              <div
                ref={editorRef}
                className="bw-rich-editor"
                contentEditable
                suppressContentEditableWarning
                onInput={(e) => setEditorHtml(e.currentTarget.innerHTML)}
                onBlur={handleEditorBlur}
                onContextMenu={handleEditorContextMenu}
                data-placeholder={t('batchWord.editorPlaceholder')}
              />
              <p className="bw-editor-hint">{t('batchWord.contextMenuHint')}</p>
            </div>

            <FilenameConfigurator
              pattern={filenamePattern}
              setPattern={setFilenamePattern}
              excelColumns={sheetData.columns.filter((col) => !sheetData.imageColumns.includes(col))}
              imageColumns={sheetData.imageColumns}
              sampleRows={sheetData.rows.slice(0, 2)}
            />

            <GeneratePanel
              generating={generating}
              total={totalGenerated}
              downloadUrl={downloadUrl}
              baseUrl={baseUrl}
              withFreshAccessToken={withFreshAccessToken}
              showSaveConfig={stage === 'mapping'}
              onSaveConfig={handleSaveConfig}
              savingConfig={savingConfig}
              saveConfigLabel={t('batchWord.saveConfig')}
              onGenerate={handleGenerate}
              onReset={handleReset}
              showReupload={stage === 'mapping'}
              onReupload={triggerTemplateUpload}
              reuploadLabel={t('batchWord.reupload')}
            />
          </div>
        )}
      </div>

      {/* 右键上下文菜单 */}
      {ctxMenu && (
        <div
          className="bw-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bw-context-menu-title">{t('batchWord.ctxMenuTitle')}</div>
          {sheetData.columns.map((col) => (
            <div
              key={col}
              className="bw-context-menu-item"
              onClick={() => handleCtxMenuSelect(col)}
            >
              {col}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
