<template>
  <div class="pptist-editor-bridge pptist-wrapper">
    <div class="layout-content">
      <Thumbnails class="layout-content-left" />
      <div class="layout-content-center">
        <CanvasTool class="center-top" />
        <Canvas class="center-body" />
        <Remark
          class="center-bottom"
          v-model:height="remarkHeight"
          :style="{ height: `${remarkHeight}px` }"
        />
      </div>
      <Toolbar class="layout-content-right" />
    </div>

    <!-- 浮动面板 -->
    <SelectPanel v-if="showSelectPanel" />
    <SearchPanel v-if="showSearchPanel" />
    <NotesPanel v-if="showNotesPanel" />
    <MarkupPanel v-if="showMarkupPanel" />
    <SymbolPanel v-if="showSymbolPanel" />
    <ImageLibPanel v-if="showImageLibPanel" />

    <!-- 导出弹窗 -->
    <Modal
      :visible="!!dialogForExport"
      :width="680"
      @closed="closeExportDialog()"
    >
      <ExportDialog />
    </Modal>

    <!-- AIPPT 弹窗 -->
    <Modal
      :visible="!!showAIPPTDialog"
      :width="720"
      :closeOnClickMask="false"
      :closeOnEsc="false"
      closeButton
      :wrapStyle="{ opacity: showAIPPTDialog === 'running' ? 0 : 1 }"
      @closed="closeAIPPTDialog()"
    >
      <AIPPTDialog />
    </Modal>
  </div>
</template>

