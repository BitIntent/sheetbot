// ============================================================================
// 表单预览 - 模拟外部用户看到的表单效果
// ============================================================================
import React from 'react'

function renderField(field) {
  const { type, label, placeholder, required, options = [] } = field
  const star = required ? <span className="fp-required">*</span> : null

  switch (type) {
    case 'textarea':
      return (
        <div className="fp-field" key={field.key}>
          <label className="fp-label">{label}{star}</label>
          <textarea className="fp-textarea" placeholder={placeholder} rows={3} readOnly />
        </div>
      )
    case 'select':
      return (
        <div className="fp-field" key={field.key}>
          <label className="fp-label">{label}{star}</label>
          <select className="fp-select" disabled>
            <option value="">{placeholder || '请选择'}</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )
    case 'radio':
      return (
        <div className="fp-field" key={field.key}>
          <label className="fp-label">{label}{star}</label>
          <div className="fp-options">
            {options.map(o => (
              <label key={o} className="fp-option">
                <input type="radio" name={field.key} disabled /> {o}
              </label>
            ))}
          </div>
        </div>
      )
    case 'checkbox':
      return (
        <div className="fp-field" key={field.key}>
          <label className="fp-label">{label}{star}</label>
          <div className="fp-options">
            {options.map(o => (
              <label key={o} className="fp-option">
                <input type="checkbox" disabled /> {o}
              </label>
            ))}
          </div>
        </div>
      )
    case 'date':
      return (
        <div className="fp-field" key={field.key}>
          <label className="fp-label">{label}{star}</label>
          <input className="fp-input" type="date" readOnly />
        </div>
      )
    default:
      return (
        <div className="fp-field" key={field.key}>
          <label className="fp-label">{label}{star}</label>
          <input
            className="fp-input"
            type={type === 'number' ? 'number' : 'text'}
            placeholder={placeholder}
            readOnly
          />
        </div>
      )
  }
}

export default function FormPreview({ fields, title, description }) {
  return (
    <div className="form-preview">
      <div className="fp-device-frame">
        <div className="fp-header">
          <h3 className="fp-title">{title || '表单预览'}</h3>
          {description && <p className="fp-desc">{description}</p>}
        </div>
        <div className="fp-body">
          {fields.length === 0 ? (
            <p className="fp-empty">暂无字段</p>
          ) : (
            fields.map(renderField)
          )}
        </div>
        <div className="fp-footer">
          <button className="fp-submit-btn" disabled>提交</button>
        </div>
      </div>
    </div>
  )
}
