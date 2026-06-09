# backend/app/pptx/planner.py
"""
PPTX 汇报规划器 — 通过 LLM + MCP Tools 分析数据并生成结构化 SlidePlan
复用: report.planner.collect_schema_context  /  report.llm_executor.call_llm_with_tools
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ..core.config import settings
from ..large_file.storage import large_file_storage
from ..report.planner import collect_schema_context
from ..report.llm_executor import call_llm_with_tools
from ..report.llm_client import call_llm_single
from ..utils.context_budget import compact_schema_context, enforce_hard_cap
from ..utils.json_output_guard import extract_json_object, guard_json_output
from ..utils.logger import get_logger

logger = get_logger("pptx.planner")

PLANNER_TIMEOUT_SEC = 300
PLANNER_MAX_TOKENS = 8192
SECTION_ALIGN_TIMEOUT_SEC = 60

# ============================================================
# 系统提示词
# ============================================================

SYSTEM_PROMPT = (
    "你是一位资深企业汇报顾问和数据分析专家。"
    "你的任务是根据 Excel 数据的表结构和统计信息，规划一份专业的 PPT 汇报方案。"
    "生成的方案将直接驱动 python-pptx 生成演示文稿。"
)


def _build_adaptive_prompt(
    raw_schema_ctx: Dict[str, Any],
    template_key: str,
    custom_prompt: str,
    toc_max_items: int,
    stage: str = "tools",
) -> tuple[str, Dict[str, Any], Dict[str, Any]]:
    """
    自适应构建 prompt：按长度阈值逐级压缩 schema，优先保证质量，再保证可执行。
    """
    if stage == "force":
        target_chars = settings.PROMPT_CHAR_TARGET_FORCE
        profile_builders = [
            ("compact", lambda: compact_schema_context(raw_schema_ctx, tight=False)),
            ("tight", lambda: compact_schema_context(raw_schema_ctx, tight=True)),
        ]
        original_ctx = compact_schema_context(raw_schema_ctx, tight=False)
    else:
        target_chars = settings.PROMPT_CHAR_TARGET_TOOLS
        profile_builders = [
            ("none", lambda: raw_schema_ctx),
            ("compact", lambda: compact_schema_context(raw_schema_ctx, tight=False)),
            ("tight", lambda: compact_schema_context(raw_schema_ctx, tight=True)),
        ]
        original_ctx = raw_schema_ctx

    original_prompt = _build_prompt(original_ctx, template_key, custom_prompt, toc_max_items)
    original_chars = len(original_prompt)
    original_sheets = len((original_ctx.get("sheets") or []))

    selected_profile = profile_builders[-1][0]
    selected_ctx = profile_builders[-1][1]()
    selected_prompt = _build_prompt(selected_ctx, template_key, custom_prompt, toc_max_items)

    for profile_name, builder in profile_builders:
        candidate_ctx = builder()
        candidate_prompt = _build_prompt(candidate_ctx, template_key, custom_prompt, toc_max_items)
        selected_profile = profile_name
        selected_ctx = candidate_ctx
        selected_prompt = candidate_prompt
        if len(candidate_prompt) <= target_chars:
            break

    info = {
        "stage": stage,
        "target_chars": target_chars,
        "original_chars": original_chars,
        "selected_chars": len(selected_prompt),
        "original_sheets": original_sheets,
        "selected_sheets": len((selected_ctx.get("sheets") or [])),
        "selected_profile": selected_profile,
        "compressed": selected_profile != "none",
    }
    return selected_prompt, selected_ctx, info


def _build_prompt(
    schema_ctx: Dict[str, Any],
    template_key: str,
    custom_prompt: str,
    toc_max_items: int,
) -> str:
    """构建 LLM 规划提示词"""
    ctx_json = json.dumps(schema_ctx, ensure_ascii=False, indent=2, default=str)

    return f"""## 数据概况

{ctx_json}

## 任务

根据以上数据结构，为选定的 PPTX 模板「{template_key}」生成一份汇报方案。

{f'用户额外要求: {custom_prompt}' if custom_prompt else ''}

