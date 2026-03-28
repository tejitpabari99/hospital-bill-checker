import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

async function getKV() {
  try {
    const { kv } = await import('@vercel/kv')
    return kv
  } catch {
    return null
  }
}

export const GET: RequestHandler = async () => {
  const kv = await getKV()
  if (!kv) return json({ total: null })
  try {
    const total = await kv.get<number>('savings_total') ?? 0
    return json({ total })
  } catch {
    return json({ total: null })
  }
}

export const POST: RequestHandler = async ({ request }) => {
  const kv = await getKV()
  if (!kv) return json({ ok: false })
  try {
    const { amount } = await request.json()
    if (typeof amount !== 'number' || amount <= 0 || amount > 1_000_000) {
      return json({ ok: false })
    }
    await kv.incrby('savings_total', Math.round(amount))
    return json({ ok: true })
  } catch {
    return json({ ok: false })
  }
}
