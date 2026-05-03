# Step 13: Audit Engine — Full SQLite, Remove LLM Findings

> **AGENT INSTRUCTIONS:** You are implementing step 13 — the most complex step.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–12 must ALL be complete.
> Read `next-steps/README.md` for full project context.
> This step rewrites the audit orchestration to be fully deterministic.
> The LLM now ONLY generates the dispute letter. Findings are 100% from SQLite lookups.

**Files to modify:**
- `src/lib/server/claude.ts` — rewrite audit orchestration
- `src/lib/server/audit-rules.ts` — complete the remaining deterministic rules
- `src/lib/server/claude-worker.mjs` — simplify to letter-only generation
- `src/lib/types.ts` — add new finding types

---

## Task 1: Understand current flow

Current flow in `claude.ts`:
1. Load JSON data (ncci, mpfs, asp, clfs, mue, lcdCoverage) at module init
2. Build `dataContext` string (code lookup results injected as text)
3. Call `buildDeterministicFindings` (NCCI, duplicates, pharmacy markup)
4. Call Gemini with tool-use to let the LLM also find upcoding, LCD mismatches, etc.
5. Merge LLM findings with deterministic findings
6. Call Gemini again to generate dispute letter

New flow:
1. All data comes from SQLite via `data-loader.ts` (no module-init JSON loading)
2. Run ALL deterministic checks (steps 01–10 data sources)
3. Build `disputeLetterContext` from the findings
4. Call Gemini ONLY to format the dispute letter
5. Return findings + letter

---

## Task 2: Update audit-rules.ts — complete all deterministic rules

Open `src/lib/server/audit-rules.ts`. Remove all old JSON-based parameters and complete the function.

- [ ] Remove parameters `mpfs`, `asp`, `clfs`, `mue`, `emMdmTiers`, `lcdCoverage` from `buildDeterministicFindings`.
  All lookups now happen internally via `data-loader.ts` imports.

- [ ] Updated function signature:

```typescript
export function buildDeterministicFindings(
  lineItems: LineItem[],
  billType: BillType = 'unknown',
  serviceDateStr?: string,
  drgCode?: string,
  patientState?: string,
  serviceZip?: string
): { findings: AuditFinding[]; summary: string } {
```

Note: return type changes — instead of `promptNote`, return a `summary` string that will be passed to the
dispute letter LLM.

- [ ] Inside the function, use `data-loader.ts` imports for all lookups:

```typescript
import {
  loadNcciPairs, loadMueEdit, loadMpfsRate, loadClfsRate,
  loadAspLimit, loadOppsRate, loadDrgRate, loadDmeposRate,
  loadAmbulanceRate, toServiceDateInt
} from './data-loader'
import type { BillType } from '$lib/types'
```

- [ ] Implement ALL checks in order:

**Check 1: NCCI unbundling** (already done in step 01)

**Check 2: MUE units** (already done in step 02)

**Check 3: Pharmacy markup / ASP** (already done in step 05)

**Check 4: OPPS benchmark** (already done in step 06, only for outpatient)

**Check 5: IPPS/DRG** (already done in step 07, only for inpatient with DRG)

**Check 6: DMEPOS** (already done in step 08, only for DME)

**Check 7: Duplicate billing** — keep existing logic:

```typescript
  // Check 7: Exact duplicate billing
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
```

**Check 8: Medicare rate comparison** — deterministic upcoding check using MPFS/CLFS/OPPS rates:

```typescript
  // Check 8: Rate comparison (upcoding check)
  // For each code not already flagged, compare billed to Medicare benchmark
  const HIGH_MARKUP_THRESHOLD = 5.0  // flag if billed > 5x Medicare rate
  const MODERATE_MARKUP_THRESHOLD = 2.5  // warn if billed > 2.5x

  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (alreadyFlaggedCodes.has(code)) continue

    const billed = lineItems[i].billedAmount
    if (!billed || billed <= 0) continue

    // Get benchmark rate
    let benchmark: number | null = null
    let benchmarkSource = ''

    if (billType === 'outpatient') {
      const oppsRow = loadOppsRate(code)
      if (oppsRow?.payment_rate) {
        benchmark = oppsRow.payment_rate
        benchmarkSource = `CMS OPPS (APC ${oppsRow.apc})`
      }
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
```

