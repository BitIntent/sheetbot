/**
 * SheetBot 嵌入 Univer：UI 层覆盖（与 @univerjs/ui 内置 Ni 列表一致，去掉 Times New Roman）
 * + 隐藏 Ribbon 上「公式」分类整行（常用函数/财务/…/全部函数）及工具栏「文本转数字」
 */

import { IConfigService, LifecycleService, LifecycleStages } from '@univerjs/core'
import { IFontService, IMenuManagerService } from '@univerjs/ui'

/** 与 @univerjs/ui 内置默认字体表结构一致（不含 Times New Roman） */
export const SHEETBOT_UI_FONT_FAMILY_LIST = [
  { value: 'Arial', label: 'fontFamily.arial', category: 'sans-serif' },
  { value: 'Tahoma', label: 'fontFamily.tahoma', category: 'sans-serif' },
  { value: 'Verdana', label: 'fontFamily.verdana', category: 'sans-serif' },
  { value: 'Microsoft YaHei', label: 'fontFamily.microsoft-yahei', category: 'sans-serif' },
  { value: 'SimSun', label: 'fontFamily.simsun', category: 'serif' },
  { value: 'SimHei', label: 'fontFamily.simhei', category: 'sans-serif' },
  { value: 'Kaiti', label: 'fontFamily.kaiti', category: 'serif' },
  { value: 'FangSong', label: 'fontFamily.fangsong', category: 'serif' },
  { value: 'NSimSun', label: 'fontFamily.nsimsun', category: 'serif' },
  { value: 'STXinwei', label: 'fontFamily.stxinwei', category: 'serif' },
  { value: 'STXingkai', label: 'fontFamily.stxingkai', category: 'serif' },
  { value: 'STLiti', label: 'fontFamily.stliti', category: 'serif' },
]

const INSERT_FN_MENU_PREFIX = 'formula-ui.operation.insert-function.'
const SHEETS_SORT_MENU_PREFIX = 'sheet.menu.sheets-sort'
const SHEETS_SORT_CTX_MENU_PREFIX = 'sheet.menu.sheets-sort-ctx'

const FORMULA_RIBBON_INSERT_MENU_SUFFIXES = [
  'common',
  'financial',
  'logical',
  'text',
  'date',
  'lookup',
  'math',
  'statistical',
  'engineering',
  'information',
  'database',
]

const SORT_MENU_IDS = [
  SHEETS_SORT_MENU_PREFIX,
  SHEETS_SORT_CTX_MENU_PREFIX,
  'sheet.command.sort-range-asc',
  'sheet.command.sort-range-asc-ext',
  'sheet.command.sort-range-desc',
  'sheet.command.sort-range-desc-ext',
  'sheet.command.sort-range-custom',
]

/** @returns {Record<string, { hidden: boolean }>} */
export function buildSheetbotHiddenFormulaRibbonMenuConfig() {
  /** @type {Record<string, { hidden: boolean }>} */
  const cfg = {}
  for (const s of FORMULA_RIBBON_INSERT_MENU_SUFFIXES) {
    cfg[`${INSERT_FN_MENU_PREFIX}${s}`] = { hidden: true }
  }
  cfg['formula-ui.operation.more-functions'] = { hidden: true }
  cfg['sheet.toolbar.text-to-number'] = { hidden: true }
  for (const id of SORT_MENU_IDS) {
    cfg[id] = { hidden: true }
  }
  return cfg
}

/**
 * 在 Univer 生命周期 Steady 之后再次写入配置并刷新 Ribbon。
 * 原因：部分插件会在启动过程中 merge `menu` / `ui.config`，覆盖 Preset 初次写入；
 * `_buildMenuSchema` 虽每次读 getConfig('menu')，但 Ribbon 需 menuChanged$ 才会重绘；
 * FontService 构造时若未读到 customFontFamily，需 removeFont 兜底。
 *
 * @param {import('@univerjs/core').Univer} univer
 */
export function applySheetbotUniverUiRuntimePatches(univer) {
  const injector = univer && typeof univer.__getInjector === 'function' ? univer.__getInjector() : null
  if (!injector) return
  try {
    const configService = injector.get(IConfigService)
    configService.setConfig('menu', buildSheetbotHiddenFormulaRibbonMenuConfig(), { merge: true })
    configService.setConfig(
      'ui.config',
      { customFontFamily: { override: true, list: SHEETBOT_UI_FONT_FAMILY_LIST } },
      { merge: true }
    )
    const fontService = injector.get(IFontService)
    fontService.removeFont('Times New Roman')
    injector.get(IMenuManagerService).menuChanged$.next()
  } catch (e) {
    console.warn('[Univer] applySheetbotUniverUiRuntimePatches', e)
  }
}

/**
 * 浅色 sheet_theme 下保持 Ribbon 与表格同主题；深色主题才锁定 Ribbon 为 dark。
 *
 * @param {HTMLElement | null} hostEl
 * @param {boolean} [darkMode=true]
 */
export function forceToolbarAlwaysDark(hostEl, darkMode = true) {
  if (!hostEl) return
  const headerbar = hostEl.querySelector('header[data-u-comp="headerbar"]')
  if (!headerbar) return
  if (darkMode) {
    headerbar.classList.add('univer-dark')
  } else {
    headerbar.classList.remove('univer-dark')
  }
}

/**
 * @param {HTMLElement | null} hostEl
 * @param {boolean} [darkMode=true]
 * @returns {() => void}
 */
export function keepToolbarAlwaysDark(hostEl, darkMode = true) {
  if (!hostEl || !darkMode) return () => {}
  let stopped = false
  let raf = 0
  const apply = () => {
    if (stopped) return
    forceToolbarAlwaysDark(hostEl, darkMode)
  }
  const schedule = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(apply)
  }
  schedule()

  const observer = new MutationObserver(() => {
    schedule()
  })
  observer.observe(hostEl, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    observer.disconnect()
  }
}

/**
 * Steady 阶段应用 UI 补丁；dispose 时取消未完成的 Promise。
 *
 * @param {import('@univerjs/core').Univer} univer
 * @param {HTMLElement | null} [hostEl]
 * @param {boolean} [darkMode=true]
 * @returns {() => void}
 */
export function scheduleSheetbotUniverUiPatchesOnSteady(univer, hostEl, darkMode = true) {
  let cancelled = false
  const stopDarkLock = keepToolbarAlwaysDark(hostEl, darkMode)
  try {
    // 立即执行一次，避免首次渲染出现样式真空。
    applySheetbotUniverUiRuntimePatches(univer)
    forceToolbarAlwaysDark(hostEl, darkMode)

    const injector = univer.__getInjector()
    const ls = injector.get(LifecycleService)
    void ls
      .onStage(LifecycleStages.Steady)
      .then(() => {
        if (cancelled) return
        applySheetbotUniverUiRuntimePatches(univer)
        forceToolbarAlwaysDark(hostEl, darkMode)
      })
      .catch(() => {
        /* 实例已销毁等 */
      })
  } catch (e) {
    console.warn('[Univer] scheduleSheetbotUniverUiPatchesOnSteady', e)
  }
  return () => {
    cancelled = true
    stopDarkLock()
  }
}
