"""
意图分类策略模块（Intent Classifier）

设计目标：
1) 将主意图识别从 prompt_expander 中解耦，形成可复用策略层
2) 采用“规则命中 + 结构化信号评分”双轨判定，降低问句枚举依赖
3) 与 intent_policy 协同：查询问句默认只读，避免误入写操作链路
"""
import re
from typing import Dict, List, Tuple

from .intent_policy import is_read_only_query_request


class Intent:
    """意图常量（与 prompt_rules.py 的映射键保持一致）"""
    ANALYZE = "analyze"
    BEAUTIFY = "beautify"
    CHART = "chart"
    SUMMARY = "summary"
    SORT = "sort"
    FILTER = "filter"
    DEDUP = "dedup"
    PIVOT = "pivot"
    FORMAT = "format"
    CONDITIONAL_FORMAT = "conditional_format"
    QUERY = "query"
    FILL = "fill"
    UNKNOWN = "unknown"


# 第一层：明确规则命中（高精度）
_INTENT_PATTERNS: List[Tuple[str, List[str]]] = [
    (Intent.ANALYZE, [r"智能分析", r"自动分析", r"分析.*数据", r"数据分析", r"帮我分析", r"分析一下", r"全面分析"]),
    (Intent.BEAUTIFY, [r"美化", r"好看", r"调整.*样式", r"表格.*美观", r"格式化.*表格", r"加粗.*表头"]),
    (Intent.CHART, [r"(做|画|生成|创建|插入).{0,4}(图表|图|柱状图|折线图|饼图|条形图|散点图|面积图)", r"可视化", r"出图"]),
    (Intent.SUMMARY, [r"(分类|分组).{0,4}(汇总|统计)", r"汇总", r"(按|根据).{0,10}(统计|汇总|求和|计数|平均)", r"排行榜"]),
    (Intent.PIVOT, [r"透视表", r"数据透视", r"交叉.*表"]),
    (Intent.SORT, [r"排序", r"排列", r"升序", r"降序"]),
    (Intent.FILTER, [r"筛选", r"过滤"]),
    (Intent.DEDUP, [r"去重", r"去除重复", r"删除重复", r"清洗"]),
    (Intent.CONDITIONAL_FORMAT, [r"条件格式", r"(高亮|标记|标红|标色).{0,10}(大于|小于|等于|包含|重复|异常|前|后)", r"异常值.*标记", r"标记.*异常"]),
    (Intent.FORMAT, [r"(设置|修改|调整).{0,6}(格式|字体|颜色|背景|边框)", r"数字格式", r"日期格式", r"货币格式"]),
    (Intent.QUERY, [r"(有|共).{0,6}(多少|几)(行|条|个|种|类)", r"(最大|最小|总和|平均|总共|合计)", r"(最高|最低|最多|最少)", r"查询", r"查看"]),
    (Intent.FILL, [r"(填充|补充|添加).{0,6}(数据|公式|值)", r"(写入|录入)"]),
]


# 第二层：结构化评分信号（低枚举，偏泛化）
_INTENT_SIGNAL_RULES: Dict[str, Dict[str, str]] = {
    Intent.ANALYZE: {
        "action": r"(分析|洞察|评估|诊断|解读)",
        "object": r"(数据|趋势|表现|结果|指标|业务)",
    },
    Intent.CHART: {
        "action": r"(画|做|生成|创建|展示|可视化)",
        "object": r"(图|图表|趋势|柱状|折线|饼|散点|面积)",
    },
    Intent.SUMMARY: {
        "action": r"(汇总|统计|归纳|分组|聚合|排行)",
        "object": r"(数据|指标|列|维度|结果)",
    },
    Intent.PIVOT: {
        "action": r"(透视|交叉)",
        "object": r"(表|分析)",
    },
    Intent.BEAUTIFY: {
        "action": r"(美化|优化|调整)",
        "object": r"(样式|格式|外观|表格)",
    },
    Intent.CONDITIONAL_FORMAT: {
        "action": r"(标记|高亮|标红|标色|突出)",
        "object": r"(异常|条件|阈值|规则)",
    },
    Intent.SORT: {
        "action": r"(排序|排列)",
        "object": r"(升序|降序|顺序)",
    },
    Intent.FILTER: {
        "action": r"(筛选|过滤)",
        "object": r"(条件|数据|记录)",
    },
    Intent.DEDUP: {
        "action": r"(去重|清洗)",
        "object": r"(重复|冗余|脏数据)",
    },
    Intent.FORMAT: {
        "action": r"(设置|修改|调整)",
        "object": r"(格式|字体|颜色|边框|对齐|数字格式)",
    },
    Intent.FILL: {
        "action": r"(填充|补全|写入|录入)",
        "object": r"(数据|值|公式)",
    },
    Intent.QUERY: {
        "action": r"(查询|查看|找出|统计)",
        "object": r"(多少|几|最大|最小|最高|最低|均值|总和|合计)",
    },
}


def _match_by_patterns(text: str) -> List[str]:
    intents: List[str] = []
    for intent_name, patterns in _INTENT_PATTERNS:
        if any(re.search(p, text) for p in patterns):
            intents.append(intent_name)
    return intents


def _match_by_signals(text: str) -> List[str]:
    hits: List[str] = []
    for intent_name, rules in _INTENT_SIGNAL_RULES.items():
        score = 0
        if re.search(rules["action"], text):
            score += 1
        if re.search(rules["object"], text):
            score += 1
        if score >= 2:
            hits.append(intent_name)
    return hits


def detect_intents(command: str) -> List[str]:
    """主意图识别：规则命中优先，结构化信号补充。"""
    text = str(command or "").strip()
    if not text:
        return [Intent.UNKNOWN]

    intents = _match_by_patterns(text)
    if not intents:
        intents = _match_by_signals(text)

    # 查询只读策略兜底：问句且无写意图时强制归入 query
    if is_read_only_query_request(text, intents):
        return [Intent.QUERY]

    # 去重保持顺序
    deduped: List[str] = []
    for it in intents:
        if it not in deduped:
            deduped.append(it)

    return deduped or [Intent.UNKNOWN]

