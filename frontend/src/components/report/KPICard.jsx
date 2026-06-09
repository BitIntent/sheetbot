import React, { useState, useEffect, useRef } from 'react'

function useCountUp(target, duration = 1200) {
  const [current, setCurrent] = useState(0)
  const rafRef = useRef(null)

  useEffect(() => {
    if (target == null || isNaN(target)) { setCurrent(0); return }
    const num = Number(target)
    const start = performance.now()
    const from = 0

    const tick = (now) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setCurrent(from + (num - from) * eased)
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [target, duration])

  return current
}

function formatNumber(val) {
  if (val == null) return '--'
  const n = Number(val)
  if (isNaN(n)) return String(val)
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万'
  if (Number.isInteger(n)) return n.toLocaleString()
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function KPICard({ label, value, unit, index = 0, exportTheme = 'dark' }) {
  const forceStatic = exportTheme === 'light'
  const numericValue = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  const animated = useCountUp(isNaN(numericValue) ? 0 : numericValue)
  const displayValue = isNaN(numericValue)
    ? (value || '--')
    : formatNumber(forceStatic ? numericValue : animated)

  return (
    <div
      className={`report-kpi-card ${forceStatic ? 'report-export-static' : ''}`}
      style={forceStatic ? undefined : { animationDelay: `${index * 100}ms` }}
    >
      <div className="report-kpi-label">{label}</div>
      <div className="report-kpi-value">
        {displayValue}
        {unit && <span className="report-kpi-unit">{unit}</span>}
      </div>
    </div>
  )
}
