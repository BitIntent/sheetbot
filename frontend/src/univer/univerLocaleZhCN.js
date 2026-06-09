/**
 * 合并各 @univerjs/* 包内建 zh-CN 文案（npm 不发 @univerjs/mockdata，故从已安装包聚合）
 * 对照：D:\\dev\\python\\univer\\examples 使用 mockdata/locales/zh-CN
 */
import designZhCN from '@univerjs/design/locale/zh-CN'
import docsUiZhCN from '@univerjs/docs-ui/locale/zh-CN'
import sheetsFormulaUiZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN'
import sheetsNumfmtUiZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN'
import sheetsCoreZhCN from '@univerjs/sheets/locale/zh-CN'
import sheetsUiZhCN from '@univerjs/sheets-ui/locale/zh-CN'
import uiZhCN from '@univerjs/ui/locale/zh-CN'

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target
  const out = target && typeof target === 'object' ? target : {}
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = out[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv)
    } else {
      out[key] = sv
    }
  }
  return out
}

const zhCN = [designZhCN, uiZhCN, docsUiZhCN, sheetsCoreZhCN, sheetsUiZhCN, sheetsFormulaUiZhCN, sheetsNumfmtUiZhCN].reduce(
  (acc, cur) => deepMerge(acc, cur),
  {}
)

export default zhCN
