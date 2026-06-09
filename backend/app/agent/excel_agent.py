# backend/app/agent/excel_agent.py
"""
Excel AI Agent using Claude Agent SDK
处理用户自然语言指令，生成 Excel 操作
"""
import os
import json
import asyncio
import time
import subprocess
import signal
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, AsyncIterator, Callable
from dataclasses import dataclass, field
from claude_agent_sdk import (
    ClaudeSDKClient, ClaudeAgentOptions,
    AssistantMessage, TextBlock, ToolUseBlock, ToolResultBlock, UserMessage
)
from .excel_tools import excel_tools_server, EXCEL_TOOL_NAMES
from .operation_validator import validate_operation_params, ValidationResult
from .prompt_expander import expand_user_prompt, detect_intent
from .prompt_rules import get_rules_for_intents
from .operation_registry import READ_ONLY_OPERATIONS, resolve_operation_type
from .intent_policy import is_read_only_query_request
from .query_bridge import get_current_bridge
from .query_semantic_parser import infer_query_semantics_with_llm
from .plan_compiler import _select_chart_type as _select_chart_type_by_data
from .plan_retry_policy import (
    should_retry_submit_analysis_plan,
    build_submit_analysis_retry_prompt,
)
from .retry_executor import execute_silent_retry_round
from ..utils.logger import AgentLogger
from ..utils.llm_model_descriptor import describe_llm_model_for_log
from ..core.config import settings


_USER_ERROR_GENERIC = "抱歉，本次操作未能完成。您可以重新描述需求再试一次。"
_USER_ERROR_LEARNING = "抱歉，该操作在当前数据结构下暂不支持。您可以换一种方式描述，或尝试拆分步骤。"
_USER_ERROR_RETRY = "抱歉，执行过程遇到问题，请稍后重试。"
_USER_HINT_PARAM = "抱歉，操作参数未能正确匹配。您可以重新发送指令再试一次。"
_USER_HINT_DATA = "抱歉，当前数据分布不适合直接执行该步骤。您可以尝试更具体的描述。"
_USER_HINT_CHART = "抱歉，图表数据区不完整。请确认数据包含分类列和数值列后重试。"
_SOFT_GUARD_PREFIX = "[SOFT_GUARD]"
_READONLY_QUERY_TOOL_NAMES = [
    "mcp__excel-tools__query_unique_values",
    "mcp__excel-tools__read_range_values",
    "mcp__excel-tools__aggregate_column",
    "mcp__excel-tools__query_column_profile",
]
_READONLY_QUERY_TOOL_SET = frozenset(_READONLY_QUERY_TOOL_NAMES)

_CHART_MAX_EFFECTIVE_ROWS = {
    "pie": 60,
    "doughnut": 60,
    "donut": 60,
    "column": 80,
    "bar": 80,
}

# 兼容旧格式分隔标题（=== xxx ===）
_SECTION_BANNER_RE = re.compile(r"^={2,}.+={2,}\s*$")
# 「关键发现」等尾块标题参与排版但不视为独立数据块，禁止计入补图块数（否则会多补一张重复图）
_BANNER_NON_DATA_KEYS = ("关键发现", "总结", "结论", "核心洞察")
_DATA_BLOCK_TITLE_RE = re.compile(r"(分析|汇总|排行|趋势|对比|分布|占比|统计|概览|洞察)")


def _normalize_section_banner_text(val: Any) -> str:
    """将标题文本规范化为商业样式（去除首尾 === 包裹）。"""
    if not isinstance(val, str):
        return ""
    s = val.strip()
    s = re.sub(r"^=+\s*", "", s)
    s = re.sub(r"\s*=+$", "", s)
    return s.strip()


def _is_section_banner_title(val: Any) -> bool:
    """是否为区块标题（兼容新旧两种格式）。"""
    if not isinstance(val, str):
        return False
    raw = val.strip()
    if not raw:
        return False
    core = _normalize_section_banner_text(raw)
    if not core:
        return False
    if _SECTION_BANNER_RE.match(raw):
        return True
    # 新商业样式：无 === 包裹，常见标题形态
    return bool(
        core.endswith("分析")
        or any(k in core for k in _BANNER_NON_DATA_KEYS)
        or _DATA_BLOCK_TITLE_RE.search(core)
    )


def _is_data_block_section_banner(val: Any) -> bool:
    """是否为「数据/分析块」分隔标题（排除关键发现等尾段）。"""
    if not _is_section_banner_title(val):
        return False
    s = _normalize_section_banner_text(val)
    if any(k in s for k in _BANNER_NON_DATA_KEYS):
        return False
    return bool(s.endswith("分析") or _DATA_BLOCK_TITLE_RE.search(s))

def _sanitize_error_for_user(technical_msg: str) -> str:
    """
    将技术性错误信息转换为用户友好的描述。
    技术细节仅保留在日志中，面向用户的消息不暴露参数名、类型名、内部实现。
    """
    lower = technical_msg.lower()
    if any(k in lower for k in ('chart', '图表', 'datarange', 'data_range', '饼图', '柱状图', '可视化')):
        return _USER_HINT_CHART
    if any(k in lower for k in ('sumcol', 'groupbycol', '数值密度', '唯一', '聚合', '统计')):
        return _USER_HINT_DATA
    if any(k in lower for k in ('startrow', 'endrow', 'startcol', 'endcol', '参数', '缺少必需参数', 'required', 'missing')):
        return _USER_HINT_PARAM
    if any(k in lower for k in ('rule_type', 'ruletype', '条件格式规则')):
        return _USER_ERROR_LEARNING
    if '未知操作' in technical_msg:
        return _USER_ERROR_LEARNING
    if any(k in lower for k in ('参数规范化', 'normalize', 'camel', 'snake')):
        return _USER_ERROR_GENERIC
    if any(k in lower for k in ('超出', '范围', '不能为空', '必须是', '收到类型')):
        return _USER_ERROR_GENERIC
    if any(k in lower for k in ('缺少必需参数', 'required', 'missing')):
        return _USER_ERROR_GENERIC
    if any(k in lower for k in ('timeout', 'connection', 'network')):
        return _USER_ERROR_RETRY
    return _USER_ERROR_GENERIC


def _parse_a1_range(a1: str) -> Optional[Dict[str, int]]:
    text = str(a1 or "").strip()
    m = re.fullmatch(r"([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)", text)
    if not m:
        return None
    c1, r1, c2, r2 = m.groups()
    return {
        "startCol": _a1_col_to_num(c1),
        "startRow": int(r1),
        "endCol": _a1_col_to_num(c2),
        "endRow": int(r2),
    }


def _a1_col_to_num(col: str) -> int:
    num = 0
    for ch in col.upper():
        if "A" <= ch <= "Z":
            num = num * 26 + (ord(ch) - ord("A") + 1)
    return max(1, num)


def _a1_num_to_col(num: int) -> str:
    n = max(1, int(num))
    out = []
    while n > 0:
        n, rem = divmod(n - 1, 26)
        out.append(chr(ord("A") + rem))
    return "".join(reversed(out))


def _col_to_letter(col: int) -> str:
    """将列号（1-based）转换为 Excel 列字母"""
    if not isinstance(col, int) or col < 1:
        return "?"
    letters = []
    n = col
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters.append(chr(65 + rem))
    return "".join(reversed(letters))


@dataclass
class ExcelContext:
    """Excel 上下文信息"""
    sheets: List[Dict[str, Any]] = field(default_factory=list)
    active_sheet: str = "Sheet1"
    selection: Optional[Dict[str, Any]] = None
    data_summary: Optional[str] = None
    custom_formulas: List[Dict[str, Any]] = field(default_factory=list)
    # 上下文预算控制：避免多工作表场景 prompt 膨胀
    max_non_active_sheets: int = 4
    max_context_chars: int = 24000

    def _format_headers_lines(
        self, sheet: Dict[str, Any], truncate_cols: bool = False
    ) -> List[str]:
        """列标题行（headersWithCol 优先）。
        truncate_cols=True 时，非活动表列名超 10 列时截断并注明总列数，减少 token。
        """
        lines: List[str] = []
        headers = sheet.get("headers", [])
        headers_with_col = sheet.get("headersWithCol", [])
        _MAX_COLS_NON_ACTIVE = 10

        if headers_with_col:
            valid = [h for h in headers_with_col if h.get("name")]
            total_cols = len(valid)
            if truncate_cols and total_cols > _MAX_COLS_NON_ACTIVE:
                shown = valid[:_MAX_COLS_NON_ACTIVE]
                suffix = f"...（共 {total_cols} 列，仅展示前 {_MAX_COLS_NON_ACTIVE} 列）"
            else:
                shown = valid
                suffix = ""
            lines.append(
                "列名与列号（条件格式等必须使用此列号）: "
                + ", ".join(
                    f"{h.get('name', '')}({_col_to_letter(int(h.get('col', 0)))}列/第{h.get('col', 0)}列)"
                    for h in shown
                )
                + suffix
            )
        elif headers:
            total_cols = len(headers)
            if truncate_cols and total_cols > _MAX_COLS_NON_ACTIVE:
                shown = headers[:_MAX_COLS_NON_ACTIVE]
                suffix = f"...（共 {total_cols} 列）"
            else:
                shown = headers
                suffix = ""
            lines.append(f"列标题: {', '.join(str(h) for h in shown)}{suffix}")
        else:
            lines.append("列标题: （暂无表头行，可能为空表或未识别首行）")
        return lines

    def _format_sample_lines(
        self,
        sheet: Dict[str, Any],
        data_start_row: int,
        total_data_rows: int,
        max_rows: int,
    ) -> List[str]:
        """数据样本行：小表且样本含全部数据行时标为完整数据。"""
        lines: List[str] = []
        sample_data = sheet.get("sampleData", [])
        if not sample_data:
            if total_data_rows <= 0:
                lines.append("数据样本: （无数据行）")
            return lines

        full_in_window = (
            total_data_rows > 0
            and len(sample_data) >= total_data_rows
            and total_data_rows <= max_rows
        )
        if full_in_window:
            lines.append(f"**完整数据（共{total_data_rows}行数据）：**")
            row_slice = sample_data[:total_data_rows]
        else:
            row_slice = sample_data[:max_rows]
            lines.append(
                f"数据样本（前{len(row_slice)}行，共{total_data_rows}行数据）:"
            )
        for i, row in enumerate(row_slice, data_start_row):
            lines.append(f"  第{i}行: {row}")
        return lines

    def _format_sheet_block(self, sheet: Dict[str, Any], is_active: bool) -> List[str]:
        """单张工作表在上下文中的展示块（活动表详细，其它表紧凑）。"""
        sn = sheet.get("name", "Unknown")
        row_count = sheet.get("rowCount", 0)
        col_count = sheet.get("colCount", 0)
        header_row = sheet.get("headerRow", sheet.get("firstRow", 1))
        title_row = sheet.get("titleRow")
        last_row = sheet.get("lastRow", row_count)
        data_start_row = sheet.get("dataStartRow", header_row + 1)
        data_end_row = sheet.get("dataEndRow", last_row)
        total_data_rows = sheet.get("totalDataRows", 0)

        block: List[str] = []
        if is_active:
            block.append(f"=== 工作表「{sn}」（当前活动） ===")
            block.append(f"活动工作表尺寸: {row_count} 行 x {col_count} 列")
            block.append("**重要：行数范围信息**")
            if title_row is not None:
                block.append(f"  - 工作表标题行: 第{title_row}行（非数据，仅装饰标题，所有操作必须跳过此行）")
            block.append(f"  - 列标题行（表头）: 第{header_row}行")
            block.append(f"  - 最后一行: 第{last_row}行")
            block.append(f"  - 数据开始行: 第{data_start_row}行（表头之后）")
            block.append(f"  - 数据结束行: 第{data_end_row}行")
            block.append(f"  - 数据总行数: {total_data_rows}行")
            block.append(
                f"  - **如果要写入最后一行，应该使用第{last_row + 1}行（数据结束行+1）**"
            )
        else:
            block.append(f"=== 工作表「{sn}」（非当前活动） ===")
            title_hint = f"标题行: 第{title_row}行（跳过）；" if title_row is not None else ""
            block.append(
                f"尺寸: {row_count} 行 x {col_count} 列；{title_hint}表头行: 第{header_row}行；"
                f"数据区: 第{data_start_row}–{data_end_row}行；数据总行数: {total_data_rows}"
            )
            block.append(
                "用户若点名本表，工具参数 `sheet` 必须为上述工作表名，不得以活动表代替。"
            )

        block.extend(self._format_headers_lines(sheet, truncate_cols=(not is_active)))
        sample_max = 10 if is_active else 5
        block.extend(
            self._format_sample_lines(sheet, data_start_row, total_data_rows, sample_max)
        )
        return block

    def _format_sheet_block_compact(self, sheet: Dict[str, Any]) -> List[str]:
        """非活动表紧凑块：仅保留结构摘要，不包含数据样本。"""
        sn = sheet.get("name", "Unknown")
        row_count = sheet.get("rowCount", 0)
        col_count = sheet.get("colCount", 0)
        header_row = sheet.get("headerRow", sheet.get("firstRow", 1))
        title_row = sheet.get("titleRow")
        data_start_row = sheet.get("dataStartRow", header_row + 1)
        data_end_row = sheet.get("dataEndRow", sheet.get("lastRow", row_count))
        total_data_rows = sheet.get("totalDataRows", 0)
        title_hint = f"标题行: 第{title_row}行（跳过）；" if title_row is not None else ""
        block: List[str] = [
            f"=== 工作表「{sn}」（非当前活动） ===",
            (
                f"尺寸: {row_count} 行 x {col_count} 列；{title_hint}表头行: 第{header_row}行；"
                f"数据区: 第{data_start_row}–{data_end_row}行；数据总行数: {total_data_rows}"
            ),
            "用户若点名本表，工具参数 `sheet` 必须为上述工作表名，不得以活动表代替。",
        ]
        block.extend(self._format_headers_lines(sheet, truncate_cols=True))
        return block

    def to_context_string(self) -> str:
        """转换为上下文字符串"""
        parts = []
        
        if self.sheets:
            sheet_names = [s.get("name", "Unknown") for s in self.sheets]
            parts.append(f"可用工作表: {', '.join(sheet_names)}")
            parts.append(f"当前活动工作表: {self.active_sheet}")
            parts.append(
                "**多工作表**：以下按每张表分别列出列标题与样本；"
                "用户指令中若写明某表名，须以该表为准，不得以活动表推断其它表无数据。"
            )
            active_sheet_obj = next(
                (s for s in self.sheets if s.get("name") == self.active_sheet),
                self.sheets[0] if self.sheets else None,
            )
            if active_sheet_obj:
                parts.extend(self._format_sheet_block(active_sheet_obj, True))

            non_active = [s for s in self.sheets if s is not active_sheet_obj]
            capped_non_active = non_active[: max(0, int(self.max_non_active_sheets))]
            for sheet in capped_non_active:
                parts.extend(self._format_sheet_block_compact(sheet))
            omitted = len(non_active) - len(capped_non_active)
            if omitted > 0:
                parts.append(f"其余 {omitted} 张非活动工作表已省略详细信息（超出上下文预算）。")
        
        if self.selection:
            sel = self.selection
            parts.append(
                f"当前选中区域: 第{sel.get('startRow', 1)}行 第{sel.get('startCol', 1)}列 "
                f"到 第{sel.get('endRow', 1)}行 第{sel.get('endCol', 1)}列"
            )
        
        if self.data_summary:
            parts.append(f"数据摘要: {self.data_summary}")
        
        if self.custom_formulas:
            parts.append("\n**用户自定义公式列表（customFormulas）：**")
            for cf in self.custom_formulas:
                params_desc = ""
                if cf.get("params"):
                    param_items = [f'{p["name"]}={p["default"]}' for p in cf["params"]]
                    params_desc = f"  参数: {', '.join(param_items)}"
                parts.append(
                    f"  - {cf['label']}(name={cf['name']}): "
                    f"expression=\"{cf['expression']}\" {params_desc}"
                )
        
        ctx = "\n".join(parts)
        budget = max(2000, int(self.max_context_chars))
        if len(ctx) > budget:
            omitted_chars = len(ctx) - budget
            ctx = (
                ctx[:budget]
                + f"\n\n[上下文已按预算截断，省略约 {omitted_chars} 个字符。若需更多细节，请在指令中点名具体工作表。]"
            )
        return ctx


