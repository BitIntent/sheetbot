// ============================================================================
// "我要汇报" 主入口组件
// 状态机: home -> template -> generating -> editor / screening
// editor 阶段使用 PPTist 专业编辑器（通过 veaury 桥接）
// ============================================================================
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import appConfig from '../../config/appConfig'
import { useAuth } from '../../contexts/AuthContext'
import useDuckdbPreparation from '../../hooks/useDuckdbPreparation'
import TemplateGallery from './TemplateGallery'
import HistoryPanel from './HistoryPanel'
import PPTistBridge from './PPTistBridge'
import PlatformViewToolbar from '../PlatformViewToolbar'
import { PPTIST_TEMPLATE_OPTIONS } from '../../constants/pptistTemplateOptions'

// 兼容历史后端 key -> PPTist 模板文件
const BACKEND_TO_PPTIST_TEMPLATE = {
  business_blue: 'template_1',
  tech_dark: 'template_2',
  minimal_white: 'template_3',
  forest_green: 'template_4',
  vibrant_orange: 'template_5',
  premium_gray: 'template_6',
  china_red: 'template_7',
  starry_purple: 'template_8',
  fresh_cyan: 'template_1',
  dark_gold: 'template_2',
}
const PRESENTATION_STATUS_MSG_ID = 'presentation-generate-status'

function buildPresentationProgressText(stage, rawMessage, progress) {
  const pct = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : null
  const message = String(rawMessage || '').trim()
  const pctText = pct === null ? '' : `（${Math.round(pct)}%）`
  const stageOrder = ['planning', 'querying', 'building', 'saving']
  const stageMeta = {
    planning: {
      done: '已完成：已接收你的汇报需求',
      doing: '进行中：正在理解表格内容并规划汇报结构',
      next: '下一步：提取关键指标并组织图表素材',
    },
    querying: {
      done: '已完成：汇报结构规划完成',
      doing: '进行中：正在提取关键数据并整理图表内容',
      next: '下一步：组装页面并生成汇报文件',
    },
    building: {
      done: '已完成：核心数据与图表已准备完成',
      doing: '进行中：正在生成演示文稿页面',
      next: '下一步：保存并打开可编辑版本',
    },
    saving: {
      done: '已完成：汇报页面已生成',
      doing: '进行中：正在保存汇报文件并准备编辑',
      next: '下一步：打开编辑器供你继续调整',
    },
  }

  if (stageMeta[stage]) {
    const currentIndex = stageOrder.indexOf(stage)
    const doneStages = stageOrder.slice(0, currentIndex)
    const doneText = doneStages.length > 0
      ? `已完成：${doneStages.map((s) => stageMeta[s]?.doing?.replace(/^进行中：/, '')).filter(Boolean).join('、')}`
      : stageMeta[stage].done
    return `${doneText}\n${stageMeta[stage].doing}${pctText}\n${stageMeta[stage].next}`
  }

  // 兜底：仅复用安全消息，避免将技术栈关键词透出到助手窗口
  if (message) {
    const safeMessage = message
      .replace(/duckdb/gi, '数据引擎')
      .replace(/sql/gi, '查询')
      .replace(/sse/gi, '流式进度')
      .replace(/pptx/gi, '汇报文件')
    const safeWithPct = pct === null ? safeMessage : `${safeMessage}${pctText}`
    return `已完成：需求已受理\n进行中：${safeWithPct}\n下一步：继续汇总并生成可编辑汇报`
  }
  return `已完成：需求已受理\n进行中：正在处理汇报生成任务${pctText}\n下一步：生成并打开可编辑汇报`
}

