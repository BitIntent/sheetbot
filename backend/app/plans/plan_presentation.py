"""套餐前台展示：由 subscription_plans + 配额生成 landing 卡片数据"""
from __future__ import annotations

import json
from typing import Any

# 前台展示顺序（不含已废弃套餐）
PUBLIC_PLAN_CODES = ("free", "pro", "premium", "enterprise")
CORE_PLAN_CODES = frozenset(PUBLIC_PLAN_CODES)
DEPRECATED_PLAN_CODES = frozenset({"starter"})


def _quota(plan: Any) -> dict[str, Any]:
    try:
        return json.loads(plan.quota_json or "{}")
    except Exception:
        return {}


def _yuan(fen: int) -> float:
    return (fen or 0) / 100


def _fmt_storage(mb: int) -> str:
    if mb == -1:
        return "云存储不限"
    if mb >= 1024:
        gb = mb / 1024
        label = f"{int(gb)} GB" if gb == int(gb) else f"{gb:.1f} GB"
        return f"{label} 云存储空间"
    return f"{mb} MB 云存储空间"


def _fmt_count(key: str, q: dict, label: str, unit: str = "") -> str | None:
    val = q.get(key, 0)
    if val == -1:
        return f"{label}不限"
    if val == 0:
        return None
    return f"{label} {val}{unit}"


def _feature(text: str, enabled: bool = True) -> dict:
    return {"text": text, "enabled": enabled}


def _build_free(plan: Any, q: dict) -> dict:
    monthly = _yuan(plan.price_monthly)
    yearly = _yuan(plan.price_yearly)
    feats = [
        _feature(_fmt_storage(q.get("storage_mb", 0))),
        _feature(f"单文件上限 {q.get('file_size_mb', 0)} MB"),
        _feature(f"AI 对话 {q.get('ai_daily', 0)} 次/天"),
        _feature(f"数据报表 {q.get('report_monthly', 0)} 次/月"),
        _feature(f"PPT 汇报 {q.get('ppt_monthly', 0)} 次/月"),
        _feature(f"表单收集 {q.get('form_count', 0)} 个 / {q.get('form_submissions', 0)} 条"),
        _feature(f"自定义公式 {q.get('formula_count', 0)} 个"),
        _feature("大文件分析", q.get("large_file_rows", 0) != 0),
        _feature("批量转 Word", q.get("batch_word_monthly", 0) != 0),
        _feature("外部系统连接器", q.get("connector_count", 0) != 0),
    ]
    return _card(plan, monthly, yearly, feats, price_label="免费", cta="免费注册", variant="free",
                desc="零成本体验 AI 办公核心能力，适合个人用户与轻度使用场景。")


def _build_pro(plan: Any, q: dict) -> dict:
    monthly = _yuan(plan.price_monthly)
    yearly = _yuan(plan.price_yearly)
    report_ppt = "报表 & PPT 不限次数" if q.get("report_monthly") == -1 else f"数据报表 {q.get('report_monthly')}/月"
    batch = q.get("batch_word_monthly", 0)
    if batch == -1:
        batch_txt, batch_ok = "批量转 Word 不限", True
    elif batch == 0:
        batch_txt, batch_ok = "批量转 Word", False
    else:
        batch_txt, batch_ok = f"批量转 Word {batch} 次/月", True
    form_c, form_s = q.get("form_count", 0), q.get("form_submissions", 0)
    form_txt = "表单收集不限" if form_c == -1 else f"表单收集 {form_c} 个 / 各 {form_s} 条"
    conn = q.get("connector_count", 0)
    if conn == -1:
        conn_txt, conn_ok = "外部连接器不限", True
    elif conn == 0:
        conn_txt, conn_ok = "外部系统连接器", False
    else:
        conn_txt, conn_ok = f"外部连接器 {conn} 个", True
    formula = q.get("formula_count", 0)
    if formula == -1:
        formula_txt = "自定义公式不限 + 技能库"
    else:
        formula_txt = f"自定义公式 {formula} 个 + 技能库"
    large_on = q.get("large_file_rows", 0) != 0
    ai_daily = q.get("ai_daily", 0)
    ai_txt = "AI 对话不限次数" if ai_daily == -1 else f"AI 对话 {ai_daily} 次/天"
    feats = [
        _feature(_fmt_storage(q.get("storage_mb", 0))),
        _feature(f"单文件上限 {q.get('file_size_mb', 0)} MB"),
        _feature(ai_txt),
        _feature("大文件分析（50 万行）" if large_on else "大文件分析", large_on),
        _feature(report_ppt),
        _feature(batch_txt, batch_ok),
        _feature(form_txt, form_c != 0),
        _feature(conn_txt, conn_ok),
        _feature(formula_txt),
        _feature("工单支持（48h 响应）"),
    ]
    return _card(plan, monthly, yearly, feats, badge="最受欢迎", highlight=True,
                desc="释放全部生产力工具，满足中高频 Excel 办公与数据分析需求。",
                cta="升级专业版", variant="pro")


