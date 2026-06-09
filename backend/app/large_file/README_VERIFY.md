# 服务器端验证步骤

## 快速验证

在服务器上运行以下命令：

```bash
cd /usr1/python/excel-ai/backend/app/large_file
chmod +x verify_modules.sh
./verify_modules.sh
```

## 手动验证步骤

### 1. 检查 node_modules 目录

```bash
# 检查 node_modules 是否存在
ls -la /usr1/python/excel-ai/frontend/node_modules | head -20

# 检查三个关键模块
ls -d /usr1/python/excel-ai/frontend/node_modules/{puppeteer,docx,sharp}
```

### 2. 检查 puppeteer

```bash
cd /usr1/python/excel-ai/frontend

# 查看 package.json 中的入口文件
cat node_modules/puppeteer/package.json | grep -E '"main"|"exports"'

# 检查可能的入口文件
ls -la node_modules/puppeteer/lib/cjs/puppeteer/puppeteer.js
ls -la node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js
ls -la node_modules/puppeteer/index.js
```

### 3. 检查 docx

```bash
cd /usr1/python/excel-ai/frontend

# 查看 package.json 中的入口文件
cat node_modules/docx/package.json | grep -E '"main"|"exports"'

# 检查可能的入口文件
ls -la node_modules/docx/build/index.js
ls -la node_modules/docx/lib/index.js
ls -la node_modules/docx/index.js
```

### 4. 检查 sharp

```bash
cd /usr1/python/excel-ai/frontend

# 查看 package.json 中的入口文件
cat node_modules/sharp/package.json | grep -E '"main"|"exports"'

# 检查可能的入口文件
ls -la node_modules/sharp/lib/index.js
ls -la node_modules/sharp/index.js
```

### 5. 测试 Node.js 导入（从 frontend 目录）

```bash
cd /usr1/python/excel-ai/frontend

# 测试 puppeteer
node -e "import('puppeteer').then(p => console.log('✅ puppeteer:', typeof p.default)).catch(e => console.log('❌', e.message))"

# 测试 docx
node -e "import('docx').then(d => console.log('✅ docx:', Object.keys(d).slice(0, 3).join(', '))).catch(e => console.log('❌', e.message))"

# 测试 sharp
node -e "import('sharp').then(s => console.log('✅ sharp:', typeof s.default)).catch(e => console.log('❌', e.message))"
```

### 6. 测试脚本路径解析

```bash
cd /usr1/python/excel-ai/backend/app/large_file

# 测试脚本能否找到 frontend/node_modules
node -e "
import { dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
console.log('脚本目录:', __dirname);

// 模拟查找逻辑
let currentDir = __dirname;
for (let i = 0; i < 5; i++) {
    const testPath = currentDir + '/../frontend/node_modules';
    const fs = await import('fs');
    if (fs.existsSync(testPath)) {
        console.log('✅ 找到 node_modules:', testPath);
        break;
    }
    currentDir = currentDir + '/..';
}
"
```

## 预期结果

如果一切正常，应该看到：

1. ✅ 所有三个模块目录都存在
2. ✅ 每个模块的 package.json 都存在
3. ✅ 至少一个入口文件存在
4. ✅ 从 frontend 目录可以成功导入所有模块
5. ✅ 脚本可以找到 frontend/node_modules 路径

## 如果验证失败

### puppeteer 导入失败
- 检查是否安装了 puppeteer: `npm list puppeteer`（在 frontend 目录）
- 如果未安装，运行: `cd /usr1/python/excel-ai/frontend && npm install`

### docx 导入失败
- 检查是否安装了 docx: `npm list docx`（在 frontend 目录）
- 如果未安装，运行: `cd /usr1/python/excel-ai/frontend && npm install`

### sharp 导入失败
- 检查是否安装了 sharp: `npm list sharp`（在 frontend 目录）
- 如果未安装，运行: `cd /usr1/python/excel-ai/frontend && npm install`

### 路径找不到
- 确认 frontend 目录结构正确
- 确认 node_modules 在 frontend 目录下
