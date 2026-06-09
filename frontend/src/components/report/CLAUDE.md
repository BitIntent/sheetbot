# report 组件架构说明

## 目录结构

```
report/
├── CLAUDE.md                # 本目录架构与约束说明
├── ReportView.jsx           # 报表总容器：状态编排、接口调用、阶段切换
├── ReportHistoryPanel.jsx   # “我要报表”首页：历史报表表格、打开、删除
├── ReportCanvas.jsx         # 报表画布组合（KPI/图表/洞察/明细）
├── TemplateSelector.jsx     # 模板选择区
├── ShareDialog.jsx          # 报表分享弹窗
├── ChartSection.jsx         # 单图表区块
├── KPICard.jsx              # KPI 卡片
├── InsightSection.jsx       # 洞察区
├── DataTable.jsx            # 明细表区
└── ExportBar.jsx            # 导出操作栏
```

## 职责边界

- `ReportView.jsx` 只负责流程控制（home/template/generating/completed/error）与数据流，不承载复杂列表渲染细节。
- `ReportHistoryPanel.jsx` 只负责历史清单 UI 与交互回调，不直接请求后端。
- `ReportCanvas.jsx` 只负责展示，不反向修改 `ReportView` 状态。

## 依赖关系

- `ReportView` -> `ReportHistoryPanel`（首页）
- `ReportView` -> `TemplateSelector`（模板阶段）
- `ReportView` -> `ReportCanvas`（结果阶段）
- `ReportView` -> `ShareDialog`（分享）

## 开发规范

- 新增交互优先落子组件，避免继续膨胀 `ReportView`。
- 所有网络请求保留在 `ReportView` 或后续 `hooks/`，展示组件保持纯渲染。
- 阶段状态必须是单一来源，禁止子组件私自维护流程状态。

## 变更记录

- 2026-02-20：新增 `ReportHistoryPanel.jsx`，将历史报表表格从 `ReportView` 拆出，降低视图耦合并提升可维护性。
