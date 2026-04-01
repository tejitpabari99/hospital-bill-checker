/**
 * Regression tests for deterministic billing audit rules.
 *
 * These tests do NOT call Gemini — they test the pure rule-lookup logic in audit-rules.ts
 * using inline test data. They serve as a regression guard so that CMS rule changes
 * or code refactors can't silently break billing audit accuracy.
 *
 * Key scenarios tested:
 * - 93010 + 93000: real NCCI unbundling pair (ECG interpretation + full ECG)
 * - 70450 + 70486: NOT bundled — different anatomical areas, must NOT be flagged
 * - 70450 + 70460: real NCCI pair (CT head w/o contrast + CT head w/ contrast)
 * - Duplicate billing: same CPT code twice
 * - Pharmacy markup: J-code billed > 4.5× ASP limit
 * - Modifier -59 on a modifiable pair → warning, not error
 * - Modifier -59 on a non-modifiable pair → still error
 */

import { describe, expect, it } from 'vitest'
import {
  buildDeterministicFindings,
  buildDataContext,
  buildArithmeticFindings,
  buildDateFindings,
  buildGfeFindings,
  getNcciEntry,
  getMpfsRate,
} from './audit-rules'
import type { NcciData, MpfsData, AspData, ClfsData, MueData, EmMdmTierData } from './audit-rules'
import type { LineItem } from '$lib/types'

// ── Test data fixtures ────────────────────────────────────────────────────────

/**
 * Minimal NCCI dataset covering the key pairs tested.
 * Mirrors the real CMS NCCI format (from ncci.json after build).
 *
 * 93010 bundles into 93000 (ECG interpretation into full ECG) — modifierCanOverride: true
 * 70450 bundles into 70460 (CT head w/o contrast into CT head w/ contrast) — modifierCanOverride: false
 * 70450 does NOT bundle into 70486 (different anatomical areas)
 */
const TEST_NCCI: NcciData = {
  '93010': { bundledInto: ['93000', '93005'], modifierCanOverride: true },
  '70450': { bundledInto: ['70460', '70470', '70496'], modifierCanOverride: false },
  '70486': { bundledInto: ['70487', '70488'], modifierCanOverride: false },
}

const TEST_MPFS: MpfsData = {
  '93000': { rate: 19.18, description: 'Electrocardiogram with interpretation' },
  '93010': { rate: 6.45, description: 'ECG interpretation and report only' },
  '70450': { rate: 106.20, description: 'CT head/brain w/o dye' },
  '70460': { rate: 117.32, description: 'CT head/brain w/ dye' },
  '70486': { rate: 127.83, description: 'CT maxillofacial w/o dye' },
  '99285': { rate: 170.78, description: 'ED visit hi mdm' },
}

const TEST_ASP: AspData = {
  'J0696': 1.45,    // ceftriaxone — 1 unit
  'J9035': 694.89,  // bevacizumab — 10mg
}

const TEST_CLFS: ClfsData = {
  '85025': { rate: 12.34, description: 'Blood count; complete (CBC), automated' },
  '80053': { rate: 14.56, description: 'Comprehensive metabolic panel' },
}

const TEST_MUE: MueData = {
  '99215': { maxUnits: 1, adjudicationType: 'date_of_service' },
  '36415': { maxUnits: 3, adjudicationType: 'claim_line' },
}

const TEST_EM_MDM: EmMdmTierData = {
  'J00': 'S',
  'R55': 'L',
  'R07': 'M',
  'I21': 'H',
}

function li(cpt: string, billed: number, units = 1, modifiers?: string[]): LineItem {
  return { cpt, description: cpt, units, billedAmount: billed, modifiers }
}

// ── getNcciEntry ──────────────────────────────────────────────────────────────

