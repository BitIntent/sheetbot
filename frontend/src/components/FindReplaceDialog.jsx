// frontend/src/components/FindReplaceDialog.jsx
import React, { useState } from 'react'
import { X } from 'lucide-react'

function FindReplaceDialog({ isOpen, onClose, onFind, onReplace }) {
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [matchWholeCell, setMatchWholeCell] = useState(false)

  if (!isOpen) return null

  const handleFind = () => {
    if (findText.trim()) {
      onFind({ find: findText, matchCase, matchWholeCell })
    }
  }

  const handleReplace = () => {
    if (findText.trim()) {
      onReplace({ find: findText, replace: replaceText || findText, matchCase, matchWholeCell })
    }
  }

  const handleReplaceAll = () => {
    if (findText.trim()) {
      onReplace({ find: findText, replace: replaceText || findText, matchCase, matchWholeCell, replaceAll: true })
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-96 p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">查找和替换</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">查找内容</label>
            <input
              type="text"
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="输入要查找的内容"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">替换为</label>
            <input
              type="text"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="输入替换内容"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
                className="mr-2"
              />
              <span className="text-sm">区分大小写</span>
            </label>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={matchWholeCell}
                onChange={(e) => setMatchWholeCell(e.target.checked)}
                className="mr-2"
              />
              <span className="text-sm">完全匹配</span>
            </label>
          </div>

          <div className="flex gap-2 pt-4">
            <button
              onClick={handleFind}
              className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              查找
            </button>
            <button
              onClick={handleReplace}
              className="flex-1 px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
            >
              替换
            </button>
            <button
              onClick={handleReplaceAll}
              className="flex-1 px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600"
            >
              全部替换
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default FindReplaceDialog
