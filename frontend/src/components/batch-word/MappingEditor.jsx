// frontend/src/components/batch-word/MappingEditor.jsx
import React, { useCallback } from 'react'
import { Plus, Trash2, AlertTriangle, Link } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function MappingEditor({
  mappings,
  setMappings,
  excelColumns,
  imageColumns,
}) {
  const { t } = useTranslation()

  const update = useCallback((idx, field, value) => {
    setMappings(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: value }
      // 选择 Excel 列时，自动补全 Word 标注为 {字段名}
      if (field === 'column') {
        const oldPlaceholder = String(prev[idx]?.placeholder || '').trim()
        const oldColumn = String(prev[idx]?.column || '').trim()
        const linkedOldPlaceholder = oldColumn ? `{${oldColumn}}` : ''
        if (!oldPlaceholder || oldPlaceholder === linkedOldPlaceholder) {
          next[idx].placeholder = value ? `{${value}}` : ''
        }
        // 自动识别图片列
        next[idx].type = imageColumns.includes(value) ? 'image' : 'text'
      }
      return next
    })
  }, [setMappings, imageColumns])

  const remove = useCallback((idx) => {
    setMappings(prev => prev.filter((_, i) => i !== idx))
  }, [setMappings])

  const add = useCallback(() => {
    setMappings(prev => [...prev, { placeholder: '', column: '', type: 'text' }])
  }, [setMappings])

  return (
    <div className="bw-mapping-editor">
      <div className="bw-mapping-header">
        <span className="bw-mapping-label">
          <Link size={14} />
          {t('batchWord.mappingTitle')}
        </span>
        <button className="bw-btn-ghost" onClick={add}>
          <Plus size={14} /> {t('batchWord.addMapping')}
        </button>
      </div>

      <div className="bw-mapping-table">
        <div className="bw-mapping-row bw-mapping-row--head">
          <span>{t('batchWord.colPlaceholder')}</span>
          <span>{t('batchWord.colExcel')}</span>
          <span>{t('batchWord.colType')}</span>
          <span></span>
        </div>

        {mappings.map((m, idx) => (
          <div key={idx} className="bw-mapping-row">
            <input
              className="bw-input"
              value={m.placeholder}
              onChange={(e) => update(idx, 'placeholder', e.target.value)}
              placeholder="{姓名}"
            />
            <select
              className="bw-input"
              value={m.column}
              onChange={(e) => update(idx, 'column', e.target.value)}
            >
              <option value="">{t('batchWord.selectColumn')}</option>
              {excelColumns.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              className="bw-input bw-input--narrow"
              value={m.type}
              onChange={(e) => update(idx, 'type', e.target.value)}
            >
              <option value="text">{t('batchWord.typeText')}</option>
              <option value="image">{t('batchWord.typeImage')}</option>
            </select>
            <button className="bw-btn-icon" onClick={() => remove(idx)}>
              <Trash2 size={14} />
            </button>
            {m.confidence !== undefined && m.confidence < 0.7 && (
              <span className="bw-low-conf" title={t('batchWord.lowConfidence')}>
                <AlertTriangle size={12} />
              </span>
            )}
          </div>
        ))}

        {mappings.length === 0 && (
          <div className="bw-mapping-empty">{t('batchWord.noMapping')}</div>
        )}
      </div>
    </div>
  )
}
