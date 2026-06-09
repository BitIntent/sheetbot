// frontend/src/components/Sidebar.jsx
/**
 * ============================================================================
 * 左侧导航栏组件 - Airtable 风格（重构版）
 * - 品牌 Logo + 搜索（对接后端）
 * - 标签页（团队/星标）
 * - 操作按钮（+ 新建 下拉 / 上传文件）
 * - 文件夹树形结构 + 工作表文件树
 * - 右键菜单
 * - 底部图标栏
 * ============================================================================
 */
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  Plus, Upload, Hash, FileSpreadsheet, FolderOpen, Folder, FolderPlus,
  Settings, Bell, HelpCircle, User,
  X, PanelLeftClose, PanelLeft, ChevronRight, ChevronDown,
  Star, StarOff, Heart, Trash2, Pencil, Move, File,
  FileText, Image, Presentation, FileCode, Zap, Loader2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { useNotifications } from '../contexts/NotificationContext'
import NotificationPanel from './NotificationPanel'
import SystemConfigPanel from './SystemConfigPanel'
import UserCenterPanel from './UserCenterPanel'
import * as filesApi from '../api/files'

const ANALYZE_META_SHEET = '__SHEETBOT_META__'

function createFileNode(file) {
  return {
    ...file,
    type: 'file',
    name: file.file_name,
  }
}

function buildTree(folders, files) {
  const folderMap = {}
  folders.forEach(f => {
    folderMap[f.id] = { ...f, type: 'folder', children: [] }
  })
  // 嵌套文件夹
  const rootFolders = []
  folders.forEach(f => {
    const node = folderMap[f.id]
    if (f.parent_id && folderMap[f.parent_id]) {
      folderMap[f.parent_id].children.push(node)
    } else {
      rootFolders.push(node)
    }
  })
  // 分配文件到文件夹或根
  const rootFiles = []
  files.forEach(f => {
    const item = createFileNode(f)
    if (f.folder_id && folderMap[f.folder_id]) {
      folderMap[f.folder_id].children.push(item)
    } else {
      rootFiles.push(item)
    }
  })
  return [...rootFolders, ...rootFiles]
}

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 420
const SIDEBAR_WIDTH_STORAGE_KEY = 'sheetbot_sidebar_width'

function clampSidebarWidth(width) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width))
}

// ===== 文件类型图标映射 =====
function getFileIcon(format) {
  switch (format) {
    case 'xlsx': case 'xls': case 'xlsm': case 'csv': return FileSpreadsheet
    case 'pdf': return FileText
    case 'png': case 'jpg': case 'jpeg': case 'gif': return Image
    case 'pptx': case 'ppt': return Presentation
    default: return FileCode
  }
}

