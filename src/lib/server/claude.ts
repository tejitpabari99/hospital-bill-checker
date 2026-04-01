import { spawn } from 'child_process'
import { join } from 'path'
import { GEMINI_API_KEY } from '$env/static/private'
import type { BillInput, AuditResult, ConfidenceLevel } from '$lib/types'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'
import { lookupHospitalPrices } from './hospital-prices'
import type { HospitalPriceResult } from './hospital-prices'
import { AUDIT_TOOL_DECLARATIONS } from './audit-tools.mjs'
import {
  buildDataContext as _buildDataContext,
  buildDeterministicFindings as _buildDeterministicFindings,
  buildArithmeticFindings,
  buildDateFindings,
  buildGfeFindings,
  getMpfsRate,
  CPT_DESCRIPTIONS,
  getNcciEntry,
} from './audit-rules'
import type {
  NcciEntry,
  NcciData,
  MpfsData,
  AspData,
  ClfsData,
  MueData,
  EmMdmTierData,
  LcdCoverageData,
} from './audit-rules'

const CLAUDE_WORKER = join(process.cwd(), 'src/lib/server/claude-worker.mjs')

type WorkerResult =
  | { text: string; functionCalls?: Array<{ name: string; args?: Record<string, unknown> }>; parts?: unknown[] }
  | { error: string }
