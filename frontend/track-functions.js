import fs from 'fs';
const content = fs.readFileSync('src/utils/excelOperations.js', 'utf8');
const lines = content.split('\n');

// 跟踪函数
const functionStack = [];
let braceBalance = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNum = i + 1;
  
  // 检测函数定义
  const funcMatch = line.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
  if (funcMatch) {
    const funcName = funcMatch[3];
    functionStack.push({ name: funcName, startLine: lineNum, startBrace: braceBalance });
    console.log(`Line ${lineNum}: START function ${funcName} (brace balance: ${braceBalance})`);
  }
  
  // 计算大括号变化
  let openBraces = 0;
  let closeBraces = 0;
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
      if (char === '{') openBraces++;
      if (char === '}') closeBraces++;
    }
  }
  
  braceBalance += openBraces - closeBraces;
  
  // 检查是否有函数结束（大括号平衡回到函数开始时的水平）
  if (functionStack.length > 0 && braceBalance === functionStack[functionStack.length - 1].startBrace) {
    const func = functionStack.pop();
    console.log(`Line ${lineNum}: END function ${func.name} (started at line ${func.startLine})`);
  }
  
  // 检测异常
  if (braceBalance < 0) {
    console.log(`Line ${lineNum}: ERROR - brace balance went negative (${braceBalance})`);
    braceBalance = 0;
  }
}

console.log(`\nFinal brace balance: ${braceBalance}`);
console.log(`Unclosed functions: ${functionStack.map(f => f.name).join(', ') || 'none'}`);
