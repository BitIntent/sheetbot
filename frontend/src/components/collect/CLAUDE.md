# collect 组件架构说明

## 目录结构

```
collect/
├── CLAUDE.md                 # 本文档（收集模块前端架构）
├── CollectView.jsx           # 状态机编排层（home/building/published）
├── FormHistoryPanel.jsx      # 历史表单列表（打开/修改/删除）
├── CollectFormEditDialog.jsx # 表单编辑弹窗（标题/描述/映射工作簿/工作表）
├── collectApi.js             # 收集模块 API Base 解析
├── useCollectBuilder.js      # 创建/发布表单流程（AI推断 + 发布）
├── useCollectSync.js         # 同步到工作表的请求与错误映射
├── useCollectForms.js        # 历史表单/工作簿选项加载 + 编辑保存状态
├── useCollectExport.js       # 导出链路（批量同步 + 下载当前工作簿）
├── FormBuilder.jsx           # 字段配置编辑器
├── FormPreview.jsx           # 表单预览
├── SharePanel.jsx            # 分享链接与状态区
├── SubmissionList.jsx        # 提交数据列表与同步触发
└── PublicForm.jsx            # 公开表单页面
```

## 职责边界

- `CollectView.jsx` 只负责流程编排与状态管理，不承载细节 UI。
- `CollectFormEditDialog.jsx` 只负责编辑弹窗展示与输入，不做网络请求。
- `collectApi.js` 只负责 API Base 解析，避免多处重复定义。
- `useCollectBuilder.js` 负责创建流程与发布流程。
- `useCollectSync.js` 只负责“同步到工作表”调用与错误文案映射。
- `useCollectForms.js` 负责表单列表加载、工作簿选项加载、编辑表单保存。
- `useCollectExport.js` 负责导出前批量同步、下载、导出结果提示。

## 依赖关系

- `CollectView` 组合 `FormHistoryPanel`、`SubmissionList`、`CollectFormEditDialog`。
- `CollectView` 通过 `useCollectBuilder` 管理表单创建与发布。
- `SubmissionList` 通过 `onSync` 调用 `useCollectSync` 暴露的 `handleSync`。
- `CollectView` 通过 `useCollectForms` 获取 `forms/formsLoading/editDraft/...` 与编辑行为。
- `CollectView` 通过 `useCollectExport` 处理导出动作，不直接拼接下载逻辑。
- 所有 API 调用统一走 `useAuthedFetch`，避免组件直连 token 逻辑。

## 本次变更（2026-03-24）

- 拆出 `CollectFormEditDialog.jsx`，降低 `CollectView` 复杂度。
- 拆出 `useCollectSync.js`，集中同步链路和错误处理逻辑。
- 拆出 `useCollectForms.js`，集中列表/编辑相关状态与请求编排。
- 拆出 `useCollectExport.js`，集中导出流程与下载行为。
- 拆出 `useCollectBuilder.js`，集中创建/发布流程。