def _build_premium(plan: Any, q: dict) -> dict:
    monthly = _yuan(plan.price_monthly)
    yearly = _yuan(plan.price_yearly)
    ai = "AI 对话不限次数" if q.get("ai_daily") == -1 else f"AI 对话 {q.get('ai_daily')} 次/天"
    large_on = q.get("large_file_rows", 0) != 0
    feats = [
        _feature(_fmt_storage(q.get("storage_mb", 0))),
        _feature(f"单文件上限 {q.get('file_size_mb', 0)} MB"),
        _feature(ai),
        _feature("大文件分析（不限行数）" if large_on else "大文件分析", large_on),
        _feature("报表 & PPT & 批量 Word 不限"),
        _feature("表单 & 连接器 & 公式不限"),
        _feature("技能库无限自建"),
        _feature("导出无水印"),
        _feature("专属顾问（8h 响应）"),
        _feature("优先体验新功能"),
    ]
    return _card(plan, monthly, yearly, feats,
                desc="零限制的极致体验，为重度数据用户与团队负责人打造。",
                cta="升级尊享版", variant="premium")


def _build_enterprise(plan: Any, _q: dict) -> dict:
    feats = [
        _feature("包含尊享版全部能力与服务"),
        _feature("永久使用授权，无需续费"),
        _feature("首年免费升级，续年可选购服务包"),
        _feature("优先技术支持通道，4h 内响应"),
        _feature("专属客户成功经理一对一服务"),
        _feature("工程师远程协助部署与环境调优"),
        _feature("部署到企业自有服务器，数据私有"),
        _feature("支持企业 Logo 与品牌定制"),
    ]
    return {
        "code": plan.code,
        "name": plan.name,
        "price_label": "联系我们",
        "price_monthly_yuan": None,
        "price_yearly_yuan": None,
        "yearly_save_yuan": None,
        "yearly_note": None,
        "badge": None,
        "highlight": False,
        "description": "一次买断，永久使用，全功能 + 长期运维保障，适合全公司推广落地。",
        "features": feats,
        "cta": "联系我们，咨询详细报价",
        "cta_action": "mailto",
        "variant": "enterprise",
    }


def _card(plan, monthly, yearly, feats, price_label=None, badge=None, highlight=False,
          desc=None, cta="", variant=""):
    save = max(0, round(monthly * 12 - yearly)) if monthly > 0 and yearly > 0 else 0
    yearly_note = f"年付 ¥{int(yearly) if yearly == int(yearly) else yearly}/年，省 ¥{save}" if yearly > 0 else None
    return {
        "code": plan.code,
        "name": plan.name,
        "price_label": price_label,
        "price_monthly_yuan": None if price_label else monthly,
        "price_yearly_yuan": None if price_label else yearly,
        "yearly_save_yuan": save if yearly > 0 else None,
        "yearly_note": yearly_note,
        "badge": badge,
        "highlight": highlight,
        "description": desc or "",
        "features": feats,
        "cta": cta,
        "cta_action": "scroll_login",
        "variant": variant,
    }


_BUILDERS = {
    "free": _build_free,
    "pro": _build_pro,
    "premium": _build_premium,
    "enterprise": _build_enterprise,
}


def build_public_plan(plan: Any) -> dict | None:
    """将 ORM 套餐转为前台卡片 JSON；未知 code 返回 None"""
    builder = _BUILDERS.get(plan.code)
    if not builder:
        return None
    return builder(plan, _quota(plan))
