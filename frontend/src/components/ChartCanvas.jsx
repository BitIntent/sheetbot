// frontend/src/components/ChartCanvas.jsx
import React, { useRef, useEffect } from 'react'
import { evaluateFormula } from '../utils/formulaEngine'

/**
 * 图表画布组件
 * 使用 Canvas 绘制简单的柱形图、折线图等
 */
const ChartCanvas = ({ chartType, title, headers, dataRows, width, height, dataRange, sheet, rangeStartRow, rangeStartCol }) => {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, width, height)

    // 设置样式
    const padding = { top: 40, right: 20, bottom: 40, left: 60 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    // 兼容多种图表类型写法
    const rawType = String(chartType || 'column').toLowerCase()
    const chartKind = ['column', 'bar', 'line', 'area', 'scatter', 'pie']
      .find(kind => rawType.includes(kind)) || 'column'

    // 绘制标题
    if (title) {
      ctx.fillStyle = '#333'
      ctx.font = 'bold 16px Arial'
      ctx.textAlign = 'center'
      ctx.fillText(title, width / 2, 20)
    }

    if (!dataRows || dataRows.length === 0) {
      ctx.fillStyle = '#999'
      ctx.font = '14px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('无数据', width / 2, height / 2)
      return
    }

    // 智能识别分类轴和数值轴
    // 1. 识别哪些列是文本（分类），哪些列是数值（数据系列）
    const textColumns = [] // 文本列的索引
    const numericColumns = [] // 数值列的索引
    
    if (dataRows.length > 0) {
      const firstRow = dataRows[0]
      firstRow.forEach((value, colIdx) => {
        // 检查值类型：字符串或日期格式的字符串视为文本
        if (typeof value === 'string') {
          textColumns.push(colIdx)
        } else if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
          numericColumns.push(colIdx)
        } else {
          // 其他情况（NaN, null, undefined）视为文本
          textColumns.push(colIdx)
        }
      })
    }

    // 2. 提取X轴标签（优先使用第一个文本列，如果没有则使用行索引）
    const labels = []
    const labelColumnIdx = textColumns.length > 0 ? textColumns[0] : -1
    
    dataRows.forEach((row, idx) => {
      if (labelColumnIdx >= 0 && row[labelColumnIdx] !== undefined) {
        // 使用指定列作为标签
        labels.push(String(row[labelColumnIdx]))
      } else {
        // 使用行索引或第一个值作为标签
        labels.push(row[0] !== undefined ? String(row[0]) : `行${idx + 1}`)
      }
    })

    // 3. 提取数值数据（只使用数值列）
    const chartData = []
    dataRows.forEach(row => {
      const numericRow = numericColumns.map(colIdx => row[colIdx] || 0)
      chartData.push(numericRow)
    })

    // 4. 确定数据系列名称（使用数值列的列标题）
    const seriesNames = numericColumns.map(colIdx => headers[colIdx] || `系列${colIdx + 1}`)
    
    // 限制显示的数据点数量
    const maxDataPoints = Math.min(dataRows.length, 20)
    const chartLabels = labels.slice(0, maxDataPoints)
    const finalChartData = chartData.slice(0, maxDataPoints)

    // 计算最大值（从所有数值列中找最大值）
    let maxValue = 0
    finalChartData.forEach(row => {
      row.forEach(val => {
        if (typeof val === 'number' && val > maxValue) {
          maxValue = val
        }
      })
    })
    
    // 如果只有一个数值列，只显示该列；如果有多个，默认显示最后一个（通常是总计列）
    const displaySeriesIdx = numericColumns.length > 0 ? numericColumns.length - 1 : 0

    if (maxValue === 0) {
      ctx.fillStyle = '#999'
      ctx.font = '14px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('无有效数据', width / 2, height / 2)
      return
    }

    // 绘制坐标轴（饼图不需要坐标轴）
    if (chartKind !== 'pie') {
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 1
      ctx.beginPath()
      // Y轴
      ctx.moveTo(padding.left, padding.top)
      ctx.lineTo(padding.left, padding.top + chartHeight)
      // X轴
      ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight)
      ctx.stroke()

      // 绘制网格线
      ctx.strokeStyle = '#e0e0e0'
      ctx.lineWidth = 0.5
      const gridLines = 5
      for (let i = 0; i <= gridLines; i++) {
        const y = padding.top + (chartHeight / gridLines) * i
        ctx.beginPath()
        ctx.moveTo(padding.left, y)
        ctx.lineTo(padding.left + chartWidth, y)
        ctx.stroke()

        // Y轴标签
        const value = maxValue - (maxValue / gridLines) * i
        ctx.fillStyle = '#666'
        ctx.font = '10px Arial'
        ctx.textAlign = 'right'
        ctx.fillText(value.toFixed(0), padding.left - 5, y + 3)
      }
    }

    // 绘制数据
    if (chartKind === 'pie') {
      // 饼图：需要标签列和数值列
      const pieLabels = []
      const pieValues = []
      
      // 如果只有数值列（数据范围只有一列），从A列（第一列）获取标签
      if (numericColumns.length > 0 && textColumns.length === 0 && sheet && rangeStartRow !== undefined) {
        // 数据范围只有一列，需要从A列获取标签
        const valueColIdx = numericColumns[0] // 第一个数值列（数量）
        const labelColNum = 1 // A列（列号从1开始）
        
        // 从A列读取标签（日期）
        dataRows.forEach((row, rowIdx) => {
          const dataRowNum = rangeStartRow + rowIdx
          // 从A列读取标签（日期）
          const labelCell = sheet.data[dataRowNum]?.[labelColNum]
          let label = ''
          if (labelCell) {
            if (labelCell.formula) {
              // 计算公式值
              try {
                const formulaValue = evaluateFormula(labelCell.formula, sheet.data)
                label = String(formulaValue)
              } catch (e) {
                label = labelCell.value || ''
              }
            } else {
              label = labelCell.value || ''
            }
          }
          // 如果没有标签，使用行号
          if (!label) {
            label = `行${dataRowNum}`
          }
          
          const value = typeof row[valueColIdx] === 'number' ? row[valueColIdx] : (parseFloat(row[valueColIdx]) || 0)
          if (value > 0) {
            pieLabels.push(String(label))
            pieValues.push(value)
          }
        })
      } else if (textColumns.length > 0 && numericColumns.length > 0) {
        // 有文本列和数值列，正常处理
        const labelColIdx = textColumns[0] // 第一个文本列（日期）
        const valueColIdx = numericColumns[0] // 第一个数值列（数量）
        
        dataRows.forEach(row => {
          const label = row[labelColIdx] !== undefined ? String(row[labelColIdx]) : ''
          const value = typeof row[valueColIdx] === 'number' ? row[valueColIdx] : (parseFloat(row[valueColIdx]) || 0)
          if (value > 0) { // 只包含有效数据
            pieLabels.push(label)
            pieValues.push(value)
          }
        })
      } else if (numericColumns.length > 0) {
        // 只有数值列，使用行索引作为标签
        const valueColIdx = numericColumns[0]
        dataRows.forEach((row, rowIdx) => {
          const value = typeof row[valueColIdx] === 'number' ? row[valueColIdx] : (parseFloat(row[valueColIdx]) || 0)
          if (value > 0) {
            pieLabels.push(`项${rowIdx + 1}`)
            pieValues.push(value)
          }
        })
      }
      
      if (pieValues.length === 0) {
        ctx.fillStyle = '#999'
        ctx.font = '14px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('无有效数据', width / 2, height / 2)
        return
      }
      
      // 计算总和
      const total = pieValues.reduce((sum, val) => sum + val, 0)
      if (total === 0) {
        ctx.fillStyle = '#999'
        ctx.font = '14px Arial'
        ctx.textAlign = 'center'
        ctx.fillText('无有效数据', width / 2, height / 2)
        return
      }
      
      // 饼图中心点和半径
      const centerX = width / 2
      const centerY = (height - padding.bottom + padding.top) / 2 + padding.top
      const radius = Math.min(chartWidth, chartHeight) / 2 - 20
      
      // 颜色方案
      const colors = [
        '#4A90E2', '#50C878', '#FF6B6B', '#FFD93D', '#6BCF7F',
        '#9B59B6', '#E74C3C', '#3498DB', '#F39C12', '#1ABC9C'
      ]
      
      // 绘制饼图
      let currentAngle = -Math.PI / 2 // 从顶部开始
      
      pieValues.forEach((value, idx) => {
        const sliceAngle = (value / total) * Math.PI * 2
        
        // 绘制扇形
        ctx.beginPath()
        ctx.moveTo(centerX, centerY)
        ctx.arc(centerX, centerY, radius, currentAngle, currentAngle + sliceAngle)
        ctx.closePath()
        ctx.fillStyle = colors[idx % colors.length]
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
        
        // 绘制标签和百分比
        const labelAngle = currentAngle + sliceAngle / 2
        const labelRadius = radius * 0.7
        const labelX = centerX + Math.cos(labelAngle) * labelRadius
        const labelY = centerY + Math.sin(labelAngle) * labelRadius
        
        // 百分比文本
        const percentage = ((value / total) * 100).toFixed(1)
        ctx.fillStyle = '#333'
        ctx.font = 'bold 11px Arial'
        ctx.textAlign = 'center'
        ctx.fillText(`${percentage}%`, labelX, labelY)
        
        // 如果扇形足够大，绘制标签
        if (sliceAngle > 0.3) {
          const labelRadius2 = radius * 0.5
          const labelX2 = centerX + Math.cos(labelAngle) * labelRadius2
          const labelY2 = centerY + Math.sin(labelAngle) * labelRadius2
          ctx.fillStyle = '#333'
          ctx.font = '10px Arial'
          ctx.fillText(pieLabels[idx].substring(0, 8), labelX2, labelY2 - 12)
        }
        
        currentAngle += sliceAngle
      })
      
      // 绘制图例（右侧）
      const legendX = centerX + radius + 30
      const legendY = centerY - (pieLabels.length * 15) / 2
      
      pieLabels.forEach((label, idx) => {
        const y = legendY + idx * 15
        
        // 颜色方块
        ctx.fillStyle = colors[idx % colors.length]
        ctx.fillRect(legendX, y - 5, 10, 10)
        ctx.strokeStyle = '#ccc'
        ctx.lineWidth = 1
        ctx.strokeRect(legendX, y - 5, 10, 10)
        
        // 标签文本
        ctx.fillStyle = '#333'
        ctx.font = '10px Arial'
        ctx.textAlign = 'left'
        const displayLabel = label.length > 12 ? label.substring(0, 12) + '...' : label
        ctx.fillText(displayLabel, legendX + 15, y + 3)
        
        // 数值
        ctx.fillStyle = '#666'
        ctx.font = '9px Arial'
        ctx.fillText(`(${pieValues[idx]})`, legendX + 15, y + 13)
      })
      
    } else if (chartKind === 'column' || chartKind === 'bar') {
      // 柱形图：默认显示主要数据系列（最后一个数值列，通常是总计）
      const barWidth = chartWidth / Math.max(finalChartData.length, 1) * 0.6
      const barSpacing = chartWidth / Math.max(finalChartData.length, 1)

      finalChartData.forEach((row, rowIdx) => {
        // 只绘制主要数据系列（最后一个数值列）
        const value = row[displaySeriesIdx] || 0
        if (typeof value === 'number' && value >= 0) {
          if (chartKind === 'bar') {
            const barHeight = chartHeight / Math.max(finalChartData.length, 1) * 0.6
            const barGap = chartHeight / Math.max(finalChartData.length, 1)
            const barWidthH = maxValue > 0 ? (value / maxValue) * chartWidth : 0
            const x = padding.left
            const y = padding.top + rowIdx * barGap + barGap * 0.2
            ctx.fillStyle = '#4A90E2'
            ctx.fillRect(x, y, barWidthH, barHeight)

            ctx.fillStyle = '#333'
            ctx.font = '10px Arial'
            ctx.textAlign = 'right'
            const label = chartLabels[rowIdx] ?? ''
            ctx.fillText(String(label).substring(0, 10), padding.left - 8, y + barHeight / 2 + 3)
          } else {
            const barHeight = maxValue > 0 ? (value / maxValue) * chartHeight : 0
            const x = padding.left + rowIdx * barSpacing + barSpacing * 0.2
            const y = padding.top + chartHeight - barHeight

            // 绘制柱子（使用单一颜色）
            ctx.fillStyle = '#4A90E2'
            ctx.fillRect(x, y, barWidth, barHeight)

            // 绘制数值标签
            if (barHeight > 15) {
              ctx.fillStyle = '#333'
              ctx.font = '10px Arial'
              ctx.textAlign = 'center'
              ctx.fillText(value.toFixed(0), x + barWidth / 2, y - 3)
            }
          }
        }
      })
      
      // 绘制图例（显示数据系列名称）
      if (seriesNames.length > 0) {
        ctx.fillStyle = '#333'
        ctx.font = '11px Arial'
        ctx.textAlign = 'left'
        const legendText = seriesNames[displaySeriesIdx] || '数据'
        ctx.fillText(legendText, padding.left, padding.top - 10)
      }
    } else if (chartKind === 'line' || chartKind === 'area') {
      // 折线图：默认显示主要数据系列
      const pointSpacing = chartWidth / Math.max(finalChartData.length - 1, 1)

      // 只绘制主要数据系列
      ctx.strokeStyle = '#4A90E2'
      ctx.lineWidth = 2
      ctx.beginPath()

      finalChartData.forEach((row, rowIdx) => {
        const value = row[displaySeriesIdx] || 0
        if (typeof value === 'number') {
          const x = padding.left + rowIdx * pointSpacing
          const y = padding.top + chartHeight - (maxValue > 0 ? (value / maxValue) * chartHeight : 0)

          if (rowIdx === 0) {
            ctx.moveTo(x, y)
          } else {
            ctx.lineTo(x, y)
          }
        }
      })

      ctx.stroke()

      if (chartKind === 'area') {
        ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight)
        ctx.lineTo(padding.left, padding.top + chartHeight)
        ctx.closePath()
        ctx.fillStyle = 'rgba(74, 144, 226, 0.2)'
        ctx.fill()
      }

      // 绘制数据点
      finalChartData.forEach((row, rowIdx) => {
        const value = row[displaySeriesIdx] || 0
        if (typeof value === 'number') {
          const x = padding.left + rowIdx * pointSpacing
          const y = padding.top + chartHeight - (maxValue > 0 ? (value / maxValue) * chartHeight : 0)

          ctx.fillStyle = '#4A90E2'
          ctx.beginPath()
          ctx.arc(x, y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      })
      
      // 绘制图例
      if (seriesNames.length > 0) {
        ctx.fillStyle = '#333'
        ctx.font = '11px Arial'
        ctx.textAlign = 'left'
        const legendText = seriesNames[displaySeriesIdx] || '数据'
        ctx.fillText(legendText, padding.left, padding.top - 10)
      }
    } else if (chartKind === 'scatter') {
      // 散点图：使用索引作为 X 轴
      const pointSpacing = chartWidth / Math.max(finalChartData.length - 1, 1)
      finalChartData.forEach((row, rowIdx) => {
        const value = row[displaySeriesIdx] || 0
        if (typeof value === 'number') {
          const x = padding.left + rowIdx * pointSpacing
          const y = padding.top + chartHeight - (maxValue > 0 ? (value / maxValue) * chartHeight : 0)
          ctx.fillStyle = '#4A90E2'
          ctx.beginPath()
          ctx.arc(x, y, 4, 0, Math.PI * 2)
          ctx.fill()
        }
      })
    }

    // 绘制X轴标签（饼图不需要X轴标签）
    if (chartKind !== 'pie') {
      ctx.fillStyle = '#666'
      ctx.font = '10px Arial'
      ctx.textAlign = 'center'
      chartLabels.forEach((label, idx) => {
        if (idx < finalChartData.length) {
          const x = padding.left + (idx * chartWidth) / Math.max(finalChartData.length - 1, 1)
          // 截断过长的标签，但保留更多字符
          const displayLabel = String(label).substring(0, 12)
          ctx.fillText(displayLabel, x, height - 10)
        }
      })
    }
  }, [chartType, title, headers, dataRows, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: 'block' }}
    />
  )
}

export default ChartCanvas
