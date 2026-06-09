/**
 * Univer Canvas 宿主：手写 Univer 注册（避免 @univerjs/presets 拉 Pro）+ Sheets Core Preset + 公式 Worker
 * 外部 workbook 变更灌表；本地编辑经 CommandExecuted debounce 回写 JSON（skip 一次灌表避免环路）
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { LocaleType, LogLevel } from '@univerjs/core'
import { DeviceInputEventType } from '@univerjs/engine-render'
import { InsertFunctionOperation, MoreFunctionsOperation } from '@univerjs/sheets-formula-ui'
import { ScrollCommand, SetCellEditVisibleOperation } from '@univerjs/sheets-ui'
import { SmartToggleSheetsFilterCommand } from '@univerjs/sheets-filter'
import {
  SortRangeAscCommand,
  SortRangeAscExtCommand,
  SortRangeCustomCommand,
  SortRangeDescCommand,
  SortRangeDescExtCommand,
} from '@univerjs/sheets-sort-ui'
import sheetsFilterZhCN from '@univerjs/sheets-filter-ui/lib/es/locale/zh-CN'
import sheetsSortZhCN from '@univerjs/sheets-sort-ui/lib/es/locale/zh-CN'
import zhCN from './univerLocaleZhCN.js'
import { createUniverSheetsApp } from './createUniverSheetsApp.js'
import { useUniverWorkbookSync } from './useUniverWorkbookSync.js'
import UniverChartsOverlay from './UniverChartsOverlay.jsx'
import UniverImagesOverlay from './UniverImagesOverlay.jsx'
// UniverCornerPatch 已移除：DOM overlay 的 box-shadow 与 Canvas stroke 使用不同抗锯齿算法，
// 导致角标边线永远无法与 Canvas 网格线像素对齐。Univer 原生引擎内部统一使用
// setLineWidthByPrecision(1) + FIX_ONE_PIXEL_BLUR_OFFSET，行列头分隔线与网格线线宽一致，
// 无需额外 DOM 补丁。

import { FIX_ONE_PIXEL_BLUR_OFFSET } from '@univerjs/engine-render'

import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'
import '@univerjs/sheets-formula-ui/lib/index.css'
import '@univerjs/sheets-numfmt-ui/lib/index.css'
import './sheetbotUniverChrome.css'

import { sheetThemeToUniverOptions } from './sheetThemeToUniver'
import { sheetbotWorkbookToUniverSnapshot, univerSnapshotToSheetbotWorkbook } from './workbookJsonAdapter'
import { computeConditionalFormatDigest } from '../utils/conditionalFormatEval'
import { attachUniverRibbonPin } from './univerRibbonPin.js'
import {
  SHEETBOT_UI_FONT_FAMILY_LIST,
  applySheetbotUniverUiRuntimePatches,
  buildSheetbotHiddenFormulaRibbonMenuConfig,
  scheduleSheetbotUniverUiPatchesOnSteady,
} from './sheetbotUniverUiOverrides.js'
import { registerSheetbotInsertChartContextMenu } from './sheetbotUniverInsertChart.js'

/** Facade setActiveSheet(string) 把 string 当 sheetId 而非 name；此函数按 name 查找再切 */
function activateSheetByName(fWorkbook, sheetName) {
  if (!fWorkbook || !sheetName) return false
  const cur = fWorkbook.getActiveSheet?.()?.getSheetName?.()
  if (cur === sheetName) return true
  const sheets = typeof fWorkbook.getSheets === 'function' ? fWorkbook.getSheets() : []
  const target = sheets.find((s) => s?.getSheetName?.() === sheetName)
  if (target) {
    fWorkbook.setActiveSheet(target)
    return true
  }
  return false
}

/** 关闭单元格编辑态，把输入中的值写回模型（否则 save() 不含当前格） */
function commitPendingCellEdit(api, fWorkbook) {
  if (!api?.syncExecuteCommand || !fWorkbook?.getId) return
  try {
    api.syncExecuteCommand(SetCellEditVisibleOperation.id, {
      visible: false,
      eventType: DeviceInputEventType.PointerUp,
      unitId: fWorkbook.getId(),
    })
  } catch (e) {
    console.warn('[Univer] commitPendingCellEdit', e)
  }
}

// 全局计数器：每次 createWorkbook 使用唯一 ID，规避 Univer UnitService 注册表跨实例 ID 冲突
let _wbSeq = 0

