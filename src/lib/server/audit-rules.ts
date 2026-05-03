import type { LineItem, AuditFinding, ConfidenceLevel, BillType } from '$lib/types'
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
  toServiceDateInt,
} from './data-loader'

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

// '-59' is intentionally excluded: the sanitizer in +server.ts strips leading dashes
// (see sanitizeStringList → replace(/^-/, '')), so '-59' never appears in modifiers[].
const MODIFIER_59_FAMILY = ['59', 'XE', 'XP', 'XS', 'XU']
// Explicit set of ambulance transport HCPCS codes eligible for the ambulance fee schedule check.
// Do NOT use a regex — A03xx codes are drug administration, not ambulance transport.
const AMBULANCE_TRANSPORT_CODES = new Set([
  'A0424', 'A0425', 'A0426', 'A0427', 'A0428', 'A0429',
  'A0430', 'A0431', 'A0432', 'A0433', 'A0434',
  'A0435', 'A0436',
])
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

type RuleFinding = {
  findingType: string
  lineItemIndex?: number
  cptCode?: string
}

function hasModifier59Family(lineItem: LineItem): boolean {
  return (lineItem.modifiers ?? [])
    .map(modifier => modifier.trim().toUpperCase())
    .some(modifier => MODIFIER_59_FAMILY.includes(modifier))
}

export function checkNcciBundling(
  lineItems: LineItem[],
  pairs: Array<{ col1_code: string; col2_code?: string; modifier_indicator: string | number }>
): RuleFinding[] {
  const normalizedCodes = lineItems.map(lineItem => lineItem.cpt.trim().toUpperCase())
  const codeSet = new Set(normalizedCodes)
  const findings: RuleFinding[] = []

  for (const pair of pairs) {
    const col1 = pair.col1_code.trim().toUpperCase()
    const col2 = pair.col2_code?.trim().toUpperCase()
    if (!codeSet.has(col1)) continue

    const col2Index = col2
      ? normalizedCodes.findIndex(code => code === col2)
      : normalizedCodes.findIndex(code => code !== col1)

    if (col2Index < 0) continue

    const modifierCanOverride = String(pair.modifier_indicator) !== '0'
    if (modifierCanOverride && hasModifier59Family(lineItems[col2Index])) continue

    findings.push({
      findingType: 'ncci_bundling',
      lineItemIndex: col2Index,
      cptCode: normalizedCodes[col2Index],
    })
  }

  return findings
}

export function checkMueExceeded(
  lineItems: LineItem[],
  edits: Array<{ hcpcs_code: string; mue_value: number | null; mue_adjudication_indicator?: string | number; mai?: string | number }>
): RuleFinding[] {
  const editByCode = new Map(edits.map(edit => [edit.hcpcs_code.trim().toUpperCase(), edit]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const edit = editByCode.get(code)
    const units = lineItem.units ?? lineItem.quantity ?? 1
    const mai = String(edit?.mue_adjudication_indicator ?? edit?.mai ?? '')
    if (edit?.mue_value == null) return []
    if (!edit || mai !== '3' || units <= edit.mue_value) return []
    return [{ findingType: 'mue_exceeded', lineItemIndex: index, cptCode: code }]
  })
}

export function checkMpfsBenchmark(
  lineItems: LineItem[],
  rates: Array<{ hcpcs_code: string; nonfac_rate: number | null }>
): RuleFinding[] {
  const rateByCode = new Map(rates.map(rate => [rate.hcpcs_code.trim().toUpperCase(), rate]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const rate = rateByCode.get(code)?.nonfac_rate
    if (rate == null || rate <= 0 || lineItem.billedAmount <= rate * 2) return []
    return [{ findingType: 'mpfs_overcharge', lineItemIndex: index, cptCode: code }]
  })
}

export function checkClfsBenchmark(
  lineItems: LineItem[],
  rates: Array<{ hcpcs_code: string; rate?: number | null; payment_limit?: number | null }>
): RuleFinding[] {
  const rateByCode = new Map(rates.map(rate => [rate.hcpcs_code.trim().toUpperCase(), rate]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const rate = rateByCode.get(code)
    const benchmark = rate?.rate ?? rate?.payment_limit
    if (benchmark == null || benchmark <= 0 || lineItem.billedAmount <= benchmark * 2) return []
    return [{ findingType: 'clfs_overcharge', lineItemIndex: index, cptCode: code }]
  })
}

