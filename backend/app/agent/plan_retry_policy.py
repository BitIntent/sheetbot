"""
submit_analysis_plan 失败重试策略（纯策略层）。

职责：
- 判定是否可触发自动修复重试
- 生成修复重试 prompt
"""

from __future__ import annotations

from typing import List


def should_retry_submit_analysis_plan(validation_errors: List[str]) -> bool:
    """
    仅对 submit_analysis_plan 的计划校验失败触发单次自动修复重试。
    """
    if not validation_errors:
        return False
    merged = "\n".join(str(e) for e in validation_errors)
    return ("计划验证失败" in merged) and ("工具执行失败" in merged or "submit_analysis_plan" in merged)


def build_submit_analysis_retry_prompt(
    command: str,
    context_str: str,
    intent_rules: str,
    validation_errors: List[str],
) -> str:
    err_text = "\n".join(f"- {e}" for e in (validation_errors or []))
    return f"""## 上一次 submit_analysis_plan 计划校验失败，请修复后重提（仅一次）

用户原始请求：
{command}

<intent_rules>
{intent_rules}
</intent_rules>

## 当前Excel状态：
{context_str}

## 失败原因（必须逐条修复）
{err_text}

硬约束：
1. 必须且仅能再次调用一次 submit_analysis_plan。
2. 禁止使用 ID/编号/编码/SKU 等高基数字段作为 group_by_col。
3. 若某块分组维度不合规，必须替换为低基数业务维度（如渠道/区域/销售人员/品类）。
4. 不要追问用户，直接输出修复后的 plan 并调用 submit_analysis_plan。"""

