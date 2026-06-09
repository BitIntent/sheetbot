# PDF/Word/PNG 导出技术方案

## 目标
确保 PDF、Word、PNG 导出与页面显示效果完全一致，包括：
- 样式（颜色、字体、布局、间距）
- 内容（文本、表格、图表）
- 结构（标题、章节、分页）

## 当前问题分析

### 1. 样式不一致
- **表格样式**：前端使用深绿色渐变表头（`#217346` → `#1e5f3a`），导出使用蓝色
- **图表样式**：前端有容器背景、边框、圆角，导出缺少
- **文本样式**：前端有特定的字体大小、行高、颜色，导出使用默认样式

### 2. 内容不完整
- **图表缺失**：PDF/PNG 中图表未渲染
- **表格不一致**：Markdown 表格解析与前端不一致
- **动态图表缺失**：前端会为表格动态生成图表，导出中缺失

### 3. 结构不一致
- **表格+图表组合**：前端中表格上方有对应图表，导出中缺失
- **章节标题**：前端有特定的标题样式和分隔线，导出缺少

## 技术方案

### 方案 A：完全复制前端 HTML + CSS（推荐）

#### 核心思路
1. **复用前端渲染逻辑**：在 Node.js 中模拟前端渲染
2. **内联完整 CSS**：将前端 CSS 样式完全复制到导出 HTML
3. **动态图表生成**：在导出时也生成表格对应的图表

#### 实现步骤

**步骤 1：提取前端 CSS 样式**
- 从 `frontend/src/index.css` 提取所有报表相关样式
- 包括：`.report-content`, `.metrics-table`, `.markdown-table`, `.chart-container` 等
- 内联到导出的 HTML 中

**步骤 2：复制前端表格+图表生成逻辑**
- 将 `parseMarkdownTables` 函数移植到 Node.js
- 将 `generateChartFromTable` 函数移植到 Node.js
- 确保表格解析和图表生成逻辑完全一致

**步骤 3：统一 HTML 结构**
- 确保导出的 HTML 结构与前端 React 组件结构一致
- 包括：标题、核心指标表格、图表、文字解读
- 表格与图表的组合顺序和位置

**步骤 4：样式完全匹配**
- 表格表头：深绿色渐变 `linear-gradient(to bottom, #217346, #1e5f3a)`
- 表格边框：圆角、阴影、边框颜色
- 图表容器：背景色 `#f9fafb`、边框、圆角
- 文本样式：字体大小、行高、颜色完全匹配

#### 优点
- ✅ 完全一致：导出效果与页面显示完全一致
- ✅ 易于维护：样式和逻辑统一管理
- ✅ 功能完整：包含所有动态生成的内容

#### 缺点
- ⚠️ 实现复杂度：需要移植前端逻辑到 Node.js
- ⚠️ 文件大小：内联完整 CSS 会增加 HTML 大小

---

### 方案 B：使用 Puppeteer 直接截图（不推荐）

#### 核心思路
使用 Puppeteer 访问前端页面并截图/打印

#### 实现步骤
1. 启动前端开发服务器或构建后的静态页面
2. 使用 Puppeteer 访问报表页面
3. 等待所有内容加载完成
4. 截图或打印为 PDF

#### 优点
- ✅ 完全一致：直接使用前端渲染结果
- ✅ 实现简单：无需移植逻辑

#### 缺点
- ❌ 需要前端服务器运行
- ❌ 性能问题：每次导出都需要启动浏览器
- ❌ 依赖性强：依赖前端构建和部署
- ❌ 不适合生产环境

---

### 方案 C：混合方案（推荐用于快速实现）

#### 核心思路
1. **样式**：完全复制前端 CSS
2. **内容**：后端生成，但结构与前端一致
3. **图表**：使用 ECharts 在 Puppeteer 中渲染

#### 实现步骤

