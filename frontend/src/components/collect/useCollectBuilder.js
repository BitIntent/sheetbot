import { useCallback, useState } from 'react'

/**
 * 收集模块：创建与发布表单流程
 */
export function useCollectBuilder({
  apiBase,
  authedFetch,
  columns,
  activeSheet,
  currentFileName,
  fileId,
  loadForms,
  setStage,
  setError,
  setPublishedForm,
}) {
  const [loading, setLoading] = useState(false)
  const [fields, setFields] = useState([])
  const [formTitle, setFormTitle] = useState('')
  const [formDesc, setFormDesc] = useState('')

  const handleCreate = useCallback(async () => {
    if (!columns.length) {
      setError('当前工作表没有列头数据，请先在 Excel 中填写第一行作为表头')
      return
    }

    setStage('building')
    setLoading(true)
    setError('')
    try {
      const res = await authedFetch(`${apiBase}/api/collect/forms/ai-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, sheet_name: activeSheet }),
      })
      if (!res.ok) throw new Error(`AI 推断失败: ${res.status}`)
      const data = await res.json()
      setFields(data.fields || [])
      setFormTitle(data.suggested_title || `${currentFileName || '数据'}收集表单`)
      setFormDesc(data.suggested_description || '')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [activeSheet, apiBase, authedFetch, columns, currentFileName, setError, setStage])

  const handlePublish = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await authedFetch(`${apiBase}/api/collect/forms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formTitle,
          description: formDesc,
          sheet_name: activeSheet,
          file_id: fileId || null,
          form_config: { fields },
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const detail = body?.detail
        const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
        const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || `发布失败: ${res.status}`))
        throw new Error(msg)
      }
      const form = await res.json()
      setPublishedForm(form)
      setStage('published')
      await loadForms()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [
    activeSheet,
    apiBase,
    authedFetch,
    fields,
    fileId,
    formDesc,
    formTitle,
    loadForms,
    setError,
    setPublishedForm,
    setStage,
  ])

  return {
    loading,
    fields,
    formTitle,
    formDesc,
    setFields,
    setFormTitle,
    setFormDesc,
    handleCreate,
    handlePublish,
  }
}

