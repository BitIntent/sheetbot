// frontend/src/components/presentation/SlideEditor.jsx
/**
 * ============================================================================
 * 幻灯片编辑器 — 支持修改标题/要点/备注
 * ============================================================================
 */
import React, { useState, useCallback } from 'react'
import { Save } from 'lucide-react'
import SlideRenderer from './SlideRenderer'

export default function SlideEditor({
  slides,
  currentIdx,
  templateKey,
  templateMetaByKey,
  onSlideChange,
  onSave,
  onSelectSlide,
}) {
  const slide = slides[currentIdx]
  if (!slide) return null

  const updateField = (field, value) => {
    onSlideChange(currentIdx, { ...slide, [field]: value })
  }

  const updateBullet = (i, value) => {
    const bullets = [...(slide.bullets || [])]
    bullets[i] = value
    onSlideChange(currentIdx, { ...slide, bullets })
  }

  const addBullet = () => {
    const bullets = [...(slide.bullets || []), '']
    onSlideChange(currentIdx, { ...slide, bullets })
  }

  const removeBullet = (i) => {
    const bullets = (slide.bullets || []).filter((_, idx) => idx !== i)
    onSlideChange(currentIdx, { ...slide, bullets })
  }

  return (
    <div className="pres-editor-layout">
      {/* 左侧缩略图 */}
      <div className="pres-thumb-panel">
        {slides.map((s, idx) => (
          <button
            key={idx}
            className={`pres-thumb-item ${idx === currentIdx ? 'active' : ''}`}
            onClick={() => onSelectSlide(idx)}
          >
            <div className="pres-thumb-number">{idx + 1}</div>
            <div className="pres-thumb-card">
              <SlideRenderer slide={s} templateKey={templateKey} templateMetaByKey={templateMetaByKey} mini />
            </div>
          </button>
        ))}
      </div>

      {/* 中间预览 */}
      <div className="pres-editor-preview">
        <SlideRenderer slide={slide} templateKey={templateKey} templateMetaByKey={templateMetaByKey} />
      </div>

      {/* 右侧属性面板 */}
      <div className="pres-editor-props">
        <div className="pres-props-header">
          <span>编辑幻灯片 #{currentIdx + 1}</span>
          <button className="pres-btn-sm" onClick={onSave} title="保存所有修改">
            <Save size={14} />
            <span>保存</span>
          </button>
        </div>

        <div className="pres-prop-group">
          <label className="pres-prop-label">版式</label>
          <select
            className="pres-prop-select"
            value={slide.layout}
            onChange={(e) => updateField('layout', e.target.value)}
          >
            <option value="cover">封面</option>
            <option value="toc">目录</option>
            <option value="kpi">KPI</option>
            <option value="chart">图表</option>
            <option value="table">表格</option>
            <option value="summary">总结</option>
            <option value="content">通用内容</option>
          </select>
        </div>

        <div className="pres-prop-group">
          <label className="pres-prop-label">标题</label>
          <input
            className="pres-prop-input"
            value={slide.title || ''}
            onChange={(e) => updateField('title', e.target.value)}
          />
        </div>

        <div className="pres-prop-group">
          <label className="pres-prop-label">副标题</label>
          <input
            className="pres-prop-input"
            value={slide.subtitle || ''}
            onChange={(e) => updateField('subtitle', e.target.value)}
          />
        </div>

        <div className="pres-prop-group">
          <label className="pres-prop-label">
            要点
            <button className="pres-btn-xs" onClick={addBullet}>+ 添加</button>
          </label>
          {(slide.bullets || []).map((b, i) => (
            <div key={i} className="pres-bullet-row">
              <input
                className="pres-prop-input"
                value={b}
                onChange={(e) => updateBullet(i, e.target.value)}
              />
              <button className="pres-btn-xs pres-btn-danger" onClick={() => removeBullet(i)}>x</button>
            </div>
          ))}
        </div>

        <div className="pres-prop-group">
          <label className="pres-prop-label">演讲者备注</label>
          <textarea
            className="pres-prop-textarea"
            value={slide.notes || ''}
            onChange={(e) => updateField('notes', e.target.value)}
            rows={3}
          />
        </div>
      </div>
    </div>
  )
}
