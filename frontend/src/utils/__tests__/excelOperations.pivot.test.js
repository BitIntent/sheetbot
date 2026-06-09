import { describe, it, expect } from 'vitest'
import {
  buildPivotHeaders,
  resolvePivotFieldName,
  buildPivotDataRows,
  normalizePivotIdentifier,
  executeOperation,
} from '../excelOperations'

describe('pivot helpers', () => {
  it('buildPivotHeaders uses fallback for empty headers', () => {
    const sourceSheetObj = {
      data: {
        1: { 1: { value: '姓名' }, 2: { value: '' } }
      }
    }
    const headers = buildPivotHeaders(sourceSheetObj, 1, 1, 2)
    expect(headers).toEqual(['姓名', '__COL_2'])
  })

  it('resolvePivotFieldName matches numeric and text inputs', () => {
    const headers = ['销售人员', '渠道', '__COL_3']
    expect(resolvePivotFieldName(2, headers, 1)).toBe('渠道')
    expect(resolvePivotFieldName('2', headers, 1)).toBe('渠道')
    expect(resolvePivotFieldName(' 销售人员 ', headers, 1)).toBe('销售人员')
    expect(resolvePivotFieldName('渠', headers, 1)).toBe('渠道')
  })

  it('resolvePivotFieldName matches header with BOM/zero-width chars', () => {
    const headers = ['\uFEFF品类\u200B', '销售额(净额)']
    expect(normalizePivotIdentifier(headers[0])).toBe('品类')
    expect(resolvePivotFieldName('品类', headers, 1)).toBe('\uFEFF品类\u200B')
  })

  it('buildPivotDataRows maps data to headers', () => {
    const sourceSheetObj = {
      data: {
        1: { 1: { value: '姓名' }, 2: { value: '' } },
        2: { 1: { value: 'A' }, 2: { value: 10 } },
        3: { 1: { value: 'B' }, 2: { value: 20 } }
      }
    }
    const headers = buildPivotHeaders(sourceSheetObj, 1, 1, 2)
    const data = buildPivotDataRows(sourceSheetObj, headers, 1, 3, 1, 2)
    expect(data).toEqual([
      { 姓名: 'A', __COL_2: 10 },
      { 姓名: 'B', __COL_2: 20 }
    ])
  })

  it('create_pivot_table respects target_row over default', () => {
    const workbook = {
      sheets: [
        {
          name: '销售明细',
          data: {
            1: { 1: { value: '品类' }, 2: { value: '销售额(净额)' } },
            2: { 1: { value: '电子产品' }, 2: { value: 100 } },
            3: { 1: { value: '电子产品' }, 2: { value: 50 } },
            4: { 1: { value: '家居日用' }, 2: { value: 30 } },
          },
          rowCount: 4,
          colCount: 2,
        },
      ],
      activeSheet: '销售明细',
    }

    const result = executeOperation(workbook, {
      type: 'create_pivot_table',
      params: {
        sheet: '销售明细',
        source_range: { startRow: 1, startCol: 1, endRow: 4, endCol: 2 },
        row_fields: ['品类'],
        value_fields: ['销售额(净额)'],
        value_aggregations: { '销售额(净额)': 'sum' },
        target_sheet: '品类销售分析',
        target_row: 3,
        target_col: 2,
      },
    })

    const targetSheet = result.sheets.find((s) => s.name === '品类销售分析')
    expect(targetSheet).toBeTruthy()
    expect(targetSheet.data[3][2].value).toBe('品类')
    expect(targetSheet.data[3][3].value).toContain('销售额(净额)')
  })

  it('create_pivot_table rolls back when row field is unmatched', () => {
    const workbook = {
      sheets: [
        {
          name: '销售明细',
          data: {
            1: { 1: { value: '品类' }, 2: { value: '销售额(净额)' } },
            2: { 1: { value: '电子产品' }, 2: { value: 100 } },
          },
          rowCount: 2,
          colCount: 2,
        },
      ],
      activeSheet: '销售明细',
    }

    const result = executeOperation(workbook, {
      type: 'create_pivot_table',
      params: {
        sheet: '销售明细',
        source_range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
        row_fields: ['不存在字段'],
        value_fields: ['销售额(净额)'],
        value_aggregations: { '销售额(净额)': 'sum' },
        target_sheet: '临时分析表',
      },
    })

    const targetSheet = result.sheets.find((s) => s.name === '临时分析表')
    expect(targetSheet).toBeFalsy()
    expect(result.activeSheet).toBe('销售明细')
  })

  it('create_pivot_table auto-creates trimmed target sheet name', () => {
    const workbook = {
      sheets: [
        {
          name: '销售明细',
          data: {
            1: { 1: { value: '品类' }, 2: { value: '销售额(净额)' } },
            2: { 1: { value: '电子产品' }, 2: { value: 100 } },
            3: { 1: { value: '家居日用' }, 2: { value: 50 } },
          },
          rowCount: 3,
          colCount: 2,
        },
      ],
      activeSheet: '销售明细',
    }

    const result = executeOperation(workbook, {
      type: 'create_pivot_table',
      params: {
        sheet: '销售明细',
        source_range: { startRow: 1, startCol: 1, endRow: 3, endCol: 2 },
        row_fields: ['品类'],
        value_fields: ['销售额(净额)'],
        value_aggregations: { '销售额(净额)': 'sum' },
        target_sheet: '  销售分析透视表  ',
      },
    })

    const targetSheet = result.sheets.find((s) => s.name === '销售分析透视表')
    expect(targetSheet).toBeTruthy()
    expect(result.activeSheet).toBe('销售分析透视表')
  })
})
