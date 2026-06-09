# backend/app/pptx/pptist_converter.py
"""
SlidePlan -> PPTist AIPPT 兼容格式转换器

Part A: AIPPTSlide[] (文字层) -- 供 PPTist useAIPPT 模板填充
Part B: DataElements[] (数据元素层) -- 供前端二阶段注入图表/表格/KPI
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger("pptx.pptist_converter")

# PPTist 画布坐标系：1000 x 562.5
CANVAS_W = 1000
CANVAS_H = 562.5
MARGIN = 50
TITLE_H = 40


# ============================================================
# Part A: SlidePlan -> AIPPTSlide[]
# ============================================================

def _split_summary_bullets(bullets: List[Any]) -> List[Dict[str, str]]:
    """
    将总结页 bullets 拆分为独立列表项。
    LLM 可能输出合并段落（如"核心发现：A；B；C；"），按 ； 或 ; 拆分。
    条数控制 6-10 条，目标每条 30-50 字。
    注意：超出长度不做截断，交给渲染层自动换行。
    """
    import re
    items: List[Dict[str, str]] = []
    for b in bullets or []:
        s = str(b).strip()
        if not s:
            continue
        # 去掉"核心发现："、"行动建议："等前缀
        s = re.sub(r'^(核心发现|行动建议|关键发现|总结)[：:]\s*', '', s)
        # 按 ； 或 ; 拆分为多条（中文分号为主）
        parts = re.split(r'[；;]', s)
        for p in parts:
            p = re.sub(r'^[①②③④⑤⑥⑦⑧⑨⑩]\s*', '', p).strip()  # 去掉 ① ② 等
            if p and len(p) >= 2:
                items.append({"title": "", "text": p})
    if len(items) > 10:
        items = items[:10]
    return items


def _slide_to_aippt(slide: dict, index: int, total: int) -> Optional[dict]:
    """将单个 SlideSpec 转为 PPTist AIPPTSlide 格式"""
    layout = slide.get("layout", "content")
    title = slide.get("title", "")
    subtitle = slide.get("subtitle", "")
    bullets = slide.get("bullets", [])

    if layout == "cover":
        return {
            "type": "cover",
            "source_index": index,
            "data": {
                "title": title,
                "text": subtitle or "",
            },
        }

    if layout == "toc":
        items = bullets if bullets else [title]
        return {
            "type": "contents",
            "source_index": index,
            "data": {"items": items},
        }

    if layout == "summary":
        # summary 映射为 content，每条 bullet 独立列表项；后处理拆分合并段落
        items = _split_summary_bullets(bullets)
        if not items:
            items.append({"title": "", "text": subtitle or "总结本阶段关键发现与后续建议。"})
        return {
            "type": "content",
            "source_index": index,
            "data": {
                "title": title or "总结与建议",
                "items": items,
            },
        }

    # kpi / chart / table / content 统一映射为 content 类型
    items = _build_content_items(slide)
    # 提取 notes 作为额外文字解读
    notes = slide.get("notes", "")
    return {
        "type": "content",
        "source_index": index,
        "data": {
            "title": title,
            "items": items,
            "notes": notes,
        },
    }


def _build_content_items(slide: dict) -> List[dict]:
    """从 SlideSpec 的 kpis/chart/table/bullets 构建 content items"""
    items: List[dict] = []
    layout = slide.get("layout", "content")

    # KPI 概览：每个 KPI 作为一个 item
    kpis = slide.get("kpis") or []
    if kpis:
        for kpi in kpis:
            label = kpi.get("label", "")
            value = kpi.get("value", "--")
            unit = kpi.get("unit", "")
            display = f"{value}{unit}" if unit else str(value)
            items.append({"title": label, "text": display})

    # 图表页：图表标题 + 精练解读（优先用数据自动生成）
    chart = slide.get("chart")
    if chart:
        chart_title = chart.get("title", "")
        insight = _build_chart_insight(chart)
        items.append({
            "title": chart_title or "数据图表",
            "text": insight or "图表显示关键指标变化，建议结合业务动作持续跟踪。",
        })

    # 表格页：表格描述 + 结论提示
    table = slide.get("table")
    if table:
        cols = table.get("columns", [])
        rows = table.get("rows", []) or []
        col_text = ", ".join(cols[:5]) if cols else "数据明细"
        summary = f"展示{len(rows)}行样本，字段包含：{col_text}" if rows else f"字段包含：{col_text}"
        items.append({
            "title": "数据表格",
            "text": summary,
        })

    # 要点列表
    bullets = slide.get("bullets", [])
    for b in bullets:
        items.append({"title": "", "text": b})

    # 至少保证 1 个 item
    if not items:
        items.append({
            "title": slide.get("title", ""),
            "text": slide.get("subtitle", "") or slide.get("notes", ""),
        })

    return items


def _safe_float(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _extract_xy(chart: dict) -> List[Tuple[str, float]]:
    rows = chart.get("data") or []
    x_field = chart.get("x_field", "")
    y_field = chart.get("y_field", "")
    points: List[Tuple[str, float]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        x = str(row.get(x_field, ""))
        y = _safe_float(row.get(y_field))
        if x and y is not None:
            points.append((x, y))
    return points


def _build_chart_insight(chart: dict) -> str:
    """
    为图表生成简短业务解读，避免仅出现“图表将自动插入”占位语。
    """
    points = _extract_xy(chart)
    if not points:
        return ""

    max_point = max(points, key=lambda t: t[1])
    min_point = min(points, key=lambda t: t[1])
    first = points[0]
    last = points[-1]
    trend = "上升" if last[1] > first[1] else ("下降" if last[1] < first[1] else "持平")

    return (
        f"整体趋势{trend}；峰值出现在“{max_point[0]}”（{max_point[1]:.2f}），"
        f"低点在“{min_point[0]}”（{min_point[1]:.2f}）。"
    )


def convert_plan_to_aippt(plan: dict) -> List[dict]:
    """
    将完整 SlidePlan 转为 AIPPTSlide[] (Part A 文字层)
    末尾自动追加 end 页
    """
    slides = plan.get("slides", [])
    total = len(slides)
    aippt_slides: List[dict] = []

    if total == 0:
        return [{"type": "end", "source_index": -1}]

    # 1) 识别封面和目录
    cover_pair = next(
        ((i, s) for i, s in enumerate(slides) if str(s.get("layout", "")) == "cover"),
        None,
    )
    toc_pair = next(
        ((i, s) for i, s in enumerate(slides) if str(s.get("layout", "")) == "toc"),
        None,
    )

    if cover_pair:
        cover_aippt = _slide_to_aippt(cover_pair[1], cover_pair[0], total)
    else:
        cover_aippt = {
            "type": "cover",
            "source_index": -1,
            "data": {
                "title": plan.get("title", "数据分析汇报"),
                "text": plan.get("subtitle", ""),
            },
        }
    if cover_aippt:
        aippt_slides.append(cover_aippt)

    toc_items: List[str] = []
    if toc_pair:
        raw_items = toc_pair[1].get("bullets") or []
        toc_items = [str(x).strip() for x in raw_items if str(x).strip()]
    if not toc_items:
        fallback_titles = []
        for s in slides:
            layout = str(s.get("layout", ""))
            if layout in ("cover", "toc"):
                continue
            t = str(s.get("title", "")).strip()
            if t:
                fallback_titles.append(t)
        toc_max = settings.PPT_TOC_MAX_ITEMS
        toc_items = fallback_titles[:toc_max] or ["核心分析"]

    aippt_slides.append({
        "type": "contents",
        "source_index": toc_pair[0] if toc_pair else -1,
        "data": {"items": toc_items},
    })

    # 2) 将正文页按目录条目分段（有多少目录就生成多少 transition）
    body_pairs: List[Tuple[int, dict]] = []
    for i, slide in enumerate(slides):
        layout = str(slide.get("layout", ""))
        if layout in ("cover", "toc"):
            continue
        body_pairs.append((i, slide))

    section_count = max(len(toc_items), 1)
    sections: List[List[Tuple[int, dict]]] = [[] for _ in range(section_count)]
    body_count = max(len(body_pairs), 1)
    for idx, pair in enumerate(body_pairs):
        original_index, slide = pair
        if isinstance(slide.get("section_index"), int):
            sec_idx = max(0, min(int(slide["section_index"]), section_count - 1))
        else:
            # 回退：无 section_index 时按顺序均分
            sec_idx = min((idx * section_count) // body_count, section_count - 1)
        sections[sec_idx].append(pair)

    for sec_idx, section_title in enumerate(toc_items):
        aippt_slides.append({
            "type": "transition",
            "source_index": -1,
            "data": {
                "title": section_title,
                "text": f"{section_title}：关键数据与结论",
                "partNumber": str(sec_idx + 1).zfill(2),
            },
        })
        for original_index, slide in sections[sec_idx]:
            aippt = _slide_to_aippt(slide, original_index, total)
            if not aippt:
                continue
            # transition 仅由目录章节统一生成，正文中出现 transition 时转为 content
            if aippt.get("type") == "transition":
                text = aippt.get("data", {}).get("text", "")
                aippt = {
                    "type": "content",
                    "source_index": original_index,
                    "data": {
                        "title": str(slide.get("title", "") or section_title),
                        "items": [{"title": "", "text": text or "请结合本章数据进行说明。"}],
                    },
                }
            aippt_slides.append(aippt)

    # 3) 感谢页保持纯结束页，不注入总结内容
    aippt_slides.append({"type": "end", "source_index": -1})
    return aippt_slides


# ============================================================
# Part B: SlidePlan -> DataElements[]
# ============================================================

def _chart_type_mapping(src_type: str) -> str:
    """将后端 chart_type 映射到 PPTist ChartType"""
    mapping = {
        "bar": "bar",
        "column": "column",
        "line": "line",
        "pie": "pie",
        "ring": "ring",
        "area": "area",
        "radar": "radar",
        "scatter": "scatter",
        "horizontal_bar": "bar",
    }
    return mapping.get(src_type, "bar")


def _build_chart_element(chart: dict, layout_region: dict) -> Optional[dict]:
    """将 ChartSpec (含已填充 data) 转为 PPTist chart 元素定义"""
    data_rows = chart.get("data") or []
    if not data_rows:
        return None

    x_field = chart.get("x_field", "")
    y_field = chart.get("y_field", "")
    series_field = chart.get("series_field", "")

    labels: List[str] = []
    legends: List[str] = []
    series_map: Dict[str, List[float]] = {}

    if series_field and series_field in (data_rows[0] if data_rows else {}):
        # 多系列：按 series_field 分组
        for row in data_rows:
            x_val = str(row.get(x_field, ""))
            if x_val not in labels:
                labels.append(x_val)
            s_name = str(row.get(series_field, ""))
            if s_name not in series_map:
                series_map[s_name] = []
                legends.append(s_name)

        # 初始化矩阵
        for name in legends:
            series_map[name] = [0.0] * len(labels)

        for row in data_rows:
            x_val = str(row.get(x_field, ""))
            s_name = str(row.get(series_field, ""))
            x_idx = labels.index(x_val)
            try:
                series_map[s_name][x_idx] = float(row.get(y_field, 0) or 0)
            except (ValueError, TypeError):
                series_map[s_name][x_idx] = 0.0
    else:
        # 单系列
        legend_name = chart.get("title", y_field or "数值")
        legends = [legend_name]
        values: List[float] = []

        for row in data_rows:
            if isinstance(row, dict):
                x_val = str(row.get(x_field, ""))
                labels.append(x_val)
                try:
                    values.append(float(row.get(y_field, 0) or 0))
                except (ValueError, TypeError):
                    values.append(0.0)

        series_map[legend_name] = values

    series = [series_map[name] for name in legends]

    if not labels or not legends or not any(series):
        return None

    return {
        "type": "chart",
        "chartType": _chart_type_mapping(chart.get("chart_type", "bar")),
        **layout_region,
        "data": {
            "labels": labels,
            "legends": legends,
            "series": series,
        },
    }


def _build_chart_image_element(chart: dict, layout_region: dict) -> Optional[dict]:
    """SQL 无结构化行但已渲染为图时，走图片兜底注入 PPTist"""
    src = chart.get("image_data_url")
    if not src:
        return None
    return {
        "type": "chartImage",
        "src": str(src),
        **layout_region,
    }


def _build_table_element(table: dict, layout_region: dict) -> Optional[dict]:
    """将 TableSpec (含已填充 rows) 转为 PPTist table 元素定义"""
    columns = table.get("columns", [])
    rows = table.get("rows", [])

    if not columns and not rows:
        return None

    # 构建 PPTist TableCell[][] 格式
    ppt_data: List[List[dict]] = []

    # 表头行
    if columns:
        header_row = []
        for col in columns:
            header_row.append({
                "id": "",
                "colspan": 1,
                "rowspan": 1,
                "text": str(col),
                "style": {"bold": True, "fontsize": "13px", "color": "#000000"},
            })
        ppt_data.append(header_row)

    # 数据行
    for row in rows:
        data_row = []
        for cell in row:
            data_row.append({
                "id": "",
                "colspan": 1,
                "rowspan": 1,
                "text": str(cell) if cell is not None else "",
                "style": {"color": "#000000", "fontsize": "13px"},
            })
        ppt_data.append(data_row)

    col_count = len(columns) if columns else (len(rows[0]) if rows else 1)
    col_widths = [round(1.0 / max(col_count, 1), 4)] * col_count

    return {
        "type": "table",
        **layout_region,
        "colWidths": col_widths,
        "cellMinHeight": 36,
        "data": ppt_data,
        "theme": {
            "color": "#217346",
            "rowHeader": True,
            "rowFooter": False,
            "colHeader": False,
            "colFooter": False,
        },
    }


def _build_kpi_elements(kpis: list, base_region: dict) -> List[dict]:
    """将 KPISpec[] 转为 PPTist text 元素定义列表"""
    elements: List[dict] = []
    count = len(kpis)
    if count == 0:
        return elements

    # KPI 横向等距排列
    total_w = base_region.get("width", CANVAS_W - MARGIN * 2)
    base_left = base_region.get("left", MARGIN)
    base_top = base_region.get("top", 120)
    gap = 20
    item_w = (total_w - gap * (count - 1)) / count

    for i, kpi in enumerate(kpis):
        value_str = kpi.get("value", "--")
        unit = kpi.get("unit", "")
        label = kpi.get("label", "")
        display = f"{value_str}{unit}" if unit else str(value_str)
        left = base_left + i * (item_w + gap)

        elements.append({
            "type": "kpi",
            "left": left,
            "top": base_top,
            "width": item_w,
            "height": 60,
            "value": str(value_str),
            "unit": unit,
            "label": label,
        })

    return elements


def _compute_layout(slide: dict, slide_index: int) -> dict:
    """根据页面内容类型计算各元素的布局区域"""
    layout = slide.get("layout", "content")
    chart_spec = slide.get("chart") or {}
    has_chart = bool(
        chart_spec
        and (chart_spec.get("data") or chart_spec.get("image_data_url"))
    )
    has_table = bool(slide.get("table") and slide["table"].get("rows"))
    has_kpis = bool(slide.get("kpis"))
    bullets = slide.get("bullets", [])

    regions = {}

    if layout == "kpi":
        # KPI 页：指标横排
        regions["kpi"] = {
            "left": MARGIN,
            "top": TITLE_H + 80,
            "width": CANVAS_W - MARGIN * 2,
            "height": 120,
        }

    elif has_chart and has_table:
        # 图表 + 表格并排
        half_w = (CANVAS_W - MARGIN * 3) / 2
        regions["chart"] = {
            "left": MARGIN,
            "top": TITLE_H + 60,
            "width": half_w,
            "height": 340,
        }
        regions["table"] = {
            "left": MARGIN * 2 + half_w,
            "top": TITLE_H + 60,
            "width": half_w,
            "height": 340,
        }

    elif has_chart and bullets:
        # 图表 + 要点：左图右文
        chart_w = (CANVAS_W - MARGIN * 3) * 0.6
        regions["chart"] = {
            "left": MARGIN,
            "top": TITLE_H + 60,
            "width": chart_w,
            "height": 380,
        }

    elif has_chart:
        # 纯图表：居中大图
        regions["chart"] = {
            "left": MARGIN + 40,
            "top": TITLE_H + 60,
            "width": CANVAS_W - MARGIN * 2 - 80,
            "height": 380,
        }

    elif has_table:
        # 纯表格：居中
        regions["table"] = {
            "left": MARGIN + 20,
            "top": TITLE_H + 60,
            "width": CANVAS_W - MARGIN * 2 - 40,
            "height": 380,
        }

    return regions


def convert_plan_to_data_elements(plan: dict) -> List[dict]:
    """
    将完整 SlidePlan 转为 DataElements[] (Part B 数据元素层)
    每个条目包含 slide_index 和 elements[]
    """
    slides = plan.get("slides", [])
    data_elements: List[dict] = []

    for i, slide in enumerate(slides):
        elements: List[dict] = []
        regions = _compute_layout(slide, i)

        # 图表（结构化 data 优先；无 data 时用 matplotlib 预渲染图兜底）
        chart = slide.get("chart")
        if chart:
            region = regions.get("chart", {
                "left": MARGIN + 40,
                "top": TITLE_H + 60,
                "width": CANVAS_W - MARGIN * 2 - 80,
                "height": 380,
            })
            chart_el = None
            if chart.get("data"):
                chart_el = _build_chart_element(chart, region)
            elif chart.get("image_data_url"):
                chart_el = _build_chart_image_element(chart, region)
            if chart_el:
                elements.append(chart_el)
            elif chart.get("sql") or chart.get("title"):
                logger.warning(
                    "图表页未产出可注入元素: slide=%d title=%s issue=%s",
                    i,
                    chart.get("title", ""),
                    chart.get("render_issue", "unknown"),
                )

        # 表格
        table = slide.get("table")
        if table and table.get("rows"):
            region = regions.get("table", {
                "left": MARGIN + 20,
                "top": TITLE_H + 60,
                "width": CANVAS_W - MARGIN * 2 - 40,
                "height": 380,
            })
            table_el = _build_table_element(table, region)
            if table_el:
                elements.append(table_el)

        # KPI
        kpis = slide.get("kpis") or []
        filled_kpis = [k for k in kpis if k.get("value") and k["value"] != "--"]
        if filled_kpis:
            region = regions.get("kpi", {
                "left": MARGIN,
                "top": TITLE_H + 80,
                "width": CANVAS_W - MARGIN * 2,
                "height": 120,
            })
            kpi_els = _build_kpi_elements(filled_kpis, region)
            elements.extend(kpi_els)

        if elements:
            data_elements.append({
                "slide_index": i,
                "elements": elements,
            })

    logger.info(
        "PPTist 转换完成: slides=%d, data_element_pages=%d",
        len(slides), len(data_elements),
    )
    return data_elements


# ============================================================
# 统一入口
# ============================================================

def convert_slide_plan(plan: dict) -> dict:
    """
    统一转换入口：SlidePlan -> PPTist 兼容格式

    返回:
        {
            "aippt_slides": [...],      # Part A 文字层
            "data_elements": [...],     # Part B 数据元素层
            "template_key": "...",      # 模板 key
        }
    """
    aippt_slides = convert_plan_to_aippt(plan)
    data_elements = convert_plan_to_data_elements(plan)

    return {
        "aippt_slides": aippt_slides,
        "data_elements": data_elements,
    }
