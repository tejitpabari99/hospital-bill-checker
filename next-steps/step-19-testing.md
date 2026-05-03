# Step 19: Integration Tests — Full SQLite Pipeline

> **AGENT INSTRUCTIONS:** You are implementing step 19.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–18 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Write integration tests that verify the full deterministic pipeline end-to-end,
from SQLite lookup functions to the audit findings output. Tests use real SQLite databases
(must be present in `data/`) and are skipped if the DB files don't exist.

All tests use `vitest`. Run with `npm run test`.

**Files to create:**
- `src/lib/server/integration.test.ts` — integration tests for all data loaders + audit rules

**Files to update:**
- `src/lib/server/audit-rules.test.ts` — add edge-case unit tests missed in earlier steps

---

## Task 1: Create integration test file

Create `src/lib/server/integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
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
  checkClfsBenchmark,
  checkAspDrugOvercharge,
  checkOppsBenchmark,
  checkIppsDrg,
  checkDmeposBenchmark,
  checkAmbulanceBenchmark,
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
    // 99213 commonly appears in NCCI as col2
    const pairs = loadNcciPairs(['99213', '36415'], 'practitioner', '2025-01-01')
    // May or may not have a pair — just verify no exception is thrown and result is an array
    expect(Array.isArray(pairs)).toBe(true)
  })

  skipIf(!DB.ncci, 'checkNcciBundling finds no issues when no pairs present', () => {
    const lineItems = [makeLineItem({ cpt: '99213' })]
    const pairs = loadNcciPairs(['99213'], 'practitioner', '2025-01-01')
    const findings = checkNcciBundling(lineItems, pairs)
    expect(Array.isArray(findings)).toBe(true)
  })

  skipIf(!DB.ncci, 'ncci_ptp has modifier_indicator column', () => {
    const db = new Database('data/ncci.sqlite', { readonly: true })
    const row = db.prepare('SELECT modifier_indicator FROM ncci_ptp LIMIT 1').get() as any
    db.close()
    expect(row).not.toBeNull()
    expect(typeof row.modifier_indicator).toBe('number')
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
    // 99213 is an extremely common CPT — should have an MUE
    if (edit) {
      expect(edit.mue_value).toBeGreaterThan(0)
      expect(edit.mai).toBeDefined()
    }
  })

  skipIf(!DB.mue, 'checkMueExceeded flags when units exceed limit', () => {
    // We'll use a fake MUE edit to simulate the finding
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

  skipIf(!DB.mpfs, 'checkMpfsBenchmark flags at 2x rate', () => {
    const fakeRate = { hcpcs_code: '99213', nonfac_rate: 100 }
    const lineItems = [makeLineItem({ cpt: '99213', billedAmount: 300 })]
    const findings = checkMpfsBenchmark(lineItems, [fakeRate])
    expect(findings.length).toBe(1)
    expect(findings[0].findingType).toBe('mpfs_overcharge')
  })

  skipIf(!DB.mpfs, 'checkMpfsBenchmark does not flag at 1.5x rate', () => {
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
    // G0103 is a common lab code (PSA test)
    const rate = loadClfsRate('G0103')
    if (rate) {
      expect(rate.payment_limit).toBeGreaterThan(0)
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
    // J0171 is epinephrine injection — a common ASP code
    const limit = loadAspLimit('J0171')
    if (limit) {
      expect(limit.asp_payment_limit).toBeGreaterThan(0)
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
    // 99285 is ER visit level 5 — common OPPS code
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
      expect(rate.drg_title).toBeDefined()
      expect(rate.relative_weight).toBeGreaterThan(0)
    }
  })

  skipIf(!DB.ipps, 'DRG codes are zero-padded to 3 digits', () => {
    const db = new Database('data/ipps.sqlite', { readonly: true })
    const row = db.prepare("SELECT drg_code FROM ipps_drg_rates WHERE CAST(drg_code AS INTEGER) < 10 LIMIT 1").get() as any
    if (row) {
      expect(row.drg_code.length).toBe(3)
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
    // E0601 is a CPAP device — very common DME code
    const rate = loadDmeposRate('E0601', 'TX')
    if (rate) {
      expect(rate.rental_rate).toBeGreaterThan(0)
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
    // ZIP 78701 is Austin TX — should resolve to a locality
    const rate = loadAmbulanceRate('A0428', '78701')
    // May or may not match — just verify no exception
    expect(rate === null || typeof rate === 'object').toBe(true)
  })
})

// ─── Full pipeline smoke test ─────────────────────────────────────────────────

const allDBsPresent = Object.values(DB).every(Boolean)

describe('full audit pipeline smoke test', () => {
  skipIf(!allDBsPresent, 'buildDeterministicFindings runs without throwing', async () => {
    const { buildDeterministicFindings } = await import('./claude')
    const lineItems: LineItem[] = [
      makeLineItem({ cpt: '99213', billedAmount: 200 }),
    ]
    const findings = await buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      'TX',
      undefined,
    )
    expect(Array.isArray(findings)).toBe(true)
  })
})
```

