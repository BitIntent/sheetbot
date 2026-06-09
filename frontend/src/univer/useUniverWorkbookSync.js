import { useCallback, useRef } from 'react'

/**
 * Univer 真源下 JSON 派生：debounce + flush + workbookRevision（首期仅占位）
 * @param {object} options
 * @param {number} [options.debounceMs]
 */
export function useUniverWorkbookSync(options = {}) {
  const { debounceMs = 500 } = options
  const revisionRef = useRef(0)
  const timerRef = useRef(null)

  const bumpRevision = useCallback(() => {
    revisionRef.current += 1
    return revisionRef.current
  }, [])

  /** @type {(fn: () => void) => void} */
  const scheduleDebounced = useCallback(
    (fn) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        fn()
      }, debounceMs)
    },
    [debounceMs]
  )

  const cancelDebounced = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return {
    getWorkbookRevision: () => revisionRef.current,
    bumpRevision,
    scheduleDebounced,
    cancelDebounced,
  }
}
