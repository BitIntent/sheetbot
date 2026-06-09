# backend/app/agent 架构文档

## 目录定位

`agent/` 是普通模式 AI 执行中枢：负责意图识别、Prompt 组装、工具编排、参数规范化、操作验证、查询桥接与执行守卫。

## 目录结构（核心文件）

```
agent/
├── CLAUDE.md                  # 本文档：agent 子系统架构说明
├── excel_agent.py             # Agent 主编排器（会话生命周期 + 工具结果消费 + 操作缓冲）
├── excel_tools.py             # MCP 工具集合（写操作工具 + 只读查询工具）
├── prompt_expander.py         # 指令扩展器（意图识别 + 元数据驱动补全）
├── intent_classifier.py       # 主意图分类策略（规则命中 + 结构化评分）
├── prompt_rules.py            # 按意图注入的规则片段
├── intent_policy.py           # 意图策略（查询只读判定：问句结构 + 写意图信号）
├── query_semantic_parser.py   # 查询语义槽位解析（LLM First，只输出结构化 JSON）
├── plan_retry_policy.py       # submit_analysis_plan 失败重试策略（判定 + 修复提示）
├── retry_executor.py          # 重试执行器（静默回合消费 tool result）
├── operation_registry.py      # 操作注册表（单一真相源 + 别名 + 只读集合）
├── param_normalizer.py        # 参数规范化（命名统一 + 类型契约出口）
├── operation_validator.py     # 参数验证器（白名单 + 业务规则门控）
└── query_bridge.py            # 只读查询桥接（后端工具 -> 前端全表计算 -> 回传）
```

## 模块职责边界

- `excel_agent.py`：只负责编排与守卫，不承载领域规则细节。
- `prompt_expander.py`：只负责“识别 + 扩展”，不负责执行安全。
- `intent_classifier.py`：只负责主意图分类，不参与执行与状态变更。
- `intent_policy.py`：只负责“是否只读查询”判定，供扩展层与执行层复用。
- `query_semantic_parser.py`：只负责语义槽位提取（排序/排名/聚合/同比环比/占比），不参与业务计算与工具执行。
- `plan_retry_policy.py`：只负责 submit_analysis_plan 校验失败后的重试策略，不参与消息流与工具消费。
- `retry_executor.py`：只负责执行静默修复回合（消费 SDK 消息流 + 复用工具结果处理回调）。
- `operation_registry.py`：唯一操作元数据源；新增操作先改这里。
- `param_normalizer.py` + `operation_validator.py`：执行前双保险，先规范化再校验。

## 关键依赖关系

- `excel_agent.py` -> `prompt_expander.py`（识别意图 + 扩展指令）
- `prompt_expander.py` -> `intent_classifier.py`（主意图分类策略）
- `excel_agent.py` -> `intent_policy.py`（只读查询硬守卫）
- `excel_agent.py` -> `query_semantic_parser.py`（LLM 语义抽取 -> 确定性计算）
- `excel_agent.py` -> `plan_retry_policy.py`（提交计划失败 -> 单次自动修复重试）
- `excel_agent.py` -> `retry_executor.py`（重试回合执行与消息消费）
- `excel_agent.py` -> `param_normalizer.py` -> `operation_validator.py`（执行前验证链）
- `operation_validator.py` / `param_normalizer.py` -> `operation_registry.py`（注册表驱动）
- `excel_tools.py` -> `query_bridge.py`（只读查询全表精确计算）

## 设计原则

1. **分层决策**：意图判定与执行守卫分层，避免把安全性押注在 Prompt 上。  
2. **结构化判定优先**：禁止依赖问句枚举；采用“问句结构 + 写意图信号”。  
3. **只读默认安全**：查询型任务默认只读，除非用户明确要求写回。  
4. **单一真相源**：操作类型/别名/只读集合统一注册表维护。  
5. **执行前双保险**：先规范化，再校验；失败即拦截，不允许带病执行。

## 宪法级约束（通用性）

1. **禁止场景硬编码**：不得针对某个行业（如销售/财务）或某个固定问句写专门逻辑。  
2. **数据驱动优先**：列识别与查询路径优先依赖样本分布（数值密度/去重率/时间特征），关键词仅辅助。  
3. **跨行业可迁移**：同一查询能力在更换表头命名后仍应可用。  
4. **能力抽象复用**：新增查询能力必须沉淀为通用算子（过滤/聚合/比较/排名），禁止一次性特判。  
5. **失败可回退**：无法确定时给出清晰回退路径，禁止“假成功”。

## 变更日志

### 2026-04-11

- 新增 `intent_policy.py`，抽离“查询只读判定”策略，避免硬编码问句。
- `prompt_expander.py` 改为复用 `intent_policy` 的结构化信号判定。
- `excel_agent.py` 改为从 `intent_policy` 引入只读判定，形成“识别层 + 执行层”双守卫。
- 新增 `intent_classifier.py`，主意图识别从 `prompt_expander.py` 下沉为独立策略模块（规则命中 + 结构化信号评分双轨）。
- 查询确定性引擎升级为“数据驱动优先”：列识别由样本数值密度主导，关键词仅辅助；多条件过滤候选由非数值列自动推断，减少行业特定词依赖。

### 2026-04-12

- 新增 `query_semantic_parser.py`：查询语义改为 LLM First 槽位抽取（query_mode/sort_order/top_n/rank_positions/aggregate_op/trend_mode/need_ratio/target_entity）。
- `excel_agent.py` 查询确定性求解器改为优先消费语义槽位，仅在槽位缺失时回退本地启发式解析，实现“理解与计算分离”。
- 新增 `backend/tests/unit/test_query_semantic_parser.py`，覆盖 JSON 提取与槽位净化规则。
- 新增 `plan_retry_policy.py`：submit_analysis_plan 校验失败后由策略层判定并生成修复 prompt；`excel_agent.py` 仅负责执行静默重试编排。
- 新增 `retry_executor.py`：将静默重试回合执行从 `excel_agent.py` 抽离，主编排器仅传入依赖与回调。
