# frontend/src/components 架构说明

## 目录职责

- `SkillManagerPage.jsx`：玩数据 Skill 视图主容器，负责技能列表、编辑表单、执行入口、工作表预览与范围选择交互。
- `SkillStepBuilder.jsx`：技能步骤可视化编排器，拖拽添加步骤、类型化参数编辑、步骤排序。
- `SkillParamWidgets.jsx`：参数 UI 组件库（RangeInput, ColorPicker, NumberInput, BooleanToggle, SelectInput 等 12 个组件），根据参数 schema 的 type 字段渲染专属交互控件。
- `skillOperationConfigs.js`：65 个用户友好技能的配置中心（分 12 类），定义 SKILL_PALETTE（技能箱面板）和 SKILL_CONFIGS（参数 schema，每个参数含 type/label/options/default）。

## 关键设计决策

### 双层操作模型

```
用户操作层（65 个技能，A1:C10 范围，UI 组件配置）
        |
        v
翻译层 (skillTranslator.js: translateSkillOp)
        |
        v
执行层 (excelOperations.js: executeOperation，不变)
```

- **配置驱动渲染**：ParamsEditor 根据 SKILL_CONFIGS 中的参数 schema 自动选择 UI 组件（range -> RangeInput, color -> ColorPicker, boolean -> BooleanToggle），无 if-else 分支。
- **A1 表示法优先**：范围参数统一使用 A1:C10 格式，翻译层自动转换为 startRow/startCol/endRow/endCol 数字坐标。
- **范围点击选择**：RangeInput/CellInput 支持从预览表格点击/拖拽选择，通过 onRequestRangeSelect 回调链打通 Widget -> StepBuilder -> ManagerPage -> 预览表格。
- **向后兼容**：旧版操作类型（set_range_style 等）通过 isLegacyOp() 识别，直接走 executeOperation 不翻译。

## 依赖关系

```
SkillManagerPage.jsx
  -> SkillStepBuilder.jsx
     -> skillOperationConfigs.js (SKILL_PALETTE, SKILL_CONFIGS)
     -> SkillParamWidgets.jsx (ParamWidget, WIDGET_MAP)
  -> ../utils/skillTranslator.js (colToLetter - 预览表格)
  -> ../utils/skillMdSerializer.js (导入/导出 .md)
  -> ../api/skill.js (CRUD API)

SkillParamWidgets.jsx 无外部组件依赖，仅依赖 lucide-react 图标。
```

## 变更日志

- 2026-02-20：技能箱 v2 重构 - 65 个用户友好技能替代旧 34 个技术性操作，类型化参数 UI 组件替代纯文本输入，新增翻译层和范围选择交互。
- 2026-02-20（早期）：将 Skill 操作配置从 SkillStepBuilder.jsx 拆分至 skillOperationConfigs.js。
- 2026-05-08：移除 `FirstLoginWelcome.jsx` 首次登录引导组件，首次登录后不再进入新手操作引导页，统一直接进入主工作区。
