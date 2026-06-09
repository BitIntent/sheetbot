#!/usr/bin/env node
/**
 * 报表导出脚本（Node.js）
 * 支持PDF、Word、PNG格式导出
 * 
 * 使用方法：
 *   node report_exporter.js <format> <input_json> <output_file>
 * 
 * 参数：
 *   format: pdf | word | png
 *   input_json: 报表数据的JSON文件路径
 *   output_file: 输出文件路径
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 模块变量（在main函数中动态加载）
let puppeteer, Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, sharp, Media;

// 查找node_modules路径（同步方式）
// 优先查找frontend/node_modules，因为Node.js模块统一放在frontend目录
function findNodeModulesPath(startDir) {
    let currentDir = resolve(startDir);
    const root = resolve('/');
    
    // 首先尝试查找frontend/node_modules（优先）
    while (currentDir !== root) {
        const frontendDir = join(currentDir, 'frontend');
        const nodeModulesPath = join(frontendDir, 'node_modules');
        if (existsSync(frontendDir) && existsSync(nodeModulesPath)) {
            return nodeModulesPath;
        }
        const parent = resolve(currentDir, '..');
        if (parent === currentDir) break;
        currentDir = parent;
    }
    
    // 注意：不再回退到标准查找，因为所有 Node.js 依赖已统一在 frontend 目录
    // 如果找不到 frontend/node_modules，说明配置有问题
    return null;
}

// 读取 package.json 获取模块入口
function getPackageEntry(packagePath) {
    try {
        const packageJsonPath = join(packagePath, 'package.json');
        if (existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            // 优先使用 exports，然后是 main，最后是默认值
            if (packageJson.exports) {
                // exports 可能是对象或字符串
                if (typeof packageJson.exports === 'string') {
                    return resolve(packagePath, packageJson.exports);
                } else if (packageJson.exports['.'] || packageJson.exports['./']) {
                    const exp = packageJson.exports['.'] || packageJson.exports['./'];
                    if (typeof exp === 'string') {
                        return resolve(packagePath, exp);
                    } else if (exp.default || exp.require) {
                        return resolve(packagePath, exp.default || exp.require);
                    }
                }
            }
            if (packageJson.main) {
                return resolve(packagePath, packageJson.main);
            }
        }
    } catch (e) {
        // 忽略错误，继续尝试其他方法
    }
    return null;
}

// 动态加载模块
async function loadModules() {
    const nodeModulesPath = findNodeModulesPath(__dirname);
    
    if (!nodeModulesPath) {
        throw new Error(`未找到node_modules目录\n脚本目录: ${__dirname}\n请确保frontend目录下有node_modules`);
    }
    
    // ES模块需要导入具体文件，不能导入目录
    // 使用绝对路径导入模块的具体入口文件
    try {
        // puppeteer: 尝试多个可能的路径（根据验证结果，入口是 lib/cjs/puppeteer/puppeteer.js）
        const puppeteerPaths = [
            resolve(nodeModulesPath, 'puppeteer', 'lib', 'cjs', 'puppeteer', 'puppeteer.js'), // CJS入口（推荐）
            resolve(nodeModulesPath, 'puppeteer', 'lib', 'esm', 'puppeteer', 'puppeteer.js'), // ESM入口
            resolve(nodeModulesPath, 'puppeteer', 'index.js')
        ];
        
        // 尝试从 package.json 获取入口
        const puppeteerPackagePath = resolve(nodeModulesPath, 'puppeteer');
        const puppeteerEntry = getPackageEntry(puppeteerPackagePath);
        if (puppeteerEntry) {
            puppeteerPaths.unshift(puppeteerEntry);
        }
        
        let puppeteerModule = null;
        for (const puppeteerPath of puppeteerPaths) {
            try {
                if (existsSync(puppeteerPath)) {
                    // 使用 file:// URL 格式确保正确解析
                    const puppeteerUrl = puppeteerPath.startsWith('/') 
                        ? `file://${puppeteerPath}` 
                        : puppeteerPath;
                    puppeteerModule = await import(puppeteerUrl);
                    break;
                }
            } catch (e) {
                // 如果文件存在但导入失败，记录错误但继续尝试下一个
                if (existsSync(puppeteerPath)) {
                    console.error(`puppeteer 导入失败 (${puppeteerPath}):`, e.message);
                }
                continue;
            }
        }
        
        if (!puppeteerModule) {
            throw new Error(`无法找到puppeteer模块入口文件，尝试的路径: ${puppeteerPaths.join(', ')}`);
        }
        puppeteer = puppeteerModule.default || puppeteerModule;
        
        // docx: 尝试多个可能的入口路径（根据验证结果，入口是 build/index.mjs 或 build/index.umd.js）
        const docxPaths = [
            resolve(nodeModulesPath, 'docx', 'build', 'index.mjs'),  // ES模块入口
            resolve(nodeModulesPath, 'docx', 'build', 'index.umd.js'), // UMD入口
            resolve(nodeModulesPath, 'docx', 'build', 'index.js'),
            resolve(nodeModulesPath, 'docx', 'lib', 'index.js'),
            resolve(nodeModulesPath, 'docx', 'index.js')
        ];
        
        // 尝试从 package.json 获取入口
        const docxPackagePath = resolve(nodeModulesPath, 'docx');
        const docxEntry = getPackageEntry(docxPackagePath);
        if (docxEntry) {
            docxPaths.unshift(docxEntry);
        }
        
        let docxModule = null;
        for (const docxPath of docxPaths) {
            try {
                if (existsSync(docxPath)) {
                    // 使用 file:// URL 格式确保正确解析
                    const docxUrl = docxPath.startsWith('/') 
                        ? `file://${docxPath}` 
                        : docxPath;
                    docxModule = await import(docxUrl);
                    break;
                }
            } catch (e) {
                // 如果文件存在但导入失败，记录错误但继续尝试下一个
                if (existsSync(docxPath)) {
                    console.error(`docx 导入失败 (${docxPath}):`, e.message);
                }
                continue;
            }
        }
        
        if (!docxModule) {
            throw new Error(`无法找到docx模块入口文件，尝试的路径: ${docxPaths.join(', ')}`);
        }
        
        Document = docxModule.Document;
        Packer = docxModule.Packer;
        Paragraph = docxModule.Paragraph;
        TextRun = docxModule.TextRun;
        Table = docxModule.Table;
        TableRow = docxModule.TableRow;
        TableCell = docxModule.TableCell;
        WidthType = docxModule.WidthType;
        AlignmentType = docxModule.AlignmentType;
        HeadingLevel = docxModule.HeadingLevel;
        
        // sharp: 尝试多个可能的入口路径
        const sharpPaths = [
            resolve(nodeModulesPath, 'sharp', 'lib', 'index.js'),
            resolve(nodeModulesPath, 'sharp', 'index.js')
        ];
        
        // 尝试从 package.json 获取入口
        const sharpPackagePath = resolve(nodeModulesPath, 'sharp');
        const sharpEntry = getPackageEntry(sharpPackagePath);
        if (sharpEntry) {
            sharpPaths.unshift(sharpEntry);
        }
        
        let sharpModule = null;
        for (const sharpPath of sharpPaths) {
            try {
                if (existsSync(sharpPath)) {
                    // 使用 file:// URL 格式确保正确解析
                    const sharpUrl = sharpPath.startsWith('/') 
                        ? `file://${sharpPath}` 
                        : sharpPath;
                    sharpModule = await import(sharpUrl);
                    break;
                }
            } catch (e) {
                // 如果文件存在但导入失败，记录错误但继续尝试下一个
                if (existsSync(sharpPath)) {
                    console.error(`sharp 导入失败 (${sharpPath}):`, e.message);
                }
                continue;
            }
        }
        
        if (!sharpModule) {
            throw new Error(`无法找到sharp模块入口文件，尝试的路径: ${sharpPaths.join(', ')}`);
        }
        
        sharp = sharpModule.default || sharpModule;
    } catch (e) {
        // 如果绝对路径导入失败，尝试使用包名（需要工作目录正确）
        // 这需要 Node.js 从 frontend 目录运行
        try {
            const puppeteerModule = await import('puppeteer');
            puppeteer = puppeteerModule.default || puppeteerModule;
            
            const docxModule = await import('docx');
            Document = docxModule.Document;
            Packer = docxModule.Packer;
            Paragraph = docxModule.Paragraph;
            TextRun = docxModule.TextRun;
            Table = docxModule.Table;
            TableRow = docxModule.TableRow;
            TableCell = docxModule.TableCell;
            WidthType = docxModule.WidthType;
            AlignmentType = docxModule.AlignmentType;
            HeadingLevel = docxModule.HeadingLevel;
            
            const sharpModule = await import('sharp');
            sharp = sharpModule.default || sharpModule;
        } catch (e2) {
            throw new Error(
                `导入模块失败:\n` +
                `  错误1（绝对路径）: ${e.message}\n` +
                `  错误2（包名）: ${e2.message}\n` +
                `  node_modules路径: ${nodeModulesPath}\n` +
                `  脚本目录: ${__dirname}\n` +
                `  请确保模块已正确安装`
            );
        }
    }
}

// ============================================================================
// 主函数
// ============================================================================
async function main() {
    try {
        // 首先加载模块
        await loadModules();
        
        // 解析命令行参数
        const [format, inputJsonPath, outputFilePath] = process.argv.slice(2);
        
        if (!format || !inputJsonPath || !outputFilePath) {
            throw new Error('缺少必需参数: format, input_json, output_file');
        }
        
        if (!['pdf', 'png'].includes(format)) {
            throw new Error(`不支持的格式: ${format}，支持: pdf, png`);
        }
        
        // 读取报表数据
        let reportData;
        try {
            reportData = JSON.parse(readFileSync(inputJsonPath, 'utf-8'));
        } catch (err) {
            throw new Error(`读取报表数据失败: ${err.message}, 文件路径: ${inputJsonPath}`);
        }
        
        // 根据格式导出
        switch (format) {
            case 'pdf':
                await exportToPDF(reportData, outputFilePath);
                break;
            case 'png':
                await exportToPNG(reportData, outputFilePath);
                break;
            default:
                throw new Error(`未实现的格式: ${format}`);
        }
        
        // 输出成功结果（JSON格式，输出到stdout）
        const successResult = JSON.stringify({ success: true, file: outputFilePath });
        console.log(successResult);
        process.exit(0);
        
    } catch (error) {
        // 输出错误结果（JSON格式，输出到stdout，stderr用于调试）
        const errorMessage = error.message || String(error);
        const errorResult = JSON.stringify({ 
            success: false, 
            error: errorMessage,
            stack: error.stack 
        });
        // 先输出错误信息到stderr（用于调试）
        console.error(`[ERROR] ${errorMessage}`);
        if (error.stack) {
            console.error(`[STACK] ${error.stack}`);
        }
        // 然后输出JSON结果到stdout（Python会读取）
        console.log(errorResult);
        process.exit(1);
    }
}

// ============================================================================
// PDF导出（使用Puppeteer）
// ============================================================================
async function exportToPDF(reportData, outputPath) {
    try {
        const html = generateHTML(reportData);
        
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-features=TranslateUI',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--enable-automation',
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        });
        
        try {
            const page = await browser.newPage();
            
            // 增加页面超时时间（60秒）
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(60000);
            
            // 设置视口大小
            await page.setViewport({ width: 1920, height: 1080 });
            
            // 设置内容（ECharts库已内联，无需等待外部资源）
            await page.setContent(html, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            // 等待ECharts库初始化（内联脚本应该立即可用）
            await page.evaluate(async () => {
                const maxWait = 5000;
                const startTime = Date.now();
                while (typeof echarts === 'undefined' && (Date.now() - startTime) < maxWait) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (typeof echarts === 'undefined') {
                    throw new Error('ECharts库加载失败');
                }
            });
            
            console.log('✅ [PDF] ECharts 库已加载');
            
            // 等待字体加载完成（使用 document.fonts.ready API）
            await page.evaluate(async () => {
                console.log('⏳ [PDF] 等待字体加载...');
                const startTime = Date.now();
                
                try {
                    // 等待所有字体加载完成（最多等待5秒）
                    await Promise.race([
                        document.fonts.ready,
                        new Promise(resolve => setTimeout(resolve, 5000))
                    ]);
                    
                    const loadTime = Date.now() - startTime;
                    console.log('✅ [PDF] 字体加载完成，耗时:', loadTime, 'ms');
                    
                    // 检查 Noto Sans SC 是否可用
                    const fontAvailable = document.fonts.check('14px "Noto Sans SC"');
                    console.log('[PDF] Noto Sans SC 字体可用:', fontAvailable);
                    
                    // 列出所有已加载的字体
                    const loadedFonts = Array.from(document.fonts.values())
                        .filter(f => f.status === 'loaded')
                        .map(f => `${f.family} (${f.weight})`);
                    console.log('[PDF] 已加载字体:', loadedFonts.join(', '));
                    
                } catch (e) {
                    console.warn('⚠️  [PDF] 字体加载检测失败:', e.message);
                }
            });
            
            // 额外等待确保字体完全渲染（兜底）
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('[PDF] 开始渲染图表...');
            
            // 等待所有图表渲染完成
            await page.evaluate(async () => {
                // 检查图表是否已渲染
                const checkChartsReady = () => {
                    if (typeof echarts === 'undefined') {
                        console.error('ECharts 未加载');
                        return false;
                    }
                    
                    const chartsReady = document.body.getAttribute('data-charts-ready') === 'true';
                    if (!chartsReady) return false;
                    
                    // 检查所有图表容器是否已渲染
                    const chartContainers = document.querySelectorAll('[id^="chart_"]');
                    if (chartContainers.length === 0) {
                        // 没有图表，直接返回 true
                        return true;
                    }
                    
                    for (const container of chartContainers) {
                        if (container.getAttribute('data-rendered') !== 'true') {
                            return false;
                        }
                        // 检查图表是否真的有内容（canvas 元素）
                        const canvas = container.querySelector('canvas');
                        if (!canvas || canvas.width === 0 || canvas.height === 0) {
                            return false;
                        }
                    }
                    return true;
                };
                
                // 轮询检查，最多等待20秒
                const maxWait = 20000;
                const startTime = Date.now();
                while (!checkChartsReady() && (Date.now() - startTime) < maxWait) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
                
                // 最终检查
                if (!checkChartsReady()) {
                    console.warn('⚠️  部分图表可能未完全渲染');
                    // 记录未渲染的图表
                    const chartContainers = document.querySelectorAll('[id^="chart_"]');
                    chartContainers.forEach((container, idx) => {
                        if (container.getAttribute('data-rendered') !== 'true') {
                            console.warn('  - 未渲染:', container.id);
                        } else {
                            const canvas = container.querySelector('canvas');
                            if (!canvas) {
                                console.warn('  - 无canvas:', container.id);
                            } else if (canvas.width === 0 || canvas.height === 0) {
                                console.warn('  - canvas尺寸为0:', container.id, 'width=', canvas.width, 'height=', canvas.height);
                            }
                        }
                    });
                } else {
                    console.log('✅ 所有图表已完全渲染');
                }
            });
            
            // 额外等待确保渲染稳定（虽然禁用了动画，但canvas绘制仍需时间）
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            console.log('开始生成PDF...');
            
            // 生成PDF（优化分页设置，自定义宽度900px，缩小边距以承载更多内容）
            await page.pdf({
                path: outputPath,
                width: '900px',
                height: '1123px', // 保持A4高度比例
                margin: {
                    top: '5mm',
                    right: '5mm',
                    bottom: '5mm',
                    left: '5mm'
                },
                printBackground: true,
                preferCSSPageSize: false,
                displayHeaderFooter: false
            });
        } finally {
            await browser.close();
        }
    } catch (error) {
        throw new Error(`PDF导出失败: ${error.message}`);
    }
}

// ============================================================================
// Word导出功能已删除
// ============================================================================

// ============================================================================
// PNG导出（使用Puppeteer截图）
// ============================================================================
async function exportToPNG(reportData, outputPath) {
    try {
        const html = generateHTML(reportData);
        
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-features=TranslateUI',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-first-run',
                '--safebrowsing-disable-auto-update',
                '--enable-automation',
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        });
        
        try {
            const page = await browser.newPage();
            
            // 增加页面超时时间（60秒）
            page.setDefaultNavigationTimeout(60000);
            page.setDefaultTimeout(60000);
            
            // 设置视口为自定义宽度900px
            await page.setViewport({ width: 900, height: 1123 });
            
            // 设置内容（ECharts库已内联，无需等待外部资源）
            await page.setContent(html, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            // 等待ECharts库初始化（内联脚本应该立即可用）
            await page.evaluate(async () => {
                const maxWait = 5000;
                const startTime = Date.now();
                while (typeof echarts === 'undefined' && (Date.now() - startTime) < maxWait) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (typeof echarts === 'undefined') {
                    throw new Error('ECharts库加载失败');
                }
            });
            
            console.log('✅ [PNG] ECharts 库已加载');
            
            // 等待字体加载完成（使用 document.fonts.ready API）
            await page.evaluate(async () => {
                console.log('⏳ [PNG] 等待字体加载...');
                const startTime = Date.now();
                
                try {
                    // 等待所有字体加载完成（最多等待5秒）
                    await Promise.race([
                        document.fonts.ready,
                        new Promise(resolve => setTimeout(resolve, 5000))
                    ]);
                    
                    const loadTime = Date.now() - startTime;
                    console.log('✅ [PNG] 字体加载完成，耗时:', loadTime, 'ms');
                    
                    // 检查 Noto Sans SC 是否可用
                    const fontAvailable = document.fonts.check('14px "Noto Sans SC"');
                    console.log('[PNG] Noto Sans SC 字体可用:', fontAvailable);
                    
                    // 列出所有已加载的字体
                    const loadedFonts = Array.from(document.fonts.values())
                        .filter(f => f.status === 'loaded')
                        .map(f => `${f.family} (${f.weight})`);
                    console.log('[PNG] 已加载字体:', loadedFonts.join(', '));
                    
                } catch (e) {
                    console.warn('⚠️  [PNG] 字体加载检测失败:', e.message);
                }
            });
            
            // 额外等待确保字体完全渲染（兜底）
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('[PNG] 开始渲染图表...');
            
            // 等待所有图表渲染完成（与 PDF 导出使用相同的逻辑）
            await page.evaluate(async () => {
                // 检查图表是否已渲染
                const checkChartsReady = () => {
                    if (typeof echarts === 'undefined') {
                        console.error('ECharts 未加载');
                        return false;
                    }
                    
                    const chartsReady = document.body.getAttribute('data-charts-ready') === 'true';
                    if (!chartsReady) return false;
                    
                    // 检查所有图表容器是否已渲染
                    const chartContainers = document.querySelectorAll('[id^="chart_"]');
                    if (chartContainers.length === 0) {
                        // 没有图表，直接返回 true
                        return true;
                    }
                    
                    for (const container of chartContainers) {
                        if (container.getAttribute('data-rendered') !== 'true') {
                            return false;
                        }
                        // 检查图表是否真的有内容（canvas 元素）
                        const canvas = container.querySelector('canvas');
                        if (!canvas || canvas.width === 0 || canvas.height === 0) {
                            return false;
                        }
                    }
                    return true;
                };
                
                // 轮询检查，最多等待20秒
                const maxWait = 20000;
                const startTime = Date.now();
                while (!checkChartsReady() && (Date.now() - startTime) < maxWait) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
                
                // 最终检查
                if (!checkChartsReady()) {
                    console.warn('⚠️  部分图表可能未完全渲染');
                    // 记录未渲染的图表
                    const chartContainers = document.querySelectorAll('[id^="chart_"]');
                    chartContainers.forEach((container, idx) => {
                        if (container.getAttribute('data-rendered') !== 'true') {
                            console.warn('  - 未渲染:', container.id);
                        } else {
                            const canvas = container.querySelector('canvas');
                            if (!canvas) {
                                console.warn('  - 无canvas:', container.id);
                            } else if (canvas.width === 0 || canvas.height === 0) {
                                console.warn('  - canvas尺寸为0:', container.id, 'width=', canvas.width, 'height=', canvas.height);
                            }
                        }
                    });
                } else {
                    console.log('✅ 所有图表已完全渲染');
                }
            });
            
            // 额外等待确保渲染稳定（虽然禁用了动画，但canvas绘制仍需时间）
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            console.log('开始生成PNG截图...');
            
            // 截图
            const screenshot = await page.screenshot({
                type: 'png',
                fullPage: true,
                clip: null
            });
            
            // 使用sharp优化图片质量
            await sharp(screenshot)
                .png({ quality: 100, compressionLevel: 6 })
                .toFile(outputPath);
                
        } finally {
            await browser.close();
        }
    } catch (error) {
        throw new Error(`PNG导出失败: ${error.message}`);
    }
}

// ============================================================================
// HTML生成（用于PDF和PNG）
// ============================================================================
function generateHTML(reportData) {
    // 转义图表配置为JSON字符串（用于内联到HTML）
    let chartsData = reportData.charts && reportData.charts.length > 0 
        ? reportData.charts.map((chart, idx) => ({
            id: `chart_${idx}`,
            title: chart.title || '',
            option: chart.option ? addChineseFontToOption(chart.option) : {}
        }))
        : [];
    
    // 解析 Markdown 表格并生成图表（在生成 HTML 之前）
    let tableChartsMap = new Map();
    if (reportData.insights) {
        let insightsText = reportData.insights.replace(/[🎯👥📦📊📄✅⚠️💡❌🔴🟡🟢]/g, '');
        // 过滤掉"---"分隔符（单独一行的三个或更多短横线）
        insightsText = insightsText.replace(/^---+$/gm, '');
        // 过滤掉连续的空行（超过2个换行符）
        insightsText = insightsText.replace(/\n{3,}/g, '\n\n');
        const parsedTables = parseMarkdownTables(insightsText);
        
        // 为每个表格生成图表
        parsedTables.forEach((table) => {
            const chart = generateChartFromTable(table);
            if (chart) {
                tableChartsMap.set(table.index, chart);
                // 将表格图表添加到 chartsData
                chartsData.push({
                    id: `chart_table_${table.index}`,
                    title: chart.title,
                    option: chart.option
                });
            }
        });
    }
    
    // 读取本地 ECharts 库和字体文件
    let echartsScript = '';
    let fontFaceCSS = '';
    
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const scriptDir = __dirname; // backend/app/large_file
        const projectRoot = resolve(scriptDir, '../../..'); // 项目根目录
        const frontendDir = resolve(projectRoot, 'frontend');
        
        // 读取 ECharts 库
        const echartsPath = resolve(frontendDir, 'public', 'lib', 'echarts.min.js');
        if (existsSync(echartsPath)) {
            echartsScript = readFileSync(echartsPath, 'utf-8');
        } else {
            // 如果 public/lib 不存在，尝试从 node_modules 读取
            const echartsNodeModulesPath = resolve(frontendDir, 'node_modules', 'echarts', 'dist', 'echarts.min.js');
            if (existsSync(echartsNodeModulesPath)) {
                echartsScript = readFileSync(echartsNodeModulesPath, 'utf-8');
            } else {
                throw new Error('未找到 ECharts 库，请运行 prepare_local_resources.js 准备资源');
            }
        }
        
        // 读取字体文件并转换为 base64
        // 优先使用 WOFF2，如果没有则使用 TTF
        const fontsDir = resolve(frontendDir, 'public', 'fonts');
        
        // 尝试 WOFF2 格式
        let regularFontPath = resolve(fontsDir, 'NotoSansSC-Regular.woff2');
        let boldFontPath = resolve(fontsDir, 'NotoSansSC-Bold.woff2');
        let regularFormat = 'woff2';
        let boldFormat = 'woff2';
        
        // 如果 WOFF2 不存在，尝试 TTF 格式
        if (!existsSync(regularFontPath)) {
            regularFontPath = resolve(fontsDir, 'NotoSansSC-Regular.ttf');
            regularFormat = 'truetype';
        }
        if (!existsSync(boldFontPath)) {
            boldFontPath = resolve(fontsDir, 'NotoSansSC-Bold.ttf');
            boldFormat = 'truetype';
        }
        
        if (existsSync(regularFontPath) && existsSync(boldFontPath)) {
            const regularFontBuffer = readFileSync(regularFontPath);
            const boldFontBuffer = readFileSync(boldFontPath);
            const regularFontBase64 = regularFontBuffer.toString('base64');
            const boldFontBase64 = boldFontBuffer.toString('base64');
            
            // 根据格式设置 MIME 类型
            const regularMimeType = regularFormat === 'woff2' ? 'font/woff2' : 'font/ttf';
            const boldMimeType = boldFormat === 'woff2' ? 'font/woff2' : 'font/ttf';
            
            fontFaceCSS = `
        @font-face {
            font-family: 'Noto Sans SC';
            font-style: normal;
            font-weight: 400;
            font-display: swap;
            src: url(data:${regularMimeType};charset=utf-8;base64,${regularFontBase64}) format('${regularFormat}');
        }
        @font-face {
            font-family: 'Noto Sans SC';
            font-style: normal;
            font-weight: 700;
            font-display: swap;
            src: url(data:${boldMimeType};charset=utf-8;base64,${boldFontBase64}) format('${boldFormat}');
        }`;
            
            console.log(`✅ 加载字体文件: Regular (${regularFormat}, ${(regularFontBuffer.length / 1024).toFixed(2)} KB), Bold (${boldFormat}, ${(boldFontBuffer.length / 1024).toFixed(2)} KB)`);
        } else {
            // 如果字体文件不存在，使用系统字体作为后备
            console.warn('⚠️  字体文件不存在，使用系统字体作为后备');
            console.warn(`   查找路径: ${regularFontPath}, ${boldFontPath}`);
        }
    } catch (error) {
        throw new Error(`加载资源失败: ${error.message}`);
    }
    
    // 提取前端 CSS 样式（完全匹配前端样式）
    const frontendStyles = `
        ${fontFaceCSS}
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: "Noto Sans SC", "Microsoft YaHei", "SimSun", "SimHei", "Arial Unicode MS", Arial, sans-serif;
            font-size: 15px;
            line-height: 1.8;
            color: #374151;
            padding: 16px;
            background: #fff;
            margin: 0;
            max-width: 100%;
            overflow-x: hidden;
        }
        
        /* PDF导出时移除所有阴影和背景框效果 */
        @media print {
            * {
                box-shadow: none !important;
            }
            body {
                background: #fff !important;
            }
        }
        
        /* 报表内容区域 */
        .report-content {
            padding: 16px;
            max-width: 100%;
            overflow-x: hidden;
        }
        
        /* 报表标题 */
        .report-header {
            margin-bottom: 32px;
            padding-bottom: 24px;
            border-bottom: 2px solid #e5e7eb;
        }
        
        .report-header h1 {
            font-size: 28px;
            font-weight: 700;
            color: #1f2937;
            margin: 0 0 8px 0;
        }
        
        /* 核心指标区域 */
        .report-metrics-section {
            margin-bottom: 32px;
            padding: 32px;
            background: #ffffff;
            border-radius: 0;
            border: none;
            box-shadow: none;
        }
        
        .report-metrics-section h2 {
            font-size: 24px;
            font-weight: 700;
            color: #1f2937;
            margin: 0 0 24px 0;
            padding-bottom: 12px;
            border-bottom: 3px solid #217346;
        }
        
        .metrics-table-wrapper {
            overflow-x: auto;
            margin-top: 16px;
            border-radius: 0;
            border: none;
            box-shadow: none;
            background: white;
        }
        
        .metrics-table-wrapper::before {
            content: '';
            display: none;
        }
        
        .metrics-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
            min-width: 100%;
        }
        
        .metrics-table thead {
            background: linear-gradient(to bottom, #217346, #1e5f3a);
        }
        
        .metrics-table th {
            padding: 14px 18px;
            text-align: left;
            font-weight: 600;
            color: #ffffff;
            border-bottom: 2px solid #1e5f3a;
            white-space: nowrap;
            font-size: 14px;
            letter-spacing: 0.5px;
        }
        
        .metrics-table tbody tr {
            border-bottom: 1px solid #f3f4f6;
        }
        
        .metrics-table tbody tr:nth-child(even) {
            background: #fafbfc;
        }
        
        .metrics-table tbody tr:last-child {
            border-bottom: none;
        }
        
        .metrics-table td {
            padding: 14px 18px;
            color: #374151;
            border-right: 1px solid #f3f4f6;
            line-height: 1.6;
        }
        
        .metrics-table td:last-child {
            border-right: none;
        }
        
        .metrics-table th:first-child,
        .metrics-table td:first-child {
            padding-left: 24px;
        }
        
        .metrics-table th:last-child,
        .metrics-table td:last-child {
            padding-right: 24px;
        }
        
        .metric-value {
            font-weight: 600;
            color: #217346;
            font-size: 16px;
        }
        
        /* 图表区域 */
        .report-charts {
            display: flex;
            flex-direction: column;
            gap: 32px;
            margin-bottom: 32px;
            margin-left: 0;
            padding-left: 0;
        }
        
        .chart-container {
            padding: 16px 16px 16px 0;
            background: #ffffff;
            border-radius: 0;
            border: none;
            box-shadow: none;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            margin-left: 0;
            margin-right: 0;
            padding-left: 0;
        }
        
        .chart-container h3 {
            font-size: 18px;
            font-weight: 600;
            color: #1f2937;
            margin: 0 0 16px 0;
            text-align: left;
            padding-left: 0;
            width: 100%;
        }
        
        .chart-wrapper {
            width: 100%;
            max-width: 100%;
            height: 400px;
            margin: 20px 0;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: visible;
        }
        
        /* 文字解读区域 */
        .report-insights {
            margin-bottom: 32px;
            padding: 32px;
            background: #ffffff;
            border-radius: 0;
            border: none;
            box-shadow: none;
        }
        
        .report-insights h2 {
            font-size: 24px;
            font-weight: 700;
            color: #1f2937;
            margin: 0 0 24px 0;
            padding-bottom: 12px;
            border-bottom: 3px solid #217346;
        }
        
        .insights-content {
            font-size: 15px;
            line-height: 1.8;
            color: #374151;
        }
        
        /* Markdown 样式 */
        .markdown-h1 {
            font-size: 28px;
            font-weight: 700;
            color: #1f2937;
            margin: 32px 0 16px 0;
            padding-bottom: 8px;
            padding-left: 0;
            border-bottom: 2px solid #e5e7eb;
        }
        
        .markdown-h2 {
            font-size: 24px;
            font-weight: 700;
            color: #1f2937;
            margin: 28px 0 16px 0;
            padding-bottom: 8px;
            border-bottom: 2px solid #e5e7eb;
        }
        
        .markdown-h3 {
            font-size: 20px;
            font-weight: 600;
            color: #374151;
            margin: 24px 0 12px 0;
            padding-left: 0;
        }
        
        .markdown-h4 {
            font-size: 18px;
            font-weight: 600;
            color: #4b5563;
            margin: 20px 0 10px 0;
            padding-left: 0;
        }
        
        .markdown-p {
            margin: 12px 0;
            line-height: 1.8;
            color: #374151;
        }
        
        .markdown-ul,
        .markdown-ol {
            margin: 16px 0;
            padding-left: 24px;
        }
        
        .markdown-li {
            margin: 8px 0;
            line-height: 1.8;
            color: #374151;
        }
        
        .markdown-strong {
            font-weight: 600;
            color: #1f2937;
        }
        
        /* Markdown 表格样式 */
        .markdown-table-wrapper {
            overflow-x: auto;
            margin: 24px 0;
            border-radius: 0;
            border: none;
            box-shadow: none;
            background: white;
        }
        
        .markdown-table-wrapper::before {
            content: '';
            display: none;
        }
        
        .markdown-table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            font-size: 14px;
            min-width: 100%;
        }
        
        .markdown-thead {
            background: linear-gradient(to bottom, #217346, #1e5f3a);
        }
        
        .markdown-th {
            padding: 14px 18px;
            text-align: left;
            font-weight: 600;
            color: #ffffff;
            border-bottom: 2px solid #1e5f3a;
            white-space: nowrap;
            font-size: 14px;
            letter-spacing: 0.5px;
        }
        
        .markdown-tbody .markdown-tr {
            border-bottom: 1px solid #f3f4f6;
        }
        
        .markdown-tbody .markdown-tr:nth-child(even) {
            background: #fafbfc;
        }
        
        .markdown-tbody .markdown-tr:last-child {
            border-bottom: none;
        }
        
        .markdown-td {
            padding: 14px 18px;
            color: #374151;
            border-right: 1px solid #f3f4f6;
            line-height: 1.6;
        }
        
        .markdown-td:last-child {
            border-right: none;
        }
        
        .markdown-th:first-child,
        .markdown-td:first-child {
            padding-left: 24px;
        }
        
        .markdown-th:last-child,
        .markdown-td:last-child {
            padding-right: 24px;
        }
        
        /* 表格+图表组合 */
        .table-with-chart-wrapper {
            margin: 24px 0;
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        .table-chart-above {
            margin-bottom: 24px;
            padding: 16px 16px 16px 0;
            background: #ffffff;
            border-radius: 0;
            border: none;
            box-shadow: none;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            page-break-inside: avoid;
            break-inside: avoid;
            margin-left: 0;
            margin-right: 0;
        }
        
        .table-chart-title {
            font-size: 16px;
            font-weight: 600;
            color: #1f2937;
            margin: 0 0 16px 0;
            text-align: left;
            width: 100%;
            padding-left: 0;
        }
        
        .table-chart-wrapper {
            width: 100%;
            max-width: 100%;
            height: 350px;
            display: block;
            overflow: hidden;
            padding-left: 0;
        }
        
        /* 防止分页拆分相关内容 */
        .report-metrics-section {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        .report-charts {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        .chart-container {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        .report-insights {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        .markdown-table-wrapper {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        .metrics-table-wrapper {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        @media print {
            body { padding: 10px; }
            .page-break { page-break-after: always; }
        }
    `;
    
    let html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <script>${echartsScript}</script>
    <style>
        ${frontendStyles}
    </style>
</head>
<body>
    <div class="report-content">
`;
    
    // 标题
    if (reportData.title) {
        html += `<div class="report-header">`;
        html += `<h1>${escapeHtml(reportData.title)}</h1>`;
        html += `</div>`;
    }
    
    // 关键指标（使用前端样式）
    if (reportData.key_metrics && reportData.key_metrics.length > 0) {
        html += `<div class="report-metrics-section">`;
        html += `<h2>核心指标概览</h2>`;
        html += `<div class="metrics-table-wrapper">`;
        html += `<table class="metrics-table">`;
        html += `<thead><tr><th>指标名称</th><th>数值</th><th>说明</th></tr></thead>`;
        html += `<tbody>`;
        for (const metric of reportData.key_metrics) {
            html += `<tr>`;
            html += `<td>${escapeHtml(metric.name || '')}</td>`;
            html += `<td class="metric-value">${escapeHtml(String(metric.value || ''))}</td>`;
            html += `<td>${escapeHtml(metric.description || '')}</td>`;
            html += `</tr>`;
        }
        html += `</tbody></table>`;
        html += `</div>`;
        html += `</div>`;
    }
    
    // 图表（使用ECharts渲染）- 只渲染主图表（非表格图表）
    const mainCharts = chartsData.filter(chart => !chart.id.startsWith('chart_table_'));
    if (mainCharts.length > 0) {
        html += `<div class="report-charts">`;
        for (const chart of mainCharts) {
            html += `<div class="chart-container">`;
            html += `<h3>${escapeHtml(chart.title)}</h3>`;
            html += `<div id="${chart.id}" class="chart-wrapper"></div>`;
            html += `</div>`;
        }
        html += `</div>`;
    }
    
    // 文字解读（包含表格+图表组合）
    if (reportData.insights) {
        let insightsText = reportData.insights.replace(/[🎯👥📦📊📄✅⚠️💡❌🔴🟡🟢]/g, '');
        // 过滤掉"---"分隔符（单独一行的三个或更多短横线）
        insightsText = insightsText.replace(/^---+$/gm, '');
        // 过滤掉连续的空行（超过2个换行符）
        insightsText = insightsText.replace(/\n{3,}/g, '\n\n');
        const parsedTables = parseMarkdownTables(insightsText);
        
        html += `<div class="report-insights">`;
        html += `<h2>数据分析解读</h2>`;
        html += `<div class="insights-content">`;
        
        // 预处理 Markdown：将表格替换为带图表的自定义标记
        let processedText = insightsText;
        const tablePlaceholders = [];
        
        parsedTables.forEach((table) => {
            const chart = tableChartsMap.get(table.index);
            const placeholder = `__TABLE_WITH_CHART_${table.index}__`;
            tablePlaceholders.push({
                placeholder,
                table,
                chart
            });
            // 替换表格文本为占位符
            processedText = processedText.replace(table.rawText, placeholder);
        });
        
        // 将处理后的文本转换为 HTML，并替换占位符
        const parts = processedText.split(/(__TABLE_WITH_CHART_\d+__)/);
        for (const part of parts) {
            const placeholderMatch = part.match(/__TABLE_WITH_CHART_(\d+)__/);
            if (placeholderMatch) {
                const tableIndex = parseInt(placeholderMatch[1]);
                const placeholder = tablePlaceholders.find(p => p.table.index === tableIndex);
                if (placeholder) {
                    // 渲染表格+图表组合
                    html += `<div class="table-with-chart-wrapper">`;
                    
                    // 如果有图表，先渲染图表
                    if (placeholder.chart) {
                        html += `<div class="table-chart-above">`;
                        html += `<h4 class="table-chart-title">${escapeHtml(placeholder.chart.title)}</h4>`;
                        html += `<div id="chart_table_${tableIndex}" class="table-chart-wrapper"></div>`;
                        html += `</div>`;
                    }
                    
                    // 渲染表格
                    html += `<div class="markdown-table-wrapper">`;
                    html += `<table class="markdown-table">`;
                    html += `<thead class="markdown-thead"><tr>`;
                    for (const header of placeholder.table.headers) {
                        html += `<th class="markdown-th">${escapeHtml(header)}</th>`;
                    }
                    html += `</tr></thead>`;
                    html += `<tbody class="markdown-tbody">`;
                    for (const row of placeholder.table.rows) {
                        html += `<tr class="markdown-tr">`;
                        for (const header of placeholder.table.headers) {
                            html += `<td class="markdown-td">${escapeHtml(String(row[header] || ''))}</td>`;
                        }
                        html += `</tr>`;
                    }
                    html += `</tbody></table>`;
                    html += `</div>`;
                    html += `</div>`;
                }
            } else {
                // 普通文本，转换为 HTML
                const markdownHtml = markdownToHtml(part);
                html += markdownHtml;
            }
        }
        
        html += `</div>`;
        html += `</div>`;
    }
    
    // 内联图表配置和渲染脚本
    // 注意：使用立即执行函数，不依赖 DOMContentLoaded（Puppeteer 可能已经过了这个事件）
    html += `
    <script>
        (function() {
            // 图表配置数据
            const chartsData = ${JSON.stringify(chartsData)};
            
            // 渲染函数
            function renderCharts() {
                if (typeof echarts === 'undefined') {
                    console.error('❌ ECharts 未加载');
                    document.body.setAttribute('data-charts-ready', 'true');
                    return;
                }
                
                let renderedCount = 0;
                const totalCharts = chartsData.length;
                
                console.log('📊 开始渲染图表，总数:', totalCharts);
                console.log('📊 图表列表:', chartsData.map(c => c.id + ' - ' + c.title).join(', '));
                
                // 超时机制：如果10秒后还没有全部渲染完成，强制标记为完成
                const renderTimeout = setTimeout(() => {
                    if (renderedCount < totalCharts) {
                        console.warn('⚠️  图表渲染超时，已渲染', renderedCount, '/', totalCharts);
                        // 列出未渲染的图表
                        chartsData.forEach((chart) => {
                            const chartDom = document.getElementById(chart.id);
                            if (chartDom && chartDom.getAttribute('data-rendered') !== 'true') {
                                console.warn('  - 未完成:', chart.id, chart.title);
                            }
                        });
                        document.body.setAttribute('data-charts-ready', 'true');
                    }
                }, 10000);
                
                chartsData.forEach(function(chart, idx) {
                    const chartDom = document.getElementById(chart.id);
                    console.log(`📈 [${idx + 1}/${totalCharts}] 准备渲染:`, chart.id, '-', chart.title);
                    
                    if (!chartDom) {
                        console.error(`❌ [${idx + 1}/${totalCharts}] 容器不存在:`, chart.id);
                        renderedCount++;
                        if (renderedCount === totalCharts) {
                            clearTimeout(renderTimeout);
                            document.body.setAttribute('data-charts-ready', 'true');
                        }
                        return;
                    }
                    
                    if (!chart.option) {
                        console.error(`❌ [${idx + 1}/${totalCharts}] 图表配置缺失:`, chart.id);
                        renderedCount++;
                        if (renderedCount === totalCharts) {
                            clearTimeout(renderTimeout);
                            document.body.setAttribute('data-charts-ready', 'true');
                        }
                        return;
                    }
                    
                    if (chartDom && chart.option) {
                        try {
                            // 表格图表使用 350px 高度，主图表使用 400px
                            const isTableChart = chart.id.startsWith('chart_table_');
                            const chartHeight = isTableChart ? 350 : 400;
                            
                            // 计算图表宽度：PDF页面宽度900px，减去左右边距（5mm * 2 = 10mm ≈ 38px），减去body padding（16px * 2 = 32px）
                            // 可用宽度 = 900 - 38 - 32 ≈ 830px
                            // 但实际需要考虑容器宽度，取较小值
                            const containerWidth = chartDom.parentElement ? chartDom.parentElement.offsetWidth : chartDom.offsetWidth;
                            const bodyPadding = 32; // 左右padding总和（16px * 2）
                            const marginPx = 10 * 3.7795; // 左右边距总和（5mm * 2 ≈ 38px）
                            const pageContentWidth = 900 - marginPx - bodyPadding; // 900px减去边距和padding
                            const availableWidth = Math.min(containerWidth || pageContentWidth, pageContentWidth);
                            // 减去图表容器的左右padding（16px * 2 = 32px）
                            const chartWidth = Math.max(availableWidth - 32, 500);
                            
                            // 确保图表容器宽度正确
                            chartDom.style.width = chartWidth + 'px';
                            chartDom.style.height = chartHeight + 'px';
                            
                            const myChart = echarts.init(chartDom, null, {
                                renderer: 'canvas',
                                width: chartWidth,
                                height: chartHeight,
                                animation: false  // 禁用动画，加速渲染
                            });
                            
                            // 更新图表option的grid配置，确保内容区域正确且不被截断，并左对齐
                            if (chart.option) {
                                // 禁用所有动画
                                chart.option.animation = false;
                                
                                if (!chart.option.grid) {
                                    chart.option.grid = {
                                        left: '5%',
                                        right: '5%',
                                        bottom: '10%',
                                        top: '15%',
                                        containLabel: true
                                    };
                                } else {
                                    // 确保containLabel为true，让坐标轴标签不被截断
                                    chart.option.grid.containLabel = true;
                                    // 调整左边距，让图表更靠左对齐
                                    chart.option.grid.left = '5%';
                                    // 调整右边距，确保内容完整显示
                                    if (!chart.option.grid.right || chart.option.grid.right === '4%' || chart.option.grid.right === '5%') {
                                        chart.option.grid.right = '5%';
                                    }
                                }
                            }
                            
                            // 监听 finished 事件，确保图表真正渲染完成
                            myChart.on('finished', function() {
                                chartDom.setAttribute('data-rendered', 'true');
                                renderedCount++;
                                console.log(`✅ [${renderedCount}/${totalCharts}] 渲染完成:`, chart.id, '-', chart.title);
                                
                                if (renderedCount === totalCharts) {
                                    clearTimeout(renderTimeout); // 清除超时定时器
                                    document.body.setAttribute('data-charts-ready', 'true');
                                    console.log('🎉 所有图表渲染完成:', renderedCount, '/', totalCharts);
                                }
                            });
                            
                            // 设置图表配置（finished 事件会在渲染完成后触发）
                            myChart.setOption(chart.option);
                            
                            // 兜底机制：如果2秒后finished事件还没触发（某些图表类型可能不触发finished），手动标记
                            setTimeout(() => {
                                if (chartDom.getAttribute('data-rendered') !== 'true') {
                                    console.warn(`⚠️  [${idx + 1}/${totalCharts}] finished事件超时，使用兜底:`, chart.id);
                                    chartDom.setAttribute('data-rendered', 'true');
                                    renderedCount++;
                                    
                                    if (renderedCount === totalCharts) {
                                        clearTimeout(renderTimeout);
                                        document.body.setAttribute('data-charts-ready', 'true');
                                        console.log('🎉 所有图表渲染完成（兜底）:', renderedCount, '/', totalCharts);
                                    }
                                }
                            }, 2000);
                            
                        } catch (error) {
                            console.error(`❌ [${idx + 1}/${totalCharts}] 渲染失败:`, chart.id, error.message);
                            console.error('错误堆栈:', error.stack);
                            chartDom.setAttribute('data-rendered', 'true'); // 标记为已处理，避免阻塞
                            renderedCount++;
                            if (renderedCount === totalCharts) {
                                clearTimeout(renderTimeout);
                                document.body.setAttribute('data-charts-ready', 'true');
                            }
                        }
                    } else {
                        renderedCount++;
                        if (renderedCount === totalCharts) {
                            document.body.setAttribute('data-charts-ready', 'true');
                        }
                    }
                });
                
                // 如果没有图表，立即标记为完成
                if (totalCharts === 0) {
                    document.body.setAttribute('data-charts-ready', 'true');
                }
            }
            
            // 如果 DOM 已加载，立即执行；否则等待
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', renderCharts);
            } else {
                // DOM 已加载，延迟一点确保容器已渲染
                setTimeout(renderCharts, 100);
            }
        })();
    </script>
    </div>
</body>
</html>
`;
    
    return html;
}

// ============================================================================
// 工具函数
// ============================================================================
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================================================
// Markdown 表格解析（与前端逻辑完全一致）
// ============================================================================
function parseMarkdownTables(markdown) {
    const tables = [];
    let tableIndex = 0;
    
    // 方法1：标准格式（表头和分隔行在不同行）
    const standardTableRegex = /(\|[^\n]+\|\s*\n\|[\s-|:]+\|\s*\n(?:\|[^\n]+\|\s*\n?)+)/g;
    let match;
    
    while ((match = standardTableRegex.exec(markdown)) !== null) {
        const tableText = match[1];
        const parsed = parseTableText(tableText, tableIndex++);
        if (parsed) tables.push(parsed);
    }
    
    // 方法2：紧凑格式（表头和分隔行在同一行）：| 列1 | 列2 | |---|---|
    const compactTableRegex = /(\|[^\n]+\|\s*\|\s*[\s-|:]+\|(?:\s*\n\s*\|\s*[^\n]+\|)+)/g;
    standardTableRegex.lastIndex = 0; // 重置
    
    while ((match = compactTableRegex.exec(markdown)) !== null) {
        const tableText = match[1];
        // 检查是否已经被标准格式匹配过
        const alreadyParsed = tables.some(t => t.rawText === tableText);
        if (!alreadyParsed) {
            // 将紧凑格式转换为标准格式
            const normalized = normalizeCompactTable(tableText);
            const parsed = parseTableText(normalized, tableIndex++);
            if (parsed) tables.push(parsed);
        }
    }
    
    // 方法3：逐行检测（更宽松的匹配）
    const lines = markdown.split('\n');
    let currentTable = null;
    let headerLine = null;
    let separatorLine = null;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // 检测表头行
        if (line.startsWith('|') && line.endsWith('|') && !line.match(/^[\s|:-]+$/)) {
            // 检查下一行是否是分隔行
            const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
            const isSeparator = nextLine.match(/^[\s|:-]+$/);
            
            if (isSeparator) {
                // 标准格式：表头行 + 分隔行
                headerLine = line;
                separatorLine = nextLine;
                currentTable = {
                    headerLine,
                    separatorLine,
                    dataLines: [],
                    startIndex: i
                };
                i++; // 跳过分隔行
            } else {
                // 可能是紧凑格式或数据行
                if (currentTable) {
                    currentTable.dataLines.push(line);
                } else {
                    // 检查是否是紧凑格式的表头+分隔行
                    const parts = line.split(/\s*\|\s*\|/).filter(p => p.trim());
                    if (parts.length >= 2) {
                        const headerPart = parts[0] + '|';
                        const separatorPart = '|' + parts[1];
                        if (separatorPart.match(/[\s-|:]+/)) {
                            headerLine = headerPart;
                            separatorLine = separatorPart;
                            currentTable = {
                                headerLine,
                                separatorLine,
                                dataLines: [],
                                startIndex: i
                            };
                        }
                    }
                }
            }
        } else if (currentTable && line.startsWith('|') && line.endsWith('|')) {
            // 数据行
            currentTable.dataLines.push(line);
        } else if (currentTable && (line === '' || !line.startsWith('|'))) {
            // 表格结束
            const tableText = [currentTable.headerLine, currentTable.separatorLine, ...currentTable.dataLines].join('\n');
            const parsed = parseTableText(tableText, tableIndex++);
            if (parsed) tables.push(parsed);
            currentTable = null;
        }
    }
    
    // 处理最后一个表格
    if (currentTable && currentTable.dataLines.length > 0) {
        const tableText = [currentTable.headerLine, currentTable.separatorLine, ...currentTable.dataLines].join('\n');
        const parsed = parseTableText(tableText, tableIndex++);
        if (parsed) tables.push(parsed);
    }
    
    // 去重（基于表头）
    const uniqueTables = [];
    const seenHeaders = new Set();
    tables.forEach(table => {
        const headerKey = table.headers.join('|');
        if (!seenHeaders.has(headerKey)) {
            seenHeaders.add(headerKey);
            uniqueTables.push(table);
        }
    });
    
    return uniqueTables;
}

// 辅助函数：解析表格文本
function parseTableText(tableText, index) {
    const lines = tableText.split('\n').filter(line => {
        const trimmed = line.trim();
        return trimmed.startsWith('|') && trimmed.endsWith('|');
    });
    
    if (lines.length < 2) return null;
    
    // 解析表头（第一行）
    const headers = lines[0].split('|').map(h => h.trim()).filter(h => h && !h.match(/^[\s-:]+$/));
    if (headers.length === 0) return null;
    
    // 跳过分隔行（第二行），解析数据行
    const dataLines = lines.slice(2).filter(line => {
        const trimmed = line.trim();
        return !trimmed.match(/^[\s|:-]+$/);
    });
    
    const rows = dataLines.map(row => {
        const cells = row.split('|').map(c => c.trim()).filter(c => c);
        const obj = {};
        headers.forEach((header, idx) => {
            obj[header] = cells[idx] || '';
        });
        return obj;
    }).filter(row => {
        return Object.values(row).some(val => val && val.trim());
    });
    
    if (rows.length === 0) return null;
    
    return {
        index,
        headers,
        rows,
        rawText: tableText
    };
}

// 辅助函数：规范化紧凑格式表格
function normalizeCompactTable(compactText) {
    // 处理格式：| 列1 | 列2 | |---|---| 或 | 列1 | 列2 | |---------|------|
    const lines = compactText.split('\n');
    const firstLine = lines[0].trim();
    
    // 查找分隔符位置（可能是 | | 或 | |---|）
    const separatorMatch = firstLine.match(/\|\s*\|[\s-|:]+\|/);
    if (separatorMatch) {
        const separatorIndex = separatorMatch.index;
        const headerPart = firstLine.substring(0, separatorIndex + 1);
        const separatorPart = firstLine.substring(separatorIndex + 1);
        
        // 重新组合为标准格式
        return [headerPart, separatorPart, ...lines.slice(1)].join('\n');
    }
    
    // 尝试另一种格式：表头和分隔行在同一行但用空格分隔
    const doublePipeMatch = firstLine.match(/\|\s*[^|]+\|\s*\|\s*[\s-|:]+\|/);
    if (doublePipeMatch) {
        const parts = firstLine.split(/\s*\|\s*\|/).filter(p => p.trim());
        if (parts.length >= 2) {
            const headerPart = '|' + parts[0] + '|';
            const separatorPart = '|' + parts[1] + '|';
            return [headerPart, separatorPart, ...lines.slice(1)].join('\n');
        }
    }
    
    return compactText;
}

// ============================================================================
// 辅助函数：为 ECharts option 添加中文字体配置
// ============================================================================
function addChineseFontToOption(option) {
    const chineseFont = '"Noto Sans SC", "Microsoft YaHei", "SimSun", "SimHei", "Arial Unicode MS", Arial, sans-serif';
    
    // 全局 textStyle
    if (!option.textStyle) {
        option.textStyle = {};
    }
    option.textStyle.fontFamily = chineseFont;
    
    // title textStyle
    if (option.title && option.title.textStyle) {
        option.title.textStyle.fontFamily = chineseFont;
    }
    
    // tooltip textStyle
    if (option.tooltip) {
        if (!option.tooltip.textStyle) {
            option.tooltip.textStyle = {};
        }
        option.tooltip.textStyle.fontFamily = chineseFont;
    }
    
    // legend textStyle
    if (option.legend) {
        if (!option.legend.textStyle) {
            option.legend.textStyle = {};
        }
        option.legend.textStyle.fontFamily = chineseFont;
    }
    
    // xAxis
    if (option.xAxis) {
        const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
        if (xAxis.axisLabel) {
            if (!xAxis.axisLabel.fontFamily) {
                xAxis.axisLabel.fontFamily = chineseFont;
            }
        }
        if (xAxis.nameTextStyle) {
            if (!xAxis.nameTextStyle.fontFamily) {
                xAxis.nameTextStyle.fontFamily = chineseFont;
            }
        }
    }
    
    // yAxis
    if (option.yAxis) {
        const yAxis = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
        if (yAxis.axisLabel) {
            if (!yAxis.axisLabel.fontFamily) {
                yAxis.axisLabel.fontFamily = chineseFont;
            }
        }
        if (yAxis.nameTextStyle) {
            if (!yAxis.nameTextStyle.fontFamily) {
                yAxis.nameTextStyle.fontFamily = chineseFont;
            }
        }
    }
    
    // series label
    if (option.series) {
        option.series.forEach(seriesItem => {
            if (seriesItem.label && seriesItem.label.textStyle) {
                if (!seriesItem.label.textStyle.fontFamily) {
                    seriesItem.label.textStyle.fontFamily = chineseFont;
                }
            }
        });
    }
    
    return option;
}

// ============================================================================
// 从表格生成图表（与前端逻辑完全一致）
// ============================================================================
function generateChartFromTable(table) {
    const { headers, rows } = table;
    if (rows.length === 0) return null;
    
    // 识别数值列
    const numericColumns = headers.filter(header => {
        return rows.some(row => {
            const value = row[header];
            if (!value) return false;
            // 尝试解析数值（去除单位）
            const numStr = String(value).replace(/[^\d.-]/g, '');
            return !isNaN(parseFloat(numStr)) && isFinite(parseFloat(numStr));
        });
    });
    
    if (numericColumns.length === 0) return null;
    
    // 识别分类列（非数值列）
    const categoryColumns = headers.filter(h => !numericColumns.includes(h));
    
    // 根据表格结构选择图表类型
    let chartType = 'bar';
    let chartData = null;
    let chartTitle = '数据可视化';
    
    // 情况1：有分类列 + 多个数值列 -> 分组柱状图
    if (categoryColumns.length > 0 && numericColumns.length > 1) {
        const categoryCol = categoryColumns[0];
        chartTitle = `${categoryCol}对比分析`;
        chartType = 'bar';
        
        const categories = rows.map(row => row[categoryCol]);
        const series = numericColumns.map(col => ({
            name: col,
            data: rows.map(row => {
                const val = row[col];
                const numStr = String(val).replace(/[^\d.-]/g, '');
                return parseFloat(numStr) || 0;
            }),
            type: 'bar'
        }));
        
        chartData = {
            title: chartTitle,
            type: chartType,
            option: addChineseFontToOption({
                title: {
                    text: chartTitle,
                    left: 'left',
                    textStyle: { fontSize: 18, fontWeight: 'bold' }
                },
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                legend: { data: numericColumns, top: 30 },
                grid: { left: '5%', right: '5%', bottom: '10%', top: '15%', containLabel: true },
                xAxis: {
                    type: 'category',
                    data: categories,
                    name: categoryCol,
                    nameLocation: 'middle',
                    nameGap: 30,
                    axisLabel: { rotate: 45 }
                },
                yAxis: {
                    type: 'value',
                    name: '数值',
                    nameLocation: 'middle',
                    nameGap: 50
                },
                series
            })
        };
    }
    // 情况2：有分类列 + 单个数值列 -> 根据数据特点选择图表类型
    else if (categoryColumns.length > 0 && numericColumns.length === 1) {
        const categoryCol = categoryColumns[0];
        const valueCol = numericColumns[0];
        
        const data = rows.map(row => ({
            name: row[categoryCol],
            value: parseFloat(String(row[valueCol]).replace(/[^\d.-]/g, '')) || 0
        })).filter(d => d.value > 0); // 过滤零值
        
        // 根据分类数量和数值特点选择图表类型
        if (data.length <= 5 && data.length > 0) {
            // 分类少 -> 饼图
            chartTitle = `${categoryCol}分布`;
            chartType = 'pie';
            chartData = {
                title: chartTitle,
                type: chartType,
                option: addChineseFontToOption({
                    title: {
                        text: chartTitle,
                        left: 'center',
                        textStyle: { fontSize: 18, fontWeight: 'bold' }
                    },
                    tooltip: { trigger: 'item', formatter: '{a} <br/>{b}: {c} ({d}%)' },
                    legend: { orient: 'vertical', left: 'left' },
                    series: [{
                        name: valueCol,
                        type: 'pie',
                        radius: '50%',
                        data,
                        emphasis: {
                            itemStyle: {
                                shadowBlur: 10,
                                shadowOffsetX: 0,
                                shadowColor: 'rgba(0, 0, 0, 0.5)'
                            }
                        }
                    }]
                })
            };
        } else if (data.length > 5 && data.length <= 15) {
            // 分类中等 -> 柱状图
            chartTitle = `${categoryCol}对比`;
            chartType = 'bar';
            chartData = {
                title: chartTitle,
                type: chartType,
                option: addChineseFontToOption({
                    title: {
                        text: chartTitle,
                        left: 'center',
                        textStyle: { fontSize: 18, fontWeight: 'bold' }
                    },
                    tooltip: { trigger: 'axis' },
                    xAxis: {
                        type: 'category',
                        data: data.map(d => d.name),
                        name: categoryCol,
                        nameLocation: 'middle',
                        nameGap: 30,
                        axisLabel: { rotate: 45, interval: 0 }
                    },
                    yAxis: {
                        type: 'value',
                        name: valueCol,
                        nameLocation: 'middle',
                        nameGap: 50
                    },
                    series: [{
                        name: valueCol,
                        data: data.map(d => d.value),
                        type: 'bar',
                        itemStyle: { color: '#217346' },
                        label: {
                            show: true,
                            position: 'top'
                        }
                    }]
                })
            };
        } else {
            // 分类多 -> 横向柱状图
            chartTitle = `${categoryCol}对比`;
            chartType = 'bar';
            chartData = {
                title: chartTitle,
                type: chartType,
                option: addChineseFontToOption({
                    title: {
                        text: chartTitle,
                        left: 'center',
                        textStyle: { fontSize: 18, fontWeight: 'bold' }
                    },
                    tooltip: { trigger: 'axis' },
                    grid: { left: '20%', right: '10%' },
                    xAxis: {
                        type: 'value',
                        name: valueCol,
                        nameLocation: 'middle',
                        nameGap: 30
                    },
                    yAxis: {
                        type: 'category',
                        data: data.map(d => d.name),
                        name: categoryCol,
                        nameLocation: 'middle',
                        nameGap: 50,
                        axisLabel: { interval: 0 }
                    },
                    series: [{
                        name: valueCol,
                        data: data.map(d => d.value),
                        type: 'bar',
                        itemStyle: { color: '#217346' }
                    }]
                })
            };
        }
    }
    // 情况3：只有数值列 -> 根据数值列数量选择图表类型
    else if (categoryColumns.length === 0 && numericColumns.length > 0) {
        if (numericColumns.length === 1) {
            // 单个数值列 -> 折线图
            const valueCol = numericColumns[0];
            chartTitle = `${valueCol}趋势`;
            chartType = 'line';
            
            const data = rows.map((row, idx) => ({
                name: `项目${idx + 1}`,
                value: parseFloat(String(row[valueCol]).replace(/[^\d.-]/g, '')) || 0
            }));
            
            chartData = {
                title: chartTitle,
                type: chartType,
                option: addChineseFontToOption({
                    title: {
                        text: chartTitle,
                        left: 'center',
                        textStyle: { fontSize: 18, fontWeight: 'bold' }
                    },
                    tooltip: { trigger: 'axis' },
                    xAxis: {
                        type: 'category',
                        data: data.map(d => d.name),
                        name: '序号',
                        nameLocation: 'middle',
                        nameGap: 30
                    },
                    yAxis: {
                        type: 'value',
                        name: valueCol,
                        nameLocation: 'middle',
                        nameGap: 50
                    },
                    series: [{
                        name: valueCol,
                        data: data.map(d => d.value),
                        type: 'line',
                        smooth: true,
                        itemStyle: { color: '#217346' },
                        areaStyle: {
                            color: {
                                type: 'linear',
                                x: 0,
                                y: 0,
                                x2: 0,
                                y2: 1,
                                colorStops: [
                                    { offset: 0, color: 'rgba(33, 115, 70, 0.3)' },
                                    { offset: 1, color: 'rgba(33, 115, 70, 0.1)' }
                                ]
                            }
                        }
                    }]
                })
            };
        } else {
            // 多个数值列 -> 折线图（多条线）
            chartTitle = '多指标趋势对比';
            chartType = 'line';
            
            const categories = rows.map((row, idx) => `项目${idx + 1}`);
            const series = numericColumns.map(col => ({
                name: col,
                data: rows.map(row => {
                    const val = row[col];
                    const numStr = String(val).replace(/[^\d.-]/g, '');
                    return parseFloat(numStr) || 0;
                }),
                type: 'line',
                smooth: true
            }));
            
            chartData = {
                title: chartTitle,
                type: chartType,
                option: addChineseFontToOption({
                    title: {
                        text: chartTitle,
                        left: 'center',
                        textStyle: { fontSize: 18, fontWeight: 'bold' }
                    },
                    tooltip: { trigger: 'axis' },
                    legend: { data: numericColumns, top: 30 },
                    grid: { left: '5%', right: '5%', bottom: '10%', top: '15%', containLabel: true },
                    xAxis: {
                        type: 'category',
                        data: categories,
                        name: '序号',
                        nameLocation: 'middle',
                        nameGap: 30
                    },
                    yAxis: {
                        type: 'value',
                        name: '数值',
                        nameLocation: 'middle',
                        nameGap: 50
                    },
                    series
                })
            };
        }
    }
    
    return chartData;
}

// ============================================================================
// Markdown 转 HTML（改进版，支持表格解析）
// ============================================================================
function markdownToHtml(markdown) {
    if (!markdown) return '';
    
    let html = markdown;
    // 过滤掉"---"分隔符（单独一行的三个或更多短横线）
    html = html.replace(/^---+$/gm, '');
    // 过滤掉连续的空行（超过2个换行符）
    html = html.replace(/\n{3,}/g, '\n\n');
    
    // 改进的表格解析（与前端逻辑一致）
    // 支持多种格式：
    // 1. 标准格式：| 列1 | 列2 |\n|---|---|\n| 值1 | 值2 |
    // 2. 紧凑格式：| 列1 | 列2 | |---|---|
    // 3. 逐行检测
    
    // 方法1：标准格式（表头和分隔行在不同行）
    const standardTableRegex = /(\|[^\n]+\|\s*\n\|[\s-|:]+\|\s*\n(?:\|[^\n]+\|\s*\n?)+)/g;
    html = html.replace(standardTableRegex, (match) => {
        return parseTableToHtml(match);
    });
    
    // 方法2：逐行检测（更宽松的匹配）
    // 注意：如果方法1已经处理了所有表格，这里可能没有需要处理的表格
    // 但为了确保不遗漏，我们仍然进行逐行检测
    const htmlLines = html.split('\n');
    let tableResult = [];
    let currentTable = null;
    let headerLine = null;
    let separatorLine = null;
    
    for (let i = 0; i < htmlLines.length; i++) {
        const line = htmlLines[i];
        const trimmed = line.trim();
        
        // 如果已经是HTML表格标签，直接添加（方法1已处理）
        if (trimmed.startsWith('<table>') || trimmed.startsWith('</table>') || trimmed.startsWith('<tr>') || trimmed.startsWith('</tr>') || trimmed.startsWith('<th>') || trimmed.startsWith('<td>')) {
            tableResult.push(line);
            continue;
        }
        
        // 检测表头行
        if (trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.match(/^[\s|:-]+$/)) {
            // 检查下一行是否是分隔行
            const nextLine = i + 1 < htmlLines.length ? htmlLines[i + 1].trim() : '';
            const isSeparator = nextLine.match(/^[\s|:-]+$/);
            
            if (isSeparator) {
                // 标准格式：表头行 + 分隔行
                headerLine = trimmed;
                separatorLine = nextLine;
                currentTable = {
                    headerLine,
                    separatorLine,
                    dataLines: [],
                    startIndex: i
                };
                i++; // 跳过分隔行
            } else if (currentTable) {
                // 数据行
                currentTable.dataLines.push(trimmed);
            }
        } else if (currentTable && trimmed.startsWith('|') && trimmed.endsWith('|')) {
            // 数据行
            currentTable.dataLines.push(trimmed);
        } else if (currentTable && (trimmed === '' || !trimmed.startsWith('|'))) {
            // 表格结束
            const tableText = [currentTable.headerLine, currentTable.separatorLine, ...currentTable.dataLines].join('\n');
            const tableHtml = parseTableToHtml(tableText);
            tableResult.push(tableHtml);
            tableResult.push(line); // 添加当前行
            currentTable = null;
        } else {
            tableResult.push(line);
        }
    }
    
    // 处理最后一个表格
    if (currentTable && currentTable.dataLines.length > 0) {
        const tableText = [currentTable.headerLine, currentTable.separatorLine, ...currentTable.dataLines].join('\n');
        const tableHtml = parseTableToHtml(tableText);
        tableResult.push(tableHtml);
    }
    
    html = tableResult.join('\n');
    
    // 辅助函数：解析表格文本为 HTML
    function parseTableToHtml(tableText) {
        const lines = tableText.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed.startsWith('|') && trimmed.endsWith('|');
        });
        
        if (lines.length < 2) return tableText; // 如果格式不对，返回原文本
        
        // 解析表头（第一行）
        const headerLine = lines[0];
        const headerCells = headerLine.split('|').map(h => h.trim()).filter(h => h && !h.match(/^[\s-:]+$/));
        if (headerCells.length === 0) return tableText;
        
        let tableHtml = '<table>';
        
        // 表头
        tableHtml += '<tr>';
        headerCells.forEach(cell => {
            tableHtml += `<th>${escapeHtml(cell)}</th>`;
        });
        tableHtml += '</tr>';
        
        // 跳过分隔行（第二行），处理数据行
        for (let i = 2; i < lines.length; i++) {
            const rowLine = lines[i];
            const trimmed = rowLine.trim();
            // 跳过分隔行
            if (trimmed.match(/^[\s|:-]+$/)) continue;
            
            const cells = rowLine.split('|').map(c => c.trim()).filter((c, idx) => {
                // 过滤掉首尾的空元素（split('|') 会在首尾产生空字符串）
                return c && idx > 0 && idx <= headerCells.length;
            });
            
            if (cells.length > 0) {
                tableHtml += '<tr>';
                // 确保单元格数量与表头一致
                for (let j = 0; j < headerCells.length; j++) {
                    tableHtml += `<td>${escapeHtml(cells[j] || '')}</td>`;
                }
                tableHtml += '</tr>';
            }
        }
        
        tableHtml += '</table>';
        return tableHtml;
    }
    
    // 标题（多行模式，从多级到少级处理，避免匹配错误）
    // 注意：必须从多级到少级，否则 ### 会匹配到 #### 的前三个字符
    html = html.replace(/^#### (.*)$/gim, '<h4 class="markdown-h4">$1</h4>');
    html = html.replace(/^### (.*)$/gim, '<h3 class="markdown-h3">$1</h3>');
    html = html.replace(/^## (.*)$/gim, '<h2 class="markdown-h2">$1</h2>');
    html = html.replace(/^# (.*)$/gim, '<h1 class="markdown-h1">$1</h1>');
    
    // 粗体（支持 **text** 和 __text__）
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
    
    // 斜体（支持 *text* 和 _text_，但不在列表项中）
    html = html.replace(/(?<![*_])\*([^*]+?)\*(?![*_])/g, '<em>$1</em>');
    html = html.replace(/(?<!_)_([^_]+?)_(?!_)/g, '<em>$1</em>');
    
    // 无序列表（支持 -、*、+，允许或不带空格）
    html = html.replace(/^[\-\*\+]\s+(.+)$/gim, '<li>$1</li>');
    html = html.replace(/^[\-\*\+](.+)$/gim, '<li>$1</li>');
    // 将连续的<li>包装在<ul>中
    html = html.replace(/(<li>.*?<\/li>\n?)+/g, (match) => {
        // 检查是否已经被包装
        if (match.includes('<ul>') || match.includes('<ol>')) {
            return match;
        }
        return '<ul>' + match + '</ul>';
    });
    
    // 有序列表（支持 1.、2. 等格式）
    html = html.replace(/^\d+\.\s+(.+)$/gim, '<li>$1</li>');
    html = html.replace(/^\d+\.(.+)$/gim, '<li>$1</li>');
    // 将连续的<li>包装在<ol>中（如果还没有被<ul>包装）
    html = html.replace(/(?<!<ul>)(?<!<ol>)(<li>.*?<\/li>\n?)+(?!<\/ul>)(?!<\/ol>)/g, (match) => {
        if (!match.includes('<ul>') && !match.includes('<ol>')) {
            return '<ol>' + match + '</ol>';
        }
        return match;
    });
    
    // 段落处理：将连续的文本行（非HTML标签）包装成段落
    const paragraphLines = html.split('\n');
    let paragraphResult = [];
    let currentParagraph = [];
    
    for (let i = 0; i < paragraphLines.length; i++) {
        const line = paragraphLines[i].trim();
        
        // 跳过空行
        if (!line) {
            if (currentParagraph.length > 0) {
                paragraphResult.push('<p>' + currentParagraph.join(' ') + '</p>');
                currentParagraph = [];
            }
            continue;
        }
        
        // 如果已经是HTML标签，直接添加
        if (line.startsWith('<') && (line.startsWith('<h') || line.startsWith('<p') || 
            line.startsWith('<ul') || line.startsWith('<ol') || line.startsWith('<li') ||
            line.startsWith('<table') || line.startsWith('<tr') || line.startsWith('<td') ||
            line.startsWith('<th') || line.startsWith('</') || line.startsWith('<strong') ||
            line.startsWith('<em') || line.startsWith('</strong') || line.startsWith('</em'))) {
            if (currentParagraph.length > 0) {
                paragraphResult.push('<p>' + currentParagraph.join(' ') + '</p>');
                currentParagraph = [];
            }
            paragraphResult.push(line);
        } else if (line.match(/^[#\-\*\+0-9]/)) {
            // 如果行首是markdown语法字符但未被转换，说明可能是未处理的markdown
            // 尝试再次处理（可能是表格处理后的残留）
            if (line.trim().match(/^####\s+/)) {
                const text = line.trim().replace(/^####\s+/, '');
                paragraphResult.push('<h4 class="markdown-h4">' + escapeHtml(text) + '</h4>');
            } else if (line.trim().match(/^###\s+/)) {
                const text = line.trim().replace(/^###\s+/, '');
                paragraphResult.push('<h3 class="markdown-h3">' + escapeHtml(text) + '</h3>');
            } else if (line.trim().match(/^##\s+/)) {
                const text = line.trim().replace(/^##\s+/, '');
                paragraphResult.push('<h2 class="markdown-h2">' + escapeHtml(text) + '</h2>');
            } else if (line.trim().match(/^#\s+/)) {
                const text = line.trim().replace(/^#\s+/, '');
                paragraphResult.push('<h1 class="markdown-h1">' + escapeHtml(text) + '</h1>');
            } else {
                // 其他未处理的markdown，作为普通文本处理
                currentParagraph.push(line);
            }
        } else {
            // 普通文本，收集到当前段落
            currentParagraph.push(line);
        }
    }
    
    // 处理剩余的段落
    if (currentParagraph.length > 0) {
        paragraphResult.push('<p>' + currentParagraph.join(' ') + '</p>');
    }
    
    html = paragraphResult.join('\n');
    
    return html;
}

// ============================================================================
// 执行主函数
// ============================================================================
main().catch(error => {
    const errorResult = JSON.stringify({ 
        success: false, 
        error: error.message || String(error),
        stack: error.stack 
    });
    console.error(error.stack); // 调试信息
    console.log(errorResult); // JSON结果输出到stdout
    process.exit(1);
});
