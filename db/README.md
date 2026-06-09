# 数据库

## 初始化

```bash
mysql -h localhost -u sheetbot_user -p sheetbot_db < db/schema.sql
```

## 文件

| 文件 | 说明 |
|------|------|
| `schema.sql` | 完整库表结构（MySQL 8.0+，utf8mb4） |

## 表分组

**认证**：`users` `refresh_tokens` `password_reset_tokens` `user_sessions`

**套餐**：`subscription_plans` `user_subscriptions` `usage_records`

**业务**：`custom_formulas` `skills` `forms` `form_submissions` `connectors` `sync_jobs`

**报表**：`report_cache` `shared_reports` `report_tasks` `notifications`

**配置**：`user_preferences` `platform_settings` `system_announcements`

ORM 定义见 `backend/app/**/models.py`。
