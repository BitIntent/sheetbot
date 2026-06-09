import { nanoid } from 'nanoid'
import tinycolor from 'tinycolor2'
import type {
  PPTChartElement, PPTImageElement, PPTTableElement, PPTTextElement,
  PPTElement, Slide, TableCell, ChartType, ChartData,
} from '@pptist/types/slides'
import {
  CANVAS_W,
  CANVAS_H,
  DEFAULT_PALETTE,
  getElementTextType,
  intersects,
  normalizeRegion,
} from '@pptist/hooks/pptLayoutStrategy'
import type { ContentRegion, ThemePalette } from '@pptist/hooks/pptLayoutStrategy'

// ============================================================
// 后端 DataElements 定义
// ============================================================

interface ChartElementDef {
  type: 'chart'
  chartType: string
  left: number
  top: number
  width: number
  height: number
  data: ChartData
}

interface ChartImageElementDef {
  type: 'chartImage'
  src: string
  left: number
  top: number
  width: number
  height: number
}

interface TableElementDef {
  type: 'table'
  left: number
  top: number
  width: number
  height: number
  colWidths: number[]
  cellMinHeight?: number
  data: { id?: string; colspan?: number; rowspan?: number; text: string; style?: Record<string, unknown> }[][]
  theme?: {
    color: string
    rowHeader: boolean
    rowFooter: boolean
    colHeader: boolean
    colFooter: boolean
  }
}

interface KPIElementDef {
  type: 'kpi'
  left: number
  top: number
  width: number
  height: number
  value: string
  unit?: string
  label: string
}

type ElementDef = ChartElementDef | ChartImageElementDef | TableElementDef | KPIElementDef

export interface DataElementGroup {
  slide_index: number
  elements: ElementDef[]
}

// ============================================================
// 内容区域探测：从模板 slide 的 text/shape 元素推导出可用区域
// ============================================================

function detectContentRegion(slide: Slide): ContentRegion {
  const contentEls = slide.elements.filter(
    (el: PPTElement) =>
      !('lock' in el && el.lock) &&
      (el.type === 'text' || el.type === 'shape') &&
      ('textType' in el || ('text' in el && el.text))
  )

  if (contentEls.length === 0) {
    return { left: 50, top: 100, width: CANVAS_W - 100, height: CANVAS_H - 150 }
  }

  // 找到标题区域（title 元素）和内容区域（非 title 元素）
  const titleEls = contentEls.filter(
    (el: any) =>
      el.textType === 'title' ||
      (el.text && el.text.type === 'title')
  )
  const bodyEls = contentEls.filter(
    (el: any) =>
      el.textType !== 'title' &&
      !(el.text && el.text.type === 'title')
  )

  const candidates = bodyEls.length > 0 ? bodyEls : contentEls

  let minLeft = CANVAS_W, minTop = CANVAS_H, maxRight = 0, maxBottom = 0
  for (const el of candidates) {
    minLeft = Math.min(minLeft, el.left)
    minTop = Math.min(minTop, el.top)
    maxRight = Math.max(maxRight, el.left + el.width)
    maxBottom = Math.max(maxBottom, el.top + el.height)
  }

  // 标题在上方时，内容区从标题底部开始
  if (titleEls.length > 0 && bodyEls.length === 0) {
    const titleBottom = Math.max(...titleEls.map(el => el.top + el.height))
    minTop = titleBottom + 10
    maxBottom = CANVAS_H - 30
  }

  const region = {
    left: Math.max(minLeft, 30),
    top: Math.max(minTop, 30),
    width: Math.min(maxRight - minLeft, CANVAS_W - 60),
    height: Math.min(maxBottom - minTop, CANVAS_H - 60),
  }

  // 保证最小尺寸
  if (region.width < 420) region.width = CANVAS_W - 120
  if (region.height < 220) region.height = CANVAS_H - 180

  // 允许更宽/更高，减少“内容太小”问题，同时确保不出画布
  if (region.width > 880) region.width = 880
  if (region.height > 380) region.height = 420
  return normalizeRegion(region, 24)
}

/** 左文右图模板：将图表锚定到画布右侧空白区 */
function detectChartPlacementRegion(slide: Slide, baseRegion: ContentRegion): ContentRegion {
  const bodyEls = slide.elements.filter(
    (el: PPTElement) =>
      (el.type === 'text' || el.type === 'shape') &&
      !('lock' in el && el.lock),
  )
  const textBodies = bodyEls.filter((el: any) => {
    const tt = getElementTextType(el)
    return tt === 'item' || tt === 'itemTitle' || tt === 'content'
  })

  let chartLeft = Math.max(baseRegion.left, Math.floor(CANVAS_W * 0.44))
  let chartWidth = Math.min(CANVAS_W - chartLeft - 40, Math.floor(CANVAS_W * 0.5))

  if (textBodies.length > 0) {
    const textRight = Math.max(...textBodies.map(el => el.left + el.width))
    if (textRight < CANVAS_W * 0.55) {
      chartLeft = Math.max(chartLeft, textRight + 24)
      chartWidth = Math.max(280, CANVAS_W - chartLeft - 40)
    }
  }

  return normalizeRegion({
    left: chartLeft,
    top: baseRegion.top,
    width: chartWidth,
    height: baseRegion.height,
  }, 24)
}

function isValidChartData(data?: ChartData): boolean {
  if (!data) return false
  const labels = Array.isArray(data.labels) ? data.labels : []
  const series = Array.isArray(data.series) ? data.series : []
  if (!labels.length || !series.length) return false
  return series.some(row => Array.isArray(row) && row.some(v => Number.isFinite(Number(v))))
}

// ============================================================
// 元素构建
// ============================================================

function buildChartElement(
  def: ChartElementDef, region: ContentRegion, palette: ThemePalette,
): PPTChartElement | null {
  if (!isValidChartData(def.data)) return null
  return {
    type: 'chart',
    id: nanoid(10),
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
    rotate: 0,
    chartType: (def.chartType || 'bar') as ChartType,
    data: def.data,
    themeColors: palette.themeColors.length ? palette.themeColors : DEFAULT_PALETTE.themeColors,
    textColor: palette.fontColor,
    lineColor: '#eee',
    fill: '#ffffff',
  }
}

function buildChartImageElement(
  def: ChartImageElementDef, region: ContentRegion,
): PPTImageElement | null {
  if (!def.src) return null
  return {
    type: 'image',
    id: nanoid(10),
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
    rotate: 0,
    src: def.src,
    fixedRatio: false,
  }
}

function buildTableElement(def: TableElementDef, region: ContentRegion, palette: ThemePalette): PPTTableElement {
  const data: TableCell[][] = def.data.map(row =>
    row.map(cell => ({
      id: cell.id || nanoid(10),
      colspan: cell.colspan ?? 1,
      rowspan: cell.rowspan ?? 1,
      text: cell.text || '',
      style: {
        ...(cell.style as TableCell['style'] || {}),
        color: '#000000',
      } as TableCell['style'],
    }))
  )

  return {
    type: 'table',
    id: nanoid(10),
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
    rotate: 0,
    colWidths: def.colWidths,
    cellMinHeight: def.cellMinHeight ?? 36,
    data,
    outline: { width: 2, style: 'solid', color: '#eeece1' },
    theme: {
      ...(def.theme ?? { color: palette.primaryColor, rowHeader: true, rowFooter: false, colHeader: false, colFooter: false }),
      color: palette.primaryColor,
      tableBgColor: tinycolor(palette.primaryColor).setAlpha(0.08).toRgbString(),
    },
  }
}

function buildKPIElements(
  defs: KPIElementDef[], region: ContentRegion, palette: ThemePalette,
): PPTTextElement[] {
  const count = defs.length
  if (count === 0) return []

  const gap = 20
  const itemW = (region.width - gap * (count - 1)) / count
  const elements: PPTTextElement[] = []

  for (let i = 0; i < count; i++) {
    const def = defs[i]
    const left = region.left + i * (itemW + gap)
    // KPI 数值用主色，系列轮换强调色
    const kpiColor = palette.themeColors[i % palette.themeColors.length] || palette.primaryColor

    const valueHtml = def.unit
      ? `<strong><span style="font-size:36px;color:${kpiColor}">${def.value}</span><span style="font-size:18px;color:${kpiColor}">${def.unit}</span></strong>`
      : `<strong><span style="font-size:36px;color:${kpiColor}">${def.value}</span></strong>`
    // 指标名称在上、数值在下；整体下移以留出顶部空间
    const labelTop = region.top
    const valueTop = region.top + 36
    elements.push({
      type: 'text',
      id: nanoid(10),
      left,
      top: labelTop,
      width: itemW,
      height: 28,
      rotate: 0,
      content: `<p style="text-align:center"><span style="font-size:14px;color:${palette.mutedColor}">${def.label}</span></p>`,
      defaultFontName: '',
      defaultColor: palette.mutedColor,
    })
    elements.push({
      type: 'text',
      id: nanoid(10),
      left,
      top: valueTop,
      width: itemW,
      height: 72,
      rotate: 0,
      content: `<p style="text-align:center;line-height:1.3">${valueHtml}</p>`,
      defaultFontName: '',
      defaultColor: palette.fontColor,
    })
  }

  return elements
}

