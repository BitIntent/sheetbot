<template>
  <div class="toolbar">
    <Tabs 
      :tabs="currentTabs" 
      :value="toolbarState" 
      card 
      @update:value="key => setToolbarState(key as ToolbarStates)"
    />
    <div class="content">
      <component :is="currentPanelComponent"></component>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore } from '@pptist/store'
import { ToolbarStates } from '@pptist/types/toolbar'

import ElementStylePanel from './ElementStylePanel/index.vue'
import ElementPositionPanel from './ElementPositionPanel.vue'
import ElementAnimationPanel from './ElementAnimationPanel.vue'
import SlideDesignPanel from './SlideDesignPanel/index.vue'
import SlideAnimationPanel from './SlideAnimationPanel.vue'
import MultiPositionPanel from './MultiPositionPanel.vue'
import MultiStylePanel from './MultiStylePanel.vue'
import Tabs from '@pptist/components/Tabs.vue'

const mainStore = useMainStore()
const { activeElementIdList, activeElementList, activeGroupElementId, toolbarState } = storeToRefs(mainStore)

const elementTabs = [
  { label: '样式', key: ToolbarStates.EL_STYLE },
  { label: '位置', key: ToolbarStates.EL_POSITION },
  { label: '动画', key: ToolbarStates.EL_ANIMATION },
]
const slideTabs = [
  { label: '设计', key: ToolbarStates.SLIDE_DESIGN },
  { label: '切换', key: ToolbarStates.SLIDE_ANIMATION },
  { label: '动画', key: ToolbarStates.EL_ANIMATION },
]
const multiSelectTabs = [
  { label: '样式（多选）', key: ToolbarStates.MULTI_STYLE },
  { label: '位置（多选）', key: ToolbarStates.MULTI_POSITION },
]

const setToolbarState = (value: ToolbarStates) => {
  mainStore.setToolbarState(value)
}

const currentTabs = computed(() => {
  if (!activeElementIdList.value.length) return slideTabs
  else if (activeElementIdList.value.length > 1) {
    if (!activeGroupElementId.value) return multiSelectTabs

    const activeGroupElement = activeElementList.value.find(item => item.id === activeGroupElementId.value)
    if (activeGroupElement) return elementTabs
    return multiSelectTabs
  }
  return elementTabs
})

watch(currentTabs, () => {
  const currentTabsValue: ToolbarStates[] = currentTabs.value.map(tab => tab.key)
  if (!currentTabsValue.includes(toolbarState.value)) {
    mainStore.setToolbarState(currentTabsValue[0])
  }
})

const currentPanelComponent = computed(() => {
  const panelMap = {
    [ToolbarStates.EL_STYLE]: ElementStylePanel,
    [ToolbarStates.EL_POSITION]: ElementPositionPanel,
    [ToolbarStates.EL_ANIMATION]: ElementAnimationPanel,
    [ToolbarStates.SLIDE_DESIGN]: SlideDesignPanel,
    [ToolbarStates.SLIDE_ANIMATION]: SlideAnimationPanel,
    [ToolbarStates.MULTI_STYLE]: MultiStylePanel,
    [ToolbarStates.MULTI_POSITION]: MultiPositionPanel,
  }
  return panelMap[toolbarState.value] || null
})
</script>

<style lang="scss" scoped>
.toolbar {
  border-left: solid 1px $borderColor;
  background-color: #fff;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0;
  gap: 0;
  flex-wrap: nowrap;
  border-bottom: none;
}
.content {
  padding: 12px;
  font-size: 13px;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;

  @include overflow-overlay();
}

/* 右侧卡片标签样式统一由 pptist-dark-theme.scss 维护，避免多处冲突 */
</style>