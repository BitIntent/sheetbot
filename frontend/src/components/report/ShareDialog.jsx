import React, { useState, useCallback } from 'react'
import { X, Copy, Check, Link2 } from 'lucide-react'

export default function ShareDialog({ isOpen, onClose, shareToken }) {
  const [copied, setCopied] = useState(false)

  const shareUrl = shareToken
    ? `${window.location.origin}/share/report/${shareToken}`
    : ''

  const handleCopy = useCallback(async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const input = document.createElement('input')
      input.value = shareUrl
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [shareUrl])

  if (!isOpen) return null

  return (
    <div className="report-share-overlay" onClick={onClose}>
      <div className="report-share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="report-share-header">
          <Link2 size={20} />
          <h3>分享报表</h3>
          <button className="report-share-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="report-share-body">
          <p className="report-share-hint">任何人可通过以下链接查看报表，无需登录：</p>
          <div className="report-share-url-row">
            <input
              type="text"
              readOnly
              value={shareUrl}
              className="report-share-url-input"
            />
            <button className="report-share-copy-btn" onClick={handleCopy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
