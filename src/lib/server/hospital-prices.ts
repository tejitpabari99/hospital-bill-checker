import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)
type DatabaseInstance = InstanceType<typeof Database>

const CACHE_DIR = join(process.cwd(), 'data', 'mrf_cache')
const FETCH_SCRIPT = join(process.cwd(), 'scripts', 'fetch_hospital_mrf.py')
const FETCH_TIMEOUT_MS = 45_000

export interface HospitalChargeRecord {
  code: string
  description: string
  grossCharge: number | null
  discountedCash: number | null
  minNegotiated: number | null
  maxNegotiated: number | null
  setting: string
}

export interface HospitalPriceResult {
  hospitalName: string
  mrfUrl: string
  fetchedAt: string
  charges: Record<string, HospitalChargeRecord>
}

function hospitalSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60)
}

function isCacheFresh(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  const ageSecs = (Date.now() - statSync(dbPath).mtimeMs) / 1000
  return ageSecs < 86_400
}

async function ensureCache(hospitalName: string, state: string, dbPath: string): Promise<boolean> {
  try {
    const args = [FETCH_SCRIPT, hospitalName]
    if (state) args.push('--state', state)
    await execFileAsync('python3', args, { timeout: FETCH_TIMEOUT_MS })
    return existsSync(dbPath)
  } catch (error) {
    console.warn(`[hospital-prices] MRF fetch failed for "${hospitalName}":`, error)
    return false
  }
}

function queryMeta(db: DatabaseInstance): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

function querySingleCode(
  db: DatabaseInstance,
  code: string
): {
  code: string
  description: string | null
  gross_charge: number | null
  discounted_cash: number | null
  min_negotiated: number | null
  max_negotiated: number | null
  setting: string | null
} | undefined {
  return db.prepare(`
    SELECT
      code,
      description,
      gross_charge,
      discounted_cash,
      min_negotiated,
      max_negotiated,
      setting
    FROM charges
    WHERE code = ?
    ORDER BY
      CASE
        WHEN setting = 'outpatient' THEN 0
        WHEN setting = 'both' THEN 1
        ELSE 2
      END,
      COALESCE(gross_charge, discounted_cash, 0) DESC
    LIMIT 1
  `).get(code) as
    | {
        code: string
        description: string | null
        gross_charge: number | null
        discounted_cash: number | null
        min_negotiated: number | null
        max_negotiated: number | null
        setting: string | null
      }
    | undefined
}

export function queryCache(dbPath: string, codes: string[]): HospitalPriceResult | null {
  if (!existsSync(dbPath)) return null

  let db: DatabaseInstance
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }

  try {
    const meta = queryMeta(db)
    const charges: Record<string, HospitalChargeRecord> = {}
    const uniqueCodes = [...new Set(codes.filter(Boolean))]

    for (const code of uniqueCodes) {
      const row = querySingleCode(db, code)
      if (!row) continue
      charges[code] = {
        code: row.code,
        description: row.description ?? '',
        grossCharge: row.gross_charge ?? null,
        discountedCash: row.discounted_cash ?? null,
        minNegotiated: row.min_negotiated ?? null,
        maxNegotiated: row.max_negotiated ?? null,
        setting: row.setting ?? '',
      }
    }

    return {
      hospitalName: meta.hospital_name ?? '',
      mrfUrl: meta.mrf_url ?? '',
      fetchedAt: meta.fetched_at ?? '',
      charges,
    }
  } finally {
    db.close()
  }
}

export async function lookupHospitalPrices(
  hospitalName: string,
  state: string,
  codes: string[]
): Promise<HospitalPriceResult | null> {
  if (!hospitalName || codes.length === 0) return null

  const slug = hospitalSlug(hospitalName)
  const dbPath = join(CACHE_DIR, `${slug}.db`)

  if (!isCacheFresh(dbPath)) {
    const ok = await ensureCache(hospitalName, state, dbPath)
    if (!ok) return null
  }

  return queryCache(dbPath, codes)
}
