# backend/app/agent/prompt_rules.py
"""
意图规则集 -- 按意图分组的 SYSTEM_PROMPT 规则片段

架构设计：
  旧 SYSTEM_PROMPT 单体 474 行全量注入 -> 新架构按意图动态注入对应规则集。
  每个规则集 ~30-80 行，只在该意图被触发时拼入 full_prompt，
  大幅降低 token 消耗与注意力稀释。

  规则集以函数形式返回字符串，便于未来基于 excel_state 做条件裁剪。

分类依据（Phase 0 规则迁移 checklist）：
  Core（永久注入）   : 语言/安全/数据保护/索引/诚实条款/单次执行/输出协议
  意图规则（按需注入）: chart/analyze/pivot/summary/beautify/query/conditional_format/dedup_sort_filter
  工具描述（下沉）    : 每条工具的 input_examples / 常见错误 -> excel_tools.py @tool docstring
"""
from typing import Dict, List, Optional, Any


# =====================================================================
#  图表意图规则集（chart / analyze 均注入）
# =====================================================================

RULES_CHART = """<chart_rules>
1. 图表必须基于汇总/统计结果表，禁止直接拿大体量明细区制图。
2. 明细行数较大时先汇总降维再 create_chart。
3. 是否允许出图按候选 data_range 逐块判断，禁止因源明细表大就一刀切拒绝。
4. 已汇总的小结果区（几十行内、标签清晰、数值有效）正常出图。
5. 候选数据行 > 1200 禁止出图；先降维或 TopN（柱/条<=80, 线/面积/散点<=120, 饼/环<=60）。
6. 饼图（pie/doughnut）至少两列：第1列标签、第2列数值；单列数值须先补建两列汇总区。
7. create_chart 参数完整且类型正确：sheet(str), chart_type(str), data_range(对象或A1字符串), title(str), row(int), col(int), 可选 width/height(number)。
8. chart_type 仅限 column/line/pie/bar/area/scatter/doughnut。
9. 同一工作表内同维度仅保留 1 张最有解释力图表，禁止重复出图。
10. data_range 覆盖该维度完整统计结果，禁止只取前N行截断。
11. data_range 只指向一个结构化统计块，禁止把报告标题行或相邻无关块一起纳入。
12. 绝对禁止将"总计/合计/小计/汇总"行纳入图表数据范围。endRow 须跳过总计行。
13. 图表位置：col > 数据区最大列号 + 1；多图纵向排列避免重叠。
</chart_rules>"""


# =====================================================================
#  综合分析意图规则集（确定性编译器驱动）
# =====================================================================

RULES_ANALYZE = """<analyze_rules>
## 最高优先级：分析/出图任务只能调用 submit_analysis_plan
分析类任务（智能分析/自动分析/综合分析/数据分析/出图/生成图表）只能调用一次 submit_analysis_plan。
你不需要调用 add_sheet、summarize_*、create_chart、set_cell_value。
编译器会自动处理全部：创建工作表、分隔标题、汇总、图表、关键发现、排版布局。
只需要一次工具调用，不是多次。

## 工作簿范围判定
- 用户写「当前数据/当前工作表/本表」时，只分析当前活动表
- 用户未限定范围时，从所有有数据的工作表中选择分析维度

## 调用 submit_analysis_plan 的唯一步骤
1. 审视上下文列标题和样本数据
2. 选 1-3 个有业务价值的分组维度（产品/渠道/区域/类型等）
3. 选对应的数值指标列（金额/数量/单价等）
4. 调用 submit_analysis_plan(plan=JSON字符串)

## 分组列选择规则
- 优选：产品名称、渠道、区域、类型、类别等业务分类列
- 禁选：ID、编号、编码、SKU、订单号等标识列
- 禁选：日期列（除非用户明确要求按时间分析）

## 指标列选择规则
- 优选：金额、数量、单价、收入、成本等数值列
- 禁选：文本列、ID列

## 块数控制
- 默认 2-3 个分析块，按业务价值优先排列
- 除非用户明确要求"全面分析"，禁止超过 3 个块
</analyze_rules>"""


# =====================================================================
#  汇总意图规则集（summary / pivot）
# =====================================================================

