# large_file 目录文件说明

## 必需文件（运行时需要）

### 核心功能文件
- **`report_exporter.js`** ✅ **必需** - Node.js 脚本，用于报表导出（PDF/Word/PNG）
  - 被 `report_exporter.py` 调用
  - 实际执行导出工作
  - **不能删除**

- **`report_exporter.py`** ✅ **必需** - Python 包装器，调用 Node.js 脚本
- **`report_generator.py`** ✅ **必需** - 报表生成核心逻辑
- **`large_file_*.py`** ✅ **必需** - 大文件处理相关模块
- **`schemas.py`** ✅ **必需** - 数据模型定义
- **`storage.py`** ✅ **必需** - 存储管理

## 临时工具文件（可以删除）

### 验证和调试工具
- **`verify_modules.sh`** ⚠️ **可删除** - 模块验证脚本
  - 用于验证 Node.js 模块安装情况
  - 验证完成后可以删除
  - 建议：保留在开发环境，生产环境可删除

- **`README_VERIFY.md`** ⚠️ **可删除** - 验证说明文档
  - 验证步骤说明
  - 验证完成后可以删除

## 清理建议

### 生产环境清理

```bash
cd 项目根目录（sheetbot/）/backend/app/large_file

# 删除验证工具（可选）
rm -f verify_modules.sh
rm -f README_VERIFY.md
```

### 开发环境保留

如果还需要调试或验证，可以保留这些文件。

## 文件依赖关系

```
report_exporter.py (Python)
    └── 调用 ──> report_exporter.js (Node.js)
                      └── 使用 ──> frontend/node_modules/{puppeteer,docx,sharp}
```

## 总结

- ✅ **保留**: `report_exporter.js` - 运行时必需
- ⚠️ **可选删除**: `verify_modules.sh`, `README_VERIFY.md` - 临时工具
