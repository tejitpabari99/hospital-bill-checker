import { describe, expect, it, vi } from 'vitest'

const auditBill = vi.fn(async (_input: unknown, _traceId?: string) => ({
  findings: [],
  disputeLetter: { text: 'ok', placeholders: [] },
  summary: {
    totalBilled: 125,
    potentialOvercharge: 0,
    errorCount: 0,
    warningCount: 0,
    cleanCount: 1,
  },
  extractedMeta: {},
}))

vi.mock('$lib/server/claude', () => ({ auditBill }))
vi.mock('$lib/server/stats', () => ({ incrementStats: vi.fn(async () => undefined) }))
vi.mock('$lib/server/logger.js', () => ({
  createServerLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  serializeError: (err: unknown) => err,
}))

function makeRequest(payload: unknown): Request {
  return new Request('http://localhost/api/audit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
  })
}

describe('POST /api/audit validation', () => {
  it('accepts and normalizes a valid payload before auditing', async () => {
    const { POST } = await import('./+server')

    const response = await POST({
      request: makeRequest({
        hospitalName: '  Test Hospital  ',
        hospitalAddress: '  123 Main St\nBoston, MA 02115 ',
        hospitalPhone: '(617) 555-1212',
        patientState: 'ma',
        serviceZip: '02115',
        serviceDate: '2026-04-01',
        billType: 'outpatient',
        billTotal: 125,
        goodFaithEstimate: 100,
        lineItems: [
          {
            cpt: ' a0428 ',
            description: ' Ambulance transport ',
            billedAmount: 125,
            units: 1,
            modifiers: ['-rh'],
            icd10Codes: ['r07.9'],
          },
        ],
      }),
    } as any)

    expect(response.status).toBe(200)
    expect(auditBill).toHaveBeenCalledTimes(1)
    const [input] = auditBill.mock.calls[0]!
    expect(input).toMatchObject({
      hospitalName: 'Test Hospital',
      hospitalAddress: '123 Main St Boston, MA 02115',
      hospitalPhone: '(617) 555-1212',
      patientState: 'MA',
      serviceZip: '02115',
      dateOfService: '2026-04-01',
      billType: 'outpatient',
      lineItems: [
        {
          cpt: 'A0428',
          description: 'Ambulance transport',
          billedAmount: 125,
          units: 1,
          modifiers: ['RH'],
          icd10Codes: ['R07.9'],
        },
      ],
    })
  })

  it('rejects oversized hospital fields without auditing', async () => {
    const { POST } = await import('./+server')
    auditBill.mockClear()

    await expect(
      POST({
        request: makeRequest({
          hospitalName: 'x'.repeat(161),
          lineItems: [{ cpt: '99285', description: 'ER visit', billedAmount: 125 }],
        }),
      } as any),
    ).rejects.toMatchObject({ status: 400 })

    expect(auditBill).not.toHaveBeenCalled()
  })

  it('rejects invalid and oversized line item fields without auditing', async () => {
    const { POST } = await import('./+server')
    auditBill.mockClear()

    await expect(
      POST({
        request: makeRequest({
          lineItems: [
            {
              cpt: 'DROP TABLE',
              description: 'x'.repeat(501),
              billedAmount: Number.POSITIVE_INFINITY,
              modifiers: ['25', '59', 'LT', 'RT', 'XX'],
            },
          ],
        }),
      } as any),
    ).rejects.toMatchObject({ status: 400 })

    expect(auditBill).not.toHaveBeenCalled()
  })
})
