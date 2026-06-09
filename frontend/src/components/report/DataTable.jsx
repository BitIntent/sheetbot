import React, { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

export default function DataTable({ headers, rows, title = '明细数据' }) {
  const [expanded, setExpanded] = useState(false)

  if (!headers?.length || !rows?.length) return null

  const displayRows = expanded ? rows : rows.slice(0, 10)

  return (
    <div className="report-data-table-section report-fade-in">
      <div className="report-data-table-header" onClick={() => setExpanded(!expanded)}>
        <h3>{title}</h3>
        <span className="report-data-table-toggle">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {expanded ? '收起' : `展开全部 (${rows.length}条)`}
        </span>
      </div>
      <div className="report-data-table-wrapper">
        <table className="report-data-table">
          <thead>
            <tr>
              {headers.map((h, i) => <th key={i}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, ri) => (
              <tr key={ri}>
                {headers.map((h, ci) => <td key={ci}>{row[h] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
