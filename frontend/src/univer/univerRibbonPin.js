/**
 * 将 Univer Ribbon（TOOLBAR 区 header[data-u-comp="headerbar"]）与顶栏 #sheetbot-univer-ribbon-slot 视口对齐。
 *
 * 禁止 appendChild 到 SheetBot：Ribbon 由 Univer 的 React 根渲染，移出宿主会断开事件委托，表现为「看得到点不动」。
 * fixed + 同步 rect 既保留 DOM 层级，又在视觉上落在第二行左侧占位区。
 */
const DEFAULT_SLOT = '#sheetbot-univer-ribbon-slot'
const RIBBON_Z = 25

function findRibbonToolbarHost(univerHostEl) {
  if (!univerHostEl) return null
  return (
    univerHostEl.querySelector('header[data-u-comp="headerbar"]') ||
    univerHostEl.querySelector('header.univer-w-screen')
  )
}

function clearFixedAlign(el) {
  if (!el?.style) return
  ;['position', 'left', 'top', 'width', 'z-index', 'margin', 'box-sizing', 'max-height'].forEach((k) => {
    el.style.removeProperty(k)
  })
}

/**
 * @param {HTMLElement | null} univerHostEl  .univer-sheet-host
 * @param {object} [options]
 * @param {string} [options.slotSelector]
 * @returns {() => void}
 */
export function attachUniverRibbonPin(univerHostEl, options = {}) {
  const slotSelector = options.slotSelector || DEFAULT_SLOT
  let raf = 0
  /** @type {HTMLElement | null} */
  let lastRibbon = null

  const sync = () => {
    if (!univerHostEl?.isConnected) return
    const slot = document.querySelector(slotSelector)
    const ribbon = findRibbonToolbarHost(univerHostEl)
    lastRibbon = ribbon
    if (!slot || !ribbon) return
    const rect = slot.getBoundingClientRect()
    if (rect.width < 4) return
    Object.assign(ribbon.style, {
      position: 'fixed',
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      zIndex: String(RIBBON_Z),
      boxSizing: 'border-box',
      margin: '0',
    })
  }

  const schedule = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(sync)
  }

  const mo = new MutationObserver(schedule)
  mo.observe(univerHostEl, { childList: true, subtree: true })

  const ro = new ResizeObserver(schedule)
  const mainContent = document.querySelector('.main-content')
  const airtableHeader = document.querySelector('.airtable-header')
  if (mainContent) ro.observe(mainContent)
  if (airtableHeader) ro.observe(airtableHeader)
  const slotEl = document.querySelector(slotSelector)
  if (slotEl) ro.observe(slotEl)

  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)

  const iv = setInterval(schedule, 400)
  schedule()

  return () => {
    clearInterval(iv)
    cancelAnimationFrame(raf)
    mo.disconnect()
    ro.disconnect()
    window.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    const ribbon = lastRibbon || findRibbonToolbarHost(univerHostEl)
    clearFixedAlign(ribbon)
    lastRibbon = null
  }
}
