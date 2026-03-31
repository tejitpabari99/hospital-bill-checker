import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { lookupHospitalPrices, queryCache } from './hospital-prices'

const cacheDir = join(process.cwd(), 'data', 'mrf_cache')
const dbPath = join(cacheDir, 'test_hospital.db')

function writeTestDatabase(rows: Array<{
  code: string
  code_type: string
  description: string
  gross_charge: number | null
  discounted_cash: number | null
  min_negotiated: number | null
  max_negotiated: number | null
  setting: string
}>) {
  mkdirSync(cacheDir, { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      code_type TEXT NOT NULL,
      description TEXT,
      gross_charge REAL,
      discounted_cash REAL,
      min_negotiated REAL,
      max_negotiated REAL,
      setting TEXT
    );
    CREATE INDEX idx_code ON charges(code);
  `)

  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('hospital_name', 'Test Hospital')
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('mrf_url', 'https://example.org/charges.json')
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('fetched_at', '2026-03-31T00:00:00Z')

  const insert = db.prepare(`
    INSERT INTO charges (
      code, code_type, description,
      gross_charge, discounted_cash,
      min_negotiated, max_negotiated,
      setting
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const row of rows) {
    insert.run(
      row.code,
      row.code_type,
      row.description,
      row.gross_charge,
      row.discounted_cash,
      row.min_negotiated,
      row.max_negotiated,
      row.setting,
    )
  }

  db.close()
}

beforeEach(() => {
  rmSync(dbPath, { force: true })
})

afterEach(() => {
  rmSync(dbPath, { force: true })
})

describe('hospital-prices', () => {
  it('returns null for empty lookup inputs', async () => {
    await expect(lookupHospitalPrices('', '', ['80053'])).resolves.toBeNull()
    await expect(lookupHospitalPrices('Test Hospital', '', [])).resolves.toBeNull()
  })

  it('reads a fresh cache and returns the matching charge record', async () => {
    writeTestDatabase([
      {
        code: '80053',
        code_type: 'CPT',
        description: 'COMPREHENSIVE METABOLIC PANEL',
        gross_charge: 350,
        discounted_cash: 175,
        min_negotiated: 45,
        max_negotiated: 210,
        setting: 'outpatient',
      },
    ])

    const result = await lookupHospitalPrices('Test Hospital', '', ['80053'])
    expect(result).not.toBeNull()
    expect(result?.hospitalName).toBe('Test Hospital')
    expect(result?.mrfUrl).toBe('https://example.org/charges.json')
    expect(result?.charges['80053']).toMatchObject({
      code: '80053',
      description: 'COMPREHENSIVE METABOLIC PANEL',
      grossCharge: 350,
      discountedCash: 175,
      minNegotiated: 45,
      maxNegotiated: 210,
      setting: 'outpatient',
    })
  })

  it('prefers outpatient rows and deduplicates requested codes', () => {
    writeTestDatabase([
      {
        code: '99285',
        code_type: 'CPT',
        description: 'EMERGENCY DEPARTMENT VISIT',
        gross_charge: 1200,
        discounted_cash: 600,
        min_negotiated: 200,
        max_negotiated: 900,
        setting: 'inpatient',
      },
      {
        code: '99285',
        code_type: 'CPT',
        description: 'EMERGENCY DEPARTMENT VISIT',
        gross_charge: 950,
        discounted_cash: 475,
        min_negotiated: 180,
        max_negotiated: 850,
        setting: 'outpatient',
      },
    ])

    const result = queryCache(dbPath, ['99285', '99285'])
    expect(result).not.toBeNull()
    expect(Object.keys(result?.charges ?? {})).toEqual(['99285'])
    expect(result?.charges['99285']).toMatchObject({
      grossCharge: 950,
      discountedCash: 475,
      setting: 'outpatient',
    })
  })

  it('returns null when the cache file is missing', () => {
    expect(queryCache(join(cacheDir, 'missing.db'), ['80053'])).toBeNull()
  })
})
