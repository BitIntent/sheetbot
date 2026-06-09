// frontend/src/components/FilterDialog.jsx
import React, { useState } from 'react'
import { X } from 'lucide-react'

const toExcelColumnName = (col) => {
  let n = Number(col)
  if (!Number.isFinite(n) || n <= 0) return ''
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function FilterDialog({ isOpen, onClose, onApply, selection }) {
  const [conditions, setConditions] = useState([
    { column: selection.startCol, operator: 'greaterThan', value: '' }
  ])

  if (!isOpen) return null

  const handleAddCondition = () => {
    setConditions([...conditions, { column: selection.startCol, operator: 'greaterThan', value: '' }])
  }

  const handleRemoveCondition = (index) => {
    setConditions(conditions.filter((_, i) => i !== index))
  }

  const handleConditionChange = (index, field, value) => {
    const newConditions = [...conditions]
    newConditions[index][field] = field === 'value' ? value : value
    setConditions(newConditions)
  }

  const handleApply = () => {
    const validConditions = conditions.filter(c => c.value !== '')
    if (validConditions.length > 0) {
      onApply({
        startRow: selection.startRow,
        startCol: selection.startCol,
        endRow: selection.endRow,
        endCol: selection.endCol,
        conditions: validConditions
      })
      onClose()
    }
  }

  const operators = [
    { value: 'greaterThan', label: '大于' },
    { value: 'greaterThanOrEqual', label: '大于等于' },
    { value: 'lessThan', label: '小于' },
    { value: 'lessThanOrEqual', label: '小于等于' },
    { value: 'equal', label: '等于' },
    { value: 'notEqual', label: '不等于' },
    { value: 'contains', label: '包含' },
    { value: 'notContains', label: '不包含' }
  ]

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-96 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">筛选数据</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          {conditions.map((condition, index) => (
            <div key={index} className="flex gap-2 items-center">
              <select
                value={condition.column}
                onChange={(e) => handleConditionChange(index, 'column', parseInt(e.target.value))}
                className="px-2 py-1 border border-gray-300 rounded text-sm"
              >
                {Array.from({ length: selection.endCol - selection.startCol + 1 }, (_, i) => {
                  const col = selection.startCol + i
                  const colLetter = toExcelColumnName(col)
                  return (
                    <option key={col} value={col}>
                      列 {colLetter}
                    </option>
                  )
                })}
              </select>

              <select
                value={condition.operator}
                onChange={(e) => handleConditionChange(index, 'operator', e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded text-sm"
              >
                {operators.map(op => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>

              <input
                type="text"
                value={condition.value}
                onChange={(e) => handleConditionChange(index, 'value', e.target.value)}
                className="flex-1 px-2 py-1 border border-gray-300 rounded text-sm"
                placeholder="值"
              />

              {conditions.length > 1 && (
                <button
                  onClick={() => handleRemoveCondition(index)}
                  className="px-2 py-1 bg-red-500 text-white rounded text-sm hover:bg-red-600"
                >
                  删除
                </button>
              )}
            </div>
          ))}

          <button
            onClick={handleAddCondition}
            className="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
          >
            + 添加条件
          </button>

          <div className="flex gap-2 pt-4">
            <button
              onClick={handleApply}
              className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              应用筛选
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

export default FilterDialog
