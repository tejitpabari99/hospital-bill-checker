import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { auditBill } from '$lib/server/claude'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'
import { incrementStats } from '$lib/server/stats'
import { randomUUID } from 'crypto'
import { createServerLogger, serializeError } from '$lib/server/logger.js'

const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

export const POST: RequestHandler = async ({ request }) => {
  const traceId = randomUUID().slice(0, 8)
  const log = createServerLogger('audit', traceId)
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown'
  const start = Date.now()
  log.info('request-start', { ip })

  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT_MAX) {
      log.warn('rate-limited', { ip, count: entry.count })
      return json(
        { error: 'rate_limited', message: 'Too many requests. Please try again in a minute.' },
        { status: 429 }
      )
    }
    entry.count++
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    log.warn('invalid-json-body')
    throw error(400, 'Invalid JSON body')
  }

  // Validate required fields
  if (!body || typeof body !== 'object' || !('lineItems' in body) || !Array.isArray((body as any).lineItems)) {
    log.warn('missing-line-items')
    throw error(400, 'lineItems array required')
  }

  const input = body as Parameters<typeof auditBill>[0]

  if (input.lineItems.length === 0) {
    log.warn('empty-line-items')
    throw error(400, 'lineItems cannot be empty')
  }

  if (input.lineItems.length > 100) {
    log.warn('too-many-line-items', { count: input.lineItems.length })
    throw error(400, 'Too many line items (max 100)')
  }

  log.info('validated-input', {
    lineItems: input.lineItems.length,
    hospitalName: input.hospitalName ?? null,
    hasBillTotal: input.billTotal != null,
    hasAdmissionDate: Boolean(input.admissionDate),
    hasDischargeDate: Boolean(input.dischargeDate),
    hasGfe: input.goodFaithEstimate != null,
  })

  try {
    const result = await auditBill(input, traceId)
    log.info('request-finished', {
      ms: Date.now() - start,
      findings: result.findings.length,
      errors: result.summary.errorCount,
      warnings: result.summary.warningCount,
      aboveHospitalList: result.summary.aboveHospitalListCount ?? 0,
    })
    incrementStats({
      potentialOvercharge: result.summary.potentialOvercharge,
      errorCount: result.summary.errorCount,
      warningCount: result.summary.warningCount,
    }).catch((err) => log.error('stats-increment-failed', { error: serializeError(err) }))
    return json(result)
  } catch (err) {
    if (err instanceof AuditRefusalError) {
      log.warn('refusal', { message: err.message, ms: Date.now() - start })
      return json({ error: 'refusal', message: err.message }, { status: 422 })
    }
    if (err instanceof AuditParseError) {
      log.error('parse-error', { message: err.message, ms: Date.now() - start })
      return json({ error: 'parse_error', message: 'Our AI returned an unexpected response. Please try again.' }, { status: 502 })
    }
    if (err instanceof AuditTimeoutError) {
      log.error('timeout', { message: err.message, ms: Date.now() - start })
      return json({ error: 'timeout', message: err.message }, { status: 504 })
    }
    log.error('unhandled-error', { error: serializeError(err) })
    throw error(500, 'Internal server error')
  }
}
