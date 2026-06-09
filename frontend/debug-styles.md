# 样式调试命令

请在浏览器控制台（F12）中依次执行以下命令来诊断背景色和文字颜色问题：

## 1. 检查 workbook 中样式是否正确保存

```javascript
// 使用暴露的调试 API 检查第一行样式
// 执行以下命令：

// 快速检查第一行所有列的样式
window.__EXCEL_DEBUG__.checkFirstRow()

// 或者手动检查特定单元格
const sheet = window.__EXCEL_WORKBOOK__.sheets.find(s => s.name === '销售数据' || s.name === 'Sheet1')
console.log('第一行样式:', {
  A1: sheet?.data?.[1]?.[1]?.style,
  B1: sheet?.data?.[1]?.[2]?.style,
  C1: sheet?.data?.[1]?.[3]?.style,
  D1: sheet?.data?.[1]?.[4]?.style,
  E1: sheet?.data?.[1]?.[5]?.style,
  F1: sheet?.data?.[1]?.[6]?.style
})
```

## 2. 检查 DOM 元素的实际样式

```javascript
// 检查第一行第一个单元格的 DOM 元素
const checkDOMStyle = () => {
  // 查找第一行的单元格（可能需要根据实际 DOM 结构调整）
  const cells = document.querySelectorAll('.excel-cell')
  const firstRowCells = Array.from(cells).filter((cell, index) => {
    // 第一行通常是第 7 个元素开始（1个corner + 6个header + 1个row-header + 6个cells）
    // 或者通过检查单元格内容
    return cell.textContent && ['日期', '销售员', '产品'].includes(cell.textContent.trim())
  })
  
  firstRowCells.forEach((cell, index) => {
    const computedStyle = window.getComputedStyle(cell)
    console.log(`单元格 ${index + 1} (${cell.textContent}):`, {
      element: cell,
      inlineStyle: cell.style.cssText,
      computedBackgroundColor: computedStyle.backgroundColor,
      computedColor: computedStyle.color,
      fontWeight: computedStyle.fontWeight,
      className: cell.className,
      hasCustomBg: cell.classList.contains('has-custom-bg'),
      cssVariables: {
        '--cell-bg-color': computedStyle.getPropertyValue('--cell-bg-color')
      }
    })
  })
}
checkDOMStyle()
```

## 3. 检查 CSS 规则优先级

```javascript
// 检查 CSS 规则
const checkCSSRules = () => {
  const stylesheets = Array.from(document.styleSheets)
  stylesheets.forEach(sheet => {
    try {
      const rules = Array.from(sheet.cssRules || [])
      rules.forEach(rule => {
        if (rule.selectorText && rule.selectorText.includes('excel-cell')) {
          console.log('CSS 规则:', {
            selector: rule.selectorText,
            style: rule.style.cssText,
            specificity: rule.selectorText.split('.').length
          })
        }
      })
    } catch (e) {
      // 跨域样式表可能无法访问
    }
  })
}
checkCSSRules()
```

## 4. 手动测试样式应用

```javascript
// 手动设置样式测试
const testManualStyle = () => {
  const cells = document.querySelectorAll('.excel-cell')
  const firstRowCells = Array.from(cells).filter(cell => 
    ['日期', '销售员', '产品'].includes(cell.textContent.trim())
  )
  
  firstRowCells.forEach(cell => {
    // 使用 setProperty 强制设置样式
    cell.style.setProperty('background-color', '#00008B', 'important')
    cell.style.setProperty('color', '#FFFFFF', 'important')
    console.log('手动设置样式:', cell.textContent, {
      backgroundColor: cell.style.backgroundColor,
      color: cell.style.color
    })
  })
}
testManualStyle()
```

## 5. 检查 React 组件状态

```javascript
// 如果可以通过 React DevTools 访问组件
// 在 React DevTools 中选择 ExcelEditor 组件，然后在控制台执行：

// 检查 sheet prop
$r.props.sheet?.data[1]?.[1]?.style

// 检查所有第一行单元格
for (let col = 1; col <= 6; col++) {
  console.log(`列 ${col}:`, $r.props.sheet?.data[1]?.[col]?.style)
}
```

## 6. 完整的诊断脚本

```javascript
// 一键诊断脚本
const diagnoseStyleIssue = () => {
  console.log('=== 开始诊断样式问题 ===\n')
  
  // 1. 检查 DOM
  console.log('1. 检查 DOM 元素样式:')
  const headerCells = Array.from(document.querySelectorAll('.excel-cell'))
    .filter(cell => ['日期', '销售员', '产品', '数量', '单价', '总金额'].includes(cell.textContent.trim()))
  
  headerCells.forEach((cell, i) => {
    const computed = window.getComputedStyle(cell)
    console.log(`  单元格 ${i+1} (${cell.textContent.trim()}):`, {
      inlineStyle: cell.style.cssText,
      computedBg: computed.backgroundColor,
      computedColor: computed.color,
      fontWeight: computed.fontWeight,
      className: cell.className
    })
  })
  
  // 2. 检查 CSS 变量
  console.log('\n2. 检查 CSS 变量:')
  headerCells.forEach(cell => {
    const bgVar = window.getComputedStyle(cell).getPropertyValue('--cell-bg-color')
    console.log(`  ${cell.textContent.trim()}: --cell-bg-color = ${bgVar || '(未设置)'}`)
  })
  
  // 3. 检查是否有 has-custom-bg 类
  console.log('\n3. 检查 has-custom-bg 类:')
  headerCells.forEach(cell => {
    console.log(`  ${cell.textContent.trim()}: has-custom-bg = ${cell.classList.contains('has-custom-bg')}`)
  })
  
  console.log('\n=== 诊断完成 ===')
}

diagnoseStyleIssue()
```

## 使用说明

1. 打开浏览器开发者工具（F12）
2. 切换到 Console 标签
3. 复制上面的命令并执行
4. 将输出结果发给我，我会根据结果进一步分析问题

## 快速测试

如果上面的诊断显示样式没有正确应用，可以尝试手动修复：

```javascript
// 临时修复脚本（仅用于测试）
const tempFix = () => {
  const headerCells = Array.from(document.querySelectorAll('.excel-cell'))
    .filter(cell => ['日期', '销售员', '产品', '数量', '单价', '总金额'].includes(cell.textContent.trim()))
  
  headerCells.forEach(cell => {
    cell.style.setProperty('background-color', '#00008B', 'important')
    cell.style.setProperty('color', '#FFFFFF', 'important')
    cell.classList.add('has-custom-bg')
  })
  
  console.log('临时修复已应用，请检查效果')
}
tempFix()
```
