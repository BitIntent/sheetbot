# backend/app/pptx/builder.py
"""
PPTX 生成引擎 — 将 SlidePlan + 模板配色 + 查询数据组装为 .pptx 文件
16:9 宽屏（13.333 x 7.5 英寸）
"""
from __future__ import annotations

import io
import base64
import os
import json
import ssl
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

from .templates import get_pptx_template, get_cover_path, get_template_visual_profile
from ..core.config import settings
from ..utils.logger import get_logger

logger = get_logger("pptx.builder")
_CHINESE_FONT_PATH_CACHE: Optional[str] = None
_PEXELS_FAILED_QUERIES: set[str] = set()

# ── 常量 ─────────────────────────────────────────────────
SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)
MARGIN_L = Inches(0.8)
MARGIN_T = Inches(0.6)
CONTENT_W = Inches(11.733)
CONTENT_H = Inches(6.3)
PEXELS_CACHE_DIR = Path(__file__).parent / "assets" / "pexels"
PEXELS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
COVER_CACHE_DIR = Path(__file__).parent / "assets" / "covers_generated"
COVER_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _rgb(hex_str: str) -> RGBColor:
    """6 位 hex -> RGBColor"""
    h = hex_str.lstrip("#")
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _set_gradient_bg(slide, c_start: str, c_end: str):
    """为幻灯片设置渐变背景"""
    bg = slide.background
    fill = bg.fill
    fill.gradient()
    fill.gradient_stops[0].color.rgb = _rgb(c_start)
    fill.gradient_stops[0].position = 0.0
    fill.gradient_stops[1].color.rgb = _rgb(c_end)
    fill.gradient_stops[1].position = 1.0


def _add_text_box(slide, left, top, width, height, text, font_size=14,
                  color="FFFFFF", bold=False, alignment=PP_ALIGN.LEFT, font_name="Microsoft YaHei"):
    """添加文本框"""
    txBox = slide.shapes.add_textbox(left, top, width, height)
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = str(text)
    p.font.size = Pt(font_size)
    p.font.color.rgb = _rgb(color)
    p.font.bold = bold
    p.font.name = font_name
    p.alignment = alignment
    return txBox


def _add_accent_bar(slide, left, top, width, height, color):
    """添加装饰色条"""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = _rgb(color)
    shape.line.fill.background()


def _detect_chinese_font_path() -> Optional[str]:
    """探测系统可用中文字体路径（缓存）"""
    global _CHINESE_FONT_PATH_CACHE
    if _CHINESE_FONT_PATH_CACHE is not None:
        return _CHINESE_FONT_PATH_CACHE

    try:
        import matplotlib.font_manager as fm
    except Exception:
        _CHINESE_FONT_PATH_CACHE = ""
        return None

    def _supports_chinese(font_path: str) -> bool:
        try:
            from matplotlib.ft2font import FT2Font
            ft = FT2Font(font_path)
            return ord("中") in ft.get_charmap()
        except Exception:
            return False

    # 1) 项目内字体目录优先（frontend/public/fonts）
    #    这样可避免依赖服务器系统字体，发布更可控。
    project_root = Path(__file__).resolve().parents[3]
    project_font_dir = project_root / "frontend" / "public" / "fonts"
    if project_font_dir.exists():
        for ext in ("*.ttf", "*.ttc", "*.otf"):
            for p in sorted(project_font_dir.rglob(ext)):
                p_str = str(p)
                if _supports_chinese(p_str):
                    _CHINESE_FONT_PATH_CACHE = p_str
                    logger.info("matplotlib 中文字体已启用(项目内): %s", p_str)
                    return p_str

    # 2) 再检查常见系统路径（服务器环境命中率更高）
    common_paths = [
        # Linux
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKSC-Regular.otf",
        "/usr/share/fonts/opentype/noto/NotoSansSC-Regular.otf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/usr/share/fonts/truetype/arphic/ukai.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        # macOS
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        # Windows
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ]

    for p in common_paths:
        if os.path.exists(p):
            _CHINESE_FONT_PATH_CACHE = p
            logger.info("matplotlib 中文字体已启用(路径): %s", p)
            return p

    # 3) 再扫描系统字体并验证是否支持中文字符
    preferred_keywords = [
        "microsoft yahei", "simhei", "simsun", "noto sans cjk", "noto sans sc",
        "source han sans", "wenquanyi", "pingfang", "heiti", "arial unicode",
        "droidsansfallback",
    ]

    scanned = (
        fm.findSystemFonts(fontext="ttf")
        + fm.findSystemFonts(fontext="ttc")
        + fm.findSystemFonts(fontext="otf")
    )

    # 3.1 优先关键字命中 + 字形校验
    for font_path in scanned:
        lower = str(font_path).lower()
        if any(k in lower for k in preferred_keywords) and _supports_chinese(font_path):
            _CHINESE_FONT_PATH_CACHE = font_path
            logger.info("matplotlib 中文字体已启用(关键字): %s", font_path)
            return font_path

    # 3.2 最后兜底：任意支持中文的字体
    for font_path in scanned:
        if _supports_chinese(font_path):
            _CHINESE_FONT_PATH_CACHE = font_path
            logger.info("matplotlib 中文字体已启用(兜底): %s", font_path)
            return font_path

    _CHINESE_FONT_PATH_CACHE = ""
    logger.warning("未检测到可用中文字体，图表中文可能乱码；请安装 Noto Sans CJK 或微软雅黑")
    return None