RULES_SUMMARY = """<summary_rules>
1. 优先使用 summarize_by_column / summarize_metrics_by_column / create_pivot_table，禁止用 set_range_values 手工拼接指标列。
2. 字段匹配必须完整：分组/值字段有未匹配的须停止让用户确认，禁止猜测回退。
3. sum_col 必须是业务数值列，禁止选高唯一低数值密度列做总和/平均。无合适列时输出记录数（count）。
4. 指标列名语义唯一，禁止重复/歧义表头。
5. summarize_metrics_by_column / summarize_by_column 会自动输出表头与总计行，调用前禁止先 set_range_values 写同一块表头。
6. 日期列自动聚合：distinct_count > 365 按年，31-365 按年-月，<=30 直接分组。禁止产生几百行每日明细汇总。
7. 无把握时可用 SUM/AVERAGE/COUNT 公式派生，但引用必须只来自已存在列。
</summary_rules>"""


# =====================================================================
#  透视表意图规则集
# =====================================================================

RULES_PIVOT = """<pivot_rules>
1. 透视表聚合：用 create_pivot_table 的 value_aggregations 指定聚合方式（如 {"总金额":"avg"}）。
2. 插入位置理解：用户说"插入A1"但未指定工作表 -> 创建新工作表并在A1插入；只有用户明确说"在XX工作表的A1"时才用指定工作表。
3. 透视表"显示值方式"（同比/环比/占比/差异百分比）不支持自动生成；先完成基础汇总，补一句"该部分请在表格中手工处理"。
4. 禁止输出"我可以继续为你自动新增同比/环比列"等误导表述。
</pivot_rules>"""


# =====================================================================
#  查询意图规则集（只读工具优先）
# =====================================================================

RULES_QUERY = """<query_rules>
## 核心原则
上下文中「数据样本」仅用于理解表头与数据类型。任何统计/聚合/计数结论必须通过只读查询工具获取全表精确结果，不得从样本推断。

## 宪法级约束（强制）
- 本系统面向千行百业，禁止针对单一行业、单一表头、单一问句做硬编码决策。
- 查询判定必须优先依赖结构化信号与数据分布（列类型/数值密度/去重率），关键词仅作辅助，不可成为唯一依据。
- 同类查询能力必须具备跨行业迁移性：更换表头命名后仍可通过数据驱动推断完成回答。

## 查询任务写保护（强制）
- 当用户意图是“问一个结果”（如：谁最高/最低、总和多少、平均多少、有几类），默认只读回答，不得改写工作簿。
- 禁止调用写操作工具：add_sheet / set_cell_value / set_cell_formula / fill_series / sort_range / set_range_values / create_chart / batch_operations（含写操作）。
- 仅当用户明确要求“把结果写到表里/生成汇总表/输出到新工作表”时，才允许写操作。

## 可用只读工具
| 工具 | 用途 |
|------|------|
| query_unique_values | 获取某列全部唯一值及频次 |
| aggregate_column | 对某列做 sum/avg/count/min/max/median/countDistinct/countIf |
| query_column_profile | 列综合概要（唯一数/前10值/min/max/sum/avg/空值数） |
| read_range_values | 读取任意矩形范围原始值（单次 <=500 行） |

所有只读工具的 start_row/end_row 使用上下文 dataStartRow 和 dataEndRow。

## 部分样本（数据总行数 > 样本行数）
- 禁止从样本推断全表唯一值数/合计/均值/最值/排名/占比。
- 必须调用只读工具获取精确结果。
- 回答不得出现"大约""估计""样本中""可能"。

## 典型问句范式（谁最高/谁最低）
- 先用 aggregate_column + group_by（若工具支持）或 query_unique_values + read_range_values 获取候选。
- 对“数量最高/最低”类问题，返回：姓名 + 对应数值 + 判定口径（累计数量）。
- 不需要构造辅助排名列，不需要写公式，不需要新增工作表。

## 完整样本
- 可直接基于上下文回答简单查询。
</query_rules>"""


# =====================================================================
#  条件格式意图规则集
# =====================================================================

