// frontend/src/components/batch-word/FilenameConfigurator.jsx
import React, { useCallback, useMemo } from 'react'
import { FileOutput } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function FilenameConfigurator({
  pattern,
  setPattern,
  excelColumns,
  sampleRows,
  imageColumns = [],
}) {
  const { t } = useTranslation()
  const disabledColumns = useMemo(() => new Set(imageColumns || []), [imageColumns])
  const allowedColumns = useMemo(
    () => (excelColumns || []).filter((c) => !disabledColumns.has(c)),
    [excelColumns, disabledColumns]
  )

  const normalizeDateLikeText = useCallback((value) => {
    if (value === null || value === undefined) return ''
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return `${value.getFullYear()}/${value.getMonth() + 1}/${value.getDate()}`
    }
    let text = String(value).trim()
    if (!text) return ''
    text = text
      .replace(/\\"/g, '"')
      .replace(/^["']+|["']+$/g, '')
      .trim()
    const m = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (m) return `${m[1]}/${Number(m[2])}/${Number(m[3])}`
    const zh = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (zh) return `${zh[1]}/${Number(zh[2])}/${Number(zh[3])}`
    return text
  }, [])

  // 实时预览前 2 条数据的实际文件名
  const previews = useMemo(() => {
    const rows = (sampleRows || []).slice(0, 2)
    return rows.map((row, idx) => {
      let name = (pattern || '文档_{_index}').replace('{_index}', String(idx + 1))
      for (const [key, val] of Object.entries(row)) {
        if (disabledColumns.has(key)) {
          name = name.replaceAll(`{${key}}`, '')
          continue
        }
        const normalized = normalizeDateLikeText(val).replaceAll('/', '-')
        name = name.replaceAll(`{${key}}`, normalized)
      }
      name = name.replace(/[\\/:*?"<>|]/g, '_').trim() || `文档_${idx + 1}`
      return name + '.docx'
    })
  }, [pattern, sampleRows, disabledColumns, normalizeDateLikeText])

  const insertColumn = (col) => {
    const token = `{${col}}`
    setPattern(prev => {
      const current = prev || ''
      // 二次点击取消
      if (current.includes(token)) {
        return current.replaceAll(token, '')
      }
      return current + token
    })
  }

  return (
    <div className="bw-filename-section">
      <div className="bw-section-label">
        <FileOutput size={14} />
        <span>{t('batchWord.filenameTitle')}</span>
      </div>

      <div className="bw-filename-input-row">
        <input
          className="bw-input bw-input--wide"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="文档_{_index}"
        />
        <span className="bw-filename-ext">.docx</span>
      </div>

      <div className="bw-filename-tags">
        <span
          className={`bw-tag ${pattern?.includes('{_index}') ? 'bw-tag--active' : ''}`}
          onClick={() => insertColumn('_index')}
        >
          {'序号'}
        </span>
        {allowedColumns.map(c => (
          <span
            key={c}
            className={`bw-tag ${pattern?.includes(`{${c}}`) ? 'bw-tag--active' : ''}`}
            onClick={() => insertColumn(c)}
          >
            {c}
          </span>
        ))}
      </div>

      {previews.length > 0 && (
        <div className="bw-filename-preview">
          <span className="bw-preview-label">{t('batchWord.filenamePreview')}</span>
          {previews.map((p, i) => (
            <div key={i} className="bw-preview-item">{p}</div>
          ))}
        </div>
      )}
    </div>
  )
}
