// frontend/src/components/presentation/SlidePlayer.jsx
/**
 * ============================================================================
 * 全屏幻灯片播放模式
 * 键盘：左/右箭头翻页，空格下一页，ESC 退出
 * ============================================================================
 */
import React, { useState, useEffect, useCallback } from 'react'
import SlideRenderer from './SlideRenderer'

export default function SlidePlayer({ slides, templateKey, templateMetaByKey, onExit }) {
  const [idx, setIdx] = useState(0)
  const total = slides?.length || 0

  const goPrev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), [])
  const goNext = useCallback(() => setIdx((i) => Math.min(total - 1, i + 1)), [total])

  // 键盘控制
  useEffect(() => {
    const handler = (e) => {
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          goPrev()
          break
        case 'ArrowRight':
        case 'ArrowDown':
        case ' ':
          e.preventDefault()
          goNext()
          break
        case 'Escape':
          onExit()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goPrev, goNext, onExit])

  // 全屏
  useEffect(() => {
    const el = document.documentElement
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {})
    }
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      }
    }
  }, [])

  // 全屏退出时也退出播放
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) onExit()
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [onExit])

  if (!total) return null

  return (
    <div className="pres-player-overlay" onClick={goNext}>
      <div className="pres-player-stage">
        <SlideRenderer
          slide={slides[idx]}
          templateKey={templateKey}
          templateMetaByKey={templateMetaByKey}
        />
      </div>

      {/* 底部进度条 */}
      <div className="pres-player-progress">
        <div
          className="pres-player-progress-fill"
          style={{ width: `${((idx + 1) / total) * 100}%` }}
        />
      </div>

      {/* 页码指示 */}
      <div className="pres-player-page-indicator" onClick={(e) => e.stopPropagation()}>
        {idx + 1} / {total}
      </div>

      {/* 左右点击区域 */}
      <div
        className="pres-player-left-zone"
        onClick={(e) => { e.stopPropagation(); goPrev() }}
      />
    </div>
  )
}
