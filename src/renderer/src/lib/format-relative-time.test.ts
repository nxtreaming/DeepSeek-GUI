import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime } from './format-relative-time'

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('omits the trailing Chinese past suffix for recent relative times', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-19T12:00:00.000Z'))

    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'zh-CN')).toBe('10分钟')
    expect(formatRelativeTime('2026-06-19T02:00:00.000Z', 'zh-CN')).toBe('10小时')
    expect(formatRelativeTime('2026-06-14T12:00:00.000Z', 'zh-CN')).toBe('5天')
  })

  it('omits past direction words from other locales too', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-19T12:00:00.000Z'))

    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'en-US')).toBe('10 minutes')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'ja-JP')).toBe('10 分')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'ko-KR')).toBe('10분')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'fr-FR')).toBe('10 minutes')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'de-DE')).toBe('10 Minuten')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'es-ES')).toBe('10 minutos')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'ru-RU')).toBe('10 минут')
    expect(formatRelativeTime('2026-06-19T11:50:00.000Z', 'ar-SA')).toBe('١٠ دقائق')
  })

  it('keeps future relative time unchanged', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-19T12:00:00.000Z'))

    expect(formatRelativeTime('2026-06-19T12:10:00.000Z', 'zh-CN')).toBe('10分钟后')
    expect(formatRelativeTime('2026-06-19T12:10:00.000Z', 'en-US')).toBe('in 10 minutes')
  })
})
