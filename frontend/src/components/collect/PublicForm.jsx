// ============================================================================
// 公开表单页面 - 独立轻量组件，外部人员填写
// 响应式布局：PC 居中卡片 / 移动端全宽
// ============================================================================
import React, { useState, useEffect, useCallback } from 'react'
import { resolveApiBaseUrl } from '../../config/appConfig'

// ── 获取 API 基础地址 ──────────────────────────────────
function getApiBase() {
  const resolved = resolveApiBaseUrl()
  if (resolved) return String(resolved).replace(/\/$/, '')
  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/$/, '')
  }
  return ''
}

async function parseJsonResponse(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`服务返回非 JSON 响应（可能命中了前端页面）：${text.slice(0, 80)}`)
  }
}

// ── 字段校验 ─────────────────────────────────────────────
function validateField(field, value) {
  if (field.required && (!value || (typeof value === 'string' && !value.trim()))) {
    return `${field.label} 为必填项`
  }
  const v = field.validation || {}
  if (v.maxLength && typeof value === 'string' && value.length > v.maxLength) {
    return `${field.label} 不能超过 ${v.maxLength} 个字符`
  }
  if (v.pattern && typeof value === 'string') {
    const re = new RegExp(v.pattern)
    if (!re.test(value)) return `${field.label} 格式不正确`
  }
  if (field.type === 'phone' && value) {
    if (!/^1[3-9]\d{9}$/.test(value)) return '请输入正确的11位手机号'
  }
  if (field.type === 'email' && value) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '请输入正确的邮箱地址'
  }
  return ''
}

