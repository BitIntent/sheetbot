#!/bin/bash
# Puppeteer 安装脚本（使用淘宝镜像）

set -e

echo "=========================================="
echo "清理旧的 puppeteer 缓存..."
echo "=========================================="

# 清理 puppeteer 缓存目录
rm -rf ~/.cache/puppeteer
rm -rf ~/.cache/puppeteer-chromium

echo "=========================================="
echo "设置环境变量..."
echo "=========================================="

# 设置 puppeteer 下载镜像
export PUPPETEER_DOWNLOAD_HOST=https://npmmirror.com/mirrors
export PUPPETEER_SKIP_DOWNLOAD=false

# 设置 npm 镜像
export npm_config_registry=https://registry.npmmirror.com

echo "PUPPETEER_DOWNLOAD_HOST=$PUPPETEER_DOWNLOAD_HOST"
echo "npm_config_registry=$npm_config_registry"

echo "=========================================="
echo "开始安装依赖..."
echo "=========================================="

# 安装依赖
npm install --registry=https://registry.npmmirror.com

echo "=========================================="
echo "安装完成！"
echo "=========================================="
