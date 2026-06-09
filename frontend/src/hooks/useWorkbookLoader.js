import { useCallback } from 'react'
import * as filesApi from '../api/files'
import { loadXlsxWithChartFallback } from '../utils/excelChartImportFallback'
import { exceljsToWorkbook } from '../utils/excelImport'

/**
 * 统一封装"从左侧文件树加载工作簿"流程，避免 App 内重复分支。
 */
export function useWorkbookLoader({
  accessToken,
  isLargeFileUploading,
  isGridDataLoading,
  withFreshAccessToken,
  prepareSelectedFileForLargeMode,
  getWorkbookMaxRowCount,
  largeFileAutoAnalyzeSizeBytes,
  largeFileAutoAnalyzeRowThreshold,
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
  largeFileMode = false,
  largeFileInfo = null,
  onChartsDegraded = null,
}) {
  return useCallback(async (fileNode, options = {}) => {
    const { preservePlatformView = false, skipAutoAnalyze = false, silentBusy = false } = options
    if (!fileNode?.id || !accessToken) return

    if (isLargeFileUploading || isGridDataLoading) {
      if (!silentBusy) {
        pushSystemMessage('warning', '当前文件正在处理中，请等待加载完成后再切换文件。')
      }
      return
    }

    const currentLargeFileId = largeFileInfo?.user_file_id || largeFileInfo?.source_file_id
    const isSwitchingInAnalyzeMode = largeFileMode && preservePlatformView && fileNode.id !== currentLargeFileId

    if (isSwitchingInAnalyzeMode) {
      setSelectedSidebarFile(fileNode)
      // 切换了文件，旧的普通模式快照不再有效
      normalModeSnapshotRef.current = null
      await prepareSelectedFileForLargeMode('analyze', fileNode)
      return
    }

    try {
      setIsGridDataLoading(true)

      const fileSize = Number(fileNode.file_size || fileNode.size || 0)
      if (!skipAutoAnalyze && fileSize >= largeFileAutoAnalyzeSizeBytes) {
        pushSystemMessage('warning', `检测到超大文件（${Math.round(fileSize / 1024 / 1024)}MB），已自动切换到"数据分析"以保证性能。`)
        setSelectedSidebarFile(fileNode)
        await prepareSelectedFileForLargeMode('analyze', fileNode)
        return
      }

      const blob = await withFreshAccessToken((token) => filesApi.downloadFile(token, fileNode.id))
      const arrayBuffer = await blob.arrayBuffer()
      const ExcelJS = await import('exceljs')
      const excelWb = new ExcelJS.Workbook()
      const chartsDegraded = await loadXlsxWithChartFallback(excelWb, arrayBuffer)

      const maxRows = getWorkbookMaxRowCount(excelWb)
      if (!skipAutoAnalyze && maxRows >= largeFileAutoAnalyzeRowThreshold) {
        pushSystemMessage('warning', `检测到工作表最大行数约 ${maxRows.toLocaleString()}，已自动切换到"数据分析"以避免普通视图卡顿。`)
        setSelectedSidebarFile(fileNode)
        await prepareSelectedFileForLargeMode('analyze', fileNode)
        return
      }

      const nextWorkbook = exceljsToWorkbook(excelWb)
      const nextActiveSheet = nextWorkbook.activeSheet || nextWorkbook.sheets?.[0]?.name || 'Sheet1'
      setWorkbook(nextWorkbook)
      setActiveSheet(nextActiveSheet)
      setSelectedSidebarFile(fileNode)
      setCurrentFileName((fileNode.file_name || fileNode.name || '').replace(/\.[^/.]+$/, ''))
      setHistory([JSON.stringify(nextWorkbook)])
      setHistoryIndex(0)
      lastSavedSnapshotRef.current = JSON.stringify(nextWorkbook)
      setSaveStatus('idle')

      if (!preservePlatformView) {
        setPlatformView('normal')
        setLargeFileMode(false)
        setLargeFileInfo(null)
        setLargeFilePreview(null)
        setResultFiles([])
        normalModeSnapshotRef.current = null
      }

      if (chartsDegraded && typeof onChartsDegraded === 'function') {
        onChartsDegraded()
      }
    } catch (error) {
      pushSystemMessage('error', `打开文件失败: ${error.message}`)
    } finally {
      setIsGridDataLoading(false)
    }
  }, [
    accessToken,
    isLargeFileUploading,
    isGridDataLoading,
    withFreshAccessToken,
    prepareSelectedFileForLargeMode,
    getWorkbookMaxRowCount,
    largeFileAutoAnalyzeSizeBytes,
    largeFileAutoAnalyzeRowThreshold,
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
    onChartsDegraded,
  ])
}
