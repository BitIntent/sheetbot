#!/bin/bash
# 验证 Node.js 模块安装和路径

echo "=========================================="
echo "验证 Node.js 模块安装"
echo "=========================================="

NODE_MODULES_PATH="/usr1/python/excel-ai/frontend/node_modules"

if [ ! -d "$NODE_MODULES_PATH" ]; then
    echo "❌ node_modules 目录不存在: $NODE_MODULES_PATH"
    exit 1
fi

echo "✅ node_modules 目录存在: $NODE_MODULES_PATH"
echo ""

# 检查 puppeteer
echo "检查 puppeteer..."
PUPPETEER_PATH="$NODE_MODULES_PATH/puppeteer"
if [ -d "$PUPPETEER_PATH" ]; then
    echo "✅ puppeteer 目录存在"
    
    # 检查 package.json
    if [ -f "$PUPPETEER_PATH/package.json" ]; then
        echo "✅ puppeteer/package.json 存在"
        echo "   入口文件信息:"
        cat "$PUPPETEER_PATH/package.json" | grep -E '"main"|"exports"|"module"' | head -5
    fi
    
    # 检查可能的入口文件
    echo "   检查可能的入口文件:"
    for path in "lib/cjs/puppeteer/puppeteer.js" "lib/esm/puppeteer/puppeteer.js" "index.js"; do
        if [ -f "$PUPPETEER_PATH/$path" ]; then
            echo "   ✅ $path 存在"
        else
            echo "   ❌ $path 不存在"
        fi
    done
else
    echo "❌ puppeteer 目录不存在"
fi
echo ""

# 检查 docx
echo "检查 docx..."
DOCX_PATH="$NODE_MODULES_PATH/docx"
if [ -d "$DOCX_PATH" ]; then
    echo "✅ docx 目录存在"
    
    # 检查 package.json
    if [ -f "$DOCX_PATH/package.json" ]; then
        echo "✅ docx/package.json 存在"
        echo "   入口文件信息:"
        cat "$DOCX_PATH/package.json" | grep -E '"main"|"exports"|"module"' | head -5
    fi
    
    # 检查可能的入口文件
    echo "   检查可能的入口文件:"
    for path in "build/index.js" "lib/index.js" "index.js"; do
        if [ -f "$DOCX_PATH/$path" ]; then
            echo "   ✅ $path 存在"
        else
            echo "   ❌ $path 不存在"
        fi
    done
else
    echo "❌ docx 目录不存在"
fi
echo ""

# 检查 sharp
echo "检查 sharp..."
SHARP_PATH="$NODE_MODULES_PATH/sharp"
if [ -d "$SHARP_PATH" ]; then
    echo "✅ sharp 目录存在"
    
    # 检查 package.json
    if [ -f "$SHARP_PATH/package.json" ]; then
        echo "✅ sharp/package.json 存在"
        echo "   入口文件信息:"
        cat "$SHARP_PATH/package.json" | grep -E '"main"|"exports"|"module"' | head -5
    fi
    
    # 检查可能的入口文件
    echo "   检查可能的入口文件:"
    for path in "lib/index.js" "index.js"; do
        if [ -f "$SHARP_PATH/$path" ]; then
            echo "   ✅ $path 存在"
        else
            echo "   ❌ $path 不存在"
        fi
    done
else
    echo "❌ sharp 目录不存在"
fi
echo ""

# 测试 Node.js 导入
echo "=========================================="
echo "测试 Node.js 模块导入（从 frontend 目录）"
echo "=========================================="

cd /usr1/python/excel-ai/frontend

echo "测试 puppeteer 导入..."
node -e "
try {
    const p = await import('puppeteer');
    console.log('✅ puppeteer 导入成功');
    console.log('   类型:', typeof p.default !== 'undefined' ? '有 default' : '无 default');
} catch (e) {
    console.log('❌ puppeteer 导入失败:', e.message);
}
" 2>&1

echo ""
echo "测试 docx 导入..."
node -e "
try {
    const d = await import('docx');
    console.log('✅ docx 导入成功');
    console.log('   可用导出:', Object.keys(d).slice(0, 5).join(', '));
} catch (e) {
    console.log('❌ docx 导入失败:', e.message);
}
" 2>&1

echo ""
echo "测试 sharp 导入..."
node -e "
try {
    const s = await import('sharp');
    console.log('✅ sharp 导入成功');
    console.log('   类型:', typeof s.default !== 'undefined' ? '有 default' : '无 default');
} catch (e) {
    console.log('❌ sharp 导入失败:', e.message);
}
" 2>&1

echo ""
echo "=========================================="
echo "验证完成"
echo "=========================================="
