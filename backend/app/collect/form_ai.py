# ============================================================================
# 表单收集 - AI 字段推断
# 通过 Claude Agent SDK 分析列头语义，输出字段类型/校验/占位符配置
# ============================================================================
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from ..report.llm_client import call_llm_single
from ..utils.logger import get_logger

logger = get_logger("collect.form_ai")

# ── 系统提示词 ─────────────────────────────────────────────
_SYSTEM_PROMPT = """\
你是一位表单设计专家。用户会给你一组 Excel 列头名称，请你为每个列头生成最佳的在线表单字段配置。

规则：
1. 根据列头语义推断字段类型（text/textarea/number/phone/email/date/select/radio/checkbox）
2. 为每个字段设置合理的 placeholder（占位提示文本）
3. 判断哪些字段应该必填（required: true）
4. 为需要校验的字段设置 validation 规则
5. 如果列头暗示有限选项（如"性别""满意度"），推断出 options 列表并将 type 设为 select/radio
6. 同时生成一个 suggested_title（表单标题）和 suggested_description（简短说明）

严格以 JSON 格式输出，不要添加 markdown 代码块标记或任何多余文字。"""

_USER_PROMPT_TPL = """\
以下是 Excel 列头列表，请为每个列头生成表单字段配置：

列头：{columns}

输出格式：
{{
  "suggested_title": "...",
  "suggested_description": "...",
  "fields": [
    {{
      "key": "col_1",
      "label": "列头名称",
      "type": "text|textarea|number|phone|email|date|select|radio|checkbox",
      "required": true/false,
      "placeholder": "...",
      "validation": {{}},
      "options": []
    }}
  ]
}}"""


# ── 字段类型回退映射（当 LLM 不可用时） ──────────────────
_KEYWORD_TYPE_MAP = {
    "手机": "phone", "电话": "phone", "联系方式": "phone",
    "邮箱": "email", "email": "email", "邮件": "email",
    "日期": "date", "时间": "date", "出生": "date",
    "年龄": "number", "金额": "number", "价格": "number",
    "数量": "number", "预算": "number", "薪资": "number",
    "性别": "radio", "满意度": "radio", "评分": "radio",
    "备注": "textarea", "描述": "textarea", "说明": "textarea",
    "地址": "textarea", "意见": "textarea", "建议": "textarea",
}


def _fallback_infer(columns: List[str]) -> Dict[str, Any]:
    """LLM 不可用时的本地回退推断"""
    fields = []
    for idx, col in enumerate(columns, 1):
        field_type = "text"
        col_lower = col.lower()
        for kw, ft in _KEYWORD_TYPE_MAP.items():
            if kw in col_lower:
                field_type = ft
                break
        fields.append({
            "key": f"col_{idx}",
            "label": col,
            "type": field_type,
            "required": idx <= 2,
            "placeholder": f"请输入{col}",
            "validation": {},
            "options": [],
        })
    return {
        "suggested_title": "信息收集表单",
        "suggested_description": "请填写以下信息",
        "fields": fields,
    }


def _parse_json_response(text: str) -> Dict[str, Any]:
    """从 LLM 响应中提取 JSON"""
    # 去除 markdown 代码块标记
    cleaned = re.sub(r"```(?:json)?\s*", "", text).strip()
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()
    return json.loads(cleaned)


async def infer_form_config(columns: List[str]) -> Dict[str, Any]:
    """
    通过 LLM 分析列头语义，返回完整字段配置。
    LLM 失败时回退到本地关键词匹配。
    """
    if not columns:
        return {"suggested_title": "", "suggested_description": "", "fields": []}

    prompt = _USER_PROMPT_TPL.format(columns=json.dumps(columns, ensure_ascii=False))

    try:
        raw = await call_llm_single(
            prompt=prompt,
            system_prompt=_SYSTEM_PROMPT,
            timeout=60.0,
        )
        result = _parse_json_response(raw)

        # 确保 key 字段存在且唯一
        for idx, field in enumerate(result.get("fields", []), 1):
            if not field.get("key"):
                field["key"] = f"col_{idx}"

        logger.info("AI 推断完成: %d 个字段", len(result.get("fields", [])))
        return result

    except Exception as exc:
        logger.warning("AI 推断失败, 回退到本地推断: %s", exc)
        return _fallback_infer(columns)
