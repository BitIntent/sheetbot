/**
 * 等价于 @univerjs/presets 的 createUniver，仅注册传入的 presets，避免依赖 meta 包拉取 @univerjs-pro。
 */
import { Univer, LogLevel } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'

import '@univerjs/network/facade'
import '@univerjs/sheets/facade'
import '@univerjs/ui/facade'
import '@univerjs/docs-ui/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/engine-formula/facade'
import '@univerjs/sheets-formula/facade'
import '@univerjs/sheets-numfmt/facade'
import '@univerjs/sheets-formula-ui/facade'
import '@univerjs/sheets-sort/facade'
import '@univerjs/sheets-filter/facade'

import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort'
import { UniverSheetsSortUIPlugin } from '@univerjs/sheets-sort-ui'
import { UniverSheetsFilterPlugin, SmartToggleSheetsFilterCommand } from '@univerjs/sheets-filter'
import { UniverSheetsFilterUIPlugin } from '@univerjs/sheets-filter-ui'

import '@univerjs/sheets-sort-ui/lib/index.css'
import '@univerjs/sheets-filter-ui/lib/index.css'

/**
 * @param {object} config
 * @param {import('@univerjs/core').LocaleType} [config.locale]
 * @param {Record<string, unknown>} [config.locales]
 * @param {import('@univerjs/core').LogLevel} [config.logLevel]
 * @param {boolean} [config.darkMode]
 * @param {object} [config.theme]  - 完整 Univer 色板对象（由 sheetThemeToUniver 提供）
 * @param {Array<{ plugins: Array }>} [config.presets]
 */
export function createUniverSheetsApp(config) {
  const { presets = [], logLevel = LogLevel.WARN, ...univerOpts } = config
  const univer = new Univer({
    logLevel,
    ...univerOpts,
  })

  const registered = new Map()
  const mergePluginOptions = (baseOpts, extraOpts) => {
    if (!baseOpts) return extraOpts
    if (!extraOpts) return baseOpts
    return {
      ...baseOpts,
      ...extraOpts,
      menu: {
        ...(baseOpts.menu || {}),
        ...(extraOpts.menu || {}),
      },
    }
  }

  const upsertPlugin = (Plugin, opts) => {
    if (!Plugin) return
    const key = Plugin?.pluginName || Plugin?.name
    if (!key) return
    const prev = registered.get(key)
    if (!prev) {
      registered.set(key, { Plugin, opts })
      return
    }
    registered.set(key, {
      Plugin: prev.Plugin || Plugin,
      opts: mergePluginOptions(prev.opts, opts),
    })
  }

  for (const presetEntry of presets) {
    const raw = Array.isArray(presetEntry) ? presetEntry[0] : presetEntry
    const { plugins } = raw || {}
    if (!Array.isArray(plugins)) continue
    for (const item of plugins) {
      if (!item) continue
      const [Plugin, opts] = Array.isArray(item) ? [item[0], item[1]] : [item]
      upsertPlugin(Plugin, opts)
    }
  }

  // 仅补齐缺失插件；若 preset 已包含则合并参数，避免重复注册导致 "already exists"
  upsertPlugin(UniverSheetsSortPlugin)
  upsertPlugin(UniverSheetsSortUIPlugin)
  upsertPlugin(UniverSheetsFilterPlugin)
  upsertPlugin(UniverSheetsFilterUIPlugin, {
    menu: {
      [SmartToggleSheetsFilterCommand.id]: { hidden: true },
    },
  })

  registered.forEach(({ Plugin, opts }) => {
    univer.registerPlugin(Plugin, opts)
  })

  return {
    univer,
    univerAPI: FUniver.newAPI(univer),
  }
}