def _load_image_from_data_url(data_url: str) -> Optional[io.BytesIO]:
    """data:image/png;base64,... -> BytesIO"""
    if not data_url or not isinstance(data_url, str):
        return None
    marker = "base64,"
    idx = data_url.find(marker)
    if idx < 0:
        return None
    try:
        raw = base64.b64decode(data_url[idx + len(marker):])
        return io.BytesIO(raw)
    except Exception:
        return None


def _fetch_pexels_image(query: str) -> Optional[Path]:
    """
    拉取 Pexels 图库图片并缓存到本地，返回缓存路径。
    """
    api_key = settings.PEXELS_API_KEY
    if not api_key or not query:
        return None

    safe_name = "".join(ch if ch.isalnum() else "_" for ch in query.lower())[:80]
    if safe_name in _PEXELS_FAILED_QUERIES:
        return None
    cache_file = PEXELS_CACHE_DIR / f"{safe_name}.jpg"
    if cache_file.exists():
        return cache_file

    def _build_ssl_context(allow_insecure: bool = False):
        if allow_insecure:
            return ssl._create_unverified_context()
        try:
            import certifi
            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            return ssl.create_default_context()

    def _urlopen_with_context(req: urllib.request.Request, allow_insecure: bool = False):
        ctx = _build_ssl_context(allow_insecure=allow_insecure)
        return urllib.request.urlopen(req, timeout=settings.PEXELS_TIMEOUT_SEC, context=ctx)

    try:
        search_url = (
            "https://api.pexels.com/v1/search?"
            + urllib.parse.urlencode({"query": query, "per_page": 1, "orientation": "landscape"})
        )
        req = urllib.request.Request(
            search_url,
            headers={"Authorization": api_key, "User-Agent": "excel-ai-pptx/1.0"},
        )
        try:
            with _urlopen_with_context(req, allow_insecure=False) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as ssl_err:
            if settings.PEXELS_ALLOW_INSECURE_SSL and "CERTIFICATE_VERIFY_FAILED" in str(ssl_err):
                logger.warning("Pexels SSL 校验失败，启用不安全降级重试: query=%s", query)
                with _urlopen_with_context(req, allow_insecure=True) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
            else:
                raise

        photos = payload.get("photos") or []
        if not photos:
            return None
        src = photos[0].get("src") or {}
        image_url = src.get("landscape") or src.get("large2x") or src.get("large")
        if not image_url:
            return None

        img_req = urllib.request.Request(
            image_url,
            headers={"Authorization": api_key, "User-Agent": "excel-ai-pptx/1.0"},
        )
        try:
            with _urlopen_with_context(img_req, allow_insecure=False) as img_resp:
                cache_file.write_bytes(img_resp.read())
        except Exception as ssl_err:
            if settings.PEXELS_ALLOW_INSECURE_SSL and "CERTIFICATE_VERIFY_FAILED" in str(ssl_err):
                with _urlopen_with_context(img_req, allow_insecure=True) as img_resp:
                    cache_file.write_bytes(img_resp.read())
            else:
                raise
        return cache_file if cache_file.exists() else None
    except Exception as exc:
        _PEXELS_FAILED_QUERIES.add(safe_name)
        logger.warning("拉取 Pexels 素材失败: query=%s err=%s", query, exc)
        return None


