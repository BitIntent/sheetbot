# Header 子模块架构说明

## 目录结构

```
header/
├── CLAUDE.md
├── HeaderTopRow.jsx
└── HeaderActionBar.jsx
```

## 文件职责

- `HeaderTopRow.jsx`：负责顶部第一行，统一处理平台视图切换与右侧工具按钮（查找、AI、连接状态、退出）。
- `HeaderActionBar.jsx`：负责顶部第二行，按视图渲染不同操作栏（普通/分析/汇报/报表/收集）。
- `CLAUDE.md`：记录本子模块职责边界与演进决策，防止 Header 再次膨胀。

## 设计决策

- 将 `Header.jsx` 从“渲染+状态+事件全集中”拆为“容器 + 展示组件”，降低耦合。
- 保留事件分发与状态管理在 `Header.jsx`，避免跨组件共享状态导致回归。
- 收集模式使用独立渲染分支，确保只显示“返回列表 / 导出收集”，消除遗留预留按钮风险。
- 普通视图 + Univer（`embedUniverRibbon`）：第二行 **保存**（`onManualSave`）在 Ribbon 插槽左侧；接着为 `#sheetbot-univer-ribbon-slot`；`univerRibbonPin` 用 **fixed + getBoundingClientRect** 将 `header[data-u-comp="headerbar"]` 对齐到插槽（**禁止** appendChild 到顶栏，否则会脱离 Univer React 根导致工具栏点击无效）。插槽右侧：**常用函数**（`CommonFunctionsMenu`：`createPortal` 挂 `document.body` + `position:fixed` 避免被内容区盖住；下拉项走 `insertUniverFunction` / `InsertFunctionOperation`，「全部函数」走 `openUniverMoreFunctions`）、筛选、排序、自定义公式、下载。Ribbon 字体展示宽度由 `univer/sheetbotUniverChrome.css` 收紧。Univer 侧通过 `sheetbotUniverUiOverrides.js` 隐藏 Ribbon 上公式分类整行并覆盖字体列表（去掉 Times New Roman）。

## 依赖边界

- `HeaderTopRow.jsx` 仅依赖 `lucide-react` 与父组件注入回调。
- `HeaderActionBar.jsx` 仅依赖 `lucide-react`、`MemoryPanel` 与父组件注入状态。
- 两个子组件不直接访问全局状态，不直接发起网络请求。

## 变更日志

- 2026-02-20：将 `Header.jsx` 拆分为 `HeaderTopRow.jsx` 与 `HeaderActionBar.jsx`，降低文件复杂度并稳定“我要收集”工具栏行为。
- 2026-03-22：Univer 模式顶栏收敛为 Ribbon 占位 + 四类 SheetBot 动作（`NormalUniverEmbedActionBar`）。
- 2026-03-22：顶栏「常用函数」改为与 Univer `InsertFunctionOperation` 一致的下拉；Ribbon 公式分类行与「文本转数字」工具项由 `UniverSheetContainer` 的 `menu` 配置隐藏。
- 2026-03-22：常用函数下拉改为 Portal + 固定定位，避免被工作表区域遮挡；嵌入条增加保存按钮；字体条宽度由 `sheetbotUniverChrome.css` 限制。
- 2026-03-22：`flushToSheetbot` 前执行 `SetCellEditVisibleOperation` 收起单元格编辑器，避免保存时漏掉正在编辑的值；保存按钮样式与 Univer 图标按钮（32px）对齐；Ribbon 上 `univer-min-w-52` 强制收窄。