## 输出格式（严格 JSON）

请输出一个 JSON 对象，**不要**包含 markdown 代码块标记，直接输出纯 JSON：

{{
  "title": "汇报主标题",
  "subtitle": "副标题（含日期范围或数据来源）",
  "domain": "业务领域（sales/finance/operations/hr/general）",
  "slides": [
    {{
      "layout": "cover",
      "title": "与主标题一致",
      "subtitle": "与副标题一致",
      "bullets": [],
      "notes": "演讲者备注"
    }},
    {{
      "layout": "toc",
      "title": "目录",
      "bullets": ["章节1名称", "章节2名称", "..."],
      "notes": ""
    }},
    {{
      "layout": "kpi",
      "title": "核心指标概览",
      "kpis": [
        {{"label": "指标名", "sql": "SELECT ... FROM ...", "unit": "元/个/%" }},
        ...
      ],
      "notes": ""
    }},
    {{
      "layout": "chart",
      "title": "图表页标题",
      "image_query": "用于配图检索的英文关键词（如 business growth）",
      "chart": {{
        "chart_type": "bar|line|pie|radar|scatter",
        "title": "图表标题",
        "sql": "SELECT dimension_col, metric_col FROM ...",
        "x_field": "dimension_col",
        "y_field": "metric_col",
        "series_field": ""
      }},
      "bullets": ["图表要点解读1", "..."],
      "notes": ""
    }},
    {{
      "layout": "table",
      "title": "数据明细",
      "image_query": "用于配图检索的英文关键词",
      "table": {{
        "sql": "SELECT col1, col2, ... FROM ... LIMIT 10",
        "columns": ["col1", "col2", "..."],
        "max_rows": 10
      }},
      "notes": ""
    }},
    {{
      "layout": "summary",
      "title": "总结与建议",
      "image_query": "用于配图检索的英文关键词",
      "bullets": ["三年销售稳定但增长乏力", "七大渠道均衡发展企业直销领跑", "实施客户分层运营提升高价值客户占比", "..."],
      "notes": ""
    }}
  ]
}}

## 规划要求

1. 幻灯片总数 8-15 页，结构：封面(1) + 目录(1) + KPI(1-2) + 图表(3-6) + 表格(0-2) + 总结(1)
2. 目录页 bullets 最多 {toc_max_items} 条，从源头规划时严格控制数量，不要超出
3. SQL 必须引用数据概况中的真实表名（双引号包裹），仅用 SELECT/WITH
4. 严禁输出任何 table 占位符语法（例如 table 占位符、按工作表命名占位符），必须直接写真实表名
5. KPI 的 SQL 应返回单个标量值
6. 图表 SQL 应返回维度列 + 数值列（数值聚合必须使用 TRY_CAST("数值列" AS DOUBLE) 后再 SUM/AVG/MIN/MAX）
7. 若日期字段是字符串，必须使用 TRY_CAST("日期字段" AS DATE) 后再做日期函数；不要直接对 VARCHAR 调用 strftime
8. 禁止使用 MySQL 风格函数 FORMAT()/DATE_FORMAT()；数值格式化请使用 ROUND()/CAST()，日期格式化请使用 strftime('%Y-%m', TRY_CAST(... AS DATE))
9. 要点和总结要具有商业洞察力，避免泛泛而谈
10. 总结页 bullets 必须为独立条目列表：条数 6-10 条，每条 30-50 字；禁止将多条合并为大段落（如"核心发现：xxx；xxx；"）；每条对应一个列表项
11. 确保 JSON 合法，所有字符串用双引号
"""


def _validate_plan_schema(plan: Dict[str, Any]) -> None:
    """最小结构校验，避免后续链路吃到畸形对象。"""
    if not isinstance(plan, dict):
        raise ValueError("plan 不是 JSON 对象")

    slides = plan.get("slides")
    if not isinstance(slides, list) or not slides:
        raise ValueError("plan.slides 必须是非空数组")

    for idx, slide in enumerate(slides):
        if not isinstance(slide, dict):
            raise ValueError(f"slides[{idx}] 不是对象")
        layout = slide.get("layout")
        if not isinstance(layout, str) or not layout.strip():
            raise ValueError(f"slides[{idx}].layout 非法")

        if "bullets" in slide and not isinstance(slide["bullets"], list):
            raise ValueError(f"slides[{idx}].bullets 必须是数组")
        if layout == "kpi" and "kpis" in slide and not isinstance(slide["kpis"], list):
            raise ValueError(f"slides[{idx}].kpis 必须是数组")
        if layout == "chart" and "chart" in slide and not isinstance(slide["chart"], dict):
            raise ValueError(f"slides[{idx}].chart 必须是对象")
        if layout == "table" and "table" in slide and not isinstance(slide["table"], dict):
            raise ValueError(f"slides[{idx}].table 必须是对象")


async def _repair_json_fallback(raw_text: str) -> Dict[str, Any]:
    """
    当返回文本夹杂解释、代码块或轻微语法问题时，使用二次 LLM 做“仅 JSON 修复”。
    """
    repair_prompt = f"""你是 JSON 修复器。请把以下文本修复为“单个合法 JSON 对象”。

