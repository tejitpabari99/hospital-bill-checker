import { spawn } from 'child_process'
import { join } from 'path'
import { GEMINI_API_KEY } from '$env/static/private'
import type { BillInput, AuditResult, ConfidenceLevel } from '$lib/types'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'
import { lookupHospitalPrices } from './hospital-prices'
import type { HospitalPriceResult } from './hospital-prices'

const CLAUDE_WORKER = join(process.cwd(), 'src/lib/server/claude-worker.mjs')

type WorkerResult = { text: string } | { error: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runClaudeWorker(prompt: string, timeoutMs: number): Promise<WorkerResult & { rawOutput?: string }> {
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
    child.stdin.write(JSON.stringify({ prompt }))
    child.stdin.end()
  })
}

function isTransientWorkerError(error: string): boolean {
  const lower = error.toLowerCase()
  return lower.includes('503') || lower.includes('high demand') || lower.includes('temporarily') || lower.includes('invalid output')
}

async function callClaude(prompt: string, timeoutMs: number): Promise<WorkerResult> {
  const first = await runClaudeWorker(prompt, timeoutMs)
  if (!('error' in first) || !isTransientWorkerError(first.error)) return first

  await sleep(1500)
  const second = await runClaudeWorker(prompt, timeoutMs)
  if (!('error' in second) || !isTransientWorkerError(second.error)) return second

  return second.error.includes('invalid output')
    ? { error: 'Worker process returned invalid output after retry' }
    : second
}

// Static data — loaded once at module init, never per-request
let mpfs: Record<string, number | { rate: number; description?: string }> = {}
let ncci: Record<string, string> = {}
let asp: Record<string, number> = {}

// Try to load static data — fail silently if not built yet
try { mpfs = (await import('$lib/data/mpfs.json', { assert: { type: 'json' } })).default } catch {}
try { ncci = (await import('$lib/data/ncci.json', { assert: { type: 'json' } })).default } catch {}
try { asp = (await import('$lib/data/asp.json', { assert: { type: 'json' } })).default } catch {}

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

