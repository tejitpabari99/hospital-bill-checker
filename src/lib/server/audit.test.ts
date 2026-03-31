import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const workerOutputs: string[] = []
const workerInputs: string[] = []

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const stdout = new EventEmitter()
    let closeHandler: (() => void) | undefined
    let errorHandler: ((error: Error) => void) | undefined

    const child = {
      stdout,
      stdin: {
        write: vi.fn((chunk: string | Buffer) => {
          workerInputs.push(chunk.toString())
        }),
        end: vi.fn(() => {
          queueMicrotask(() => {
            const next = workerOutputs.shift()
            if (!next) {
              errorHandler?.(new Error('No mocked worker output available'))
              return
            }
            stdout.emit('data', Buffer.from(next))
            closeHandler?.()
          })
        }),
      },
      on: vi.fn((event: string, cb: (() => void) | ((error: Error) => void)) => {
        if (event === 'close') closeHandler = cb as () => void
        if (event === 'error') errorHandler = cb as (error: Error) => void
        return child
      }),
    }

    return child
  }),
  default: {
    spawn: vi.fn(() => {
      const stdout = new EventEmitter()
      let closeHandler: (() => void) | undefined
      let errorHandler: ((error: Error) => void) | undefined

      const child = {
        stdout,
        stdin: {
          write: vi.fn((chunk: string | Buffer) => {
            workerInputs.push(chunk.toString())
          }),
          end: vi.fn(() => {
            queueMicrotask(() => {
              const next = workerOutputs.shift()
              if (!next) {
                errorHandler?.(new Error('No mocked worker output available'))
                return
              }
              stdout.emit('data', Buffer.from(next))
              closeHandler?.()
            })
          }),
        },
        on: vi.fn((event: string, cb: (() => void) | ((error: Error) => void)) => {
          if (event === 'close') closeHandler = cb as () => void
          if (event === 'error') errorHandler = cb as (error: Error) => void
          return child
        }),
      }

      return child
    }),
  },
}))

vi.mock('./hospital-prices', () => ({
  lookupHospitalPrices: vi.fn(async () => null),
}))

vi.mock('$lib/data/ncci.json', () => ({
  default: {
    '93010': { bundledInto: ['93000'], modifierCanOverride: true },
  },
}))

vi.mock('$lib/data/mpfs.json', () => ({
  default: {
    '93000': { rate: 19.18, description: 'Electrocardiogram with interpretation' },
    '93010': { rate: 6.45, description: 'ECG interpretation and report only' },
    '99285': { rate: 170.78, description: 'Emergency department visit, high medical decision making complexity' },
  },
}))

vi.mock('$lib/data/asp.json', () => ({
  default: {},
}))

vi.mock('$lib/data/clfs.json', () => ({
  default: {},
}))

describe('auditBill', () => {
  beforeEach(() => {
    workerOutputs.length = 0
    workerInputs.length = 0
    vi.resetModules()
  })

  it('injects deterministic NCCI findings even when Gemini returns none', async () => {
    workerOutputs.push(
      JSON.stringify({
        text: JSON.stringify({
          findings: [],
          summary: {
            totalBilled: 0,
            potentialOvercharge: 0,
            errorCount: 0,
            warningCount: 0,
            cleanCount: 2,
          },
          extractedMeta: {},
        }),
      }),
      JSON.stringify({
        text: JSON.stringify({
          disputeLetter: {
            text: 'Test dispute letter',
            placeholders: ['[Your Full Name]'],
          },
        }),
      }),
    )

    const { auditBill } = await import('./claude')

    const result = await auditBill({
      hospitalName: 'Test Hospital',
      lineItems: [
        { cpt: '93000', description: 'ECG complete', units: 1, billedAmount: 250 },
        { cpt: '93010', description: 'ECG interpretation', units: 1, billedAmount: 45 },
      ],
    })

    const finding = result.findings.find(
      (item) => item.cptCode === '93010' && item.errorType === 'unbundling',
    )

    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('error')
    expect(finding?.confidence).toBe('high')
    expect(finding?.ncciBundledWith).toBe('93000')
    expect(finding?.standardDescription).toBeTruthy()
    expect(result.summary.errorCount).toBe(1)
    expect(result.summary.warningCount).toBe(0)
    expect(result.summary.potentialOvercharge).toBe(45)
    expect(result.disputeLetter.text).toBe('Test dispute letter')
  })

  it('passes above_hospital_list_price findings into the dispute-letter prompt', async () => {
    const { lookupHospitalPrices } = await import('./hospital-prices')
    vi.mocked(lookupHospitalPrices).mockResolvedValue({
      hospitalName: 'Test Hospital',
      mrfUrl: 'https://example.com/mrf.json',
      fetchedAt: '2026-03-31T00:00:00Z',
      charges: {
        '99285': {
          code: '99285',
          description: 'Emergency department visit',
          grossCharge: 300,
          discountedCash: 250,
          minNegotiated: null,
          maxNegotiated: null,
          setting: 'outpatient',
        },
      },
    })

    workerOutputs.push(
      JSON.stringify({
        text: JSON.stringify({
          findings: [],
          summary: {
            totalBilled: 0,
            potentialOvercharge: 0,
            errorCount: 0,
            warningCount: 0,
            cleanCount: 1,
          },
          extractedMeta: {},
        }),
      }),
      JSON.stringify({
        text: JSON.stringify({
          disputeLetter: {
            text: 'Hospital list price dispute letter',
            placeholders: ['[Your Full Name]'],
          },
        }),
      }),
    )

    const { auditBill } = await import('./claude')

    const result = await auditBill({
      hospitalName: 'Test Hospital CA',
      lineItems: [
        { cpt: '99285', description: 'ER visit', units: 1, billedAmount: 500 },
      ],
    })

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].errorType).toBe('above_hospital_list_price')
    expect(result.summary.aboveHospitalListCount).toBe(1)
    expect(result.summary.aboveHospitalListTotal).toBe(200)

    const disputePayload = JSON.parse(workerInputs[1] ?? '{}') as { prompt?: string }
    const disputePrompt = disputePayload.prompt ?? ''
    expect(disputePrompt).toContain('"errorType": "above_hospital_list_price"')
    expect(disputePrompt).toContain('"hospitalGrossCharge": 300')
    expect(disputePrompt).toContain('https://example.com/mrf.json')
  })
})
