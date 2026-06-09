/**
 * ============================================================================
 * SheetBot JSON workbook <-> Univer IWorkbookData 双向适配
 * ============================================================================
 *
 * 覆盖范围（权威清单，修改时同步更新）：
 *
 * ---- 灌表（SheetBot -> Univer）承载 ----
 *   - 单元格值 / 公式 / 内联样式（含条件格式静态烘焙）
 *   - 样式属性完整映射：fontFamily/fontSize/bold/italic/underline/strikethrough
 *     fontColor/backgroundColor/horizontalAlignment/verticalAlignment
 *     wrapText(true→WRAP, false→CLIP)/numberFormat/border(4边)
 *     textRotation→tr / indent→pd.st
 *   - 兼容性安全网（normalizeStyleAliases）：snake_case 别名、嵌套 font/fill 展开
 *   - 合并区域 mergedCells -> mergeData
 *   - 行列宽高 colWidths/rowHeights -> columnData/rowData
 *   - 隐藏行 hiddenRows -> rowData[r].hd
 *   - 隐藏列 hiddenColumns -> columnData[c].hd
 *   - 冻结窗格 freeze -> freeze (xSplit/ySplit/startRow/startColumn)
 *   - 工作表隐藏 hidden -> hidden
 *   - 工作表标签颜色 tabColor
 *
 * ---- 灌表走叠加层（不经过 IWorkbookData）----
 *   - 图表 charts -> UniverChartsOverlay
 *   - 单元格内嵌图 cell.image -> UniverImagesOverlay
 *
 * ---- 灌表 JSON 持有但 Univer 未消费（prev 守门）----
 *   - 条件格式规则 conditionalFormats（灌表时静态烘焙进 style，回写时原样保留）
 *   - 数据验证 dataValidations
 *   - 筛选元数据 filters
 *   - 工作表级图片 images / 形状 shapes
 *   - 单元格批注 cell.comments
 *   - 单元格超链接 cell.hyperlink
 *
 * ---- 回写（Univer -> SheetBot）策略 ----
 *   Univer 快照提供：值/公式/样式/合并/行列宽高/隐藏行列/冻结
 *   prev 保留（白名单）：charts, conditionalFormats, dataValidations,
 *     hiddenRows*, hiddenColumns*, filters, images, shapes
 *   单元格级 prev 合并：image, comments, hyperlink
 *   * hiddenRows/hiddenColumns 优先从 Univer rowData/columnData 提取；
 *     Univer 未提供时回退 prev
 */
import { BooleanNumber, LocaleType } from '@univerjs/core'
import {
  mergeConditionalFormatIntoSheetbotStyle,
  prepareConditionalFormatRules,
  getConditionalFormatStyleAt,
} from '../utils/conditionalFormatEval'

const APP_VERSION = '3.0.0-alpha'

// ==================== 基础工具 ====================

// ── 语义名称 → Excel 格式模板映射 ──
// Agent 可能发送 "number"/"currency"/"percentage" 等语义名称，
// 这些不是合法的 Excel numFmt pattern；若原样传入 Univer，
// 格式引擎会把其中字母（m/e/d/s）解析为日期 token，
// 导致数值 2 被格式化为 "1900-01-02" — 严重数据损坏。
const _NUMFMT_ALIASES = {
  number: '#,##0',
  integer: '0',
  currency: '#,##0.00',
  accounting: '#,##0.00',
  percentage: '0.00%',
  percent: '0.00%',
  scientific: '0.00E+00',
  text: '@',
  date: 'yyyy-mm-dd',
  time: 'h:mm:ss',
  datetime: 'yyyy-mm-dd h:mm:ss',
  general: 'General',
}
function _resolveNumFmt(raw) {
  if (!raw || typeof raw !== 'string') return raw
  return _NUMFMT_ALIASES[raw.toLowerCase()] ?? raw
}

function toCellValue(v) {
  if (v == null) return ''
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return v
  return String(v)
}

function slugSheetId(name, index) {
  const base = String(name || `Sheet${index + 1}`).replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
  return `sb-${index}-${base.slice(0, 48)}`
}

// ==================== 样式转换：SheetBot <-> Univer ====================

