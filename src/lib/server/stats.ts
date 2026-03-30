import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const STATS_FILE = join(process.cwd(), 'data/stats.json')
const STATS_DIR = join(process.cwd(), 'data')
const SESSION_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface StatsData {
  bills_checked: number
  errors_found: number
  reviews_flagged: number
  savings_total: number
}

export interface StatsSnapshot extends StatsData {
  users_online: number
}

// In-memory write lock — prevents concurrent file corruption
let writeLock: Promise<void> = Promise.resolve()

// In-memory session tracking: sessionId → expiry timestamp
// This is intentionally in-memory only (resets on restart = fine, live counter is approximate)
const sessions = new Map<string, number>()

async function readStats(): Promise<StatsData> {
  try {
    const raw = await readFile(STATS_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      bills_checked: parsed.bills_checked ?? 0,
      errors_found: parsed.errors_found ?? 0,
      reviews_flagged: parsed.reviews_flagged ?? 0,
      savings_total: parsed.savings_total ?? 0,
    }
  } catch {
    return { bills_checked: 0, errors_found: 0, reviews_flagged: 0, savings_total: 0 }
  }
}

export interface StatsDelta {
  potentialOvercharge: number
  errorCount: number
  warningCount: number
}

export async function incrementStats(delta: StatsDelta): Promise<void> {
  writeLock = writeLock.then(async () => {
    const data = await readStats()
    data.bills_checked += 1
    data.errors_found += delta.errorCount
    data.reviews_flagged += delta.warningCount
    data.savings_total += Math.round(delta.potentialOvercharge)
    await mkdir(STATS_DIR, { recursive: true })
    await writeFile(STATS_FILE, JSON.stringify(data), 'utf-8')
  })
  await writeLock
}

export function recordHeartbeat(sessionId: string): number {
  const now = Date.now()
  // Expire old sessions
  for (const [id, expiry] of sessions) {
    if (expiry < now) sessions.delete(id)
  }
  // Record this session
  sessions.set(sessionId, now + SESSION_TTL_MS)
  return sessions.size
}

export async function getStats(): Promise<StatsSnapshot> {
  const data = await readStats()
  // Expire stale sessions before counting
  const now = Date.now()
  for (const [id, expiry] of sessions) {
    if (expiry < now) sessions.delete(id)
  }
  return { ...data, users_online: sessions.size }
}
