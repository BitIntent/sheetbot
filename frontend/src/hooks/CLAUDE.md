# Hooks 模块架构说明

## 目录结构（节选）

```
hooks/
├── CLAUDE.md
├── useLayoutViewport.js
├── useAuthedFetch.js
├── useSSE.js
├── useWebSocket.js
├── useWorkbookLoader.js
└── ... 其他渲染/布局 hooks
```

## 文件职责

- `useWorkbookLoader.js`：统一封装“从左侧文件树加载工作簿”的流程，包括自动大文件判定、下载解包、状态回填与视图切换策略。
- `useAuthedFetch.js`：统一封装登录后 API 请求，自动注入 Bearer Token，并复用 `withFreshAccessToken` 处理 401 刷新重试。
- `useLayoutViewport.js`：统一封装主工作区断点行为（移动端抽屉侧栏、平板自动折叠侧栏、移动端自动关闭 AI 面板）。

## 设计决策

- 将 `App.jsx` 中长函数 `handleSidebarFileSelect` 下沉到 hook，避免页面容器承担过多装载细节。
- 保持行为兼容：默认逻辑不变，仅通过 `options` 参数支持“保持当前视图/跳过自动分析/静默忙碌提示”等场景。
- 将收集/连接模块重复的 `authedFetch` 逻辑收敛到单一 hook，降低鉴权逻辑分叉和遗漏风险。

## 依赖边界

- `useWorkbookLoader` 依赖 `filesApi.downloadFile` 与 `exceljsToWorkbook`，不直接依赖 UI 组件。
- 具体状态写入由调用方注入 setter，避免 hook 与全局上下文强耦合。
- `useAuthedFetch` 仅依赖 `AuthContext`，对业务模块暴露统一的 `fetch` 入口，不耦合具体 API 路径。

## 变更日志

- 2026-02-20：新增 `useWorkbookLoader.js`，抽离工作簿装载逻辑，降低 `App.jsx` 复杂度。
- 2026-02-20：新增 `useAuthedFetch.js`，统一收敛 Collect/Connect/Submission 的鉴权请求逻辑。
- 2026-05-08：新增 `useLayoutViewport.js`，将 `App.jsx` 中分散的视口响应逻辑下沉为复用 hook，保持行为不变仅做结构拆分。
