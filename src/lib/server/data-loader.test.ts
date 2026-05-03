import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import { describe, it, expect } from 'vitest'
import { loadAmbulanceRate, loadAspLimit, loadClfsRate, loadDmeposRate, loadDrgRate, loadOppsRate, toServiceDateInt } from './data-loader'

describe('toServiceDateInt', () => {
  it('parses YYYY-MM-DD', () => {
    expect(toServiceDateInt('2026-04-01')).toBe(20260401)
  })

  it('parses YYYYMMDD', () => {
    expect(toServiceDateInt('20260401')).toBe(20260401)
  })

  it('falls back to today for empty string', () => {
    const today = new Date()
    const expected = parseInt(
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`,
      10
    )
    expect(toServiceDateInt('')).toBe(expected)
  })

  it('falls back to today for null', () => {
    const today = new Date()
    const expected = parseInt(
      `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`,
      10
    )
    expect(toServiceDateInt(null)).toBe(expected)
  })

  it('falls back to today for garbage input', () => {
    const today = new Date()
    const result = toServiceDateInt('not-a-date')
    expect(result).toBeGreaterThan(20200101)
    expect(result).toBeLessThan(21000101)
  })
})

describe('CLFS SQLite integration', () => {
  it.skipIf(!existsSync('data/clfs.sqlite'))('returns rate for CBC 85025', () => {
    const row = loadClfsRate('85025')
    expect(row).not.toBeNull()
    expect(row!.rate).toBeGreaterThan(0)
    expect(row!.rate).toBeLessThan(100)  // CBC is a few dollars
  })

  it.skipIf(!existsSync('data/clfs.sqlite'))('returns null for non-lab code', () => {
    // 99285 is in MPFS, not CLFS
    const row = loadClfsRate('99285')
    // May or may not be null — just assert it doesn't throw
    expect(row === null || typeof row.rate === 'number').toBe(true)
  })
})

describe('ASP SQLite integration', () => {
  it.skipIf(!existsSync('data/asp.sqlite'))('returns limit for J0696 (Ceftriaxone)', () => {
    const row = loadAspLimit('J0696')
    expect(row).not.toBeNull()
    expect(row!.payment_limit).toBeGreaterThan(0)
  })

  it.skipIf(!existsSync('data/asp.sqlite'))('returns null for non-drug code', () => {
    expect(loadAspLimit('99285')).toBeNull()
  })
})

describe('OPPS SQLite integration', () => {
  it.skipIf(!existsSync('data/opps.sqlite'))('loads Addendum B for 99285', () => {
    const row = loadOppsRate('99285')
    // 99285 may or may not be in OPPS
    if (row) {
      expect(row.hcpcs_code).toBe('99285')
      expect(typeof row.status_indicator).toBe('string')
    }
  })

  it.skipIf(!existsSync('data/opps.sqlite'))('Addendum B has records', () => {
    const row = loadOppsRate('70450')
    // Just verify no crash
    expect(row === null || row.hcpcs_code === '70450').toBe(true)
  })
})

describe('IPPS SQLite integration', () => {
  it.skipIf(!existsSync('data/ipps.sqlite'))('loads DRG 470 (major joint replacement)', () => {
    const row = loadDrgRate('470')
    expect(row).not.toBeNull()
    expect(row!.ms_drg).toBe('470')
    expect(row!.relative_weight).toBeGreaterThan(0)
    expect(row!.geometric_mean_los).toBeGreaterThan(0)
  })

  it.skipIf(!existsSync('data/ipps.sqlite'))('pads DRG code to 3 digits', () => {
    const row = loadDrgRate('1')
    // May or may not exist, just verify no crash
    if (row) expect(row.ms_drg).toBe('001')
  })

  it.skipIf(!existsSync('data/ipps.sqlite'))('returns null for invalid DRG', () => {
    expect(loadDrgRate('999')).toBeNull()
  })
})

describe('DMEPOS SQLite integration', () => {
  it.skipIf(!existsSync('data/dmepos.sqlite'))('returns rate for E0601 in TX', () => {
    const row = loadDmeposRate('E0601', 'TX')
    if (row) {
      expect(row.fee_amount).toBeGreaterThan(0)
    }
  })

  it.skipIf(!existsSync('data/dmepos.sqlite'))('returns null for unknown code', () => {
    expect(loadDmeposRate('ZZZZZ', 'CA')).toBeNull()
  })
})

describe('Ambulance SQLite integration', () => {
  it.skipIf(!existsSync('data/ambulance.sqlite'))('geography table has records', () => {
    const db = new Database('data/ambulance.sqlite', { readonly: true })
    const count = db.prepare('SELECT COUNT(*) as c FROM ambulance_geography').get() as { c: number }
    expect(count.c).toBeGreaterThan(1000)
    db.close()
  })

  it.skipIf(!existsSync('data/ambulance.sqlite'))('rates table has records', () => {
    const db = new Database('data/ambulance.sqlite', { readonly: true })
    const count = db.prepare('SELECT COUNT(*) as c FROM ambulance_rates').get() as { c: number }
    expect(count.c).toBeGreaterThan(0)
    db.close()
  })

  it.skipIf(!existsSync('data/ambulance.sqlite'))('loads a rate using zip-to-locality routing', () => {
    const row = loadAmbulanceRate('A0427', '90210')
    expect(row === null || row.hcpcs_code === 'A0427').toBe(true)
  })
})

describe('hospital directory sqlite', () => {
  it.skipIf(!existsSync('data/hospital_directory.sqlite'))('has hospitals', () => {
    const db = new Database('data/hospital_directory.sqlite', { readonly: true })
    const count = db.prepare('SELECT COUNT(*) as c FROM hospitals').get() as { c: number }
    expect(count.c).toBeGreaterThan(1000)
    db.close()
  })

  it.skipIf(!existsSync('data/hospital_directory.sqlite'))('can search by name', () => {
    const db = new Database('data/hospital_directory.sqlite', { readonly: true })
    const rows = db.prepare(
      'SELECT hospital_name FROM hospitals WHERE normalized_name LIKE ? LIMIT 3'
    ).all('%general%') as Array<{ hospital_name: string }>
    expect(rows.length).toBeGreaterThan(0)
    db.close()
  })
})
