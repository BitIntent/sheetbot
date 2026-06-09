// frontend/src/components/AIAssistant.jsx
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import appConfig from '../config/appConfig'
import { detectSheetHeaderRow } from '../utils/excelOperations'
import {
  Send, X, Bot, Loader2, Database, ChevronDown, ChevronUp, Sparkles,
  FileSpreadsheet, BarChart3, Filter, ArrowLeftRight, Copy, Search, Link2,
  Calendar, List, Hash, Edit3, ChevronRight, Lightbulb,
  Paintbrush, Layers, AlertTriangle, Eraser, Calculator, Table2, Users,
  RefreshCw, AlertCircle, CheckCircle2,
} from 'lucide-react'

/** 面板内提示类消息：未手动关闭时自动隐藏（进度类除外） */
const AI_PROMPT_AUTO_HIDE_MS = 5000
const ASSISTANT_TIP_RE = /AI 助手已就绪|已完成数据准备|分析状态已刷新|数据准备超时|可开始分析|可开始报表|可开始汇报/

/** 后端/SSE 常用 🔧 前缀标识「正在执行」，前端用旋转图标替代 */
const LEADING_WRENCH_FOR_EXEC = /^\s*🔧\s*/
function stripExecutingWrenchPrefix(text) {
  return String(text ?? '').replace(LEADING_WRENCH_FOR_EXEC, '')
}
function isWrenchExecutingContent(text) {
  const t = String(text ?? '')
  return LEADING_WRENCH_FOR_EXEC.test(t) && /正在执行/.test(t)
}

// ==============================================================================
// 普通模式目标导向预设（面向 Excel 小白，直达最终目标，无占位符）
// ==============================================================================
/** 预设指令图标色（战略性配色，对齐各视图 accent，避免灰阶扁平） */
const GOAL_PRESET_TONES = {
  emerald: { bg: 'rgba(33, 115, 70, 0.14)', fg: '#166534', ring: 'rgba(33, 115, 70, 0.28)' },
  blue: { bg: 'rgba(37, 99, 235, 0.12)', fg: '#1D4ED8', ring: 'rgba(37, 99, 235, 0.26)' },
  teal: { bg: 'rgba(15, 118, 110, 0.12)', fg: '#0F766E', ring: 'rgba(15, 118, 110, 0.26)' },
  amber: { bg: 'rgba(217, 119, 6, 0.14)', fg: '#B45309', ring: 'rgba(217, 119, 6, 0.3)' },
  rose: { bg: 'rgba(225, 29, 72, 0.1)', fg: '#BE123C', ring: 'rgba(225, 29, 72, 0.24)' },
  sky: { bg: 'rgba(2, 132, 199, 0.12)', fg: '#0369A1', ring: 'rgba(2, 132, 199, 0.26)' },
  indigo: { bg: 'rgba(79, 70, 229, 0.1)', fg: '#4338CA', ring: 'rgba(79, 70, 229, 0.24)' },
  orange: { bg: 'rgba(234, 88, 12, 0.12)', fg: '#C2410C', ring: 'rgba(234, 88, 12, 0.28)' },
  slate: { bg: 'rgba(71, 85, 105, 0.1)', fg: '#334155', ring: 'rgba(71, 85, 105, 0.22)' },
}

const GOAL_PRESETS = [
  { icon: Paintbrush, tone: 'emerald', text: '帮我美化表格：表头加粗配色、数字右对齐、自动调整列宽' },
  { icon: BarChart3, tone: 'blue', text: '智能分析当前数据，自动生成图表并总结关键发现' },
  { icon: Layers, tone: 'teal', text: '智能识别有意义的列，按分类汇总统计，生成一张独立的汇总报表' },
  { icon: AlertTriangle, tone: 'amber', text: '自动标记异常值：高于均值标绿色、低于均值标红色' },
  { icon: Eraser, tone: 'rose', text: '检查重复数据并清理，只保留唯一记录' },
  { icon: Calculator, tone: 'sky', type: 'formula', text: '对整列批量套用自定义公式，自动计算并填充结果' },
  { icon: Table2, tone: 'indigo', text: '创建数据透视表，根据你对当前工作表各列的理解，智能识别透视表所需的相关字段' },
  {
    icon: FileSpreadsheet,
    tone: 'orange',
    text: '一键生成销售业绩报表，含仿真数据和表头样式',
    type: 'oneclick',
    label: '销售业绩报表',
    body: '生成一个企业销售业绩报表示例。字段包含：订单日期、大区、销售人员、客户名称、产品名称、数量、单价、折扣率、销售额(净额)、毛利率、回款状态。要求数据真实可分析，金额和利润逻辑一致。',
  },
  {
    icon: Users,
    tone: 'teal',
    text: '一键生成客户管理台账，含分层标签和跟进记录',
    type: 'oneclick',
    label: '客户分层报表',
    body: '生成一个客户分层分析报表示例。字段包含：客户ID、客户名称、行业、地区、近12个月消费额、复购次数、最近下单日、客单价、客户等级（A/B/C）、流失风险、客户经理。',
  },
]

const PRESET_PROMPTS = [
  { label: '快捷指令...', value: '' },
]

// ==============================================================================
// 大文件模式预设提示词 - 只读分析操作（结果导出到新文件）
// 单表均带 [工作表]，多表带 [工作表1]、[工作表2] 等，无硬编码
// ==============================================================================
const LARGE_FILE_PROMPTS = [
  { label: '📊 快捷分析操作...', value: '', type: 'header' },

  // ========== 数据透视表 ==========
  { label: '📊 创建透视表（导出新工作表）', value: '在 [工作表] 中创建数据透视表，行字段：[行字段]，列字段：[列字段]，值字段：[值字段]（求和）' },

  // ========== 分组统计 ==========
  { label: '📈 按单列分组统计', value: '在 [工作表] 中，按 [分组列] 分组，统计 [统计列] 的总和、平均值、最大值、最小值' },
  { label: '📈 按多列分组统计', value: '在 [工作表] 中，按 [分组列1] 和 [分组列2] 分组，统计 [统计列] 的总和' },

  // ========== 数据筛选 ==========
  { label: '🔍 按条件筛选数据', value: '在 [工作表] 中，筛选 [列名] 大于 [数值] 的数据' },
  { label: '🔍 筛选指定类别数据', value: '在 [工作表] 中，筛选 [列名] 等于 "[值]" 的所有数据' },
  { label: '🔍 筛选日期范围数据', value: '在 [工作表] 中，筛选 [日期列] 在 [开始日期] 到 [结束日期] 之间的数据' },

  // ========== 排序导出 ==========
  { label: '📋 按列降序排序导出', value: '在 [工作表] 中，按 [列名] 降序排序，导出前100条数据' },
  { label: '📋 按列升序排序导出', value: '在 [工作表] 中，按 [列名] 升序排序' },
  { label: '📋 多列排序导出', value: '在 [工作表] 中，先按 [排序列1] 升序，再按 [排序列2] 降序排序' },

  // ========== 数据去重 ==========
  { label: '🧹 去重并导出', value: '在 [工作表] 中，按 [列名] 去重，保留唯一值' },
  { label: '🧹 多列组合去重', value: '在 [工作表] 中，按 [去重列1] 和 [去重列2] 组合去重' },

  // ========== 统计信息 ==========
  { label: '📉 查看列统计信息', value: '在 [工作表] 中，显示 [列名] 的统计信息：计数、总和、平均值、最大值、最小值' },
  { label: '📉 查看数据概览', value: '在 [工作表] 中，显示数据概览，包括行数、列数、各列数据类型' },

  // ========== 跨表关联查询 ==========
  { label: '🔗 关联两个工作表查询', value: '关联 [工作表1] 和 [工作表2]，通过 [关联列1]=[关联列2] 连接，查询 [查询列1]、[查询列2]，导出结果' },
  { label: '🔗 三表关联查询', value: '关联 [工作表1]、[工作表2]、[工作表3]，通过 [关联列1]=[关联列2]、[关联列3]=[关联列4] 连接，查询 [查询列1]、[查询列2]' },

  // ========== 企业高价值 ==========
  { label: '📊 按分组取 TOP N', value: '在 [工作表] 中，按 [分组列] 分组，取 [指标列] 的 TOP [N] 条记录' },
  { label: '📊 同比/环比分析', value: '在 [工作表] 中，按 [日期列] 和 [分组列] 分组，统计 [指标列] 的同比、环比' },

  // ========== 自定义 SQL 查询 ==========
  { label: '🔧 自定义 SQL 查询...', value: '__CUSTOM_SQL__', type: 'custom_sql' },
]

// SQL 查询模板
const SQL_TEMPLATES = [
  { label: '选择操作...', value: '' },
  // ========== 基础查询 ==========
  { label: '基础查询 - SELECT *', value: 'SELECT * FROM {table} LIMIT 100' },
  { label: '条件筛选 - WHERE', value: 'SELECT * FROM {table} WHERE [列名] > [值]' },
  { label: '分组统计 - GROUP BY', value: 'SELECT [分组列], SUM([数值列]) as 总计 FROM {table} GROUP BY [分组列]' },
  { label: '排序 - ORDER BY', value: 'SELECT * FROM {table} ORDER BY [列名] DESC LIMIT 100' },
  { label: '去重 - DISTINCT', value: 'SELECT DISTINCT [列名] FROM {table}' },
  { label: '计数统计 - COUNT', value: 'SELECT [分组列], COUNT(*) as 数量 FROM {table} GROUP BY [分组列]' },
  // ========== 跨表关联查询（重要！）==========
  { label: '两表关联 - JOIN', value: `SELECT 
    a.*,
    b.[关联列2]
FROM {table:工作表1} a
JOIN {table:工作表2} b ON a.[关联列] = b.[关联列]
LIMIT 100` },
  { label: '销售+客户关联示例', value: `SELECT 
    s."订单行ID",
    s."下单日期",
    s."销售额(净额)" as 销售额,
    c."客户名称",
    c."客户分层",
    c."大区"
FROM {table:销售明细} s
JOIN {table:客户明细} c ON s."客户ID" = c."客户ID"
WHERE c."大区" = '华南'
LIMIT 100` },
  { label: '销售+产品关联示例', value: `SELECT 
    s."订单行ID",
    s."下单日期",
    s."销售额(净额)" as 销售额,
    p."产品名称",
    p."品牌",
    p."品类"
FROM {table:销售明细} s
JOIN {table:产品明细} p ON s."产品ID" = p."产品ID"
LIMIT 100` },
  { label: '三表关联示例', value: `SELECT 
    s."下单日期",
    c."客户名称",
    c."大区",
    p."产品名称",
    p."品牌",
    s."销售额(净额)" as 销售额
FROM {table:销售明细} s
JOIN {table:客户明细} c ON s."客户ID" = c."客户ID"
JOIN {table:产品明细} p ON s."产品ID" = p."产品ID"
LIMIT 100` },
  { label: '按大区统计销售额', value: `SELECT 
    c."大区",
    COUNT(*) as 订单数,
    SUM(s."销售额(净额)") as 总销售额,
    AVG(s."销售额(净额)") as 平均销售额
FROM {table:销售明细} s
JOIN {table:客户明细} c ON s."客户ID" = c."客户ID"
GROUP BY c."大区"
ORDER BY 总销售额 DESC` },
  { label: '按品牌统计销售额', value: `SELECT 
    p."品牌",
    COUNT(*) as 订单数,
    SUM(s."销售额(净额)") as 总销售额,
    SUM(s."数量") as 总数量
FROM {table:销售明细} s
JOIN {table:产品明细} p ON s."产品ID" = p."产品ID"
GROUP BY p."品牌"
ORDER BY 总销售额 DESC` },
  // ========== 其他高级查询 ==========
  { label: '多条件筛选 - AND/OR', value: 'SELECT * FROM {table} WHERE [列1] > [值1] AND [列2] = \'[值2]\'' },
  { label: '模糊匹配 - LIKE', value: 'SELECT * FROM {table} WHERE [列名] LIKE \'%关键词%\'' },
  { label: '范围筛选 - BETWEEN', value: 'SELECT * FROM {table} WHERE [列名] BETWEEN [值1] AND [值2]' },
  { label: 'TOP N 查询', value: 'SELECT * FROM {table} ORDER BY [列名] DESC LIMIT 10' },
  { label: '聚合函数组合', value: 'SELECT [分组列], COUNT(*) as 数量, SUM([数值列]) as 总计, AVG([数值列]) as 平均值 FROM {table} GROUP BY [分组列]' },
]