def _render_dynamic_cover(template_key: str, output_path: Path) -> Optional[Path]:
    """按模板风格动态生成封面背景图"""
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None

    tpl = get_pptx_template(template_key)
    colors = tpl.get("colors", {})
    visual = get_template_visual_profile(template_key)
    style = visual.get("cover_style", "diagonal")
    w, h = 1920, 1080

    def _hex_rgb(v: str):
        v = (v or "0D1F3C").lstrip("#")
        return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))

    c1 = _hex_rgb(colors.get("bg_start", "0D1F3C"))
    c2 = _hex_rgb(colors.get("bg_end", "1B3A6B"))
    accent = _hex_rgb(colors.get("accent", "4ECDC4"))

    # 渐变底
    img = Image.new("RGB", (w, h), c1)
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        row = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row
    draw = ImageDraw.Draw(img, "RGBA")

    # 风格图案
    if style in ("diagonal", "dynamic_rays", "luxury_lines"):
        draw.polygon([(w - 360, 0), (w, 0), (w, 260)], fill=(*accent, 120))
    if style in ("organic_curves", "soft_bubbles", "gold_arc", "star_particles"):
        for i in range(5):
            r = 50 + i * 34
            draw.ellipse((w - 220 - r, h - 170 - r, w - 220 + r, h - 170 + r), outline=(*accent, 180), width=2)
    if style in ("neon_grid", "clean_blocks"):
        for i in range(6):
            x = 120 + i * 110
            draw.rectangle((x, 88, x + 66, 94), fill=(*accent, 110))
    if style == "star_particles":
        for i in range(60):
            x = (i * 71) % w
            y = (i * 53) % h
            draw.ellipse((x, y, x + 3, y + 3), fill=(255, 255, 255, 150))

    draw.rectangle((0, h - 8, w, h), fill=(*accent, 220))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(output_path, "PNG", optimize=True)
    return output_path


def resolve_cover_image_path(template_key: str) -> Optional[Path]:
    """
    解析模板封面图路径：
    - 优先原始静态封面
    - 若静态封面缺失/无效，则动态生成专属封面
    """
    static_path = get_cover_path(template_key)
    generated_path = COVER_CACHE_DIR / f"{template_key}.png"
    if generated_path.exists() and generated_path.stat().st_size > 1024:
        return generated_path
    generated = _render_dynamic_cover(template_key, generated_path)
    if generated and generated.exists():
        return generated
    if static_path.exists() and static_path.stat().st_size > 1024:
        return static_path
    return None