// ── 字段渲染 ─────────────────────────────────────────────
function FieldInput({ field, value, onChange, error }) {
  const { type, label, placeholder, required, options = [] } = field
  const star = required ? <span style={{ color: '#ef4444' }}>*</span> : null

  const inputProps = {
    value: value || '',
    onChange: e => onChange(e.target.value),
    placeholder,
    className: `pf-input ${error ? 'pf-input-error' : ''}`,
  }

  let control
  switch (type) {
    case 'textarea':
      control = <textarea {...inputProps} rows={3} />
      break
    case 'select':
      control = (
        <select {...inputProps} onChange={e => onChange(e.target.value)}>
          <option value="">{placeholder || '请选择'}</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
      break
    case 'radio':
      control = (
        <div className="pf-options">
          {options.map(o => (
            <label key={o} className="pf-option-label">
              <input
                type="radio"
                name={field.key}
                value={o}
                checked={value === o}
                onChange={() => onChange(o)}
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      )
      break
    case 'checkbox':
      control = (
        <div className="pf-options">
          {options.map(o => {
            const arr = Array.isArray(value) ? value : []
            return (
              <label key={o} className="pf-option-label">
                <input
                  type="checkbox"
                  checked={arr.includes(o)}
                  onChange={() => {
                    const next = arr.includes(o) ? arr.filter(x => x !== o) : [...arr, o]
                    onChange(next)
                  }}
                />
                <span>{o}</span>
              </label>
            )
          })}
        </div>
      )
      break
    case 'date':
      control = <input {...inputProps} type="date" />
      break
    case 'number':
      control = <input {...inputProps} type="number" />
      break
    default:
      control = <input {...inputProps} type={type === 'phone' ? 'tel' : 'text'} />
  }

  return (
    <div className="pf-field">
      <label className="pf-label">{label} {star}</label>
      {control}
      {error && <p className="pf-field-error">{error}</p>}
    </div>
  )
}

// ── 主组件 ───────────────────────────────────────────────
export default function PublicForm() {
  const [formData, setFormData] = useState(null)
  const [values, setValues] = useState({})
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [loadError, setLoadError] = useState('')

  const token = new URLSearchParams(window.location.search).get('token')

  // 加载表单配置
  useEffect(() => {
    if (!token) {
      setLoadError('缺少表单参数')
      return
    }
    fetch(`${getApiBase()}/api/public/form/${token}`)
      .then(res => {
        if (!res.ok) throw new Error('表单不存在或已删除')
        return parseJsonResponse(res)
      })
      .then(data => {
        setFormData(data)
        const init = {}
        for (const f of data.fields || []) {
          init[f.key] = f.type === 'checkbox' ? [] : ''
        }
        setValues(init)
      })
      .catch(e => setLoadError(e.message))
  }, [token])

  const handleChange = useCallback((key, val) => {
    setValues(prev => ({ ...prev, [key]: val }))
    setErrors(prev => ({ ...prev, [key]: '' }))
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!formData) return

    // 校验
    const newErrors = {}
    let hasError = false
    for (const field of formData.fields) {
      const err = validateField(field, values[field.key])
      if (err) {
        newErrors[field.key] = err
        hasError = true
      }
    }
    setErrors(newErrors)
    if (hasError) return

    setSubmitting(true)
    try {
      const res = await fetch(`${getApiBase()}/api/public/form/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: values }),
      })
      const result = await parseJsonResponse(res)
      if (result.success) {
        setSubmitted(true)
      } else {
        setErrors({ _global: result.message || '提交失败' })
      }
    } catch {
      setErrors({ _global: '网络错误，请稍后重试' })
    } finally {
      setSubmitting(false)
    }
  }

  // ── 样式（内嵌，独立于主应用） ──────────────────────────
  return (
    <>
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; min-height: 100vh; }
        .pf-container { max-width: 640px; margin: 0 auto; padding: 24px 16px; min-height: 100vh; }
        .pf-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); overflow: hidden; }
        .pf-header { background: linear-gradient(135deg, #217346, #2A9058); padding: 28px 24px; color: #fff; }
        .pf-header h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
        .pf-header p { font-size: 14px; opacity: 0.9; line-height: 1.5; }
        .pf-body { padding: 24px; }
        .pf-field { margin-bottom: 20px; }
        .pf-label { display: block; font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px; }
        .pf-input, .pf-field select, .pf-field textarea {
          width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px;
          font-size: 15px; color: #111827; background: #fff; transition: border-color .15s;
          outline: none; font-family: inherit;
        }
        .pf-input:focus, .pf-field select:focus, .pf-field textarea:focus { border-color: #217346; box-shadow: 0 0 0 3px rgba(33,115,70,.12); }
        .pf-input-error { border-color: #ef4444 !important; }
        .pf-field-error { color: #ef4444; font-size: 14px; margin-top: 4px; }
        .pf-options { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
        .pf-option-label { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #374151; cursor: pointer; }
        .pf-option-label input { accent-color: #217346; }
        .pf-footer { padding: 0 24px 24px; }
        .pf-submit-btn {
          width: 100%; padding: 12px; background: linear-gradient(135deg, #217346, #2A9058);
          color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600;
          cursor: pointer; transition: opacity .15s;
        }
        .pf-submit-btn:hover:not(:disabled) { opacity: 0.9; }
        .pf-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .pf-global-error { color: #ef4444; font-size: 13px; text-align: center; margin-bottom: 16px; }
        .pf-success { text-align: center; padding: 60px 24px; }
        .pf-success-icon { font-size: 56px; margin-bottom: 16px; }
        .pf-success h2 { font-size: 22px; color: #217346; margin-bottom: 8px; }
        .pf-success p { font-size: 14px; color: #6b7280; }
        .pf-success-again { margin-top: 20px; padding: 10px 24px; background: #217346; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
        .pf-error-page { text-align: center; padding: 80px 24px; color: #6b7280; }
        .pf-error-page h2 { color: #ef4444; margin-bottom: 8px; }
        .pf-closed { text-align: center; padding: 60px 24px; color: #6b7280; }
        .pf-closed h2 { margin-bottom: 8px; }
        @media (max-width: 480px) {
          .pf-container { padding: 0; }
          .pf-card { border-radius: 0; min-height: 100vh; }
        }
      `}</style>
      <div className="pf-container">
        {loadError ? (
          <div className="pf-card">
            <div className="pf-error-page">
              <h2>无法加载表单</h2>
              <p>{loadError}</p>
            </div>
          </div>
        ) : !formData ? (
          <div className="pf-card">
            <div className="pf-closed">
              <p>加载中...</p>
            </div>
          </div>
        ) : submitted ? (
          <div className="pf-card">
            <div className="pf-header">
              <h1>{formData.title}</h1>
            </div>
            <div className="pf-success">
              <div className="pf-success-icon">&#10003;</div>
              <h2>提交成功</h2>
              <p>感谢您的填写，数据已成功提交。</p>
              <button className="pf-success-again" onClick={() => {
                setSubmitted(false)
                const init = {}
                for (const f of formData.fields) init[f.key] = f.type === 'checkbox' ? [] : ''
                setValues(init)
                setErrors({})
              }}>
                继续填写
              </button>
            </div>
          </div>
        ) : !formData.accepting ? (
          <div className="pf-card">
            <div className="pf-header">
              <h1>{formData.title}</h1>
            </div>
            <div className="pf-closed">
              <h2>表单已关闭</h2>
              <p>该表单已停止收集，感谢关注。</p>
            </div>
          </div>
        ) : (
          <div className="pf-card">
            <div className="pf-header">
              <h1>{formData.title}</h1>
              {formData.description && <p>{formData.description}</p>}
            </div>
            <form onSubmit={handleSubmit}>
              <div className="pf-body">
                {errors._global && <p className="pf-global-error">{errors._global}</p>}
                {formData.fields.map(field => (
                  <FieldInput
                    key={field.key}
                    field={field}
                    value={values[field.key]}
                    onChange={val => handleChange(field.key, val)}
                    error={errors[field.key]}
                  />
                ))}
              </div>
              <div className="pf-footer">
                <button type="submit" className="pf-submit-btn" disabled={submitting}>
                  {submitting ? '提交中...' : '提交'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </>
  )
}
