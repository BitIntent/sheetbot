import { chromium } from 'playwright'

async function inspectButton() {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()
  
  try {
    console.log('1. 访问网站...')
    await page.goto('http://1.95.195.88/', { waitUntil: 'networkidle', timeout: 30000 })
    
    console.log('2. 检查是否需要登录...')
    const usernameInput = page.locator('input[type="text"], input[name="username"]').first()
    if (await usernameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('   发现登录表单,进行登录...')
      await usernameInput.fill('admin')
      await page.locator('input[type="password"], input[name="password"]').first().fill('admin123')
      await page.locator('button[type="submit"]').first().click()
      await page.waitForLoadState('networkidle', { timeout: 10000 })
      console.log('   登录完成')
    } else {
      console.log('   无需登录或已登录')
    }
    
    console.log('3. 查找"我要收集"标签...')
    await page.waitForTimeout(2000)
    const collectTab = page.getByText('我要收集', { exact: false }).first()
    await collectTab.waitFor({ state: 'visible', timeout: 10000 })
    console.log('   找到"我要收集"标签,点击...')
    await collectTab.click()
    await page.waitForTimeout(3000)
    
    console.log('4. 保存初始截图...')
    await page.screenshot({ path: 'collect-page.png', fullPage: true })
    console.log('   已保存: collect-page.png')
    
    console.log('5. 查找所有按钮...')
    const allButtons = await page.locator('button').all()
    console.log(`   页面共有 ${allButtons.length} 个按钮`)
    
    console.log('\n6. 列出前20个可见按钮:')
    for (let i = 0; i < Math.min(allButtons.length, 20); i++) {
      const btn = allButtons[i]
      if (await btn.isVisible().catch(() => false)) {
        const text = await btn.textContent().catch(() => '')
        const classes = await btn.getAttribute('class').catch(() => '')
        const style = await btn.getAttribute('style').catch(() => '')
        console.log(`   ${i + 1}. 文本="${text?.trim()}"`)
        console.log(`      class="${classes}"`)
        if (style) console.log(`      style="${style}"`)
      }
    }
    
    console.log('\n7. 查找绿色/圆角按钮...')
    const greenButtons = await page.locator('button').evaluateAll(buttons => {
      return buttons.map((btn, idx) => {
        const computed = window.getComputedStyle(btn)
        const bgColor = computed.backgroundColor
        const borderRadius = computed.borderRadius
        const isGreen = bgColor.includes('33') || bgColor.includes('115') || bgColor.includes('70') // RGB for green
        const isRounded = parseFloat(borderRadius) > 5
        return {
          index: idx,
          text: btn.textContent?.trim(),
          className: btn.className,
          backgroundColor: bgColor,
          borderRadius: borderRadius,
          isGreen,
          isRounded
        }
      }).filter(info => info.isGreen && info.isRounded)
    })
    
    console.log(`   找到 ${greenButtons.length} 个绿色圆角按钮:`)
    greenButtons.forEach((btn, i) => {
      console.log(`   ${i + 1}. 文本="${btn.text}"`)
      console.log(`      class="${btn.className}"`)
      console.log(`      背景色=${btn.backgroundColor}`)
      console.log(`      圆角=${btn.borderRadius}`)
    })
    
    console.log('\n8. 查找包含"..."的元素...')
    const threeDotsElements = await page.locator('*').filter({ hasText: '...' }).all()
    console.log(`   找到 ${threeDotsElements.length} 个包含"..."的元素`)
    
    for (let i = 0; i < Math.min(threeDotsElements.length, 10); i++) {
      const el = threeDotsElements[i]
      const tagName = await el.evaluate(e => e.tagName)
      const text = await el.textContent().catch(() => '')
      const classes = await el.getAttribute('class').catch(() => '')
      console.log(`   ${i + 1}. <${tagName}> 文本="${text?.trim()}" class="${classes}"`)
    }
    
    console.log('\n9. 等待30秒供手动检查...')
    await page.waitForTimeout(30000)
    
  } catch (error) {
    console.error('错误:', error.message)
  } finally {
    await browser.close()
  }
}

inspectButton()