// ===== 文件夹树节点 =====
function TreeNode({
  node, depth = 0, activeFileId, expandedFolders,
  onToggleFolder, onFileClick, onContextMenu, collapsed,
  dragOverFolderId, onDragStart, onDragOver, onDragLeave, onDrop,
  onToggleStar, fileSelectionLocked = false,
  pendingFileId = null,
  editingItem, editingName, onEditingNameChange, onRenameSubmit, onRenameCancel,
}) {
  const isEditing = editingItem && editingItem.id === node.id
  if (isEditing) {
    return (
      <div
        key={node.id}
        className={`tree-item ${depth > 0 ? 'tree-child' : ''}`}
        style={{ '--tree-depth': depth }}
      >
        <input
          className="tree-item-rename-input"
          value={editingName}
          onChange={e => onEditingNameChange(e.target.value)}
          onBlur={onRenameSubmit}
          onKeyDown={e => {
            if (e.key === 'Enter') onRenameSubmit()
            if (e.key === 'Escape') onRenameCancel()
          }}
          autoFocus
          onClick={e => e.stopPropagation()}
        />
      </div>
    )
  }
  if (node.type === 'folder') {
    const isExpanded = expandedFolders.has(node.id)
    const isDragOver = dragOverFolderId === node.id
    return (
      <>
        <div
          className={`tree-item tree-folder depth-${Math.min(depth, 4)} ${depth > 0 ? 'tree-child' : ''}${isDragOver ? ' drag-over' : ''}`}
          style={{ '--tree-depth': depth }}
          draggable
          onDragStart={e => onDragStart(e, node)}
          onDragOver={e => onDragOver(e, node.id)}
          onDragLeave={e => onDragLeave(e)}
          onDrop={e => onDrop(e, node.id)}
          onClick={() => onToggleFolder(node.id)}
          onContextMenu={e => onContextMenu(e, node)}
          title={node.name}
        >
          <span className="tree-item-chevron">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="tree-item-icon">
            {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          </span>
          {!collapsed && <span className="tree-item-name">{node.name}</span>}
        </div>
        {isExpanded && node.children?.map(child => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            activeFileId={activeFileId}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onFileClick={onFileClick}
            onContextMenu={onContextMenu}
            collapsed={collapsed}
            dragOverFolderId={dragOverFolderId}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onToggleStar={onToggleStar}
            editingItem={editingItem}
            editingName={editingName}
            onEditingNameChange={onEditingNameChange}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
          />
        ))}
      </>
    )
  }

  const FileIcon = getFileIcon(node.file_format)
  const isPendingFile = pendingFileId === node.id && activeFileId !== node.id
  return (
    <div
      className={`tree-item tree-file depth-${Math.min(depth, 4)} ${depth > 0 ? 'tree-child' : ''} ${activeFileId === node.id ? 'active' : ''} ${isPendingFile ? 'pending' : ''} ${fileSelectionLocked ? 'disabled-file' : ''}`}
      style={{ '--tree-depth': depth }}
      draggable
      onDragStart={e => onDragStart(e, node)}
      onClick={() => {
        if (fileSelectionLocked) return
        onFileClick(node)
      }}
      onContextMenu={e => onContextMenu(e, node)}
      title={node.name}
    >
      <span className="tree-item-icon">
        <FileIcon size={14} />
      </span>
      {!collapsed && (
        <>
          <span className="tree-item-name">{node.name}</span>
          {isPendingFile && (
            <span className="tree-file-pending-spinner" title="正在切换文件...">
              <Loader2 size={12} />
            </span>
          )}
          <button
            className={`tree-favorite-btn ${node.is_starred ? 'active' : ''}`}
            title={node.is_starred ? '取消星标' : '设为星标'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleStar(node)
            }}
          >
            <Heart size={12} />
          </button>
        </>
      )}
    </div>
  )
}