<script lang="ts" setup>
// ============================================================================
// PPTist 编辑器桥接入口 -- 去除 EditorHeader，保留完整编辑能力
// Props -> Store / Store -> Emit 双向同步，
// runAIPPT 期间用 isRunningAIPPT 锁阻断 props 回写覆盖
// ============================================================================
import { ref, watch, onMounted, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { nanoid } from 'nanoid'
import { useMainStore, useSlidesStore, useSnapshotStore, useScreenStore } from '@pptist/store'
import useGlobalHotkey from '@pptist/hooks/useGlobalHotkey'
import usePasteEvent from '@pptist/hooks/usePasteEvent'

import Canvas from '@pptist/views/Editor/Canvas/index.vue'
import CanvasTool from '@pptist/views/Editor/CanvasTool/index.vue'
import Thumbnails from '@pptist/views/Editor/Thumbnails/index.vue'
import Toolbar from '@pptist/views/Editor/Toolbar/index.vue'
import Remark from '@pptist/views/Editor/Remark/index.vue'
import ExportDialog from '@pptist/views/Editor/ExportDialog/index.vue'
import SelectPanel from '@pptist/views/Editor/SelectPanel.vue'
import SearchPanel from '@pptist/views/Editor/SearchPanel.vue'
import NotesPanel from '@pptist/views/Editor/NotesPanel.vue'
import SymbolPanel from '@pptist/views/Editor/SymbolPanel.vue'
import MarkupPanel from '@pptist/views/Editor/MarkupPanel.vue'
import ImageLibPanel from '@pptist/views/Editor/ImageLibPanel.vue'
import AIPPTDialog from '@pptist/views/Editor/AIPPTDialog.vue'
import Modal from '@pptist/components/Modal.vue'

import type { Slide } from '@pptist/types/slides'
import type { AIPPTSlide } from '@pptist/types/AIPPT'
import useAddSlidesOrElements from '@pptist/hooks/useAddSlidesOrElements'
import useAIPPT from '@pptist/hooks/useAIPPT'
import useSlideHandler from '@pptist/hooks/useSlideHandler'
import { injectDataElements } from '@pptist/hooks/useDataElementInjector'
import type { DataElementGroup } from '@pptist/hooks/useDataElementInjector'
import tinycolor from 'tinycolor2'
import {
  appendFallbackBodyTextIfNeeded,
  CANVAS_H,
  CANVAS_W,
  cloneElement,
  extractThemePalette,
  getElementTextType,
  removeUnfilledPlaceholders,
  replaceElementText,
} from '@pptist/hooks/pptLayoutStrategy'
import type { ThemePalette } from '@pptist/hooks/pptLayoutStrategy'

// ---------- Props / Emits ----------
const props = defineProps<{
  slides?: Slide[]
  slideIndex?: number
  speakerName?: string
}>()

const emit = defineEmits<{
  (e: 'update:slides', slides: Slide[]): void
  (e: 'update:slideIndex', index: number): void
  (e: 'requestScreening'): void
  (e: 'requestExport', type: string): void
  (e: 'slidesReady'): void
}>()

// ---------- Store ----------
const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const snapshotStore = useSnapshotStore()

const {
  dialogForExport,
  showSelectPanel,
  showSearchPanel,
  showNotesPanel,
  showSymbolPanel,
  showMarkupPanel,
  showImageLibPanel,
  showAIPPTDialog,
} = storeToRefs(mainStore)

const closeExportDialog = () => mainStore.setDialogForExport('')
const closeAIPPTDialog = () => mainStore.setAIPPTDialogState(false)

const remarkHeight = ref(40)

// ── AIPPT 注入锁：阻断 Props->Store 和 Store->Emit 的循环覆盖 ──
const isRunningAIPPT = ref(false)

// ---------- Props -> Store 同步 ----------
watch(
  () => props.slides,
  (newSlides) => {
    // AIPPT 注入期间跳过，防止 React batch 回传中间态覆盖 store
    if (isRunningAIPPT.value) return
    if (newSlides && newSlides.length > 0) {
      slidesStore.setSlides(newSlides)
      snapshotStore.initSnapshotDatabase()
      emit('slidesReady')
    }
  },
  { immediate: true }
)

onMounted(() => {
  if (!props.slides || props.slides.length === 0) {
    setTimeout(() => emit('slidesReady'), 100)
  }
})

watch(
  () => props.slideIndex,
  (idx) => {
    if (idx !== undefined && idx !== slidesStore.slideIndex) {
      slidesStore.updateSlideIndex(idx)
    }
  }
)

// Store -> Emit 同步：注入期间静默，完成后一次性推送最终态
watch(
  () => slidesStore.slides,
  (s) => {
    if (!isRunningAIPPT.value) emit('update:slides', s)
  },
  { deep: true }
)

watch(
  () => slidesStore.slideIndex,
  (i) => emit('update:slideIndex', i)
)

// ---------- 全局快捷键 + 粘贴 ----------
useGlobalHotkey()
usePasteEvent()

// ---------- AIPPT 生成 ----------
const { AIPPT } = useAIPPT()
const { resetSlides } = useSlideHandler()

const applySpeakerName = (slides: Slide[], speakerName: string): Slide[] => {
  if (!speakerName) return slides
  const patterns = [
    /演讲人\s*[：:]\s*(XXX|xxx|待定|姓名)?/g,
    /汇报人\s*[：:]\s*(XXX|xxx|待定|姓名)?/g,
    /\{\{\s*speaker\s*\}\}/gi,
  ]

  const replaceInHtml = (html: string) => {
    let text = html
    for (const p of patterns) {
      text = text.replace(p, (m: string) => {
        if (m.startsWith('{{')) return speakerName
        const prefix = m.includes('汇报人') ? '汇报人：' : '演讲人：'
        return `${prefix}${speakerName}`
      })
    }
    return text
  }

  return slides.map((slide) => ({
    ...slide,
    elements: slide.elements.map((el: any) => {
      if (el.type === 'text' && typeof el.content === 'string') {
        return { ...el, content: replaceInHtml(el.content) }
      }
      if (el.type === 'shape' && el.text?.content) {
        return { ...el, text: { ...el.text, content: replaceInHtml(el.text.content) } }
      }
      return el
    }),
  }))
}

// 策略方法集中在 pptLayoutStrategy.ts，组件内只保留流程编排

// ── 从模板中提取一对 item+itemNumber 的"行模板" ──
const extractItemRow = (tpl: Slide) => {
  const items = tpl.elements.filter((e: any) => getElementTextType(e) === 'item')
  const numbers = tpl.elements.filter((e: any) => getElementTextType(e) === 'itemNumber')
  if (!items.length) return null
  // 排序：从上到下、从左到右
  const posSort = (a: any, b: any) => (a.top * 2 + a.left) - (b.top * 2 + b.left)
  items.sort(posSort)
  numbers.sort(posSort)
  return { item: items[0], number: numbers[0] || null, numbers, rowHeight: items[0].height + 10 }
}

// ── 从模板 itemNumber 中选取高亮样式（不透明背景）作为统一编号风格 ──
const pickHighlightedNumberFill = (numbers: any[], palette?: ThemePalette): string => {
  if (!numbers?.length) {
    return palette?.primaryColor ? tinycolor(palette.primaryColor).setAlpha(0.6).toRgbString() : '#5b9bd5'
  }
  let best = numbers[0]?.fill
  let bestAlpha = 0
  for (const n of numbers) {
    const fill = n?.fill
    if (!fill) continue
    const c = tinycolor(fill)
    const alpha = c.getAlpha()
    if (alpha > bestAlpha) {
      bestAlpha = alpha
      best = fill
    }
  }
  if (bestAlpha >= 0.4) return best
  return palette?.primaryColor ? tinycolor(palette.primaryColor).setAlpha(0.6).toRgbString() : '#5b9bd5'
}

// ── 空白内容模板：仅有背景+标题，无 item/itemNumber/itemTitle/content ──
const isBlankContentTemplate = (tpl: Slide) =>
  !tpl.elements.some((e: any) =>
    ['item', 'itemNumber', 'itemTitle', 'content'].includes(getElementTextType(e)),
  )

// ── 总结页：空白模板 + 左对齐 + ☆ 项目符号，内容填充大部分页 ──
const buildSummaryContentElements = (
  tpl: Slide,
  dataItems: { title?: string; text?: string }[],
  slideTitle: string,
  palette?: ThemePalette,
) => {
  const fontColor = palette?.fontColor || '#333'
  const decorations = tpl.elements
    .filter((e: any) => {
      const tt = getElementTextType(e)
      if (tt === 'item' || tt === 'itemNumber' || tt === 'itemTitle' || tt === 'content') return false
      if (e.type === 'line') return false
      if (e.type === 'shape' && e.height != null && e.width != null && e.height < 12 && e.width > 80) return false
      return true
    })
    .map((el: any) => {
      const cel = cloneElement(el)
      if (getElementTextType(el) === 'title') return replaceElementText(cel, slideTitle)
      return cel
    })
  const MARGIN = 60
  const contentTop = 100
  const contentBottom = CANVAS_H - 50
  const availableH = contentBottom - contentTop
  const n = Math.max(1, dataItems.length)
  const rowH = Math.max(40, availableH / n)
  const fullWidth = CANVAS_W - 2 * MARGIN
  const BULLET = '\u2606'
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows: any[] = []
  for (let i = 0; i < dataItems.length; i++) {
    const raw = dataItems[i]?.text || dataItems[i]?.title || ''
    const bulletText = `${BULLET} ${escapeHtml(raw)}`
    const html = `<p style="text-align:left;line-height:1.5"><span style="font-size:16px;color:${fontColor}">${bulletText}</span></p>`
    rows.push({
      type: 'text',
      id: nanoid(10),
      left: MARGIN,
      top: contentTop + i * rowH,
      width: fullWidth,
      height: rowH - 4,
      rotate: 0,
      content: html,
      defaultFontName: '',
      defaultColor: fontColor,
    } as any)
  }
  return [...decorations, ...rows]
}

// ── 为目录页动态生成 item 行（最多 6 条，自适应 y 防溢出）──
const buildContentsElements = (tpl: Slide, dataItems: string[], palette?: ThemePalette) => {
  const rowTpl = extractItemRow(tpl)
  if (!rowTpl) return tpl.elements.map(cloneElement)

  // 保留非 item/itemNumber 的装饰元素（背景、标题等）；排除 line 避免模板虚线被带入
  const decorations = tpl.elements.filter((e: any) => {
    const tt = getElementTextType(e)
    if (tt === 'item' || tt === 'itemNumber') return false
    if (e.type === 'line') return false
    return true
  }).map(cloneElement)

  const contentTop = rowTpl.item.top
  const contentBottom = CANVAS_H - 50
  const availableH = contentBottom - contentTop
  const n = Math.max(1, dataItems.length)
  const rowH = Math.max(32, availableH / n)
  const baseTop = contentTop
  const rows: any[] = []

  const numberFill = pickHighlightedNumberFill(rowTpl.numbers || (rowTpl.number ? [rowTpl.number] : []), palette)
  const ensureNumberFill = (el: any) => ({ ...el, fill: numberFill })
  for (let i = 0; i < dataItems.length; i++) {
    const yOffset = baseTop + i * rowH
    if (rowTpl.number) {
      rows.push(replaceElementText(
        ensureNumberFill({ ...cloneElement(rowTpl.number), top: yOffset }),
        String(i + 1).padStart(2, '0'),
      ))
    }
    rows.push(replaceElementText(
      { ...cloneElement(rowTpl.item), top: yOffset },
      dataItems[i],
    ))
  }
  return [...decorations, ...rows]
}


const buildSlidesByTemplateFallback = (templateSlides: Slide[], aipptSlides: AIPPTSlide[], palette?: ThemePalette): Slide[] => {
  const byType = (t: string) => templateSlides.filter((s: any) => s.type === t)
  const coverTpl = byType('cover')[0] || templateSlides[0]
  const contentsTpls = byType('contents')
  const transitionTpl = byType('transition')[0]
  const contentTpls = byType('content')
  const endTpl = byType('end')[0]

  const pickByItems = (templates: Slide[], n: number) => {
    if (!templates.length) return null
    const score = (s: any) => s.elements.filter((e: any) => getElementTextType(e) === 'item').length
    const sorted = [...templates].sort((a: any, b: any) => Math.abs(score(a) - n) - Math.abs(score(b) - n))
    return sorted[0]
  }

  let transitionCounter = 0
  const out: Slide[] = []

  for (const item of aipptSlides as any[]) {
    // ── 封面 ──
    if (item.type === 'cover' && coverTpl) {
      const elements = coverTpl.elements.map((el: any) => {
        if (getElementTextType(el) === 'title') return replaceElementText(cloneElement(el), item.data?.title || '')
        if (getElementTextType(el) === 'content') return replaceElementText(cloneElement(el), item.data?.text || '')
        return cloneElement(el)
      })
      out.push({ ...coverTpl, id: nanoid(10), sheetbotSourceIndex: item.source_index ?? -1, elements } as Slide)
      continue
    }

    // ── 目录（动态行数）──
    if (item.type === 'contents' && contentsTpls.length) {
      const tpl = contentsTpls[0]
      const dataItems: string[] = item.data?.items || []
      const elements = buildContentsElements(tpl, dataItems, palette)
      out.push({ ...tpl, id: nanoid(10), sheetbotSourceIndex: item.source_index ?? -1, elements } as Slide)
      continue
    }

    // ── 过渡页（编号递增）──
    if (item.type === 'transition' && transitionTpl) {
      transitionCounter += 1
      const elements = transitionTpl.elements.map((el: any) => {
        const tt = getElementTextType(el)
        if (tt === 'title') return replaceElementText(cloneElement(el), item.data?.title || '')
        if (tt === 'content') return replaceElementText(cloneElement(el), item.data?.text || '')
        if (tt === 'partNumber') return replaceElementText(cloneElement(el), String(transitionCounter).padStart(2, '0'))
        return cloneElement(el)
      })
      out.push({ ...transitionTpl, id: nanoid(10), sheetbotSourceIndex: item.source_index ?? -1, elements } as Slide)
      continue
    }

    // ── 内容页（填充 + 清理残留）──
    if (item.type === 'content' && contentTpls.length) {
      const dataItems: { title?: string; text?: string }[] = item.data?.items || []
      const slideTitle = item.data?.title || ''
      const isSummary = /总结|建议/.test(slideTitle) && slideTitle.length <= 20
      const listTpl = contentTpls.find((t: any) =>
        t.elements.some((e: any) => getElementTextType(e) === 'item'),
      ) ?? contentsTpls[0]
      if (isSummary && dataItems.length > 0) {
        const blankTpl = contentTpls.find((t: any) => isBlankContentTemplate(t)) ?? contentTpls[0]
        const elements = buildSummaryContentElements(
          blankTpl,
          dataItems,
          slideTitle || '总结与建议',
          palette,
        )
        if (elements) {
          out.push({
            ...blankTpl,
            id: nanoid(10),
            sheetbotSourceIndex: item.source_index ?? -1,
            elements,
          } as Slide)
          continue
        }
      }
      const tpl = pickByItems(contentTpls, dataItems.length) || contentTpls[0]
      const hasItemNumber = tpl.elements.some((e: any) => getElementTextType(e) === 'itemNumber')
      const isSummaryList = isSummary && !hasItemNumber
      let titleCursor = 0
      let textCursor = 0
      let numberCursor = 1
      const filledIds = new Set<string>()
      const mergedBodyText = dataItems
        .map((d) => [d.title, d.text].filter(Boolean).join('：'))
        .filter(Boolean)
        .join('；')

      const elements = tpl.elements.map((el: any) => {
        const tt = getElementTextType(el)
        const cel = cloneElement(el)

        if (tt === 'title') {
          filledIds.add(cel.id)
          return replaceElementText(cel, item.data?.title || '')
        }
        if (tt === 'itemTitle') {
          const t = dataItems[titleCursor]?.title || ''
          titleCursor += 1
          if (t) { filledIds.add(cel.id); return replaceElementText(cel, t) }
          return cel
        }
        if (tt === 'item') {
          const t = dataItems[textCursor]?.text || ''
          const displayText = isSummaryList && t ? `${textCursor + 1}. ${t}` : t
          textCursor += 1
          if (displayText) { filledIds.add(cel.id); return replaceElementText(cel, displayText) }
          if (!t && textCursor === 1 && mergedBodyText) {
            filledIds.add(cel.id)
            return replaceElementText(cel, isSummaryList ? `1. ${mergedBodyText}` : mergedBodyText)
          }
          return cel
        }
        if (tt === 'itemNumber') {
          if (numberCursor <= dataItems.length) {
            filledIds.add(cel.id)
            const n = String(numberCursor).padStart(2, '0')
            numberCursor += 1
            return replaceElementText(cel, n)
          }
          numberCursor += 1
          return cel
        }
        if (tt === 'content' && dataItems.length === 1) {
          filledIds.add(cel.id)
          return replaceElementText(cel, dataItems[0]?.text || '')
        }
        if (tt === 'content' && mergedBodyText) {
          filledIds.add(cel.id)
          return replaceElementText(cel, mergedBodyText)
        }
        // 非占位元素默认保留；占位元素若未命中将被清理
        if (tt !== 'item' && tt !== 'itemTitle' && tt !== 'itemNumber' && tt !== 'content') {
          filledIds.add(cel.id)
        }
        return cel
      })

      const cleaned = removeUnfilledPlaceholders(elements, filledIds)
      const textForFallback = mergedBodyText || item.data?.notes || ''
      const baseSlide = { ...tpl, id: nanoid(10), sheetbotSourceIndex: item.source_index ?? -1, elements: cleaned } as Slide
      out.push(appendFallbackBodyTextIfNeeded(baseSlide, textForFallback, palette))
      continue
    }

    // ── 感谢页 ──
    if (item.type === 'end' && endTpl) {
      out.push({ ...endTpl, id: nanoid(10), sheetbotSourceIndex: -1, elements: endTpl.elements.map(cloneElement) } as Slide)
    }
  }
  return out
}

// ---------- 暴露给 React（通过 ref）的命令式 API ----------
defineExpose({
  openExportDialog: (type?: string) => mainStore.setDialogForExport(type || 'pptx'),
  startScreening: () => {
    const screenStore = useScreenStore()
    screenStore.setScreening(true)
    emit('requestScreening')
  },
  openAIPPTDialog: () => mainStore.setAIPPTDialogState(true),
  getSlides: () => slidesStore.slides,
  getSlideIndex: () => slidesStore.slideIndex,
  setSlides: (slides: Slide[]) => slidesStore.setSlides(slides),
  addSlides: (slides: Slide[]) => {
    const { addSlidesFromData } = useAddSlidesOrElements()
    addSlidesFromData(slides)
  },
  /**
   * 二阶段注入（带锁保护）：
   * 1. AIPPT 根据模板 + AI 数据填充文字
   * 2. injectDataElements 注入图表/表格/KPI
   * 全程屏蔽 Props<->Store 双向同步，完成后一次性推送
   */
  runAIPPT: (
    templateSlides: Slide[],
    aipptSlides: AIPPTSlide[],
    dataElements: DataElementGroup[],
    imgs?: { id: string; src: string; width: number; height: number }[],
    speakerName?: string,
    templateTheme?: any,
  ) => {
    isRunningAIPPT.value = true

    if (templateTheme) {
      slidesStore.setTheme(templateTheme)
    }

    resetSlides()
    if (templateTheme) {
      slidesStore.setTheme(templateTheme)
    }
    AIPPT(templateSlides, aipptSlides, imgs)

    const finalize = () => {
      if (templateTheme) {
        slidesStore.setTheme(templateTheme)
      }
      const palette = extractThemePalette(templateTheme || slidesStore.theme)

      if (aipptSlides?.length) {
        const fallbackSlides = buildSlidesByTemplateFallback(templateSlides, aipptSlides, palette)
        if (fallbackSlides.length) {
          slidesStore.setSlides(fallbackSlides)
        }
      }

      if (dataElements && dataElements.length > 0) {
        const currentSlides = slidesStore.slides
        const enriched = injectDataElements(currentSlides, dataElements, palette.themeColors, aipptSlides as any, palette)
        slidesStore.setSlides(enriched)
      }

      // 将模板中的“演讲人：XXX”等占位符替换为当前登录用户名
      if (speakerName) {
        const withSpeaker = applySpeakerName(slidesStore.slides, speakerName)
        slidesStore.setSlides(withSpeaker)
      }

      // 解锁后一次性推送最终态给 React
      isRunningAIPPT.value = false
      snapshotStore.initSnapshotDatabase()
      emit('update:slides', slidesStore.slides)
    }

    nextTick(finalize)
  },
})
</script>

<style lang="scss" scoped>
.pptist-editor-bridge {
  height: 100%;
  width: 100%;
  position: relative;
  overflow: hidden;
}

.layout-content {
  height: 100%;
  display: flex;
}

.layout-content-left {
  width: 160px;
  height: 100%;
  flex-shrink: 0;
}

.layout-content-center {
  width: calc(100% - 160px - 300px);
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;

  .center-top {
    min-height: 40px;
    height: auto;
    flex: 0 0 auto;
    position: relative;
    z-index: 2;
  }

  .center-body {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    z-index: 1;
  }

  .center-bottom {
    flex: 0 0 auto;
  }
}

.layout-content-right {
  width: 300px;
  min-width: 300px;
  height: 100%;
}
</style>