- [ ] Build the summary string:

```typescript
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
```

- [ ] Run: `npm run check`

---

## Task 3: Update claude-worker.mjs — letter-only

The Gemini worker now ONLY generates the dispute letter. No tool calls, no findings analysis.

- [ ] Open `src/lib/server/claude-worker.mjs`
- [ ] Simplify to a single prompt call:

```javascript
/**
 * claude-worker.mjs
 * Child process: receives audit context + deterministic findings via stdin,
 * calls Gemini to generate a dispute letter.
 * Writes { text } or { error } to stdout.
 */
import { GoogleGenerativeAI } from '@google/generative-ai'

let inputData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { inputData += chunk })
process.stdin.on('end', async () => {
  try {
    const { prompt } = JSON.parse(inputData.trim())

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.3 },
    })

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    process.stdout.write(JSON.stringify({ text }))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }))
    process.exit(0)
  }
})
```

---

## Task 4: Rewrite claude.ts audit orchestration

- [ ] Open `src/lib/server/claude.ts` and replace it with this rewritten version:

```typescript
import { spawn } from 'child_process'
import { join } from 'path'
import { GEMINI_API_KEY } from '$env/static/private'
import type { BillInput, AuditResult, AuditFinding } from '$lib/types'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'
import { lookupHospitalPricesV2 } from './hospital-prices-v2'
import { createServerLogger, serializeError } from './logger.js'
import {
  buildDeterministicFindings,
  buildArithmeticFindings,
  buildDateFindings,
  buildGfeFindings,
  CPT_DESCRIPTIONS,
} from './audit-rules'
import { toServiceDateInt } from './data-loader'

const CLAUDE_WORKER = join(process.cwd(), 'src/lib/server/claude-worker.mjs')

function createAuditLogger(traceId?: string) {
  return createServerLogger('audit-core', traceId)
}

function runWorker(prompt: string, timeoutMs: number, traceId?: string): Promise<{ text?: string; error?: string }> {
  const log = createAuditLogger(traceId)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLAUDE_WORKER], {
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, GEMINI_API_KEY },
    })
    let output = ''
    child.stdout?.on('data', (c: Buffer) => { output += c.toString() })
    child.on('close', () => {
      try { resolve(JSON.parse(output)) }
      catch { resolve({ error: 'Invalid worker output' }) }
    })
    child.on('error', (err) => {
      log.error('worker-error', { error: serializeError(err) })
      resolve({ error: err.message })
    })
    child.stdin.write(JSON.stringify({ prompt, traceId }))
    child.stdin.end()
  })
}

function buildDisputeLetterPrompt(
  billInput: BillInput,
  findings: AuditFinding[],
  summary: string,
  hospitalPrices: Awaited<ReturnType<typeof lookupHospitalPricesV2>>
): string {
  const errorFindings = findings.filter(f => f.severity === 'error')
  const warningFindings = findings.filter(f => f.severity === 'warning')
  const totalBilled = billInput.lineItems.reduce((s, li) => s + (li.billedAmount ?? 0), 0)

  const findingLines = findings
    .filter(f => f.lineItemIndex >= 0)
    .map(f => {
      const li = billInput.lineItems[f.lineItemIndex]
      const rate = f.medicareRate ? ` (Medicare rate: $${f.medicareRate.toFixed(2)})` : ''
      return `- CPT ${f.cptCode}: ${f.description}${rate}`
    })
    .join('\n')

  const hospitalPricingNote = hospitalPrices
    ? `\nHospital's own published prices (from their CMS Machine-Readable File) were also reviewed. Where billed amounts exceed the hospital's own published gross charge, this is noted in the findings.`
    : ''

  return `You are a medical billing advocate writing a formal dispute letter on behalf of a patient.

Bill details:
- Hospital/provider: ${billInput.hospitalName ?? '[HOSPITAL NAME]'}
- Bill type: ${billInput.billType ?? 'unknown'}
- Date of service: ${billInput.dateOfService ?? 'unknown'}
- Account number: ${billInput.accountNumber ?? '[ACCOUNT NUMBER]'}
- Total billed: $${totalBilled.toFixed(2)}

Audit summary:
${summary}

