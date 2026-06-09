import fs from 'fs';
const content = fs.readFileSync('src/utils/excelOperations.js', 'utf8');
const lines = content.split('\n');

let depth = 0;
let prevDepth = 0;

// 找出深度变化大于正常值的行
for (let i = 0; i < 800; i++) {
  prevDepth = depth;
  const line = lines[i];
  
  for (const char of line) {
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  
  // 显示每行的深度（只显示前800行）
  if (depth !== prevDepth) {
    console.log(`Line ${i+1}: depth ${prevDepth} -> ${depth}: ${line.slice(0, 80)}`);
  }
}

console.log(`\nDepth at line 800: ${depth}`);