export function checkAspDrugOvercharge(
  lineItems: LineItem[],
  limits: Array<{ hcpcs_code: string; payment_limit?: number | null; asp_payment_limit?: number | null }>
): RuleFinding[] {
  const limitByCode = new Map(limits.map(limit => [limit.hcpcs_code.trim().toUpperCase(), limit]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const limit = limitByCode.get(code)
    const benchmark = limit?.payment_limit ?? limit?.asp_payment_limit
    if (benchmark == null || benchmark <= 0 || lineItem.billedAmount <= benchmark * 4.5) return []
    return [{ findingType: 'asp_overcharge', lineItemIndex: index, cptCode: code }]
  })
}

export function checkOppsBenchmark(
  lineItems: LineItem[],
  rates: Array<{ hcpcs_code: string; payment_rate: number | null }>
): RuleFinding[] {
  const rateByCode = new Map(rates.map(rate => [rate.hcpcs_code.trim().toUpperCase(), rate]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const rate = rateByCode.get(code)?.payment_rate
    if (rate == null || rate <= 0 || lineItem.billedAmount <= rate * 2.5) return []
    return [{ findingType: 'opps_overcharge', lineItemIndex: index, cptCode: code }]
  })
}

export function checkIppsDrg(
  drgCode: string | undefined,
  rates: Array<{ ms_drg?: string; drg_code?: string; relative_weight: number | null }>
): RuleFinding[] {
  if (!drgCode) return []
  const normalizedDrg = drgCode.trim().replace(/[^0-9]/g, '').padStart(3, '0')
  const match = rates.find(rate => (rate.ms_drg ?? rate.drg_code) === normalizedDrg)
  return match ? [{ findingType: 'ipps_drg', cptCode: `DRG-${normalizedDrg}` }] : []
}

export function checkDmeposBenchmark(
  lineItems: LineItem[],
  rates: Array<{ hcpcs_code: string; fee_amount?: number | null; rental_rate?: number | null }>
): RuleFinding[] {
  const rateByCode = new Map(rates.map(rate => [rate.hcpcs_code.trim().toUpperCase(), rate]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const rate = rateByCode.get(code)
    const benchmark = rate?.fee_amount ?? rate?.rental_rate
    if (benchmark == null || benchmark <= 0 || lineItem.billedAmount <= benchmark * 2) return []
    return [{ findingType: 'dmepos_overcharge', lineItemIndex: index, cptCode: code }]
  })
}