const VIEW_LABEL_MAP = {
  normal: '普通视图',
  analyze: '数据分析',
  report: 'PPT汇报',
  reportCard: '数据报表',
  collect: '数据收集',
  connect: '数据接入',
  share: '玩数据Skill',
  skill: '玩数据Skill',
  batchWord: '批量转Word',
}

function GoalPresetIconChip({ Icon, tone = 'emerald' }) {
  const t = GOAL_PRESET_TONES[tone] || GOAL_PRESET_TONES.emerald
  return (
    <span
      className="goal-preset-icon-chip"
      data-tone={tone}
      style={{
        '--gp-icon-bg': t.bg,
        '--gp-icon-fg': t.fg,
        '--gp-icon-ring': t.ring,
      }}
    >
      <Icon size={14} className="goal-preset-icon" aria-hidden />
    </span>
  )
}

function stripPromptPrefix(label = '') {
  return String(label)
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\s]+/gu, '')
    .trim()
}

function resolvePromptIcon(label = '', type = '') {
  const text = stripPromptPrefix(label)
  if (type === 'header') return { Icon: Sparkles, color: '#34D399' }
  if (type === 'custom_sql' || /SQL|查询/.test(text)) return { Icon: Database, color: '#34D399' }
  if (/透视/.test(text)) return { Icon: FileSpreadsheet, color: '#6EE7B7' }
  if (/分组|统计|占比/.test(text)) return { Icon: BarChart3, color: '#10B981' }
  if (/筛选/.test(text)) return { Icon: Filter, color: '#4ADE80' }
  if (/排序/.test(text)) return { Icon: ArrowLeftRight, color: '#2DD4BF' }
  if (/去重/.test(text)) return { Icon: Copy, color: '#22C55E' }
  if (/关联|JOIN/.test(text)) return { Icon: Link2, color: '#34D399' }
  if (/概览|预览/.test(text)) return { Icon: Search, color: '#9CA3AF' }
  return { Icon: Bot, color: '#6EE7B7' }
}

function resolveSqlTemplateIcon(label = '') {
  const text = stripPromptPrefix(label)
  if (/选择操作/.test(text)) return { Icon: Sparkles, color: '#34D399' }
  if (/JOIN|关联/.test(text)) return { Icon: Link2, color: '#34D399' }
  if (/WHERE|筛选|LIKE|BETWEEN/.test(text)) return { Icon: Filter, color: '#4ADE80' }
  if (/GROUP BY|聚合|COUNT|统计/.test(text)) return { Icon: BarChart3, color: '#10B981' }
  if (/ORDER BY|TOP/.test(text)) return { Icon: ArrowLeftRight, color: '#2DD4BF' }
  if (/DISTINCT|去重/.test(text)) return { Icon: Copy, color: '#22C55E' }
  if (/SELECT \*/.test(text)) return { Icon: Search, color: '#9CA3AF' }
  return { Icon: Database, color: '#34D399' }
}

// ------------------------------------------------------------------------------
// 快捷分析占位符解析（用于动态表单）
// ------------------------------------------------------------------------------
const SHEET_PLACEHOLDERS = new Set(['工作表', '工作表1', '工作表2', '工作表3'])
const COLUMN_PLACEHOLDERS = new Set([
  '行字段', '列字段', '值字段', '分组列', '分组列1', '分组列2', '统计列', '指标列', '数值列',
  '列名', '列名1', '列名2', '公式取值列', '结果插入列', '源列', '目标列', '日期列', '排序列1', '排序列2', '去重列1', '去重列2',
  '关联列1', '关联列2', '关联列3', '关联列4', '查询列1', '查询列2'
])
const TEXT_PLACEHOLDERS = new Set(['数值', '值', '开始日期', '结束日期', 'N', '公式名', '格式', '旧值', '新值', '分隔符', '新列名'])
const ADD_CUSTOM_FORMULA_VALUE = '__ADD_CUSTOM_FORMULA__'

function parsePlaceholders(template) {
  if (!template || typeof template !== 'string') return { sheet: [], column: [], text: [] }
  const matches = [...template.matchAll(/\[([^\]]+)\]/g)]
  const seen = new Set()
  const sheet = []
  const column = []
  const text = []
  for (const m of matches) {
    const key = m[1]
    if (seen.has(key)) continue
    seen.add(key)
    if (SHEET_PLACEHOLDERS.has(key)) sheet.push(key)
    else if (COLUMN_PLACEHOLDERS.has(key)) column.push(key)
    else if (TEXT_PLACEHOLDERS.has(key)) text.push(key)
  }
  return { sheet, column, text }
}

/** 列占位符绑定的工作表（多表场景）: 关联列1->工作表1, 关联列2->工作表2, 关联列3->工作表2, 关联列4->工作表3, 查询列N->工作表N */
function getColumnBoundSheet(placeholder) {
  const m = placeholder.match(/^(关联列|查询列)(\d+)$/)
  if (!m) return null
  const n = parseInt(m[2], 10)
  if (m[1] === '查询列') return `工作表${n}`
  if (m[1] === '关联列') {
    if (n <= 2) return `工作表${n}`
    return n === 3 ? '工作表2' : '工作表3'
  }
  return null
}

function getPlaceholderIcon(placeholder) {
  if (SHEET_PLACEHOLDERS.has(placeholder)) return { Icon: FileSpreadsheet, color: '#60A5FA' }
  if (placeholder === '日期列') return { Icon: Calendar, color: '#2DD4BF' }
  if (/^关联列\d+$/.test(placeholder)) return { Icon: Link2, color: '#34D399' }
  if (/^查询列\d+$/.test(placeholder)) return { Icon: List, color: '#10B981' }
  if (COLUMN_PLACEHOLDERS.has(placeholder)) return { Icon: BarChart3, color: '#10B981' }
  return { Icon: Hash, color: '#9CA3AF' }
}

function applyPlaceholdersToTemplate(template, selections) {
  if (!template || typeof template !== 'string') return template
  const isMultiTable = /\[工作表[123]\]/.test(template)
  return Object.entries(selections || {}).reduce((acc, [ph, val]) => {
    if (!val) return acc
    const boundSheet = getColumnBoundSheet(ph)
    const replacement = (isMultiTable && boundSheet && COLUMN_PLACEHOLDERS.has(ph))
      ? (selections[boundSheet] ? `${selections[boundSheet]}.${val}` : val)
      : String(val)
    return acc.split(`[${ph}]`).join(replacement)
  }, template)
}

function buildCustomFormulaOptions(customFormulas = []) {
  const formulas = Array.isArray(customFormulas) ? customFormulas : []
  return [
    ...formulas.map(f => ({ value: f.name, label: f.label || f.name })),
    { value: ADD_CUSTOM_FORMULA_VALUE, label: '添加自定义公式' },
  ]
}