class ExcelAgent:
    """Excel AI Agent 类"""
    
    # =====================================================================
    #  SYSTEM_PROMPT_CORE: 精简核心层（每次请求必注入）
    #  意图相关规则已迁移至 prompt_rules.py，按需动态注入到 full_prompt
    # =====================================================================

    SYSTEM_PROMPT = """你是专业 Excel 助手。只处理电子表格操作，拒绝其他话题。

<constraints>
- 所有输出使用简体中文，禁止英文句子
- 禁止执行系统命令、访问文件系统、网络操作、代码执行
- 工具调用仅允许 mcp__excel-tools__*（及必要的 AskUserQuestion）；禁止调用 TodoWrite/Task/切模式等元工具
- 行列索引从 1 开始（A=1, B=2）；颜色用十六进制（#FF0000）
- 公式必须以 = 开头，使用标准 Excel 语法
- 多个操作优先 batch_operations 一次提交
- 用户用引号包裹的列名/表名，去掉引号后与上下文列标题逐字匹配
- 上下文按工作表分段列出列标题与样本；用户点名某表时以该表段落为准
- 创建工作簿/工作薄 = 创建新工作表并填充数据（add_sheet + set_range_values）
</constraints>

<data_protection>
1. 分析/统计/汇总结果必须写入新工作表，禁止覆盖源数据
2. outputRow 必须在数据 endRow 之后
3. 格式/排序/筛选等原地操作除外；用户明确要求修改时除外
4. 写数据前自问：目标区域是否已有用户数据？
</data_protection>

<output_protocol>
工具调用前，输出执行计划：
  我将执行以下操作：
  - [步骤1]: [工具名] [关键参数摘要]
  - [步骤2]: [工具名] [关键参数摘要]

工具调用后，输出结果摘要（含操作位置/范围/效果）。
错误时用非技术语言描述原因和建议，禁止暴露参数名/类型/状态码。
不确定时说"该功能还在学习中"，禁止猜测执行。
</output_protocol>

<honesty>
- 工具返回 ERROR 后禁止声称"已完成"
- 禁止插入辅助列（前端不执行公式，辅助列值始终为空）
- 禁止构造不在支持列表中的 rule_type / chart_type / 操作类型
- 禁止规划无法填充数据的列（源数据无对应字段则不要包含）
- 禁止承诺后续操作（会话关闭后无法兑现）
- 多步操作部分失败时，明确标出哪些成功、哪些失败
- 条件格式仅限: greaterThan/lessThan/between/equal/text/containsText/notContainsText/beginsWith/endsWith/top10/bottom10/aboveAverage/duplicate/uniqueValues/colorScale
- 图表仅限: column/line/pie/bar/area/scatter/doughnut
- 超出上述范围走诚实回退
</honesty>

<execution_principle>
你只有一次执行机会，会话结束后无法重试。
- 先完成全部规划，再调用第一个工具
- 执行中发现问题：完成已开始的操作，在总结中如实说明
- 一键生表场景：禁止追问，自行补全细节直接执行
</execution_principle>

<custom_formula>
上下文 customFormulas 字段列出用户公式。用户说"用XX公式计算"时：
- 从 customFormulas 查找匹配名（name/label）
- 调用 apply_custom_formula，传入 expression 和默认参数
- 列字母自动解析为同行对应列的值，value 代表目标列当前值
</custom_formula>

<analysis_protocol>
## 最高优先级：分析/出图任务必须且只能调用 submit_analysis_plan

触发词：分析、智能分析、自动分析、综合分析、数据分析、出图、生成图表、汇总并出图
匹配到以上任意关键词时，你只需要调用一次 submit_analysis_plan 工具，不要调用其他工具。

禁止行为（违反则整批操作作废）：
- 禁止手动调用 add_sheet
- 禁止手动调用 summarize_metrics_by_column / summarize_by_column
- 禁止手动调用 create_chart
- 禁止手动调用 set_cell_value 写分析标题
- 以上操作全部由 submit_analysis_plan 的编译器自动生成

调用方法：
1. 审视上下文列标题，选 1-3 个有业务价值的分组维度
2. 分组列：业务分类（产品名称/渠道/区域/类型），禁选 ID/编号/编码
3. 指标列：数值列（金额/数量/单价），禁选文本列
4. 一次调用：submit_analysis_plan(plan=JSON)
5. 编译器自动处理全部排版/图表/关键发现
</analysis_protocol>

<few_shot_examples>
示例1 -- 智能分析并出图:
用户: "智能分析当前数据，自动生成图表并总结关键发现"
计划: 调用 submit_analysis_plan(plan='{"blocks":[{"source_sheet":"销售数据","group_by_col":"产品名称","metric_col":"总金额","aggregation":"sum","chart_type":"auto"},{"source_sheet":"销售数据","group_by_col":"渠道","metric_col":"总金额","aggregation":"sum","chart_type":"auto"}],"include_insights":true}')

示例2 -- 美化表格:
用户: "美化表格"
计划:
- batch_operations: [set_range_style(表头: bold+#217346+白色), set_range_style(数据区: 交替行背景+细框线), auto_fit_column(全列)]

示例3 -- 查询类:
用户: "有几类产品？"
计划: 调用 query_unique_values(col=产品列, start_row=dataStartRow, end_row=dataEndRow)
回答: "共有 N 类产品" + 列出各类频次
</few_shot_examples>"""

    def __init__(self, session_id: str = 'default'):
        """初始化 Agent"""
        self.session_id = session_id
        self.client: Optional[ClaudeSDKClient] = None
        self.context = ExcelContext()
        # 上下文预算可通过环境变量调节
        self.context.max_non_active_sheets = int(os.getenv("AGENT_CONTEXT_MAX_NON_ACTIVE_SHEETS", "4"))
        self.context.max_context_chars = int(os.getenv("AGENT_CONTEXT_MAX_CHARS", "24000"))
        self._operations_buffer: List[Dict[str, Any]] = []
        self._message_callback: Optional[Callable] = None
        self.log = AgentLogger(session_id)
        self._close_lock = asyncio.Lock()
        self._closed = False
        self._inflight = 0
        self._last_active_ts = time.monotonic()
        self._per_request_close = os.getenv("AGENT_PER_REQUEST_CLOSE", "true").lower() == "true"
        self._awaiting_followup = False
        self._last_question: Optional[str] = None
        self._last_user_request: Optional[str] = None
        self._last_context_snapshot: Optional[str] = None
        self._is_followup_execution = False  # 标记当前是否为补充信息后的执行
        self._active_auto_analysis_request = False
        self._query_readonly_mode = False
        self._client_query_mode: Optional[bool] = None
        self._query_readonly_aborted = False
        
    async def initialize(self):
        """初始化 Claude SDK Client"""
        # 允许复用实例时重新初始化
        self._closed = False
        self.log.set_llm_model_for_log(describe_llm_model_for_log(None))
        self.log.agent_init_start()
        
        try:
            api_key = os.getenv("ANTHROPIC_API_KEY")
            auth_token = os.getenv("ANTHROPIC_AUTH_TOKEN")
            credential = api_key or auth_token
            if not credential:
                raise ValueError("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 环境变量未设置")
            # Claude Agent SDK/CLI 默认读取 ANTHROPIC_API_KEY，这里做兼容映射。
            if not api_key and auth_token:
                os.environ["ANTHROPIC_API_KEY"] = auth_token
                api_key = auth_token
            
            self.log.logger.debug(self.log.fmt(f'API Key 已配置 (长度: {len(api_key)})'))
            
            # ========================================================================
            # 安全配置：三重防护禁用危险工具
            # ========================================================================
            # 1. 白名单：只允许 Excel 工具
            # 2. 黑名单：明确禁止所有危险的系统工具
            # 3. SYSTEM_PROMPT：明确告知 AI 安全边界
            # ========================================================================
            DANGEROUS_TOOLS = [
                "Bash", "BashOutput", "KillBash",  # Shell 命令执行
                "Write", "Edit", "Read",            # 文件系统操作
                "Glob", "Grep",                     # 文件搜索
                "WebFetch", "WebSearch",            # 网络访问
                "NotebookEdit",                     # Jupyter 操作
                "Task",                             # 子代理任务
            ]
            
            allowed_tool_names = _READONLY_QUERY_TOOL_NAMES if self._query_readonly_mode else EXCEL_TOOL_NAMES
            options = ClaudeAgentOptions(
                system_prompt=self.SYSTEM_PROMPT,
                mcp_servers={"excel-tools": excel_tools_server},
                allowed_tools=allowed_tool_names,     # 查询模式下收敛为只读工具白名单
                disallowed_tools=DANGEROUS_TOOLS,     # 黑名单：明确禁止危险工具
                permission_mode="acceptEdits",
                max_turns=20,
                model=settings.ANTHROPIC_EFFECTIVE_MODEL or None,
            )
            self.log.set_llm_model_for_log(describe_llm_model_for_log(options))
            
            self.client = ClaudeSDKClient(options=options)
            await self.client.__aenter__()
            self._client_query_mode = self._query_readonly_mode
            if self._query_readonly_mode:
                self.log.logger.info(
                    self.log.fmt(
                        f"查询只读模式初始化：allowed_tools={','.join(_READONLY_QUERY_TOOL_NAMES)}"
                    )
                )
            
            self.log.agent_init_success()
            
        except ValueError as e:
            self.log.agent_init_failed(str(e))
            raise Exception(f"配置错误: {str(e)}") from e
            
        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            self.log.agent_init_failed(str(e), error_details)
            raise Exception(f"Agent 启动失败: {str(e)}") from e
        
    async def close(self):
        """关闭 Agent"""
        async with self._close_lock:
            if self._closed:
                return
            self._closed = True
            if self.client:
                try:
                    # 先尝试正常关闭
                    await self.client.__aexit__(None, None, None)
                    self.log.logger.info(self.log.fmt('✅ Agent 正常关闭'))
                except Exception as e:
                    self.log.logger.warning(self.log.fmt(f'关闭 Agent 失败: {e}'))
                    # 如果正常关闭失败，尝试调用 disconnect
                    try:
                        if hasattr(self.client, 'disconnect'):
                            await self.client.disconnect()
                            self.log.logger.info(self.log.fmt('✅ 通过 disconnect 关闭 Agent'))
                    except Exception as e2:
                        self.log.logger.warning(self.log.fmt(f'disconnect 也失败: {e2}'))
                finally:
                    self.client = None
            self.log.agent_close()


    def touch(self):
        """刷新活跃时间"""
        self._last_active_ts = time.monotonic()

    def is_idle(self, now_ts: float, idle_ttl_sec: int) -> bool:
        """是否空闲超时"""
        if self._inflight > 0:
            return False
        return (now_ts - self._last_active_ts) > idle_ttl_sec
    
    def update_context(self, excel_state: Dict[str, Any]):
        """更新 Excel 上下文"""
        self.context.sheets = excel_state.get("sheets", [])
        self.context.active_sheet = excel_state.get("activeSheet", "Sheet1")
        self.context.selection = excel_state.get("selection")
        self.context.data_summary = excel_state.get("dataSummary")
        self.context.custom_formulas = excel_state.get("customFormulas", [])
    
    def set_message_callback(self, callback: Callable):
        """设置消息回调函数"""
        self._message_callback = callback

    def _is_one_click_sheet_command(self, command: str) -> bool:
        text = str(command or "")
        return ("一键生表" in text) or ("完整表结构" in text and "示例数据" in text)

    def _get_active_sheet_meta(self) -> Optional[Dict[str, Any]]:
        for sheet in self.context.sheets:
            if isinstance(sheet, dict) and sheet.get("name") == self.context.active_sheet:
                return sheet
        if self.context.sheets and isinstance(self.context.sheets[0], dict):
            return self.context.sheets[0]
        return None

    def _extract_headers_with_col(self, sheet_meta: Dict[str, Any]) -> List[Dict[str, Any]]:
        hwc = sheet_meta.get("headersWithCol") or []
        out: List[Dict[str, Any]] = []
        for h in hwc:
            if not isinstance(h, dict):
                continue
            name = str(h.get("name") or "").strip()
            col = h.get("col")
            if not name:
                continue
            try:
                col_num = int(col)
            except (TypeError, ValueError):
                continue
            if col_num < 1:
                continue
            out.append({"name": name, "col": col_num})
        if out:
            return out
        # 兼容 headers 为字符串数组
        hs = sheet_meta.get("headers") or []
        for idx, item in enumerate(hs, start=1):
            # 兼容 headers 为对象数组：[{col, value}] / [{name, col}]
            if isinstance(item, dict):
                name = item.get("name")
                if not name:
                    name = item.get("value")
                col = item.get("col", idx)
                n = str(name or "").strip()
                try:
                    c = int(col)
                except (TypeError, ValueError):
                    c = idx
                if n and c >= 1:
                    out.append({"name": n, "col": c})
                continue
            n = str(item or "").strip()
            if n:
                out.append({"name": n, "col": idx})
        return out

    @staticmethod
    def _to_number(val: Any) -> Optional[float]:
        if isinstance(val, (int, float)):
            return float(val)
        s = str(val or "").strip().replace(",", "")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None

    @staticmethod
    def _format_number(val: float) -> str:
        if abs(val - int(val)) < 1e-9:
            return str(int(val))
        return f"{val:.2f}"

    @staticmethod
    def _is_group_semantic(name: str) -> bool:
        n = str(name or "").lower()
        return any(
            k in n
            for k in ("人员", "姓名", "员工", "销售", "客户", "用户", "渠道", "区域", "类别", "品类", "部门", "产品", "name")
        )

    @staticmethod
    def _is_id_semantic(name: str) -> bool:
        n = str(name or "").lower()
        return bool(re.search(r"(id|编号|编码|代码|序号|no|num|sku)$|^(id|编号|编码|代码|序号|sku)$", n))

    @staticmethod
    def _is_metric_semantic(name: str) -> bool:
        n = str(name or "").lower()
        return any(k in n for k in ("数量", "金额", "收入", "销量", "值", "score", "count", "sum", "total", "avg"))

    def _infer_numeric_cols_from_sample(
        self, sheet_meta: Dict[str, Any], headers_with_col: List[Dict[str, Any]]
    ) -> set[int]:
        """
        数据驱动列类型推断：
        使用 sampleData 估计每列数值密度，避免依赖行业关键词。
        """
        samples = sheet_meta.get("sampleData") or []
        if not isinstance(samples, list) or not samples:
            return set()
        numeric_cols: set[int] = set()
        for h in headers_with_col:
            col = int(h["col"])
            numeric = 0
            total = 0
            for row in samples:
                val = None
                if isinstance(row, list):
                    idx = col - 1
                    if 0 <= idx < len(row):
                        val = row[idx]
                elif isinstance(row, dict):
                    val = row.get(h["name"])
                    if val is None:
                        val = row.get(str(col))
                if val is None or str(val).strip() == "":
                    continue
                total += 1
                if self._to_number(val) is not None:
                    numeric += 1
            if total > 0 and (numeric / total) >= 0.6:
                numeric_cols.add(col)
        return numeric_cols

    @staticmethod
    def _is_date_semantic(name: str) -> bool:
        n = str(name or "").lower()
        return any(k in n for k in ("日期", "时间", "年月", "月份", "date", "month", "day"))

    @staticmethod
    def _parse_datetime_value(val: Any) -> Optional[datetime]:
        if val is None:
            return None
        if isinstance(val, datetime):
            return val
        s = str(val).strip()
        if not s:
            return None
        # 优先 YYYY-MM-DD / YYYY/MM/DD / YYYY-MM / YYYY/MM
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m", "%Y/%m", "%Y.%m.%d", "%Y.%m"):
            try:
                dt = datetime.strptime(s, fmt)
                if fmt in ("%Y-%m", "%Y/%m", "%Y.%m"):
                    dt = dt.replace(day=1)
                return dt
            except ValueError:
                continue
        # 容错提取
        m = re.search(r"(20\d{2}|19\d{2})[-/.年](\d{1,2})", s)
        if m:
            try:
                return datetime(int(m.group(1)), int(m.group(2)), 1)
            except ValueError:
                return None
        return None

    @staticmethod
    def _extract_metric_threshold(text: str) -> Optional[Dict[str, Any]]:
        """
        提取行级数值过滤条件（作用于指标列原始值）。
        示例：数量大于10 / 金额>=1000 / 小于 5
        """
        t = str(text or "")
        patterns = [
            (r"(不少于|不低于|至少|>=)\s*([0-9]+(?:\.[0-9]+)?)", ">="),
            (r"(不大于|不高于|至多|<=)\s*([0-9]+(?:\.[0-9]+)?)", "<="),
            (r"(大于|高于|超过|>)\s*([0-9]+(?:\.[0-9]+)?)", ">"),
            (r"(小于|低于|少于|<)\s*([0-9]+(?:\.[0-9]+)?)", "<"),
            (r"(等于|=|==)\s*([0-9]+(?:\.[0-9]+)?)", "=="),
        ]
        for pat, op in patterns:
            m = re.search(pat, t)
            if not m:
                continue
            try:
                val = float(m.group(2))
            except (TypeError, ValueError):
                continue
            return {"op": op, "value": val}
        return None

    @staticmethod
    def _parse_natural_number_token(token: str) -> Optional[int]:
        """
        将自然数 token 解析为 int：
        - 阿拉伯数字：150 / 1,500
        - 中文数字：十、二十、一百五十、两百、三千零二、两万三千
        """
        raw = str(token or "").strip()
        if not raw:
            return None

        arabic = raw.replace(",", "").replace("，", "")
        if re.fullmatch(r"\d+", arabic):
            try:
                return int(arabic)
            except (TypeError, ValueError):
                return None

        s = raw.replace("零", "〇")
        digit_map = {
            "〇": 0,
            "一": 1,
            "二": 2,
            "两": 2,
            "三": 3,
            "四": 4,
            "五": 5,
            "六": 6,
            "七": 7,
            "八": 8,
            "九": 9,
        }
        unit_map = {"十": 10, "百": 100, "千": 1000, "万": 10000}

        total = 0
        section = 0
        number = 0
        has_valid_char = False
        for ch in s:
            if ch in digit_map:
                number = digit_map[ch]
                has_valid_char = True
                continue
            if ch in unit_map:
                has_valid_char = True
                unit = unit_map[ch]
                if unit == 10000:
                    section += number
                    if section == 0:
                        section = 1
                    total += section * unit
                    section = 0
                    number = 0
                    continue
                if number == 0:
                    number = 1
                section += number * unit
                number = 0
                continue
            return None

        if not has_valid_char:
            return None
        return total + section + number

    @staticmethod
    def _extract_rank_positions(text: str) -> List[int]:
        """
        解析查询中的“位次”诉求，返回 1-based 排名位次列表。
        支持：
        - 第2/第3/第10
        - 第二/第三/第十
        - 第二与第三 / 第2和第3 / 第2到第4 / 第2-4
        """
        s = str(text or "")
        if not s:
            return []

        positions: List[int] = []
        rank_token_re = r"([0-9][0-9,，]*|[〇零一二两三四五六七八九十百千万]{1,12})"
        for m in re.finditer(rf"第\s*{rank_token_re}", s):
            val = ExcelAgent._parse_natural_number_token(m.group(1))
            if isinstance(val, int) and val >= 1:
                positions.append(val)

        # 区间表达：第2到第4 / 第2-4 / 第二到第四 / 第一百到第一百五十
        range_match = re.search(
            rf"第\s*{rank_token_re}\s*(?:到|至|-|~)\s*第?\s*{rank_token_re}",
            s,
        )
        if range_match:
            left = ExcelAgent._parse_natural_number_token(range_match.group(1))
            right = ExcelAgent._parse_natural_number_token(range_match.group(2))
            if isinstance(left, int) and isinstance(right, int):
                lo, hi = (left, right) if left <= right else (right, left)
                positions.extend(list(range(lo, hi + 1)))

        uniq_positions = sorted(set([p for p in positions if p >= 1]))
        return uniq_positions

    def _resolve_query_columns(
        self,
        command: str,
        headers_with_col: List[Dict[str, Any]],
        sheet_meta: Optional[Dict[str, Any]] = None,
        preferred_group_hint: Optional[str] = None,
        preferred_metric_hint: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        text = str(command or "").strip()
        if not text:
            return None
        numeric_cols = self._infer_numeric_cols_from_sample(sheet_meta or {}, headers_with_col)
        non_numeric_cols = {int(h["col"]) for h in headers_with_col if int(h["col"]) not in numeric_cols}

        # group 列优先：LLM 显式 hint > 命令点名 > 语义维度 > 首个非数值非ID列
        group_col = None
        if isinstance(preferred_group_hint, str) and preferred_group_hint.strip():
            g_hint = preferred_group_hint.strip()
            group_col = next(
                (
                    h
                    for h in headers_with_col
                    if str(h.get("name", "")).strip() == g_hint and not self._is_id_semantic(str(h.get("name", "")))
                ),
                None,
            )
        for h in headers_with_col:
            if group_col:
                break
            col = int(h["col"])
            if h["name"] in text and col in non_numeric_cols and not self._is_id_semantic(h["name"]):
                group_col = h
                break
        if not group_col:
            for h in headers_with_col:
                col = int(h["col"])
                if col in non_numeric_cols and self._is_group_semantic(h["name"]) and not self._is_id_semantic(h["name"]):
                    group_col = h
                    break
        if not group_col:
            for h in headers_with_col:
                col = int(h["col"])
                if col in non_numeric_cols and not self._is_id_semantic(h["name"]):
                    group_col = h
                    break
        if not group_col:
            return None

        # metric 列优先：LLM 显式 hint > 命令点名数值列 > 语义数值列 > 任一数值列
        metric_col = None
        if isinstance(preferred_metric_hint, str) and preferred_metric_hint.strip():
            m_hint = preferred_metric_hint.strip()
            metric_col = next(
                (
                    h
                    for h in headers_with_col
                    if str(h.get("name", "")).strip() == m_hint and h["col"] != group_col["col"]
                ),
                None,
            )
        for h in headers_with_col:
            if metric_col:
                break
            if h["col"] == group_col["col"]:
                continue
            col = int(h["col"])
            if h["name"] in text and col in numeric_cols:
                metric_col = h
                break
        if not metric_col:
            for h in headers_with_col:
                if h["col"] == group_col["col"]:
                    continue
                col = int(h["col"])
                if col in numeric_cols and self._is_metric_semantic(h["name"]):
                    metric_col = h
                    break
        if not metric_col:
            # 兜底1：语义指标列（即便 sampleData 暂未识别为数值）
            for h in headers_with_col:
                if h["col"] == group_col["col"]:
                    continue
                if self._is_metric_semantic(h["name"]) and not self._is_id_semantic(h["name"]):
                    metric_col = h
                    break
        if not metric_col:
            for h in headers_with_col:
                if h["col"] == group_col["col"]:
                    continue
                col = int(h["col"])
                if col in numeric_cols:
                    metric_col = h
                    break
        if not metric_col:
            # 兜底2：任一非 group 非 ID 列（最终保底，不因表头格式差异直接失效）
            for h in headers_with_col:
                if h["col"] == group_col["col"]:
                    continue
                if not self._is_id_semantic(h["name"]):
                    metric_col = h
                    break
        if not metric_col:
            return None

        mode = "max"
        if re.search(r"(最低|最少|最小)", text):
            mode = "min"
        topn = 1
        topn_match = re.search(
            r"(?:前|top)\s*第?\s*([0-9][0-9,，]*|[〇零一二两三四五六七八九十百千万]{1,12})",
            text,
            re.IGNORECASE,
        )
        if topn_match:
            parsed_topn = self._parse_natural_number_token(topn_match.group(1))
            if isinstance(parsed_topn, int):
                topn = max(1, parsed_topn)
        return {"group": group_col, "metric": metric_col, "mode": mode, "topn": topn}

    async def _scan_group_metric_totals(
        self,
        bridge: Any,
        sheet_name: str,
        start_row: int,
        end_row: int,
        group_col: int,
        metric_col: int,
        filter_equals: Optional[Dict[int, str]] = None,
        metric_threshold: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, float]]:
        filter_equals = filter_equals or {}
        cols = sorted(set([group_col, metric_col, *filter_equals.keys()]))
        left_col, right_col = cols[0], cols[-1]
        col_index = {c: c - left_col for c in cols}
        totals: Dict[str, float] = {}
        chunk = 500
        for rs in range(start_row, end_row + 1, chunk):
            re_row = min(end_row, rs + chunk - 1)
            result = await bridge.query_frontend({
                "type": "read_range_values",
                "params": {
                    "sheet": sheet_name,
                    "startRow": rs,
                    "startCol": left_col,
                    "endRow": re_row,
                    "endCol": right_col,
                },
            })
            if result.get("error"):
                return None
            rows = result.get("values") or []
            for row in rows:
                if not isinstance(row, list) or len(row) < (right_col - left_col + 1):
                    continue
                # 多条件过滤：仅保留满足所有等值条件的行
                matched = True
                for f_col, f_val in filter_equals.items():
                    idx = col_index.get(f_col, -1)
                    if idx < 0 or idx >= len(row):
                        matched = False
                        break
                    if str(row[idx] or "").strip() != str(f_val).strip():
                        matched = False
                        break
                if not matched:
                    continue

                g_idx = col_index.get(group_col, -1)
                m_idx = col_index.get(metric_col, -1)
                if g_idx < 0 or m_idx < 0 or g_idx >= len(row) or m_idx >= len(row):
                    continue
                gval = row[g_idx]
                mval = row[m_idx]
                key = str(gval or "").strip()
                num = self._to_number(mval)
                if not key or num is None:
                    continue
                # 指标阈值过滤（行级）
                if metric_threshold:
                    op = str(metric_threshold.get("op"))
                    rhs = float(metric_threshold.get("value", 0))
                    if op == ">" and not (num > rhs):
                        continue
                    if op == ">=" and not (num >= rhs):
                        continue
                    if op == "<" and not (num < rhs):
                        continue
                    if op == "<=" and not (num <= rhs):
                        continue
                    if op == "==" and not (abs(num - rhs) < 1e-9):
                        continue
                totals[key] = totals.get(key, 0.0) + num
        return totals

    async def _extract_query_filters(
        self,
        bridge: Any,
        sheet_name: str,
        start_row: int,
        end_row: int,
        headers_with_col: List[Dict[str, Any]],
        sheet_meta: Dict[str, Any],
        text: str,
        exclude_cols: Optional[set] = None,
    ) -> Dict[int, str]:
        """
        从查询语句中提取“多条件等值过滤”。
        策略：对候选维度列拉取唯一值，命令中若出现该值则作为过滤条件。
        """
        exclude = exclude_cols or set()
        filters: Dict[int, str] = {}
        numeric_cols = self._infer_numeric_cols_from_sample(sheet_meta, headers_with_col)
        candidates = [
            h
            for h in headers_with_col
            if int(h.get("col", 0)) not in exclude
            and int(h.get("col", 0)) not in numeric_cols
            and not self._is_id_semantic(str(h.get("name", "")))
        ][:8]
        for h in candidates:
            col = int(h["col"])
            uniq = await self._query_unique_for_column(bridge, sheet_name, start_row, end_row, col)
            if not uniq or not isinstance(uniq.get("items"), list):
                continue
            # 优先匹配更长值，降低“华”误命中“华东”
            items = uniq["items"]
            values = sorted(
                [str(it.get("value", "")).strip() for it in items if isinstance(it, dict)],
                key=len,
                reverse=True,
            )
            matched = next((v for v in values if len(v) >= 2 and v in text), None)
            if matched:
                filters[col] = matched
        return filters

    @staticmethod
    def _pick_target_from_text(candidates: List[str], text: str) -> Optional[str]:
        ordered = sorted([c for c in candidates if c], key=len, reverse=True)
        return next((name for name in ordered if name in text), None)

    async def _scan_period_metric_totals(
        self,
        bridge: Any,
        sheet_name: str,
        start_row: int,
        end_row: int,
        date_col: int,
        metric_col: int,
        filter_equals: Optional[Dict[int, str]] = None,
    ) -> Optional[Dict[str, float]]:
        filter_equals = filter_equals or {}
        cols = sorted(set([date_col, metric_col, *filter_equals.keys()]))
        left_col, right_col = cols[0], cols[-1]
        col_index = {c: c - left_col for c in cols}
        period_totals: Dict[str, float] = {}
        chunk = 500
        for rs in range(start_row, end_row + 1, chunk):
            re_row = min(end_row, rs + chunk - 1)
            result = await bridge.query_frontend({
                "type": "read_range_values",
                "params": {
                    "sheet": sheet_name,
                    "startRow": rs,
                    "startCol": left_col,
                    "endRow": re_row,
                    "endCol": right_col,
                },
            })
            if result.get("error"):
                return None
            rows = result.get("values") or []
            for row in rows:
                if not isinstance(row, list) or len(row) < (right_col - left_col + 1):
                    continue
                matched = True
                for f_col, f_val in filter_equals.items():
                    idx = col_index.get(f_col, -1)
                    if idx < 0 or idx >= len(row):
                        matched = False
                        break
                    if str(row[idx] or "").strip() != str(f_val).strip():
                        matched = False
                        break
                if not matched:
                    continue
                d_idx = col_index.get(date_col, -1)
                m_idx = col_index.get(metric_col, -1)
                if d_idx < 0 or m_idx < 0 or d_idx >= len(row) or m_idx >= len(row):
                    continue
                dt = self._parse_datetime_value(row[d_idx])
                num = self._to_number(row[m_idx])
                if dt is None or num is None:
                    continue
                p = f"{dt.year:04d}-{dt.month:02d}"
                period_totals[p] = period_totals.get(p, 0.0) + num
        return period_totals

    async def _scan_metric_values_with_filters(
        self,
        bridge: Any,
        sheet_name: str,
        start_row: int,
        end_row: int,
        metric_col: int,
        filter_equals: Optional[Dict[int, str]] = None,
    ) -> Optional[List[float]]:
        filter_equals = filter_equals or {}
        cols = sorted(set([metric_col, *filter_equals.keys()]))
        left_col, right_col = cols[0], cols[-1]
        col_index = {c: c - left_col for c in cols}
        values: List[float] = []
        chunk = 500
        for rs in range(start_row, end_row + 1, chunk):
            re_row = min(end_row, rs + chunk - 1)
            result = await bridge.query_frontend({
                "type": "read_range_values",
                "params": {
                    "sheet": sheet_name,
                    "startRow": rs,
                    "startCol": left_col,
                    "endRow": re_row,
                    "endCol": right_col,
                },
            })
            if result.get("error"):
                return None
            rows = result.get("values") or []
            for row in rows:
                if not isinstance(row, list) or len(row) < (right_col - left_col + 1):
                    continue
                matched = True
                for f_col, f_val in filter_equals.items():
                    idx = col_index.get(f_col, -1)
                    if idx < 0 or idx >= len(row):
                        matched = False
                        break
                    if str(row[idx] or "").strip() != str(f_val).strip():
                        matched = False
                        break
                if not matched:
                    continue
                m_idx = col_index.get(metric_col, -1)
                if m_idx < 0 or m_idx >= len(row):
                    continue
                num = self._to_number(row[m_idx])
                if num is None:
                    continue
                values.append(num)
        return values

    @staticmethod
    def _calc_window_change(period_totals: Dict[str, float], mode: str) -> Optional[Dict[str, Any]]:
        if not period_totals:
            return None
        periods = sorted(period_totals.keys())
        latest = periods[-1]
        latest_val = period_totals[latest]
        y, m = latest.split("-")
        y_int, m_int = int(y), int(m)
        baseline = None
        if mode == "mom":
            by, bm = (y_int - 1, 12) if m_int == 1 else (y_int, m_int - 1)
            baseline = f"{by:04d}-{bm:02d}"
        elif mode == "yoy":
            baseline = f"{y_int - 1:04d}-{m_int:02d}"
        if not baseline or baseline not in period_totals:
            return None
        base_val = period_totals[baseline]
        diff = latest_val - base_val
        ratio = None if abs(base_val) < 1e-9 else (diff / base_val * 100.0)
        return {
            "latest_period": latest,
            "latest_value": latest_val,
            "baseline_period": baseline,
            "baseline_value": base_val,
            "diff": diff,
            "ratio": ratio,
        }

    async def _query_unique_for_column(
        self,
        bridge: Any,
        sheet_name: str,
        start_row: int,
        end_row: int,
        col: int,
    ) -> Optional[Dict[str, Any]]:
        result = await bridge.query_frontend({
            "type": "query_unique_values",
            "params": {
                "sheet": sheet_name,
                "column": col,
                "startRow": start_row,
                "endRow": end_row,
            },
        })
        if result.get("error"):
            return None
        return result

    async def _try_answer_query_deterministically(self, command: str) -> Optional[str]:
        """
        查询模式确定性求解器：
        命中以下高频意图时，直接走只读桥接计算，不依赖 LLM 自由规划：
        1) 谁/哪位 + 最高/最低（含前N）
        2) 指定主体（如某销售）累计值查询
        3) 多少类/多少位（去重计数）
        4) 总和/平均/最大/最小（单列聚合）
        """
        text = str(command or "").strip()
        if not text:
            return None

        sheet_meta = self._get_active_sheet_meta()
        if not sheet_meta:
            return None
        headers_with_col = self._extract_headers_with_col(sheet_meta)

        bridge = get_current_bridge()
        if not bridge:
            return None

        sheet_name = str(sheet_meta.get("name") or self.context.active_sheet)
        start_row = int(sheet_meta.get("dataStartRow") or (sheet_meta.get("headerRow") or 1) + 1)
        end_row = int(sheet_meta.get("dataEndRow") or sheet_meta.get("lastRow") or start_row)
        if end_row < start_row:
            return None

        col_plan = self._resolve_query_columns(text, headers_with_col, sheet_meta)
        metric_threshold = self._extract_metric_threshold(text)
        llm_slots = await infer_query_semantics_with_llm(text, headers_with_col)
        preferred_group_hint = llm_slots.get("group_by_hint")
        preferred_metric_hint = llm_slots.get("metric_hint")
        if preferred_group_hint or preferred_metric_hint:
            hinted_plan = self._resolve_query_columns(
                text,
                headers_with_col,
                sheet_meta,
                preferred_group_hint=preferred_group_hint,
                preferred_metric_hint=preferred_metric_hint,
            )
            if hinted_plan:
                col_plan = hinted_plan
        rank_positions = llm_slots.get("rank_positions") or self._extract_rank_positions(text)
        llm_top_n = llm_slots.get("top_n")
        llm_sort_order = llm_slots.get("sort_order")
        llm_query_mode = str(llm_slots.get("query_mode") or "unknown")
        llm_need_ratio = bool(llm_slots.get("need_ratio"))
        llm_aggregate_op = llm_slots.get("aggregate_op")
        llm_trend_mode = llm_slots.get("trend_mode")
        llm_target_entity = llm_slots.get("target_entity")
        self.log.logger.info(
            self.log.fmt(
                "查询语义槽位: "
                f"query_mode={llm_query_mode}, sort_order={llm_sort_order}, top_n={llm_top_n}, "
                f"rank_positions={rank_positions or []}, group_hint={preferred_group_hint}, metric_hint={preferred_metric_hint}"
            )
        )
        has_explicit_rank_signal = bool(
            re.search(
                r"(排名|名次|第\s*([0-9][0-9,，]*|[〇零一二两三四五六七八九十百千万]{1,12})\s*名?)",
                text,
                re.IGNORECASE,
            )
        )
        if not has_explicit_rank_signal:
            rank_positions = []
        if col_plan and llm_sort_order in {"asc", "desc"}:
            col_plan["mode"] = "min" if llm_sort_order == "asc" else "max"

        # 分支0：同比/环比（按月窗口比较）
        trend_mode = None
        if llm_trend_mode in {"mom", "yoy"}:
            trend_mode = llm_trend_mode
        elif re.search(r"环比", text):
            trend_mode = "mom"
        elif re.search(r"同比", text):
            trend_mode = "yoy"

        if trend_mode:
            metric_col = None
            if col_plan:
                metric_col = col_plan.get("metric")
            if not metric_col:
                metric_col = next((h for h in headers_with_col if self._is_metric_semantic(h["name"])), None)
            date_col = next((h for h in headers_with_col if self._is_date_semantic(h["name"])), None)
            if metric_col and date_col:
                filters = await self._extract_query_filters(
                    bridge,
                    sheet_name,
                    start_row,
                    end_row,
                    headers_with_col,
                    sheet_meta,
                    text,
                    exclude_cols={int(metric_col["col"]), int(date_col["col"])},
                )
                period_totals = await self._scan_period_metric_totals(
                    bridge,
                    sheet_name,
                    start_row,
                    end_row,
                    int(date_col["col"]),
                    int(metric_col["col"]),
                    filter_equals=filters,
                )
                ch = self._calc_window_change(period_totals or {}, trend_mode)
                if ch:
                    metric_name = metric_col["name"]
                    mode_zh = "环比" if trend_mode == "mom" else "同比"
                    ratio_txt = "基期为0，无法计算百分比" if ch["ratio"] is None else f"{ch['ratio']:.2f}%"
                    filter_prefix = ""
                    if filters:
                        filter_text = "，".join(
                            f"{next((h['name'] for h in headers_with_col if int(h['col']) == c), f'第{c}列')}={v}"
                            for c, v in filters.items()
                        )
                        filter_prefix = f"在「{filter_text}」条件下，"
                    return (
                        f"{filter_prefix}{metric_name}{mode_zh}：{ch['latest_period']} 为 {self._format_number(ch['latest_value'])}，"
                        f"{ch['baseline_period']} 为 {self._format_number(ch['baseline_value'])}，"
                        f"变化 {self._format_number(ch['diff'])}（{ratio_txt}）。"
                    )

        # 分支1：最高/最低/前N（分组聚合排序）
        asks_rank_or_extreme = (
            llm_query_mode == "extreme_rank"
            or bool(rank_positions)
            or re.search(r"(谁|哪位|哪一个|哪个|最高|最低|最多|最少|最大|最小|前\s*\d+|top\s*\d+)", text, re.IGNORECASE)
        )
        if col_plan and asks_rank_or_extreme:
            gcol = int(col_plan["group"]["col"])
            mcol = int(col_plan["metric"]["col"])
            filters = await self._extract_query_filters(
                bridge, sheet_name, start_row, end_row, headers_with_col, sheet_meta, text, exclude_cols={gcol, mcol}
            )
            totals = await self._scan_group_metric_totals(
                bridge,
                sheet_name,
                start_row,
                end_row,
                gcol,
                mcol,
                filter_equals=filters,
                metric_threshold=metric_threshold,
            )
            if totals:
                mode = str(col_plan["mode"])
                topn = int(llm_top_n or col_plan.get("topn") or 1)
                metric_name = col_plan["metric"]["name"]
                sorted_items = sorted(totals.items(), key=lambda kv: kv[1], reverse=(mode == "max"))
                sorted_desc = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
                sorted_asc = sorted(totals.items(), key=lambda kv: kv[1], reverse=False)
                filter_prefix = ""
                if filters:
                    filter_text = "，".join(
                        f"{next((h['name'] for h in headers_with_col if int(h['col']) == c), f'第{c}列')}={v}"
                        for c, v in filters.items()
                    )
                    filter_prefix = f"在「{filter_text}」条件下，"
                if metric_threshold:
                    filter_prefix += f"{metric_name}{metric_threshold['op']}{self._format_number(float(metric_threshold['value']))}，"
                asks_both_extremes = bool(re.search(r"(最高|最大|最多).*(最低|最小|最少)|(最低|最小|最少).*(最高|最大|最多)", text))
                if asks_both_extremes and not rank_positions and topn <= 1:
                    max_val = sorted_desc[0][1]
                    min_val = sorted_asc[0][1]
                    max_people = sorted([k for k, v in sorted_desc if abs(v - max_val) < 1e-9])
                    min_people = sorted([k for k, v in sorted_asc if abs(v - min_val) < 1e-9])
                    return (
                        f"{filter_prefix}最高的是：{'、'.join(max_people)}（{self._format_number(max_val)}）；"
                        f"最低的是：{'、'.join(min_people)}（{self._format_number(min_val)}）。"
                    )
                if rank_positions:
                    rows: List[tuple[int, str, float]] = []
                    for pos in rank_positions:
                        idx = pos - 1
                        if idx < 0 or idx >= len(sorted_items):
                            continue
                        name, val = sorted_items[idx]
                        rows.append((pos, name, val))
                    if rows:
                        lines = [f"{filter_prefix}按{metric_name}累计值排序的指定名次："]
                        for pos, name, val in rows:
                            lines.append(f"第{pos}名：{name}（{self._format_number(val)}）")
                        return "\n".join(lines)
                if topn > 1:
                    rows = sorted_items[:topn]
                    lines = [f"{filter_prefix}前{len(rows)}名（按{metric_name}累计值）："]
                    for i, (name, val) in enumerate(rows, start=1):
                        lines.append(f"{i}. {name}：{self._format_number(val)}")
                    return "\n".join(lines)
                best_val = sorted_items[0][1]
                best_people = [k for k, v in sorted_items if abs(v - best_val) < 1e-9]
                best_people.sort()
                cmp_word = "最高" if mode == "max" else "最低"
                # 占比查询：返回最佳项占总量比例
                if llm_need_ratio or re.search(r"(占比|比例|占总量|占总体)", text):
                    total_sum = sum(totals.values())
                    if total_sum > 0:
                        ratio = best_val / total_sum * 100
                        return (
                            f"{filter_prefix}{cmp_word}的是：{'、'.join(best_people)}。"
                            f"{metric_name}累计值为 {self._format_number(best_val)}，占比 {ratio:.2f}%（基于当前筛选范围）。"
                        )
                return f"{filter_prefix}{cmp_word}的是：{'、'.join(best_people)}。{metric_name}累计值为 {self._format_number(best_val)}。"

        # 分支2：某主体累计值（如“陈晨累计数量是多少”）
        asks_entity_total = llm_query_mode == "entity_total" or re.search(r"(累计|总|合计|多少|几|值)", text)
        if col_plan and asks_entity_total:
            gcol = int(col_plan["group"]["col"])
            mcol = int(col_plan["metric"]["col"])
            uniq = await self._query_unique_for_column(bridge, sheet_name, start_row, end_row, gcol)
            if uniq and isinstance(uniq.get("items"), list):
                candidates = [str(it.get("value", "")).strip() for it in uniq["items"] if isinstance(it, dict)]
                target = None
                if isinstance(llm_target_entity, str) and llm_target_entity in candidates:
                    target = llm_target_entity
                if not target:
                    target = self._pick_target_from_text(candidates, text)
                if target:
                    filters = await self._extract_query_filters(
                        bridge, sheet_name, start_row, end_row, headers_with_col, sheet_meta, text, exclude_cols={gcol, mcol}
                    )
                    totals = await self._scan_group_metric_totals(
                        bridge,
                        sheet_name,
                        start_row,
                        end_row,
                        gcol,
                        mcol,
                        filter_equals=filters,
                        metric_threshold=metric_threshold,
                    )
                    if totals and target in totals:
                        metric_name = col_plan["metric"]["name"]
                        if llm_need_ratio or re.search(r"(占比|比例|占总量|占总体)", text):
                            total_sum = sum(totals.values())
                            if total_sum > 0:
                                ratio = totals[target] / total_sum * 100
                                return (
                                    f"{target} 的{metric_name}累计值为 {self._format_number(totals[target])}，"
                                    f"占比 {ratio:.2f}%（基于当前筛选范围）。"
                                )
                        return f"{target} 的{metric_name}累计值为 {self._format_number(totals[target])}。"

        # 分支3：去重计数（多少类/多少位/多少种）
        asks_unique_count = llm_query_mode == "unique_count" or re.search(r"(多少|几).*(类|位|种|个)", text)
        if asks_unique_count:
            # 优先命中命令里出现的列名
            target_col = None
            for h in headers_with_col:
                if h["name"] and h["name"] in text:
                    target_col = h
                    break
            if not target_col:
                target_col = next((h for h in headers_with_col if self._is_group_semantic(h["name"])), None)
            if target_col:
                uniq = await self._query_unique_for_column(
                    bridge, sheet_name, start_row, end_row, int(target_col["col"])
                )
                if uniq and isinstance(uniq.get("uniqueCount"), int):
                    return f"{target_col['name']}共有 {uniq['uniqueCount']} 个不同取值。"

        # 分支4：单列聚合（总和/平均/最大/最小/计数）
        asks_aggregate = llm_query_mode == "aggregate" or re.search(r"(总和|合计|总计|平均|均值|最大|最小|计数|多少)", text)
        if asks_aggregate:
            metric_col = None
            for h in headers_with_col:
                if h["name"] and h["name"] in text and self._is_metric_semantic(h["name"]):
                    metric_col = h
                    break
            if not metric_col:
                metric_col = next((h for h in headers_with_col if self._is_metric_semantic(h["name"])), None)
            if metric_col:
                filters = await self._extract_query_filters(
                    bridge,
                    sheet_name,
                    start_row,
                    end_row,
                    headers_with_col,
                    sheet_meta,
                    text,
                    exclude_cols={int(metric_col["col"])},
                )
                op = "sum"
                if llm_aggregate_op in {"sum", "avg", "max", "min", "count"}:
                    op = str(llm_aggregate_op)
                elif re.search(r"(平均|均值)", text):
                    op = "avg"
                elif re.search(r"(最大|最高|最多)", text):
                    op = "max"
                elif re.search(r"(最小|最低|最少)", text):
                    op = "min"
                elif re.search(r"(计数|多少|几)", text):
                    op = "count"
                agg = await bridge.query_frontend({
                    "type": "aggregate_column",
                    "params": {
                        "sheet": sheet_name,
                        "column": int(metric_col["col"]),
                        "startRow": start_row,
                        "endRow": end_row,
                        "operation": op,
                        "condition": "",
                    },
                })
                if not agg.get("error") and "result" in agg:
                    op_zh = {"sum": "总和", "avg": "平均值", "max": "最大值", "min": "最小值", "count": "计数"}.get(op, op)
                    val = agg.get("result")
                    # 若存在过滤条件，改用 read_range_values 进行带条件聚合
                    if filters:
                        metric_values = await self._scan_metric_values_with_filters(
                            bridge,
                            sheet_name,
                            start_row,
                            end_row,
                            metric_col=int(metric_col["col"]),
                            filter_equals=filters,
                        )
                        if metric_values is not None:
                            if op == "sum":
                                val = sum(metric_values)
                            elif op == "avg":
                                val = (sum(metric_values) / len(metric_values)) if metric_values else None
                            elif op == "max":
                                val = max(metric_values) if metric_values else None
                            elif op == "min":
                                val = min(metric_values) if metric_values else None
                            elif op == "count":
                                val = len(metric_values)
                    filter_prefix = ""
                    if filters:
                        filter_text = "，".join(
                            f"{next((h['name'] for h in headers_with_col if int(h['col']) == c), f'第{c}列')}={v}"
                            for c, v in filters.items()
                        )
                        filter_prefix = f"在「{filter_text}」条件下，"
                    if isinstance(val, (int, float)):
                        return f"{filter_prefix}{metric_col['name']}的{op_zh}为 {self._format_number(float(val))}。"
                    return f"{filter_prefix}{metric_col['name']}的{op_zh}为 {val}。"

        return None

    def _requires_chart_delivery(self, command: str) -> bool:
        """判断用户是否明确要求“本轮必须出图”"""
        text = str(command or "").strip().lower()
        if not text:
            return False

        positive_hints = [
            "图表", "可视化", "柱状图", "条形图", "折线图", "饼图", "雷达图", "散点图",
            "生成图", "自动出图", "自动生成图表", "智能分析",
        ]
        negative_hints = [
            "不要图表", "不需要图表", "仅汇总", "只要汇总", "不出图",
            "先不画图", "无需可视化", "仅生成表格",
        ]
        if any(k in text for k in negative_hints):
            return False
        return any(k in text for k in positive_hints)

    def _has_generated_chart_operation(self, operations: List[Dict[str, Any]]) -> bool:
        """检查本轮操作中是否包含 create_chart（含批量操作递归）"""
        def _iter_ops(items: List[Dict[str, Any]]):
            for op in items or []:
                if not isinstance(op, dict):
                    continue
                op_type = str(op.get("type", ""))
                yield op_type
                if op_type == "batch_operations":
                    nested = (op.get("params") or {}).get("operations") or []
                    yield from _iter_ops(nested)

        return any(op_type == "create_chart" for op_type in _iter_ops(operations))

    def _is_auto_analysis_command(self, command: str) -> bool:
        """判断是否是“智能分析并自动出图”类指令（不应反问用户）"""
        text = str(command or "").strip()
        if not text:
            return False
        has_analyze = ("智能分析" in text) or ("自动分析" in text)
        has_chart = ("图表" in text) or ("可视化" in text) or ("出图" in text)
        return has_analyze and has_chart

    def _iter_operations(self, operations: List[Dict[str, Any]]):
        """递归遍历操作（展开 batch_operations）"""
        for op in operations or []:
            if not isinstance(op, dict):
                continue
            yield op
            if str(op.get("type", "")) == "batch_operations":
                nested = (op.get("params") or {}).get("operations") or []
                yield from self._iter_operations(nested)

    def _extract_summary_target_sheets(self, operations: List[Dict[str, Any]]) -> List[str]:
        """提取汇总产物工作表（保持顺序）"""
        sheets: List[str] = []
        seen = set()
        for op in self._iter_operations(operations):
            op_type = str(op.get("type", ""))
            if op_type not in ("summarize_metrics_by_column", "summarize_by_column"):
                continue
            params = op.get("params") or {}
            sheet_name = (
                params.get("targetSheet")
                or params.get("target_sheet")
                or params.get("sheet")
            )
            if isinstance(sheet_name, str) and sheet_name.strip():
                sn = sheet_name.strip()
                if sn not in seen:
                    seen.add(sn)
                    sheets.append(sn)
        return sheets

    def _extract_chart_target_sheets(self, operations: List[Dict[str, Any]]) -> List[str]:
        """提取已生成图表的工作表（保持顺序）"""
        sheets: List[str] = []
        seen = set()
        for op in self._iter_operations(operations):
            if str(op.get("type", "")) != "create_chart":
                continue
            params = op.get("params") or {}
            sheet_name = params.get("sheet")
            if isinstance(sheet_name, str) and sheet_name.strip():
                sn = sheet_name.strip()
                if sn not in seen:
                    seen.add(sn)
                    sheets.append(sn)
        return sheets

    def _has_summary_operations(self, operations: List[Dict[str, Any]]) -> bool:
        """是否包含汇总分析表相关操作"""
        for op in self._iter_operations(operations):
            if str(op.get("type", "")) in ("summarize_metrics_by_column", "summarize_by_column", "create_pivot_table"):
                return True
        return False

    def _section_marker_rows_for_sheet(self, operations: List[Dict[str, Any]], sheet_name: str) -> List[int]:
        """提取某表上「=== xxx ===」分隔标题所在行号（升序）。"""
        rows: List[int] = []
        for op in self._iter_operations(operations):
            if str(op.get("type", "")) != "set_cell_value":
                continue
            p = op.get("params") or {}
            if (p.get("sheet") or "").strip() != sheet_name:
                continue
            val = p.get("value")
            if not _is_data_block_section_banner(val):
                continue
            r = p.get("row")
            if isinstance(r, int) and r > 0:
                rows.append(r)
        return sorted(set(rows))

    def _summarize_target_rows_for_sheet(self, operations: List[Dict[str, Any]], sheet_name: str) -> List[int]:
        """提取写入目标表的 summarize_* 的表头起始行（target_row）。"""
        rows: List[int] = []
        _SUMMARY_TYPES = ("summarize_metrics_by_column", "summarize_by_column")
        for op in self._iter_operations(operations):
            if str(op.get("type", "")) not in _SUMMARY_TYPES:
                continue
            p = op.get("params") or {}
            ts = (p.get("targetSheet") or p.get("target_sheet") or "").strip()
            if ts != sheet_name:
                continue
            tr = p.get("targetRow") if p.get("targetRow") is not None else p.get("target_row")
            if isinstance(tr, int) and tr > 0:
                rows.append(tr)
        return sorted(set(rows))

    def _next_section_banner_row_after(
        self, operations: List[Dict[str, Any]], sheet_name: str, after_row: int
    ) -> Optional[int]:
        best: Optional[int] = None
        for op in self._iter_operations(operations):
            if str(op.get("type", "")) != "set_cell_value":
                continue
            p = op.get("params") or {}
            if (p.get("sheet") or "").strip() != sheet_name:
                continue
            r = p.get("row")
            if not isinstance(r, int) or r <= after_row:
                continue
            val = p.get("value")
            if _is_section_banner_title(val):
                if best is None or r < best:
                    best = r
        return best

    def _infer_comprehensive_block_header_rows(self, operations: List[Dict[str, Any]], sheet_name: str) -> List[int]:
        """
        推断「综合分析」同表多块的表头行（每块一张柱图：标签列+首列数值）。
        结合 === 分隔行与 summarize_* 的 target_row；纯手工块用「分隔行+1」作表头行。
        """
        markers = self._section_marker_rows_for_sheet(operations, sheet_name)
        targets = self._summarize_target_rows_for_sheet(operations, sheet_name)
        if not markers and not targets:
            return []
        if not markers:
            return targets

        headers: List[int] = []
        for i, m in enumerate(markers):
            hi = markers[i + 1] if i + 1 < len(markers) else 10_000
            in_seg = [t for t in targets if m < t < hi]
            if in_seg:
                headers.append(min(in_seg))
            else:
                # 仅当该分隔段内确有手工数据输出时，才视为可补图块
                has_manual_data = False
                for op in self._iter_operations(operations):
                    op_type = str(op.get("type", ""))
                    if op_type not in ("set_range_values", "set_range_style"):
                        continue
                    p = op.get("params") or {}
                    if (p.get("sheet") or "").strip() != sheet_name:
                        continue
                    sr = p.get("startRow") if p.get("startRow") is not None else p.get("start_row")
                    if not isinstance(sr, int):
                        continue
                    if m < sr < hi:
                        has_manual_data = True
                        break
                if has_manual_data:
                    headers.append(m + 1)

        first_m = markers[0]
        for t in targets:
            if t < first_m:
                headers.append(t)
        return sorted(set(headers))

    def _autofill_block_end_row(
        self,
        operations: List[Dict[str, Any]],
        sheet_name: str,
        header_row: int,
        sorted_headers: List[int],
    ) -> int:
        """表头行确定后，推断数据区末行（不含下一块 === 标题行）。"""
        next_h = next((h for h in sorted_headers if h > header_row), None)
        next_b = self._next_section_banner_row_after(operations, sheet_name, header_row)
        caps: List[int] = []
        if next_b is not None:
            caps.append(next_b - 1)
        if next_h is not None:
            caps.append(next_h - 1)
        if caps:
            end_row = min(caps)
            end_row = max(header_row, end_row)
        else:
            # 无后续分隔块：手工汇总通常很短，避免拉到 60 行误吞「关键发现」等后续文字
            end_row = min(header_row + _CHART_MAX_EFFECTIVE_ROWS["column"], header_row + 28)
        if end_row <= header_row:
            end_row = header_row + 5
        return end_row

    def _find_block_chart_insert_idx(
        self,
        buf: List[Dict[str, Any]],
        sheet_name: str,
        header_row: int,
        sorted_headers: List[int],
    ) -> int:
        """
        返回本块（banner 在 header_row）在 buffer 中的图表插入位置。

        策略：找到下一个 banner 的 buffer 下标；在其之前插入，让 reflow
        能正确把补图归属到本块而非最后一块。
        找不到下一 banner 时退化为追加末尾。
        """
        next_hr = next((h for h in sorted_headers if h > header_row), None)
        if next_hr is None:
            return len(buf)  # 最后一块，追加即可，reflow 归属正确

        # 从头搜索 next_hr 对应的 banner 在 buffer 中的位置
        for i, op in enumerate(buf):
            if str(op.get("type") or "") != "set_cell_value":
                continue
            p = op.get("params") or {}
            if str(p.get("sheet") or "").strip() != sheet_name:
                continue
            r = self._get_int_param(p, "row")
            if r != next_hr:
                continue
            val = str(p.get("value") or "").strip()
            if _is_data_block_section_banner(val):
                return i  # 在下一块 banner 之前插入
        return len(buf)  # 找不到则退化为末尾

    def _chart_row_span_from_params(self, params: Dict[str, Any]) -> tuple:
        """解析 create_chart 的 dataRange 行区间（复用统一解析器）。"""
        dr = params.get("dataRange") or params.get("data_range")
        return self._extract_chart_row_span(dr)

    @staticmethod
    def _row_intervals_overlap(a0: int, a1: int, b0: int, b1: int) -> bool:
        return max(a0, b0) <= min(a1, b1)

    @staticmethod
    def _select_chart_type_for_block(
        header_row: int,
        end_row: int,
        value_col_count: int,
        used_types: Optional[set[str]] = None,
    ) -> str:
        """
        统一复用 plan_compiler 的选型策略，避免两套规则漂移。
        这里仅提供最小必要输入（行数、指标列数量、已用类型）。
        """
        data_rows = max(1, int(end_row) - int(header_row))
        val_cols = max(1, int(value_col_count))
        return _select_chart_type_by_data(
            data_rows=data_rows,
            value_col_count=val_cols,
            used_types=used_types or set(),
        )

    def _autofill_missing_summary_charts(self, command: str) -> int:
        """
        自动为"已汇总但未出图"的分析块补图。

        综合分析模式下，所有汇总块均写入同一张工作表（如「综合分析」），
        需用「汇总次数 / === 分隔块数 / 图表次数」综合判断缺口。
        禁止再用 startRow=1,endRow=200 的占位区间（会吞并多块数据导致乱图）。
        """
        if not self._is_auto_analysis_command(command):
            return 0
        if not self._operations_buffer:
            return 0

        _SUMMARY_TYPES = {"summarize_metrics_by_column", "summarize_by_column"}
        summary_count_by_sheet: Dict[str, int] = {}
        chart_count_by_sheet: Dict[str, int] = {}
        marker_count_by_sheet: Dict[str, int] = {}

        for op in self._iter_operations(self._operations_buffer):
            op_type = str(op.get("type", ""))
            params = op.get("params") or {}
            if op_type in _SUMMARY_TYPES:
                sn = (params.get("targetSheet") or params.get("target_sheet") or params.get("sheet") or "").strip()
                if sn:
                    summary_count_by_sheet[sn] = summary_count_by_sheet.get(sn, 0) + 1
            elif op_type == "create_chart":
                sn = (params.get("sheet") or "").strip()
                if sn:
                    chart_count_by_sheet[sn] = chart_count_by_sheet.get(sn, 0) + 1
            elif op_type == "set_cell_value":
                sn = (params.get("sheet") or "").strip()
                val = params.get("value")
                if sn and _is_data_block_section_banner(val):
                    marker_count_by_sheet[sn] = marker_count_by_sheet.get(sn, 0) + 1

        # 仅对“确实有汇总”的 sheet 触发补图，禁止对仅有标题/说明文本的 sheet 补图
        candidate_sheets = set(summary_count_by_sheet.keys())
        if not candidate_sheets:
            return 0

        added = 0
        buf = self._operations_buffer
        for sheet_name in sorted(candidate_sheets):
            block_headers = self._infer_comprehensive_block_header_rows(buf, sheet_name)
            if not block_headers:
                tr = self._summarize_target_rows_for_sheet(buf, sheet_name)
                if tr:
                    block_headers = tr
                elif marker_count_by_sheet.get(sheet_name, 0) and summary_count_by_sheet.get(sheet_name, 0) > 0:
                    block_headers = [m + 1 for m in self._section_marker_rows_for_sheet(buf, sheet_name)]
                elif summary_count_by_sheet.get(sheet_name, 0):
                    # 工具未带 target_row 时无法推断多块边界，退化为自第 1 行起（兼容旧单测与历史调用）
                    block_headers = [1]
                else:
                    continue

            # 块数已由 block_headers / 汇总次数刻画；勿再与 marker_count 取 max，避免与「关键发现」等重复计数
            need_count = max(len(block_headers), summary_count_by_sheet.get(sheet_name, 0))
            have_count = chart_count_by_sheet.get(sheet_name, 0)
            missing_count = max(0, need_count - have_count)
            if missing_count == 0:
                continue

            sorted_h = sorted(block_headers)
            existing_spans: List[tuple] = []
            used_chart_types: set[str] = set()
            for op0 in self._iter_operations(buf):
                if str(op0.get("type", "")) != "create_chart":
                    continue
                p0 = op0.get("params") or {}
                if (p0.get("sheet") or "").strip() != sheet_name:
                    continue
                ct = str(p0.get("chartType") or p0.get("chart_type") or "").strip().lower()
                if ct:
                    used_chart_types.add(ct)
                s0, s1 = self._chart_row_span_from_params(p0)
                if s0 is not None and s1 is not None:
                    existing_spans.append((s0, s1))

            self.log.logger.info(
                self.log.fmt(
                    f"补图检测: sheet={sheet_name} 块表头行={sorted_h} "
                    f"汇总={summary_count_by_sheet.get(sheet_name, 0)} "
                    f"数据块分隔标题={marker_count_by_sheet.get(sheet_name, 0)} "
                    f"需图={need_count} 已图={have_count} 缺={missing_count}"
                )
            )

            # 逐块尝试补图：idx 用完所有块后直接终止，不再对最后一块无限重试
            # 关键：chart 必须插入到所属块的操作序列末尾（下一个 banner 之前），
            # 而非追加到 buffer 末尾——追加会导致 reflow 把所有补图归属到最后一个块，
            # 从而赋予错误的列槽和 dataRange。
            charts_added_here = 0
            pending_inserts: List[tuple] = []  # (insert_idx, op)
            base_chart_serial = have_count
            for idx in range(have_count, len(sorted_h)):
                if charts_added_here >= missing_count:
                    break
                hr = sorted_h[idx]
                end_row = self._autofill_block_end_row(buf, sheet_name, hr, sorted_h)
                if any(
                    self._row_intervals_overlap(hr, end_row, s0, s1) for s0, s1 in existing_spans
                ):
                    self.log.logger.info(
                        self.log.fmt(
                            f"补图跳过: sheet={sheet_name} 行 {hr}-{end_row} 与已有图表数据区重叠"
                        )
                    )
                    continue
                title_n = base_chart_serial + charts_added_here + 1
                value_col_count = 1
                chart_type = self._select_chart_type_for_block(
                    hr,
                    end_row,
                    value_col_count,
                    used_types=used_chart_types,
                )
                used_chart_types.add(chart_type)
                op = {
                    "type": "create_chart",
                    "params": {
                        "sheet": sheet_name,
                        "chartType": chart_type,
                        "dataRange": {
                            "startRow": hr,
                            "startCol": 1,
                            "endRow": end_row,
                            "endCol": 2,
                        },
                        "title": f"{sheet_name}-分析图{title_n}",
                        "row": hr,
                        "col": 6,
                        "width": 520,
                        "height": 340,
                    },
                }
                # 找到本块在 buffer 中的插入位置（下一个 banner 之前，或 buffer 末尾）
                insert_idx = self._find_block_chart_insert_idx(buf, sheet_name, hr, sorted_h)
                pending_inserts.append((insert_idx, op))
                charts_added_here += 1
                added += 1
                chart_count_by_sheet[sheet_name] = chart_count_by_sheet.get(sheet_name, 0) + 1
                existing_spans.append((hr, end_row))

            # 从后往前插入，保证先插入的不影响后续索引
            for insert_idx, op in sorted(pending_inserts, key=lambda x: x[0], reverse=True):
                buf.insert(insert_idx, op)

        if added > 0:
            self.log.logger.info(self.log.fmt(f"自动补图生效：补齐 {added} 张图表"))
        return added

    def _strip_followup_questions_for_auto_analysis(self, text: str, command: str) -> str:
        """自动分析场景下移除“继续追问用户”的尾句，保持专家直出风格。"""
        if not text or not self._is_auto_analysis_command(command):
            return text
        lines = str(text).splitlines()
        filtered: List[str] = []
        for line in lines:
            s = line.strip()
            if not s:
                filtered.append(line)
                continue
            if ("您希望我" in s and "分析" in s) or ("更深入" in s and "可视化" in s):
                continue
            filtered.append(line)
        return "\n".join(filtered).strip()

    @staticmethod
    def _has_completion_claim_without_ops(text: str) -> bool:
        """
        检测文本是否包含“已完成/已成功”语义。
        用于识别“0 工具调用 + 完成话术”的假完成场景。
        """
        payload = str(text or "").strip().lower()
        if not payload:
            return False
        hints = (
            "操作已完成",
            "已完成",
            "已成功",
            "成功完成",
            "已生成",
            "请查看",
            "分析结果",
            "图表生成",
        )
        return any(h in payload for h in hints)

    def _build_noop_retry_prompt(
        self,
        *,
        command: str,
        context_str: str,
        intent_rules: str,
        prior_text: str,
    ) -> str:
        preview = (prior_text or "").strip()
        if len(preview) > 400:
            preview = preview[:400] + "..."
        return f"""## 上一轮出现“文本声称完成但未产生任何操作”，必须立即修复（仅一次）

用户原始请求：
{command}

<intent_rules>
{intent_rules}
</intent_rules>

## 当前Excel状态：
{context_str}

## 上一轮无效文本（仅作参考）
{preview}

硬约束：
1. 不允许输出“已完成/已成功”类文本总结。
2. 必须且仅能调用一次 submit_analysis_plan。
3. 若字段不足以分析，调用 AskUserQuestion 明确缺失字段；禁止猜测。
4. 绝对禁止返回空操作。"""

    def _extract_one_click_fields(self, command: str) -> List[str]:
        text = str(command or "")
        patterns = [
            r"字段(?:包含|包括|为|涉及)\s*[：:]\s*([^\n。；;]+)",
            r"字段\s*[：:]\s*([^\n。；;]+)",
        ]
        for pattern in patterns:
            match = re.search(pattern, text)
            if not match:
                continue
            raw = match.group(1)
            items = [
                p.strip(" \t\r\n`'\"“”‘’「」『』")
                for p in re.split(r"[、,，/|]", raw)
            ]
            fields = [item for item in items if item]
            if fields:
                return fields
        return ["姓名", "手机", "班级", "职务", "家庭地址"]

    def _build_one_click_sample_rows(self, fields: List[str], row_count: int = 10) -> List[List[str]]:
        names = ["张伟", "李娜", "王强", "刘敏", "陈杰", "赵雪", "黄磊", "周婷", "吴昊", "郑颖"]
        phones = [
            "138****5678", "139****2468", "137****1122", "136****8899", "135****3344",
            "188****7755", "187****6600", "186****9988", "185****4433", "158****2211",
        ]
        classes = ["高三1班", "高三2班", "高三3班", "高三1班", "高三2班", "高三3班", "高三1班", "高三2班", "高三3班", "高三1班"]
        roles = ["班长", "学习委员", "体育委员", "", "纪律委员", "文艺委员", "", "劳动委员", "团支书", ""]
        addresses = [
            "北京市朝阳区望京街道", "上海市浦东新区张江镇", "广州市天河区珠江新城",
            "深圳市南山区科技园", "杭州市西湖区文三路", "成都市高新区天府大道",
            "武汉市洪山区珞喻路", "南京市建邺区奥体大街", "西安市雁塔区小寨东路", "重庆市渝中区解放碑",
        ]

        rows: List[List[str]] = []
        for idx in range(row_count):
            row_values: List[str] = []
            for field in fields:
                if "姓名" in field:
                    row_values.append(names[idx % len(names)])
                elif ("手机" in field) or ("电话" in field):
                    row_values.append(phones[idx % len(phones)])
                elif "班级" in field:
                    row_values.append(classes[idx % len(classes)])
                elif "职务" in field:
                    row_values.append(roles[idx % len(roles)])
                elif "地址" in field:
                    row_values.append(addresses[idx % len(addresses)])
                else:
                    row_values.append(f"{field}{idx + 1}")
            rows.append(row_values)
        return rows

    def _build_one_click_fallback_operations(self, command: str) -> List[Dict[str, Any]]:
        fields = self._extract_one_click_fields(command)
        sheet_name = self.context.active_sheet or "Sheet1"
        if self.context.sheets and not any(s.get("name") == sheet_name for s in self.context.sheets):
            sheet_name = self.context.sheets[0].get("name", "Sheet1")

        rows = self._build_one_click_sample_rows(fields, row_count=10)
        values = [fields] + rows
        col_count = len(fields)

        header_style = {
            "bold": True,
            "backgroundColor": "#4472C4",
            "fontColor": "#FFFFFF",
            "horizontalAlignment": "center",
            "verticalAlignment": "middle",
        }
        width_map = {
            "姓名": 12,
            "手机": 15,
            "班级": 14,
            "职务": 12,
            "家庭地址": 40,
            "地址": 40,
        }

        operations: List[Dict[str, Any]] = [
            {
                "type": "set_range_values",
                "params": {
                    "sheet": sheet_name,
                    "startRow": 1,
                    "startCol": 1,
                    "values": values,
                },
            },
            {
                "type": "set_range_style",
                "params": {
                    "sheet": sheet_name,
                    "startRow": 1,
                    "startCol": 1,
                    "endRow": 1,
                    "endCol": col_count,
                    "style": header_style,
                },
            },
        ]

        for idx, field in enumerate(fields, start=1):
            width = width_map.get(field, 16)
            operations.append(
                {
                    "type": "set_column_width",
                    "params": {"sheet": sheet_name, "col": idx, "width": width},
                }
            )
        return operations
    
    async def _send_message(self, msg_type: str, data: Any):
        """发送消息到回调"""
        if self._message_callback:
            await self._message_callback(msg_type, data)

    async def process_command(
        self, 
        command: str, 
        excel_state: Optional[Dict[str, Any]] = None
    ) -> AsyncIterator[Dict[str, Any]]:
        """处理用户命令"""
        self.log.command_received(command)
        self._inflight += 1
        self.touch()
        
        if isinstance(excel_state, dict) and excel_state:
            self.update_context(excel_state)
            self.log.command_context(excel_state)
            from .param_normalizer import set_excel_state
            set_excel_state(excel_state)
        
        # 注入工具日志前缀，让 MCP 工具函数的日志携带 session_id + user_tag
        from .excel_tools import (
            set_tool_log_prefix,
            set_tool_session_id,
            set_tool_excel_state_snapshot,
        )
        set_tool_log_prefix(self.log.fmt(""))
        set_tool_session_id(self.session_id)
        if isinstance(excel_state, dict) and excel_state:
            set_tool_excel_state_snapshot(self.session_id, excel_state)
        
        context_str = self.context.to_context_string()
        active_intent_rules = ""
        
        # 核心逻辑：判断是否应该作为补充信息执行
        # 只有在确实在等待补充信息时，才认为是补充信息执行
        # 关键：不依赖硬编码的关键词检测，而是基于状态标志判断
        force_followup_execute = (
            self._awaiting_followup and 
            self._last_question and 
            self._last_user_request
        )
        # 每次请求先重置查询只读守卫，避免跨请求状态泄漏
        self._query_readonly_mode = False
        self._query_readonly_aborted = False

        # 先基于命令判定查询模式，再初始化 client（确保工具白名单与模式一致）
        pre_intents = detect_intent(command)
        self._query_readonly_mode = is_read_only_query_request(command, pre_intents)

        # 查询模式确定性直答：命中可计算问句时直接返回，避免 LLM 工具链跑偏
        if self._query_readonly_mode:
            deterministic_answer = await self._try_answer_query_deterministically(command)
            if deterministic_answer:
                self.log.logger.info(self.log.fmt("查询确定性求解命中：已直接返回只读计算结果。"))
                self.log.command_complete(True, "查询确定性直答")
                yield {"type": "complete", "content": deterministic_answer}
                self._inflight = max(0, self._inflight - 1)
                self.touch()
                return

        # 确保 client 已初始化并连接；若模式切换（读写 <-> 只读）则重建 client
        if self.client and not self._closed and self._client_query_mode != self._query_readonly_mode:
            await self.close()
        if not self.client or self._closed:
            await self.initialize()
        
        # 如果不在等待补充信息状态，但仍有残留状态，清理它们
        # 这可能是由于之前的任务已完成但状态未完全清理导致的
        if not force_followup_execute and (self._last_user_request or self._last_question):
            self.log.logger.info(
                                self.log.fmt(f'🔍 检测到残留的补充信息状态（但不在等待状态），清理状态。 当前命令: "{command}", 残留任务: "{self._last_user_request}"')
            )
            self._awaiting_followup = False
            self._last_question = None
            self._last_user_request = None
            self._last_context_snapshot = None
        
        # 调试日志：记录上下文状态
        if force_followup_execute:
            self.log.logger.info(self.log.fmt(f'🔄 检测到补充信息执行：原始任务="{self._last_user_request}", 补充信息="{command}"'))
        
        if force_followup_execute:
            self._is_followup_execution = True
            original_task = self._last_user_request
            user_supplement = command
            self._active_auto_analysis_request = self._is_auto_analysis_command(original_task or "")

            # followup 路径沿用上次意图规则（若有）
            followup_intents = getattr(self, '_last_intents', None) or detect_intent(original_task)
            followup_rules = get_rules_for_intents(followup_intents)
            active_intent_rules = followup_rules

            full_prompt = f"""## 继续执行之前的任务（非新任务）

原始任务：{original_task}
你之前的问题：{self._last_question}
用户补充信息：{user_supplement}

<intent_rules>
{followup_rules}
</intent_rules>

## 当前Excel状态：
{context_str}

用补充信息完成原始任务。数据不存在时再次询问用户，禁止猜测。"""
            
            # 记录日志，确认 prompt 已构建
            self.log.logger.info(self.log.fmt(f'📝 补充执行 prompt 已构建，原始任务: "{original_task}", 补充信息: "{user_supplement}"'))
            self._awaiting_followup = False
        else:
            self._is_followup_execution = False
            self._active_auto_analysis_request = self._is_auto_analysis_command(command)
            # 元数据驱动 prompt 扩展：用户输入模糊时自动补全上下文与执行指引
            expanded_command, was_expanded = expand_user_prompt(command, excel_state)
            if was_expanded:
                self.log.logger.info(
                    self.log.fmt(f'Prompt 扩展已生效，原始指令长度={len(command)}，扩展后长度={len(expanded_command)}')
                )
            effective_command = expanded_command if was_expanded else command

            # 意图识别 + 动态规则注入（Phase 2 核心改造）
            intents = detect_intent(command)
            # 结构化只读查询守卫：问句且无写意图时，强制走 QUERY 规则，禁止改写工作簿
            if self._query_readonly_mode and "query" not in intents:
                intents = ["query", *[i for i in intents if i != "unknown"]]
            intent_rules = get_rules_for_intents(intents)
            active_intent_rules = intent_rules
            self._last_intents = intents
            self.log.logger.info(
                self.log.fmt(f'意图识别: {intents}, 注入规则 {len(intent_rules)} chars')
            )
            if self._query_readonly_mode:
                self.log.logger.info(self.log.fmt('查询只读守卫生效：本轮禁止写操作工具落库'))

            full_prompt = f"""## 当前Excel状态：
{context_str}

<intent_rules>
{intent_rules}
</intent_rules>

## 用户请求：
{effective_command}

如果识别出不存在的工作表或列字段，停止规划并让用户补充信息。"""

        self._operations_buffer = []
        # 每次请求开始时重置验证状态，避免跨请求残留
        self._validation_errors = []
        self._fatal_validation_error = False
        
        try:
            # 记录发送的 prompt（仅记录关键部分，避免日志过长）
            if force_followup_execute:
                self.log.logger.info(self.log.fmt(f'🔄 发送补充执行查询到 Claude，原始任务: "{self._last_user_request}"'))
                self.log.logger.info(self.log.fmt('📝 使用同一个 ClaudeSDKClient 实例维护会话连续性'))
            else:
                self.log.logger.debug(self.log.fmt('发送查询到 Claude'))
            
            # 关键：使用同一个 client 实例的 query() 方法，ClaudeSDKClient 会自动维护会话历史
            # 根据文档，ClaudeSDKClient.query() 支持多轮对话，前提是使用同一个 client 实例
            # session_id 参数用于标识会话，使用 self.session_id 确保会话一致性
            await self.client.query(full_prompt, session_id=self.session_id)
            
            text_buffer = ""
            stop_processing = False
            tool_call_count = 0  # 统计工具调用次数
            tool_result_count = 0  # 统计工具结果次数
            no_followup_for_one_click = "一键生表" in (command or "")
            
            async for message in self.client.receive_response():
                # 记录所有消息类型用于调试
                self.log.logger.debug(self.log.fmt(f'收到消息类型: {type(message)}'))
                
                if isinstance(message, AssistantMessage):
                    self.log.logger.debug(self.log.fmt(f'AssistantMessage.content 长度: {len(message.content)}'))
                    for idx, block in enumerate(message.content):
                        self.log.logger.debug(self.log.fmt(f'content[{idx}] 类型: {type(block)}'))
                        
                        # 统计工具调用
                        if isinstance(block, ToolUseBlock):
                            tool_call_count += 1
                        elif isinstance(block, ToolResultBlock):
                            tool_result_count += 1
                        
                        if isinstance(block, TextBlock):
                            text_buffer += block.text
                            self.log.ai_response(block.text, streaming=True)
                            yield {"type": "text", "content": block.text}
                        
                        elif isinstance(block, ToolUseBlock):
                            # 查询只读模式下：一旦模型尝试越权工具，立即短路本轮，避免长链跑偏
                            if self._query_readonly_mode and block.name not in _READONLY_QUERY_TOOL_SET:
                                self._query_readonly_aborted = True
                                self.log.logger.warning(
                                    self.log.fmt(
                                        f"查询只读模式检测到越权工具调用: {block.name}，本轮提前终止并返回只读引导。"
                                    )
                                )
                                stop_processing = True
                                break
                            self.log.tool_call_start(block.name, getattr(block, 'input', {}))
                            # 记录工具调用详情
                            self.log.logger.info(
                                self.log.fmt(f'🔧 工具调用: {block.name}, 输入参数: {getattr(block, "input", {})}')
                            )
                            if block.name == "AskUserQuestion":
                                if force_followup_execute or no_followup_for_one_click:
                                    reason = "补充执行时不应提问" if force_followup_execute else "一键生表场景禁止追问"
                                    self.log.logger.info(self.log.fmt(f'⚠️ {reason}，跳过 AskUserQuestion'))
                                    yield {"type": "thinking", "content": "继续执行，不再提问"}
                                    continue
                                question_input = getattr(block, 'input', {}) or {}
                                question = (
                                    question_input.get("question") or
                                    question_input.get("content") or
                                    "需要进一步确认，请补充您的意图。"
                                )
                                self._awaiting_followup = True
                                self._last_question = question
                                self._last_user_request = command
                                self._last_context_snapshot = context_str
                                yield {"type": "ask", "content": question}
                                stop_processing = True
                                break
                            yield {"type": "thinking", "content": f"正在执行: {block.name}"}
                        
                        elif isinstance(block, ToolResultBlock):
                            # 记录工具结果块的详细信息
                            self.log.logger.debug(self.log.fmt('========== 收到 ToolResultBlock (AssistantMessage) =========='))
                            await self._process_tool_result(block)
                            self.log.logger.debug(self.log.fmt('========== ToolResultBlock 处理完成 =========='))
                            if getattr(self, '_fatal_validation_error', False):
                                self.log.logger.warning(
                                    self.log.fmt('⚠️ 检测到致命参数错误，停止后续工具链以避免部分成功。')
                                )
                                stop_processing = True
                                break
                        else:
                            # Claude SDK 新版本可能返回 ThinkingBlock/RedactedThinkingBlock。
                            # 这些块不参与工具执行，仅做调试记录，避免噪音 warning。
                            block_type_name = type(block).__name__
                            if block_type_name in {"ThinkingBlock", "RedactedThinkingBlock"}:
                                self.log.logger.debug(
                                    self.log.fmt(f'收到思考块: {block_type_name}，已跳过。')
                                )
                            else:
                                self.log.logger.warning(
                                    self.log.fmt(f'未知的 block 类型: {type(block)}')
                                )
                
                elif isinstance(message, UserMessage):
                    self.log.logger.debug(self.log.fmt(f'UserMessage.content 长度: {len(message.content)}'))
                    for idx, block in enumerate(message.content):
                        self.log.logger.debug(self.log.fmt(f'UserMessage.content[{idx}] 类型: {type(block)}'))
                        if isinstance(block, ToolResultBlock):
                            tool_result_count += 1
                            self.log.logger.debug(self.log.fmt('========== 收到 ToolResultBlock (UserMessage) =========='))
                            await self._process_tool_result(block)
                            self.log.logger.debug(self.log.fmt('========== ToolResultBlock 处理完成 =========='))
                            if getattr(self, '_fatal_validation_error', False):
                                self.log.logger.warning(
                                    self.log.fmt('⚠️ 检测到致命参数错误，停止后续工具链以避免部分成功。')
                                )
                                stop_processing = True
                                break
                else:
                    # 记录非 AssistantMessage 类型的消息
                    self.log.logger.debug(self.log.fmt(f'非 AssistantMessage 消息: {type(message)}'))
                
                if stop_processing:
                    break
                
            # stop_processing 为 True 时：
            #   - 若是 fatal_validation_error → 不 return，落入下方 error yield 通知前端
            #   - 若是 asked_user 等其他原因 → return（不需要额外 yield）
            if stop_processing and not getattr(self, '_fatal_validation_error', False):
                return

            # 记录操作生成情况
            validation_errors = getattr(self, '_validation_errors', [])
            if validation_errors and getattr(self, '_fatal_validation_error', False):
                # submit_analysis_plan 计划校验失败：同轮静默自动修复重试 1 次
                if should_retry_submit_analysis_plan(validation_errors):
                    self.log.logger.info(self.log.fmt("检测到 submit_analysis_plan 计划校验失败，启动单次自动修复重试。"))
                    retry_prompt = build_submit_analysis_retry_prompt(
                        command=command,
                        context_str=context_str,
                        intent_rules=active_intent_rules,
                        validation_errors=validation_errors,
                    )
                    self._validation_errors = []
                    self._fatal_validation_error = False
                    query_aborted = await execute_silent_retry_round(
                        client=self.client,
                        session_id=self.session_id,
                        retry_prompt=retry_prompt,
                        query_readonly_mode=self._query_readonly_mode,
                        readonly_tool_set=set(_READONLY_QUERY_TOOL_SET),
                        process_tool_result=self._process_tool_result,
                        get_fatal_validation_error=lambda: bool(getattr(self, "_fatal_validation_error", False)),
                    )
                    if query_aborted:
                        self._query_readonly_aborted = True
                    validation_errors = getattr(self, '_validation_errors', [])
                    # 重试成功：继续走正常 operations 下发，不进入错误分支
                    if not (validation_errors and getattr(self, '_fatal_validation_error', False)):
                        self.log.logger.info(self.log.fmt("submit_analysis_plan 自动修复重试成功。"))
                    else:
                        self.log.logger.warning(self.log.fmt("submit_analysis_plan 自动修复重试失败，将按原错误路径返回。"))

            if validation_errors and getattr(self, '_fatal_validation_error', False):
                # 有致命校验错误时拒绝部分成功：丢弃已缓存操作，统一返回错误
                self._operations_buffer = []
                # 技术细节仅保留在日志，面向用户的消息脱敏
                raw_error = "\n".join(f"• {err}" for err in validation_errors)
                self.log.logger.warning(
                    self.log.fmt(f'⚠️ 检测到致命参数错误，已丢弃本轮操作: {raw_error}')
                )
                user_msg = _sanitize_error_for_user(raw_error)
                yield {"type": "error", "content": user_msg}
                self._validation_errors = []
                self._fatal_validation_error = False
            elif self._operations_buffer:
                # submit_analysis_plan 编译器产出的操作已确定性排版
                _plan_compiled = any(
                    str(op.get('type', '')) == 'add_sheet'
                    and str((op.get('params') or {}).get('name', '')).strip() == '综合分析'
                    for op in self._operations_buffer
                ) and self._has_generated_chart_operation(self._operations_buffer)

                if not _plan_compiled and self._requires_chart_delivery(command):
                    self._autofill_missing_summary_charts(command)
                # 综合分析统一排版：整批操作生成后做一次确定性重排，
                # 以块为单位同步平移标题/汇总/图表，彻底避免块间重叠与粘连。
                if not _plan_compiled:
                    self._reflow_comprehensive_layout()

                # 原子交付规则（强制）：
                # 在“要求自动出图”的请求中，只要出现了汇总分析表，就必须至少有 1 张图表；
                # 否则整批操作作废，避免“有表无图”的半交付。
                if self._requires_chart_delivery(command):
                    has_summary = self._has_summary_operations(self._operations_buffer)
                    has_chart = self._has_generated_chart_operation(self._operations_buffer)
                    if has_summary and not has_chart:
                        self.log.logger.warning(
                            self.log.fmt('⚠️ 原子交付守卫触发：已生成汇总分析表但无图表，丢弃本轮操作。')
                        )
                        self._operations_buffer = []
                        yield {"type": "error", "content": "提示：当前结果仅包含汇总表、尚缺少配套图表。系统已自动拦截半成品交付，请重试后我会一次性输出完整分析结果。"}
                        return
                self.log.tool_result_processed(len(self._operations_buffer))
                yield {"type": "operations", "content": self._operations_buffer}
                # 关键：如果生成了操作，说明任务已完成，完全清理补充信息相关状态
                # 无论是否force_followup_execute，只要生成了操作，就说明任务已完成
                if self._awaiting_followup or force_followup_execute or self._last_user_request:
                    self._awaiting_followup = False
                    self._last_user_request = None
                    self._last_question = None
                    self._last_context_snapshot = None
                    self.log.logger.info(
                                                self.log.fmt(f'✅ 任务成功完成，已完全清理补充信息相关状态。 生成操作数: {len(self._operations_buffer)}')
                    )

                # 图表交付守卫：用户要求“自动出图”但本轮未生成 create_chart，视为未完成，保持会话继续执行
                if self._requires_chart_delivery(command) and not self._has_generated_chart_operation(self._operations_buffer):
                    if self._is_auto_analysis_command(command):
                        self.log.logger.warning(
                            self.log.fmt('⚠️ 图表交付守卫触发：自动分析场景下仍未生成图表，直接返回错误，不再追问用户。')
                        )
                        yield {"type": "error", "content": "提示：本轮自动分析尚未成功完成图表生成。系统已阻止不完整交付，请重试后我将直接补齐图表并给出结论。"}
                        return
                    question = "本轮尚未成功生成图表。是否允许我基于已产出的汇总区域继续自动创建图表？回复“继续”即可。"
                    self._awaiting_followup = True
                    self._last_user_request = command
                    self._last_question = question
                    self._last_context_snapshot = context_str
                    self.log.logger.warning(
                        self.log.fmt('⚠️ 图表交付守卫触发：检测到用户要求出图但本轮未生成 create_chart，保持会话等待补充执行。')
                    )
                    yield {"type": "ask", "content": question}
                    return
            else:
                # 没有生成操作，检查是否有验证错误
                if validation_errors:
                    raw_error = "\n".join(f"• {err}" for err in validation_errors)
                    self.log.logger.warning(self.log.fmt(f'⚠️ 操作验证失败: {raw_error}'))
                    user_msg = _sanitize_error_for_user(raw_error)
                    yield {"type": "error", "content": user_msg}
                    # 清理验证错误
                    self._validation_errors = []
                    self._fatal_validation_error = False
                else:
                    fallback_handled = False
                    noop_retry_recovered = False
                    if self._is_one_click_sheet_command(command):
                        fallback_ops = self._build_one_click_fallback_operations(command)
                        fallback_errors = []
                        for op in fallback_ops:
                            success, error_msg = self._validate_and_add_operation(op)
                            if not success and error_msg:
                                fallback_errors.append(error_msg)
                        if self._operations_buffer:
                            self.log.logger.info(
                                self.log.fmt(f'✅ 一键生表兜底生效：自动生成 {len(self._operations_buffer)} 个操作')
                            )
                            yield {"type": "operations", "content": self._operations_buffer}
                            if self._awaiting_followup or force_followup_execute or self._last_user_request:
                                self._awaiting_followup = False
                                self._last_user_request = None
                                self._last_question = None
                                self._last_context_snapshot = None
                            fallback_handled = True
                        elif fallback_errors:
                            raw_error = "\n".join(f"• {err}" for err in fallback_errors)
                            self.log.logger.warning(self.log.fmt(f'⚠️ 一键生表兜底执行失败: {raw_error}'))
                            yield {"type": "error", "content": _USER_ERROR_GENERIC}
                            fallback_handled = True

                    if (
                        not fallback_handled
                        and not self._query_readonly_mode
                        and self._requires_chart_delivery(command)
                        and tool_call_count == 0
                        and self._has_completion_claim_without_ops(text_buffer)
                    ):
                        self.log.logger.warning(
                            self.log.fmt(
                                "⚠️ 检测到“完成语义 + 0 工具调用”假完成，启动单次静默自动修复重试。"
                            )
                        )
                        retry_prompt = self._build_noop_retry_prompt(
                            command=command,
                            context_str=context_str,
                            intent_rules=active_intent_rules if not force_followup_execute else "",
                            prior_text=text_buffer,
                        )
                        query_aborted = await execute_silent_retry_round(
                            client=self.client,
                            session_id=self.session_id,
                            retry_prompt=retry_prompt,
                            query_readonly_mode=self._query_readonly_mode,
                            readonly_tool_set=set(_READONLY_QUERY_TOOL_SET),
                            process_tool_result=self._process_tool_result,
                            get_fatal_validation_error=lambda: bool(
                                getattr(self, "_fatal_validation_error", False)
                            ),
                        )
                        if query_aborted:
                            self._query_readonly_aborted = True
                        if self._operations_buffer:
                            self.log.logger.info(
                                self.log.fmt(
                                    f"✅ 假完成自动修复成功：重试后生成 {len(self._operations_buffer)} 个操作"
                                )
                            )
                            if not self._has_generated_chart_operation(self._operations_buffer):
                                self._autofill_missing_summary_charts(command)
                            self._reflow_comprehensive_layout()
                            if self._requires_chart_delivery(command):
                                has_summary = self._has_summary_operations(self._operations_buffer)
                                has_chart = self._has_generated_chart_operation(self._operations_buffer)
                                if has_summary and not has_chart:
                                    self._operations_buffer = []
                                    yield {
                                        "type": "error",
                                        "content": "提示：系统已执行自动修复，但仍未生成图表，已阻止不完整交付，请重试。",
                                    }
                                    return
                            self.log.tool_result_processed(len(self._operations_buffer))
                            yield {"type": "operations", "content": self._operations_buffer}
                            if self._awaiting_followup or force_followup_execute or self._last_user_request:
                                self._awaiting_followup = False
                                self._last_user_request = None
                                self._last_question = None
                                self._last_context_snapshot = None
                            noop_retry_recovered = True
                        else:
                            self.log.logger.warning(
                                self.log.fmt("⚠️ 假完成自动修复失败：重试后仍无操作。")
                            )
                            text_buffer = (
                                "提示：上一轮未实际执行任何表格操作。"
                                "系统已自动尝试修复，但暂未成功落地分析结果。"
                                "请重试同一指令，我将强制重新执行分析链路。"
                            )

                    # 没有生成操作，记录详细信息用于调试
                    if not fallback_handled and not noop_retry_recovered:
                        self.log.logger.warning(
                            self.log.fmt(
                                f'⚠️ 未生成任何操作。工具调用次数: {tool_call_count}, '
                                f'工具结果次数: {tool_result_count}, 文本响应长度: {len(text_buffer)}, '
                                f'是否为补充执行: {force_followup_execute}, 是否等待补充信息: {self._awaiting_followup}'
                            )
                        )
                        # 如果文本响应不为空，记录文本内容（前500字符）
                        if text_buffer:
                            text_preview = text_buffer[:500] if len(text_buffer) > 500 else text_buffer
                            self.log.logger.info(self.log.fmt(f'Claude 返回的文本内容: {text_preview}'))
                        # 如果工具调用次数为0，说明 Claude 没有调用任何工具
                        if tool_call_count == 0:
                            self.log.logger.warning(self.log.fmt('⚠️ Claude 没有调用任何工具，可能只返回了文本响应'))
                        elif tool_call_count > 0 and tool_result_count == 0:
                            # 工具调用但无结果——仅在没有文本响应时才视为失败
                            # 只读查询工具不产生 operation，Agent 返回文本回答属正常流程
                            if not text_buffer.strip():
                                self.log.logger.warning(
                                    self.log.fmt(f'⚠️ 工具调用 ({tool_call_count}) 无结果且无文本响应，可能工具调用失败')
                                )
                                yield {"type": "error", "content": _USER_ERROR_RETRY}
                            else:
                                self.log.logger.info(
                                                                        self.log.fmt(f'ℹ️ 工具调用 ({tool_call_count}) 未产生操作， 但 Agent 已返回文本回答（{len(text_buffer)} 字符），属正常查询流程')
                                )
                        # 查询只读模式兜底：无操作时统一给出“非成功态”文本，避免 no_op_completion 假成功告警
                        if self._query_readonly_mode:
                            text_buffer = (
                                "提示：这是查询请求，系统已自动阻止写入类工具。"
                                "当前模型尝试了非只读工具，已被提前终止。"
                                "请重试同一问题；系统将仅允许只读查询工具并返回结论。"
                            )
                        if self._query_readonly_aborted:
                            # 覆盖模型自由文本，避免出现“已完成”语义导致 no_op_completion 假成功告警
                            text_buffer = (
                                "提示：查询流程已被保护机制接管。"
                                "检测到越权工具调用，当前轮次已中止，未对表格做任何修改。"
                                "请重试同一问题，我将仅使用只读查询工具返回最终答案。"
                            )
            
            text_buffer = self._strip_followup_questions_for_auto_analysis(text_buffer, command)
            self.log.command_complete(True, f'生成 {len(self._operations_buffer)} 个操作')
            yield {"type": "complete", "content": text_buffer}
                
        except Exception as e:
            self.log.ai_error(str(e))
            yield {"type": "error", "content": _USER_ERROR_RETRY}
        finally:
            self._inflight = max(0, self._inflight - 1)
            self.touch()
            # 关键：补充信息后的执行完成后，根据任务是否成功完成来决定是否重置标志
            # 如果任务成功完成（生成了操作），重置 _is_followup_execution，允许 Agent 正常关闭
            # 如果任务未完成（需要再次询问用户），保持 _is_followup_execution 为 True，保持连接
            if self._is_followup_execution:
                if self._operations_buffer:
                    # 任务成功完成，重置标志，允许 Agent 正常关闭
                    self._is_followup_execution = False
                    self.log.logger.info(self.log.fmt('✅ 补充信息后的执行成功完成，重置 _is_followup_execution = False，允许 Agent 正常关闭'))
                else:
                    # 任务未完成（可能需要再次询问用户），保持标志，保持连接
                    self.log.logger.info(self.log.fmt('⚠️ 补充信息后的执行未生成操作，_is_followup_execution 保持为 True，保持连接'))
    
    def _validate_and_add_operation(self, op: Dict[str, Any]) -> tuple:
        """
        验证操作参数并添加到缓冲区
        
        Args:
            op: 操作字典，包含 type 和 params
        
        Returns:
            tuple[bool, Optional[str]]: (是否成功添加, 错误信息)
        """
        excel_state = self._build_validation_excel_state()
        
        # 设置全局 Excel 状态上下文（用于参数规范化中的字段名转换）
        from .param_normalizer import set_excel_state
        set_excel_state(excel_state)
        
        op_type = op.get('type', 'unknown')
        op_params = op.get('params', {})
        canonical_op_type = resolve_operation_type(str(op_type))

        # 查询只读模式：硬拦截任何写操作（避免“问一个结果却改写整张表”）
        if self._query_readonly_mode and canonical_op_type not in READ_ONLY_OPERATIONS:
            error_msg = (
                f"{_SOFT_GUARD_PREFIX} 查询只读守卫拦截写操作: {canonical_op_type}。"
                "该请求为查询问句，默认只返回结果，不改写工作簿。"
            )
            self.log.logger.warning(self.log.fmt(f'❌ {error_msg}'))
            return False, error_msg
        
        # 记录验证前的操作信息
        self.log.logger.debug(
            self.log.fmt(f'开始验证操作: type={op_type}, sheet={op_params.get("sheet", "N/A")}, params_keys={list(op_params.keys())}')
        )
        
        # 在验证前，先规范化参数（确保类型正确）
        from .param_normalizer import normalize_operation_params
        try:
            normalized_params = normalize_operation_params(op_type, op_params.copy())
            normalized_params = self._cap_chart_data_range(op_type, normalized_params)
            # 图表行数超限预判——提前拒绝，不等前端报错
            if normalized_params.pop("_chart_rejected", False):
                reason = normalized_params.pop("_chart_rejected_reason", "图表数据行数过大")
                return False, reason
            normalized_params.pop("_chart_rejected_reason", None)
            # 汇总操作高基数日期列预检——提前拒绝，避免产出千行结果
            summarize_reject = self._precheck_summarize_high_cardinality(op_type, normalized_params)
            if summarize_reject:
                return False, summarize_reject
            comprehensive_reject = self._precheck_comprehensive_operation(op_type, normalized_params)
            if comprehensive_reject:
                return False, comprehensive_reject
            # 自动分析请求下，统一收敛「综合分析*」工作表命名，防止结果分叉
            normalized_params = self._normalize_auto_analysis_sheet_refs(op_type, normalized_params)
            # 自动分析请求下，关键发现文本强制模板化，避免自由发挥导致波动/无依据结论
            normalized_params = self._normalize_auto_analysis_insights(op_type, normalized_params)
            # 综合分析布局硬约束：块间距至少 2 空行，汇总必须紧跟分隔标题
            normalized_params = self._enforce_comprehensive_layout(op_type, normalized_params)
            # 更新 operation 中的 params
            op['params'] = normalized_params
            op_params = normalized_params
        except Exception as e:
            error_msg = f"参数规范化失败: {e}"
            self.log.logger.warning(self.log.fmt(f'❌ {error_msg}'))
            return False, error_msg
        
        validation = validate_operation_params(
            op_type,
            op_params,
            excel_state
        )
        
        if not validation.is_valid:
            error_msg = f"操作参数验证失败: {', '.join(validation.errors)}"
            self.log.logger.warning(self.log.fmt(f'❌ {error_msg}'))
            self.log.logger.debug(
                                self.log.fmt(f'操作详情: type={op_type},  params={json.dumps(op_params, ensure_ascii=False, indent=2)}')
            )
            self.log.logger.debug(
                                self.log.fmt(f'Excel状态: sheets={[s.get("name") for s in self.context.sheets]},  activeSheet={self.context.active_sheet}')
            )
            return False, error_msg
        
        # 验证通过，记录成功日志
        self.log.logger.debug(
                        self.log.fmt(f'✅ 操作验证通过: type={op_type},  sheet={op_params.get("sheet", "N/A")}')
        )

        # 执行期防呆：当 summarize_* 即将写入汇总表头时，移除已缓冲的“手工写表头”操作，避免双表头。
        self._drop_conflicting_manual_header_ops(op_type, op_params)

        # 执行期防呆：综合分析结果表只允许创建一次，重复 add_sheet("综合分析") 直接去重。
        if op_type == "add_sheet":
            sheet_name = str(op_params.get("name") or "").strip()
            if sheet_name == self._COMPREHENSIVE_SHEET_NAME:
                for exist in self._operations_buffer:
                    if str(exist.get("type") or "") != "add_sheet":
                        continue
                    ep = exist.get("params") or {}
                    if str(ep.get("name") or "").strip() == self._COMPREHENSIVE_SHEET_NAME:
                        self.log.logger.info(
                            self.log.fmt("综合分析 add_sheet 去重：检测到重复创建，已跳过本次重复操作")
                        )
                        return True, None
        
        self._operations_buffer.append(op)
        self.log.operation_generated(op_type, op_params)
        return True, None

    _COMPREHENSIVE_SHEET_NAME = "综合分析"
    _MIN_BLOCK_GAP_ROWS = 2
    _COMPREHENSIVE_BLOCK_WIDTH = 4
    _COMPREHENSIVE_COL_GAP = 2
    _COMPREHENSIVE_MAX_COL = 24
    _COMPREHENSIVE_BAND_GAP_ROWS = 3
    # 综合分析图表统一锚点行（用户体验对齐：所有图表从第 13 行开始）
    _COMPREHENSIVE_CHART_ROW = 13
    # 每个分析块预留的数据行预算（压缩布局，降低“统计与图表间距过大”）
    # 图表 dataRange.endRow = banner_row + 1 + DATA_BUDGET（不依赖实际写入行数）
    _COMPREHENSIVE_DATA_BUDGET = 24

    def _normalize_auto_analysis_sheet_refs(self, op_type: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """自动分析请求下，统一把「综合分析*」别名收敛到固定结果表名。"""
        if not self._active_auto_analysis_request:
            return params

        def _canon(name: Any) -> Optional[str]:
            if not isinstance(name, str):
                return None
            s = name.strip()
            if not s:
                return None
            if s == self._COMPREHENSIVE_SHEET_NAME:
                return s
            if "综合分析" in s:
                return self._COMPREHENSIVE_SHEET_NAME
            return s

        key_candidates = ["sheet", "targetSheet", "target_sheet"]
        if op_type in ("add_sheet", "set_active_sheet"):
            key_candidates.append("name")

        changed = False
        for k in key_candidates:
            if k not in params:
                continue
            old = params.get(k)
            new = _canon(old)
            if isinstance(old, str) and isinstance(new, str) and old.strip() != new:
                params[k] = new
                changed = True

        if changed:
            self.log.logger.info(
                self.log.fmt(f"自动分析工作表名归一: op={op_type} -> {self._COMPREHENSIVE_SHEET_NAME}")
            )
        return params

    def _build_deterministic_insight_rows(self, sheet_name: str, max_items: int = 3) -> List[List[str]]:
        """
        基于已生成的数据块标题，输出确定性的关键发现文案。
        只做“已完成事项 + 建议关注点”描述，禁止凭空生成业务结论。
        """
        titles: List[str] = []
        seen = set()
        for op in self._operations_buffer:
            if str(op.get("type") or "") != "set_cell_value":
                continue
            p = op.get("params") or {}
            if str(p.get("sheet") or "").strip() != sheet_name:
                continue
            raw = p.get("value")
            if not _is_data_block_section_banner(raw):
                continue
            title = _normalize_section_banner_text(raw)
            if not title or title in seen:
                continue
            seen.add(title)
            titles.append(title)
            if len(titles) >= max_items:
                break

        if not titles:
            titles = ["当前数据核心维度分析"]

        rows: List[List[str]] = []
        for idx, title in enumerate(titles, start=1):
            # 固定写满 4 列，覆盖旧汇总残留，防止“第1列是洞察、第2-4列仍是旧数值”脏数据串行。
            rows.append([f"{idx}. 已完成「{title}」汇总与图表，请重点关注头部与尾部类别差异。", "", "", ""])
        return rows

    def _normalize_auto_analysis_insights(self, op_type: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        自动分析场景下，将 LLM 自由发挥的关键发现替换为确定性模板文案。
        触发条件：set_range_values + 目标为综合分析结果表 + values 为文本列表。
        """
        if not self._active_auto_analysis_request or op_type != "set_range_values":
            return params

        sheet_name = str(params.get("sheet") or "").strip()
        if sheet_name != self._COMPREHENSIVE_SHEET_NAME:
            return params

        values = params.get("values")
        if not isinstance(values, list) or not values:
            return params

        text_cells: List[str] = []
        for row in values:
            if isinstance(row, list) and row:
                text_cells.append(str(row[0] if row[0] is not None else "").strip())

        if not text_cells:
            return params

        looks_like_insight_block = any(
            ("关键发现" in t) or re.match(r"^\d+[\.、]\s*", t) for t in text_cells if t
        )
        if not looks_like_insight_block:
            return params

        params["values"] = self._build_deterministic_insight_rows(sheet_name)
        self.log.logger.info(self.log.fmt("关键发现模板化：已替换为确定性文案（基于已生成分析块）"))
        return params

    @staticmethod
    def _get_int_param(params: Dict[str, Any], *keys: str) -> Optional[int]:
        for k in keys:
            v = params.get(k)
            try:
                if v is not None:
                    return int(v)
            except (TypeError, ValueError):
                continue
        return None

    @staticmethod
    def _set_int_param(params: Dict[str, Any], value: int, *keys: str) -> None:
        for k in keys:
            if k in params:
                params[k] = int(value)
        if not any(k in params for k in keys) and keys:
            params[keys[0]] = int(value)

    def _op_effective_max_row(self, op_type: str, params: Dict[str, Any], sheet_name: str) -> Optional[int]:
        """估算单个操作在目标 sheet 上占用到的最大行号（用于综合分析块间距硬约束）。"""
        if op_type == "create_chart":
            op_sheet = str(params.get("sheet") or "").strip()
            if op_sheet != sheet_name:
                return None
            dr = params.get("dataRange") or params.get("data_range")
            _, end_row = self._extract_chart_row_span(dr)
            return int(end_row) if isinstance(end_row, int) else None

        if op_type == "set_cell_value":
            op_sheet = str(params.get("sheet") or "").strip()
            if op_sheet != sheet_name:
                return None
            return self._get_int_param(params, "row")

        if op_type in ("summarize_metrics_by_column", "summarize_by_column"):
            target_sheet = str(params.get("targetSheet") or params.get("target_sheet") or "").strip()
            if target_sheet != sheet_name:
                return None
            # summarize 实际高度未知；targetRow 至少占用该行
            return self._get_int_param(params, "targetRow", "target_row")

        if op_type == "set_range_values":
            op_sheet = str(params.get("sheet") or "").strip()
            if op_sheet != sheet_name:
                return None
            start_row = self._get_int_param(params, "startRow", "start_row")
            values = params.get("values")
            if start_row is None:
                return None
            if isinstance(values, list) and values:
                return start_row + max(1, len(values)) - 1
            return start_row

        return None

    def _buffer_sheet_max_row(self, sheet_name: str) -> int:
        max_row = 0
        for op in self._operations_buffer:
            op_type = str(op.get("type") or "")
            params = op.get("params") or {}
            r = self._op_effective_max_row(op_type, params, sheet_name)
            if isinstance(r, int) and r > max_row:
                max_row = r
        return max_row

    def _latest_banner_row(self, sheet_name: str) -> Optional[int]:
        for op in reversed(self._operations_buffer):
            if str(op.get("type") or "") != "set_cell_value":
                continue
            p = op.get("params") or {}
            if str(p.get("sheet") or "").strip() != sheet_name:
                continue
            value = str(p.get("value") or "").strip()
            if not _is_section_banner_title(value):
                continue
            return self._get_int_param(p, "row")
        return None

    def _latest_preceding_block_title_row(self, sheet_name: str, upper_row_exclusive: Optional[int]) -> Optional[int]:
        """
        在指定行之前，回溯最近的“可能是区块标题”的 A 列 set_cell_value。
        兜底场景：模型输出了商业标题但未以“分析”结尾，导致严格标题识别失败。
        """
        for op in reversed(self._operations_buffer):
            if str(op.get("type") or "") != "set_cell_value":
                continue
            p = op.get("params") or {}
            if str(p.get("sheet") or "").strip() != sheet_name:
                continue
            row = self._get_int_param(p, "row")
            if row is None:
                continue
            if upper_row_exclusive is not None and row >= upper_row_exclusive:
                continue
            col = self._get_int_param(p, "col")
            if col != 1:
                continue
            value = str(p.get("value") or "").strip()
            if not value:
                continue
            normalized = _normalize_section_banner_text(value)
            if not normalized:
                continue
            if any(k in normalized for k in _BANNER_NON_DATA_KEYS):
                continue
            return row
        return None

    def _enforce_comprehensive_layout(self, op_type: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        综合分析布局硬约束：
        1) 区块标题（=== xxx 分析 ===）必须与上一块至少间隔 2 空行
        2) summarize_* 的 targetRow 必须 = 最新区块标题行 + 1
        """
        if op_type == "set_cell_value":
            sheet_name = str(params.get("sheet") or "").strip()
            value = str(params.get("value") or "").strip()
            if sheet_name != self._COMPREHENSIVE_SHEET_NAME or not _is_section_banner_title(value):
                return params
            # 输出统一为商业样式标题（去掉 === 包裹）
            params["value"] = _normalize_section_banner_text(value)
            # 分隔标题统一放在 A 列，避免同一块在 E 列重复写标题造成块识别错乱
            if self._get_int_param(params, "col") != 1:
                self._set_int_param(params, 1, "col")
            current_row = self._get_int_param(params, "row")
            if current_row is None:
                return params
            occupied_max = self._buffer_sheet_max_row(sheet_name)
            if occupied_max > 0:
                required_row = occupied_max + self._MIN_BLOCK_GAP_ROWS + 1
                if current_row < required_row:
                    self._set_int_param(params, required_row, "row")
                    self.log.logger.info(
                        self.log.fmt(
                            f"综合分析块间距修正: 标题行 {current_row} -> {required_row} (sheet={sheet_name}, occupied_max={occupied_max})"
                        )
                    )
            return params

        if op_type in ("summarize_metrics_by_column", "summarize_by_column"):
            target_sheet = str(params.get("targetSheet") or params.get("target_sheet") or "").strip()
            if target_sheet != self._COMPREHENSIVE_SHEET_NAME:
                return params
            # 综合分析统一从 A 列起表，避免左右拼接造成视觉“粘连”
            self._set_int_param(params, 1, "targetCol", "target_col")
            current_row = self._get_int_param(params, "targetRow", "target_row")
            banner_row = self._latest_banner_row(target_sheet)
            # 兜底：优先回溯 current_row 之前最近的 A 列标题，避免误把后续块回拉到第 2 行
            fallback_banner_row = self._latest_preceding_block_title_row(
                target_sheet,
                current_row if current_row is not None else None,
            )
            if fallback_banner_row is not None:
                banner_row = fallback_banner_row
            if banner_row is None:
                return params
            expected_row = banner_row + 1
            if current_row is None or current_row != expected_row:
                self._set_int_param(params, expected_row, "targetRow", "target_row")
                self.log.logger.info(
                    self.log.fmt(
                        f"综合分析汇总对齐修正: targetRow {current_row} -> {expected_row} (sheet={target_sheet})"
                    )
                )
            return params

        return params

    def _parse_field_list(self, raw: Any) -> List[Any]:
        if isinstance(raw, list):
            return raw
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                return []
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return parsed
            except (json.JSONDecodeError, TypeError):
                pass
            return [s]
        return []

    def _resolve_field_to_col_index(self, sheet_name: str, field: Any) -> Optional[int]:
        """把 rowFields/valueField 中的列引用解析成 1-based 列号。"""
        if isinstance(field, int):
            return field if field > 0 else None
        if isinstance(field, str):
            s = field.strip()
            if not s:
                return None
            try:
                i = int(s)
                return i if i > 0 else None
            except (TypeError, ValueError):
                pass
            sheet = self._get_sheet_meta(sheet_name)
            if not sheet:
                return None
            headers = sheet.get("headers") or []
            if isinstance(headers, list):
                for idx, h in enumerate(headers, start=1):
                    if isinstance(h, dict):
                        if str(h.get("value") or "").strip() == s:
                            hcol = h.get("col")
                            try:
                                return int(hcol) if hcol is not None else idx
                            except (TypeError, ValueError):
                                return idx
                    elif isinstance(h, str) and h.strip() == s:
                        return idx
        return None

    def _is_high_cardinality_dimension(self, sheet_name: str, col_index: int) -> bool:
        p = self._sample_col_profile(sheet_name, col_index)
        if p["count"] < 8:
            return False
        return p["distinct_ratio"] >= 0.75

    def _precheck_comprehensive_operation(self, op_type: str, params: Dict[str, Any]) -> Optional[str]:
        """
        综合分析模式预检：
        - create_pivot_data 仅在维度低基数时允许；高基数维度拒绝，避免杂块污染布局与图表。
        """
        if op_type != "create_pivot_data":
            return None
        target_sheet = str(params.get("targetSheet") or params.get("target_sheet") or "").strip()
        if target_sheet != self._COMPREHENSIVE_SHEET_NAME:
            return None
        source_sheet = str(params.get("sheet") or "").strip()
        row_fields = self._parse_field_list(params.get("rowFields") or params.get("row_fields"))
        if not row_fields:
            return "create_pivot_data 缺少 rowFields，无法判定分组维度。"
        row_col = self._resolve_field_to_col_index(source_sheet, row_fields[0])
        if row_col is None:
            return "create_pivot_data 的 rowFields 无法映射到有效列，建议改用 summarize_*。"
        if self._is_high_cardinality_dimension(source_sheet, row_col):
            return "综合分析中该透视分组维度基数过高，易产出超长明细块。请改用低基数维度（如渠道/品类/客户分层）或 summarize_*。"
        return None

    @staticmethod
    def _parse_data_range_meta(data_range: Any) -> Optional[Dict[str, Any]]:
        """解析 create_chart.dataRange（A1 / dict / JSON str），返回规范结构。"""
        if isinstance(data_range, dict):
            sr, er = ExcelAgent._extract_row_span_from_dict(data_range)
            if sr is None or er is None:
                return None
            # 兼容扁平与嵌套 col 字段
            sc = data_range.get("startCol") or data_range.get("start_col")
            ec = data_range.get("endCol") or data_range.get("end_col")
            if sc is None or ec is None:
                st = data_range.get("start") or {}
                en = data_range.get("end") or {}
                sc = st.get("col")
                ec = en.get("col")
            try:
                return {"kind": "dict", "startRow": int(sr), "endRow": int(er), "startCol": int(sc), "endCol": int(ec)}
            except (TypeError, ValueError):
                return None
        if isinstance(data_range, str):
            parsed = _parse_a1_range(data_range)
            if parsed:
                return {
                    "kind": "a1",
                    "startRow": int(parsed["startRow"]),
                    "endRow": int(parsed["endRow"]),
                    "startCol": int(parsed["startCol"]),
                    "endCol": int(parsed["endCol"]),
                }
            try:
                obj = json.loads(data_range)
            except (json.JSONDecodeError, TypeError):
                return None
            return ExcelAgent._parse_data_range_meta(obj)
        return None

    @staticmethod
    def _to_a1_range(start_row: int, start_col: int, end_row: int, end_col: int) -> str:
        def _col_to_letters(n: int) -> str:
            letters = ""
            col = int(n)
            while col > 0:
                col, rem = divmod(col - 1, 26)
                letters = chr(65 + rem) + letters
            return letters
        return f"{_col_to_letters(start_col)}{start_row}:{_col_to_letters(end_col)}{end_row}"

    def _shift_chart_data_range(self, params: Dict[str, Any], delta_row: int, delta_col: int) -> None:
        if delta_row == 0 and delta_col == 0:
            return
        key = "dataRange" if "dataRange" in params else ("data_range" if "data_range" in params else None)
        if not key:
            return
        raw = params.get(key)
        meta = self._parse_data_range_meta(raw)
        if not meta:
            return
        sr = max(1, int(meta["startRow"]) + delta_row)
        er = max(sr, int(meta["endRow"]) + delta_row)
        sc = max(1, int(meta["startCol"]) + delta_col)
        ec = max(sc, int(meta["endCol"]) + delta_col)
        if isinstance(raw, dict):
            if "start" in raw or "end" in raw:
                params[key] = {
                    "start": {"row": sr, "col": sc},
                    "end": {"row": er, "col": ec},
                }
            else:
                params[key] = {"startRow": sr, "startCol": sc, "endRow": er, "endCol": ec}
            return
        if isinstance(raw, str):
            # A1 / JSON string 均统一回写为 A1，降低后续解析分支复杂度
            params[key] = self._to_a1_range(sr, sc, er, ec)

    def _block_max_row(self, block_ops: List[Dict[str, Any]], sheet_name: str) -> int:
        block_max = 0
        for op in block_ops:
            op_type = str(op.get("type") or "")
            params = op.get("params") or {}
            r = self._op_effective_max_row(op_type, params, sheet_name)
            if isinstance(r, int):
                block_max = max(block_max, r)
        return block_max

    def _reflow_comprehensive_layout(self) -> None:
        """
        对「综合分析」按块统一重排（列分区布局）：
        - 每个数据块占用固定列宽，块间留 2 空列
        - 图表固定放在所属数据块下方
        - 超过最大列宽时自动换到下一行带（row band）
        """
        sheet_name = self._COMPREHENSIVE_SHEET_NAME
        ops = self._operations_buffer
        if not ops:
            return

        banner_indexes: List[int] = []
        for i, op in enumerate(ops):
            if str(op.get("type") or "") != "set_cell_value":
                continue
            p = op.get("params") or {}
            if str(p.get("sheet") or "").strip() != sheet_name:
                continue
            if _is_section_banner_title(p.get("value")):
                banner_indexes.append(i)

        if len(banner_indexes) <= 1:
            return

        band_row = 1
        band_col = 1
        band_max_row = 1
        block_width = self._COMPREHENSIVE_BLOCK_WIDTH
        col_gap = self._COMPREHENSIVE_COL_GAP
        max_col = self._COMPREHENSIVE_MAX_COL
        remove_indices: List[int] = []

        for b_i, start_idx in enumerate(banner_indexes):
            end_idx = banner_indexes[b_i + 1] if b_i + 1 < len(banner_indexes) else len(ops)
            block_ops = ops[start_idx:end_idx]
            has_summary_in_block = False
            for op0 in block_ops:
                op0_type = str(op0.get("type") or "")
                if op0_type not in ("summarize_metrics_by_column", "summarize_by_column"):
                    continue
                p0 = op0.get("params") or {}
                ts0 = str(p0.get("targetSheet") or p0.get("target_sheet") or "").strip()
                if ts0 == sheet_name:
                    has_summary_in_block = True
                    break

            # 无汇总的块不允许保留图表：避免出现“图表范围无有效数值”前端报错。
            if not has_summary_in_block:
                for abs_idx in range(start_idx + 1, end_idx):
                    op_abs = ops[abs_idx]
                    if str(op_abs.get("type") or "") != "create_chart":
                        continue
                    p_abs = op_abs.get("params") or {}
                    if str(p_abs.get("sheet") or "").strip() == sheet_name:
                        remove_indices.append(abs_idx)

            banner_op = ops[start_idx]
            banner_params = banner_op.get("params") or {}
            old_banner_row = self._get_int_param(banner_params, "row") or band_row
            old_banner_col = self._get_int_param(banner_params, "col") or 1

            if band_col + block_width - 1 > max_col:
                band_row = max(1, band_max_row + self._COMPREHENSIVE_BAND_GAP_ROWS)
                band_col = 1
                band_max_row = band_row

            new_banner_row = max(1, band_row)
            new_banner_col = max(1, band_col)
            delta_row = new_banner_row - old_banner_row
            delta_col = new_banner_col - old_banner_col
            self._set_int_param(banner_params, new_banner_row, "row")
            self._set_int_param(banner_params, new_banner_col, "col")

            # 槽位边界：列范围 [new_banner_col, slot_col_max]，行范围 [new_banner_row, data_row_max]
            # 任何写操作超出边界时强制裁剪，防止列/行溢出覆盖相邻槽位
            slot_col_max = new_banner_col + block_width - 1
            data_row_max = new_banner_row + 1 + self._COMPREHENSIVE_DATA_BUDGET

            for op in block_ops[1:]:
                op_type = str(op.get("type") or "")
                p = op.get("params") or {}
                if op_type in ("summarize_metrics_by_column", "summarize_by_column"):
                    target_sheet = str(p.get("targetSheet") or p.get("target_sheet") or "").strip()
                    if target_sheet == sheet_name:
                        self._set_int_param(p, new_banner_row + 1, "targetRow", "target_row")
                        self._set_int_param(p, new_banner_col, "targetCol", "target_col")
                    continue

                op_sheet = str(p.get("sheet") or "").strip()
                if op_sheet != sheet_name:
                    continue

                if op_type == "set_cell_value":
                    r = self._get_int_param(p, "row")
                    c = self._get_int_param(p, "col")
                    if r is not None:
                        new_r = max(new_banner_row, min(data_row_max, r + delta_row))
                        self._set_int_param(p, new_r, "row")
                    if c is not None:
                        new_c = max(new_banner_col, min(slot_col_max, c + delta_col))
                        self._set_int_param(p, new_c, "col")
                elif op_type in ("set_range_values", "set_range_style", "clear_formatting", "conditional_format"):
                    sr = self._get_int_param(p, "startRow", "start_row")
                    er = self._get_int_param(p, "endRow", "end_row")
                    sc = self._get_int_param(p, "startCol", "start_col")
                    ec = self._get_int_param(p, "endCol", "end_col")
                    if sr is not None:
                        self._set_int_param(p, max(new_banner_row, sr + delta_row), "startRow", "start_row")
                    if er is not None:
                        # 行溢出裁剪：超出数据预算区则截断到预算边界
                        self._set_int_param(p, min(data_row_max, max(new_banner_row, er + delta_row)), "endRow", "end_row")
                    if sc is not None:
                        self._set_int_param(p, max(new_banner_col, sc + delta_col), "startCol", "start_col")
                    if ec is not None:
                        # 列溢出裁剪：超出槽位宽度则截断到槽位右边界
                        self._set_int_param(p, min(slot_col_max, max(new_banner_col, ec + delta_col)), "endCol", "end_col")
                elif op_type == "create_chart":
                    row = self._get_int_param(p, "row")
                    col = self._get_int_param(p, "col")
                    if row is not None:
                        self._set_int_param(p, max(1, row + delta_row), "row")
                    if col is not None:
                        self._set_int_param(p, max(1, col + delta_col), "col")
                    self._shift_chart_data_range(p, delta_row, delta_col)

            # ---------------------------------------------------------------
            # 图表位置与数据范围：使用固定预算，不依赖实际写入行数
            # 原因：后端感知不到前端 summarize 实际输出了几行；
            # 使用固定预算 endRow = banner_row + 1 + DATA_BUDGET 与前端
            # _COMPREHENSIVE_MAX_ROWS=60 对齐，前端 ECharts 自动裁空行。
            # ---------------------------------------------------------------
            chart_data_start = new_banner_row + 1  # 表头行
            chart_data_end = new_banner_row + 1 + self._COMPREHENSIVE_DATA_BUDGET
            # 图表位置固定锚点：行=13，列=当前块起始列
            chart_row = self._COMPREHENSIVE_CHART_ROW

            for op in block_ops:
                if str(op.get("type") or "") != "create_chart":
                    continue
                p = op.get("params") or {}
                if str(p.get("sheet") or "").strip() != sheet_name:
                    continue
                # 设定图表位置
                self._set_int_param(p, chart_row, "row")
                self._set_int_param(p, new_banner_col, "col")
                # 强制覆盖 dataRange 为固定预算区间（与前端 _COMPREHENSIVE_MAX_ROWS 对齐）
                fixed_range: Dict[str, int] = {
                    "startRow": chart_data_start,
                    "endRow": chart_data_end,
                    "startCol": new_banner_col,
                    "endCol": new_banner_col + block_width - 1,
                }
                if "dataRange" in p:
                    p["dataRange"] = fixed_range
                else:
                    p["data_range"] = fixed_range

            # 多图同页去同质化兜底：若模型全给了 column，按块序换成 bar/line/area。
            block_chart_ops: List[Dict[str, Any]] = []
            for op in block_ops:
                if str(op.get("type") or "") != "create_chart":
                    continue
                p = op.get("params") or {}
                if str(p.get("sheet") or "").strip() == sheet_name:
                    block_chart_ops.append(op)
            if len(block_chart_ops) >= 2:
                preferred_cycle = ("column", "bar", "line", "area")
                for idx2, op2 in enumerate(block_chart_ops):
                    p2 = op2.get("params") or {}
                    ct = str(p2.get("chartType") or p2.get("chart_type") or "").strip().lower()
                    if not ct or ct == "column":
                        new_ct = preferred_cycle[min(idx2, len(preferred_cycle) - 1)]
                        if "chartType" in p2:
                            p2["chartType"] = new_ct
                        else:
                            p2["chart_type"] = new_ct

            # 预留 band 高度时同时考虑数据预算区，避免超过 4 块换行后与上一 band 数据区重叠
            block_end_row = max(data_row_max, chart_row + 16)
            band_max_row = max(band_max_row, block_end_row)
            band_col = new_banner_col + block_width + col_gap

        if remove_indices:
            for idx in sorted(set(remove_indices), reverse=True):
                ops.pop(idx)
            self.log.logger.info(
                self.log.fmt(f"综合分析图表清理：移除 {len(set(remove_indices))} 个无汇总支撑的图表操作")
            )

    # 前端硬上限（与 excelOperations.js MAX_CHART_ROWS_HARD 对齐）
    _FRONTEND_CHART_HARD_CAP = 1200

    def _extract_chart_row_span(self, data_range: Any) -> tuple:
        """从 dataRange 提取 (start_row, end_row)，兼容扁平/嵌套/A1/JSON字符串四种格式。"""
        if isinstance(data_range, dict):
            return self._extract_row_span_from_dict(data_range)
        if isinstance(data_range, str):
            # A1 格式（如 "A1:D50"）
            parsed = _parse_a1_range(data_range)
            if parsed:
                return parsed["startRow"], parsed["endRow"]
            # JSON 字符串（LLM 有时将 dict 序列化为字符串传入）
            try:
                obj = json.loads(data_range)
                if isinstance(obj, dict):
                    return self._extract_row_span_from_dict(obj)
            except (json.JSONDecodeError, TypeError):
                pass
        return None, None

    @staticmethod
    def _extract_row_span_from_dict(d: dict) -> tuple:
        """从 dict 提取行区间，兼容扁平与嵌套两种格式。"""
        sr = d.get("startRow") or d.get("start_row")
        er = d.get("endRow") or d.get("end_row")
        if sr is not None and er is not None:
            try:
                return int(sr), int(er)
            except (TypeError, ValueError):
                pass
        st = d.get("start") or {}
        en = d.get("end") or {}
        sr2, er2 = st.get("row"), en.get("row")
        if sr2 is not None and er2 is not None:
            try:
                return int(sr2), int(er2)
            except (TypeError, ValueError):
                pass
        return None, None

    def _cap_chart_data_range(self, op_type: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        执行期防呆：在操作入缓冲区前预判图表行数是否超前端硬上限。
        超限时直接标记 `_chart_rejected`（调用方据此拒绝入缓冲），而非静默截断数据区——
        截断会导致图表只展示局部、用户看到"数据不全"的假成功，不如当场拒绝并给出可恢复路径。
        """
        if op_type != "create_chart":
            return params

        data_range = params.get("dataRange") or params.get("data_range")
        sr, er = self._extract_chart_row_span(data_range)
        if sr is None or er is None:
            return params

        row_span = er - sr + 1
        if row_span <= self._FRONTEND_CHART_HARD_CAP:
            return params

        # 超限：标记拒绝，调用方读取 _chart_rejected 后拒绝入缓冲
        params["_chart_rejected"] = True
        params["_chart_rejected_reason"] = (
            f"图表数据行数过大（{row_span} 行），请先汇总到 {self._FRONTEND_CHART_HARD_CAP} 行以内再制图。"
        )
        chart_type = str(params.get("chartType") or params.get("chart_type") or "column").lower()
        self.log.logger.warning(
            self.log.fmt(
                f"chart 预判拒绝: type={chart_type}, rows={row_span} > hard_cap={self._FRONTEND_CHART_HARD_CAP}"
            )
        )
        return params

    # ── 日期列关键词（用于高基数预检）──
    _DATE_COL_KEYWORDS = re.compile(
        r"日期|时间|date|time|年|月|week|quarter|季度",
        re.IGNORECASE,
    )
    _DATE_VALUE_RE = re.compile(
        r"^\s*(\d{4}[-/年]\d{1,2}([-/月]\d{1,2})?日?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*$"
    )
    _ID_COL_KEYWORDS = re.compile(
        r"\b(id|sku)\b|编号|编码|货号|订单号|产品id|客户id",
        re.IGNORECASE,
    )
    _CODE_LIKE_VALUE_RE = re.compile(r"^[A-Za-z]{0,3}\d{3,}$")
    # 源数据行数超此阈值 + group_by 列名命中日期关键词 → 拒绝汇总（汇总结果行数 ≈ distinct dates）
    _SUMMARIZE_HIGH_CARDINALITY_THRESHOLD = 200
    # 通用高基数风险阈值（与日期无关）：大样本 + 高去重分组列
    _SUMMARIZE_GENERIC_HIGH_CARD_ROWS = 800
    _SUMMARIZE_GENERIC_HIGH_CARD_DISTINCT_RATIO = 0.78

    def _get_sheet_meta(self, sheet_name: str) -> Optional[Dict[str, Any]]:
        for sheet in self.context.sheets:
            if isinstance(sheet, dict) and sheet.get("name") == sheet_name:
                return sheet
        return None

    def _get_sample_col_values(self, sheet_name: str, col_index: int, max_count: int = 20) -> List[str]:
        """
        从 excel_state.sampleData 提取某列样本值（1-based col）。
        兼容 sampleData 行为 list/tuple 场景。
        """
        if col_index <= 0:
            return []
        sheet = self._get_sheet_meta(sheet_name)
        if not sheet:
            return []
        sample = sheet.get("sampleData") or []
        values: List[str] = []
        for row in sample:
            cell = None
            if isinstance(row, (list, tuple)):
                if len(row) >= col_index:
                    cell = row[col_index - 1]
            if cell is None:
                continue
            text = str(cell).strip()
            if text == "":
                continue
            values.append(text)
            if len(values) >= max_count:
                break
        return values

    def _is_date_like_high_cardinality_in_sample(self, sheet_name: str, col_index: int) -> bool:
        values = self._get_sample_col_values(sheet_name, col_index, max_count=20)
        if len(values) < 6:
            return False
        date_like = [v for v in values if self._DATE_VALUE_RE.match(v)]
        # 至少 60% 像日期，且去重率高（>=0.8）才判为“日期高基数分组风险”
        if len(date_like) / len(values) < 0.6:
            return False
        unique_ratio = len(set(date_like)) / max(1, len(date_like))
        return unique_ratio >= 0.8

    def _is_numeric_like(self, text: str) -> bool:
        try:
            float(str(text).replace(",", ""))
            return True
        except (TypeError, ValueError):
            return False

    def _estimate_col_count(self, sheet_name: str) -> int:
        sheet = self._get_sheet_meta(sheet_name)
        if not sheet:
            return 0
        headers = sheet.get("headers") or []
        if isinstance(headers, list) and headers:
            if isinstance(headers[0], dict):
                cols = [int(h.get("col")) for h in headers if isinstance(h, dict) and h.get("col") is not None]
                if cols:
                    return max(cols)
            return len(headers)
        sample = sheet.get("sampleData") or []
        max_len = 0
        for row in sample:
            if isinstance(row, (list, tuple)):
                max_len = max(max_len, len(row))
        return max_len

    def _sample_col_profile(self, sheet_name: str, col_index: int) -> Dict[str, float]:
        values = self._get_sample_col_values(sheet_name, col_index, max_count=20)
        if not values:
            return {"count": 0.0, "distinct_ratio": 1.0, "non_numeric_ratio": 0.0}
        distinct_ratio = len(set(values)) / len(values)
        non_numeric = [v for v in values if not self._is_numeric_like(v)]
        non_numeric_ratio = len(non_numeric) / len(values)
        return {
            "count": float(len(values)),
            "distinct_ratio": float(distinct_ratio),
            "non_numeric_ratio": float(non_numeric_ratio),
        }

    def _is_id_like_dimension(self, sheet_name: str, col_index: int, col_header: str) -> bool:
        """判断分组列是否是 ID/编码类维度（不适合作为自动分析分组轴）。"""
        header = str(col_header or "").strip()
        if header and self._ID_COL_KEYWORDS.search(header):
            return True
        values = self._get_sample_col_values(sheet_name, col_index, max_count=40)
        if len(values) < 8:
            return False
        non_empty = [v.strip() for v in values if isinstance(v, str) and v.strip()]
        if len(non_empty) < 8:
            return False
        code_like_hits = sum(1 for v in non_empty if self._CODE_LIKE_VALUE_RE.match(v))
        return (code_like_hits / max(1, len(non_empty))) >= 0.65

    def _pick_fallback_group_col(self, sheet_name: str, current_group_col: int, sum_col: int) -> Optional[int]:
        """为日期高基数组选择更稳妥的低基数分组列。"""
        total_cols = self._estimate_col_count(sheet_name)
        if total_cols <= 0:
            return None
        best_col: Optional[int] = None
        best_score = -1.0
        for col in range(1, total_cols + 1):
            if col in (current_group_col, sum_col):
                continue
            header = (self._get_col_header(sheet_name, col) or "").strip()
            if self._DATE_COL_KEYWORDS.search(header):
                continue
            if self._is_id_like_dimension(sheet_name, col, header):
                continue
            if self._is_date_like_high_cardinality_in_sample(sheet_name, col):
                continue
            p = self._sample_col_profile(sheet_name, col)
            if p["count"] < 4:
                continue
            # 偏好：非数值列 + 去重率较低（可分组）
            score = (p["non_numeric_ratio"] * 0.6) + ((1.0 - p["distinct_ratio"]) * 0.4)
            if score > best_score:
                best_score = score
                best_col = col
        if best_score < 0.45:
            return None
        return best_col

    def _precheck_summarize_high_cardinality(
        self, op_type: str, params: Dict[str, Any]
    ) -> Optional[str]:
        """
        预检 summarize_* 操作：若分组列为日期列且源数据量大，
        汇总结果可达数千行，后续图表必然超限。提前拒绝并给出可恢复路径。
        返回 None 表示通过，返回 str 表示拒绝原因。
        """
        if op_type not in ("summarize_metrics_by_column", "summarize_by_column"):
            return None

        try:
            start_row = int(params.get("startRow") or params.get("start_row") or 0)
            end_row = int(params.get("endRow") or params.get("end_row") or 0)
        except (TypeError, ValueError):
            return None

        source_rows = end_row - start_row + 1

        # 获取 group_by 列号 → 从 context.sheets 查列名
        try:
            group_col = int(params.get("groupByCol") or params.get("group_by_col") or 0)
        except (TypeError, ValueError):
            return None

        sheet_name = str(params.get("sheet") or "").strip()
        col_header = self._get_col_header(sheet_name, group_col)
        if not col_header:
            return None
        id_like_group_col = self._is_id_like_dimension(sheet_name, group_col, col_header)

        header_date_like = bool(self._DATE_COL_KEYWORDS.search(col_header))
        sample_date_high_card = self._is_date_like_high_cardinality_in_sample(sheet_name, group_col)
        profile = self._sample_col_profile(sheet_name, group_col)
        sample_generic_high_card = (
            profile["count"] >= 10
            and profile["distinct_ratio"] >= self._SUMMARIZE_GENERIC_HIGH_CARD_DISTINCT_RATIO
        )
        # 两条命中任意一条即拒绝：
        # 1) 大样本 + 日期语义表头
        # 2) 样本值本身显示为高基数日期（即使表头没写“日期”）
        # 3) 通用高基数维度（大样本 + 高去重率），不限日期
        if not (
            id_like_group_col
            or
            (source_rows > self._SUMMARIZE_HIGH_CARDINALITY_THRESHOLD and header_date_like)
            or sample_date_high_card
            or (
                source_rows > self._SUMMARIZE_GENERIC_HIGH_CARD_ROWS
                and sample_generic_high_card
            )
        ):
            return None

        sum_col = 0
        try:
            sum_col = int(params.get("sumCol") or params.get("sum_col") or 0)
        except (TypeError, ValueError):
            sum_col = 0

        fallback_col = self._pick_fallback_group_col(sheet_name, group_col, sum_col)
        if fallback_col:
            fallback_header = self._get_col_header(sheet_name, fallback_col) or f"第{fallback_col}列"
            params["groupByCol"] = fallback_col
            if "group_by_col" in params:
                params["group_by_col"] = fallback_col
            reason_prefix = "ID/编码分组自动纠偏" if id_like_group_col else "日期高基数自动纠偏"
            self.log.logger.info(
                self.log.fmt(
                    f"{reason_prefix}: groupByCol {group_col}({col_header}) -> {fallback_col}({fallback_header})"
                )
            )
            return None

        if id_like_group_col:
            return (
                f"分组列「{col_header}」属于 ID/编码类高基数字段，不适合用于自动分析分组。"
                f"请改用低基数业务维度（如渠道/品类/客户分层/销售人员）后重试。"
            )

        if source_rows > self._SUMMARIZE_GENERIC_HIGH_CARD_ROWS and sample_generic_high_card:
            return (
                f"分组列「{col_header}」样本去重率过高（{profile['distinct_ratio']:.2f}），"
                f"在 {source_rows} 行数据上会产出超长汇总区，后续图表易超限。"
                f"请改用低基数维度先汇总（如渠道/品类/客户分层等），或先做降维再制图。"
            )

        return (
            f"分组列「{col_header}」疑似日期列，源数据 {source_rows} 行，"
            f"按日期直接分组可能产生上千行结果、后续图表必然超限。"
            f"请先按年/月粒度聚合后再汇总（可用 apply_custom_formula 构造年月辅助列，"
            f"再以辅助列作为 group_by_col）。"
        )

    def _get_col_header(self, sheet_name: str, col_index: int) -> Optional[str]:
        """从 context.sheets 中获取指定工作表指定列的表头名"""
        for sheet in self.context.sheets:
            if not isinstance(sheet, dict):
                continue
            if sheet.get("name") != sheet_name:
                continue
            headers = sheet.get("headers") or []
            # headers 可能是 [{col, value},...] 或 [str,...]
            if isinstance(headers, list):
                for h in headers:
                    if isinstance(h, dict):
                        hcol = h.get("col")
                        if hcol is not None and int(hcol) == col_index:
                            return str(h.get("value", ""))
                    elif isinstance(h, str):
                        idx = headers.index(h) + 1
                        if idx == col_index:
                            return h
            break
        return None

    def _drop_conflicting_manual_header_ops(self, op_type: str, op_params: Dict[str, Any]) -> None:
        """移除与 summarize_* 冲突的手工表头写入操作（set_range_values）。"""
        if op_type not in ("summarize_metrics_by_column", "summarize_by_column"):
            return

        def _to_int(value: Any, default: int) -> int:
            try:
                return int(value)
            except (TypeError, ValueError):
                return default

        def _as_sheet_name(raw: Any) -> str:
            if isinstance(raw, str):
                return raw.strip()
            if isinstance(raw, dict):
                for key in ("name", "sheet", "sheetName"):
                    val = raw.get(key)
                    if isinstance(val, str) and val.strip():
                        return val.strip()
            return ""

        def _looks_like_header(values: Any) -> bool:
            if not isinstance(values, list) or len(values) != 1:
                return False
            row = values[0]
            if not isinstance(row, list) or len(row) < 2:
                return False
            for cell in row:
                if cell is None:
                    return False
                if isinstance(cell, (int, float)):
                    return False
                if not isinstance(cell, str) or not cell.strip():
                    return False
            return True

        target_sheet = _as_sheet_name(op_params.get("targetSheet")) or _as_sheet_name(op_params.get("sheet"))
        if not target_sheet:
            return

        end_row = _to_int(op_params.get("endRow"), 1)
        target_row = _to_int(op_params.get("targetRow"), end_row + 1)
        target_col = _to_int(op_params.get("targetCol"), 1)
        group_col = _to_int(op_params.get("groupByCol"), target_col)
        sum_col = _to_int(op_params.get("sumCol"), target_col + 1)
        header_rows = {target_row, max(1, target_row - 1)}

        def _overlap(start_col: int, end_col: int, col: int) -> bool:
            return start_col <= col <= end_col

        kept_ops: List[Dict[str, Any]] = []
        removed_count = 0

        for buffered in self._operations_buffer:
            b_type = buffered.get("type")
            b_params = buffered.get("params", {}) or {}

            if b_type != "set_range_values":
                kept_ops.append(buffered)
                continue

            sheet_name = _as_sheet_name(b_params.get("sheet"))
            start_row = _to_int(b_params.get("startRow"), -1)
            start_col = _to_int(b_params.get("startCol"), -1)
            values = b_params.get("values")

            if sheet_name != target_sheet or start_row not in header_rows or not _looks_like_header(values):
                kept_ops.append(buffered)
                continue

            first_row = values[0]
            end_col = start_col + len(first_row) - 1

            # summarize_metrics_by_column 标题区固定 4 列；summarize_by_column 关注分组列与汇总列。
            conflict = False
            if op_type == "summarize_metrics_by_column":
                metrics_end_col = target_col + 3
                conflict = not (end_col < target_col or start_col > metrics_end_col)
            else:
                conflict = _overlap(start_col, end_col, group_col) or _overlap(start_col, end_col, sum_col)

            if conflict:
                removed_count += 1
                continue

            kept_ops.append(buffered)

        if removed_count > 0:
            self._operations_buffer = kept_ops
            self.log.logger.info(
                self.log.fmt(f'🧹 summarize 防重生效：移除 {removed_count} 条手工表头写入操作')
            )

    def _build_validation_excel_state(self) -> Dict[str, Any]:
        """构建用于参数校验的 Excel 状态（包含本轮已生成操作的影响）"""
        def _as_sheet_name(raw: Any) -> Optional[str]:
            if isinstance(raw, str):
                name = raw.strip()
                return name or None
            if isinstance(raw, dict):
                for key in ("name", "sheet", "sheetName"):
                    val = raw.get(key)
                    if isinstance(val, str) and val.strip():
                        return val.strip()
            return None

        def _next_pivot_sheet_name(source_name: str, existing_names: set[str]) -> str:
            base = f"{source_name}透视表"
            candidate = base
            seq = 1
            while candidate in existing_names:
                candidate = f"{base}{seq}"
                seq += 1
            return candidate

        def _iter_effective_operations(operations: List[Dict[str, Any]]):
            for operation in operations:
                if not isinstance(operation, dict):
                    continue
                op_type = operation.get('type')
                params = operation.get('params', {}) or {}
                if op_type == 'batch_operations':
                    nested = params.get('operations')
                    if isinstance(nested, list):
                        for nested_op in _iter_effective_operations(nested):
                            yield nested_op
                    continue
                yield operation

        sheets = []
        for sheet in self.context.sheets:
            if isinstance(sheet, dict):
                sheets.append(dict(sheet))

        active_sheet = self.context.active_sheet

        for buffered_op in _iter_effective_operations(self._operations_buffer):
            op_type = buffered_op.get('type')
            params = buffered_op.get('params', {}) or {}

            if op_type == 'add_sheet':
                name = params.get('name')
                if name and not any(s.get('name') == name for s in sheets):
                    sheets.append({'name': name})
                continue

            if op_type == 'rename_sheet':
                old_name = params.get('oldName')
                new_name = params.get('newName')
                if not old_name or not new_name:
                    continue
                for s in sheets:
                    if s.get('name') == old_name:
                        s['name'] = new_name
                if active_sheet == old_name:
                    active_sheet = new_name
                continue

            if op_type == 'delete_sheet':
                name = params.get('name')
                if not name:
                    continue
                sheets = [s for s in sheets if s.get('name') != name]
                if active_sheet == name:
                    active_sheet = sheets[0].get('name', 'Sheet1') if sheets else 'Sheet1'
                continue

            if op_type == 'copy_sheet':
                source_name = params.get('sourceName')
                new_name = params.get('newName')
                source_sheet = next((s for s in sheets if s.get('name') == source_name), None)
                if new_name and source_sheet and not any(s.get('name') == new_name for s in sheets):
                    copied = dict(source_sheet)
                    copied['name'] = new_name
                    sheets.append(copied)
                continue

            if op_type == 'set_active_sheet':
                name = params.get('name')
                if name:
                    active_sheet = name
                continue

            # create_pivot_table 会在前端执行时自动创建目标工作表（若指定了 targetSheet）
            # 参数校验需要感知这一副作用，避免后续 set_cell_value 被误判“工作表不存在”。
            if op_type == 'create_pivot_table':
                target_name = _as_sheet_name(
                    params.get('targetSheet')
                    or params.get('target_sheet')
                    or params.get('targetSheetName')
                )
                # 未显式给 targetSheet 时，前端会自动创建“源工作表+透视表(+序号)”
                if not target_name:
                    source_name = _as_sheet_name(params.get('sheet')) or active_sheet
                    existing = {s.get('name') for s in sheets if s.get('name')}
                    target_name = _next_pivot_sheet_name(source_name, existing)
                if target_name and not any(s.get('name') == target_name for s in sheets):
                    sheets.append({'name': target_name})
                continue

            # create_pivot_data 在目标 sheet 不存在时会自动创建该工作表
            if op_type == 'create_pivot_data':
                source_name = _as_sheet_name(params.get('sheet')) or active_sheet
                target_name = _as_sheet_name(params.get('targetSheet')) or source_name
                if target_name and not any(s.get('name') == target_name for s in sheets):
                    sheets.append({'name': target_name})
                continue

            # summarize_metrics_by_column 在 targetSheet 不存在时会自动创建该工作表
            if op_type == 'summarize_metrics_by_column':
                source_name = _as_sheet_name(params.get('sheet')) or active_sheet
                target_name = _as_sheet_name(params.get('targetSheet')) or source_name
                if target_name and not any(s.get('name') == target_name for s in sheets):
                    sheets.append({'name': target_name})
                continue

        return {
            "sheets": sheets,
            "activeSheet": active_sheet,
            "selection": self.context.selection,
        }
    
    async def _process_tool_result(self, result_block: ToolResultBlock):
        """处理工具调用结果"""
        # 初始化验证错误列表（如果不存在）
        if not hasattr(self, '_validation_errors'):
            self._validation_errors = []
        validation_errors = []  # 本次处理的验证错误
        try:
            # 记录原始结果结构用于调试
            self.log.logger.debug(self.log.fmt('========== 开始处理 ToolResultBlock =========='))
            self.log.logger.debug(self.log.fmt(f'ToolResultBlock 类型: {type(result_block)}'))
            
            # 记录 ToolResultBlock 的标准属性
            if hasattr(result_block, 'tool_use_id'):
                self.log.logger.debug(self.log.fmt(f'tool_use_id: {result_block.tool_use_id}'))
            if hasattr(result_block, 'is_error'):
                self.log.logger.debug(self.log.fmt(f'is_error: {result_block.is_error}'))
            
            # 尝试多种方式提取 operation
            operation_found = False

            def _extract_tool_error_texts(raw: Any) -> List[str]:
                errors: List[str] = []
                if isinstance(raw, str):
                    txt = raw.strip()
                    if txt.startswith("ERROR:"):
                        errors.append(txt)
                    return errors
                if isinstance(raw, dict):
                    if raw.get("type") == "text" and isinstance(raw.get("text"), str):
                        txt = raw["text"].strip()
                        if txt.startswith("ERROR:"):
                            errors.append(txt)
                    nested = raw.get("content")
                    if isinstance(nested, list):
                        for item in nested:
                            errors.extend(_extract_tool_error_texts(item))
                    return errors
                if isinstance(raw, list):
                    for item in raw:
                        errors.extend(_extract_tool_error_texts(item))
                return errors
            
            # 方法1: 检查 content 属性（最可能的位置）
            if hasattr(result_block, 'content'):
                content = result_block.content
                self.log.logger.debug(self.log.fmt(f'ToolResultBlock.content 类型: {type(content)}'))
                self.log.logger.debug(self.log.fmt(f'ToolResultBlock.content 值: {content}'))
                tool_errors = _extract_tool_error_texts(content)
                if tool_errors:
                    validation_errors.extend([f"工具执行失败: {msg}" for msg in tool_errors])
                
                if isinstance(content, list):
                    # content 是列表，遍历查找所有 operation（支持多个操作）
                    self.log.logger.debug(self.log.fmt(f'content 列表长度: {len(content)}'))
                    operations_in_content = []  # 收集所有找到的操作
                    
                    for idx, item in enumerate(content):
                        self.log.logger.debug(self.log.fmt(f'content[{idx}] 类型: {type(item)}'))
                        if isinstance(item, dict):
                            self.log.logger.debug(self.log.fmt(f'content[{idx}] keys: {list(item.keys())}'))
                            # 检查是否是 operation 类型的 content 项
                            if item.get("type") == "operation" and "operation" in item:
                                op = item["operation"]
                                operations_in_content.append(op)
                            # 检查 text 中是否编码了 operation（SDK 可能过滤了自定义类型）
                            elif item.get("type") == "text" and "text" in item:
                                text = item["text"]
                                if text.startswith("__EXCEL_OPERATION__:"):
                                    try:
                                        import json
                                        op_json = text.replace("__EXCEL_OPERATION__:", "", 1)
                                        op = json.loads(op_json)
                                        self.log.logger.debug(
                                                                                        self.log.fmt(f'从 JSON 字符串解析 operation: type={op.get("type")},  params_keys={list(op.get("params", {}).keys())}')
                                        )
                                        operations_in_content.append(op)
                                    except Exception as e:
                                        self.log.logger.warning(
                                                                                        self.log.fmt(f'解析编码的 operation 失败: {e},  text_preview={text[:200]}')
                                        )
                            # 兼容旧格式：直接包含 operation 字段
                            elif "operation" in item:
                                op = item["operation"]
                                operations_in_content.append(op)
                            # 兼容旧格式：item 本身就是 operation
                            elif "type" in item and "params" in item and item.get("type") != "text":
                                op = item
                                operations_in_content.append(op)
                        elif hasattr(item, '__dict__'):
                            # 可能是对象，检查其属性
                            item_dict = item.__dict__
                            self.log.logger.debug(self.log.fmt(f'content[{idx}] 对象属性: {list(item_dict.keys())}'))
                            if "operation" in item_dict:
                                op = item_dict["operation"]
                                if isinstance(op, dict):
                                    operations_in_content.append(op)
                    
                    # 处理所有找到的操作（去重：同一个操作可能在 operation 和 text 中都出现）
                    seen_operations = set()
                    for op in operations_in_content:
                        # 使用操作类型和关键参数生成唯一键
                        op_key = (op.get("type"), str(op.get("params", {})))
                        if op_key not in seen_operations:
                            seen_operations.add(op_key)
                            success, error_msg = self._validate_and_add_operation(op)
                            if success:
                                operation_found = True
                            elif error_msg:
                                # 验证失败，收集错误信息
                                validation_errors.append(error_msg)
                
                elif isinstance(content, dict):
                    # content 是字典
                    self.log.logger.debug(self.log.fmt(f'content 字典 keys: {list(content.keys())}'))
                    # 检查是否有嵌套的 content 字段（SDK 可能包装了返回值）
                    if "content" in content and isinstance(content["content"], list):
                        nested_content = content["content"]
                        operations_in_nested = []
                        for item in nested_content:
                            if isinstance(item, dict) and item.get("type") == "operation" and "operation" in item:
                                operations_in_nested.append(item["operation"])
                            elif isinstance(item, dict) and item.get("type") == "text" and "text" in item:
                                text = item["text"]
                                if text.startswith("__EXCEL_OPERATION__:"):
                                    try:
                                        import json
                                        op_json = text.replace("__EXCEL_OPERATION__:", "", 1)
                                        op = json.loads(op_json)
                                        operations_in_nested.append(op)
                                    except Exception as e:
                                        self.log.logger.warning(self.log.fmt(f'解析嵌套 content 中的 operation 失败: {e}'))
                            elif isinstance(item, dict) and "operation" in item:
                                operations_in_nested.append(item["operation"])
                            elif isinstance(item, dict) and "type" in item and "params" in item and item.get("type") != "text":
                                operations_in_nested.append(item)
                        
                        # 处理所有找到的操作（去重）
                        seen_operations = set()
                        for op in operations_in_nested:
                            op_key = (op.get("type"), str(op.get("params", {})))
                            if op_key not in seen_operations:
                                seen_operations.add(op_key)
                                success, error_msg = self._validate_and_add_operation(op)
                                if success:
                                    operation_found = True
                                elif error_msg:
                                    validation_errors.append(error_msg)
                    elif "operation" in content:
                        op = content["operation"]
                        success, error_msg = self._validate_and_add_operation(op)
                        if success:
                            operation_found = True
                        elif error_msg:
                            validation_errors.append(error_msg)
                    elif "type" in content and "params" in content:
                        # content 本身就是 operation
                        op = content
                        success, error_msg = self._validate_and_add_operation(op)
                        if success:
                            operation_found = True
                        elif error_msg:
                            validation_errors.append(error_msg)
                
                elif isinstance(content, str):
                    # content 是字符串，尝试解析 JSON
                    self.log.logger.debug(self.log.fmt(f'content 是字符串，长度: {len(content)}'))
                    # 检查是否包含编码的 operation
                    if "__EXCEL_OPERATION__:" in content:
                        try:
                            import json
                            parts = content.split("__EXCEL_OPERATION__:", 1)
                            if len(parts) == 2:
                                op_json = parts[1].strip()
                                op = json.loads(op_json)
                                success, error_msg = self._validate_and_add_operation(op)
                                if success:
                                    operation_found = True
                                elif error_msg:
                                    validation_errors.append(error_msg)
                        except Exception as e:
                            self.log.logger.warning(self.log.fmt(f'解析编码的 operation 失败: {e}'))
                    
                    # 尝试解析 JSON
                    if not operation_found:
                        try:
                            import json
                            if content.strip().startswith('{') or content.strip().startswith('['):
                                parsed = json.loads(content)
                                if isinstance(parsed, dict):
                                    # 检查是否有嵌套的 content
                                    if "content" in parsed and isinstance(parsed["content"], list):
                                        for item in parsed["content"]:
                                            if isinstance(item, dict) and item.get("type") == "operation" and "operation" in item:
                                                op = item["operation"]
                                                success, error_msg = self._validate_and_add_operation(op)
                                                if success:
                                                    operation_found = True
                                                    break
                                                elif error_msg:
                                                    validation_errors.append(error_msg)
                                    elif "operation" in parsed:
                                        op = parsed["operation"]
                                        success, error_msg = self._validate_and_add_operation(op)
                                        if success:
                                            operation_found = True
                                        elif error_msg:
                                            validation_errors.append(error_msg)
                                    elif "type" in parsed and "params" in parsed:
                                        op = parsed
                                        success, error_msg = self._validate_and_add_operation(op)
                                        if success:
                                            operation_found = True
                                        elif error_msg:
                                            validation_errors.append(error_msg)
                                elif isinstance(parsed, list):
                                    for item in parsed:
                                        if isinstance(item, dict) and "operation" in item:
                                            op = item["operation"]
                                            success, error_msg = self._validate_and_add_operation(op)
                                            if success:
                                                operation_found = True
                                                break
                                            elif error_msg:
                                                validation_errors.append(error_msg)
                        except Exception as e:
                            self.log.logger.warning(self.log.fmt(f'解析 content JSON 失败: {e}'))
            
            # 方法2: 检查 result_block 的所有属性
            if not operation_found and hasattr(result_block, '__dict__'):
                result_dict = result_block.__dict__
                self.log.logger.debug(self.log.fmt(f'ToolResultBlock.__dict__ keys: {list(result_dict.keys())}'))
                
                # 检查是否有 operation 字段
                if "operation" in result_dict:
                    op = result_dict["operation"]
                    if isinstance(op, dict):
                        success, error_msg = self._validate_and_add_operation(op)
                        if success:
                            operation_found = True
                        elif error_msg:
                            validation_errors.append(error_msg)
            
            # 方法3: 检查是否有 text 属性
            if not operation_found and hasattr(result_block, 'text'):
                try:
                    import json
                    text = result_block.text
                    if text and text.strip().startswith('{'):
                        parsed = json.loads(text)
                        if "operation" in parsed:
                            op = parsed["operation"]
                            success, error_msg = self._validate_and_add_operation(op)
                            if success:
                                operation_found = True
                            elif error_msg:
                                validation_errors.append(error_msg)
                except:
                    pass
            
            # 如果有验证错误，区分软守卫与硬错误：
            # - 软守卫（查询只读模式拦截写操作）只记录并跳过，不触发致命失败
            # - 硬错误才进入 fatal 流程
            if validation_errors:
                soft_guard_errors = [e for e in validation_errors if str(e).startswith(_SOFT_GUARD_PREFIX)]
                hard_errors = [e for e in validation_errors if not str(e).startswith(_SOFT_GUARD_PREFIX)]

                if soft_guard_errors:
                    self.log.logger.info(
                        self.log.fmt(
                            f'ℹ️ 查询只读软守卫生效，已跳过 {len(soft_guard_errors)} 个写操作，不中断本轮处理。'
                        )
                    )
                if hard_errors:
                    if not hasattr(self, '_validation_errors'):
                        self._validation_errors = []
                    self._validation_errors.extend(hard_errors)
                    # 仅硬错误标记为致命
                    self._fatal_validation_error = True
            
            if not operation_found:
                if not validation_errors:
                    # 只读查询工具（query_unique_values 等）只返回文本给模型，不产生 operation——预期行为
                    self.log.logger.info(
                        self.log.fmt('ℹ️ 工具结果块未携带 operation（只读查询或元信息），已忽略并继续。')
                    )
                # 记录更详细的调试信息
                if hasattr(result_block, 'content'):
                    self.log.logger.debug(self.log.fmt(f'ToolResultBlock.content 类型: {type(result_block.content)}'))
                    if isinstance(result_block.content, list):
                        for idx, item in enumerate(result_block.content):
                            self.log.logger.debug(
                                                                self.log.fmt(f'content[{idx}]: type={type(item)},  keys={list(item.keys()) if isinstance(item, dict) else "N/A"}')
                            )
                            if isinstance(item, dict) and "text" in item:
                                text_preview = str(item["text"])[:500]
                                self.log.logger.debug(self.log.fmt(f'content[{idx}].text 预览: {text_preview}'))
                if hasattr(result_block, '__dict__'):
                    import json
                    try:
                        result_dict = {k: v for k, v in result_block.__dict__.items() if k != 'content'}
                        self.log.logger.debug(self.log.fmt(f'ToolResultBlock 属性: {json.dumps(result_dict, default=str, ensure_ascii=False, indent=2)}'))
                    except Exception as e:
                        self.log.logger.debug(self.log.fmt(f'ToolResultBlock 属性序列化失败: {e}'))
            else:
                self.log.logger.debug(self.log.fmt('✅ 成功提取 operation'))
            
            self.log.logger.debug(self.log.fmt(f'========== ToolResultBlock 处理完成，operation_found={operation_found} =========='))
                
        except Exception as e:
            error_msg = f"处理工具结果时出错: {e}"
            self.log.tool_call_failed('unknown', str(e))
            self.log.logger.error(self.log.fmt(f'❌ {error_msg}'), exc_info=True)
            # 收集错误，以便后续发送到前端
            if not hasattr(self, '_validation_errors'):
                self._validation_errors = []
            self._validation_errors.append(error_msg)
    
    async def process_command_simple(
        self, 
        command: str, 
        excel_state: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """简化版命令处理"""
        text_parts = []
        operations = []
        
        async for response in self.process_command(command, excel_state):
            if response["type"] == "text":
                text_parts.append(response["content"])
            elif response["type"] == "operations":
                operations.extend(response["content"])
            elif response["type"] == "error":
                return {"success": False, "message": response["content"], "operations": []}
        
        return {"success": True, "message": "".join(text_parts), "operations": operations}


class ExcelAgentManager:
    """Excel Agent 管理器"""
    
    def __init__(self):
        self._agents: Dict[str, ExcelAgent] = {}
        self._lock = asyncio.Lock()
        self.log = AgentLogger('manager')
        self._cleanup_task: Optional[asyncio.Task] = None
        self._cleanup_interval = int(os.getenv("AGENT_CLEANUP_INTERVAL_SEC", 30))
        self._idle_ttl_sec = int(os.getenv("AGENT_IDLE_TTL_SEC", 300))
    
    async def get_agent(self, session_id: str) -> ExcelAgent:
        """获取或创建 Agent 实例"""
        async with self._lock:
            if session_id not in self._agents:
                self.log.logger.info(f'[manager] 创建新 Agent: {session_id}')
                agent = ExcelAgent(session_id)
                self._agents[session_id] = agent
                self._ensure_cleanup_task()
            return self._agents[session_id]

    def _ensure_cleanup_task(self):
        if self._cleanup_task and not self._cleanup_task.done():
            return
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        try:
            while True:
                await asyncio.sleep(self._cleanup_interval)
                now_ts = time.monotonic()
                async with self._lock:
                    idle_sessions = [
                        sid for sid, agent in self._agents.items()
                        if agent.is_idle(now_ts, self._idle_ttl_sec)
                    ]
                for session_id in idle_sessions:
                    self.log.logger.info(f'[manager] 空闲超时，关闭 Agent: {session_id}')
                    await self.remove_agent(session_id)
                
                # 定期清理残留的 Claude 进程
                await self._cleanup_orphan_claude_processes()
        except asyncio.CancelledError:
            return
    
    async def _cleanup_orphan_claude_processes(self):
        """
        清理残留的 Claude 进程
        
        注意：此函数已禁用自动清理，改为仅记录日志。
        原因：无法区分 ExcelAgent 和 LargeFileAgent 的 Claude 进程，
        自动清理可能误杀正在使用的进程。
        
        如需手动清理残留进程，请使用：pkill -f "claude_agent_sdk"
        """
        # 暂时禁用自动清理，只记录发现的进程数量
        try:
            base_path = os.getcwd()
            claude_pids = self._find_claude_pids(base_path)
            
            if claude_pids:
                # 只记录，不清理
                self.log.logger.debug(f'[manager] 发现 {len(claude_pids)} 个 Claude 进程（未清理，避免误杀 LargeFileAgent）')
        except Exception as e:
            self.log.logger.debug(f'[manager] 检查 Claude 进程时出错: {e}')
    
    def _find_claude_pids(self, base_path: str) -> List[int]:
        """查找 Claude 进程 PID"""
        try:
            output = subprocess.check_output(["ps", "-ef"], text=True, stderr=subprocess.DEVNULL)
        except Exception:
            return []
        
        pids = []
        keywords = [base_path, "claude_agent_sdk/_bundled/claude"]
        for line in output.splitlines():
            if not line or line.startswith("UID"):
                continue
            if all(k in line for k in keywords):
                parts = line.split()
                if len(parts) > 1 and parts[1].isdigit():
                    pids.append(int(parts[1]))
        return pids
    
    async def remove_agent(self, session_id: str):
        """移除 Agent 实例"""
        agent = None
        async with self._lock:
            if session_id in self._agents:
                self.log.logger.info(f'[manager] 移除 Agent: {session_id}')
                agent = self._agents[session_id]
                del self._agents[session_id]
        # 关键：无论 _per_request_close 的值如何，移除时都应该关闭 Agent，确保资源释放
        if agent:
            await agent.close()
    
    async def close_all(self):
        """关闭所有 Agent"""
        async with self._lock:
            self.log.logger.info('[manager] 关闭所有 Agent')
            for agent in self._agents.values():
                if not agent._per_request_close:
                    await agent.close()
            self._agents.clear()
        if self._cleanup_task and not self._cleanup_task.done():
            self._cleanup_task.cancel()


# 全局 Agent 管理器实例
agent_manager = ExcelAgentManager()
