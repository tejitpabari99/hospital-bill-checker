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
      { code: '99285', description: '', units: 2, quantity: 2, amount: 100, modifiers: [], serviceDate: undefined, icd10Codes: [] },
      { code: '70486', description: 'CT scan', units: 1, quantity: 1, amount: 0, modifiers: [], serviceDate: undefined, icd10Codes: [] },
    ])
  })
})

describe('vision extraction modifier handling', () => {
  it('preserves modifiers array from extracted data', () => {
    const mockExtracted = {
      lineItems: [
        { code: '99285', description: 'ER visit', units: 1, quantity: 1, amount: 800, modifiers: ['25', 'LT'] },
        { code: '70450', description: 'CT head', units: 1, quantity: 1, amount: 1200, modifiers: [] },
      ],
      patientState: 'TX',
      serviceZip: '78701',
    }

    const modifiers = mockExtracted.lineItems[0].modifiers
    expect(modifiers).toContain('25')
    expect(modifiers).toContain('LT')
    expect(mockExtracted.lineItems[1].modifiers).toHaveLength(0)
    expect(mockExtracted.patientState).toBe('TX')
    expect(mockExtracted.serviceZip).toBe('78701')
  })

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
})
