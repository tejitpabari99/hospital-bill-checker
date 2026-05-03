import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { getHospitalCacheDb } from './db'
import type { HospitalChargeRecord, HospitalPriceResult } from './hospital-prices'

const execFileAsync = promisify(execFile)
const FETCH_SCRIPT = join(process.cwd(), 'scripts', 'fetch_hospital_trilliant.py')
const FETCH_TIMEOUT_MS = 90_000

async function ensureTrilliantCache(
  hospitalName: string,
  state: string,
  phone?: string
): Promise<boolean> {
  const args = [FETCH_SCRIPT, hospitalName]
  if (state) args.push('--state', state)
  if (phone) args.push('--phone', phone)
  try {
    await execFileAsync('python3', args, { timeout: FETCH_TIMEOUT_MS })
    return true
  } catch (err) {
    console.warn(`[hospital-v2] Trilliant fetch failed for "${hospitalName}":`, err)
    return false
  }
}

function hospitalCacheId(hospitalName: string, state: string): string {
  const normalizedName = hospitalName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ /g, '_')
    .slice(0, 60)

  return (normalizedName + (state ? `_${state.toLowerCase()}` : '')).replace(/[^a-z0-9_-]/g, '_').slice(0, 80)
}

export async function lookupHospitalPricesV2(
  hospitalName: string,
  hospitalState: string,
  codes: string[],
  hospitalPhone?: string
): Promise<HospitalPriceResult | null> {
  if (!hospitalName || codes.length === 0) return null

  const cacheId = hospitalCacheId(hospitalName, hospitalState)
  const cacheFile = join(process.cwd(), 'data', 'hospital_cache', `${cacheId}.sqlite`)

  // Ensure cache exists (trigger fetch if missing or stale)
  const cacheExists = existsSync(cacheFile) &&
    (Date.now() - statSync(cacheFile).mtimeMs) < 7 * 86_400_000

  if (!cacheExists) {
    const ok = await ensureTrilliantCache(hospitalName, hospitalState, hospitalPhone)
    if (!ok) return null
  }

  const db = getHospitalCacheDb(cacheId)
  if (!db) return null

  const charges: Record<string, HospitalChargeRecord> = {}

  for (const code of codes) {
    const normalizedCode = code.toUpperCase().trim()
    const row = db.prepare(`
      SELECT code, description, gross_charge, discounted_cash, min_negotiated, max_negotiated, setting
      FROM charges
      WHERE code = ?
      ORDER BY
        CASE WHEN setting = 'outpatient' THEN 0 WHEN setting = 'both' THEN 1 ELSE 2 END,
        COALESCE(gross_charge, discounted_cash, 0) DESC
      LIMIT 1
    `).get(normalizedCode) as {
      code: string; description: string | null;
      gross_charge: number | null; discounted_cash: number | null;
      min_negotiated: number | null; max_negotiated: number | null;
      setting: string | null;
    } | undefined

    if (row) {
      charges[normalizedCode] = {
        code: row.code,
        description: row.description ?? '',
        grossCharge: row.gross_charge,
        discountedCash: row.discounted_cash,
        minNegotiated: row.min_negotiated,
        maxNegotiated: row.max_negotiated,
        setting: row.setting ?? '',
      }
    }
  }

  if (Object.keys(charges).length === 0) return null

  const meta = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>
  const metaObj = Object.fromEntries(meta.map((row) => [row.key, row.value]))

  return {
    hospitalName,
    mrfUrl: metaObj.source ?? '',
    fetchedAt: metaObj.converted_at ?? new Date().toISOString(),
    charges,
  }
}
