import React, { useState, useEffect, useRef } from 'react'
import {
  Bot, BarChart2, Presentation, FileText, FileOutput,
  FormInput, Link2, Table2, LogOut, Zap,
} from 'lucide-react'

/* 分组导航：核心 / 产出类 / 协作类 / 实验 */
const NAV_GROUPS = [
  {
    id: 'core',
    items: [
      { key: 'normal', label: '普通视图', icon: Table2, desc: 'Excel 基本操作、AI 交互与数据透视' },
    ],
  },
  {
    id: 'output',
    items: [
      { key: 'analyze', label: '数据分析', icon: BarChart2, desc: '大文件分析，内存数据库 + AI 联动', tag: '大文件' },
      { key: 'report', label: 'PPT汇报', icon: Presentation, desc: '图表 + AI 结论 → PPT' },
      { key: 'reportCard', label: '数据报表', icon: FileText, desc: '图表 + AI 结论 → 在线报表/PDF/PNG' },
    ],
  },
  {
    id: 'collab',
    items: [
      { key: 'collect', label: '数据收集', icon: FormInput, desc: '表格 → 在线表单，数据实时回流' },
      { key: 'connect', label: '数据接入', icon: Link2, desc: 'API/Webhook 连接外部系统' },
      { key: 'batchWord', label: '批量转Word', icon: FileOutput, desc: 'Excel 数据 + Word 模板 → 批量文档' },
    ],
  },
]

export default function HeaderTopRow({
  tabsContainerRef,
  activeTabRefs,
  activeViewKey,
  onViewClick,
  onToggleAI,
  aiPanelOpen,
  onLogout,
  largeFileInfo,
  isLargeFileUploading,
}) {
  const isLoading = isLargeFileUploading || (largeFileInfo && !largeFileInfo.duckdb_ready)
  const isCompleted = largeFileInfo?.duckdb_ready === true
  const progress = largeFileInfo?.duckdb_load_progress ?? (isCompleted ? 100 : 0)

  const [completedVisible, setCompletedVisible] = useState(false)
  const hideTimerRef = useRef(null)

  useEffect(() => {
    if (isLoading) {
      setCompletedVisible(false)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    } else if (isCompleted) {
      setCompletedVisible(true)
      hideTimerRef.current = setTimeout(() => setCompletedVisible(false), 3000)
    }
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }
  }, [isLoading, isCompleted])

  const showProgress = isLoading || completedVisible
  const stageText = isLoading
    ? (largeFileInfo?.duckdb_load_stage || '正在准备...')
    : completedVisible
      ? (largeFileInfo?.duckdb_load_stage || '已完成')
      : ''

  return (
    <div className={`header-row-unified ${isLoading ? 'loading' : ''} ${completedVisible && !isLoading ? 'load-completed' : ''}`}>
      <div ref={tabsContainerRef} className="header-platform-nav" style={{ marginBottom: 0 }}>
        <div className="header-nav-groups">
          {NAV_GROUPS.map((group) => (
            <React.Fragment key={group.id}>
              <div className="header-nav-group" data-group={group.id}>
                {group.label && (
                  <span className="header-nav-group-label">{group.label}</span>
                )}
                <div className="header-nav-group-items">
                  {group.items.map(({ key, label, icon: Icon, desc, tag }) => (
                    <button
                      key={key}
                      ref={el => { if (el) activeTabRefs.current[key] = el }}
                      type="button"
                      className={`header-view-tab ${activeViewKey === key ? 'active' : ''}`}
                      onClick={() => onViewClick(key)}
                      title={desc}
                      aria-current={activeViewKey === key ? 'page' : undefined}
                    >
                      <Icon size={15} strokeWidth={2} className="header-view-tab-icon" />
                      <span className="header-view-tab-text">{label}</span>
                      {tag && (
                        <span className="header-view-tab-tag">{tag}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </React.Fragment>
          ))}

          <button
            ref={el => { if (el) activeTabRefs.current['skill'] = el }}
            type="button"
            className={`header-skill-tab ${activeViewKey === 'skill' ? 'active' : ''}`}
            onClick={() => onViewClick('skill')}
            title="通过拖拉拽组装 70+ 操作原子，在浏览器内沙箱执行"
          >
            <Zap size={14} strokeWidth={2} className="header-skill-tab-icon" />
            <span className="header-skill-tab-label">玩数据 Skill</span>
            <span className="header-skill-tab-badge">Beta</span>
          </button>
        </div>
      </div>

      <div className="header-tools">
        {stageText && showProgress && (
          <span className={`header-progress-stage ${completedVisible && !isLoading ? 'completed' : ''}`}>
            {stageText}
          </span>
        )}
        <button
          type="button"
          className={`header-tool-btn header-tool-btn-ai ${aiPanelOpen ? 'active' : ''}`}
          onClick={onToggleAI}
          title="AI 助手"
        >
          <Bot size={15} strokeWidth={2} />
          <span>AI 助手</span>
        </button>
        <button
          type="button"
          className="header-tool-btn header-tool-btn-ghost"
          onClick={onLogout}
          title="退出"
        >
          <LogOut size={15} strokeWidth={2} />
          <span>退出</span>
        </button>
      </div>

      {showProgress && (
        <div
          className={`header-progress-fill ${completedVisible && !isLoading ? 'completed' : ''}`}
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      )}
    </div>
  )
}
