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
  const totalBilled = billInput.lineItems.reduce((s, li) => s + (li.billedAmount ?? 0), 0)

  const findingLines = findings
    .filter(f => f.lineItemIndex >= 0)
    .map(f => {
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
  if (billInput.hospitalName) {
    const stateFromAddr = billInput.hospitalAddress?.match(/\b([A-Z]{2})\b/)?.[1]
    const stateFromName = billInput.hospitalName?.match(/\b([A-Z]{2})\b/)?.[1]
    const state = stateFromAddr ?? stateFromName ?? billInput.patientState ?? ''

    if (state && state.length === 2) {
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
