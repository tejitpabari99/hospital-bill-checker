import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { auditBill } from '$lib/server/claude'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'
import { incrementStats } from '$lib/server/stats'

const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

export const POST: RequestHandler = async ({ request }) => {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown'

  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT_MAX) {
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
    throw error(400, 'Invalid JSON body')
  }

  // Validate required fields
  if (!body || typeof body !== 'object' || !('lineItems' in body) || !Array.isArray((body as any).lineItems)) {
    throw error(400, 'lineItems array required')
  }

  const input = body as Parameters<typeof auditBill>[0]

  if (input.lineItems.length === 0) {
    throw error(400, 'lineItems cannot be empty')
  }

  if (input.lineItems.length > 100) {
    throw error(400, 'Too many line items (max 100)')
  }

  try {
    const result = await auditBill(input)
    console.log(`[audit] Hospital price enrichment: ${result.summary.aboveHospitalListCount ?? 0} codes above hospital list`)
    incrementStats({
      potentialOvercharge: result.summary.potentialOvercharge,
      errorCount: result.summary.errorCount,
      warningCount: result.summary.warningCount,
    }).catch((err) => console.error('stats increment failed:', err))
    return json(result)
  } catch (err) {
    if (err instanceof AuditRefusalError) {
      return json({ error: 'refusal', message: err.message }, { status: 422 })
    }
    if (err instanceof AuditParseError) {
      return json({ error: 'parse_error', message: 'Our AI returned an unexpected response. Please try again.' }, { status: 502 })
    }
    if (err instanceof AuditTimeoutError) {
      return json({ error: 'timeout', message: err.message }, { status: 504 })
    }
    console.error('Audit error:', err)
    throw error(500, 'Internal server error')
  }
}
