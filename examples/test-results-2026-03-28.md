# E2E Test Results — 2026-03-28

## Environment
- Branch: `feat/e2e-testing`
- Model: `claude-sonnet-4-6`
- API key: from cc-gateway/.env

## Build & Type Check
- `bun run check`: ✅ 0 errors, 0 warnings
- `bun run build`: ✅ built in 4.09s

## Bugs Found & Fixed (this session)

### Bug 1: pdf-parse v2 API incompatibility (CRITICAL)
**Symptom**: All text-based PDFs routed to Vision regardless of content
**Root cause**: pdf-parse v2 (2.4.5) exports `PDFParse` class, not a function. Code called it as a function → silently threw → fell through to Vision
**Fix**: `new PDFParse({ data: new Uint8Array(buffer) }); await parser.getText()`
**Impact**: Fixed. Text PDFs now parse locally (free, fast), Vision only used for scanned images.

### Bug 2: Vision-extracted line items discarded (CRITICAL)
**Symptom**: Vision path extracted `lineItems` with amounts/descriptions, but `parseWithVision` discarded them — never returned from parse route
**Root cause**: `ParsedBill` interface had no `lineItems` or `extractedMeta` fields
**Fix**: Added `lineItems` and `extractedMeta` to `ParsedBill`; fixed `parseWithVision` return
**Impact**: Fixed. Vision-extracted structured data (including amounts) now flows through to audit.

### Bug 3: Audit received $0 line items for text PDFs (HIGH)
**Symptom**: Text PDFs → CPT codes extracted but `billedAmount: 0` → audit computed $0 overcharges
**Root cause**: No mechanism to pass raw bill text to audit when line items were stubs
**Fix**: Added `rawText?: string` to `BillInput`; when all lineItem amounts are $0, rawText passed to audit prompt so Claude extracts amounts from bill text
**Impact**: Fixed. Audit now gives meaningful financial results for text PDFs.

### Bug 4: CPT regex false positive from account numbers
**Symptom**: Account number `VGH-2024-98741` → CPT code list included `98741`
**Root cause**: `\b` word boundary doesn't prevent matching after hyphens
**Fix**: Added negative lookbehind `(?<![0-9$\-])` and lookahead `(?![.\-0-9])`
**Impact**: Fixed. Only true CPT codes extracted.

## Test 1: Synthetic ER Visit — Valley General Hospital

**Bill**: ankle sprain (S93.401A), ER visit + ECG + blood draw + Ceftriaxone injection
**Method**: text PDF → `/api/parse` → `/api/audit`

### Parse Results
```
cptCodesFound: ["99285", "93010", "36415", "J0696"]
usedVision: false
pageCount: 1
```
✅ No false positives. All 4 codes correctly found.

### Audit Results
| Line | CPT | Severity | Error Type | Verdict |
|------|-----|----------|------------|---------|
| 0 | 99285 | ⚠️ warning | upcoding | Ankle sprain + highest ER complexity = suspicious. Medicare rate $225.87, billed $820 (3.6x). **Clinically correct.** |
| 1 | 93010 | 🔴 error | unbundling | ECG interpretation bundled into 93000 per NCCI. **Correct NCCI rule.** |
| 2 | 36415 | ℹ️ info | icd10_mismatch | Blood draw for ankle sprain — clinical necessity questioned. **Reasonable flag.** |
| 3 | J0696 | 🔴 error | pharmacy_markup | $150 vs CMS ASP $5.80 (4 units × $1.45) = 25.9x markup. **Correct math.** |

**Summary**: $1,040 billed, $958.20 potential overcharge
**Dispute letter**: ✅ Proper 42 CFR § 405.374 citation, NCCI reference, itemized table, placeholders highlighted

### Quality Assessment
- Upcoding detection: ✅ Ankle sprain correctly flagged as not supporting high complexity
- NCCI unbundling: ✅ 93010/93000 bundling rule correctly applied
- Drug markup: ✅ Math correct (26x vs CMS ASP)
- Dispute letter: ✅ Professional, regulatory citations correct, patient-readable
- False positives: 0 — blood draw flag is appropriate and correctly framed as "info" not "error"

**OVERALL: PASS** ✅

## Download Status
Virginia Victims Fund PDFs could not be downloaded (sandbox network restrictions block vvf.virginia.gov). Manual download needed:

- Riverside: https://vvf.virginia.gov/sites/default/files/documents/Sample-Itemized-Billing-Statement-Riverside.pdf
- HCA: https://vvf.virginia.gov/sites/default/files/Documents/Sample-Itemized-Billing-Statement-HCA-Hospital.pdf
- VCU: https://vvf.virginia.gov/sites/default/files/Documents/Sample-Itemized-Billing-Statement-VCU.pdf
- Sentara: https://vvf.virginia.gov/sites/default/files/Documents/Sample-Itemized-Billing-Statement-Sentara.pdf

