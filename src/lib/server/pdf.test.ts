import { describe, expect, it } from 'vitest'
import { sanitizeVisionCodes, sanitizeVisionLineItems } from './pdf'

describe('pdf sanitizer', () => {
  it('drops malformed vision codes without throwing', () => {
    expect(sanitizeVisionCodes(['070486', null, '99285', 123, ' J0696 '])).toEqual([
      '70486',
      '99285',
      'J0696',
    ])
  })

  it('drops malformed line items and normalizes nullable fields', () => {
    expect(sanitizeVisionLineItems([
      { code: null, description: null, units: null, amount: null },
      { code: '99285', description: null, units: 2, amount: 100 },
      { code: '070486', description: '  CT scan  ', units: 'x', amount: undefined },
      { code: 'not-a-code', description: 'ignored', units: 1, amount: 1 },
      null,
    ])).toEqual([
      { code: '99285', description: '', units: 2, amount: 100 },
      { code: '70486', description: 'CT scan', units: 1, amount: 0 },
    ])
  })
})
