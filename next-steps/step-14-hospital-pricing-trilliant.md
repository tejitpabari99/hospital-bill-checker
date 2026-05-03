# Step 14: Hospital Pricing — Wire Trilliant + Replace MRF Discovery

> **AGENT INSTRUCTIONS:** You are implementing step 14.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–13 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Fully replace the existing `hospital-prices.ts` MRF discovery system with the Trilliant-based
system (`hospital-prices-v2.ts`) built in step 10. Remove old MRF scripts and code.

**Files to modify:**
- `src/lib/server/claude.ts` — confirm it uses `lookupHospitalPricesV2`
- Any remaining references to old `lookupHospitalPrices` or `hospital-prices.ts`

**Files to delete:**
- `scripts/fetch_hospital_mrf.py` — replaced by `fetch_hospital_trilliant.py`
- `src/lib/server/hospital-prices.ts` — replaced by `hospital-prices-v2.ts`

---

## Task 1: Verify claude.ts uses the new system

- [ ] Open `src/lib/server/claude.ts`
- [ ] Confirm: `import { lookupHospitalPricesV2 } from './hospital-prices-v2'` is present
- [ ] Confirm: No import of `lookupHospitalPrices` from old `./hospital-prices`
- [ ] If old import still exists, remove it

---

## Task 2: Search for remaining references to old hospital-prices.ts

- [ ] Run:

```bash
grep -r "hospital-prices" /root/projects/hospital-bill-checker/src/ --include="*.ts" --include="*.svelte"
grep -r "lookupHospitalPrices[^V]" /root/projects/hospital-bill-checker/src/ --include="*.ts"
```

- [ ] Fix any remaining references to point to `hospital-prices-v2.ts`

---

## Task 3: Update hospital-prices-v2.ts to export the HospitalChargeRecord and HospitalPriceResult types

Since we're deleting `hospital-prices.ts`, any code that imported `HospitalChargeRecord` or `HospitalPriceResult`
from it needs to import from the new file.

- [ ] Open `src/lib/server/hospital-prices-v2.ts`
- [ ] Ensure these types are defined (not just imported from `hospital-prices.ts`):

```typescript
export interface HospitalChargeRecord {
  code: string
  description: string
  grossCharge: number | null
  discountedCash: number | null
  minNegotiated: number | null
  maxNegotiated: number | null
  setting: string
}

export interface HospitalPriceResult {
  hospitalName: string
  mrfUrl: string
  fetchedAt: string
  charges: Record<string, HospitalChargeRecord>
}
```

- [ ] Remove the import of these types from `./hospital-prices` in `hospital-prices-v2.ts`

---

## Task 4: Delete old files

- [ ] `rm scripts/fetch_hospital_mrf.py`
- [ ] `rm src/lib/server/hospital-prices.ts`
- [ ] `npm run check`
- [ ] Fix any TypeScript errors (update imports in any files that imported from `hospital-prices.ts`)

---

## Task 5: Update hospital state extraction

The current code in `claude.ts` extracts state from hospital address. Improve this extraction to also
use `billInput.patientState` as a fallback:

- [ ] In `src/lib/server/claude.ts`, find the hospital lookup section:

```typescript
  if (billInput.hospitalName && billInput.hospitalAddress) {
    const stateMatch = billInput.hospitalAddress.match(/\b([A-Z]{2})\b/)
    const state = stateMatch?.[1] ?? billInput.patientState ?? ''
```

- [ ] Update to also check hospital name for state abbreviation:

```typescript
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
```

---

## Task 6: Staleness notice in hospital price results

When hospital pricing is returned, add a note about data freshness.

- [ ] In `src/lib/server/hospital-prices-v2.ts`, add to the returned `HospitalPriceResult`:

```typescript
return {
  hospitalName,
  mrfUrl: metaObj.source ?? '',
  fetchedAt: metaObj.converted_at ?? new Date().toISOString(),
  charges,
  dataNote: 'Hospital pricing data sourced from Trilliant Health (Oria). Updated when last requested; may be up to 7 days old.',
}
```

- [ ] Add `dataNote?: string` to the `HospitalPriceResult` interface

---

## Task 7: Test that hospital pricing still works

- [ ] Run a manual test:

```bash
python3 scripts/fetch_hospital_trilliant.py "Mayo Clinic" --state MN
```

- [ ] Verify a SQLite file is created in `data/hospital_cache/`
- [ ] Run `npm run check && npm run build`

---

## Task 8: Tests

```typescript
describe('hospital pricing v2', () => {
  it.skipIf(!existsSync('data/hospital_directory.sqlite'))('directory is searchable', () => {
    const db = new Database('data/hospital_directory.sqlite', { readonly: true })
    const count = db.prepare('SELECT COUNT(*) as c FROM hospitals').get() as { c: number }
    expect(count.c).toBeGreaterThan(100)
    db.close()
  })

  it('hospital cache dir exists or can be created', async () => {
    const cacheDir = join(process.cwd(), 'data', 'hospital_cache')
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }
    expect(existsSync(cacheDir)).toBe(true)
  })
})
```

Add imports: `import { existsSync, mkdirSync } from 'fs'; import { join } from 'path'`

- [ ] `npm run test`

---

## Task 9: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/lib/server/hospital-prices-v2.ts src/lib/server/claude.ts
git rm --cached scripts/fetch_hospital_mrf.py src/lib/server/hospital-prices.ts 2>/dev/null || true
git commit -m "feat: replace mrf discovery with trilliant on-demand hospital pricing"
```
