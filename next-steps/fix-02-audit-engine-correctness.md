# Fix 02: Audit Engine Correctness

> **AGENT INSTRUCTIONS:** You are implementing fix 02.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix seven bugs in the audit engine (`src/lib/server/audit-rules.ts`) that cause wrong findings, silent check failures, and contradictory dispute letters. These are the highest-priority fixes because they directly affect the advice given to patients about their medical bills.

---

## Background

Seven bugs were found in `buildDeterministicFindings` and the standalone rule functions:

- **A1 (CRITICAL):** Check 4 (OPPS benchmark) does not add the flagged code to `alreadyFlaggedCodes`. This means the same code can later trigger an `opps_benchmark` finding AND an `upcoding` finding in Check 8 — the dispute letter would cite two contradictory rates for the same line item.
- **A2 (CRITICAL):** The ambulance regex `^A0(4|3)\d{2}$` has a typo in the alternation: `(4|3)` means it matches `A04xx` (correct) but also `A03xx` which are drug administration codes, not ambulance codes. Should use an explicit set of known ambulance HCPCS codes.
- **A3 (IMPORTANT):** No assertion verifies that `nonfac_rate` from `mpfs_rates` is stored in dollars, not raw RVU totals. If the build script accidentally stores RVUs instead of converted dollar amounts, the 2× and 5× thresholds would fire on nearly every bill, producing massive false positives.
- **A4 (IMPORTANT):** Check 2 (MUE) does `mueEntry.mue_adjudication_indicator === '3'` (string comparison). If SQLite stores MAI as an INTEGER column, this comparison always fails silently — MUE checks never fire for any bill.
- **A5 (IMPORTANT):** DMEPOS check silently skips when `patientState` is missing; ambulance check silently skips when `serviceZip` is missing. The user gets no finding telling them why the check was skipped.
- **A6 (IMPORTANT):** `billedAmount` from LLM extraction is not coerced from string. If it arrives as `"$1,234.56"`, arithmetic operations produce `NaN`, and all findings for that line item are silently skipped.
- **A7 (IMPORTANT):** Check 8 upcoding falls through to MPFS benchmark for outpatient bills when OPPS rate is null. MPFS is the physician fee schedule — it is the wrong benchmark for outpatient hospital facility bills.
- **A8 (MINOR):** Two consecutive audit blocks are both labeled `// Check 7` — one is duplicate billing detection, one is ambulance fee schedule. The duplicate label is confusing.

---

## Task 1: Fix A1 — Add code to `alreadyFlaggedCodes` after OPPS finding

**File:** `src/lib/server/audit-rules.ts`

Find Check 4 (OPPS benchmark). It currently ends like this:

```typescript
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
        }
```

Add `alreadyFlaggedCodes.add(code)` immediately after the `findings.push(...)` call, inside the `if (billed > benchmark * 2.5)` block:

```typescript
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
          alreadyFlaggedCodes.add(code)  // <-- ADD THIS LINE
        }
```

---

## Task 2: Fix A2 — Replace ambulance regex with explicit code set

**File:** `src/lib/server/audit-rules.ts`

Find the ambulance check in `buildDeterministicFindings` (Check 7, ambulance fee schedule):

```typescript
      if (!/^A0(4|3)\d{2}$/.test(code)) continue
```

Replace with:

```typescript
      // Explicit set of CMS ambulance HCPCS codes. The regex ^A0(4|3)\d{2}$ was
      // incorrect — A03xx are drug administration codes, not ambulance codes.
      const AMBULANCE_CODES = new Set([
        'A0427', 'A0428', 'A0429',  // BLS
        'A0430', 'A0431',            // ALS Level 1
        'A0432', 'A0433', 'A0434',  // ALS Level 2 / specialty
        'A0435', 'A0436',            // fixed wing / rotary wing
        'A0426', 'A0424',            // SCT / specialty
      ])
      if (!AMBULANCE_CODES.has(code)) continue
```

Note: The `AMBULANCE_CODES` set should be defined as a module-level constant (above `buildDeterministicFindings`) rather than inside the loop. Move it to near the top of the file with the other constants (below `MODIFIER_59_FAMILY`):

```typescript
// Explicit set of ambulance transport HCPCS codes eligible for the ambulance fee schedule check.
// Do NOT use a regex — A03xx codes are drug administration, not ambulance transport.
const AMBULANCE_TRANSPORT_CODES = new Set([
  'A0424', 'A0426', 'A0427', 'A0428', 'A0429',
  'A0430', 'A0431', 'A0432', 'A0433', 'A0434',
  'A0435', 'A0436',
])
```

Then inside the loop, replace:

```typescript
      if (!/^A0(4|3)\d{2}$/.test(code)) continue
```

with:

```typescript
      if (!AMBULANCE_TRANSPORT_CODES.has(code)) continue
```

---

## Task 3: Fix A4 — MUE MAI string coercion in `buildDeterministicFindings`

**File:** `src/lib/server/audit-rules.ts`

In Check 2 (MUE units), find this line:

```typescript
    const mai = mueEntry.mue_adjudication_indicator
```

followed shortly by:

```typescript
    if (mai === '3' && unitsBilled > maxUnits) {
```

The `loadMueEdit` return type declares `mue_adjudication_indicator: string`, but SQLite may store it as an INTEGER. Add `String()` coercion:

```typescript
    const mai = String(mueEntry.mue_adjudication_indicator ?? '')
```

The comparison `mai === '3'` is already correct once `mai` is coerced to a string.

---