const UNIVER_HA = { left: 1, center: 2, right: 3, justify: 4 }
const UNIVER_VA = { top: 1, middle: 2, bottom: 3 }
const HA_REV = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify' }
const VA_REV = { 1: 'top', 2: 'middle', 3: 'bottom' }

const BORDER_STYLE_MAP = {
  thin: 1, hair: 2, dotted: 3, dashed: 4,
  dashDot: 5, dashDotDot: 6, double: 7, medium: 8,
  mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11,
  slantDashDot: 12, thick: 13,
}
const BORDER_STYLE_REV = Object.fromEntries(
  Object.entries(BORDER_STYLE_MAP).map(([k, v]) => [v, k])
)

function colorToRgb(c) {
  if (!c) return undefined
  return typeof c === 'string' ? c : c.rgb || undefined
}

function normalizeHexColor(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const withHash = raw.startsWith('#') ? raw : `#${raw}`
  const body = withHash.slice(1)
  if (/^[0-9a-fA-F]{6}$/.test(body)) return `#${body.toUpperCase()}`
  if (/^[0-9a-fA-F]{8}$/.test(body)) return `#${body.slice(2).toUpperCase()}`
  return ''
}

// ==================== 单元格级 prev 合并 ====================

/**
 * Univer 快照不承载 image/comments/hyperlink，需从 prev.data 回补。
 * next 优先（Univer 编辑后的值/公式/style），prev 仅补缺失的非核心字段。
 */
function mergePrevCellExtras(nextData, prevData) {
  if (!prevData || typeof prevData !== 'object') return nextData
  const merged = { ...(nextData || {}) }
  const EXTRA_KEYS = ['image', 'comments', 'hyperlink']
  Object.keys(prevData).forEach((rKey) => {
    const prevRow = prevData[rKey]
    if (!prevRow || typeof prevRow !== 'object') return
    Object.keys(prevRow).forEach((cKey) => {
      const prevCell = prevRow[cKey]
      if (!prevCell || typeof prevCell !== 'object') return
      let hasExtra = false
      for (const k of EXTRA_KEYS) {
        if (prevCell[k] != null) { hasExtra = true; break }
      }
      if (!hasExtra) return
      if (!merged[rKey]) merged[rKey] = {}
      const nextCell = merged[rKey][cKey] || {}
      const patched = { ...nextCell }
      for (const k of EXTRA_KEYS) {
        if (prevCell[k] != null && patched[k] == null) {
          patched[k] = prevCell[k]
        }
      }
      merged[rKey][cKey] = patched
    })
  })
  return merged
}

// ==================== SheetBot style -> Univer IStyleData ====================

/**
 * 兼容性安全网：将后端/LLM 可能产出的 snake_case / 别名统一为 camelCase。
 * 在 sheetbotStyleToUniver 入口处做一次，保证后续字段读取始终命中。
 */
