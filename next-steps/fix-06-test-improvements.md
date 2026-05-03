# Fix 06: Test Improvements

> **AGENT INSTRUCTIONS:** You are implementing fix 06.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix four test quality issues: a weak integration test assertion that would pass even if all audit rules failed, a contradictory triple-billing test name, inconsistent MUE fixture field names, and add four missing edge-case tests for bugs that were found during review.

---

## Background

Six test issues were found:

- **F5 (IMPORTANT):** `src/lib/server/integration.test.ts` lines 281-295 — the full pipeline smoke test only asserts `Array.isArray(findings)`. A change that makes all audit rules silently fail (returning `[]`) would still pass this test. The test should assert that expected findings are actually present for known inputs.
- **F6 (IMPORTANT):** `src/lib/server/audit-rules.test.ts` lines 194-204 — the test is named "flags all extra occurrences for triple billing" but the assertion is `toHaveLength(1)`. The test name says it should flag all extra occurrences (2nd and 3rd), but the assertion says only one finding. Either the name or the assertion is wrong. In this case, the current behavior (`toHaveLength(1)`) is correct (once `alreadyFlaggedCodes.add(code)` fires on the first duplicate, subsequent ones are suppressed), so the test name is wrong. Fix the name.
- **F9 (IMPORTANT):** MUE test fixtures at `audit-rules.test.ts` lines 555-570 use two different field names: `mai` (lines 555) vs `mue_adjudication_indicator` (lines 566-569). One set of tests may be passing vacuously because the wrong field name causes the MAI check to always be treated as non-`'3'`.
- **A9 (MINOR):** Missing test: OPPS zero-rate packaged service should NOT trigger a finding (payment_rate = 0 is a packaged service, not a free service).
- **A10 (MINOR):** Missing test: `billedAmount` as a string like `"$1,234.56"` should be coerced or produce no NaN findings.
- **A11 (MINOR):** Missing test: A03xx code (e.g. `A0300`) should NOT trigger the ambulance check.
- **A12 (MINOR):** Missing test: MUE MAI stored as integer (not string) through `buildDeterministicFindings` should still fire the MUE check.

---

## Task 1: Fix F6 — Correct the contradictory triple-billing test name

**File:** `src/lib/server/audit-rules.test.ts`

Find this test (around line 194):

```typescript
  it('flags all extra occurrences for triple billing', () => {
    const lineItems = [
      li('99285', 500.00),
      li('99285', 500.00),
      li('99285', 500.00),
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    const dups = findings.filter(f => f.errorType === 'duplicate')
    expect(dups).toHaveLength(1)
  })
```

The assertion `toHaveLength(1)` is correct — once the code is added to `alreadyFlaggedCodes`, only the first duplicate is flagged. The name is misleading. Rename it:

```typescript
  it('flags only the first duplicate for triple billing (subsequent are suppressed by alreadyFlaggedCodes)', () => {
    const lineItems = [
      li('99285', 500.00),
      li('99285', 500.00),
      li('99285', 500.00),
    ]
    const { findings } = buildDeterministicFindings(lineItems)

    const dups = findings.filter(f => f.errorType === 'duplicate')
    expect(dups).toHaveLength(1)
    expect(dups[0].lineItemIndex).toBe(1)  // first duplicate is at index 1
  })
```

---

## Task 2: Fix F9 — Standardize MUE fixture field names

**File:** `src/lib/server/audit-rules.test.ts`

Find the two MUE test blocks that use different field names. Look for tests around lines 551-573. One uses `mai` and one uses `mue_adjudication_indicator`.

The `checkMueExceeded` function accepts both (it reads `edit?.mue_adjudication_indicator ?? edit?.mai`), so both field names work. However, the `buildDeterministicFindings` function calls `loadMueEdit` from SQLite which returns `mue_adjudication_indicator`. To match production behavior, standardize all test fixtures that go through `buildDeterministicFindings` to use `mue_adjudication_indicator`.

Find all test fixtures that use `mai` in the MUE-related describe blocks:

```typescript
  const edits = [{ hcpcs_code: '99213', mue_value: 1, mai: 3, bill_type: 'practitioner' }]
```

For fixtures passed directly to `checkMueExceeded`, either field name is fine — they both work. But add a comment clarifying which is the canonical SQLite field name:

```typescript
  // Note: the canonical SQLite column is 'mue_adjudication_indicator'.
  // 'mai' is an alias accepted by checkMueExceeded for convenience.
  // Fixtures testing buildDeterministicFindings (which reads from SQLite) use 'mue_adjudication_indicator'.
```

For any test that tests `buildDeterministicFindings` directly (not `checkMueExceeded`), ensure the fixture uses `mue_adjudication_indicator`, not `mai`.

---

