// ============================================================================
// 连接器配置表单 - 根据类型动态渲染配置字段
// ============================================================================
import React, { useState, useMemo } from 'react'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'

// ── 各类型的配置字段定义 ────────────────────────────────────
const TYPE_FIELDS = {
  shopify: [
    { key: 'shop_domain', label: '店铺域名', placeholder: 'xxx.myshopify.com', required: true },
    { key: 'api_key', label: 'Access Token', placeholder: 'shpat_xxx...', required: true, secret: true },
    { key: 'resource', label: '数据类型', type: 'select', options: [
      { value: 'orders', label: '订单' },
      { value: 'products', label: '产品' },
      { value: 'customers', label: '客户' },
    ]},
  ],
  dingtalk: [
    { key: 'app_key', label: 'AppKey', placeholder: '钉钉应用 AppKey', required: true },
    { key: 'app_secret', label: 'AppSecret', placeholder: '钉钉应用 AppSecret', required: true, secret: true },
    { key: 'data_type', label: '数据类型', type: 'select', options: [
      { value: 'contacts', label: '通讯录' },
      { value: 'attendance', label: '考勤' },
      { value: 'approval', label: '审批' },
    ]},
    { key: 'department_id', label: '部门 ID', placeholder: '1 (根部门)', defaultValue: '1' },
  ],
  wecom: [
    { key: 'corp_id', label: '企业 ID', placeholder: 'CorpID', required: true },
    { key: 'secret', label: '应用 Secret', placeholder: '应用 Secret', required: true, secret: true },
    { key: 'agent_id', label: 'AgentId', placeholder: '应用 AgentId' },
    { key: 'data_type', label: '数据类型', type: 'select', options: [
      { value: 'contacts', label: '通讯录' },
      { value: 'approval', label: '审批' },
    ]},
    { key: 'department_id', label: '部门 ID', placeholder: '1 (根部门)', defaultValue: '1' },
  ],
  database: [
    { key: 'db_type', label: '数据库类型', type: 'select', options: [
      { value: 'mysql', label: 'MySQL' },
      { value: 'postgresql', label: 'PostgreSQL' },
    ]},
    { key: 'host', label: '主机', placeholder: '127.0.0.1', required: true },
    { key: 'port', label: '端口', placeholder: '3306', type: 'number' },
    { key: 'database', label: '数据库名', placeholder: 'mydb', required: true },
    { key: 'username', label: '用户名', placeholder: 'root', required: true },
    { key: 'password', label: '密码', placeholder: '密码', secret: true },
    { key: 'query', label: 'SQL 查询', placeholder: 'SELECT * FROM orders LIMIT 1000', type: 'textarea', required: true },
    { key: 'incremental_column', label: '增量列', placeholder: 'updated_at 或 id（留空=全量）' },
    { key: 'cursor_strategy', label: '游标策略', type: 'select', options: [
      { value: 'time', label: 'time（时间游标）' },
      { value: 'numeric', label: 'numeric（数字游标）' },
    ]},
    { key: 'primary_key', label: '主键字段（可选去重）', placeholder: 'product_id / id' },
    { key: 'deduplicate_by_primary_key', label: '主键去重', type: 'select', options: [
      { value: 'false', label: '关闭' },
      { value: 'true', label: '开启' },
    ]},
    { key: 'batch_size', label: '每次拉取行数', type: 'number', placeholder: '1000' },
  ],
  webhook: [],
  custom_api: [
    { key: 'url', label: '请求 URL', placeholder: 'https://api.example.com/data', required: true },
    { key: 'method', label: '请求方法', type: 'select', options: [
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' },
      { value: 'PUT', label: 'PUT' },
    ]},
    { key: 'auth_type', label: '认证方式', type: 'select', options: [
      { value: '', label: '无认证' },
      { value: 'bearer', label: 'Bearer Token' },
      { value: 'api_key', label: 'API Key' },
    ]},
    { key: 'auth_token', label: 'Token / Key', placeholder: '认证凭证', secret: true, condition: (cfg) => !!cfg.auth_type },
    { key: 'data_path', label: '数据路径', placeholder: 'data.items (JSON 路径)' },
    { key: 'body_template', label: '请求体模板', placeholder: '{"page": 1}', type: 'textarea', condition: (cfg) => cfg.method !== 'GET' },
  ],
}

