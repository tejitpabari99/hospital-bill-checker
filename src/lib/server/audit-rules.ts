/**
 * audit-rules.ts — pure deterministic billing audit rules
 *
 * No imports from $lib/data — all data is passed in as parameters.
 * This keeps the logic testable without needing SvelteKit aliases.
 */

import type { LineItem, AuditFinding, ConfidenceLevel, BillType } from '$lib/types'
import { loadAspLimit, loadClfsRate, loadDrgRate, loadMpfsRate, loadMueEdit, loadNcciPairs, loadOppsRate, toServiceDateInt } from './data-loader'

// ── Types ─────────────────────────────────────────────────────────────────────

export type MpfsEntry = number | { rate: number; description?: string }
export type MpfsData = Record<string, MpfsEntry>
export type ClfsData = Record<string, { rate: number; description?: string }>
export type EmMdmTier = 'S' | 'L' | 'M' | 'H'
export type EmMdmTierData = Record<string, EmMdmTier>
export type LcdCoverageEntry = {
  covered: string[]
  notCovered: string[]
  lcdIds: string[]
}
export type LcdCoverageData = Record<string, LcdCoverageEntry>

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

const MODIFIER_59_FAMILY = ['59', '-59', 'XE', 'XP', 'XS', 'XU']
const TIER_RANK: Record<EmMdmTier, number> = { S: 0, L: 1, M: 2, H: 3 }
const TIER_NAMES: Record<EmMdmTier, string> = {
  S: 'straightforward',
  L: 'low complexity',
  M: 'moderate complexity',
  H: 'high complexity',
}

