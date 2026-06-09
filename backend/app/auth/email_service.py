"""
认证邮件发送服务。
"""
from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage
from typing import Optional
from urllib.parse import quote_plus

from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger("auth_email_service")


class AuthEmailService:
    """注册欢迎邮件 / 密码重置邮件发送服务。"""

    @staticmethod
    def is_enabled() -> bool:
        return bool(settings.SMTP_HOST and settings.SMTP_USER and settings.SMTP_PASSWORD)

    @staticmethod
    def build_password_reset_link(token: str) -> str:
        base = (settings.SHEETBOT_PUBLIC_BASE_URL or "").rstrip("/")
        safe_token = quote_plus(token)
        return f"{base}/landing.html?reset_token={safe_token}"

    @staticmethod
    async def send_register_success_email(to_email: str, username: str) -> bool:
        """发送注册成功邮件。"""
        if not AuthEmailService.is_enabled():
            logger.warning("SMTP 未配置，跳过注册成功邮件发送")
            return False
        subject = "欢迎加入 SheetBot｜你的账号已创建成功"
        html = f"""
        <html>
          <body style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f7fb;padding:24px;">
            <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6ebf4;border-radius:12px;padding:24px;">
              <h2 style="margin:0 0 12px;color:#1f2a44;">欢迎加入 SheetBot，{username}</h2>
              <p style="margin:0 0 12px;color:#3d4b66;line-height:1.7;">
                你的账号已注册成功。你可以立即登录并开始体验 AI 数据执行、报表与汇报能力。
              </p>
              <p style="margin:0 0 18px;color:#3d4b66;line-height:1.7;">
                登录入口：<a href="{settings.SHEETBOT_PUBLIC_BASE_URL}/landing.html" style="color:#2f6bff;text-decoration:none;">{settings.SHEETBOT_PUBLIC_BASE_URL}/landing.html</a>
              </p>
              <div style="padding:12px 14px;background:#f7fbff;border:1px solid #dbe8ff;border-radius:8px;color:#4b5d7a;font-size:13px;line-height:1.6;">
                若非本人操作，请及时联系系统管理员。
              </div>
            </div>
          </body>
        </html>
        """
        return await AuthEmailService._send_email_async(to_email, subject, html)

    @staticmethod
    async def send_password_reset_email(to_email: str, username: str, reset_link: str) -> bool:
        """发送密码重置邮件。"""
        if not AuthEmailService.is_enabled():
            logger.warning("SMTP 未配置，跳过密码重置邮件发送")
            return False
        minutes = settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES
        subject = "SheetBot 密码重置申请"
        html = f"""
        <html>
          <body style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:#f5f7fb;padding:24px;">
            <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6ebf4;border-radius:12px;padding:24px;">
              <h2 style="margin:0 0 12px;color:#1f2a44;">重置你的 SheetBot 密码</h2>
              <p style="margin:0 0 12px;color:#3d4b66;line-height:1.7;">
                用户 {username}，我们收到了你的密码重置请求。请点击下方链接设置新密码。
              </p>
              <p style="margin:0 0 12px;color:#3d4b66;line-height:1.7;">
                <a href="{reset_link}" style="display:inline-block;background:#2f6bff;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">重置密码</a>
              </p>
              <p style="margin:0 0 12px;color:#3d4b66;line-height:1.7;">
                或复制以下链接到浏览器打开：<br/>
                <a href="{reset_link}" style="color:#2f6bff;text-decoration:none;word-break:break-all;">{reset_link}</a>
              </p>
              <div style="padding:12px 14px;background:#fff8f0;border:1px solid #ffe5bf;border-radius:8px;color:#7a5a2f;font-size:13px;line-height:1.6;">
                该链接将在 {minutes} 分钟后失效。若非你本人操作，请忽略此邮件并尽快修改账号密码。
              </div>
            </div>
          </body>
        </html>
        """
        return await AuthEmailService._send_email_async(to_email, subject, html)

    @staticmethod
    async def _send_email_async(to_email: str, subject: str, html: str) -> bool:
        return await asyncio.to_thread(AuthEmailService._send_email_sync, to_email, subject, html)

    @staticmethod
    def _send_email_sync(to_email: str, subject: str, html: str) -> bool:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = f"{settings.SMTP_FROM_NAME} <{settings.SMTP_USER}>"
        msg["To"] = to_email
        msg.set_content("请使用支持 HTML 的邮件客户端查看本邮件内容。")
        msg.add_alternative(html, subtype="html")

        try:
            if settings.SMTP_USE_SSL:
                with smtplib.SMTP_SSL(
                    settings.SMTP_HOST,
                    settings.SMTP_PORT,
                    timeout=settings.SMTP_TIMEOUT_SECONDS,
                ) as smtp:
                    smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                    smtp.send_message(msg)
            else:
                with smtplib.SMTP(
                    settings.SMTP_HOST,
                    settings.SMTP_PORT,
                    timeout=settings.SMTP_TIMEOUT_SECONDS,
                ) as smtp:
                    smtp.starttls()
                    smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
                    smtp.send_message(msg)
            logger.info("认证邮件发送成功: to=%s subject=%s", to_email, subject)
            return True
        except Exception as exc:
            logger.error("认证邮件发送失败: to=%s subject=%s error=%s", to_email, subject, exc)
            return False
