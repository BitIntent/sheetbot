// ============================================================================
// 我要连接 - 主视图（状态机）
// 阶段: home -> configuring -> active
// ============================================================================
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { detectSheetHeaderRow } from '../../utils/excelOperations'
import { Loader2 } from 'lucide-react'
import ConnectorCatalog from './ConnectorCatalog'
import ConnectorConfigForm from './ConnectorConfigForm'
import ConnectorDetail from './ConnectorDetail'
import ConnectorHistory from './ConnectorHistory'
import FieldMappingPanel from './FieldMappingPanel'
import '../../styles/connect.css'
import PlatformViewToolbar from '../PlatformViewToolbar'
import { useAuthedFetch } from '../../hooks/useAuthedFetch'
import { resolveApiBaseUrl } from '../../config/appConfig'

function getApiBase() {
  const resolved = resolveApiBaseUrl()
  if (resolved) return String(resolved).replace(/\/$/, '')
  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/$/, '')
  }
  return ''
}

export default function ConnectView({
  workbook, activeSheet, fileId, currentFileName,
  onQuickStart, onAiHint, pushSystemMessage,
}) {
  const authedFetch = useAuthedFetch()
  const [stage, setStage] = useState('home')
  const [loading, setLoading] = useState(false)

  // 配置阶段
  const [selectedType, setSelectedType] = useState('')
  const [connectorName, setConnectorName] = useState('')
  const [sheetName, setSheetName] = useState('')
  const [targetFileId, setTargetFileId] = useState(fileId || null)
  const [syncInterval, setSyncInterval] = useState(0)
  const [fieldMapping, setFieldMapping] = useState({})
  const [editingConnector, setEditingConnector] = useState(null)
  const [testResult, setTestResult] = useState(null)

  // 活跃阶段
  const [activeConnector, setActiveConnector] = useState(null)

  // 历史列表
  const [connectors, setConnectors] = useState([])
  const [connectorsLoading, setConnectorsLoading] = useState(false)

  // ── 工作表列名（字段映射候选） ──────────────────────────
  const columns = useMemo(() => {
    // 仅使用“目标工作簿”的列头，避免误用当前临时选中文件
    if (targetFileId && fileId !== targetFileId) return []
    if (!workbook?.sheets?.length) return []
    const sheet = workbook.sheets.find(s => s.name === activeSheet) || workbook.sheets[0]
    if (!sheet?.data) return []
    const hRow = detectSheetHeaderRow(sheet.data)
    const headerRowData = sheet.data[String(hRow)] || sheet.data[hRow]
    if (!headerRowData) return []
    const cols = []
    const maxCol = Math.min(sheet.colCount || 26, 50)
    for (let c = 1; c <= maxCol; c++) {
      const cell = headerRowData[String(c)] || headerRowData[c]
      if (cell?.value) cols.push(String(cell.value).trim())
    }
    return cols
  }, [workbook, activeSheet, targetFileId, fileId])

  useEffect(() => {
    if (stage !== 'configuring') return
    if (!fileId) return
    // 配置阶段允许用户通过左侧切换目标工作簿
    setTargetFileId(fileId)
  }, [fileId, stage])

  // ── 加载连接器列表 ────────────────────────────────────
  const loadConnectors = useCallback(async () => {
    setConnectorsLoading(true)
    try {
      const res = await authedFetch(`${getApiBase()}/api/connect/connectors`)
      if (res.ok) {
        const data = await res.json()
        setConnectors(data.items || [])
      }
    } catch (e) {
      console.warn('[ConnectView] 加载连接器列表失败', e)
    } finally {
      setConnectorsLoading(false)
    }
  }, [authedFetch])

  useEffect(() => { loadConnectors() }, [loadConnectors])

  // ── 选择连接器类型 -> 进入配置 ────────────────────────
  const handleSelectType = (type) => {
    setSelectedType(type)
    setConnectorName('')
    setTargetFileId(fileId || null)
    setSheetName(activeSheet || '')
    setSyncInterval(0)
    setFieldMapping({})
    setEditingConnector(null)
    setTestResult(null)
    setStage('configuring')
  }

  // ── 测试连接 ──────────────────────────────────────────
  const handleTestConnection = async (config) => {
    setLoading(true)
    setTestResult(null)
    try {
      const res = await authedFetch(`${getApiBase()}/api/connect/connectors/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, config }),
      })
      const data = await res.json()
      setTestResult(data)
      const normalizedFields = (data.available_fields || []).filter(
        f => typeof f === 'string' && f.trim() && !f.trim().startsWith('(')
      )
      if (normalizedFields.length && !Object.keys(fieldMapping).length) {
        const autoMapping = {}
        for (const f of normalizedFields) {
          autoMapping[f] = f
        }
        setFieldMapping(autoMapping)
      }
    } catch (e) {
      setTestResult({ success: false, message: e.message })
    } finally {
      setLoading(false)
    }
  }

  // ── 保存连接器 ────────────────────────────────────────
  const handleSave = async (config) => {
    if (!targetFileId) {
      pushSystemMessage?.('warning', '请先在左侧文件树选择要同步到的目标工作簿文件')
      return
    }
    setLoading(true)
    try {
      const payload = {
        name: connectorName || `${selectedType} 连接器`,
        type: selectedType,
        config,
        field_mapping: fieldMapping,
        file_id: targetFileId || null,
        sheet_name: sheetName || null,
        sync_interval: syncInterval,
      }

      let res
      if (editingConnector) {
        res = await authedFetch(
          `${getApiBase()}/api/connect/connectors/${editingConnector.id}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        )
      } else {
        res = await authedFetch(`${getApiBase()}/api/connect/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const detail = errData?.detail
        const isQuota = typeof detail === 'object' && (detail.code === 'quota_exceeded' || detail.code === 'feature_disabled')
        const msg = isQuota ? detail.message : (typeof detail === 'string' ? detail : (detail?.message || `保存失败: ${res.status}`))
        throw new Error(msg)
      }

      const saved = await res.json()

      // 自动启用
      if (saved.status !== 'active') {
        await authedFetch(
          `${getApiBase()}/api/connect/connectors/${saved.id}/status`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'active' }),
          }
        )
        saved.status = 'active'
      }

      setActiveConnector(saved)
      setStage('active')
      loadConnectors()
    } catch (e) {
      pushSystemMessage?.('error', e.message)
    } finally {
      setLoading(false)
    }
  }

  // ── 打开历史连接器 ────────────────────────────────────
  const handleOpenConnector = async (connector) => {
    try {
      const res = await authedFetch(
        `${getApiBase()}/api/connect/connectors/${connector.id}`
      )
      if (res.ok) {
        const full = await res.json()
        setActiveConnector(full)
        setStage('active')
      }
    } catch (e) {
      console.warn('[ConnectView] 打开连接器失败', e)
    }
  }

  // ── 删除连接器 ────────────────────────────────────────
  const handleDelete = async (id) => {
    try {
      await authedFetch(`${getApiBase()}/api/connect/connectors/${id}`, {
        method: 'DELETE',
      })
      loadConnectors()
      if (activeConnector?.id === id) {
        setStage('home')
        setActiveConnector(null)
      }
    } catch (e) {
      console.warn('[ConnectView] 删除失败', e)
    }
  }

  // ── 切换连接器状态 ────────────────────────────────────
  const handleToggleStatus = async (id, newStatus) => {
    try {
      const res = await authedFetch(
        `${getApiBase()}/api/connect/connectors/${id}/status`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus }),
        }
      )
      if (res.ok) {
        const updated = await res.json()
        setActiveConnector(updated)
        loadConnectors()
      }
    } catch (e) {
      console.warn('[ConnectView] 切换状态失败', e)
    }
  }

  // ── 手动同步 ──────────────────────────────────────────
  const handleManualSync = async (id) => {
    try {
      const res = await authedFetch(
        `${getApiBase()}/api/connect/connectors/${id}/sync`,
        { method: 'POST' }
      )
      if (res.ok) {
        const data = await res.json()
        // 刷新连接器详情
        const detailRes = await authedFetch(
          `${getApiBase()}/api/connect/connectors/${id}`
        )
        if (detailRes.ok) setActiveConnector(await detailRes.json())
        return data
      }
      const errData = await res.json().catch(() => ({}))
      const d = errData?.detail
      throw new Error(typeof d === 'object' ? (d.message || '同步失败') : (d || '同步失败'))
    } catch (e) {
      throw e
    }
  }

  // ── 更新字段映射 ──────────────────────────────────────
  const handleUpdateMapping = async (id, newMapping) => {
    try {
      const res = await authedFetch(
        `${getApiBase()}/api/connect/connectors/${id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field_mapping: newMapping }),
        }
      )
      if (res.ok) {
        const updated = await res.json()
        setActiveConnector(updated)
      }
    } catch (e) {
      console.warn('[ConnectView] 更新映射失败', e)
    }
  }

  // ── 编辑连接器 -> 回到配置阶段 ────────────────────────
  const handleEditConnector = (connector) => {
    setSelectedType(connector.type)
    setConnectorName(connector.name)
    setTargetFileId(connector.file_id || null)
    setSheetName(connector.sheet_name || '')
    setSyncInterval(connector.sync_interval || 0)
    setFieldMapping(connector.field_mapping || {})
    setEditingConnector(connector)
    setTestResult(null)
    setStage('configuring')
  }

  const targetWorkbookLabel = useMemo(() => {
    if (!targetFileId) return '未绑定（请先在左侧选择工作簿）'
    if (targetFileId === fileId) return currentFileName || '当前左侧工作簿'
    return `已绑定其他工作簿（ID: ${targetFileId.slice(0, 8)}...），请在左侧切换到对应文件`
  }, [targetFileId, fileId, currentFileName])

  // ── 渲染 ──────────────────────────────────────────────
  useEffect(() => {
    const onConnectAction = (event) => {
      const action = event?.detail?.action
      if (action === 'back_list') {
        setStage('home')
        setActiveConnector(null)
        setEditingConnector(null)
      }
    }
    window.addEventListener('connect:view-action', onConnectAction)
    return () => window.removeEventListener('connect:view-action', onConnectAction)
  }, [])

  return (
    <div className="connect-view">
      {(stage === 'configuring' || stage === 'active') && (
        <PlatformViewToolbar variant="connect" />
      )}
      {/* ===== HOME ===== */}
      {stage === 'home' && (
        <div className={`connect-home${fileId ? ' is-file-selected' : ''}`}>
          {!fileId && (
            <div className="connect-hero">
              <div className="view-title-row">
                <h2 className="connect-hero-title">数据接入</h2>
                <button className="view-start-action-btn" onClick={() => onQuickStart?.()}>
                  点击开始
                </button>
              </div>
              <p className="connect-hero-desc">
                打通外部系统 API，配置数据源自动同步到表格
              </p>
              <p className="connect-file-note">
                请先在左侧文件树选择需要分析的文件
              </p>
            </div>
          )}
          {!!fileId && (
            <div className="connect-selected-actions">
              <h2 className="connect-section-title">选择数据连接器</h2>
              <ConnectorCatalog onSelect={handleSelectType} />
            </div>
          )}
          <ConnectorHistory
            connectors={connectors}
            loading={connectorsLoading}
            onOpen={handleOpenConnector}
            onDelete={handleDelete}
            onRefresh={loadConnectors}
          />
        </div>
      )}

      {/* ===== CONFIGURING ===== */}
      {stage === 'configuring' && (
        <div className="connect-configuring">
          <div className="connect-configuring-body">
            <div className="connect-form-col">
              <ConnectorConfigForm
                connectorType={selectedType}
                initialConfig={editingConnector?.config || {}}
                connectorName={connectorName}
                targetWorkbookLabel={targetWorkbookLabel}
                targetWorkbookReady={Boolean(targetFileId) && targetFileId === fileId}
                sheetName={sheetName}
                syncInterval={syncInterval}
                onNameChange={setConnectorName}
                onSheetNameChange={setSheetName}
                onSyncIntervalChange={setSyncInterval}
                onSave={handleSave}
                onTest={handleTestConnection}
                onCancel={() => { setStage('home'); setEditingConnector(null) }}
                loading={loading}
                testResult={testResult}
              />
            </div>
            <div className="connect-mapping-col">
              <FieldMappingPanel
                mapping={fieldMapping}
                availableFields={testResult?.available_fields || []}
                columns={columns}
                targetFileBound={Boolean(targetFileId)}
                targetFileReady={!targetFileId || targetFileId === fileId}
                onChange={setFieldMapping}
              />
            </div>
          </div>
        </div>
      )}

      {/* ===== ACTIVE ===== */}
      {stage === 'active' && activeConnector && (
        <ConnectorDetail
          connector={activeConnector}
          columns={columns}
          onToggleStatus={handleToggleStatus}
          onSync={handleManualSync}
          onUpdateMapping={handleUpdateMapping}
          onEdit={handleEditConnector}
          onBack={() => { setStage('home'); setActiveConnector(null) }}
          authedFetch={authedFetch}
          apiBase={getApiBase()}
        />
      )}
    </div>
  )
}
