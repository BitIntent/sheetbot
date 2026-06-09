<template>
  <div class="canvas-tool">
    <div class="left-handler">
      <span class="handler-item" v-tooltip="'返回'" @click="emitPresentationAction('back_home')">
        <i-icon-park-outline:left />
      </span>
      <span class="handler-item" :class="{ 'disable': !canUndo }" v-tooltip="'撤销（Ctrl + Z）'" @click="undo()">
        <i-icon-park-outline:back />
      </span>
      <span class="handler-item" :class="{ 'disable': !canRedo }" v-tooltip="'重做（Ctrl + Y）'" @click="redo()">
        <i-icon-park-outline:next />
      </span>
      <div class="more">
        <Divider type="vertical" style="height: 20px;" />
        <Popover class="more-icon" trigger="click" v-model:value="moreVisible" :offset="10">
          <template #content>
            <PopoverMenuItem class="popover-menu-item" center @click="toggleNotesPanel(); moreVisible = false"><i-icon-park-outline:comment class="icon" />批注面板</PopoverMenuItem>
            <PopoverMenuItem class="popover-menu-item" center @click="toggleSelectPanel(); moreVisible = false"><i-icon-park-outline:move-one class="icon" />选择窗格</PopoverMenuItem>
            <PopoverMenuItem class="popover-menu-item" center @click="toggleSraechPanel(); moreVisible = false"><i-icon-park-outline:search class="icon" />查找替换</PopoverMenuItem>
          </template>
          <span class="handler-item">
            <i-icon-park-outline:more />
          </span>
        </Popover>
        <span class="handler-item" :class="{ 'active': showNotesPanel }" v-tooltip="'批注面板'" @click="toggleNotesPanel()">
          <i-icon-park-outline:comment />
        </span>
        <span class="handler-item" :class="{ 'active': showSelectPanel }" v-tooltip="'选择窗格'" @click="toggleSelectPanel()">
          <i-icon-park-outline:move-one />
        </span>
        <span class="handler-item" :class="{ 'active': showSearchPanel }" v-tooltip="'查找/替换（Ctrl + F）'" @click="toggleSraechPanel()">
          <i-icon-park-outline:search />
        </span>
      </div>
    </div>

    <div class="add-element-handler">
      <div class="insert-handler-item group-btn" :class="{ 'active': creatingElement?.type === 'text' }" v-tooltip="'插入文字'">
        <div class="group-btn-main" @click="drawText()"><i-icon-park-outline:font-size class="icon" /></div>
        
        <Popover trigger="click" v-model:value="textTypeSelectVisible" style="height: 100%;" :offset="10">
          <template #content>
            <PopoverMenuItem center @click="() => { drawText(); textTypeSelectVisible = false }"><i-icon-park-outline:text-rotation-none class="icon" /> 横向文本框</PopoverMenuItem>
            <PopoverMenuItem center @click="() => { drawText(true); textTypeSelectVisible = false }"><i-icon-park-outline:text-rotation-down class="icon" /> 竖向文本框</PopoverMenuItem>
          </template>
          <span class="arrow"><i-icon-park-outline:down /></span>
        </Popover>
      </div>
      <div class="insert-handler-item group-btn" :class="{ 'active': creatingCustomShape || creatingElement?.type === 'shape' }" v-tooltip="'插入形状'" :offset="10">
        <Popover trigger="click" style="height: 100%;" v-model:value="shapePoolVisible" :offset="10">
          <template #content>
            <ShapePool @select="shape => drawShape(shape)" />
          </template>
          <div class="group-btn-main"><i-icon-park-outline:graphic-design class="icon" /></div>
        </Popover>
        
        <Popover trigger="click" v-model:value="shapeMenuVisible" style="height: 100%;" :offset="10">
          <template #content>
            <PopoverMenuItem center @click="shapeMenuVisible = false; shapePoolVisible = true"><i-icon-park-outline:graphic-design class="icon" />预设形状</PopoverMenuItem>
            <PopoverMenuItem center @click="() => { drawCustomShape(); shapeMenuVisible = false }"><i-icon-park-outline:writing-fluently class="icon" />自由绘制</PopoverMenuItem>
          </template>
          <span class="arrow"><i-icon-park-outline:down /></span>
        </Popover>
      </div>
      <div class="insert-handler-item group-btn" v-tooltip="'插入图片'">
        <FileInput style="height: 100%;" @change="files => insertImageElement(files)">
          <div class="group-btn-main"><i-icon-park-outline:picture class="icon" /></div>
        </FileInput>
        
        <Popover trigger="click" v-model:value="imageMenuVisible" style="height: 100%;" :offset="10">
          <template #content>
            <FileInput @change="files => { insertImageElement(files); imageMenuVisible = false }">
              <PopoverMenuItem center><i-icon-park-outline:upload class="icon" /> 上传图片</PopoverMenuItem>
            </FileInput>
            <PopoverMenuItem center @click="openImageLibPanel(); imageMenuVisible = false"><i-icon-park-outline:picture class="icon" /> 在线图库</PopoverMenuItem>
          </template>
          <span class="arrow"><i-icon-park-outline:down /></span>
        </Popover>
      </div>
      <Popover trigger="click" v-model:value="chartPoolVisible" :offset="10">
        <template #content>
          <ChartPool @select="chart => { createChartElement(chart); chartPoolVisible = false }" />
        </template>
        <div class="insert-handler-item" v-tooltip="'插入图表'">
          <i-icon-park-outline:chart-proportion class="icon" />
        </div>
      </Popover>
      <Popover trigger="click" v-model:value="tableGeneratorVisible" :offset="10">
        <template #content>
          <TableGenerator
            @close="tableGeneratorVisible = false"
            @insert="({ row, col }) => { createTableElement(row, col); tableGeneratorVisible = false }"
          />
        </template>
        <div class="insert-handler-item" v-tooltip="'插入表格'">
          <i-icon-park-outline:insert-table class="icon" />
        </div>
      </Popover>
    </div>

    <div class="right-handler">
      <div class="presentation-actions">
        <span
          class="handler-item presentation-action-item"
          :class="{ 'disable': !hasSlides || isSaving }"
          v-tooltip="isSaving ? '保存中' : '保存'"
          @click="emitPresentationAction('save')"
        >
          <i-icon-park-outline:save-one class="action-icon" />
        </span>
        <span class="handler-item presentation-action-item" :class="{ 'disable': !hasSlides }" v-tooltip="'播放'" @click="emitPresentationAction('play')">
          <i-icon-park-outline:play-one class="action-icon" />
        </span>
        <span class="handler-item presentation-action-item" v-tooltip="'导出'" @click="openExportDialog()">
          <i-icon-park-outline:download-one class="action-icon" />
        </span>
      </div>
      <span class="handler-item viewport-size" v-tooltip="'画布缩小（Ctrl + -）'" @click="scaleCanvas('-')">
        <i-icon-park-outline:minus />
      </span>
      <Popover trigger="click" v-model:value="canvasScaleVisible">
        <template #content>
          <PopoverMenuItem
            center
            v-for="item in canvasScalePresetList" 
            :key="item" 
            @click="applyCanvasPresetScale(item)"
          >{{item}}%</PopoverMenuItem>
          <PopoverMenuItem center @click="resetCanvas(); canvasScaleVisible = false">适应屏幕</PopoverMenuItem>
        </template>
        <span class="text">{{ canvasScalePercentage }}</span>
      </Popover>
      <span class="handler-item viewport-size" v-tooltip="'画布放大（Ctrl + =）'" @click="scaleCanvas('+')">
        <i-icon-park-outline:plus />
      </span>
      <span class="handler-item viewport-size-adaptation" v-tooltip="'适应屏幕（Ctrl + 0）'" @click="resetCanvas()">
        <i-icon-park-outline:full-screen />
      </span>
    </div>

  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useSnapshotStore, useSlidesStore } from '@pptist/store'
