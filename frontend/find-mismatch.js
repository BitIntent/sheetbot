import fs from 'fs';
const content = fs.readFileSync('src/utils/excelOperations.js', 'utf8');
const lines = content.split('\n');

// 只检查 for 循环部分（第149-240行）
let depth = 1; // for 循环开始前的深度是 1（在 normalizeParams 函数内）

for (let i = 148; i <= 240; i++) {
  const line = lines[i];
  let openCount = 0;
  let closeCount = 0;
  
  for (const char of line) {
    if (char === '{') openCount++;
    if (char === '}') closeCount++;
  }
  
  const prevDepth = depth;
  depth += openCount - closeCount;
  
  if (openCount > 0 || closeCount > 0) {
    console.log(`Line ${i+1}: { = ${openCount}, } = ${closeCount}, depth: ${prevDepth} -> ${depth}`);
    console.log(`  ${line.slice(0, 100)}`);
  }
}

console.log(`\nFinal depth after line 240: ${depth} (should be 1)`);
