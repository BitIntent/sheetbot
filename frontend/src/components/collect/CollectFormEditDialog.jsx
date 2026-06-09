import React from 'react'
import { Loader2, X } from 'lucide-react'

export default function CollectFormEditDialog({
  open,
  saving,
  draft,
  workbookOptions,
  onClose,
  onChange,
  onSave,
}) {
  if (!open) return null

  return (
    <div className="collect-edit-modal-mask" onClick={onClose}>
      <div className="collect-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="collect-edit-modal-header">
          <h3>修改表单</h3>
          <button className="collect-edit-modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="collect-edit-modal-body">
          <div className="fb-section">
            <label className="fb-label">标题</label>
            <input
              className="fb-input"
              value={draft.title}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
              placeholder="请输入表单标题"
            />
          </div>
          <div className="fb-section">
            <label className="fb-label">描述</label>
            <textarea
              className="fb-textarea"
              rows={3}
              value={draft.description}
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
              placeholder="请输入表单描述"
            />
          </div>
          <div className="fb-section">
            <label className="fb-label">映射工作簿</label>
            <select
              className="fb-select"
              value={draft.file_id}
              onChange={(e) => onChange({ ...draft, file_id: e.target.value })}
            >
              <option value="">不绑定工作簿</option>
              {workbookOptions.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <div className="fb-section">
            <label className="fb-label">映射工作表名</label>
            <input
              className="fb-input"
              value={draft.sheet_name}
              onChange={(e) => onChange({ ...draft, sheet_name: e.target.value })}
              placeholder="如：Sheet1"
            />
          </div>
        </div>
        <div className="collect-edit-modal-footer">
          <button className="collect-btn-ghost" onClick={onClose}>取消</button>
          <button className="collect-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="spin" /> : null}
            <span>保存修改</span>
          </button>
        </div>
      </div>
    </div>
  )
}

