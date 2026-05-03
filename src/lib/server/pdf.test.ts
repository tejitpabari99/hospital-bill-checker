import { describe, expect, it } from 'vitest'
import { sanitizeVisionCodes, sanitizeVisionLineItems, sanitizeVisionMeta } from './pdf'

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
      { code: '99285', description: '', units: 2, quantity: 2, amount: 100, modifiers: [], serviceDate: undefined, icd10Codes: [] },
      { code: '70486', description: 'CT scan', units: 1, quantity: 1, amount: 0, modifiers: [], serviceDate: undefined, icd10Codes: [] },
    ])
  })
})

describe('vision extraction modifier handling', () => {
  it('sanitizes quantity, modifiers, and diagnosis fields from vision line items', () => {
    expect(sanitizeVisionLineItems([
      {
        code: '99285',
        description: 'ER visit',
        units: 2,
        quantity: 3,
        amount: 800,
        modifiers: [' 25 ', 'LT', null, ''],
        serviceDate: ' 2026-03-28 ',
        icd10Codes: [' R07.9 ', ''],
      },
    ])).toEqual([
      {
        code: '99285',
        description: 'ER visit',
        units: 2,
        quantity: 3,
        amount: 800,
        modifiers: ['25', 'LT'],
        serviceDate: '2026-03-28',
        icd10Codes: ['R07.9'],
      },
    ])
  })

  it('sanitizes patient state, service ZIP, and DRG metadata from vision output', () => {
    expect(sanitizeVisionMeta({
      patientState: ' tx ',
      serviceZip: '78701-1234',
      drgCode: 'MS-DRG 470',
    })).toEqual({
      patientState: 'TX',
      serviceZip: '78701',
      drgCode: '470',
    })

    expect(sanitizeVisionMeta({
      patientState: 'Texas',
      serviceZip: 'abc',
      drgCode: null,
    })).toEqual({
      patientState: undefined,
      serviceZip: undefined,
      drgCode: undefined,
    })
  })
})