硬性约束：
1) 输出第一字符必须是 '{{'，最后字符必须是 '}}'
2) 只输出 JSON，不要解释文字，不要 markdown
3) 不可改写业务语义；仅做结构修复（去前后缀、补引号/逗号、闭合括号）

待修复文本：
{raw_text}
"""
    repaired = await call_llm_single(
        prompt=repair_prompt,
        model="claude-sonnet-4-20250514",
        max_tokens=PLANNER_MAX_TOKENS,
        timeout=120,
        system_prompt="你是严格 JSON 修复器，只输出合法 JSON。",
    )
    return extract_json_object(repaired)


async def _force_json_fallback(
    raw_schema_ctx: Dict[str, Any],
    template_key: str,
    custom_prompt: str,
) -> Dict[str, Any]:
    """
    当 tools 首次返回非 JSON 时，使用单次调用强制输出纯 JSON。
    """
    toc_max = settings.PPT_TOC_MAX_ITEMS
    base_prompt, _, compress_info = _build_adaptive_prompt(
        raw_schema_ctx=raw_schema_ctx,
        template_key=template_key,
        custom_prompt=custom_prompt,
        toc_max_items=toc_max,
        stage="force",
    )
    logger.info(
        "PPTX planner prompt 自适应压缩: stage=%s compressed=%s profile=%s chars=%d->%d sheets=%d->%d target=%d",
        compress_info["stage"],
        compress_info["compressed"],
        compress_info["selected_profile"],
        compress_info["original_chars"],
        compress_info["selected_chars"],
        compress_info["original_sheets"],
        compress_info["selected_sheets"],
        compress_info["target_chars"],
    )
    strict_prompt = (
        base_prompt
        + "\n\n【最终输出硬性约束】\n"
          "1) 你的回复第一个字符必须是 '{'，最后一个字符必须是 '}'。\n"
          "2) 不要输出任何解释、说明、前言、后记、Markdown 代码块。\n"
          "3) 若无法确定某字段，请填空字符串或空数组，但仍必须返回合法 JSON 对象。\n"
    )
    strict_prompt = enforce_hard_cap(strict_prompt)
    raw = await call_llm_single(
        prompt=strict_prompt,
        model="claude-sonnet-4-20250514",
        max_tokens=PLANNER_MAX_TOKENS,
        timeout=PLANNER_TIMEOUT_SEC,
        system_prompt=SYSTEM_PROMPT,
    )
    return extract_json_object(raw)


# ============================================================
# 主入口
# ============================================================

def _resolve_schema_context(file_id: str, user_file_id: str = "") -> tuple[Dict[str, Any], str]:
    """
    解析可用于 DuckDB 分析的上下文：
    - 优先使用传入 file_id（通常是 large-file 会话 ID）
    - 若无源表，则按 source_file_id 反查最近的会话 file_id 兜底
    """
    direct_ctx = collect_schema_context(file_id)
    if direct_ctx.get("sheets"):
        return direct_ctx, file_id

    candidates = []
    source_id = user_file_id or file_id
    try:
        metas = list(large_file_storage.list_files() or [])
        candidates = [m for m in metas if getattr(m, "source_file_id", None) == source_id]
        candidates.sort(
            key=lambda m: getattr(m, "last_accessed", None) or getattr(m, "created_at", None),
            reverse=True,
        )
    except Exception as e:
        logger.warning("PPTX 解析 file_id 兜底候选失败: file_id=%s err=%s", file_id, e)

    for meta in candidates:
        candidate_id = getattr(meta, "file_id", None)
        if not candidate_id:
            continue
        candidate_ctx = collect_schema_context(candidate_id)
        if candidate_ctx.get("sheets"):
            logger.info("PPTX file_id 兜底命中: input=%s user_file_id=%s resolved=%s", file_id, user_file_id, candidate_id)
            return candidate_ctx, candidate_id

    return direct_ctx, file_id


async def generate_slide_plan(
    file_id: str,
    template_key: str,
    custom_prompt: str = "",
    user_file_id: str = "",
) -> Dict[str, Any]:
    """
    生成 PPTX 汇报规划（SlidePlan）。
    优先走 tools 调用，失败回退 llm_client 单次调用。
    """
    raw_schema_ctx, runtime_file_id = _resolve_schema_context(file_id, user_file_id=user_file_id)
    if not raw_schema_ctx.get("sheets"):
        raise ValueError("未找到已加载的工作表数据，请先在「我要分析」中加载文件")
    toc_max = settings.PPT_TOC_MAX_ITEMS
    prompt_text, schema_ctx, compress_info = _build_adaptive_prompt(
        raw_schema_ctx=raw_schema_ctx,
        template_key=template_key,
        custom_prompt=custom_prompt,
        toc_max_items=toc_max,
        stage="tools",
    )
    prompt_text = enforce_hard_cap(prompt_text)
    logger.info(
        "PPTX planner prompt 自适应压缩: stage=%s compressed=%s profile=%s chars=%d->%d sheets=%d->%d target=%d runtime_file_id=%s",
        compress_info["stage"],
        compress_info["compressed"],
        compress_info["selected_profile"],
        compress_info["original_chars"],
        compress_info["selected_chars"],
        compress_info["original_sheets"],
        compress_info["selected_sheets"],
        compress_info["target_chars"],
        runtime_file_id,
    )

    # 优先 tools 调用
    try:
        raw_text = await call_llm_with_tools(
            file_id=runtime_file_id,
            prompt=prompt_text,
            system_prompt=SYSTEM_PROMPT,
            timeout=PLANNER_TIMEOUT_SEC,
            max_turns=20,
            session_prefix="pptx_planner",
        )
        logger.info("PPTX planner tools 调用成功: file_id=%s", file_id)
    except Exception as tools_err:
        logger.warning("PPTX planner tools 调用失败，回退单次调用: %s", tools_err)
        raw_text = await call_llm_single(
            prompt=prompt_text,
            model="claude-sonnet-4-20250514",
            max_tokens=PLANNER_MAX_TOKENS,
            timeout=PLANNER_TIMEOUT_SEC,
            system_prompt=SYSTEM_PROMPT,
        )

    async def _force() -> Dict[str, Any]:
        return await _force_json_fallback(raw_schema_ctx, template_key, custom_prompt)

    async def _repair() -> Dict[str, Any]:
        return await _repair_json_fallback(raw_text)

    plan = await guard_json_output(
        raw_text,
        validator=_validate_plan_schema,
        force_json_fallback=_force,
        repair_json_fallback=_repair,
        logger=logger,
        module_name="pptx.planner",
    )

    # 基本校验
    if "slides" not in plan or not isinstance(plan["slides"], list):
        raise ValueError("LLM 返回的方案缺少 slides 数组")

    if len(plan["slides"]) < 3:
        raise ValueError(f"幻灯片数量不足: {len(plan['slides'])}")

    # 文案兜底：避免固定区块出现空文本，保证模板填充稳定
    _normalize_plan_text(plan)

    # 二次语义分段：目录标题 -> 正文页映射（LLM 优先，失败回退规则）
    await _align_sections_with_llm(plan)

    logger.info(
        "PPTX plan 生成完成: file_id=%s slides=%d title=%s",
        file_id, len(plan["slides"]), plan.get("title", "")
    )
    return plan


def _normalize_plan_text(plan: Dict[str, Any]) -> None:
    """
    对 LLM 结果做最小补全，避免模板固定区块留空：
    - cover/toc/summary/content 的 title/bullets/notes 兜底
    - chart/table 页面补齐 bullets，便于前端内容区填充
    """
    slides = plan.get("slides", [])
    if not isinstance(slides, list):
        return

    report_title = str(plan.get("title") or "数据分析汇报")
    report_subtitle = str(plan.get("subtitle") or "基于当前数据生成")

    # 为 toc 生成章节候选
    chapter_titles = []
    for s in slides:
        t = str(s.get("title") or "").strip()
        layout = str(s.get("layout") or "")
        if t and layout not in ("cover", "toc"):
            chapter_titles.append(t)
    chapter_titles = chapter_titles[:8]

    def _ensure_sentence_ending(text: str) -> str:
        """确保总结条目以中文句号结尾。"""
        s = str(text or "").strip()
        if not s:
            return s
        if s[-1] in ("。", "！", "？", ".", "!", "?"):
            return s
        return f"{s}。"

    for idx, slide in enumerate(slides):
        layout = str(slide.get("layout") or "content")
        title = str(slide.get("title") or "").strip()
        bullets = slide.get("bullets")
        notes = str(slide.get("notes") or "").strip()

        if not isinstance(bullets, list):
            bullets = []
        bullets = [str(b).strip() for b in bullets if str(b).strip()]

        if layout == "cover":
            slide["title"] = title or report_title
            slide["subtitle"] = str(slide.get("subtitle") or "").strip() or report_subtitle
            if not notes:
                slide["notes"] = "开场：说明汇报范围、数据来源与核心结论。"
            continue

        if layout == "toc":
            slide["title"] = title or "目录"
            if not bullets:
                slide["bullets"] = chapter_titles or ["核心指标概览", "趋势分析", "结构分析", "总结建议"]
            else:
                slide["bullets"] = bullets
            if not notes:
                slide["notes"] = "本页概述报告结构与阅读顺序。"
            continue

        if not title:
            slide["title"] = f"分析主题 {idx + 1}"

        if layout in ("chart", "table") and not bullets:
            slide["bullets"] = [
                "聚焦关键指标变化，识别异常点与拐点",
                "结合业务场景解释波动原因并给出行动建议",
            ]
        elif layout == "summary" and not bullets:
            slide["bullets"] = ["关键发现总结。", "下一步行动建议。"]
        elif layout == "summary":
            slide["bullets"] = [_ensure_sentence_ending(item) for item in bullets]
        elif not bullets and layout in ("kpi", "content"):
            slide["bullets"] = ["核心结论提炼", "业务影响说明"]
        else:
            slide["bullets"] = bullets

        if not notes:
            slide["notes"] = f"围绕“{slide['title']}”展开，先结论后原因。"


def _body_slide_indexes(slides: List[Dict[str, Any]]) -> List[int]:
    return [
        i for i, s in enumerate(slides)
        if str(s.get("layout") or "") not in ("cover", "toc")
    ]


def _normalize_toc_items(plan: Dict[str, Any]) -> List[str]:
    slides = plan.get("slides", [])
    toc = next((s for s in slides if str(s.get("layout") or "") == "toc"), None)
    items: List[str] = []
    if toc:
        raw = toc.get("bullets") or []
        items = [str(x).strip() for x in raw if str(x).strip()]
    if not items:
        fallback = []
        for s in slides:
            if str(s.get("layout") or "") in ("cover", "toc"):
                continue
            t = str(s.get("title") or "").strip()
            if t:
                fallback.append(t)
        items = fallback[:6] or ["核心分析"]
    return items


def _build_section_alignment_prompt(plan: Dict[str, Any], toc_items: List[str]) -> str:
    slides = plan.get("slides", [])
    body = []
    for i in _body_slide_indexes(slides):
        s = slides[i]
        body.append({
            "slide_index": i,
            "layout": s.get("layout", ""),
            "title": s.get("title", ""),
            "bullets": (s.get("bullets") or [])[:3],
        })
    return f"""你是一名汇报结构规划助手。请将正文页映射到目录章节，输出纯 JSON。

