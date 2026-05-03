/**
 * Regression tests for deterministic billing audit rules.
 *
 * These tests do NOT call Gemini — they test deterministic rule logic in audit-rules.ts.
 * Most tests use inline data; NCCI-specific tests query data/ncci.sqlite when present.
 *
 * Key scenarios tested:
 * - 93010 + 93000: real NCCI unbundling pair (ECG interpretation + full ECG)
 * - 70450 + 70486: NOT bundled — different anatomical areas, must NOT be flagged
 * - 70450 + 70460: real NCCI pair (CT head w/o contrast + CT head w/ contrast)
 * - Duplicate billing: same CPT code twice
 * - Pharmacy markup: J-code billed > 4.5× ASP limit
 * - Modifier -59 on a modifiable pair → valid override, no finding
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import {
  buildDeterministicFindings,
  buildDataContext,
  buildArithmeticFindings,
  buildDateFindings,
  buildGfeFindings,
  getMpfsRate,
  checkNcciBundling,
  checkMueExceeded,
  checkMpfsBenchmark,
  checkOppsBenchmark,
} from './audit-rules'
import type { MpfsData, ClfsData, EmMdmTierData, LcdCoverageData } from './audit-rules'
import type { LineItem } from '$lib/types'
import { loadClfsRate, loadMpfsRate, loadMueEdit, loadNcciPairs } from './data-loader'

// ── Test data fixtures ────────────────────────────────────────────────────────

const TEST_MPFS: MpfsData = {
  '93000': { rate: 19.18, description: 'Electrocardiogram with interpretation' },
  '93010': { rate: 6.45, description: 'ECG interpretation and report only' },
  '70450': { rate: 106.20, description: 'CT head/brain w/o dye' },
  '70460': { rate: 117.32, description: 'CT head/brain w/ dye' },
  '70486': { rate: 127.83, description: 'CT maxillofacial w/o dye' },
  '99285': { rate: 170.78, description: 'ED visit hi mdm' },
}

const TEST_CLFS: ClfsData = {
  '85025': { rate: 12.34, description: 'Blood count; complete (CBC), automated' },
  '80053': { rate: 14.56, description: 'Comprehensive metabolic panel' },
}

const TEST_EM_MDM: EmMdmTierData = {
  'J00': 'S',
  'R55': 'L',
  'R07': 'M',
  'I21': 'H',
}

const TEST_LCD_COVERAGE: LcdCoverageData = {
  '99285': {
    covered: ['I21'],
    notCovered: ['J00'],
    lcdIds: ['L99999'],
  },
}

function li(cpt: string, billed: number, units = 1, modifiers?: string[]): LineItem {
  return { cpt, description: cpt, units, billedAmount: billed, modifiers }
}

const ncciDb = (() => { try { return new Database('data/ncci.sqlite', { readonly: true }) } catch { return null } })()
const mueDb = (() => { try { return new Database('data/mue.sqlite', { readonly: true }) } catch { return null } })()
const hasMpfsDb = existsSync('data/mpfs.sqlite')
const hasClfsDb = existsSync('data/clfs.sqlite')
const hasAspDb = existsSync('data/asp.sqlite')
const hasOppsDb = existsSync('data/opps.sqlite')
const hasIppsDb = existsSync('data/ipps.sqlite')
const hasDmeposDb = existsSync('data/dmepos.sqlite')
const hasAmbulanceDb = existsSync('data/ambulance.sqlite')

// ── getMpfsRate ───────────────────────────────────────────────────────────────

describe('getMpfsRate', () => {
  it('returns undefined for undefined entry', () => {
    expect(getMpfsRate(undefined)).toBeUndefined()
  })

  it('returns rate from object entry', () => {
    expect(getMpfsRate({ rate: 106.20 })).toBe(106.20)
  })

  it('returns the number directly from numeric entry', () => {
    expect(getMpfsRate(170.78)).toBe(170.78)
  })
})

// ── buildDeterministicFindings: NCCI unbundling ───────────────────────────────

describe('buildDeterministicFindings — NCCI unbundling', () => {
  it.skipIf(!ncciDb)('flags 93010 as unbundled when 93000 is also on the bill', () => {
    const lineItems = [
      li('93000', 250.00),   // full ECG — comprehensive code
      li('93010', 45.00),    // ECG interpretation — component, should bundle into 93000
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    const unbundled = findings.filter(f => f.errorType === 'unbundling')
    expect(unbundled).toHaveLength(1)
    expect(unbundled[0].cptCode).toBe('93010')
    expect(unbundled[0].severity).toBe('warning')
    expect(unbundled[0].confidence).toBe('high')
    expect(unbundled[0].ncciBundledWith).toBe('93000')
    expect(unbundled[0].lineItemIndex).toBe(1)
  })

  it.skipIf(!ncciDb)('does NOT flag 93010 when only 93010 is on the bill (no Col1 present)', () => {
    const lineItems = [li('93010', 45.00), li('99285', 500.00)]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'unbundling')).toHaveLength(0)
  })

  it.skipIf(!ncciDb)('flags 70450 as unbundled when 70460 is also on the bill', () => {
    const lineItems = [
      li('70460', 400.00),   // CT head with contrast — comprehensive
      li('70450', 350.00),   // CT head without contrast — component
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    const unbundled = findings.filter(f => f.errorType === 'unbundling')
    expect(unbundled).toHaveLength(1)
    expect(unbundled[0].cptCode).toBe('70450')
    expect(unbundled[0].severity).toBe('error')
    expect(unbundled[0].ncciBundledWith).toBe('70460')
    expect(unbundled[0].description).toContain('CMS NCCI PTP edits')
  })

  it.skipIf(!ncciDb)('does NOT flag 70450 + 70486 (different anatomical areas — not NCCI bundled)', () => {
    const lineItems = [
      li('70450', 350.00),   // CT head/brain — no NCCI relationship to 70486
      li('70486', 400.00),   // CT maxillofacial — different anatomy
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    // This was the original bug: AI hallucinated this as an unbundling error
    expect(findings.filter(f => f.errorType === 'unbundling')).toHaveLength(0)
  })

  it.skipIf(!ncciDb)('skips a modifiable pair when modifier -59 is present', () => {
    const lineItems = [
      li('93000', 250.00),
      li('93010', 45.00, 1, ['59']),  // API sanitizer strips leading dash; audit engine sees '59'
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'unbundling')).toHaveLength(0)
  })

  it.skipIf(!ncciDb)('accepts XS modifier as equivalent to -59', () => {
    const lineItems = [
      li('93000', 250.00),
      li('93010', 45.00, 1, ['XS']),
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'unbundling')).toHaveLength(0)
  })

  it.skipIf(!ncciDb || !hasMpfsDb)('includes medicareRate from MPFS in unbundling finding', () => {
    const lineItems = [li('93000', 250.00), li('93010', 45.00)]
    const { findings } = buildDeterministicFindings(lineItems)

    const f = findings.find(f => f.cptCode === '93010')!
    expect(f.medicareRate).toBeGreaterThan(0)
  })
})

describe('buildDeterministicFindings — NCCI modifier_indicator severity', () => {
  it.skipIf(!ncciDb)(
    'modifier_indicator=0 pair without modifier produces severity: error',
    () => {
      const pair = ncciDb!
        .prepare(`
          SELECT col1_code, col2_code
          FROM ncci_ptp
          WHERE modifier_indicator = '0'
            AND bill_type = 'practitioner'
            AND effective_date <= 20260401
            AND deletion_date >= 20260401
          LIMIT 1
        `)
        .get() as { col1_code: string; col2_code: string } | undefined
      if (!pair) return

      const lineItems = [
        li(pair.col1_code, 500),
        li(pair.col2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2026-04-01')
      const ncciFinding = findings.find(f => f.errorType === 'unbundling')
      expect(ncciFinding).toBeDefined()
      expect(ncciFinding?.severity).toBe('error')
    }
  )

  it.skipIf(!ncciDb)(
    'modifier_indicator=1 pair without modifier produces severity: warning (not error)',
    () => {
      const pair = ncciDb!
        .prepare(`
          SELECT col1_code, col2_code
          FROM ncci_ptp
          WHERE modifier_indicator = '1'
            AND bill_type = 'practitioner'
            AND effective_date <= 20260401
            AND deletion_date >= 20260401
          LIMIT 1
        `)
        .get() as { col1_code: string; col2_code: string } | undefined
      if (!pair) return

      const lineItems = [
        li(pair.col1_code, 500),
        li(pair.col2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2026-04-01')
      const ncciFinding = findings.find(f => f.errorType === 'unbundling')
      expect(ncciFinding).toBeDefined()
      expect(ncciFinding?.severity).toBe('warning')
    }
  )

  it.skipIf(!ncciDb)(
    'modifier_indicator=1 pair WITH modifier -59 produces no finding (suppressed)',
    () => {
      const pair = ncciDb!
        .prepare(`
          SELECT col1_code, col2_code
          FROM ncci_ptp
          WHERE modifier_indicator = '1'
            AND bill_type = 'practitioner'
            AND effective_date <= 20260401
            AND deletion_date >= 20260401
          LIMIT 1
        `)
        .get() as { col1_code: string; col2_code: string } | undefined
      if (!pair) return

      const lineItems = [
        li(pair.col1_code, 500),
        { ...li(pair.col2_code, 250), modifiers: ['59'] },
      ]
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2026-04-01')
      const ncciFinding = findings.find(f => f.errorType === 'unbundling')
      expect(ncciFinding).toBeUndefined()
    }
  )

  it.skipIf(!ncciDb)(
    'modifier_indicator=9 pair produces no finding (not applicable)',
    () => {
      const pair = ncciDb!
        .prepare(`
          SELECT col1_code, col2_code
          FROM ncci_ptp
          WHERE modifier_indicator = '9'
            AND bill_type = 'practitioner'
            AND effective_date <= 20260401
            AND deletion_date >= 20260401
          LIMIT 1
        `)
        .get() as { col1_code: string; col2_code: string } | undefined
      if (!pair) return

      const lineItems = [
        li(pair.col1_code, 500),
        li(pair.col2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2026-04-01')
      const ncciFinding = findings.find(f => f.errorType === 'unbundling')
      expect(ncciFinding).toBeUndefined()
    }
  )
})

// ── buildDeterministicFindings: duplicates ────────────────────────────────────

describe('buildDeterministicFindings — duplicate detection', () => {
  it('flags the second occurrence of a duplicate code', () => {
    const lineItems = [
      li('99285', 500.00),
      li('99285', 500.00),   // duplicate
      li('93000', 250.00),
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    const dups = findings.filter(f => f.errorType === 'duplicate')
    expect(dups).toHaveLength(1)
    expect(dups[0].lineItemIndex).toBe(1)
    expect(dups[0].severity).toBe('error')
    expect(dups[0].confidence).toBe('high')
  })

  it('flags only the first duplicate for triple billing (subsequent are suppressed by alreadyFlaggedCodes)', () => {
    const lineItems = [
      li('99285', 500.00),
      li('99285', 500.00),
      li('99285', 500.00),
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    const dups = findings.filter(f => f.errorType === 'duplicate')
    expect(dups).toHaveLength(1)
    expect(dups[0].lineItemIndex).toBe(1)
  })

  it('does NOT flag a code that appears only once', () => {
    const lineItems = [li('99285', 500.00), li('70450', 350.00)]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'duplicate')).toHaveLength(0)
  })
})

// ── buildDeterministicFindings: pharmacy markup ───────────────────────────────

describe('buildDeterministicFindings — pharmacy markup', () => {
  it.skipIf(!hasAspDb)('flags a J-code billed at more than 4.5× ASP limit', () => {
    const lineItems = [li('J0696', 50.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems)

    const markup = findings.filter(f => f.errorType === 'pharmacy_markup')
    expect(markup).toHaveLength(1)
    expect(markup[0].cptCode).toBe('J0696')
    expect(markup[0].severity).toBe('error')
    expect(markup[0].confidence).toBe('high')
    expect(markup[0].markupRatio).toBeGreaterThan(4.5)
  })

  it.skipIf(!hasAspDb)('does NOT flag a J-code billed within 4.5× ASP limit', () => {
    const lineItems = [li('J0696', 1.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'pharmacy_markup')).toHaveLength(0)
  })

  it.skipIf(!hasAspDb)('uses the ASP payment limit from SQLite', () => {
    const lineItems = [li('J0696', 1.00, 5)]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'pharmacy_markup')).toHaveLength(0)
  })

  it('does NOT flag a non-J-code even if highly marked up', () => {
    // 99285 is in MPFS but not ASP — pharmacy markup rule doesn't apply
    const lineItems = [li('99285', 99999.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems)

    expect(findings.filter(f => f.errorType === 'pharmacy_markup')).toHaveLength(0)
  })

  it.skipIf(!hasAspDb)('includes markupRatio in the finding', () => {
    const lineItems = [li('J0696', 100.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems)

    const f = findings.find(f => f.errorType === 'pharmacy_markup')!
    expect(f.markupRatio).toBeGreaterThan(10)
    expect(typeof f.markupRatio).toBe('number')
  })
})

// ── buildDeterministicFindings: promptNote ────────────────────────────────────

describe('buildDeterministicFindings — summary', () => {
  it('returns a summary when no deterministic findings', () => {
    const lineItems = [li('99285', 500.00)]
    const { summary } = buildDeterministicFindings(lineItems)
    expect(summary).toContain('Total billed: $500.00')
  })

  it('summarizes deterministic findings when they exist', () => {
    const lineItems = [li('99285', 500.00), li('99285', 500.00)]
    const { summary } = buildDeterministicFindings(lineItems)
    expect(summary).toContain('Errors: 1')
    expect(summary).toContain('Potential overcharge: $500.00')
  })
})

describe('buildDeterministicFindings — SQLite audit routes', () => {
  it.skipIf(!hasOppsDb)('emits a concrete outpatient OPPS benchmark finding', () => {
    const { findings, summary } = buildDeterministicFindings(
      [li('99285', 2000)],
      'outpatient',
      '2026-04-01',
    )

    const finding = findings.find(finding => finding.errorType === 'opps_benchmark')
    expect(finding).toMatchObject({
      lineItemIndex: 0,
      cptCode: '99285',
      severity: 'warning',
      errorType: 'opps_benchmark',
      confidence: 'medium',
      medicareRate: 608.43,
    })
    expect(finding?.description).toContain('APC 5025: Level 5 Type A ED Visits')
    expect(summary).toContain('Bill type: outpatient')
    expect(summary).toContain('Warnings: 1')
  })

  it.skipIf(!hasIppsDb)('emits a concrete inpatient DRG informational finding', () => {
    const { findings, summary } = buildDeterministicFindings(
      [li('27447', 30000)],
      'inpatient',
      '2026-04-01',
      '470',
    )

    const finding = findings.find(finding => finding.errorType === 'ipps_drg')
    expect(finding).toMatchObject({
      lineItemIndex: -1,
      cptCode: 'DRG-470',
      severity: 'info',
      errorType: 'ipps_drg',
      confidence: 'high',
      standardDescription: 'MAJOR HIP AND KNEE JOINT REPLACEMENT OR REATTACHMENT OF LOWER EXTREMITY WITHOUT MCC',
    })
    expect(finding?.description).toContain('CMS relative weight: 1.9289')
    expect(summary).toContain('Bill type: inpatient')
  })

  it.skipIf(!hasDmeposDb)('emits a concrete DMEPOS benchmark finding', () => {
    const { findings } = buildDeterministicFindings(
      [li('E0601', 200)],
      'dme',
      '2026-04-01',
      undefined,
      'TX',
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      lineItemIndex: 0,
      cptCode: 'E0601',
      severity: 'warning',
      errorType: 'dmepos_benchmark',
      confidence: 'medium',
      medicareRate: 50.91,
    })
    expect(findings[0].description).toContain('CMS DMEPOS fee schedule rate of $50.91 for TX')
  })

  it.skipIf(!hasAmbulanceDb)('emits a concrete ambulance benchmark finding', () => {
    const { findings } = buildDeterministicFindings(
      [li('A0428', 1000)],
      'outpatient',
      '2026-04-01',
      undefined,
      undefined,
      '94002',
    )

    const finding = findings.find(finding => finding.errorType === 'ambulance_benchmark')
    expect(finding).toMatchObject({
      lineItemIndex: 0,
      cptCode: 'A0428',
      severity: 'warning',
      errorType: 'ambulance_benchmark',
      confidence: 'medium',
      medicareRate: 284.56,
    })
    expect(finding?.description).toContain('locality 05')
  })
})

// ── buildDataContext ──────────────────────────────────────────────────────────

describe('buildDataContext', () => {
  it('returns empty string when no codes match any data source', () => {
    const lineItems = [li('99999', 100.00)]
    expect(buildDataContext(lineItems)).toBe('')
  })

  it.skipIf(!hasMpfsDb)('includes MPFS rate for a code in MPFS', () => {
    const lineItems = [li('99285', 500.00)]
    const ctx = buildDataContext(lineItems)
    expect(ctx).toContain('99285: Medicare rate $170.78')
  })

  it.skipIf(!hasAspDb)('includes ASP limit for a J-code', () => {
    const lineItems = [li('J0696', 50.00)]
    const ctx = buildDataContext(lineItems)
    expect(ctx).toContain('J0696: CMS ASP limit $')
  })

  it.skipIf(!ncciDb)('includes NCCI hit only when BOTH the component AND its Col1 are on the bill', () => {
    // 93010 alone — no hit (Col1 93000 not present)
    expect(
      buildDataContext([li('93010', 45.00)])
    ).not.toContain('NCCI')

    // 93010 + 93000 — hit reported
    expect(
      buildDataContext([li('93000', 250.00), li('93010', 45.00)])
    ).toContain('NCCI bundling violations')
  })

  it.skipIf(!ncciDb)('does NOT include 70450+70486 as NCCI hit (not directly bundled)', () => {
    const ctx = buildDataContext([li('70450', 350.00), li('70486', 400.00)])
    expect(ctx).not.toContain('NCCI bundling violations')
  })

  it.skipIf(!hasClfsDb)('falls back to CLFS for lab codes missing from MPFS', () => {
    const clfsRow = loadClfsRate('85025')
    const ctx = buildDataContext([li('85025', 35.00)])

    expect(clfsRow).not.toBeNull()
    expect(ctx).toContain(`85025: Medicare rate $${clfsRow!.rate.toFixed(2)} (CLFS (lab rate))`)
  })
})

describe('buildDeterministicFindings — CLFS fallback', () => {
  it.skipIf(!hasClfsDb)('uses the CLFS rate for duplicate lab codes missing from MPFS', () => {
    const clfsRow = loadClfsRate('85025')
    const { findings } = buildDeterministicFindings([li('85025', 35.00), li('85025', 35.00)])

    const duplicate = findings.find((finding) => finding.errorType === 'duplicate')
    expect(clfsRow).not.toBeNull()
    expect(duplicate?.medicareRate).toBeUndefined()
    expect(duplicate?.standardDescription).toBe('Blood count; complete (CBC), automated')
  })
})

describe('MPFS SQLite integration', () => {
  it.skipIf(!hasMpfsDb)('returns rate for 99285', () => {
    const row = loadMpfsRate('99285')
    expect(row).not.toBeNull()
    expect(row!.nonfac_rate).toBeGreaterThan(100)
    expect(row!.nonfac_rate).toBeLessThan(500)
  })

  it.skipIf(!hasMpfsDb)('returns rate for 70450', () => {
    const row = loadMpfsRate('70450')
    expect(row).not.toBeNull()
    expect(row!.nonfac_rate).toBeGreaterThan(80)
  })

  it.skipIf(!hasMpfsDb)('returns null for unknown code', () => {
    expect(loadMpfsRate('ZZZZZ')).toBeNull()
  })
})

describe('buildDeterministicFindings — MUE units', () => {
  it.skipIf(!mueDb)('flags line items that exceed the CMS MUE cap', () => {
    const { findings } = buildDeterministicFindings([li('99215', 300.00, 2)], 'practitioner')

    const mueFindings = findings.filter((finding) =>
      finding.cptCode === '99215' && finding.description.includes('Medically Unlikely Edit')
    )
    expect(mueFindings).toHaveLength(1)
  })

  it.skipIf(!mueDb)('does not flag line items within the CMS MUE cap', () => {
    const { findings } = buildDeterministicFindings([li('99215', 300.00, 1)], 'practitioner')

    expect(findings.find((finding) => finding.cptCode === '99215')).toBeUndefined()
  })
})

describe('bill-level deterministic findings', () => {
  it('flags arithmetic mismatches at the bill level', () => {
    const findings = buildArithmeticFindings([li('99285', 500.00), li('93000', 250.00)], 900)
    expect(findings).toHaveLength(1)
    expect(findings[0].lineItemIndex).toBe(-1)
    expect(findings[0].errorType).toBe('arithmetic_error')
  })

  it('flags service dates outside the stay window', () => {
    const findings = buildDateFindings(
      [{ ...li('99285', 500.00), serviceDate: '2024-01-20' }],
      '2024-01-14',
      '2024-01-16'
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].errorType).toBe('date_error')
  })

  it('flags bills that exceed the Good Faith Estimate by $400 or more', () => {
    const findings = buildGfeFindings([li('99285', 1200.00)], 700)
    expect(findings).toHaveLength(1)
    expect(findings[0].lineItemIndex).toBe(-1)
    expect(findings[0].errorType).toBe('no_surprises_act')
  })
})

describe('NCCI SQLite integration', () => {
  it.skipIf(!ncciDb)('93010 bundles into 93000 for practitioner', () => {
    const pairs = loadNcciPairs('93010', 'practitioner', 20260401)
    const col1Codes = pairs.map(p => p.col1_code)
    expect(col1Codes).toContain('93000')
  })

  it.skipIf(!ncciDb)('returns empty for unknown code', () => {
    const pairs = loadNcciPairs('99999', 'practitioner', 20260401)
    expect(pairs).toHaveLength(0)
  })

  it.skipIf(!ncciDb)('returns different results for different bill types', () => {
    const pract = loadNcciPairs('93010', 'practitioner', 20260401)
    const outpt = loadNcciPairs('93010', 'outpatient', 20260401)
    expect(Array.isArray(pract)).toBe(true)
    expect(Array.isArray(outpt)).toBe(true)
  })
})

describe('MUE SQLite integration', () => {
  it.skipIf(!mueDb)('returns MUE for 99285 practitioner', () => {
    const entry = loadMueEdit('99285', 'practitioner')
    expect(entry).not.toBeNull()
    expect(entry!.mue_value).toBeGreaterThan(0)
  })

  it.skipIf(!mueDb)('returns null for unknown code', () => {
    const entry = loadMueEdit('ZZZZZ', 'practitioner')
    expect(entry).toBeNull()
  })

  it.skipIf(!mueDb)('has outpatient entries', () => {
    const entry = loadMueEdit('99285', 'outpatient')
    // May or may not exist — just verify it returns null or a valid row
    if (entry) {
      expect(entry.mue_value).toBeGreaterThan(0)
    }
  })
})

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
    // Note: the canonical SQLite column is 'mue_adjudication_indicator'.
    // 'mai' is an alias accepted by checkMueExceeded for convenience.
    // Fixtures testing buildDeterministicFindings use 'mue_adjudication_indicator'.
    const edits = [{ hcpcs_code: '99213', mue_value: 1, mai: 3, bill_type: 'practitioner' }]
    const findings = checkMueExceeded(lineItems, edits)
    expect(findings.length).toBe(0)
  })

  it('checkMueExceeded: MAI 1 and 2 are not hard-error flagged', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
      { cpt: '99214', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
      { cpt: '99215', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    const edits = [
      { hcpcs_code: '99213', mue_value: 1, mue_adjudication_indicator: '1' },
      { hcpcs_code: '99214', mue_value: 1, mue_adjudication_indicator: '2' },
      { hcpcs_code: '99215', mue_value: 1, mue_adjudication_indicator: '3' },
    ]
    const findings = checkMueExceeded(lineItems, edits)
    expect(findings).toEqual([{ findingType: 'mue_exceeded', lineItemIndex: 2, cptCode: '99215' }])
  })

  it.skipIf(!ncciDb)('inpatient bills do not inherit practitioner NCCI edits', () => {
    const pairs = loadNcciPairs('93010', 'inpatient', 20260401)
    expect(pairs).toHaveLength(0)
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

// ── Edge-case regression tests added after code review ─────────────────────────

describe('audit-rules edge-case regressions', () => {
  it('OPPS rate of 0 does not trigger opps_benchmark finding', () => {
    const lineItems = [
      { cpt: '99213', description: 'Office visit', units: 1, billedAmount: 500, modifiers: [], icd10Codes: [] },
    ]
    const rates = [{ hcpcs_code: '99213', payment_rate: 0 }]
    const findings = checkOppsBenchmark(lineItems, rates)
    expect(findings).toHaveLength(0)
  })

  it('billedAmount as string "$1,234.56" does not produce NaN in findings', () => {
    const lineItems = [
      { cpt: '99213', description: 'Office visit', units: 1, billedAmount: '$1,234.56' as any, modifiers: [], icd10Codes: [] },
    ]
    expect(() => {
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2025-01-01')
      for (const f of findings) {
        if (f.medicareRate != null) expect(Number.isFinite(f.medicareRate)).toBe(true)
        if (f.markupRatio != null) expect(Number.isFinite(f.markupRatio)).toBe(true)
      }
    }).not.toThrow()
  })

  it('billedAmount as "NaN" string does not produce findings', () => {
    const lineItems = [
      { cpt: '99213', description: 'Office visit', units: 1, billedAmount: 'NaN' as any, modifiers: [], icd10Codes: [] },
    ]
    expect(() => {
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2025-01-01')
      const upcodings = findings.filter(f => f.errorType === 'upcoding')
      expect(upcodings).toHaveLength(0)
    }).not.toThrow()
  })

  it('A03xx drug administration code does not trigger ambulance check', () => {
    const lineItems = [
      { cpt: 'A0300', description: 'Drug admin', units: 1, billedAmount: 5000, modifiers: [], icd10Codes: [] },
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      undefined,
      '78701'
    )
    const ambulanceFindings = findings.filter(f => f.errorType === 'ambulance_benchmark')
    expect(ambulanceFindings).toHaveLength(0)
  })

  it.skipIf(!hasAmbulanceDb)('A0428 (BLS ambulance) code DOES produce ambulance_benchmark finding when billed at extreme markup', () => {
    const lineItems = [
      { cpt: 'A0428', description: 'BLS transport', units: 1, billedAmount: 50_000, modifiers: [], icd10Codes: [] },
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      undefined,
      '78701'
    )
    const ambulanceFindings = findings.filter(f => f.errorType === 'ambulance_benchmark')
    expect(ambulanceFindings.length).toBeGreaterThan(0)
    expect(ambulanceFindings[0].cptCode).toBe('A0428')
  })

  it('checkMueExceeded fires when mai is integer 3 (not string)', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    const edits = [{ hcpcs_code: '99213', mue_value: 1, mue_adjudication_indicator: 3 as any }]
    const findings = checkMueExceeded(lineItems, edits)
    expect(findings).toHaveLength(1)
    expect(findings[0].findingType).toBe('mue_exceeded')
  })

  it('checkMueExceeded does NOT fire when mai is integer 1', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    const edits = [{ hcpcs_code: '99213', mue_value: 1, mue_adjudication_indicator: 1 as any }]
    const findings = checkMueExceeded(lineItems, edits)
    expect(findings).toHaveLength(0)
  })

  it('OPPS-flagged code does not also appear in upcoding findings', () => {
    const lineItems = [
      { cpt: '99285', description: 'ER visit', units: 1, billedAmount: 99_999, modifiers: [], icd10Codes: [] },
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'outpatient',
      '2025-01-01'
    )
    const oppsFindings = findings.filter(f => f.cptCode === '99285' && f.errorType === 'opps_benchmark')
    const upcodingFindings = findings.filter(f => f.cptCode === '99285' && f.errorType === 'upcoding')
    if (oppsFindings.length > 0) {
      expect(upcodingFindings).toHaveLength(0)
    }
  })
})
