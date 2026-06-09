import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'http://1.95.195.88';
const USERNAME = 'yorko';
const PASSWORD = '980405@net';
const OUTPUT_DIR = path.join('..', 'docs-site', 'static', 'manual', 'zh', 'img');

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function captureScreenshots() {
  console.log('启动浏览器...');
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  
  const page = await context.newPage();

  try {
    // 1. 访问登录页 - 增加超时到 60 秒
    console.log('访问登录页面...');
    await page.goto(`${BASE_URL}/`, { 
      waitUntil: 'domcontentloaded',  // 降低等待要求
      timeout: 60000 
    });
    await page.waitForTimeout(3000);
    
    // 截图登录页
    console.log('截图: 登录页 login-page.png');
    await page.screenshot({ 
      path: path.join(OUTPUT_DIR, 'login-page.png'),
      fullPage: false
    });
    console.log('  ✓ 登录页截图完成');
    
    // 2. 登录
    console.log('执行登录...');
    
    // 查找用户名输入框 - 使用更宽松的定位
    try {
      const inputs = await page.locator('input').all();
      console.log(`  找到 ${inputs.length} 个输入框`);
      
      if (inputs.length >= 2) {
        await inputs[0].fill(USERNAME);
        await inputs[1].fill(PASSWORD);
        console.log('  - 填写用户名和密码');
        
        // 查找登录按钮
        const buttons = await page.locator('button').all();
        for (const btn of buttons) {
          const text = await btn.textContent().catch(() => '');
          if (text.includes('登录') || text.includes('Login')) {
            await btn.click();
            console.log('  - 点击登录按钮');
            break;
          }
        }
      }
    } catch (e) {
      console.log('  ! 登录表单查找失败:', e.message);
    }
    
    // 等待登录完成
    await page.waitForTimeout(8000);
    
    // 3. 截图主界面
    console.log('截图: 主界面 main-dashboard.png');
    await page.screenshot({ 
      path: path.join(OUTPUT_DIR, 'main-dashboard.png'),
      fullPage: false
    });
    console.log('  ✓ 主界面截图完成');

    // 4. 截图侧边栏 (左侧部分)
    console.log('截图: 侧边栏导航 sidebar-nav.png');
    await page.screenshot({ 
      path: path.join(OUTPUT_DIR, 'sidebar-nav.png'),
      clip: { x: 0, y: 0, width: 300, height: 900 }
    });
    console.log('  ✓ 侧边栏截图完成');

    // 5. 尝试点击各个视图并截图
    const views = [
      { name: '普通视图', filename: 'normal-view.png' },
      { name: '我要分析', filename: 'analyze-view.png' },
      { name: '我要汇报', filename: 'presentation-view.png' },
      { name: '我要报表', filename: 'report-view.png' },
      { name: '我要收集', filename: 'collect-view.png' },
      { name: '我要连接', filename: 'connect-view.png' },
      { name: '批量转Word', filename: 'batch-word-view.png' },
      { name: '玩数据Skill', filename: 'skill-view.png' }
    ];

    for (const view of views) {
      try {
        const link = await page.locator(`text=${view.name}`).first();
        if (await link.isVisible().catch(() => false)) {
          await link.click();
          await page.waitForTimeout(3000);
          
          await page.screenshot({ 
            path: path.join(OUTPUT_DIR, view.filename),
            fullPage: false
          });
          console.log(`  ✓ ${view.name} 截图完成`);
        }
      } catch (e) {
        console.log(`  ! ${view.name} 截图失败: ${e.message}`);
      }
    }

    console.log('\n所有截图完成! 图片保存在: ' + OUTPUT_DIR);
    
    // 列出所有截图文件
    const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.png'));
    console.log('\n生成的截图文件:');
    files.forEach(f => console.log('  - ' + f));
    
  } catch (error) {
    console.error('截图过程中出错:', error.message);
    // 出错时也保存当前页面状态
    try {
      await page.screenshot({ 
        path: path.join(OUTPUT_DIR, 'error-debug.png'),
        fullPage: true
      });
      console.log('已保存调试截图到 error-debug.png');
    } catch (e) {
      console.log('无法保存调试截图:', e.message);
    }
  } finally {
    await browser.close();
    console.log('浏览器已关闭');
  }
}

// 执行截图
captureScreenshots();