Confirmed billing errors and warnings (determined by CMS rule tables, NOT AI inference):
${findingLines || 'No specific billing errors identified.'}
${hospitalPricingNote}

Write a professional, factual dispute letter from the patient to the hospital billing department.
The letter should:
1. Reference specific CPT codes and findings from the CMS audit
2. Request itemized explanations for each flagged charge
3. Cite applicable CMS policies where relevant (NCCI, MUE, MPFS, OPPS as applicable)
4. Use formal but firm language
5. Include placeholders [PATIENT NAME] and [DATE] where appropriate
6. NOT make claims about findings not listed above

Format as a complete letter with greeting, body paragraphs, and closing. Use markdown table for the disputed charges.`
}

export async function auditBill(
  billInput: BillInput,
  traceId?: string
): Promise<AuditResult> {
  const log = createAuditLogger(traceId)
  log.info('audit-start', { lineItemCount: billInput.lineItems.length, billType: billInput.billType })

  // --- Step 1: Deterministic findings from SQLite ---
  const serviceDateStr = billInput.dateOfService ?? billInput.admissionDate
  const { findings: deterministicFindings, summary } = buildDeterministicFindings(
    billInput.lineItems,
    billInput.billType ?? 'unknown',
    serviceDateStr,
    billInput.drgCode,
    billInput.patientState,
    billInput.serviceZip
  )

  // Arithmetic and date findings
  const arithmeticFindings = buildArithmeticFindings(billInput.lineItems, billInput.billTotal)
  const dateFindings = buildDateFindings(billInput.lineItems, billInput.admissionDate, billInput.dischargeDate)
  const gfeFindings = buildGfeFindings(billInput.lineItems, billInput.goodFaithEstimate)

  const allFindings = [...deterministicFindings, ...arithmeticFindings, ...dateFindings, ...gfeFindings]

  log.info('deterministic-findings-complete', {
    findingCount: allFindings.length,
    errors: allFindings.filter(f => f.severity === 'error').length,
  })

  // --- Step 2: Hospital price comparison ---
  let hospitalPrices: Awaited<ReturnType<typeof lookupHospitalPricesV2>> = null
  if (billInput.hospitalName && billInput.hospitalAddress) {
    const stateMatch = billInput.hospitalAddress.match(/\b([A-Z]{2})\b/)
    const state = stateMatch?.[1] ?? billInput.patientState ?? ''
    try {
      hospitalPrices = await lookupHospitalPricesV2(
        billInput.hospitalName,
        state,
        billInput.lineItems.map(li => li.cpt),
        billInput.hospitalPhone
      )

      // Add hospital list price findings
      if (hospitalPrices) {
        for (let i = 0; i < billInput.lineItems.length; i++) {
          const li = billInput.lineItems[i]
          const charge = hospitalPrices.charges[li.cpt]
          if (!charge?.grossCharge) continue
          if (li.billedAmount > charge.grossCharge) {
            allFindings.push({
              lineItemIndex: i,
              cptCode: li.cpt,
              severity: 'error',
              errorType: 'above_hospital_list_price',
              confidence: 'high',
              description: `CPT ${li.cpt} is billed at $${li.billedAmount.toFixed(2)}, which exceeds ${billInput.hospitalName}'s own published gross charge of $${charge.grossCharge.toFixed(2)}.`,
              standardDescription: CPT_DESCRIPTIONS[li.cpt],
              recommendation: `Request explanation for why the billed amount exceeds the hospital's own published price. You may cite the hospital's CMS Machine-Readable File.`,
              medicareRate: undefined,
              markupRatio: undefined,
              ncciBundledWith: undefined,
              hospitalGrossCharge: charge.grossCharge,
              hospitalCashPrice: charge.discountedCash ?? undefined,
              hospitalPriceSource: hospitalPrices.mrfUrl,
            })
          }
        }
      }
    } catch (err) {
      log.warn('hospital-price-lookup-failed', { error: serializeError(err as Error) })
    }
  }

  // --- Step 3: Generate dispute letter via LLM ---
  const letterPrompt = buildDisputeLetterPrompt(billInput, allFindings, summary, hospitalPrices)
  const letterResult = await runWorker(letterPrompt, 60_000, traceId)

  let disputeLetterText = ''
  if (letterResult.text) {
    disputeLetterText = letterResult.text
  } else {
    log.warn('letter-generation-failed', { error: letterResult.error })
    disputeLetterText = generateFallbackLetter(billInput, allFindings)
  }

  // Extract placeholders
  const placeholderMatches = disputeLetterText.match(/\[[^\]]+\]/g) ?? []
  const placeholders = [...new Set(placeholderMatches)]

  // --- Step 4: Build summary ---
  const errorCount = allFindings.filter(f => f.severity === 'error').length
  const warningCount = allFindings.filter(f => f.severity === 'warning').length
  const totalBilled = billInput.lineItems.reduce((s, li) => s + (li.billedAmount ?? 0), 0)
  const potentialOvercharge = allFindings
    .filter(f => f.severity === 'error' && f.lineItemIndex >= 0)
    .reduce((s, f) => s + (billInput.lineItems[f.lineItemIndex]?.billedAmount ?? 0), 0)

  const aboveHospitalFindings = allFindings.filter(f => f.errorType === 'above_hospital_list_price')

  log.info('audit-complete', {
    findingCount: allFindings.length,
    errorCount,
    warningCount,
    potentialOvercharge,
  })

  return {
    findings: allFindings,
    disputeLetter: { text: disputeLetterText, placeholders },
    summary: {
      totalBilled,
      potentialOvercharge,
      errorCount,
      warningCount,
      cleanCount: billInput.lineItems.length - new Set(allFindings.filter(f => f.lineItemIndex >= 0).map(f => f.lineItemIndex)).size,
      aboveHospitalListCount: aboveHospitalFindings.length || undefined,
      aboveHospitalListTotal: aboveHospitalFindings.reduce((s, f) => s + (billInput.lineItems[f.lineItemIndex]?.billedAmount ?? 0), 0) || undefined,
      hospitalName: hospitalPrices?.hospitalName,
      hospitalMrfUrl: hospitalPrices?.mrfUrl,
    },
    extractedMeta: {
      hospitalName: billInput.hospitalName,
      hospitalAddress: billInput.hospitalAddress,
      hospitalPhone: billInput.hospitalPhone,
      accountNumber: billInput.accountNumber,
      dateOfService: billInput.dateOfService,
      billType: billInput.billType,
    },
  }
}

