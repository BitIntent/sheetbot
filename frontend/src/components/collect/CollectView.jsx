// ============================================================================
// 我要收集 - 主视图（状态机）
// 阶段: home → building → published
// ============================================================================
import React, { useState, useEffect, useMemo } from 'react'
import { detectSheetHeaderRow } from '../../utils/excelOperations'
import {
  Plus, Loader2,
} from 'lucide-react'
import FormBuilder from './FormBuilder'
import FormPreview from './FormPreview'
import SharePanel from './SharePanel'
import SubmissionList from './SubmissionList'
import FormHistoryPanel from './FormHistoryPanel'
import CollectFormEditDialog from './CollectFormEditDialog'
import PlatformViewToolbar from '../PlatformViewToolbar'
import { useCollectBuilder } from './useCollectBuilder'
import { useCollectSync } from './useCollectSync'
import { useCollectForms } from './useCollectForms'
import { useCollectExport } from './useCollectExport'
import { getCollectApiBase } from './collectApi'
import '../../styles/collect.css'
import { useAuthedFetch } from '../../hooks/useAuthedFetch'

// ── 主视图 ───────────────────────────────────────────────
export default function CollectView({ workbook, activeSheet, fileId, currentFileName, onWorkbookSynced, onQuickStart, onAiHint, pushSystemMessage }) {
  const authedFetch = useAuthedFetch()
  const apiBase = getCollectApiBase()
  const [stage, setStage] = useState('home') // home | building | published

  // 已发布表单
  const [publishedForm, setPublishedForm] = useState(null)

  const [notice, setNotice] = useState('')

  // 统一错误通道：走 AI 助手面板 / 右下角弹框，不在视图内内联展示
  const reportError = (msg) => { if (msg) pushSystemMessage?.('error', msg) }

  const {
    forms,
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
  } = useCollectForms({
    apiBase,
    authedFetch,
    activeSheet,
    publishedForm,
    setPublishedForm,
    setNotice,
    setError: reportError,
  })
  const columns = useMemo(() => {
    if (!workbook?.sheets?.length) return []
    const sheet = workbook.sheets.find(s => s.name === activeSheet) || workbook.sheets[0]
    if (!sheet?.data) return []
    const hRow = detectSheetHeaderRow(sheet.data)
    const headerRowData = sheet.data[String(hRow)] || sheet.data[hRow]
    if (!headerRowData) return []
    const cols = []
    const maxCol = Math.min(sheet.colCount || 26, 50)
    for (let c = 1; c <= maxCol; c++) {
      const cell = headerRowData[String(c)] || headerRowData[c]
      if (cell?.value) cols.push(String(cell.value).trim())
    }
    return cols
  }, [workbook, activeSheet])
  const {
    loading,
    fields,
    formTitle,
    formDesc,
    setFields,
    setFormTitle,
    setFormDesc,
    handleCreate,
    handlePublish,
  } = useCollectBuilder({
    apiBase,
    authedFetch,
    columns,
    activeSheet,
    currentFileName,
    fileId,
    loadForms,
    setStage,
    setError: reportError,
    setPublishedForm,
  })

  const { handleSync } = useCollectSync({
    apiBase,
    authedFetch,
    onWorkbookSynced,
    setNotice,
    setError: reportError,
  })
  const { handleExportCollect } = useCollectExport({
    apiBase,
    authedFetch,
    fileId,
    currentFileName,
    forms,
    onAiHint,
    handleSync,
    setNotice,
    setError: reportError,
  })

  // ── 打开历史表单 ──────────────────────────────────────
  const handleOpenForm = (form) => {
    setPublishedForm(form)
    setStage('published')
  }

  // ── 删除表单 ──────────────────────────────────────────
  const handleDeleteForm = async (formId) => {
    try {
      await authedFetch(`${apiBase}/api/collect/forms/${formId}`, {
        method: 'DELETE',
      })
      loadForms()
      if (publishedForm?.id === formId) {
        setStage('home')
        setPublishedForm(null)
      }
    } catch (e) {
      console.warn('[CollectView] 删除失败', e)
    }
  }

  // ── 切换状态 ──────────────────────────────────────────
  const handleToggleStatus = async (formId, newStatus) => {
    try {
      const res = await authedFetch(`${apiBase}/api/collect/forms/${formId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        const updated = await res.json()
        setPublishedForm(updated)
        loadForms()
      }
    } catch (e) {
      console.warn('[CollectView] 状态切换失败', e)
    }
  }

  useEffect(() => {
    const onCollectAction = async (event) => {
      const action = event?.detail?.action
      if (action === 'back_list') {
        setStage('home')
        setPublishedForm(null)
        return
      }
      if (action === 'export_collect') {
        await handleExportCollect()
      }
    }
    window.addEventListener('collect:view-action', onCollectAction)
    return () => window.removeEventListener('collect:view-action', onCollectAction)
  }, [handleExportCollect])

  // ── 渲染 ──────────────────────────────────────────────
  return (
    <div className="collect-view">
      {(stage === 'building' || stage === 'published') && (
        <PlatformViewToolbar variant="collect" />
      )}
      {/* ===== HOME 阶段 ===== */}
      {stage === 'home' && (
        <div className={`collect-home${fileId ? ' is-file-selected' : ''}`}>
          {!fileId && (
            <div className="collect-hero">
              <div className="view-title-row">
                <h2 className="collect-hero-title">数据收集</h2>
                <button className="view-start-action-btn" onClick={() => onQuickStart?.()}>
                  点击开始
                </button>
              </div>
              <p className="collect-hero-desc">
                将工作表列头转化为在线表单，外部人员填写后数据自动回流到表格
              </p>
              <p className="collect-file-note">
                请先在左侧文件树选择需要分析的文件
              </p>
            </div>
          )}
          {!!fileId && (
            <div className="collect-selected-actions">
              <button
                className="collect-btn-primary"
                onClick={handleCreate}
                disabled={!columns.length}
              >
                <Plus size={18} />
                <span>从当前表格创建表单</span>
              </button>
              {!columns.length && (
                <p className="collect-hint">
                  请先在 Excel 中填写第一行列头（如：姓名、手机号、意向产品）
                </p>
              )}
            </div>
          )}
          <FormHistoryPanel
            forms={forms}
            loading={formsLoading}
            onOpen={handleOpenForm}
            onEdit={handleEditForm}
            onDelete={handleDeleteForm}
            onRefresh={loadForms}
          />
        </div>
      )}

      {/* ===== BUILDING 阶段 ===== */}
      {stage === 'building' && (
        <div className="collect-building">
          <div className="collect-building-header">
            <h3 className="collect-building-title">配置表单</h3>
            <button
              className="collect-btn-primary"
              onClick={handlePublish}
              disabled={loading || !fields.length}
            >
              {loading ? <Loader2 size={16} className="spin" /> : null}
              <span>发布表单</span>
            </button>
          </div>
          {loading && !fields.length ? (
            <div className="collect-loading">
              <Loader2 size={32} className="spin" />
              <p>AI 正在分析列头，生成表单配置...</p>
            </div>
          ) : (
            <div className="collect-building-body">
              <div className="collect-builder-col">
                <FormBuilder
                  fields={fields}
                  title={formTitle}
                  description={formDesc}
                  onFieldsChange={setFields}
                  onTitleChange={setFormTitle}
                  onDescChange={setFormDesc}
                />
              </div>
              <div className="collect-preview-col">
                <FormPreview
                  fields={fields}
                  title={formTitle}
                  description={formDesc}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== PUBLISHED 阶段 ===== */}
      {stage === 'published' && publishedForm && (
        <div className="collect-published">
          <div className="collect-published-header">
            <h3 className="collect-published-title">{publishedForm.title}</h3>
            <div className="collect-published-actions">
              {publishedForm.status === 'active' ? (
                <button
                  className="collect-btn-danger"
                  onClick={() => handleToggleStatus(publishedForm.id, 'closed')}
                >
                  关闭收集
                </button>
              ) : (
                <button
                  className="collect-btn-primary"
                  onClick={() => handleToggleStatus(publishedForm.id, 'active')}
                >
                  重新开启
                </button>
              )}
            </div>
          </div>
          <div className="collect-published-body">
            {notice && <p className="collect-notice">{notice}</p>}
            <SharePanel form={publishedForm} />
            <SubmissionList
              formId={publishedForm.id}
              formConfig={publishedForm.form_config}
              onSync={() => handleSync(publishedForm)}
            />
          </div>
        </div>
      )}

      <CollectFormEditDialog
        open={editFormOpen}
        saving={editSaving}
        draft={editDraft}
        workbookOptions={workbookOptions}
        onClose={handleCloseEditForm}
        onChange={setEditDraft}
        onSave={handleUpdateForm}
      />
    </div>
  )
}
