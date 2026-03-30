import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getGA4ActiveUsers } from '$lib/server/ga4-realtime'
import { getStats } from '$lib/server/stats'

export const GET: RequestHandler = async () => {
  try {
    const activeUsers = await getGA4ActiveUsers()
    return json({ active_users: activeUsers, source: 'ga4' })
  } catch (err) {
    console.warn('[live-users] GA4 failed, using fallback:', (err as Error).message)
    try {
      const stats = await getStats()
      return json({ active_users: stats.users_online, source: 'fallback' })
    } catch {
      return json({ active_users: 2, source: 'fallback' })
    }
  }
}
