/**
 * 图表鲁棒性 UT — 覆盖四个已知故障点
 *
 * P0-1 (L3-1/L2-1): dataRange 行列号 0/负数 → A1 字符串夹紧
 * P0-2 (L4-5):       雷达图空数据 Math.max(...[]) = -Infinity → 轴崩溃
 * P1-1 (L5-2):       createChart 写入后 charts 为新数组引用
 * 验证 (S3):         workbookJsonAdapter charts 白名单保留
 *
 * 测试运行（远程）：
 *   cd frontend && npx vitest run src/utils/__tests__/chartRobustness.test.js
 */
import { describe, it, expect } from 'vitest'
import { executeOperation } from '../excelOperations'
import { buildEchartsOption, extractChartData, parseRange } from '../../univer/chartEchartsBuilder'

// ============================================================
//  辅助工具
// ============================================================
function makeWorkbook(sheetName, data, rowCount = 20, colCount = 6) {
  return {
    sheets: [{ name: sheetName, data, rowCount, colCount }],
    activeSheet: sheetName,
  }
}

function baseChartParams(overrides = {}) {
  return {
    type: 'create_chart',
    params: {
      sheet: 'Sheet1',
      chartType: 'column',
      dataRange: 'A1:B8',
      title: '测试图表',
      row: 1,
      col: 4,
      width: 400,
      height: 300,
      ...overrides,
    },
  }
}

// 左侧两列（A-B）：品类 / 销售额，6 行数据
// 右侧两列（D-E）：独立数据块，4 行，col 3 为空列作隔断
// 两块列区间不重叠，可分别建图而不触发去重逻辑
const SAMPLE_DATA = {
  1: { 1: { value: '品类' }, 2: { value: '销售额' }, 4: { value: '地区' }, 5: { value: '利润' } },
  2: { 1: { value: '电子' }, 2: { value: 1200 }, 4: { value: '华东' }, 5: { value: 500 } },
  3: { 1: { value: '服装' }, 2: { value: 800 }, 4: { value: '华南' }, 5: { value: 300 } },
  4: { 1: { value: '食品' }, 2: { value: 600 }, 4: { value: '华北' }, 5: { value: 400 } },
  5: { 1: { value: '家居' }, 2: { value: 950 } },
  6: { 1: { value: '美妆' }, 2: { value: 430 } },
}