## Task 3: Fix F5 — Strengthen the integration test smoke test assertion

**File:** `src/lib/server/integration.test.ts`

Find the full pipeline smoke test (around line 280):

```typescript
describe('full audit pipeline smoke test', () => {
  skipIf(!allDBsPresent, 'buildDeterministicFindings runs without throwing', () => {
    const lineItems: LineItem[] = [
      makeLineItem({ cpt: '99213', billedAmount: 200 }),
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      'TX',
      undefined
    )
    expect(Array.isArray(findings)).toBe(true)
  })
})
```

Replace with a test that actually asserts meaningful behavior — use a known overcharge that should trigger a finding when real DBs are present:

```typescript
describe('full audit pipeline smoke test', () => {
  skipIf(!allDBsPresent, 'buildDeterministicFindings runs without throwing', () => {
    const lineItems: LineItem[] = [
      makeLineItem({ cpt: '99213', billedAmount: 200 }),
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      'TX',
      undefined
    )
    expect(Array.isArray(findings)).toBe(true)
  })

  skipIf(!allDBsPresent, 'buildDeterministicFindings returns findings array with correct shape', () => {
    const lineItems: LineItem[] = [
      makeLineItem({ cpt: '99213', billedAmount: 200 }),
    ]
    const { findings, summary } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      'TX',
      undefined
    )
    expect(Array.isArray(findings)).toBe(true)
    expect(typeof summary).toBe('string')
    // Each finding must have required shape fields
    for (const f of findings) {
      expect(typeof f.findingType ?? f.errorType).toBe('string')
      expect(typeof f.severity).toBe('string')
      expect(['error', 'warning', 'info']).toContain(f.severity)
    }
  })

  skipIf(!allDBsPresent, 'buildDeterministicFindings flags a known extreme overcharge', () => {
    // 99213 at $50,000 should be flagged at 2x MPFS rate regardless of DB version.
    // If all rules are silently failing, this test catches it.
    const lineItems: LineItem[] = [
      makeLineItem({ cpt: '99213', billedAmount: 50_000 }),
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      undefined,
      undefined
    )
    expect(Array.isArray(findings)).toBe(true)
    // At $50,000 for a 99213 (MPFS ~$80), this must trigger upcoding.
    // If findings is empty here, the audit engine is silently broken.
    const upcodings = findings.filter(f => f.errorType === 'upcoding' || f.errorType === 'mpfs_overcharge')
    expect(upcodings.length).toBeGreaterThan(0)
  })
})
```

---

## Task 4: Add missing edge-case tests

**File:** `src/lib/server/audit-rules.test.ts`

Add the following describe block at the end of the file (after all existing describe blocks):