def _add_visual_motif(slide, colors: Dict[str, str], style: str):
    """
    按模板风格增加几何装饰，避免模板视觉同质化。
    """
    accent = _rgb(colors["accent"])
    secondary = _rgb(colors["secondary"])

    if style in ("diagonal", "dynamic_rays", "luxury_lines"):
        tri = slide.shapes.add_shape(MSO_SHAPE.RIGHT_TRIANGLE, Inches(11.8), Inches(0), Inches(1.5), Inches(1.2))
        tri.fill.solid()
        tri.fill.fore_color.rgb = accent
        tri.line.fill.background()
    if style in ("organic_curves", "soft_bubbles", "gold_arc", "star_particles"):
        for i in range(4):
            c = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(10.7 + i * 0.18), Inches(5.3 + i * 0.1), Inches(1.7), Inches(1.1))
            c.fill.background()
            c.line.color.rgb = accent
            c.line.width = Pt(1)
    if style in ("neon_grid", "clean_blocks"):
        for i in range(3):
            r = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.35 + i * 0.6), Inches(0.35), Inches(0.45), Inches(0.03))
            r.fill.solid()
            r.fill.fore_color.rgb = secondary
            r.line.fill.background()

    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0), Inches(7.45), SLIDE_W, Inches(0.05))
    bar.fill.solid()
    bar.fill.fore_color.rgb = accent
    bar.line.fill.background()


def _add_stock_image(slide, query: str, left, top, width, height):
    """
    插入网络素材图（Pexels），失败时静默跳过。
    """
    img_path = _fetch_pexels_image(query)
    if not img_path:
        return
    try:
        pic = slide.shapes.add_picture(str(img_path), left, top, width, height)
        pic.line.fill.background()
    except Exception as exc:
        logger.warning("插入 Pexels 素材失败: %s", exc)


def render_stock_image_data_url(query: str) -> Optional[str]:
    """
    获取素材图并转成 data URL，供在线预览与导出保持一致。
    """
    img_path = _fetch_pexels_image(query)
    if not img_path or not img_path.exists():
        return None
    try:
        b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
        return f"data:image/jpeg;base64,{b64}"
    except Exception:
        return None


# ============================================================
# 各版式构建函数
# ============================================================

def _build_cover(prs: Presentation, slide_data: Dict, colors: Dict, template_key: str):
    """封面页"""
    layout = prs.slide_layouts[6]  # blank
    slide = prs.slides.add_slide(layout)
    visual = get_template_visual_profile(template_key)

    # 尝试添加封面背景图
    cover_path = resolve_cover_image_path(template_key)
    if cover_path and cover_path.exists():
        slide.shapes.add_picture(str(cover_path), Emu(0), Emu(0), SLIDE_W, SLIDE_H)
    else:
        _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, visual.get("cover_style", "diagonal"))

    # 标题
    _add_text_box(
        slide,
        Inches(1.5), Inches(2.2), Inches(10.3), Inches(1.5),
        slide_data.get("title", ""),
        font_size=40, color=colors["accent"], bold=True, alignment=PP_ALIGN.CENTER,
    )
    # 副标题
    _add_text_box(
        slide,
        Inches(2.0), Inches(4.0), Inches(9.3), Inches(1.0),
        slide_data.get("subtitle", ""),
        font_size=18, color=colors["text_muted"], alignment=PP_ALIGN.CENTER,
    )
    # 底部装饰条
    _add_accent_bar(slide, Inches(5.0), Inches(5.5), Inches(3.3), Inches(0.04), colors["accent"])


def _build_toc(prs: Presentation, slide_data: Dict, colors: Dict):
    """目录页"""
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, "clean_blocks")

    _add_text_box(
        slide, MARGIN_L, MARGIN_T, CONTENT_W, Inches(0.7),
        slide_data.get("title", "目录"),
        font_size=28, color=colors["accent"], bold=True,
    )
    _add_accent_bar(slide, MARGIN_L, Inches(1.3), Inches(1.2), Inches(0.04), colors["accent"])

    bullets = slide_data.get("bullets", [])
    for i, item in enumerate(bullets):
        y = Inches(1.8) + Inches(i * 0.65)
        # 序号
        _add_text_box(
            slide, MARGIN_L, y, Inches(0.6), Inches(0.5),
            f"{i + 1:02d}", font_size=22, color=colors["accent"], bold=True,
        )
        # 条目文字
        _add_text_box(
            slide, Inches(1.6), y, Inches(10.0), Inches(0.5),
            item, font_size=16, color=colors["text_light"],
        )


