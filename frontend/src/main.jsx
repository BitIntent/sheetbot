import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
/* 全局样式必须在 App 之前加载，否则 Vite 去重会导致 index.css 深色规则覆盖浅色 override */
import './styles/theme.css'
import './styles/report.css'
import './index.css'
import './styles/workspace-light-overrides.css'
import './styles/sheetbot-ai-panel.css'
import './styles/sheetbot-dialogs.css'
import './styles/platform-view-toolbar.css'
import './styles/platform-list-ui.css'
import './styles/batch-word.css'
import './styles/presentation.css'
import App from './App'
import ShareReportPage from './pages/ShareReportPage'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { NotificationProvider } from './contexts/NotificationContext'
import { ConfigProvider } from './contexts/ConfigContext'
import { reportClientDiag } from './utils/clientDiagLogger'

function isShareReportRoute() {
  return window.location.pathname.startsWith('/share/report/')
}

function getShareToken() {
  const match = window.location.pathname.match(/^\/share\/report\/([a-f0-9]+)$/)
  return match ? match[1] : null
}

function isAuthDebugMode() {
  if (typeof window === 'undefined') return false
  const qs = new URLSearchParams(window.location.search || '')
  return qs.get('debug-auth') === '1'
}

function hasAnyAuthToken() {
  if (typeof window === 'undefined') return false
  const access = localStorage.getItem('sheetbot_access_token') || sessionStorage.getItem('sheetbot_access_token')
  const refresh = localStorage.getItem('sheetbot_refresh_token') || sessionStorage.getItem('sheetbot_refresh_token')
  return !!(access && refresh)
}

function redirectToLanding(reason = 'unknown', detail = {}) {
  reportClientDiag('redirect_to_landing', { reason, ...detail })
  console.warn('[AuthRedirect] 跳转 landing', { reason, ...detail })
  window.location.replace('/landing.html')
}

function Root() {
  const { isAuthenticated, loading } = useAuth()
  const authDebugMode = isAuthDebugMode()
  React.useEffect(() => {
    if (!loading && !isAuthenticated) {
      reportClientDiag('workspace_unauthenticated', {
        path: window.location.pathname,
        hasToken: !!localStorage.getItem('sheetbot_access_token'),
        debugMode: authDebugMode,
      })
    }
  }, [loading, isAuthenticated, authDebugMode])

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-primary, #F4F6F9)',
        color: 'var(--text-primary, #0F172A)',
        fontSize: 14
      }}>
        加载中...
      </div>
    )
  }
  if (isAuthenticated) return <App />
  if (authDebugMode) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-primary, #F4F6F9)',
        color: 'var(--text-primary, #0F172A)',
        fontSize: 14,
        padding: 24,
        textAlign: 'center',
      }}>
        鉴权调试模式：未登录状态下不自动跳转。请查看网络与后端日志。
      </div>
    )
  }
  // 旧登录页停用：未登录统一回到官网登录窗口
  redirectToLanding('root_not_authenticated', { path: window.location.pathname })
  return null
}

function AppEntry() {
  reportClientDiag('app_entry_boot', {
    path: window.location.pathname,
    hasToken: hasAnyAuthToken(),
  })

  // 根路径统一展示官网落地页（由 landing.html 承载登录/注册）
  if (window.location.pathname === '/' && !hasAnyAuthToken()) {
    redirectToLanding('entry_root_path')
    return null
  }

  if (isShareReportRoute()) {
    const token = getShareToken()
    return <ShareReportPage shareToken={token} />
  }
  return (
    <AuthProvider>
      <NotificationProvider>
        <ConfigProvider>
          <Root />
        </ConfigProvider>
      </NotificationProvider>
    </AuthProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppEntry />
  </React.StrictMode>,
)
