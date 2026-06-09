// frontend/src/components/ChartDialog.jsx
import React, { useState, useMemo, useEffect } from 'react'
import { X } from 'lucide-react'

function ChartDialog({ isOpen, onClose, onCreate, selection }) {
  const [chartType, setChartType] = useState('column')
  const [title, setTitle] = useState('')
  const [dataRange, setDataRange] = useState('')
  const [row, setRow] = useState(selection.endRow + 2)
  const [col, setCol] = useState(selection.startCol)

  const handleCreate = () => {
    if (dataRange.trim()) {
      onCreate({
        chartType,
        title,
        dataRange: dataRange.trim(),
        row,
        col,
        width: 400,
        height: 300
      })
      onClose()
    }
  }

  const chartTypes = [
    { value: 'column', label: '柱状图' },
    { value: 'line', label: '折线图' },
    { value: 'pie', label: '饼图' },
    { value: 'bar', label: '条形图' },
    { value: 'area', label: '面积图' },
    { value: 'scatter', label: '散点图' }
  ]

  // 自动生成数据范围（基于选中区域）
  const defaultRange = useMemo(() => {
    const startCol = String.fromCharCode(64 + selection.startCol)
    const endCol = String.fromCharCode(64 + selection.endCol)
    return `${startCol}${selection.startRow}:${endCol}${selection.endRow}`
  }, [selection])

  useEffect(() => {
    if (isOpen && !dataRange && defaultRange) {
      setDataRange(defaultRange)
    }
  }, [defaultRange, dataRange, isOpen])

  useEffect(() => {
    if (isOpen) {
      setRow(selection.endRow + 2)
      setCol(selection.startCol)
    }
  }, [isOpen, selection])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-96 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">创建图表</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">图表类型</label>
            <select
              value={chartType}
              onChange={(e) => setChartType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {chartTypes.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">图表标题</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="输入图表标题（可选）"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">数据范围</label>
            <input
              type="text"
              value={dataRange}
              onChange={(e) => setDataRange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如: A1:D10"
            />
            <p className="text-xs text-gray-500 mt-1">格式: A1:D10 或 Sheet1!A1:D10</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">位置行</label>
              <input
                type="number"
                value={row}
                onChange={(e) => setRow(parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                min="1"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">位置列</label>
              <input
                type="number"
                value={col}
                onChange={(e) => setCol(parseInt(e.target.value) || 1)}
                className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                min="1"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-4">
            <button
              onClick={handleCreate}
              className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              创建图表
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ChartDialog
