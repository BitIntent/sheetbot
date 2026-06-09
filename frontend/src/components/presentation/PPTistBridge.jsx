// ============================================================================
// PPTist React 桥接组件
// 使用 veaury 将 PPTist Vue 编辑器和放映器嵌入React
// 负责 Pinia 初始化、Props 传递、事件监听
// ============================================================================
import React, { useRef, useEffect, useCallback } from 'react'
import { applyVueInReact } from 'veaury'
import { getPinia } from '../../pptist-vue/bridge/pptistInit'
import directives from '../../pptist-vue/directive'
import PPTistEditorVue from '../../pptist-vue/bridge/PPTistEditor.vue'
import PPTistScreenVue from '../../pptist-vue/bridge/PPTistScreen.vue'

const pinia = getPinia()

const PPTistEditorWrapped = applyVueInReact(PPTistEditorVue, {
  pinia,
  beforeVueAppMount: (app) => {
    if (app && typeof app.use === 'function') {
      app.use(pinia)
      app.use(directives)
    }
  },
})

const PPTistScreenWrapped = applyVueInReact(PPTistScreenVue, {
  pinia,
  beforeVueAppMount: (app) => {
    if (app && typeof app.use === 'function') {
      app.use(pinia)
    }
  },
})

export default function PPTistBridge({
  slides,
  slideIndex,
  speakerName,
  screening,
  onSlidesChange,
  onSlideIndexChange,
  onSlidesReady,
  onExitScreening,
  onRequestExport,
  editorRef,
}) {
  const vueEditorRef = useRef(null)

  // veaury 将 Vue defineExpose 实例放在 __veauryVueRef__ 上
  const getVueExposed = useCallback(() => {
    const wrapper = vueEditorRef.current
    return wrapper?.__veauryVueRef__ || wrapper || null
  }, [])

  useEffect(() => {
    if (editorRef) {
      editorRef.current = {
        openExportDialog: (type) => getVueExposed()?.openExportDialog?.(type),
        startScreening: () => getVueExposed()?.startScreening?.(),
        openAIPPTDialog: () => getVueExposed()?.openAIPPTDialog?.(),
        getSlides: () => getVueExposed()?.getSlides?.(),
        setSlides: (s) => getVueExposed()?.setSlides?.(s),
        runAIPPT: (templateSlides, aipptSlides, dataElements, imgs, speaker, templateTheme) => {
          const vue = getVueExposed()
          if (typeof vue?.runAIPPT !== 'function') return false
          vue.runAIPPT(templateSlides, aipptSlides, dataElements, imgs, speaker, templateTheme)
          return true
        },
      }
    }
  }, [editorRef, getVueExposed])

  const handleSlidesUpdate = useCallback(
    (newSlides) => onSlidesChange?.(newSlides),
    [onSlidesChange]
  )

  const handleSlideIndexUpdate = useCallback(
    (idx) => onSlideIndexChange?.(idx),
    [onSlideIndexChange]
  )

  const handleSlidesReady = useCallback(
    () => onSlidesReady?.(),
    [onSlidesReady]
  )

  const handleExitScreening = useCallback(
    () => onExitScreening?.(),
    [onExitScreening]
  )

  return (
    <div className="pptist-bridge-container" style={{ height: '100%' }}>
      {!screening && (
        <PPTistEditorWrapped
          ref={vueEditorRef}
          slides={slides}
          slideIndex={slideIndex}
          speakerName={speakerName}
          onUpdate:slides={handleSlidesUpdate}
          onUpdate:slideIndex={handleSlideIndexUpdate}
          onSlidesReady={handleSlidesReady}
          onRequestExport={onRequestExport}
        />
      )}
      {screening && (
        <PPTistScreenWrapped
          onExitScreening={handleExitScreening}
        />
      )}
    </div>
  )
}