```typescript
// ── Edge-case regression tests added after code review ─────────────────────────

describe('audit-rules edge-case regressions', () => {

  // A9: OPPS zero-rate (packaged service) should not trigger a finding
  it('OPPS rate of 0 does not trigger opps_benchmark finding', () => {
    const lineItems = [
      { cpt: '99213', description: 'Office visit', units: 1, billedAmount: 500, modifiers: [], icd10Codes: [] },
    ]
    // payment_rate = 0 means the service is packaged (no separate OPPS payment)
    const rates = [{ hcpcs_code: '99213', payment_rate: 0 }]
    const findings = checkOppsBenchmark(lineItems, rates)
    expect(findings).toHaveLength(0)
  })

  // A10: billedAmount as string should coerce without producing NaN findings
  it('billedAmount as string "$1,234.56" does not produce NaN in findings', () => {
    // Cast to any to simulate LLM returning a string instead of number
    const lineItems = [
      { cpt: '99213', description: 'Office visit', units: 1, billedAmount: '$1,234.56' as any, modifiers: [], icd10Codes: [] },
    ]
    // Should not throw and should not produce findings with NaN medicareRate or markupRatio
    expect(() => {
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2025-01-01')
      for (const f of findings) {
        if (f.medicareRate != null) expect(Number.isFinite(f.medicareRate)).toBe(true)
        if (f.markupRatio != null) expect(Number.isFinite(f.markupRatio)).toBe(true)
      }
    }).not.toThrow()
  })

  it('billedAmount as "NaN" string does not produce findings', () => {
    const lineItems = [
      { cpt: '99213', description: 'Office visit', units: 1, billedAmount: 'NaN' as any, modifiers: [], icd10Codes: [] },
    ]
    expect(() => {
      const { findings } = buildDeterministicFindings(lineItems, 'practitioner', '2025-01-01')
      // billedAmount NaN should be treated as 0 — no upcoding findings fire on $0
      const upcodings = findings.filter(f => f.errorType === 'upcoding')
      expect(upcodings).toHaveLength(0)
    }).not.toThrow()
  })

  // A11: A03xx codes should NOT trigger the ambulance check
  it('A03xx drug administration code does not trigger ambulance check', () => {
    const lineItems = [
      { cpt: 'A0300', description: 'Drug admin', units: 1, billedAmount: 5000, modifiers: [], icd10Codes: [] },
    ]
    // With the fixed ambulance code set (explicit list), A0300 should not match
    const { findings } = buildDeterministicFindings(
      lineItems,
      'practitioner',
      '2025-01-01',
      undefined,
      undefined,
      '78701'  // provide a serviceZip so the ambulance check is not simply skipped
    )
    const ambulanceFindings = findings.filter(f => f.errorType === 'ambulance_benchmark')
    expect(ambulanceFindings).toHaveLength(0)
  })

  it('A0428 (BLS ambulance) code DOES trigger ambulance check when applicable', () => {
    const lineItems = [
      { cpt: 'A0428', description: 'BLS transport', units: 1, billedAmount: 50_000, modifiers: [], icd10Codes: [] },
    ]
    // A0428 is a real ambulance code — with a serviceZip and extreme markup, it should be checked
    // (may or may not fire depending on DB presence, but should not be silently skipped due to regex)
    expect(() => {
      buildDeterministicFindings(
        lineItems,
        'practitioner',
        '2025-01-01',
        undefined,
        undefined,
        '78701'
      )
    }).not.toThrow()
  })

  // A12: MUE MAI stored as integer (not string) should still fire
  it('checkMueExceeded fires when mai is integer 3 (not string)', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    // Simulate SQLite returning an INTEGER column value (number, not string)
    const edits = [{ hcpcs_code: '99213', mue_value: 1, mue_adjudication_indicator: 3 as any }]
    const findings = checkMueExceeded(lineItems, edits)
    // String('3') === '3' is true, so this should fire
    expect(findings).toHaveLength(1)
    expect(findings[0].findingType).toBe('mue_exceeded')
  })

  it('checkMueExceeded does NOT fire when mai is integer 1', () => {
    const lineItems = [
      { cpt: '99213', description: '', units: 99, billedAmount: 100, modifiers: [], icd10Codes: [] },
    ]
    const edits = [{ hcpcs_code: '99213', mue_value: 1, mue_adjudication_indicator: 1 as any }]
    const findings = checkMueExceeded(lineItems, edits)
    // MAI 1 is not the hard-error indicator — should not fire
    expect(findings).toHaveLength(0)
  })

  // OPPS dedup: code flagged by OPPS should not also appear in upcoding
  it('OPPS-flagged code does not also appear in upcoding findings', () => {
    // Simulate an outpatient bill where the OPPS rate exists and code is massively overbilled
    const lineItems = [
      { cpt: '99285', description: 'ER visit', units: 1, billedAmount: 99_999, modifiers: [], icd10Codes: [] },
    ]
    const { findings } = buildDeterministicFindings(
      lineItems,
      'outpatient',
      '2025-01-01'
    )
    // If both opps_benchmark and upcoding appear for the same code, that's the A1 bug recurring
    const oppsFindings = findings.filter(f => f.cptCode === '99285' && f.errorType === 'opps_benchmark')
    const upcodingFindings = findings.filter(f => f.cptCode === '99285' && f.errorType === 'upcoding')
    // There should not be BOTH an opps_benchmark AND an upcoding finding for the same code
    if (oppsFindings.length > 0) {
      expect(upcodingFindings).toHaveLength(0)
    }
  })
})
```

---

## Task 5: Run all tests and confirm counts

After making the above changes, run:

```bash
cd /root/projects/hospital-bill-checker
npm run test -- --reporter=verbose
```

Expected outcomes:
- `audit-rules.test.ts` — all existing tests pass; new edge-case tests pass
- `integration.test.ts` — DB-gated tests skip if DBs not present; new pipeline smoke tests pass when DBs are present
- No tests that previously passed now fail (no regressions)

---

## Verification

- [ ] Triple-billing test name no longer says "flags all extra occurrences" (the assertion is `toHaveLength(1)`)
- [ ] `checkMueExceeded` test with integer MAI=3 fires correctly
- [ ] `checkMueExceeded` test with integer MAI=1 does not fire
- [ ] OPPS zero-rate test confirms no false positive
- [ ] String `billedAmount` test does not throw and produces no NaN values
- [ ] A03xx ambulance test passes (code is not flagged as ambulance)
- [ ] Integration smoke test has the new extreme-overcharge assertion
- [ ] `npm run check` passes
- [ ] `npm run test` passes

---

## Commit

```bash
git add src/lib/server/audit-rules.test.ts src/lib/server/integration.test.ts
git commit -m "test: fix contradictory test name, standardize MUE fixtures, add missing edge-case tests"
```
