// frontend/src/components/FormulaBar.jsx
import React from 'react'

function FormulaBar({ value, onChange, onEnter }) {
  return (
    <div className="formula-bar" data-tour="formula-bar">
      <span className="formula-bar-label">fx</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onEnter()
          }
        }}
        className="formula-bar-input"
        placeholder="输入公式或值"
      />
    </div>
  )
}

export default FormulaBar
