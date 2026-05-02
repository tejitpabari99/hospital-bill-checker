import { describe, it, expect } from 'vitest'
import { toServiceDateInt } from './data-loader'

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
