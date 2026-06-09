// ============================================================================
// 分享面板 - 公开链接 + 二维码 + 状态信息
// ============================================================================
import React, { useMemo, useState } from 'react'
import { Copy, Check, ExternalLink, QrCode } from 'lucide-react'

export default function SharePanel({ form }) {
  const [copied, setCopied] = useState(false)

  const formUrl = useMemo(() => {
    const origin = window.location.origin
    return `${origin}/form.html?token=${form.share_token}`
  }, [form.share_token])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const input = document.createElement('input')
      input.value = formUrl
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const isActive = form.status === 'active'

  return (
    <div className="share-panel">
      <h4 className="share-panel-title">分享表单</h4>
      <div className="share-status">
        <span className={`share-status-dot ${isActive ? 'active' : 'closed'}`} />
        <span>{isActive ? '正在收集' : '已关闭'}</span>
        <span className="share-status-count">
          {form.submission_count || 0} 条提交
        </span>
      </div>
      <div className="share-link-row">
        <input className="share-link-input" value={formUrl} readOnly />
        <button className="share-link-copy" onClick={handleCopy} title="复制链接">
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <a
          className="share-link-open"
          href={formUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="在新窗口打开"
        >
          <ExternalLink size={16} />
        </a>
      </div>
      <p className="share-hint">将此链接发送给需要填写的人员，支持 PC 和手机端访问</p>
    </div>
  )
}