目录章节（按顺序）:
{json.dumps(toc_items, ensure_ascii=False)}

正文页:
{json.dumps(body, ensure_ascii=False)}

输出格式（必须严格 JSON）:
{{
  "mapping": [
    {{"slide_index": 2, "section_index": 0}},
    {{"slide_index": 3, "section_index": 1}}
  ]
}}

约束:
1) section_index 范围是 [0, {max(len(toc_items)-1, 0)}]
2) 每个正文页都必须出现一次且只出现一次
3) 尽量保持章节顺序（不要频繁来回跳章）
4) 只输出 JSON，不要解释文本
"""


def _safe_text(v: Any) -> str:
    return str(v or "").strip().lower()


def _text_overlap_score(a: str, b: str) -> int:
    if not a or not b:
        return 0
    score = len(set(a) & set(b))
    if a in b or b in a:
        score += 4
    return score


def _fallback_align_sections(plan: Dict[str, Any], toc_items: List[str]) -> Dict[int, int]:
    slides = plan.get("slides", [])
    body_indexes = _body_slide_indexes(slides)
    if not body_indexes:
        return {}
    section_count = max(len(toc_items), 1)
    mapping: Dict[int, int] = {}
    for pos, idx in enumerate(body_indexes):
        s = slides[idx]
        text = " ".join([
            _safe_text(s.get("title")),
            " ".join(_safe_text(x) for x in (s.get("bullets") or [])[:3]),
        ]).strip()

        best_sec = 0
        best_score = -1
        for sec_idx, sec in enumerate(toc_items):
            sc = _text_overlap_score(text, _safe_text(sec))
            if sc > best_score:
                best_score = sc
                best_sec = sec_idx
        if best_score <= 0:
            best_sec = min((pos * section_count) // len(body_indexes), section_count - 1)
        mapping[idx] = best_sec
    return mapping


async def _align_sections_with_llm(plan: Dict[str, Any]) -> None:
    slides = plan.get("slides", [])
    if not isinstance(slides, list) or not slides:
        return

    toc_items = _normalize_toc_items(plan)
    body_indexes = _body_slide_indexes(slides)
    if not toc_items or not body_indexes:
        return

    fallback = _fallback_align_sections(plan, toc_items)
    prompt = _build_section_alignment_prompt(plan, toc_items)
    try:
        raw = await call_llm_single(
            prompt=prompt,
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            timeout=SECTION_ALIGN_TIMEOUT_SEC,
            system_prompt="你是严格的 JSON 映射器，只输出合法 JSON。",
        )
        parsed = extract_json_object(raw)
        items = parsed.get("mapping", [])
        if not isinstance(items, list):
            raise ValueError("mapping 不是数组")

        llm_map: Dict[int, int] = {}
        max_sec = len(toc_items) - 1
        for item in items:
            if not isinstance(item, dict):
                continue
            si = item.get("slide_index")
            sec = item.get("section_index")
            if not isinstance(si, int) or not isinstance(sec, int):
                continue
            if si not in body_indexes:
                continue
            llm_map[si] = max(0, min(sec, max_sec))

        if len(llm_map) != len(body_indexes):
            raise ValueError(f"LLM 映射不完整: {len(llm_map)}/{len(body_indexes)}")

        for i in body_indexes:
            slides[i]["section_index"] = llm_map[i]
        logger.info("PPTX 章节语义映射完成: sections=%d slides=%d", len(toc_items), len(body_indexes))
        return
    except Exception as exc:
        logger.warning("PPTX 章节语义映射失败，回退规则映射: %s", exc)

    for i in body_indexes:
        slides[i]["section_index"] = fallback.get(i, 0)
