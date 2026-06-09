# report 模块架构说明

## 模块定位

`report/` 负责“我要报表”链路：从数据结构理解、报表规划、SQL 执行、图表构建到洞察生成与分享。

## 目录骨架

```text
report/
├── analyzer.py      # 结构分析与模板推荐
├── templates.py     # 报表模板定义
├── planner.py       # Phase 1：LLM 规划（KPI/图表/SQL）
├── aggregator.py    # SQL 执行与结果聚合
├── chart_builder.py # 图表配置构建
├── insight_generator.py # Phase 3：图表洞察 + 总体洞察
├── insight_prompt_builder.py # 洞察 Prompt 构建（图表级/总体）
├── insight_quality_gate.py # 洞察质量门禁（结构与内容校验）
├── insight_fallback_engine.py # 洞察兜底引擎（数据驱动回退）
├── llm_client.py    # 单次 LLM 调用（无 tools）
├── llm_executor.py  # 统一 tools 化 LLM 调用入口
├── assembler.py     # 报表组装主流程（流式阶段输出）
├── cache.py         # 报表缓存读写
├── storage.py       # 报表存储抽象
├── share_service.py # 分享与报表列表能力
├── task_manager.py  # 异步任务管理
├── router.py        # API 路由
└── __init__.py
```

## 关键设计决策

1. **LLM 双通道，strict-json 优先**
   - `llm_executor.py` 统一封装 Claude Agent SDK + MCP tools。
   - `planner.py` 默认走 `llm_client.py` strict-json 单次直出；仅在 `REPORT_PLANNER_USE_TOOLS_FIRST=true` 时启用 tools-first。
   - `insight_generator.py` 仍采用 tools 优先 + 回退策略，保障洞察质量。
   - 目标：规划阶段以稳定 JSON 为优先，洞察阶段保留 tools 能力。

2. **阶段化流水线**
   - Phase 1：`planner.py` 生成可执行计划。
   - Phase 2：`aggregator.py` + `chart_builder.py` 执行数据层与可视化层。
   - Phase 3：`insight_generator.py` 编排洞察流程；`insight_prompt_builder.py` 负责提示词；`insight_quality_gate.py` 负责质量门禁；`insight_fallback_engine.py` 负责数据驱动兜底。

3. **可靠性优先**
   - 缓存命中优先返回，fallback 结果不落缓存，避免低质量内容固化。
   - 异步任务与同步流式并存，支持不同交互时延诉求。
   - `planner.py` 的 JSON 解析与回退不再内嵌实现，统一委托 `utils/json_output_guard.py`。

## 依赖边界

- 允许依赖 `large_file` 的数据能力（DuckDB/MCP tools）。
- 允许依赖 `utils/json_output_guard.py` 作为统一 JSON 容错链路。
- 不跨入 `agent/` 普通模式工具实现。
- `router.py` 只编排，不承载复杂业务逻辑。

## 开发约束

- 新增 LLM 入口必须先落到 `llm_executor.py`（tools）或 `llm_client.py`（纯文本）之一，禁止散落调用。
- 业务模块只做 prompt 与结果解析，不重复实现 SDK 生命周期管理。
- 任何新增文件都要同步更新本文件，保持架构可读性。

## 变更记录

### 2026-02-20
- 新增 `llm_executor.py`，统一报表模块 tools 化 LLM 调用入口。
- `planner.py` 改为 tools 优先，失败回退 `llm_client.py`。
- `insight_generator.py` 的图表洞察改为 tools 优先，失败回退 `llm_client.py`。
- `insight_generator.py` 的总体洞察改为 `llm_executor.py` 单入口，移除对 `large_file_agent_manager` 的直接依赖。

### 2026-03-03
- `planner.py` 接入 `utils/json_output_guard.py`，采用统一容错链路：`direct_parse -> force_json -> json_repair`。
- `planner.py` 新增强制 JSON 回退与 JSON 修复回退，能力与 `pptx/planner.py` 对齐。
- 洞察生成链路重构为三层：`insight_prompt_builder.py`（提示词）、`insight_quality_gate.py`（质量门禁）、`insight_fallback_engine.py`（兜底）。
- `insight_generator.py` 降级为编排层，保留外部 API 不变，减少 Prompt 与校验逻辑耦合。
- `planner.py` 集成 `utils/context_budget` 自适应压缩，防止 context window / Argument list too long 溢出。

### 2026-04-12
- `aggregator.py` 新增 SQL 占位符统一解析：执行前将 `{table}` / `{table:工作表名}` 渲染为 DuckDB 实表名；未解析占位符直接 fail-fast，避免批量 Parser Error。
- `assembler.py` 新增 SQL 硬错误熔断：命中占位符/表映射硬错误后，后续 KPI/图表/明细 SQL 直接跳过，防止同类错误刷屏。
- `planner.py` 调整 Phase1 执行策略：默认 strict-json 单次直出（45s），tools-first 改为可选开关 `REPORT_PLANNER_USE_TOOLS_FIRST`。
- `planner.py` 新增 `_build_resilient_fallback_plan`：Phase1 超时/异常时回退为可执行稳健计划（含 KPI/图表/明细 SQL），避免整单失败。
