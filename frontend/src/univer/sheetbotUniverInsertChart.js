// ================================================================
// SheetBot：Univer 右键菜单扩展
// - 插入图表（BUTTON）
// - 引用自定义公式（SUBITEMS 原生二级悬停菜单 + 原生箭头）
//
// 核心难点：Univer getMenuByPositionKey 对非内置 position key
// 返回 undefined（导致 SUBITEMS 渲染 .length 崩溃），且
// context menu onOptionSelect 不向 command 传递 params。
// 解法：patch getMenuByPositionKey 注入自定义 provider +
//       per-formula command 绕过 params 缺失。
// ================================================================

import { CommandType, ICommandService } from '@univerjs/core'
import { ContextMenuPosition, IContextMenuService, IMenuManagerService, MenuItemType } from '@univerjs/ui'
import { of } from 'rxjs'

export const SHEETBOT_OPEN_INSERT_CHART_COMMAND_ID = 'sheetbot.command.open-insert-chart'

// 父级 SUBITEMS 的 id 即子菜单的 position key
const FORMULA_SUBMENU_KEY = 'sheetbot.submenu.custom-formula'
const FORMULA_CMD_PREFIX = 'sheetbot.formula.exec.'

/**
 * @param {import('@univerjs/core').Univer} univer
 * @param {{
 *  invoke: () => void,
 *  isReadOnly: () => boolean,
 *  getCustomFormulas?: () => Array<any>,
 *  applyCustomFormula?: (formulaId: string) => void,
 * }} bridge
 * @returns {() => void}
 */
