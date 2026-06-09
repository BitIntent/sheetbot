import { describe, it, expect } from 'vitest'
import { executeOperation } from '../excelOperations'

function buildWorkbookWithSheet(name, data, rowCount = 300, colCount = 3) {
  return {
    sheets: [
      {
        name,
        data,
        rowCount,
        colCount,
      },
    ],
    activeSheet: name,
  }
}

describe('createChart quality gate', () => {
  it('allows chart for compact aggregated range even if source table is large', () => {
    const data = {
      1: { 1: { value: '渠道' }, 2: { value: '销售额(净额)(求和)' } },
      2: { 1: { value: '京东' }, 2: { value: 135503.5 } },
      3: { 1: { value: '企业直销' }, 2: { value: 132612.67 } },
      4: { 1: { value: '天猫' }, 2: { value: 68401.01 } },
      5: { 1: { value: '官网' }, 2: { value: 73045.29 } },
      6: { 1: { value: '抖音' }, 2: { value: 71195.14 } },
      7: { 1: { value: '拼多多' }, 2: { value: 117903.09 } },
      8: { 1: { value: '线下门店' }, 2: { value: 97905.43 } },
    }
    const workbook = buildWorkbookWithSheet('销售分析', data, 300, 2)
    let errMsg = ''
    const result = executeOperation(
      workbook,
      {
        type: 'create_chart',
        params: {
          sheet: '销售分析',
          chart_type: 'column',
          data_range: 'A1:B20',
          title: '各渠道销售额',
          row: 3,
          col: 4,
          width: 600,
          height: 400,
        },
      },
      (msg) => { errMsg = String(msg || '') }
    )

    const targetSheet = result.sheets.find((s) => s.name === '销售分析')
    expect(errMsg).toBe('')
    expect(Array.isArray(targetSheet.charts)).toBe(true)
    expect(targetSheet.charts.length).toBe(1)
  })

  it('rejects chart for oversized raw detail range', () => {
    const data = {
      1: { 1: { value: '渠道' }, 2: { value: '销售额(净额)' } },
    }
    for (let r = 2; r <= 320; r++) {
      data[r] = {
        1: { value: `渠道${(r % 3) + 1}` },
        2: { value: 100 + (r % 9) },
      }
    }
    const workbook = buildWorkbookWithSheet('销售明细', data, 320, 2)
    let errMsg = ''
    const result = executeOperation(
      workbook,
      {
        type: 'create_chart',
        params: {
          sheet: '销售明细',
          chart_type: 'column',
          data_range: 'A1:B320',
          title: '明细直出柱图',
          row: 3,
          col: 4,
          width: 600,
          height: 400,
        },
      },
      (msg) => { errMsg = String(msg || '') }
    )

    const targetSheet = result.sheets.find((s) => s.name === '销售明细')
    expect(errMsg).toContain('暂时无法完成')
    expect(targetSheet.charts || []).toHaveLength(0)
  })

  it('auto-fixes chart range: skip title row and extend contiguous summary rows', () => {
    const data = {
      1: { 1: { value: '品类销售分析' } }, // 标题行，不应纳入图表
      2: { 1: { value: '品类' }, 2: { value: '销售额(净额)' } },
      3: { 1: { value: '家居日用' }, 2: { value: 120 } },
      4: { 1: { value: '食品饮料' }, 2: { value: 90 } },
      5: { 1: { value: '电子产品' }, 2: { value: 80 } },
      6: { 1: { value: '个护美妆' }, 2: { value: 70 } },
      7: { 1: { value: '母婴' }, 2: { value: 60 } },
      8: { 1: { value: '运动户外' }, 2: { value: 50 } },
      9: { 1: { value: '' }, 2: { value: '' } },
    }
    const workbook = buildWorkbookWithSheet('分析', data, 20, 2)
    let errMsg = ''
    const result = executeOperation(
      workbook,
      {
        type: 'create_chart',
        params: {
          sheet: '分析',
          chart_type: 'column',
          // 故意截断到前 6 行，期望自动扩展并跳过标题行
          data_range: 'A1:B6',
          title: '品类对比',
          row: 2,
          col: 4,
        },
      },
      (msg) => { errMsg = String(msg || '') }
    )
    const targetSheet = result.sheets.find((s) => s.name === '分析')
    expect(errMsg).toBe('')
    expect(targetSheet.charts || []).toHaveLength(1)
    expect(targetSheet.charts[0].dataRange).toBe('A2:B8')
  })

  it('stops batch_operations after chart failure (fail-fast)', () => {
    const data = {
      1: { 1: { value: '数值' } },
      2: { 1: { value: 10 } },
      3: { 1: { value: 20 } },
      4: { 1: { value: 30 } },
    }
    const workbook = buildWorkbookWithSheet('分析', data, 10, 3)
    let errMsg = ''
    const result = executeOperation(
      workbook,
      {
        type: 'batch_operations',
        params: {
          operations: [
            {
              type: 'create_chart',
              params: {
                sheet: '分析',
                chart_type: 'pie',
                // 只有一列且无左侧标签列，必然失败
                data_range: 'A1:A4',
                title: '无效饼图',
                row: 2,
                col: 3,
              },
            },
            {
              type: 'set_cell_value',
              params: {
                sheet: '分析',
                row: 6,
                col: 1,
                value: '不应执行',
              },
            },
          ],
        },
      },
      (msg) => { errMsg = String(msg || '') }
    )

    const targetSheet = result.sheets.find((s) => s.name === '分析')
    expect(errMsg).toContain('暂时无法完成')
    expect(targetSheet.charts || []).toHaveLength(0)
    expect(targetSheet.data?.[6]?.[1]?.value).toBeUndefined()
  })

  it('dedupes charts on same sheet and same dimension signature', () => {
    const data = {
      1: { 1: { value: '渠道' }, 2: { value: '销售额(净额)' } },
      2: { 1: { value: '京东' }, 2: { value: 100 } },
      3: { 1: { value: '天猫' }, 2: { value: 80 } },
      4: { 1: { value: '抖音' }, 2: { value: 60 } },
    }
    const workbook = buildWorkbookWithSheet('分析', data, 20, 4)

    const first = executeOperation(
      workbook,
      {
        type: 'create_chart',
        params: {
          sheet: '分析',
          chart_type: 'column',
          data_range: 'A1:B4',
          title: '渠道销售额-柱状图',
          row: 2,
          col: 4,
        },
      }
    )
    const second = executeOperation(
      first,
      {
        type: 'create_chart',
        params: {
          sheet: '分析',
          chart_type: 'pie',
          data_range: 'A1:B4',
          title: '渠道销售额-饼图',
          row: 20,
          col: 4,
        },
      }
    )

    const targetSheet = second.sheets.find((s) => s.name === '分析')
    expect(targetSheet.charts || []).toHaveLength(1)
  })

  it('downgrades summarize_metrics_by_column to count-only for ID-like metric column', () => {
    const workbook = buildWorkbookWithSheet('产品明细', {
      1: {
        1: { value: '产品ID' },
        4: { value: '品类' },
      },
      2: { 1: { value: 'P0001' }, 4: { value: '电子产品' } },
      3: { 1: { value: 'P0002' }, 4: { value: '电子产品' } },
      4: { 1: { value: 'P0003' }, 4: { value: '食品饮料' } },
    }, 10, 6)

    const result = executeOperation(
      workbook,
      {
        type: 'summarize_metrics_by_column',
        params: {
          sheet: '产品明细',
          start_row: 2,
          end_row: 4,
          group_by_col: 4,
          sum_col: 1,
          target_sheet: '产品分析',
          target_row: 1,
          target_col: 1,
          include_total: true,
        },
      }
    )

    const summary = result.sheets.find((s) => s.name === '产品分析')
    expect(summary.data[1][1].value).toBe('品类')
    expect(summary.data[1][2].value).toBe('记录数')
    expect(summary.data[1][3]).toBeUndefined()
    expect(summary.data[2][1].value).toBe('电子产品')
    expect(summary.data[2][2].value).toBe(2)
    expect(summary.data[4][1].value).toBe('总计')
    expect(summary.data[4][2].value).toBe(3)
  })
})

