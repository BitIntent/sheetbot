import { describe, it, expect, vi } from 'vitest'
import { substituteVars, executeSkillOnSheet, executeSkill } from '../skillExecutor'

// ============================================================================
// substituteVars
// ============================================================================

describe('substituteVars', () => {
  const ctx = {
    sheet: { name: '销售数据', firstRow: 1, lastRow: 10, firstCol: 1, lastCol: 5 },
    file: { name: 'report.xlsx', sheetCount: 3 },
  }

  it('字符串中替换单个变量', () => {
    expect(substituteVars('{{sheet.name}}', ctx)).toBe('销售数据')
  })

  it('替换数字变量', () => {
    expect(substituteVars('{{sheet.lastCol}}', ctx)).toBe(5)
  })

  it('字符串中替换多个变量', () => {
    const result = substituteVars('{{sheet.firstRow}}-{{sheet.lastRow}}', ctx)
    expect(result).toBe('1-10')
  })

  it('未知变量保持原样', () => {
    expect(substituteVars('{{unknown.var}}', ctx)).toBe('{{unknown.var}}')
  })

  it('非字符串数值直接返回', () => {
    expect(substituteVars(42, ctx)).toBe(42)
    expect(substituteVars(true, ctx)).toBe(true)
    expect(substituteVars(null, ctx)).toBe(null)
  })

  it('对象递归替换', () => {
    const params = {
      startRow: '{{sheet.firstRow}}',
      endRow: '{{sheet.lastRow}}',
      style: { bold: true, color: '#fff' },
    }
    const result = substituteVars(params, ctx)
    expect(result.startRow).toBe(1)
    expect(result.endRow).toBe(10)
    expect(result.style.bold).toBe(true)
  })

  it('数组递归替换', () => {
    const arr = ['{{sheet.name}}', '{{file.name}}', 42]
    const result = substituteVars(arr, ctx)
    expect(result).toEqual(['销售数据', 'report.xlsx', 42])
  })

  it('嵌套对象递归替换', () => {
    const params = { outer: { inner: '{{sheet.firstCol}}' } }
    const result = substituteVars(params, ctx)
    expect(result.outer.inner).toBe(1)
  })

  it('无变量的字符串直接返回', () => {
    expect(substituteVars('hello world', ctx)).toBe('hello world')
  })
})


// ============================================================================
// executeSkillOnSheet
// ============================================================================

describe('executeSkillOnSheet', () => {
  const makeSheet = (name, data = {}) => ({ name, data })
  const makeWorkbook = (sheets) => ({ sheets, fileName: 'test.xlsx' })

  it('空步骤不调用 execFn', () => {
    const execFn = vi.fn(wb => wb)
    const sheet = makeSheet('Sheet1')
    const wb = makeWorkbook([sheet])
    const result = executeSkillOnSheet([], sheet, wb, execFn)
    expect(execFn).not.toHaveBeenCalled()
    expect(result).toBe(wb)
  })

  it('每个步骤调用一次 execFn', () => {
    const execFn = vi.fn(wb => wb)
    const sheet = makeSheet('Sheet1')
    const wb = makeWorkbook([sheet])
    const steps = [
      { id: 's1', label: 'A', operation_type: 'freeze_panes', params: { row: 1 } },
      { id: 's2', label: 'B', operation_type: 'auto_fit_column', params: {} },
    ]
    executeSkillOnSheet(steps, sheet, wb, execFn)
    expect(execFn).toHaveBeenCalledTimes(2)
  })

  it('operation 的 type 正确传入 execFn', () => {
    const calls = []
    const execFn = vi.fn((wb, op) => { calls.push(op); return wb })
    const sheet = makeSheet('Sheet1')
    const wb = makeWorkbook([sheet])
    executeSkillOnSheet(
      [{ id: 's1', label: 'freeze', operation_type: 'freeze_panes', params: { row: 1 } }],
      sheet, wb, execFn,
    )
    expect(calls[0].type).toBe('freeze_panes')
  })

  it('sheetName 自动注入到 params', () => {
    const calls = []
    const execFn = vi.fn((wb, op) => { calls.push(op); return wb })
    const sheet = makeSheet('财务表')
    const wb = makeWorkbook([sheet])
    executeSkillOnSheet(
      [{ id: 's1', label: 'A', operation_type: 'auto_fit_column', params: {} }],
      sheet, wb, execFn,
    )
    expect(calls[0].params.sheetName).toBe('财务表')
  })

  it('变量被替换后传入 execFn', () => {
    const calls = []
    const execFn = vi.fn((wb, op) => { calls.push(op); return wb })
    const data = { 1: { 1: { value: 'A' }, 5: { value: 'E' } } }
    const sheet = makeSheet('数据', data)
    const wb = makeWorkbook([sheet])
    executeSkillOnSheet(
      [{
        id: 's1', label: 'style', operation_type: 'set_range_style',
        params: { startCol: '{{sheet.firstCol}}', endCol: '{{sheet.lastCol}}' },
      }],
      sheet, wb, execFn,
    )
    expect(calls[0].params.startCol).toBe(1)
    expect(calls[0].params.endCol).toBe(5)
  })

  it('步骤执行失败时继续执行后续步骤', () => {
    let callCount = 0
    const execFn = vi.fn((wb, op) => {
      callCount++
      if (callCount === 1) throw new Error('step error')
      return wb
    })
    const sheet = makeSheet('S1')
    const wb = makeWorkbook([sheet])
    const steps = [
      { id: 's1', label: 'bad', operation_type: 'bad_op', params: {} },
      { id: 's2', label: 'good', operation_type: 'freeze_panes', params: {} },
    ]
    expect(() => executeSkillOnSheet(steps, sheet, wb, execFn)).not.toThrow()
    expect(execFn).toHaveBeenCalledTimes(2)
  })

  it('返回 execFn 累积后的 workbook', () => {
    let state = 0
    const execFn = vi.fn(wb => ({ ...wb, state: ++state }))
    const sheet = makeSheet('S1')
    const wb = makeWorkbook([sheet])
    const result = executeSkillOnSheet(
      [
        { id: 's1', label: 'A', operation_type: 'op1', params: {} },
        { id: 's2', label: 'B', operation_type: 'op2', params: {} },
      ],
      sheet, wb, execFn,
    )
    expect(result.state).toBe(2)
  })
})


