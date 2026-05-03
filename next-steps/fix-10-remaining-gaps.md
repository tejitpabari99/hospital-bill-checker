# Fix 10: Remaining Data Pipeline and Test Gaps

> **AGENT INSTRUCTIONS:** You are implementing fix 10.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix remaining data pipeline and test coverage gaps: DMEPOS build script produces duplicate rows on re-runs, OPPS Addendum A header detection breaks if CMS adds a column, and several engine paths that emit `info` findings have no test coverage.

---

## Background

Three issues remain after the first two rounds of fixes:

1. **DMEPOS idempotency:** `scripts/build_dmepos_sqlite.py` uses plain `INSERT` (not `INSERT OR REPLACE`) with an `AUTOINCREMENT` primary key. Running the script twice doubles every row in the database. This is listed as issue P8 in FIXES.md ("deferred").
2. **OPPS Addendum A header detection:** `scripts/build_opps_sqlite.py` `parse_addendum_a()` still uses exact tuple equality (`row == tuple(header_row)`) for the `data_started` flag. Addendum B was fixed to use field-position detection; Addendum A was not. A single extra CMS column would cause 0 rows to be parsed with no error.
3. **Missing test coverage for skipped-check info findings:** The engine emits `dmepos_skipped` and `ambulance_skipped` (or equivalent) `info` findings when required context is missing (`patientState`, `serviceZip`). These code paths have no tests. The empty line-items edge case also has no test.

---

## Task 1: Fix DMEPOS build script idempotency

**File:** `scripts/build_dmepos_sqlite.py`

Find the section where the database is set up and data is inserted. Add DELETE statements before the insert loop so that re-runs produce identical results:

```python
# Wipe existing rows so re-runs are idempotent.
# dmepos_state_rates must be deleted first due to the FK constraint on dmepos_base.hcpcs_code.
conn.execute("DELETE FROM dmepos_state_rates")
conn.execute("DELETE FROM dmepos_base")
conn.commit()
```

Place these DELETE statements after the `CREATE TABLE IF NOT EXISTS` blocks (so the tables are created if they do not exist) and before the first `INSERT` in the data-loading loop.

**Alternative approach (if preferred):** Change the `dmepos_base` table to use a natural composite unique key `(hcpcs_code, modifier)` instead of `AUTOINCREMENT`, and change all INSERT statements to `INSERT OR REPLACE`. This approach is cleaner but requires verifying that the composite key is truly unique across all rows. Only use this approach if you can confirm uniqueness from the CMS source data structure.

**Verification:** Run the script twice against a temp database and confirm `SELECT COUNT(*) FROM dmepos_base` returns the same value both times.

---

## Task 2: Fix OPPS Addendum A header detection

**File:** `scripts/build_opps_sqlite.py`

Find the `parse_addendum_a()` function. It contains a `data_started` flag that is set when the header row is detected. The current detection uses exact tuple equality:

```python
# Before (fragile — breaks if CMS adds a column):
if row == tuple(header_row):
    data_started = True
```

Replace with position-based detection, mirroring the fix already applied to Addendum B:

```python
# After (robust — checks only the APC column position):
# apc_col is determined earlier in the function by scanning for the 'APC' header cell.
if apc_col is not None and str(row[apc_col]).strip().upper() in ('APC', 'STATUS INDICATOR'):
    data_started = True
```

You may need to study the Addendum B `parse_addendum_b()` implementation first to understand the exact pattern used there, then apply the same approach to `parse_addendum_a()`. The column index variable name (`apc_col`) may differ — use whatever the existing Addendum A code calls it.

If `apc_col` is not yet determined before the `data_started` check, add a first-pass scan that identifies the APC column index from the header row, similar to how Addendum B does it.

---

## Task 3: Add missing tests for info-finding skipped paths

**File:** `src/lib/server/audit-rules.test.ts`

Add the following test suite. Adapt the `errorType` string values and `description` patterns to match whatever the actual implementation emits — look at the audit-rules source for the exact strings used when emitting DMEPOS-skip and ambulance-skip findings.

```typescript
describe('buildDeterministicFindings — skipped-check info findings', () => {
  it('emits a dmepos_skipped info finding when a DME bill has no patientState', () => {
    // E0601 = CPAP device, a common DMEPOS code.
    // Without patientState, the DMEPOS rate check cannot run and should emit an info finding.
    const lineItems = [li('E0601', 5000)]
    const { findings } = buildDeterministicFindings(lineItems, 'dme')
    const skipped = findings.find(
      f =>
        f.errorType === 'dmepos_skipped' ||
        (f.severity === 'info' && f.description?.toLowerCase().includes('patient state'))
    )
    expect(skipped).toBeDefined()
    expect(skipped?.severity).toBe('info')
  })

  it('emits an ambulance_skipped info finding when an ambulance code has no serviceZip', () => {
    // A0428 = BLS ambulance transport, a common ambulance code.
    // Without serviceZip the ambulance fee schedule lookup cannot run.
    const lineItems = [li('A0428', 2000)]
    const { findings } = buildDeterministicFindings(lineItems, 'practitioner')
    const skipped = findings.find(
      f =>
        f.errorType === 'ambulance_skipped' ||
        (f.severity === 'info' &&
          (f.description?.toLowerCase().includes('zip') ||
            f.description?.toLowerCase().includes('ambulance')))
    )
    expect(skipped).toBeDefined()
    expect(skipped?.severity).toBe('info')
  })

  it('handles an empty lineItems array without throwing', () => {
    // Should return immediately with empty findings and a $0.00 summary.
    const { findings, summary } = buildDeterministicFindings([])
    expect(findings).toHaveLength(0)
    expect(summary).toContain('$0.00')
  })
})
```

### Notes on test setup

- The `li(cpt, amount)` helper is assumed to already exist in the test file. Check the existing usage before adding these tests.
- If `buildDeterministicFindings` accepts a second `billType` argument, pass `'dme'` and `'practitioner'` as shown. If the bill type is part of a context object, adjust accordingly.
- If `summary` is not a field on the return value, remove or adapt the empty-array test's `summary` assertion.

---

## Verification

- [ ] Running `scripts/build_dmepos_sqlite.py` twice produces the same row count in `dmepos_base`
- [ ] Parsing an OPPS Addendum A file with an extra column does not result in 0 rows parsed
- [ ] DME bill without `patientState` produces an `info` finding
- [ ] Ambulance code without `serviceZip` produces an `info` finding
- [ ] `buildDeterministicFindings([])` returns `{ findings: [], ... }` without throwing
- [ ] `npm run check` passes with no TypeScript errors
- [ ] `npm run test` passes

---

## Commit

```bash
git add scripts/build_dmepos_sqlite.py scripts/build_opps_sqlite.py src/lib/server/audit-rules.test.ts
git commit -m "fix: dmepos idempotency, opps addendum a header, missing skip-path test coverage"
```
