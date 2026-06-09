import { describe, it, expect } from 'vitest'
import { formatInUserTimezone } from '../dateFormat'

describe('dateFormat timezone behavior', () => {
  it('treats ISO without timezone suffix as UTC', () => {
    const naiveIso = '2026-02-27T03:59:11'
    const formatted = formatInUserTimezone(naiveIso, 'Asia/Shanghai')
    expect(formatted).toContain('11:59:11')
  })

  it('converts UTC to configured timezone', () => {
    const utcIso = '2026-02-27T03:59:11Z'
    const formatted = formatInUserTimezone(utcIso, 'America/New_York')
    expect(formatted).toContain('22:59:11')
  })
})