function normalizeStyleAliases(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const s = { ...raw }
  // snake_case 字体/颜色
  if (s.font_color && !s.fontColor) { s.fontColor = s.font_color; delete s.font_color }
  if (s.font_size && !s.fontSize) { s.fontSize = s.font_size; delete s.font_size }
  if (s.font_family && !s.fontFamily) { s.fontFamily = s.font_family; delete s.font_family }
  if (s.font_weight && !s.bold) { s.bold = s.font_weight === 'bold' || s.font_weight === true; delete s.font_weight }
  if (s.font_style && !s.italic) { s.italic = s.font_style === 'italic' || s.font_style === true; delete s.font_style }
  // 颜色别名
  if (s.color && !s.fontColor) { s.fontColor = s.color; delete s.color }
  if (s.background_color && !s.backgroundColor) { s.backgroundColor = s.background_color; delete s.background_color }
  if (s.bgColor && !s.backgroundColor) { s.backgroundColor = s.bgColor; delete s.bgColor }
  if (s.background && !s.backgroundColor) { s.backgroundColor = s.background; delete s.background }
  if (s.fill_color && !s.backgroundColor) { s.backgroundColor = s.fill_color; delete s.fill_color }
  if (s.fillColor && !s.backgroundColor) { s.backgroundColor = s.fillColor; delete s.fillColor }
  // 对齐别名
  if (s.align && !s.horizontalAlignment) { s.horizontalAlignment = s.align; delete s.align }
  if (s.valign && !s.verticalAlignment) { s.verticalAlignment = s.valign; delete s.valign }
  if (s.horizontal_alignment && !s.horizontalAlignment) { s.horizontalAlignment = s.horizontal_alignment; delete s.horizontal_alignment }
  if (s.vertical_alignment && !s.verticalAlignment) { s.verticalAlignment = s.vertical_alignment; delete s.vertical_alignment }
  // 换行 / 旋转 / 缩进别名
  if (s.wrap_text != null && s.wrapText == null) { s.wrapText = s.wrap_text; delete s.wrap_text }
  if (s.text_rotation != null && s.textRotation == null) { s.textRotation = s.text_rotation; delete s.text_rotation }
  if (s.number_format && !s.numberFormat) { s.numberFormat = s.number_format; delete s.number_format }
  // 嵌套 font 对象展开（ExcelJS 风格兜底）
  if (s.font && typeof s.font === 'object') {
    const f = s.font
    if (f.name && !s.fontFamily) s.fontFamily = f.name
    if (f.size != null && s.fontSize == null) s.fontSize = f.size
    if (f.bold && !s.bold) s.bold = true
    if (f.italic && !s.italic) s.italic = true
    if (f.underline && !s.underline) s.underline = true
    if (f.strike && !s.strikethrough) s.strikethrough = true
    if ((f.color?.argb || f.color?.rgb || f.color) && !s.fontColor) {
      s.fontColor = f.color?.rgb || f.color?.argb || f.color
    }
    delete s.font
  }
  // 嵌套 fill 对象展开
  if (s.fill && typeof s.fill === 'object') {
    const fg = s.fill.fgColor?.argb || s.fill.fgColor?.rgb || s.fill.color || s.fill.fgColor
    if (fg && !s.backgroundColor) s.backgroundColor = typeof fg === 'string' ? fg : (fg?.rgb || fg?.argb || '')
    delete s.fill
  }
  return s
}

function sheetbotStyleToUniver(rawStyle) {
  if (!rawStyle || typeof rawStyle !== 'object') return undefined
  const style = normalizeStyleAliases(rawStyle)
  const s = {}
  if (style.fontFamily) s.ff = style.fontFamily
  if (style.fontSize != null) s.fs = Number(style.fontSize)
  if (style.bold) s.bl = 1
  if (style.italic) s.it = 1
  if (style.underline) s.ul = { s: 1 }
  if (style.strikethrough) s.st = { s: 1 }
  const fc = colorToRgb(style.fontColor)
  if (fc) s.cl = { rgb: fc }
  const bg = colorToRgb(style.backgroundColor)
  if (bg) s.bg = { rgb: bg }
  if (style.horizontalAlignment || style.horizontalAlign) {
    const ha = style.horizontalAlignment || style.horizontalAlign
    if (UNIVER_HA[ha]) s.ht = UNIVER_HA[ha]
  }
  if (style.verticalAlignment || style.verticalAlign) {
    const va = style.verticalAlignment || style.verticalAlign
    if (UNIVER_VA[va]) s.vt = UNIVER_VA[va]
  }
  // 换行：truthy→WRAP(2)，显式 false→CLIP(1)
  if (style.wrapText === true) s.tb = 2
  else if (style.wrapText === false) s.tb = 1
  // 文字旋转（角度，-90~90）
  if (style.textRotation != null) {
    const deg = Number(style.textRotation)
    if (Number.isFinite(deg)) s.tr = { a: deg }
  }
  // 缩进（左缩进 → paddingData.st，单位 pt，默认 1 级 = 8pt）
  if (style.indent != null) {
    const level = Number(style.indent)
    if (Number.isFinite(level) && level > 0) {
      s.pd = { ...(s.pd || {}), st: level * 8 }
    }
  }
  if (style.numberFormat) s.n = { pattern: _resolveNumFmt(style.numberFormat) }
  if (style.border && typeof style.border === 'object') {
    const bd = {}
    for (const side of ['t', 'r', 'b', 'l']) {
      const key = { t: 'top', r: 'right', b: 'bottom', l: 'left' }[side]
      const src = style.border[key]
      if (!src) continue
      const borderStyle = BORDER_STYLE_MAP[src.style] ?? 1
      const clr = colorToRgb(src.color?.argb || src.color)
      bd[side] = { s: borderStyle, cl: clr ? { rgb: clr } : { rgb: '#000000' } }
    }
    if (Object.keys(bd).length) s.bd = bd
  }
  return Object.keys(s).length ? s : undefined
}

