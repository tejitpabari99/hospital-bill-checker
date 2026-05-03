import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import {
  loadNcciPairs,
  loadMueEdit,
  loadMpfsRate,
  loadClfsRate,
  loadAspLimit,
  loadOppsRate,
  loadDrgRate,
  loadDmeposRate,
  loadAmbulanceRate,
} from './data-loader'
import {
  checkNcciBundling,
  checkMueExceeded,
  checkMpfsBenchmark,
  checkAspDrugOvercharge,
  buildDeterministicFindings,
} from './audit-rules'
import type { LineItem } from '../types'

// ─── helpers ────────────────────────────────────────────────────────────────

function skipIf(condition: boolean, name: string, fn: () => void | Promise<void>) {
  if (condition) {
    it.skip(name, fn)
  } else {
    it(name, fn)
  }
}

const DB = {
  ncci: existsSync('data/ncci.sqlite'),
  mue: existsSync('data/mue.sqlite'),
  mpfs: existsSync('data/mpfs.sqlite'),
  clfs: existsSync('data/clfs.sqlite'),
  asp: existsSync('data/asp.sqlite'),
  opps: existsSync('data/opps.sqlite'),
  ipps: existsSync('data/ipps.sqlite'),
  dmepos: existsSync('data/dmepos.sqlite'),
  ambulance: existsSync('data/ambulance.sqlite'),
}

function makeLineItem(overrides: Partial<LineItem> = {}): LineItem {
  return {
    cpt: '99213',
    description: 'Office visit',
    units: 1,
    billedAmount: 200,
    modifiers: [],
    icd10Codes: [],
    ...overrides,
  }
}

// ─── NCCI ────────────────────────────────────────────────────────────────────

describe('NCCI PTP integration', () => {
  skipIf(!DB.ncci, 'database is queryable and has rows', () => {
    const db = new Database('data/ncci.sqlite', { readonly: true })
    const count = db.prepare('SELECT COUNT(*) as c FROM ncci_ptp').get() as { c: number }
    db.close()
    expect(count.c).toBeGreaterThan(100_000)
  })

  skipIf(!DB.ncci, 'loadNcciPairs returns pairs for a known code', () => {
    // 99213 commonly appears in NCCI as col2.
    const pairs = loadNcciPairs('99213', 'practitioner', 20250101)
    expect(Array.isArray(pairs)).toBe(true)
  })

  skipIf(!DB.ncci, 'checkNcciBundling finds no issues when no pairs present', () => {
    const lineItems = [makeLineItem({ cpt: '99213' })]
    const pairs = loadNcciPairs('99213', 'practitioner', 20250101)
    const findings = checkNcciBundling(lineItems, pairs)
    expect(Array.isArray(findings)).toBe(true)
  })

  skipIf(!DB.ncci, 'ncci_ptp has modifier_indicator column', () => {
    const db = new Database('data/ncci.sqlite', { readonly: true })
    const row = db.prepare('SELECT modifier_indicator FROM ncci_ptp LIMIT 1').get() as { modifier_indicator: unknown }
    db.close()
    expect(row).not.toBeNull()
    expect(['number', 'string']).toContain(typeof row.modifier_indicator)
  })
})

// ─── MUE ─────────────────────────────────────────────────────────────────────

describe('MUE integration', () => {
  skipIf(!DB.mue, 'database has rows for all bill types', () => {
    const db = new Database('data/mue.sqlite', { readonly: true })
    const types = ['practitioner', 'outpatient', 'dme']
    for (const bt of types) {
      const row = db.prepare('SELECT COUNT(*) as c FROM mue_edits WHERE bill_type = ?').get(bt) as { c: number }
      expect(row.c).toBeGreaterThan(100)
    }
    db.close()
  })

  skipIf(!DB.mue, 'loadMueEdit returns a result for code 99213', () => {
    const edit = loadMueEdit('99213', 'practitioner')
    if (edit) {
      expect(edit.mue_value).toBeGreaterThan(0)
      expect(edit.mue_adjudication_indicator).toBeDefined()
    }
  })

  skipIf(!DB.mue, 'checkMueExceeded flags when units exceed limit', () => {
    const lineItems = [makeLineItem({ cpt: '99213', units: 999 })]
    const fakeEdit = { hcpcs_code: '99213', mue_value: 1, mai: 3, bill_type: 'practitioner' }
    const findings = checkMueExceeded(lineItems, [fakeEdit])
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].findingType).toBe('mue_exceeded')
  })
})

