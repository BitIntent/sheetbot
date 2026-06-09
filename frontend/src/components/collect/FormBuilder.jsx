// ============================================================================
// 表单构建器 - 字段配置/编辑面板
// ============================================================================
import React from 'react'
import {
  GripVertical, Trash2, ChevronDown, ChevronUp,
} from 'lucide-react'

const FIELD_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'number', label: '数字' },
  { value: 'phone', label: '手机号' },
  { value: 'email', label: '邮箱' },
  { value: 'date', label: '日期' },
  { value: 'select', label: '下拉选择' },
  { value: 'radio', label: '单选' },
  { value: 'checkbox', label: '多选' },
]

export default function FormBuilder({
  fields, title, description,
  onFieldsChange, onTitleChange, onDescChange,
}) {
  const updateField = (idx, patch) => {
    const next = fields.map((f, i) => (i === idx ? { ...f, ...patch } : f))
    onFieldsChange(next)
  }

  const removeField = (idx) => {
    onFieldsChange(fields.filter((_, i) => i !== idx))
  }

  const moveField = (idx, dir) => {
    const next = [...fields]
    const target = idx + dir
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onFieldsChange(next)
  }

  const addField = () => {
    onFieldsChange([
      ...fields,
      {
        key: `col_${fields.length + 1}`,
        label: '新字段',
        type: 'text',
        required: false,
        placeholder: '',
        validation: {},
        options: [],
      },
    ])
  }

  const needsOptions = (type) => ['select', 'radio', 'checkbox'].includes(type)

  return (
    <div className="form-builder">
      {/* 表单基本信息 */}
      <div className="fb-section">
        <label className="fb-label">表单标题</label>
        <input
          className="fb-input"
          value={title}
          onChange={e => onTitleChange(e.target.value)}
          placeholder="表单标题"
        />
      </div>
      <div className="fb-section">
        <label className="fb-label">表单描述</label>
        <textarea
          className="fb-textarea"
          value={description}
          onChange={e => onDescChange(e.target.value)}
          placeholder="简短描述（可选）"
          rows={2}
        />
      </div>

      {/* 字段列表 */}
      <div className="fb-section">
        <label className="fb-label">字段配置</label>
        <div className="fb-fields">
          {fields.map((field, idx) => (
            <div key={field.key} className="fb-field-card">
              <div className="fb-field-header">
                <GripVertical size={14} className="fb-grip" />
                <input
                  className="fb-field-label-input"
                  value={field.label}
                  onChange={e => updateField(idx, { label: e.target.value })}
                  placeholder="字段名称"
                />
                <div className="fb-field-actions">
                  <button onClick={() => moveField(idx, -1)} disabled={idx === 0} title="上移">
                    <ChevronUp size={14} />
                  </button>
                  <button onClick={() => moveField(idx, 1)} disabled={idx === fields.length - 1} title="下移">
                    <ChevronDown size={14} />
                  </button>
                  <button onClick={() => removeField(idx)} title="删除">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="fb-field-body">
                <div className="fb-field-row">
                  <select
                    className="fb-select"
                    value={field.type}
                    onChange={e => updateField(idx, { type: e.target.value })}
                  >
                    {FIELD_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <label className="fb-checkbox-label">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={e => updateField(idx, { required: e.target.checked })}
                    />
                    <span>必填</span>
                  </label>
                </div>
                <input
                  className="fb-input fb-input-sm"
                  value={field.placeholder}
                  onChange={e => updateField(idx, { placeholder: e.target.value })}
                  placeholder="占位提示文本"
                />
                {needsOptions(field.type) && (
                  <input
                    className="fb-input fb-input-sm"
                    value={(field.options || []).join(', ')}
                    onChange={e => updateField(idx, {
                      options: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                    })}
                    placeholder="选项（用英文逗号分隔）"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <button className="collect-btn-ghost fb-add-btn" onClick={addField}>
          + 添加字段
        </button>
      </div>
    </div>
  )
}
