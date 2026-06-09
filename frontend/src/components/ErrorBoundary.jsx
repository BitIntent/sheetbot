// frontend/src/components/ErrorBoundary.jsx
/**
 * ================================
 * 错误边界组件
 * - 捕获渲染错误并提示
 * ================================
 */
import React from 'react'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error) {
    if (this.props.onError) {
      this.props.onError(error)
    }
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          <div className="font-semibold mb-2">页面发生错误，已停止渲染</div>
          <div className="mb-3">建议刷新页面或重试操作。</div>
          <button
            className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700"
            onClick={this.handleReload}
          >
            刷新页面
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