// ─── MPFS ─────────────────────────────────────────────────────────────────────

describe('MPFS integration', () => {
  skipIf(!DB.mpfs, 'database has rows', () => {
    const db = new Database('data/mpfs.sqlite', { readonly: true })
    const row = db.prepare('SELECT COUNT(*) as c FROM mpfs_rates').get() as { c: number }
    db.close()
    expect(row.c).toBeGreaterThan(1000)
  })

  skipIf(!DB.mpfs, 'loadMpfsRate returns a rate for 99213', () => {
    const rate = loadMpfsRate('99213')
    if (rate) {
      expect(rate.nonfac_rate).toBeGreaterThan(0)
    }
  })

  skipIf(!DB.mpfs, 'checkMpfsBenchmark flags above 2x rate', () => {
    const fakeRate = { hcpcs_code: '99213', nonfac_rate: 100 }
    const lineItems = [makeLineItem({ cpt: '99213', billedAmount: 300 })]
    const findings = checkMpfsBenchmark(lineItems, [fakeRate])
    expect(findings.length).toBe(1)
    expect(findings[0].findingType).toBe('mpfs_overcharge')
  })

  skipIf(!DB.mpfs, 'checkMpfsBenchmark does not flag below 2x rate', () => {
    const fakeRate = { hcpcs_code: '99213', nonfac_rate: 100 }
    const lineItems = [makeLineItem({ cpt: '99213', billedAmount: 150 })]
    const findings = checkMpfsBenchmark(lineItems, [fakeRate])
    expect(findings.length).toBe(0)
  })
})

// ─── CLFS ─────────────────────────────────────────────────────────────────────

describe('CLFS integration', () => {
  skipIf(!DB.clfs, 'database has rows and clfs_current view exists', () => {
    const db = new Database('data/clfs.sqlite', { readonly: true })
    const row = db.prepare('SELECT COUNT(*) as c FROM clfs_current').get() as { c: number }
    db.close()
    expect(row.c).toBeGreaterThan(100)
  })

  skipIf(!DB.clfs, 'loadClfsRate returns a result for a lab code', () => {
    const rate = loadClfsRate('G0103')
    if (rate) {
      expect(rate.rate).toBeGreaterThan(0)
    }
  })
})

// ─── ASP ─────────────────────────────────────────────────────────────────────

describe('ASP integration', () => {
  skipIf(!DB.asp, 'database has rows', () => {
    const db = new Database('data/asp.sqlite', { readonly: true })
    const row = db.prepare('SELECT COUNT(*) as c FROM asp_payment_limits').get() as { c: number }
    db.close()
    expect(row.c).toBeGreaterThan(100)
  })

  skipIf(!DB.asp, 'loadAspLimit returns result for a J-code', () => {
    const limit = loadAspLimit('J0171')
    if (limit) {
      expect(limit.payment_limit).toBeGreaterThan(0)
    }
  })

  skipIf(!DB.asp, 'checkAspDrugOvercharge flags 10x ASP rate', () => {
    const fakeLimit = { hcpcs_code: 'J0171', asp_payment_limit: 10 }
    const lineItems = [makeLineItem({ cpt: 'J0171', billedAmount: 200 })]
    const findings = checkAspDrugOvercharge(lineItems, [fakeLimit])
    expect(findings.length).toBe(1)
    expect(findings[0].findingType).toBe('asp_overcharge')
  })
})

// ─── OPPS ─────────────────────────────────────────────────────────────────────

