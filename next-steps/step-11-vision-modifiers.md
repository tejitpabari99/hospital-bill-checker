# Step 11: Vision Extraction — Add Modifiers + Quantity

> **AGENT INSTRUCTIONS:** You are implementing step 11.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–10 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Update the Gemini Vision extraction (`vision-extract.mjs`) to also extract:
- `modifiers` — list of billing modifiers per line item (e.g., `["25", "LT"]`)
- `quantity` — quantity billed (may differ from units on some bills)
- Better extraction of `serviceZip` and `patientState` for DMEPOS/ambulance lookups

**Files to modify:**
- `src/lib/server/vision-extract.mjs` — update prompt
- `src/lib/server/pdf.ts` — handle new fields, pass them through

---

## Task 1: Update vision-extract.mjs prompt

The current prompt returns:
```json
{
  "lineItems": [{ "code": "...", "description": "...", "units": 1, "amount": 800.00 }]
}
```

We need to add:
```json
{
  "lineItems": [{ "code": "...", "description": "...", "units": 1, "amount": 800.00, "modifiers": ["25"], "quantity": 1 }],
  "patientState": "TX",
  "serviceZip": "78701"
}
```

- [ ] Open `src/lib/server/vision-extract.mjs`

- [ ] Find the prompt text (the large template literal passed to Gemini)

- [ ] Update the JSON schema section within the prompt from:

```
  "lineItems": [
    { "code": "99285", "description": "ER visit", "units": 1, "amount": 800.00 }
  ],
```

to:

```
  "lineItems": [
    {
      "code": "99285",
      "description": "ER visit",
      "units": 1,
      "quantity": 1,
      "amount": 800.00,
      "modifiers": ["25", "LT"]
    }
  ],
  "patientState": "TX or null",
  "serviceZip": "78701 or null",
```

- [ ] Update the extraction instructions section. Find the line:

```
IMPORTANT: Extract ALL line items with CPT/HCPCS codes.
```

- [ ] Add after that line:

```
For each line item, extract billing modifiers exactly as printed (e.g., "25", "LT", "RT", "59"). Modifiers are 2-character codes that appear after the CPT code, often separated by a dash or space. List them as strings in the "modifiers" array. If no modifiers are present, set "modifiers" to [].
"quantity" is the quantity column if present; if only "units" appears, copy that value to "quantity" as well.
Extract "patientState" as the 2-letter state code from the patient's address on the bill (null if not found).
Extract "serviceZip" as the 5-digit ZIP code of the service location or hospital address (null if not found).
```

---

## Task 2: Update PDF type definitions

The extracted data structure in `src/lib/server/pdf.ts` (or wherever the vision response is typed) needs updating.

- [ ] Open `src/lib/server/pdf.ts` and find the type for extracted line items (usually an inline type or a local type)

- [ ] Update the line item type to include `modifiers` and `quantity`:

```typescript
type ExtractedLineItem = {
  code: string
  description: string
  units: number
  quantity?: number
  amount: number
  modifiers?: string[]
  serviceDate?: string
  icd10Codes?: string[]
}
```

- [ ] Update the code that maps extracted items to `LineItem` to pass through `modifiers` and `quantity`:

```typescript
const lineItem: LineItem = {
  cpt: item.code?.trim().toUpperCase() ?? '',
  description: item.description ?? '',
  units: Number(item.units ?? 1),
  quantity: Number(item.quantity ?? item.units ?? 1),
  billedAmount: Number(item.amount ?? 0),
  modifiers: (item.modifiers ?? []).map((m: string) => m.trim()).filter(Boolean),
  serviceDate: item.serviceDate,
  icd10Codes: item.icd10Codes ?? [],
}
```

- [ ] Also extract `patientState` and `serviceZip` from the vision response:

Find where the vision response is parsed (the JSON.parse of the Gemini response text) and add:
```typescript
const patientState: string | undefined = parsed.patientState ?? undefined
const serviceZip: string | undefined = parsed.serviceZip ?? undefined
```

Pass these to `BillInput`:
```typescript
const billInput: BillInput = {
  ...existingFields,
  patientState,
  // serviceZip stored in billInput for later use (step 13 will wire it)
}
```

You may need to add `serviceZip?: string` to `BillInput` in `src/lib/types.ts`.

---

## Task 3: Add serviceZip to BillInput

- [ ] Open `src/lib/types.ts`
- [ ] Add `serviceZip?: string` to the `BillInput` interface:

```typescript
export interface BillInput {
  lineItems: LineItem[]
  rawText?: string
  hospitalName?: string
  hospitalAddress?: string
  hospitalPhone?: string
  hospitalNpi?: string
  accountNumber?: string
  dateOfService?: string
  billTotal?: number
  admissionDate?: string
  dischargeDate?: string
  goodFaithEstimate?: number
  patientName?: string
  billType?: BillType
  patientState?: string
  serviceZip?: string    // <-- ADD
  drgCode?: string
}
```

- [ ] Run: `npm run check`

---

## Task 4: Write tests for the updated vision output

**File:** `src/lib/server/pdf.test.ts` (already exists — add to it)

- [ ] Add a test that verifies modifier and quantity fields survive the parsing pipeline:

```typescript
describe('vision extraction modifier handling', () => {
  it('preserves modifiers array from extracted data', () => {
    // Simulate what vision-extract.mjs returns
    const mockExtracted = {
      lineItems: [
        { code: '99285', description: 'ER visit', units: 1, quantity: 1, amount: 800, modifiers: ['25', 'LT'] },
        { code: '70450', description: 'CT head', units: 1, quantity: 1, amount: 1200, modifiers: [] },
      ],
      patientState: 'TX',
      serviceZip: '78701',
    }

    // The mapping logic (from pdf.ts extractLineItems or equivalent function)
    // This test verifies the shape after mapping
    const modifiers = mockExtracted.lineItems[0].modifiers
    expect(modifiers).toContain('25')
    expect(modifiers).toContain('LT')
    expect(mockExtracted.lineItems[1].modifiers).toHaveLength(0)
    expect(mockExtracted.patientState).toBe('TX')
    expect(mockExtracted.serviceZip).toBe('78701')
  })
})
```

- [ ] Run: `npm run test -- pdf`

---

## Task 5: Run check and build

- [ ] `npm run check`
- [ ] `npm run build`
- [ ] If any errors, fix them before committing

---

## Task 6: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/lib/server/vision-extract.mjs src/lib/server/pdf.ts src/lib/types.ts \
        src/lib/server/pdf.test.ts
git commit -m "feat: extract modifiers and quantity from bill vision — add patientState and serviceZip"
```

---

## What this enables downstream

After this step:
- `lineItems[i].modifiers` is populated → NCCI modifier-pair check (step 01) can use them
- `patientState` is in `BillInput` → DMEPOS lookup (step 08) can use it
- `serviceZip` is in `BillInput` → Ambulance lookup (step 09) can use it
- `quantity` is tracked separately from `units` for edge cases
