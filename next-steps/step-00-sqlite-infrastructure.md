# Step 00: SQLite Infrastructure

> **AGENT INSTRUCTIONS:** You are implementing step 00 of the hospital bill checker plan.
> Work in `/root/projects/hospital-bill-checker`.
> Read `next-steps/README.md` first for full project context.
> Complete every checkbox. Commit at the end.

**Goal:** Create the TypeScript db helper module and data-loader pattern that all subsequent steps will use.
This step establishes the architecture; later steps fill in the actual data.

**Files to create:**
- `src/lib/server/db.ts` — opens and caches `better-sqlite3` connections
- `src/lib/server/data-loader.ts` — typed query helpers (stub, filled in by later steps)
- `src/lib/types.ts` — add `BillType` type

**Files to modify:**
- `src/lib/server/audit-rules.ts` — add new type aliases that later steps use

---

## Task 1: Add BillType to types.ts

**File:** `src/lib/types.ts`

- [ ] Open `src/lib/types.ts` and add the `BillType` union after the imports section (before `LineItem`):

```typescript
export type BillType = 'practitioner' | 'outpatient' | 'dme' | 'inpatient' | 'unknown'
```

- [ ] Add `billType` and `serviceDate` to `BillInput`:

```typescript
export interface BillInput {
  lineItems: LineItem[]
  rawText?: string
  hospitalName?: string
  hospitalAddress?: string
  hospitalPhone?: string
  hospitalNpi?: string
  accountNumber?: string
  dateOfService?: string
  billTotal?: number
  admissionDate?: string
  dischargeDate?: string
  goodFaithEstimate?: number
  patientName?: string
  billType?: BillType        // <-- ADD
  patientState?: string      // <-- ADD (for DMEPOS lookup)
  drgCode?: string           // <-- ADD (for IPPS lookup)
}
```

- [ ] Add `modifiers` and `quantity` to `LineItem` if not already there:

```typescript
export interface LineItem {
  cpt: string
  description: string
  units: number
  billedAmount: number
  serviceDate?: string
  modifiers?: string[]
  icd10Codes?: string[]
  quantity?: number
}
```

- [ ] Run: `npm run check`
- [ ] Expected: no TypeScript errors

---

## Task 2: Create db.ts

**File:** `src/lib/server/db.ts`

- [ ] Create `src/lib/server/db.ts` with this content:

```typescript
import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync } from 'fs'

const DATA_DIR = join(process.cwd(), 'data')

function openDb(filename: string): Database.Database | null {
  const path = join(DATA_DIR, filename)
  if (!existsSync(path)) return null
  try {
    return new Database(path, { readonly: true })
  } catch (err) {
    console.warn(`[db] Failed to open ${filename}:`, err)
    return null
  }
}

// Each DB is opened once and cached for the lifetime of the process
let _ncci: Database.Database | null | undefined = undefined
let _mue: Database.Database | null | undefined = undefined
let _mpfs: Database.Database | null | undefined = undefined
let _clfs: Database.Database | null | undefined = undefined
let _asp: Database.Database | null | undefined = undefined
let _opps: Database.Database | null | undefined = undefined
let _ipps: Database.Database | null | undefined = undefined
let _dmepos: Database.Database | null | undefined = undefined
let _ambulance: Database.Database | null | undefined = undefined
let _hospitalDir: Database.Database | null | undefined = undefined

export function getNcciDb(): Database.Database | null {
  if (_ncci !== undefined) return _ncci
  return (_ncci = openDb('ncci.sqlite'))
}

export function getMueDb(): Database.Database | null {
  if (_mue !== undefined) return _mue
  return (_mue = openDb('mue.sqlite'))
}

export function getMpfsDb(): Database.Database | null {
  if (_mpfs !== undefined) return _mpfs
  return (_mpfs = openDb('mpfs.sqlite'))
}

export function getClfsDb(): Database.Database | null {
  if (_clfs !== undefined) return _clfs
  return (_clfs = openDb('clfs.sqlite'))
}

export function getAspDb(): Database.Database | null {
  if (_asp !== undefined) return _asp
  return (_asp = openDb('asp.sqlite'))
}

export function getOppsDb(): Database.Database | null {
  if (_opps !== undefined) return _opps
  return (_opps = openDb('opps.sqlite'))
}

export function getIppsDb(): Database.Database | null {
  if (_ipps !== undefined) return _ipps
  return (_ipps = openDb('ipps.sqlite'))
}

export function getDmeposDb(): Database.Database | null {
  if (_dmepos !== undefined) return _dmepos
  return (_dmepos = openDb('dmepos.sqlite'))
}

export function getAmbulanceDb(): Database.Database | null {
  if (_ambulance !== undefined) return _ambulance
  return (_ambulance = openDb('ambulance.sqlite'))
}

export function getHospitalDirectoryDb(): Database.Database | null {
  if (_hospitalDir !== undefined) return _hospitalDir
  return (_hospitalDir = openDb('hospital_directory.sqlite'))
}

/** Open a per-hospital pricing SQLite (converted from DuckDB). Returns null if not cached. */
export function getHospitalCacheDb(hospitalId: string): Database.Database | null {
  const safeName = hospitalId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)
  return openDb(join('hospital_cache', `${safeName}.sqlite`))
}

/** For writable access during script execution (not for server). */
export function openWritable(filename: string): Database.Database {
  const path = join(DATA_DIR, filename)
  return new Database(path)
}
```

- [ ] Run: `npm run check`
- [ ] Expected: no TypeScript errors