// ===== 右键菜单 =====
function ContextMenu({ x, y, node, onAction, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const items = node.type === 'folder'
    ? [
        { id: 'rename', label: '重命名', icon: Pencil },
        { id: 'new_subfolder', label: '新建子文件夹', icon: FolderPlus },
        { id: 'delete', label: '删除', icon: Trash2 },
      ]
    : [
        { id: 'rename', label: '重命名', icon: Pencil },
        { id: 'star', label: node.is_starred ? '取消星标' : '加星标', icon: node.is_starred ? StarOff : Star },
        { id: 'delete', label: '删除', icon: Trash2 },
      ]

  return (
    <div ref={menuRef} className="tree-context-menu" style={{ top: y, left: x }}>
      {items.map(item => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            className="tree-context-item"
            onClick={() => { onAction(item.id, node); onClose() }}
          >
            <Icon size={14} />
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ===== 新建下拉菜单 =====
function NewDropdown({
  onNewWorkbook,
  onNewSheet,
  onNewFolder,
  onClose,
  disableNewSheet = false,
}) {
  const ref = useRef(null)
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} className="new-dropdown">
      <button className="new-dropdown-item" onClick={() => { onNewWorkbook(); onClose() }}>
        <File size={14} />
        <span>新建空白工作簿</span>
      </button>
      <button
        className="new-dropdown-item"
        disabled={disableNewSheet}
        onClick={() => {
          if (disableNewSheet) return
          onNewSheet()
          onClose()
        }}
      >
        <Hash size={14} />
        <span>新建工作表</span>
      </button>
      <button className="new-dropdown-item" onClick={() => { onNewFolder(); onClose() }}>
        <FolderPlus size={14} />
        <span>新建文件夹</span>
      </button>
    </div>
  )
}


function Sidebar({
  sheets = [],
  activeSheet,
  onSheetSelect,
  onAddSheet,
  onDeleteSheet,
  onRenameSheet,
  onCloseResultSheet,
  largeFileMode,
  largeFileInfo,
  currentFileName,
  onOpen,
  onOpenHelp,
  collapsed,
  onToggleCollapse,
  onFileSelect,
  onFileDeleted,
  selectedFileId = null,
  pendingFileId = null,
  onNotificationNavigateToReport,
  fileSelectionLocked = false,
  onOpenSkillManager,
  platformView = 'normal',
  mobileOpen = false,
  isMobileViewport = false,
}) {
  const { t } = useTranslation()
  const { accessToken } = useAuth()
  const { unreadCount } = useNotifications()
  const [notifPanelOpen, setNotifPanelOpen] = useState(false)
  const [configPanelOpen, setConfigPanelOpen] = useState(false)
  const [userPanelOpen, setUserPanelOpen] = useState(false)

  // ===== 状态 =====
  const [activeTab, setActiveTab] = useState('team')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const searchTimerRef = useRef(null)

  const [folders, setFolders] = useState([])
  const [files, setFiles] = useState([])
  const [expandedFolders, setExpandedFolders] = useState(new Set())
  const [activeFileId, setActiveFileId] = useState(null)

  const [showNewDropdown, setShowNewDropdown] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const [editingItem, setEditingItem] = useState(null)
  const [editingName, setEditingName] = useState('')

  const [dragOverFolderId, setDragOverFolderId] = useState(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)

  const [storageUsage, setStorageUsage] = useState(null)

  const [toast, setToast] = useState(null)
  const uploadInputRef = useRef(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const sidebarRef = useRef(null)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return 240
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (Number.isFinite(stored) && stored > 0) return clampSidebarWidth(stored)
    return 240
  })

  const toastTimerRef = useRef(null)
  const showToast = useCallback((msg, durationMs = 2000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs)
  }, [])

  // ===== 加载文件树 =====
  const loadStorageUsage = useCallback(async () => {
    if (!accessToken) return
    try {
      setStorageUsage(await filesApi.getStorageUsage(accessToken))
    } catch { /* 非关键信息 */ }
  }, [accessToken])

  const loadFileTree = useCallback(async () => {
    if (!accessToken) return
    try {
      const data = await filesApi.getFileTree(accessToken)
      setFolders(data.folders || [])
      setFiles(data.files || [])
    } catch (e) {
      console.warn('加载文件树失败:', e)
    }
    loadStorageUsage()
  }, [accessToken, loadStorageUsage])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  useEffect(() => {
    if (!selectedFileId) return
    setActiveFileId(selectedFileId)
  }, [selectedFileId])

  useEffect(() => {
    if (!selectedFileId) return
    loadFileTree()
  }, [selectedFileId, loadFileTree])

  useEffect(() => {
    if (!isResizingSidebar) return undefined

    const handleMouseMove = (event) => {
      const sidebarEl = sidebarRef.current
      if (!sidebarEl) return
      const left = sidebarEl.getBoundingClientRect().left
      const nextWidth = clampSidebarWidth(event.clientX - left)
      setSidebarWidth(nextWidth)
    }

    const handleMouseUp = () => {
      setIsResizingSidebar(false)
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.classList.add('sidebar-resizing')
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('sidebar-resizing')
    }
  }, [isResizingSidebar, sidebarWidth])

  const handleSidebarResizeStart = useCallback((event) => {
    if (collapsed) return
    event.preventDefault()
    setIsResizingSidebar(true)
  }, [collapsed])

  const disableNewSheetInCurrentView = platformView === 'analyze'

  // 默认展开所有目录（首次加载）
  useEffect(() => {
    if (!folders.length) return
    setExpandedFolders(prev => {
      if (prev.size > 0) return prev
      return new Set(folders.map(folder => folder.id))
    })
  }, [folders])

  // ===== 搜索 (debounce) =====
  const handleSearchChange = useCallback((e) => {
    const q = e.target.value
    setSearchQuery(q)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!q.trim()) {
      setSearchResults(null)
      return
    }
    searchTimerRef.current = setTimeout(async () => {
      if (!accessToken) return
      try {
        const results = await filesApi.searchFiles(accessToken, q.trim())
        setSearchResults(results)
      } catch (e) {
        console.warn('搜索失败:', e)
      }
    }, 300)
  }, [accessToken])

  // ===== 文件树组装 =====
  const tree = useMemo(() => {
    if (searchResults) {
      return searchResults.map(createFileNode)
    }
    if (activeTab === 'starred') {
      return files.filter(f => f.is_starred).map(createFileNode)
    }
    return buildTree(folders, files)
  }, [folders, files, searchResults, activeTab])

  // ===== 文件夹展开/折叠 =====
  const handleToggleFolder = useCallback((folderId) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  // ===== 文件点击 =====
  const handleFileClick = useCallback((fileNode) => {
    if (fileSelectionLocked) {
      showToast('当前文件处理中，请等待加载完成后再切换。')
      return
    }
    onFileSelect?.(fileNode)
  }, [fileSelectionLocked, onFileSelect, showToast])

  const handleToggleStar = useCallback(async (fileNode) => {
    if (!accessToken || fileNode.type !== 'file') return
    try {
      await filesApi.toggleStar(accessToken, fileNode.id)
      await loadFileTree()
    } catch (e) {
      showToast(`星标操作失败: ${e.message}`)
    }
  }, [accessToken, loadFileTree, showToast])

  // ===== 右键菜单 =====
  const handleContextMenu = useCallback((e, node) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  // ===== 右键菜单操作 =====
  const handleContextAction = useCallback(async (actionId, node) => {
    if (!accessToken) return
    try {
      if (actionId === 'rename') {
        setEditingItem(node)
        setEditingName(node.name)
      } else if (actionId === 'star' && node.type === 'file') {
        await filesApi.toggleStar(accessToken, node.id)
        await loadFileTree()
      } else if (actionId === 'delete') {
        if (node.type === 'folder') {
          await filesApi.deleteFolder(accessToken, node.id)
        } else {
          await filesApi.deleteFile(accessToken, node.id)
          onFileDeleted?.(node)
        }
        await loadFileTree()
        showToast('已删除')
      } else if (actionId === 'new_subfolder') {
        const name = '新文件夹'
        await filesApi.createFolder(accessToken, name, node.id)
        setExpandedFolders(prev => new Set([...prev, node.id]))
        await loadFileTree()
      }
    } catch (e) {
      showToast(`操作失败: ${e.message}`)
    }
  }, [accessToken, loadFileTree, showToast, onFileDeleted])

  // ===== 重命名提交 =====
  const handleRenameSubmit = useCallback(async () => {
    if (!editingItem || !editingName.trim() || !accessToken) {
      setEditingItem(null)
      return
    }
    if (editingName === editingItem.name) {
      setEditingItem(null)
      return
    }
    try {
      if (editingItem.type === 'folder') {
        await filesApi.renameFolder(accessToken, editingItem.id, editingName)
      } else {
        await filesApi.renameFile(accessToken, editingItem.id, editingName)
      }
      await loadFileTree()
    } catch (e) {
      showToast(`重命名失败: ${e.message}`)
    }
    setEditingItem(null)
    setEditingName('')
  }, [editingItem, editingName, accessToken, loadFileTree, showToast])

  // ===== 上传文件 =====
  const handleUploadFile = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file || !accessToken) return
    e.target.value = ''

    // 前端拦截：单文件大小超限（零网络开销即时反馈）
    const fileSizeMb = file.size / (1024 * 1024)
    const fileLimitMb = storageUsage?.file_size_limit_mb
    if (fileLimitMb != null && fileLimitMb > 0 && fileSizeMb > fileLimitMb) {
      const plan = storageUsage.plan_name || '当前套餐'
      showToast(
        `您当前为「${plan}」，单文件大小上限为 ${fileLimitMb}MB，当前文件 ${fileSizeMb.toFixed(1)}MB 超出限制。请升级套餐以上传更大文件。`,
        6000,
      )
      return
    }

    // 前端拦截：存储已满时阻止上传
    const totalMb = storageUsage?.total_mb
    if (storageUsage && totalMb != null && totalMb > 0 && storageUsage.used_mb >= totalMb) {
      const plan = storageUsage.plan_name || '当前套餐'
      const usedDisplay = storageUsage.used_mb < 1 ? storageUsage.used_mb.toFixed(2) : Math.round(storageUsage.used_mb)
      showToast(
        `您的「${plan}」云存储空间已满（${usedDisplay}MB / ${totalMb}MB），请删除不需要的文件或升级套餐后再上传。`,
        6000,
      )
      return
    }

    try {
      setIsUploading(true)
      setUploadProgress(0)
      const result = await filesApi.uploadFileWithProgress(accessToken, file, {
        onProgress: ({ percent }) => setUploadProgress(percent)
      })
      await loadFileTree()
      showToast('上传成功')
      onFileSelect?.({ ...result, type: 'file', name: result.file_name })
    } catch (err) {
      showToast(err.message || `上传失败 (HTTP ${err.status || '未知'})`, err.isQuota ? 6000 : 3000)
    } finally {
      setIsUploading(false)
      setUploadProgress(0)
    }
  }, [accessToken, loadFileTree, showToast, onFileSelect, storageUsage])

  // ===== 新建文件夹 =====
  const handleNewFolder = useCallback(async () => {
    if (!accessToken) return
    try {
      await filesApi.createFolder(accessToken, '新文件夹')
      await loadFileTree()
    } catch (e) {
      showToast(`创建失败: ${e.message}`)
    }
  }, [accessToken, loadFileTree, showToast])

  // ===== 新建空白工作簿 =====
  const handleNewWorkbook = useCallback(async () => {
    if (!accessToken) return
    if (fileSelectionLocked || isUploading) {
      showToast('当前文件处理中，请稍后再创建工作簿。')
      return
    }
    const wbTotalMb = storageUsage?.total_mb
    if (storageUsage && wbTotalMb != null && wbTotalMb > 0 && storageUsage.used_mb >= wbTotalMb) {
      const plan = storageUsage.plan_name || '当前套餐'
      showToast(`您的「${plan}」云存储空间已满（${Math.round(storageUsage.used_mb)}MB / ${wbTotalMb}MB），请删除不需要的文件或升级套餐。`, 6000)
      return
    }
    try {
      const ExcelJS = await import('exceljs')
      const excelWb = new ExcelJS.Workbook()
      excelWb.addWorksheet('Sheet1')

      const buffer = await excelWb.xlsx.writeBuffer()
      const isoStamp = new Date().toISOString()
      const stamp = isoStamp
        .replaceAll('-', '')
        .replaceAll(':', '')
        .replaceAll('.', '')
        .replace('T', '')
        .replace('Z', '')
        .slice(0, 14)
      const filename = `新建工作簿_${stamp}.xlsx`
      const workbookBlob = new Blob(
        [buffer],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      )

      const result = await filesApi.uploadFile(accessToken, workbookBlob, null, filename)
      await loadFileTree()
      showToast('已创建空白工作簿')
      onFileSelect?.({ ...result, type: 'file', name: result.file_name })
    } catch (e) {
      showToast(e.message || `创建工作簿失败`, 3000)
    }
  }, [accessToken, fileSelectionLocked, isUploading, loadFileTree, onFileSelect, showToast, storageUsage])

  // ===== 拖拽处理 =====
  const handleDragStart = useCallback((e, node) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type: node.type, id: node.id }))
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e, folderId) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverFolderId(folderId)
    setDragOverRoot(false)
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    setDragOverFolderId(null)
  }, [])

  const handleDrop = useCallback(async (e, targetFolderId) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderId(null)
    setDragOverRoot(false)

    if (!accessToken) return
    try {
      const raw = e.dataTransfer.getData('application/json')
      if (!raw) return
      const { type, id } = JSON.parse(raw)

      if (type === 'folder' && id === targetFolderId) return

      if (type === 'file') {
        await filesApi.moveFile(accessToken, id, targetFolderId)
      } else if (type === 'folder') {
        await filesApi.moveFolder(accessToken, id, targetFolderId)
      }
      await loadFileTree()
      showToast('移动成功')
    } catch (err) {
      showToast(`移动失败: ${err.message}`)
    }
  }, [accessToken, loadFileTree, showToast])

  const handleRootDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverRoot(true)
    setDragOverFolderId(null)
  }, [])

  const handleRootDragLeave = useCallback(() => {
    setDragOverRoot(false)
  }, [])

  const handleRootDrop = useCallback(async (e) => {
    e.preventDefault()
    setDragOverRoot(false)
    setDragOverFolderId(null)

    if (!accessToken) return
    try {
      const raw = e.dataTransfer.getData('application/json')
      if (!raw) return
      const { type, id } = JSON.parse(raw)

      if (type === 'file') {
        await filesApi.moveFile(accessToken, id, null)
      } else if (type === 'folder') {
        await filesApi.moveFolder(accessToken, id, null)
      }
      await loadFileTree()
      showToast('已移动到根目录')
    } catch (err) {
      showToast(`移动失败: ${err.message}`)
    }
  }, [accessToken, loadFileTree, showToast])

  return (
    <>
      <div
        ref={sidebarRef}
        id="sheetbot-left-sidebar"
        className={`sidebar ${collapsed ? 'collapsed' : ''} ${isResizingSidebar ? 'resizing' : ''}${isMobileViewport ? ' mobile' : ''}${mobileOpen ? ' mobile-open' : ''}`}
        style={!collapsed ? { width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` } : undefined}
      >
        {/* ===== 头部：仅 Logo（底部分隔线与主区平台 Tab 行对齐） ===== */}
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">
              <img src="/favicon-128x128.png" alt="SheetBot" />
            </div>
            {!collapsed && <span className="sidebar-brand-text">SheetBot</span>}
          </div>
        </div>

        {/* ===== 搜索（灰线下方，不占顶栏对齐高度） ===== */}
        {!collapsed && (
          <div className="sidebar-toolbar">
            <input
              type="text"
              className="sidebar-search"
              placeholder="搜索文件..."
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
        )}

        {/* ===== 标签页 ===== */}
        {!collapsed && (
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${activeTab === 'team' ? 'active' : ''}`}
              onClick={() => { setActiveTab('team'); setSearchResults(null) }}
            >
              我的
            </button>
            <button
              className={`sidebar-tab ${activeTab === 'starred' ? 'active' : ''}`}
              onClick={() => { setActiveTab('starred'); setSearchResults(null) }}
            >
              星标
            </button>
          </div>
        )}

        {/* ===== 操作按钮 ===== */}
        <div className="sidebar-actions">
          <div className="sidebar-action-group">
            <button
              className="sidebar-action-btn"
              onClick={() => setShowNewDropdown(v => !v)}
              title="新建"
            >
              <Plus size={14} />
              {!collapsed && <span>新建</span>}
              {!collapsed && <ChevronDown size={12} style={{ marginLeft: 2 }} />}
            </button>
            {showNewDropdown && (
              <NewDropdown
                onNewWorkbook={handleNewWorkbook}
                onNewSheet={() => onAddSheet?.()}
                onNewFolder={handleNewFolder}
                disableNewSheet={disableNewSheetInCurrentView}
                onClose={() => setShowNewDropdown(false)}
              />
            )}
          </div>
          <button
            className="sidebar-action-btn"
            onClick={() => {
              if (isUploading) return
              uploadInputRef.current?.click()
            }}
            title={isUploading ? `上传中 ${uploadProgress}%` : '上传'}
            disabled={isUploading}
          >
            <Upload size={14} />
            {!collapsed && (
              <span>{isUploading ? `上传中 ${uploadProgress}%` : '上传'}</span>
            )}
            {isUploading && (
              <div className="sidebar-upload-progress-bar" aria-hidden="true">
                <div
                  className="sidebar-upload-progress-fill"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
          </button>
          <input
            type="file"
            ref={uploadInputRef}
            accept=".xlsx,.xls,.xlsm,.csv"
            style={{ display: 'none' }}
            onChange={handleUploadFile}
          />
        </div>

        {/* ===== 文件/文件夹树 ===== */}
        <div
          className={`sidebar-file-tree${dragOverRoot ? ' drag-over-root' : ''}${fileSelectionLocked ? ' locked' : ''}`}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          {!collapsed && tree.length > 0 && (
            <div className="sidebar-tree-label">文件管理</div>
          )}
          {!collapsed && storageUsage && (
            <div className="sidebar-storage-bar">
              <div className="sidebar-storage-text">
                <span>{storageUsage.used_mb < 1 ? storageUsage.used_mb.toFixed(2) : Math.round(storageUsage.used_mb)} MB</span>
                <span className="sidebar-storage-sep"> / </span>
                <span>{storageUsage.total_mb == null ? '无限' : `${storageUsage.total_mb >= 1024 ? (storageUsage.total_mb / 1024).toFixed(1) + ' GB' : storageUsage.total_mb + ' MB'}`}</span>
              </div>
              {storageUsage.total_mb != null && (
                <div className="sidebar-storage-track">
                  <div
                    className={`sidebar-storage-fill${storageUsage.used_mb / storageUsage.total_mb > 0.9 ? ' danger' : ''}`}
                    style={{ width: `${Math.min(100, (storageUsage.used_mb / storageUsage.total_mb) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {tree.map(node => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              activeFileId={activeFileId}
              expandedFolders={expandedFolders}
              onToggleFolder={handleToggleFolder}
              onFileClick={handleFileClick}
              onContextMenu={handleContextMenu}
              collapsed={collapsed}
              dragOverFolderId={dragOverFolderId}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onToggleStar={handleToggleStar}
              fileSelectionLocked={fileSelectionLocked}
              pendingFileId={pendingFileId}
              editingItem={editingItem}
              editingName={editingName}
              onEditingNameChange={setEditingName}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={() => { setEditingItem(null); setEditingName('') }}
            />
          ))}
          {!collapsed && tree.length === 0 && !searchQuery && (
            <div className="sidebar-empty-hint">
              点击「上传」开始使用
            </div>
          )}
        </div>

        {/* ===== 底部图标 ===== */}
        <div className="sidebar-footer">
          <button
            className="sidebar-footer-icon"
            title="技能库"
            onClick={() => onOpenSkillManager?.()}
          >
            <Zap size={16} />
          </button>
          <button className="sidebar-footer-icon" title={t('sidebar.settings')} onClick={() => setConfigPanelOpen(prev => !prev)}>
            <Settings size={16} />
          </button>
          <button
            className="sidebar-footer-icon"
            title={t('sidebar.notifications')}
            onClick={() => setNotifPanelOpen(prev => !prev)}
            style={{ position: 'relative' }}
          >
            <Bell size={16} />
            {unreadCount > 0 && (
              <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
            )}
          </button>
          <button className="sidebar-footer-icon" title={t('sidebar.help')} onClick={onOpenHelp}>
            <HelpCircle size={16} />
          </button>
          <button className="sidebar-footer-icon active" title={t('sidebar.user')} onClick={() => setUserPanelOpen(prev => !prev)}>
            <User size={16} />
          </button>
        </div>

        {/* ===== 折叠按钮 ===== */}
        <button
          className="sidebar-collapse-btn"
          onClick={onToggleCollapse}
          title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
        {!collapsed && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧文件管理栏宽度"
            onMouseDown={handleSidebarResizeStart}
          />
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 系统配置面板 */}
      <SystemConfigPanel
        open={configPanelOpen}
        onClose={() => setConfigPanelOpen(false)}
      />

      {/* 通知面板 */}
      <NotificationPanel
        open={notifPanelOpen}
        onClose={() => setNotifPanelOpen(false)}
        onNavigate={(payload) => {
          setNotifPanelOpen(false)
          onNotificationNavigateToReport?.(payload)
        }}
      />

      {/* 用户中心面板 */}
      <UserCenterPanel
        open={userPanelOpen}
        onClose={() => setUserPanelOpen(false)}
      />

      {/* Toast */}
      {toast && (
        <div
          className={`placeholder-toast${toast.length > 30 ? ' placeholder-toast-wide' : ''}`}
          onClick={() => setToast(null)}
        >
          {toast}
        </div>
      )}
    </>
  )
}

export default React.memo(Sidebar)
