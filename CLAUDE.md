# SheetBot - 项目架构文档（开源版）

## 核心原则：双模式严格隔离

| 维度 | 普通模式 | 大文件模式 |
|------|----------|------------|
| 适用场景 | 小型 Excel (<50MB) | 大型 Excel (>50MB) |
| 数据存储 | 前端内存 (Univer) | 服务端 DuckDB |
| 后端模块 | `backend/app/agent/` | `backend/app/large_file/` |
| 前端入口 | `handleSendCommand()` | `handleLargeFileUpload()` |
| 通信方式 | SSE | HTTP REST API |

**禁止** `agent/` 与 `large_file/` 互相 import；禁止混用 API 端点。

## 目录结构

```
sheetbot/
├── backend/app/
│   ├── main.py              # FastAPI 入口
│   ├── agent/               # 普通模式 Agent + 分析编译器
│   ├── large_file/          # 大文件 DuckDB 管线
│   ├── report/              # 智能报表
│   ├── pptx/                # PPT 汇报
│   ├── batch_word/          # 批量转 Word
│   ├── collect/             # 在线表单
│   ├── connect/             # 外部连接器
│   ├── auth/                # 用户认证
│   ├── plans/               # 套餐模型 + 公开定价 + 只读订阅查询（不含支付）
│   ├── config/              # 用户偏好 / platform_settings
│   ├── formula/             # 自定义公式
│   └── skill/               # 技能库
├── frontend/src/
│   ├── App.jsx              # 主应用（模式切换）
│   ├── univer/              # Univer Canvas 宿主
│   ├── components/          # 业务 UI
│   ├── api/plans.js         # GET /api/plans/my
│   └── utils/               # excelOperations / skillExecutor 等
├── db/                      # schema.sql 结构参考
├── uploads/                 # UGC 四分区（不入库）
├── docs-site/               # Docusaurus 帮助中心
├── manage.py                # 服务管理
└── Caddyfile                # 自托管静态 + API 反代
```

## 普通模式分析：四层架构

```
用户指令 → prompt_expander（元数据扩展，无 LLM）
        → excel_agent（选维度，submit_analysis_plan）
        → plan_contract + plan_compiler（确定性 operations）
        → 前端 excelOperations / Univer 执行
```

## 套餐与配额（无在线支付）

- `subscription_plans` / `user_subscriptions` / `usage_records`：配额限流
- `GET /api/public/plans`：landing 定价展示
- `GET /api/plans/my`：用户中心只读当前套餐
- 升级/续费：开源版通过人工分配套餐，无微信支付模块

## UGC 存储

统一 `uploads/{类型}_files/YYYY-MM-DD/`；禁止写入 `backend/uploads/`。

## LLM 调用

禁止直接 `import anthropic`；统一经 Claude Agent SDK 或 `report/llm_client.call_llm_single()`。

## 变更日志

### 2026-06-09（开源预处理 + 移除微信支付 + 移除 Alembic）
- 删除 `admin/`、`site/`、远程部署脚本、含用户数据的 SQL 导出
- 删除 `backend/app/payment/` 及前端 `UpgradeModal` / `api/payment.js`
- 套餐查询迁移至 `GET /api/plans/my`；landing 付费按钮改为邮件咨询
- `db/schema.sql` 移除支付相关表；`Caddyfile` 简化为自托管单站点
- 套餐模型自包含于 `backend/app/plans/`（不再依赖 admin 模块）
- 删除 `backend/alembic/` 与 `alembic.ini`；数据库初始化统一用 `db/schema.sql`
