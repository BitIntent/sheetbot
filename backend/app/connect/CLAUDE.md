# 外部系统连接器模块 (`connect/`)

## 架构定位

打通外部系统 API，配置数据源自动同步到 Excel 工作表。支持六种连接器类型，涵盖电商、企业办公、数据库、通用 API 等主流场景。

## 目录结构

```
connect/
├── CLAUDE.md               # 本文件 - 模块架构文档
├── __init__.py              # 模块入口
├── models.py                # ORM 模型: connectors + sync_jobs
├── schemas.py               # Pydantic 请求/响应模型
├── router.py                # 认证路由 + Webhook 公开路由
├── service.py               # CRUD / 状态查询 / 同步任务管理
├── sync_engine.py           # 同步执行引擎: 拉取 + 映射 + 写入
├── writer.py                # 数据写入: 字段映射 + openpyxl 追加行
├── scheduler.py             # asyncio 定时调度器
└── adapters/                # 连接器适配器
    ├── __init__.py          # 适配器工厂 get_adapter()
    ├── base.py              # 抽象基类 BaseAdapter
    ├── shopify.py           # Shopify REST Admin API
    ├── dingtalk.py          # 钉钉企业内部应用
    ├── wecom.py             # 企业微信
    ├── database.py          # MySQL / PostgreSQL
    ├── webhook.py           # 被动接收推送
    └── custom_api.py        # 通用 HTTP API
```

## 数据流

```
用户创建连接器 → 配置认证信息 + 字段映射 → 启用
                                          ↓
              ┌─── 手动触发 sync ──→ execute_sync()
              │                         ↓
调度器扫描 ───┤               adapter.fetch_data()
              │                         ↓
              └─── 定时到期 ───→  writer.write_rows_to_xlsx()
                                        ↓
                                  Excel 工作表追加行
```

## API 端点

- `GET    /api/connect/connectors`           - 列出连接器
- `POST   /api/connect/connectors`           - 创建连接器
- `GET    /api/connect/connectors/{id}`      - 连接器详情
- `PUT    /api/connect/connectors/{id}`      - 更新配置
- `PUT    /api/connect/connectors/{id}/status` - 切换状态
- `DELETE /api/connect/connectors/{id}`      - 删除
- `POST   /api/connect/connectors/{id}/sync` - 手动同步
- `GET    /api/connect/connectors/{id}/jobs` - 同步历史
- `POST   /api/connect/connectors/test`      - 测试连接
- `POST   /api/webhook/{endpoint_token}`     - Webhook 公开端点

## 隔离原则

本模块与 `agent/`、`large_file/`、`collect/` 完全独立。唯一共享的基础设施是 `utils/logger.py`、`core/database.py` 和 `files/models.py`（读取文件路径）。
