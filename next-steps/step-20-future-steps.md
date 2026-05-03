# Step 20: Future Steps Reference

> **AGENT INSTRUCTIONS:** This file documents work that is NOT in scope for the current
> implementation sprint. Read it for context if you encounter placeholder code or TODO comments.
> Do not implement anything in this file unless explicitly instructed.

This is a living reference document — not a backlog of equal priority items. Items are ordered
by expected impact and implementation difficulty.

---

## Future Step A: MPFS Stage 2 — Location-Adjusted GPCI Pricing

**What:** Apply Geographic Practice Cost Indices (GPCI) to MPFS rates to get location-specific
payment amounts instead of the national average.

**Why not now:** Adds ~30% complexity to MPFS lookup, requires a locality code → ZIP mapping,
and the national average is close enough for a first-pass dispute letter. The current 2× benchmark
already accounts for regional variation.

**Files needed from CMS:**
- `rvu26b.zip` → contains:
  - `GPCI2026.xlsx` — GPCI values by locality (work, practice expense, malpractice)
  - `26LOCCO.xlsx` — locality code → ZIP code mapping

**Implementation plan:**
1. Download `rvu26b.zip` and extract.
2. Build `scripts/build_mpfs_gpci_sqlite.py`:
   - Parse `GPCI2026.xlsx` → `mpfs_gpci` table: `(locality_code, gpci_work, gpci_pe, gpci_mp)`
   - Parse `26LOCCO.xlsx` → `mpfs_locality_zip` table: `(zip_code, locality_code, carrier)`
3. Update `data/mpfs.sqlite` to store raw RVUs (work, PE, MP) instead of pre-calculated rate.
4. Update `loadMpfsRate()` to:
   - Accept `serviceZip` as parameter
   - Join to `mpfs_locality_zip` → `mpfs_gpci`
   - Calculate: `rate = (work_rvu × gpci_work + pe_rvu × gpci_pe + mp_rvu × gpci_mp) × 33.29`
5. Fall back to national average (uniform GPCI = 1.0) if ZIP not found.

**Schema additions to `data/mpfs.sqlite`:**
```sql
CREATE TABLE mpfs_gpci (
  locality_code TEXT PRIMARY KEY,
  carrier TEXT,
  gpci_work REAL,
  gpci_pe REAL,
  gpci_mp REAL
);
CREATE TABLE mpfs_locality_zip (
  zip_code TEXT,
  locality_code TEXT,
  carrier TEXT,
  PRIMARY KEY (zip_code, carrier)
);
```

---

## Future Step B: ASP NDC-to-HCPCS Crosswalk

**What:** Some drug bills use National Drug Codes (NDC) instead of HCPCS codes (J-codes). The NDC
crosswalk maps NDC → HCPCS so we can look up the ASP limit.

**Why not now:** Most bills submitted for audit have HCPCS codes. NDC-only bills are less common
in consumer contexts. The schema (`asp_ndc_hcpcs_crosswalk`) is already created (empty).

**CMS source:** CMS publishes a quarterly NDC-HCPCS crosswalk file alongside the ASP data.
URL format: same CMS ASP downloads page.

**Implementation plan:**
1. Add crosswalk file download to `scripts/build_asp_sqlite.py`
2. Parse NDC → HCPCS mapping into `asp_ndc_hcpcs_crosswalk`
3. In `checkAspDrugOvercharge()`, if a line item code starts with digits (NDC format), look it
   up in the crosswalk to get the HCPCS code, then check ASP.

---

## Future Step C: DMEPOS Rural Rates

**What:** CMS publishes separate rural rates for DMEPOS equipment. Patients in rural ZIP codes
should be checked against rural rates, not non-rural (NR) rates.

**Why not now:** Rural vs. non-rural classification requires a ZIP-to-locality lookup (same
infrastructure as ambulance geography). The schema can be added to `dmepos_state_rates` by
adding a `rate_type TEXT` column ('NR' vs 'R').

**Implementation plan:**
1. Update `scripts/build_dmepos_sqlite.py` to also extract rural rate columns
   (header pattern `^([A-Z]{2})\s*\(R\)` — e.g., "TX (R)").
