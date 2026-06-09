import { storeToRefs } from 'pinia'
import { useMainStore } from '@pptist/store'
import type { PPTShapeElement } from '@pptist/types/slides'

export default () => {
  const mainStore = useMainStore()
  const { shapeFormatPainter, handleElement } = storeToRefs(mainStore)

  const toggleShapeFormatPainter = (keep = false) => {
    const _handleElement = handleElement.value as PPTShapeElement

    if (shapeFormatPainter.value) mainStore.setShapeFormatPainter(null)
    else {
      mainStore.setShapeFormatPainter({
        keep,
        fill: _handleElement.fill,
        gradient: _handleElement.gradient,
        outline: _handleElement.outline,
        opacity: _handleElement.opacity,
        shadow: _handleElement.shadow,
      })
    }
  }

  return {
    toggleShapeFormatPainter,
  }
}
