import Anthropic from '@anthropic-ai/sdk'
import type { BillInput, AuditResult } from '$lib/types'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'

// Static data — loaded once at module init, never per-request
let mpfs: Record<string, number> = {}
let ncci: Record<string, string> = {}
let asp: Record<string, number> = {}

// Try to load static data — fail silently if not built yet
try { mpfs = (await import('$lib/data/mpfs.json', { assert: { type: 'json' } })).default } catch {}
try { ncci = (await import('$lib/data/ncci.json', { assert: { type: 'json' } })).default } catch {}
try { asp = (await import('$lib/data/asp.json', { assert: { type: 'json' } })).default } catch {}

const client = new Anthropic()

function isRefusal(text: string): boolean {
  const refusalPhrases = ["i can't", "i cannot", "i'm unable", "i won't", "i am unable", "not able to", "cannot process", "cannot assist"]
  return refusalPhrases.some(p => text.toLowerCase().includes(p))
}

function extractJSON(text: string): string {
  // Strip markdown code blocks if present
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

// Pre-compute NCCI and MPFS context to inject into prompt
function buildDataContext(lineItems: BillInput['lineItems']): string {
  const codes = lineItems.map(li => li.cpt)
  const ncciHits: string[] = []
  const mpfsRates: string[] = []
  const aspRates: string[] = []

  for (const code of codes) {
    if (ncci[code]) ncciHits.push(`${code} is bundled into ${ncci[code]} per NCCI rules`)
    if (mpfs[code]) mpfsRates.push(`${code}: Medicare rate $${mpfs[code].toFixed(2)}`)
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

  const prompt = `You are a medical billing auditor helping a patient review their hospital bill for errors.

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

Also generate a dispute letter. Use these EXACT placeholder strings (they will be highlighted in amber in the UI):
- [Your Full Name]
- [Your Mailing Address]
- [Today's Date]
- [Account Number / Patient ID] — replace with extracted account number if found
- [Date of Service] — replace with extracted date if found
- [Hospital Name] — replace with extracted hospital name if found

Letter must include: (1) opening citing right to dispute, (2) itemized table of flagged codes with reason and Medicare benchmark, (3) request for corrected bill or written justification, (4) regulatory reference to CMS billing rights (42 CFR 405.374), (5) signature block.

Respond ONLY with valid JSON matching this exact schema:
{
  "findings": [
    {
      "lineItemIndex": 0,
      "cptCode": "99285",
      "severity": "warning",
      "errorType": "upcoding",
      "description": "Patient-friendly explanation",
      "medicareRate": 150.00,
      "markupRatio": 3.5,
      "ncciBundledWith": null,
      "recommendation": "What patient should do"
    }
  ],
  "disputeLetter": {
    "text": "Full letter text with [placeholder] markers",
    "placeholders": ["[Your Full Name]", "[Your Mailing Address]"]
  },
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

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 85_000)

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: controller.signal })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''

    if (isRefusal(text)) throw new AuditRefusalError()

    try {
      return JSON.parse(extractJSON(text)) as AuditResult
    } catch {
      throw new AuditParseError(`Raw response: ${text.slice(0, 200)}`)
    }
  } catch (err: unknown) {
    if (err instanceof AuditRefusalError || err instanceof AuditParseError) throw err
    if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') throw new AuditTimeoutError()
    throw err
  } finally {
    clearTimeout(timeout)
  }
}
