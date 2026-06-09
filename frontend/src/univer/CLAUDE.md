# Univer 子系统架构说明

## 职责边界

- 本目录只负责 **Univer Canvas 宿主、SheetBot JSON 适配、视口同步与叠加层**。
- 不承载业务流程编排（业务状态机在 `App.jsx` / 各业务组件）。
- 对外暴露统一入口：`UniverSheetContainer.jsx`。

## 文件分层

- `UniverSheetContainer.jsx`：Univer 生命周期入口，挂载 API、同步 activeSheet、接入叠加层。
- `createUniverSheetsApp.js`：Univer 内核与插件注册（避免拉取 Pro 依赖）。
- `workbookJsonAdapter.js`：SheetBot JSON 与 Univer Snapshot 双向转换。
- `useUniverWorkbookSync.js`：编辑回写与灌表节流，避免环路注入。
- `useUniverViewportSync.js`：Skeleton/滚动/缩放/内容偏移同步。
- `UniverChartsOverlay.jsx`：图表浮层渲染与交互桥接。
- `UniverImagesOverlay.jsx`：图片浮层定位与渲染。
- `UniverCornerPatch.jsx`：左上角交汇补丁（三角填充 + 1px 线宽统一）。
- `sheetbotUniverChrome.css`：Univer UI 外观修正（Ribbon/左上角补丁等）。
- `sheetbotUniverUiOverrides.js`：UI 运行时覆盖（字体、菜单隐藏、重绘触发）。
- `sheetbotUniverInsertChart.js`：右键插入图表桥接。
- `univerRibbonPin.js`：Ribbon 固定对齐到 SheetBot 顶栏插槽。
- `sheetThemeToUniver.js`：SheetBot 主题映射到 Univer 色板。
- `chartEchartsBuilder.js`：图表数据转 ECharts option。
- `univerLocaleZhCN.js`：Univer 中文本地化补丁。
- `univerFormula.worker.js`：公式 Worker 入口。

## 依赖方向（强制）

- 允许依赖：`frontend/src/utils/*`（纯工具）、Univer 官方包。
- 禁止依赖：业务模块（如 `report/collect/connect`）与大文件后端 API 逻辑。
- 叠加层只读 `workbook` 与 viewport 信息，禁止直接修改业务状态。

## 变更日志

- 2026-03-30：新增 `UniverCornerPatch.jsx`，统一普通视图/大文件分析视图左上角交汇样式（三角填充、右下线宽 1px）。
