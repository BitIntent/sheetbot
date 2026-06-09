# ============================================================================
# 根据工作簿元数据，由 LLM 生成若干条可执行的 AI 指令建议（普通模式助手）
# 多工作表感知 + 跨表数据分析专家视角
# ============================================================================
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

from ..report.llm_client import call_llm_single
from ..utils.json_output_guard import extract_json_object
from ..utils.logger import get_logger

logger = get_logger("excel.prompt_suggest")

# ------------------------------------------------------------------
# 系统提示词：数据分析专家视角，多工作表感知
# ------------------------------------------------------------------
_SYSTEM = """\
你是一位资深数据分析专家兼 Excel 高级用户。根据 JSON 工作簿结构摘要生成恰好 5 条中文指令建议。

## 输入结构
```json
{
  "activeSheet": "当前活动表名",
  "currentFileName": "文件名",
  "sheetCount": 3,
  "sheets": [
    {"name": "表名", "headers": ["列A","列B",...], "approxDataRows": 200},
    ...
  ]
}
```

## 工作表分配规则（强制，必须严格遵守）

- 当 sheets 只有 1 张时：5 条全部关于该表。
- 当 sheets 有 2 张时：活动表 3 条，另一张表 2 条。
- 当 sheets 有 3 张及以上时：活动表 2 条，其余表各至少 1 条（不足则轮流分配），总计 5 条。
- **违规判定**：如果 5 条建议全部是同一张表，视为失败输出。

## 生成策略

1. **全表学习**：逐一分析每张 sheet 的 name/headers/approxDataRows，理解业务含义。
2. **分表独立建议**：为每张表基于其自身 headers 生成有针对性的操作指令。
3. **差异化覆盖**：5 条覆盖不同维度 -- 格式美化、排序筛选、统计汇总、条件高亮、图表可视化。
4. **数据量敏感**：approxDataRows > 50 的表优先推荐统计/可视化指令。

## 硬性约束

1. 每条必须写出工作表名称，用直角引号包裹，表名必须与 JSON 中的 name 逐字一致。
2. 列名必须取自对应工作表的 headers，不得跨表混用或虚构列名。
3. 每条是一步即可完成的操作指令（15~80 字，口语化）：
   - 允许：加粗/底纹/列宽、排序、筛选、去重、条件格式、分组汇总、图表、数字格式、合并单元格
   - 禁止：SQL、VBA、宏、跨簿操作、模糊的"全面分析"
4. approxDataRows = 0 或无 headers 的表只做格式化建议。

## 输出格式
只输出一个 JSON 对象，不要 markdown 代码块、不要解释：
{"suggestions":["...","...","...","...","..."]}"""


def _sheet_names_from_metadata(metadata: Dict[str, Any]) -> List[str]:
    sheets = metadata.get("sheets")
    if not isinstance(sheets, list):
        return []
    return [
        str(s.get("name") or "").strip()
        for s in sheets
        if isinstance(s, dict) and str(s.get("name") or "").strip()
    ]


def _sanitize_suggestions(
    suggestions: List[str],
    sheet_names: List[str],
) -> List[str]:
    """
    轻量修正：只校验「」内恰好是已知表名的引用是否拼写正确。
    不把列名等非表名引用当作错误，不丢弃任何建议。
    """
    if not sheet_names or not suggestions:
        return suggestions
    name_set = set(sheet_names)
    name_lower_map = {n.lower(): n for n in sheet_names}
    out: List[str] = []
    for s in suggestions:
        refs = re.findall(r'\u300c([^\u300d]+)\u300d', s)
        for ref in refs:
            if ref in name_set:
                continue
            # 只在大小写不匹配时纠正（如 sheet1 -> Sheet1）
            if ref.lower() in name_lower_map:
                correct = name_lower_map[ref.lower()]
                s = s.replace(f'\u300c{ref}\u300d', f'\u300c{correct}\u300d', 1)
            # 否则视为列名或其他文本，不做处理，不丢弃
        out.append(s)
    return out


def _fallback_pad(
    active_sheet: str,
    sheet_names: List[str],
    items: List[str],
) -> List[str]:
    """兜底补齐：不足 5 条时用多表模板轮流补充"""
    out = [x for x in (s.strip() for s in items) if x][:5]
    if len(out) >= 5:
        return out

    # 构建多表兜底池：使用统一模板源，避免与规则降级逻辑漂移
    pool: List[str] = []
    targets = sheet_names if sheet_names else [active_sheet or "Sheet1"]
    for s in targets:
        pool.extend(_sheet_template_suggestions(s, []))

    idx = 0
    while len(out) < 5 and pool:
        candidate = pool[idx % len(pool)]
        if candidate not in out:
            out.append(candidate)
        idx += 1
        if idx >= len(pool) * 2:
            break

    # 极端兜底
    fallback_sheet = active_sheet or "Sheet1"
    while len(out) < 5:
        out.append(f"\u628a\u300c{fallback_sheet}\u300d\u7b2c\u4e00\u884c\u8868\u5934\u52a0\u7c97\u5e76\u81ea\u52a8\u8c03\u6574\u5217\u5bbd\u3002")
        break
    return out[:5]


