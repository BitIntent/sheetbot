// frontend/src/components/HelpModalV2.jsx
/**
 * ===================================
 * 帮助弹窗组件（嵌入独立文档站点）
 * - 嵌入 docs-site 构建的 /help/ 站点
 * - 统一使用同域路径：/help/toc
 * ===================================
 */
import React from 'react'
import { X, BookOpen, ExternalLink } from 'lucide-react'

export default function HelpModalV2({ isOpen, onClose }) {
  if (!isOpen) return null

  const helpUrl = '/help/toc'

  const openInNewTab = () => {
    window.open(helpUrl, '_blank')
    onClose()
  }

  return (
    <div className="help-modal-overlay" onClick={onClose}>
      <div className="help-modal help-modal-iframe" onClick={e => e.stopPropagation()}>
        <div className="help-modal-header">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center text-white">
              <BookOpen size={18} />
            </div>
            <h2>产品使用手册</h2>
          </div>
          <div className="help-modal-actions">
            <button
              className="help-external-btn"
              onClick={openInNewTab}
              title="在新标签页打开"
            >
              <ExternalLink size={16} />
              <span>新窗口</span>
            </button>
            <button className="help-close-btn" onClick={onClose} title="关闭">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="help-modal-body iframe-container">
          <iframe
            src={helpUrl}
            title="SheetBot 产品使用手册"
            className="help-iframe"
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
          />
        </div>
      </div>
    </div>
  )
}
