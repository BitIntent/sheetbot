import { useCallback } from 'react'

/**
 * 收集模块：同步提交数据到工作表
 */
export function useCollectSync({
  apiBase,
  authedFetch,
  onWorkbookSynced,
  setNotice,
  setError,
}) {
  const handleSync = useCallback(async (form) => {
    if (!form?.id) return 0
    try {
      const res = await authedFetch(`${apiBase}/api/collect/forms/${form.id}/sync`, {
        method: 'POST',
      })
      if (res.ok) {
        const data = await res.json()
        const count = Number(data.synced_count || 0)
        if (count > 0) {
          setNotice(data.message || `同步完成，共 ${count} 条`)
          setError('')
        } else {
          setNotice(data.message || '没有待同步的提交数据')
          setError('')
        }
        try {
          await onWorkbookSynced?.(form)
        } catch (refreshError) {
          console.warn('[CollectView] 同步后刷新工作簿失败', refreshError)
        }
        return count
      }

      let detail = `同步失败: ${res.status}`
      try {
        const err = await res.json()
        detail = err?.detail || detail
      } catch (_) {
        // ignore parse error
      }
      setNotice('')
      setError(detail)
    } catch (e) {
      console.warn('[CollectView] 同步失败', e)
      setNotice('')
      setError(`同步失败: ${e.message}`)
    }
    return 0
  }, [apiBase, authedFetch, onWorkbookSynced, setNotice, setError])

  return { handleSync }
}

