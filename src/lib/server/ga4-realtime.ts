import { BetaAnalyticsDataClient } from '@google-analytics/data'
import { env } from '$env/dynamic/private'

let _client: BetaAnalyticsDataClient | null = null

function getClient(): BetaAnalyticsDataClient {
  if (!_client) {
    const inlineKey = (env as any).GA_SERVICE_ACCOUNT_KEY ?? ''
    if (inlineKey) {
      _client = new BetaAnalyticsDataClient({ credentials: JSON.parse(inlineKey) })
    } else {
      // Falls back to GOOGLE_APPLICATION_CREDENTIALS file path automatically
      _client = new BetaAnalyticsDataClient()
    }
  }
  return _client
}

// 60-second server-side cache to stay within GA4 free-tier quota (10 req/min)
let cache: { value: number; expiresAt: number } | null = null

export async function getGA4ActiveUsers(): Promise<number> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.value

  const propertyId = (env as any).GA_PROPERTY_ID ?? ''
  if (!propertyId) throw new Error('GA_PROPERTY_ID not configured')

  const [response] = await getClient().runRealtimeReport({
    property: `properties/${propertyId}`,
    metrics: [{ name: 'activeUsers' }],
  })

  const value = parseInt(response.rows?.[0]?.metricValues?.[0]?.value ?? '0', 10) || 0
  cache = { value, expiresAt: now + 60_000 }
  return value
}
