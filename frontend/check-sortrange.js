import fs from 'fs';
const content = fs.readFileSync('src/utils/excelOperations.js', 'utf8');
const lines = content.split('\n');

// 只检查 sortRange 函数（第1450-2025行）
let depth = 0;

for (let i = 1449; i <= 2030; i++) {
  const line = lines[i];
  let openCount = 0;
  let closeCount = 0;
  let inString = false;
  let stringChar = '';
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const prevChar = j > 0 ? line[j-1] : '';
    
    // 简单字符串检测
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      inString = true;
      stringChar = char;
    } else if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
    }
    
    if (!inString) {
      if (char === '{') openCount++;
      if (char === '}') closeCount++;
    }
  }
  
  const prevDepth = depth;
  depth += openCount - closeCount;
  
  // 显示深度变化
  if (openCount > 0 || closeCount > 0) {
    console.log(`Line ${i+1}: { = ${openCount}, } = ${closeCount}, depth: ${prevDepth} -> ${depth}`);
  }
  
  // 如果深度为 0，函数结束
  if (depth === 0 && prevDepth > 0) {
    console.log(`  ^^^ Function likely ends here`);
  }
}

console.log(`\nFinal depth: ${depth} (should be 0 if sortRange closed properly)`);
