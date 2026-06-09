// ============================================================================
// PPTist 子系统初始化 — Pinia + 全局样式 + Directive
// 在 React 应用启动时调用一次，确保 Vue 子系统就绪
// ============================================================================
import { App } from 'vue'
import { createPinia, type Pinia } from 'pinia'

import 'prosemirror-view/style/prosemirror.css'
import 'animate.css'
import '@pptist/assets/styles/prosemirror.scss'
import '@pptist/assets/styles/global.scss'
import '@pptist/assets/styles/font.scss'
import '@/styles/pptist-dark-theme.scss'
import '@/styles/pptist-sheetbot-light.scss'

let _pinia: Pinia | null = null

export function getPinia(): Pinia {
  if (!_pinia) {
    _pinia = createPinia()
  }
  return _pinia
}

export function installPinia(app: App): void {
  app.use(getPinia())
}
