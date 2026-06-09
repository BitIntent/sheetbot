import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import appConfig from '../../config/appConfig'
import { useAuth } from '../../contexts/AuthContext'
import { useNotifications } from '../../contexts/NotificationContext'
import useDuckdbPreparation from '../../hooks/useDuckdbPreparation'
import TemplateSelector from './TemplateSelector'
import ReportCanvas from './ReportCanvas'
import ShareDialog from './ShareDialog'
import ReportHistoryPanel from './ReportHistoryPanel'
import PlatformViewToolbar from '../PlatformViewToolbar'
const REPORT_STATUS_MSG_ID = 'report-generate-status'

function buildReportProgressText(stage, rawMessage, progress) {
  const pct = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : null
  const pctText = pct === null ? '' : `（${Math.round(pct)}%）`
  const message = String(rawMessage || '').trim()

  const stageMap = {
    preparing: '已完成：已接收报表需求\n进行中：正在准备分析上下文\n下一步：梳理指标与图表框架',
    planning: '已完成：数据上下文准备完成\n进行中：正在规划报表结构与重点指标\n下一步：执行分析并生成图表',
    querying: '已完成：报表结构规划完成\n进行中：正在执行数据分析\n下一步：生成图表与核心结论',
    charting: '已完成：核心数据分析完成\n进行中：正在生成图表表达\n下一步：补充洞察与总结',
    insight: '已完成：图表生成完成\n进行中：正在整理关键洞察\n下一步：组装最终报表',
    assembling: '已完成：洞察提炼完成\n进行中：正在组装并输出报表\n下一步：展示可导出结果',
  }
  if (stageMap[stage]) {
    return stageMap[stage].replace(/进行中：([^\n]+)/, `进行中：$1${pctText}`)
  }

  if (message) {
    const safeMessage = message
      .replace(/duckdb/gi, '数据引擎')
      .replace(/sql/gi, '查询')
      .replace(/sse/gi, '流式进度')
      .replace(/mcp/gi, '能力模块')
    return `已完成：需求已受理\n进行中：${safeMessage}${pctText}\n下一步：继续生成图表与结论`
  }

  return `已完成：需求已受理\n进行中：正在生成报表${pctText}\n下一步：整理图表与洞察`
}

