# plans/ - 套餐与订阅

## 职责

套餐 ORM、启动播种、公开定价 API、用户当前订阅只读查询。**不含在线支付。**

## 文件

| 文件 | 用途 |
|------|------|
| `models.py` | `subscription_plans` / `user_subscriptions` / `usage_records` / `system_announcements` |
| `seed.py` | 首次启动写入默认套餐与配额 |
| `plan_presentation.py` | 套餐行 → landing 卡片 JSON |
| `public_router.py` | `GET /api/public/plans` |
| `router.py` | `GET /api/plans/my`（需 JWT） |

## 依赖

- 被 `core/quota.py` 读取配额
- 被 `main.py` 启动时调用 `seed_subscription_plans()`
- 前端 `api/plans.js` → `UserCenterPanel` 展示当前套餐

## 升级路径

开源版通过数据库或管理脚本直接写入 `user_subscriptions`；不提供微信支付回调。