// ==================== Univer IStyleData -> SheetBot style ====================

function univerStyleToSheetbot(cellS, stylesMap) {
  if (cellS == null) return undefined
  const sd = typeof cellS === 'string' ? stylesMap?.[cellS] : cellS
  if (!sd || typeof sd !== 'object') return undefined

  const style = {}
  if (sd.ff) style.fontFamily = sd.ff
  if (sd.fs != null) style.fontSize = sd.fs
  if (sd.bl === 1) style.bold = true
  if (sd.it === 1) style.italic = true
  if (sd.ul?.s === 1) style.underline = true
  if (sd.st?.s === 1) style.strikethrough = true
  if (sd.cl?.rgb) style.fontColor = sd.cl.rgb
  if (sd.bg?.rgb) style.backgroundColor = sd.bg.rgb
  if (sd.ht && HA_REV[sd.ht]) style.horizontalAlignment = HA_REV[sd.ht]
  if (sd.vt && VA_REV[sd.vt]) style.verticalAlignment = VA_REV[sd.vt]
  if (sd.tb === 2) style.wrapText = true
  else if (sd.tb === 1) style.wrapText = false
  // 文字旋转
  if (sd.tr?.a != null) {
    const deg = Number(sd.tr.a)
    if (Number.isFinite(deg)) style.textRotation = deg
  }
  // 缩进（paddingData.st → indent 级数，1 级 = 8pt）
  if (sd.pd?.st != null) {
    const pt = Number(sd.pd.st)
    if (Number.isFinite(pt) && pt > 0) style.indent = Math.round(pt / 8)
  }
  if (sd.n?.pattern) style.numberFormat = sd.n.pattern
  if (sd.bd && typeof sd.bd === 'object') {
    const border = {}
    for (const [uKey, exKey] of [['t', 'top'], ['r', 'right'], ['b', 'bottom'], ['l', 'left']]) {
      const side = sd.bd[uKey]
      if (!side) continue
      const bs = BORDER_STYLE_REV[side.s] || 'thin'
      border[exKey] = { style: bs }
      if (side.cl?.rgb) border[exKey].color = { argb: side.cl.rgb.replace('#', 'FF') }
    }
    if (Object.keys(border).length) style.border = border
  }
  return Object.keys(style).length ? style : undefined
}

// ==================== 合并 / 行列宽高 ====================

function sheetbotMergedToMergeData(mergedCells) {
  if (!Array.isArray(mergedCells)) return []
  return mergedCells
    .map((m) => {
      const sr = Number(m?.startRow)
      const sc = Number(m?.startCol ?? m?.startColumn)
      const er = Number(m?.endRow)
      const ec = Number(m?.endCol ?? m?.endColumn)
      if (![sr, sc, er, ec].every((n) => Number.isFinite(n))) return null
      // SheetBot: 1-based inclusive -> Univer: 0-based inclusive（四端对称 -1）
      return { startRow: sr - 1, endRow: er - 1, startColumn: sc - 1, endColumn: ec - 1 }
    })
    .filter(Boolean)
}

/**
 * SheetBot 宽高 + 隐藏行列 -> Univer rowData/columnData
 * Univer: rowData[0-based] = { h: px, hd: BooleanNumber.TRUE }
 */
