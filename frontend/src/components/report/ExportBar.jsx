import React from 'react'
import { Download, Share2, Loader2 } from 'lucide-react'

export default function ExportBar({
  onExportPDF,
  onExportPNG,
  onShare,
  exportingPDF,
  exportingPNG,
  sharingLoading,
  disabled,
}) {
  return (
    <div className="report-export-bar">
      <button
        className="report-export-btn report-export-pdf"
        onClick={onExportPDF}
        disabled={disabled || exportingPDF}
      >
        {exportingPDF ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        {exportingPDF ? '导出中...' : '导出 PDF'}
      </button>
      <button
        className="report-export-btn report-export-png"
        onClick={onExportPNG}
        disabled={disabled || exportingPNG}
      >
        {exportingPNG ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        {exportingPNG ? '导出中...' : '导出 PNG'}
      </button>
      <button
        className="report-export-btn report-export-share"
        onClick={onShare}
        disabled={disabled || sharingLoading}
      >
        {sharingLoading ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
        {sharingLoading ? '创建中...' : '分享'}
      </button>
    </div>
  )
}
