# backend/app/report/templates.py
"""
报表模板定义 — 8 种预设分析风格
保留模板选择入口（名称、图标、描述），内部结构由 LLM 动态规划。
style_hint 作为 Phase 1 LLM 的分析风格指引。
"""
from typing import Dict, List, Any

REPORT_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "overview": {
        "key": "overview",
        "name": "经营概览",
        "description": "销售/财务/运营通用，全面展示核心指标与趋势",
        "icon": "BarChart3",
        "style_hint": (
            "全面展示核心KPI和关键维度分布，兼顾时间趋势和分类结构。"
            "图表数量 6-10 张，涵盖折线趋势、柱状排行、饼图占比。"
            "优先展示总量指标（总额、总数）及其分维度拆解。"
        ),
        "suitable_for": ["sales", "finance", "operations", "general"],
    },
    "comparison": {
        "key": "comparison",
        "name": "对比分析",
        "description": "多维度对比，适合地区、产品线、渠道分析",
        "icon": "ArrowLeftRight",
        "style_hint": (
            "侧重多维度对比：地区对比、产品对比、渠道对比、时间同比/环比。"
            "图表数量 5-8 张，必须包含分组柱状图和雷达图。"
            "KPI 应体现对比差异：最大值 vs 最小值、增长率差异等。"
        ),
        "suitable_for": ["sales", "operations", "general"],
    },
    "trend": {
        "key": "trend",
        "name": "趋势深潜",
        "description": "时间序列数据深度分析，聚焦变化规律",
        "icon": "TrendingUp",
        "style_hint": (
            "侧重时间序列深度分析，必须包含同环比、季节性、拐点识别。"
            "图表数量 4-8 张，折线图为主，辅以瀑布式变化图。"
            "KPI 应体现趋势：期初 vs 期末、增长率、波动率。"
            "日期粒度应根据数据时间跨度自动选择（年/季/月/周/日）。"
        ),
        "suitable_for": ["sales", "finance", "operations"],
    },
    "ranking": {
        "key": "ranking",
        "name": "排行榜单",
        "description": "聚焦 TOP N，快速定位头部与尾部",
        "icon": "Trophy",
        "style_hint": (
            "聚焦 TOP N 排行，快速定位头部与尾部。"
            "图表数量 4-6 张，水平柱状图为主，辅以饼图占比。"
            "KPI 应体现集中度：TOP3/TOP5 占比、头尾差距倍数。"
            "每个分类维度都应有独立排行。"
        ),
        "suitable_for": ["sales", "operations", "general"],
    },
    "executive": {
        "key": "executive",
        "name": "管理层摘要",
        "description": "一页精华，大数字 + 关键结论 + 行动建议",
        "icon": "Briefcase",
        "style_hint": (
            "管理层一页精华：大数字 KPI + 关键趋势 + 行动建议。"
            "图表数量 2-4 张，精简但信息密度高。"
            "KPI 数量 4-6 个，选择最关键的经营指标。"
            "侧重宏观结论而非细节拆解。"
        ),
        "suitable_for": ["sales", "finance", "operations", "general"],
    },
    "anomaly": {
        "key": "anomaly",
        "name": "异常诊断",
        "description": "聚焦异常波动、离群点和风险信号",
        "icon": "AlertTriangle",
        "style_hint": (
            "重点识别异常值、突变区间和异常聚集维度，优先解释异常成因。"
            "图表数量 5-8 张，建议包含趋势折线、箱线分布或异常排行。"
            "KPI 应体现异常规模与影响：异常占比、异常金额、波动幅度。"
            "输出应给出明确排查路径和修复优先级。"
        ),
        "suitable_for": ["sales", "finance", "operations", "manufacturing", "general"],
    },
    "segment": {
        "key": "segment",
        "name": "客户分层",
        "description": "按客群/区域/渠道分层洞察结构差异",
        "icon": "Users",
        "style_hint": (
            "围绕分层分析展开：客群分层、区域分层、渠道分层与价值带分布。"
            "图表数量 5-8 张，优先分组柱状图、占比图、客群价值散点图。"
            "KPI 应体现分层差异：高价值客群占比、客群贡献度、层级迁移趋势。"
            "结论需明确不同分层的策略动作。"
        ),
        "suitable_for": ["sales", "retail", "operations", "general"],
    },
    "funnel": {
        "key": "funnel",
        "name": "漏斗转化",
        "description": "关注流程转化效率，定位关键流失环节",
        "icon": "Filter",
        "style_hint": (
            "以流程漏斗为主线，分析各阶段转化率、流失率和瓶颈节点。"
            "图表数量 4-7 张，必须包含漏斗图或阶段转化对比图。"
            "KPI 应体现转化效率：阶段转化率、累计转化率、关键环节流失占比。"
            "建议需指向可执行的优化动作与验证指标。"
        ),
        "suitable_for": ["sales", "operations", "retail", "general"],
    },
}


def get_template(key: str) -> Dict[str, Any]:
    return REPORT_TEMPLATES.get(key, REPORT_TEMPLATES["overview"])


def get_all_templates() -> List[Dict[str, Any]]:
    return [
        {
            "key": t["key"],
            "name": t["name"],
            "description": t["description"],
            "icon": t["icon"],
        }
        for t in REPORT_TEMPLATES.values()
    ]