function sheetbotToUniverRowColData(colWidths, rowHeights, hiddenRows, hiddenColumns) {
  const columnData = {}
  const rowData = {}
  if (colWidths && typeof colWidths === 'object') {
    for (const k of Object.keys(colWidths)) {
      const c1 = Number(k)
      if (!Number.isFinite(c1) || c1 < 1 || colWidths[k] == null) continue
      columnData[String(c1 - 1)] = { w: Number(colWidths[k]) }
    }
  }
  if (rowHeights && typeof rowHeights === 'object') {
    for (const k of Object.keys(rowHeights)) {
      const r1 = Number(k)
      if (!Number.isFinite(r1) || r1 < 1 || rowHeights[k] == null) continue
      rowData[String(r1 - 1)] = { h: Number(rowHeights[k]) }
    }
  }
  if (Array.isArray(hiddenRows)) {
    for (const r1 of hiddenRows) {
      const idx = Number(r1)
      if (!Number.isFinite(idx) || idx < 1) continue
      const key = String(idx - 1)
      rowData[key] = { ...(rowData[key] || {}), hd: BooleanNumber.TRUE }
    }
  }
  if (Array.isArray(hiddenColumns)) {
    for (const c1 of hiddenColumns) {
      const idx = Number(c1)
      if (!Number.isFinite(idx) || idx < 1) continue
      const key = String(idx - 1)
      columnData[key] = { ...(columnData[key] || {}), hd: BooleanNumber.TRUE }
    }
  }
  return { columnData, rowData }
}

/**
 * Univer rowData/columnData -> SheetBot 宽高 + 隐藏行列
 */
function univerToSheetbotRowColData(columnData, rowData, prevColWidths, prevRowHeights) {
  const colWidths = { ...(prevColWidths && typeof prevColWidths === 'object' ? prevColWidths : {}) }
  const rowHeights = { ...(prevRowHeights && typeof prevRowHeights === 'object' ? prevRowHeights : {}) }
  const hiddenRows = []
  const hiddenColumns = []
  if (rowData && typeof rowData === 'object') {
    for (const r0 of Object.keys(rowData)) {
      const entry = rowData[r0]
      if (!entry || typeof entry !== 'object') continue
      const r1 = Number(r0) + 1
      if (entry.h != null) rowHeights[r1] = entry.h
      if (entry.hd === BooleanNumber.TRUE) hiddenRows.push(r1)
    }
  }
  if (columnData && typeof columnData === 'object') {
    for (const c0 of Object.keys(columnData)) {
      const entry = columnData[c0]
      if (!entry || typeof entry !== 'object') continue
      const c1 = Number(c0) + 1
      if (entry.w != null) colWidths[c1] = entry.w
      if (entry.hd === BooleanNumber.TRUE) hiddenColumns.push(c1)
    }
  }
  return { colWidths, rowHeights, hiddenRows, hiddenColumns }
}

// ==================== SheetBot -> Univer ====================

/**
 * @param {object} sheetbotWorkbook
 * @returns {import('@univerjs/core').IWorkbookData}
 */
