# frontend/public 架构说明

## 目录职责

- `landing.html`：官网落地页结构与脚本入口（只保留内容结构，不再内联大段样式）。
- `landing.css`：官网落地页的唯一样式真源，承接原 `landing.html` 的完整样式定义。
- `robots.txt` / `sitemap.xml`：搜索引擎抓取入口与站点地图。
- `help/`：帮助中心静态站点产物与资源。
- `mocks/`：前端功能演示所需静态 mock 数据。
- `images/` / `lib/`：官网和功能页面的公共静态资源。

## 当前结构

```text
public/
├── CLAUDE.md
├── landing.html
├── landing.css
├── robots.txt
├── sitemap.xml
├── help/
├── mocks/
├── images/
└── lib/
```

## 设计约束

- 官网样式统一维护在 `landing.css`，禁止再次把大体量样式回填到 `landing.html`。
- `landing.html` 以语义结构和交互脚本为主，样式改动优先在 `landing.css` 完成。
- 对外 SEO 文件（`robots.txt`、`sitemap.xml`）变更需与发布域名保持一致。

## 变更日志

- 2026-05-08：将 `landing.html` 内联样式整体拆分到 `landing.css`，实现结构与样式解耦，保持页面视觉不变。
