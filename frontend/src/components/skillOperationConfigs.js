// ============================================================================
// 玩数据 Skill - 技能配置中心 (v2)
//
// 65 个用户友好技能 x 12 个类别
// 每个参数有明确的 type，前端根据 type 渲染专属 UI 组件
// sheet 参数由执行引擎自动注入，用户无需配置
// ============================================================================

// ============================================================================
// 技能箱面板 - 分类与技能清单
// ============================================================================

export const SKILL_PALETTE = [
  {
    category: '字体与样式',
    skills: [
      { type: 'set_font', label: '设置字体' },
      { type: 'set_fill', label: '填充颜色' },
      { type: 'set_alignment', label: '对齐方式' },
      { type: 'set_border', label: '边框设置' },
      { type: 'set_number_format', label: '数字格式' },
      { type: 'clear_format', label: '清除格式' },
    ],
  },
  {
    category: '快捷样式',
    skills: [
      { type: 'header_beautify', label: '表头美化' },
      { type: 'zebra_stripe', label: '斑马纹' },
      { type: 'percent_format', label: '百分比格式' },
      { type: 'currency_format', label: '货币格式' },
      { type: 'date_format', label: '日期格式' },
      { type: 'wrap_text', label: '文本换行' },
    ],
  },
  {
    category: '条件格式',
    skills: [
      { type: 'cond_highlight', label: '条件高亮' },
      { type: 'cond_color_scale', label: '条件色阶' },
      { type: 'cond_data_bar', label: '条件数据条' },
      { type: 'clear_cond_format', label: '清除条件格式' },
    ],
  },
  {
    category: '单元格编辑',
    skills: [
      { type: 'set_value', label: '填写值' },
      { type: 'batch_fill', label: '批量填写' },
      { type: 'set_values', label: '批量写入' },
      { type: 'set_formula', label: '写入公式' },
      { type: 'find_replace', label: '查找替换' },
      { type: 'clear_content', label: '清除内容' },
      { type: 'clear_cell', label: '清除单元格' },
      { type: 'copy_paste', label: '复制粘贴' },
    ],
  },
  {
    category: '快捷公式',
    skills: [
      { type: 'quick_sum', label: '求和 SUM' },
      { type: 'quick_average', label: '平均值 AVG' },
      { type: 'quick_count', label: '计数 COUNT' },
      { type: 'quick_max', label: '最大值 MAX' },
      { type: 'quick_min', label: '最小值 MIN' },
      { type: 'custom_formula', label: '自定义公式' },
    ],
  },
  {
    category: '行操作',
    skills: [
      { type: 'insert_rows', label: '插入行' },
      { type: 'delete_rows', label: '删除行' },
      { type: 'set_row_height', label: '设置行高' },
      { type: 'hide_rows', label: '隐藏行' },
      { type: 'show_rows', label: '显示行' },
    ],
  },
  {
    category: '列操作',
    skills: [
      { type: 'insert_columns', label: '插入列' },
      { type: 'delete_columns', label: '删除列' },
      { type: 'set_column_width', label: '设置列宽' },
      { type: 'auto_fit_column', label: '自适应列宽' },
      { type: 'hide_columns', label: '隐藏列' },
      { type: 'show_columns', label: '显示列' },
    ],
  },
  {
    category: '单元格操作',
    skills: [
      { type: 'merge_cells', label: '合并单元格' },
      { type: 'unmerge_cells', label: '取消合并' },
      { type: 'freeze_panes', label: '冻结窗格' },
      { type: 'unfreeze_panes', label: '取消冻结' },
      { type: 'fill_series', label: '填充序列' },
    ],
  },
  {
    category: '批注与链接',
    skills: [
      { type: 'add_comment', label: '添加批注' },
      { type: 'update_comment', label: '修改批注' },
      { type: 'delete_comment', label: '删除批注' },
      { type: 'set_hyperlink', label: '设置超链接' },
      { type: 'remove_hyperlink', label: '删除超链接' },
    ],
  },
  {
    category: '数据验证',
    skills: [
      { type: 'validate_list', label: '下拉列表' },
      { type: 'validate_number', label: '数值范围' },
      { type: 'clear_validation', label: '清除验证' },
    ],
  },
  {
    category: '数据处理',
    skills: [
      { type: 'sort_range', label: '排序' },
      { type: 'multi_sort', label: '多列排序' },
      { type: 'remove_duplicates', label: '去重' },
      { type: 'filter_data', label: '筛选' },
      { type: 'clear_filter', label: '清除筛选' },
      { type: 'query_unique', label: '统计值次数' },
    ],
  },
  {
    category: '数据分析',
    skills: [
      { type: 'pivot_table', label: '创建透视表' },
      { type: 'pivot_data', label: '生成透视数据' },
      { type: 'calc_statistics', label: '统计计算' },
      { type: 'summarize_column', label: '按列汇总' },
      { type: 'summarize_metrics', label: '多指标汇总' },
    ],
  },
]

