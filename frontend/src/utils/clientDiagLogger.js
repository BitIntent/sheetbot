/**
 * 客户端诊断日志上报（轻量、低侵入）
 * 用于快速定位前端回跳 landing 的根因。
 */
export function reportClientDiag(event, detail = {}) {
  if (typeof window === 'undefined') return
  try {
    const payload = {
      event: String(event || 'unknown'),
      ts: new Date().toISOString(),
      href: window.location.href,
      ua: navigator.userAgent,
      detail,
    }
    const body = JSON.stringify(payload)

    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/client-log', blob)
      return
    }

    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch (_) {
    // 诊断日志不影响主流程
  }
}
