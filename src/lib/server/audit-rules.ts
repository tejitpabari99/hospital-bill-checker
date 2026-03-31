/**
 * audit-rules.ts — pure deterministic billing audit rules
 *
 * No imports from $lib/data — all data is passed in as parameters.
 * This keeps the logic testable without needing SvelteKit aliases.
 */

import type { LineItem, AuditFinding, ConfidenceLevel } from '$lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NcciEntry = { bundledInto: string[]; modifierCanOverride: boolean } | string
export type NcciData = Record<string, NcciEntry>
export type MpfsEntry = number | { rate: number; description?: string }
export type MpfsData = Record<string, MpfsEntry>
export type AspData = Record<string, number>
export type ClfsData = Record<string, { rate: number; description?: string }>

// ── Known CPT descriptions ────────────────────────────────────────────────────

export const CPT_DESCRIPTIONS: Record<string, string> = {
  '70450': 'CT head or brain without contrast',
  '70460': 'CT head or brain with contrast',
  '70470': 'CT head or brain without and with contrast',
  '70486': 'CT maxillofacial area without contrast',
  '70487': 'CT maxillofacial area with contrast',
  '70488': 'CT maxillofacial area without and with contrast',
  '70490': 'CT soft tissue neck without contrast',
  '70491': 'CT soft tissue neck with contrast',
  '70551': 'MRI brain without contrast',
  '70553': 'MRI brain without and with contrast',
  '71046': 'Chest X-ray, 2 views',
  '71250': 'CT thorax without contrast',
  '72148': 'MRI lumbar spine without contrast',
  '72141': 'MRI cervical spine without contrast',
  '73721': 'MRI joint of lower extremity without contrast',
  '74177': 'CT abdomen and pelvis without contrast',
  '74178': 'CT abdomen and pelvis without and with contrast',
  '93000': 'Electrocardiogram, routine ECG with at least 12 leads',
  '93005': 'Electrocardiogram, tracing only',
  '93010': 'Electrocardiogram, interpretation and report only',
  '85025': 'Blood count; complete (CBC), automated',
  '80053': 'Comprehensive metabolic panel',
  '36415': 'Collection of venous blood by venipuncture',
  '36410': 'Venipuncture, necessitating physician skill',
  '27447': 'Total knee arthroplasty',
  '27370': 'Injection, knee joint',
  '99285': 'Emergency department visit, high medical decision making complexity',
  '99284': 'Emergency department visit, high complexity',
  '99283': 'Emergency department visit, moderate complexity',
  '99213': 'Office/outpatient visit, established patient, low complexity',
  '99214': 'Office/outpatient visit, established patient, moderate complexity',
  '99215': 'Office/outpatient visit, established patient, high complexity',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getMpfsRate(entry: MpfsEntry | undefined): number | undefined {
  if (entry === undefined) return undefined
  if (typeof entry === 'number') return entry
  return entry.rate
}

export function getNcciEntry(
  code: string,
  ncci: NcciData
): { bundledInto: string[]; modifierCanOverride: boolean } | null {
  const entry = ncci[code]
  if (!entry) return null
  if (typeof entry === 'string') return { bundledInto: [entry], modifierCanOverride: true }
  return entry
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Build the CMS reference data context string injected into the AI prompt.
 * Only includes data for codes actually on this bill (bounded by lineItems).
 */
export function buildDataContext(
  lineItems: LineItem[],
  ncci: NcciData,
  mpfs: MpfsData,
  asp: AspData,
  clfs: ClfsData = {}
): string {
  const codes = lineItems.map(li => li.cpt.trim().toUpperCase())
  const codeSet = new Set(codes)
  const ncciHits: string[] = []
  const mpfsRates: string[] = []
  const aspRates: string[] = []
  const RADIOLOGY_BUNDLE_RULES = [
    ['70486', '70450', 'CT maxillofacial (70486) is bundled into CT head (70450) — billing both requires modifier -59 with documented distinct clinical indications'],
    ['70491', '70490', 'CT neck with contrast (70491) is bundled into CT neck without contrast (70490) when both are billed'],
    ['70553', '70551', 'MRI brain with contrast (70553) is bundled into MRI brain without contrast (70551) when billed together'],
    ['74178', '74177', 'CT abdomen/pelvis with and without contrast (74178) supersedes CT abdomen/pelvis without contrast only (74177)'],
    ['71271', '71250', 'Low-dose CT chest (71271) is bundled into standard CT thorax (71250) when both appear'],
  ] as const
  const radHits: string[] = []

  for (const rawCode of codes) {
    const code = rawCode.trim().toUpperCase()

    // NCCI: only inject a hit if the Col1 (comprehensive) code is ALSO on this bill
    const ncciEntry = getNcciEntry(code, ncci)
    if (ncciEntry) {
      const presentCol1 = ncciEntry.bundledInto.filter(c => codeSet.has(c))
      if (presentCol1.length > 0) {
        const modNote = ncciEntry.modifierCanOverride
          ? '(modifier -59 may override with documented distinct clinical indication)'
          : '(no modifier override allowed — always an unbundling error)'
        ncciHits.push(`${code} is bundled into ${presentCol1.join(' / ')} per CMS NCCI ${modNote}`)
      }
    }

    const mpfsRate = getMpfsRate(mpfs[code])
    const clfsRate = mpfsRate === undefined && clfs[code] ? clfs[code].rate : undefined
    const effectiveRate = mpfsRate ?? clfsRate
    if (effectiveRate !== undefined) {
      const source = clfsRate !== undefined ? 'CLFS (lab rate)' : 'MPFS'
      mpfsRates.push(`${code}: Medicare rate $${effectiveRate.toFixed(2)} (${source})`)
    }
    if (asp[code]) aspRates.push(`${code}: CMS ASP limit $${asp[code].toFixed(2)}`)
  }

  for (const [col2, col1, rule] of RADIOLOGY_BUNDLE_RULES) {
    if (codeSet.has(col2) && codeSet.has(col1)) {
      radHits.push(rule)
    }
  }

  return [
    ncciHits.length ? `NCCI bundling violations detected on this bill:\n${ncciHits.join('\n')}` : '',
    mpfsRates.length ? `Medicare rates (MPFS 2026):\n${mpfsRates.join('\n')}` : '',
    aspRates.length ? `CMS ASP drug limits:\n${aspRates.join('\n')}` : '',
    radHits.length ? `Radiology bundling rules (NCCI):\n${radHits.join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

/**
 * Build deterministic pre-findings from CMS rule tables (no AI needed).
 * Covers: NCCI unbundling, exact duplicate billing, pharmacy markup.
 *
 * Returns findings array and a promptNote string to inject into the AI prompt
 * so the AI knows not to re-flag these codes.
 */
export function buildDeterministicFindings(
  lineItems: LineItem[],
  ncci: NcciData,
  mpfs: MpfsData,
  asp: AspData,
  clfs: ClfsData = {}
): { findings: AuditFinding[]; promptNote: string } {
  const codes = lineItems.map(li => li.cpt.trim().toUpperCase())
  const codeSet = new Set(codes)
  const findings: AuditFinding[] = []

  // Lab codes are in CLFS, not MPFS — use CLFS as fallback for any rate lookup.
  function getEffectiveRate(code: string): number | undefined {
    return getMpfsRate(mpfs[code]) ?? clfs[code]?.rate
  }

  // 1. NCCI unbundling — deterministic
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const ncciEntry = getNcciEntry(code, ncci)
    if (!ncciEntry) continue

    const presentCol1 = ncciEntry.bundledInto.filter(c => codeSet.has(c))
    if (presentCol1.length === 0) continue

    const lineItem = lineItems[i]
    const hasModifier59 = lineItem.modifiers?.some(m =>
      ['59', '-59', 'XE', 'XP', 'XS', 'XU'].includes(m.trim())
    )
    const isError = !hasModifier59 || !ncciEntry.modifierCanOverride

    findings.push({
      lineItemIndex: i,
      cptCode: code,
      severity: isError ? 'error' : 'warning',
      errorType: 'unbundling',
      confidence: 'high' as ConfidenceLevel,
      description: hasModifier59 && ncciEntry.modifierCanOverride
        ? `CPT ${code} is billed with modifier -59 alongside CPT ${presentCol1.join('/')}. This may be legitimate if there is documented distinct clinical indication, but requires review.`
        : `CPT ${code} should not be billed separately when CPT ${presentCol1.join(' or ')} is also billed. CMS NCCI rules require ${code} to be bundled into ${presentCol1.join('/')}.${ncciEntry.modifierCanOverride ? '' : ' No modifier can override this rule.'}`,
      standardDescription: CPT_DESCRIPTIONS[code],
      recommendation: hasModifier59 && ncciEntry.modifierCanOverride
        ? 'Request the clinical documentation supporting separate billing with modifier -59. It requires distinct procedures at different anatomical sites or separate patient encounters.'
        : 'Request a corrected bill removing the bundled charge, or written justification under 42 CFR 405.374.',
      medicareRate: getEffectiveRate(code),
      markupRatio: undefined,
      ncciBundledWith: presentCol1[0],
    })
  }

  // 2. Duplicate detection — deterministic
  const codeIndexes = new Map<string, number[]>()
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (!codeIndexes.has(code)) codeIndexes.set(code, [])
    codeIndexes.get(code)!.push(i)
  }
  for (const [code, indexes] of codeIndexes) {
    if (indexes.length <= 1) continue
    for (const idx of indexes.slice(1)) {
      findings.push({
        lineItemIndex: idx,
        cptCode: code,
        severity: 'error',
        errorType: 'duplicate',
        confidence: 'high' as ConfidenceLevel,
        description: `CPT ${code} appears ${indexes.length} times on this bill. Duplicate billing is a common billing error.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: 'Request a corrected bill with the duplicate charge removed.',
        medicareRate: getEffectiveRate(code),
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
    }
  }

  // 3. Pharmacy markup — deterministic
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const aspRate = asp[code]
    if (!aspRate) continue
    const lineItem = lineItems[i]
    const allowedAmount = aspRate * lineItem.units * 1.06
    if (lineItem.billedAmount <= allowedAmount * 4.5) continue

    const markupRatio = lineItem.billedAmount / allowedAmount
    findings.push({
      lineItemIndex: i,
      cptCode: code,
      severity: 'error',
      errorType: 'pharmacy_markup',
      confidence: 'high' as ConfidenceLevel,
      description: `${code} billed at $${lineItem.billedAmount.toFixed(2)} vs CMS ASP-based limit of $${allowedAmount.toFixed(2)} for ${lineItem.units} unit(s) — ${markupRatio.toFixed(1)}× markup. CMS allows maximum 6% over the Average Sales Price.`,
      standardDescription: CPT_DESCRIPTIONS[code],
      recommendation: 'Request itemized drug pricing documentation and compare against the CMS ASP list at cms.gov/medicare/payment/part-b-drugs/asp-pricing-files.',
      medicareRate: aspRate,
      markupRatio: markupRatio,
      ncciBundledWith: undefined,
    })
  }

  const alreadyFlaggedCodes = new Set(findings.map(f => f.cptCode))
  const promptNote =
    findings.length > 0
      ? `\n\nIMPORTANT: The following findings are CONFIRMED by deterministic CMS rule lookup — do NOT contradict or omit them. Include them in your output exactly as described:\n${findings
          .map(
            f =>
              `- lineItemIndex:${f.lineItemIndex} CPT ${f.cptCode}: ${f.errorType} (severity:${f.severity}, confidence:high)`
          )
          .join('\n')}\n\nFor the above codes, do not add duplicate findings. Focus your analysis on the remaining codes: ${codes.filter(c => !alreadyFlaggedCodes.has(c)).join(', ') || 'none'}.`
      : ''

  return { findings, promptNote }
}
