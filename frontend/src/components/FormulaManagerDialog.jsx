import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { X, Plus, Trash2, Edit3, Check, AlertCircle, Play } from 'lucide-react'
import * as formulaApi from '../api/formula'

// ============================================================================
// 列引用解析（复用于预览计算）
// ============================================================================

const JS_RESERVED = new Set([
  'Math', 'NaN', 'Infinity', 'undefined', 'null',
  'true', 'false', 'if', 'else', 'return',
])

function parseColumnRefs(expression) {
  const matches = expression.match(/\b([A-Z]{1,2})\b/g) || []
  return [...new Set(matches.filter(m => !JS_RESERVED.has(m)))]
}

function tryEvalExpression(expression, testValue, params, colValues) {
  try {
    const ctx = { value: testValue }
    for (const [letter, val] of Object.entries(colValues || {})) {
      ctx[letter] = val
    }
    for (const [k, v] of Object.entries(params || {})) {
      ctx[k] = v
    }
    const keys = Object.keys(ctx)
    const vals = Object.values(ctx)
    const fn = new Function(...keys, `return ${expression}`)
    const result = fn(...vals)
    if (typeof result !== 'number' || !isFinite(result)) return '(非数值)'
    return Number.isInteger(result) ? result : parseFloat(result.toFixed(4))
  } catch {
    return '(表达式错误)'
  }
}

// ============================================================================
// 空参数行模板
// ============================================================================

function emptyParam() {
  return { name: '', label: '', default: 0, type: 'number' }
}

// ============================================================================
// FormulaManagerDialog
// ============================================================================

