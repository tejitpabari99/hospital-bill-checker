import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { auditBill } from '$lib/server/claude'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'

export const POST: RequestHandler = async ({ request }) => {
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
