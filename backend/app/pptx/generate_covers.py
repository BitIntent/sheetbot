# backend/app/pptx/generate_covers.py
"""
封面背景图生成器 — 用 Pillow 为 10 套模板各生成一张 1920x1080 封面背景
运行方式：python -m backend.app.pptx.generate_covers
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

COVERS_DIR = Path(__file__).parent / "assets" / "covers"
COVERS_DIR.mkdir(parents=True, exist_ok=True)

W, H = 1920, 1080


def _hex(s: str) -> tuple:
    """6 位 hex 转 RGB 元组"""
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _lerp(c1: tuple, c2: tuple, t: float) -> tuple:
    """线性插值两色"""
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def _draw_gradient(img: Image.Image, c_start: tuple, c_end: tuple, angle: float = 135):
    """绘制角度渐变背景"""
    px = img.load()
    rad = math.radians(angle)
    cos_a, sin_a = math.cos(rad), math.sin(rad)

    for y in range(H):
        for x in range(W):
            nx = x / W - 0.5
            ny = y / H - 0.5
            t = nx * cos_a + ny * sin_a + 0.5
            t = max(0.0, min(1.0, t))
            px[x, y] = _lerp(c_start, c_end, t)


def _draw_circles(draw: ImageDraw.ImageDraw, accent: tuple, count: int = 6):
    """在右下角绘制装饰圆"""
    for i in range(count):
        r = 80 + i * 60
        cx = W - 200 + i * 30
        cy = H - 200 + i * 25
        alpha_color = (*accent, 25 + i * 8)
        draw.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            fill=None,
            outline=(*accent, 60),
            width=2,
        )


def _draw_diagonal_stripe(draw: ImageDraw.ImageDraw, accent: tuple):
    """右上角对角装饰条"""
    points = [(W - 400, 0), (W, 0), (W, 300)]
    draw.polygon(points, fill=(*accent, 40))
    points2 = [(W - 250, 0), (W, 0), (W, 180)]
    draw.polygon(points2, fill=(*accent, 30))


def _draw_bottom_bar(draw: ImageDraw.ImageDraw, color: tuple, h: int = 6):
    """底部细横条装饰"""
    draw.rectangle([0, H - h, W, H], fill=color)


def generate_cover(filename: str, bg_start: str, bg_end: str, accent: str, style: str = "default"):
    """生成单张封面背景"""
    img = Image.new("RGBA", (W, H))
    c_start = _hex(bg_start)
    c_end = _hex(bg_end)
    c_accent = _hex(accent)

    # 渐变底色
    bg = Image.new("RGB", (W, H))
    _draw_gradient(bg, c_start, c_end)
    img.paste(bg)

    draw = ImageDraw.ImageDraw(img, "RGBA")

    if style == "light":
        # 浅色系：左侧色块 + 底部条
        draw.rectangle([0, 0, 60, H], fill=(*_hex(accent), 50))
        _draw_bottom_bar(draw, (*c_accent, 180), 4)
    else:
        # 深色系：对角线装饰 + 圆形 + 底部条
        _draw_diagonal_stripe(draw, c_accent)
        _draw_circles(draw, c_accent)
        _draw_bottom_bar(draw, c_accent)

    # 保存为 PNG
    out = img.convert("RGB")
    out.save(COVERS_DIR / filename, "PNG", optimize=True)
    print(f"  -> {filename}")


# ============================================================
# 模板配色映射
# ============================================================

COVER_SPECS = [
    ("business_blue.png", "0D1F3C", "1B3A6B", "4ECDC4", "default"),
    ("tech_dark.png", "0A0E17", "141B2D", "0AE5C7", "default"),
    ("minimal_white.png", "FFFFFF", "F7FAFC", "3182CE", "light"),
    ("forest_green.png", "0F3D26", "1B5E3B", "A8D5BA", "default"),
    ("vibrant_orange.png", "7C2D12", "E8590C", "FCD34D", "default"),
    ("premium_gray.png", "1F2937", "374151", "D4A843", "default"),
    ("china_red.png", "5C0A1A", "9B1B30", "D4A843", "default"),
    ("starry_purple.png", "2E1065", "5B21B6", "F0ABFC", "default"),
    ("fresh_cyan.png", "ECFEFF", "CFFAFE", "0E7490", "light"),
    ("dark_gold.png", "000000", "1A1A1A", "D4A843", "default"),
]


def main():
    print("生成 PPTX 封面背景图...")
    for spec in COVER_SPECS:
        generate_cover(*spec)
    print(f"完成！共 {len(COVER_SPECS)} 张，目录: {COVERS_DIR}")


if __name__ == "__main__":
    main()