function getMpfsRate(entry: number | { rate: number; description?: string } | undefined): number | undefined {
  if (entry === undefined) return undefined
  if (typeof entry === 'number') return entry
  return entry.rate
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

// Pre-compute NCCI and MPFS context to inject into prompt
function buildDataContext(lineItems: BillInput['lineItems']): string {
  const codes = lineItems.map(li => li.cpt)
  const ncciHits: string[] = []
  const mpfsRates: string[] = []
  const aspRates: string[] = []

  for (const code of codes) {
    if (ncci[code]) ncciHits.push(`${code} is bundled into ${ncci[code]} per NCCI rules`)
    const mpfsRate = getMpfsRate(mpfs[code])
    if (mpfsRate !== undefined) mpfsRates.push(`${code}: Medicare rate $${mpfsRate.toFixed(2)}`)
    if (asp[code]) aspRates.push(`${code}: CMS ASP limit $${asp[code].toFixed(2)}`)
  }

  return [
    ncciHits.length ? `NCCI bundling rules:\n${ncciHits.join('\n')}` : '',
    mpfsRates.length ? `Medicare rates (MPFS):\n${mpfsRates.join('\n')}` : '',
    aspRates.length ? `CMS ASP drug limits:\n${aspRates.join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

export async function auditBill(input: BillInput): Promise<AuditResult> {
  const dataContext = buildDataContext(input.lineItems)

  // Call 1: findings + summary + extractedMeta
  const prompt1 = `You are a medical billing auditor helping a patient review their hospital bill for errors.

IMPORTANT: Focus only on billing codes and amounts. Do not request or reference any personal health information beyond what is provided.

Bill details:
Hospital: ${input.hospitalName ?? 'Unknown'}
Date of service: ${input.dateOfService ?? 'Unknown'}
Account: ${input.accountNumber ?? 'Unknown'}

Line items:
${JSON.stringify(input.lineItems, null, 2)}

${dataContext ? `Reference data from CMS:\n${dataContext}` : ''}

Analyze this bill for the following error types:
1. UPCODING: E&M code (99201-99285) that seems too high for the diagnosis codes present. Frame as "may be worth questioning" — you cannot confirm without clinical notes.
2. UNBUNDLING: CPT codes billed separately that NCCI says must be bundled. Check the NCCI data above.
3. PHARMACY MARKUP: J-code billed at >4.5x the CMS ASP limit above. Calculate markup ratio.
4. ICD10 MISMATCH: Diagnosis codes that don't clinically justify the procedure.
5. DUPLICATE: Same CPT + same date appearing more than once.

For each finding, add a \`confidence\` field with one of these exact values:
- high: supported by explicit CMS data or a direct code-to-rule match
- medium: likely issue, but some context is missing or inference is moderate
- low: speculative or weakly supported; use sparingly

For each finding, include \`standardDescription\` — the official clinical name of the CPT or HCPCS code from standard references (e.g. "99285 - Emergency department visit, high medical decision making complexity"). Use your knowledge of CPT codes. Do NOT copy from the bill's description field, which may be redacted or inaccurate.

For the summary:
- totalBilled: sum of all line item billedAmounts
- potentialOvercharge: sum of estimated savings across ALL findings:
  - UPCODING: billedAmount minus Medicare rate (medicareRate) for that code
  - UNBUNDLING: full billedAmount of the unbundled code (since it shouldn't be billed separately)
  - PHARMACY_MARKUP: billedAmount minus (CMS ASP × units × 1.06 allowed markup)
  - DUPLICATE: billedAmount of each extra duplicate occurrence
  - ICD10_MISMATCH: full billedAmount of the mismatched procedure
  If billedAmount is 0 for a line item, use the Medicare rate as a proxy for the overcharge estimate.
- errorCount: count of findings with severity "error"
- warningCount: count of findings with severity "warning"
- cleanCount: count of line items with NO finding

Respond ONLY with valid JSON matching this exact schema:
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

  const result1 = await callClaude(prompt1, 90_000)

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

  const hospitalName = input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? ''
  const state = extractStateFromHospitalName(hospitalName)
  const allCodes = input.lineItems.map((lineItem) => lineItem.cpt)

  let hospitalPrices: HospitalPriceResult | null = null
  try {
    hospitalPrices = await lookupHospitalPrices(hospitalName, state, allCodes)
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

  const hospitalPriceContext = buildHospitalPriceContext(hospitalPrices, enrichedFindings, input.lineItems)

  // Call 2: dispute letter
  const prompt2 = `You are a medical billing auditor helping a patient write a dispute letter.

Bill details:
Hospital: ${input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? 'Unknown'}
Date of service: ${input.dateOfService ?? call1Result.extractedMeta?.dateOfService ?? 'Unknown'}
Account: ${input.accountNumber ?? call1Result.extractedMeta?.accountNumber ?? 'Unknown'}

Findings from billing audit:
${JSON.stringify(enrichedFindings, null, 2)}${hospitalPriceContext}

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

  const aboveHospitalListCount = enrichedFindings.reduce((count, finding) => {
    const record = finding as typeof finding & { hospitalGrossCharge?: number }
    const lineItem = input.lineItems[finding.lineItemIndex]
    if (record.hospitalGrossCharge != null && lineItem && lineItem.billedAmount > record.hospitalGrossCharge) {
      return count + 1
    }
    return count
  }, 0)

  const aboveHospitalListTotal = enrichedFindings.reduce((total, finding) => {
    const record = finding as typeof finding & { hospitalGrossCharge?: number }
    const lineItem = input.lineItems[finding.lineItemIndex]
    if (record.hospitalGrossCharge != null && lineItem && lineItem.billedAmount > record.hospitalGrossCharge) {
      return total + (lineItem.billedAmount - record.hospitalGrossCharge)
    }
    return total
  }, 0)

  return {
    ...call1Result,
    findings: enrichedFindings,
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
