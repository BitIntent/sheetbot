#!/bin/bash
# ============================================================================
# 清理未使用的字体文件脚本
# 只保留实际使用的字体：NotoSansSC-Regular.woff2, NotoSansSC-Bold.woff2,
# NotoSansSC-Regular.ttf, NotoSansSC-Bold.ttf
# ============================================================================

FONTS_DIR="/usr1/python/excel-ai/frontend/public/fonts"

# 需要保留的字体文件（实际使用的）
KEEP_FONTS=(
    "NotoSansSC-Regular.woff2"
    "NotoSansSC-Bold.woff2"
    "NotoSansSC-Regular.ttf"
    "NotoSansSC-Bold.ttf"
)

echo "=========================================="
echo "清理未使用的字体文件"
echo "=========================================="
echo "字体目录: $FONTS_DIR"
echo ""

# 检查目录是否存在
if [ ! -d "$FONTS_DIR" ]; then
    echo "❌ 字体目录不存在: $FONTS_DIR"
    exit 1
fi

# 统计信息
TOTAL_SIZE=0
DELETED_COUNT=0
KEPT_COUNT=0

echo "保留的字体文件："
for font in "${KEEP_FONTS[@]}"; do
    font_path="$FONTS_DIR/$font"
    if [ -f "$font_path" ]; then
        size=$(stat -c%s "$font_path" 2>/dev/null || stat -f%z "$font_path" 2>/dev/null)
        size_mb=$(echo "scale=2; $size / 1024 / 1024" | bc)
        echo "  ✅ $font (${size_mb} MB)"
        ((KEPT_COUNT++))
    else
        echo "  ⚠️  $font (不存在)"
    fi
done

echo ""
echo "删除的字体文件："

# 遍历字体目录中的所有文件
for font_file in "$FONTS_DIR"/*; do
    if [ -f "$font_file" ]; then
        filename=$(basename "$font_file")
        should_keep=false
        
        # 检查是否在保留列表中
        for keep_font in "${KEEP_FONTS[@]}"; do
            if [ "$filename" == "$keep_font" ]; then
                should_keep=true
                break
            fi
        done
        
        # 如果不在保留列表中，删除
        if [ "$should_keep" == false ]; then
            size=$(stat -c%s "$font_file" 2>/dev/null || stat -f%z "$font_file" 2>/dev/null)
            size_mb=$(echo "scale=2; $size / 1024 / 1024" | bc)
            TOTAL_SIZE=$(echo "$TOTAL_SIZE + $size" | bc)
            echo "  🗑️  $filename (${size_mb} MB)"
            rm -f "$font_file"
            ((DELETED_COUNT++))
        fi
    fi
done

echo ""
echo "=========================================="
echo "清理完成"
echo "=========================================="
echo "保留文件数: $KEPT_COUNT"
echo "删除文件数: $DELETED_COUNT"
if [ "$DELETED_COUNT" -gt 0 ]; then
    total_size_mb=$(echo "scale=2; $TOTAL_SIZE / 1024 / 1024" | bc)
    echo "释放空间: ${total_size_mb} MB"
fi
echo ""

# 显示清理后的文件列表
echo "清理后的字体文件列表："
ls -lh "$FONTS_DIR" 2>/dev/null || echo "目录为空或不存在"
