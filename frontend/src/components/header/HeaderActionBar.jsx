import React from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Filter, ArrowUpDown, AlignJustify,
  Undo, Redo, Scissors, Copy, Clipboard, Paintbrush,
  Download, Save, BarChart3, Code2,
  Search, FunctionSquare, Square, Sigma,
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
  ChevronLeft, ChevronRight, ChevronDown, RefreshCw, FileDown, Image, Share2,
} from 'lucide-react'
import MemoryPanel from '../MemoryPanel'
import { PLATFORM_VIEWS_WITH_INLINE_TOOLBAR } from '../PlatformViewToolbar'

/** 与 @univerjs/sheets-formula-ui 中「常用函数」下拉项顺序一致 */
const UNIVER_COMMON_FUNCTION_NAMES = ['SUMIF', 'SUM', 'AVERAGE', 'IF', 'COUNT', 'SIN', 'MAX']

function CommonFunctionsMenu({ onInsertFunction, onOpenAllFunctions }) {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef(null)
  const menuRef = React.useRef(null)
  const [fixedStyle, setFixedStyle] = React.useState(null)

  const updatePosition = React.useCallback(() => {
    if (!open || !wrapRef.current) return
    const r = wrapRef.current.getBoundingClientRect()
    setFixedStyle({
      position: 'fixed',
      top: r.bottom + 4,
      left: r.left,
      minWidth: Math.max(r.width, 148),
      zIndex: 2147483000,
    })
  }, [open])

  React.useLayoutEffect(() => {
    if (!open) {
      setFixedStyle(null)
      return undefined
    }
    updatePosition()
    const onDoc = (e) => {
      const t = e.target
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onScrollResize = () => updatePosition()
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScrollResize, true)
    window.addEventListener('resize', onScrollResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScrollResize, true)
      window.removeEventListener('resize', onScrollResize)
    }
  }, [open, updatePosition])

  const menuPortal =
    open && fixedStyle
      ? createPortal(
          <div
            ref={menuRef}
            className="new-dropdown header-common-fn-dropdown header-common-fn-dropdown-portal"
            style={fixedStyle}
            role="menu"
          >
            {UNIVER_COMMON_FUNCTION_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                className="new-dropdown-item"
                onClick={() => {
                  setOpen(false)
                  onInsertFunction?.(name)
                }}
              >
                {name}
              </button>
            ))}
            <div className="header-common-fn-dropdown-divider" aria-hidden />
            <button
              type="button"
              role="menuitem"
              className="new-dropdown-item"
              onClick={() => {
                setOpen(false)
                onOpenAllFunctions?.()
              }}
            >
              全部函数
            </button>
          </div>,
          document.body
        )
      : null

  return (
    <div className="header-common-fn-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`header-action-item${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title="常用函数"
      >
        <Sigma size={13} />
        <ChevronDown size={12} className="header-common-fn-chevron" aria-hidden />
      </button>
      {menuPortal}
    </div>
  )
}

function ZoomControl({ sheetZoom, onSheetZoomChange }) {
  return (
    <div className="header-zoom-control" title="工作表缩放">
      <button
        type="button"
        className="header-zoom-btn"
        onClick={() => onSheetZoomChange?.(sheetZoom - 0.1)}
        aria-label="缩小"
      >
        −
      </button>
      <input
        className="header-zoom-slider"
        type="range"
        min={60}
        max={200}
        step={5}
        value={Math.round(sheetZoom * 100)}
        onChange={(e) => onSheetZoomChange?.(Number(e.target.value) / 100)}
        aria-label="缩放滑块"
      />
      <button
        type="button"
        className="header-zoom-btn"
        onClick={() => onSheetZoomChange?.(sheetZoom + 0.1)}
        aria-label="放大"
      >
        +
      </button>
      <span className="header-zoom-value">{Math.round(sheetZoom * 100)}%</span>
    </div>
  )
}

