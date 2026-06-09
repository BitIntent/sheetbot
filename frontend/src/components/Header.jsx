// frontend/src/components/Header.jsx
/**
 * ============================================================================
 * 顶部头部栏组件 - Airtable 风格
 * - 视图切换 + 右侧工具（合并为一行）
 * - 操作栏（编辑/格式/数据/下载等）
 * ============================================================================
 */
import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import HeaderTopRow from './header/HeaderTopRow'
import HeaderActionBar from './header/HeaderActionBar'
import { PLATFORM_VIEWS_WITH_INLINE_TOOLBAR } from './PlatformViewToolbar'

function Header({
  activeSheet,
  onInsertRow,
  onFilter,
  onSort,
  onSortCurrentAsc,
  onSortExtAsc,
  onSortCurrentDesc,
  onSortExtDesc,
  onSortCustom,
  onSetRowHeight,
  onFindReplace,
  onOpenFormulaManager,
  onToggleAI,
  aiPanelOpen,
  onUndo, onRedo, canUndo, canRedo,
  onCut, onCopy, onPaste, canPaste,
  formatBrushActive, onFormatBrush,
  onSave,
  onAnalyzeDownload,
  onManualSave,
  canManualSave,
  saveStatus = 'idle',
  onRefreshAnalyzeStatus,
  onOpenAnalyzeSqlBuilder,
  onFormatChange,
  largeFileMode,
  largeFileInfo,
  isLargeFileUploading,
  onSwitchNormalView,
  onEnterAnalyzeView,
  onEnterReportView,
  isConnected,
  // 平台视图
  platformView = 'normal',
  onPlatformViewChange,
  // 内存面板
  analyzeFileId,
  apiBaseUrl,
  accessToken: headerAccessToken,
  onSessionCleared,
  onAnalyzePrevPage,
  onAnalyzeNextPage,
  canAnalyzePrevPage = false,
  canAnalyzeNextPage = false,
  analyzePageLabel = '第 1/1 页',
  // 工作表缩放（普通视图 & 我要分析）
  sheetZoom = 1,
  onSheetZoomChange,
  embedUniverRibbon = false,
  onOpenUniverMoreFunctions,
  onInsertUniverFunction,
  onInsertChart,
}) {
  const { logout } = useAuth()
  const [reportActionState, setReportActionState] = useState({
    canReanalyze: true,
    canTemplate: false,
    canGenerate: false,
    canExport: false,
    canShare: false,
  })
  const tabsContainerRef = useRef(null)
  const activeTabRefs = useRef({})

  const activeViewKey = platformView || (largeFileMode ? 'analyze' : 'normal')

  const emitReportAction = useCallback((action) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('report:view-action', { detail: { action } }))
  }, [])

  const emitPresentationAction = useCallback((action) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('presentationAction', { detail: { action } }))
  }, [])

  const emitCollectAction = useCallback((action) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('collect:view-action', { detail: { action } }))
  }, [])

  const emitConnectAction = useCallback((action) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('connect:view-action', { detail: { action } }))
  }, [])

  const emitBatchWordAction = useCallback((action) => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent('batch-word:view-action', { detail: { action } }))
  }, [])

  useEffect(() => {
    const onReportState = (event) => {
      const next = event?.detail || {}
      setReportActionState((prev) => ({
        ...prev,
        canReanalyze: !!next.canReanalyze,
        canTemplate: !!next.canTemplate,
        canGenerate: !!next.canGenerate,
        canExport: !!next.canExport,
        canShare: !!next.canShare,
      }))
    }
    window.addEventListener('report:view-state', onReportState)
    return () => window.removeEventListener('report:view-state', onReportState)
  }, [])

  // ===== 平台视图切换 =====
  const handleViewClick = useCallback((viewKey) => {
    if (viewKey === 'normal') {
      onSwitchNormalView?.()
    } else if (viewKey === 'analyze') {
      onEnterAnalyzeView?.()
    } else if (viewKey === 'reportCard') {
      onEnterReportView?.()
    } else {
      // 我要汇报、我要报表、我要收集、我要连接、我要分享
      onPlatformViewChange?.(viewKey)
    }
  }, [onSwitchNormalView, onEnterAnalyzeView, onEnterReportView, onPlatformViewChange])

  return (
    <>
      <div
        className={`airtable-header${
          PLATFORM_VIEWS_WITH_INLINE_TOOLBAR.has(platformView) ? ' airtable-header--nav-only' : ''
        }`}
      >
        <HeaderTopRow
          tabsContainerRef={tabsContainerRef}
          activeTabRefs={activeTabRefs}
          activeViewKey={activeViewKey}
          onViewClick={handleViewClick}
          onToggleAI={onToggleAI}
          aiPanelOpen={aiPanelOpen}
          onLogout={() => logout().then(() => { window.location.href = '/' })}
          largeFileInfo={largeFileInfo}
          isLargeFileUploading={isLargeFileUploading}
        />

        <HeaderActionBar
          embedUniverRibbon={embedUniverRibbon}
          onOpenUniverMoreFunctions={onOpenUniverMoreFunctions}
          onInsertUniverFunction={onInsertUniverFunction}
          platformView={platformView}
          largeFileInfo={largeFileInfo}
          onRefreshAnalyzeStatus={onRefreshAnalyzeStatus}
          onOpenAnalyzeSqlBuilder={onOpenAnalyzeSqlBuilder}
          canAnalyzePrevPage={canAnalyzePrevPage}
          onAnalyzePrevPage={onAnalyzePrevPage}
          canAnalyzeNextPage={canAnalyzeNextPage}
          onAnalyzeNextPage={onAnalyzeNextPage}
          analyzePageLabel={analyzePageLabel}
          onAnalyzeDownload={onAnalyzeDownload}
          analyzeFileId={analyzeFileId}
          apiBaseUrl={apiBaseUrl}
          headerAccessToken={headerAccessToken}
          onSessionCleared={onSessionCleared}
          sheetZoom={sheetZoom}
          onSheetZoomChange={onSheetZoomChange}
          reportActionState={reportActionState}
          emitReportAction={emitReportAction}
          emitPresentationAction={emitPresentationAction}
          emitCollectAction={emitCollectAction}
          emitConnectAction={emitConnectAction}
          emitBatchWordAction={emitBatchWordAction}
          onUndo={onUndo}
          onRedo={onRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          onManualSave={onManualSave}
          canManualSave={canManualSave}
          saveStatus={saveStatus}
          onCut={onCut}
          onCopy={onCopy}
          onPaste={onPaste}
          canPaste={canPaste}
          formatBrushActive={formatBrushActive}
          onFormatBrush={onFormatBrush}
          onFormatChange={onFormatChange}
          onInsertRow={onInsertRow}
          onFilter={onFilter}
          onSort={onSort}
          onSortCurrentAsc={onSortCurrentAsc}
          onSortExtAsc={onSortExtAsc}
          onSortCurrentDesc={onSortCurrentDesc}
          onSortExtDesc={onSortExtDesc}
          onSortCustom={onSortCustom}
          onSetRowHeight={onSetRowHeight}
          onFindReplace={onFindReplace}
          onOpenFormulaManager={onOpenFormulaManager}
          onInsertChart={onInsertChart}
          onSave={onSave}
        />
      </div>
    </>
  )
}

export default React.memo(Header)
