// ============================================================================
// 玩数据 Skill - 参数 UI 组件库
//
// 每个组件接收统一 props:
//   value, onChange, schema, onRequestRangeSelect?
// 根据 schema.type 渲染专属交互控件
// ============================================================================

import React, { useState, useRef, useCallback } from 'react'
import { Crosshair } from 'lucide-react'

// ============================================================================
// 常用颜色预设（用于 ColorPicker 色板）
// ============================================================================

const COLOR_PRESETS = [
  '#000000', '#434343', '#666666', '#999999', '#CCCCCC', '#FFFFFF',
  '#FF0000', '#FF6600', '#FFCC00', '#00CC00', '#0066FF', '#9900FF',
  '#FEE2E2', '#FEF3C7', '#DCFCE7', '#DBEAFE', '#EDE9FE', '#FCE7F3',
  '#B91C1C', '#D97706', '#16A34A', '#2563EB', '#7C3AED', '#DB2777',
]

// ============================================================================
// RangeInput - A1:C10 格式 + 点击预览表格选择
// ============================================================================

export function RangeInput({ value, onChange, schema, onRequestRangeSelect }) {
  const handleSelect = useCallback(() => {
    if (onRequestRangeSelect) {
      onRequestRangeSelect((rangeStr) => onChange(rangeStr), 'range')
    }
  }, [onRequestRangeSelect, onChange])

  return (
    <div className="skw-range-input">
      <input
        type="text"
        className="skw-input"
        value={value ?? schema?.default ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={schema?.placeholder || 'A1:C10'}
      />
      {onRequestRangeSelect && (
        <button type="button" className="skw-select-btn" onClick={handleSelect} title="从预览表格选择范围">
          <Crosshair size={14} />
        </button>
      )}
    </div>
  )
}

// ============================================================================
// CellInput - A1 格式 + 点击选择
// ============================================================================

export function CellInput({ value, onChange, schema, onRequestRangeSelect }) {
  const handleSelect = useCallback(() => {
    if (onRequestRangeSelect) {
      onRequestRangeSelect((cellStr) => onChange(cellStr), 'cell')
    }
  }, [onRequestRangeSelect, onChange])

  return (
    <div className="skw-range-input">
      <input
        type="text"
        className="skw-input"
        value={value ?? schema?.default ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={schema?.placeholder || 'A1'}
      />
      {onRequestRangeSelect && (
        <button type="button" className="skw-select-btn" onClick={handleSelect} title="从预览表格选择单元格">
          <Crosshair size={14} />
        </button>
      )}
    </div>
  )
}

// ============================================================================
// RowInput - 行号数字输入
// ============================================================================

export function RowInput({ value, onChange, schema }) {
  const numVal = typeof value === 'number' ? value : (parseInt(value) || schema?.default || 1)
  return (
    <input
      type="number"
      className="skw-input skw-input-narrow"
      value={numVal}
      min={1}
      onChange={e => onChange(parseInt(e.target.value) || 1)}
      placeholder="行号"
    />
  )
}

// ============================================================================
// ColumnInput - 列字母输入 (A, B, C...)
// ============================================================================

export function ColumnInput({ value, onChange, schema }) {
  return (
    <input
      type="text"
      className="skw-input skw-input-narrow"
      value={value ?? schema?.default ?? 'A'}
      onChange={e => onChange(e.target.value.toUpperCase())}
      placeholder="A"
      maxLength={3}
    />
  )
}

// ============================================================================
// MultiColumnInput - 多列选择 (A,B,C)
// ============================================================================

export function MultiColumnInput({ value, onChange, schema }) {
  return (
    <input
      type="text"
      className="skw-input"
      value={value ?? schema?.default ?? ''}
      onChange={e => onChange(e.target.value.toUpperCase())}
      placeholder={schema?.placeholder || 'A,B,C'}
    />
  )
}

// ============================================================================
// ColorPicker - 色板 + 自定义颜色输入
// ============================================================================

export function ColorPicker({ value, onChange, schema }) {
  const [showPalette, setShowPalette] = useState(false)
  const wrapRef = useRef(null)
  const currentColor = value || schema?.default || '#000000'

  const handleBlur = useCallback((e) => {
    if (wrapRef.current && !wrapRef.current.contains(e.relatedTarget)) {
      setShowPalette(false)
    }
  }, [])

  return (
    <div className="skw-color-picker" ref={wrapRef} onBlur={handleBlur}>
      <div className="skw-color-row">
        <button
          type="button"
          className="skw-color-swatch"
          style={{ backgroundColor: currentColor }}
          onClick={() => setShowPalette(!showPalette)}
          title="选择颜色"
        />
        <input
          type="text"
          className="skw-input skw-color-text"
          value={currentColor}
          onChange={e => onChange(e.target.value)}
          placeholder="#FFFFFF"
          maxLength={9}
        />
        <input
          type="color"
          className="skw-color-native"
          value={currentColor.length === 7 ? currentColor : '#000000'}
          onChange={e => onChange(e.target.value)}
          title="系统取色器"
        />
      </div>
      {showPalette && (
        <div className="skw-color-palette">
          {COLOR_PRESETS.map(c => (
            <button
              key={c}
              type="button"
              className={`skw-color-cell${c === currentColor ? ' is-active' : ''}`}
              style={{ backgroundColor: c }}
              onClick={() => { onChange(c); setShowPalette(false) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// NumberInput - 数字微调器
// ============================================================================

export function NumberInput({ value, onChange, schema }) {
  const { min = -Infinity, max = Infinity, step = 1 } = schema || {}
  const numVal = typeof value === 'number' ? value : (parseFloat(value) ?? schema?.default ?? 0)

  const clamp = (v) => Math.max(min, Math.min(max, v))

  return (
    <div className="skw-number-input">
      <button type="button" className="skw-num-btn" onClick={() => onChange(clamp(numVal - step))}>-</button>
      <input
        type="number"
        className="skw-input skw-input-narrow"
        value={numVal}
        min={min === -Infinity ? undefined : min}
        max={max === Infinity ? undefined : max}
        step={step}
        onChange={e => onChange(clamp(parseFloat(e.target.value) || 0))}
      />
      <button type="button" className="skw-num-btn" onClick={() => onChange(clamp(numVal + step))}>+</button>
    </div>
  )
}

// ============================================================================
// BooleanToggle - 开关按钮
// ============================================================================

export function BooleanToggle({ value, onChange }) {
  const isOn = value === true || value === 'true'
  return (
    <button
      type="button"
      className={`skw-toggle${isOn ? ' is-on' : ''}`}
      onClick={() => onChange(!isOn)}
      role="switch"
      aria-checked={isOn}
    >
      <span className="skw-toggle-track" />
      <span className="skw-toggle-thumb" />
    </button>
  )
}

// ============================================================================
// SelectInput - 下拉选择
// ============================================================================

export function SelectInput({ value, onChange, schema }) {
  const options = schema?.options || []
  return (
    <select
      className="skw-select"
      value={value ?? schema?.default ?? ''}
      onChange={e => onChange(e.target.value)}
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}

// ============================================================================
// TextInput - 文本输入
// ============================================================================

export function TextInput({ value, onChange, schema }) {
  return (
    <input
      type="text"
      className="skw-input"
      value={value ?? schema?.default ?? ''}
      onChange={e => onChange(e.target.value)}
      placeholder={schema?.placeholder || ''}
    />
  )
}

// ============================================================================
// FormulaInput - 公式输入（自动补 = 前缀）
// ============================================================================

export function FormulaInput({ value, onChange, schema }) {
  const raw = value ?? schema?.default ?? ''
  return (
    <div className="skw-formula-input">
      <span className="skw-formula-prefix">fx</span>
      <input
        type="text"
        className="skw-input"
        value={raw}
        onChange={e => onChange(e.target.value)}
        placeholder={schema?.placeholder || '=SUM(A1:A10)'}
      />
    </div>
  )
}

// ============================================================================
// ItemsInput - 逗号分隔的列表输入
// ============================================================================

export function ItemsInput({ value, onChange, schema }) {
  return (
    <input
      type="text"
      className="skw-input"
      value={value ?? schema?.default ?? ''}
      onChange={e => onChange(e.target.value)}
      placeholder={schema?.placeholder || '用逗号分隔'}
    />
  )
}

// ============================================================================
// 组件注册表 - type -> Component 映射
// ============================================================================

export const WIDGET_MAP = {
  range: RangeInput,
  cell: CellInput,
  row: RowInput,
  column: ColumnInput,
  columns: MultiColumnInput,
  color: ColorPicker,
  number: NumberInput,
  boolean: BooleanToggle,
  select: SelectInput,
  text: TextInput,
  formula: FormulaInput,
  items: ItemsInput,
}

// ============================================================================
// 通用渲染器 - 根据 schema.type 自动选择组件
// ============================================================================

export function ParamWidget({ schema, value, onChange, onRequestRangeSelect }) {
  const Widget = WIDGET_MAP[schema?.type] || TextInput
  return <Widget value={value} onChange={onChange} schema={schema} onRequestRangeSelect={onRequestRangeSelect} />
}
