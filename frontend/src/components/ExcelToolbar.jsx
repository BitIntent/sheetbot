// frontend/src/components/ExcelToolbar.jsx
/**
 * ===================================
 * Excel 工具栏组件
 * - 文件操作 | 编辑 | 字体 | 对齐 | 数据 | 视图 | AI
 * ===================================
 */
import React, { useState, useRef } from 'react'
import {
  // 文件操作
  FolderOpen, Download, FileSpreadsheet,
  // 编辑操作
  Undo, Redo, Copy, Clipboard, Scissors, Paintbrush,
  // 字体格式
  Bold, Italic, Underline, Type, Droplet,
  // 对齐
  AlignLeft, AlignCenter, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  WrapText, Combine,
  // 边框
  Square,
  // 数据操作
  ArrowUpAZ, ArrowDownZA, Filter, Search,
  // 插入
  BarChart3,
  // AI & 状态
  Bot, Wifi, WifiOff,
  // 报表
  FileText,
  // 大文件
  HardDrive, X,
  // 帮助
  BookOpen
} from 'lucide-react'

function ExcelToolbar({
  workbook,
  selection,
  isConnected,
  onToggleAI,
  aiPanelOpen,
  onSave,
  onOpen,
  onFormatChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onCopy,
  onPaste,
  onCut,
  canPaste,
  // 新增：格式刷
  formatBrushActive,
  onFormatBrush,
  // 新增：排序
  onSort,
  // 新增：大文件处理
  largeFileMode,
  largeFileInfo,
  onLargeFileUpload,
  onExitLargeFileMode,
  onDownloadLargeFile,
  // 新增：已上传文件列表
  uploadedLargeFiles = [],
  onSelectLargeFile,
  // 新增：结果文件相关
  resultFiles = [],
  onDownloadResultFile,
  onPreviewResultFile,
  onRefreshResultFiles,
  // 新增：上传进度
  isUploading = false,
  uploadProgress = 0,
  // 新增：帮助手册
  onOpenHelp,
  // 新增：报表生成
  onGenerateReport
}) {
  const [fontSize, setFontSize] = useState(13)
  const [fontColor, setFontColor] = useState('#000000')
  const [bgColor, setBgColor] = useState('#ffffff')
  const [showFileSelector, setShowFileSelector] = useState(false)
  const [showResultFiles, setShowResultFiles] = useState(false)
  const largeFileInputRef = useRef(null)
  const fileSelectorRef = useRef(null)
  const resultFilesRef = useRef(null)

  // 点击外部关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event) => {
      if (fileSelectorRef.current && !fileSelectorRef.current.contains(event.target)) {
        setShowFileSelector(false)
      }
      if (resultFilesRef.current && !resultFilesRef.current.contains(event.target)) {
        setShowResultFiles(false)
      }
    }
    if (showFileSelector || showResultFiles) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showFileSelector, showResultFiles])

  const handleFormat = (formatType, value) => {
    if (onFormatChange) {
      onFormatChange(formatType, value)
    }
  }

  return (
    <div className="toolbar" data-tour="toolbar">
      {/* ===== Logo ===== */}
      <div className="toolbar-logo">
        <img 
          src="/images/logo.png" 
          alt="Excel AI Assistant Logo" 
          className="logo-image"
        />
      </div>
      
      <div className="toolbar-divider" />

      {/* ===== 文件操作组 ===== */}
      <button className="toolbar-btn" onClick={onOpen} title="打开文件">
        <FolderOpen size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => onSave('xlsx')} title="下载文件">
        <Download size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* ===== 大文件处理 ===== */}
      <input
        type="file"
        ref={largeFileInputRef}
        accept=".xlsx,.xls,.xlsm"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.[0] && onLargeFileUpload) {
            onLargeFileUpload(e.target.files[0])
          }
          e.target.value = ''
        }}
      />
      {/* 上传进度条 */}
      {isUploading && (
        <div className="upload-progress-container" title={`上传进度: ${uploadProgress}%`}>
          <div className="upload-progress-bar">
            <div 
              className="upload-progress-fill" 
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <span className="upload-progress-text">{uploadProgress}%</span>
        </div>
      )}
      
      {largeFileMode ? (
        <>
          {/* 文件选择器下拉框 */}
          <div className="large-file-selector-container" ref={fileSelectorRef} data-tour="file-selector">
            <button
              className="toolbar-btn large-file-active"
              onClick={() => setShowFileSelector(!showFileSelector)}
              title={`当前文件: ${largeFileInfo?.original_name || ''}\n点击切换文件`}
            >
              <HardDrive size={18} />
              <span className="large-file-label">
                {largeFileInfo?.original_name?.length > 15 
                  ? largeFileInfo.original_name.slice(0, 15) + '...' 
                  : largeFileInfo?.original_name || '数据分析'}
              </span>
            </button>
            
            {/* 文件选择下拉菜单 */}
            {showFileSelector && (
              <div className="large-file-dropdown">
                <div className="large-file-dropdown-header">
                  请选择您要操作的文件：
                </div>
                <div className="large-file-dropdown-list">
                  {uploadedLargeFiles.length === 0 ? (
                    <div className="large-file-dropdown-empty">
                      暂无已上传文件
                    </div>
                  ) : (
                    uploadedLargeFiles.map((file) => (
                      <div
                        key={file.file_id}
                        className={`large-file-dropdown-item ${file.file_id === largeFileInfo?.file_id ? 'active' : ''}`}
                        onClick={() => {
                          onSelectLargeFile?.(file.file_id)
                          setShowFileSelector(false)
                        }}
                      >
                        <div className="large-file-item-name">
                          <FileSpreadsheet size={16} />
                          <span>{file.original_name}</span>
                        </div>
                        <div className="large-file-item-info">
                          <span>{(file.file_size / 1024 / 1024).toFixed(1)} MB</span>
                          <span>{file.row_count?.toLocaleString()} 行</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="large-file-dropdown-footer">
                  <button
                    className="large-file-upload-btn"
                    onClick={() => {
                      largeFileInputRef.current?.click()
                      setShowFileSelector(false)
                    }}
                  >
                    + 上传新文件
                  </button>
                </div>
              </div>
            )}
          </div>
          
          {/* 结果文件下拉框 */}
          <div className="result-files-container" ref={resultFilesRef} data-tour="result-files">
            <button
              className={`toolbar-btn ${resultFiles.length > 0 ? 'has-results' : ''}`}
              onClick={() => {
                if (resultFiles.length > 0) {
                  setShowResultFiles(!showResultFiles)
                } else {
                  onRefreshResultFiles?.()
                }
              }}
              title={resultFiles.length > 0 ? `${resultFiles.length} 个结果文件` : '暂无结果文件'}
            >
              <FileSpreadsheet size={18} />
              {resultFiles.length > 0 && (
                <span className="result-files-badge">{resultFiles.length}</span>
              )}
            </button>
            
            {showResultFiles && resultFiles.length > 0 && (
              <div className="result-files-dropdown">
                <div className="result-files-header">
                  分析结果文件（点击预览，下载按钮保存）
                </div>
                <div className="result-files-list">
                  {resultFiles.map((file) => (
                    <div
                      key={file.file_id}
                      className="result-file-item"
                    >
                      <div 
                        className="result-file-info"
                        onClick={() => {
                          onPreviewResultFile?.(file.file_id)
                          setShowResultFiles(false)
                        }}
                        title="点击预览此结果"
                      >
                        <FileSpreadsheet size={14} className="result-file-icon" />
                        <span className="result-file-name">
                          {file.filename?.length > 25 
                            ? file.filename.slice(0, 25) + '...' 
                            : file.filename}
                        </span>
                        <span className="result-file-rows">
                          {file.row_count?.toLocaleString()} 行
                        </span>
                      </div>
                      <button
                        className="result-file-download"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDownloadResultFile?.(file.file_id, file.filename)
                        }}
                        title="下载此结果文件"
                      >
                        <Download size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          
          {/* 生成报表按钮 */}
          {largeFileInfo?.duckdb_ready && (
            <button
              className="toolbar-btn"
              onClick={onGenerateReport}
              title="生成报表"
            >
              <FileText size={18} />
              <span className="large-file-label">生成报表</span>
            </button>
          )}
          
          <button
            className="toolbar-btn"
            onClick={onExitLargeFileMode}
            title="退出大文件模式"
          >
            <X size={18} />
          </button>
        </>
      ) : (
        <button
          className="toolbar-btn"
          onClick={() => largeFileInputRef.current?.click()}
          title="数据分析 - 大文件分析（>50MB），内存数据库 + AI 联动"
        >
          <FileSpreadsheet size={18} />
          <span className="large-file-label">数据分析</span>
        </button>
      )}

      <div className="toolbar-divider" />

      {/* ===== 编辑操作组 ===== */}
      <button 
        className={`toolbar-btn ${!canUndo ? 'disabled' : ''}`}
        title="撤销 (Ctrl+Z)"
        onClick={onUndo}
        disabled={!canUndo}
      >
        <Undo size={18} />
      </button>
      <button 
        className={`toolbar-btn ${!canRedo ? 'disabled' : ''}`}
        title="重做 (Ctrl+Y)"
        onClick={onRedo}
        disabled={!canRedo}
      >
        <Redo size={18} />
      </button>

      <div className="toolbar-divider" />

      <button className="toolbar-btn" title="剪切 (Ctrl+X)" onClick={onCut}>
        <Scissors size={18} />
      </button>
      <button className="toolbar-btn" title="复制 (Ctrl+C)" onClick={onCopy}>
        <Copy size={18} />
      </button>
      <button 
        className={`toolbar-btn ${!canPaste ? 'disabled' : ''}`}
        title="粘贴 (Ctrl+V)"
        onClick={onPaste}
        disabled={!canPaste}
      >
        <Clipboard size={18} />
      </button>
      <button 
        className={`toolbar-btn ${formatBrushActive ? 'active' : ''}`}
        title="格式刷"
        onClick={onFormatBrush}
      >
        <Paintbrush size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* ===== 字体格式组 ===== */}
      <div className="toolbar-group">
        <select
          className="toolbar-select"
          value={fontSize}
          onChange={(e) => {
            setFontSize(Number(e.target.value))
            handleFormat('fontSize', Number(e.target.value))
          }}
          title="字体大小"
        >
          {[8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(size => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </div>

      <button className="toolbar-btn" onClick={() => handleFormat('bold', true)} title="粗体 (Ctrl+B)">
        <Bold size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('italic', true)} title="斜体 (Ctrl+I)">
        <Italic size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('underline', true)} title="下划线 (Ctrl+U)">
        <Underline size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* 字体颜色 */}
      <div className="toolbar-group color-picker">
        <input
          type="color"
          value={fontColor}
          onChange={(e) => {
            setFontColor(e.target.value)
            handleFormat('fontColor', e.target.value)
          }}
          className="toolbar-color-input"
          title="字体颜色"
        />
        <Type size={18} className="toolbar-icon" />
      </div>

      {/* 背景颜色 */}
      <div className="toolbar-group color-picker">
        <input
          type="color"
          value={bgColor}
          onChange={(e) => {
            setBgColor(e.target.value)
            handleFormat('backgroundColor', e.target.value)
          }}
          className="toolbar-color-input"
          title="背景颜色"
        />
        <Droplet size={18} className="toolbar-icon" />
      </div>

      <div className="toolbar-divider" />

      {/* ===== 对齐组 ===== */}
      {/* 水平对齐 */}
      <button className="toolbar-btn" onClick={() => handleFormat('align', 'left')} title="左对齐">
        <AlignLeft size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('align', 'center')} title="水平居中">
        <AlignCenter size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('align', 'right')} title="右对齐">
        <AlignRight size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* 垂直对齐 */}
      <button className="toolbar-btn" onClick={() => handleFormat('verticalAlign', 'top')} title="顶部对齐">
        <AlignVerticalJustifyStart size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('verticalAlign', 'middle')} title="垂直居中">
        <AlignVerticalJustifyCenter size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('verticalAlign', 'bottom')} title="底部对齐">
        <AlignVerticalJustifyEnd size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* 自动换行 & 合并单元格 */}
      <button className="toolbar-btn" onClick={() => handleFormat('wrapText', true)} title="自动换行">
        <WrapText size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('merge', true)} title="合并单元格">
        <Combine size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* ===== 边框 ===== */}
      <button className="toolbar-btn" onClick={() => handleFormat('border', 'all')} title="设置边框">
        <Square size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* ===== 数据操作组 ===== */}
      <button className="toolbar-btn" onClick={() => onSort?.('asc')} title="升序排序 (A→Z)">
        <ArrowUpAZ size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => onSort?.('desc')} title="降序排序 (Z→A)">
        <ArrowDownZA size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('filter', true)} title="筛选">
        <Filter size={18} />
      </button>
      <button className="toolbar-btn" onClick={() => handleFormat('find', true)} title="查找替换">
        <Search size={18} />
      </button>

      <div className="toolbar-divider" />

      {/* ===== 插入组 ===== */}
      <button className="toolbar-btn" onClick={() => handleFormat('chart', 'bar')} title="插入图表">
        <BarChart3 size={18} />
      </button>
      <button
        className="toolbar-btn"
        onClick={onOpenHelp}
        title="使用手册"
      >
        <BookOpen size={18} />
      </button>

      {/* ===== 右侧：AI助手 + 连接状态 ===== */}
      <div className="toolbar-right">
        <button
          className={`toolbar-btn ai-toggle ${aiPanelOpen ? 'active' : ''}`}
          onClick={onToggleAI}
          title={aiPanelOpen ? '关闭 AI 助手' : '打开 AI 助手'}
        >
          <Bot size={18} />
          <span>AI 助手</span>
        </button>

        <div className="toolbar-divider" />

        <div className="connection-status">
          {isConnected ? (
            <>
              <Wifi size={16} className="text-green-600" />
              <span>已连接</span>
            </>
          ) : (
            <>
              <WifiOff size={16} className="text-red-600" />
              <span>未连接</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExcelToolbar
