# Fix 08: ASP Drug Overcharge — Per-Unit Comparison

> **AGENT INSTRUCTIONS:** You are implementing fix 08.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix the ASP drug overcharge check to compare the per-unit billed amount against the per-unit ASP limit, not the total billed amount. The current code produces false-positive errors for every multi-unit drug line item.

---

## Background

The ASP check (Check 3) in `src/lib/server/audit-rules.ts` currently does:

```typescript
const billed = lineItems[i].billedAmount  // TOTAL across all units
const limit = aspRow.payment_limit        // PER UNIT (ASP+6%)
const ratio = billed / limit
if (ratio > 4.5) { ... }
```

**The bug:** If a patient has 10 units of a drug billed at $20/unit (within the $21.20 ASP limit), then:

- `billed = $200` (total)
- `limit = $21.20` (per unit)
- `ratio = 9.4×` → FALSE POSITIVE ERROR

Every multi-unit drug line item is incorrectly flagged. The fabricated `ratio` also flows into the `markupRatio` field of the finding description, so the auto-generated dispute letter claims a 9.4× overcharge when the actual ratio is 0.94× (within limit). This is the highest-severity false positive in the current codebase: it causes patients to dispute valid charges.

The same per-unit bug may exist in the standalone `checkAspDrugOvercharge` helper function if it exists (lines ~152–175 in `audit-rules.ts`). Both must be fixed.

---

## Task 1: Fix the ASP check inside `buildDeterministicFindings`

**File:** `src/lib/server/audit-rules.ts`

Find the ASP check block (the one that reads `aspRow` and pushes `pharmacy_markup` findings). The relevant variable assignments look like:

```typescript
// Before (wrong):
const billed = lineItems[i].billedAmount
const ratio = billed / aspRow.payment_limit
```

Replace with:

```typescript
// After (correct — compare per-unit amounts):
const units = lineItems[i].units ?? lineItems[i].quantity ?? 1
const billedPerUnit = lineItems[i].billedAmount / Math.max(1, units)
const ratio = billedPerUnit / aspRow.payment_limit
```

Also update the finding's `description` field. Wherever it currently says something like `"billed at $X.XX"` using the total `billed` value, change it to use `billedPerUnit` and include the word "per unit":

- Before: `"billed at $${billed.toFixed(2)} vs ASP limit of $${aspRow.payment_limit.toFixed(2)}"`
- After: `"billed at $${billedPerUnit.toFixed(2)} per unit vs ASP limit of $${aspRow.payment_limit.toFixed(2)} per unit (${units} unit${units !== 1 ? 's' : ''} × $${billedPerUnit.toFixed(2)} = $${lineItems[i].billedAmount.toFixed(2)} total)"`

---

## Task 2: Fix the standalone `checkAspDrugOvercharge` helper (if it exists)

**File:** `src/lib/server/audit-rules.ts`

Search for a function named `checkAspDrugOvercharge` (around lines 152–175). If it exists, apply the identical per-unit fix:

```typescript
// Before:
const billed = lineItem.billedAmount
const ratio = billed / aspRow.payment_limit

// After:
const units = lineItem.units ?? lineItem.quantity ?? 1
const billedPerUnit = lineItem.billedAmount / Math.max(1, units)
const ratio = billedPerUnit / aspRow.payment_limit
```

Update its description field the same way as Task 1. If the helper does not exist, skip this task.

---

## Tests to update / add in `src/lib/server/audit-rules.test.ts`

### Update existing tests

Search for any existing test that uses a J-code with `units > 1`. Verify the ratio comparison in the test expectation is per-unit, not total. If you find a test that was passing only because the false-positive threshold was high enough, update its fixture or assertion to reflect per-unit logic.

### Add a new regression test

```typescript
const hasAspDb = /* use the same guard pattern as other ASP tests in this file */

it.skipIf(!hasAspDb)(
  'does NOT flag a multi-unit J-code where per-unit rate is within ASP limit',
  () => {
    // J0696 (ceftriaxone): ASP+6% limit is roughly $0.50 per 500 mg vial.
    // 10 units billed at $3.00 TOTAL = $0.30/unit, well within the limit.
    // The old (buggy) code would compute ratio = 3.00 / 0.50 = 6× → false positive.
    // The new code computes ratio = 0.30 / 0.50 = 0.6× → no finding.
    const lineItems = [li('J0696', 3.00, 10)]  // totalBilled=3.00, units=10
    const { findings } = buildDeterministicFindings(lineItems)
    expect(
      findings.filter(f => f.errorType === 'pharmacy_markup')
    ).toHaveLength(0)
  }
)

it.skipIf(!hasAspDb)(
  'DOES flag a multi-unit J-code where per-unit rate exceeds ASP limit significantly',
  () => {
    // 1 unit billed at $500.00 for a drug with ASP+6% of ~$0.50 → ratio ~1000× → genuine error
    const lineItems = [li('J0696', 500.00, 1)]
    const { findings } = buildDeterministicFindings(lineItems)
    expect(
      findings.filter(f => f.errorType === 'pharmacy_markup')
    ).not.toHaveLength(0)
  }
)
```

Note: The `li(cpt, amount, units)` helper signature assumes `units` is the third argument. Check the actual helper signature in the test file and adjust accordingly.

---

## Verification

- [ ] A J-code with 10 units billed at $0.30/unit (within ASP limit) produces no `pharmacy_markup` finding
- [ ] A J-code with 1 unit billed at 10× the ASP limit produces a `pharmacy_markup` finding
- [ ] The finding description mentions "per unit" when units > 1
- [ ] `npm run check` passes with no TypeScript errors
- [ ] `npm run test` passes

---

## Commit

```bash
git add src/lib/server/audit-rules.ts src/lib/server/audit-rules.test.ts
git commit -m "fix: asp check uses per-unit billed amount not total"
```
