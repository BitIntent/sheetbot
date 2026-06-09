# docs-site 架构说明

本目录是 SheetBot 用户手册的 **Docusaurus 站点工程**。

## 职责

- 直接维护 `docs/` 下的 Markdown 内容（唯一源）
- 根据 `sidebars.js` 组织导航
- 构建静态站点供 `/help/` 访问

## 关键文件

- `docusaurus.config.js`：站点配置（baseUrl、主题、路由）
- `sidebars.js`：章节导航（手工维护）
- `docs/`：手册章节（唯一源）
- `src/css/custom.css`：主题样式覆盖
- `scripts/publish-help.mjs`：将 build 产物发布到 `frontend/public/help`

## 构建链路

1. `npm run build`（在 `docs-site/` 下）
2. `npm run publish:help` 发布到 `frontend/public/help/`
3. 或直接 `npm run release:help` 一键完成
