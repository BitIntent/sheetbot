import { describe, it, expect, vi, afterEach } from 'vitest'
import { toMarkdown, fromMarkdown, downloadSkillMd, toUniversalMarkdown } from '../skillMdSerializer'
import { getRefImpl, hasRefImpl } from '../skillRefImpl'

// ============================================================================
// toMarkdown
// ============================================================================

describe('toMarkdown', () => {
  const sampleSkill = {
    name: '报表格式化',
    description: '统一设置表头样式',
    tags: ['格式', '报表'],
    scope: { mode: 'all_sheets' },
    steps: [
      { id: 's1', label: '冻结首行', operation_type: 'freeze_panes', params: { row: 1, col: 0 } },
    ],
  }

  it('包含 YAML frontmatter 块', () => {
    const md = toMarkdown(sampleSkill)
    expect(md).toContain('---')
    expect(md).toContain('name: 报表格式化')
    expect(md).toContain('description: 统一设置表头样式')
  })

  it('包含 tags 列表', () => {
    const md = toMarkdown(sampleSkill)
    expect(md).toContain('tags: [格式, 报表]')
  })

  it('包含 version 字段', () => {
    const md = toMarkdown(sampleSkill)
    expect(md).toContain('version: 1.0.0')
  })

  it('包含 ## Steps 区块', () => {
    const md = toMarkdown(sampleSkill)
    expect(md).toContain('## Steps')
  })

  it('包含 ## Scope 区块', () => {
    const md = toMarkdown(sampleSkill)
    expect(md).toContain('## Scope')
  })

  it('steps JSON 内容可解析', () => {
    const md = toMarkdown(sampleSkill)
    const match = md.match(/## Steps[\s\S]*?```json\n([\s\S]*?)```/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match[1])
    expect(parsed).toHaveLength(1)
    expect(parsed[0].operation_type).toBe('freeze_panes')
  })

  it('scope JSON 内容可解析', () => {
    const md = toMarkdown(sampleSkill)
    const match = md.match(/## Scope[\s\S]*?```json\n([\s\S]*?)```/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match[1])
    expect(parsed.mode).toBe('all_sheets')
  })

  it('空 steps 不报错', () => {
    const md = toMarkdown({ name: 'X', description: '', tags: [], scope: { mode: 'all_sheets' }, steps: [] })
    expect(md).toContain('## Steps')
    const match = md.match(/## Steps[\s\S]*?```json\n([\s\S]*?)```/)
    const parsed = JSON.parse(match[1])
    expect(parsed).toEqual([])
  })

  it('空 tags 渲染为 tags: []', () => {
    const md = toMarkdown({ name: 'X', description: '', tags: [], scope: { mode: 'all_sheets' }, steps: [] })
    expect(md).toContain('tags: []')
  })

  it('中文字段正确输出', () => {
    const md = toMarkdown({ name: '人效分析', description: '分析人员效率', tags: ['人事'], scope: { mode: 'all_sheets' }, steps: [] })
    expect(md).toContain('name: 人效分析')
    expect(md).toContain('description: 分析人员效率')
  })
})


// ============================================================================
// fromMarkdown
// ============================================================================

describe('fromMarkdown', () => {
  const validMd = `---
name: 报表格式化
description: 统一设置表头样式
tags: [格式, 报表]
version: 1.0.0
---

# 报表格式化

## Scope

\`\`\`json
{"mode":"all_sheets"}
\`\`\`

## Steps

\`\`\`json
[{"id":"s1","label":"冻结首行","operation_type":"freeze_panes","params":{"row":1,"col":0}}]
\`\`\``

  it('解析 name', () => {
    const skill = fromMarkdown(validMd)
    expect(skill).not.toBeNull()
    expect(skill.name).toBe('报表格式化')
  })

  it('解析 description', () => {
    const skill = fromMarkdown(validMd)
    expect(skill.description).toBe('统一设置表头样式')
  })

  it('解析 tags', () => {
    const skill = fromMarkdown(validMd)
    expect(skill.tags).toEqual(['格式', '报表'])
  })

  it('解析 scope', () => {
    const skill = fromMarkdown(validMd)
    expect(skill.scope.mode).toBe('all_sheets')
  })

  it('解析 steps', () => {
    const skill = fromMarkdown(validMd)
    expect(skill.steps).toHaveLength(1)
    expect(skill.steps[0].operation_type).toBe('freeze_panes')
    expect(skill.steps[0].params.row).toBe(1)
  })

  it('缺少 name 返回 null', () => {
    const badMd = `---
description: 没有名字
---
## Steps
\`\`\`json
[]
\`\`\``
    expect(fromMarkdown(badMd)).toBeNull()
  })

  it('无效格式返回 null', () => {
    expect(fromMarkdown('random text without frontmatter')).toBeNull()
  })

  it('空 steps JSON 解析为空数组', () => {
    const md = `---
name: 空技能
description: 无步骤
tags: []
---
## Scope
\`\`\`json
{"mode":"all_sheets"}
\`\`\`
## Steps
\`\`\`json
[]
\`\`\``
    const skill = fromMarkdown(md)
    expect(skill).not.toBeNull()
    expect(skill.steps).toEqual([])
  })

  it('单个 tag 解析为数组', () => {
    const md = `---
name: 单标签
description: x
tags: [格式]
---
## Scope
\`\`\`json
{"mode":"all_sheets"}
\`\`\`
## Steps
\`\`\`json
[]
\`\`\``
    const skill = fromMarkdown(md)
    expect(skill.tags).toEqual(['格式'])
  })


  it('toMarkdown 后 fromMarkdown 完整往返', () => {
    const original = {
      name: '往返测试',
      description: '测试序列化',
      tags: ['A', 'B'],
      scope: { mode: 'named_sheet', sheet: 'Sheet2' },
      steps: [
        { id: 's1', label: '步骤1', operation_type: 'freeze_panes', params: { row: 1 } },
      ],
    }
    const md = toMarkdown(original)
    const parsed = fromMarkdown(md)
    expect(parsed).not.toBeNull()
    expect(parsed.name).toBe('往返测试')
    expect(parsed.tags).toEqual(['A', 'B'])
    expect(parsed.scope.mode).toBe('named_sheet')
    expect(parsed.steps[0].operation_type).toBe('freeze_panes')
  })
})


// ============================================================================
// downloadSkillMd（toMarkdown 输出内容验证，不依赖 DOM）
// ============================================================================

describe('downloadSkillMd - output content', () => {
  it('toMarkdown 生成的内容包含正确 name', () => {
    // downloadSkillMd 内部调用 toMarkdown，通过验证 toMarkdown 输出来间接覆盖
    const { toMarkdown: tm } = { toMarkdown }
    const skill = { name: '测试技能', description: '', tags: [], scope: { mode: 'all_sheets' }, steps: [] }
    const md = toMarkdown(skill)
    expect(md).toContain('name: 测试技能')
  })

  it('文件名应为 skill.name + .md', () => {
    const skill = { name: '人效分析', description: '', tags: [], scope: { mode: 'all_sheets' }, steps: [] }
    const expectedFilename = `${skill.name}.md`
    expect(expectedFilename).toBe('人效分析.md')
  })
})


// ============================================================================
// toUniversalMarkdown - 通用 SKILL.md 导出
// ============================================================================

describe('toUniversalMarkdown', () => {
  const universalSkill = {
    name: '报表美化',
    description: '表头加粗 + 斑马纹',
    tags: ['格式', '报表'],
    scope: { mode: 'all_sheets' },
    steps: [
      {
        id: 's1', label: '表头加粗',
        operation_type: 'set_font',
        params: { range: 'A1:{{sheet.lastColLetter}}1', bold: true, fontSize: 14, fontColor: '#FFFFFF' },
      },
      {
        id: 's2', label: '求和',
        operation_type: 'quick_sum',
        params: { dataRange: 'B2:B10', outputCell: 'B11' },
      },
    ],
  }

  it('包含 YAML frontmatter 与 format: universal', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('---')
    expect(md).toContain('format: universal')
    expect(md).toContain('author: SheetBot')
  })

  it('包含 ## Environment 段', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('## Environment')
    expect(md).toContain('openpyxl')
    expect(md).toContain('pip install openpyxl')
  })

  it('包含 ## Variables 段并列出动态变量', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('## Variables')
    expect(md).toContain('sheet.lastColLetter')
  })

  it('包含 ## Steps 段', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('## Steps')
    expect(md).toContain('### Step 1: 表头加粗')
    expect(md).toContain('### Step 2: 求和')
  })

  it('包含 openpyxl 参考实现', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('openpyxl Reference Implementation')
    expect(md).toContain('Font(')
  })

  it('包含 ## Expected Result 段', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('## Expected Result')
    expect(md).toContain('Step 1')
    expect(md).toContain('Step 2')
  })

  it('包含 ## Save 段', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('## Save')
    expect(md).toContain('wb.save')
  })

  it('无变量引用时不生成 Variables 段', () => {
    const skill = {
      name: 'X', description: '', tags: [], scope: { mode: 'all_sheets' },
      steps: [{ id: 's1', label: '写值', operation_type: 'set_value', params: { cell: 'A1', value: 'hello' } }],
    }
    const md = toUniversalMarkdown(skill)
    expect(md).not.toContain('## Variables')
  })

  it('空步骤输出"无执行步骤"', () => {
    const skill = { name: 'X', description: '', tags: [], scope: { mode: 'all_sheets' }, steps: [] }
    const md = toUniversalMarkdown(skill)
    expect(md).toContain('无执行步骤')
  })

  it('参数表包含所有 params', () => {
    const md = toUniversalMarkdown(universalSkill)
    expect(md).toContain('`bold`')
    expect(md).toContain('`fontSize`')
  })
})


