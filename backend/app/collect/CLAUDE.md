# collect - 表单收集模块

将 Excel 列头通过 LLM 智能推断转化为在线表单，外部人员通过公开链接填写后数据实时回流到 SheetBot 表格。

## 架构

```
collect/
├── __init__.py     # 模块入口
├── models.py       # Form + FormSubmission SQLAlchemy 模型
├── schemas.py      # Pydantic 请求/响应 DTO
├── router.py       # FastAPI 路由（认证端点 + 公开端点）
├── service.py      # 业务逻辑（CRUD / 提交处理 / 同步 xlsx）
├── form_ai.py      # LLM 字段推断（通过 Claude Agent SDK）
└── CLAUDE.md       # 本文件
```

## 数据流

```
列头 → LLM 推断 → 字段配置 → 发布表单 → 生成 share_token
                                              ↓
外部填写 (PublicForm) → POST submit → FormSubmission → 同步到 xlsx
```

## API 端点

| 类型 | 前缀 | 说明 |
|------|------|------|
| 认证 | `/api/collect` | 表单 CRUD、AI 配置、提交列表、同步 |
| 公开 | `/api/public/form` | 获取表单配置、提交数据（无需登录） |

## 依赖

- `report.llm_client.call_llm_single` - LLM 调用
- `auth.models.User` - 用户模型
- `files.models.UserFile` - 关联文件（同步时延迟导入）
- `openpyxl` - 同步时追加行到 xlsx

## 隔离规则

本模块完全独立于 `agent/`、`large_file/`、`pptx/` 等模块，不存在交叉导入。
