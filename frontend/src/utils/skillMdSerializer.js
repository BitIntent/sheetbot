/**
 * SKILL.md 序列化/反序列化
 *
 * 对齐 agentskills.io 标准格式：
 * - YAML frontmatter: name, description, tags, version
 * - Markdown body: ## Steps 下的 JSON code block
 *
 * 通用 SKILL.md 导出（toUniversalMarkdown）：
 * - 面向 Claude Code / Cursor 等外部 Agent 的行业标准格式
 * - 含自然语言步骤描述、openpyxl 参考实现、变量字典、执行环境声明
 */

import { getRefImpl, hasRefImpl } from './skillRefImpl'
import { SKILL_CONFIGS } from '../components/skillOperationConfigs'

// ----------------------------------------------------------------
// 导出 Skill -> SKILL.md 字符串（内部格式）
// ----------------------------------------------------------------

/**
 * 将技能对象序列化为 SKILL.md 格式字符串
 * @param {object} skill - { name, description, tags, scope, steps }
 * @returns {string}
 */
export function toMarkdown(skill) {
  const tags = (skill.tags || []).join(', ')
  const stepsJson = JSON.stringify(skill.steps || [], null, 2)

  const lines = [
    '---',
    `name: ${skill.name || ''}`,
    `description: ${skill.description || ''}`,
    tags ? `tags: [${tags}]` : 'tags: []',
    'version: 1.0.0',
    '---',
    '',
    `# ${skill.name || 'Skill'}`,
    '',
    `> ${skill.description || ''}`,
    '',
    '## Scope',
    '',
    '```json',
    JSON.stringify(skill.scope || { mode: 'all_sheets' }, null, 2),
    '```',
    '',
    '## Steps',
    '',
    '```json',
    stepsJson,
    '```',
  ]

  return lines.join('\n')
}

/**
 * 触发浏览器下载 SKILL.md 文件
 * @param {object} skill
 */
export function downloadSkillMd(skill) {
  const content = toMarkdown(skill)
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${skill.name || 'skill'}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ----------------------------------------------------------------
// 导入 SKILL.md 字符串 -> Skill 对象
// ----------------------------------------------------------------

/**
 * 解析 SKILL.md 格式字符串，返回技能对象
 * @param {string} mdText
 * @returns {{ name, description, tags, scope, steps } | null}
 */
export function fromMarkdown(mdText) {
  try {
    const frontmatter = parseFrontmatter(mdText)
    if (!frontmatter.name) return null

    const scope = extractJsonBlock(mdText, 'Scope') || { mode: 'all_sheets' }
    const steps = extractJsonBlock(mdText, 'Steps') || []

    return {
      name: frontmatter.name,
      description: frontmatter.description || '',
      tags: parseTags(frontmatter.tags),
      scope,
      steps: Array.isArray(steps) ? steps : [],
    }
  } catch {
    return null
  }
}

// ----------------------------------------------------------------
// 内部工具
// ----------------------------------------------------------------

/**
 * 解析 YAML frontmatter（只支持简单 key: value，无嵌套）
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const result = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    result[key] = val
  }
  return result
}

/**
 * 提取 ## {section} 下第一个 ```json ... ``` 代码块
 */
function extractJsonBlock(text, section) {
  const sectionRe = new RegExp(`##\\s+${section}[\\s\\S]*?\`\`\`json\\n([\\s\\S]*?)\`\`\``)
  const match = text.match(sectionRe)
  if (!match) return null
  return JSON.parse(match[1])
}

/**
 * 解析 tags 字段：支持 "[格式, 报表]" 或 "格式, 报表"
 */
function parseTags(tagsStr) {
  if (!tagsStr) return []
  const clean = tagsStr.replace(/^\[|\]$/g, '').trim()
  if (!clean) return []
  return clean.split(',').map(t => t.trim()).filter(Boolean)
}

// ----------------------------------------------------------------
// 通用 SKILL.md 导出 - 面向外部 Code Agent
// ----------------------------------------------------------------

// 变量语义字典：{{变量名}} -> { desc, compute, example }
const VARIABLE_DICT = {
  'sheet.range':         { desc: '工作表已使用区域范围',       compute: 'ws.min_row:ws.max_row, ws.min_column:ws.max_column', example: 'A1:H50' },
  'sheet.firstRow':      { desc: '第一行有数据的行号',         compute: 'ws.min_row', example: '1' },
  'sheet.lastRow':       { desc: '最后一行有数据的行号',       compute: 'ws.max_row', example: '50' },
  'sheet.firstCol':      { desc: '第一列有数据的列号（数字）', compute: 'ws.min_column', example: '1' },
  'sheet.lastCol':       { desc: '最后一列有数据的列号（数字）', compute: 'ws.max_column', example: '8' },
  'sheet.firstColLetter':{ desc: '第一列有数据的列字母',       compute: 'get_column_letter(ws.min_column)', example: 'A' },
  'sheet.lastColLetter': { desc: '最后一列有数据的列字母',     compute: 'get_column_letter(ws.max_column)', example: 'H' },
  'sheet.rowCount':      { desc: '有数据的行数',               compute: 'ws.max_row - ws.min_row + 1', example: '50' },
  'sheet.colCount':      { desc: '有数据的列数',               compute: 'ws.max_column - ws.min_column + 1', example: '8' },
}

/**
 * 扫描所有步骤中的 {{...}} 变量引用
 */
function collectVariables(steps) {
  const vars = new Set()
  const re = /\{\{([^}]+)\}\}/g
  for (const step of steps || []) {
    const params = step.params || {}
    for (const val of Object.values(params)) {
      const str = String(val)
      let m
      while ((m = re.exec(str)) !== null) {
        vars.add(m[1])
      }
    }
  }
  return [...vars]
}

