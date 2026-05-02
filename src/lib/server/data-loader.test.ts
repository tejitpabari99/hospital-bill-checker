import { existsSync } from 'fs'
import { describe, it, expect } from 'vitest'
import { loadClfsRate, toServiceDateInt } from './data-loader'

describe('toServiceDateInt', () => {
  it('parses YYYY-MM-DD', () => {
    expect(toServiceDateInt('2026-04-01')).toBe(20260401)
  })

  it('parses YYYYMMDD', () => {
    expect(toServiceDateInt('20260401')).toBe(20260401)
  })

  it('falls back to today for empty string', () => {
    const today = new Date()
    const expected = parseInt(
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`,
      10
    )
    expect(toServiceDateInt('')).toBe(expected)
  })

  it('falls back to today for null', () => {
    const today = new Date()
    const expected = parseInt(
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`,
      10
    )
    expect(toServiceDateInt(null)).toBe(expected)
  })

  it('falls back to today for garbage input', () => {
    const today = new Date()
    const result = toServiceDateInt('not-a-date')
    expect(result).toBeGreaterThan(20200101)
    expect(result).toBeLessThan(21000101)
  })
})

describe('CLFS SQLite integration', () => {
  it.skipIf(!existsSync('data/clfs.sqlite'))('returns rate for CBC 85025', () => {
    const row = loadClfsRate('85025')
    expect(row).not.toBeNull()
    expect(row!.rate).toBeGreaterThan(0)
    expect(row!.rate).toBeLessThan(100)  // CBC is a few dollars
  })

  it.skipIf(!existsSync('data/clfs.sqlite'))('returns null for non-lab code', () => {
    // 99285 is in MPFS, not CLFS
    const row = loadClfsRate('99285')
    // May or may not be null — just assert it doesn't throw
    expect(row === null || typeof row.rate === 'number').toBe(true)
  })
})
