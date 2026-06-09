// ============================================================================
// 玩数据 Skill - 步骤构建器 (v2)
//
// 技能箱 (SKILL_PALETTE) + 步骤画布 + 类型化参数编辑器
// 每个参数根据 schema.type 渲染专属 UI 组件
// ============================================================================

import React, { useState, useRef, useCallback, useMemo } from 'react'
import { Trash2, GripVertical, ChevronDown, ChevronRight, RotateCcw, Info } from 'lucide-react'
import { nanoid } from 'nanoid'
import { SKILL_PALETTE, SKILL_CONFIGS } from './skillOperationConfigs'
import { ParamWidget } from './SkillParamWidgets'
import { letterToCol } from '../utils/skillTranslator'

// ============================================================================
// 构建默认参数（从 schema params 数组 -> 平铺 key-value 对象）
// ============================================================================

function buildDefaultParams(skillType) {
  const config = SKILL_CONFIGS[skillType]
  if (!config?.params) return {}
  const defaults = {}
  for (const p of config.params) {
    if (p.default !== undefined) defaults[p.key] = p.default
  }
  return defaults
}

// ============================================================================
// 技能箱分类面板
// ============================================================================

function PaletteCategory({ category, skills, onAddSkill, searchQuery }) {
  const [expanded, setExpanded] = useState(true)

  const handleDragStart = useCallback((e, skill) => {
    e.dataTransfer.setData('application/skill-op', JSON.stringify(skill))
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

  // 搜索过滤
  const filtered = useMemo(() => {
    if (!searchQuery) return skills
    const q = searchQuery.toLowerCase()
    return skills.filter(s => s.label.includes(q) || s.type.includes(q))
  }, [skills, searchQuery])

  if (filtered.length === 0) return null

  return (
    <div className="skill-palette-category">
      <button
        type="button"
        className="skill-palette-cat-header"
        onClick={() => setExpanded(v => !v)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{category}</span>
        <span className="skill-palette-cat-count">{filtered.length}</span>
      </button>
      {expanded && (
        <div className="skill-palette-ops">
          {filtered.map(skill => (
            <div
              key={skill.type}
              className="skill-palette-chip"
              draggable
              onDragStart={e => handleDragStart(e, skill)}
              onClick={() => onAddSkill(skill)}
              title={SKILL_CONFIGS[skill.type]?.description || skill.label}
            >
              <GripVertical size={10} className="skill-palette-grip" />
              <span>{skill.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 类型化参数编辑器（根据 SKILL_CONFIGS schema 渲染 UI 组件）
// ============================================================================

function TypedParamsEditor({ skillType, params, onParamChange, onParamsReplace, onRequestRangeSelect, sheetContext }) {
  const config = SKILL_CONFIGS[skillType]
  const paramDefs = config?.params || []
  const currentColumnWidth = useMemo(() => {
    if (skillType !== 'set_column_width') return null
    const colText = String(params?.column || '').replace(/[^A-Za-z]/g, '').toUpperCase()
    if (!colText) return null
    const colIndex = letterToCol(colText)
    const width = Number(sheetContext?.colWidths?.[colIndex])
    if (!Number.isFinite(width) || width <= 0) return null
    return width
  }, [skillType, params?.column, sheetContext?.colWidths])

  // 条件可见性：某些参数仅在特定条件下显示
  const isVisible = useCallback((def) => {
    if (!def.visibleWhen) return true
    const { key, value } = def.visibleWhen
    return params?.[key] === value
  }, [params])

  // 检测参数值中是否含有 {{...}} 动态变量
  const hasVariableParams = useMemo(() => {
    if (!params) return false
    return Object.values(params).some(v => typeof v === 'string' && /\{\{.+\}\}/.test(v))
  }, [params])

  if (paramDefs.length === 0) {
    return <div className="skw-empty-params">此技能无需配置参数</div>
  }

  return (
    <div className="skw-params-editor">
      {paramDefs.map(def => {
        if (!isVisible(def)) return null
        const currentVal = params?.[def.key]
        return (
          <div key={def.key} className="skw-param-row">
            <label className="skw-param-label">
              {def.label}
              {def.required && <span className="skw-required">*</span>}
            </label>
            <div className="skw-param-control">
              <ParamWidget
                schema={def}
                value={currentVal}
                onChange={(v) => onParamChange(def.key, v)}
                onRequestRangeSelect={onRequestRangeSelect}
              />
              {skillType === 'custom_formula' && def.key === 'expression' && (
                <div className="skw-live-meta">
                  表达式示例：<code>E*F</code>（可用列字母直接引用同一行数据）
                </div>
              )}
              {skillType === 'set_column_width' && def.key === 'width' && (
                <div className="skw-live-meta">
                  当前列宽：{currentColumnWidth ?? '未设置（默认宽度）'}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* 动态变量提示：仅当参数中实际使用了变量时才显示 */}
      {hasVariableParams && (
        <div className="skw-vars-hint">
          <Info size={12} />
          <span>含动态变量，执行时自动替换为实际值（如 <code>{'{{sheet.range}}'}</code> = 整个数据区域）</span>
        </div>
      )}

      {/* 恢复默认按钮 */}
      <button
        type="button"
        className="skw-reset-btn"
        onClick={() => onParamsReplace(buildDefaultParams(skillType))}
        title="恢复此技能的默认参数"
      >
        <RotateCcw size={12} /> 恢复默认
      </button>
    </div>
  )
}

// ============================================================================
// 单步骤卡片
// ============================================================================

function StepCard({ step, index, expanded, onToggle, onChange, onDelete,
  onDragStart, onDragOver, onDrop, onRequestRangeSelect, sheetContext }) {

  const handleParamChange = useCallback((key, value) => {
    onChange({ ...step, params: { ...step.params, [key]: value } })
  }, [step, onChange])

  const handleParamsReplace = useCallback((nextParams) => {
    onChange({ ...step, params: nextParams })
  }, [step, onChange])

  const handleLabelChange = useCallback((e) => {
    onChange({ ...step, label: e.target.value })
  }, [step, onChange])

  const config = SKILL_CONFIGS[step.operation_type]

  return (
    <div
      className="skill-step-card"
      draggable
      onDragStart={e => onDragStart(e, index)}
      onDragOver={e => onDragOver(e, index)}
      onDrop={e => onDrop(e, index)}
    >
      <div className="skill-step-header" onDoubleClick={onToggle}>
        <div className="skill-step-drag-handle">
          <GripVertical size={14} />
        </div>
        <div className="skill-step-num">{index + 1}</div>
        <div className="skill-step-main" onDoubleClick={e => e.stopPropagation()}>
          <input
            className="skill-step-label-input"
            value={step.label}
            onChange={handleLabelChange}
            onDoubleClick={e => e.stopPropagation()}
            placeholder="步骤名称"
          />
          <div className="skill-step-desc-inline" title={config?.description || ''}>
            {config?.description || '该技能无说明'}
          </div>
        </div>
        <span className="skill-step-op-badge" title={config?.description || ''}>
          {config?.label || step.operation_type}
        </span>
        <button type="button" className="skill-step-toggle" onClick={onToggle}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button type="button" className="skill-step-delete" onClick={onDelete} title="删除步骤">
          <Trash2 size={13} />
        </button>
      </div>

      {expanded && (
        <div className="skill-step-params">
          <TypedParamsEditor
            skillType={step.operation_type}
            params={step.params}
            onParamChange={handleParamChange}
            onParamsReplace={handleParamsReplace}
            onRequestRangeSelect={onRequestRangeSelect}
            sheetContext={sheetContext}
          />
        </div>
      )}
    </div>
  )
}

// ============================================================================
// SkillStepBuilder 主体
// ============================================================================

export default function SkillStepBuilder({ steps, onChange, onRequestRangeSelect, sheetContext }) {
  const [expandedIds, setExpandedIds] = useState(new Set())
  const [dragIndex, setDragIndex] = useState(null)
  const [dropZoneActive, setDropZoneActive] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const dropZoneRef = useRef(null)

  // 从技能箱添加
  const handleAddSkill = useCallback((skill) => {
    const newStep = {
      id: nanoid(),
      label: skill.label,
      operation_type: skill.type,
      params: buildDefaultParams(skill.type),
    }
    onChange([...steps, newStep])
    setExpandedIds(prev => new Set([...prev, newStep.id]))
  }, [steps, onChange])

  // 拖入画布
  const handleCanvasDrop = useCallback((e) => {
    e.preventDefault()
    setDropZoneActive(false)
    const opData = e.dataTransfer.getData('application/skill-op')
    if (!opData) return
    const skill = JSON.parse(opData)
    handleAddSkill(skill)
  }, [handleAddSkill])

  // 步骤内部拖拽排序
  const handleStepDragStart = useCallback((e, index) => {
    e.dataTransfer.setData('application/skill-step-index', String(index))
    e.dataTransfer.effectAllowed = 'move'
    setDragIndex(index)
  }, [])

  const handleStepDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleStepDrop = useCallback((e, targetIndex) => {
    e.preventDefault()
    const fromIndexStr = e.dataTransfer.getData('application/skill-step-index')
    if (!fromIndexStr) return
    const fromIndex = parseInt(fromIndexStr, 10)
    if (fromIndex === targetIndex || isNaN(fromIndex)) return
    const next = [...steps]
    const [moved] = next.splice(fromIndex, 1)
    next.splice(targetIndex, 0, moved)
    onChange(next)
    setDragIndex(null)
  }, [steps, onChange])

  const handleStepChange = useCallback((index, updatedStep) => {
    const next = [...steps]
    next[index] = updatedStep
    onChange(next)
  }, [steps, onChange])

  const handleDeleteStep = useCallback((index) => {
    onChange(steps.filter((_, i) => i !== index))
  }, [steps, onChange])

  const toggleExpand = useCallback((id) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  return (
    <div className="skill-step-builder">
      {/* ---- 左侧：技能箱 ---- */}
      <div className="skill-palette">
        <div className="skill-palette-title">技能箱</div>
        <div className="skill-palette-search">
          <input
            type="text"
            placeholder="搜索技能..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="skill-palette-search-input"
          />
        </div>
        <div className="skill-palette-scroll">
          {SKILL_PALETTE.map(cat => (
            <PaletteCategory
              key={cat.category}
              category={cat.category}
              skills={cat.skills}
              onAddSkill={handleAddSkill}
              searchQuery={searchQuery}
            />
          ))}
        </div>
        <div className="skill-palette-hint">拖拽到右侧添加步骤</div>
      </div>

      {/* ---- 右侧：步骤画布 ---- */}
      <div
        className="skill-canvas"
        onDragOver={e => { e.preventDefault(); setDropZoneActive(true) }}
        onDragLeave={() => setDropZoneActive(false)}
        onDrop={handleCanvasDrop}
      >
        <div className="skill-canvas-title">
          执行步骤
          <span className="skill-canvas-count">({steps.length}步)</span>
        </div>

        <div className="skill-steps-list">
          {steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              expanded={expandedIds.has(step.id)}
              onToggle={() => toggleExpand(step.id)}
              onChange={(updated) => handleStepChange(index, updated)}
              onDelete={() => handleDeleteStep(index)}
              onDragStart={handleStepDragStart}
              onDragOver={handleStepDragOver}
              onDrop={handleStepDrop}
              onRequestRangeSelect={onRequestRangeSelect}
              sheetContext={sheetContext}
            />
          ))}
        </div>

        <div
          ref={dropZoneRef}
          className={`skill-drop-zone${dropZoneActive ? ' active' : ''}`}
        >
          + 拖拽操作到此处添加步骤
        </div>
      </div>
    </div>
  )
}