def _build_kpi(prs: Presentation, slide_data: Dict, colors: Dict):
    """KPI 大数字页"""
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, "luxury_lines")

    _add_text_box(
        slide, MARGIN_L, MARGIN_T, CONTENT_W, Inches(0.7),
        slide_data.get("title", "核心指标"),
        font_size=28, color=colors["accent"], bold=True,
    )
    _add_accent_bar(slide, MARGIN_L, Inches(1.3), Inches(1.2), Inches(0.04), colors["accent"])

    kpis = slide_data.get("kpis", [])
    cols = min(len(kpis), 4)
    if cols == 0:
        return

    card_w = Inches(11.0 / cols)
    card_h = Inches(2.5)
    start_y = Inches(2.0)

    for i, kpi in enumerate(kpis[:8]):
        row = i // cols
        col = i % cols
        x = MARGIN_L + Emu(int(col * card_w))
        y = start_y + Emu(int(row * (card_h + Inches(0.3))))

        # 卡片背景
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, card_w - Inches(0.2), card_h)
        card.fill.solid()
        card.fill.fore_color.rgb = _rgb(colors["card_bg"])
        card.line.fill.background()

        # 指标名称
        _add_text_box(
            slide, x + Inches(0.2), y + Inches(0.3), card_w - Inches(0.5), Inches(0.4),
            kpi.get("label", ""),
            font_size=12, color=colors["text_muted"],
        )
        # 指标数值
        _add_text_box(
            slide, x + Inches(0.2), y + Inches(0.9), card_w - Inches(0.5), Inches(0.8),
            kpi.get("value", "--"),
            font_size=32, color=colors["accent"], bold=True,
        )
        # 单位
        if kpi.get("unit"):
            _add_text_box(
                slide, x + Inches(0.2), y + Inches(1.8), card_w - Inches(0.5), Inches(0.4),
                kpi["unit"],
                font_size=11, color=colors["text_muted"],
            )


def _build_chart(prs: Presentation, slide_data: Dict, colors: Dict):
    """图表页（占位 + 要点）"""
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, "diagonal")

    _add_text_box(
        slide, MARGIN_L, MARGIN_T, CONTENT_W, Inches(0.7),
        slide_data.get("title", "数据图表"),
        font_size=28, color=colors["accent"], bold=True,
    )
    _add_accent_bar(slide, MARGIN_L, Inches(1.3), Inches(1.2), Inches(0.04), colors["accent"])

    chart_info = slide_data.get("chart", {})
    chart_type = chart_info.get("chart_type", "bar")
    chart_title = chart_info.get("title", "")
    data = chart_info.get("data", [])

    # 优先使用预渲染图（与在线预览同源）
    data_url = chart_info.get("image_data_url")
    if data_url:
        chart_buf = _load_image_from_data_url(data_url)
        if chart_buf:
            slide.shapes.add_picture(
                chart_buf,
                MARGIN_L, Inches(1.6), Inches(7.5), Inches(4.5),
            )
        else:
            _add_chart_placeholder(slide, colors, chart_type, chart_title)
    elif data:
        # 如果有数据，用 matplotlib 渲染（基础实现）
        try:
            chart_img = _render_chart_matplotlib(chart_type, chart_title, data, chart_info, colors)
            if chart_img:
                slide.shapes.add_picture(
                    chart_img,
                    MARGIN_L, Inches(1.6), Inches(7.5), Inches(4.5),
                )
            else:
                _add_chart_placeholder(slide, colors, chart_type, chart_title)
        except Exception as e:
            logger.warning("图表渲染失败: %s", e)
            _add_chart_placeholder(slide, colors, chart_type, chart_title)
    else:
        _add_chart_placeholder(slide, colors, chart_type, chart_title)

    # 右侧要点
    bullets = slide_data.get("bullets", [])
    if bullets:
        for i, b in enumerate(bullets[:5]):
            y = Inches(1.8) + Inches(i * 0.6)
            _add_text_box(
                slide, Inches(8.8), y, Inches(4.2), Inches(0.5),
                f"  {b}", font_size=13, color=colors["text_light"],
            )
    _add_stock_image(
        slide,
        slide_data.get("image_query") or "business analytics dashboard",
        Inches(8.7), Inches(4.8), Inches(4.2), Inches(1.4),
    )