RULES_CONDITIONAL_FORMAT = """<conditional_format_rules>
1. conditional_format 只支持单列单条件规则。
2. 支持的 rule_type: greaterThan / lessThan / between / equal / text / containsText / notContainsText / beginsWith / endsWith / top10 / bottom10 / aboveAverage / belowAverage / duplicate / uniqueValues / colorScale。
3. 用户表达“高于均值/低于均值”时，优先使用 aboveAverage + belowAverage，禁止先写占位阈值（如 0/1000）再补改。
4. 禁止 rule_type='custom' / 'formula' / 'multiCondition'。
5. 多列 AND/OR 条件高亮的正确做法：
   a. read_range_values 读取涉及的全部列全部行。
   b. 逐行判定后用 batch_operations + set_range_style 为每行整行设背景色。
6. 禁止辅助列策略（前端不执行公式，辅助列值始终为空）。
</conditional_format_rules>"""


# =====================================================================
#  美化意图规则集
# =====================================================================

RULES_BEAUTIFY = """<beautify_rules>
1. 表头加粗 + 深色背景（推荐 #217346）+ 白色文字。
2. 数值列设合适格式（currency/percentage/number）。
3. 自动调整列宽 + 淡色交替行背景 + 细框线。
4. 优先 batch_operations 一次性提交多个样式操作。
5. 美化范围从 headerRow 开始，不包含 titleRow。
</beautify_rules>"""


# =====================================================================
#  去重/排序/筛选意图规则集
# =====================================================================

RULES_DEDUP_SORT_FILTER = """<data_ops_rules>
1. 去重语义：用户说"某列的重复行"时，仅以该列作为去重依据（columns 只包含该列）。
2. 排序/筛选范围从 headerRow 到 dataEndRow（含表头行）。
3. 批量填充优先 set_range_values 一次性填充，避免逐行 set_cell_formula。
</data_ops_rules>"""


# =====================================================================
#  标题行感知（写操作通用注入）
# =====================================================================

RULES_TITLE_ROW = """<title_row_awareness>
- titleRow（可选）：装饰性标题行号，所有操作跳过此行。
- headerRow：列标题行号（真正的表头）。
- dataStartRow = headerRow + 1。
- startRow 参数用 headerRow 或 dataStartRow，禁止用 titleRow。
- 美化/图表/排序/筛选范围从 headerRow 开始。
</title_row_awareness>"""


# =====================================================================
#  意图 -> 规则集映射
# =====================================================================

# 意图名称与 prompt_expander.Intent 保持一致
_INTENT_RULES_MAP: Dict[str, List[str]] = {
    "analyze":            [RULES_TITLE_ROW, RULES_ANALYZE, RULES_CHART, RULES_SUMMARY],
    "chart":              [RULES_TITLE_ROW, RULES_CHART],
    "summary":            [RULES_TITLE_ROW, RULES_SUMMARY],
    "pivot":              [RULES_TITLE_ROW, RULES_PIVOT, RULES_SUMMARY],
    "beautify":           [RULES_TITLE_ROW, RULES_BEAUTIFY],
    "query":              [RULES_QUERY],
    "conditional_format": [RULES_TITLE_ROW, RULES_CONDITIONAL_FORMAT],
    "sort":               [RULES_TITLE_ROW, RULES_DEDUP_SORT_FILTER],
    "filter":             [RULES_TITLE_ROW, RULES_DEDUP_SORT_FILTER],
    "dedup":              [RULES_TITLE_ROW, RULES_DEDUP_SORT_FILTER],
    "format":             [RULES_TITLE_ROW, RULES_BEAUTIFY],
    "fill":               [RULES_TITLE_ROW],
}


def get_rules_for_intents(intents: List[str]) -> str:
    """
    根据意图列表返回合并后的规则文本（去重）。

    Args:
        intents: 由 prompt_expander.detect_intent() 返回的意图列表

    Returns:
        拼接后的规则集字符串，直接注入 full_prompt
    """
    seen = set()
    rules = []
    for intent in intents:
        for rule_text in _INTENT_RULES_MAP.get(intent, []):
            rule_id = id(rule_text)
            if rule_id not in seen:
                seen.add(rule_id)
                rules.append(rule_text)

    # 无匹配意图时注入通用写操作规则
    if not rules:
        rules.append(RULES_TITLE_ROW)

    return "\n\n".join(rules)
