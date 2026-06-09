import { useCallback, useEffect, useRef } from 'react'
import {
  CHART_REGEN_AFTER_IMPORT_COMMAND,
  CHART_REGEN_SKIP_MESSAGE,
  CHART_REGEN_STATUS_MESSAGE,
} from '../utils/excelChartImportFallback'

const REGEN_READY_DELAY_MS = 400
const REGEN_WAIT_TIMEOUT_MS = 45000

/**
 * 图表导入降级后：打开 AI 面板并自动发送「智能分析 + 出图」指令。
 */
export function useChartRegenAfterImport({
  largeFileMode,
  platformView,
  isConnected,
  isReady,
  isAiProcessing,
  workbook,
  handleSendCommand,
  setAiPanelOpen,
  pushSystemMessage,
}) {
  const pendingRef = useRef(false)
  const startedAtRef = useRef(0)

  const requestChartRegenAfterImport = useCallback(() => {
    pendingRef.current = true
    startedAtRef.current = Date.now()
    setAiPanelOpen(true)
    pushSystemMessage('status', CHART_REGEN_STATUS_MESSAGE)
  }, [setAiPanelOpen, pushSystemMessage])

  const cancelChartRegen = useCallback(() => {
    pendingRef.current = false
    startedAtRef.current = 0
  }, [])

  useEffect(() => {
    if (!pendingRef.current) return

    if (largeFileMode || platformView !== 'normal') {
      cancelChartRegen()
      return
    }

    const elapsed = Date.now() - (startedAtRef.current || 0)
    if (elapsed > REGEN_WAIT_TIMEOUT_MS) {
      pendingRef.current = false
      pushSystemMessage('warning', CHART_REGEN_SKIP_MESSAGE)
      return
    }

    if (!workbook?.sheets?.length || !isConnected || !isReady || isAiProcessing) {
      return
    }

    pendingRef.current = false
    const timer = setTimeout(() => {
      handleSendCommand(CHART_REGEN_AFTER_IMPORT_COMMAND)
    }, REGEN_READY_DELAY_MS)

    return () => clearTimeout(timer)
  }, [
    workbook,
    isConnected,
    isReady,
    isAiProcessing,
    largeFileMode,
    platformView,
    handleSendCommand,
    pushSystemMessage,
    cancelChartRegen,
  ])

  return { requestChartRegenAfterImport, cancelChartRegen }
}
