import { useCallback } from 'react'

/**
 * 收集模块：导出链路（先同步，再下载当前工作簿）
 */
export function useCollectExport({
  apiBase,
  authedFetch,
  fileId,
  currentFileName,
  forms,
  onAiHint,
  handleSync,
  setNotice,
  setError,
}) {
  const handleExportCollect = useCallback(async () => {
    if (!fileId) {
      setNotice('')
      setError('')
      onAiHint?.('请先在左侧选择要导出的工作簿文件。')
      return
    }

    const relatedForms = forms.filter((f) => f?.file_id && f.file_id === fileId)
    if (!relatedForms.length) {
      setNotice('')
      setError('当前选中文件没有已发布的收集表单，无法导出。')
      return
    }

    try {
      const syncResults = await Promise.all(relatedForms.map((form) => handleSync(form)))
      const synced = syncResults.reduce((sum, n) => sum + (Number(n) || 0), 0)

      const res = await authedFetch(`${apiBase}/api/files/${fileId}/download?_=${Date.now()}`)
      if (!res.ok) {
        throw new Error(`下载失败: ${res.status}`)
      }
      const blob = await res.blob()
      const defaultName = `${(currentFileName || 'collect_export').replace(/[\\\\/:*?\"<>|]/g, '_')}.xlsx`
      const cd = res.headers.get('content-disposition') || ''
      const match = cd.match(/filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?/i)
      const filename = decodeURIComponent(match?.[1] || match?.[2] || defaultName)

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      setError('')
      setNotice(`导出收集完成：已同步 ${synced} 条并下载工作簿。`)
    } catch (e) {
      setNotice('')
      setError(`导出收集失败: ${e.message}`)
    }
  }, [
    apiBase,
    authedFetch,
    currentFileName,
    fileId,
    forms,
    handleSync,
    onAiHint,
    setError,
    setNotice,
  ])

  return { handleExportCollect }
}