function generateFallbackLetter(billInput: BillInput, findings: AuditFinding[]): string {
  const errorCount = findings.filter(f => f.severity === 'error').length
  return `[DATE]

[PATIENT NAME]
[ADDRESS]

${billInput.hospitalName ?? '[HOSPITAL NAME]'}
Billing Department

Re: Account Number ${billInput.accountNumber ?? '[ACCOUNT NUMBER]'}

Dear Billing Department,

I am writing to dispute ${errorCount} billing error(s) identified in my bill dated ${billInput.dateOfService ?? '[DATE OF SERVICE]'}.

Please provide itemized documentation for the following flagged charges:

${findings.filter(f => f.severity === 'error').map(f => `- CPT ${f.cptCode}: ${f.description}`).join('\n')}

I request a corrected statement within 30 days.

Sincerely,
[PATIENT NAME]`
}

// Re-export for compatibility
export { CPT_DESCRIPTIONS }
```

- [ ] Remove the old `AUDIT_TOOL_DECLARATIONS` and `audit-tools.mjs` references (no longer needed)
- [ ] Run: `npm run check`

---

## Task 5: Remove audit-tools.mjs (tool declarations no longer used)

The Gemini tool-use loop is gone — the LLM no longer calls tools.

- [ ] Check if `audit-tools.mjs` is imported anywhere other than `claude.ts`
- [ ] If only used by claude.ts (which we rewrote): `rm src/lib/server/audit-tools.mjs`
- [ ] Run: `npm run check && npm run build`

---

## Task 6: Full integration test

```bash
cd /root/projects/hospital-bill-checker
npm run check
npm run build
npm run test
```

All tests should pass. Fix any remaining TypeScript errors.

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/lib/server/claude.ts src/lib/server/audit-rules.ts \
        src/lib/server/claude-worker.mjs src/lib/types.ts
git rm --cached src/lib/server/audit-tools.mjs 2>/dev/null || true
git commit -m "feat: fully deterministic audit engine — llm only for dispute letter"
```