export default function PresentationView({
  fileId,
  largeFileInfo,
  isPreparing = false,
  onClose,
  onPrepareFromSelectedFile,
  setAiMessages,
  pushSystemMessage,
  onQuickStart,
}) {
  const { withFreshAccessToken, user } = useAuth()
  const editorRef = useRef(null)

  const getApiBaseUrl = useCallback(() => {
    const configured = appConfig.apiBaseUrl || ''
    if (configured) return configured.replace(/\/$/, '')
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/$/, '')
    }
    return ''
  }, [])
  const baseUrl = getApiBaseUrl()

  // ── 核心状态 ──
  const [stage, setStage] = useState('home')
  const [templates, setTemplates] = useState(PPTIST_TEMPLATE_OPTIONS)
  const [selectedKey, setSelectedKey] = useState('')
  const [generating, setGenerating] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')
  const [progressPct, setProgressPct] = useState(0)
  const [pptistSlides, setPptistSlides] = useState(null)
  const [slideIndex, setSlideIndex] = useState(0)
  const [screening, setScreening] = useState(false)
  const [isSavingSlides, setIsSavingSlides] = useState(false)
  const [pptxId, setPptxId] = useState(null)
  const [pptxTitle, setPptxTitle] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')

  // 二阶段注入缓存（SSE 返回后暂存，编辑器就绪后执行注入）
  const pendingAipptRef = useRef(null)

  const [historyList, setHistoryList] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const templateCacheRef = useRef({})
  const lastProgressNoticeRef = useRef({ stage: '', pct: -1, text: '' })

  const canUseCurrentFile = !!fileId
  const isMemoryReady = !!largeFileInfo?.duckdb_ready && !isPreparing
  const canGeneratePresentation = canUseCurrentFile && isMemoryReady && !!selectedKey

  // ── API 请求封装 ──
  const apiRequest = useCallback(async (path, init = {}) => {
    return withFreshAccessToken(async (accessToken) => {
      const url = `${baseUrl}${path}`
      const headers = {
        ...(init?.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      }
      if (init?.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json'
      }
      const res = await fetch(url, {
        ...init,
        headers,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const detail = body?.detail
        const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
        const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || `HTTP ${res.status}`))
        const err = new Error(msg)
        err.status = res.status
        err.isQuota = isQuota
        throw err
      }
      return res
    })
  }, [baseUrl, withFreshAccessToken])

  // ── 加载模板列表 ──
  const loadTemplates = useCallback(async () => {
    setTemplates(PPTIST_TEMPLATE_OPTIONS)
    setSelectedKey((prev) => prev || PPTIST_TEMPLATE_OPTIONS[0].key)
  }, [])

  // ── 加载历史列表 ──
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await apiRequest('/api/pptx/list')
      const data = await res.json()
      setHistoryList(data?.items || data || [])
    } catch (err) {
      console.error('加载汇报历史失败:', err)
    } finally {
      setHistoryLoading(false)
    }
  }, [apiRequest])

  // ── 初始化 ──
  useEffect(() => {
    loadTemplates()
    loadHistory()
  }, [loadTemplates, loadHistory])

  const loadTemplateSlides = useCallback(async (templateKey) => {
    const tplFile = BACKEND_TO_PPTIST_TEMPLATE[templateKey] || templateKey || selectedKey || 'template_1'
    if (templateCacheRef.current[tplFile]) return templateCacheRef.current[tplFile]

    const url = `./mocks/pptist/${tplFile}.json`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`模板加载失败(${res.status})`)
    }
    const payload = await res.json()
    const slides = payload.slides || payload || []
    const theme = payload.theme || null
    const result = { slides, theme }
    templateCacheRef.current[tplFile] = result
    return result
  }, [selectedKey])

  const { duckdbInitLoading, duckdbLoadingMessage } = useDuckdbPreparation({
    fileId,
    isPreparing,
    onPrepareFromSelectedFile,
    setStage,
    loadingStage: 'loading',
    preparingMessage: '正在准备数据环境，请稍候...',
    checkingMessage: '正在检查并加载当前活动文件...',
  })

  useEffect(() => {
    if (fileId) setStage('template')
    else if (!duckdbInitLoading) setStage('home')
  }, [fileId, duckdbInitLoading])

  // ── SSE 流式生成 ──
  const handleGenerate = useCallback(async () => {
    if (!fileId || !selectedKey || !isMemoryReady) {
      setProgressMsg('数据尚未完成内存加载，请稍候再生成汇报。')
      return
    }
    setGenerating(true)
    setProgressMsg('AI 正在规划汇报结构...')
    setProgressPct(5)
    setStage('generating')
    lastProgressNoticeRef.current = { stage: '', pct: -1, text: '' }
    pushSystemMessage?.('status', '已开始生成汇报，我会持续同步处理进度。', {
      id: PRESENTATION_STATUS_MSG_ID,
      dedupe: false,
      revealPanel: true,
      persistent: true,
      upsertById: true,
    })

    try {
      const url = `${baseUrl}/api/pptx/generate`
      const userFileId = largeFileInfo?.user_file_id || largeFileInfo?.source_file_id || null
      const body = JSON.stringify({
        analysis_file_id: fileId,
        user_file_id: userFileId,
        file_id: fileId,
        template_key: selectedKey,
        custom_prompt: customPrompt,
      })

      const res = await withFreshAccessToken(async (accessToken) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body,
        })
        // 让 withFreshAccessToken 能识别 401 并触发刷新重试
        if (response.status === 401) {
          const authError = new Error('HTTP 401')
          authError.status = 401
          throw authError
        }
        return response
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        const detail = errBody?.detail
        const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
        const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || `HTTP ${res.status}`))
        throw new Error(msg)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (!raw || raw === '[DONE]') continue

          try {
            const evt = JSON.parse(raw)
            if (evt.event === 'progress') {
              const stageName = String(evt.data?.stage || '')
              const progressValue = Number(evt.data?.progress || 0)
              const uiText = String(evt.data?.message || '')
              setProgressMsg(uiText)
              setProgressPct(progressValue)

              const noticeText = buildPresentationProgressText(stageName, uiText, progressValue)
              const prev = lastProgressNoticeRef.current
              const stageChanged = prev.stage !== stageName
              const textChanged = prev.text !== noticeText
              const pctIncreasedEnough = progressValue >= (prev.pct + 8)
              // ── 进度消息节流策略 ──
              // 1) 阶段切换立刻播报
              // 2) 文案变化立刻播报
              // 3) 同阶段按 8% 增量播报，避免刷屏
              if (stageChanged || textChanged || pctIncreasedEnough) {
                pushSystemMessage?.('status', noticeText, {
                  id: PRESENTATION_STATUS_MSG_ID,
                  dedupe: false,
                  revealPanel: true,
                  persistent: true,
                  upsertById: true,
                })
                lastProgressNoticeRef.current = { stage: stageName, pct: progressValue, text: noticeText }
              }
            } else if (evt.event === 'complete') {
              const d = evt.data || {}
              pushSystemMessage?.('success', '已完成：汇报生成成功\n进行中：正在打开编辑器\n下一步：你可以继续微调并导出', {
                id: PRESENTATION_STATUS_MSG_ID,
                dedupe: false,
                revealPanel: true,
                persistent: true,
                upsertById: true,
              })
              setPptxId(d.pptx_id || '')
              setPptxTitle(d.title || '')
              setSlideIndex(0)

              const templateKey = d.template_key || selectedKey
              try {
                const { slides, theme } = await loadTemplateSlides(templateKey)
                pendingAipptRef.current = {
                  aipptSlides: d.aippt_slides || [],
                  dataElements: d.data_elements || [],
                  templateSlides: slides,
                  templateTheme: theme,
                }
                setPptistSlides(slides)
                setStage('editor')
                loadHistory()
              } catch (templateErr) {
                throw new Error(`加载 PPTist 模板失败: ${templateErr.message}`)
              }
            } else if (evt.event === 'error') {
              throw new Error(evt.data?.message || '生成失败')
            }
          } catch (parseErr) {
            if (parseErr.message !== '生成失败') continue
            throw parseErr
          }
        }
      }
    } catch (err) {
      console.error('PPTX 生成失败:', err)
      pushSystemMessage?.('error', `已完成：本次汇报任务已结束\n进行中：未完成\n下一步：请重试，或调整要求后重新生成\n原因：${err.message}`, {
        id: PRESENTATION_STATUS_MSG_ID,
        dedupe: false,
        revealPanel: true,
        persistent: true,
        upsertById: true,
      })
      pushSystemMessage?.('error', err.message)
      setStage('template')
      setProgressMsg('')
    } finally {
      setGenerating(false)
    }
  }, [fileId, selectedKey, isMemoryReady, customPrompt, baseUrl, withFreshAccessToken, loadHistory, loadTemplateSlides, largeFileInfo, pushSystemMessage])

  // ── 二阶段注入：编辑器就绪后加载模板并执行 AIPPT ──
  // runAIPPT 返回 false 表示 Vue 侧尚未就绪，不清除 pending 以便重试
  const tryRunPendingAippt = useCallback(() => {
    const pending = pendingAipptRef.current
    if (!pending) return false
    const { aipptSlides, dataElements, templateSlides, templateTheme } = pending
    if (!templateSlides.length || !editorRef.current?.runAIPPT) return false

    const speakerName = user?.username || user?.email || ''
    const ok = editorRef.current.runAIPPT(templateSlides, aipptSlides, dataElements, undefined, speakerName, templateTheme)
    if (!ok) return false

    pendingAipptRef.current = null
    setProgressMsg('')
    return true
  }, [user])

  const handleSlidesReady = useCallback(() => {
    tryRunPendingAippt()
  }, [tryRunPendingAippt])

  // 兜底重试：veaury ref 可能在 Vue 组件挂载后延迟就绪
  // stage / pptistSlides 变化均触发重试
  useEffect(() => {
    if (stage !== 'editor' || !pendingAipptRef.current) return
    // 立即尝试一次
    if (tryRunPendingAippt()) return
    const timer = setInterval(() => {
      if (tryRunPendingAippt() || !pendingAipptRef.current) {
        clearInterval(timer)
      }
    }, 200)
    return () => clearInterval(timer)
  }, [stage, pptistSlides, tryRunPendingAippt])

  // ── 打开历史汇报 ──
  const handleOpenHistory = useCallback(async (item) => {
    const loadingMsgId = `ppt-loading-${Date.now()}`
    setAiMessages?.(prev => [...prev, {
      id: loadingMsgId,
      type: 'status',
      content: `正在加载汇报「${item.title || '无标题'}」，请稍候...`,
    }])

    try {
      const res = await apiRequest(`/api/pptx/slides/${item.pptx_id}`)
      const data = await res.json()
      const historyTemplateKey = data.template_key || 'template_1'
      const { slides: baseSlides, theme: baseTheme } = await loadTemplateSlides(historyTemplateKey)
      const persistedSlides = Array.isArray(data.pptist_slides) ? data.pptist_slides : []
      if (persistedSlides.length > 0) {
        pendingAipptRef.current = null
        setPptistSlides(persistedSlides)
      } else if (data.aippt_slides?.length) {
        setPptistSlides(baseSlides)
        pendingAipptRef.current = {
          aipptSlides: data.aippt_slides || [],
          dataElements: data.data_elements || [],
          templateSlides: baseSlides,
          templateTheme: baseTheme,
        }
      } else {
        const slides = data.pptist_slides || data.slides || baseSlides || []
        setPptistSlides(slides)
      }
      setPptxId(data.pptx_id)
      setPptxTitle(data.title || '')
      setSlideIndex(0)
      setScreening(false)
      setStage('editor')

      // 加载完成 -> 移除提示
      setAiMessages?.(prev => prev.filter(m => m.id !== loadingMsgId))
    } catch (err) {
      console.error('打开汇报失败:', err)
      setAiMessages?.(prev => prev.filter(m => m.id !== loadingMsgId))
      pushSystemMessage?.('error', `打开汇报失败：${err.message}`)
    }
  }, [apiRequest, loadTemplateSlides, setAiMessages, pushSystemMessage])

  // ── 删除汇报 ──
  const handleDeleteHistory = useCallback(async (pptxIdToDelete) => {
    try {
      await apiRequest(`/api/pptx/${pptxIdToDelete}`, { method: 'DELETE' })
      loadHistory()
    } catch (err) {
      console.error('删除汇报失败:', err)
    }
  }, [apiRequest, loadHistory])

  // ── 返回首页 ──
  const handleBackToHome = useCallback(() => {
    setPptistSlides(null)
    setPptxId(null)
    setScreening(false)
    setProgressMsg('')
    setStage(fileId ? 'template' : 'home')
    loadHistory()
  }, [fileId, loadHistory])

  // ── 下载 PPTX（PPTist 原生 pptxgenjs 导出）──
  const handleExportPptx = useCallback(() => {
    editorRef.current?.openExportDialog?.('pptx')
  }, [])

  // ── 保存编辑结果到后端（持久化）──
  const handleSavePptistSlides = useCallback(async () => {
    if (!pptxId || !pptistSlides?.length || isSavingSlides) return
    try {
      setIsSavingSlides(true)
      setProgressMsg('正在保存...')
      await apiRequest(`/api/pptx/slides/${pptxId}`, {
        method: 'PUT',
        body: JSON.stringify({ pptist_slides: pptistSlides }),
      })
      setProgressMsg('保存成功')
      setTimeout(() => setProgressMsg(''), 1200)
      loadHistory()
    } catch (err) {
      console.error('保存汇报失败:', err)
      pushSystemMessage?.('error', `保存失败: ${err.message}`)
      setProgressMsg('')
    } finally {
      setIsSavingSlides(false)
    }
  }, [apiRequest, pptxId, pptistSlides, loadHistory, isSavingSlides, pushSystemMessage])

  // ── Header 状态通信 ──
  const presentationViewState = useCallback(() => ({
    stage,
    hasSlides: !!pptistSlides && pptistSlides.length > 0,
    currentSlideIdx: slideIndex,
    slideCount: pptistSlides?.length || 0,
    editMode: stage === 'editor',
    canPrevPage: false,
    canNextPage: false,
    canEdit: false,
    canAddSlide: false,
    canDeleteSlide: false,
    canCopySlide: false,
    canMoveUp: false,
    canMoveDown: false,
    canPlay: !!pptistSlides && pptistSlides.length > 0,
    canSave: !!pptxId && !!pptistSlides && pptistSlides.length > 0 && !isSavingSlides,
    canExport: !!pptistSlides && pptistSlides.length > 0,
    canShare: !!pptxId,
    pageLabel: '',
  }), [stage, pptistSlides, slideIndex, pptxId, isSavingSlides])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('presentationSaveState', {
      detail: { saving: isSavingSlides },
    }))
  }, [isSavingSlides])

  const handlePresentationAction = useCallback((action) => {
    switch (action) {
      case 'back_home':
        handleBackToHome()
        break
      case 'play':
        setScreening(true)
        editorRef.current?.startScreening?.()
        break
      case 'save':
        handleSavePptistSlides()
        break
      case 'export_pptx':
        handleExportPptx()
        break
      default:
        break
    }
  }, [handleBackToHome, handleExportPptx, handleSavePptistSlides])

  useEffect(() => {
    const handler = () => {
      window.__presentationViewState = presentationViewState()
    }
    handler()
    window.addEventListener('presentationStateQuery', handler)
    return () => window.removeEventListener('presentationStateQuery', handler)
  }, [presentationViewState])

  useEffect(() => {
    const handler = (e) => {
      const action = e.detail?.action
      if (action) handlePresentationAction(action)
    }
    window.addEventListener('presentationAction', handler)
    return () => window.removeEventListener('presentationAction', handler)
  }, [handlePresentationAction])

  // ── 渲染 ──

  // DuckDB 加载中
  if (stage === 'loading' || (duckdbInitLoading && !fileId)) {
    return (
      <div className="pres-view">
        <div className="pres-generating">
          <Loader2 size={40} className="pres-spinner" />
          <p className="pres-generating-msg">
            {duckdbLoadingMessage || '正在准备数据环境，请稍候...'}
          </p>
        </div>
      </div>
    )
  }

  // 首页
  if (stage === 'home') {
    return (
      <div className="pres-view">
        <div className="pres-home">
          <div className="pres-home-hero">
            <div className="view-title-row">
              <h1 className="pres-home-title">PPT汇报</h1>
              <button className="view-start-action-btn" onClick={() => onQuickStart?.()}>
                点击开始
              </button>
            </div>
            <p className="pres-home-desc">
              基于 Excel 数据智能生成专业演示文稿，一键创建 PPTX 用于汇报
            </p>
            {!canUseCurrentFile && (
              <p className="pres-home-hint">
                请先在左侧文件树选择需要分析的文件
              </p>
            )}
            {canUseCurrentFile && (
              <button className="pres-btn-primary" onClick={() => setStage('template')}>
                选择模板开始
              </button>
            )}
          </div>
          <HistoryPanel
            items={historyList}
            loading={historyLoading}
            onOpen={handleOpenHistory}
            onDelete={handleDeleteHistory}
            onRefresh={loadHistory}
          />
        </div>
      </div>
    )
  }

  // 模板选择
  if (stage === 'template') {
    return (
      <div className="pres-view">
        <PlatformViewToolbar variant="report" />
        <TemplateGallery
          templates={templates}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          customPrompt={customPrompt}
          onCustomPromptChange={setCustomPrompt}
          onGenerate={handleGenerate}
          canGenerate={canGeneratePresentation}
          generateDisabledHint={!isMemoryReady ? '数据正在加载到内存，完成后可生成' : ''}
          generating={generating}
        />
        <HistoryPanel
          items={historyList}
          loading={historyLoading}
          onOpen={handleOpenHistory}
          onDelete={handleDeleteHistory}
          onRefresh={loadHistory}
        />
      </div>
    )
  }

  // 生成中
  if (stage === 'generating') {
    return (
      <div className="pres-view">
        <PlatformViewToolbar variant="report" />
        <div className="pres-generating">
          <Loader2 size={40} className="pres-spinner" />
          <p className="pres-generating-msg">{progressMsg}</p>
          <div className="pres-progress-bar">
            <div className="pres-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      </div>
    )
  }

  // PPTist 编辑器（核心改造）
  if (stage === 'editor') {
    return (
      <div className="pres-view pres-editor-fullsize">
        <PlatformViewToolbar variant="report" />
        <PPTistBridge
          slides={pptistSlides}
          slideIndex={slideIndex}
          speakerName={user?.username || user?.email || ''}
          screening={screening}
          onSlidesChange={setPptistSlides}
          onSlideIndexChange={setSlideIndex}
          onSlidesReady={handleSlidesReady}
          onExitScreening={() => setScreening(false)}
          onRequestExport={handleExportPptx}
          editorRef={editorRef}
        />
      </div>
    )
  }

  return null
}