// ---- 角标区域 Canvas 边框扩展 ----
// 行列头扩展只在各自视口内绘制边框，角标区域（左上角视口）无任何组件绘制显式边框。
// 此扩展挂载到 RowHeader 上，利用 RowHeader draw() 将上下文平移 columnHeaderHeight 后、
// 以 y < 0 坐标向上绘制到角标区域，补齐右边框和下边框。
const GRIDLINES_DEFAULT_COLOR = 'rgb(214, 216, 219)'

function createCornerBorderExtension() {
  return {
    uKey: 'SheetBotCornerBorderExt',
    type: 0,
    Z_INDEX: 200,
    parent: null,
    translateX: 0,
    translateY: 0,
    extensionOffset: {},
    get zIndex() { return this.Z_INDEX },
    clearCache() {},
    dispose() {},
    draw(ctx, parentScale, skeleton) {
      if (!skeleton) return
      const { columnHeaderHeight, rowHeaderWidth } = skeleton
      if (!columnHeaderHeight || !rowHeaderWidth) return

      const { scaleX = 1, scaleY = 1 } = parentScale
      const scale = Math.max(scaleX, scaleY) || 1
      const strokeColor = skeleton.gridlinesColor
        ?? ctx.renderConfig?.gridlinesColor
        ?? GRIDLINES_DEFAULT_COLOR

      ctx.save()
      ctx.translateWithPrecisionRatio(FIX_ONE_PIXEL_BLUR_OFFSET, FIX_ONE_PIXEL_BLUR_OFFSET)
      ctx.setLineWidthByPrecision(1)
      ctx.strokeStyle = strokeColor

      const xFix = rowHeaderWidth - 0.5 / scale
      const yFix = -0.5 / scale

      // 右边框：从角标顶部延伸至行列头交汇处（与 RowHeaderLayout 右边框像素对齐）
      ctx.beginPath()
      ctx.moveToByPrecision(xFix, -columnHeaderHeight)
      ctx.lineToByPrecision(xFix, 0)
      ctx.stroke()

      // 下边框：从角标左端延伸至行列头交汇处（与 ColumnHeaderLayout 底边框像素对齐）
      ctx.beginPath()
      ctx.moveToByPrecision(0, yFix)
      ctx.lineToByPrecision(rowHeaderWidth, yFix)
      ctx.stroke()

      ctx.restore()
    },
  }
}

/** 全量 createWorkbook 前捕获视口，避免 JSON 回灌时 scroll 恒为 0 导致滚动条缩回默认区 */
/** 仅捕获滚动：缩放以 Header viewZoom 为唯一真源；若同时恢复 getZoom() 会覆盖 100%（Univer 内部常为 1.4） */
function captureActiveSheetViewState(api) {
  try {
    const fws = api?.getActiveWorkbook?.()?.getActiveSheet?.()
    if (!fws?.getScrollState) return null
    const scroll = fws.getScrollState()
    return {
      scroll: {
        sheetViewStartRow: scroll.sheetViewStartRow,
        sheetViewStartColumn: scroll.sheetViewStartColumn,
        offsetX: scroll.offsetX,
        offsetY: scroll.offsetY,
      },
    }
  } catch {
    return null
  }
}

function restoreActiveSheetViewState(api, captured) {
  if (!captured?.scroll || !api?.syncExecuteCommand) return
  try {
    const fws = api.getActiveWorkbook?.()?.getActiveSheet?.()
    if (!fws) return
    api.syncExecuteCommand(ScrollCommand.id, { ...captured.scroll })
  } catch (e) {
    console.warn('[Univer] restoreActiveSheetViewState', e)
  }
}

/**
 * 生成「是否需 createWorkbook」的签名：Univer 网格不读 sheet.charts（图表为 React 浮层），
 * 仅图表位移/缩放不应触发全量重灌，否则松手会整表闪一下。
 */
function workbookWithoutChartsForInjectSig(wb) {
  if (wb == null || typeof wb !== 'object') return wb
  const sheets = Array.isArray(wb.sheets)
    ? wb.sheets.map((s) => {
        if (!s || typeof s !== 'object') return s
        const { charts: _c, ...rest } = s
        return rest
      })
    : wb.sheets
  return { ...wb, sheets }
}

