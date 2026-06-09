// frontend/src/components/presentation/SlidePreview.jsx
/**
 * ============================================================================
 * 幻灯片在线预览 — 左侧缩略图导航 + 右侧大幻灯片渲染
 * ============================================================================
 */
import React from 'react'
import SlideRenderer from './SlideRenderer'

export default function SlidePreview({
  slides,
  currentIdx,
  templateKey,
  templateMetaByKey,
  title,
  onSelectSlide,
}) {
  if (!slides?.length) {
    return <div className="pres-empty">暂无幻灯片</div>
  }

  return (
    <div className="pres-preview-layout">
      {/* 左侧缩略图列表 */}
      <div className="pres-thumb-panel">
        {slides.map((slide, idx) => (
          <button
            key={idx}
            className={`pres-thumb-item ${idx === currentIdx ? 'active' : ''}`}
            onClick={() => onSelectSlide(idx)}
          >
            <div className="pres-thumb-number">{idx + 1}</div>
            <div className="pres-thumb-card">
              <SlideRenderer
                slide={slide}
                templateKey={templateKey}
                templateMetaByKey={templateMetaByKey}
                mini
              />
            </div>
          </button>
        ))}
      </div>

      {/* 右侧主幻灯片 */}
      <div className="pres-main-stage">
        <SlideRenderer
          slide={slides[currentIdx]}
          templateKey={templateKey}
          templateMetaByKey={templateMetaByKey}
        />
      </div>
    </div>
  )
}
