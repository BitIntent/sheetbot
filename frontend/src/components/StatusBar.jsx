// frontend/src/components/StatusBar.jsx
/**
 * ============================================
 * 状态栏组件
 * - 显示选中区域的基础统计信息
 * - 自动计算求和、平均值、计数、最大值、最小值
 * ============================================
 */
import React, { useMemo } from 'react'
import { evaluateFormula } from '../utils/formulaEngine'

const StatusBar = ({ selection, sheet }) => {
  // 计算选中区域的统计数据
  const stats = useMemo(() => {
    if (!sheet?.data) return null
    
    const { startRow, startCol, endRow, endCol } = selection
    const values = []
    
    // 收集选中区域的数值
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const cell = sheet.data?.[r]?.[c]
        if (cell) {
          // 处理公式单元格
          let val
          if (cell.formula) {
            val = evaluateFormula(cell.formula, sheet.data)
          } else {
            val = cell.value
          }
          const num = parseFloat(val)
          if (!isNaN(num)) {
            values.push(num)
          }
        }
      }
    }
    
    if (values.length === 0) return null
    
    const sum = values.reduce((acc, v) => acc + v, 0)
    const avg = sum / values.length
    const max = Math.max(...values)
    const min = Math.min(...values)
    
    return {
      count: values.length,
      sum: Number.isInteger(sum) ? sum : parseFloat(sum.toFixed(2)),
      avg: parseFloat(avg.toFixed(2)),
      max: Number.isInteger(max) ? max : parseFloat(max.toFixed(2)),
      min: Number.isInteger(min) ? min : parseFloat(min.toFixed(2))
    }
  }, [selection, sheet])

  // 格式化数字显示（保留两位小数，不使用千位分隔符）
  const formatNumber = (num) => {
    if (num === undefined || num === null) return '-'
    // 整数直接显示，小数保留两位
    if (Number.isInteger(num)) {
      return num.toString()
    }
    return parseFloat(num.toFixed(2)).toString()
  }

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="status-item">
          选区: {String.fromCharCode(64 + selection.startCol)}{selection.startRow}
          {(selection.startRow !== selection.endRow || selection.startCol !== selection.endCol) && 
            `:${String.fromCharCode(64 + selection.endCol)}${selection.endRow}`
          }
        </span>
      </div>
      <div className="status-right">
        {stats ? (
          <>
            <span className="status-stat">
              <span className="stat-label">计数</span>
              <span className="stat-value">{formatNumber(stats.count)}</span>
            </span>
            <span className="status-stat">
              <span className="stat-label">求和</span>
              <span className="stat-value">{formatNumber(stats.sum)}</span>
            </span>
            <span className="status-stat">
              <span className="stat-label">平均值</span>
              <span className="stat-value">{formatNumber(stats.avg)}</span>
            </span>
            <span className="status-stat">
              <span className="stat-label">最大值</span>
              <span className="stat-value">{formatNumber(stats.max)}</span>
            </span>
            <span className="status-stat">
              <span className="stat-label">最小值</span>
              <span className="stat-value">{formatNumber(stats.min)}</span>
            </span>
          </>
        ) : (
          <span className="status-item hint">选择包含数值的单元格查看统计</span>
        )}
      </div>
    </div>
  )
}

export default StatusBar