2. Add `rate_type TEXT` to `dmepos_state_rates` PRIMARY KEY.
3. Update `loadDmeposRate()` to accept `isRural: boolean` and prefer matching rate type.
4. Determine rural/non-rural from `serviceZip` using ambulance geography table as a cross-reference.

---

## Future Step D: Ambulance Rural/Super-Rural Adjustments

**What:** CMS applies rural (+50%) and super-rural (+22.6% additional) payment adjustments for
ambulance transport. The current implementation uses base rates only.

**Why not now:** Requires ZIP-to-rural-classification lookup. The geography table schema is already
built but doesn't include rural classification.

**Implementation plan:**
1. Add `rural_classification TEXT` to `ambulance_geography` table ('urban', 'rural', 'super-rural').
2. Update ZIP classification using RUCA (Rural-Urban Commuting Area) codes or CMS locality codes.
3. Apply multiplier in `checkAmbulanceBenchmark()` before comparison.

---

## Future Step E: NCCI Private Payer Adoption

**What:** Some private insurers and state Medicaid programs have adopted NCCI edits, but with
modifications. Flagging "this is a Medicare-only rule" when NCCI edits are found would improve
accuracy.

**Why not now:** Requires a per-payer database that doesn't exist in a clean form. Current
implementation always applies Medicare NCCI, which is the closest available standard.

**Implementation plan:**
- Add a `payer_type TEXT` field to `BillInput` (extracted from bill or user-provided).
- If payer is not Medicare/Medicare Advantage, add a caveat to NCCI findings.

---

## Future Step F: Full Hospital MRF Download

**What:** Instead of using Trilliant as an intermediary, download hospital MRF files directly
from hospital websites. This gives complete data but is slow (files can be gigabytes).

**Why not now:** Trilliant provides pre-parsed DuckDB files that are much smaller. Direct MRF
downloads would require dealing with varied CMS-mandated schemas and very large files.

**When to consider:** If Trilliant/Oria changes its data access model or pricing.

---

## Future Step G: Diagnosis-Based Pricing Validation

**What:** Some CPT codes are only covered by Medicare for specific diagnoses (ICD-10 codes). If
a bill has a CPT code paired with a non-covered ICD-10 code, the charge may be improper.

**Data source:** CMS Local Coverage Determinations (LCD) and National Coverage Determinations (NCD).

**Why not now:** LCD/NCD data is in PDF/HTML format with no machine-readable download. Parsing
would require significant NLP work. This is a "version 2.0" feature.

---

## Future Step H: Duplicate Billing Detection

**What:** Flag duplicate CPT codes on the same bill (same code, same date, multiple line items).
This is distinct from MUE — it's billing the same service twice.

**Why not now:** The current data model handles this: if the same CPT appears twice with the
same service date, `checkMueExceeded` would catch it if the combined units exceed the MUE limit.
True duplicate detection (separate from MUE) is a refinement.

**Implementation:** Add a check in `audit-rules.ts` that groups line items by (cpt, serviceDate)
and flags any group with count > 1 and no modifier difference.

---

## Future Step I: Export / Print-Ready Dispute Letter

**What:** Allow the dispute letter to be exported as a formatted PDF.

**Implementation options:**
- Puppeteer/Playwright: render the letter page and print to PDF
- `@react-pdf/renderer` or `svelte-pdf`: template-based PDF generation
- Simple: add a print-optimized CSS class and let browser `window.print()` handle it

**Why not now:** The letter is currently rendered as HTML. PDF export is a UX enhancement, not
a correctness requirement.

---

## Maintenance Reminders

These are recurring tasks, not features:

| Task | Frequency | What to do |
|------|-----------|------------|
| Update MPFS conversion factor | Annually (Jan) | Change `33.29` in `build_mpfs_sqlite.py` to new CF |
| Rebuild all SQLite DBs | Quarterly | Run all `build_*_sqlite.py` scripts |
| Check ASP quarter | Quarterly | Re-run `build_asp_sqlite.py` with new quarter file |
| Verify NCCI quarterly release | Quarterly | Download new NCCI ZIPs, rebuild `ncci.sqlite` |
| Update MUE quarter | Quarterly | Re-run `build_mue_sqlite.py` |
| Hospital directory refresh | Ad hoc | Re-run `build_hospital_directory_sqlite.py` |
| Clear stale hospital cache | Weekly (optional) | `find data/hospital_cache -mtime +7 -delete` |