def _looks_numeric_header(name: str) -> bool:
    text = str(name or "").strip().lower()
    if not text:
        return False
    hints = (
        "金额", "数量", "单价", "销量", "销售额", "成本", "利润", "折扣", "税", "price",
        "amount", "qty", "quantity", "total", "cost", "profit", "rate",
    )
    return any(k in text for k in hints)


def _sheet_template_suggestions(sheet_name: str, headers: List[str]) -> List[str]:
    """单一模板源：同一工作表的标准建议序列（按优先级）。"""
    cleaned_headers = [str(h).strip() for h in (headers or []) if str(h).strip()]
    numeric_headers = [h for h in cleaned_headers if _looks_numeric_header(h)]
    first_header = cleaned_headers[0] if cleaned_headers else ""
    first_metric = numeric_headers[0] if numeric_headers else ""

    items = [
        f"把「{sheet_name}」首行表头加粗并设置浅色底纹，同时自动调整列宽。",
    ]
    if first_metric:
        items.append(f"在「{sheet_name}」对「{first_metric}」应用条件格式：高于均值标绿色，低于均值标蓝色。")
        items.append(f"把「{sheet_name}」中的「{first_metric}」设置为带千分位的数字格式。")
        items.append(f"在「{sheet_name}」高亮「{first_metric}」前3名所在行，便于识别头部数据。")
    elif first_header:
        items.append(f"在「{sheet_name}」按「{first_header}」升序排序，并高亮重复值。")
    else:
        items.append(f"在「{sheet_name}」创建基础表格样式并添加边框，便于后续录入。")
    items.append(f"对「{sheet_name}」的数据区域执行去重，清理重复记录。")
    return items


def _build_rule_based_suggestions(metadata: Dict[str, Any]) -> List[str]:
    """
    LLM 失败时的确定性兜底建议（不依赖模型，保证可用性）。
    目标：按工作表分布给出 5 条可执行建议。
    """
    if not isinstance(metadata, dict):
        return []
    active = str(metadata.get("activeSheet") or "").strip()
    sheets = metadata.get("sheets") if isinstance(metadata.get("sheets"), list) else []
    valid_sheets = [s for s in sheets if isinstance(s, dict) and str(s.get("name") or "").strip()]
    if not valid_sheets:
        return []

    names = [str(s.get("name")).strip() for s in valid_sheets]
    if not active or active not in names:
        active = names[0]

    ordered = [active] + [n for n in names if n != active]
    suggest: List[str] = []

    for name in ordered:
        if len(suggest) >= 5:
            break
        sheet = next((s for s in valid_sheets if str(s.get("name")).strip() == name), {})
        headers = [str(h).strip() for h in (sheet.get("headers") or []) if str(h).strip()]
        suggest.extend(_sheet_template_suggestions(name, headers))

    return suggest[:5]


def parse_suggestions_from_llm(raw: str) -> List[str]:
    """从 LLM 文本中解析 suggestions 列表（容错 JSON 提取）。"""
    text = (raw or "").strip()
    if not text:
        return []
    try:
        obj = extract_json_object(text)
    except ValueError:
        logger.warning("prompt_suggest JSON \u89e3\u6790\u5931\u8d25\uff0craw \u524d 200 \u5b57: %s", text[:200])
        return []
    arr = obj.get("suggestions")
    if not isinstance(arr, list):
        return []
    return [str(x).strip() for x in arr if str(x).strip()]


async def suggest_prompts_for_workbook(metadata: Dict[str, Any]) -> List[str]:
    """调用 LLM，返回 5 条指令建议（不足则用兜底补齐）。"""
    payload = json.dumps(metadata or {}, ensure_ascii=False, indent=2)
    active = ""
    names: List[str] = []
    if isinstance(metadata, dict):
        active = str(metadata.get("activeSheet") or "").strip()
        names = _sheet_names_from_metadata(metadata)

    # 构造分配指令：根据工作表数量明确告知 LLM 每张表分几条
    distribution = ""
    other_names = [n for n in names if n != active]
    if len(names) == 1:
        distribution = f"本工作簿只有 1 张表，5 条全部关于该表。"
    elif len(names) == 2 and active:
        other = other_names[0] if other_names else names[0]
        distribution = (
            f"本工作簿有 2 张表。分配要求：3 条关于活动表「{active}」，"
            f"2 条关于「{other}」。"
        )
    elif len(names) >= 3 and active:
        others_str = "、".join(f"\u300c{n}\u300d" for n in other_names[:4])
        distribution = (
            f"本工作簿有 {len(names)} 张表。分配要求：2 条关于活动表「{active}」，"
            f"其余 3 条必须分布在其他工作表（{others_str}）中，尽量不重复。"
        )
    elif names:
        distribution = f"请为不同工作表生成建议，不要全部集中在同一张表。"

    user_msg = (
        f"以下为当前工作簿结构摘要（JSON），请生成 5 条指令。\n"
        f"【分配规则】{distribution}\n\n"
        f"{payload}"
    )
    items: List[str] = []
    try:
        raw = await call_llm_single(
            user_msg,
            max_tokens=2048,
            timeout=90.0,
            system_prompt=_SYSTEM,
        )
        items = parse_suggestions_from_llm(raw)
    except Exception as e:
        logger.warning("prompt_suggest LLM 失败，降级规则建议: %s", e)
        items = _build_rule_based_suggestions(metadata)

    items = _sanitize_suggestions(items, names)
    return _fallback_pad(active, names, items)
