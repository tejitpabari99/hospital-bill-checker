import type { LayoutServerLoad } from './$types'
import { getStats } from '$lib/server/stats'
import { getGA4ActiveUsers } from '$lib/server/ga4-realtime'

export const load: LayoutServerLoad = async () => {
  try {
    const [stats, activeUsers] = await Promise.all([
      getStats(),
      getGA4ActiveUsers().catch(() => null),
    ])
    return {
      initialStats: {
        bills_checked: stats.bills_checked,
        savings_total: stats.savings_total,
        users_online: activeUsers ?? stats.users_online,
      }
    }
  } catch {
    return { initialStats: null }
  }
}
