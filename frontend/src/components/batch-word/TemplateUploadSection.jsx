// frontend/src/components/batch-word/TemplateUploadSection.jsx
import React, { useCallback, useRef, useState } from 'react'
import { Upload, FileText, Sparkles, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function TemplateUploadSection({
  onUploaded,
  onAutoAnnotate,
  excelColumns,
  baseUrl,
  withFreshAccessToken,
}) {
  const { t } = useTranslation()
  const fileRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [enableAI, setEnableAI] = useState(true)

  const handleFile = useCallback(async (file) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setError(t('batchWord.errNotDocx'))
      return
    }

    setUploading(true)
    setError('')

    try {
      const form = new FormData()
      form.append('file', file)
      const res = await withFreshAccessToken(async (token) => {
        return fetch(`${baseUrl}/api/batch-word/upload-template`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || body.error || res.statusText)
      }

      const data = await res.json()
      onUploaded(data)

      // AI 自动标注
      if (enableAI && excelColumns?.length) {
        onAutoAnnotate(data.template_id, excelColumns)
      }
    } catch (e) {
      setError(e.message || t('batchWord.errUploadFailed'))
    } finally {
      setUploading(false)
    }
  }, [baseUrl, withFreshAccessToken, enableAI, excelColumns, onUploaded, onAutoAnnotate, t])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    handleFile(file)
  }, [handleFile])

  const handleDragOver = useCallback((e) => e.preventDefault(), [])

  return (
    <div className="bw-upload-section">
      <div
        className="bw-dropzone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".docx"
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {uploading ? (
          <div className="bw-dropzone-inner">
            <div className="bw-spinner" />
            <span>{t('batchWord.uploading')}</span>
          </div>
        ) : (
          <div className="bw-dropzone-inner">
            <Upload size={28} strokeWidth={1.5} />
            <span className="bw-dropzone-title">{t('batchWord.uploadTitle')}</span>
            <span className="bw-dropzone-hint">{t('batchWord.uploadHint')}</span>
          </div>
        )}
      </div>

      <label className="bw-ai-toggle">
        <input
          type="checkbox"
          checked={enableAI}
          onChange={(e) => setEnableAI(e.target.checked)}
        />
        <Sparkles size={14} />
        <span>{t('batchWord.aiAnnotate')}</span>
      </label>

      {error && (
        <div className="bw-error">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
