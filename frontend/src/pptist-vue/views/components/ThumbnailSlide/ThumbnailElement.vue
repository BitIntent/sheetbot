<template>
  <div 
    class="base-element"
    :class="`base-element-${elementInfo.id}`"
    :style="{
      zIndex: elementIndex,
    }"
  >
    <component
      :is="currentElementComponent"
      :elementInfo="elementInfo"
      target="thumbnail"
    ></component>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { ElementTypes, type PPTElement } from '@pptist/types/slides'

import BaseImageElement from '@pptist/views/components/element/ImageElement/BaseImageElement.vue'
import BaseTextElement from '@pptist/views/components/element/TextElement/BaseTextElement.vue'
import BaseShapeElement from '@pptist/views/components/element/ShapeElement/BaseShapeElement.vue'
import BaseLineElement from '@pptist/views/components/element/LineElement/BaseLineElement.vue'
import BaseChartElement from '@pptist/views/components/element/ChartElement/BaseChartElement.vue'
import BaseTableElement from '@pptist/views/components/element/TableElement/BaseTableElement.vue'
import BaseLatexElement from '@pptist/views/components/element/LatexElement/BaseLatexElement.vue'
import BaseVideoElement from '@pptist/views/components/element/VideoElement/BaseVideoElement.vue'
import BaseAudioElement from '@pptist/views/components/element/AudioElement/BaseAudioElement.vue'

const props = defineProps<{
  elementInfo: PPTElement
  elementIndex: number
}>()

const currentElementComponent = computed<unknown>(() => {
  const elementTypeMap = {
    [ElementTypes.IMAGE]: BaseImageElement,
    [ElementTypes.TEXT]: BaseTextElement,
    [ElementTypes.SHAPE]: BaseShapeElement,
    [ElementTypes.LINE]: BaseLineElement,
    [ElementTypes.CHART]: BaseChartElement,
    [ElementTypes.TABLE]: BaseTableElement,
    [ElementTypes.LATEX]: BaseLatexElement,
    [ElementTypes.VIDEO]: BaseVideoElement,
    [ElementTypes.AUDIO]: BaseAudioElement,
  }
  return elementTypeMap[props.elementInfo.type] || null
})
</script>