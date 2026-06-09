import { useEffect, useRef, useState } from 'react'

const MOBILE_VIEWPORT_MAX_WIDTH = 900
const TABLET_VIEWPORT_MAX_WIDTH = 1280
const MOBILE_GESTURE_EDGE_PX = 24
const MOBILE_GESTURE_CLOSE_ZONE_PX = 360
const MOBILE_GESTURE_TRIGGER_PX = 56

/**
 * 统一管理主工作区视口状态，避免 App.jsx 中散落多个断点副作用。
 */
export function useLayoutViewport({
  aiPanelOpen,
  setAiPanelOpen,
  sidebarCollapsed,
  setSidebarCollapsed,
}) {
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH : false
  ))
  const [isTabletViewport, setIsTabletViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= TABLET_VIEWPORT_MAX_WIDTH : false
  ))
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const mobileGestureRef = useRef(null)
  const prevIsMobileViewportRef = useRef(isMobileViewport)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handleViewportResize = () => {
      const width = window.innerWidth
      setIsMobileViewport(width <= MOBILE_VIEWPORT_MAX_WIDTH)
      setIsTabletViewport(width <= TABLET_VIEWPORT_MAX_WIDTH)
    }
    handleViewportResize()
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  useEffect(() => {
    if (!isMobileViewport && mobileSidebarOpen) {
      setMobileSidebarOpen(false)
    }
  }, [isMobileViewport, mobileSidebarOpen])

  useEffect(() => {
    if (isTabletViewport && !isMobileViewport && !sidebarCollapsed) {
      setSidebarCollapsed(true)
    }
  }, [isTabletViewport, isMobileViewport, sidebarCollapsed, setSidebarCollapsed])

  useEffect(() => {
    const enteredMobileViewport = isMobileViewport && !prevIsMobileViewportRef.current
    if (enteredMobileViewport && aiPanelOpen) {
      setAiPanelOpen(false)
    }
    prevIsMobileViewportRef.current = isMobileViewport
  }, [isMobileViewport, aiPanelOpen, setAiPanelOpen])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const body = document.body
    const shouldLock = isMobileViewport && mobileSidebarOpen
    const previousOverflow = body.style.overflow
    const previousTouchAction = body.style.touchAction
    if (shouldLock) {
      body.style.overflow = 'hidden'
      body.style.touchAction = 'none'
    } else {
      body.style.overflow = ''
      body.style.touchAction = ''
    }
    return () => {
      body.style.overflow = previousOverflow
      body.style.touchAction = previousTouchAction
    }
  }, [isMobileViewport, mobileSidebarOpen])

  const handleMobileTouchStart = (event) => {
    if (!isMobileViewport) return
    const touch = event.touches?.[0]
    if (!touch) return
    const startX = touch.clientX
    const startY = touch.clientY
    const canOpenFromEdge = !mobileSidebarOpen && startX <= MOBILE_GESTURE_EDGE_PX
    const canCloseFromDrawer = mobileSidebarOpen && startX <= MOBILE_GESTURE_CLOSE_ZONE_PX
    if (!canOpenFromEdge && !canCloseFromDrawer) {
      mobileGestureRef.current = null
      return
    }
    mobileGestureRef.current = {
      startX,
      startY,
      lastX: startX,
      lastY: startY,
      mode: canOpenFromEdge ? 'open' : 'close',
    }
  }

  const handleMobileTouchMove = (event) => {
    const gesture = mobileGestureRef.current
    if (!gesture) return
    const touch = event.touches?.[0]
    if (!touch) return
    const deltaX = touch.clientX - gesture.startX
    const deltaY = touch.clientY - gesture.startY
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 14) {
      mobileGestureRef.current = null
      return
    }
    gesture.lastX = touch.clientX
    gesture.lastY = touch.clientY
  }

  const handleMobileTouchEnd = (event) => {
    const gesture = mobileGestureRef.current
    mobileGestureRef.current = null
    if (!gesture) return
    const touch = event.changedTouches?.[0]
    const endX = touch?.clientX ?? gesture.lastX
    const endY = touch?.clientY ?? gesture.lastY
    const deltaX = endX - gesture.startX
    const deltaY = endY - gesture.startY
    if (Math.abs(deltaX) < MOBILE_GESTURE_TRIGGER_PX || Math.abs(deltaX) < Math.abs(deltaY)) return
    if (gesture.mode === 'open' && deltaX > 0) {
      setMobileSidebarOpen(true)
    }
    if (gesture.mode === 'close' && deltaX < 0) {
      setMobileSidebarOpen(false)
    }
  }

  return {
    isMobileViewport,
    isTabletViewport,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileGestureHandlers: isMobileViewport
      ? {
        onTouchStart: handleMobileTouchStart,
        onTouchMove: handleMobileTouchMove,
        onTouchEnd: handleMobileTouchEnd,
        onTouchCancel: () => {
          mobileGestureRef.current = null
        },
      }
      : {},
  }
}
