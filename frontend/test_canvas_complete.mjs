import { chromium } from '@playwright/test';

async function testApplication() {
  console.log('=== SheetBot Canvas 完整测试 ===\n');
  
  const browser = await chromium.launch({ 
    headless: false,
    slowMo: 600
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  
  try {
    // 1. 访问网站
    console.log('[1/12] 访问 http://1.95.195.88/');
    await page.goto('http://1.95.195.88/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'complete-1-landing.png', fullPage: true });
    console.log('       ✓ 截图已保存\n');
    
    // 2. 点击登录
    console.log('[2/12] 点击登录按钮');
    await page.locator('button:has-text("登录")').first().click();
    await page.waitForTimeout(2000);
    console.log('       ✓ 登录表单已显示\n');
    
    // 3. 填写登录信息
    console.log('[3/12] 填写登录信息 (demo / demo@0320HI)');
    await page.locator('input[name="username"][placeholder*="邮箱"]').fill('demo');
    await page.locator('input[name="password"]').first().fill('demo@0320HI');
    console.log('       ✓ 登录信息已填写\n');
    
    // 4. 提交登录
    console.log('[4/12] 提交登录');
    await page.locator('button[type="submit"]:has-text("登录")').click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'complete-2-after-login.png', fullPage: true });
    console.log('       ✓ 登录成功\n');
    
    // 5. 跳过所有引导步骤
    console.log('[5/12] 跳过引导对话框...');
    let guidanceSteps = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const nextButton = page.locator('button:has-text("下一步")').first();
        const skipButton = page.locator('button:has-text("跳过")').first();
        const closeButton = page.locator('button:has-text("知道了")').first();
        
        if (await nextButton.isVisible({ timeout: 1000 })) {
          await nextButton.click();
          guidanceSteps++;
          console.log(`       - 点击第 ${guidanceSteps} 个"下一步"`);
          await page.waitForTimeout(800);
        } else if (await skipButton.isVisible({ timeout: 500 })) {
          await skipButton.click();
          console.log('       - 点击"跳过"');
          await page.waitForTimeout(800);
          break;
        } else if (await closeButton.isVisible({ timeout: 500 })) {
          await closeButton.click();
          console.log('       - 点击"知道了"');
          await page.waitForTimeout(800);
          break;
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }
    console.log(`       ✓ 已跳过 ${guidanceSteps} 个引导步骤\n`);
    
    await page.screenshot({ path: 'complete-3-guidance-skipped.png', fullPage: true });
    
    // 6. 点击"新建"按钮
    console.log('[6/12] 点击"新建"按钮');
    await page.waitForTimeout(1000);
    await page.locator('button:has-text("新建")').first().click({ force: true });
    await page.waitForTimeout(4000); // 等待 Excel 编辑器加载
    await page.screenshot({ path: 'complete-4-excel-loaded.png', fullPage: true });
    console.log('       ✓ Excel 编辑器已加载\n');
    
    // 7. 检查 canvas 元素
    console.log('[7/11] 检查 canvas.scroll-canvas 元素');
    const canvasCheck = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.scroll-canvas');
      if (!canvas) return { exists: false };
      
      const rect = canvas.getBoundingClientRect();
      return {
        exists: true,
        className: canvas.className,
        width: canvas.width,
        height: canvas.height,
        offsetWidth: canvas.offsetWidth,
        offsetHeight: canvas.offsetHeight,
        style: canvas.style.cssText,
        visible: canvas.offsetParent !== null,
        rect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height
        }
      };
    });
    
    if (canvasCheck.exists) {
      console.log('       ✓ Canvas 元素存在!');
      console.log(`         - 类名: ${canvasCheck.className}`);
      console.log(`         - Canvas 尺寸: ${canvasCheck.width} x ${canvasCheck.height}`);
      console.log(`         - 显示尺寸: ${canvasCheck.offsetWidth} x ${canvasCheck.offsetHeight}`);
      console.log(`         - 位置: top=${canvasCheck.rect.top}, left=${canvasCheck.rect.left}`);
      console.log(`         - 可见: ${canvasCheck.visible ? '是' : '否'}`);
    } else {
      console.log('       ✗ Canvas 元素不存在');
    }
    console.log('');
    
    // 8. 检查 Excel 容器
    console.log('[8/11] 检查 .excel-container 元素');
    const containerCheck = await page.evaluate(() => {
      const container = document.querySelector('.excel-container');
      if (!container) return { exists: false };
      
      return {
        exists: true,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        offsetWidth: container.offsetWidth,
        offsetHeight: container.offsetHeight
      };
    });
    
    if (containerCheck.exists) {
      console.log('       ✓ Excel 容器存在!');
      console.log(`         - 容器尺寸: ${containerCheck.offsetWidth} x ${containerCheck.offsetHeight}`);
      console.log(`         - 可滚动高度: ${containerCheck.scrollHeight}px`);
      console.log(`         - 可视高度: ${containerCheck.clientHeight}px`);
      console.log(`         - 当前滚动位置: ${containerCheck.scrollTop}px`);
    } else {
      console.log('       ✗ Excel 容器不存在');
    }
    console.log('');
    
    // 9. 滚动测试
    console.log('[9/11] 滚动测试 (向下滚动 2000px)');
    const scrollResult = await page.evaluate(() => {
      const container = document.querySelector('.excel-container');
      if (!container) return { success: false, message: 'Container not found' };
      
      const beforeScroll = container.scrollTop;
      container.scrollTop = 2000;
      
      return new Promise(resolve => {
        setTimeout(() => {
          const afterScroll = container.scrollTop;
          resolve({
            success: true,
            beforeScroll,
            afterScroll,
            scrolled: afterScroll - beforeScroll
          });
        }, 500);
      });
    });
    
    if (scrollResult.success) {
      console.log('        ✓ 滚动成功!');
      console.log(`          - 滚动前: ${scrollResult.beforeScroll}px`);
      console.log(`          - 滚动后: ${scrollResult.afterScroll}px`);
      console.log(`          - 实际滚动: ${scrollResult.scrolled}px`);
    } else {
      console.log(`        ✗ 滚动失败: ${scrollResult.message}`);
    }
    
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'complete-5-after-scroll.png', fullPage: true });
    console.log('        ✓ 滚动后截图已保存\n');
    
    // 10. 综合诊断
    console.log('[10/11] 综合诊断');
    const fullDiagnostics = await page.evaluate(() => {
      const results = {
        allCanvases: [],
        excelRelatedElements: [],
        documentInfo: {
          title: document.title,
          url: document.URL,
          readyState: document.readyState
        }
      };
      
      // 所有 canvas 元素
      document.querySelectorAll('canvas').forEach((canvas, index) => {
        const rect = canvas.getBoundingClientRect();
        results.allCanvases.push({
          index,
          className: canvas.className,
          id: canvas.id || '(无)',
          visible: canvas.offsetParent !== null,
          dimensions: `${canvas.width}x${canvas.height}`,
          position: `top=${Math.round(rect.top)}, left=${Math.round(rect.left)}`
        });
      });
      
      // Excel 相关元素
      const selectors = [
        '.excel-container',
        '.workbook-container',
        '.spreadsheet-view',
        'canvas.scroll-canvas',
        '[class*="excel"]'
      ];
      
      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          results.excelRelatedElements.push({
            selector,
            count: elements.length,
            firstElementVisible: elements[0].offsetParent !== null
          });
        }
      });
      
      return results;
    });
    
    console.log('        文档信息:');
    console.log(`          - 标题: ${fullDiagnostics.documentInfo.title}`);
    console.log(`          - URL: ${fullDiagnostics.documentInfo.url}`);
    
    console.log('\n        所有 Canvas 元素:');
    if (fullDiagnostics.allCanvases.length === 0) {
      console.log('          (无)');
    } else {
      fullDiagnostics.allCanvases.forEach(canvas => {
        console.log(`          - Canvas #${canvas.index}:`);
        console.log(`            类名: ${canvas.className || '(无类名)'}`);
        console.log(`            尺寸: ${canvas.dimensions}`);
        console.log(`            位置: ${canvas.position}`);
        console.log(`            可见: ${canvas.visible}`);
      });
    }
    
    console.log('\n        Excel 相关元素:');
    if (fullDiagnostics.excelRelatedElements.length === 0) {
      console.log('          (无)');
    } else {
      fullDiagnostics.excelRelatedElements.forEach(el => {
        console.log(`          - ${el.selector}: 数量=${el.count}, 可见=${el.firstElementVisible}`);
      });
    }
    
    // 11. 测试总结
    console.log('\n[11/11] === 测试总结 ===\n');
    
    const issues = [];
    
    if (!canvasCheck.exists) {
      issues.push('❌ canvas.scroll-canvas 元素不存在');
      console.log('✗ Canvas 元素: 不存在');
    } else if (!canvasCheck.visible) {
      issues.push('⚠️  canvas.scroll-canvas 存在但不可见');
      console.log('⚠️  Canvas 元素: 存在但不可见');
    } else {
      console.log('✓ Canvas 元素: 存在且可见');
    }
    
    if (!containerCheck.exists) {
      issues.push('❌ .excel-container 元素不存在');
      console.log('✗ Excel 容器: 不存在');
    } else {
      console.log('✓ Excel 容器: 存在');
    }
    
    if (scrollResult.success) {
      console.log('✓ 滚动功能: 正常');
    } else {
      issues.push('❌ 滚动功能不可用');
      console.log('✗ 滚动功能: 不可用');
    }
    
    if (issues.length > 0) {
      console.log('\n发现的问题:');
      issues.forEach(issue => console.log(`  ${issue}`));
    } else {
      console.log('\n✓ 所有功能正常!');
    }
    
    console.log('\n所有截图已保存到 frontend 目录:');
    console.log('  - complete-1-landing.png');
    console.log('  - complete-2-after-login.png');
    console.log('  - complete-3-guidance-skipped.png');
    console.log('  - complete-4-excel-loaded.png');
    console.log('  - complete-5-after-scroll.png');
    
    console.log('\n浏览器将保持打开 30 秒供检查...');
    await page.waitForTimeout(30000);
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    await page.screenshot({ path: 'complete-error.png', fullPage: true });
  } finally {
    await browser.close();
    console.log('\n测试结束');
  }
}

testApplication().catch(console.error);
