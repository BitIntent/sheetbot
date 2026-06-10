#!/bin/bash
# ============================================================================
# 手动下载字体文件脚本
# 如果 prepare_local_resources.js 下载失败，可以使用此脚本
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FONTS_DIR="$PROJECT_ROOT/frontend/public/fonts"

# 创建字体目录
mkdir -p "$FONTS_DIR"

echo "=========================================="
echo "手动下载 Noto Sans SC 字体"
echo "=========================================="
echo "字体目录: $FONTS_DIR"
echo ""

# 下载 Regular 字体（使用 fontsource CDN）
echo "下载 NotoSansSC-Regular.woff2..."
curl -L -o "$FONTS_DIR/NotoSansSC-Regular.woff2" \
    "https://unpkg.com/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2" \
    --connect-timeout 30 --max-time 120 --fail --silent --show-error

if [ $? -eq 0 ] && [ -f "$FONTS_DIR/NotoSansSC-Regular.woff2" ]; then
    SIZE=$(stat -c%s "$FONTS_DIR/NotoSansSC-Regular.woff2" 2>/dev/null || stat -f%z "$FONTS_DIR/NotoSansSC-Regular.woff2" 2>/dev/null)
    if [ "$SIZE" -gt 50000 ]; then
        echo "✅ Regular 字体下载成功 ($(($SIZE / 1024)) KB)"
    else
        echo "❌ Regular 字体文件大小异常 ($(($SIZE / 1024)) KB，期望 > 50KB)，删除..."
        rm -f "$FONTS_DIR/NotoSansSC-Regular.woff2"
        echo "   尝试备用源..."
        curl -L -o "$FONTS_DIR/NotoSansSC-Regular.woff2" \
            "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2" \
            --connect-timeout 30 --max-time 120 --fail --silent --show-error
        if [ $? -eq 0 ]; then
            SIZE=$(stat -c%s "$FONTS_DIR/NotoSansSC-Regular.woff2" 2>/dev/null || stat -f%z "$FONTS_DIR/NotoSansSC-Regular.woff2" 2>/dev/null)
            if [ "$SIZE" -gt 50000 ]; then
                echo "✅ Regular 字体下载成功（备用源） ($(($SIZE / 1024)) KB)"
            else
                echo "❌ 备用源也失败"
            fi
        fi
    fi
else
    echo "❌ Regular 字体下载失败"
fi

echo ""

# 下载 Bold 字体（使用 fontsource CDN）
echo "下载 NotoSansSC-Bold.woff2..."
curl -L -o "$FONTS_DIR/NotoSansSC-Bold.woff2" \
    "https://unpkg.com/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-700-normal.woff2" \
    --connect-timeout 30 --max-time 120 --fail --silent --show-error

if [ $? -eq 0 ] && [ -f "$FONTS_DIR/NotoSansSC-Bold.woff2" ]; then
    SIZE=$(stat -c%s "$FONTS_DIR/NotoSansSC-Bold.woff2" 2>/dev/null || stat -f%z "$FONTS_DIR/NotoSansSC-Bold.woff2" 2>/dev/null)
    if [ "$SIZE" -gt 50000 ]; then
        echo "✅ Bold 字体下载成功 ($(($SIZE / 1024)) KB)"
    else
        echo "❌ Bold 字体文件大小异常 ($(($SIZE / 1024)) KB，期望 > 50KB)，删除..."
        rm -f "$FONTS_DIR/NotoSansSC-Bold.woff2"
        echo "   尝试备用源..."
        curl -L -o "$FONTS_DIR/NotoSansSC-Bold.woff2" \
            "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-700-normal.woff2" \
            --connect-timeout 30 --max-time 120 --fail --silent --show-error
        if [ $? -eq 0 ]; then
            SIZE=$(stat -c%s "$FONTS_DIR/NotoSansSC-Bold.woff2" 2>/dev/null || stat -f%z "$FONTS_DIR/NotoSansSC-Bold.woff2" 2>/dev/null)
            if [ "$SIZE" -gt 50000 ]; then
                echo "✅ Bold 字体下载成功（备用源） ($(($SIZE / 1024)) KB)"
            else
                echo "❌ 备用源也失败"
            fi
        fi
    fi
else
    echo "❌ Bold 字体下载失败"
fi

echo ""
echo "=========================================="
echo "下载完成"
echo "=========================================="
echo "检查字体文件:"
ls -lh "$FONTS_DIR"/*.woff2 2>/dev/null || echo "未找到字体文件"
