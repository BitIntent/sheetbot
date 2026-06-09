// frontend/src/components/SheetTabs.jsx
import React, { useState } from 'react'
import { Plus, X } from 'lucide-react'

function SheetTabs({
  sheets,
  activeSheet,
  onSelectSheet,
  onAddSheet,
  onDeleteSheet,
  onRenameSheet,
  onCloseResultSheet,
  largeFileMode
}) {
  const [editingSheet, setEditingSheet] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [hasFocus, setHasFocus] = useState(false)
  
  const handleRename = (sheetName) => {
    setEditingSheet(sheetName)
    setEditingName(sheetName)
  }
  
  const handleRenameSubmit = () => {
    if (editingName && editingName !== editingSheet) {
      onRenameSheet(editingSheet, editingName)
    }
    setEditingSheet(null)
    setEditingName('')
  }
  
  return (
    <div
      className="flex items-center border-b border-gray-300 bg-gray-50"
      data-tour="sheet-tabs"
      onFocusCapture={() => setHasFocus(true)}
      onBlurCapture={() => setHasFocus(false)}
    >
      {sheets.map(sheet => (
        <div
          key={sheet.name}
          className={`flex items-center px-4 py-2 border-r border-gray-300 cursor-pointer ${
            activeSheet === sheet.name ? 'bg-white border-b-2 border-b-blue-500' : 'hover:bg-gray-100'
          } ${sheet.isResultSheet ? 'result-sheet-tab' : ''}`}
          onClick={() => onSelectSheet(sheet.name)}
        >
          {editingSheet === sheet.name ? (
            <input
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit()
                if (e.key === 'Escape') {
                  setEditingSheet(null)
                  setEditingName('')
                }
              }}
              className="px-1 py-0 text-sm border border-blue-500 rounded focus:outline-none"
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span
                className={`text-sm ${activeSheet === sheet.name && hasFocus ? 'font-bold' : ''}`}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  handleRename(sheet.name)
                }}
              >
                {sheet.name}
              </span>
              {sheet.isResultSheet ? (
                <button
                  className="ml-2 text-gray-400 hover:text-red-600"
                  title="关闭结果工作表"
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseResultSheet?.(sheet.name)
                  }}
                >
                  <X size={14} />
                </button>
              ) : (
                sheets.length > 1 && !largeFileMode && (
                  <button
                    className="ml-2 text-gray-400 hover:text-red-600"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteSheet(sheet.name)
                    }}
                  >
                    <X size={14} />
                  </button>
                )
              )}
            </>
          )}
        </div>
      ))}
      <button
        className="px-4 py-2 text-gray-600 hover:bg-gray-100"
        onClick={onAddSheet}
        title="添加工作表"
      >
        <Plus size={16} />
      </button>
    </div>
  )
}

export default SheetTabs