export default function ConnectorConfigForm({
  connectorType,
  initialConfig,
  connectorName,
  targetWorkbookLabel,
  targetWorkbookReady,
  sheetName,
  syncInterval,
  onNameChange,
  onSheetNameChange,
  onSyncIntervalChange,
  onSave,
  onTest,
  onCancel,
  loading,
  testResult,
}) {
  const [config, setConfig] = useState(() => {
    const cfg = { ...(initialConfig || {}) }
    const fields = TYPE_FIELDS[connectorType] || []
    for (const f of fields) {
      if (f.defaultValue && !cfg[f.key]) cfg[f.key] = f.defaultValue
    }
    if (connectorType === 'database') {
      if (!cfg.cursor_strategy) cfg.cursor_strategy = 'time'
      if (cfg.deduplicate_by_primary_key === undefined) cfg.deduplicate_by_primary_key = false
      if (!cfg.batch_size) cfg.batch_size = 1000
    }
    return cfg
  })

  const fields = useMemo(() => {
    return (TYPE_FIELDS[connectorType] || []).filter(f => !f.condition || f.condition(config))
  }, [connectorType, config])

  const handleChange = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    const authCfg = {}
    if (config.auth_type === 'bearer') {
      authCfg.token = config.auth_token || ''
    } else if (config.auth_type === 'api_key') {
      authCfg.key_name = 'X-API-Key'
      authCfg.key_value = config.auth_token || ''
    }

    const cleanConfig = { ...config }
    delete cleanConfig.auth_token
    if (Object.keys(authCfg).length) {
      cleanConfig.auth_config = authCfg
    }
    if (connectorType === 'database') {
      cleanConfig.deduplicate_by_primary_key = String(cleanConfig.deduplicate_by_primary_key) === 'true'
      cleanConfig.batch_size = parseInt(cleanConfig.batch_size, 10) || 1000
      if (!cleanConfig.incremental_column) {
        delete cleanConfig.cursor_strategy
        delete cleanConfig.last_cursor
      }
    }

    onSave(cleanConfig)
  }

  const isWebhook = connectorType === 'webhook'

  return (
    <div className="connect-config-form">
      {/* 基础信息 */}
      <div className="connect-config-section">
        <label className="connect-config-label">连接器名称</label>
        <input
          className="connect-config-input"
          value={connectorName}
          onChange={e => onNameChange(e.target.value)}
          placeholder="如：Shopify 订单同步"
        />
      </div>

      <div className="connect-config-section">
        <label className="connect-config-label">目标工作簿</label>
        <input
          className="connect-config-input"
          value={targetWorkbookLabel || '未绑定'}
          readOnly
        />
        {!targetWorkbookReady && (
          <span className="connect-config-hint">
            已绑定目标工作簿，但当前未切换到该文件。若需修改字段映射，请先在左侧切换到目标工作簿；若仅调整写入工作表，可直接修改下方“目标工作表”。
          </span>
        )}
      </div>

      <div className="connect-config-section">
        <label className="connect-config-label">目标工作表</label>
        <input
          className="connect-config-input"
          value={sheetName}
          onChange={e => onSheetNameChange(e.target.value)}
          placeholder="数据将写入此工作表（留空则写入第一个）"
        />
      </div>

      <div className="connect-config-section">
        <label className="connect-config-label">同步频率（分钟）</label>
        <input
          className="connect-config-input"
          type="number"
          min={0}
          value={syncInterval}
          onChange={e => onSyncIntervalChange(parseInt(e.target.value) || 0)}
          placeholder="0 = 仅手动同步"
        />
        <span className="connect-config-hint">0 表示仅手动同步，建议最小 5 分钟</span>
      </div>

      {/* Webhook 特殊提示 */}
      {isWebhook && (
        <div className="connect-config-section">
          <div className="connect-webhook-hint">
            Webhook 模式无需额外配置。创建后系统将生成唯一推送地址，外部系统向该地址发送 JSON 数据即可自动同步到表格。
          </div>
        </div>
      )}

      {/* Database 配置指引 */}
      {connectorType === 'database' && (
        <div className="connect-config-section">
          <div className="connect-db-guide">
            <p className="connect-db-guide-title">数据库同步配置指引（先读）</p>
            <ul className="connect-db-guide-list">
              <li><strong>推荐做法</strong>：请在源表（被读取的数据表）中追加一个 <code>updated_at</code> 字段（用于记录每次修改时间），在配置页“增量列”中填写 <code>updated_at</code> 即可。</li>
              <li><strong>可直接执行的 MySQL 语句创建 <code>updated_at</code> 字段</strong>：<code>ALTER TABLE your_table ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;</code></li>
              <li><strong>如果暂时不能改表</strong>：至少要保证源表中有一个唯一字段（如 <code>ID</code>）用于“主键去重”，避免重复写入。配置页填写方式：<code>增量列留空</code>、<code>主键字段=ID</code>、<code>主键去重=开启</code>。</li>
            </ul>
          </div>
        </div>
      )}

      {/* 类型特定字段 */}
      {fields.map(f => (
        <div key={f.key} className="connect-config-section">
          <label className="connect-config-label">
            {f.label}
            {f.required && <span className="connect-required">*</span>}
          </label>
          {f.type === 'select' ? (
            <select
              className="connect-config-select"
              value={config[f.key] || (f.options[0]?.value ?? '')}
              onChange={e => handleChange(f.key, e.target.value)}
            >
              {f.options.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea
              className="connect-config-textarea"
              value={config[f.key] || ''}
              onChange={e => handleChange(f.key, e.target.value)}
              placeholder={f.placeholder || ''}
              rows={3}
            />
          ) : (
            <input
              className="connect-config-input"
              type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'}
              value={config[f.key] || ''}
              onChange={e => handleChange(f.key, e.target.value)}
              placeholder={f.placeholder || ''}
            />
          )}
        </div>
      ))}

      {/* 测试结果 */}
      {testResult && (
        <div className={`connect-test-result ${testResult.success ? 'success' : 'error'}`}>
          {testResult.success
            ? <><CheckCircle size={16} /> <span>{testResult.message}</span></>
            : <><XCircle size={16} /> <span>{testResult.message}</span></>
          }
        </div>
      )}

      {/* 操作按钮 */}
      <div className="connect-config-actions">
        {!isWebhook && (
          <button
            className="collect-btn-ghost"
            onClick={() => onTest(config)}
            disabled={loading}
          >
            {loading ? <Loader2 size={14} className="spin" /> : null}
            测试连接
          </button>
        )}
        <button className="collect-btn-ghost" onClick={onCancel}>取消</button>
        <button
          className="collect-btn-primary"
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? <Loader2 size={14} className="spin" /> : null}
          保存并启用
        </button>
      </div>
    </div>
  )
}
