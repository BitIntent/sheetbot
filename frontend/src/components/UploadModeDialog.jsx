// frontend/src/components/UploadModeDialog.jsx
/**
 * 上传后模式选择对话框
 * 用户选择以哪种模式打开上传的文件
 */
import React from 'react'
import {
  Table2, BarChart3, FileText, LayoutTemplate,
  ClipboardList, Link2, Zap, X
} from 'lucide-react'

const MODES = [
  { id: 'normal',   label: '普通视图',     desc: '在线查看与编辑表格',          icon: Table2 },
  { id: 'analyze',  label: '数据分析',     desc: 'AI 驱动的数据分析',          icon: BarChart3 },
  { id: 'report',   label: 'PPT汇报',      desc: '自动生成数据报告',            icon: FileText },
  { id: 'template', label: '数据报表',     desc: '套用报表模板',                icon: LayoutTemplate },
  { id: 'collect',  label: '数据收集',     desc: '创建数据收集表单',            icon: ClipboardList },
  { id: 'connect',  label: '数据接入',     desc: '连接外部数据源',              icon: Link2 },
  { id: 'skill',    label: '玩数据Skill',  desc: '拖拉拽组装原子操作技能 Beta', icon: Zap },
]

function UploadModeDialog({ fileInfo, onSelect, onClose }) {
  if (!fileInfo) return null

  return (
    <div className="upload-mode-overlay" onClick={onClose}>
      <div className="upload-mode-dialog" onClick={e => e.stopPropagation()}>
        <div className="upload-mode-header">
          <h3>选择操作模式</h3>
          <button className="upload-mode-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="upload-mode-filename">
          文件: <strong>{fileInfo.file_name}</strong>
        </p>
        <div className="upload-mode-grid">
          {MODES.map(mode => {
            const Icon = mode.icon
            return (
              <button
                key={mode.id}
                className="upload-mode-card"
                onClick={() => onSelect(mode.id, fileInfo)}
              >
                <Icon size={28} />
                <span className="upload-mode-card-label">{mode.label}</span>
                <span className="upload-mode-card-desc">{mode.desc}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default React.memo(UploadModeDialog)
