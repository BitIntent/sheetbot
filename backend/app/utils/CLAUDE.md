# utils 模块架构说明

## 模块定位

`utils/` 提供跨业务模块共享的基础设施能力，不承载具体业务流程。

## 目录结构

```text
utils/
├── __init__.py            # 对外导出基础工具
├── logger.py              # 统一日志封装
├── access_logger.py       # Access 日志落盘（JSONL，按天切分）
├── context_budget.py      # schema 压缩与 prompt 长度预算
└── json_output_guard.py   # LLM JSON 输出守卫（提取/容错/回退编排）
```

## 设计约束

1. 只放“可跨模块复用”的能力，不放业务规则。
2. 工具函数必须可组合，避免模块间重复实现同类逻辑。
3. 任何新增共享能力需同步在本文件登记，保持边界清晰。

## 变更记录

### 2026-03-11
- 新增 `access_logger.py`，统一写入 `logs/access/access-YYYY-MM-DD.log` 的 access 日志能力。

### 2026-03-03
- 新增 `json_output_guard.py`，统一 `report` 与 `pptx` 的 JSON 提取与容错回退链路。
