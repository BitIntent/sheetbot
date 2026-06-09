// ============================================================================
// 独立表单页入口 - 最小 React 挂载（不加载主应用）
// ============================================================================
import React from 'react'
import { createRoot } from 'react-dom/client'
import PublicForm from './components/collect/PublicForm'

const root = createRoot(document.getElementById('form-root'))
root.render(<PublicForm />)