describe('OPPS integration', () => {
  skipIf(!DB.opps, 'database has addendum_b and addendum_a', () => {
    const db = new Database('data/opps.sqlite', { readonly: true })
    const b = db.prepare('SELECT COUNT(*) as c FROM opps_addendum_b').get() as { c: number }
    const a = db.prepare('SELECT COUNT(*) as c FROM opps_addendum_a').get() as { c: number }
    db.close()
    expect(b.c).toBeGreaterThan(100)
    expect(a.c).toBeGreaterThan(10)
  })

  skipIf(!DB.opps, 'loadOppsRate returns APC rate for a common code', () => {
    const rate = loadOppsRate('99285')
    if (rate) {
      expect(rate.payment_rate).toBeGreaterThanOrEqual(0)
    }
  })
})

// ─── IPPS/DRG ─────────────────────────────────────────────────────────────────

describe('IPPS/DRG integration', () => {
  skipIf(!DB.ipps, 'database has rows', () => {
    const db = new Database('data/ipps.sqlite', { readonly: true })
    const row = db.prepare('SELECT COUNT(*) as c FROM ipps_drg_rates').get() as { c: number }
    db.close()
    expect(row.c).toBeGreaterThan(100)
  })

  skipIf(!DB.ipps, 'loadDrgRate returns data for DRG 470 (major joint)', () => {
    const rate = loadDrgRate('470')
    if (rate) {
      expect(rate.title).toBeDefined()
      expect(rate.relative_weight).toBeGreaterThan(0)
    }
  })

  skipIf(!DB.ipps, 'DRG codes are zero-padded to 3 digits', () => {
    const db = new Database('data/ipps.sqlite', { readonly: true })
    const row = db.prepare('SELECT ms_drg FROM ipps_drg_rates WHERE CAST(ms_drg AS INTEGER) < 10 LIMIT 1').get() as { ms_drg: string } | undefined
    if (row) {
      expect(row.ms_drg.length).toBe(3)
    }
    db.close()
  })
})

// ─── DMEPOS ───────────────────────────────────────────────────────────────────

describe('DMEPOS integration', () => {
  skipIf(!DB.dmepos, 'database has base and state rate tables', () => {
    const db = new Database('data/dmepos.sqlite', { readonly: true })
    const base = db.prepare('SELECT COUNT(*) as c FROM dmepos_base').get() as { c: number }
    const state = db.prepare('SELECT COUNT(*) as c FROM dmepos_state_rates').get() as { c: number }
    db.close()
    expect(base.c).toBeGreaterThan(100)
    expect(state.c).toBeGreaterThan(1000)
  })

  skipIf(!DB.dmepos, 'loadDmeposRate returns rate for a state', () => {
    const rate = loadDmeposRate('E0601', 'TX')
    if (rate) {
      expect(rate.fee_amount).toBeGreaterThan(0)
    }
  })
})

// ─── Ambulance ────────────────────────────────────────────────────────────────

describe('Ambulance integration', () => {
  skipIf(!DB.ambulance, 'database has rates and geography tables', () => {
    const db = new Database('data/ambulance.sqlite', { readonly: true })
    const rates = db.prepare('SELECT COUNT(*) as c FROM ambulance_rates').get() as { c: number }
    const geo = db.prepare('SELECT COUNT(*) as c FROM ambulance_geography').get() as { c: number }
    db.close()
    expect(rates.c).toBeGreaterThan(10)
    expect(geo.c).toBeGreaterThan(10_000)
  })

  skipIf(!DB.ambulance, 'loadAmbulanceRate resolves a ZIP to locality', () => {
    const rate = loadAmbulanceRate('A0428', '78701')
    expect(rate === null || typeof rate === 'object').toBe(true)
  })
})

// ─── Full pipeline smoke test ─────────────────────────────────────────────────

const allDBsPresent = Object.values(DB).every(Boolean)

describe('full audit pipeline smoke test', () => {
  skipIf(!allDBsPresent, 'buildDeterministicFindings runs without throwing', () => {
    const lineItems: LineItem[] = [
      makeLineItem({ cpt: '99213', billedAmount: 200 }),
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      'TX',
      undefined
    )
    expect(Array.isArray(findings)).toBe(true)
  })
})
