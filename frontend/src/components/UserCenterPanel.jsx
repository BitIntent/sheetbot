/**
 * ============================================================================
 * 用户中心面板 - 从 Sidebar 用户图标弹出
 * - 账户信息展示（只读）
 * - 修改密码（全设备强制重新登录）
 * - 更新邮箱（需密码确认）
 * ============================================================================
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, User, Lock, Mail, Eye, EyeOff, LogOut, Crown } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import * as authApi from '../api/auth'
import * as plansApi from '../api/plans'

// ===== 密码可见性切换输入框 =====
function PasswordInput({ value, onChange, placeholder, autoFocus }) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="uc-password-wrap">
      <input
        type={visible ? 'text' : 'password'}
        className="uc-input"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      <button
        type="button"
        className="uc-eye-btn"
        onClick={() => setVisible(v => !v)}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}

export default function UserCenterPanel({ open, onClose }) {
  const { t } = useTranslation()
  const { user, accessToken, logout } = useAuth()
  const panelRef = useRef(null)

  // ===== 修改密码表单 =====
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)

  // ===== 更新邮箱表单 =====
  const [newEmail, setNewEmail] = useState('')
  const [emailPwd, setEmailPwd] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)

  const [toast, setToast] = useState(null)

  // ===== 我的套餐（只读） =====
  const [subscription, setSubscription] = useState(null)

  const loadSubscription = useCallback(() => {
    if (!accessToken) return
    plansApi.getMySubscription(accessToken)
      .then((s) => setSubscription(s))
      .catch(() => setSubscription(null))
  }, [accessToken])

  // ===== 重置表单 =====
  useEffect(() => {
    if (open) {
      setOldPwd('')
      setNewPwd('')
      setConfirmPwd('')
      setNewEmail('')
      setEmailPwd('')
      setToast(null)
      loadSubscription()
    }
  }, [open, loadSubscription])

  // ===== 点击外部关闭 =====
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  const showToast = useCallback((msg, isError = false) => {
    setToast({ msg, isError })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // ===== 修改密码 =====
  const handleChangePassword = useCallback(async () => {
    if (!oldPwd.trim()) return showToast(t('userCenter.errOldRequired'), true)
    if (newPwd.length < 6) return showToast(t('userCenter.errNewMinLen'), true)
    if (newPwd !== confirmPwd) return showToast(t('userCenter.errConfirmMismatch'), true)

    setPwdSaving(true)
    try {
      await authApi.changePassword(accessToken, {
        old_password: oldPwd,
        new_password: newPwd,
      })
      showToast(t('userCenter.pwdSuccess'))
      setTimeout(() => logout(), 1500)
    } catch (e) {
      showToast(e.message, true)
    } finally {
      setPwdSaving(false)
    }
  }, [oldPwd, newPwd, confirmPwd, accessToken, logout, showToast, t])

  // ===== 更新邮箱 =====
  const handleChangeEmail = useCallback(async () => {
    if (!newEmail.trim()) return showToast(t('userCenter.errEmailRequired'), true)
    if (!emailPwd.trim()) return showToast(t('userCenter.errPwdRequired'), true)

    setEmailSaving(true)
    try {
      await authApi.changeEmail(accessToken, {
        new_email: newEmail,
        password: emailPwd,
      })
      showToast(t('userCenter.emailSuccess'))
      setNewEmail('')
      setEmailPwd('')
    } catch (e) {
      showToast(e.message, true)
    } finally {
      setEmailSaving(false)
    }
  }, [newEmail, emailPwd, accessToken, showToast, t])

  if (!open) return null

  return (
    <div className="uc-panel" ref={panelRef}>
      {/* ===== Header ===== */}
      <div className="uc-panel-header">
        <span className="uc-panel-title">
          <User size={16} style={{ marginRight: 6 }} />
          {t('userCenter.title')}
        </span>
        <button className="uc-panel-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="uc-panel-body">
        {/* ===== 账户信息 ===== */}
        <div className="uc-section">
          <div className="uc-section-label">{t('userCenter.accountInfo')}</div>
          <div className="uc-info-row">
            <span className="uc-info-key">{t('userCenter.username')}</span>
            <span className="uc-info-val">{user?.username}</span>
          </div>
          <div className="uc-info-row">
            <span className="uc-info-key">{t('userCenter.email')}</span>
            <span className="uc-info-val">{user?.email}</span>
          </div>
          {user?.display_name && (
            <div className="uc-info-row">
              <span className="uc-info-key">{t('userCenter.displayName')}</span>
              <span className="uc-info-val">{user.display_name}</span>
            </div>
          )}
        </div>

        {/* ===== 我的套餐 ===== */}
        <div className="uc-section">
          <div className="uc-section-label">
            <Crown size={13} style={{ marginRight: 4 }} />
            我的套餐
          </div>
          <div className="uc-info-row">
            <span className="uc-info-key">当前套餐</span>
            <span className="uc-info-val">{subscription?.plan_name || '免费版'}</span>
          </div>
          {subscription?.expires_at && (
            <div className="uc-info-row">
              <span className="uc-info-key">到期时间</span>
              <span className="uc-info-val">
                {new Date(subscription.expires_at).toLocaleDateString('zh-CN')}
              </span>
            </div>
          )}
        </div>

        {/* ===== 修改密码 ===== */}
        <div className="uc-section">
          <div className="uc-section-label">
            <Lock size={13} style={{ marginRight: 4 }} />
            {t('userCenter.changePwd')}
          </div>
          <PasswordInput
            value={oldPwd}
            onChange={e => setOldPwd(e.target.value)}
            placeholder={t('userCenter.oldPwd')}
          />
          <PasswordInput
            value={newPwd}
            onChange={e => setNewPwd(e.target.value)}
            placeholder={t('userCenter.newPwd')}
          />
          <PasswordInput
            value={confirmPwd}
            onChange={e => setConfirmPwd(e.target.value)}
            placeholder={t('userCenter.confirmPwd')}
          />
          <div className="uc-hint">{t('userCenter.pwdHint')}</div>
          <button
            className="uc-action-btn"
            onClick={handleChangePassword}
            disabled={pwdSaving}
          >
            {pwdSaving ? t('userCenter.saving') : t('userCenter.changePwdBtn')}
          </button>
        </div>

        {/* ===== 更新邮箱 ===== */}
        <div className="uc-section">
          <div className="uc-section-label">
            <Mail size={13} style={{ marginRight: 4 }} />
            {t('userCenter.changeEmail')}
          </div>
          <input
            type="email"
            className="uc-input"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            placeholder={t('userCenter.newEmail')}
          />
          <PasswordInput
            value={emailPwd}
            onChange={e => setEmailPwd(e.target.value)}
            placeholder={t('userCenter.emailPwdConfirm')}
          />
          <button
            className="uc-action-btn"
            onClick={handleChangeEmail}
            disabled={emailSaving}
          >
            {emailSaving ? t('userCenter.saving') : t('userCenter.changeEmailBtn')}
          </button>
        </div>

        {/* ===== 退出登录 ===== */}
        <div className="uc-section uc-section-logout">
          <button className="uc-logout-btn" onClick={logout}>
            <LogOut size={14} style={{ marginRight: 4 }} />
            {t('userCenter.logout')}
          </button>
        </div>

        {/* ===== Toast ===== */}
        {toast && (
          <div className={`uc-toast ${toast.isError ? 'error' : 'success'}`}>
            {toast.msg}
          </div>
        )}
      </div>
    </div>
  )
}