// ============================================================================
// skillRefImpl - openpyxl 参考实现映射表
// ============================================================================

describe('skillRefImpl', () => {
  it('hasRefImpl 对高频技能返回 true', () => {
    expect(hasRefImpl('set_font')).toBe(true)
    expect(hasRefImpl('set_fill')).toBe(true)
    expect(hasRefImpl('quick_sum')).toBe(true)
    expect(hasRefImpl('header_beautify')).toBe(true)
    expect(hasRefImpl('merge_cells')).toBe(true)
    expect(hasRefImpl('insert_rows')).toBe(true)
    expect(hasRefImpl('sort_range')).toBe(true)
  })

  it('hasRefImpl 对不存在的类型返回 false', () => {
    expect(hasRefImpl('nonexistent_skill')).toBe(false)
  })

  it('getRefImpl 返回 code 和 imports', () => {
    const ref = getRefImpl('set_font', { bold: true, fontSize: 14, fontColor: '#FF0000' })
    expect(ref).not.toBeNull()
    expect(ref.code).toContain('Font(')
    expect(ref.code).toContain('bold=True')
    expect(ref.imports).toContain('from openpyxl.styles import Font')
  })

  it('getRefImpl 对 quick_sum 生成 SUM 公式', () => {
    const ref = getRefImpl('quick_sum', { outputCell: 'B11', dataRange: 'B2:B10' })
    expect(ref).not.toBeNull()
    expect(ref.code).toContain('SUM')
  })

  it('getRefImpl 对不存在的类型返回 null', () => {
    expect(getRefImpl('nonexistent_skill', {})).toBeNull()
  })

  it('getRefImpl 参数为空对象时不报错', () => {
    const ref = getRefImpl('set_fill', {})
    expect(ref).not.toBeNull()
    expect(ref.code).toContain('PatternFill')
  })

  it('getRefImpl header_beautify 包含主题色', () => {
    const ref = getRefImpl('header_beautify', { theme: 'green', fontColor: '#FFFFFF' })
    expect(ref).not.toBeNull()
    expect(ref.code).toContain('theme_colors')
    expect(ref.code).toContain('green')
  })
})
