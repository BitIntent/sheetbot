# backend/app/skill — 技能库模块

## 职责

为用户提供可复用的文件级自动化技能：将多个原子 Excel 操作编排为有序序列，通过 REST API 持久化，由前端沙箱执行（无后端运行时依赖）。

## 文件结构

```
skill/
├── __init__.py        # 模块入口
├── models.py          # Skill ORM 模型（skills 表）
├── schemas.py         # Pydantic 请求/响应模型
├── service.py         # CRUD + 预设播种逻辑
├── router.py          # REST API（GET/POST/PUT/DELETE）
└── CLAUDE.md          # 本文件
```

## 核心数据结构

- `steps` — JSON 数组，每个步骤含 `id`, `label`, `operation_type`, `params`
- `scope` — 执行范围：`all_sheets` 或 `named_sheet`
- `tags` — 分类标签数组
- `is_preset` — 预设技能由系统播种，不可删除

## API 端点

| 方法   | 路径                  | 说明         |
|--------|-----------------------|--------------|
| GET    | /api/skill/list       | 获取全部技能 |
| POST   | /api/skill            | 新建技能     |
| PUT    | /api/skill/{skill_id} | 更新技能     |
| DELETE | /api/skill/{skill_id} | 删除技能     |

## 变更日志

### 2026-02-20
- 初始建立，对称 formula 模块结构
- 预设两个示例技能：报表格式化、数据清洗
