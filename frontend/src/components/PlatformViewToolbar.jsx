/**
 * 平台视图内嵌工具栏（与顶栏主菜单分离）
 * 数据报表 / PPT汇报 / 数据收集 / 数据接入 / 批量转Word
 */
import React, { useEffect, useState, useCallback } from 'react'
import { RefreshCw, FileDown, Image, Share2, ChevronLeft, Download } from 'lucide-react'

function ToolbarButton({ onClick, disabled, title, icon: Icon, children, active }) {
  return (
    <button
      type="button"
      className={`platform-toolbar-btn${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {Icon ? <Icon size={14} strokeWidth={2} aria-hidden /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  )
}

function ReportCardToolbar() {
  const [state, setState] = useState({
    canReanalyze: true,
    canExport: false,
    canShare: false,
  })

  useEffect(() => {
    const onState = (e) => {
      const next = e?.detail || {}
      setState((prev) => ({
        ...prev,
        canReanalyze: !!next.canReanalyze,
        canExport: !!next.canExport,
        canShare: !!next.canShare,
      }))
    }
    window.addEventListener('report:view-state', onState)
    return () => window.removeEventListener('report:view-state', onState)
  }, [])

  const emit = useCallback((action) => {
    window.dispatchEvent(new CustomEvent('report:view-action', { detail: { action } }))
  }, [])

  return (
    <div className="platform-view-toolbar" data-variant="reportCard">
      <ToolbarButton
        icon={RefreshCw}
        onClick={() => emit('back_home')}
        disabled={!state.canReanalyze}
        title="跳转到报表首页（报表清单页）"
      >
        报表首页
      </ToolbarButton>
      <ToolbarButton
        icon={FileDown}
        onClick={() => emit('export_pdf')}
        disabled={!state.canExport}
        title="导出 PDF"
      >
        导出PDF
      </ToolbarButton>
      <ToolbarButton
        icon={Image}
        onClick={() => emit('export_png')}
        disabled={!state.canExport}
        title="导出 PNG"
      >
        导出PNG
      </ToolbarButton>
      <ToolbarButton
        icon={Share2}
        onClick={() => emit('share')}
        disabled={!state.canShare}
        title="分享报表"
      >
        分享
      </ToolbarButton>
    </div>
  )
}

function PresentationToolbar() {
  const emit = useCallback((action) => {
    window.dispatchEvent(new CustomEvent('presentationAction', { detail: { action } }))
  }, [])

  return (
    <div className="platform-view-toolbar" data-variant="report">
      <ToolbarButton
        icon={RefreshCw}
        onClick={() => emit('back_home')}
        title="返回汇报首页"
      >
        汇报首页
      </ToolbarButton>
    </div>
  )
}

function CollectToolbar() {
  const emit = useCallback((action) => {
    window.dispatchEvent(new CustomEvent('collect:view-action', { detail: { action } }))
  }, [])

  return (
    <div className="platform-view-toolbar" data-variant="collect">
      <ToolbarButton icon={ChevronLeft} onClick={() => emit('back_list')} title="返回收集列表">
        返回列表
      </ToolbarButton>
      <ToolbarButton icon={Download} onClick={() => emit('export_collect')} title="导出收集结果">
        导出收集
      </ToolbarButton>
    </div>
  )
}

function ConnectToolbar() {
  const emit = useCallback((action) => {
    window.dispatchEvent(new CustomEvent('connect:view-action', { detail: { action } }))
  }, [])

  return (
    <div className="platform-view-toolbar" data-variant="connect">
      <ToolbarButton icon={ChevronLeft} onClick={() => emit('back_list')} title="返回连接清单">
        返回清单
      </ToolbarButton>
    </div>
  )
}

function BatchWordToolbar() {
  const emit = useCallback((action) => {
    window.dispatchEvent(new CustomEvent('batch-word:view-action', { detail: { action } }))
  }, [])

  return (
    <div className="platform-view-toolbar" data-variant="batchWord">
      <ToolbarButton icon={ChevronLeft} onClick={() => emit('back_list')} title="返回批量转Word首页">
        返回清单
      </ToolbarButton>
    </div>
  )
}

const VARIANT_MAP = {
  reportCard: ReportCardToolbar,
  report: PresentationToolbar,
  collect: CollectToolbar,
  connect: ConnectToolbar,
  batchWord: BatchWordToolbar,
}

export default function PlatformViewToolbar({ variant }) {
  const Comp = VARIANT_MAP[variant]
  if (!Comp) return null
  return <Comp />
}

export const PLATFORM_VIEWS_WITH_INLINE_TOOLBAR = new Set([
  'reportCard',
  'report',
  'collect',
  'connect',
  'batchWord',
])
