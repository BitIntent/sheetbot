<template>
  <div 
    class="mobile-editable-element"
    :style="{
      zIndex: elementIndex,
    }"
  >
    <component
      :is="currentElementComponent"
      :elementInfo="elementInfo"
      :selectElement="selectElement"
      :contextmenus="() => null"
    ></component>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { ElementTypes, type PPTElement } from '@pptist/types/slides'

import ImageElement from '@pptist/views/components/element/ImageElement/index.vue'
import TextElement from '@pptist/views/components/element/TextElement/index.vue'
import ShapeElement from '@pptist/views/components/element/ShapeElement/index.vue'
import LineElement from '@pptist/views/components/element/LineElement/index.vue'
import ChartElement from '@pptist/views/components/element/ChartElement/index.vue'
import TableElement from '@pptist/views/components/element/TableElement/index.vue'
import LatexElement from '@pptist/views/components/element/LatexElement/index.vue'
import VideoElement from '@pptist/views/components/element/VideoElement/index.vue'
import AudioElement from '@pptist/views/components/element/AudioElement/index.vue'

const props = defineProps<{
  elementInfo: PPTElement
  elementIndex: number
  selectElement: (e: TouchEvent, element: PPTElement, canMove?: boolean) => void
}>()

const currentElementComponent = computed<unknown>(() => {
  const elementTypeMap = {
    [ElementTypes.IMAGE]: ImageElement,
    [ElementTypes.TEXT]: TextElement,
    [ElementTypes.SHAPE]: ShapeElement,
    [ElementTypes.LINE]: LineElement,
    [ElementTypes.CHART]: ChartElement,
    [ElementTypes.TABLE]: TableElement,
    [ElementTypes.LATEX]: LatexElement,
    [ElementTypes.VIDEO]: VideoElement,
    [ElementTypes.AUDIO]: AudioElement,
  }
  return elementTypeMap[props.elementInfo.type] || null
})
</script>