// ============================================================
// 文字解读元素构建
// ============================================================

function buildInsightTextElement(
  text: string,
  region: ContentRegion,
  palette: ThemePalette,
  options?: { fontSize?: number },
): PPTTextElement {
  const fontSize = options?.fontSize ?? 12
  return {
    type: 'text',
    id: nanoid(10),
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
    rotate: 0,
    content: `<p style="line-height:1.6"><span style="font-size:${fontSize}px;color:${palette.mutedColor}">${text}</span></p>`,
    defaultFontName: '',
    defaultColor: palette.mutedColor,
  }
}

// ============================================================
// AIPPT Slide 定义（仅用于提取文字解读）
// ============================================================

interface AIPPTSlideForInsight {
  type: string
  source_index: number
  data?: {
    title?: string
    items?: { title?: string; text?: string }[]
    notes?: string
  }
}

// ============================================================
// 导出：注入数据元素到已生成的幻灯片
// 基于模板内容区域自适应布局，不使用后端硬编码坐标
// ============================================================

export function injectDataElements(
  slides: Slide[],
  dataElements: DataElementGroup[],
  _themeColors?: string[],
  aipptSlides?: AIPPTSlideForInsight[],
  palette?: ThemePalette,
): Slide[] {
  const pal = palette || DEFAULT_PALETTE
  if (!dataElements || dataElements.length === 0) return slides

  const result = slides.map(s => ({ ...s, elements: [...s.elements] }))

  for (const group of dataElements) {
    let mappedIndex = result.findIndex((s: any) => s?.sheetbotSourceIndex === group.slide_index)
    if (mappedIndex < 0) {
      console.warn(
        '[PPT] 数据元素未匹配到幻灯片，已跳过',
        { slide_index: group.slide_index, available: result.map((s: any) => s?.sheetbotSourceIndex) },
      )
      continue
    }
    const slide = result[mappedIndex]
    if (!slide) continue

    const baseRegion = normalizeRegion(detectContentRegion(slide), 24)
    const chartPlacement = detectChartPlacementRegion(slide, baseRegion)
    const charts = group.elements.filter(e => e.type === 'chart') as ChartElementDef[]
    const chartImages = group.elements.filter(e => e.type === 'chartImage') as ChartImageElementDef[]
    const tables = group.elements.filter(e => e.type === 'table') as TableElementDef[]
    const kpis = group.elements.filter(e => e.type === 'kpi') as KPIElementDef[]
    const hasVisualChart = charts.length > 0 || chartImages.length > 0

    // 清理占位：图表仅清理右侧锚定区，保留左侧解读文案
    if (hasVisualChart || tables.length || kpis.length) {
      const removeGroupIds = new Set<string>()
      const removeElIds = new Set<string>()
      const dataZone: ContentRegion = hasVisualChart ? chartPlacement : { ...baseRegion }

      for (const el of slide.elements as any[]) {
        const tt = getElementTextType(el)
        const shouldRemoveText = tt === 'item' || tt === 'itemTitle' || tt === 'itemNumber' || tt === 'content'
        const elBox = { left: el.left, top: el.top, width: el.width, height: el.height }
        const inZone = intersects(elBox, dataZone)
        const isCandidateBodyEl =
          (el.type === 'text' || el.type === 'shape') &&
          !el.lock &&
          tt !== 'title' &&
          tt !== 'partNumber' &&
          inZone

        if (hasVisualChart) {
          if (shouldRemoveText && inZone) {
            removeElIds.add(el.id)
            if (el.groupId) removeGroupIds.add(el.groupId)
          }
          continue
        }

        if (shouldRemoveText) {
          removeElIds.add(el.id)
          if (el.groupId) removeGroupIds.add(el.groupId)
          continue
        }
        if (isCandidateBodyEl) {
          removeElIds.add(el.id)
          if (el.groupId) removeGroupIds.add(el.groupId)
        }
      }

      slide.elements = slide.elements.filter((el: any) => {
        if (removeElIds.has(el.id)) return false
        if (el.groupId && removeGroupIds.has(el.groupId)) return false
        return true
      })
    }

    let dataBottomY = baseRegion.top
    const insightText = _extractInsightText(group.slide_index, aipptSlides)
    const GAP = 16
    const reserveInsightH = insightText ? 72 : 0
    const reserveDataBottom = reserveInsightH + GAP

    // KPI 独占一行：指标名称在上、数值在下；整体下移以留出顶部空间
    if (kpis.length > 0) {
      const KPI_TOP_OFFSET = 56
      const kpiRegion = {
        ...baseRegion,
        top: baseRegion.top + KPI_TOP_OFFSET,
        height: 130,
      }
      const kpiEls = buildKPIElements(kpis, kpiRegion, pal)
      slide.elements.push(...kpiEls)
      baseRegion.top += KPI_TOP_OFFSET + 130
      baseRegion.height -= KPI_TOP_OFFSET + 110
      dataBottomY = baseRegion.top
    }

    // chart + table 并排或独占，表格/图表与解读至少 16px 间距，均在内容区内
    if (charts.length > 0 && tables.length > 0) {
      const half = (baseRegion.width - 20) / 2
      const usableH = Math.max(220, baseRegion.height - reserveDataBottom)
      const h = Math.min(usableH, 320)
      for (const c of charts) {
        const el = buildChartElement(c, normalizeRegion({ ...baseRegion, width: half, height: h }, 24), pal)
        if (el) slide.elements.push(el)
      }
      for (const t of tables) {
        slide.elements.push(buildTableElement(t, normalizeRegion({ ...baseRegion, left: baseRegion.left + half + 20, width: half, height: h }, 24), pal))
      }
      dataBottomY = baseRegion.top + h + GAP
    }
    else if (hasVisualChart) {
      const chartRegion = normalizeRegion({ ...chartPlacement, height: Math.min(chartPlacement.height, 400) }, 24)
      const usableH = Math.max(220, chartRegion.height - reserveDataBottom)
      const h = Math.min(usableH, 400)
      const region = normalizeRegion({ ...chartRegion, height: h }, 24)
      for (const c of charts) {
        const el = buildChartElement(c, region, pal)
        if (el) slide.elements.push(el)
      }
      for (const img of chartImages) {
        const el = buildChartImageElement(img, region)
        if (el) slide.elements.push(el)
      }
      dataBottomY = chartRegion.top + h + GAP
    }
    else if (tables.length > 0) {
      const usableH = Math.max(220, baseRegion.height - reserveDataBottom)
      const h = Math.min(usableH, 340)
      for (const t of tables) {
        slide.elements.push(buildTableElement(t, normalizeRegion({ ...baseRegion, height: h }, 24), pal))
      }
      dataBottomY = baseRegion.top + h + GAP
    }

    if (insightText && dataBottomY < CANVAS_H - 40) {
      const remainingH = CANVAS_H - dataBottomY - 20
      const isKpiOnly = kpis.length > 0 && charts.length === 0 && tables.length === 0
      const bottomMargin = 25
      let insightH: number
      let insightTop: number
      if (isKpiOnly) {
        insightTop = Math.max(dataBottomY + 100, CANVAS_H - bottomMargin - 240)
        const maxH = CANVAS_H - insightTop - bottomMargin
        insightH = Math.min(240, remainingH, maxH)
      } else {
        insightH = Math.min(72, remainingH)
        insightTop = dataBottomY
      }
      const insightRegion: ContentRegion = {
        left: baseRegion.left,
        top: insightTop,
        width: baseRegion.width,
        height: insightH,
      }
      slide.elements.push(buildInsightTextElement(
        insightText,
        normalizeRegion(insightRegion, 24),
        pal,
        isKpiOnly ? { fontSize: 14 } : undefined,
      ))
    }
  }

  return result
}

// 从 aipptSlides 中提取对应页的文字解读
function _extractInsightText(sourceIndex: number, aipptSlides?: AIPPTSlideForInsight[]): string {
  if (!aipptSlides) return ''
  const matched = aipptSlides.find(s => s.source_index === sourceIndex)
  if (!matched?.data) return ''

  const parts: string[] = []
  // notes 是最直接的解读
  if (matched.data.notes) parts.push(matched.data.notes)
  // items 中的 text 也是解读内容
  for (const item of matched.data.items || []) {
    if (item.text && item.text.length > 5) parts.push(item.text)
  }
  // 去重、截取前 200 字
  const unique = [...new Set(parts)]
  const joined = unique.join('  ')
  return joined.length > 200 ? joined.slice(0, 200) + '...' : joined
}

export default function useDataElementInjector() {
  return { injectDataElements }
}
