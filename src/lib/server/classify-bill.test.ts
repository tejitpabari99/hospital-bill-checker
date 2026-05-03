import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const workerOutputs: string[] = []
const workerInputs: string[] = []
let emitChildError = false

vi.mock('$env/static/private', () => ({ GEMINI_API_KEY: 'test-key' }))
vi.mock('./logger.js', () => ({
  createServerLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  serializeError: (err: unknown) => err,
}))

vi.mock('child_process', () => {
  const spawn = vi.fn(() => {
    const stdout = new EventEmitter()
    const handlers = new Map<string, (arg?: unknown) => void>()
    const child = {
      stdout,
      stdin: {
        write: vi.fn((chunk: string | Buffer) => {
          workerInputs.push(chunk.toString())
        }),
        end: vi.fn(() => {
          queueMicrotask(() => {
            if (emitChildError) {
              handlers.get('error')?.(new Error('worker failed'))
              return
            }
            stdout.emit('data', Buffer.from(workerOutputs.shift() ?? ''))
            handlers.get('close')?.()
          })
        }),
      },
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers.set(event, cb)
        return child
      }),
    }

    return child
  })

  return { spawn, default: { spawn } }
})

describe('classifyBill', () => {
  beforeEach(() => {
    workerOutputs.length = 0
    workerInputs.length = 0
    emitChildError = false
    vi.resetModules()
  })

  it('returns a valid worker classification', async () => {
    workerOutputs.push(JSON.stringify({ billType: 'outpatient' }))
    const { classifyBill } = await import('./pdf')

    await expect(classifyBill({ lineItems: [] }, 'test-key')).resolves.toBe('outpatient')
  })

  it('falls back to unknown for invalid JSON', async () => {
    workerOutputs.push('not-json')
    const { classifyBill } = await import('./pdf')

    await expect(classifyBill({ lineItems: [] }, 'test-key')).resolves.toBe('unknown')
  })

  it('falls back to unknown for unsupported bill types', async () => {
    workerOutputs.push(JSON.stringify({ billType: 'dental' }))
    const { classifyBill } = await import('./pdf')

    await expect(classifyBill({ lineItems: [] }, 'test-key')).resolves.toBe('unknown')
  })

  it('falls back to unknown when the child process errors', async () => {
    emitChildError = true
    const { classifyBill } = await import('./pdf')

    await expect(classifyBill({ lineItems: [] }, 'test-key')).resolves.toBe('unknown')
  })

  it('passes the bounded classification payload to the worker', async () => {
    workerOutputs.push(JSON.stringify({ billType: 'dme' }))
    const { classifyBill } = await import('./pdf')

    await classifyBill({
      rawText: 'raw bill text',
      hospitalName: 'Test Hospital',
      admissionDate: '2026-04-01',
      dischargeDate: '2026-04-03',
      drgCode: '470',
      lineItems: Array.from({ length: 35 }, (_, index) => ({
        cpt: String(99000 + index),
        description: `line ${index}`,
        units: 1,
        billedAmount: 100,
      })),
    }, 'test-key')

    const payload = JSON.parse(workerInputs[0] ?? '{}') as { lineItems?: unknown[]; hospitalName?: string; drgCode?: string }
    expect(payload.hospitalName).toBe('Test Hospital')
    expect(payload.drgCode).toBe('470')
    expect(payload.lineItems).toHaveLength(30)
  })
})