## Task 4: Fix A6 — Coerce `billedAmount` from string in `buildDeterministicFindings`

**File:** `src/lib/server/audit-rules.ts`

At the top of `buildDeterministicFindings`, after `const codes = lineItems.map(...)`, add a sanitization step:

```typescript
  // Coerce billedAmount from string in case LLM extraction returned "$1,234.56" etc.
  // A non-numeric billedAmount would produce NaN in arithmetic and silently skip findings.
  const sanitizedLineItems: LineItem[] = lineItems.map(li => {
    const raw = li.billedAmount
    if (typeof raw === 'number') return li
    // Strip currency symbols, commas, spaces; parse the number
    const parsed = parseFloat(String(raw).replace(/[$,\s]/g, ''))
    return { ...li, billedAmount: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 }
  })
```

Then replace all uses of `lineItems[i]` inside `buildDeterministicFindings` with `sanitizedLineItems[i]`.

Or more simply: replace the first line of the function body:

```typescript
  const codes = lineItems.map(li => li.cpt.trim().toUpperCase())
```

with:

```typescript
  // Coerce billedAmount — LLM may return "$1,234.56" as a string; NaN silently skips all findings.
  const lineItems = rawLineItems.map(li => {
    if (typeof li.billedAmount === 'number') return li
    const parsed = parseFloat(String(li.billedAmount).replace(/[$,\s]/g, ''))
    return { ...li, billedAmount: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 }
  })
  const codes = lineItems.map(li => li.cpt.trim().toUpperCase())
```

And update the function signature from:

```typescript
export function buildDeterministicFindings(
  lineItems: LineItem[],
```

to:

```typescript
export function buildDeterministicFindings(
  rawLineItems: LineItem[],
```

---

## Task 5: Fix A7 — Outpatient bills in Check 8 should not fall through to MPFS

**File:** `src/lib/server/audit-rules.ts`

In Check 8 (upcoding check), find this block:

```typescript
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
```

Replace with:

```typescript
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
```

---

## Task 6: Fix A5 — Add info findings when DMEPOS or ambulance check is skipped

**File:** `src/lib/server/audit-rules.ts`

**DMEPOS check** — find this block:

```typescript
  // Check 6: DMEPOS
  if (billType === 'dme' && patientState) {
```

Add an `else` branch to surface a visible info finding:

```typescript
  // Check 6: DMEPOS
  if (billType === 'dme' && patientState) {
    // ... existing code unchanged ...
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
```

**Ambulance check** — find the ambulance check block that starts with:

```typescript
  // Check 7: Ambulance fee schedule
  if (serviceZip) {
```

Add an else branch:

```typescript
  // Check 7: Ambulance fee schedule
  if (serviceZip) {
    // ... existing code unchanged ...
  } else if (lineItems.some((_, i) => AMBULANCE_TRANSPORT_CODES.has(codes[i]))) {
    // Only surface the skip finding if there are actually ambulance codes on the bill.
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
```

---

## Task 7: Fix A8 — Rename duplicate `// Check 7` labels

**File:** `src/lib/server/audit-rules.ts`

There are two consecutive `// Check 7` comments. Rename them correctly:

First occurrence (ambulance fee schedule):
```typescript
  // Check 7: Ambulance fee schedule
```
Leave this as Check 7 (it comes first in the file).

Second occurrence (exact duplicate billing — currently also labeled Check 7):
```typescript
  // Check 7: Exact duplicate billing
```
Rename to:
```typescript
  // Check 8: Exact duplicate billing
```

And the current `// Check 8: Rate comparison` becomes:
```typescript
  // Check 9: Rate comparison (upcoding check)
```

Update the comment at the start of Check 9 as well:
```typescript
  // Check 9: Rate comparison (upcoding check)
  // For each code not already flagged, compare billed to Medicare benchmark
```

---

## Task 8: Add a comment about MPFS dollar assertion

**File:** `src/lib/server/data-loader.ts`

Find `loadMpfsRate` and add a comment above its implementation (or in the function body near where it reads `nonfac_rate`) that the value must be in dollars:

```typescript
// IMPORTANT: nonfac_rate and fac_rate MUST be stored in dollars (not raw RVU totals).
// If build_mpfs_sqlite.py stores raw RVU values without converting via the Conversion Factor,
// the 2x and 5x thresholds in audit-rules.ts will fire on almost every bill.
// build_mpfs_sqlite.py must multiply: total_rvu * conversion_factor = dollar_amount.
// The CY2026 Conversion Factor is $32.3465. Verify: loadMpfsRate('99213')?.nonfac_rate
// should be approximately $68–$80, not 2.11 (raw RVU).
```

---

## Verification

- [ ] An outpatient line item that triggers OPPS check does NOT also appear in upcoding findings
- [ ] An outpatient line item without an OPPS rate does NOT get an MPFS upcoding finding
- [ ] A code matching `A0427` triggers the ambulance check; a code matching `A0300` does not
- [ ] `buildDeterministicFindings` with `billedAmount: '$1,234.56'` does not produce NaN in any finding
- [ ] `buildDeterministicFindings` with `billType: 'dme'` and no `patientState` produces a `dmepos_skipped` info finding
- [ ] DMEPOS check with `patientState` still works (no regression)
- [ ] `npm run check` passes
- [ ] `npm run test` passes

---

## Commit

```bash
git add src/lib/server/audit-rules.ts src/lib/server/data-loader.ts
git commit -m "fix: audit engine — OPPS dedup, ambulance code set, MUE coercion, billedAmount, outpatient fallback"
```