export default function ReportView({ fileId, largeFileInfo, isPreparing = false, onClose, onPrepareFromSelectedFile, pushSystemMessage, onQuickStart }) {
  const { withFreshAccessToken } = useAuth()
  const { addListener } = useNotifications()
  const getApiBaseUrl = useCallback(() => {
    const configured = appConfig.apiBaseUrl || ''
    if (configured) return configured.replace(/\/$/, '')
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/$/, '')
    }
    return ''
  }, [])
  const baseUrl = getApiBaseUrl()
  const canvasRef = useRef(null)

  const [stage, setStage] = useState('home')
  const [templates, setTemplates] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const [generating, setGenerating] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')
  const [report, setReport] = useState(null)
  const [historyReports, setHistoryReports] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyActionLoading, setHistoryActionLoading] = useState('')

  const [exportingPDF, setExportingPDF] = useState(false)
  const [exportingPNG, setExportingPNG] = useState(false)
  const [sharingLoading, setSharingLoading] = useState(false)
  const [shareToken, setShareToken] = useState(null)
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [initLoading, setInitLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [domainOverride, setDomainOverride] = useState('auto')
  const [domainQuickLoading, setDomainQuickLoading] = useState('')
  const [exportTheme, setExportTheme] = useState('dark')
  const [exportMode, setExportMode] = useState('screen')
  const [customPrompt, setCustomPrompt] = useState('')
  const [asyncTaskId, setAsyncTaskId] = useState(null)
  const taskPollRef = useRef(null)
  const handleGenerateSSERef = useRef(null)
  const lastReportProgressRef = useRef({ stage: '', pct: -1, text: '' })
  const lastAsyncProgressRef = useRef('')
  const canUseCurrentFile = !!fileId

  const { duckdbInitLoading, duckdbLoadingMessage } = useDuckdbPreparation({
    fileId,
    isPreparing,
    onPrepareFromSelectedFile,
    setStage,
    loadingStage: 'loading',
    preparingMessage: '正在准备数据环境，请稍候...',
    checkingMessage: '正在检查并加载当前活动文件...',
  })

  const getApiCandidates = useCallback(() => {
    const candidates = new Set()
    const addCandidate = (value) => {
      if (!value) return
      candidates.add(String(value).replace(/\/$/, ''))
    }

    addCandidate(baseUrl)
    if (typeof window !== 'undefined' && window.location?.origin) {
      addCandidate(window.location.origin)
    }
    return [...candidates]
  }, [baseUrl])

  const requestJsonWithFallback = useCallback(async (path, init, token) => {
    const urls = getApiCandidates().map((origin) => `${origin}${path}`)
    let lastNetworkError = null
    let lastHttpError = null

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          ...init,
          headers: {
            ...(init?.headers || {}),
            Authorization: `Bearer ${token}`,
          },
        })
        const text = await res.text().catch(() => '')
        const ct = res.headers.get('content-type') || ''
        const isHtml = text && text.trim().startsWith('<')

        if (!res.ok) {
          let body = {}
          if (ct.includes('application/json')) {
            try {
              body = JSON.parse(text) || {}
            } catch {
              body = isHtml ? { detail: `服务器返回 HTML 而非 JSON（${res.status}）` } : {}
            }
          } else if (isHtml) {
            body = { detail: res.status === 404 ? '报表不存在或已过期' : `服务器返回 HTML（${res.status}）` }
          }
          const err = new Error(body?.detail || `${res.status}`)
          err.status = res.status
          err.url = url
          err.attemptedUrls = urls
          if (res.status === 401) {
            throw err
          }
          lastHttpError = err
          continue
        }

        if (isHtml) {
          const err = new Error('服务器返回 HTML 而非 JSON，请检查接口地址或登录状态')
          err.status = res.status
          err.url = url
          err.attemptedUrls = urls
          throw err
        }
        if (!ct.includes('application/json')) {
          const err = new Error(`响应格式错误: ${text?.slice(0, 60) || '非 JSON'}`)
          err.status = res.status
          err.url = url
          err.attemptedUrls = urls
          throw err
        }
        try {
          return JSON.parse(text)
        } catch (parseErr) {
          const err = new Error('服务器返回 HTML 而非 JSON，请检查接口地址或登录状态')
          err.status = res.status
          err.url = url
          err.attemptedUrls = urls
          throw err
        }
      } catch (error) {
        if (error?.status === 401) {
          throw error
        }
        lastNetworkError = error
      }
    }

    if (lastHttpError) throw lastHttpError
    throw lastNetworkError || new Error('请求失败')
  }, [getApiCandidates])

  const loadReportHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback('/api/report/list', { method: 'GET' }, token)
      })
      setHistoryReports(Array.isArray(data?.reports) ? data.reports : [])
    } catch (err) {
      console.error('加载报表历史失败:', err)
      setNotice(`加载历史报表失败：${err?.message || '未知错误'}`)
    } finally {
      setHistoryLoading(false)
    }
  }, [withFreshAccessToken, requestJsonWithFallback])

  const handleOpenHistoryReport = useCallback(async (reportId) => {
    if (!reportId) return
    setHistoryActionLoading(`open:${reportId}`)
    setNotice('')
    try {
      const data = await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback(`/api/report/${encodeURIComponent(reportId)}`, { method: 'GET' }, token)
      })
      setReport(data)
      setStage('completed')
    } catch (err) {
      console.error('打开历史报表失败:', err)
      const msg = err?.message || '未知错误'
      setNotice(`打开报表失败：${msg}`)
      if (err?.status === 404) {
        loadReportHistory()
      }
    } finally {
      setHistoryActionLoading('')
    }
  }, [withFreshAccessToken, requestJsonWithFallback, loadReportHistory])

  const handleDeleteHistoryReport = useCallback(async (reportId) => {
    if (!reportId) return
    const confirmed = window.confirm('确认删除该报表记录吗？此操作不可撤销。')
    if (!confirmed) return
    setHistoryActionLoading(`delete:${reportId}`)
    setNotice('')
    try {
      await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback(`/api/report/${encodeURIComponent(reportId)}`, { method: 'DELETE' }, token)
      })
      setHistoryReports((prev) => prev.filter((item) => item.report_id !== reportId))
      if (report?.report_id === reportId) {
        setReport(null)
        setStage(canUseCurrentFile ? 'template' : 'home')
      }
    } catch (err) {
      console.error('删除历史报表失败:', err)
      setNotice(`删除失败：${err?.message || '未知错误'}`)
    } finally {
      setHistoryActionLoading('')
    }
  }, [withFreshAccessToken, requestJsonWithFallback, report, canUseCurrentFile])

  const reportViewState = useCallback(() => ({
    isReportDetailOpen: stage === 'completed' && !!report?.report_id,
    canReanalyze: canUseCurrentFile && !initLoading && !generating,
    canTemplate: canUseCurrentFile && !initLoading && stage !== 'loading',
    canGenerate: canUseCurrentFile && !initLoading && !generating && !!selectedKey && stage !== 'loading',
    canGenerateAsync: canUseCurrentFile && !initLoading && !generating && !!selectedKey && stage !== 'loading',
    canExport: stage === 'completed' && !!report?.report_id && !exportingPDF && !exportingPNG,
    canShare: stage === 'completed' && !!report?.report_id && !sharingLoading,
    isAsyncGenerating: !!asyncTaskId,
  }), [canUseCurrentFile, initLoading, generating, stage, selectedKey, report, exportingPDF, exportingPNG, sharingLoading, asyncTaskId])

  const initializeReport = useCallback(async (cancelledRef) => {
    if (!fileId) return
    setStage('loading')
    setInitLoading(true)
    try {
      const res = await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback(`/api/report/analyze-structure/${fileId}`, {
          method: 'POST',
        }, token)
      })

      if (cancelledRef?.current) return
      setTemplates(res.templates || [])
      // 取消进入“我要报表”时的 AI 推荐自动选中，改为用户手动选择模板
      setSelectedKey('')
      setProgressMsg('')
      setStage('template')
    } catch (err) {
      console.error('报表初始化失败:', err)
      if (!cancelledRef?.current) {
        pushSystemMessage?.('error', err?.message || '报表初始化失败')
        setProgressMsg('')
        setStage('home')
      }
    } finally {
      if (!cancelledRef?.current) {
        setInitLoading(false)
      }
    }
  }, [baseUrl, fileId, withFreshAccessToken])

  // 初始化：分析数据结构 + 获取模板列表
  useEffect(() => {
    loadReportHistory()
  }, [loadReportHistory])

  useEffect(() => {
    // 有 fileId：自动初始化模板（同时模板页下方展示历史清单）
    // 无 fileId：停留历史首页
    if (!fileId) {
      if (!duckdbInitLoading) setStage('home')
      return
    }
    const cancelledRef = { current: false }
    initializeReport(cancelledRef)
    return () => {
      cancelledRef.current = true
    }
  }, [fileId, initializeReport, duckdbInitLoading])

  const handleStartFromCurrentFile = useCallback(async () => {
    // 若当前已处于大文件上下文，直接初始化模板；否则走外部准备流程
    if (fileId) {
      const cancelledRef = { current: false }
      await initializeReport(cancelledRef)
      return
    }
    onPrepareFromSelectedFile?.()
  }, [fileId, initializeReport, onPrepareFromSelectedFile])

  const handleReinitialize = useCallback(() => {
    if (!fileId) {
      loadReportHistory()
      setStage('home')
      return
    }
    const cancelledRef = { current: false }
    initializeReport(cancelledRef)
  }, [fileId, initializeReport, loadReportHistory])

  const handleBackToHome = useCallback(() => {
    setNotice('')
    setReport(null)
    setProgressMsg('')
    setStage(fileId ? 'template' : 'home')
    loadReportHistory()
  }, [fileId, loadReportHistory])

  // 加载已完成报表（通过 cache_id 从后端获取）
  const loadCompletedReport = useCallback(async (cacheId) => {
    if (!cacheId) return
    try {
      const data = await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback(`/api/report/task/${cacheId}`, { method: 'GET' }, token)
      })
      if (data?.report_cache_id) {
        // 获取到任务信息，报表缓存在快照中
        // 尝试通过 SSE 同步流重新加载，因为缓存会命中
        setReport(null)
        setGenerating(false)
        setStage('completed')
      }
    } catch (e) {
      console.warn('加载完成报表失败:', e)
    }
  }, [withFreshAccessToken, requestJsonWithFallback])

  // 轮询异步任务状态
  const pollTaskStatus = useCallback(async (taskId) => {
    try {
      const data = await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback(`/api/report/task/${taskId}`, { method: 'GET' }, token)
      })
      if (!data) return

      if (data.progress_message) {
        setProgressMsg(data.progress_message)
        const safeText = buildReportProgressText('', data.progress_message, data.progress || null)
        if (safeText !== lastAsyncProgressRef.current) {
          pushSystemMessage?.('status', safeText, {
            id: REPORT_STATUS_MSG_ID,
            dedupe: false,
            revealPanel: true,
            persistent: true,
            upsertById: true,
          })
          lastAsyncProgressRef.current = safeText
        }
      }

      if (data.status === 'completed') {
        if (taskPollRef.current) {
          clearInterval(taskPollRef.current)
          taskPollRef.current = null
        }
        setAsyncTaskId(null)
        pushSystemMessage?.('success', '已完成：报表生成成功\n进行中：正在加载结果\n下一步：你可以查看、导出或分享', {
          id: REPORT_STATUS_MSG_ID,
          dedupe: false,
          revealPanel: true,
          persistent: true,
          upsertById: true,
        })
        // 报表完成，使用 SSE 同步流重新加载（缓存命中，秒返回）
        if (handleGenerateSSERef.current) handleGenerateSSERef.current()
      } else if (data.status === 'failed') {
        if (taskPollRef.current) {
          clearInterval(taskPollRef.current)
          taskPollRef.current = null
        }
        setAsyncTaskId(null)
        setGenerating(false)
        pushSystemMessage?.('error', `生成失败: ${data.error_message || '未知错误'}`)
        setProgressMsg('')
        setStage('template')
      }
    } catch (e) {
      console.warn('轮询任务状态失败:', e)
    }
  }, [withFreshAccessToken, requestJsonWithFallback, pushSystemMessage])

  // 生成报表（SSE 同步流 - 用于快速场景和缓存加载）
  const handleGenerateSSE = useCallback(async (overrideDomain = domainOverride, promptOverride) => {
    if (!fileId || !selectedKey) return
    const safeDomainOverride = ['auto', 'retail', 'manufacturing', 'finance', 'general'].includes(overrideDomain)
      ? overrideDomain
      : domainOverride
    const effectivePrompt = promptOverride !== undefined ? promptOverride : customPrompt
    setGenerating(true)
    setReport(null)
    setProgressMsg('正在初始化...')
    setStage('generating')
    lastReportProgressRef.current = { stage: '', pct: -1, text: '' }
    pushSystemMessage?.('status', '已开始生成报表，我会持续同步处理进度。', {
      id: REPORT_STATUS_MSG_ID,
      dedupe: false,
      revealPanel: true,
      persistent: true,
      upsertById: true,
    })

    try {
      await withFreshAccessToken(async (token) => {
        const urls = getApiCandidates().map((origin) => `${origin}/api/report/generate`)
        let res = null
        let networkError = null
        let httpError = null
        for (const url of urls) {
          try {
            const options = {
              ...(safeDomainOverride !== 'auto' ? { domain_override: safeDomainOverride } : {}),
              ...(effectivePrompt ? { custom_prompt: effectivePrompt.slice(0, 500) } : {}),
              ...(largeFileInfo?.source_file_id ? { source_file_id: largeFileInfo.source_file_id } : {}),
              ...(largeFileInfo?.user_file_id ? { user_file_id: largeFileInfo.user_file_id } : {}),
            }
            const current = await fetch(url, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                file_id: fileId,
                template_key: selectedKey,
                options,
              }),
            })
            if (!current.ok) {
              const errBody = await current.json().catch(() => ({}))
              const detail = errBody?.detail
              const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
              const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || `生成请求失败: ${current.status}`))
              const e = new Error(msg)
              e.status = current.status
              e.url = url
              e.attemptedUrls = urls
              e.isQuota = isQuota
              if (current.status === 401 || isQuota) throw e
              httpError = e
              throw e
            }
            res = current
            break
          } catch (e) {
            if (e?.status === 401 || e?.isQuota) throw e
            networkError = e
          }
        }

        if (!res) throw httpError || networkError || new Error('生成请求失败')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const event = JSON.parse(line.slice(6))
              const evtType = event.event
              const data = event.data

              if (evtType === 'progress') {
                setProgressMsg(data.message || '')
                const stageName = String(data.stage || '')
                const progressValue = Number(data.progress || 0)
                const noticeText = buildReportProgressText(stageName, data.message || '', progressValue)
                const prev = lastReportProgressRef.current
                const stageChanged = prev.stage !== stageName
                const textChanged = prev.text !== noticeText
                const pctIncreasedEnough = progressValue >= (prev.pct + 8)
                if (stageChanged || textChanged || pctIncreasedEnough) {
                  pushSystemMessage?.('status', noticeText, {
                    id: REPORT_STATUS_MSG_ID,
                    dedupe: false,
                    revealPanel: true,
                    persistent: true,
                    upsertById: true,
                  })
                  lastReportProgressRef.current = { stage: stageName, pct: progressValue, text: noticeText }
                }
              } else if (evtType === 'kpis') {
                setReport((prev) => ({ ...(prev || {}), kpis: data.kpis }))
              } else if (evtType === 'charts') {
                setReport((prev) => ({ ...(prev || {}), charts: data.charts }))
              } else if (evtType === 'insights') {
                setReport((prev) => ({ ...(prev || {}), insights: data.insights }))
              } else if (evtType === 'complete') {
                pushSystemMessage?.('success', '已完成：报表生成成功\n进行中：结果已准备好\n下一步：可继续导出或分享', {
                  id: REPORT_STATUS_MSG_ID,
                  dedupe: false,
                  revealPanel: true,
                  persistent: true,
                  upsertById: true,
                })
                setReport(data)
                setStage('completed')
                loadReportHistory()
              } else if (evtType === 'error') {
                pushSystemMessage?.('error', data.message || '报表生成出错')
                setProgressMsg('')
                setStage('template')
              }
            } catch { /* ignore parse errors */ }
          }
        }
      })
    } catch (err) {
      console.error('报表生成失败:', err)
      pushSystemMessage?.('error', `已完成：本次报表任务已结束\n进行中：未完成\n下一步：请重试，或调整分析视角后重新生成\n原因：${err.message}`, {
        id: REPORT_STATUS_MSG_ID,
        dedupe: false,
        revealPanel: true,
        persistent: true,
        upsertById: true,
      })
      pushSystemMessage?.('error', err.message)
      setProgressMsg('')
      setStage('template')
    } finally {
      setGenerating(false)
    }
  }, [fileId, selectedKey, baseUrl, withFreshAccessToken, getApiCandidates, domainOverride, customPrompt, largeFileInfo, loadReportHistory, pushSystemMessage])

  handleGenerateSSERef.current = handleGenerateSSE

  // 生成报表（异步模式 - 提交后台任务）
  const handleGenerateAsync = useCallback(async (overrideDomain = domainOverride, promptOverride) => {
    if (!fileId || !selectedKey) return
    const safeDomainOverride = ['auto', 'retail', 'manufacturing', 'finance', 'general'].includes(overrideDomain)
      ? overrideDomain
      : domainOverride
    const effectivePrompt = promptOverride !== undefined ? promptOverride : customPrompt

    setGenerating(true)
    setReport(null)
    setProgressMsg('正在提交报表生成任务...')
    setStage('generating')
    lastAsyncProgressRef.current = ''
    pushSystemMessage?.('status', '已提交后台生成任务，我会持续同步处理进度。', {
      id: REPORT_STATUS_MSG_ID,
      dedupe: false,
      revealPanel: true,
      persistent: true,
      upsertById: true,
    })

    try {
      const options = {
        ...(safeDomainOverride !== 'auto' ? { domain_override: safeDomainOverride } : {}),
        ...(effectivePrompt ? { custom_prompt: effectivePrompt.slice(0, 500) } : {}),
        ...(largeFileInfo?.source_file_id ? { source_file_id: largeFileInfo.source_file_id } : {}),
        ...(largeFileInfo?.user_file_id ? { user_file_id: largeFileInfo.user_file_id } : {}),
      }
      const data = await withFreshAccessToken(async (token) => {
        return requestJsonWithFallback('/api/report/generate-async', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_id: fileId,
            template_key: selectedKey,
            options,
          }),
        }, token)
      })

      const taskId = data?.task_id
      if (!taskId) throw new Error('未获取到任务ID')

      setAsyncTaskId(taskId)
      setProgressMsg('报表生成中，您可以继续其他操作，完成后将收到通知...')
      pushSystemMessage?.(
        'status',
        '已完成：任务提交成功\n进行中：报表正在后台生成\n下一步：完成后自动加载结果',
        {
          id: REPORT_STATUS_MSG_ID,
          dedupe: false,
          revealPanel: true,
          persistent: true,
          upsertById: true,
        }
      )

      // 启动轮询
      taskPollRef.current = setInterval(() => pollTaskStatus(taskId), 5000)

    } catch (err) {
      console.error('提交异步任务失败:', err)
      pushSystemMessage?.('error', `已完成：本次报表任务已结束\n进行中：未开始生成\n下一步：请重试提交任务\n原因：${err.message}`, {
        id: REPORT_STATUS_MSG_ID,
        dedupe: false,
        revealPanel: true,
        persistent: true,
        upsertById: true,
      })
      pushSystemMessage?.('error', err.message)
      setProgressMsg('')
      setStage('template')
      setGenerating(false)
    }
  }, [fileId, selectedKey, withFreshAccessToken, requestJsonWithFallback, domainOverride, customPrompt, pollTaskStatus, largeFileInfo, pushSystemMessage])

  // 默认使用 SSE 同步流（向后兼容），可通过修改此引用切换策略
  const handleGenerate = handleGenerateSSE

  // 监听通知系统中的报表完成事件
  useEffect(() => {
    if (!addListener) return
    const removeListener = addListener((notification) => {
      if (notification?.type === 'report_completed') {
        // 更新历史报表列表，确保刚生成的条目立即可见
        loadReportHistory()
      }
      if (
        notification?.type === 'report_completed' &&
        notification?.payload?.file_id === fileId &&
        asyncTaskId &&
        notification?.payload?.task_id === asyncTaskId
      ) {
        // 报表已完成，使用 SSE 重新加载（缓存命中）
        setAsyncTaskId(null)
        if (taskPollRef.current) {
          clearInterval(taskPollRef.current)
          taskPollRef.current = null
        }
        if (handleGenerateSSERef.current) handleGenerateSSERef.current()
      }
    })
    return removeListener
  }, [addListener, fileId, asyncTaskId, loadReportHistory])

  // 清理轮询定时器
  useEffect(() => {
    return () => {
      if (taskPollRef.current) {
        clearInterval(taskPollRef.current)
        taskPollRef.current = null
      }
    }
  }, [])

  const handleQuickDomainRegenerate = useCallback(async (domainKey) => {
    setDomainQuickLoading(domainKey)
    setDomainOverride(domainKey)
    try {
      await handleGenerate(domainKey)
    } finally {
      setTimeout(() => setDomainQuickLoading(''), 600)
    }
  }, [handleGenerate])

  const waitForExportReady = useCallback(async (mode = 'pdf') => {
    setExportTheme('light')
    setExportMode(mode)
    await new Promise((r) => setTimeout(r, 900))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }, [])

  const resetExportTheme = useCallback(() => {
    setExportTheme('dark')
    setExportMode('screen')
  }, [])

  const addCanvasPagedToPdf = useCallback((pdf, canvas, isFirstPageRef, layoutRef) => {
    const pageW = pdf.internal.pageSize.getWidth()
    const pageH = pdf.internal.pageSize.getHeight()
    const margin = 7
    const contentW = pageW - margin * 2
    const contentH = pageH - margin * 2
    const blockGap = 2
    const naturalImgH = (canvas.height / canvas.width) * contentW
    const remainH = margin + contentH - layoutRef.currentY

    const ensureNewPage = () => {
      if (!isFirstPageRef.current) {
        pdf.addPage()
      }
      isFirstPageRef.current = false
      layoutRef.currentY = margin
    }

    const drawAtCurrentPage = (drawW, drawH) => {
      const imgData = canvas.toDataURL('image/png')
      const drawX = margin + (contentW - drawW) / 2
      pdf.addImage(imgData, 'PNG', drawX, layoutRef.currentY, drawW, drawH, undefined, 'FAST')
      layoutRef.currentY += drawH + blockGap
    }

    if (naturalImgH <= remainH) {
      drawAtCurrentPage(contentW, naturalImgH)
      isFirstPageRef.current = false
      return
    }

    if (naturalImgH <= contentH) {
      ensureNewPage()
      drawAtCurrentPage(contentW, naturalImgH)
      return
    }

    // 超高区块按整块缩放到单页，避免单个区块被拆页
    ensureNewPage()
    const fitScale = contentH / naturalImgH
    const drawW = contentW * fitScale
    drawAtCurrentPage(drawW, contentH)
  }, [])

  // 导出 PDF
  const handleExportPDF = useCallback(async () => {
    const el = canvasRef.current
    if (!el) return
    setExportingPDF(true)
    try {
      await waitForExportReady('pdf')
      const html2canvas = (await import('html2canvas')).default
      const { default: jsPDF } = await import('jspdf')

      const sections = el.querySelectorAll('[data-export-block="true"]')
      const pdf = new jsPDF('p', 'mm', 'a4')
      const isFirstPageRef = { current: true }
      const layoutRef = { currentY: 7 }

      for (const section of sections) {
        const canvas = await html2canvas(section, {
          scale: 2,
          backgroundColor: '#FFFFFF',
          useCORS: true,
          logging: false,
          windowWidth: Math.max(1440, document.documentElement.clientWidth || 1440),
        })
        addCanvasPagedToPdf(pdf, canvas, isFirstPageRef, layoutRef)
      }

      pdf.save(`${report?.title || '报表'}.pdf`)
    } catch (err) {
      console.error('PDF 导出失败:', err)
    } finally {
      resetExportTheme()
      setExportingPDF(false)
    }
  }, [report, waitForExportReady, resetExportTheme, addCanvasPagedToPdf])

  // 导出 PNG
  const handleExportPNG = useCallback(async () => {
    const el = canvasRef.current
    if (!el) return
    setExportingPNG(true)
    try {
      await waitForExportReady('png')
      const html2canvas = (await import('html2canvas')).default
      const exportWidth = Math.max(el.scrollWidth || 0, el.offsetWidth || 0, el.clientWidth || 0)
      const exportHeight = Math.max(el.scrollHeight || 0, el.offsetHeight || 0, el.clientHeight || 0)
      const canvas = await html2canvas(el, {
        scale: 2,
        backgroundColor: '#FFFFFF',
        useCORS: true,
        logging: false,
        width: exportWidth,
        height: exportHeight,
        windowWidth: Math.max(1440, exportWidth, document.documentElement.clientWidth || 0),
        windowHeight: Math.max(exportHeight, document.documentElement.clientHeight || 0),
        scrollX: 0,
        scrollY: 0,
        onclone: (doc) => {
          // 导出时确保外层容器不裁剪内容，避免长页面被截断
          const clonedCanvas = doc.querySelector('.report-canvas')
          if (clonedCanvas) {
            clonedCanvas.style.overflow = 'visible'
            clonedCanvas.style.height = 'auto'
            clonedCanvas.style.maxHeight = 'none'
          }
          const clonedContent = doc.querySelector('.report-content')
          if (clonedContent) {
            clonedContent.style.overflow = 'visible'
            clonedContent.style.height = 'auto'
            clonedContent.style.maxHeight = 'none'
          }
        },
      })
      const link = document.createElement('a')
      link.download = `${report?.title || '报表'}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err) {
      console.error('PNG 导出失败:', err)
    } finally {
      resetExportTheme()
      setExportingPNG(false)
    }
  }, [report, waitForExportReady, resetExportTheme])

  // 分享
  const handleShare = useCallback(async () => {
    if (!report?.report_id) return
    setSharingLoading(true)
    setNotice('')
    try {
      const result = await withFreshAccessToken(async (token) => {
        const sourceFileId =
          largeFileInfo?.source_file_id ||
          largeFileInfo?.user_file_id ||
          report?.source_file_id ||
          null
        return requestJsonWithFallback(`/api/report/${report.report_id}/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_file_id: sourceFileId,
            report_data: {
              ...report,
              source_file_id: sourceFileId,
            },
          }),
        }, token)
      })
      setShareToken(result.share_token)
      setShareDialogOpen(true)
    } catch (err) {
      console.error('分享失败:', err)
      const candidates = getApiCandidates().join(' 或 ')
      const msg = err?.message?.includes('Failed to fetch')
        ? `分享失败：无法连接报表接口。已尝试：${candidates}/api/report`
        : `分享失败：${err?.message || '未知错误'}`
      setNotice(msg)
    } finally {
      setSharingLoading(false)
    }
  }, [report, largeFileInfo, baseUrl, withFreshAccessToken, requestJsonWithFallback, getApiCandidates])

  useEffect(() => {
    const onReportAction = (event) => {
      const action = event?.detail?.action
      if (!action) return
      if (action === 'back_home') handleBackToHome()
      else if (action === 'reanalyze') handleReinitialize()
      else if (action === 'template') {
        if (stage === 'home') handleStartFromCurrentFile()
        else setStage('template')
      }
      else if (action === 'generate') {
        if (stage === 'home') handleStartFromCurrentFile()
        else handleGenerate()
      }
      else if (action === 'generate_async') handleGenerateAsync()
      else if (action === 'export_pdf') handleExportPDF()
      else if (action === 'export_png') handleExportPNG()
      else if (action === 'share') handleShare()
    }
    window.addEventListener('report:view-action', onReportAction)
    return () => window.removeEventListener('report:view-action', onReportAction)
  }, [stage, handleStartFromCurrentFile, handleBackToHome, handleReinitialize, handleGenerate, handleGenerateAsync, handleExportPDF, handleExportPNG, handleShare])

  useEffect(() => {
    const detail = reportViewState()
    detail.customPrompt = customPrompt
    window.dispatchEvent(new CustomEvent('report:view-state', { detail }))
  }, [reportViewState, customPrompt])

  useEffect(() => {
    const onCustomPrompt = (e) => {
      const prompt = e?.detail?.prompt
      if (!prompt || typeof prompt !== 'string') return
      const trimmed = prompt.trim().slice(0, 500)
      if (!trimmed) return
      setCustomPrompt(trimmed)
      handleGenerate(domainOverride, trimmed)
    }
    window.addEventListener('report:custom-prompt', onCustomPrompt)
    return () => window.removeEventListener('report:custom-prompt', onCustomPrompt)
  }, [handleGenerate, domainOverride])

  return (
    <div className="report-view">
      {/* 主内容区。 */}
      <div className="report-content">
        <div className="report-content-inner">
        {notice && <div className="report-inline-notice">{notice}</div>}
        {!canUseCurrentFile && (
          <div className="report-empty-file-hint">
            <div className="view-title-row">
              <h3 className="report-empty-file-title">数据报表</h3>
              {!duckdbInitLoading && (
                <button className="view-start-action-btn" onClick={() => onQuickStart?.()}>
                  点击开始
                </button>
              )}
            </div>
            <p className="report-empty-file-desc">
              基于 Excel 数据智能生成专业分析报表，一键生成可导出、可分享的报表结果
            </p>
            {duckdbInitLoading ? (
              <p className="report-empty-file-note" style={{ color: '#34D399' }}>
                <Loader2 size={14} className="animate-spin" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
                {duckdbLoadingMessage || '正在加载文件到内存...'}
              </p>
            ) : (
              <p className="report-empty-file-note">
                请先在左侧文件树选择需要分析的文件
              </p>
            )}
          </div>
        )}
        {canUseCurrentFile && (
          <>
          <PlatformViewToolbar variant="reportCard" />
          <div className="report-domain-quickbar">
            <span className="report-domain-quickbar-label">解读语境：</span>
            {[
              { key: 'retail', label: '零售/电商' },
              { key: 'manufacturing', label: '制造/供应链' },
              { key: 'finance', label: '财务/经营' },
              { key: 'general', label: '通用业务' },
            ].map((item) => (
              <button
                key={item.key}
                className={`report-domain-quick-btn ${domainOverride === item.key ? 'active' : ''}`}
                disabled={generating || initLoading || domainQuickLoading === item.key}
                onClick={() => handleQuickDomainRegenerate(item.key)}
                title={`按${item.label}语境重新生成图表解读`}
              >
                {domainQuickLoading === item.key ? '处理中...' : item.label}
              </button>
            ))}
            <button
              className={`report-domain-quick-btn ${domainOverride === 'auto' ? 'active' : ''}`}
              disabled={generating || initLoading}
              onClick={() => setDomainOverride('auto')}
              title="恢复自动识别行业"
            >
              自动识别
            </button>
          </div>
          </>
        )}
        {stage === 'loading' && (
          <div className="report-loading">
            <Loader2 size={32} className="animate-spin" />
            <p>{duckdbInitLoading ? duckdbLoadingMessage : (initLoading ? '正在分析数据结构...' : '正在加载...')}</p>
          </div>
        )}

        {stage === 'template' && (
          <div className="report-template-stage">
            {templates?.length ? (
              <TemplateSelector
                templates={templates}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
                loading={generating}
              />
            ) : (
              <div className="report-template-loading">
                <Loader2 size={32} className="animate-spin" />
                <p>{fileId ? '正在分析数据结构...' : '正在加载文件到内存...'}</p>
              </div>
            )}
            <div className="report-generate-actions">
              <button
                className="report-generate-btn"
                onClick={() => handleGenerate()}
                disabled={!fileId || !selectedKey || generating || initLoading}
              >
                {generating ? <Loader2 size={18} className="animate-spin" /> : null}
                生成报表
              </button>
              <button
                className="report-generate-btn report-generate-async-btn"
                onClick={() => handleGenerateAsync()}
                disabled={!fileId || !selectedKey || generating || initLoading}
                title="提交后台任务，生成完成后通知您"
              >
                后台生成
              </button>
            </div>
          </div>
        )}

        {(stage === 'home' || stage === 'template' || (fileId == null && onPrepareFromSelectedFile)) && (
          <ReportHistoryPanel
            reports={historyReports}
            loading={historyLoading}
            actionLoading={historyActionLoading}
            onRefresh={loadReportHistory}
            onOpenReport={handleOpenHistoryReport}
            onDeleteReport={handleDeleteHistoryReport}
          />
        )}

        {stage === 'generating' && (
          <div className="report-generating">
            <Loader2 size={32} className="animate-spin" />
            <p className="report-progress-msg">{progressMsg}</p>
            {asyncTaskId && (
              <p className="report-async-hint">
                报表正在后台生成，您可以切换到其他视图继续工作。完成后将通过铃铛通知您。
              </p>
            )}
            {report?.kpis && (
              <div className="report-preview-partial">
                <ReportCanvas report={report} ref={canvasRef} exportTheme={exportTheme} exportMode={exportMode} />
              </div>
            )}
          </div>
        )}

        {stage === 'completed' && report && (
          <div className="report-completed">
            <ReportCanvas report={report} ref={canvasRef} exportTheme={exportTheme} exportMode={exportMode} />
          </div>
        )}

        {stage === 'error' && (
          <div className="report-error">
            <p>{progressMsg || '报表生成失败'}</p>
            <button className="report-retry-btn" onClick={() => setStage('template')}>
              重新选择模板
            </button>
          </div>
        )}
        </div>
      </div>

      <ShareDialog
        isOpen={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        shareToken={shareToken}
      />
    </div>
  )
}
