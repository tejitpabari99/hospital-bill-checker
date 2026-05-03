# Step 12: Document Classification (LLM Bill Type)

> **AGENT INSTRUCTIONS:** You are implementing step 12.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–11 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Add a lightweight LLM call that classifies the extracted bill as one of:
- `practitioner` — physician/professional claim (CMS-1500 form, outpatient office visits)
- `outpatient` — hospital outpatient facility (UB-04 form, hospital departments)
- `dme` — DME supplier bill (durable medical equipment)
- `inpatient` — hospital inpatient admission (has DRG, admission/discharge dates)
- `unknown` — could not determine

This is a **separate LLM call** from vision extraction. It runs after extraction.
The result is stored in `BillInput.billType` and shown to the user in the UI as a processing step.

**Files to create:**
- `src/lib/server/classify-bill.mjs` — child process that calls Gemini for classification

**Files to modify:**
- `src/lib/server/pdf.ts` — orchestrate classification after extraction
- `src/lib/server/claude.ts` — pass `billType` through to audit

---

## Task 1: Create the classification child process

**File:** `src/lib/server/classify-bill.mjs`

This runs as a child process (same pattern as vision-extract.mjs and claude-worker.mjs).

- [ ] Create `src/lib/server/classify-bill.mjs`:

```javascript
/**
 * classify-bill.mjs
 * Child process: reads extracted bill JSON from stdin, calls Gemini to classify bill type.
 * Writes { billType } or { error } to stdout.
 *
 * billType: 'practitioner' | 'outpatient' | 'dme' | 'inpatient' | 'unknown'
 */
import { GoogleGenerativeAI } from '@google/generative-ai'

let inputData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { inputData += chunk })
process.stdin.on('end', async () => {
  try {
    const { rawText, lineItems, hospitalName, admissionDate, dischargeDate, drgCode } = JSON.parse(inputData.trim())

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0 },
    })

    // Build a concise summary for classification
    const cptList = (lineItems ?? []).map(li => li.code).filter(Boolean).slice(0, 20).join(', ')
    const hasDrg = drgCode || (rawText ?? '').match(/\bDRG\b/i) || (rawText ?? '').match(/\bMS-DRG\b/i)
    const hasAdmission = admissionDate || dischargeDate
    const dmeKeywords = (rawText ?? '').match(/\b(DME|durable medical|equipment supplier|wheelchair|CPAP|oxygen|prosthetic)\b/i)
    const ub04Keywords = (rawText ?? '').match(/\b(UB-04|revenue code|facility|outpatient hospital|type of bill)\b/i)

    const prompt = `You are classifying a medical bill. Based on the information below, respond with ONLY a JSON object.

Bill information:
- Hospital/provider name: ${hospitalName ?? 'unknown'}
- CPT/HCPCS codes billed: ${cptList || 'none found'}
- Has DRG code: ${hasDrg ? 'YES' : 'no'}
- Has admission + discharge dates: ${hasAdmission ? 'YES' : 'no'}
- Raw bill text excerpt: "${(rawText ?? '').slice(0, 400)}"

Classify this bill into EXACTLY one of these types:
- "practitioner" — physician or professional services bill (office visit, procedure by doctor)
- "outpatient" — hospital outpatient facility bill (hospital departments, UB-04 form)
- "dme" — durable medical equipment supplier bill (equipment, supplies, CPAP, wheelchair)
- "inpatient" — hospital inpatient admission (has DRG, admission/discharge dates covering multi-day stay)
- "unknown" — cannot determine from available information

Respond with ONLY this JSON and nothing else:
{ "billType": "practitioner" }

Pick the single best type. If the bill could be practitioner or outpatient, prefer "outpatient" for hospital facility bills and "practitioner" for physician office bills.`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    // Extract JSON from response
    const jsonMatch = text.match(/\{[^}]+\}/)
    if (!jsonMatch) {
      process.stdout.write(JSON.stringify({ billType: 'unknown' }))
      process.exit(0)
    }

    const parsed = JSON.parse(jsonMatch[0])
    const billType = parsed.billType

    const VALID_TYPES = ['practitioner', 'outpatient', 'dme', 'inpatient', 'unknown']
    if (!VALID_TYPES.includes(billType)) {
      process.stdout.write(JSON.stringify({ billType: 'unknown' }))
      process.exit(0)
    }

    process.stdout.write(JSON.stringify({ billType }))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.message ?? String(err), billType: 'unknown' }))
    process.exit(0)
  }
})
```

---

## Task 2: Create classifyBill function in pdf.ts

- [ ] Open `src/lib/server/pdf.ts`

- [ ] Add an import for spawn/join near the top:

```typescript
import { spawn } from 'child_process'
import { join } from 'path'
```

- [ ] Add the `classifyBill` function (place it near the other helper functions):

