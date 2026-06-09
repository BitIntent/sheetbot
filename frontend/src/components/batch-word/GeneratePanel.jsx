// frontend/src/components/batch-word/GeneratePanel.jsx
import React from 'react'
import { Download, CheckCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function GeneratePanel({
  generating,
  total,
  downloadUrl,
  baseUrl,
  withFreshAccessToken,
  onGenerate,
  onReset,
  showReupload = false,
  onReupload,
  reuploadLabel = '',
  showSaveConfig = false,
  onSaveConfig,
  savingConfig = false,
  saveConfigLabel = '',
}) {
  const { t } = useTranslation()

  const handleDownload = async () => {
    try {
      const url = `${baseUrl}${downloadUrl}`
      const res = await withFreshAccessToken(async (token) => {
        return fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        })
      })
      if (!res.ok) throw new Error(res.statusText)

      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = downloadUrl.split('/').pop() + '.zip'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      console.error('download failed:', e)
    }
  }

  if (generating) {
    return (
      <div className="bw-generate-panel">
        <Loader2 size={24} className="bw-spin" />
        <span className="bw-gen-text">{t('batchWord.generating')}</span>
      </div>
    )
  }

  if (downloadUrl) {
    return (
      <div className="bw-generate-panel bw-generate-panel--done">
        <CheckCircle size={22} />
        <span className="bw-gen-text">
          {t('batchWord.generatedCount', { count: total })}
        </span>
        <button className="bw-btn-primary" onClick={handleDownload}>
          <Download size={14} />
          {t('batchWord.downloadZip')}
        </button>
        <button className="bw-btn-primary" onClick={onReset}>
          {t('batchWord.restart')}
        </button>
      </div>
    )
  }

  return (
    <div className="bw-generate-panel">
      <div className="bw-generate-actions-row">
        {showSaveConfig && (
          <button
            className="bw-btn-primary bw-btn-lg"
            onClick={onSaveConfig}
            disabled={savingConfig}
          >
            {savingConfig ? t('batchWord.savingConfig') : (saveConfigLabel || t('batchWord.saveConfig'))}
          </button>
        )}
        <button className="bw-btn-primary bw-btn-lg" onClick={onGenerate}>
          {t('batchWord.startGenerate')}
        </button>
        {showReupload && (
          <button className="bw-btn-primary bw-btn-lg" onClick={onReupload}>
            {reuploadLabel || t('batchWord.reupload')}
          </button>
        )}
      </div>
    </div>
  )
}
