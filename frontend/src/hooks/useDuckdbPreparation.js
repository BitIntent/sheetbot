// frontend/src/hooks/useDuckdbPreparation.js
/**
 * ============================================================================
 * 数据预加载初始化 Hook
 * - 统一“我要报表/我要汇报”的文件预加载触发与加载态管理
 * - 只负责“是否已拿到 fileId”这一层，不介入业务初始化细节
 * ============================================================================
 */
import { useEffect, useRef, useState } from 'react'

export default function useDuckdbPreparation({
  fileId,
  isPreparing = false,
  onPrepareFromSelectedFile,
  setStage,
  loadingStage = 'loading',
  preparingMessage = '正在准备数据环境，请稍候...',
  checkingMessage = '正在检查并加载当前活动文件...',
}) {
  const [duckdbInitLoading, setDuckdbInitLoading] = useState(false)
  const [duckdbLoadingMessage, setDuckdbLoadingMessage] = useState('')
  const prepareTriggeredRef = useRef(false)

  useEffect(() => {
    // 已完成预加载（有 fileId）: 清理初始化状态
    if (fileId) {
      setDuckdbInitLoading(false)
      setDuckdbLoadingMessage('')
      prepareTriggeredRef.current = false
      return
    }

    // 正在预加载: 标记 loading 态，但不切换 stage（首页保持可见）
    if (isPreparing) {
      setDuckdbInitLoading(true)
      setDuckdbLoadingMessage(preparingMessage)
      return
    }

    // 预加载结束但仍未拿到 fileId: 回收 loading 态（可能失败/取消）
    if (!fileId && !isPreparing && duckdbInitLoading) {
      setDuckdbInitLoading(false)
      setDuckdbLoadingMessage('')
      return
    }

    // 首次进入不自动触发，等用户主动操作

  }, [
    fileId,
    isPreparing,
    duckdbInitLoading,
    onPrepareFromSelectedFile,
    setStage,
    loadingStage,
    preparingMessage,
    checkingMessage,
  ])

  return {
    duckdbInitLoading,
    duckdbLoadingMessage,
  }
}