---

## Task 3: Create data-loader.ts (stub)

**File:** `src/lib/server/data-loader.ts`

This file will be filled in progressively by later steps. Create the stub now.

- [ ] Create `src/lib/server/data-loader.ts`:

```typescript
/**
 * data-loader.ts
 * Queries SQLite databases and returns typed data for the audit engine.
 * Later steps add implementations of each loader function.
 */

import type { BillType } from '$lib/types'

// ─── NCCI ────────────────────────────────────────────────────────────────────

export type NcciPairRow = {
  col1_code: string
  modifier_indicator: string  // '0' | '1' | '9'
  rationale: string | null
}

/**
 * Returns all active NCCI pairs where col2_code bundles into some col1_code,
 * filtered by bill type and service date.
 * serviceDateInt: YYYYMMDD integer. If 0, uses today.
 */
export function loadNcciPairs(
  col2Code: string,
  billType: BillType,
  serviceDateInt: number
): NcciPairRow[] {
  return []  // implemented in step-01
}

// ─── MUE ─────────────────────────────────────────────────────────────────────

export type MueRow = {
  hcpcs_code: string
  mue_value: number
  mue_adjudication_indicator: string  // '1' | '2' | '3'
  mue_rationale: string | null
}

export function loadMueEdit(
  hcpcsCode: string,
  billType: BillType
): MueRow | null {
  return null  // implemented in step-02
}

// ─── MPFS ────────────────────────────────────────────────────────────────────

export type MpfsRow = {
  hcpcs_code: string
  description: string | null
  status_code: string | null
  nonfac_rate: number | null
  fac_rate: number | null
}

export function loadMpfsRate(hcpcsCode: string): MpfsRow | null {
  return null  // implemented in step-03
}

// ─── CLFS ────────────────────────────────────────────────────────────────────

export type ClfsRow = {
  hcpcs_code: string
  rate: number
  description: string | null
  indicator: string | null
  eff_date: string | null
}

export function loadClfsRate(hcpcsCode: string): ClfsRow | null {
  return null  // implemented in step-04
}

// ─── ASP ─────────────────────────────────────────────────────────────────────

export type AspRow = {
  hcpcs_code: string
  payment_limit: number
  description: string | null
  dosage: string | null
}

export function loadAspLimit(hcpcsCode: string): AspRow | null {
  return null  // implemented in step-05
}

// ─── OPPS ────────────────────────────────────────────────────────────────────

export type OppsRow = {
  hcpcs_code: string
  short_descriptor: string | null
  status_indicator: string | null
  apc: string | null
  payment_rate: number | null
  apc_title: string | null
}

export function loadOppsRate(hcpcsCode: string, quarter?: string): OppsRow | null {
  return null  // implemented in step-06
}

// ─── IPPS ────────────────────────────────────────────────────────────────────

export type IppsRow = {
  ms_drg: string
  title: string | null
  relative_weight: number | null
  geometric_mean_los: number | null
  arithmetic_mean_los: number | null
}

export function loadDrgRate(drgCode: string, fiscalYear?: string): IppsRow | null {
  return null  // implemented in step-07
}

// ─── DMEPOS ──────────────────────────────────────────────────────────────────

export type DmeposRow = {
  hcpcs_code: string
  description: string | null
  mod: string | null
  mod2: string | null
  category: string | null
  ceiling: number | null
  floor: number | null
  state_code: string
  fee_amount: number | null
}

export function loadDmeposRate(hcpcsCode: string, stateCode: string): DmeposRow | null {
  return null  // implemented in step-08
}

// ─── Ambulance ───────────────────────────────────────────────────────────────

export type AmbulanceRow = {
  hcpcs_code: string
  short_description: string | null
  locality: string | null
  area_type: string | null
  base_rate: number | null
  mileage_rate: number | null
  rate_amount: number | null
}

export function loadAmbulanceRate(hcpcsCode: string, zipCode: string): AmbulanceRow | null {
  return null  // implemented in step-09
}
```

- [ ] Run: `npm run check`
- [ ] Expected: no errors

---

## Task 4: Helper — serviceDateToInt

Add a shared helper to convert service date strings to YYYYMMDD integers used in DB queries.

- [ ] Add to the bottom of `src/lib/server/data-loader.ts`:

```typescript
// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a date string (any format parseable by Date constructor, or YYYYMMDD)
 * to a YYYYMMDD integer for NCCI/MUE date comparisons.
 * Falls back to today if input is invalid or empty.
 */
export function toServiceDateInt(dateStr: string | undefined | null): number {
  if (dateStr) {
    // Already YYYYMMDD?
    const compact = dateStr.replace(/-/g, '')
    if (/^\d{8}$/.test(compact)) {
      const n = parseInt(compact, 10)
      if (n > 19000101 && n < 21000101) return n
    }
    // Try Date parse
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return parseInt(`${y}${m}${day}`, 10)
    }
  }
  // Fallback: today
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return parseInt(`${y}${m}${day}`, 10)
}
```

---

## Task 5: Write tests

**File:** `src/lib/server/data-loader.test.ts`

- [ ] Create `src/lib/server/data-loader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { toServiceDateInt } from './data-loader'

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
```

- [ ] Run: `npm run test -- data-loader`
- [ ] Expected: all tests pass

---

## Task 6: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/lib/types.ts src/lib/server/db.ts src/lib/server/data-loader.ts src/lib/server/data-loader.test.ts
git commit -m "feat: add sqlite infrastructure and data-loader stub"
```