import { getImageDataURL } from '@pptist/utils/image'
import type { ShapePoolItem } from '@pptist/configs/shapes'
import useScaleCanvas from '@pptist/hooks/useScaleCanvas'
import useHistorySnapshot from '@pptist/hooks/useHistorySnapshot'
import useCreateElement from '@pptist/hooks/useCreateElement'

import ShapePool from './ShapePool.vue'
import ChartPool from './ChartPool.vue'
import TableGenerator from './TableGenerator.vue'
import FileInput from '@pptist/components/FileInput.vue'
import Divider from '@pptist/components/Divider.vue'
import Popover from '@pptist/components/Popover.vue'
import PopoverMenuItem from '@pptist/components/PopoverMenuItem.vue'

const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const { creatingElement, creatingCustomShape, showSelectPanel, showSearchPanel, showNotesPanel } = storeToRefs(mainStore)
const { canUndo, canRedo } = storeToRefs(useSnapshotStore())
const { slides } = storeToRefs(slidesStore)
const hasSlides = computed(() => (slides.value?.length || 0) > 0)
const isSaving = ref(false)

const { redo, undo } = useHistorySnapshot()

const {
  scaleCanvas,
  setCanvasScalePercentage,
  resetCanvas,
  canvasScalePercentage,
} = useScaleCanvas()