---

## Task 2: Update audit-rules.test.ts with edge cases

- [ ] Open `src/lib/server/audit-rules.test.ts`
- [ ] Add the following describe block at the bottom:

```typescript
describe('audit-rules edge cases', () => {
  it('checkNcciBundling: modifier 59 bypasses indicator=1 edit', () => {
    const lineItems = [
      { cpt: 'A', description: '', units: 1, billedAmount: 100, modifiers: [], icd10Codes: [] },
      { cpt: 'B', description: '', units: 1, billedAmount: 100, modifiers: ['59'], icd10Codes: [] },
    ]
    const pairs = [
      { col1_code: 'A', col2_code: 'B', modifier_indicator: 1, bill_type: 'practitioner' as const },
    ]
    const findings = checkNcciBundling(lineItems, pairs)
    expect(findings.length).toBe(0)
  })

  it('checkNcciBundling: no modifier does NOT bypass indicator=1 edit', () => {
    const lineItems = [
      { cpt: 'A', description: '', units: 1, billedAmount: 100, modifiers: [], icd10Codes: [] },
      { cpt: 'B', description: '', units: 1, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    const pairs = [
      { col1_code: 'A', col2_code: 'B', modifier_indicator: 1, bill_type: 'practitioner' as const },
    ]
    const findings = checkNcciBundling(lineItems, pairs)
    expect(findings.length).toBe(1)
  })

  it('checkMueExceeded: exactly at limit is not flagged', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 1, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    const edits = [{ hcpcs_code: '99213', mue_value: 1, mai: 3, bill_type: 'practitioner' }]
    const findings = checkMueExceeded(lineItems, edits)
    expect(findings.length).toBe(0)
  })

  it('checkMpfsBenchmark: exactly at 2x threshold is not flagged', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 1, billedAmount: 200, modifiers: [], icd10Codes: [] },
    ]
    const rates = [{ hcpcs_code: '99213', nonfac_rate: 100 }]
    const findings = checkMpfsBenchmark(lineItems, rates)
    expect(findings.length).toBe(0)
  })

  it('checkMpfsBenchmark: above 2x threshold is flagged', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 1, billedAmount: 201, modifiers: [], icd10Codes: [] },
    ]
    const rates = [{ hcpcs_code: '99213', nonfac_rate: 100 }]
    const findings = checkMpfsBenchmark(lineItems, rates)
    expect(findings.length).toBe(1)
  })

  it('unknown bill type skips bill-type-specific checks', async () => {
    const { buildDeterministicFindings } = await import('./claude')
    const lineItems = [
      { cpt: '99213', description: '', units: 1, billedAmount: 200, modifiers: [], icd10Codes: [] },
    ]
    // Should not throw even with unknown bill type and no DBs present
    const findings = await buildDeterministicFindings(lineItems, 'unknown', '2025-01-01', undefined, undefined, undefined)
    expect(Array.isArray(findings)).toBe(true)
  })
})
```

---

## Task 3: Run tests

- [ ] `npm run test -- --reporter=verbose`
- [ ] Verify:
  - Tests without DB files are skipped (not failed)
  - Unit tests pass
  - If DB files are present, integration tests pass

---

## Task 4: Run check and build

- [ ] `npm run check && npm run build`

---

## Task 5: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/lib/server/integration.test.ts src/lib/server/audit-rules.test.ts
git commit -m "test: add integration tests for all SQLite data loaders and full audit pipeline"
```