export default function FormulaManagerDialog({ open, onClose, accessToken }) {
  const [formulas, setFormulas] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [editMode, setEditMode] = useState(null)
  const [error, setError] = useState('')

  // 编辑表单
  const [form, setForm] = useState({
    name: '', label: '', description: '', expression: '', params: [],
  })

  // 预览
  const [testValue, setTestValue] = useState(100)
  const [testCols, setTestCols] = useState({})

  // ------------------------------------------------------------------
  // 加载
  // ------------------------------------------------------------------

  const loadFormulas = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const data = await formulaApi.listFormulas(accessToken)
      setFormulas(data.formulas || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    if (open) {
      loadFormulas()
      setSelectedId(null)
      setEditMode(null)
      setError('')
    }
  }, [open, loadFormulas])

  // ------------------------------------------------------------------
  // 选中公式 -> 加载到表单
  // ------------------------------------------------------------------

  const selectedFormula = useMemo(
    () => formulas.find(f => f.id === selectedId) || null,
    [formulas, selectedId],
  )

  useEffect(() => {
    if (!selectedFormula) return
    setForm({
      name: selectedFormula.name,
      label: selectedFormula.label,
      description: selectedFormula.description,
      expression: selectedFormula.expression,
      params: selectedFormula.params?.length
        ? selectedFormula.params.map(p => ({ ...p }))
        : [],
    })
    setTestCols({})
  }, [selectedFormula])

  // ------------------------------------------------------------------
  // 列引用 & 预览
  // ------------------------------------------------------------------

  const colRefs = useMemo(() => parseColumnRefs(form.expression || ''), [form.expression])

  const previewResult = useMemo(() => {
    if (!form.expression) return '-'
    const paramDefaults = {}
    for (const p of form.params) {
      if (p.name) paramDefaults[p.name] = p.default ?? 0
    }
    return tryEvalExpression(form.expression, testValue, paramDefaults, testCols)
  }, [form.expression, form.params, testValue, testCols])

  // ------------------------------------------------------------------
  // 表单 helpers
  // ------------------------------------------------------------------

  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }))

  const addParam = () => setForm(prev => ({
    ...prev, params: [...prev.params, emptyParam()],
  }))

  const removeParam = (idx) => setForm(prev => ({
    ...prev, params: prev.params.filter((_, i) => i !== idx),
  }))

  const updateParam = (idx, field, value) => setForm(prev => {
    const next = [...prev.params]
    next[idx] = { ...next[idx], [field]: value }
    return { ...prev, params: next }
  })

  // ------------------------------------------------------------------
  // 新建
  // ------------------------------------------------------------------

  const handleNew = () => {
    setSelectedId(null)
    setEditMode('create')
    setForm({ name: '', label: '', description: '', expression: '', params: [] })
    setTestCols({})
    setError('')
  }

  // ------------------------------------------------------------------
  // 编辑
  // ------------------------------------------------------------------

  const handleEdit = () => {
    if (!selectedFormula) return
    setEditMode('edit')
    setError('')
  }

  // ------------------------------------------------------------------
  // 保存
  // ------------------------------------------------------------------

  const handleSave = async () => {
    setError('')
    if (!form.name.trim() || !form.label.trim() || !form.expression.trim()) {
      setError('名称、显示名和表达式不能为空')
      return
    }
    const body = {
      name: form.name.trim(),
      label: form.label.trim(),
      description: form.description.trim(),
      expression: form.expression.trim(),
      params: form.params.filter(p => p.name.trim()),
    }
    try {
      if (editMode === 'create') {
        await formulaApi.createFormula(accessToken, body)
      } else {
        const updateBody = { ...body }
        delete updateBody.name
        await formulaApi.updateFormula(accessToken, selectedId, updateBody)
      }
      await loadFormulas()
      setEditMode(null)
    } catch (e) {
      setError(e.message)
    }
  }

  // ------------------------------------------------------------------
  // 删除
  // ------------------------------------------------------------------

  const handleDelete = async () => {
    if (!selectedFormula || selectedFormula.is_preset) return
    try {
      await formulaApi.deleteFormula(accessToken, selectedId)
      setSelectedId(null)
      setEditMode(null)
      await loadFormulas()
    } catch (e) {
      setError(e.message)
    }
  }

  // ------------------------------------------------------------------
  // 取消编辑
  // ------------------------------------------------------------------

  const handleCancel = () => {
    setEditMode(null)
    setError('')
    if (selectedFormula) {
      setForm({
        name: selectedFormula.name,
        label: selectedFormula.label,
        description: selectedFormula.description,
        expression: selectedFormula.expression,
        params: selectedFormula.params?.map(p => ({ ...p })) || [],
      })
    }
  }

  if (!open) return null

  const isEditing = editMode === 'create' || editMode === 'edit'
  const canDelete = selectedFormula && !selectedFormula.is_preset && !isEditing

  return (
    <div className="fm-overlay" onClick={onClose}>
      <div className="fm-dialog" onClick={e => e.stopPropagation()}>

        {/* ---- 标题栏 ---- */}
        <div className="fm-header">
          <span className="fm-title">自定义公式管理</span>
          <button className="fm-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="fm-body">

          {/* ---- 左侧列表 ---- */}
          <div className="fm-list">
            <div className="fm-list-toolbar">
              <button className="fm-btn fm-btn-accent" onClick={handleNew}>
                <Plus size={14} /> 新建
              </button>
            </div>
            {loading ? (
              <div className="fm-empty">加载中...</div>
            ) : formulas.length === 0 ? (
              <div className="fm-empty">暂无公式</div>
            ) : (
              <div className="fm-list-items">
                {formulas.map(f => (
                  <div
                    key={f.id}
                    className={`fm-list-item ${f.id === selectedId ? 'active' : ''}`}
                    onClick={() => { setSelectedId(f.id); setEditMode(null); setError('') }}
                  >
                    <span className="fm-item-label">{f.label}</span>
                    {f.is_preset && <span className="fm-badge">预设</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---- 右侧详情/编辑 ---- */}
          <div className="fm-detail">
            {!selectedFormula && !isEditing ? (
              <div className="fm-placeholder">
                <div className="fm-placeholder-title">选择或新建公式</div>
                <div className="fm-guide">
                  <div className="fm-guide-title">使用指引</div>
                  <ul>
                    <li><code>value</code> 代表当前单元格的数值</li>
                    <li>列字母（如 <code>C</code>、<code>D</code>）代表同行对应列的数值</li>
                    <li>自定义参数（如 <code>rate</code>）为常量，应用时可调整</li>
                  </ul>
                  <div className="fm-guide-title">示例</div>
                  <ul>
                    <li>单单元格：<code>value * (1 - rate)</code></li>
                    <li>多列联动：<code>C - D</code>（C 列减 D 列）</li>
                    <li>混合：<code>C * D * (1 + rate)</code></li>
                  </ul>
                  <div className="fm-guide-title">调用方式</div>
                  <ul>
                    <li>右键单元格 / 列头 -&gt; 选择公式应用</li>
                    <li>AI 助手输入"F 列采用XX公式计算"</li>
                  </ul>
                </div>
              </div>
            ) : (
              <>
                {/* 操作按钮 */}
                <div className="fm-detail-toolbar">
                  {isEditing ? (
                    <>
                      <button className="fm-btn fm-btn-accent" onClick={handleSave}>
                        <Check size={14} /> 保存
                      </button>
                      <button className="fm-btn" onClick={handleCancel}>取消</button>
                    </>
                  ) : (
                    <>
                      <button className="fm-btn" onClick={handleEdit}>
                        <Edit3 size={14} /> 编辑
                      </button>
                      <button
                        className="fm-btn fm-btn-danger"
                        onClick={handleDelete}
                        disabled={!canDelete}
                        title={selectedFormula?.is_preset ? '预设公式不可删除' : ''}
                      >
                        <Trash2 size={14} /> 删除
                      </button>
                    </>
                  )}
                </div>

                {error && (
                  <div className="fm-error">
                    <AlertCircle size={14} /> {error}
                  </div>
                )}

                {/* 表单 */}
                <div className="fm-form">
                  <label className="fm-label">
                    标识名（唯一）
                    <input
                      className="fm-input"
                      value={form.name}
                      onChange={e => updateField('name', e.target.value)}
                      disabled={!isEditing || editMode === 'edit'}
                      placeholder="如 TAX_DEDUCT"
                    />
                  </label>
                  <label className="fm-label">
                    显示名称
                    <input
                      className="fm-input"
                      value={form.label}
                      onChange={e => updateField('label', e.target.value)}
                      disabled={!isEditing}
                      placeholder="如 税后金额"
                    />
                  </label>
                  <label className="fm-label">
                    描述
                    <input
                      className="fm-input"
                      value={form.description}
                      onChange={e => updateField('description', e.target.value)}
                      disabled={!isEditing}
                      placeholder="简要说明公式用途"
                    />
                  </label>
                  <label className="fm-label">
                    表达式
                    <input
                      className="fm-input fm-input-mono"
                      value={form.expression}
                      onChange={e => updateField('expression', e.target.value)}
                      disabled={!isEditing}
                      placeholder="如 value * (1 - rate) 或 C - D"
                    />
                    {colRefs.length > 0 && (
                      <span className="fm-hint">引用列: {colRefs.join(', ')}</span>
                    )}
                  </label>

                  {/* 参数 */}
                  <div className="fm-params-section">
                    <div className="fm-params-header">
                      <span>常量参数</span>
                      {isEditing && (
                        <button className="fm-btn-sm" onClick={addParam}>
                          <Plus size={12} /> 添加
                        </button>
                      )}
                    </div>
                    {form.params.length === 0 ? (
                      <div className="fm-hint">无常量参数</div>
                    ) : (
                      form.params.map((p, idx) => (
                        <div key={idx} className="fm-param-row">
                          <input
                            className="fm-input fm-input-sm"
                            value={p.name}
                            onChange={e => updateParam(idx, 'name', e.target.value)}
                            disabled={!isEditing}
                            placeholder="变量名"
                          />
                          <input
                            className="fm-input fm-input-sm"
                            value={p.label}
                            onChange={e => updateParam(idx, 'label', e.target.value)}
                            disabled={!isEditing}
                            placeholder="显示名"
                          />
                          <input
                            className="fm-input fm-input-sm fm-input-num"
                            type="number"
                            step={p.type === 'percent' ? 0.01 : 1}
                            value={p.default}
                            onChange={e => updateParam(idx, 'default', parseFloat(e.target.value) || 0)}
                            disabled={!isEditing}
                          />
                          <select
                            className="fm-input fm-input-sm"
                            value={p.type}
                            onChange={e => updateParam(idx, 'type', e.target.value)}
                            disabled={!isEditing}
                          >
                            <option value="number">数值</option>
                            <option value="percent">百分比</option>
                          </select>
                          {isEditing && (
                            <button className="fm-btn-icon" onClick={() => removeParam(idx)}>
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {/* 实时预览 */}
                  <div className="fm-preview">
                    <div className="fm-preview-title">
                      <Play size={14} /> 实时预览
                    </div>
                    <div className="fm-preview-inputs">
                      <label className="fm-preview-label">
                        value
                        <input
                          className="fm-input fm-input-sm fm-input-num"
                          type="number"
                          value={testValue}
                          onChange={e => setTestValue(parseFloat(e.target.value) || 0)}
                        />
                      </label>
                      {colRefs.map(col => (
                        <label key={col} className="fm-preview-label">
                          {col} 列
                          <input
                            className="fm-input fm-input-sm fm-input-num"
                            type="number"
                            value={testCols[col] ?? 0}
                            onChange={e => setTestCols(prev => ({
                              ...prev, [col]: parseFloat(e.target.value) || 0,
                            }))}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="fm-preview-result">
                      结果: <strong>{previewResult}</strong>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
