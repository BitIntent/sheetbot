// frontend/src/components/ViewPlaceholder.jsx
/**
 * 平台视图占位组件 - 展示即将推出的功能概念说明
 */
import React from 'react'
import { BarChart3, FileText, FormInput, Link2, Share2 } from 'lucide-react'

const VIEW_CONFIG = {
  report: {
    icon: BarChart3,
    title: 'PPT汇报',
    desc: '将 Excel 提炼图表与 AI 分析结论，生成 PPT 格式',
    features: [
      '智能提取表格中的关键图表',
      'AI 分析结论自动生成汇报内容',
      '一键导出为 PowerPoint 演示文稿'
    ]
  },
  reportCard: {
    icon: FileText,
    title: '数据报表',
    desc: '将 Excel 提炼图表与 AI 分析结论、问题、建议，生成在线报表',
    features: [
      '图表 + AI 分析结论 + 问题诊断 + 改进建议',
      '生成在线可交互报表',
      '导出 PDF 及 PNG 格式'
    ]
  },
  collect: {
    icon: FormInput,
    title: '数据收集',
    desc: '将二维表格瞬间转化为在线表单 (Form)',
    features: [
      '在 Excel 中定义列头（如：姓名、手机号、意向产品）',
      '外部人员填写表单，数据实时回流到表格',
      '无需手动汇总，数据自动追加到 SheetBot 表格行中'
    ]
  },
  connect: {
    icon: Link2,
    title: '数据接入',
    desc: '打通外部系统的 API 连接器',
    features: [
      '配置 Webhook 或 API，定时拉取数据',
      '支持 Shopify、钉钉、企业微信、MySQL 等',
      '不再依赖手动导入导出，数据自动同步'
    ]
  },
  share: {
    icon: Share2,
    title: '我要分享',
    desc: '分享在线电子表格数据内容给第三方',
    features: [
      '生成只读或可编辑的分享链接',
      '控制访问权限与有效期',
      '实时协作与数据同步'
    ]
  }
}

function ViewPlaceholder({ viewKey }) {
  const config = VIEW_CONFIG[viewKey]
  if (!config) return null

  const Icon = config.icon

  return (
    <div className="view-placeholder">
      <div className="view-placeholder-card">
        <div className="view-placeholder-icon">
          <Icon size={48} />
        </div>
        <h2 className="view-placeholder-title">{config.title}</h2>
        <p className="view-placeholder-desc">{config.desc}</p>
        <ul className="view-placeholder-features">
          {config.features.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
        <div className="view-placeholder-badge">即将推出</div>
      </div>
    </div>
  )
}

export default ViewPlaceholder