export function sheetbotWorkbookToUniverSnapshot(sheetbotWorkbook) {
  const sheetsIn = Array.isArray(sheetbotWorkbook?.sheets) ? sheetbotWorkbook.sheets : []
  const sheetOrder = []
  const sheets = {}
  const styles = {}
  let styleCounter = 0

  sheetsIn.forEach((sheet, index) => {
    const name = sheet?.name || `Sheet${index + 1}`
    const sid = slugSheetId(name, index)
    sheetOrder.push(sid)

    const rowCount = Math.max(200, Number(sheet?.rowCount) || 500)
    const columnCount = Math.max(26, Number(sheet?.colCount) || 26)
    const cellData = {}
    const mergeData = sheetbotMergedToMergeData(sheet?.mergedCells)
    const { columnData, rowData } = sheetbotToUniverRowColData(
      sheet?.colWidths, sheet?.rowHeights, sheet?.hiddenRows, sheet?.hiddenColumns
    )

    const data = sheet?.data && typeof sheet.data === 'object' ? sheet.data : {}
    const cfRules = prepareConditionalFormatRules(sheet)
    for (const rKey of Object.keys(data)) {
      const r1 = Number(rKey)
      if (!Number.isFinite(r1) || r1 < 1) continue
      const uRow = String(r1 - 1)
      const rowObj = data[rKey]
      if (!rowObj || typeof rowObj !== 'object') continue
      for (const cKey of Object.keys(rowObj)) {
        const c1 = Number(cKey)
        if (!Number.isFinite(c1) || c1 < 1) continue
        const uCol = String(c1 - 1)
        const sbCell = rowObj[cKey]
        if (!sbCell || typeof sbCell !== 'object') continue

        const uCell = {}
        const formula = sbCell.formula != null ? String(sbCell.formula) : ''
        if (formula.startsWith('=')) {
          uCell.f = formula
        } else if ('value' in sbCell && sbCell.value !== undefined && sbCell.value !== null && sbCell.value !== '') {
          uCell.v = toCellValue(sbCell.value)
        }

        const cfFmt =
          cfRules.length > 0 ? getConditionalFormatStyleAt(r1, c1, sbCell, cfRules, data) : null
        const mergedSbStyle = mergeConditionalFormatIntoSheetbotStyle(sbCell.style, cfFmt)
        const uStyle = sheetbotStyleToUniver(mergedSbStyle)
        if (uStyle) {
          const styleSid = `s_${styleCounter++}`
          styles[styleSid] = uStyle
          uCell.s = styleSid
        }

        if (uCell.v !== undefined || uCell.f || uCell.s) {
          if (!cellData[uRow]) cellData[uRow] = {}
          cellData[uRow][uCol] = uCell
        }
      }
    }

    // 冻结窗格
    const sbFreeze = sheet?.freeze
    let freeze = { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 }
    if (sbFreeze && typeof sbFreeze === 'object') {
      const fr = Number(sbFreeze.row ?? sbFreeze.ySplit ?? 0)
      const fc = Number(sbFreeze.col ?? sbFreeze.xSplit ?? 0)
      if (Number.isFinite(fr) && fr > 0) {
        freeze.ySplit = fr
        freeze.startRow = fr
      }
      if (Number.isFinite(fc) && fc > 0) {
        freeze.xSplit = fc
        freeze.startColumn = fc
      }
    }

    sheets[sid] = {
      id: sid,
      name,
      tabColor: normalizeHexColor(sheet?.tabColor),
      hidden: sheet?.hidden ? BooleanNumber.TRUE : BooleanNumber.FALSE,
      freeze,
      rowCount,
      columnCount,
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      mergeData,
      cellData,
      rowData,
      columnData,
      rowHeader: { width: 46, hidden: BooleanNumber.FALSE },
      columnHeader: { height: 20, hidden: BooleanNumber.FALSE },
      showGridlines: BooleanNumber.TRUE,
      rightToLeft: BooleanNumber.FALSE,
    }
  })

  if (sheetOrder.length === 0) {
    const sid = 'sb-0-Sheet1'
    sheetOrder.push(sid)
    sheets[sid] = {
      id: sid,
      name: 'Sheet1',
      tabColor: '',
      hidden: BooleanNumber.FALSE,
      freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
      rowCount: 500,
      columnCount: 26,
      zoomRatio: 1,
      scrollTop: 0,
      scrollLeft: 0,
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      mergeData: [],
      cellData: {},
      rowData: {},
      columnData: {},
      rowHeader: { width: 46, hidden: BooleanNumber.FALSE },
      columnHeader: { height: 20, hidden: BooleanNumber.FALSE },
      showGridlines: BooleanNumber.TRUE,
      rightToLeft: BooleanNumber.FALSE,
    }
  }

  const wbId = `sheetbot-wb-${sheetbotWorkbook?.activeSheet || 'default'}`

  return {
    id: wbId,
    name: 'SheetBot',
    appVersion: APP_VERSION,
    locale: LocaleType.ZH_CN,
    sheetOrder,
    styles,
    sheets,
  }
}

// ==================== Univer -> SheetBot ====================

/**
 * Univer IWorkbookData -> SheetBot workbook
 * @param {import('@univerjs/core').IWorkbookData} snapshot
 * @param {object} [preserve] JSON 真源（含 Univer 不承载的字段）
 * @param {string | null | undefined} [facadeActiveSheetName]
 */
