#!/bin/bash
# 安装 Chromium/Puppeteer 所需的系统依赖库（CentOS/RHEL 版本）

echo "=========================================="
echo "安装 Chromium 系统依赖（CentOS/RHEL）"
echo "=========================================="

# 检测 Linux 发行版
if [ -f /etc/redhat-release ]; then
    # CentOS/RHEL/AlmaLinux
    DISTRO=$(cat /etc/redhat-release | awk '{print $1}')
    VERSION=$(cat /etc/redhat-release | grep -oE '[0-9]+' | head -1)
    echo "检测到 ${DISTRO} ${VERSION} 系统"
    
    echo ""
    echo "安装基础依赖包..."
    yum install -y \
        alsa-lib \
        atk \
        cups-libs \
        gtk3 \
        libXcomposite \
        libXcursor \
        libXdamage \
        libXext \
        libXi \
        libXrandr \
        libXScrnSaver \
        libXtst \
        pango \
        || echo "⚠️  某些包可能安装失败，请检查"
    
    echo ""
    echo "安装字体包..."
    yum install -y \
        dejavu-sans-fonts \
        dejavu-serif-fonts \
        liberation-fonts \
        || echo "⚠️  字体包安装失败（可选）"
    
    # CentOS 7/8 可能需要额外的包
    if [ "$VERSION" -lt "9" ]; then
        echo ""
        echo "安装 CentOS ${VERSION} 特定依赖..."
        yum install -y \
            xorg-x11-fonts-100dpi \
            xorg-x11-fonts-75dpi \
            xorg-x11-utils \
            xorg-x11-fonts-cyrillic \
            xorg-x11-fonts-Type1 \
            xorg-x11-fonts-misc \
            || echo "⚠️  某些字体包可能安装失败（可选）"
    fi
    
    echo ""
    echo "验证关键依赖..."
    for pkg in libatk-1.0.so.0 libXcomposite.so.1 libXdamage.so.1 libXext.so.6 libXi.so.6 libXrandr.so.2; do
        if ldconfig -p | grep -q "$pkg"; then
            echo "✅ $pkg 已安装"
        else
            echo "❌ $pkg 未找到"
        fi
    done
elif [ -f /etc/debian_version ]; then
    # Debian/Ubuntu
    echo "检测到 Debian 系列系统"
    echo "安装依赖包..."
    apt-get update
    apt-get install -y \
        ca-certificates \
        fonts-liberation \
        libappindicator3-1 \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libgcc1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libstdc++6 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxrandr2 \
        libxrender1 \
        libxss1 \
        libxtst6 \
        lsb-release \
        wget \
        xdg-utils \
        || echo "⚠️  某些包可能安装失败，请检查"
else
    echo "⚠️  无法识别 Linux 发行版，请手动安装依赖"
    echo ""
    echo "RedHat/CentOS 系列："
    echo "  yum install -y alsa-lib atk cups-libs gtk3 libXcomposite libXcursor libXdamage libXext libXi libXrandr libXScrnSaver libXtst pango"
    echo ""
    echo "Debian/Ubuntu 系列："
    echo "  apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2"
    exit 1
fi

echo ""
echo "=========================================="
echo "安装完成"
echo "=========================================="
echo ""
echo "如果仍有问题，可以尝试安装完整的 Chromium："
echo "  yum install -y chromium  # RedHat 系列"
echo "  apt-get install -y chromium-browser  # Debian 系列"
echo ""
echo "然后配置 puppeteer 使用系统 Chromium（需要修改代码）"