/**
 * 将技能类型翻译为自然语言步骤描述
 */
function stepDescription(step) {
  const cfg = SKILL_CONFIGS[step.operation_type]
  if (!cfg) return step.label || step.operation_type
  const parts = [cfg.description]
  const p = step.params || {}
  if (p.range) parts.push(`范围: ${p.range}`)
  if (p.cell) parts.push(`单元格: ${p.cell}`)
  if (p.column) parts.push(`列: ${p.column}`)
  return parts.join('，')
}

/**
 * 将参数对象格式化为 Markdown 表格行
 */
function paramsTable(params) {
  if (!params || Object.keys(params).length === 0) return ''
  const rows = ['| 参数 | 值 |', '|------|-----|']
  for (const [k, v] of Object.entries(params)) {
    rows.push(`| \`${k}\` | \`${JSON.stringify(v)}\` |`)
  }
  return rows.join('\n')
}

/**
 * 将技能对象导出为通用 SKILL.md（面向外部 Code Agent）
 *
 * 格式特点：
 * - YAML frontmatter（name/description/tags/version/author/format）
 * - Environment 段：目标格式、推荐库、安装命令
 * - Variables 段：动态变量表
 * - Step N 段：自然语言描述 + openpyxl 参考实现 + 参数表
 * - Expected Result 段：预期效果汇总
 */
export function toUniversalMarkdown(skill) {
  const steps = skill.steps || []
  const tags = (skill.tags || []).join(', ')
  const usedVars = collectVariables(steps)

  const lines = []

  // === YAML Frontmatter ===
  lines.push('---')
  lines.push(`name: "${skill.name || ''}"`)
  lines.push(`description: "${skill.description || ''}"`)
  lines.push(tags ? `tags: [${tags}]` : 'tags: []')
  lines.push('version: 1.0.0')
  lines.push('author: SheetBot')
  lines.push('format: universal')
  lines.push('---')
  lines.push('')

  // === Title & Description ===
  lines.push(`# ${skill.name || 'Skill'}`)
  lines.push('')
  if (skill.description) {
    lines.push(`> ${skill.description}`)
    lines.push('')
  }

  // === Environment ===
  lines.push('## Environment')
  lines.push('')
  lines.push('- **Target Format**: `.xlsx` (Excel 2007+)')
  lines.push('- **Recommended Library**: [openpyxl](https://openpyxl.readthedocs.io/) (Python)')
  lines.push('- **Install**: `pip install openpyxl`')
  lines.push('- **Alternative**: ExcelJS (Node.js), xlsxwriter (Python)')
  lines.push('')
  lines.push('```python')
  lines.push('from openpyxl import load_workbook')
  lines.push('')
  lines.push('wb = load_workbook("input.xlsx")')
  lines.push('ws = wb.active  # or wb["SheetName"]')
  lines.push('```')
  lines.push('')

  // === Variables ===
  if (usedVars.length > 0) {
    lines.push('## Variables')
    lines.push('')
    lines.push('以下变量在执行时需根据实际工作表动态计算：')
    lines.push('')
    lines.push('| 变量 | 含义 | 计算方式 | 示例 |')
    lines.push('|------|------|----------|------|')
    for (const v of usedVars) {
      const dict = VARIABLE_DICT[v]
      if (dict) {
        lines.push(`| \`{{${v}}}\` | ${dict.desc} | \`${dict.compute}\` | \`${dict.example}\` |`)
      } else {
        lines.push(`| \`{{${v}}}\` | 自定义变量 | 根据上下文确定 | - |`)
      }
    }
    lines.push('')
  }

  // === Steps ===
  lines.push('## Steps')
  lines.push('')
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const label = step.label || `步骤 ${i + 1}`
    const opType = step.operation_type

    lines.push(`### Step ${i + 1}: ${label}`)
    lines.push('')
    lines.push(stepDescription(step))
    lines.push('')

    // 参数表
    const pt = paramsTable(step.params)
    if (pt) {
      lines.push('**Parameters:**')
      lines.push('')
      lines.push(pt)
      lines.push('')
    }

    // openpyxl 参考实现
    const ref = hasRefImpl(opType) ? getRefImpl(opType, step.params || {}) : null
    if (ref && ref.code) {
      lines.push('<details>')
      lines.push('<summary>openpyxl Reference Implementation</summary>')
      lines.push('')
      lines.push('```python')
      if (ref.imports && ref.imports.length > 0) {
        lines.push(ref.imports.join('\n'))
        lines.push('')
      }
      lines.push(ref.code)
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  // === Expected Result ===
  lines.push('## Expected Result')
  lines.push('')
  if (steps.length === 0) {
    lines.push('（无执行步骤）')
  } else {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const cfg = SKILL_CONFIGS[step.operation_type]
      const desc = cfg ? cfg.description : (step.label || step.operation_type)
      lines.push(`- **Step ${i + 1}**: ${desc}`)
    }
  }
  lines.push('')

  // === Save ===
  lines.push('## Save')
  lines.push('')
  lines.push('```python')
  lines.push('wb.save("output.xlsx")')
  lines.push('```')

  return lines.join('\n')
}

/**
 * 触发浏览器下载通用 SKILL.md 文件
 */
export function downloadUniversalSkillMd(skill) {
  const content = toUniversalMarkdown(skill)
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${skill.name || 'skill'}_universal.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
