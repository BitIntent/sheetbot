/**
 * 公式计算 Worker（对齐 D:\\dev\\python\\univer\\examples\\src\\sheets\\worker.ts）
 * 主线程通过 UniverRPCMainThreadPlugin + workerURL 与此线程通信。
 */
import { LocaleType, LogLevel, Univer } from '@univerjs/core'
import { UniverSheetsCoreWorkerPreset } from '@univerjs/preset-sheets-core/worker'

const { plugins } = UniverSheetsCoreWorkerPreset()

const univer = new Univer({
  locale: LocaleType.ZH_CN,
  logLevel: LogLevel.WARN,
  // Worker 仅跑公式引擎，不加载 UI 文案包以减小体积（与官方 worker.ts 仅用 zh-CN 占位一致）
  locales: {
    [LocaleType.ZH_CN]: {},
  },
})

for (const item of plugins) {
  if (!item) continue
  const [Plugin, options] = Array.isArray(item) ? item : [item]
  univer.registerPlugin(Plugin, options)
}

// RPC 宿主需挂到 Worker 全局（与官方示例一致）
const g = typeof self !== 'undefined' ? self : globalThis
g.univer = univer
