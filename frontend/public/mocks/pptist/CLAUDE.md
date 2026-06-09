# PPTist 模板资源（前端 Mock）

本目录存放 **PPTist JSON 模板**，用于“我要汇报”在前端生成/预览/编辑 PPT。

## 目录结构

```
frontend/public/mocks/pptist/
├── template_1.json
├── template_2.json
├── template_3.json
├── template_4.json
├── template_5.json
├── template_6.json
├── template_7.json
├── template_8.json
├── template_9.json
├── template_10.json
└── CLAUDE.md
```

## 约定与边界

- **文件命名**：`template_<n>.json`，并在 `frontend/src/components/presentation/PresentationView.jsx` 的 `PPTIST_TEMPLATE_OPTIONS` 注册。
- **资源位置**：模板封面缩略图放在 `frontend/public/images/`，并通过 `cover` 字段引用（例如：`/images/template_9.svg`）。
- **外链图片**：模板可直接使用 `images.pexels.com` 等 CDN 图片作为背景/装饰图（现有模板已采用该策略）。
- **模板形状**：顶层固定为 `title/width/height/theme/slides[]`；每页 `slide` 包含 `elements[]` + `background` + `type`（如 `cover/contents/transition/content/end`）。

## 模板风格说明

- `template_9.json`：霓虹夜景科技风（深色高对比、蓝紫霓虹点缀）
- `template_10.json`：暖色纸纹极简风（暖色纸感、克制排版、适合复盘总结）

## 变更日志

- 2026-02-25：新增 `template_9.json`、`template_10.json`