function AnalyzeActionBar({
  onRefreshAnalyzeStatus,
  onOpenAnalyzeSqlBuilder,
  canAnalyzePrevPage,
  onAnalyzePrevPage,
  canAnalyzeNextPage,
  onAnalyzeNextPage,
  analyzePageLabel,
  onAnalyzeDownload,
  analyzeFileId,
  apiBaseUrl,
  headerAccessToken,
  onSessionCleared,
  largeFileInfo,
}) {
  const loading = !largeFileInfo?.duckdb_ready

  return (
    <>
      <button className="header-action-item" onClick={onRefreshAnalyzeStatus} disabled={loading} title="刷新分析状态">
        <BarChart3 size={13} /><span>刷新状态</span>
      </button>
      <button className="header-action-item" onClick={onOpenAnalyzeSqlBuilder} disabled={loading} title="SQL 查询">
        <Code2 size={13} /><span>SQL</span>
      </button>
      <button
        className={`header-action-item ${!canAnalyzePrevPage ? 'disabled' : ''}`}
        onClick={onAnalyzePrevPage}
        disabled={!canAnalyzePrevPage}
        title="上一页"
      >
        <ChevronLeft size={13} /><span>上一页</span>
      </button>
      <button
        className={`header-action-item ${!canAnalyzeNextPage ? 'disabled' : ''}`}
        onClick={onAnalyzeNextPage}
        disabled={!canAnalyzeNextPage}
        title="下一页"
      >
        <ChevronRight size={13} /><span>下一页</span>
      </button>
      <span className="header-action-item disabled" title="当前分页信息">
        {analyzePageLabel}
      </span>
      <button className="header-action-item" onClick={() => onAnalyzeDownload?.()} disabled={loading} title="下载分析结果">
        <Download size={13} /><span>下载</span>
      </button>
      <span className="header-action-item disabled" title={loading ? '数据加载中...' : '分析模式仅预览，不直接编辑原文件'}>
        {loading ? '数据加载中...' : '仅预览模式'}
      </span>
      {analyzeFileId && (
        <MemoryPanel
          fileId={analyzeFileId}
          apiBaseUrl={apiBaseUrl}
          accessToken={headerAccessToken}
          onCleared={onSessionCleared}
        />
      )}
    </>
  )
}

function ReportCardActionBar({ reportActionState, emitReportAction }) {
  return (
    <>
      <button
        className="header-action-item"
        onClick={() => emitReportAction('back_home')}
        disabled={!reportActionState.canReanalyze}
        title="跳转到报表首页（报表清单页）"
      >
        <RefreshCw size={13} /><span>报表首页</span>
      </button>
      <div className="header-action-separator" />
      <button
        className="header-action-item"
        onClick={() => emitReportAction('export_pdf')}
        disabled={!reportActionState.canExport}
        title="导出 PDF"
      >
        <FileDown size={13} /><span>导出PDF</span>
      </button>
      <button
        className="header-action-item"
        onClick={() => emitReportAction('export_png')}
        disabled={!reportActionState.canExport}
        title="导出 PNG"
      >
        <Image size={13} /><span>导出PNG</span>
      </button>
      <button
        className="header-action-item"
        onClick={() => emitReportAction('share')}
        disabled={!reportActionState.canShare}
        title="分享报表"
      >
        <Share2 size={13} /><span>分享</span>
      </button>
    </>
  )
}

