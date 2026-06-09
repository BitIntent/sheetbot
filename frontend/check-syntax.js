import fs from 'fs';
const content = fs.readFileSync('src/utils/excelOperations.js', 'utf8');
const lines = content.split('\n');

let depth = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  // 简单计算大括号（忽略字符串和注释的复杂情况）
  for (const char of line) {
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  
  // 检查函数定义位置的深度
  if (line.match(/^(export\s+)?function\s+\w+/) && depth !== 1) {
    console.log(`Line ${i+1}: Function at depth ${depth}: ${line.slice(0, 70)}`);
  }
  
  // 检查意外的深度变化
  if (depth < 0) {
    console.log(`Line ${i+1}: Unexpected }, depth = ${depth}`);
    depth = 0;
  }
}

console.log('Final depth:', depth);
if (depth !== 0) {
  console.log('ERROR: Unbalanced braces!');
}
