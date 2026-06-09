import { useCallback, useEffect, useState } from 'react'

/**
 * 收集模块：表单列表与编辑状态管理
 */
export function useCollectForms({
  apiBase,
  authedFetch,
  activeSheet,
  publishedForm,
  setPublishedForm,
  setNotice,
  setError,
}) {
  const [forms, setForms] = useState([])
  const [formsLoading, setFormsLoading] = useState(false)
  const [workbookOptions, setWorkbookOptions] = useState([])

  const [editFormOpen, setEditFormOpen] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [editingForm, setEditingForm] = useState(null)
  const [editDraft, setEditDraft] = useState({
    title: '',
    description: '',
    file_id: '',
    sheet_name: '',
  })

  const loadForms = useCallback(async () => {
    setFormsLoading(true)
    try {
      const res = await authedFetch(`${apiBase}/api/collect/forms`)
      if (res.ok) {
        const data = await res.json()
        setForms(Array.isArray(data) ? data : [])
      }
    } catch (e) {
      console.warn('[CollectView] 加载表单列表失败', e)
    } finally {
      setFormsLoading(false)
    }
  }, [apiBase, authedFetch])

  const loadWorkbookOptions = useCallback(async () => {
    try {
      const res = await authedFetch(`${apiBase}/api/files/tree`)
      if (!res.ok) return
      const data = await res.json()
      const files = Array.isArray(data?.files) ? data.files : []
      const excelFiles = files
        .filter((f) => ['xlsx', 'xls', 'xlsm', 'csv'].includes(String(f?.file_format || '').toLowerCase()))
        .map((f) => ({
          id: f.id,
          name: f.file_name || f.name || f.id,
          format: String(f.file_format || '').toLowerCase(),
        }))
      setWorkbookOptions(excelFiles)
    } catch (e) {
      console.warn('[CollectView] 加载工作簿选项失败', e)
    }
  }, [apiBase, authedFetch])

  useEffect(() => {
    loadForms()
  }, [loadForms])

  useEffect(() => {
    loadWorkbookOptions()
  }, [loadWorkbookOptions])

  const handleEditForm = useCallback((form) => {
    setEditingForm(form)
    setEditDraft({
      title: form?.title || '',
      description: form?.description || '',
      file_id: form?.file_id || '',
      sheet_name: form?.sheet_name || activeSheet || '',
    })
    setEditFormOpen(true)
    setError('')
  }, [activeSheet, setError])

  const handleCloseEditForm = useCallback(() => {
    setEditFormOpen(false)
    setEditingForm(null)
  }, [])

  const handleUpdateForm = useCallback(async () => {
    if (!editingForm?.id) return null
    const title = String(editDraft.title || '').trim()
    if (!title) {
      setError('表单标题不能为空')
      return null
    }

    setEditSaving(true)
    setError('')
    try {
      const payload = {
        title,
        description: String(editDraft.description || '').trim(),
        file_id: editDraft.file_id || null,
        sheet_name: String(editDraft.sheet_name || '').trim() || null,
      }
      const res = await authedFetch(`${apiBase}/api/collect/forms/${editingForm.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`修改失败: ${res.status}${errText ? ` - ${errText}` : ''}`)
      }

      const updated = await res.json()
      setEditFormOpen(false)
      setEditingForm(null)
      setEditDraft({ title: '', description: '', file_id: '', sheet_name: '' })
      setForms((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
      if (publishedForm?.id === updated.id) {
        setPublishedForm(updated)
      }
      setNotice('表单修改成功')
      await loadForms()
      return updated
    } catch (e) {
      setError(e.message || '表单修改失败')
      return null
    } finally {
      setEditSaving(false)
    }
  }, [
    apiBase,
    authedFetch,
    editDraft,
    editingForm,
    loadForms,
    publishedForm?.id,
    setError,
    setNotice,
    setPublishedForm,
  ])

  return {
    forms,
    setForms,
    formsLoading,
    workbookOptions,
    loadForms,
    editFormOpen,
    editSaving,
    editDraft,
    setEditDraft,
    handleEditForm,
    handleCloseEditForm,
    handleUpdateForm,
  }
}