function SortDropdown({
  onSortCurrentAsc,
  onSortExtAsc,
  onSortCurrentDesc,
  onSortExtDesc,
  onSortCustom,
}) {
  const [open, setOpen] = React.useState(false)
  const wrapRef = React.useRef(null)
  const menuRef = React.useRef(null)
  const [fixedStyle, setFixedStyle] = React.useState(null)

  const updatePosition = React.useCallback(() => {
    if (!open || !wrapRef.current) return
    const r = wrapRef.current.getBoundingClientRect()
    setFixedStyle({
      position: 'fixed',
      top: r.bottom + 4,
      left: r.left,
      minWidth: Math.max(r.width, 100),
      zIndex: 2147483000,
    })
  }, [open])

  React.useLayoutEffect(() => {
    if (!open) { setFixedStyle(null); return undefined }
    updatePosition()
    const onDoc = (e) => {
      if (wrapRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onScrollResize = () => updatePosition()
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScrollResize, true)
    window.addEventListener('resize', onScrollResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScrollResize, true)
      window.removeEventListener('resize', onScrollResize)
    }
  }, [open, updatePosition])

  const menuPortal =
    open && fixedStyle
      ? createPortal(
          <div ref={menuRef} className="new-dropdown header-common-fn-dropdown header-common-fn-dropdown-portal" style={fixedStyle} role="menu">
            <button type="button" role="menuitem" className="new-dropdown-item" onClick={() => { setOpen(false); onSortCurrentAsc?.() }}>
              当前区域升序
            </button>
            <button type="button" role="menuitem" className="new-dropdown-item" onClick={() => { setOpen(false); onSortExtAsc?.() }}>
              拓展区域升序
            </button>
            <button type="button" role="menuitem" className="new-dropdown-item" onClick={() => { setOpen(false); onSortCurrentDesc?.() }}>
              当前区域降序
            </button>
            <button type="button" role="menuitem" className="new-dropdown-item" onClick={() => { setOpen(false); onSortExtDesc?.() }}>
              拓展区域降序
            </button>
            <button type="button" role="menuitem" className="new-dropdown-item" onClick={() => { setOpen(false); onSortCustom?.() }}>
              自定义排序
            </button>
          </div>,
          document.body,
        )
      : null

  return (
    <div ref={wrapRef} style={{ display: 'inline-flex' }}>
      <button
        type="button"
        className={`header-action-item${open ? ' active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title="排序"
      >
        <ArrowUpDown size={13} />
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          aria-label="打开排序菜单"
        >
          <ChevronDown size={10} style={{ marginLeft: 1 }} aria-hidden />
        </span>
      </button>
      {menuPortal}
    </div>
  )
}

/** 普通视图 + Univer：Ribbon + 常用函数 + 筛选/排序/公式/下载 */
function NormalUniverEmbedActionBar({
  onFilter,
  onSortCurrentAsc,
  onSortExtAsc,
  onSortCurrentDesc,
  onSortExtDesc,
  onSortCustom,
  onOpenFormulaManager,
  onOpenUniverMoreFunctions,
  onInsertUniverFunction,
  onInsertChart,
  onSave,
  onManualSave,
  canManualSave,
  saveStatus,
}) {
  return (
    <>
      <button
        type="button"
        className={`header-univer-toolbar-icon-btn ${(!canManualSave || saveStatus === 'saving') ? 'disabled' : ''}`}
        onClick={() => onManualSave?.()}
        disabled={!canManualSave || saveStatus === 'saving'}
        title={
          canManualSave
            ? `保存到当前文件${saveStatus === 'saving' ? '（保存中）' : saveStatus === 'saved' ? '（已保存）' : saveStatus === 'error' ? '（上次失败）' : ''}`
            : '请先在左侧选择活动文件'
        }
        aria-label="保存"
      >
        <Save size={16} strokeWidth={2} style={saveStatus === 'saved' ? { color: '#4ade80' } : saveStatus === 'error' ? { color: '#f87171' } : undefined} />
      </button>
      <div className="header-action-separator" />
      <div
        id="sheetbot-univer-ribbon-slot"
        className="header-univer-ribbon-pin-target"
      />
      <div className="header-action-separator" />
      <CommonFunctionsMenu
        onInsertFunction={onInsertUniverFunction}
        onOpenAllFunctions={onOpenUniverMoreFunctions}
      />
      <button className="header-action-item" onClick={onOpenFormulaManager} title="自定义公式管理">
        <FunctionSquare size={13} />
      </button>
      <button className="header-action-item" onClick={onFilter} title="筛选">
        <Filter size={13} />
      </button>
      <SortDropdown
        onSortCurrentAsc={onSortCurrentAsc}
        onSortExtAsc={onSortExtAsc}
        onSortCurrentDesc={onSortCurrentDesc}
        onSortExtDesc={onSortExtDesc}
        onSortCustom={onSortCustom}
      />
      <button
        className="header-action-item"
        onClick={onInsertChart}
        title="插入图表（SheetBot）"
        aria-label="插入图表"
      >
        <BarChart3 size={13} />
      </button>
      <div className="header-action-separator" />
      <button className="header-action-item" onClick={() => onSave?.('xlsx')} title="下载文件">
        <Download size={13} />
      </button>
    </>
  )
}

function DefaultActionBar({
  platformView,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onManualSave,
  canManualSave,
  saveStatus,
  onCut,
  onCopy,
  onPaste,
  canPaste,
  formatBrushActive,
  onFormatBrush,
  onFormatChange,
  onInsertRow,
  onFilter,
  onSort,
  onSetRowHeight,
  onFindReplace,
  onOpenFormulaManager,
  onInsertChart,
  onSheetZoomChange,
  sheetZoom,
  onSave,
}) {
  return (
    <>
      <button className={`header-action-item ${!canUndo ? 'disabled' : ''}`} onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
        <Undo size={13} />
      </button>
      <button className={`header-action-item ${!canRedo ? 'disabled' : ''}`} onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Y)">
        <Redo size={13} />
      </button>
      <div className="header-action-separator" />

      {platformView === 'normal' && (
        <button
          className={`header-action-item ${(!canManualSave || saveStatus === 'saving') ? 'disabled' : ''}`}
          onClick={onManualSave}
          disabled={!canManualSave || saveStatus === 'saving'}
          aria-label="保存"
          title={canManualSave
            ? `保存到当前文件（当前状态：${
              saveStatus === 'saving'
                ? '保存中'
                : saveStatus === 'saved'
                  ? '已保存'
                  : saveStatus === 'error'
                    ? '保存失败'
                    : '未保存'
            }）`
            : '请先在左侧选择活动文件'}
        >
          <Save size={13} />
        </button>
      )}

      <button className="header-action-item" onClick={onCut} title="剪切"><Scissors size={13} /></button>
      <button className="header-action-item" onClick={onCopy} title="复制"><Copy size={13} /></button>
      <button className={`header-action-item ${!canPaste ? 'disabled' : ''}`} onClick={onPaste} disabled={!canPaste} title="粘贴"><Clipboard size={13} /></button>
      <button className={`header-action-item ${formatBrushActive ? 'active' : ''}`} onClick={onFormatBrush} title="格式刷" style={formatBrushActive ? { background: 'var(--accent-primary)', color: 'white' } : {}}>
        <Paintbrush size={13} />
      </button>
      <div className="header-action-separator" />

      <button className="header-action-item" onClick={() => onFormatChange?.('bold')} title="加粗"><Bold size={13} /></button>
      <button className="header-action-item" onClick={() => onFormatChange?.('italic')} title="斜体"><Italic size={13} /></button>
      <button className="header-action-item" onClick={() => onFormatChange?.('underline')} title="下划线"><Underline size={13} /></button>
      <div className="header-action-separator" />

      <button className="header-action-item" onClick={() => onFormatChange?.('align', 'left')} title="左对齐"><AlignLeft size={13} /></button>
      <button className="header-action-item" onClick={() => onFormatChange?.('align', 'center')} title="居中"><AlignCenter size={13} /></button>
      <button className="header-action-item" onClick={() => onFormatChange?.('align', 'right')} title="右对齐"><AlignRight size={13} /></button>
      <div className="header-action-separator" />

      <button
        className="header-action-item"
        onClick={() => onFormatChange?.('border', 'all')}
        title="给选定单元格添加边框"
      >
        <Square size={13} />
      </button>
      <button className="header-action-item" onClick={onInsertRow} title="插入行">
        <Plus size={13} /><span>插入行</span>
      </button>
      <button className="header-action-item" onClick={onFilter} title="筛选">
        <Filter size={13} /><span>筛选</span>
      </button>
      <button className="header-action-item" onClick={() => onSort?.()} title="排序（点击切换升降序）">
        <ArrowUpDown size={13} /><span>排序</span>
      </button>
      <button className="header-action-item" onClick={onSetRowHeight} title="设置选中行的行高">
        <AlignJustify size={13} /><span>行高</span>
      </button>
      <button className="header-action-item" onClick={onFindReplace} title="查找替换">
        <Search size={13} /><span>查找</span>
      </button>
      <button className="header-action-item" onClick={onOpenFormulaManager} title="自定义公式管理">
        <FunctionSquare size={13} /><span>自定义公式</span>
      </button>
      <button className="header-action-item" onClick={onInsertChart} title="在工作表中插入图表" aria-label="插入图表">
        <BarChart3 size={13} />
      </button>

      {platformView === 'normal' && (
        <ZoomControl sheetZoom={sheetZoom} onSheetZoomChange={onSheetZoomChange} />
      )}

      <div className="header-action-separator" />
      <button className="header-action-item" onClick={() => onSave?.('xlsx')} title="下载文件">
        <Download size={13} /><span>下载</span>
      </button>
    </>
  )
}

export default function HeaderActionBar(props) {
  const {
    platformView,
    embedUniverRibbon,
    reportActionState,
    emitReportAction,
    emitPresentationAction,
    emitCollectAction,
    emitConnectAction,
    emitBatchWordAction,
  } = props

  // skill 视图不需要工具栏
  if (platformView === 'skill') return null

  // 平台视图操作按钮已下沉至各 View 内容区顶部
  if (PLATFORM_VIEWS_WITH_INLINE_TOOLBAR.has(platformView)) return null

  return (
    <div
      className={`header-action-bar ${platformView === 'collect' ? 'collect-mode' : ''} ${
        embedUniverRibbon ? 'univer-ribbon-embed' : ''
      }`}
    >
      {platformView === 'analyze' ? (
        <AnalyzeActionBar {...props} />
      ) : platformView === 'reportCard' ? (
        <ReportCardActionBar
          reportActionState={reportActionState}
          emitReportAction={emitReportAction}
        />
      ) : platformView === 'report' ? (
        <button
          className="header-action-item"
          onClick={() => emitPresentationAction('back_home')}
          title="返回汇报首页"
        >
          <RefreshCw size={13} /><span>汇报首页</span>
        </button>
      ) : platformView === 'collect' ? (
        <>
          <button
            className="header-action-item collect-action-item"
            onClick={() => emitCollectAction('back_list')}
            title="返回收集列表"
          >
            <ChevronLeft size={13} /><span>返回列表</span>
          </button>
          <button
            className="header-action-item collect-action-item"
            onClick={() => emitCollectAction('export_collect')}
            title="导出收集结果"
          >
            <Download size={13} /><span>导出收集</span>
          </button>
        </>
      ) : platformView === 'connect' ? (
        <button
          className="header-action-item collect-action-item"
          onClick={() => emitConnectAction?.('back_list')}
          title="返回连接清单"
        >
          <ChevronLeft size={13} /><span>返回清单</span>
        </button>
      ) : platformView === 'batchWord' ? (
        <button
          className="header-action-item collect-action-item"
          onClick={() => emitBatchWordAction?.('back_list')}
          title="返回批量转Word首页"
        >
          <ChevronLeft size={13} /><span>返回清单</span>
        </button>
      ) : embedUniverRibbon ? (
        <NormalUniverEmbedActionBar
          onFilter={props.onFilter}
          onSortCurrentAsc={props.onSortCurrentAsc}
          onSortExtAsc={props.onSortExtAsc}
          onSortCurrentDesc={props.onSortCurrentDesc}
          onSortExtDesc={props.onSortExtDesc}
          onSortCustom={props.onSortCustom}
          onOpenFormulaManager={props.onOpenFormulaManager}
          onOpenUniverMoreFunctions={props.onOpenUniverMoreFunctions}
          onInsertUniverFunction={props.onInsertUniverFunction}
          onInsertChart={props.onInsertChart}
          onSave={props.onSave}
          onManualSave={props.onManualSave}
          canManualSave={props.canManualSave}
          saveStatus={props.saveStatus}
        />
      ) : (
        <DefaultActionBar {...props} />
      )}
    </div>
  )
}