const UniverSheetContainer = forwardRef(function UniverSheetContainer(
  {
    workbook,
    sheetTheme,
    activeSheet,
    customFormulas,
    onWorkbookChange,
    readOnly: _readOnly,
    fileId,
    onChartUpdate,
    onChartDelete,
    onOpenChartInsert,
    onApplyCustomFormula,
    /** 与 App selection 同步（大文件「我要分析」Canvas 等需 StatusBar / 公式栏读格） */
    onUniverSelectionChange,
    /** Univer 底栏切换活动表时回调（分析模式懒加载 preview 依赖 App.handleSelectSheetWrapper） */
    onUniverActiveSheetChange,
    /** 用户意图活动表（同步写入），灌表 effect 早于 prop 提交时优先于此 */
    glideActiveSheetRef,
    /** 与 Header 缩放一致，传 `sheetZoom` */
    viewZoom,
  },
  ref
) {
  const reactId = useId().replace(/:/g, '')
  const containerId = useMemo(() => `univer-root-${reactId}`, [reactId])
  const hostRef = useRef(null)
  const workbookInjectSig = useMemo(
    () => JSON.stringify(workbookWithoutChartsForInjectSig(workbook ?? {})),
    [workbook]
  )
  const workbookPreserveRef = useRef(workbook)
  workbookPreserveRef.current = workbook

  const univerAPIRef = useRef(null)
  const univerInstanceRef = useRef(null)
  const skipNextWorkbookInjectRef = useRef(false)
  const onWorkbookChangeRef = useRef(onWorkbookChange)
  onWorkbookChangeRef.current = onWorkbookChange
  const onOpenChartInsertRef = useRef(onOpenChartInsert)
  onOpenChartInsertRef.current = onOpenChartInsert
  const customFormulasRef = useRef(Array.isArray(customFormulas) ? customFormulas : [])
  customFormulasRef.current = Array.isArray(customFormulas) ? customFormulas : []
  const onApplyCustomFormulaRef = useRef(onApplyCustomFormula)
  onApplyCustomFormulaRef.current = onApplyCustomFormula
  const readOnlyRef = useRef(!!_readOnly)
  readOnlyRef.current = !!_readOnly
  const onUniverSelectionChangeRef = useRef(onUniverSelectionChange)
  onUniverSelectionChangeRef.current = onUniverSelectionChange
  const onUniverActiveSheetChangeRef = useRef(onUniverActiveSheetChange)
  onUniverActiveSheetChangeRef.current = onUniverActiveSheetChange
  const activeSheetPropRef = useRef(activeSheet)
  activeSheetPropRef.current = activeSheet
  const viewZoomRef = useRef(viewZoom)
  viewZoomRef.current = viewZoom
  /** injectWorkbook 期间 createWorkbook 会触发 ActiveSheetChanged（激活 sheetOrder[0]），必须屏蔽回调以免覆写 glideActiveSheetRef */
  const suppressActiveSheetChangeRef = useRef(false)

  const { scheduleDebounced, cancelDebounced, bumpRevision } = useUniverWorkbookSync({ debounceMs: 600 })

  /** Header sheetZoom 灌到当前活动表（每张表各有缩放模型，切表后必须重施） */
  const applyHeaderZoomToActiveSheet = useCallback(() => {
    const z = viewZoomRef.current
    if (z == null || !Number.isFinite(Number(z))) return
    const api = univerAPIRef.current
    const fws = api?.getActiveWorkbook?.()?.getActiveSheet?.()
    if (!fws || typeof fws.zoom !== 'function') return
    try {
      fws.zoom(Number(z))
    } catch (e) {
      console.warn('[Univer] applyHeaderZoomToActiveSheet', e)
    }
  }, [])

  useImperativeHandle(ref, () => ({
    /** 获取 Univer Facade API（供图表对话框读取选区） */
    getUniverAPI() { return univerAPIRef.current },
    /** 强制注入当前 workbook 到 Univer 画布（绕过节流，用于 operation_complete 最终刷新） */
    forceInject() {
      skipNextWorkbookInjectRef.current = false
      clearTimeout(trailingInjectTimerRef.current)
      lastInjectTsRef.current = Date.now()
      injectWorkbook(true)
    },
    /** 同步导出（兼容原有调用点） */
    flushToSheetbot() {
      const api = univerAPIRef.current
      const fb = api?.getActiveWorkbook?.()
      if (!fb) {
        console.warn('[Univer] flushToSheetbot: no active workbook')
        return null
      }
      try {
        commitPendingCellEdit(api, fb)
        const snap = fb.save()
        const activeName = fb.getActiveSheet?.()?.getSheetName?.() ?? null
        return univerSnapshotToSheetbotWorkbook(snap, workbookPreserveRef.current, activeName)
      } catch (e) {
        console.warn('[Univer] flushToSheetbot sync error', e)
        return null
      }
    },
    /** 异步导出：commit 后等一帧再 save，保证模型写入完成 */
    async flushToSheetbotAsync() {
      const api = univerAPIRef.current
      const fb = api?.getActiveWorkbook?.()
      if (!fb) {
        console.warn('[Univer] flushToSheetbotAsync: no active workbook')
        return null
      }
      try {
        commitPendingCellEdit(api, fb)
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const snap = fb.save()
        const activeName = fb.getActiveSheet?.()?.getSheetName?.() ?? null
        return univerSnapshotToSheetbotWorkbook(snap, workbookPreserveRef.current, activeName)
      } catch (e) {
        console.warn('[Univer] flushToSheetbotAsync error', e)
        return null
      }
    },
    openUniverMoreFunctions() {
      const api = univerAPIRef.current
      if (!api?.syncExecuteCommand) return
      api.syncExecuteCommand(MoreFunctionsOperation.id)
    },
    insertUniverFunction(functionName) {
      const api = univerAPIRef.current
      if (!api?.syncExecuteCommand || !functionName) return false
      return api.syncExecuteCommand(InsertFunctionOperation.id, { value: functionName })
    },
    /** Univer 原生升序排序（自动检测表头、数据类型） */
    sortRangeAsc() {
      const api = univerAPIRef.current
      if (!api?.executeCommand) return false
      try { return api.executeCommand(SortRangeAscCommand.id) } catch (e) { console.warn('[Univer] sortRangeAsc', e); return false }
    },
    /** Univer 原生扩展区域升序 */
    sortRangeAscExt() {
      const api = univerAPIRef.current
      if (!api?.executeCommand) return false
      try { return api.executeCommand(SortRangeAscExtCommand.id) } catch (e) { console.warn('[Univer] sortRangeAscExt', e); return false }
    },
    /** Univer 原生降序排序 */
    sortRangeDesc() {
      const api = univerAPIRef.current
      if (!api?.executeCommand) return false
      try { return api.executeCommand(SortRangeDescCommand.id) } catch (e) { console.warn('[Univer] sortRangeDesc', e); return false }
    },
    /** Univer 原生扩展区域降序 */
    sortRangeDescExt() {
      const api = univerAPIRef.current
      if (!api?.executeCommand) return false
      try { return api.executeCommand(SortRangeDescExtCommand.id) } catch (e) { console.warn('[Univer] sortRangeDescExt', e); return false }
    },
    /** Univer 原生自定义排序 */
    sortRangeCustom() {
      const api = univerAPIRef.current
      if (!api?.executeCommand) return false
      try { return api.executeCommand(SortRangeCustomCommand.id) } catch (e) { console.warn('[Univer] sortRangeCustom', e); return false }
    },
    /** Univer 原生自动筛选 */
    toggleAutoFilter() {
      const api = univerAPIRef.current
      if (!api?.syncExecuteCommand) return false
      try { return api.syncExecuteCommand(SmartToggleSheetsFilterCommand.id) } catch (e) { console.warn('[Univer] toggleAutoFilter', e); return false }
    },
  }))

  useEffect(() => {
    const el = hostRef.current
    if (!el) return undefined

    const worker = new Worker(new URL('./univerFormula.worker.js', import.meta.url), {
      type: 'module',
    })

    const { darkMode, theme } = sheetThemeToUniverOptions(sheetTheme)
    const { univer, univerAPI } = createUniverSheetsApp({
      locale: LocaleType.ZH_CN,
      locales: {
        [LocaleType.ZH_CN]: { ...zhCN, ...sheetsSortZhCN, ...sheetsFilterZhCN },
      },
      logLevel: LogLevel.WARN,
      darkMode,
      theme,
      presets: [
        UniverSheetsCorePreset({
          container: containerId,
          workerURL: worker,
          /* 显式 true：避免 merge 时 undefined 覆盖默认导致 Ribbon 不挂载 */
          header: true,
          /* Ribbon 在 UI 的 TOOLBAR 槽（header[data-u-comp=headerbar]）；sheets-ui 把 HEADER 槽留给公式栏，toolbar:false 会连 Ribbon 一并关掉 */
          ribbonType: 'simple',
          toolbar: true,
          /* 勿设 zoomSlider:false：会卸掉缩放相关 Redi 依赖，Facade zoom() 报 wH dependency missing */
          customFontFamily: { override: true, list: SHEETBOT_UI_FONT_FAMILY_LIST },
          menu: buildSheetbotHiddenFormulaRibbonMenuConfig(),
        }),
      ],
    })

    univerAPIRef.current = univerAPI
    univerInstanceRef.current = univer

    // ---- 行列头 borderColor 统一为网格线颜色 ----
    // Univer 默认：gridlines = getColor([214,216,219])，headerBorder = getColor([217,217,217])
    // CanvasColorService 在 darkMode 反转后二者产生可感知差异。
    // 统一到同一源色，保证反转结果完全一致。
    const GRIDLINES_COLOR = 'rgb(214, 216, 219)'
    try {
      univerAPI.customizeColumnHeader({ headerStyle: { borderColor: GRIDLINES_COLOR } })
      univerAPI.customizeRowHeader({ headerStyle: { borderColor: GRIDLINES_COLOR } })
    } catch (_e) { /* facade API 尚未就绪时静默忽略 */ }

    const cancelUiPatches = scheduleSheetbotUniverUiPatchesOnSteady(univer, el, darkMode)

    const unregisterInsertChartMenu = registerSheetbotInsertChartContextMenu(univer, {
      invoke: () => onOpenChartInsertRef.current?.(),
      isReadOnly: () => readOnlyRef.current,
      getCustomFormulas: () => customFormulasRef.current,
      applyCustomFormula: (formulaId) => {
        onApplyCustomFormulaRef.current?.(formulaId, null)
      },
    })

    const cfDigestRef = { current: computeConditionalFormatDigest(workbookPreserveRef.current) }

    const runDebouncedExport = () => {
      // readOnly 模式下仍可能发生“结构性命令”（如列宽/行高/视图相关）；
      // 这里不能直接 return，否则这些变更不会回写到 React workbook，
      // 后续一旦发生重灌会被旧快照覆盖，表现为“设置了但没有生效”。
      scheduleDebounced(() => {
        const api = univerAPIRef.current
        const fb = api?.getActiveWorkbook?.()
        if (!fb) return
        try {
          const activeName = fb.getActiveSheet?.()?.getSheetName?.() ?? null
          const next = univerSnapshotToSheetbotWorkbook(fb.save(), workbookPreserveRef.current, activeName)
          const prevStr = JSON.stringify(workbookPreserveRef.current ?? {})
          const nextStr = JSON.stringify(next ?? {})
          if (prevStr === nextStr) return

          // 条件格式动态重算：编辑数值后烘焙结果可能变化，需强制重灌刷新颜色
          const nextCfDigest = computeConditionalFormatDigest(next)
          const cfChanged = nextCfDigest !== cfDigestRef.current
          cfDigestRef.current = nextCfDigest
          skipNextWorkbookInjectRef.current = !cfChanged

          const revision = bumpRevision()
          onWorkbookChangeRef.current?.(next, { revision, source: 'univer' })
        } catch (e) {
          console.warn('[Univer] debounced export', e)
        }
      })
    }

    const cmdSub = univerAPI.onCommandExecuted(runDebouncedExport)

    let activeSheetEventSub = null
    if (typeof univerAPI.addEvent === 'function' && univerAPI.Event?.ActiveSheetChanged) {
      try {
        activeSheetEventSub = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, (params) => {
          try {
            if (suppressActiveSheetChangeRef.current) return
            const ws = params?.activeSheet
            const name = ws && typeof ws.getSheetName === 'function' ? ws.getSheetName() : ''
            if (!name) return
            onUniverActiveSheetChangeRef.current?.(name)
          } catch (e) {
            console.warn('[Univer] ActiveSheetChanged handler', e)
          }
        })
      } catch (e) {
        console.warn('[Univer] ActiveSheetChanged subscribe', e)
      }
    }

    univer.onDispose(() => {
      worker.terminate()
    })

    const detachRibbonPin = attachUniverRibbonPin(el)

    return () => {
      try {
        unregisterInsertChartMenu()
      } catch (_) {
        /* ignore */
      }
      try {
        cancelUiPatches()
      } catch (_) {
        /* ignore */
      }
      try {
        cmdSub.dispose()
      } catch (_) {
        /* ignore */
      }
      try {
        activeSheetEventSub?.dispose?.()
      } catch (_) {
        /* ignore */
      }
      cancelDebounced()
      univerAPIRef.current = null
      univerInstanceRef.current = null
      try {
        univer.dispose()
      } catch (e) {
        console.warn('[Univer] dispose', e)
      }
      try {
        detachRibbonPin()
      } catch (_) {
        /* ignore */
      }
      worker.terminate()
    }
  }, [containerId, sheetTheme, scheduleDebounced, cancelDebounced, bumpRevision])

  // 追踪上一次 fileId，当文件切换时强制注入，无视 skipNext 标记
  const prevFileIdRef = useRef(fileId)
  const cornerExtDisposableRef = useRef(null)

  // ── 节流注入（SSE 连续操作边执行边渲染，避免全量等待） ──
  const INJECT_THROTTLE_MS = 400
  const lastInjectTsRef = useRef(0)
  const trailingInjectTimerRef = useRef(null)

  const injectWorkbook = useCallback((preserveView) => {
    const api = univerAPIRef.current
    if (!api) return
    const prevWb = api.getActiveWorkbook?.()
    const captured = preserveView && prevWb ? captureActiveSheetViewState(api) : null
    if (prevWb) {
      try { prevWb.dispose() } catch (e) { console.warn('[Univer] dispose workbook', e) }
    }
    try {
      const wb = workbookPreserveRef.current
      const snap = sheetbotWorkbookToUniverSnapshot(JSON.parse(JSON.stringify(wb ?? {})))
      snap.id = `sheetbot-wb-${++_wbSeq}`
      suppressActiveSheetChangeRef.current = true
      api.createWorkbook(snap)
      const u = univerInstanceRef.current
      if (u) applySheetbotUniverUiRuntimePatches(u)

      // 注册角标边框扩展（每次 createWorkbook 后需重新注册）
      try {
        cornerExtDisposableRef.current?.dispose?.()
      } catch (_) { /* ignore */ }
      try {
        cornerExtDisposableRef.current = api.registerSheetRowHeaderExtension(
          snap.id, createCornerBorderExtension()
        )
      } catch (_e) { /* facade 尚未就绪时静默忽略 */ }
      let finalized = false
      const finalize = () => {
        if (finalized) return
        finalized = true
        suppressActiveSheetChangeRef.current = false
        if (captured) {
          requestAnimationFrame(() => {
            try {
              restoreActiveSheetViewState(api, captured)
            } catch (_) {
              /* ignore */
            }
            applyHeaderZoomToActiveSheet()
          })
        }
      }
      const runAlign = (attempt = 0) => {
        try {
          const fb = api.getActiveWorkbook?.()
          if (!fb) {
            if (attempt < 8) {
              requestAnimationFrame(() => runAlign(attempt + 1))
              return
            }
            finalize()
            return
          }
          const glide = glideActiveSheetRef?.current
          const wantSheet =
            (typeof glide === 'string' && glide ? glide : null) ||
            activeSheetPropRef.current ||
            wb?.activeSheet ||
            (Array.isArray(wb?.sheets) ? wb.sheets[0]?.name : null)
          if (wantSheet) {
            activateSheetByName(fb, wantSheet)
          }
          if (typeof fb.setEditable === 'function') {
            fb.setEditable(!readOnlyRef.current)
          }
          applyHeaderZoomToActiveSheet()
          finalize()
        } catch (e) {
          console.warn('[Univer] inject rAF align', e)
          finalize()
        }
      }
      requestAnimationFrame(runAlign)
    } catch (e) {
      console.warn('[Univer] createWorkbook', e)
      suppressActiveSheetChangeRef.current = false
    }
  }, [applyHeaderZoomToActiveSheet])

  useEffect(() => {
    const api = univerAPIRef.current
    if (!api) return

    const prevId = prevFileIdRef.current
    const fileChanged = fileId !== prevId
    prevFileIdRef.current = fileId

    // 文件切换：立即注入，不节流
    if (fileChanged) {
      skipNextWorkbookInjectRef.current = false
      clearTimeout(trailingInjectTimerRef.current)
      lastInjectTsRef.current = Date.now()
      injectWorkbook(false)
      return
    }

    if (skipNextWorkbookInjectRef.current) {
      skipNextWorkbookInjectRef.current = false
      return
    }

    // ── 节流注入：SSE 连续操作时每 INJECT_THROTTLE_MS 渲染一次 ──
    // 领先边（leading）：距上次注入超过阈值则立即执行
    // 尾随边（trailing）：保证最后一次变更一定被渲染
    const now = Date.now()
    const elapsed = now - lastInjectTsRef.current

    clearTimeout(trailingInjectTimerRef.current)

    if (elapsed >= INJECT_THROTTLE_MS) {
      lastInjectTsRef.current = now
      injectWorkbook(true)
    } else {
      trailingInjectTimerRef.current = setTimeout(() => {
        lastInjectTsRef.current = Date.now()
        injectWorkbook(true)
      }, INJECT_THROTTLE_MS - elapsed)
    }

    return () => clearTimeout(trailingInjectTimerRef.current)
  }, [workbookInjectSig, fileId, sheetTheme, injectWorkbook])

  /* 只读开关在运行期变化（同实例） */
  useEffect(() => {
    const api = univerAPIRef.current
    const fb = api?.getActiveWorkbook?.()
    if (!fb || typeof fb.setEditable !== 'function') return
    try {
      fb.setEditable(!_readOnly)
    } catch (e) {
      console.warn('[Univer] setEditable', e)
    }
  }, [_readOnly])

  /* Header 缩放：rAF 避免与 setActiveSheet / 引擎切表同帧竞态触发 zoom 命令异常 */
  useEffect(() => {
    if (viewZoom == null || !Number.isFinite(Number(viewZoom))) return
    const id = requestAnimationFrame(() => {
      applyHeaderZoomToActiveSheet()
    })
    return () => cancelAnimationFrame(id)
  }, [viewZoom, activeSheet, workbookInjectSig, fileId, applyHeaderZoomToActiveSheet])

  /* 选区 -> App（StatusBar 等）；依赖 ref 避免父组件回调引用抖动 */
  useEffect(() => {
    let cancelled = false
    let disposable = null
    const t = window.setTimeout(() => {
      if (cancelled || !onUniverSelectionChangeRef.current) return
      try {
        const api = univerAPIRef.current
        const fb = api?.getActiveWorkbook?.()
        if (!fb || typeof fb.onSelectionChange !== 'function') return
        disposable = fb.onSelectionChange(() => {
          if (cancelled) return
          const cb = onUniverSelectionChangeRef.current
          if (!cb) return
          try {
            const apiNow = univerAPIRef.current
            const fbNow = apiNow?.getActiveWorkbook?.()
            const fws = fbNow?.getActiveSheet?.()
            const ar = fws?.getSelection?.()?.getActiveRange?.()
            if (!ar || typeof ar.getRow !== 'function') return
            cb({
              startRow: ar.getRow() + 1,
              startCol: ar.getColumn() + 1,
              endRow: ar.getLastRow() + 1,
              endCol: ar.getLastColumn() + 1,
            })
          } catch {
            /* 切表/销毁窗口 */
          }
        })
      } catch {
        /* API 未就绪 */
      }
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(t)
      try {
        disposable?.dispose?.()
      } catch {
        /* ignore */
      }
    }
  }, [workbookInjectSig, fileId])

  const active = activeSheet || workbook?.activeSheet || workbook?.sheets?.[0]?.name || 'Sheet1'

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 480 }}>
      <div
        ref={hostRef}
        id={containerId}
        className="univer-sheet-host"
        style={{ width: '100%', height: '100%', minHeight: 480 }}
      />
      {/* UniverCornerPatch 已移除 — Canvas 原生渲染保持线宽一致 */}
      <UniverImagesOverlay workbook={workbook} activeSheet={active} univerAPIRef={univerAPIRef} hostRef={hostRef} />
      <UniverChartsOverlay workbook={workbook} activeSheet={active} univerAPIRef={univerAPIRef} hostRef={hostRef} onChartUpdate={onChartUpdate} onChartDelete={onChartDelete} />
    </div>
  )
})

UniverSheetContainer.displayName = 'UniverSheetContainer'

export default UniverSheetContainer
