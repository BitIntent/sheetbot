import { defineConfig } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 若存在 .env.test 则加载，便于直接配置 PW_LOGIN_* 等（不覆盖已有 process.env）
const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '.env.test')
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
  })
}

const baseURL = process.env.PW_BASE_URL || 'http://1.95.195.88'
const browserChannel = process.env.PW_BROWSER_CHANNEL || 'chrome'

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  retries: 1,
  workers: 1,
  timeout: 120 * 1000,

  // 三种 reporter：控制台列表 + HTML 报告 + JSON（供 CI 集成）
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/report.json' }]
  ],

  use: {
    baseURL,
    channel: browserChannel,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1600, height: 900 }
  },

  // 三套执行 project，分别对应冒烟 / 回归 / 全量
  projects: [
    {
      name: 'smoke',
      testMatch: '**/smoke/**/*.spec.ts'
    },
    {
      name: 'regression',
      testMatch: [
        '**/regression/**/*.spec.ts',
        '**/analyze/**/*.spec.ts'
      ]
    },
    {
      name: 'full',
      testMatch: '**/*.spec.ts'
    }
  ]
})
