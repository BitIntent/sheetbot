# backend/app/batch_word/auto_annotator.py
"""
批量转 Word - LLM 自动标注
使用 Claude Agent SDK 分析 Word 文档内容，智能识别可替换字段
"""
import json
import re
from typing import List, Dict

from ..report.llm_client import call_llm_single
from ..utils.logger import get_logger

logger = get_logger("batch_word.auto_annotator")

SYSTEM_PROMPT = (
    "你是一位 Word 文档标注专家。"
    "用户会给你一份 Word 文档的文本内容和一组 Excel 列头。"
    "你的任务是：识别文档中应该被 Excel 数据替换的字段，"
    "并建议使用 {列名} 格式的标注符。"
    "严格按 JSON 格式返回结果，不要添加任何其他文字。"
)


def _build_prompt(doc_text: str, excel_columns: List[str], has_image_slot: bool = False) -> str:
    """构造 LLM prompt"""
    cols_str = "、".join(excel_columns)
    image_hint = "模板中检测到图片位，请优先尝试输出与图片相关字段（如{照片}/{头像}）。" if has_image_slot else ""
    return f"""以下是一份 Word 文档的文本内容：

---
{doc_text[:3000]}
---

Excel 列头列表：{cols_str}
{image_hint}

请分析文档内容，识别其中应该被 Excel 数据替换的字段。
不仅要识别明显的姓名/日期/编号，也要识别示例值、演示数据、占位语句；如果存在图片位，也要给出图片字段标注建议。
强约束：
1) 只标注“字段值”本身，不标注标题/标签/固定说明文字。
2) 禁止把文档标题、文档名、页眉页脚、说明文本中的关键词替换为字段（如：准考证、演示、说明、Q文档、网址）。
3) 优先标注表格中的值单元格，不要标注表头单元格。
4) original_text 必须是文档中可被精确替换的一小段值文本，避免过长语句。

返回 JSON 数组，每个元素包含：
- original_text: 文档中的原始文本片段（尽量精确到具体值）
- placeholder: 建议的标注符，格式为 {{列名}}
- column: 对应的 Excel 列名（必须是上面列头中的某一个）
- confidence: 置信度 0.0-1.0

只返回纯 JSON 数组，不要包含 markdown 代码块或其他文字。

示例：
[
  {{"original_text": "张三", "placeholder": "{{姓名}}", "column": "姓名", "confidence": 0.95}},
  {{"original_text": "2024年1月1日", "placeholder": "{{日期}}", "column": "日期", "confidence": 0.8}}
]"""


def _parse_llm_response(text: str) -> List[Dict]:
    """从 LLM 响应中提取 JSON 数组"""
    text = text.strip()

    # 尝试去除 markdown 代码块标记
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    try:
        result = json.loads(text)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    # 回退：用正则提取 JSON 数组
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    logger.warning("无法解析 LLM 标注结果: %s...", text[:200])
    return []


async def auto_annotate(
    doc_text: str,
    excel_columns: List[str],
    has_image_slot: bool = False,
) -> List[Dict]:
    """
    调用 LLM 自动标注 Word 文档。
    
    Returns:
        [{"original_text", "placeholder", "column", "confidence"}, ...]
    """
    prompt = _build_prompt(doc_text, excel_columns, has_image_slot=has_image_slot)

    try:
        raw = await call_llm_single(
            prompt=prompt,
            system_prompt=SYSTEM_PROMPT,
            max_tokens=4096,
            timeout=60.0,
        )
        suggestions = _parse_llm_response(raw)

        # 过滤无效项：column 必须在列头中
        col_set = set(excel_columns)
        valid = [
            s for s in suggestions
            if s.get("column") in col_set and s.get("placeholder")
        ]

        # 兜底：模板有图片位时，尽量补一条图片映射建议
        if has_image_slot and not any(("照片" in str(s.get("column", "")) or "头像" in str(s.get("column", "")) or "image" in str(s.get("column", "")).lower()) for s in valid):
            image_cols = [c for c in excel_columns if any(k in c for k in ("照片", "头像", "图片", "image", "Image", "IMAGE"))]
            if image_cols:
                c = image_cols[0]
                valid.append({
                    "original_text": "图片位",
                    "placeholder": "{照片}",
                    "column": c,
                    "confidence": 0.78,
                })

        logger.info("AI 标注完成: 总建议=%d 有效=%d", len(suggestions), len(valid))
        return valid

    except Exception as e:
        logger.error("AI 标注失败: %s", e)
        raise
