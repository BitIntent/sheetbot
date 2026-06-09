<template>
  <div class="pptist-screen-bridge">
    <BaseView :changeViewMode="changeViewMode" v-if="viewMode === 'base'" />
    <PresenterView :changeViewMode="changeViewMode" v-else-if="viewMode === 'presenter'" />
  </div>
</template>

<script lang="ts" setup>
// ============================================================================
// PPTist 放映桥接入口
// 从 Store 读取幻灯片数据进行放映，ESC 退出时通知 React
// ============================================================================
import { onMounted, onUnmounted, ref } from 'vue'
import { KEYS } from '@pptist/configs/hotkey'
import useScreening from '@pptist/hooks/useScreening'

import BaseView from '@pptist/views/Screen/BaseView.vue'
import PresenterView from '@pptist/views/Screen/PresenterView.vue'

const emit = defineEmits<{
  (e: 'exitScreening'): void
}>()

const viewMode = ref<'base' | 'presenter'>('base')
const changeViewMode = (mode: 'base' | 'presenter') => {
  viewMode.value = mode
}

const { exitScreening } = useScreening()

const keydownListener = (e: KeyboardEvent) => {
  const key = e.key.toUpperCase()
  if (key === KEYS.ESC) {
    exitScreening()
    emit('exitScreening')
  }
}

onMounted(() => document.addEventListener('keydown', keydownListener))
onUnmounted(() => document.removeEventListener('keydown', keydownListener))
</script>

<style lang="scss" scoped>
.pptist-screen-bridge {
  width: 100%;
  height: 100%;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  background: #000;
}
</style>