Place in `examples/test-images/` once downloaded. Run:
```bash
curl -s -X POST http://localhost:5173/api/parse -F "file=@examples/test-images/riverside.pdf;type=application/pdf"
```

## Next Steps
1. Download Virginia PDFs and run through parse + audit
2. Check if scanned PDFs correctly route to Vision path
3. Test with an image file (JPG/PNG) to verify Vision path works end-to-end
4. Deploy to Vercel for production testing

---

## Session 2 Test Results — 2026-03-28 (API key unavailable)

### Additional Bugs Found and Fixed

### Bug 5: Set deduplication breaks duplicate billing detection (CRITICAL — FIXED commit e2f0fe9)
**Symptom**: `cptCodesFound` used `[...new Set(matches)]` which collapsed duplicate CPT codes.
A bill with 85025 billed twice would show only one instance, making duplicate detection impossible.
**Fix**: Removed `new Set()` to preserve duplicates.
**Verified**: `duplicate-billing.pdf` now returns `['85025', '85025', '80053']`.

### Bug 6: Savings API returns 500 on page load without KV credentials (MEDIUM — FIXED commit e2f0fe9)
**Symptom**: `GET /api/savings` crashed with 500 on every page load in non-Vercel environments.
`@vercel/kv`'s `kv` getter throws when env vars are missing; the error escaped `getKV()`'s catch.
**Fix**: Wrapped the full GET and POST handler bodies in try/catch.
**Verified**: `GET /api/savings` now returns `{"total": null}` cleanly.

### Parse Test Results (8 synthetic PDFs, no API key)

| File | Codes Found | Vision Used | False Positives | Result |
|------|-------------|-------------|-----------------|--------|
| er-visit-with-cpt.pdf | 99285, 93010, 36415 | NO | 0 | PASS |
| pharmacy-markup.pdf | 99213, J9035 | NO | 0 | PASS |
| clean-bill.pdf | 99213, 85025 | NO | 0 | PASS |
| ncci-unbundling.pdf | 27447, 27370, 36410 | NO | 0 | PASS |
| summary-bill-no-cpt.pdf | (empty) | YES | 0 | PARTIAL* |
| upcoding-scenario.pdf | 99285 | NO | 0 | PASS |
| duplicate-billing.pdf | 85025, 85025, 80053 | NO | 0 | PASS |
| icd10-mismatch.pdf | 73721, 99284 | NO | 0 | PASS |

*PARTIAL: Vision fallback correctly triggered but fails without API key.
Without an API key, Vision returns "Audit failed — please try again" which is misleading.

### Edge Case Handling

| Test | Expected | Actual | Result |
|------|----------|--------|--------|
| Empty lineItems | 400 "lineItems cannot be empty" | ✅ match | PASS |
| Invalid JSON body | 400 "Invalid JSON body" | ✅ match | PASS |
| No file field | 400 "file field required" | ✅ match | PASS |
| 101 line items | 400 "Too many line items (max 100)" | ✅ match | PASS |
| Savings API (no KV) | 200 {"total": null} | ✅ match (after fix) | PASS |

### Remaining Issues (Require API Key to Test)

1. **Vision error message** — When API key is missing, catch block returns "Audit failed —
   please try again. Your file was not saved." This is misleading (it's a parse step, not audit,
   and the failure is a server config issue). Recommend: distinguish auth errors from format errors.

2. **JSON extraction fragility** — If Claude returns JSON with trailing prose (not in a code fence),
   the fallback `JSON.parse(text)` fails. Recommend: find outermost `{...}` block as backup.

3. **Limited reference data** — mpfs.json has only 23 CPT codes; asp.json has only 6 J-codes.
   Most real bills will have codes not in the lookup tables, leaving Claude without Medicare
   benchmark data for those lines.

4. **Rate limiting not wired up** — `@upstash/ratelimit` is in dependencies but not used on
   any endpoint. Both `/api/parse` (CPU) and `/api/audit` ($$) are unprotected.

### Recommended Fixes (Prioritized)

1. **[P0]** Add `ANTHROPIC_API_KEY` to `.env.example` with placeholder — required for any testing
2. **[P1]** Fix Vision catch error message to be non-misleading
3. **[P1]** Harden JSON extraction: `text.match(/\{[\s\S]*\}/)` fallback
4. **[P1]** Wire up rate limiting on `/api/parse` and `/api/audit`
5. **[P2]** Expand mpfs.json to full E&M code table (99202-99499) and top 50 drug J-codes
6. **[P2]** Add real hospital PDFs (VVF Virginia samples) to test suite once network allows
7. **[P3]** Fix test PDF truncation — use a proper PDF library so test content isn't cut off