const canvasScalePresetList = [200, 150, 125, 100, 75, 50]
const canvasScaleVisible = ref(false)

const applyCanvasPresetScale = (value: number) => {
  setCanvasScalePercentage(value)
  canvasScaleVisible.value = false
}

const {
  createImageElement,
  createChartElement,
  createTableElement,
} = useCreateElement()

const insertImageElement = (files: FileList) => {
  const imageFile = files[0]
  if (!imageFile) return
  getImageDataURL(imageFile).then(dataURL => createImageElement(dataURL))
}

const shapePoolVisible = ref(false)
const chartPoolVisible = ref(false)
const tableGeneratorVisible = ref(false)
const textTypeSelectVisible = ref(false)
const shapeMenuVisible = ref(false)
const imageMenuVisible = ref(false)
const moreVisible = ref(false)

// 绘制文字范围
const drawText = (vertical = false) => {
  mainStore.setCreatingElement({
    type: 'text',
    vertical,
  })
}

// 绘制形状范围
const drawShape = (shape: ShapePoolItem) => {
  mainStore.setCreatingElement({
    type: 'shape',
    data: shape,
  })
  shapePoolVisible.value = false
}
// 绘制自定义任意多边形
const drawCustomShape = () => {
  mainStore.setCreatingCustomShapeState(true)
  shapePoolVisible.value = false
}

// 打开选择面板
const toggleSelectPanel = () => {
  mainStore.setSelectPanelState(!showSelectPanel.value)
}

// 打开搜索替换面板
const toggleSraechPanel = () => {
  mainStore.setSearchPanelState(!showSearchPanel.value)
}

// 打开批注面板
const toggleNotesPanel = () => {
  mainStore.setNotesPanelState(!showNotesPanel.value)
}

// 打开图库面板
const openImageLibPanel = () => {
  mainStore.setImageLibPanelState(true)
}

const openExportDialog = () => {
  mainStore.setDialogForExport('pptx')
}

const emitPresentationAction = (action: 'back_home' | 'play' | 'save') => {
  if (action === 'save' && isSaving.value) return
  if (!hasSlides.value && (action === 'play' || action === 'save')) return
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('presentationAction', { detail: { action } }))
}

const onPresentationSaveState = (evt: Event) => {
  const e = evt as CustomEvent<{ saving?: boolean }>
  isSaving.value = !!e.detail?.saving
}