```typescript
const CLASSIFY_WORKER = join(process.cwd(), 'src/lib/server/classify-bill.mjs')

export async function classifyBill(billInput: BillInput, geminiApiKey: string): Promise<BillType> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLASSIFY_WORKER], {
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, GEMINI_API_KEY: geminiApiKey },
    })

    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })

    child.on('close', () => {
      try {
        const result = JSON.parse(output)
        const billType = result.billType as BillType
        const VALID: BillType[] = ['practitioner', 'outpatient', 'dme', 'inpatient', 'unknown']
        resolve(VALID.includes(billType) ? billType : 'unknown')
      } catch {
        resolve('unknown')
      }
    })

    child.on('error', () => resolve('unknown'))

    // Send the bill data needed for classification
    child.stdin.write(JSON.stringify({
      rawText: billInput.rawText ?? '',
      lineItems: billInput.lineItems.slice(0, 30),
      hospitalName: billInput.hospitalName,
      admissionDate: billInput.admissionDate,
      dischargeDate: billInput.dischargeDate,
      drgCode: billInput.drgCode,
    }))
    child.stdin.end()
  })
}
```

---

## Task 3: Wire classification into the parse flow

In `pdf.ts`, find the function that orchestrates vision extraction and returns the `BillInput`.
After extraction completes successfully, call `classifyBill` and set `billType` on the result.

- [ ] Find the main parse function (probably `parseBill` or similar):

```typescript
// After vision extraction returns billInput:
const billType = await classifyBill(billInput, geminiApiKey)
billInput.billType = billType
```

The `geminiApiKey` comes from the environment — import it the same way `vision-extract.mjs` does
(via env passed to child process, or from `$env/static/private` in the server context).

In `src/routes/api/parse/+server.ts` or the pdf.ts orchestration, the GEMINI_API_KEY is available.
Pass it to `classifyBill`.

---

## Task 4: Surface classification in API response

The `/api/parse` endpoint returns `BillInput` to the client. The client then shows processing steps.

- [ ] Open `src/routes/api/parse/+server.ts`
- [ ] Ensure the response JSON includes `billType`:

```typescript
return json({
  lineItems: billInput.lineItems,
  hospitalName: billInput.hospitalName,
  // ... other fields ...
  billType: billInput.billType ?? 'unknown',  // <-- ADD
})
```

- [ ] Open the relevant Svelte page (`+page.svelte`) and show the bill type as a processing step:

Find the existing step display (the 3-step indicator showing "Extracting" → "Analyzing" → "Done") and add
the bill type classification as a labeled step shown to the user.

Example display text (after extraction completes):
```
✓ Bill type identified: Outpatient Hospital Facility
```

Or in the results header/summary area.

---

## Task 5: DRG extraction from vision

The IPPS check (step 07) needs a DRG code. Add DRG extraction to the vision prompt.

- [ ] Open `src/lib/server/vision-extract.mjs`
- [ ] Add `"drgCode"` to the extracted JSON schema:

```
  "drgCode": "470 or null",
```

- [ ] Add to instructions:
```
Extract "drgCode" as the MS-DRG or DRG code explicitly shown on the bill (e.g., "470", "291"). Only extract if the bill explicitly shows a DRG/MS-DRG number. Set to null if absent.
```

- [ ] In `pdf.ts`, pass `drgCode` through to `BillInput.drgCode`

---

## Task 6: Write tests

**File:** `src/lib/server/classify-bill.test.ts` (create new)

```typescript
import { describe, it, expect } from 'vitest'

// Unit test: verify that valid bill types are accepted
const VALID_BILL_TYPES = ['practitioner', 'outpatient', 'dme', 'inpatient', 'unknown']

describe('bill type classification', () => {
  it('valid bill types list is correct', () => {
    expect(VALID_BILL_TYPES).toContain('practitioner')
    expect(VALID_BILL_TYPES).toContain('outpatient')
    expect(VALID_BILL_TYPES).toContain('dme')
    expect(VALID_BILL_TYPES).toContain('inpatient')
    expect(VALID_BILL_TYPES).toContain('unknown')
    expect(VALID_BILL_TYPES).toHaveLength(5)
  })

  it('unknown is the fallback type', () => {
    // Simulate what happens when classification returns an invalid type
    const INVALID = 'ambulance'
    const result = VALID_BILL_TYPES.includes(INVALID as typeof VALID_BILL_TYPES[number]) ? INVALID : 'unknown'
    expect(result).toBe('unknown')
  })
})
```

- [ ] `npm run test && npm run check && npm run build`

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/lib/server/classify-bill.mjs src/lib/server/pdf.ts \
        src/lib/server/vision-extract.mjs src/lib/types.ts \
        src/lib/server/classify-bill.test.ts \
        src/routes/api/parse/+server.ts
git commit -m "feat: add llm document classification for bill type routing"
```

---

## Why this is LLM and not deterministic

Classification uses the LLM because:
- The same CPT code can appear on practitioner OR hospital outpatient bills
- Form type (UB-04 vs CMS-1500) is often not extractable from vision
- DRG is not always present on inpatient bills
- The LLM is good at reading context signals (revenue codes, form layout, provider type) to classify

This is one of the 3 approved LLM uses. The classification result drives all downstream routing.