export function registerSheetbotInsertChartContextMenu(univer, bridge) {
  const injector = univer && typeof univer.__getInjector === 'function' ? univer.__getInjector() : null
  if (!injector) return () => {}

  const commandService = injector.get(ICommandService)
  const menuManager = injector.get(IMenuManagerService)
  let ctxMenuService = null
  try { ctxMenuService = injector.get(IContextMenuService) } catch (_) { /* 降级到合成事件 */ }

  // ================================================================
  // Patch getMenuByPositionKey
  // 原因：SUBITEMS 渲染 ne = getMenuByPositionKey(id)，接着 ne.length。
  //       对非内置 key（如我们的 FORMULA_SUBMENU_KEY），原实现返回 undefined → 崩溃。
  // 方案：注入 provider Map，自定义 key 命中时直接返回构建好的 IMenuSchema[]。
  // ================================================================
  if (!menuManager._sbProviders) {
    menuManager._sbProviders = new Map()
    const orig = menuManager.getMenuByPositionKey
    menuManager.getMenuByPositionKey = function (key) {
      const native = orig.call(this, key)
      if (Array.isArray(native) && native.length > 0) return native
      const provider = this._sbProviders.get(key)
      if (provider) {
        try { return provider() } catch (_) { return [] }
      }
      return Array.isArray(native) ? native : []
    }
  }

  // ================================================================
  // 注册：插入图表 command
  // ================================================================
  const hasChartCmd = commandService.hasCommand(SHEETBOT_OPEN_INSERT_CHART_COMMAND_ID)
  const chartDispose = hasChartCmd
    ? { dispose() {} }
    : commandService.registerCommand({
        id: SHEETBOT_OPEN_INSERT_CHART_COMMAND_ID,
        type: CommandType.COMMAND,
        handler: () => {
          if (bridge.isReadOnly?.()) return false
          try { bridge.invoke?.() } catch (e) { console.warn('[SheetBot] insert chart', e) }
          return true
        },
      })

  // ================================================================
  // 自定义公式子菜单 provider
  //
  // getMenuByPositionKey(FORMULA_SUBMENU_KEY) 被调用时触发。
  // 每次右键弹出菜单 → useMemo 重新计算 → 调用此 provider → 读取最新公式列表。
  //
  // Univer context menu 的 onOptionSelect 不传 params 给 executeCommand，
  // 因此每个公式分配独立 commandId（per-formula command），
  // formulaId 通过闭包捕获，不依赖 params 传递。
  // ================================================================
  const registeredFormulaCmds = new Set()

  menuManager._sbProviders.set(FORMULA_SUBMENU_KEY, () => {
    const formulas = bridge.getCustomFormulas?.() || []

    if (!formulas.length) {
      return [{
        key: 'sb-formula-empty',
        order: 0,
        item: {
          id: 'sheetbot.formula.empty',
          type: MenuItemType.BUTTON,
          title: '暂无自定义公式',
          disabled$: of(true),
        },
      }]
    }

    return formulas.map((f, i) => {
      const fid = String(f.id || f.name || `f${i}`)
      const cmdId = `${FORMULA_CMD_PREFIX}${fid}`

      if (!registeredFormulaCmds.has(cmdId)) {
        try {
          commandService.registerCommand({
            id: cmdId,
            type: CommandType.COMMAND,
            handler: () => {
              if (bridge.isReadOnly?.()) return false
              // 关闭菜单：主菜单 + 子菜单 portal 需全部收起
              // 1. IContextMenuService 官方 API —— 关闭主菜单
              try { ctxMenuService?.hideContextMenu() } catch (_) { /* ignore */ }
              // 2. 执行公式
              try { bridge.applyCustomFormula?.(fid) } catch (e) { console.warn('[SheetBot] formula', e) }
              // 3. 下一帧兜底：子菜单 portal 可能未随主菜单同步卸载
              requestAnimationFrame(() => {
                try { ctxMenuService?.hideContextMenu() } catch (_) { /* ignore */ }
                document.querySelectorAll('[data-u-context-menu-submenu]').forEach(el => {
                  el.style.cssText = 'display:none !important'
                })
              })
              return true
            },
          })
          registeredFormulaCmds.add(cmdId)
        } catch (_) { /* 幂等：重复注册忽略 */ }
      }

      return {
        key: `sb-formula-${i}`,
        order: 10 + i,
        item: {
          id: cmdId,
          commandId: cmdId,
          type: MenuItemType.BUTTON,
          title: String(f.label || f.name || `公式${i + 1}`),
        },
      }
    })
  })

  // ================================================================
  // 注册一级菜单：SUBITEMS 获取原生悬停展开 + 原生箭头
  // ================================================================
  const parentFactory = () => ({
    id: FORMULA_SUBMENU_KEY,
    type: MenuItemType.SUBITEMS,
    title: '引用自定义公式',
  })

  menuManager.mergeMenu({
    [ContextMenuPosition.MAIN_AREA]: {
      sheetbotInsertChart: {
        order: 950,
        menuItemFactory: () => ({
          id: SHEETBOT_OPEN_INSERT_CHART_COMMAND_ID,
          commandId: SHEETBOT_OPEN_INSERT_CHART_COMMAND_ID,
          type: MenuItemType.BUTTON,
          title: '插入图表',
        }),
      },
      sheetbotCustomFormula: { order: 980, menuItemFactory: parentFactory },
    },
    [ContextMenuPosition.COL_HEADER]: {
      sheetbotCustomFormula: { order: 980, menuItemFactory: parentFactory },
    },
    [ContextMenuPosition.ROW_HEADER]: {
      sheetbotCustomFormula: { order: 980, menuItemFactory: parentFactory },
    },
  })

  try { menuManager.menuChanged$.next() } catch (_) { /* ignore */ }

  // ================================================================
  // Cleanup
  // ================================================================
  return () => {
    menuManager._sbProviders?.delete(FORMULA_SUBMENU_KEY)
    try { chartDispose.dispose() } catch (_) { /* ignore */ }
    if (!hasChartCmd) {
      try { commandService.unregisterCommand(SHEETBOT_OPEN_INSERT_CHART_COMMAND_ID) } catch (_) { /* ignore */ }
    }
    for (const cmdId of registeredFormulaCmds) {
      try { commandService.unregisterCommand(cmdId) } catch (_) { /* ignore */ }
    }
    registeredFormulaCmds.clear()
  }
}
