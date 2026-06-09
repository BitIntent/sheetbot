// ============================================================================
// 连接器类型选择网格 - 6 种连接器卡片
// ============================================================================
import React from 'react'
import {
  ShoppingCart, MessageSquare, Users,
  Database, Webhook, Globe,
} from 'lucide-react'

const CONNECTOR_TYPES = [
  {
    type: 'shopify',
    name: 'Shopify',
    desc: '同步订单、产品、客户数据',
    icon: ShoppingCart,
    color: '#96BF48',
  },
  {
    type: 'dingtalk',
    name: '钉钉',
    desc: '通讯录、考勤、审批数据',
    icon: MessageSquare,
    color: '#3A8BFF',
  },
  {
    type: 'wecom',
    name: '企业微信',
    desc: '通讯录、消息、审批数据',
    icon: Users,
    color: '#07C160',
  },
  {
    type: 'database',
    name: '数据库',
    desc: 'MySQL / PostgreSQL 查询同步',
    icon: Database,
    color: '#F29111',
  },
  {
    type: 'webhook',
    name: 'Webhook',
    desc: '接收外部系统推送的数据',
    icon: Webhook,
    color: '#A855F7',
  },
  {
    type: 'custom_api',
    name: '自定义 API',
    desc: '配置任意 HTTP API 拉取数据',
    icon: Globe,
    color: '#06B6D4',
  },
]

export default function ConnectorCatalog({ onSelect }) {
  return (
    <div className="connect-catalog">
      {CONNECTOR_TYPES.map(ct => {
        const Icon = ct.icon
        return (
          <button
            key={ct.type}
            className="connect-catalog-card"
            onClick={() => onSelect(ct.type)}
          >
            <div className="connect-catalog-icon" style={{ color: ct.color }}>
              <Icon size={28} />
            </div>
            <div className="connect-catalog-info">
              <span className="connect-catalog-name">{ct.name}</span>
              <span className="connect-catalog-desc">{ct.desc}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

export { CONNECTOR_TYPES }
