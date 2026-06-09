import { nanoid } from 'nanoid'
import type { Slide } from '@pptist/types/slides'

export const CANVAS_W = 1000
export const CANVAS_H = 562.5

export interface ThemePalette {
  themeColors: string[]
  primaryColor: string
  fontColor: string
  accentColor: string
  mutedColor: string
}

export interface ContentRegion {
  left: number
  top: number
  width: number
  height: number
}

export const DEFAULT_PALETTE: ThemePalette = {
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
  primaryColor: '#5b9bd5',
  fontColor: '#333',
  accentColor: '#ed7d31',
  mutedColor: '#888',
}

export const extractThemePalette = (theme: any): ThemePalette => {
  const tc = theme?.themeColors || DEFAULT_PALETTE.themeColors
  const primary = tc[0] || DEFAULT_PALETTE.primaryColor
  const accent = tc[1] || primary
  const fontColor = theme?.fontColor || DEFAULT_PALETTE.fontColor
  const mutedColor = '#888'
  return { themeColors: tc, primaryColor: primary, fontColor, accentColor: accent, mutedColor }
}

export const getElementTextType = (el: any) => el?.textType || el?.text?.type || ''

export const cloneElement = (el: any) => ({ ...el, id: nanoid(10) })

export const replaceElementText = (el: any, text: string) => {
  if (!text) return el
  const content = typeof el.content === 'string' ? el.content : el?.text?.content
  if (!content || typeof content !== 'string') return el

  const parser = new DOMParser()
  const doc = parser.parseFromString(content, 'text/html')
  const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const firstNode = walker.nextNode()
  if (firstNode) {
    firstNode.textContent = text
    let node
    while ((node = walker.nextNode())) {
      node.parentNode?.removeChild(node)
    }
  }
  const next = doc.body.innerHTML
  if (el.type === 'text') return { ...el, content: next }
  if (el.type === 'shape' && el.text) return { ...el, text: { ...el.text, content: next } }
  return el
}

export function normalizeRegion(region: ContentRegion, margin = 24): ContentRegion {
  const next = { ...region }
  next.width = Math.max(260, Math.min(next.width, CANVAS_W - margin * 2))
  next.height = Math.max(120, Math.min(next.height, CANVAS_H - margin * 2))
  next.left = Math.max(margin, Math.min(next.left, CANVAS_W - next.width - margin))
  next.top = Math.max(margin, Math.min(next.top, CANVAS_H - next.height - margin))
  return next
}

export function intersects(a: ContentRegion, b: ContentRegion): boolean {
  return !(
    a.left + a.width < b.left ||
    b.left + b.width < a.left ||
    a.top + a.height < b.top ||
    b.top + b.height < a.top
  )
}

export const removeUnfilledPlaceholders = (elements: any[], filledIds: Set<string>) => {
  const removeIds = new Set<string>()
  const removeGroupIds = new Set<string>()
  for (const el of elements) {
    if (filledIds.has(el.id)) continue
    const tt = getElementTextType(el)
    if (tt === 'item' || tt === 'itemTitle' || tt === 'itemNumber' || tt === 'content') {
      removeIds.add(el.id)
      if (el.groupId) removeGroupIds.add(el.groupId)
    }
  }
  return elements.filter((el: any) => {
    if (removeIds.has(el.id)) return false
    if (el.groupId && removeGroupIds.has(el.groupId)) return false
    return true
  })
}

export const hasBodyTextSlot = (slide: Slide) => {
  return slide.elements.some((el: any) => {
    const tt = getElementTextType(el)
    return tt === 'item' || tt === 'itemTitle' || tt === 'content'
  })
}

export const appendFallbackBodyTextIfNeeded = (slide: Slide, text: string, palette?: ThemePalette): Slide => {
  if (!text || hasBodyTextSlot(slide)) return slide
  const fontColor = palette?.fontColor || '#333'
  const content = `<p><span style="font-size:18px;color:${fontColor}">${text}</span></p>`
  return {
    ...slide,
    elements: [
      ...slide.elements,
      {
        id: nanoid(10),
        type: 'text',
        left: 80,
        top: 170,
        width: 840,
        height: 260,
        rotate: 0,
        content,
        defaultFontName: '',
        defaultColor: fontColor,
      } as any,
    ],
  } as Slide
}
