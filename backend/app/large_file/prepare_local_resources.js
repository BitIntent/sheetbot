#!/usr/bin/env node
/**
 * ============================================================================
 * 准备本地资源脚本
 * - 复制 ECharts 库到 public/lib 目录
 * - 下载 Noto Sans SC 字体文件并转换为 base64
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 查找项目根目录和 frontend 目录
const scriptDir = __dirname; // backend/app/large_file
const projectRoot = resolve(scriptDir, '../../..'); // 项目根目录
const frontendDir = resolve(projectRoot, 'frontend');
const publicDir = resolve(frontendDir, 'public');
const libDir = resolve(publicDir, 'lib');
const fontsDir = resolve(publicDir, 'fonts');

console.log('==========================================');
console.log('准备本地资源');
console.log('==========================================');
console.log(`项目根目录: ${projectRoot}`);
console.log(`前端目录: ${frontendDir}`);
console.log(`公共资源目录: ${publicDir}`);
console.log(`库目录: ${libDir}`);
console.log(`字体目录: ${fontsDir}`);

// 创建目录
if (!existsSync(libDir)) {
    mkdirSync(libDir, { recursive: true });
    console.log(`✅ 创建目录: ${libDir}`);
}
if (!existsSync(fontsDir)) {
    mkdirSync(fontsDir, { recursive: true });
    console.log(`✅ 创建目录: ${fontsDir}`);
}

// 复制 ECharts 库
const echartsSourcePath = resolve(frontendDir, 'node_modules', 'echarts', 'dist', 'echarts.min.js');
const echartsDestPath = resolve(libDir, 'echarts.min.js');

if (existsSync(echartsSourcePath)) {
    copyFileSync(echartsSourcePath, echartsDestPath);
    console.log(`✅ 复制 ECharts 库: ${echartsDestPath}`);
} else {
    console.error(`❌ 未找到 ECharts 库: ${echartsSourcePath}`);
    console.error('请确保已运行 npm install');
    process.exit(1);
}

// 下载 Noto Sans SC 字体（Regular 和 Bold）
// 使用 fontsource CDN，更可靠
const fontFiles = [
    {
        name: 'NotoSansSC-Regular.woff2',
        url: 'https://unpkg.com/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
        weight: 400,
        fallbackUrl: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2'
    },
    {
        name: 'NotoSansSC-Bold.woff2',
        url: 'https://unpkg.com/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-700-normal.woff2',
        weight: 700,
        fallbackUrl: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.0.8/files/noto-sans-sc-chinese-simplified-700-normal.woff2'
    }
];

async function downloadFont(fontFile, useFallback = false) {
    return new Promise((resolve, reject) => {
        const filePath = resolve(fontsDir, fontFile.name);
        
        // 如果文件已存在且大小合理，跳过下载
        if (existsSync(filePath) && !useFallback) {
            const stats = require('fs').statSync(filePath);
            if (stats.size > 50000) { // 至少 50KB（正常字体文件应该 > 100KB）
                console.log(`⏭️  字体已存在，跳过: ${fontFile.name} (${(stats.size / 1024).toFixed(2)} KB)`);
                resolve(filePath);
                return;
            } else {
                console.log(`⚠️  字体文件存在但大小异常 (${(stats.size / 1024).toFixed(2)} KB)，重新下载: ${fontFile.name}`);
            }
        }
        
        const downloadUrl = useFallback ? (fontFile.fallbackUrl || fontFile.url) : fontFile.url;
        console.log(`📥 下载字体: ${fontFile.name}...`);
        console.log(`   来源: ${downloadUrl}`);
        
        const request = https.get(downloadUrl, (response) => {
            // 处理重定向
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                console.log(`   重定向到: ${redirectUrl}`);
                request.destroy();
                // 递归下载重定向 URL
                return downloadFont({ ...fontFile, url: redirectUrl }, useFallback).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                console.error(`❌ 下载失败: HTTP ${response.statusCode}`);
                if (!useFallback && fontFile.fallbackUrl) {
                    console.log(`   尝试备用源...`);
                    request.destroy();
                    return downloadFont(fontFile, true).then(resolve).catch(reject);
                }
                resolve(null);
                return;
            }
            
            const chunks = [];
            let totalSize = 0;
            
            response.on('data', (chunk) => {
                chunks.push(chunk);
                totalSize += chunk.length;
            });
            
            response.on('end', () => {
                if (chunks.length === 0 || totalSize < 50000) {
                    console.error(`❌ 下载失败: 文件大小异常 (${totalSize} bytes，期望 > 50KB)`);
                    if (!useFallback && fontFile.fallbackUrl) {
                        console.log(`   尝试备用源...`);
                        return downloadFont(fontFile, true).then(resolve).catch(reject);
                    }
                    resolve(null);
                    return;
                }
                
                const buffer = Buffer.concat(chunks);
                writeFileSync(filePath, buffer);
                console.log(`✅ 下载完成: ${fontFile.name} (${(buffer.length / 1024).toFixed(2)} KB)`);
                resolve(filePath);
            });
        });
        
        request.on('error', (error) => {
            console.error(`❌ 下载失败: ${fontFile.name} - ${error.message}`);
            console.error(`   错误详情: ${error.code || 'UNKNOWN'}`);
            if (!useFallback && fontFile.fallbackUrl) {
                console.log(`   尝试备用源...`);
                return downloadFont(fontFile, true).then(resolve).catch(reject);
            }
            resolve(null);
        });
        
        request.setTimeout(60000, () => {
            request.destroy();
            console.error(`❌ 下载超时: ${fontFile.name} (60秒)`);
            if (!useFallback && fontFile.fallbackUrl) {
                console.log(`   尝试备用源...`);
                return downloadFont(fontFile, true).then(resolve).catch(reject);
            }
            resolve(null);
        });
    });
}

// 主函数
async function main() {
    // 下载所有字体
    console.log('');
    console.log('下载中文字体...');
    const downloadPromises = fontFiles.map(font => downloadFont(font));
    const downloadedFonts = await Promise.all(downloadPromises);

    const successCount = downloadedFonts.filter(f => f !== null).length;
    console.log('');
    console.log('==========================================');
    console.log('准备完成');
    console.log('==========================================');
    console.log(`ECharts 库位置: ${echartsDestPath}`);
    console.log(`字体文件位置: ${fontsDir}`);
    console.log(`成功下载字体: ${successCount}/${fontFiles.length}`);

    if (successCount === 0) {
        console.log('');
        console.log('⚠️  警告：未下载任何字体文件。');
        console.log('导出功能将使用系统字体，可能无法正确显示中文。');
        console.log('建议手动下载字体文件或检查网络连接。');
    }
}

// 执行主函数
main().catch(error => {
    console.error('执行失败:', error);
    process.exit(1);
});
