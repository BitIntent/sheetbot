// ============================================================================
// 字段映射面板 - 外部字段 <-> Excel 列名
// ============================================================================
import React from 'react'
import { ArrowRight, Plus, X } from 'lucide-react'

export default function FieldMappingPanel({ mapping, availableFields, columns, targetFileBound, targetFileReady, onChange }) {
  const entries = Object.entries(mapping || {})
  const externalOptions = (availableFields || []).filter(
    f => typeof f === 'string' && f.trim() && !f.trim().startsWith('(')
  )
  const excelOptions = (columns || []).filter(c => typeof c === 'string' && c.trim())

  const handleUpdate = (oldKey, newKey, newValue) => {
    const updated = { ...mapping }
    if (oldKey && oldKey !== newKey) delete updated[oldKey]
    if (newKey) updated[newKey] = newValue
    onChange(updated)
  }

  const handleRemove = (key) => {
    const updated = { ...mapping }
    delete updated[key]
    onChange(updated)
  }

  const handleAdd = () => {
    const unusedField = externalOptions.find(f => !(f in (mapping || {})))
    const name = unusedField || `field_${entries.length + 1}`
    onChange({ ...mapping, [name]: name })
  }

  return (
    <div className="connect-mapping-panel">
      <div className="connect-mapping-header">
        <span className="connect-mapping-title">字段映射</span>
        <span className="connect-mapping-hint">外部字段 {'->'} Excel 列名</span>
      </div>

      <div className="connect-mapping-rows">
        {externalOptions.length === 0 && (
          <div className="connect-config-hint">
            暂未识别到外部字段，请先点击“测试连接”并确认 SQL 可正常返回列名。
          </div>
        )}
        {targetFileBound && !targetFileReady && (
          <div className="connect-config-hint">
            当前未切换到已绑定目标工作簿，Excel 列名下拉可能不完整（仅显示已选值）。如需修改映射，请先在左侧切换到目标工作簿。
          </div>
        )}
        {targetFileReady && excelOptions.length === 0 && (
          <div className="connect-config-hint">
            目标工作簿首行未识别到列名，请先在目标工作表第一行填写列头。
          </div>
        )}
        {entries.map(([extField, excelCol], idx) => (
          <div key={idx} className="connect-mapping-row">
            <select
              className="connect-config-select connect-mapping-input"
              value={extField}
              onChange={e => handleUpdate(extField, e.target.value, excelCol)}
            >
              {[...new Set([extField, ...externalOptions])].map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <ArrowRight size={16} className="connect-mapping-arrow" />
            <select
              className="connect-config-select connect-mapping-input"
              value={excelCol}
              onChange={e => handleUpdate(extField, extField, e.target.value)}
            >
              {[...new Set([excelCol, ...excelOptions])].map(option => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <button className="connect-mapping-remove" onClick={() => handleRemove(extField)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <button className="collect-btn-ghost connect-mapping-add" onClick={handleAdd}>
        <Plus size={14} /> 添加映射
      </button>
    </div>
  )
}
