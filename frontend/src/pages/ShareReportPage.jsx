import React, { useState, useEffect, useRef } from 'react'
import { Loader2, ArrowUp } from 'lucide-react'
import ReportCanvas from '../components/report/ReportCanvas'
import { resolveApiBaseUrl } from '../config/appConfig'

export default function ShareReportPage({ shareToken }) {
  const baseUrl = (() => {
    const resolved = resolveApiBaseUrl()
    if (resolved) return String(resolved).replace(/\/$/, '')
    if (typeof window !== 'undefined' && window.location?.origin) {
      return String(window.location.origin).replace(/\/$/, '')
    }
    return ''
  })()
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const pageRef = useRef(null)

  useEffect(() => {
    if (!shareToken) { setError('无效的分享链接'); setLoading(false); return }

    fetch(`${baseUrl}/api/share/report/${shareToken}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? '报表不存在或已过期' : `加载失败 (${r.status})`)
        return r.json()
      })
      .then((data) => { setReport(data); setLoading(false) })
      .catch((err) => { setError(err.message); setLoading(false) })
  }, [shareToken, baseUrl])

  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const onScroll = () => {
      setShowBackToTop(el.scrollTop > 320)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const handleBackToTop = () => {
    const el = pageRef.current
    if (!el) return
    el.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (loading) {
    return (
      <div className="share-report-page share-report-loading">
        <Loader2 size={36} className="animate-spin" />
        <p>正在加载报表...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="share-report-page share-report-error">
        <h2>无法加载报表</h2>
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div className="share-report-page" ref={pageRef}>
      <div className="share-report-container">
        <ReportCanvas report={report} />
        <div className="share-report-badge">
          由 SheetBot 生成 · 查看次数 {report?.view_count || 0}
        </div>
      </div>
      {showBackToTop && (
        <button className="share-report-backtop" onClick={handleBackToTop} title="返回顶部">
          <ArrowUp size={16} />
        </button>
      )}
    </div>
  )
}