type WorkerRequest = {
  prompt?: string
  contents?: Array<{ role: string; parts: unknown[] }>
  tools?: unknown[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runClaudeWorker(input: WorkerRequest, timeoutMs: number): Promise<WorkerResult & { rawOutput?: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLAUDE_WORKER], {
      timeout: timeoutMs,
      env: { ...process.env, GEMINI_API_KEY },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('close', () => {
      try {
        resolve(JSON.parse(output))
      } catch {
        resolve({ error: 'Worker process returned invalid output', rawOutput: output.slice(0, 500) })
      }
    })
    child.on('error', (err) => resolve({ error: err.message }))
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

function isTransientWorkerError(error: string): boolean {
  const lower = error.toLowerCase()
  return lower.includes('503') || lower.includes('high demand') || lower.includes('temporarily') || lower.includes('invalid output')
}

async function callClaude(prompt: string, timeoutMs: number): Promise<WorkerResult> {
  const first = await runClaudeWorker({ prompt }, timeoutMs)
  if (!('error' in first) || !isTransientWorkerError(first.error)) return first

  await sleep(1500)
  const second = await runClaudeWorker({ prompt }, timeoutMs)
  if (!('error' in second) || !isTransientWorkerError(second.error)) return second

  return second.error.includes('invalid output')
    ? { error: 'Worker process returned invalid output after retry' }
    : second
}

type ToolExecutionData = {
  mpfs: MpfsData
  ncci: NcciData
  mue: MueData
  lcdCoverage: LcdCoverageData
  asp: AspData
  clfs: ClfsData
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  data: ToolExecutionData
): unknown {
  switch (name) {
    case 'lookup_mpfs_rate': {
      const code = String(args.cptCode ?? '').trim().toUpperCase()
      const rate = getMpfsRate(data.mpfs[code]) ?? data.clfs[code]?.rate ?? null
      return { code, rate, source: rate != null ? (data.mpfs[code] ? 'mpfs' : 'clfs') : 'not_found' }
    }
    case 'check_ncci_bundling': {
      const code = String(args.cptCode ?? '').trim().toUpperCase()
      const allCodes = new Set(((args.allCodesOnBill as string[] | undefined) ?? []).map((value) => value.toUpperCase()))
      const entry = getNcciEntry(code, data.ncci)
      if (!entry) return { ncciViolation: false }
      const bundledWith = entry.bundledInto.filter((candidate) => allCodes.has(candidate))
      const modifiers = ((args.modifiers as string[] | undefined) ?? []).map((value) => value.trim())
      const hasModifier59 = modifiers.some((modifier) => ['59', '-59', 'XE', 'XP', 'XS', 'XU'].includes(modifier))
      return {
        ncciViolation: bundledWith.length > 0,
        bundledWith,
        modifierCanOverride: entry.modifierCanOverride,
        hasModifier59,
      }
    }
    case 'check_mue_units': {
      const code = String(args.cptCode ?? '').trim().toUpperCase()
      const unitsBilled = Number(args.unitsBilled ?? 0)
      const entry = data.mue[code]
      if (!entry) return { hasMue: false }
      return {
        hasMue: true,
        maxUnits: entry.maxUnits,
        adjudicationType: entry.adjudicationType,
        exceedsLimit: entry.adjudicationType === 'date_of_service' && unitsBilled > entry.maxUnits,
      }
    }
    case 'check_lcd_coverage': {
      const code = String(args.cptCode ?? '').trim().toUpperCase()
      const icd10Codes = ((args.icd10Codes as string[] | undefined) ?? []).map((value) => value.toUpperCase())
      const entry = data.lcdCoverage[code]
      if (!entry) return { hasLcd: false }
      const hasCoveredDx = icd10Codes.some((icd) =>
        entry.covered.some((covered) => icd.startsWith(covered.toUpperCase()))
      )
      const hasExcludedDx = icd10Codes.some((icd) =>
        entry.notCovered.some((excluded) => icd.startsWith(excluded.toUpperCase()))
      )
      return {
        hasLcd: true,
        lcdIds: entry.lcdIds,
        hasCoveredDx,
        hasExcludedDx,
        coveredCount: entry.covered.length,
      }
    }
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

async function callClaudeWithTools(prompt: string, timeoutMs: number): Promise<WorkerResult> {
  const contents: Array<{ role: string; parts: unknown[] }> = [{ role: 'user', parts: [{ text: prompt }] }]
  const maxTurns = 4

  for (let attempt = 0; attempt < maxTurns; attempt++) {
    const result = await runClaudeWorker({ contents, tools: AUDIT_TOOL_DECLARATIONS }, timeoutMs)
    if ('error' in result) return result

    const functionCalls = result.functionCalls ?? []
    if (functionCalls.length === 0) return result

    const modelParts = Array.isArray(result.parts) && result.parts.length > 0
      ? result.parts
      : functionCalls.map((functionCall) => ({ functionCall }))

    contents.push({ role: 'model', parts: modelParts })
    contents.push({
      role: 'function',
      parts: functionCalls.map((functionCall) => ({
        functionResponse: {
          name: functionCall.name,
          response: executeTool(functionCall.name, functionCall.args ?? {}, {
            mpfs,
            ncci,
            mue,
            lcdCoverage,
            asp,
            clfs,
          }),
        },
      })),
    })
  }

  return { error: 'Tool-calling loop exceeded maximum turns' }
}

// Static data — loaded once at module init, never per-request
let mpfs: MpfsData = {}
let ncci: NcciData = {}
let asp: AspData = {}
let clfs: ClfsData = {}
let mue: MueData = {}
let emMdmTiers: EmMdmTierData = {}
let lcdCoverage: LcdCoverageData = {}

// CPT_DESCRIPTIONS, getMpfsRate, getNcciEntry are re-exported from audit-rules.ts

// Try to load static data — fail silently if not built yet
try { mpfs = (await import('$lib/data/mpfs.json', { assert: { type: 'json' } })).default } catch {}
try { ncci = (await import('$lib/data/ncci.json', { assert: { type: 'json' } })).default } catch {}
try { asp = (await import('$lib/data/asp.json', { assert: { type: 'json' } })).default } catch {}
try { clfs = (await import('$lib/data/clfs.json', { assert: { type: 'json' } })).default } catch {}
try { mue = (await import('$lib/data/mue.json', { assert: { type: 'json' } })).default as MueData } catch {}
try {
  const rawEmMdmTiers = (await import('$lib/data/em_mdm_tiers.json', { assert: { type: 'json' } })).default as unknown as Record<string, string>
  emMdmTiers = Object.fromEntries(
    Object.entries(rawEmMdmTiers).filter(([key]) => !key.startsWith('_'))
  ) as EmMdmTierData
} catch {}
try { lcdCoverage = (await import('$lib/data/lcd_coverage.json', { assert: { type: 'json' } })).default as LcdCoverageData } catch {}

function isRefusal(text: string): boolean {
  const refusalPhrases = ["i can't", "i cannot", "i'm unable", "i won't", "i am unable", "not able to", "cannot process", "cannot assist"]
  return refusalPhrases.some(p => text.toLowerCase().includes(p))
}

function isTransientModelFailure(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('503') || lower.includes('high demand') || lower.includes('invalid output')
}

function extractJSON(text: string): string {
  // Try code fence first, then outermost {...} block, then raw text
  const codeFence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeFence) return codeFence[1].trim()
  const jsonBlock = text.match(/(\{[\s\S]*\})/)
  if (jsonBlock) return jsonBlock[1].trim()
  return text.trim()
}

function normalizeConfidence(value: unknown): ConfidenceLevel | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized
  return undefined
}

function normalizeFindings(findings: AuditResult['findings']): AuditResult['findings'] {
  return findings.map((finding) => ({
    ...finding,
    confidence: normalizeConfidence((finding as { confidence?: unknown }).confidence),
  }))
}

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
])

function extractStateFromHospitalName(hospitalName: string): string {
  const match = hospitalName.match(/\b([A-Z]{2})\b/g)
  if (!match) return ''
  const state = match.find((code) => US_STATE_CODES.has(code))
  return state ?? ''
}

function buildHospitalPriceContext(
  hospitalPrices: HospitalPriceResult | null,
  findings: AuditResult['findings'],
  lineItems: BillInput['lineItems']
): string {
  if (!hospitalPrices) return ''

  const hospitalPriceLines: string[] = []
  for (const finding of findings) {
    const f = finding as typeof finding & { hospitalGrossCharge?: number }
    if (f.hospitalGrossCharge == null) continue
    const lineItem = lineItems[finding.lineItemIndex]
    if (!lineItem || lineItem.billedAmount <= f.hospitalGrossCharge) continue
    hospitalPriceLines.push(
      `CPT ${finding.cptCode}: billed $${lineItem.billedAmount.toFixed(2)}, ` +
      `hospital's own published gross charge $${f.hospitalGrossCharge.toFixed(2)} ` +
      `(source: ${hospitalPrices.mrfUrl})`
    )
  }

  if (hospitalPriceLines.length === 0) return ''

  return [
    '',
    'Hospital\'s own CMS-required price transparency file shows these discrepancies:',
    hospitalPriceLines.join('\n'),
    'Include a paragraph citing these discrepancies and the MRF URL as evidence.',
    '',
  ].join('\n')
}

/**
 * For line items that have no existing finding, check whether the billed amount
 * exceeds the hospital's own published gross charge and create a warning.
 */
function buildAboveListPriceFindings(
  lineItems: BillInput['lineItems'],
  hospitalPrices: HospitalPriceResult | null,
  existingIndexes: Set<number>
): AuditResult['findings'] {
  if (!hospitalPrices) return []

  const findings: AuditResult['findings'] = []

  for (let i = 0; i < lineItems.length; i++) {
    if (existingIndexes.has(i)) continue

    const lineItem = lineItems[i]
    const code = lineItem.cpt.trim().toUpperCase()
    const record = hospitalPrices.charges[code]
    if (!record) continue

    const grossCharge = record.grossCharge
    if (grossCharge == null || lineItem.billedAmount <= grossCharge) continue

    const overcharge = lineItem.billedAmount - grossCharge

    findings.push({
      lineItemIndex: i,
      cptCode: code,
      severity: 'warning',
      errorType: 'above_hospital_list_price',
      confidence: 'high',
      description: `${code} was billed at $${lineItem.billedAmount.toFixed(2)}, but this hospital's own CMS-required price transparency file lists the gross charge as $${grossCharge.toFixed(2)} — a difference of $${overcharge.toFixed(2)}. The billed amount exceeds the hospital's own published rate.`,
      standardDescription: CPT_DESCRIPTIONS[code] ?? lineItem.description,
      recommendation: `Ask billing why the charge exceeds the hospital's published gross charge of $${grossCharge.toFixed(2)}. The hospital's own price transparency file (${hospitalPrices.mrfUrl}) is public record and can be cited in a dispute.`,
      medicareRate: getMpfsRate(mpfs[code]) ?? clfs[code]?.rate,
      markupRatio: undefined,
      ncciBundledWith: undefined,
      hospitalGrossCharge: grossCharge,
      hospitalCashPrice: record.discountedCash ?? undefined,
      hospitalPriceSource: hospitalPrices.mrfUrl || undefined,
    })
  }

  return findings
}

// Thin wrappers that bind module-level data to the pure functions in audit-rules.ts
function buildDataContext(lineItems: BillInput['lineItems']): string {
  return _buildDataContext(lineItems, ncci, mpfs, asp, clfs)
}

function buildDeterministicFindings(lineItems: BillInput['lineItems']): {
  findings: AuditResult['findings']
  promptNote: string
} {
  return _buildDeterministicFindings(lineItems, ncci, mpfs, asp, clfs, mue, emMdmTiers, lcdCoverage)
}

export async function auditBill(input: BillInput): Promise<AuditResult> {
  const dataContext = buildDataContext(input.lineItems)
  const { findings: deterministicCoreFindings, promptNote } = buildDeterministicFindings(input.lineItems)
  const arithmeticFindings = buildArithmeticFindings(input.lineItems, input.billTotal)
  const dateFindings = buildDateFindings(input.lineItems, input.admissionDate, input.dischargeDate)
  const gfeFindings = buildGfeFindings(input.lineItems, input.goodFaithEstimate)
  const deterministicFindings = [...deterministicCoreFindings, ...arithmeticFindings, ...dateFindings, ...gfeFindings]
  const deterministicCodes = new Set(
    deterministicFindings
      .filter((finding) => finding.lineItemIndex >= 0)
      .map((finding) => `${finding.cptCode}:${finding.lineItemIndex}`)
  )

  // Call 1: findings + summary + extractedMeta
  const prompt1 = `You are a medical billing auditor helping a patient review their hospital bill for errors.

IMPORTANT: Focus only on billing codes and amounts. Do not request or reference any personal health information beyond what is provided.

Bill details:
Hospital: ${input.hospitalName ?? 'Unknown'}
Date of service: ${input.dateOfService ?? 'Unknown'}
Account: ${input.accountNumber ?? 'Unknown'}
Bill total: ${input.billTotal ?? 'Unknown'}
Admission date: ${input.admissionDate ?? 'Unknown'}
Discharge date: ${input.dischargeDate ?? 'Unknown'}

Line items:
${JSON.stringify(input.lineItems, null, 2)}

${dataContext ? `Reference data from CMS (only for codes on this bill):\n${dataContext}` : ''}${promptNote}

Analyze this bill for the following error types. NCCI unbundling, duplicates, and pharmacy markups above 4.5× ASP are already handled above — focus your analysis on:
1. UPCODING: E&M code (99201-99285) that seems too high for the diagnosis codes present. Frame as "may be worth questioning" — you cannot confirm without clinical notes.
2. UNBUNDLING: CPT codes billed separately that NCCI says must be bundled. Check the NCCI bundling rules above. IMPORTANT: If a modifier -59 (or X{EPSU} modifier) is present on the component code, the unbundling may be legitimate — flag it as "warning" rather than "error" and note the modifier in your description. Without modifier -59, flag as "error" with confidence "high" when NCCI data is explicit.
3. ICD10 MISMATCH: Diagnosis codes that don't clinically justify the procedure.

For each finding, add a \`confidence\` field:
- high: supported by explicit CMS data or direct code-to-rule match
- medium: likely issue but some context missing
- low: speculative; use sparingly

For each finding, include \`standardDescription\` — the official clinical name of the CPT/HCPCS code. Do NOT copy from the bill description field.
Use the available tools before making any claim that depends on MPFS, NCCI, MUE, or LCD data. If you mention one of those data sources in a finding, you must have called the corresponding tool first.

For the summary:
- totalBilled: sum of ALL line item billedAmounts
- potentialOvercharge: sum across ALL findings (including confirmed ones above):
  - UPCODING: billedAmount minus Medicare rate for that code
  - UNBUNDLING: full billedAmount of the bundled code
  - PHARMACY_MARKUP: billedAmount minus (ASP × units × 1.06)
  - DUPLICATE: billedAmount of each duplicate occurrence
  - ICD10_MISMATCH: full billedAmount of mismatched procedure
  If billedAmount is 0, use Medicare rate as proxy.
- errorCount: count of findings with severity "error"
- warningCount: count of findings with severity "warning"
- cleanCount: count of line items with NO finding

Respond ONLY with valid JSON:
{
  "findings": [
    {
      "lineItemIndex": 0,
      "cptCode": "99285",
      "severity": "warning",
      "errorType": "upcoding",
      "confidence": "medium",
      "description": "Patient-friendly explanation",
      "standardDescription": "Emergency department visit, high medical decision making complexity",
      "medicareRate": 150.00,
      "markupRatio": null,
      "ncciBundledWith": null,
      "recommendation": "What patient should do"
    }
  ],
  "summary": {
    "totalBilled": 1500.00,
    "potentialOvercharge": 450.00,
    "errorCount": 1,
    "warningCount": 2,
    "cleanCount": 3
  },
  "extractedMeta": {
    "hospitalName": "General Hospital",
    "accountNumber": "12345",
    "dateOfService": "2024-01-15"
  }
}`

  const result1 = await callClaudeWithTools(prompt1, 90_000)

  if ('error' in result1) {
    if (result1.error.includes('timed out') || result1.error.includes('timeout')) {
      throw new AuditTimeoutError()
    }
    if (isTransientModelFailure(result1.error)) {
      throw new AuditTimeoutError('Gemini is busy right now — please try again.')
    }
    if (result1.error.includes('invalid output')) {
      throw new AuditParseError(result1.error)
    }
    throw new Error(result1.error)
  }

  if (isRefusal(result1.text)) throw new AuditRefusalError()

  let call1Result: { findings: AuditResult['findings']; summary: AuditResult['summary']; extractedMeta: AuditResult['extractedMeta'] }
  try {
    call1Result = JSON.parse(extractJSON(result1.text))
    call1Result.findings = normalizeFindings(call1Result.findings ?? [])
  } catch {
    throw new AuditParseError(`Raw response: ${result1.text.slice(0, 200)}`)
  }

  // Merge deterministic pre-findings with AI findings.
  // De-duplicate: if AI already flagged a code the deterministic layer caught, prefer deterministic.
  const aiFindings = call1Result.findings.filter(
    (finding) => !deterministicCodes.has(`${finding.cptCode}:${finding.lineItemIndex}`)
  )
  call1Result.findings = [...deterministicFindings, ...aiFindings]

  // Recompute summary counts to include deterministic findings
  const totalBilled = input.lineItems.reduce((s, li) => s + li.billedAmount, 0)
  const potentialOvercharge = call1Result.findings.reduce((s, f) => {
    const li = input.lineItems[f.lineItemIndex]
    const billedAmt = li?.billedAmount ?? 0
    const mpfsRate = getMpfsRate(mpfs[f.cptCode]) ?? clfs[f.cptCode]?.rate ?? 0
    if (f.errorType === 'upcoding') return s + Math.max(0, billedAmt - mpfsRate)
    if (f.errorType === 'unbundling') return s + (billedAmt || mpfsRate)
    if (f.errorType === 'pharmacy_markup') {
      const aspRate = asp[f.cptCode] ?? 0
      return s + Math.max(0, billedAmt - aspRate * (li?.units ?? 1) * 1.06)
    }
    if (f.errorType === 'duplicate') return s + (billedAmt || mpfsRate)
    if (f.errorType === 'icd10_mismatch') return s + (billedAmt || mpfsRate)
    if (f.errorType === 'arithmetic_error') return s + Math.abs(totalBilled - (input.billTotal ?? totalBilled))
    if (f.errorType === 'date_error') return s + (billedAmt || mpfsRate)
    if (f.errorType === 'no_surprises_act') return s + Math.max(0, totalBilled - (input.goodFaithEstimate ?? 0))
    if (f.errorType === 'above_hospital_list_price') {
      const hosp = (f as typeof f & { hospitalGrossCharge?: number }).hospitalGrossCharge ?? 0
      return s + Math.max(0, billedAmt - hosp)
    }
    return s
  }, 0)
  call1Result.summary = {
    ...call1Result.summary,
    totalBilled,
    potentialOvercharge: Math.round(potentialOvercharge * 100) / 100,
    errorCount: call1Result.findings.filter(f => f.severity === 'error').length,
    warningCount: call1Result.findings.filter(f => f.severity === 'warning').length,
    cleanCount: input.lineItems.length - new Set(
      call1Result.findings
        .filter((finding) => finding.lineItemIndex >= 0)
        .map((finding) => finding.lineItemIndex)
    ).size,
  }

  const hospitalName = input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? ''
  const stateFromAddress = input.hospitalAddress
    ? extractStateFromHospitalName(input.hospitalAddress)
    : ''
  const state = stateFromAddress || extractStateFromHospitalName(hospitalName)
  const hospitalPhone = input.hospitalPhone ?? null
  const allCodes = input.lineItems.map((lineItem) => lineItem.cpt)

  let hospitalPrices: HospitalPriceResult | null = null
  try {
    hospitalPrices = await lookupHospitalPrices(hospitalName, state, allCodes, hospitalPhone ?? undefined)
  } catch (error) {
    console.warn('[claude.ts] Hospital price lookup failed:', error)
  }

  const enrichedFindings = call1Result.findings.map((finding) => {
    if (!hospitalPrices) return finding
    const record = hospitalPrices.charges[finding.cptCode]
    if (!record) return finding
    return {
      ...finding,
      hospitalGrossCharge: record.grossCharge ?? undefined,
      hospitalCashPrice: record.discountedCash ?? undefined,
      hospitalPriceSource: hospitalPrices.mrfUrl || undefined,
    }
  })

  const existingFindingIndexes = new Set(enrichedFindings.map(f => f.lineItemIndex))
  const aboveListFindings = buildAboveListPriceFindings(
    input.lineItems,
    hospitalPrices,
    existingFindingIndexes
  )
  const allFindings = [...enrichedFindings, ...aboveListFindings]

  const hospitalPriceContext = buildHospitalPriceContext(hospitalPrices, allFindings, input.lineItems)

  // Call 2: dispute letter
  const prompt2 = `You are a medical billing auditor helping a patient write a dispute letter.

Bill details:
Hospital: ${input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? 'Unknown'}
Date of service: ${input.dateOfService ?? call1Result.extractedMeta?.dateOfService ?? 'Unknown'}
Account: ${input.accountNumber ?? call1Result.extractedMeta?.accountNumber ?? 'Unknown'}

Findings from billing audit:
${JSON.stringify(allFindings, null, 2)}${hospitalPriceContext}

Generate a dispute letter for the patient. Use these EXACT placeholder strings (they will be highlighted in amber in the UI):
- [Your Full Name]
- [Your Mailing Address]
- [Today's Date]
- [Account Number / Patient ID] — replace with extracted account number if found
- [Date of Service] — replace with extracted date if found
- [Hospital Name] — replace with extracted hospital name if found

Letter must include: (1) opening citing right to dispute, (2) itemized table of flagged codes with reason and Medicare benchmark, (3) request for corrected bill or written justification, (4) regulatory reference to CMS billing rights (42 CFR 405.374), (5) signature block.

Respond ONLY with valid JSON matching this exact schema:
{
  "disputeLetter": {
    "text": "Full letter text with [placeholder] markers",
    "placeholders": ["[Your Full Name]", "[Your Mailing Address]"]
  }
}`

  const result2 = await callClaude(prompt2, 60_000)

  if ('error' in result2) {
    if (result2.error.includes('timed out') || result2.error.includes('timeout')) {
      throw new AuditTimeoutError()
    }
    if (isTransientModelFailure(result2.error)) {
      throw new AuditTimeoutError('Gemini is busy right now — please try again.')
    }
    if (result2.error.includes('invalid output')) {
      throw new AuditParseError(result2.error)
    }
    throw new Error(result2.error)
  }

  if (isRefusal(result2.text)) throw new AuditRefusalError()

  let call2Result: { disputeLetter: AuditResult['disputeLetter'] }
  try {
    call2Result = JSON.parse(extractJSON(result2.text))
  } catch {
    throw new AuditParseError(`Raw response: ${result2.text.slice(0, 200)}`)
  }

  const aboveHospitalListCount = allFindings.reduce((count, finding) => {
    const record = finding as typeof finding & { hospitalGrossCharge?: number }
    const lineItem = input.lineItems[finding.lineItemIndex]
    if (record.hospitalGrossCharge != null && lineItem && lineItem.billedAmount > record.hospitalGrossCharge) {
      return count + 1
    }
    return count
  }, 0)

  const aboveHospitalListTotal = allFindings.reduce((total, finding) => {
    const record = finding as typeof finding & { hospitalGrossCharge?: number }
    const lineItem = input.lineItems[finding.lineItemIndex]
    if (record.hospitalGrossCharge != null && lineItem && lineItem.billedAmount > record.hospitalGrossCharge) {
      return total + (lineItem.billedAmount - record.hospitalGrossCharge)
    }
    return total
  }, 0)

  return {
    ...call1Result,
    findings: allFindings,
    summary: {
      ...call1Result.summary,
      aboveHospitalListCount,
      aboveHospitalListTotal,
      hospitalName: hospitalPrices?.hospitalName || undefined,
      hospitalMrfUrl: hospitalPrices?.mrfUrl || undefined,
    },
    ...call2Result,
  } as AuditResult
}