export function univerSnapshotToSheetbotWorkbook(snapshot, preserve = {}, facadeActiveSheetName) {
  const prevSheets = Array.isArray(preserve.sheets) ? preserve.sheets : []
  const byName = (name) => prevSheets.find((s) => s.name === name) || {}
  const stylesMap = snapshot?.styles || {}

  const sheets = (snapshot?.sheetOrder || []).map((sid) => {
    const ws = snapshot.sheets?.[sid]
    if (!ws) return null
    const name = ws.name || 'Sheet1'
    const prev = byName(name)
    const data = {}

    const cellData = ws.cellData || {}
    for (const r0 of Object.keys(cellData)) {
      const r1 = Number(r0) + 1
      if (!Number.isFinite(r1) || r1 < 1) continue
      const row = cellData[r0]
      if (!row || typeof row !== 'object') continue
      for (const c0 of Object.keys(row)) {
        const c1 = Number(c0) + 1
        if (!Number.isFinite(c1) || c1 < 1) continue
        const cell = row[c0]
        if (!cell || typeof cell !== 'object') continue

        const o = {}
        if (cell.f != null && String(cell.f).trim()) o.formula = String(cell.f)
        else if (cell.v !== undefined && cell.v !== null && cell.v !== '') o.value = cell.v

        const style = univerStyleToSheetbot(cell.s, stylesMap)
        if (style) o.style = style

        if (Object.keys(o).length === 0) continue
        if (!data[r1]) data[r1] = {}
        data[r1][c1] = o
      }
    }

    // Univer: 0-based inclusive -> SheetBot: 1-based inclusive（四端对称 +1）
    const mergedCells = (ws.mergeData || []).map((m) => ({
      startRow: m.startRow + 1,
      endRow: m.endRow + 1,
      startCol: m.startColumn + 1,
      endCol: m.endColumn + 1,
    }))

    // 从 Univer rowData/columnData 提取宽高 + 隐藏状态
    const extracted = univerToSheetbotRowColData(
      ws.columnData, ws.rowData, prev.colWidths, prev.rowHeights
    )

    // 隐藏行/列：Univer 有则取 Univer，否则回退 prev
    const hiddenRows = extracted.hiddenRows.length > 0
      ? extracted.hiddenRows
      : (prev.hiddenRows || [])
    const hiddenColumns = extracted.hiddenColumns.length > 0
      ? extracted.hiddenColumns
      : (prev.hiddenColumns || [])

    const nextHidden = ws.hidden === BooleanNumber.TRUE
      ? true
      : ws.hidden === BooleanNumber.FALSE
        ? false
        : !!prev.hidden
    const nextTabColor = ws.tabColor == null ? prev.tabColor : ws.tabColor

    // 冻结窗格：从 Univer 提取
    let freeze = prev.freeze || undefined
    if (ws.freeze) {
      const ys = ws.freeze.ySplit || 0
      const xs = ws.freeze.xSplit || 0
      if (ys > 0 || xs > 0) {
        freeze = {}
        if (ys > 0) freeze.row = ys
        if (xs > 0) freeze.col = xs
      } else {
        freeze = undefined
      }
    }

    // 单元格级合并：image + comments + hyperlink
    const mergedData = mergePrevCellExtras(data, prev.data)

    return {
      name,
      data: mergedData,
      rowCount: ws.rowCount ?? prev.rowCount,
      colCount: ws.columnCount ?? prev.colCount,
      tabColor: normalizeHexColor(nextTabColor),
      hidden: nextHidden,
      mergedCells,
      freeze,
      charts: prev.charts || [],
      colWidths: extracted.colWidths,
      rowHeights: extracted.rowHeights,
      hiddenRows,
      hiddenColumns,
      conditionalFormats: prev.conditionalFormats,
      dataValidations: prev.dataValidations,
      filters: prev.filters,
      images: prev.images,
      shapes: prev.shapes,
    }
  }).filter(Boolean)

  const sheetNameSet = new Set(sheets.map((s) => s?.name).filter(Boolean))
  const fromFacade =
    facadeActiveSheetName && sheetNameSet.has(facadeActiveSheetName) ? facadeActiveSheetName : null
  const fromPreserve = preserve.activeSheet && sheetNameSet.has(preserve.activeSheet) ? preserve.activeSheet : null

  return {
    ...preserve,
    sheets,
    activeSheet: fromFacade || fromPreserve || sheets[0]?.name || 'Sheet1',
  }
}