// ------------------------------------------------------------------------------
// 快捷分析动态表单（根据占位符渲染工作表/列下拉、文本输入）
// ------------------------------------------------------------------------------
function AnalyzeQuickForm({
  template,
  sheets = [],
  columnsBySheet = {},
  defaultSheet = '',
  selections = {},
  onSelectionsChange,
  disabled = false,
  customFormulas = [],
  onOpenFormulaManager = null,
}) {
  const { sheet: sheetPlaceholders, column: columnPlaceholders, text: textPlaceholders } = parsePlaceholders(template)
  const [openKey, setOpenKey] = useState(null)
  const formRef = useRef(null)

  useEffect(() => {
    const onDocClick = (e) => {
      if (formRef.current && !formRef.current.contains(e.target)) setOpenKey(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const handleSelect = (placeholder, value) => {
    setOpenKey(null)
    if (placeholder === '公式名' && value === ADD_CUSTOM_FORMULA_VALUE) {
      onOpenFormulaManager?.()
      return
    }
    onSelectionsChange?.({ ...selections, [placeholder]: value })
  }

  const getColumnsForPlaceholder = (ph) => {
    const bound = getColumnBoundSheet(ph)
    const sheetName = bound ? (selections[bound] || '') : (selections['工作表'] || defaultSheet)
    return columnsBySheet[sheetName] || []
  }

  const PLACEHOLDER_LABELS = {
    工作表: '工作表', 工作表1: '工作表1', 工作表2: '工作表2', 工作表3: '工作表3',
    行字段: '行字段', 列字段: '列字段', 值字段: '值字段',
    分组列: '分组列', 分组列1: '分组列1', 分组列2: '分组列2', 统计列: '统计列', 指标列: '指标列', 数值列: '数值列',
    列名: '列名', 列名1: '列名1', 列名2: '列名2', 公式取值列: '公式取值列', 结果插入列: '结果插入列',
    源列: '源列', 目标列: '目标列',
    日期列: '日期列', 排序列1: '排序列1', 排序列2: '排序列2',
    去重列1: '去重列1', 去重列2: '去重列2',
    关联列1: '关联列1', 关联列2: '关联列2', 关联列3: '关联列3', 关联列4: '关联列4',
    查询列1: '查询列1', 查询列2: '查询列2',
    数值: '数值', 值: '值', 开始日期: '开始日期', 结束日期: '结束日期', N: 'N',
    公式名: '公式名', 格式: '格式', 旧值: '旧值', 新值: '新值', 分隔符: '分隔符', 新列名: '新列名'
  }

  const renderDropdown = (placeholder, options, label) => {
    const { Icon, color } = getPlaceholderIcon(placeholder)
    const isOpen = openKey === placeholder
    const currentVal = selections[placeholder] || ''
    const hint = options.length === 0 ? '请先选择工作表' : `请选择${label || placeholder}...`
    const displayText = currentVal || hint
    return (
      <div key={placeholder} className="mb-3">
        <label className="ai-form-label mb-1 block" style={{ color: '#B3B3B3', fontSize: '13px' }}>{PLACEHOLDER_LABELS[placeholder] || placeholder}：</label>
        <div className="ai-quick-action" style={{ position: 'relative' }}>
          <button
            type="button"
            disabled={disabled}
            className="ai-quick-action-trigger ai-dark-select"
            onClick={() => setOpenKey(isOpen ? null : placeholder)}
          >
            <Icon size={14} style={{ color }} />
            <span className="ai-quick-action-trigger-text">{displayText}</span>
            <ChevronDown size={14} className={`ai-quick-action-chevron ${isOpen ? 'open' : ''}`} />
          </button>
          {isOpen && (
            <div className="ai-quick-action-menu">
              {options.map((opt, i) => {
                const val = typeof opt === 'string' ? opt : opt.value
                const lab = typeof opt === 'string' ? opt : opt.label
                return (
                  <button
                    key={`${placeholder}-${i}`}
                    type="button"
                    className="ai-quick-action-item"
                    onClick={() => handleSelect(placeholder, val)}
                  >
                    <Icon size={14} style={{ color }} />
                    <span>{lab}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderTextInput = (placeholder, label) => {
    if (placeholder === '公式名' && Array.isArray(customFormulas)) {
      const opts = buildCustomFormulaOptions(customFormulas)
      return renderDropdown(placeholder, opts, '公式名')
    }
    const { Icon } = getPlaceholderIcon(placeholder)
    const val = selections[placeholder] || ''
    return (
      <div key={placeholder} className="mb-3">
        <label className="ai-form-label mb-1 block" style={{ color: '#B3B3B3', fontSize: '13px' }}>{PLACEHOLDER_LABELS[placeholder] || placeholder}：</label>
        <div className="flex items-center gap-2">
          <Icon size={14} style={{ color: '#9CA3AF' }} />
          <input
            type="text"
            value={val}
            onChange={(e) => onSelectionsChange?.({ ...selections, [placeholder]: e.target.value })}
            disabled={disabled}
            placeholder={`请输入${label || placeholder}`}
            className="flex-1 rounded px-3 py-2 text-sm focus:outline-none ai-dark-input"
            style={{ fontSize: '14px' }}
          />
        </div>
      </div>
    )
  }

  const hasAny = sheetPlaceholders.length + columnPlaceholders.length + textPlaceholders.length > 0
  if (!hasAny) return null

  return (
    <div ref={formRef} className="mb-4 p-4 rounded-lg ai-dark-section" style={{ fontSize: '14px' }}>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} style={{ color: '#34D399' }} />
        <span className="font-medium" style={{ color: '#D4D0DC', fontSize: '14px' }}>填写参数</span>
      </div>
      {sheetPlaceholders.map((ph) => renderDropdown(ph, sheets, '工作表'))}
      {columnPlaceholders.map((ph) => {
        if (ph === '结果插入列') {
          const { Icon } = getPlaceholderIcon(ph)
          const val = selections[ph] || ''
          return (
            <div key={ph} className="mb-3">
              <label className="ai-form-label" style={{ color: '#B3B3B3', fontSize: '13px' }}>{PLACEHOLDER_LABELS[ph] || ph}：</label>
              <div className="flex items-center gap-2">
                <Icon size={14} style={{ color: '#9CA3AF' }} />
                <input
                  type="text"
                  value={val}
                  onChange={(e) => onSelectionsChange?.({ ...selections, [ph]: e.target.value })}
                  disabled={disabled}
                  placeholder="如：H列或某列表头名称"
                  className="flex-1 rounded px-3 py-2 text-sm focus:outline-none ai-dark-input"
                  style={{ fontSize: '14px' }}
                  required
                />
              </div>
            </div>
          )
        }
        const opts = getColumnsForPlaceholder(ph)
        return renderDropdown(ph, opts, ph)
      })}
      {textPlaceholders.map((ph) => renderTextInput(ph, ph))}
    </div>
  )
}

// ==============================================================================
// 报表分析视角预设提示词
// ==============================================================================
const REPORT_PERSPECTIVE_PRESETS = [
  { label: '收入质量分析', prompt: '请从收入质量角度分析，重点关注收入结构、增长质量、客单价变化和高价值客户贡献' },
  { label: '成本优化建议', prompt: '请从成本控制角度分析，识别高成本环节、异常波动项，给出可落地的降本增效建议' },
  { label: '渠道效率对比', prompt: '请对比各渠道的投入产出效率，识别高ROI渠道和低效渠道，建议资源重新分配方案' },
  { label: '客户分层洞察', prompt: '请从客户分层角度分析，识别核心客户群、流失风险客户，建议差异化运营策略' },
  { label: '趋势预警分析', prompt: '请重点识别指标异常波动和趋势拐点，给出预警信号和建议的应对措施' },
  { label: '产品组合优化', prompt: '请分析产品/SKU组合结构，识别明星产品、长尾产品，建议品类优化策略' },
  { label: '区域差异分析', prompt: '请对比不同区域/市场的表现差异，识别高增长区域和需要关注的薄弱区域' },
  { label: '经营效率诊断', prompt: '请从经营效率角度全面诊断，关注人效、坪效、周转率等效率指标' },
  { label: '管理层摘要', prompt: '请用管理层视角提炼3-5条最关键的经营洞察，语言简洁、结论明确、建议可执行' },
  { label: '风险识别', prompt: '请重点识别数据中隐含的经营风险，包括集中度风险、趋势恶化、异常偏离等' },
]

function buildOneClickSheetPrompt(topic, body, { hasSelectedWorkbook, currentSheetIsEmpty }) {
  const sheetName = String(topic || '主题报表').replace(/^生成/, '').replace(/\s+/g, '').slice(0, 20)
  const scenarioInstruction = !hasSelectedWorkbook
    ? `请先创建一个新的工作簿，并将默认工作表重命名为「${sheetName}」，然后在该工作表生成完整表结构与10条示例数据。`
    : currentSheetIsEmpty
      ? '请直接在当前空工作表生成完整表结构与10条示例数据。'
      : `请新建一张空工作表并命名为「${sheetName}」，然后在新工作表生成完整表结构与10条示例数据。`

  return [
    `请执行“一键生表”任务，主题为「${sheetName}」。`,
    scenarioInstruction,
    '',
    '数据与格式要求：',
    '- 首行必须是清晰可读的业务表头（完整字段名）。',
    '- 示例数据必须为真实业务风格，字段之间逻辑自洽。',
    '- 完成后请将首行设为表头样式（加粗、背景色、边框）并保证列宽可读。',
    '',
    body,
  ].join('\n')
}

function isCreateWorkbookIntent(command = '') {
  return /(创建|新建).*(工作簿|工作薄)(文件)?/.test(String(command))
}

function extractWorkbookName(command = '') {
  const text = String(command || '')
  const quotedMatch = text.match(/[“"'`「『]([^”"'`」』]{1,31})[”"'`」』]\s*工作(?:簿|薄)/)
  if (quotedMatch?.[1]) return quotedMatch[1].trim()

  const plainMatch = text.match(/(?:创建|新建)(?:一个|一份|个)?\s*([^\s，。,；;：:]{1,31})\s*工作(?:簿|薄)/)
  if (plainMatch?.[1]) return plainMatch[1].trim()

  return ''
}

function AIAssistant({
  open,
  messages,
  isProcessing,
  isConnected,
  isReady,
  onSendCommand,
  onClearBackendMessages,
  onClose,
  // 大文件模式
  largeFileMode = false,
  largeFileInfo = null,
  currentFileName = '',
  currentSheetCount = 0,
  activeSheet = null,
  workbook = null,
  hasSelectedWorkbook = true,
  currentSheetIsEmpty = true,
  onEnsureWorkbookForOneClickSheet = null,
  platformView = 'normal',
  openSqlBuilderSignal = 0,
  customFormulas = [],
  accessToken = '',
  onOpenFormulaManager = null,
  executionProgress = null,
}) {
  // 大文件模式下，全部工作表未加载完成前禁止操作
  const duckdbLoading = largeFileMode && !largeFileInfo?.duckdb_ready

  const [input, setInput] = useState('')
  const [selectedPrompt, setSelectedPrompt] = useState('')
  const [isPreparingOneClickWorkbook, setIsPreparingOneClickWorkbook] = useState(false)
  const [formulaPresetOpen, setFormulaPresetOpen] = useState(false)
  const [fpSheet, setFpSheet] = useState('')
  const [fpColumn, setFpColumn] = useState('')
  const [fpFormula, setFpFormula] = useState('')
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false)
  const [aiSuggestError, setAiSuggestError] = useState('')
  const [aiSuggestList, setAiSuggestList] = useState([])
  const [aiSuggestPick, setAiSuggestPick] = useState('')
  const [showSqlBuilder, setShowSqlBuilder] = useState(false)
  const [sqlQuery, setSqlQuery] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('')
  const [sqlTemplateRaw, setSqlTemplateRaw] = useState('')
  const [memoryTables, setMemoryTables] = useState([])
  const [selectedMemoryTable, setSelectedMemoryTable] = useState('')
  const [placeholderSelections, setPlaceholderSelections] = useState({})
  const [analyzePlaceholderSelections, setAnalyzePlaceholderSelections] = useState({})
  const [normalPlaceholderSelections, setNormalPlaceholderSelections] = useState({})
  const [analyzeSheets, setAnalyzeSheets] = useState([])
  const [analyzeColumnsBySheet, setAnalyzeColumnsBySheet] = useState({})
  const [fetchedColumnsBySheet, setFetchedColumnsBySheet] = useState({})
  const [quickActionOpen, setQuickActionOpen] = useState(false)
  const [memoryTableOpen, setMemoryTableOpen] = useState(false)
  const [sqlActionOpen, setSqlActionOpen] = useState(false)
  const messagesEndRef = useRef(null)
  const quickActionRef = useRef(null)
  const memoryTableRef = useRef(null)
  const sqlActionRef = useRef(null)
  const tipFirstSeenRef = useRef(new Map())
  const tipDismissedRef = useRef(new Set())
  const [tipTick, setTipTick] = useState(0)
  const [tipDismissTick, setTipDismissTick] = useState(0)
  
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }
  
  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // 定时刷新：用于自动隐藏“提示型消息”
  useEffect(() => {
    const timer = setInterval(() => setTipTick(t => t + 1), 500)
    return () => clearInterval(timer)
  }, [])

  const isProgressPromptMessage = (msg) =>
    msg && ['upload_progress', 'backend_progress'].includes(msg.type)

  const isAssistantTipMessage = (msg) =>
    msg?.type === 'assistant' && ASSISTANT_TIP_RE.test(String(msg.content || ''))

  /** 含进度条：仅手动关闭，避免上传/长任务中途消失 */
  const isPromptChromeMessage = (msg) => {
    if (!msg) return false
    if (msg.persistent === true) return false
    if (isProgressPromptMessage(msg)) return true
    if (['status', 'warning', 'thinking', 'success', 'error'].includes(msg.type)) return true
    return isAssistantTipMessage(msg)
  }

  const visibleMessageEntries = useMemo(() => {
    const currentKeys = new Set()
    const now = Date.now()

    const withMeta = messages.map((msg, index) => {
      const key = msg.id || `${msg.type}:${String(msg.content)}:${index}`
      currentKeys.add(key)
      if (tipDismissedRef.current.has(key)) {
        return { msg, key, visible: false }
      }
      if (msg?.persistent === true) {
        return { msg, key, visible: true }
      }
      if (!isPromptChromeMessage(msg)) {
        return { msg, key, visible: true }
      }
      if (!tipFirstSeenRef.current.has(key)) {
        tipFirstSeenRef.current.set(key, now)
      }
      const firstSeen = tipFirstSeenRef.current.get(key) || now
      if (isProgressPromptMessage(msg)) {
        return { msg, key, visible: true }
      }
      return { msg, key, visible: now - firstSeen < AI_PROMPT_AUTO_HIDE_MS }
    })

    for (const existingKey of tipFirstSeenRef.current.keys()) {
      if (!currentKeys.has(existingKey)) tipFirstSeenRef.current.delete(existingKey)
    }
    tipDismissedRef.current.forEach((k) => {
      if (!currentKeys.has(k)) tipDismissedRef.current.delete(k)
    })

    return withMeta.filter((item) => item.visible)
  }, [messages, tipTick, tipDismissTick])

  const dismissPromptMessage = useCallback((rowKey) => {
    tipDismissedRef.current.add(rowKey)
    setTipDismissTick((t) => t + 1)
  }, [])
  
  // 根据模式选择提示词列表（SQL 模式仅允许“我要分析”视图）
  const currentPrompts = useMemo(() => {
    if (!largeFileMode) return PRESET_PROMPTS
    if (platformView === 'analyze') return LARGE_FILE_PROMPTS
    return LARGE_FILE_PROMPTS.filter((prompt) => prompt.value !== '__CUSTOM_SQL__')
  }, [largeFileMode, platformView])
  const currentViewLabel = VIEW_LABEL_MAP[platformView] || '普通视图'

  // 工作表列表：优先用 workbook（含全部工作表），否则用 session-info
  const effectiveAnalyzeSheets = useMemo(() => {
    const fromWorkbook = (workbook?.sheets || []).map(s => s?.name).filter(Boolean)
    if (fromWorkbook.length > 0) return fromWorkbook
    return analyzeSheets
  }, [workbook?.sheets, analyzeSheets])

  // 列清单：session-info 为主，workbook 表头补充，按需 preview 兜底（未点击左侧工作表时）
  const effectiveColumnsBySheet = useMemo(() => {
    const merged = { ...analyzeColumnsBySheet, ...fetchedColumnsBySheet }
    ;(workbook?.sheets || []).forEach(sheet => {
      const name = sheet?.name
      if (!name || (merged[name] && merged[name].length > 0)) return
      const hRow = detectSheetHeaderRow(sheet?.data)
      const headerRowData = sheet?.data?.[hRow]
      if (!headerRowData || typeof headerRowData !== 'object') return
      const fromHeader = Object.keys(headerRowData)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => headerRowData[k]?.value)
        .filter(Boolean)
      if (fromHeader.length > 0) merged[name] = fromHeader
    })
    return merged
  }, [workbook?.sheets, analyzeColumnsBySheet, fetchedColumnsBySheet])

  // 普通模式：工作表列表与列清单（来自 workbook，全量加载无懒加载）
  const effectiveNormalSheets = useMemo(() => {
    return (workbook?.sheets || []).map(s => s?.name).filter(Boolean)
  }, [workbook?.sheets])
  const effectiveNormalColumnsBySheet = useMemo(() => {
    const merged = {}
    ;(workbook?.sheets || []).forEach(sheet => {
      const name = sheet?.name
      if (!name) return
      const hRow = detectSheetHeaderRow(sheet?.data)
      const headerRowData = sheet?.data?.[hRow]
      if (!headerRowData || typeof headerRowData !== 'object') return
      const fromHeader = Object.keys(headerRowData)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => headerRowData[k]?.value)
        .filter(Boolean)
      if (fromHeader.length > 0) merged[name] = fromHeader
    })
    return merged
  }, [workbook?.sheets])

  // 供后端 LLM 生成「智能指令建议」的工作簿元数据（多表学习，上限 5 张）
  const workbookSuggestMeta = useMemo(() => {
    const MAX_SHEETS_FOR_SUGGEST = 5
    const allSheets = (workbook?.sheets || []).map((s) => {
      const name = s?.name
      if (!name) return null
      const data = s?.data || {}
      const rowKeys = Object.keys(data).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
      const firstRow = rowKeys.length > 0 ? rowKeys[0] : 1
      const headerRow = data[firstRow]
      let headers = []
      if (headerRow && typeof headerRow === 'object') {
        headers = Object.keys(headerRow)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => headerRow[k]?.value)
          .filter(Boolean)
      }
      const approxDataRows = rowKeys.filter((r) => r > firstRow).length
      return { name, headers, approxDataRows }
    }).filter(Boolean)
    // 取前 5 张表供 LLM 学习；活动表确保在首位
    const active = activeSheet || workbook?.activeSheet || ''
    let sheets = allSheets
    if (allSheets.length > MAX_SHEETS_FOR_SUGGEST) {
      const activeEntry = allSheets.find(s => s.name === active)
      const rest = allSheets.filter(s => s.name !== active).slice(0, MAX_SHEETS_FOR_SUGGEST - (activeEntry ? 1 : 0))
      sheets = activeEntry ? [activeEntry, ...rest] : rest.slice(0, MAX_SHEETS_FOR_SUGGEST)
    }
    return {
      activeSheet: active,
      currentFileName: currentFileName || '',
      sheetCount: allSheets.length,
      sheets,
    }
  }, [workbook?.sheets, workbook?.activeSheet, activeSheet, currentFileName])

  const fetchAiSuggestions = useCallback(async () => {
    if (!accessToken) {
      setAiSuggestError('请先登录后再使用此功能')
      return
    }
    if (!hasSelectedWorkbook) {
      setAiSuggestError('请先在左侧「文件管理」中选择并打开一个工作簿，再使用「打开思路」。')
      return
    }
    if (!effectiveNormalSheets.length) {
      setAiSuggestError('当前没有可用工作表，请先打开包含工作表的工作簿后再试。')
      return
    }
    setAiSuggestLoading(true)
    setAiSuggestError('')
    try {
      const base = String(appConfig.apiBaseUrl || '').replace(/\/$/, '')
      const res = await fetch(`${base}/api/excel/suggest-prompts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ metadata: workbookSuggestMeta }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const d = data?.detail
        const msg = typeof d === 'object' && d?.message
          ? d.message
          : (typeof d === 'string' ? d : '生成失败，请稍后重试')
        setAiSuggestList([])
        setAiSuggestError(msg)
        return
      }
      const list = Array.isArray(data.suggestions) ? data.suggestions : []
      setAiSuggestList(list.map(s => String(s || '').trim()).filter(Boolean))
      setAiSuggestPick('')
    } catch {
      setAiSuggestList([])
      setAiSuggestError('网络异常，请稍后重试')
    } finally {
      setAiSuggestLoading(false)
    }
  }, [accessToken, workbookSuggestMeta, hasSelectedWorkbook, effectiveNormalSheets.length])

  // 自定义公式预设：选齐三项后填充指令（必须带 expression，模型才能理解计算逻辑）
  const handleFpSelect = (field, value) => {
    let ns = fpSheet, nc = fpColumn, nf = fpFormula
    if (field === 'sheet') { ns = value; nc = ''; setFpSheet(value); setFpColumn('') }
    else if (field === 'column') { nc = value; setFpColumn(value) }
    else { nf = value; setFpFormula(value) }
    if (ns && nc && nf) {
      const f = customFormulas.find(c => c.name === nf)
      const expr = String(f?.expression || '').trim()
      const showName = f?.label || nf
      const params = Array.isArray(f?.params) ? f.params : []
      const paramLines = params.length
        ? params.map(p => `  - ${p.label || p.name}（${p.name}）：默认 ${p.default ?? 0}${p.type === 'percent' ? '%' : ''}`)
          .join('\n')
        : ''
      const paramBlock = paramLines ? `\n公式可调参数（常量，未在表达式中写死时可按默认值参与计算）：\n${paramLines}` : ''
      const desc = String(f?.description || '').trim()
      const descBlock = desc ? `\n说明：${desc}` : ''
      const exprBlock = expr
        ? `表达式：${expr}`
        : '（系统未返回表达式，请打开「自定义公式」管理核对该公式内容后再执行）'
      setInput(
        `请对「${ns}」工作表的「${nc}」列逐行计算，并将结果写回同列（批量填充）。\n\n`
        + `自定义公式：${showName}（标识：${nf}）\n`
        + `${exprBlock}${descBlock}${paramBlock}\n\n`
        + `请严格按上述表达式含义，结合当前表中各列数值（含列字母引用规则）完成计算并回填。`
      )
      setSelectedPrompt('')
      setTimeout(() => { setFormulaPresetOpen(false); setFpSheet(''); setFpColumn(''); setFpFormula('') }, 120)
    }
  }

  const applyTableToTemplate = (template, tableValue) => {
    if (!template || typeof template !== 'string') return template
    const effectiveTableValue = tableValue || memoryTables[0]?.value || '{table}'
    return template.replace(/\{table\}/g, effectiveTableValue)
  }

  const applyPlaceholderMap = (template, selections) => {
    if (!template || typeof template !== 'string') return template
    return Object.entries(selections || {}).reduce((acc, [placeholder, value]) => {
      if (!value) return acc
      return acc.split(placeholder).join(value)
    }, template)
  }

  const buildSqlFromTemplate = (template, tableValue, selections) => {
    const withDefaultTable = applyTableToTemplate(template, tableValue)
    return applyPlaceholderMap(withDefaultTable, selections)
  }

  const extractTablePlaceholders = (text) => {
    if (!text) return []
    const matches = text.match(/\{table:[^}]+\}/g) || []
    if (matches.length > 0) return Array.from(new Set(matches))
    if (!text.includes('{table:')) return []
    const tokens = []
    let idx = 0
    while ((idx = text.indexOf('{table:', idx)) !== -1) {
      const end = text.indexOf('}', idx)
      if (end === -1) break
      tokens.push(text.slice(idx, end + 1))
      idx = end + 1
    }
    return Array.from(new Set(tokens))
  }

  const placeholderTokens = useMemo(() => {
    const base = [sqlTemplateRaw, sqlQuery].filter(Boolean).join('\n')
    return extractTablePlaceholders(base)
  }, [sqlTemplateRaw, sqlQuery])

  const safeEncodeUri = (uri) => {
    if (!uri) return uri
    try {
      return encodeURI(uri)
    } catch (error) {
      console.warn('[AIAssistant] URI 编码失败', error, uri)
      return uri
    }
  }

  const markdownLink = ({ href, children, ...props }) => {
    const safeHref = safeEncodeUri(href)
    return (
      <a href={safeHref} {...props}>
        {children}
      </a>
    )
  }

  const markdownImage = ({ src, alt, ...props }) => {
    const safeSrc = safeEncodeUri(src)
    return <img src={safeSrc} alt={alt} {...props} />
  }

  const markdownComponents = { a: markdownLink, img: markdownImage }

  const handleMemoryTableValue = (value) => {
    setSelectedMemoryTable(value)
    if (sqlTemplateRaw) {
      setSqlQuery(buildSqlFromTemplate(sqlTemplateRaw, value, placeholderSelections))
    }
  }

  const handlePlaceholderSelect = (placeholder, value) => {
    setPlaceholderSelections(prev => {
      const next = { ...prev, [placeholder]: value }
      if (sqlTemplateRaw) {
        setSqlQuery(buildSqlFromTemplate(sqlTemplateRaw, selectedMemoryTable, next))
      } else {
        setSqlQuery(current => current.split(placeholder).join(value))
      }
      return next
    })
  }
  
  const openCustomSqlBuilder = () => {
    if (platformView !== 'analyze') return
    setSelectedPrompt('__CUSTOM_SQL__')
    setShowSqlBuilder(true)
    setInput('')
  }

  const handleSend = async () => {
    if (duckdbLoading) return
    if (!input.trim() || !isConnected || !isReady || isProcessing) {
      if (isProcessing) {
        console.warn('[AIAssistant] 正在处理中，忽略重复请求')
      }
      return
    }
    const command = input.trim()

    // 普通视图：当用户明确要求“创建工作簿/工作薄文件”且当前未选中文件时，先自动创建文件再发指令
    if (
      !largeFileMode &&
      platformView === 'normal' &&
      !hasSelectedWorkbook &&
      typeof onEnsureWorkbookForOneClickSheet === 'function' &&
      isCreateWorkbookIntent(command)
    ) {
      setIsPreparingOneClickWorkbook(true)
      try {
        const workbookName = extractWorkbookName(command)
        const created = await onEnsureWorkbookForOneClickSheet(workbookName)
        if (!created) return
      } finally {
        setIsPreparingOneClickWorkbook(false)
      }
    }

    onSendCommand(command)
    setInput('')
    setSelectedPrompt('')
    setAnalyzePlaceholderSelections({})
    setNormalPlaceholderSelections({})
    setShowSqlBuilder(false)
  }

  const handlePromptValue = (value) => {
    setSelectedPrompt(value)

    if (value === '__CUSTOM_SQL__') {
      if (platformView !== 'analyze') {
        setShowSqlBuilder(false)
        return
      }
      openCustomSqlBuilder()
    } else if (value) {
      setShowSqlBuilder(false)
      if (largeFileMode && platformView === 'analyze') {
        const { sheet } = parsePlaceholders(value)
        const defaults = {}
        const defSheet = activeSheet || effectiveAnalyzeSheets[0] || ''
        sheet.forEach(ph => { defaults[ph] = defSheet })
        setAnalyzePlaceholderSelections(defaults)
        setInput(applyPlaceholdersToTemplate(value, defaults))
      } else if (!largeFileMode && platformView === 'normal') {
        const { sheet } = parsePlaceholders(value)
        const defaults = {}
        const defSheet = activeSheet || effectiveNormalSheets[0] || ''
        sheet.forEach(ph => { defaults[ph] = defSheet })
        setNormalPlaceholderSelections(defaults)
        setInput(applyPlaceholdersToTemplate(value, defaults))
      } else {
        setInput(value)
      }
    } else {
      setShowSqlBuilder(false)
    }
  }

  /**
   * 占位符替换时，公式名需解析为 Agent 可执行的完整指令块。
   * 两种模式：
   * 1) 单列模式（列名）：value 表示目标列单元格值，就地计算
   * 2) 跨列模式（源列+目标列）：value 表示源列的值，结果写入目标列
   */
  const resolveSelectionsForTemplate = (selections) => {
    const resolved = { ...selections }
    if (selections['公式名'] && Array.isArray(customFormulas) && customFormulas.length > 0) {
      const formula = customFormulas.find(f => f.name === selections['公式名'])
      if (formula?.expression) {
        const params = (formula.params || []).reduce((acc, p) => {
          acc[p.name] = p.default ?? 0
          return acc
        }, {})
        const paramsStr = JSON.stringify(params)
        const valueCol = selections['公式取值列']
        const resultCol = selections['结果插入列']
        if (valueCol && resultCol) {
          const sameCol = valueCol === resultCol
          resolved['公式名'] = sameCol
            ? `expression="${formula.expression}"，formula_params=${paramsStr}。value 表示公式取值列（${valueCol}）的单元格值，结果就地替换`
            : `expression="${formula.expression}"，formula_params=${paramsStr}。value 表示公式取值列（${valueCol}）的值，请用 ${valueCol} 的列字母替换 value 后调用 apply_custom_formula，target_col 为结果插入列（${resultCol}）的列号`
        } else {
          const colHint = selections['列名'] ? `目标列（${selections['列名']}）` : '目标列'
          resolved['公式名'] = `expression="${formula.expression}"，formula_params=${paramsStr}。value 表示${colHint}的单元格值，由 apply_custom_formula 工具自动注入`
        }
      }
    }
    return resolved
  }

  const handleAnalyzePlaceholderChange = (nextSelections) => {
    setAnalyzePlaceholderSelections(nextSelections)
    const template = currentPrompts.find(p => p.value === selectedPrompt)?.value || selectedPrompt
    if (template && template !== '__CUSTOM_SQL__') {
      setInput(applyPlaceholdersToTemplate(template, resolveSelectionsForTemplate(nextSelections)))
    }
  }

  const handleNormalPlaceholderChange = (nextSelections) => {
    setNormalPlaceholderSelections(nextSelections)
    const template = currentPrompts.find(p => p.value === selectedPrompt)?.value || selectedPrompt
    if (template) {
      setInput(applyPlaceholdersToTemplate(template, resolveSelectionsForTemplate(nextSelections)))
    }
  }

  const handleTemplateValue = (value) => {
    setSelectedTemplate(value)
    if (value) {
      setSqlTemplateRaw(value)
      setPlaceholderSelections({})
      setSqlQuery(buildSqlFromTemplate(value, selectedMemoryTable, {}))
    }
  }
  
  const handleSqlSubmit = () => {
    if (!sqlQuery.trim()) return
    // 将 SQL 查询转换为自然语言指令
    const command = `执行 SQL 查询并将结果导出到新文件：\n${sqlQuery}`
    setInput(command)
    setShowSqlBuilder(false)
    // 自动发送
    onSendCommand(command)
    setInput('')
    setSqlQuery('')
    setSelectedTemplate('')
    setSqlTemplateRaw('')
    setSelectedMemoryTable('')
    setPlaceholderSelections({})
    setSelectedPrompt('')
  }

  useEffect(() => {
    if (!largeFileMode || !showSqlBuilder || !largeFileInfo?.file_id) return
    const fetchMemoryTables = async () => {
      try {
        const baseUrl = (appConfig.apiBaseUrl || window.location.origin).replace(/\/$/, '')
        const response = await fetch(`${baseUrl}/api/large-file/memory-tables/${largeFileInfo.file_id}`)
        if (!response.ok) return
        const data = await response.json()
        const tables = Array.isArray(data.tables) ? data.tables : []
        const normalized = tables.map((table) => {
          const typeLabel = table.type === 'result' ? '结果表' : '源表'
          const tableName = table.table_name || ''
          const value = tableName ? `"${tableName}"` : (table.syntax || `{table:${table.name}}`)
          return {
            name: table.name,
            type: table.type,
            tableName,
            value,
            label: `${table.name}(${typeLabel})`
          }
        })
        setMemoryTables(prev => {
          const changed = JSON.stringify(prev.map(t => t.value)) !== JSON.stringify(normalized.map(t => t.value))
          if (changed) setSelectedMemoryTable('')
          return normalized
        })
      } catch (error) {
        console.warn('[AIAssistant] 获取内存表失败', error)
      }
    }
    fetchMemoryTables()
  }, [largeFileMode, showSqlBuilder, largeFileInfo?.file_id, activeSheet])

  // 快捷分析动态表单：获取工作表列表与列清单（session-info）
  useEffect(() => {
    if (!largeFileMode || platformView !== 'analyze' || !largeFileInfo?.file_id) return
    const fetchSessionInfo = async () => {
      setFetchedColumnsBySheet({})
      try {
        const baseUrl = (appConfig.apiBaseUrl || window.location.origin).replace(/\/$/, '')
        const response = await fetch(`${baseUrl}/api/large-file/session-info/${largeFileInfo.file_id}`)
        if (!response.ok) return
        const data = await response.json()
        const all = [...(data.source_tables || []), ...(data.result_tables || [])]
        const names = all.map(t => t.name).filter(Boolean)
        const colsMap = {}
        all.forEach(t => {
          if (t.name && Array.isArray(t.columns)) colsMap[t.name] = t.columns
        })
        setAnalyzeSheets(names)
        setAnalyzeColumnsBySheet(colsMap)
      } catch (error) {
        console.warn('[AIAssistant] 获取 session-info 失败', error)
      }
    }
    fetchSessionInfo()
  }, [largeFileMode, platformView, largeFileInfo?.file_id])

  // 按需获取列：当 session-info 与 workbook 均无某工作表列时，调用 preview 获取表头
  useEffect(() => {
    if (!largeFileMode || platformView !== 'analyze' || !largeFileInfo?.file_id) return
    const sheets = effectiveAnalyzeSheets
    if (!sheets.length) return
    const baseUrl = (appConfig.apiBaseUrl || window.location.origin).replace(/\/$/, '')
    const hasColumnsFromWorkbook = (name) => {
      const s = (workbook?.sheets || []).find(sh => sh?.name === name)
      if (!s?.data) return false
      const hRow = detectSheetHeaderRow(s.data)
      const headerRowData = s.data[hRow]
      return headerRowData && typeof headerRowData === 'object' && Object.keys(headerRowData).length > 0
    }
    sheets.forEach(async (sheetName) => {
      if (analyzeColumnsBySheet[sheetName]?.length > 0) return
      if (fetchedColumnsBySheet[sheetName]?.length > 0) return
      if (hasColumnsFromWorkbook(sheetName)) return
      try {
        const url = `${baseUrl}/api/large-file/preview/${largeFileInfo.file_id}?sheet_name=${encodeURIComponent(sheetName)}&limit=1`
        const res = await fetch(url)
        if (!res.ok) return
        const data = await res.json()
        const cols = data?.columns
        if (Array.isArray(cols) && cols.length > 0) {
          setFetchedColumnsBySheet(prev => ({ ...prev, [sheetName]: cols }))
        }
      } catch (e) {
        console.warn('[AIAssistant] 按需获取列失败', sheetName, e)
      }
    })
  }, [largeFileMode, platformView, largeFileInfo?.file_id, effectiveAnalyzeSheets, analyzeColumnsBySheet, fetchedColumnsBySheet, workbook?.sheets])

  useEffect(() => {
    if (!memoryTables.length) return
    if (selectedMemoryTable) return
    const matched = activeSheet
      ? memoryTables.find(table => table.name === activeSheet)
      : null
    if (matched) {
      setSelectedMemoryTable(matched.value)
      return
    }
    setSelectedMemoryTable(memoryTables[0].value)
  }, [memoryTables, activeSheet, selectedMemoryTable])

  useEffect(() => {
    if (!sqlTemplateRaw || !selectedMemoryTable) return
    setSqlQuery(buildSqlFromTemplate(sqlTemplateRaw, selectedMemoryTable, placeholderSelections))
  }, [sqlTemplateRaw, selectedMemoryTable, placeholderSelections])

  useEffect(() => {
    const onDocumentClick = (event) => {
      if (quickActionRef.current && !quickActionRef.current.contains(event.target)) {
        setQuickActionOpen(false)
      }
      if (memoryTableRef.current && !memoryTableRef.current.contains(event.target)) {
        setMemoryTableOpen(false)
      }
      if (sqlActionRef.current && !sqlActionRef.current.contains(event.target)) {
        setSqlActionOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocumentClick)
    return () => document.removeEventListener('mousedown', onDocumentClick)
  }, [])

  const selectedPromptLabel = useMemo(() => {
    const matched = currentPrompts.find((prompt) => prompt.value === selectedPrompt)
    return matched ? stripPromptPrefix(matched.label) : ''
  }, [currentPrompts, selectedPrompt])

  const selectedSqlTemplateLabel = useMemo(() => {
    const matched = SQL_TEMPLATES.find((tpl) => tpl.value === selectedTemplate)
    return matched ? stripPromptPrefix(matched.label) : ''
  }, [selectedTemplate])

  const displayFileName = useMemo(() => {
    const candidate = largeFileInfo?.original_name || currentFileName || 'workbook'
    if (/\.(xlsx|xls|xlsm|csv)$/i.test(candidate)) return candidate
    return `${candidate}.xlsx`
  }, [largeFileInfo?.original_name, currentFileName])

  const displaySheetCount = useMemo(() => {
    const count = Number(currentSheetCount)
    return Number.isFinite(count) && count > 0 ? count : 1
  }, [currentSheetCount])

  const modeLineText = useMemo(() => {
    if (platformView === 'analyze') return '只读模式 | 结果导出保存'
    if (platformView === 'report') return '生成PPT并保存'
    if (platformView === 'reportCard') return '生成报表并保存'
    return '写模式 | 结果自动保存'
  }, [platformView])

  const selectedMemoryTableLabel = useMemo(() => {
    const matched = memoryTables.find((table) => table.value === selectedMemoryTable)
    return matched ? matched.label : ''
  }, [memoryTables, selectedMemoryTable])

  useEffect(() => {
    if (!largeFileMode || !openSqlBuilderSignal) return
    openCustomSqlBuilder()
  }, [largeFileMode, openSqlBuilderSignal])

  useEffect(() => {
    if (platformView === 'analyze') return
    setShowSqlBuilder(false)
    setSqlActionOpen(false)
    setMemoryTableOpen(false)
    setAnalyzePlaceholderSelections({})
    setNormalPlaceholderSelections({})
    if (selectedPrompt === '__CUSTOM_SQL__') {
      setSelectedPrompt('')
    }
  }, [platformView, selectedPrompt])
  
  // 当面板关闭时，不在这里渲染按钮，而是在App.jsx中渲染
  if (!open) {
    return null
  }
  
  return (
    <div className="ai-panel" data-tour="ai-assistant" data-platform-view={platformView || 'normal'}>
      <div className="ai-panel-header">
        <div className="ai-panel-header-main">
          <span className="ai-header-icon-chip" aria-hidden>
            <Bot size={18} className="ai-header-icon" />
          </span>
          <h3 className="ai-panel-title-text">AI 助手</h3>
          <span className="ai-view-badge">{currentViewLabel}</span>
        </div>
        <div className="ai-panel-header-actions">
          <button
            type="button"
            onClick={onClearBackendMessages}
            className="ai-panel-clear-btn"
            title="清空后端回复消息"
          >
            清空回复
          </button>
          <button type="button" onClick={onClose} className="ai-close-btn" title="关闭">
            <X size={18} />
          </button>
        </div>
      </div>
      
      {/* 文件状态提示（各视图统一） */}
      <div className="large-file-indicator border-b px-4 py-2 text-sm">
        <div className="font-medium file-name">
          <FileSpreadsheet size={14} className="ai-file-icon" />
          <span>{displayFileName}</span>
        </div>
        <div className="text-xs file-info">
          {displaySheetCount.toLocaleString()} 张工作表 | {modeLineText}
        </div>
      </div>
      
      <div className="ai-panel-scroll-body">
        {/* 预设提示词区域 - 始终显示在顶部 */}
        {/* 预设提示词下拉框 - 报表模式改为分析视角快捷区，汇报模式隐藏 */}
        {platformView !== 'report' && platformView !== 'collect' && platformView !== 'connect' && (
          <div className="mb-4">
            {platformView === 'reportCard' ? (
              <div className="report-perspective-bar">
                <div className="report-perspective-header">
                  <Sparkles size={14} className="ai-perspective-icon" />
                  <span>分析视角</span>
                </div>
                <div className="report-perspective-chips">
                  {REPORT_PERSPECTIVE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      className="report-perspective-chip"
                      onClick={() => {
                        // click also sets textarea input so label stays in sync
                        setInput(preset.prompt)
                        setSelectedPrompt(preset.prompt)
                      }}
                      title={preset.prompt}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : largeFileMode ? (
              <>
                <div className="ai-quick-action" ref={quickActionRef}>
                  <button
                    type="button"
                    disabled={duckdbLoading || !isConnected || !isReady || isProcessing}
                    className="ai-quick-action-trigger ai-dark-select"
                    onClick={() => {
                      setSqlActionOpen(false)
                      setQuickActionOpen((prev) => !prev)
                    }}
                  >
                    <span className="ai-quick-action-trigger-text">
                      {selectedPromptLabel || '请选择分析操作...'}
                    </span>
                    <ChevronDown
                      size={14}
                      className={`ai-quick-action-chevron ${quickActionOpen ? 'open' : ''}`}
                    />
                  </button>
                  {quickActionOpen && (
                    <div className="ai-quick-action-menu">
                      {currentPrompts.map((prompt, index) => {
                        const isHeader = prompt.type === 'header' || (!prompt.value && !prompt.type)
                        const cleanLabel = stripPromptPrefix(prompt.label)
                        const { Icon, color } = resolvePromptIcon(prompt.label, prompt.type)
                        if (isHeader) {
                          return (
                            <div key={`${prompt.label}-${index}`} className="ai-quick-action-header">
                              <Icon size={13} style={{ color }} />
                              <span>{cleanLabel}</span>
                            </div>
                          )
                        }
                        return (
                          <button
                            key={`${prompt.label}-${index}`}
                            type="button"
                            className="ai-quick-action-item"
                            onClick={() => {
                              handlePromptValue(prompt.value)
                              setQuickActionOpen(false)
                            }}
                          >
                            <Icon size={14} style={{ color }} />
                            <span>{cleanLabel}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="goal-presets-list">
                <div className="goal-presets-header">
                  <Lightbulb size={14} />
                  <span>试试这样问我</span>
                </div>
                {GOAL_PRESETS.map((preset, idx) => {
                  const Icon = preset.icon
                  const isDisabled = !isConnected || !isReady || isProcessing || isPreparingOneClickWorkbook
                  if (preset.type === 'formula') {
                    return (
                      <div key={idx} className="goal-preset-row-group">
                        <button
                          type="button"
                          className="goal-preset-row"
                          disabled={isDisabled}
                          onClick={() => setFormulaPresetOpen(p => !p)}
                        >
                          <GoalPresetIconChip Icon={Icon} tone={preset.tone} />
                          <span className="goal-preset-text">{preset.text}</span>
                          {formulaPresetOpen
                            ? <ChevronDown size={14} className="goal-preset-arrow" />
                            : <ChevronRight size={14} className="goal-preset-arrow" />}
                        </button>
                        {formulaPresetOpen && (
                          <div className="goal-preset-formula-panel">
                            <select className="goal-preset-select" value={fpSheet} onChange={e => handleFpSelect('sheet', e.target.value)}>
                              <option value="">选择工作表</option>
                              {effectiveNormalSheets.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                            <select className="goal-preset-select" value={fpColumn} onChange={e => handleFpSelect('column', e.target.value)} disabled={!fpSheet}>
                              <option value="">选择目标列</option>
                              {(effectiveNormalColumnsBySheet[fpSheet] || []).map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <select
                              className="goal-preset-select"
                              value={fpFormula}
                              onChange={(e) => {
                                const next = e.target.value
                                if (next === ADD_CUSTOM_FORMULA_VALUE) {
                                  onOpenFormulaManager?.()
                                  return
                                }
                                handleFpSelect('formula', next)
                              }}
                            >
                              <option value="">{customFormulas.length ? '选择自定义公式' : '暂无自定义公式'}</option>
                              {buildCustomFormulaOptions(customFormulas).map((f) => (
                                <option key={f.value} value={f.value}>{f.label}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )
                  }
                  return (
                    <button
                      key={idx}
                      type="button"
                      className="goal-preset-row"
                      disabled={isDisabled}
                      onClick={async () => {
                        setFormulaPresetOpen(false)
                        if (preset.type === 'oneclick') {
                          let nextHasSelectedWorkbook = hasSelectedWorkbook
                          let nextCurrentSheetIsEmpty = currentSheetIsEmpty
                          if (!hasSelectedWorkbook && typeof onEnsureWorkbookForOneClickSheet === 'function') {
                            setIsPreparingOneClickWorkbook(true)
                            try {
                              const created = await onEnsureWorkbookForOneClickSheet()
                              if (created) { nextHasSelectedWorkbook = true; nextCurrentSheetIsEmpty = true }
                            } finally { setIsPreparingOneClickWorkbook(false) }
                          }
                          setInput(buildOneClickSheetPrompt(preset.label, preset.body, {
                            hasSelectedWorkbook: nextHasSelectedWorkbook,
                            currentSheetIsEmpty: nextCurrentSheetIsEmpty,
                          }))
                          setSelectedPrompt('')
                        } else {
                          setInput(preset.text)
                          setSelectedPrompt('')
                        }
                      }}
                    >
                      <GoalPresetIconChip Icon={Icon} tone={preset.tone} />
                      <span className="goal-preset-text">{preset.text}</span>
                      <ChevronRight size={14} className="goal-preset-arrow" />
                    </button>
                  )
                })}
                <div className="goal-ai-suggest-wrap">
                  <button
                    type="button"
                    className="goal-ai-suggest-trigger"
                    title={
                      !hasSelectedWorkbook
                        ? '请先在左侧「文件管理」中打开工作簿'
                        : '根据当前工作簿结构生成 5 条简单、可执行的指令（会写明工作表名）'
                    }
                    disabled={
                      !isConnected || !isReady || isProcessing || isPreparingOneClickWorkbook
                      || aiSuggestLoading || !accessToken
                    }
                    onClick={() => { setFormulaPresetOpen(false); fetchAiSuggestions() }}
                  >
                    <Sparkles size={16} className="goal-ai-suggest-icon" />
                    <span className="goal-ai-suggest-title">
                     不知道下什么指令？点我打开思路(Beta)
                    </span>
                    {aiSuggestLoading ? <Loader2 size={16} className="goal-ai-suggest-spin" /> : null}
                  </button>
                  {aiSuggestError ? (
                    <div className="goal-ai-suggest-error">{aiSuggestError}</div>
                  ) : null}
                  {aiSuggestList.length > 0 ? (
                    <select
                      className="goal-ai-suggest-select"
                      value={aiSuggestPick}
                      onChange={(e) => {
                        const v = e.target.value
                        setAiSuggestPick(v)
                        if (v) {
                          setInput(v)
                          setSelectedPrompt('')
                        }
                      }}
                    >
                      <option value="">选择一条 AI 生成的指令填入输入框</option>
                      {aiSuggestList.map((s, i) => (
                        <option key={i} value={s}>
                          {s.length > 72 ? `${s.slice(0, 69)}` + '…' : s}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              </div>
            )}

            {/* 大文件快捷指令 → 表单间距 */}
            {largeFileMode && platformView === 'analyze' && selectedPrompt && selectedPrompt !== '__CUSTOM_SQL__' && !showSqlBuilder && (
              <div style={{ height: 24 }} />
            )}

            {/* 快捷分析动态表单（大文件模式 + 非 SQL 操作） */}
            {largeFileMode && platformView === 'analyze' && selectedPrompt && selectedPrompt !== '__CUSTOM_SQL__' && !showSqlBuilder && (
              <AnalyzeQuickForm
                template={selectedPrompt}
                sheets={effectiveAnalyzeSheets}
                columnsBySheet={effectiveColumnsBySheet}
                defaultSheet={activeSheet || effectiveAnalyzeSheets[0] || ''}
                selections={analyzePlaceholderSelections}
                onSelectionsChange={handleAnalyzePlaceholderChange}
                disabled={duckdbLoading || !isConnected || !isReady || isProcessing}
                customFormulas={customFormulas}
                onOpenFormulaManager={onOpenFormulaManager}
              />
            )}

          </div>
        )}
        
        {/* SQL 查询构建器 - 仅在大文件模式下选择自定义 SQL 时显示 */}
        {showSqlBuilder && largeFileMode && platformView === 'analyze' && (
          <div className="mb-4 p-4 rounded-lg ai-dark-section ai-sql-builder">
            <div className="flex items-center gap-2 mb-3">
              <Database size={18} className="ai-sql-builder-icon" />
              <span className="font-medium ai-sql-builder-title">自定义 SQL 查询</span>
              <button
                onClick={() => setShowSqlBuilder(false)}
                className="ml-auto ai-sql-close-btn"
              >
                <X size={16} />
              </button>
            </div>

            {/* 内存表选择 */}
            <div className="mb-3">
              <label className="text-xs mb-1 block ai-sql-label">内存表：</label>
              <div className="ai-quick-action" ref={memoryTableRef}>
                <button
                  type="button"
                  className="ai-quick-action-trigger ai-dark-select"
                  onClick={() => {
                    setQuickActionOpen(false)
                    setSqlActionOpen(false)
                    setMemoryTableOpen((prev) => !prev)
                  }}
                >
                  <span className="ai-quick-action-trigger-text">
                    {selectedMemoryTableLabel || '请选择内存表...'}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`ai-quick-action-chevron ${memoryTableOpen ? 'open' : ''}`}
                  />
                </button>
                {memoryTableOpen && (
                  <div className="ai-quick-action-menu">
                    {memoryTables.map((table, index) => (
                      <button
                        key={`${table.name}-${index}`}
                        type="button"
                        className="ai-quick-action-item"
                        onClick={() => {
                          handleMemoryTableValue(table.value)
                          setMemoryTableOpen(false)
                        }}
                      >
                        <FileSpreadsheet size={14} style={{ color: '#60A5FA' }} />
                        <span>{table.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            
            {/* SQL 模板选择 */}
            <div className="mb-3">
              <label className="text-xs mb-1 block ai-sql-label">选择操作：</label>
              <div className="ai-quick-action" ref={sqlActionRef}>
                <button
                  type="button"
                  className="ai-quick-action-trigger ai-dark-select"
                  onClick={() => {
                    setQuickActionOpen(false)
                    setSqlActionOpen((prev) => !prev)
                  }}
                >
                  <span className="ai-quick-action-trigger-text">
                    {selectedSqlTemplateLabel || '选择操作...'}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`ai-quick-action-chevron ${sqlActionOpen ? 'open' : ''}`}
                  />
                </button>
                {sqlActionOpen && (
                  <div className="ai-quick-action-menu">
                    {SQL_TEMPLATES.map((template, index) => {
                      const cleanLabel = stripPromptPrefix(template.label)
                      const { Icon, color } = resolveSqlTemplateIcon(template.label)
                      return (
                        <button
                          key={`${template.label}-${index}`}
                          type="button"
                          className="ai-quick-action-item"
                          onClick={() => {
                            handleTemplateValue(template.value)
                            setSqlActionOpen(false)
                          }}
                        >
                          <Icon size={14} style={{ color }} />
                          <span>{cleanLabel}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            
            {/* SQL 输入框 */}
            <div className="mb-3">
              <label className="text-xs mb-1 block ai-sql-label" style={{ color: '#B3B3B3' }}>
                SQL 语句：
              </label>
              <textarea
                value={sqlQuery}
                onChange={(e) => {
                  setSqlQuery(e.target.value)
                  if (sqlTemplateRaw) setSqlTemplateRaw('')
                }}
                placeholder="SELECT * FROM {table} WHERE ..."
                rows={10}
                className="w-full rounded px-3 py-2 text-sm font-mono focus:outline-none ai-dark-input"
              />
            </div>

            {placeholderTokens.length > 0 && (
              <div className="mb-3">
                <label className="text-xs mb-1 block ai-sql-label" style={{ color: '#B3B3B3' }}>多表占位符：</label>
                <div className="space-y-2">
                  {placeholderTokens.map((token, idx) => (
                    <div key={token} className="flex flex-col gap-2 px-2 py-2 rounded-lg ai-dark-section">
                      <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: '#B3B3B3' }}>{idx + 1}.占位符</span>
                        <code className="px-2 py-0.5 rounded text-xs whitespace-nowrap" style={{ background: '#1E1E1E', color: '#34D399' }}>{token}</code>
                      </div>
                      <select
                        value={placeholderSelections[token] || ''}
                        onChange={(e) => handlePlaceholderSelect(token, e.target.value)}
                        className="w-full rounded px-2 py-1 text-xs focus:outline-none ai-dark-select"
                      >
                        <option value="">选择内存表</option>
                        {memoryTables.map((table, index) => (
                          <option key={`${token}-${table.name}-${index}`} value={table.value}>
                            {table.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* SQL 语法提示 */}
            <div className="mb-3 text-xs p-2 rounded ai-dark-section ai-sql-help" style={{ color: '#B3B3B3' }}>
              <p className="font-medium mb-1" style={{ color: '#E5E5E5' }}>工作表引用：</p>
              <ul className="list-disc list-inside space-y-0.5 mb-2">
                <li><code style={{ background: '#1E1E1E', color: '#34D399', padding: '0 4px', borderRadius: 3 }}>{'{table}'}</code> - 引用当前选择的工作表</li>
                <li><code style={{ background: '#1E1E1E', color: '#34D399', padding: '0 4px', borderRadius: 3 }}>{'{table:工作表名}'}</code> - 引用指定工作表（跨表查询）</li>
              </ul>
              <p className="font-medium mb-1" style={{ color: '#E5E5E5' }}>跨表关联示例：</p>
              <code className="block p-1 rounded text-xs mb-2 ai-sql-codeblock" style={{ background: '#1E1E1E', color: '#E5E5E5' }}>
                SELECT * FROM {'{table:销售明细}'} s<br/>
                JOIN {'{table:客户明细}'} c ON s.客户ID = c.客户ID
              </code>
              <p className="font-medium mb-1" style={{ color: '#E5E5E5' }}>常用语法：</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>WHERE 列名 {'>'} 值 / = '文本' / LIKE '%关键词%'</li>
                <li>GROUP BY 列名 + SUM/AVG/COUNT/MAX/MIN</li>
                <li>ORDER BY 列名 ASC/DESC，LIMIT 数量</li>
                <li>特殊列名用双引号："销售额(净额)"</li>
              </ul>
            </div>
            
            {/* 执行按钮 */}
            <button
              onClick={handleSqlSubmit}
              disabled={!sqlQuery.trim() || isProcessing || duckdbLoading}
              className="w-full text-white px-4 py-2 rounded disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: '#217346' }}
              data-ui="ai-sql-run-btn"
            >
              <Send size={16} />
              执行SQL
            </button>
          </div>
        )}
        
        {/* 消息列表 */}
        {visibleMessageEntries.length > 0 && (
          <div className="space-y-2 mb-4">
            {visibleMessageEntries.map(({ msg, key: rowKey }) => {
              // 根据消息类型设置样式
              const getMessageStyle = () => {
                switch (msg.type) {
                  case 'user':
                    return { backgroundColor: '#217346', color: 'white' }
                  case 'success':
                    return {
                      backgroundColor: 'rgba(16, 185, 129, 0.12)',
                      color: '#A7F3D0',
                      border: '1px solid rgba(52, 211, 153, 0.4)',
                    }
                  case 'error':
                    return { backgroundColor: 'rgba(220, 38, 38, 0.15)', color: '#FCA5A5' }
                  case 'status':
                    return { 
                      backgroundColor: 'rgba(59, 130, 246, 0.15)', 
                      color: '#93C5FD', 
                      borderLeft: '3px solid #3b82f6',
                      animation: 'pulse 2s infinite'
                    }
                  case 'upload_progress':
                    return {
                      backgroundColor: 'rgba(16, 185, 129, 0.12)',
                      color: '#86efac',
                      borderLeft: '3px solid #10b981'
                    }
                  case 'thinking':
                    return { backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#FCD34D', borderLeft: '3px solid #f59e0b' }
                  case 'tool_call':
                    return { backgroundColor: 'rgba(99, 102, 241, 0.15)', color: '#A5B4FC', borderLeft: '3px solid #6366f1' }
                  case 'tool_result':
                    return { backgroundColor: 'rgba(16, 185, 129, 0.15)', color: '#6EE7B7', borderLeft: '3px solid #10b981' }
                  case 'warning':
                    return { backgroundColor: 'rgba(234, 179, 8, 0.15)', color: '#FDE68A', borderLeft: '3px solid #eab308' }
                  case 'backend_progress':
                    return { 
                      backgroundColor: 'rgba(2, 132, 199, 0.15)', 
                      color: '#7DD3FC', 
                      borderLeft: '3px solid #0284c7',
                      fontSize: '13px'
                    }
                  default:
                    return { backgroundColor: '#2A2A2A', color: '#E5E5E5' }
                }
              }
              
              const getMessageClass = () => {
                if (msg.type === 'user') return 'user'
                if (msg.type === 'error') return 'error'
                return 'assistant'
              }
              
              const assistantContent = msg.content?.startsWith('✅') || msg.content?.startsWith('操作完成！')
                ? `\n${msg.content}`
                : msg.content

              return (
                <div
                  key={rowKey}
                  className={`ai-message ${getMessageClass()}${isPromptChromeMessage(msg) ? ' ai-message--prompt' : ''}`}
                  style={getMessageStyle()}
                >
                  {isPromptChromeMessage(msg) && (
                    <button
                      type="button"
                      className="ai-prompt-dismiss"
                      onClick={() => dismissPromptMessage(rowKey)}
                      aria-label="关闭此提示"
                    >
                      <X size={14} strokeWidth={2} aria-hidden />
                    </button>
                  )}
                  {msg.type === 'thinking' ? (
                    <div className="flex items-start gap-2 ai-thinking-exec-row">
                      <RefreshCw
                        size={16}
                        className="flex-shrink-0 mt-0.5 ai-thinking-exec-spin"
                        strokeWidth={2.25}
                        aria-hidden
                      />
                      <div className="flex-1 min-w-0 whitespace-pre-wrap text-[13px] leading-relaxed">
                        {stripExecutingWrenchPrefix(msg.content)}
                      </div>
                    </div>
                  ) : msg.type === 'assistant' ? (
                    isWrenchExecutingContent(assistantContent) ? (
                      <div className="flex items-start gap-2 ai-thinking-exec-row">
                        <RefreshCw
                          size={16}
                          className="flex-shrink-0 mt-0.5 ai-thinking-exec-spin"
                          strokeWidth={2.25}
                          aria-hidden
                        />
                        <div className="flex-1 min-w-0 ai-assistant-message">
                          <ReactMarkdown components={markdownComponents}>
                            {stripExecutingWrenchPrefix(assistantContent)}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <div className="ai-assistant-message">
                        <ReactMarkdown components={markdownComponents}>
                          {assistantContent}
                        </ReactMarkdown>
                      </div>
                    )
                  ) : msg.type === 'status' ? (
                    <div className="flex items-start gap-2">
                      <Loader2 className="animate-spin flex-shrink-0 mt-0.5" size={16} />
                      <div className="flex-1">
                        <ReactMarkdown className="whitespace-pre-wrap" components={markdownComponents}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  ) : msg.type === 'upload_progress' ? (
                    <div className="flex flex-col gap-2">
                      <div className="text-xs">{msg.content}</div>
                      <div style={{ height: 8, borderRadius: 999, background: 'rgba(148, 163, 184, 0.25)', overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.max(0, Math.min(100, Number(msg.progress) || 0))}%`,
                            background: '#10b981',
                            transition: 'width 0.2s ease'
                          }}
                        />
                      </div>
                    </div>
                  ) : msg.type === 'backend_progress' ? (
                    // 后端操作进度 - 使用 Markdown 渲染（支持代码块高亮）
                    <div className="backend-progress-message">
                      <ReactMarkdown
                        components={{
                          ...markdownComponents,
                          code: ({ node, inline, className, children, ...props }) => {
                            if (inline) {
                              return <code className="bg-sky-100 px-1 rounded text-sky-800" {...props}>{children}</code>
                            }
                            return (
                              <pre className="bg-sky-900 text-sky-100 p-2 rounded text-xs overflow-x-auto my-1">
                                <code {...props}>{children}</code>
                              </pre>
                            )
                          }
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : msg.type === 'tool_call' || msg.type === 'tool_result' ? (
                    <pre className="text-xs whitespace-pre-wrap font-mono">{msg.content}</pre>
                  ) : (
                    msg.content
                  )}
                </div>
              )
            })}
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* ── 执行状态浮动条：始终可见，不随消息滚动 ── */}
      {executionProgress && (
        <div className={`ai-execution-status-bar ${executionProgress.phase === 'error' ? 'ai-execution-error' : ''} ${executionProgress.phase === 'done' ? 'ai-execution-done' : ''}`}>
          <div className="ai-execution-status-inner">
            {executionProgress.phase === 'error' ? (
              <AlertCircle className="ai-execution-icon-error" size={14} />
            ) : executionProgress.phase === 'done' ? (
              <CheckCircle2 className="ai-execution-icon-done" size={14} />
            ) : (
              <Loader2 className="animate-spin ai-execution-spinner" size={14} />
            )}
            <span className="ai-execution-label">
              {executionProgress.phase === 'thinking'
                ? 'AI 正在分析与规划...'
                : executionProgress.phase === 'executing'
                  ? `正在执行操作${executionProgress.opCount > 0 ? `（已完成 ${executionProgress.opCount} 个）` : ''}...`
                  : executionProgress.phase === 'done'
                    ? `执行完成（共 ${executionProgress.opCount} 个操作）`
                    : '操作未能完成，请重试'
              }
            </span>
            {executionProgress.lastOpDesc && executionProgress.phase === 'executing' && (
              <span className="ai-execution-detail">{executionProgress.lastOpDesc}</span>
            )}
          </div>
          {(executionProgress.phase === 'thinking' || executionProgress.phase === 'executing') && (
            <div className="ai-execution-progress-track">
              <div className="ai-execution-progress-pulse" />
            </div>
          )}
        </div>
      )}
      
      <div className="ai-footer-area">
        <div className="ai-footer-row">
          <textarea
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                if (platformView === 'reportCard' && input.trim()) {
                  window.dispatchEvent(new CustomEvent('report:custom-prompt', { detail: { prompt: input.trim() } }))
                  setInput('')
                  return
                }
                handleSend()
              }
            }}
            placeholder={
              platformView === 'reportCard'
                ? "输入自定义分析视角，提交后将以此视角重新生成报表..."
                : platformView === 'collect'
                  ? "数据收集视图暂不支持发送 AI 指令"
                  : platformView === 'connect'
                  ? "数据接入视图暂不支持发送 AI 指令"
                : largeFileMode
                  ? (duckdbLoading ? "数据加载中，请等待全部完成后操作..." : "输入分析指令（结果将导出到新文件）...")
                  : (isConnected && isReady ? "输入Excel操作指令..." : "等待连接...")
            }
            disabled={
              platformView === 'report' 
                ? true 
                : platformView === 'collect'
                  ? true
                : platformView === 'connect'
                  ? true
                : largeFileMode 
                  ? (isProcessing || isPreparingOneClickWorkbook || duckdbLoading)
                  : (!isConnected || !isReady || isProcessing || isPreparingOneClickWorkbook)
            }
            className="ai-footer-textarea"
          />
          <button
            onClick={() => {
              if (platformView === 'reportCard' && input.trim()) {
                window.dispatchEvent(new CustomEvent('report:custom-prompt', { detail: { prompt: input.trim() } }))
                setInput('')
                return
              }
              handleSend()
            }}
            disabled={
              platformView === 'report' 
                ? true 
                : platformView === 'collect'
                  ? true
                : platformView === 'connect'
                  ? true
                : largeFileMode 
                  ? (isProcessing || isPreparingOneClickWorkbook || duckdbLoading || !input.trim())
                  : (!isConnected || !isReady || isProcessing || isPreparingOneClickWorkbook || !input.trim())
            }
            className="ai-footer-send-btn"
          >
            <Send size={18} />
            <span style={{ fontSize: 13 }}>{platformView === 'reportCard' ? '生成' : '发送'}</span>
          </button>
        </div>
        {!isConnected && (
          <p style={{ fontSize: 13, color: '#F87171', marginTop: 6 }}>未连接到服务器</p>
        )}
      </div>
    </div>
  )
}

export default AIAssistant