**步骤 1：样式复制**
```javascript
// 从 frontend/src/index.css 提取样式
const frontendStyles = `
  .metrics-table thead {
    background: linear-gradient(to bottom, #217346, #1e5f3a);
  }
  .metrics-table th {
    color: #ffffff;
    font-weight: 600;
    padding: 14px 18px;
  }
  .markdown-table thead {
    background: linear-gradient(to bottom, #217346, #1e5f3a);
  }
  .markdown-th {
    color: #ffffff;
    font-weight: 600;
    padding: 14px 18px;
  }
  .chart-container {
    padding: 24px;
    background: #f9fafb;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }
  // ... 更多样式
`;
```

**步骤 2：表格+图表组合**
- 解析 Markdown 表格
- 为每个表格生成对应的图表（使用与前端相同的逻辑）
- 在 HTML 中，图表放在表格上方

**步骤 3：内容结构**
```html
<!-- 标题 -->
<h1>报表标题</h1>

<!-- 核心指标表格 -->
<h2>核心指标概览</h2>
<table class="metrics-table">...</table>

<!-- 图表区域 -->
<div class="report-charts">
  <div class="chart-container">
    <h3>图表标题</h3>
    <div id="chart_0" class="chart-wrapper"></div>
  </div>
</div>

<!-- 文字解读（包含表格+图表组合） -->
<div class="report-insights">
  <h2>数据分析解读</h2>
  <!-- 表格+图表组合 -->
  <div class="table-with-chart-wrapper">
    <div class="table-chart-above">
      <h4>图表标题</h4>
      <div id="chart_table_0" class="chart-wrapper"></div>
    </div>
    <div class="markdown-table-wrapper">
      <table class="markdown-table">...</table>
    </div>
  </div>
</div>
```

#### 优点
- ✅ 样式一致：完全匹配前端样式
- ✅ 内容完整：包含所有图表和表格
- ✅ 实现相对简单：主要复制样式和结构

#### 缺点
- ⚠️ 需要移植表格解析和图表生成逻辑

---

## 推荐方案：方案 C（混合方案）

### 实施优先级

#### 阶段 1：样式匹配（立即实施）
1. 提取前端 CSS 样式
2. 内联到导出 HTML
3. 确保表格、图表、文本样式完全匹配

#### 阶段 2：内容完整性（立即实施）
1. 修复图表渲染问题（确保 ECharts 正确渲染）
2. 改进表格解析逻辑（与前端一致）
3. 确保所有内容都包含在导出中

#### 阶段 3：动态图表生成（后续优化）
1. 移植 `parseMarkdownTables` 到 Node.js
2. 移植 `generateChartFromTable` 到 Node.js
3. 为每个表格生成对应图表

### 关键技术点

#### 1. CSS 样式提取
```javascript
// 从 frontend/src/index.css 提取关键样式
const REPORT_STYLES = `
  /* 核心指标表格 */
  .metrics-table thead {
    background: linear-gradient(to bottom, #217346, #1e5f3a);
  }
  .metrics-table th {
    color: #ffffff;
    font-weight: 600;
    padding: 14px 18px;
  }
  
  /* Markdown 表格 */
  .markdown-table thead {
    background: linear-gradient(to bottom, #217346, #1e5f3a);
  }
  .markdown-th {
    color: #ffffff;
    font-weight: 600;
    padding: 14px 18px;
  }
  
  /* 图表容器 */
  .chart-container {
    padding: 24px;
    background: #f9fafb;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }
  
  /* 表格+图表组合 */
  .table-with-chart-wrapper {
    margin: 24px 0;
  }
  .table-chart-above {
    margin-bottom: 24px;
    padding: 20px;
    background: #f9fafb;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }
`;
```

#### 2. 表格+图表组合生成
```javascript
// 解析 Markdown 表格
const tables = parseMarkdownTables(insights);

// 为每个表格生成图表
tables.forEach(table => {
  const chart = generateChartFromTable(table);
  // 在 HTML 中，图表放在表格上方
  html += `
    <div class="table-with-chart-wrapper">
      ${chart ? `<div class="table-chart-above">
        <h4>${chart.title}</h4>
        <div id="chart_table_${table.index}"></div>
      </div>` : ''}
      <div class="markdown-table-wrapper">
        <table class="markdown-table">...</table>
      </div>
    </div>
  `;
});
```

#### 3. 图表渲染确保
```javascript
// 等待所有图表渲染完成（包括表格图表）
await page.evaluate(async () => {
  // 渲染主图表
  chartsData.forEach(chart => {
    const chartDom = document.getElementById(chart.id);
    if (chartDom) {
      const myChart = echarts.init(chartDom);
      myChart.setOption(chart.option);
    }
  });
  
  // 渲染表格图表
  tableChartsData.forEach(chart => {
    const chartDom = document.getElementById(`chart_table_${chart.tableIndex}`);
    if (chartDom) {
      const myChart = echarts.init(chartDom);
      myChart.setOption(chart.option);
    }
  });
});
```

## 实施计划

### 第一步：样式匹配（1-2小时）
1. 提取前端 CSS 样式
2. 更新 `generateHTML` 函数，内联样式
3. 测试样式是否匹配

### 第二步：内容完整性（2-3小时）
1. 修复图表渲染逻辑
2. 改进表格解析
3. 确保所有内容都包含

### 第三步：动态图表生成（3-4小时）
1. 移植表格解析逻辑
2. 移植图表生成逻辑
3. 集成到导出流程

## 预期效果

实施后，PDF/Word/PNG 导出将：
- ✅ 表格样式完全匹配（深绿色表头、白色文字）
- ✅ 图表完整显示（包括表格对应的图表）
- ✅ 布局一致（图表在表格上方）
- ✅ 文本样式一致（字体、大小、颜色）
- ✅ 内容完整（所有文本、表格、图表）

## 风险评估

- **低风险**：样式复制、内容完整性修复
- **中风险**：动态图表生成逻辑移植（需要确保与前端逻辑一致）
- **时间估算**：总计 6-9 小时
