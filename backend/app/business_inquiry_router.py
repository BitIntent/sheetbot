"""
官网商务咨询公开提交接口。
"""
from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage
from html import escape

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .business_inquiry_models import BusinessInquiry
from .core.config import settings
from .core.database import get_db
from .utils.logger import get_logger

logger = get_logger("business_inquiry.router")

router = APIRouter(prefix="/api/public/business-inquiries", tags=["business-inquiry"])

_ALLOWED_PRODUCTS = {"sheetbot", "geobot", "geoops", "knowledgebot", "atlasbot"}


class BusinessInquiryCreateRequest(BaseModel):
    product: str = Field(default="sheetbot")
    company_name: str = Field(min_length=1, max_length=255)
    contact_name: str = Field(min_length=1, max_length=100)
    phone: str = Field(min_length=5, max_length=64)
    email: str = Field(default="", max_length=255)
    message: str = Field(min_length=1, max_length=4000)
    source_page: str = Field(default="site_contact", max_length=128)


class BusinessInquiryCreateResponse(BaseModel):
    success: bool
    message: str
    inquiry_id: str


def _inquiry_notify_recipients() -> list[str]:
    raw = (settings.BUSINESS_INQUIRY_NOTIFY_EMAILS or "").strip()
    items = [x.strip() for x in raw.replace(";", ",").split(",")]
    return [x for x in items if x]


async def _send_business_inquiry_notify_email(
    *,
    inquiry_id: str,
    product: str,
    company_name: str,
    contact_name: str,
    phone: str,
    email: str,
    message: str,
    source_page: str,
) -> bool:
    if not (settings.SMTP_HOST and settings.SMTP_USER and settings.SMTP_PASSWORD):
        logger.warning("商务咨询通知邮件跳过：SMTP 未配置")
        return False
    recipients = _inquiry_notify_recipients()
    if not recipients:
        logger.warning("商务咨询通知邮件跳过：收件人未配置")
        return False

    subject = f"[官网商务咨询] {company_name} - {product}"
    html_body = f"""
    <html>
      <body style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:#f6f8fb;padding:24px;">
        <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e6ebf4;border-radius:12px;padding:20px;">
          <h2 style="margin:0 0 12px;color:#1f2a44;">收到新的官网商务咨询</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.7;color:#2f3b52;">
            <tr><td style="width:140px;padding:6px 0;color:#6b7a99;">线索ID</td><td style="padding:6px 0;">{escape(inquiry_id)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7a99;">咨询产品</td><td style="padding:6px 0;">{escape(product)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7a99;">公司名称</td><td style="padding:6px 0;">{escape(company_name)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7a99;">联系人</td><td style="padding:6px 0;">{escape(contact_name)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7a99;">联系电话</td><td style="padding:6px 0;">{escape(phone)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7a99;">邮箱</td><td style="padding:6px 0;">{escape(email or '-')}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7a99;">来源页面</td><td style="padding:6px 0;">{escape(source_page)}</td></tr>
          </table>
          <div style="margin-top:14px;padding:12px;background:#f8fbff;border:1px solid #dbe8ff;border-radius:8px;">
            <div style="font-weight:600;color:#1f2a44;margin-bottom:6px;">需求说明</div>
            <div style="white-space:pre-wrap;color:#2f3b52;">{escape(message)}</div>
          </div>
        </div>
      </body>
    </html>
    """
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{settings.SMTP_FROM_NAME} <{settings.SMTP_USER}>"
    msg["To"] = ", ".join(recipients)
    msg.set_content("请使用支持 HTML 的邮件客户端查看商务咨询通知。")
    msg.add_alternative(html_body, subtype="html")

    def _send_sync() -> bool:
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
            return True
        except Exception as exc:
            logger.error("商务咨询通知邮件发送失败: inquiry_id=%s error=%s", inquiry_id, exc)
            return False

    ok = await asyncio.to_thread(_send_sync)
    if ok:
        logger.info("商务咨询通知邮件已发送: inquiry_id=%s to=%s", inquiry_id, recipients)
    return ok


@router.post("", response_model=BusinessInquiryCreateResponse)
async def create_business_inquiry(
    body: BusinessInquiryCreateRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """提交商务咨询信息。"""
    product = str(body.product or "sheetbot").strip().lower()
    if product not in _ALLOWED_PRODUCTS:
        raise HTTPException(status_code=400, detail="咨询产品不合法")

    company_name = body.company_name.strip()
    contact_name = body.contact_name.strip()
    phone = body.phone.strip()
    message = body.message.strip()
    email = body.email.strip()
    source_page = body.source_page.strip() or "site_contact"
    if not company_name or not contact_name or not phone or not message:
        raise HTTPException(status_code=400, detail="请填写完整信息后再提交")

    ip_address = request.client.host if request.client else None
    user_agent = (request.headers.get("user-agent", "") or "")[:500]

    inquiry = BusinessInquiry(
        product=product,
        company_name=company_name,
        contact_name=contact_name,
        phone=phone,
        email=email,
        message=message,
        source_page=source_page,
        ip_address=ip_address,
        user_agent=user_agent,
    )
    db.add(inquiry)
    await db.flush()
    logger.info(f"收到商务咨询: product={product}, inquiry_id={inquiry.id}")
    # 邮件通知失败不阻断主流程，避免影响官网表单提交体验。
    await _send_business_inquiry_notify_email(
        inquiry_id=inquiry.id,
        product=product,
        company_name=company_name,
        contact_name=contact_name,
        phone=phone,
        email=email,
        message=message,
        source_page=source_page,
    )

    return BusinessInquiryCreateResponse(
        success=True,
        message="咨询信息已提交，我们会尽快与您联系",
        inquiry_id=inquiry.id,
    )