export const EM_MDM_LEVELS: Record<string, EmMdmTier> = {
  '99202': 'S', '99203': 'L', '99204': 'M', '99205': 'H',
  '99211': 'S', '99212': 'S', '99213': 'L', '99214': 'M', '99215': 'H',
  '99281': 'S', '99282': 'S', '99283': 'L', '99284': 'M', '99285': 'H',
  '99221': 'L', '99222': 'M', '99223': 'H',
  '99231': 'L', '99232': 'M', '99233': 'H',
  '99304': 'L', '99305': 'M', '99306': 'H',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getMpfsRate(entry: MpfsEntry | undefined): number | undefined {
  if (entry === undefined) return undefined
  if (typeof entry === 'number') return entry
  return entry.rate
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Build the CMS reference data context string injected into the AI prompt.
 * Only includes data for codes actually on this bill (bounded by lineItems).
 */
export function buildDataContext(
  lineItems: LineItem[],
  billType: BillType = 'unknown',
  serviceDateStr?: string
): string {
  const serviceDateInt = toServiceDateInt(serviceDateStr)
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
    const pairs = loadNcciPairs(code, billType, serviceDateInt)
    if (pairs.length > 0) {
      const presentCol1 = pairs.filter(pair => codeSet.has(pair.col1_code))
      if (presentCol1.length > 0) {
        const modNote = presentCol1.some(pair => pair.modifier_indicator === '0')
          ? '(no modifier override allowed — always an unbundling error)'
          : '(modifier -59 may override with documented distinct clinical indication)'
        ncciHits.push(`${code} is bundled into ${presentCol1.map(pair => pair.col1_code).join(' / ')} per CMS NCCI ${modNote}`)
      }
    }

    const mpfsRow = loadMpfsRate(code)
    const clfsRow = mpfsRow?.nonfac_rate == null ? loadClfsRate(code) : null
    const effectiveRate = mpfsRow?.nonfac_rate ?? clfsRow?.rate
    if (effectiveRate != null) {
      const source = clfsRow != null ? 'CLFS (lab rate)' : 'MPFS'
      mpfsRates.push(`${code}: Medicare rate $${effectiveRate.toFixed(2)} (${source})`)
    }
    const aspRow = loadAspLimit(code)
    if (aspRow) aspRates.push(`${code}: CMS ASP limit $${aspRow.payment_limit.toFixed(2)}`)
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
  mpfs: MpfsData,
  clfs: ClfsData = {},
  emMdmTiers: EmMdmTierData = {},
  lcdCoverage: LcdCoverageData = {},
  billType: BillType = 'unknown',
  serviceDateStr?: string,
  drgCode?: string
): { findings: AuditFinding[]; promptNote: string } {
  const serviceDateInt = toServiceDateInt(serviceDateStr)
  const codes = lineItems.map(li => li.cpt.trim().toUpperCase())
  const codeSet = new Set(codes)
  const findings: AuditFinding[] = []
  const alreadyFlaggedCodes = new Set<string>()

  // Rate lookup — MPFS first, CLFS fallback (step 04 adds CLFS).
  function getEffectiveRate(code: string): { rate: number; source: string } | null {
    const mpfsRow = loadMpfsRate(code)
    if (mpfsRow?.nonfac_rate != null) {
      return { rate: mpfsRow.nonfac_rate, source: 'MPFS' }
    }
    const clfsRow = loadClfsRate(code)
    if (clfsRow?.rate != null) {
      return { rate: clfsRow.rate, source: 'CLFS' }
    }
    return null
  }

  // 1. NCCI unbundling — deterministic, per-pair modifier check
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const pairs = loadNcciPairs(code, billType, serviceDateInt)
    if (pairs.length === 0) continue

    const presentCol1 = pairs.filter(p => codeSet.has(p.col1_code))
    if (presentCol1.length === 0) continue

    const lineModifiers = (lineItems[i].modifiers ?? []).map(m => m.trim().toUpperCase())
    const hasModifier59 = lineModifiers.some(m => MODIFIER_59_FAMILY.includes(m))

    for (const pair of presentCol1) {
      const modifierCanOverride = pair.modifier_indicator !== '0'
      const modifierOverrides = modifierCanOverride && hasModifier59

      if (modifierOverrides) continue

      const modNote = modifierCanOverride
        ? '(modifier -59 may override with documented distinct clinical indication)'
        : '(no modifier override allowed — always an unbundling error)'

      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'unbundling',
        confidence: 'high' as ConfidenceLevel,
        description: `CPT ${code} is bundled into CPT ${pair.col1_code} per CMS NCCI PTP edits. Both codes should not be billed separately on the same claim ${modNote}.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Request that the hospital remove CPT ${code} from the claim or provide documentation justifying separate billing with modifier -59.`,
        ncciBundledWith: pair.col1_code,
        medicareRate: getEffectiveRate(code)?.rate,
        markupRatio: undefined,
      })
      alreadyFlaggedCodes.add(code)
      break
    }
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
        medicareRate: getEffectiveRate(code)?.rate,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
    }
  }

  // 3. Pharmacy markup check (ASP) — deterministic
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (alreadyFlaggedCodes.has(code)) continue

    const aspRow = loadAspLimit(code)
    if (!aspRow) continue

    const billed = lineItems[i].billedAmount
    const limit = aspRow.payment_limit
    const ratio = billed / limit

    // CMS allows up to 106% of ASP (6% markup). Over 4.5x = pharmacy markup error.
    if (ratio > 4.5) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'pharmacy_markup',
        confidence: 'high',
        description: `${code} (${aspRow.description ?? 'drug code'}) is billed at $${billed.toFixed(2)}, which is ${ratio.toFixed(1)}x the CMS ASP payment limit of $${limit.toFixed(2)}.`,
        standardDescription: aspRow.description ?? undefined,
        recommendation: `Request itemized drug administration records and justification for the markup above 4.5x the CMS Average Sales Price limit.`,
        medicareRate: limit,
        markupRatio: ratio,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    }
  }

  // 4. OPPS benchmark check (outpatient only) — deterministic
  if (billType === 'outpatient') {
    for (let i = 0; i < lineItems.length; i++) {
      const code = codes[i]
      if (alreadyFlaggedCodes.has(code)) continue

      const oppsRow = loadOppsRate(code)
      if (!oppsRow || oppsRow.payment_rate == null) continue

      const billed = lineItems[i].billedAmount
      const benchmark = oppsRow.payment_rate

      if (billed > benchmark * 2.5) {
        findings.push({
          lineItemIndex: i,
          cptCode: code,
          severity: 'warning',
          errorType: 'upcoding',
          confidence: 'medium',
          description: `CPT ${code} (${oppsRow.short_descriptor ?? ''}) is billed at $${billed.toFixed(2)}, which is ${(billed / benchmark).toFixed(1)}× the CMS OPPS outpatient facility benchmark of $${benchmark.toFixed(2)} (APC ${oppsRow.apc}: ${oppsRow.apc_title ?? ''}).`,
          standardDescription: oppsRow.short_descriptor ?? undefined,
          recommendation: `Request itemized justification for why facility fees exceed the CMS Outpatient Prospective Payment System rate.`,
          medicareRate: benchmark,
          markupRatio: billed / benchmark,
          ncciBundledWith: undefined,
        })
      }
    }
  }

  // 5. IPPS/DRG inpatient reference - informational
  if (billType === 'inpatient' && drgCode) {
    const drg = loadDrgRate(drgCode)
    if (drg) {
      findings.push({
        lineItemIndex: -1,
        cptCode: `DRG-${drg.ms_drg}`,
        severity: 'info',
        errorType: 'other',
        confidence: 'high',
        description: `This inpatient bill shows MS-DRG ${drg.ms_drg}: "${drg.title}". CMS relative weight: ${drg.relative_weight ?? 'N/A'}. Expected length of stay: ${drg.geometric_mean_los ?? 'N/A'} days (geometric mean).`,
        standardDescription: drg.title ?? undefined,
        recommendation: `Compare your actual length of stay to the CMS expected LOS of ${drg.geometric_mean_los ?? 'N/A'} days for DRG ${drg.ms_drg}. Contact your hospital billing department if the DRG assignment appears incorrect.`,
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
    }
  }

  // 6. LCD/NCD coverage check
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const lcdEntry = lcdCoverage[code]
    if (!lcdEntry || lcdEntry.covered.length === 0) continue

    const icd10s = lineItems[i].icd10Codes ?? []
    if (icd10s.length === 0) continue

    const hasCoveredDx = icd10s.some((icd) =>
      lcdEntry.covered.some((covered) => icd.toUpperCase().startsWith(covered.toUpperCase()))
    )
    const hasExcludedDx = icd10s.some((icd) =>
      lcdEntry.notCovered.some((excluded) => icd.toUpperCase().startsWith(excluded.toUpperCase()))
    )

    if (hasCoveredDx) continue

    const lcdRef = lcdEntry.lcdIds.slice(0, 2).join(', ')
    findings.push({
      lineItemIndex: i,
      cptCode: code,
      severity: hasExcludedDx ? 'error' : 'warning',
      errorType: 'icd10_mismatch',
      confidence: hasExcludedDx ? 'high' : 'medium',
      description: `CPT ${code} may not be covered for the diagnosis codes on this bill (${icd10s.join(', ')}). Per CMS LCD ${lcdRef}, this procedure requires specific qualifying diagnoses that are not present on the bill.`,
      standardDescription: CPT_DESCRIPTIONS[code],
      recommendation: `Request documentation showing medical necessity for CPT ${code}. The CMS LCD (${lcdRef}) specifies which diagnoses qualify this procedure for coverage. If your diagnosis is not listed, ask billing to explain or correct the diagnosis codes.`,
      medicareRate: getEffectiveRate(code)?.rate,
      markupRatio: undefined,
      ncciBundledWith: undefined,
    })
  }

  // 7. MUE units check — deterministic
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const unitsBilled = lineItems[i].units ?? 1
    const mueEntry = loadMueEdit(code, billType)
    if (!mueEntry) continue

    const mai = mueEntry.mue_adjudication_indicator
    const maxUnits = mueEntry.mue_value

    // MAI 1 = per claim line, MAI 2 or 3 = per date of service
    // For simplicity: flag if units > maxUnits regardless of MAI
    if (unitsBilled > maxUnits) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'other',
        confidence: 'high' as ConfidenceLevel,
        description: `CPT ${code} has ${unitsBilled} units billed, which exceeds the CMS Medically Unlikely Edit (MUE) limit of ${maxUnits} units per ${mai === '1' ? 'claim line' : 'date of service'}.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Request itemized documentation for each unit of CPT ${code}. The MUE limit is ${maxUnits} unit(s).`,
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    }
  }

  // 8. E&M upcoding — deterministic pre-filter
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const emTier = EM_MDM_LEVELS[code]
    if (!emTier) continue

    const icd10s = lineItems[i].icd10Codes ?? []
    if (icd10s.length === 0) continue

    let maxIcdTier: EmMdmTier = 'S'
    for (const icd of icd10s) {
      const prefix = icd.substring(0, 3).toUpperCase()
      const icdTier = emMdmTiers[prefix] ?? null
      if (icdTier && TIER_RANK[icdTier] > TIER_RANK[maxIcdTier]) {
        maxIcdTier = icdTier
      }
    }

    if (TIER_RANK[emTier] - TIER_RANK[maxIcdTier] < 2) continue

    findings.push({
      lineItemIndex: i,
      cptCode: code,
      severity: 'warning',
      errorType: 'upcoding',
      confidence: 'medium' as ConfidenceLevel,
      description: `CPT ${code} requires ${TIER_NAMES[emTier]} medical decision-making, but the diagnosis codes on this bill (${icd10s.join(', ')}) suggest at most ${TIER_NAMES[maxIcdTier]} MDM. This may be worth questioning.`,
      standardDescription: CPT_DESCRIPTIONS[code],
      recommendation: 'Request the clinical notes supporting this E&M level. Ask billing to explain why the documentation justifies this complexity tier per AMA 2021 E&M guidelines.',
      medicareRate: getEffectiveRate(code)?.rate,
      markupRatio: undefined,
      ncciBundledWith: undefined,
    })
  }

  findings.forEach(f => alreadyFlaggedCodes.add(f.cptCode))
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

