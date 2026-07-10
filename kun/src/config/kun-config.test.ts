import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandHomePath, RuntimeTuningConfigSchema } from './kun-config.js'

describe('RuntimeTuningConfigSchema streamIdleTimeoutMs', () => {
  it('accepts a custom timeout, including 0 to disable the guard', () => {
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: 300_000 }).success).toBe(true)
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: 0 }).success).toBe(true)
  })

  it('rejects negative or fractional timeouts', () => {
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: -1 }).success).toBe(false)
    expect(RuntimeTuningConfigSchema.safeParse({ streamIdleTimeoutMs: 1.5 }).success).toBe(false)
  })
})

describe('RuntimeTuningConfigSchema turn admission', () => {
  it('accepts a bounded positive global turn concurrency cap', () => {
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 4 }
    }).success).toBe(true)
  })

  it('rejects zero, fractions, and excessive global turn caps', () => {
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 0 }
    }).success).toBe(false)
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 1.5 }
    }).success).toBe(false)
    expect(RuntimeTuningConfigSchema.safeParse({
      turnLimits: { maxConcurrentTurns: 257 }
    }).success).toBe(false)
  })
})

describe('expandHomePath', () => {
  it('expands Windows-style home-relative paths', () => {
    expect(expandHomePath('~\\kun\\config.json')).toBe(join(homedir(), 'kun', 'config.json'))
  })

  it('leaves non-home tilde prefixes untouched', () => {
    expect(expandHomePath('~other/config.json')).toBe('~other/config.json')
  })
})
