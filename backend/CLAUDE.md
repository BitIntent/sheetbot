# SheetBot 后端架构

## 入口

`app/main.py`：FastAPI 应用，挂载各业务 router，启动时 `plans.seed` 播种套餐。

## 模块边界

| 目录 | 职责 | API 前缀 |
|------|------|----------|
| `agent/` | 普通模式 AI + 分析编译器 | `/api/excel/*`, `/sse/*` |
| `large_file/` | 大文件 DuckDB | `/api/large-file/*` |
| `report/` | 智能报表 SSE | `/api/report/*` |
| `pptx/` | PPT 汇报 | `/api/pptx/*` |
| `batch_word/` | 批量转 Word | `/api/batch-word/*` |
| `collect/` | 表单收集 | `/api/collect/*`, `/api/public/form/*` |
| `connect/` | 外部连接器 | `/api/connect/*`, `/api/webhook/*` |
| `auth/` | 注册登录 JWT | `/api/auth/*` |
| `plans/` | 套餐 + 配额模型 | `/api/public/plans`, `/api/plans/my` |
| `config/` | 用户偏好 | `/api/config/*` |
| `formula/` | 自定义公式 | `/api/formula/*` |
| `skill/` | 技能库 | `/api/skill/*` |

`agent/` 与 `large_file/` **禁止**互相 import。

## 套餐模块（plans/）

- `models.py`：`SubscriptionPlan` / `UserSubscription` / `UsageRecord` / `SystemAnnouncement`
- `seed.py`：启动播种 free/pro/premium 默认配额
- `public_router.py`：landing 公开定价卡片
- `router.py`：认证用户当前有效订阅（只读，无支付）
- `plan_presentation.py`：DB 行 → 前台展示 DTO

配额检查：`core/quota.py` `QuotaGuard`，用量：`core/usage_service.py`。

## 分析确定性管线（agent/）

- `prompt_expander.py`：模糊指令元数据扩展
- `plan_contract.py` + `plan_compiler.py`：plan → operations，零 LLM
- `excel_tools.submit_analysis_plan`：分析类任务唯一入口
- `operation_registry.py`：60+ 操作单一真相源

## 数据库

- 结构真源：`db/schema.sql`（新环境直接 `mysql ... < db/schema.sql` 初始化）
- ORM 定义：`app/**/models.py`；启动时 `create_all` 可补全缺失表（开发兜底）

## 变更日志

### 2026-06-09
- 移除 `payment/` 模块与 `WECHATPAY_*` 配置
- 新增 `plans/router.py` 替代 `/api/payment/my-subscription`
- 移除 Alembic 迁移目录，避免暴露内部维护历史