// ============================================================================
// executeSkill
// ============================================================================

describe('executeSkill', () => {
  const makeWb = (sheetNames) => ({
    sheets: sheetNames.map(n => ({ name: n, data: {} })),
    fileName: 'test.xlsx',
  })

  it('空 steps 不调用 execFn', () => {
    const execFn = vi.fn(wb => wb)
    const wb = makeWb(['S1', 'S2'])
    const result = executeSkill({ steps: [], scope: { mode: 'all_sheets' } }, wb, execFn)
    expect(execFn).not.toHaveBeenCalled()
    expect(result).toBe(wb)
  })

  it('all_sheets 遍历所有 Sheet', () => {
    const execFn = vi.fn(wb => wb)
    const wb = makeWb(['S1', 'S2', 'S3'])
    const skill = {
      steps: [{ id: 's1', label: 'A', operation_type: 'freeze_panes', params: {} }],
      scope: { mode: 'all_sheets' },
    }
    executeSkill(skill, wb, execFn)
    // 3张Sheet * 1步骤 = 3次调用
    expect(execFn).toHaveBeenCalledTimes(3)
  })

  it('named_sheet 只操作指定 Sheet', () => {
    const execFn = vi.fn(wb => wb)
    const wb = makeWb(['S1', 'S2', 'S3'])
    const skill = {
      steps: [{ id: 's1', label: 'A', operation_type: 'freeze_panes', params: {} }],
      scope: { mode: 'named_sheet', sheet: 'S2' },
    }
    executeSkill(skill, wb, execFn)
    expect(execFn).toHaveBeenCalledTimes(1)
  })

  it('named_sheet 不存在时不调用 execFn', () => {
    const execFn = vi.fn(wb => wb)
    const wb = makeWb(['S1', 'S2'])
    const skill = {
      steps: [{ id: 's1', label: 'A', operation_type: 'freeze_panes', params: {} }],
      scope: { mode: 'named_sheet', sheet: 'NONEXISTENT' },
    }
    executeSkill(skill, wb, execFn)
    expect(execFn).not.toHaveBeenCalled()
  })

  it('空 workbook 直接返回', () => {
    const execFn = vi.fn(wb => wb)
    const skill = {
      steps: [{ id: 's1', label: 'A', operation_type: 'freeze_panes', params: {} }],
      scope: { mode: 'all_sheets' },
    }
    const result = executeSkill(skill, { sheets: [] }, execFn)
    expect(execFn).not.toHaveBeenCalled()
    expect(result).toEqual({ sheets: [] })
  })

  it('默认 scope 为 all_sheets', () => {
    const execFn = vi.fn(wb => wb)
    const wb = makeWb(['S1', 'S2'])
    const skill = {
      steps: [{ id: 's1', label: 'A', operation_type: 'freeze_panes', params: {} }],
    }
    executeSkill(skill, wb, execFn)
    expect(execFn).toHaveBeenCalledTimes(2)
  })
})
