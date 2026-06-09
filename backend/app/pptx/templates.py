# backend/app/pptx/templates.py
"""
PPTX 汇报模板定义 — 10 套企业级扁平模板
每套模板包含：配色方案、字体对、封面背景图引用、版式定义。
颜色值统一使用 6 位 hex（不含 #），供 python-pptx RGBColor 直接消费。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

# 素材根目录
ASSETS_DIR = Path(__file__).parent / "assets"
COVERS_DIR = ASSETS_DIR / "covers"

# ============================================================
# 模板注册表
# ============================================================

PPTX_TEMPLATES: Dict[str, Dict[str, Any]] = {

    # ── 1. 商务蓝 ──────────────────────────────────────────
    "business_blue": {
        "key": "business_blue",
        "name": "商务蓝",
        "description": "深蓝渐变 + 白字，通用商务汇报",
        "icon": "Briefcase",
        "cover_image": "business_blue.png",
        "colors": {
            "primary": "1B3A6B",
            "secondary": "2D5FAA",
            "accent": "4ECDC4",
            "bg_start": "0D1F3C",
            "bg_end": "1B3A6B",
            "text_light": "FFFFFF",
            "text_dark": "1B3A6B",
            "text_muted": "8EACC8",
            "card_bg": "163058",
            "table_header": "1B3A6B",
            "table_stripe": "F0F4F8",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 2. 科技黑 ──────────────────────────────────────────
    "tech_dark": {
        "key": "tech_dark",
        "name": "科技黑",
        "description": "暗黑底 + 荧光蓝绿，技术/数据分析",
        "icon": "Monitor",
        "cover_image": "tech_dark.png",
        "colors": {
            "primary": "0AE5C7",
            "secondary": "00B4D8",
            "accent": "7B2FF7",
            "bg_start": "0A0E17",
            "bg_end": "141B2D",
            "text_light": "E8F0FE",
            "text_dark": "0A0E17",
            "text_muted": "5A6A8A",
            "card_bg": "1A2238",
            "table_header": "141B2D",
            "table_stripe": "F0F4F8",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 3. 极简白 ──────────────────────────────────────────
    "minimal_white": {
        "key": "minimal_white",
        "name": "极简白",
        "description": "纯白底 + 灰黑字，正式场合",
        "icon": "FileText",
        "cover_image": "minimal_white.png",
        "colors": {
            "primary": "2D3748",
            "secondary": "4A5568",
            "accent": "3182CE",
            "bg_start": "FFFFFF",
            "bg_end": "F7FAFC",
            "text_light": "FFFFFF",
            "text_dark": "1A202C",
            "text_muted": "A0AEC0",
            "card_bg": "F7FAFC",
            "table_header": "2D3748",
            "table_stripe": "F7FAFC",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 4. 森林绿 ──────────────────────────────────────────
    "forest_green": {
        "key": "forest_green",
        "name": "森林绿",
        "description": "深绿 + 米白，可持续/环保",
        "icon": "TreePine",
        "cover_image": "forest_green.png",
        "colors": {
            "primary": "1B5E3B",
            "secondary": "2E8B57",
            "accent": "A8D5BA",
            "bg_start": "0F3D26",
            "bg_end": "1B5E3B",
            "text_light": "F5F0E8",
            "text_dark": "1B5E3B",
            "text_muted": "7CAA91",
            "card_bg": "174D33",
            "table_header": "1B5E3B",
            "table_stripe": "F0F8F4",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 5. 活力橙 ──────────────────────────────────────────
    "vibrant_orange": {
        "key": "vibrant_orange",
        "name": "活力橙",
        "description": "暖橙渐变 + 白字，营销/增长",
        "icon": "Flame",
        "cover_image": "vibrant_orange.png",
        "colors": {
            "primary": "E8590C",
            "secondary": "F97316",
            "accent": "FCD34D",
            "bg_start": "7C2D12",
            "bg_end": "E8590C",
            "text_light": "FFFFFF",
            "text_dark": "7C2D12",
            "text_muted": "FDBA74",
            "card_bg": "9A3412",
            "table_header": "E8590C",
            "table_stripe": "FFF7ED",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 6. 高级灰 ──────────────────────────────────────────
    "premium_gray": {
        "key": "premium_gray",
        "name": "高级灰",
        "description": "灰色阶 + 金色点缀，金融/高管",
        "icon": "Building2",
        "cover_image": "premium_gray.png",
        "colors": {
            "primary": "374151",
            "secondary": "6B7280",
            "accent": "D4A843",
            "bg_start": "1F2937",
            "bg_end": "374151",
            "text_light": "F3F4F6",
            "text_dark": "1F2937",
            "text_muted": "9CA3AF",
            "card_bg": "2D3748",
            "table_header": "374151",
            "table_stripe": "F3F4F6",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 7. 中国红 ──────────────────────────────────────────
    "china_red": {
        "key": "china_red",
        "name": "中国红",
        "description": "深红 + 金色，年度总结",
        "icon": "Award",
        "cover_image": "china_red.png",
        "colors": {
            "primary": "9B1B30",
            "secondary": "C62828",
            "accent": "D4A843",
            "bg_start": "5C0A1A",
            "bg_end": "9B1B30",
            "text_light": "FFF5E6",
            "text_dark": "5C0A1A",
            "text_muted": "E8A0A0",
            "card_bg": "7A1525",
            "table_header": "9B1B30",
            "table_stripe": "FEF2F2",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 8. 星空紫 ──────────────────────────────────────────
    "starry_purple": {
        "key": "starry_purple",
        "name": "星空紫",
        "description": "深紫渐变 + 粉蓝，创新/产品发布",
        "icon": "Sparkles",
        "cover_image": "starry_purple.png",
        "colors": {
            "primary": "5B21B6",
            "secondary": "7C3AED",
            "accent": "F0ABFC",
            "bg_start": "2E1065",
            "bg_end": "5B21B6",
            "text_light": "F5F3FF",
            "text_dark": "2E1065",
            "text_muted": "A78BFA",
            "card_bg": "3B1A8E",
            "table_header": "5B21B6",
            "table_stripe": "F5F3FF",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 9. 清新青 ──────────────────────────────────────────
    "fresh_cyan": {
        "key": "fresh_cyan",
        "name": "清新青",
        "description": "浅青蓝 + 白色，教育/培训",
        "icon": "GraduationCap",
        "cover_image": "fresh_cyan.png",
        "colors": {
            "primary": "0E7490",
            "secondary": "06B6D4",
            "accent": "67E8F9",
            "bg_start": "ECFEFF",
            "bg_end": "CFFAFE",
            "text_light": "FFFFFF",
            "text_dark": "164E63",
            "text_muted": "67E8F9",
            "card_bg": "E0F7FA",
            "table_header": "0E7490",
            "table_stripe": "ECFEFF",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },

    # ── 10. 暗夜金 ─────────────────────────────────────────
    "dark_gold": {
        "key": "dark_gold",
        "name": "暗夜金",
        "description": "纯黑 + 金色，高端汇报",
        "icon": "Crown",
        "cover_image": "dark_gold.png",
        "colors": {
            "primary": "D4A843",
            "secondary": "B8860B",
            "accent": "FFD700",
            "bg_start": "000000",
            "bg_end": "1A1A1A",
            "text_light": "F5E6C8",
            "text_dark": "000000",
            "text_muted": "8B7D5E",
            "card_bg": "1A1A0A",
            "table_header": "1A1A1A",
            "table_stripe": "F9F6EF",
        },
        "fonts": {"title": "Microsoft YaHei", "body": "Microsoft YaHei"},
    },
}

TEMPLATE_VISUALS: Dict[str, Dict[str, str]] = {
    "business_blue": {"cover_style": "diagonal", "pexels_query": "corporate office meeting"},
    "tech_dark": {"cover_style": "neon_grid", "pexels_query": "technology data center"},
    "minimal_white": {"cover_style": "clean_blocks", "pexels_query": "modern office white"},
    "forest_green": {"cover_style": "organic_curves", "pexels_query": "sustainability green business"},
    "vibrant_orange": {"cover_style": "dynamic_rays", "pexels_query": "marketing growth team"},
    "premium_gray": {"cover_style": "luxury_lines", "pexels_query": "finance executive boardroom"},
    "china_red": {"cover_style": "festive_wave", "pexels_query": "city skyline red light"},
    "starry_purple": {"cover_style": "star_particles", "pexels_query": "innovation digital product"},
    "fresh_cyan": {"cover_style": "soft_bubbles", "pexels_query": "education training teamwork"},
    "dark_gold": {"cover_style": "gold_arc", "pexels_query": "luxury business presentation"},
}


# ============================================================
# 公开 API
# ============================================================

def get_pptx_template(key: str) -> Dict[str, Any]:
    """获取指定模板，不存在则回退到商务蓝"""
    return PPTX_TEMPLATES.get(key, PPTX_TEMPLATES["business_blue"])


def get_all_pptx_templates() -> List[Dict[str, Any]]:
    """获取所有模板摘要（供前端选择列表）"""
    return [
        {
            "key": t["key"],
            "name": t["name"],
            "description": t["description"],
            "icon": t["icon"],
            "cover_image": t["cover_image"],
            "cover_url": f"/api/pptx/template-cover/{t['key']}",
            "colors": t["colors"],
            "fonts": t["fonts"],
            "visual": TEMPLATE_VISUALS.get(t["key"], {}),
        }
        for t in PPTX_TEMPLATES.values()
    ]


def get_cover_path(template_key: str) -> Path:
    """获取封面背景图的文件路径"""
    tpl = get_pptx_template(template_key)
    return COVERS_DIR / tpl["cover_image"]


def get_template_visual_profile(template_key: str) -> Dict[str, str]:
    """获取模板视觉配置（封面风格 + 素材关键词）"""
    return TEMPLATE_VISUALS.get(template_key, TEMPLATE_VISUALS["business_blue"])
