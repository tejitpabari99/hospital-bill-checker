import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { recordHeartbeat } from '$lib/server/stats'

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}))
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0
    ? body.sessionId
    : `anon-${Date.now()}`
  const count = recordHeartbeat(sessionId)
  return json({ ok: true, users_online: count })
}
