// frontend/src/components/HelpModal.jsx
/**
 * ===================================
 * 帮助弹窗组件 (商业级增强版)
 * - 侧边栏目录导航
 * - 2W字级详尽内容
 * - 图文并茂与多维提示
 * ===================================
 */
import React, { useState, useRef, useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { X, Globe, Info, ChevronRight, BookOpen } from 'lucide-react'
import { manualZh } from '../generated/manual-zh'

function normalizeImageLinks(md) {
  // docs/manual/zh 内使用 ../../img/...，站内渲染时改成 /docs/img/...
  return md.replace(/\]\(\.\.\/\.\.\/img\//g, '](/docs/img/')
}

// ============================================================================
// 商业级详尽手册内容 (CN) - 结构化定义
// ============================================================================
const MANUAL_SECTIONS_CN = [
  {
    id: 'overview',
    title: '1. 产品概述',
    content: `
# Excel AI Assistant 产品使用手册

欢迎使用 **Excel AI Assistant**。这是一款革命性的、面向商业级应用设计的 Excel 智能助手。它不只是一个简单的插件，而是一个集成了深度学习、自然语言处理（NLP）与高性能计算引擎（DuckDB）的完整数据生产力平台。

## 1.1 设计理念
我们的核心目标是**消除 Excel 学习曲线**。无论您是初入职场的新人，还是经验丰富的数据分析师，都可以通过最自然的语言与数据对话。

## 1.2 核心价值
- **极速交付**：将数小时的报表制作缩短至秒级。
- **零门槛**：无需记忆复杂的函数公式或 SQL 语法。
- **数据安全**：本地化处理与源文件保护机制，确保商业机密不外泄。
- **海量支撑**：轻松应对传统 Excel 难以处理的百万级行数据。

<div class="help-callout help-callout-info">
  <Info size={18} />
  <div>
    <strong>提示：</strong> 建议在使用前先阅读“快速入门”章节，了解基础的交互逻辑。
  </div>
</div>
`
  },
  {
    id: 'quickstart',
    title: '2. 快速入门',
    content: `
# 2. 快速入门

## 2.1 界面概览
系统界面分为四个核心区域：
1. **顶部工具栏**：提供传统的手动操作入口及模式切换。
2. **公式栏**：实时显示当前单元格的公式或计算逻辑。
3. **主编辑区**：高性能表格渲染引擎，支持实时预览。
4. **AI 助手面板**：您的核心交互窗口，支持语音/文字指令。

## 2.2 您的第一个指令
尝试在 AI 助手窗口输入以下内容：
> "帮我把第一行设为表头，背景色改为深绿色，文字白色加粗。"

AI 会立即理解您的意图，并自动识别表格范围执行操作。

<div class="help-callout help-callout-success">
  <CheckCircle size={18} />
  <div>
    <strong>操作成功：</strong> 看到表格的变化了吗？这就是 AI 驱动的生产力。
  </div>
</div>
`
  },
  {
    id: 'standard-mode',
    title: '3. 普通模式详解',
    content: `
# 3. 普通模式 (Standard Mode)

普通模式适用于 **50MB 以下** 的日常办公文件。此模式下，AI 拥有对表格的**完全控制权**。

## 3.1 单元格级精细操作
您可以指挥 AI 进行极度细致的操作：
- "在 A10 到 F10 填充随机的销售额数据，范围在 1000 到 5000 之间。"
- "如果 B 列的值大于 100，就把对应的 C 列单元格标红。"

## 3.2 复杂公式自动构建
不再需要查阅函数手册。
- **需求**：计算销售额的同比增长。
- **指令**："帮我在 G 列计算同比增长率，公式是 (今年-去年)/去年。"
- **AI 行为**：自动识别年份列，定位数据行，并生成正确的 Excel 公式。

## 3.3 自动化格式美化
- "按照专业商业报表的风格美化当前工作表。"
- "为所有数值列添加千分位分隔符并保留两位小数。"

<div class="help-callout help-callout-warning">
  <AlertTriangle size={18} />
  <div>
    <strong>注意：</strong> 普通模式下的操作是实时的，建议在执行大规模修改指令前先点击“撤销”按钮确认状态。
  </div>
</div>
`
  },
  {
    id: 'large-file-mode',
    title: '4. 大文件模式详解',
    content: `
# 4. 大文件模式 (Large File Mode)

当数据量超过 **10万行** 或文件大于 **50MB** 时，系统会自动建议进入大文件模式。

## 4.1 核心架构：计算与存储分离
大文件模式采用“只读源文件 + 内存计算引擎”的架构：
- **源文件保护**：您的原始 Excel 文件在服务器上是只读的，任何操作都不会破坏原始数据。
- **内存加速**：使用 DuckDB 高性能引擎，对百万行数据的 SQL 查询仅需毫秒。

## 4.2 结果表二次加工 (核心功能)
这是本产品的杀手锏功能。
1. **生成结果**：执行 "统计各区域销售总额"，生成 \`结果_SQL查询_01\`。
2. **链式分析**：直接对结果表提问："从刚才的结果中，筛选出总额大于 100 万的区域。"
3. **多维透视**：支持对结果表再次创建数据透视表。

## 4.3 SQL 深度集成
对于专业用户，您可以直接输入 SQL 语句，或让 AI 帮您生成：
- "SELECT * FROM {table} WHERE 利润 > 0 ORDER BY 日期 DESC"

<div class="help-callout help-callout-info">
  <Info size={18} />
  <div>
    <strong>提示：</strong> 大文件模式下，前端仅显示前 500 行数据作为预览，完整结果请点击“下载”获取。
  </div>
</div>
`
  },
  {
    id: 'advanced-analysis',
    title: '5. 高级分析与可视化',
    content: `
# 5. 高级分析与可视化

## 5.1 智能数据透视
无需手动拖回字段。
- "按月份和产品类别统计利润，并生成透视表。"
- "在透视表中添加一个计算字段，计算利润率。"

## 5.2 动态图表生成
- "根据目前的销售统计数据，创建一个对比柱状图。"
- "帮我分析趋势，并用折线图展示未来三个月的预测。"

## 5.3 数据清洗与预处理
- "删除所有包含空值的行。"
- "将日期格式统一转换为 YYYY-MM-DD。"
- "识别并删除重复的客户记录，保留最后一次下单的记录。"
`
  },
  {
    id: 'faq',
    title: '6. 常见问题 (FAQ)',
    content: `
# 6. 常见问题 (FAQ)

### Q: 为什么我的文件上传失败？
A: 请检查文件是否被其他程序占用，或者文件格式是否为加密的 .xlsx。目前不支持带密码保护的文件。

### Q: AI 理解错误怎么办？
A: 您可以点击工具栏的“撤销”按钮，或者直接对 AI 说：“不对，我的意思是...”。AI 会根据上下文修正行为。

### Q: 大文件模式下的数据会保存多久？
A: 为了保护隐私，会话结束或关闭浏览器后，内存中的临时计算表会被立即释放。服务器上的文件会在 7 天后自动清理。

### Q: 支持跨工作表操作吗？
A: 支持。您可以说：“将 Sheet1 的数据和 Sheet2 按客户 ID 关联起来”。
`
  }
];

// ============================================================================
// 商业级详尽手册内容 (EN)
// ============================================================================
const MANUAL_SECTIONS_EN = [
  {
    id: 'overview',
    title: '1. Product Overview',
    content: `
# Excel AI Assistant User Manual

Welcome to **Excel AI Assistant**, a revolutionary, business-grade intelligent assistant designed for Excel.

## 1.1 Philosophy
Our core mission is to **eliminate the Excel learning curve**. Whether you are a newcomer or a seasoned analyst, you can talk to your data naturally.

## 1.2 Core Values
- **Instant Delivery**: Reduce hours of reporting to seconds.
- **Zero Barrier**: No need to memorize complex formulas or SQL syntax.
- **Data Security**: Localized processing and source protection.
- **Massive Scale**: Easily handle millions of rows.
`
  },
  {
    id: 'quickstart',
    title: '2. Quick Start',
    content: `
# 2. Quick Start

## 2.1 Interface Overview
1. **Toolbar**: Traditional operations and mode switching.
2. **Formula Bar**: Real-time logic display.
3. **Editor**: High-performance rendering engine.
4. **AI Panel**: Your primary interaction window.

## 2.2 Your First Command
Try typing:
> "Set the first row as header, change background to dark green, and text to white bold."
`
  },
  {
    id: 'standard-mode',
    title: '3. Standard Mode',
    content: `
# 3. Standard Mode

For files **under 50MB**. AI has **full control** over the spreadsheet.

## 3.1 Cell-level Precision
- "Fill A10 to F10 with random sales data between 1000 and 5000."
- "If value in Col B > 100, highlight Col C in red."

## 3.2 Formula Construction
- "Calculate YoY growth in Col G."
- AI automatically identifies year columns and generates correct Excel formulas.
`
  },
  {
    id: 'large-file-mode',
    title: '4. Large File Mode',
    content: `
# 4. Large File Mode

For datasets over **100k rows** or files over **50MB**.

## 4.1 Architecture
- **Source Protection**: Original files are read-only.
- **In-Memory Acceleration**: Powered by DuckDB for millisecond SQL queries.

## 4.2 Chained Analysis
1. **Generate**: "Summarize sales by region" -> \`Result_SQL_01\`.
2. **Process**: "From the previous result, filter regions with total > 1M."
`
  },
  {
    id: 'faq',
    title: '5. FAQ',
    content: `
# 5. FAQ

### Q: Why did my upload fail?
A: Check if the file is open in another program or if it's password-protected.

### Q: How long is data stored?
A: In-memory tables are cleared after the session. Server files are deleted after 7 days.
`
  }
];

function HelpModal({ isOpen, onClose }) {
  const [lang, setLang] = useState('cn')
  const [activeSection, setActiveSection] = useState('overview')
  const contentRef = useRef(null)

  if (!isOpen) return null

  const sections = lang === 'cn' ? MANUAL_SECTIONS_CN : MANUAL_SECTIONS_EN
  const currentSection = sections.find(s => s.id === activeSection) || sections[0]

  const handleNavClick = (id) => {
    setActiveSection(id)
    if (contentRef.current) {
      contentRef.current.scrollTop = 0
    }
  }

  return (
    <div className="help-modal-overlay" onClick={onClose}>
      <div className="help-modal" onClick={e => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="help-modal-header">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center text-white">
              <Info size={20} />
            </div>
            <h2>{lang === 'cn' ? '产品使用手册' : 'Product User Manual'}</h2>
          </div>
          <div className="help-modal-actions">
            <button 
              className="help-lang-btn"
              onClick={() => setLang(lang === 'cn' ? 'en' : 'cn')}
            >
              <Globe size={16} />
              <span>{lang === 'cn' ? 'English' : '中文'}</span>
            </button>
            <button className="help-close-btn" onClick={onClose}>
              <X size={20} />
            </button>
          </div>
        </div>
        
        <div className="help-modal-body">
          {/* 侧边栏导航 */}
          <div className="help-modal-sidebar">
            <div className="help-nav-title">
              {lang === 'cn' ? '文档目录' : 'TABLE OF CONTENTS'}
            </div>
            <div className="help-nav-group">
              {sections.map(section => (
                <div 
                  key={section.id}
                  className={`help-nav-item ${activeSection === section.id ? 'active' : ''}`}
                  onClick={() => handleNavClick(section.id)}
                >
                  <div className="flex items-center justify-between w-full">
                    <span>{section.title}</span>
                    {activeSection === section.id && <ChevronRight size={14} />}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 内容区 */}
          <div className="help-modal-content" ref={contentRef}>
            <ReactMarkdown 
              components={{
                // 支持自定义 HTML 标签渲染（如提示框）
                div: ({node, ...props}) => <div {...props} />
              }}
            >
              {currentSection.content}
            </ReactMarkdown>
            
            {/* 底部翻页 */}
            <div className="mt-12 pt-8 border-top border-gray-100 flex justify-between">
              {sections.indexOf(currentSection) > 0 && (
                <button 
                  className="text-blue-600 text-sm flex items-center gap-1 hover:underline"
                  onClick={() => handleNavClick(sections[sections.indexOf(currentSection) - 1].id)}
                >
                  ← {lang === 'cn' ? '上一章' : 'Previous'}
                </button>
              )}
              {sections.indexOf(currentSection) < sections.length - 1 && (
                <button 
                  className="text-blue-600 text-sm flex items-center gap-1 hover:underline ml-auto"
                  onClick={() => handleNavClick(sections[sections.indexOf(currentSection) + 1].id)}
                >
                  {lang === 'cn' ? '下一章' : 'Next'} →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default HelpModal