def _add_chart_placeholder(slide, colors, chart_type, chart_title):
    """图表占位区域"""
    shape = slide.shapes.add_shape(
        MSO_SHAPE.ROUNDED_RECTANGLE,
        MARGIN_L, Inches(1.6), Inches(7.5), Inches(4.5),
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = _rgb(colors["card_bg"])
    shape.line.color.rgb = _rgb(colors["accent"])
    shape.line.width = Pt(1)

    _add_text_box(
        slide,
        Inches(2.5), Inches(3.5), Inches(4.0), Inches(0.5),
        f"[{chart_type}] {chart_title}",
        font_size=14, color=colors["text_muted"], alignment=PP_ALIGN.CENTER,
    )


def _render_chart_matplotlib(chart_type, title, data, chart_info, colors) -> Optional[io.BytesIO]:
    """用 matplotlib 将图表数据渲染为 PNG（BytesIO）"""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        logger.warning("matplotlib 不可用，跳过图表渲染")
        return None

    if not data:
        return None

    x_field = chart_info.get("x_field", "")
    y_field = chart_info.get("y_field", "")
    if not x_field or not y_field:
        return None

    def _to_numeric_or_none(val: Any) -> Optional[float]:
        if val is None:
            return None
        if isinstance(val, (int, float)):
            try:
                return float(val)
            except Exception:
                return None
        text = str(val).strip()
        if not text:
            return None
        text = text.replace(",", "").replace("，", "")
        text = text.replace("￥", "").replace("¥", "").replace("$", "")
        is_percent = text.endswith("%")
        if is_percent:
            text = text[:-1]
        text = "".join(ch for ch in text if ch in "0123456789.-+eE")
        if text in {"", "-", "+", ".", "-.", "+."}:
            return None
        try:
            num = float(text)
        except Exception:
            return None
        return num / 100.0 if is_percent else num

    points: List[tuple[str, float]] = []
    for row in data:
        x_raw = row.get(x_field)
        y_raw = row.get(y_field)
        x_text = str(x_raw).strip() if x_raw is not None else ""
        y_num = _to_numeric_or_none(y_raw)
        if not x_text or y_num is None:
            continue
        points.append((x_text, y_num))

    if not points:
        logger.warning(
            "图表渲染前校验失败: title=%s x_field=%s y_field=%s（无有效数值点）",
            title,
            x_field,
            y_field,
        )
        return None
    labels = [p[0] for p in points]
    values = [p[1] for p in points]

    bg_color = f"#{colors['bg_start']}"
    text_color = f"#{colors['text_light']}"
    accent_color = f"#{colors['accent']}"
    font_path = _detect_chinese_font_path()
    font_prop = None
    try:
        import matplotlib
        import matplotlib.font_manager as fm
        matplotlib.rcParams["axes.unicode_minus"] = False
        if font_path:
            font_prop = fm.FontProperties(fname=font_path)
    except Exception:
        font_prop = None

    fig, ax = plt.subplots(figsize=(10, 6), facecolor=bg_color)
    ax.set_facecolor(bg_color)

    if chart_type in ("bar", "bar_horizontal"):
        if chart_type == "bar_horizontal":
            ax.barh(labels, values, color=accent_color)
        else:
            ax.bar(labels, values, color=accent_color)
    elif chart_type == "line":
        ax.plot(labels, values, color=accent_color, linewidth=2, marker='o', markersize=4)
    elif chart_type == "pie":
        pie_points = [(lb, val) for lb, val in zip(labels, values) if val > 0]
        if not pie_points:
            logger.warning("饼图渲染失败: title=%s（无正数值数据）", title)
            return None
        labels = [p[0] for p in pie_points]
        values = [p[1] for p in pie_points]
        textprops = {"color": text_color, "fontsize": 10}
        if font_prop:
            textprops["fontproperties"] = font_prop
        ax.pie(
            values,
            labels=labels,
            colors=[accent_color, f"#{colors['secondary']}", f"#{colors['primary']}"],
            textprops=textprops,
        )
    else:
        ax.bar(labels, values, color=accent_color)

    if chart_type != "pie":
        ax.set_title(title, color=text_color, fontsize=14, pad=12, fontproperties=font_prop)
        ax.tick_params(colors=text_color, labelsize=9)
        ax.spines['bottom'].set_color(text_color)
        ax.spines['left'].set_color(text_color)
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        plt.xticks(rotation=45, ha='right')
        if font_prop:
            for label in ax.get_xticklabels():
                label.set_fontproperties(font_prop)
            for label in ax.get_yticklabels():
                label.set_fontproperties(font_prop)

    plt.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=150, facecolor=bg_color, bbox_inches='tight')
    plt.close(fig)
    buf.seek(0)
    return buf


