import { describe, it, expect } from 'vitest'
import { normalizeOperationType, validateOperation } from '../operationValidator'

function buildWorkbook() {
  return {
    sheets: [
      { name: 'Sheet_制造业_2026', data: {}, rowCount: 100, colCount: 20 },
      { name: 'Sheet_医疗_北区', data: {}, rowCount: 200, colCount: 30 },
    ],
    activeSheet: 'Sheet_制造业_2026',
  }
}

describe('operationValidator constitution', () => {
  it('normalizes camelCase operation type via registry alias pipeline', () => {
    expect(normalizeOperationType('setCellValue')).toBe('set_cell_value')
    expect(normalizeOperationType('insertRows')).toBe('insert_row')
  })

  it('validates by structural contract, not business naming', () => {
    const wb = buildWorkbook()
    const op = {
      type: 'summarize_metrics_by_column',
      params: {
        sheet: 'Sheet_医疗_北区',
        startRow: 2,
        endRow: 150,
        groupByCol: 7,
        sumCol: 11,
      },
    }
    const result = validateOperation(wb, op)
    expect(result.isValid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects unknown operation without scene-specific fallback', () => {
    const wb = buildWorkbook()
    const op = {
      type: 'special_sales_magic_op',
      params: { sheet: 'Sheet_制造业_2026' },
    }
    const result = validateOperation(wb, op)
    expect(result.isValid).toBe(false)
    expect(result.errors.some((e) => e.includes('未知操作类型'))).toBe(true)
  })

  it('keeps generic sheet existence check across domains', () => {
    const wb = buildWorkbook()
    const op = {
      type: 'set_cell_value',
      params: {
        sheet: 'Not_Exists_跨行业',
        row: 1,
        col: 1,
        value: 'x',
      },
    }
    const result = validateOperation(wb, op)
    expect(result.isValid).toBe(false)
    expect(result.errors.some((e) => e.includes('工作表'))).toBe(true)
  })
})