// ============================================================================
// 技能详细配置 - 参数 Schema
//
// 参数 type 与前端 UI 组件映射：
//   range    -> RangeInput     (A1:C10 文本框 + 点击预览表格选择)
//   cell     -> CellInput      (A1 文本框 + 点击选择)
//   row      -> RowInput       (行号数字输入)
//   column   -> ColumnInput    (列字母选择, A/B/C)
//   color    -> ColorPicker    (色板 + 自定义颜色)
//   number   -> NumberInput    (数字微调器)
//   boolean  -> BooleanToggle  (开关)
//   select   -> SelectInput    (下拉选择)
//   text     -> TextInput      (文本输入)
//   formula  -> FormulaInput   (公式输入, 自动补 =)
//   items    -> ItemsInput     (逗号分隔的列表输入)
//   columns  -> MultiColumnInput (多列选择, A,B,C)
// ============================================================================

export const SKILL_CONFIGS = {

  // ------------------------------------------------------------------
  // 1. 字体与样式
  // ------------------------------------------------------------------

  set_font: {
    label: '设置字体',
    description: '设置区域的字体属性（加粗、斜体、字号、颜色等）',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'bold', label: '加粗', type: 'boolean', default: false },
      { key: 'italic', label: '斜体', type: 'boolean', default: false },
      { key: 'underline', label: '下划线', type: 'boolean', default: false },
      { key: 'strikethrough', label: '删除线', type: 'boolean', default: false },
      { key: 'fontSize', label: '字号', type: 'number', min: 6, max: 72, step: 1, default: 11 },
      { key: 'fontColor', label: '字体颜色', type: 'color', default: '#000000' },
      { key: 'fontFamily', label: '字体', type: 'select', default: 'Arial', options: [
        { value: 'Arial', label: 'Arial' },
        { value: 'Times New Roman', label: 'Times New Roman' },
        { value: 'Calibri', label: 'Calibri' },
        { value: 'Consolas', label: 'Consolas' },
        { value: '微软雅黑', label: '微软雅黑' },
        { value: '宋体', label: '宋体' },
        { value: '黑体', label: '黑体' },
        { value: '楷体', label: '楷体' },
      ]},
    ],
  },

  set_fill: {
    label: '填充颜色',
    description: '设置区域的背景填充颜色',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'fillColor', label: '填充颜色', type: 'color', required: true, default: '#DBEAFE' },
    ],
  },

  set_alignment: {
    label: '对齐方式',
    description: '设置区域的水平/垂直对齐与文本控制',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'horizontal', label: '水平对齐', type: 'select', default: 'center', options: [
        { value: 'left', label: '左对齐' },
        { value: 'center', label: '居中' },
        { value: 'right', label: '右对齐' },
      ]},
      { key: 'vertical', label: '垂直对齐', type: 'select', default: 'middle', options: [
        { value: 'top', label: '顶部' },
        { value: 'middle', label: '居中' },
        { value: 'bottom', label: '底部' },
      ]},
      { key: 'wrapText', label: '自动换行', type: 'boolean', default: false },
      { key: 'indent', label: '缩进', type: 'number', min: 0, max: 15, step: 1, default: 0 },
      { key: 'textRotation', label: '文字旋转角度', type: 'number', min: -90, max: 90, step: 15, default: 0 },
    ],
  },

  set_border: {
    label: '边框设置',
    description: '设置区域的边框样式与颜色',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'borderStyle', label: '线型', type: 'select', default: 'thin', options: [
        { value: 'thin', label: '细线' },
        { value: 'medium', label: '中等' },
        { value: 'thick', label: '粗线' },
        { value: 'dashed', label: '虚线' },
        { value: 'dotted', label: '点线' },
        { value: 'double', label: '双线' },
        { value: 'none', label: '无边框' },
      ]},
      { key: 'borderColor', label: '边框颜色', type: 'color', default: '#000000' },
      { key: 'borderPosition', label: '边框位置', type: 'select', default: 'all', options: [
        { value: 'all', label: '所有边框' },
        { value: 'outside', label: '外边框' },
        { value: 'top', label: '上边框' },
        { value: 'bottom', label: '下边框' },
        { value: 'left', label: '左边框' },
        { value: 'right', label: '右边框' },
      ]},
    ],
  },

  set_number_format: {
    label: '数字格式',
    description: '设置区域的数字显示格式',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'format', label: '格式类型', type: 'select', required: true, default: 'number', options: [
        { value: 'general', label: '常规' },
        { value: 'number', label: '数字 (1,234.56)' },
        { value: 'percent', label: '百分比 (12.34%)' },
        { value: 'currency', label: '货币 ($1,234)' },
        { value: 'date', label: '日期 (2026-01-01)' },
        { value: 'text', label: '文本' },
        { value: 'custom', label: '自定义' },
      ]},
      { key: 'decimals', label: '小数位数', type: 'number', min: 0, max: 10, step: 1, default: 2 },
      { key: 'customFormat', label: '自定义格式串', type: 'text', default: '#,##0.00',
        visibleWhen: { key: 'format', value: 'custom' } },
    ],
  },

  clear_format: {
    label: '清除格式',
    description: '清除区域的所有格式，保留数据',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
    ],
  },

  // ------------------------------------------------------------------
  // 2. 快捷样式
  // ------------------------------------------------------------------

  header_beautify: {
    label: '表头美化',
    description: '一键美化表头：加粗 + 填充色 + 居中 + 边框',
    params: [
      { key: 'range', label: '表头范围', type: 'range', required: true, default: 'A1:{{sheet.lastColLetter}}1' },
      { key: 'theme', label: '主题', type: 'select', default: 'blue', options: [
        { value: 'blue', label: '蓝色' },
        { value: 'green', label: '绿色' },
        { value: 'orange', label: '橙色' },
        { value: 'dark', label: '深色' },
        { value: 'purple', label: '紫色' },
      ]},
      { key: 'fontColor', label: '字体颜色', type: 'color', default: '#FFFFFF' },
    ],
  },

  zebra_stripe: {
    label: '斑马纹',
    description: '为数据区域添加交替行颜色',
    params: [
      { key: 'range', label: '数据范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'color1', label: '奇数行颜色', type: 'color', default: '#FFFFFF' },
      { key: 'color2', label: '偶数行颜色', type: 'color', default: '#F0F4FF' },
    ],
  },

  percent_format: {
    label: '百分比格式',
    description: '将区域数字显示为百分比',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'decimals', label: '小数位数', type: 'number', min: 0, max: 6, step: 1, default: 1 },
    ],
  },

  currency_format: {
    label: '货币格式',
    description: '将区域数字显示为货币格式',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'symbol', label: '货币符号', type: 'select', default: '¥', options: [
        { value: '¥', label: '¥ 人民币' },
        { value: '$', label: '$ 美元' },
        { value: '€', label: '€ 欧元' },
        { value: '£', label: '£ 英镑' },
      ]},
      { key: 'decimals', label: '小数位数', type: 'number', min: 0, max: 4, step: 1, default: 2 },
    ],
  },

  date_format: {
    label: '日期格式',
    description: '将区域设置为日期显示格式',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'datePattern', label: '日期格式', type: 'select', default: 'yyyy-mm-dd', options: [
        { value: 'yyyy-mm-dd', label: '2026-01-15' },
        { value: 'yyyy/mm/dd', label: '2026/01/15' },
        { value: 'mm-dd', label: '01-15' },
        { value: 'yyyy"年"mm"月"dd"日"', label: '2026年01月15日' },
        { value: 'mm/dd/yyyy', label: '01/15/2026' },
      ]},
    ],
  },

  wrap_text: {
    label: '文本换行',
    description: '开启区域自动换行',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
    ],
  },

  // ------------------------------------------------------------------
  // 3. 条件格式
  // ------------------------------------------------------------------

  cond_highlight: {
    label: '条件高亮',
    description: '满足条件的单元格高亮显示',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'operator', label: '条件', type: 'select', required: true, default: 'greaterThan', options: [
        { value: 'greaterThan', label: '大于' },
        { value: 'lessThan', label: '小于' },
        { value: 'equal', label: '等于' },
        { value: 'notEqual', label: '不等于' },
        { value: 'between', label: '介于' },
        { value: 'contains', label: '包含' },
        { value: 'notContains', label: '不包含' },
      ]},
      { key: 'value', label: '比较值', type: 'text', required: true, default: '100' },
      { key: 'value2', label: '上限值', type: 'text', default: '200',
        visibleWhen: { key: 'operator', value: 'between' } },
      { key: 'highlightColor', label: '高亮背景色', type: 'color', default: '#FEE2E2' },
      { key: 'fontColor', label: '字体颜色', type: 'color', default: '#B91C1C' },
    ],
  },

  cond_color_scale: {
    label: '条件色阶',
    description: '按数值大小用渐变色显示',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'minColor', label: '最小值颜色', type: 'color', default: '#DCFCE7' },
      { key: 'maxColor', label: '最大值颜色', type: 'color', default: '#FEE2E2' },
    ],
  },

  cond_data_bar: {
    label: '条件数据条',
    description: '在单元格内显示数据条',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'barColor', label: '数据条颜色', type: 'color', default: '#60A5FA' },
    ],
  },

  clear_cond_format: {
    label: '清除条件格式',
    description: '清除区域的所有条件格式',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
    ],
  },

  // ------------------------------------------------------------------
  // 4. 单元格编辑
  // ------------------------------------------------------------------

  set_value: {
    label: '填写值',
    description: '向单个单元格写入值',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'value', label: '值', type: 'text', required: true, default: '' },
    ],
  },

  batch_fill: {
    label: '批量填写',
    description: '向区域内所有单元格填写相同值',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'value', label: '填写值', type: 'text', required: true, default: '' },
    ],
  },

  set_values: {
    label: '批量写入',
    description: '从起始单元格开始写入二维数据',
    params: [
      { key: 'startCell', label: '起始单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'values', label: '数据（二维数组）', type: 'text', required: true,
        default: '[["产品","数量","金额"],["A款",10,199.9]]',
        placeholder: '[["A","B"],["C","D"]]' },
    ],
  },

  set_formula: {
    label: '写入公式',
    description: '向单元格写入 Excel 公式',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'formula', label: '公式', type: 'formula', required: true, default: '=SUM(B2:B10)' },
    ],
  },

  find_replace: {
    label: '查找替换',
    description: '在工作表中查找并替换文本',
    params: [
      { key: 'find', label: '查找内容', type: 'text', required: true, default: '' },
      { key: 'replace', label: '替换为', type: 'text', required: true, default: '' },
      { key: 'matchCase', label: '区分大小写', type: 'boolean', default: false },
      { key: 'matchWholeCell', label: '全单元格匹配', type: 'boolean', default: false },
    ],
  },

  clear_content: {
    label: '清除内容',
    description: '清除区域数据（可选同时清除格式）',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'clearFormat', label: '同时清除格式', type: 'boolean', default: false },
    ],
  },

  clear_cell: {
    label: '清除单元格',
    description: '清除单个单元格的内容',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'clearFormat', label: '同时清除格式', type: 'boolean', default: false },
    ],
  },

  copy_paste: {
    label: '复制粘贴',
    description: '将源区域复制到目标位置',
    params: [
      { key: 'sourceRange', label: '源区域', type: 'range', required: true, default: 'A1:C10' },
      { key: 'targetCell', label: '粘贴位置', type: 'cell', required: true, default: 'E1' },
      { key: 'valuesOnly', label: '仅粘贴值', type: 'boolean', default: false },
    ],
  },

  // ------------------------------------------------------------------
  // 5. 快捷公式
  // ------------------------------------------------------------------

  quick_sum: {
    label: '求和 SUM',
    description: '对区域求和，结果写入指定单元格',
    params: [
      { key: 'dataRange', label: '数据范围', type: 'range', required: true, default: 'B2:B10' },
      { key: 'outputCell', label: '输出位置', type: 'cell', required: true, default: 'B11' },
    ],
  },

  quick_average: {
    label: '平均值 AVG',
    description: '计算区域平均值',
    params: [
      { key: 'dataRange', label: '数据范围', type: 'range', required: true, default: 'B2:B10' },
      { key: 'outputCell', label: '输出位置', type: 'cell', required: true, default: 'B11' },
    ],
  },

  quick_count: {
    label: '计数 COUNT',
    description: '计算区域非空单元格个数',
    params: [
      { key: 'dataRange', label: '数据范围', type: 'range', required: true, default: 'B2:B10' },
      { key: 'outputCell', label: '输出位置', type: 'cell', required: true, default: 'B11' },
    ],
  },

  quick_max: {
    label: '最大值 MAX',
    description: '获取区域最大值',
    params: [
      { key: 'dataRange', label: '数据范围', type: 'range', required: true, default: 'B2:B10' },
      { key: 'outputCell', label: '输出位置', type: 'cell', required: true, default: 'B11' },
    ],
  },

  quick_min: {
    label: '最小值 MIN',
    description: '获取区域最小值',
    params: [
      { key: 'dataRange', label: '数据范围', type: 'range', required: true, default: 'B2:B10' },
      { key: 'outputCell', label: '输出位置', type: 'cell', required: true, default: 'B11' },
    ],
  },

  custom_formula: {
    label: '自定义公式',
    description: '用表达式批量填充列（支持列引用）',
    params: [
      { key: 'targetColumn', label: '目标列', type: 'column', required: true, default: 'C' },
      { key: 'startRow', label: '起始行', type: 'row', required: true, default: 2 },
      { key: 'endRow', label: '结束行', type: 'row', required: true, default: 10 },
      { key: 'expression', label: '表达式', type: 'text', required: true,
        default: 'E*F', placeholder: '示例：E*F（也兼容 [E]*[F]、{E}*{F}）' },
    ],
  },

  // ------------------------------------------------------------------
  // 6. 行操作
  // ------------------------------------------------------------------

  insert_rows: {
    label: '插入行',
    description: '在指定位置插入空行',
    params: [
      { key: 'row', label: '插入位置（行号）', type: 'row', required: true, default: 1 },
      { key: 'count', label: '插入行数', type: 'number', min: 1, max: 1000, step: 1, default: 1 },
    ],
  },

  delete_rows: {
    label: '删除行',
    description: '删除指定位置的行',
    params: [
      { key: 'row', label: '起始行号', type: 'row', required: true, default: 1 },
      { key: 'count', label: '删除行数', type: 'number', min: 1, max: 1000, step: 1, default: 1 },
    ],
  },

  set_row_height: {
    label: '设置行高',
    description: '设置指定行的高度',
    params: [
      { key: 'row', label: '行号', type: 'row', required: true, default: 1 },
      { key: 'height', label: '行高（像素）', type: 'number', min: 1, max: 500, step: 1, default: 24 },
    ],
  },

  hide_rows: {
    label: '隐藏行',
    description: '隐藏指定行',
    params: [
      { key: 'row', label: '行号', type: 'row', required: true, default: 1 },
    ],
  },

  show_rows: {
    label: '显示行',
    description: '显示已隐藏的行',
    params: [
      { key: 'row', label: '行号', type: 'row', required: true, default: 1 },
    ],
  },

  // ------------------------------------------------------------------
  // 7. 列操作
  // ------------------------------------------------------------------

  insert_columns: {
    label: '插入列',
    description: '在指定位置插入空列',
    params: [
      { key: 'column', label: '插入位置（列）', type: 'column', required: true, default: 'A' },
      { key: 'count', label: '插入列数', type: 'number', min: 1, max: 100, step: 1, default: 1 },
    ],
  },

  delete_columns: {
    label: '删除列',
    description: '删除指定列',
    params: [
      { key: 'column', label: '起始列', type: 'column', required: true, default: 'A' },
      { key: 'count', label: '删除列数', type: 'number', min: 1, max: 100, step: 1, default: 1 },
    ],
  },

  set_column_width: {
    label: '设置列宽',
    description: '设置指定列的宽度',
    params: [
      { key: 'column', label: '列', type: 'column', required: true, default: 'A' },
      { key: 'width', label: '列宽', type: 'number', min: 1, max: 255, step: 1, default: 18 },
    ],
  },

  auto_fit_column: {
    label: '自适应列宽',
    description: '根据内容自动调整列宽',
    params: [
      { key: 'column', label: '列', type: 'column', required: true, default: 'A' },
    ],
  },

  hide_columns: {
    label: '隐藏列',
    description: '隐藏指定列',
    params: [
      { key: 'column', label: '列', type: 'column', required: true, default: 'A' },
    ],
  },

  show_columns: {
    label: '显示列',
    description: '显示已隐藏的列',
    params: [
      { key: 'column', label: '列', type: 'column', required: true, default: 'A' },
    ],
  },

  // ------------------------------------------------------------------
  // 8. 单元格操作
  // ------------------------------------------------------------------

  merge_cells: {
    label: '合并单元格',
    description: '合并指定区域的单元格',
    params: [
      { key: 'range', label: '合并范围', type: 'range', required: true, default: 'A1:C1' },
    ],
  },

  unmerge_cells: {
    label: '取消合并',
    description: '取消合并指定区域的单元格',
    params: [
      { key: 'range', label: '取消合并范围', type: 'range', required: true, default: 'A1:C1' },
    ],
  },

  freeze_panes: {
    label: '冻结窗格',
    description: '冻结指定单元格上方和左侧的行列',
    params: [
      { key: 'cell', label: '冻结位置', type: 'cell', required: true, default: 'B2',
        placeholder: '如 B2 表示冻结第 1 行和 A 列' },
    ],
  },

  unfreeze_panes: {
    label: '取消冻结',
    description: '取消所有冻结窗格',
    params: [],
  },

  fill_series: {
    label: '填充序列',
    description: '在区域内填充等差序列或日期序列',
    params: [
      { key: 'range', label: '填充范围', type: 'range', required: true, default: 'A1:A10' },
      { key: 'seriesType', label: '序列类型', type: 'select', default: 'linear', options: [
        { value: 'linear', label: '等差数列' },
        { value: 'date', label: '日期序列' },
      ]},
      { key: 'step', label: '步长', type: 'number', min: -1000, max: 1000, step: 1, default: 1 },
      { key: 'direction', label: '填充方向', type: 'select', default: 'down', options: [
        { value: 'down', label: '向下' },
        { value: 'right', label: '向右' },
        { value: 'up', label: '向上' },
        { value: 'left', label: '向左' },
      ]},
    ],
  },

  // ------------------------------------------------------------------
  // 9. 批注与链接
  // ------------------------------------------------------------------

  add_comment: {
    label: '添加批注',
    description: '为单元格添加批注',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'text', label: '批注内容', type: 'text', required: true, default: '' },
    ],
  },

  update_comment: {
    label: '修改批注',
    description: '修改单元格的批注内容',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'text', label: '新批注内容', type: 'text', required: true, default: '' },
    ],
  },

  delete_comment: {
    label: '删除批注',
    description: '删除单元格的批注',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
    ],
  },

  set_hyperlink: {
    label: '设置超链接',
    description: '为单元格添加超链接',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
      { key: 'url', label: '链接地址', type: 'text', required: true, default: 'https://', placeholder: 'https://...' },
      { key: 'displayText', label: '显示文本', type: 'text', default: '', placeholder: '可选，默认显示链接' },
    ],
  },

  remove_hyperlink: {
    label: '删除超链接',
    description: '删除单元格的超链接',
    params: [
      { key: 'cell', label: '目标单元格', type: 'cell', required: true, default: 'A1' },
    ],
  },

  // ------------------------------------------------------------------
  // 10. 数据验证
  // ------------------------------------------------------------------

  validate_list: {
    label: '下拉列表',
    description: '为区域添加下拉选择验证',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: 'A1:A10' },
      { key: 'items', label: '选项列表', type: 'items', required: true, default: '选项1,选项2,选项3',
        placeholder: '用逗号分隔，如：是,否' },
    ],
  },

  validate_number: {
    label: '数值范围',
    description: '限制区域只能输入指定范围的数字',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: 'A1:A10' },
      { key: 'min', label: '最小值', type: 'number', min: -999999, max: 999999, default: 0 },
      { key: 'max', label: '最大值', type: 'number', min: -999999, max: 999999, default: 100 },
    ],
  },

  clear_validation: {
    label: '清除验证',
    description: '清除区域的数据验证规则',
    params: [
      { key: 'range', label: '目标范围', type: 'range', required: true, default: '{{sheet.range}}' },
    ],
  },

  // ------------------------------------------------------------------
  // 11. 数据处理
  // ------------------------------------------------------------------

  sort_range: {
    label: '排序',
    description: '按指定列排序数据',
    params: [
      { key: 'range', label: '排序范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'sortByColumn', label: '排序列', type: 'column', required: true, default: 'A' },
      { key: 'order', label: '排序方式', type: 'select', default: 'asc', options: [
        { value: 'asc', label: '升序 A-Z' },
        { value: 'desc', label: '降序 Z-A' },
      ]},
      { key: 'hasHeader', label: '首行为表头', type: 'boolean', default: true },
    ],
  },

  multi_sort: {
    label: '多列排序',
    description: '按多列排序（先按第一列，再按第二列...）',
    params: [
      { key: 'range', label: '排序范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'sortRules', label: '排序规则', type: 'text', required: true,
        default: '[{"column":"A","order":"asc"},{"column":"B","order":"desc"}]',
        placeholder: '[{"column":"A","order":"asc"}]' },
      { key: 'hasHeader', label: '首行为表头', type: 'boolean', default: true },
    ],
  },

  remove_duplicates: {
    label: '去重',
    description: '删除区域中的重复行',
    params: [
      { key: 'range', label: '数据范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'byColumns', label: '去重依据列', type: 'columns', required: true, default: 'A',
        placeholder: '如 A,B 表示按 A+B 列联合去重' },
      { key: 'hasHeader', label: '首行为表头', type: 'boolean', default: true },
    ],
  },

  filter_data: {
    label: '筛选',
    description: '按条件筛选数据',
    params: [
      { key: 'range', label: '数据范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'column', label: '筛选列', type: 'column', required: true, default: 'A' },
      { key: 'operator', label: '条件', type: 'select', required: true, default: 'contains', options: [
        { value: 'contains', label: '包含' },
        { value: 'equals', label: '等于' },
        { value: 'greaterThan', label: '大于' },
        { value: 'lessThan', label: '小于' },
        { value: 'notContains', label: '不包含' },
      ]},
      { key: 'value', label: '筛选值', type: 'text', required: true, default: '' },
    ],
  },

  clear_filter: {
    label: '清除筛选',
    description: '清除工作表上的所有筛选',
    params: [],
  },

  query_unique: {
    label: '统计值次数',
    description: '查询指定列中重复出现的次数，并输出到目标位置',
    params: [
      { key: 'column', label: '目标列', type: 'column', required: true, default: 'A' },
      { key: 'startRow', label: '起始行', type: 'row', default: 1 },
      { key: 'endRow', label: '结束行', type: 'row', default: 100 },
      { key: 'outputCell', label: '输出位置', type: 'cell', default: '' },
    ],
  },

  // ------------------------------------------------------------------
  // 12. 数据分析
  // ------------------------------------------------------------------

  pivot_table: {
    label: '创建透视表',
    description: '从源数据创建透视表到新位置',
    params: [
      { key: 'sourceRange', label: '数据源范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'rowFields', label: '行字段（表头名）', type: 'items', required: true, default: '分类',
        placeholder: '如：分类,区域' },
      { key: 'valueFields', label: '值字段', type: 'text', required: true,
        default: '[{"name":"金额","agg":"sum"}]',
        placeholder: '[{"name":"金额","agg":"sum"}]' },
      { key: 'targetSheet', label: '输出工作表', type: 'text', default: '' },
      { key: 'targetCell', label: '输出位置', type: 'cell', default: 'A1' },
    ],
  },

  pivot_data: {
    label: '生成透视数据',
    description: '按行列分组生成交叉统计数据',
    params: [
      { key: 'sourceRange', label: '数据源范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'rowFields', label: '行分组字段', type: 'items', required: true, default: '分类' },
      { key: 'colFields', label: '列分组字段', type: 'items', default: '' },
      { key: 'valueField', label: '值字段', type: 'text', required: true, default: '金额' },
      { key: 'aggregateFunc', label: '聚合方式', type: 'select', default: 'sum', options: [
        { value: 'sum', label: '求和' },
        { value: 'avg', label: '平均值' },
        { value: 'count', label: '计数' },
        { value: 'min', label: '最小值' },
        { value: 'max', label: '最大值' },
      ]},
      { key: 'targetSheet', label: '输出工作表', type: 'text', default: '' },
      { key: 'targetCell', label: '输出位置', type: 'cell', default: 'A1' },
    ],
  },

  calc_statistics: {
    label: '统计计算',
    description: '对区域进行基本统计（求和/平均/计数等）',
    params: [
      { key: 'range', label: '统计范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'outputCell', label: '输出位置', type: 'cell', required: true, default: 'A1' },
    ],
  },

  summarize_column: {
    label: '按列汇总',
    description: '按分组列对数值列求和汇总',
    params: [
      { key: 'range', label: '数据范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'groupByColumn', label: '分组列', type: 'column', required: true, default: 'A' },
      { key: 'sumColumn', label: '汇总列', type: 'column', required: true, default: 'B' },
      { key: 'outputCell', label: '输出位置', type: 'cell', default: 'A1' },
      { key: 'includeTotal', label: '输出总计行', type: 'boolean', default: true },
    ],
  },

  summarize_metrics: {
    label: '多指标汇总',
    description: '按分组列对数值列汇总并输出到新工作表',
    params: [
      { key: 'range', label: '数据范围', type: 'range', required: true, default: '{{sheet.range}}' },
      { key: 'groupByColumn', label: '分组列', type: 'column', required: true, default: 'A' },
      { key: 'sumColumn', label: '汇总列', type: 'column', required: true, default: 'B' },
      { key: 'targetSheet', label: '输出工作表', type: 'text', default: '' },
      { key: 'targetCell', label: '输出位置', type: 'cell', default: 'A1' },
      { key: 'includeTotal', label: '输出总计行', type: 'boolean', default: true },
    ],
  },
}

// ============================================================================
// 工具函数：判断是否为新版技能类型
// ============================================================================

const NEW_SKILL_TYPES = new Set(Object.keys(SKILL_CONFIGS))

export function isNewSkillType(type) {
  return NEW_SKILL_TYPES.has(type)
}

// ============================================================================
// 向后兼容：旧版操作类型集合（用于 isLegacyOp 判断）
// ============================================================================

const LEGACY_OP_TYPES = new Set([
  'set_cell_style', 'set_range_style', 'clear_formatting', 'auto_fit_column',
  'auto_fit_row', 'conditional_format', 'set_cell_value', 'set_range_values',
  'set_cell_formula', 'find_replace', 'remove_duplicates', 'sort_range',
  'filter_data', 'remove_filter', 'fill_series', 'insert_row', 'delete_row',
  'insert_column', 'delete_column', 'set_row_height', 'set_column_width',
  'hide_row', 'hide_column', 'freeze_panes', 'add_sheet', 'rename_sheet',
  'copy_sheet', 'clear_range', 'merge_cells', 'unmerge_cells',
  'create_pivot_table', 'create_pivot_data', 'calculate_statistics',
  'summarize_by_column', 'set_active_sheet', 'copy_paste', 'clear_cell',
  'show_row', 'show_column', 'summarize_metrics_by_column',
  'set_data_validation', 'remove_data_validation', 'add_comment',
  'delete_comment', 'update_comment', 'set_hyperlink', 'remove_hyperlink',
  'query_unique_values', 'apply_custom_formula',
])

export function isLegacyOp(type) {
  return LEGACY_OP_TYPES.has(type)
}