onMounted(() => {
  if (typeof window === 'undefined') return
  window.addEventListener('presentationSaveState', onPresentationSaveState as EventListener)
})

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return
  window.removeEventListener('presentationSaveState', onPresentationSaveState as EventListener)
})
</script>

<style lang="scss" scoped>
.canvas-tool {
  position: relative;
  border-bottom: 1px solid $borderColor;
  background-color: #fff;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  flex-wrap: wrap;
  column-gap: 4px;
  row-gap: 4px;
  padding: 4px 10px;
  min-height: 40px;
  font-size: 13px;
  user-select: none;
}
// 布局层打平：三组工具统一进入同一行流，先填满第一行再换行
.left-handler,
.add-element-handler,
.right-handler,
.more {
  display: contents;
}
.more-icon {
  display: none;
}
.popover-menu-item {
  display: flex;
  padding: 8px 10px;

  &.center {
    justify-content: center;
  }

  .icon {
    font-size: 18px;
    margin-right: 8px;
  }
}
.add-element-handler {
  position: static;

  & > div {
    flex-shrink: 0;
  }

  .insert-handler-item {
    height: 30px;
    font-size: 14px;
    margin: 0 2px;
    padding: 0 10px;
    display: flex;
    justify-content: center;
    align-items: center;
    border-radius: $borderRadius;
    overflow: hidden;
    cursor: pointer;

    &:not(.group-btn):hover {
      background-color: #363F4C;
      color: #fff;
    }

    &.active {
      background-color: #363F4C;
      color: #fff;
    }

    .icon {
      margin-right: 0;
    }

    &.group-btn {
      margin-right: 2px;
      padding: 0 6px;
      gap: 0;
      display: inline-flex;
      align-items: stretch;

      &:hover {
        background-color: #363F4C;
        color: #fff;
      }

      .group-btn-main {
        height: 100%;
        min-width: 26px;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 0 4px;
        border-radius: $borderRadius;
      }

      .arrow {
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        font-size: 12px;
        padding: 0 4px;
        border-radius: $borderRadius;
      }

      .group-btn-main:hover,
      .arrow:hover {
        background-color: #363F4C;
        color: #fff;
      }
    }
  }
}
.handler-item {
  height: 30px;
  font-size: 14px;
  margin: 0 2px;
  display: flex;
  justify-content: center;
  align-items: center;
  border-radius: $borderRadius;
  overflow: hidden;
  cursor: pointer;

  &.disable {
    opacity: .5;
  }
}
.left-handler, .right-handler {
  .handler-item {
    padding: 0 8px;

    &.active,
    &:not(.disable):hover {
      background-color: #f1f1f1;
    }
  }
}
.right-handler {
  .presentation-actions {
    display: contents;
  }

  .presentation-action-item {
    height: 30px;
    font-size: 14px;
    margin: 0 2px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: $borderRadius;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    line-height: 1;
    transition: background-color .2s ease;

    .action-icon {
      font-size: 14px;
      line-height: 1;
    }
  }

  .text {
    display: inline-block;
    width: 40px;
    text-align: center;
    cursor: pointer;
  }

  .viewport-size {
    font-size: 13px;
  }
}

@media screen and (width <= 1600px) {
  .add-element-handler {
    .insert-handler-item {
      .icon {
        margin-right: 0;
      }
      .text {
        display: none;
      }
    }
  }
}
@media screen and (width <= 1366px) {
  .add-element-handler {
    .insert-handler-item {
      padding: 0 6px;
    }
  }
}
@media screen and (width <= 1200px) {
  .presentation-actions {
    .presentation-action-item:not(:last-child) {
      display: none;
    }
  }
  .right-handler .text {
    display: none;
  }
  .more > .handler-item {
    display: none;
  }
  .more-icon {
    display: block;
  }
}
@media screen and (width <= 1000px) {
  .left-handler, .right-handler {
    display: none;
  }
}
</style>