export function checkAmbulanceBenchmark(
  lineItems: LineItem[],
  rates: Array<{ hcpcs_code: string; rate_amount?: number | null; base_rate?: number | null }>
): RuleFinding[] {
  const rateByCode = new Map(rates.map(rate => [rate.hcpcs_code.trim().toUpperCase(), rate]))

  return lineItems.flatMap((lineItem, index) => {
    const code = lineItem.cpt.trim().toUpperCase()
    const rate = rateByCode.get(code)
    const benchmark = rate?.rate_amount ?? rate?.base_rate
    if (benchmark == null || benchmark <= 0 || lineItem.billedAmount <= benchmark * 2.5) return []
    return [{ findingType: 'ambulance_overcharge', lineItemIndex: index, cptCode: code }]
  })
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

export function buildDeterministicFindings(
  rawLineItems: LineItem[],
  billType: BillType = 'unknown',
  serviceDateStr?: string,
  drgCode?: string,
  patientState?: string,
  serviceZip?: string
): { findings: AuditFinding[]; summary: string } {
  const serviceDateInt = toServiceDateInt(serviceDateStr)
  // Coerce billedAmount — LLM may return "$1,234.56" as a string; NaN silently skips all findings.
  const lineItems = rawLineItems.map(li => {
    if (typeof li.billedAmount === 'number') return li
    const parsed = parseFloat(String(li.billedAmount).replace(/[$,\s]/g, ''))
    return { ...li, billedAmount: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 }
  })
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

  // Check 1: NCCI unbundling
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const pairs = loadNcciPairs(code, billType, serviceDateInt)
    if (pairs.length === 0) continue

    const presentCol1 = pairs.filter(p => codeSet.has(p.col1_code))
    if (presentCol1.length === 0) continue

    const lineModifiers = (lineItems[i].modifiers ?? []).map(m => m.trim().toUpperCase())
    const hasModifier59Family = lineModifiers.some(m => MODIFIER_59_FAMILY.includes(m))

    for (const pair of presentCol1) {
      const ind = String(pair.modifier_indicator).trim()
      if (ind === '9') continue

      const modifierCanOverride = ind === '1'
      const modifierOverrides = modifierCanOverride && hasModifier59Family

      if (modifierOverrides) continue

      const severity: 'error' | 'warning' = modifierCanOverride ? 'warning' : 'error'
      const modNote = modifierCanOverride
        ? '(modifier -59 may override with documented distinct clinical indication)'
        : '(no modifier override allowed — always an unbundling error)'
      const recommendation = modifierCanOverride
        ? 'Separate billing may be permitted with modifier -59 or X{EPSU} and appropriate documentation. Request the medical record and authorization letter.'
        : 'This code pair is always bundled — separate billing is not permitted regardless of documentation.'

      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity,
        errorType: 'unbundling',
        confidence: 'high' as ConfidenceLevel,
        description: `CPT ${code} is bundled into CPT ${pair.col1_code} per CMS NCCI PTP edits. Both codes should not be billed separately on the same claim ${modNote}.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation,
        ncciBundledWith: pair.col1_code,
        medicareRate: getEffectiveRate(code)?.rate,
        markupRatio: undefined,
      })
      alreadyFlaggedCodes.add(code)
      break
    }
  }

  // Check 2: MUE units
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (alreadyFlaggedCodes.has(code)) continue

    const unitsBilled = lineItems[i].units ?? lineItems[i].quantity ?? 1
    const mueEntry = loadMueEdit(code, billType)
    if (!mueEntry) continue

    const maxUnits = mueEntry.mue_value
    const mai = String(mueEntry.mue_adjudication_indicator ?? '')

    // mue_value is NULL for CMS-suppressed codes — skip the check (no limit published)
    if (maxUnits == null) continue
    if (mai === '3' && unitsBilled > maxUnits) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'mue_units',
        confidence: 'high' as ConfidenceLevel,
        description: `CPT ${code} has ${unitsBilled} units billed, which exceeds the CMS Medically Unlikely Edit (MUE) limit of ${maxUnits} units per date of service.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Request itemized documentation for each unit of CPT ${code}. The MUE limit is ${maxUnits} unit(s).`,
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    }
  }

  // Check 3: Pharmacy markup / ASP
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

  // Check 4: OPPS benchmark
  if (billType === 'outpatient') {
    for (let i = 0; i < lineItems.length; i++) {
      const code = codes[i]
      if (alreadyFlaggedCodes.has(code)) continue

      const oppsRow = loadOppsRate(code)
      // payment_rate = 0 means packaged/bundled into another APC — not separately payable
      if (!oppsRow || oppsRow.payment_rate == null || oppsRow.payment_rate === 0) continue

      const billed = lineItems[i].billedAmount
      const benchmark = oppsRow.payment_rate

      if (billed > benchmark * 2.5) {
        findings.push({
          lineItemIndex: i,
          cptCode: code,
          severity: 'warning',
          errorType: 'opps_benchmark',
          confidence: 'medium',
          description: `CPT ${code} (${oppsRow.short_descriptor ?? ''}) is billed at $${billed.toFixed(2)}, which is ${(billed / benchmark).toFixed(1)}× the CMS OPPS outpatient facility benchmark of $${benchmark.toFixed(2)} (APC ${oppsRow.apc}: ${oppsRow.apc_title ?? ''}).`,
          standardDescription: oppsRow.short_descriptor ?? undefined,
          recommendation: `Request itemized justification for why facility fees exceed the CMS Outpatient Prospective Payment System rate.`,
          medicareRate: benchmark,
          markupRatio: billed / benchmark,
          ncciBundledWith: undefined,
        })
        alreadyFlaggedCodes.add(code)
      }
    }
  }

  // Check 5: IPPS/DRG
  if (billType === 'inpatient' && drgCode) {
    const drg = loadDrgRate(drgCode)
    if (drg) {
      findings.push({
        lineItemIndex: -1,
        cptCode: `DRG-${drg.ms_drg}`,
        severity: 'info',
        errorType: 'ipps_drg',
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

  // Check 6: DMEPOS
  if (billType === 'dme' && patientState) {
    for (let i = 0; i < lineItems.length; i++) {
      const code = codes[i]
      if (alreadyFlaggedCodes.has(code)) continue

      const dmeRow = loadDmeposRate(code, patientState)
      if (!dmeRow || dmeRow.fee_amount == null) continue

      const billed = lineItems[i].billedAmount
      const benchmark = dmeRow.fee_amount

      if (billed > benchmark * 2.0) {
        findings.push({
          lineItemIndex: i,
          cptCode: code,
          severity: 'warning',
          errorType: 'dmepos_benchmark',
          confidence: 'medium',
          description: `${code} (${dmeRow.description ?? 'DME item'}) is billed at $${billed.toFixed(2)}, which is ${(billed / benchmark).toFixed(1)}× the CMS DMEPOS fee schedule rate of $${benchmark.toFixed(2)} for ${dmeRow.state_code}.`,
          standardDescription: dmeRow.description ?? undefined,
          recommendation: `Request itemized documentation. CMS DMEPOS fee schedule rate for this code is $${benchmark.toFixed(2)} in ${dmeRow.state_code}.`,
          medicareRate: benchmark,
          markupRatio: billed / benchmark,
          ncciBundledWith: undefined,
        })
      }
    }
  } else if (billType === 'dme' && !patientState) {
    findings.push({
      lineItemIndex: -1,
      cptCode: 'DMEPOS-SKIP',
      severity: 'info',
      errorType: 'dmepos_skipped',
      confidence: 'high',
      description: 'DMEPOS fee schedule check was skipped because no patient state was provided. State is required to look up the correct DMEPOS fee schedule locality.',
      standardDescription: undefined,
      recommendation: 'Re-submit the bill with your state of residence to enable DMEPOS rate comparison.',
      medicareRate: undefined,
      markupRatio: undefined,
      ncciBundledWith: undefined,
    })
  }

  // Check 7: Ambulance fee schedule
  if (serviceZip) {
    for (let i = 0; i < lineItems.length; i++) {
      const code = codes[i]
      if (alreadyFlaggedCodes.has(code)) continue
      if (!AMBULANCE_TRANSPORT_CODES.has(code)) continue

      const ambulanceRow = loadAmbulanceRate(code, serviceZip)
      const benchmark = ambulanceRow?.rate_amount ?? ambulanceRow?.base_rate
      if (!ambulanceRow || benchmark == null || benchmark <= 0) continue

      const billed = lineItems[i].billedAmount
      const ratio = billed / benchmark
      if (ratio <= 2.5) continue

      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'warning',
        errorType: 'ambulance_benchmark',
        confidence: 'medium',
        description: `${code} (${ambulanceRow.short_description ?? 'ambulance service'}) is billed at $${billed.toFixed(2)}, which is ${ratio.toFixed(1)}× the CMS ambulance fee schedule benchmark of $${benchmark.toFixed(2)} for locality ${ambulanceRow.locality ?? 'unknown'}.`,
        standardDescription: ambulanceRow.short_description ?? undefined,
        recommendation: `Request itemized documentation. CMS ambulance fee schedule benchmark for this code is $${benchmark.toFixed(2)}.`,
        medicareRate: benchmark,
        markupRatio: ratio,
        ncciBundledWith: undefined,
      })
    }
  } else if (lineItems.some((_, i) => AMBULANCE_TRANSPORT_CODES.has(codes[i]))) {
    findings.push({
      lineItemIndex: -1,
      cptCode: 'AMBULANCE-SKIP',
      severity: 'info',
      errorType: 'ambulance_skipped',
      confidence: 'high',
      description: 'Ambulance fee schedule check was skipped because no service ZIP code was found on the bill. ZIP code is required to determine the correct ambulance fee schedule locality.',
      standardDescription: undefined,
      recommendation: 'Re-submit the bill with the service ZIP code to enable ambulance rate comparison.',
      medicareRate: undefined,
      markupRatio: undefined,
      ncciBundledWith: undefined,
    })
  }

  // Check 8: Exact duplicate billing
  const seenCodes = new Map<string, number>()
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (alreadyFlaggedCodes.has(code)) continue
    const prev = seenCodes.get(code)
    if (prev !== undefined && lineItems[i].billedAmount === lineItems[prev].billedAmount) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'duplicate',
        confidence: 'high',
        description: `CPT ${code} appears ${lineItems.filter((_, idx) => codes[idx] === code).length} times at the same dollar amount on this bill.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: 'Request itemized documentation showing why this service was billed multiple times.',
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    }
    seenCodes.set(code, i)
  }

  // Check 9: Rate comparison (upcoding check)
  // For each code not already flagged, compare billed to Medicare benchmark
  const HIGH_MARKUP_THRESHOLD = 5.0
  const MODERATE_MARKUP_THRESHOLD = 2.5

  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (alreadyFlaggedCodes.has(code)) continue

    const billed = lineItems[i].billedAmount
    if (!billed || billed <= 0) continue

    let benchmark: number | null = null
    let benchmarkSource = ''

    if (billType === 'outpatient') {
      const oppsRow = loadOppsRate(code)
      if (oppsRow?.payment_rate) {
        benchmark = oppsRow.payment_rate
        benchmarkSource = `CMS OPPS (APC ${oppsRow.apc})`
      }
      // For outpatient bills: if OPPS rate is null, do NOT fall through to MPFS.
      // MPFS is the physician fee schedule — it measures physician work, not facility costs.
      // Using MPFS as a facility benchmark would produce misleading comparisons.
      if (benchmark == null) continue
    }

    if (benchmark == null) {
      const mpfsRow = loadMpfsRate(code)
      if (mpfsRow?.nonfac_rate) {
        benchmark = mpfsRow.nonfac_rate
        benchmarkSource = 'CMS MPFS'
      }
    }

    if (benchmark == null) {
      const clfsRow = loadClfsRate(code)
      if (clfsRow?.rate) {
        benchmark = clfsRow.rate
        benchmarkSource = 'CMS CLFS'
      }
    }

    if (benchmark == null || benchmark <= 0) continue

    const ratio = billed / benchmark

    if (ratio >= HIGH_MARKUP_THRESHOLD) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'upcoding',
        confidence: 'high',
        description: `CPT ${code} is billed at $${billed.toFixed(2)}, which is ${ratio.toFixed(1)}× the Medicare benchmark of $${benchmark.toFixed(2)} (${benchmarkSource}).`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Request itemized justification. Medicare pays $${benchmark.toFixed(2)} for this service; your bill is ${ratio.toFixed(1)}× that amount.`,
        medicareRate: benchmark,
        markupRatio: ratio,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    } else if (ratio >= MODERATE_MARKUP_THRESHOLD) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'warning',
        errorType: 'upcoding',
        confidence: 'medium',
        description: `CPT ${code} is billed at $${billed.toFixed(2)}, which is ${ratio.toFixed(1)}× the Medicare benchmark of $${benchmark.toFixed(2)} (${benchmarkSource}).`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Compare against your EOB from insurance. Medicare benchmark is $${benchmark.toFixed(2)}.`,
        medicareRate: benchmark,
        markupRatio: ratio,
        ncciBundledWith: undefined,
      })
    }
  }

  const errorCount = findings.filter(f => f.severity === 'error').length
  const warningCount = findings.filter(f => f.severity === 'warning').length
  const totalBilled = lineItems.reduce((s, li) => s + (li.billedAmount ?? 0), 0)
  const flaggedBilled = findings
    .filter(f => f.lineItemIndex >= 0 && f.severity === 'error')
    .map(f => lineItems[f.lineItemIndex]?.billedAmount ?? 0)
    .reduce((s, v) => s + v, 0)

  const summary = [
    `Bill type: ${billType}`,
    `Total billed: $${totalBilled.toFixed(2)}`,
    `Errors: ${errorCount}, Warnings: ${warningCount}`,
    errorCount > 0 ? `Potential overcharge: $${flaggedBilled.toFixed(2)}` : 'No confirmed billing errors found.',
  ].join('\n')

  return { findings, summary }
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