def render_chart_data_url(chart_info: Dict[str, Any], colors: Dict[str, str]) -> Optional[str]:
    """
    渲染图表并返回 data URL，供在线预览与 PPTX 共用同一图源。
    """
    chart_type = chart_info.get("chart_type", "bar")
    title = chart_info.get("title", "")
    data = chart_info.get("data", [])
    if not data:
        return None
    img_buf = _render_chart_matplotlib(chart_type, title, data, chart_info, colors)
    if not img_buf:
        return None
    b64 = base64.b64encode(img_buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _build_table(prs: Presentation, slide_data: Dict, colors: Dict):
    """数据表格页"""
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, "clean_blocks")

    _add_text_box(
        slide, MARGIN_L, MARGIN_T, CONTENT_W, Inches(0.7),
        slide_data.get("title", "数据表格"),
        font_size=28, color=colors["accent"], bold=True,
    )
    _add_accent_bar(slide, MARGIN_L, Inches(1.3), Inches(1.2), Inches(0.04), colors["accent"])

    table_spec = slide_data.get("table", {})
    col_names = table_spec.get("columns", [])
    rows = table_spec.get("rows", [])

    if not col_names:
        _add_text_box(
            slide, MARGIN_L, Inches(3.0), CONTENT_W, Inches(0.5),
            "暂无表格数据", font_size=14, color=colors["text_muted"], alignment=PP_ALIGN.CENTER,
        )
        return

    n_rows = min(len(rows), 10) + 1
    n_cols = len(col_names)
    table_shape = slide.shapes.add_table(
        n_rows, n_cols,
        MARGIN_L, Inches(1.6), CONTENT_W, Inches(min(n_rows * 0.45, 5.5)),
    )
    table = table_shape.table

    # 表头
    for ci, col_name in enumerate(col_names):
        cell = table.cell(0, ci)
        cell.text = str(col_name)
        for paragraph in cell.text_frame.paragraphs:
            paragraph.font.size = Pt(11)
            paragraph.font.bold = True
            paragraph.font.color.rgb = _rgb("#000000")
        cell.fill.solid()
        cell.fill.fore_color.rgb = _rgb(colors["table_header"])

    # 数据行
    for ri, row in enumerate(rows[:10]):
        for ci, val in enumerate(row):
            if ci >= n_cols:
                break
            cell = table.cell(ri + 1, ci)
            cell.text = str(val) if val is not None else ""
            for paragraph in cell.text_frame.paragraphs:
                paragraph.font.size = Pt(10)
                paragraph.font.color.rgb = _rgb("#000000")