describe('getNcciEntry', () => {
  it('returns null for a code not in NCCI', () => {
    expect(getNcciEntry('99285', TEST_NCCI)).toBeNull()
  })

  it('returns bundledInto array for a known component code', () => {
    const entry = getNcciEntry('93010', TEST_NCCI)
    expect(entry).not.toBeNull()
    expect(entry?.bundledInto).toContain('93000')
    expect(entry?.bundledInto).toContain('93005')
  })

  it('handles legacy string format (single col1 stored as string)', () => {
    const legacyNcci: NcciData = { '93010': '93000' }
    const entry = getNcciEntry('93010', legacyNcci)
    expect(entry?.bundledInto).toEqual(['93000'])
    expect(entry?.modifierCanOverride).toBe(true)
  })
})

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
  it('flags 93010 as unbundled when 93000 is also on the bill', () => {
    const lineItems = [
      li('93000', 250.00),   // full ECG — comprehensive code
      li('93010', 45.00),    // ECG interpretation — component, should bundle into 93000
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const unbundled = findings.filter(f => f.errorType === 'unbundling')
    expect(unbundled).toHaveLength(1)
    expect(unbundled[0].cptCode).toBe('93010')
    expect(unbundled[0].severity).toBe('error')
    expect(unbundled[0].confidence).toBe('high')
    expect(unbundled[0].ncciBundledWith).toBe('93000')
    expect(unbundled[0].lineItemIndex).toBe(1)
  })

  it('does NOT flag 93010 when only 93010 is on the bill (no Col1 present)', () => {
    const lineItems = [li('93010', 45.00), li('99285', 500.00)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    expect(findings.filter(f => f.errorType === 'unbundling')).toHaveLength(0)
  })

  it('flags 70450 as unbundled when 70460 is also on the bill (modifierCanOverride=false)', () => {
    const lineItems = [
      li('70460', 400.00),   // CT head with contrast — comprehensive
      li('70450', 350.00),   // CT head without contrast — component
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const unbundled = findings.filter(f => f.errorType === 'unbundling')
    expect(unbundled).toHaveLength(1)
    expect(unbundled[0].cptCode).toBe('70450')
    expect(unbundled[0].severity).toBe('error')
    expect(unbundled[0].ncciBundledWith).toBe('70460')
    // No modifier can override this
    expect(unbundled[0].description).toContain('No modifier can override this rule')
  })

  it('does NOT flag 70450 + 70486 (different anatomical areas — not NCCI bundled)', () => {
    const lineItems = [
      li('70450', 350.00),   // CT head/brain — no NCCI relationship to 70486
      li('70486', 400.00),   // CT maxillofacial — different anatomy
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    // This was the original bug: AI hallucinated this as an unbundling error
    expect(findings.filter(f => f.errorType === 'unbundling')).toHaveLength(0)
  })

  it('returns warning (not error) when modifier -59 is present on a modifiable pair', () => {
    const lineItems = [
      li('93000', 250.00),
      li('93010', 45.00, 1, ['-59']),  // has modifier -59; 93010/93000 is modifiable
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const unbundled = findings.filter(f => f.errorType === 'unbundling')
    expect(unbundled).toHaveLength(1)
    expect(unbundled[0].severity).toBe('warning')
    expect(unbundled[0].description).toContain('modifier -59')
  })

  it('still returns error when modifier -59 is present but modifierCanOverride=false', () => {
    const lineItems = [
      li('70460', 400.00),
      li('70450', 350.00, 1, ['-59']),  // modifier -59 but 70450/70460 has modifierCanOverride=false
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const unbundled = findings.filter(f => f.errorType === 'unbundling')
    expect(unbundled).toHaveLength(1)
    expect(unbundled[0].severity).toBe('error')
  })

  it('accepts XS modifier as equivalent to -59', () => {
    const lineItems = [
      li('93000', 250.00),
      li('93010', 45.00, 1, ['XS']),
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    expect(findings[0].severity).toBe('warning')  // XS treated same as -59
  })

  it('includes medicareRate from MPFS in unbundling finding', () => {
    const lineItems = [li('93000', 250.00), li('93010', 45.00)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const f = findings.find(f => f.cptCode === '93010')!
    expect(f.medicareRate).toBe(6.45)
  })
})

// ── buildDeterministicFindings: duplicates ────────────────────────────────────

describe('buildDeterministicFindings — duplicate detection', () => {
  it('flags the second occurrence of a duplicate code', () => {
    const lineItems = [
      li('99285', 500.00),
      li('99285', 500.00),   // duplicate
      li('93000', 250.00),
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const dups = findings.filter(f => f.errorType === 'duplicate')
    expect(dups).toHaveLength(1)
    expect(dups[0].lineItemIndex).toBe(1)
    expect(dups[0].severity).toBe('error')
    expect(dups[0].confidence).toBe('high')
  })

  it('flags all extra occurrences for triple billing', () => {
    const lineItems = [
      li('99285', 500.00),
      li('99285', 500.00),
      li('99285', 500.00),
    ]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const dups = findings.filter(f => f.errorType === 'duplicate')
    expect(dups).toHaveLength(2)
  })

  it('does NOT flag a code that appears only once', () => {
    const lineItems = [li('99285', 500.00), li('70450', 350.00)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    expect(findings.filter(f => f.errorType === 'duplicate')).toHaveLength(0)
  })
})

// ── buildDeterministicFindings: pharmacy markup ───────────────────────────────

describe('buildDeterministicFindings — pharmacy markup', () => {
  it('flags a J-code billed at more than 4.5× ASP limit', () => {
    // J0696 ASP = $1.45/unit, allowed = 1.45 × 1 × 1.06 = $1.537
    // 4.5× threshold = $6.917 — bill at $50 to trigger
    const lineItems = [li('J0696', 50.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const markup = findings.filter(f => f.errorType === 'pharmacy_markup')
    expect(markup).toHaveLength(1)
    expect(markup[0].cptCode).toBe('J0696')
    expect(markup[0].severity).toBe('error')
    expect(markup[0].confidence).toBe('high')
    expect(markup[0].markupRatio).toBeGreaterThan(4.5)
  })

  it('does NOT flag a J-code billed within 4.5× ASP limit', () => {
    // J0696: allowed = 1.537, 4.5× = 6.917, bill at $5 — under threshold
    const lineItems = [li('J0696', 5.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    expect(findings.filter(f => f.errorType === 'pharmacy_markup')).toHaveLength(0)
  })

  it('accounts for units in the markup calculation', () => {
    // J0696 billed at $8 for 5 units: allowed = 1.45 × 5 × 1.06 = $7.685
    // 4.5× threshold = $34.58 — $8 is well under threshold
    const lineItems = [li('J0696', 8.00, 5)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    expect(findings.filter(f => f.errorType === 'pharmacy_markup')).toHaveLength(0)
  })

  it('does NOT flag a non-J-code even if highly marked up', () => {
    // 99285 is in MPFS but not ASP — pharmacy markup rule doesn't apply
    const lineItems = [li('99285', 99999.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    expect(findings.filter(f => f.errorType === 'pharmacy_markup')).toHaveLength(0)
  })

  it('includes markupRatio in the finding', () => {
    const lineItems = [li('J0696', 100.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)

    const f = findings.find(f => f.errorType === 'pharmacy_markup')!
    expect(f.markupRatio).toBeGreaterThan(10)
    expect(typeof f.markupRatio).toBe('number')
  })
})

// ── buildDeterministicFindings: promptNote ────────────────────────────────────

describe('buildDeterministicFindings — promptNote', () => {
  it('returns empty promptNote when no deterministic findings', () => {
    const lineItems = [li('99285', 500.00)]
    const { promptNote } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)
    expect(promptNote).toBe('')
  })

  it('returns non-empty promptNote when deterministic findings exist', () => {
    const lineItems = [li('93000', 250.00), li('93010', 45.00)]
    const { promptNote } = buildDeterministicFindings(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)
    expect(promptNote).toContain('CONFIRMED by deterministic CMS rule lookup')
    expect(promptNote).toContain('93010')
    expect(promptNote).toContain('unbundling')
  })
})

// ── buildDataContext ──────────────────────────────────────────────────────────

describe('buildDataContext', () => {
  it('returns empty string when no codes match any data source', () => {
    const lineItems = [li('99999', 100.00)]
    expect(buildDataContext(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)).toBe('')
  })

  it('includes MPFS rate for a code in MPFS', () => {
    const lineItems = [li('99285', 500.00)]
    const ctx = buildDataContext(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)
    expect(ctx).toContain('99285: Medicare rate $170.78')
  })

  it('includes ASP limit for a J-code', () => {
    const lineItems = [li('J0696', 50.00)]
    const ctx = buildDataContext(lineItems, TEST_NCCI, TEST_MPFS, TEST_ASP)
    expect(ctx).toContain('J0696: CMS ASP limit $1.45')
  })

  it('includes NCCI hit only when BOTH the component AND its Col1 are on the bill', () => {
    // 93010 alone — no hit (Col1 93000 not present)
    expect(
      buildDataContext([li('93010', 45.00)], TEST_NCCI, TEST_MPFS, TEST_ASP)
    ).not.toContain('NCCI')

    // 93010 + 93000 — hit reported
    expect(
      buildDataContext([li('93000', 250.00), li('93010', 45.00)], TEST_NCCI, TEST_MPFS, TEST_ASP)
    ).toContain('NCCI bundling violations')
  })

  it('does NOT include 70450+70486 as NCCI hit (not directly bundled)', () => {
    const ctx = buildDataContext(
      [li('70450', 350.00), li('70486', 400.00)],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP
    )
    expect(ctx).not.toContain('NCCI bundling violations')
  })

  it('falls back to CLFS for lab codes missing from MPFS', () => {
    const ctx = buildDataContext(
      [li('85025', 35.00)],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP,
      TEST_CLFS
    )

    expect(ctx).toContain('85025: Medicare rate $12.34 (CLFS (lab rate))')
  })
})

describe('buildDeterministicFindings — CLFS fallback', () => {
  it('uses the CLFS rate for duplicate lab codes missing from MPFS', () => {
    const { findings } = buildDeterministicFindings(
      [li('85025', 35.00), li('85025', 35.00)],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP,
      TEST_CLFS
    )

    const duplicate = findings.find((finding) => finding.errorType === 'duplicate')
    expect(duplicate?.medicareRate).toBe(12.34)
    expect(duplicate?.standardDescription).toBe('Blood count; complete (CBC), automated')
  })
})

describe('buildDeterministicFindings — MUE units', () => {
  it('flags codes that exceed the CMS date-of-service MUE cap', () => {
    const { findings } = buildDeterministicFindings(
      [li('99215', 300.00, 1), li('99215', 300.00, 2)],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP,
      TEST_CLFS,
      TEST_MUE
    )

    const mueFindings = findings.filter((finding) =>
      finding.cptCode === '99215' && finding.description.includes('Medically Unlikely Edits')
    )
    expect(mueFindings).toHaveLength(2)
  })

  it('ignores claim-line MUE entries for deterministic caps', () => {
    const { findings } = buildDeterministicFindings(
      [li('36415', 20.00, 5)],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP,
      TEST_CLFS,
      TEST_MUE
    )

    expect(findings.find((finding) => finding.cptCode === '36415')).toBeUndefined()
  })
})

describe('buildDeterministicFindings — E&M upcoding pre-filter', () => {
  it('flags E&M codes that exceed supported ICD-10 MDM by two tiers or more', () => {
    const { findings } = buildDeterministicFindings(
      [{ ...li('99215', 300.00), icd10Codes: ['J00.9'] }],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP,
      TEST_CLFS,
      TEST_MUE,
      TEST_EM_MDM
    )

    expect(findings.find((finding) => finding.errorType === 'upcoding')).toBeDefined()
  })

  it('does not flag E&M codes when the diagnoses support the billed tier', () => {
    const { findings } = buildDeterministicFindings(
      [{ ...li('99284', 220.00), icd10Codes: ['R07.9'] }],
      TEST_NCCI,
      TEST_MPFS,
      TEST_ASP,
      TEST_CLFS,
      TEST_MUE,
      TEST_EM_MDM
    )

    expect(findings.find((finding) => finding.errorType === 'upcoding')).toBeUndefined()
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
