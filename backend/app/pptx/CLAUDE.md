# PPTX 汇报模块 — 架构文档

## 模块定位

基于 Excel 数据智能生成企业级 PPTX 演示文稿。完全独立于 `report`（我要报表）和 `agent`（我要分析）模块。

## 目录结构

```
pptx/
├── CLAUDE.md              # 本文件 — 模块架构
├── __init__.py            # 模块入口
├── router.py              # API 路由：SSE 生成 / CRUD / 下载
├── planner.py             # LLM 规划器：生成 SlidePlan JSON
├── pptist_converter.py    # PPTist 格式转换：SlidePlan -> AIPPTSlide[] + DataElements[]
├── builder.py             # PPTX 引擎：python-pptx 文件生成（备用下载）
├── templates.py           # 10 套模板配色与版式定义
├── schemas.py             # Pydantic 数据模型
├── storage.py             # 文件与元数据持久化（JSON + .pptx）
├── generate_covers.py     # Pillow 封面背景图生成脚本
└── assets/
    ├── covers/            # 10 张封面背景 PNG（1920x1080）
    └── icons/             # Lucide 图标 PNG 缓存（预留）
```

## 数据流

```
用户选模板 → POST /api/pptx/generate (SSE)
  ├─ planner.py: collect_schema_context → LLM → SlidePlan JSON
  ├─ router.py: execute_plan_sql 填充 KPI/图表/表格数据
  ├─ builder.py: SlidePlan + 模板 → .pptx 文件（备用下载）
  ├─ pptist_converter.py: SlidePlan → AIPPTSlide[] + DataElements[]
  └─ storage.py: 保存 .pptx + 元数据 JSON
前端: SSE complete → 加载 PPTist 模板 JSON
  ├─ 第一阶段: useAIPPT.AIPPT(模板, 文字数据, 图片池) → 文字+排版
  └─ 第二阶段: injectDataElements(slides, 图表/表格/KPI) → 完整幻灯片
→ PPTist 编辑器（所见即所得）→ 导出 / 播放
```

## 核心设计决策

1. **LLM 复用**: 复用 `report.planner.collect_schema_context` 获取数据上下文，复用 `report.llm_executor.call_llm_with_tools` 执行 MCP 调用
   - JSON 提取与容错回退统一复用 `utils/json_output_guard.py`，避免与 `report` 维护两套解析逻辑
2. **SQL 安全**: 通过 `report.aggregator.execute_plan_sql` 执行，自带白名单校验
3. **模板系统**: 纯配色方案 + Pillow 代码生成背景 — 无外部图片依赖
4. **存储策略**: JSON 元数据 + .pptx 二进制文件，磁盘存储于 `uploads/pptx_files/`

## 依赖关系

```
pptx.planner           → report.planner (collect_schema_context)
                       → report.llm_executor (call_llm_with_tools)
                       → report.llm_client (call_llm_single, fallback)
                       → utils.json_output_guard (统一 JSON 容错链路)
pptx.router            → report.aggregator (execute_plan_sql)
                       → pptx.pptist_converter (convert_slide_plan)
pptx.pptist_converter  → 无外部依赖（纯数据转换）
pptx.builder           → pptx.templates (配色/路径)
```

**禁止 import**: `agent/`、`large_file/`（保持模块隔离）

## 变更日志

### 2026-03-03
- `planner.py` 接入 `utils/json_output_guard.py`，统一 direct/force/repair 三段式 JSON 容错链路。

### 2026-02-22
- 新增 `pptist_converter.py`：SlidePlan → PPTist AIPPT 兼容格式
  - Part A: AIPPTSlide[]（文字层）— cover/contents/transition/content/end
  - Part B: DataElements[]（数据元素层）— chart/table/kpi 原生元素
- `router.py` SSE complete 增加 `aippt_slides` + `data_elements` 返回字段
- `router.py` GET slides 端点增加 PPTist 格式实时转换
- 前端 `useDataElementInjector.ts`：图表/表格/KPI → PPTist 原生可编辑元素

### 2026-02-20
- 初始构建：完整 4 阶段实现
- 后端：router + planner + builder + templates + storage + schemas
- 前端：PresentationView + TemplateGallery + SlidePreview + SlideEditor + SlidePlayer + SlideRenderer + HistoryPanel
- Header 工具栏：导航组 + 编辑组 + 输出组