def _build_summary(prs: Presentation, slide_data: Dict, colors: Dict):
    """总结与建议页"""
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, "organic_curves")

    _add_text_box(
        slide, MARGIN_L, MARGIN_T, CONTENT_W, Inches(0.7),
        slide_data.get("title", "总结与建议"),
        font_size=28, color=colors["accent"], bold=True,
    )
    _add_accent_bar(slide, MARGIN_L, Inches(1.3), Inches(1.2), Inches(0.04), colors["accent"])

    bullets = slide_data.get("bullets", [])
    for i, item in enumerate(bullets):
        y = Inches(1.8) + Inches(i * 0.65)
        # 圆点装饰
        dot = slide.shapes.add_shape(MSO_SHAPE.OVAL, MARGIN_L, y + Inches(0.08), Inches(0.12), Inches(0.12))
        dot.fill.solid()
        dot.fill.fore_color.rgb = _rgb(colors["accent"])
        dot.line.fill.background()
        # 文字
        _add_text_box(
            slide, Inches(1.2), y, Inches(10.8), Inches(0.5),
            item, font_size=15, color=colors["text_light"],
        )


def _build_content(prs: Presentation, slide_data: Dict, colors: Dict):
    """通用内容页"""
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    _set_gradient_bg(slide, colors["bg_start"], colors["bg_end"])
    _add_visual_motif(slide, colors, "diagonal")

    _add_text_box(
        slide, MARGIN_L, MARGIN_T, CONTENT_W, Inches(0.7),
        slide_data.get("title", ""),
        font_size=28, color=colors["accent"], bold=True,
    )

    if slide_data.get("subtitle"):
        _add_text_box(
            slide, MARGIN_L, Inches(1.3), CONTENT_W, Inches(0.5),
            slide_data["subtitle"],
            font_size=16, color=colors["text_muted"],
        )

    bullets = slide_data.get("bullets", [])
    start_y = Inches(2.0) if slide_data.get("subtitle") else Inches(1.6)
    for i, item in enumerate(bullets):
        y = start_y + Inches(i * 0.6)
        _add_text_box(
            slide, Inches(1.2), y, Inches(10.8), Inches(0.5),
            f"  {item}", font_size=15, color=colors["text_light"],
        )
    _add_stock_image(
        slide,
        slide_data.get("image_query") or "business teamwork office",
        Inches(8.7), Inches(4.7), Inches(4.2), Inches(1.5),
    )


# ============================================================
# 版式分派表
# ============================================================

LAYOUT_BUILDERS = {
    "toc": _build_toc,
    "kpi": _build_kpi,
    "chart": _build_chart,
    "table": _build_table,
    "summary": _build_summary,
    "content": _build_content,
}


# ============================================================
# 主入口
# ============================================================

def build_pptx(
    slide_plan: Dict[str, Any],
    template_key: str,
    output_path: Path,
) -> Path:
    """
    根据 SlidePlan + 模板生成 .pptx 文件。
    返回生成的文件路径。
    """
    tpl = get_pptx_template(template_key)
    visual = get_template_visual_profile(template_key)
    colors = tpl["colors"]

    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    slides_data = slide_plan.get("slides", [])

    for slide_data in slides_data:
        if not slide_data.get("image_query"):
            slide_data["image_query"] = visual.get("pexels_query", "business presentation")
        layout_type = slide_data.get("layout", "content")

        if layout_type == "cover":
            _build_cover(prs, slide_data, colors, template_key)
        elif layout_type in LAYOUT_BUILDERS:
            LAYOUT_BUILDERS[layout_type](prs, slide_data, colors)
        else:
            _build_content(prs, slide_data, colors)

    prs.save(str(output_path))
    logger.info("PPTX 文件生成完成: %s (slides=%d)", output_path.name, len(slides_data))
    return output_path
