import React, { useLayoutEffect, useState } from 'react'

/**
 * 左上角补丁层（无内容）：
 * - 不放三角/文字
 * - 仅把交汇处右/下边线统一到 1px，贴合网格线宽
 */
export default function UniverCornerPatch({ univerAPIRef, hostRef, deps = [], viewZoom }) {
  void univerAPIRef
  const [cornerRect, setCornerRect] = useState(null)

  useLayoutEffect(() => {
    const host = hostRef?.current
    if (!host) return undefined

    let rafId = 0
    const readRect = () => {
      const section = host.querySelector?.('[data-range-selector]')
      if (!section) return
      const hr = host.getBoundingClientRect()
      const sr = section.getBoundingClientRect()
      if (!Number.isFinite(hr.left) || !Number.isFinite(sr.left)) return

      const width = Math.max(1, Math.round(sr.left - hr.left))
      const height = Math.max(1, Math.round(sr.top - hr.top))
      const hostBg = window.getComputedStyle(host).backgroundColor
      const next = {
        left: 0,
        top: 0,
        width,
        height,
        bg: hostBg && hostBg !== 'rgba(0, 0, 0, 0)' ? hostBg : '#0b0d12',
      }
      setCornerRect((prev) => {
        if (!prev) return next
        if (
          prev.width === next.width &&
          prev.height === next.height &&
          prev.left === 0 &&
          prev.top === 0 &&
          prev.bg === next.bg
        ) {
          return prev
        }
        return next
      })
    }

    const schedule = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(readRect)
    }

    readRect()
    const ro = new ResizeObserver(schedule)
    ro.observe(host)
    const section = host.querySelector?.('[data-range-selector]')
    if (section) ro.observe(section)

    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', schedule)
      ro.disconnect()
    }
  }, [hostRef, viewZoom, ...deps])

  // 关键：未拿到真实偏移前不渲染，避免初始出现在 (0,0) 再“掉下来”
  if (!cornerRect?.width || !cornerRect?.height) return null

  return (
    <div
      className="sheetbot-univer-corner-patch"
      style={{
        left: cornerRect.left,
        top: cornerRect.top,
        width: cornerRect.width,
        height: cornerRect.height,
        '--sheetbot-corner-bg': cornerRect.bg,
      }}
      aria-hidden="true"
    />
  )
}
