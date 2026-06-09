import React from 'react'
import { BarChart3, ArrowLeftRight, TrendingUp, Trophy, Briefcase, AlertTriangle, Users, Filter } from 'lucide-react'

const ICON_MAP = {
  BarChart3: BarChart3,
  ArrowLeftRight: ArrowLeftRight,
  TrendingUp: TrendingUp,
  Trophy: Trophy,
  Briefcase: Briefcase,
  AlertTriangle: AlertTriangle,
  Users: Users,
  Filter: Filter,
}

export default function TemplateSelector({
  templates,
  selectedKey,
  onSelect,
  loading,
}) {
  if (!templates?.length) return null

  return (
    <div className="report-template-selector">
      <h2 className="report-template-title">选择报表模板</h2>
      <div className="report-template-grid">
        {templates.map((tpl) => {
          const IconComp = ICON_MAP[tpl.icon] || BarChart3
          const isSelected = selectedKey === tpl.key

          return (
            <button
              key={tpl.key}
              className={`report-template-card ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelect(tpl.key)}
              disabled={loading}
            >
              <IconComp size={28} className="report-template-icon" />
              <span className="report-template-name">{tpl.name}</span>
              <span className="report-template-desc">{tpl.description}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
