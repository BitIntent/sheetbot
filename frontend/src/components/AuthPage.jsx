// frontend/src/components/AuthPage.jsx
import React, { useState, useEffect } from 'react'
import { Mail, Lock, User, Moon, Sun, BarChart2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import './../styles/AuthPage.css'

function AuthPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('auth-theme')
    if (stored) return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    username: ''
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('auth-theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
    setError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setIsSubmitting(true)
    try {
      if (mode === 'register') {
        await register({
          username: formData.username.trim(),
          email: formData.email.trim(),
          password: formData.password
        })
        setMode('login')
        setFormData(prev => ({ ...prev, password: '', confirmPassword: '' }))
        setError('')
      } else {
        await login({
          username: formData.email.trim(),
          password: formData.password
        })
        window.location.href = '/'
      }
    } catch (err) {
      setError(err.message || '操作失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const switchMode = () => {
    setMode(prev => prev === 'login' ? 'register' : 'login')
    setFormData({ email: '', password: '', confirmPassword: '', username: '' })
    setError('')
  }

  const isRegisterValid = mode === 'register'
    ? formData.password === formData.confirmPassword && formData.password.length >= 6 && formData.username.trim().length >= 3
    : true
  const isLoginValid = formData.email && formData.password

  return (
    <div className="auth-page">
      <button
        type="button"
        className="auth-theme-toggle"
        onClick={toggleTheme}
        title={theme === 'dark' ? '切换亮色模式' : '切换深色模式'}
        aria-label={theme === 'dark' ? '切换亮色模式' : '切换深色模式'}
      >
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
      </button>

      <div className="auth-content">
        <div className="auth-card">
          <div className="auth-brand">
            <div className="auth-brand-icon">
              <BarChart2 size={28} strokeWidth={2.5} />
            </div>
            <h1 className="auth-brand-title">SheetBot</h1>
            <p className="auth-brand-subtitle">
              {mode === 'login' ? '登录以继续使用' : '创建账户开始使用'}
            </p>
          </div>

          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
              onClick={() => setMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
              onClick={() => setMode('register')}
            >
              注册
            </button>
          </div>

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <form className="auth-form auth-form-enter" onSubmit={handleSubmit}>
            {mode === 'register' && (
              <div className="auth-field">
                <label htmlFor="username">用户名</label>
                <div className="auth-input-wrapper">
                  <User size={18} />
                  <input
                    id="username"
                    name="username"
                    type="text"
                    className="auth-input"
                    placeholder="至少 3 个字符"
                    value={formData.username}
                    onChange={handleChange}
                    autoComplete="username"
                  />
                </div>
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="email">{mode === 'login' ? '用户名或邮箱' : '邮箱'}</label>
              <div className="auth-input-wrapper">
                <Mail size={18} />
                <input
                  id="email"
                  name="email"
                  type={mode === 'login' ? 'text' : 'email'}
                  className="auth-input"
                  placeholder={mode === 'login' ? '请输入用户名或邮箱' : '请输入邮箱'}
                  value={formData.email}
                  onChange={handleChange}
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="password">密码</label>
              <div className="auth-input-wrapper">
                <Lock size={18} />
                <input
                  id="password"
                  name="password"
                  type="password"
                  className="auth-input"
                  placeholder={mode === 'login' ? '请输入密码' : '至少 6 位字符'}
                  value={formData.password}
                  onChange={handleChange}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </div>
            </div>

            {mode === 'register' && (
              <div className="auth-field">
                <label htmlFor="confirmPassword">确认密码</label>
                <div className="auth-input-wrapper">
                  <Lock size={18} />
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    className="auth-input"
                    placeholder="请再次输入密码"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    autoComplete="new-password"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              className="auth-submit"
              disabled={isSubmitting || (mode === 'login' ? !isLoginValid : !isRegisterValid)}
            >
              {isSubmitting ? '处理中...' : mode === 'login' ? '登录' : '注册'}
            </button>
          </form>

          <div className="auth-switch">
            <span className="auth-switch-text">
              {mode === 'login' ? '还没有账户？' : '已有账户？'}
            </span>{' '}
            <button
              type="button"
              className="auth-switch-link"
              onClick={switchMode}
            >
              {mode === 'login' ? '立即注册' : '去登录'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AuthPage