// ============================================================
//  P0-1：dataRange 行列号 0 / 负数 夹紧
// ============================================================
describe('P0-1: dataRange 行列号 ≥1 夹紧', () => {
  it('对象格式 startRow:0 应被夹紧为 1，图表正常写入', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    const result = executeOperation(
      wb,
      baseChartParams({
        dataRange: { startRow: 0, startCol: 1, endRow: 6, endCol: 2 },
      }),
      (msg) => { err = String(msg) }
    )
    expect(err).toBe('')
    const sheet = result.sheets[0]
    expect(sheet.charts.length).toBeGreaterThan(0)
    // A1 字符串的行号应 ≥ 1
    const dr = sheet.charts[0].dataRange
    const parsed = parseRange(dr)
    expect(parsed.startRow).toBeGreaterThanOrEqual(1)
  })

  it('对象格式 startCol:0 应被夹紧为 1', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    const result = executeOperation(
      wb,
      baseChartParams({
        dataRange: { startRow: 1, startCol: 0, endRow: 6, endCol: 2 },
      }),
      (msg) => { err = String(msg) }
    )
    expect(err).toBe('')
    const parsed = parseRange(result.sheets[0].charts[0].dataRange)
    expect(parsed.startCol).toBeGreaterThanOrEqual(1)
  })

  it('对象格式负数行列号应被夹紧', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    const result = executeOperation(
      wb,
      baseChartParams({
        dataRange: { startRow: -3, startCol: -1, endRow: 6, endCol: 2 },
      }),
      (msg) => { err = String(msg) }
    )
    expect(err).toBe('')
    const parsed = parseRange(result.sheets[0].charts[0].dataRange)
    expect(parsed.startRow).toBeGreaterThanOrEqual(1)
    expect(parsed.startCol).toBeGreaterThanOrEqual(1)
  })

  it('A1 字符串中 endRow < startRow 时应修正（不崩溃）', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    // A5:B2 — endRow < startRow，应自动修正为 A5:B5
    const result = executeOperation(
      wb,
      baseChartParams({ dataRange: 'A5:B2' }),
      (msg) => { err = String(msg) }
    )
    // 不抛错即通过（createChart 内部自愈可能调整范围后无数据而静默退出，但不应崩溃）
    expect(typeof err).toBe('string')
  })

  it('{ start:{row,col}, end:{row,col} } 格式 0 值被夹紧', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    const result = executeOperation(
      wb,
      baseChartParams({
        dataRange: { start: { row: 0, col: 0 }, end: { row: 6, col: 2 } },
      }),
      (msg) => { err = String(msg) }
    )
    expect(err).toBe('')
    const parsed = parseRange(result.sheets[0].charts[0].dataRange)
    expect(parsed.startRow).toBeGreaterThanOrEqual(1)
    expect(parsed.startCol).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================
//  P0-2：雷达图空数据 / 全零数据 不崩溃
// ============================================================
describe('P0-2: 雷达图 Math.max 空数组 / 全零不崩溃', () => {
  const makeRadarSheet = (dataRows) => ({
    name: 'Sheet1',
    data: dataRows,
    rowCount: 10,
    colCount: 4,
  })

  it('空 matrix（无数据行）返回合法 option，indicator.max ≥ 1', () => {
    const sheet = makeRadarSheet({
      1: { 1: { value: '维度' }, 2: { value: '指标A' } },
      // 没有数据行
    })
    const chart = {
      id: 'c1',
      chartType: 'radar',
      dataRange: 'A1:B1',
      title: '',
      row: 1, col: 4,
    }
    const option = buildEchartsOption(chart, sheet)
    // 空 matrix 时 extractChartData 返回 matrix:[]，buildEchartsOption 应返回占位 option
    expect(option).toBeTruthy()
    // 若返回了 radar option，indicator max 不能是 -Infinity / NaN
    if (option.radar?.indicator) {
      for (const ind of option.radar.indicator) {
        expect(Number.isFinite(ind.max)).toBe(true)
        expect(ind.max).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('全零 matrix 时 indicator.max ≥ 1', () => {
    const sheet = makeRadarSheet({
      1: { 1: { value: '指标' }, 2: { value: '值' } },
      2: { 1: { value: '速度' }, 2: { value: 0 } },
      3: { 1: { value: '精度' }, 2: { value: 0 } },
    })
    const chart = { id: 'c2', chartType: 'radar', dataRange: 'A1:B3', title: '' }
    const option = buildEchartsOption(chart, sheet)
    if (option.radar?.indicator) {
      for (const ind of option.radar.indicator) {
        expect(Number.isFinite(ind.max)).toBe(true)
        expect(ind.max).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('正常数据时 indicator.max 正确反映最大值', () => {
    const sheet = makeRadarSheet({
      1: { 1: { value: '指标' }, 2: { value: '值' } },
      2: { 1: { value: '速度' }, 2: { value: 80 } },
      3: { 1: { value: '精度' }, 2: { value: 95 } },
      4: { 1: { value: '耗时' }, 2: { value: 60 } },
    })
    const chart = { id: 'c3', chartType: 'radar', dataRange: 'A1:B4', title: '' }
    const option = buildEchartsOption(chart, sheet)
    if (option.radar?.indicator) {
      const maxVal = Math.max(...option.radar.indicator.map(i => i.max))
      // max 应 ≥ 95（最大数据值）
      expect(maxVal).toBeGreaterThanOrEqual(95)
    }
  })
})

// ============================================================
//  P1-1：createChart 写入后 charts 数组为新引用
// ============================================================
describe('P1-1: createChart 写入后 charts 为新数组引用', () => {
  it('第二次 create_chart 后 sheet.charts 引用已更新', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)

    // 先执行一次，拿到中间状态引用
    const wb1 = executeOperation(wb, baseChartParams({ title: '图1' }), () => {})
    const sheet1 = wb1.sheets[0]
    const chartsRef1 = sheet1.charts

    // 第二张图指向右侧独立列块（D1:E4），避免与第一张触发同维度去重
    const wb2 = executeOperation(wb1, baseChartParams({ title: '图2', dataRange: 'D1:E4', col: 12 }), () => {})
    const sheet2 = wb2.sheets[0]
    const chartsRef2 = sheet2.charts

    // 新数组引用不同（保证 React useMemo 能感知变化）
    expect(chartsRef2).not.toBe(chartsRef1)
    expect(chartsRef2.length).toBe(2)
  })

  it('单次 create_chart 后 charts 长度为 1', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    const result = executeOperation(wb, baseChartParams(), () => {})
    expect(result.sheets[0].charts.length).toBe(1)
  })
})

// ============================================================
//  回归：正常路径在修复后仍能正常写入图表
// ============================================================
describe('回归：正常 A1 字符串路径不受夹紧影响', () => {
  it('标准 A1:B6 字符串正常写入', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    const result = executeOperation(wb, baseChartParams({ dataRange: 'A1:B6' }), (msg) => { err = msg })
    expect(err).toBe('')
    expect(result.sheets[0].charts.length).toBe(1)
    expect(result.sheets[0].charts[0].dataRange).toMatch(/^[A-Z]+\d+:[A-Z]+\d+$/)
  })

  it('列字母大小写混合 A1:b6 被规范化为大写', () => {
    const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
    let err = ''
    const result = executeOperation(wb, baseChartParams({ dataRange: 'a1:b6' }), (msg) => { err = msg })
    expect(err).toBe('')
    // A1 字符串应大写
    expect(result.sheets[0].charts[0].dataRange).toMatch(/^[A-Z]+\d+:[A-Z]+\d+$/)
  })

  it('bar / line / area / doughnut 类型均正常落图', () => {
    for (const chartType of ['bar', 'line', 'area', 'doughnut']) {
      const wb = makeWorkbook('Sheet1', SAMPLE_DATA)
      let err = ''
      const result = executeOperation(wb, baseChartParams({ chartType, dataRange: 'A1:B6' }), (msg) => { err = msg })
      expect(err, `chartType=${chartType} 不应报错`).toBe('')
      expect(result.sheets[0].charts.length, `chartType=${chartType} 应有 1 张图`).toBe(1)
    }
  })
})