export function buildArithmeticFindings(
  lineItems: LineItem[],
  billTotal?: number
): AuditFinding[] {
  const findings: AuditFinding[] = []
  const lineSum = lineItems.reduce((sum, lineItem) => sum + (lineItem.billedAmount || 0), 0)

  if (billTotal != null && billTotal > 0) {
    const diff = Math.abs(lineSum - billTotal)
    if (diff > 0.5) {
      findings.push({
        lineItemIndex: -1,
        cptCode: 'TOTAL',
        severity: 'error',
        errorType: 'arithmetic_error',
        confidence: 'high',
        description: `The sum of all line items ($${lineSum.toFixed(2)}) does not match the bill total ($${billTotal.toFixed(2)}). The difference is $${diff.toFixed(2)}.`,
        standardDescription: 'Bill arithmetic error',
        recommendation: 'Request a corrected itemized statement explaining the discrepancy between individual charges and the stated total.',
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
    }
  }

  return findings
}

export function buildDateFindings(
  lineItems: LineItem[],
  admissionDate?: string,
  dischargeDate?: string
): AuditFinding[] {
  const findings: AuditFinding[] = []

  if (admissionDate && dischargeDate) {
    const admit = new Date(admissionDate)
    const discharge = new Date(dischargeDate)
    for (let i = 0; i < lineItems.length; i++) {
      const lineItem = lineItems[i]
      if (!lineItem.serviceDate) continue
      const serviceDate = new Date(lineItem.serviceDate)
      if (serviceDate < admit || serviceDate > discharge) {
        findings.push({
          lineItemIndex: i,
          cptCode: lineItem.cpt,
          severity: 'warning',
          errorType: 'date_error',
          confidence: 'high',
          description: `CPT ${lineItem.cpt} has a service date of ${lineItem.serviceDate}, which is outside your admission window (${admissionDate} - ${dischargeDate}).`,
          standardDescription: CPT_DESCRIPTIONS[lineItem.cpt],
          recommendation: 'Request an explanation for why this service was billed outside your stay dates. This may be a data entry error.',
          medicareRate: undefined,
          markupRatio: undefined,
          ncciBundledWith: undefined,
        })
      }
    }
  }

  return findings
}

export function buildGfeFindings(
  lineItems: LineItem[],
  gfe?: number
): AuditFinding[] {
  if (!gfe || gfe <= 0) return []
  const totalBilled = lineItems.reduce((sum, lineItem) => sum + (lineItem.billedAmount || 0), 0)
  const excess = totalBilled - gfe
  if (excess < 400) return []

  return [{
    lineItemIndex: -1,
    cptCode: 'GFE',
    severity: 'error',
    errorType: 'no_surprises_act',
    confidence: 'high',
    description: `Your total bill ($${totalBilled.toFixed(2)}) exceeds your Good Faith Estimate ($${gfe.toFixed(2)}) by $${excess.toFixed(2)}, which is above the $400 threshold under the No Surprises Act.`,
    standardDescription: 'No Surprises Act - Good Faith Estimate violation',
    recommendation: 'You have the right to dispute this through CMS Patient-Provider Dispute Resolution. Submit a dispute at cms.gov/medical-bill-rights within 120 days of receiving the bill. Cite 26 U.S.C. § 9816 and 29 U.S.C. § 1185e.',
    medicareRate: undefined,
    markupRatio: undefined,
    ncciBundledWith: undefined,
  }]
}
