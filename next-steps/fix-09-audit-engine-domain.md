# Fix 09: Audit Engine Domain Correctness

> **AGENT INSTRUCTIONS:** You are implementing fix 09.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix three interrelated audit engine domain issues: the MPFS moderate-overcharge threshold is too high (2.5× instead of 2×), inpatient bills incorrectly run MPFS/CLFS/ASP line-item checks (Check 9), and line items with `units: 0` pass through silently instead of being flagged as data anomalies.

---

## Background

Three separate bugs were identified in `src/lib/server/audit-rules.ts`:

1. **MPFS threshold:** The spec defines 2× Medicare rate as the moderate-overcharge boundary. The constant `MODERATE_MARKUP_THRESHOLD` is set to `2.5`, causing the 2.0×–2.5× overcharge band to be silently ignored.
2. **Inpatient Check 9:** For inpatient DRG-based bills, individual CPT line items are bundled into the DRG global payment — comparing them to MPFS physician rates is meaningless and produces false positives. Check 9 (the large rate-comparison loop) must be skipped entirely for inpatient bills.
3. **units=0:** A line item with `units: 0` passes the MUE check (`0 <= maxUnits`) silently. A non-zero charge with zero documented units is a billing anomaly and should be surfaced as a data-quality `info` finding.

---

## Task 1: Fix MPFS moderate-overcharge threshold (2.5 → 2.0)

**File:** `src/lib/server/audit-rules.ts`

Find the `MODERATE_MARKUP_THRESHOLD` constant:

```typescript
// Before
const MODERATE_MARKUP_THRESHOLD = 2.5
```

Replace with:

```typescript
// After
// 2.0× is the correct boundary per the billing spec; charges between 2× and HIGH_MARKUP_THRESHOLD
// are a 'warning', charges above HIGH_MARKUP_THRESHOLD are an 'error'.
const MODERATE_MARKUP_THRESHOLD = 2.0
```

No other code changes are needed for this task — the threshold is already used correctly in the severity branching that follows it. The fix is only the constant value.

---

## Task 2: Skip Check 9 (rate-based upcoding) for inpatient bills

**File:** `src/lib/server/audit-rules.ts`

Find Check 9 — the large loop that calls `loadMpfsRate`, `loadClfsRate`, and/or `loadOppsRate` and produces upcoding findings. It will be labelled with a comment like `// Check 9` or positioned after Check 8.

Wrap the entire Check 9 loop in an inpatient guard:

```typescript
// Check 9: Rate-based upcoding (outpatient / practitioner bills only)
// For inpatient DRG-based payment, individual CPT line items are bundled into the
// DRG global payment. Comparing them to MPFS physician rates produces false positives.
if (billType !== 'inpatient') {
  for (let i = 0; i < lineItems.length; i++) {
    // ... existing Check 9 loop body, unchanged ...
  }
}
```

If the existing code uses a `switch` or `if/else` structure over `billType` that already routes execution, add `billType === 'inpatient'` as an early-return or `continue` condition at the top of the relevant branch instead of wrapping it externally.

---

## Task 3: Flag zero-unit line items as data-quality findings

**File:** `src/lib/server/audit-rules.ts`

Find the normalization block near the top of `buildDeterministicFindings` — it is the section that coerces `billedAmount` and similar fields. After that block (before any check loops begin), add:

```typescript
// Emit a data-quality info finding for any line with zero units billed.
// units=0 with a non-zero charge is a billing anomaly — the MUE check passes
// (0 <= maxUnits) so it would otherwise be silently ignored.
const zeroUnitFindings: AuditFinding[] = lineItems
  .map((li, i) => ({ li, i }))
  .filter(({ li }) => (li.units ?? li.quantity ?? 1) === 0)
  .map(({ li, i }) => ({
    lineItemIndex: i,
    cptCode: li.cpt,
    severity: 'info' as const,
    errorType: 'other' as const,
    confidence: 'high' as const,
    description: `CPT ${li.cpt} has 0 units billed. This is a data anomaly — units must be a positive integer.`,
    recommendation: 'Request a corrected claim with a valid unit quantity. A charge with zero units is not a valid billing entry.',
  }))
findings.push(...zeroUnitFindings)
```

Adjust the field names (`li.cpt`, `li.units`, `li.quantity`) to match the actual property names on the line-item type used in the file.

---

## Tests to add in `src/lib/server/audit-rules.test.ts`

### Task 1 — MPFS threshold

```typescript
it('bills at 2.1× Medicare rate produce a warning finding (moderate overcharge)', () => {
  // A charge at 2.1× should fall in the moderate overcharge band and produce 'warning'.
  // Before this fix (threshold=2.5), it would have been missed entirely.
  // Use a CPT known to have an MPFS rate, e.g. 99213 with a known rate,
  // or mock loadMpfsRate to return a fixed value.
  // Adapt to whichever mocking pattern is already used in this test file.
})
```

### Task 2 — Inpatient guard

```typescript
it('inpatient bill does not produce MPFS upcoding findings for individual CPT lines', () => {
  // A single CPT line item on an inpatient bill should NOT trigger Check 9.
  const lineItems = [li('99213', 500)]  // MPFS rate ~$75 → 6.7× if Check 9 ran
  const { findings } = buildDeterministicFindings(lineItems, 'inpatient')
  const upcodingFindings = findings.filter(
    f => f.errorType === 'upcoding' || f.errorType === 'mpfs_benchmark'
  )
  expect(upcodingFindings).toHaveLength(0)
})
```

### Task 3 — Zero units

```typescript
it('line item with units=0 produces an info/other finding', () => {
  const lineItems = [{ ...li('99213', 200), units: 0 }]
  const { findings } = buildDeterministicFindings(lineItems)
  const zeroUnitFinding = findings.find(
    f => f.errorType === 'other' && f.description?.includes('0 units')
  )
  expect(zeroUnitFinding).toBeDefined()
  expect(zeroUnitFinding?.severity).toBe('info')
})

it('line item with units=1 does NOT produce a zero-unit finding', () => {
  const lineItems = [li('99213', 200)]  // default units=1
  const { findings } = buildDeterministicFindings(lineItems)
  const zeroUnitFinding = findings.find(
    f => f.errorType === 'other' && f.description?.includes('0 units')
  )
  expect(zeroUnitFinding).toBeUndefined()
})
```

---

## Verification

- [ ] A bill at 2.1× Medicare rate produces a `warning` finding (was previously missed)
- [ ] A bill at 2.6× Medicare rate produces an `error` finding (unchanged)
- [ ] An inpatient bill with a CPT line produces zero `upcoding` / `mpfs_benchmark` findings
- [ ] A line item with `units: 0` produces an `info` finding with `errorType: 'other'`
- [ ] A line item with `units: 1` produces no zero-unit finding
- [ ] `npm run check` passes with no TypeScript errors
- [ ] `npm run test` passes

---

## Commit

```bash
git add src/lib/server/audit-rules.ts src/lib/server/audit-rules.test.ts
git commit -m "fix: mpfs threshold 2x, skip check 9 for inpatient, flag zero-unit line items"
```
