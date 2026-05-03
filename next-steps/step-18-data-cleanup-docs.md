# Step 18: Data Cleanup Documentation

> **AGENT INSTRUCTIONS:** You are implementing step 18.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–17 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Create a `DATA-CLEANUP.md` file in the project root that documents every data cleanup
decision made per source — why rows were dropped, why certain columns were ignored, and what
anomalies exist in the raw CMS files. This is a reference for future maintainers.

Also add a `data/README.md` that explains what's in the `data/` directory and how to rebuild
each SQLite file.

**Files to create:**
- `DATA-CLEANUP.md` — per-source cleanup decisions
- `data/README.md` — directory index and rebuild instructions

---

## Task 1: Create DATA-CLEANUP.md

Create `/root/projects/hospital-bill-checker/DATA-CLEANUP.md`:

```markdown
# Data Cleanup Notes

This document explains every non-obvious cleanup decision made when ingesting CMS data into SQLite.
Each section covers one data source, what the raw files look like, and why certain rows are dropped.

---

## NCCI PTP (`data/ncci.sqlite`)

**Script:** `scripts/build_ncci_sqlite.py`

### Raw file layout

CMS publishes NCCI PTP edits as Excel (`.xlsx`) files — one per bill type (Medicare Part B,
Hospital Outpatient, DME). Each file has multiple quarterly worksheets.

**Medicare Part B layout:**
- Column 0: Column 1 Code (the "included" code)
- Column 1: Column 2 Code (the "excluded" code when billed together)
- Column 2: Effective Date (YYYYMMDD integer)
- Column 3: Deletion Date (YYYYMMDD integer or 99991231 = never)
- Column 4: Modifier Indicator (0 or 1)

**Medicaid / outpatient / DME layout:**
Slightly different column ordering. Detected by whether column 1 is blank (Medicare layout) vs. populated.

### Cleanup decisions

- **Header rows dropped:** CMS files include literal header text rows like "Column 1 Code",
  "Column 2 Code", etc. These are filtered by the CODE_PATTERN regex `^[A-Z0-9]{4,7}$`.
- **Non-code descriptor rows:** Some rows contain category names (e.g., "MEDICINE CODES"). Also
  dropped by CODE_PATTERN.
- **Invalid format count:** Typically 300,000–400,000 rows per file fail CODE_PATTERN. This is
  expected — CMS NCCI files embed a large amount of human-readable text.
- **All effective date ranges kept:** We do NOT filter by date at ingest. Date filtering is done
  at query time: `effective_date <= service_date AND deletion_date >= service_date`. This allows
  correct lookups for past bills.
- **modifier_indicator stored per pair:** The modifier indicator applies to the specific
  (col1_code, col2_code) combination, not globally per col2. Same col2 may have indicator=0
  with one col1 and indicator=1 with another.

### Known anomalies

- `99991231` in deletion_date means "no deletion date" — treated as indefinitely active.
- Some pairs appear in multiple quarters with the same effective date but different deletion dates.
  The PRIMARY KEY `(col1_code, col2_code, effective_date, bill_type)` deduplicates these.

---

## MUE (`data/mue.sqlite`)

**Script:** `scripts/build_mue_sqlite.py`

### Raw file layout

CMS publishes MUE edits as `.csv` files. Three variants: practitioner, outpatient, DME.

Row 0: CMS disclaimer text (not a data row)
Row 1: Column headers (`HCPCS/CPT Code`, `CPT/HCPCS Descriptor`, `MUE Value`, `MUE Adjudication Indicator`, `MUE Rationale`)
Rows 2+: Data

### Cleanup decisions

- **Row 0 dropped:** The disclaimer row ("CMS publishes ...") is always row 0. Skipped explicitly.
- **Row 1 is the actual header:** Parsed as the column name row.
- **All MAI values kept:** We store MAI=1, MAI=2, and MAI=3 rows. At query time, only MAI=3
  (claim-line adjudication) is used for hard flagging. MAI=1 and MAI=2 are date-of-service limits
  and are not checked.
- **"N/A" MUE values:** Some codes have "N/A" in the MUE Value column — no public limit. These
  rows are stored with `mue_value = NULL` and are not checked.

### Known anomalies

- Some HCPCS codes appear in both practitioner and outpatient MUE tables with different values.
  Both are stored — `bill_type` column differentiates them.

---

## MPFS (`data/mpfs.sqlite`)

**Script:** `scripts/build_mpfs_sqlite.py`

### Raw file layout

Annual Excel file (`PPRRVU26.xlsx`). Header row detected by scanning for "HCPCS" in the first
column of the first 10 rows.

Relevant columns: `HCPCS`, `MOD` (modifier), `DESCRIPTION`, `STATUS CODE`, `NON-FAC TOTAL`,
`FAC TOTAL`, `NONFAC PE RVU`, `FAC PE RVU`, `WORK RVU`, `MP RVU`.

### Cleanup decisions

- **MOD rows skipped:** Rows where the `MOD` column is non-empty (e.g., modifier-specific rates)
  are skipped. We use the base code rate only. Modifier-specific rates differ rarely and the base
  rate is the conservative benchmark.
- **Status code rows:** Some rows have `STATUS CODE` = "C" (covered) vs. "I" (injected drug) vs.
  other codes. All status codes are kept; downstream logic can filter if needed.
- **Rate calculation:** `nonfac_rate = NONFAC_TOTAL × 33.29`. The $33.29 is the 2026 Medicare
  conversion factor. This must be updated annually.
- **Zero/null RVU rows:** Rows with `NONFAC_TOTAL = 0` or null result in `nonfac_rate = 0`. These
  are stored but never flagged (a 0-rate code can't be overbilled by ratio).

### Known anomalies

- The MPFS file includes thousands of codes with 0.00 RVUs — typically bundled services or
  codes not separately payable under Medicare. These are valid rows.

---

## CLFS (`data/clfs.sqlite`)

**Script:** `scripts/build_clfs_sqlite.py`

### Raw file layout

Annual TXT or CSV file from CMS. Delimiter is tab or comma — detected by trying tab first.
Header row contains `HCPCS` and either `PAYMENT_LIMIT` or `RATE`. Header is found by scanning
first 5 rows for a cell containing "HCPCS".

### Cleanup decisions

- **Full history kept:** All rows (all years, all effective dates) are stored in `clfs_rates`.
  A view `clfs_current` returns the latest rate per code using `ROW_NUMBER() OVER (PARTITION BY
  hcpcs_code ORDER BY effective_date DESC)`.
- **Non-HCPCS rows:** Some rows contain "COVERAGE POLICY" or notes. Filtered by requiring the
  HCPCS code to match `^[A-Z][0-9]{4}$`.

### Known anomalies

- Some codes have multiple effective dates in the same year (mid-year rate changes). The
  `clfs_current` view correctly picks the most recent.

---

## ASP (`data/asp.sqlite`)

**Script:** `scripts/build_asp_sqlite.py`

### Raw file layout

Quarterly Excel file. First 7 rows are a CMS header block (quarter name, disclaimer, blank rows).
Row 8 is the actual column header. Header detection scans first 15 rows for `HCPCS CODE` in the
first cell.

Relevant columns: `HCPCS Code`, `Short Descriptor`, `HCPCS Code Dosage`, `ASP+6%` (the actual
payment limit used by Medicare).

### Cleanup decisions

- **Only J/Q/C/A/B HCPCS prefixes kept:** ASP applies to injectable and infusion drugs. Other
  prefixes are noise in the file.
- **ASP+6% column used:** Medicare pays ASP+6% for most Part B drugs. We store the combined limit
  as `asp_payment_limit`.
- **NDC crosswalk table empty:** The `asp_ndc_hcpcs_crosswalk` table schema is created but not
  populated. This is future work (step 20).

### Known anomalies

- The CMS ASP file occasionally lists the same HCPCS code multiple times with different dosage
  descriptions (e.g., 1 mg vs 10 mg vials). The PRIMARY KEY on `hcpcs_code` keeps only the
  first occurrence. Future work: store all rows with dosage differentiator.

---

## OPPS (`data/opps.sqlite`)

**Script:** `scripts/build_opps_sqlite.py`

### Raw file layout

Two Excel files: Addendum B (HCPCS→APC mapping) and Addendum A (APC reference).
Neither file has pre-header rows — the first row is the header. Column position is variable;
the build script uses a flexible `find_col()` helper that searches by column name.

### Cleanup decisions

- **All APC types kept:** OPPS includes "packaged" APCs (where payment is bundled into another
  APC) and "pass-through" APCs. All are stored. Packaged services have `payment_rate = 0` and
  are not flagged.
- **Addendum A joined at query time:** `opps_addendum_b` stores HCPCS→APC, and `opps_addendum_a`
  stores APC→title. The join `loadOppsRate()` returns APC title for display.

---

## IPPS/DRG (`data/ipps.sqlite`)

**Script:** `scripts/build_ipps_sqlite.py`

### Raw file layout

Annual Excel file. Multiple sheets — the relevant sheet contains DRG codes. Sheet detection
scans all sheets for "DRG" in the first row, first cell.

### Cleanup decisions

- **DRG codes zero-padded to 3 digits:** CMS sometimes stores DRGs as integers (e.g., 470).
  We normalize to `"470"` (string, left-padded if needed).
- **Non-data rows:** Some sheets include subtotal rows or category headers. Filtered by requiring
  the DRG column to match `^[0-9]{3}$` after padding.

---

## DMEPOS (`data/dmepos.sqlite`)

**Script:** `scripts/build_dmepos_sqlite.py`

### Raw file layout

Annual Excel file (`DMEPOS_APR.xlsx`) from `dme26-b.zip`. Two tables: a base code table and
state-specific rate columns. State column headers match the pattern `^([A-Z]{2})\s*\(NR\)` —
e.g., "TX (NR)" means Texas non-rural rate.

### Cleanup decisions

- **Only Non-Rural (NR) rates stored:** The file also contains rural rates and capped rental
  rates. Non-rural is the most common case. Future work: add rural rates for rural ZIP codes.
- **Modifier preference:** When looking up a code, rows with blank modifier are preferred.
  Modifier-specific rows (e.g., modifier KH, KI) handle rental vs. purchase scenarios.
- **State codes validated:** Only 2-letter uppercase state codes extracted. Non-state columns
  (e.g., "NATIONAL") are skipped.

---

## Ambulance (`data/ambulance.sqlite`)

**Script:** `scripts/build_ambulance_sqlite.py`

### Raw file layout

Two ZIP files: base rates and ZIP-to-locality geography mapping. Column detection is adaptive
(no fixed column positions assumed).

### Cleanup decisions

- **Only BLS/ALS codes checked:** Ambulance HCPCS codes are A0428 (BLS), A0427 (ALS-1),
  A0433 (ALS-2), A0430 (fixed wing), A0431 (rotary wing), A0434 (specialty care transport).
  Other A-codes are not ambulance transport.
- **ZIP-to-locality required:** Without a service ZIP code on the bill, ambulance checking is
  skipped entirely.

---

## Hospital Directory (`data/hospital_directory.sqlite`)

**Script:** `scripts/build_hospital_directory_sqlite.py`

### Raw file layout

CMS Hospital General Information CSV from data.cms.gov. Standard CSV with header row.

### Cleanup decisions

- **`normalized_name` column added:** Lowercase, punctuation-stripped version of facility_name.
  Used for fuzzy matching against hospital names extracted from bills.
- **`phone_digits` column added:** 10 digits only, no formatting. Used as a secondary match key
  when the hospital name is ambiguous.

---

## Hospital MRF Cache (`data/hospital_cache/`)

**Script:** `scripts/fetch_hospital_trilliant.py`

### Source

Trilliant Health / Oria platform (`oria-data.trillianthealth.com`). HTML page per hospital.
DuckDB file URL extracted from HTML `<a>` tags matching `*_parsed.duckdb`.

### Cleanup decisions

- **7-day TTL cache:** SQLite files cached in `data/hospital_cache/<provider_id>.sqlite`.
  Staleness checked at lookup time — if `meta.fetched_at < now - 7 days`, re-fetch.
- **DuckDB → SQLite conversion:** The DuckDB file is read using the `duckdb` Python package.
  All rows from the `charges` table are written to SQLite. The `meta` table stores source URL
  and fetch timestamp.
- **Charges table schema normalized:** Column names from Trilliant files vary. The conversion
  script normalizes to: `code`, `description`, `gross_charge`, `discounted_cash`,
  `min_negotiated`, `max_negotiated`, `setting`.
```

---

## Task 2: Create data/README.md

Create `/root/projects/hospital-bill-checker/data/README.md`:

```markdown
# data/

This directory contains all SQLite databases used by the hospital bill checker app.
Files are NOT committed to git — they must be built from CMS source data using the scripts below.

## Directory Structure

```
data/
  ncci.sqlite              — NCCI PTP edits (3 bill types)
  mue.sqlite               — Medically Unlikely Edits (3 bill types)
  mpfs.sqlite              — Medicare Physician Fee Schedule
  clfs.sqlite              — Clinical Lab Fee Schedule
  asp.sqlite               — Average Sales Price (Part B drugs)
  opps.sqlite              — OPPS Addendum B + A (outpatient APC rates)
  ipps.sqlite              — IPPS DRG weights (inpatient)
  dmepos.sqlite            — DMEPOS state fee schedule
  ambulance.sqlite         — Ambulance Fee Schedule + ZIP geography
  hospital_directory.sqlite — CMS hospital directory (for name matching)
  hospital_cache/          — Per-hospital MRF pricing (7-day TTL, auto-populated)
```

## Rebuilding All Databases

Run scripts in order (each is idempotent — safe to re-run):

```bash
python3 scripts/build_ncci_sqlite.py
python3 scripts/build_mue_sqlite.py
python3 scripts/build_mpfs_sqlite.py
python3 scripts/build_clfs_sqlite.py
python3 scripts/build_asp_sqlite.py
python3 scripts/build_opps_sqlite.py
python3 scripts/build_ipps_sqlite.py
python3 scripts/build_dmepos_sqlite.py
python3 scripts/build_ambulance_sqlite.py
python3 scripts/build_hospital_directory_sqlite.py
```

Each script downloads the latest CMS files and creates/replaces the SQLite database.
Scripts require: `pip install requests openpyxl duckdb`

## Checking Database Sizes

```bash
du -sh data/*.sqlite
sqlite3 data/ncci.sqlite "SELECT COUNT(*) FROM ncci_ptp"
sqlite3 data/mue.sqlite "SELECT COUNT(*) FROM mue_edits"
```

## Hospital Cache

The `hospital_cache/` subdirectory is populated automatically when the app processes a bill
that includes a recognized hospital name. You can pre-populate it by running:

```bash
python3 scripts/fetch_hospital_trilliant.py "Hospital Name" --state TX
```

Cache files older than 7 days are automatically refreshed on next lookup.

## Data Freshness

See `DATA-CLEANUP.md` for per-source refresh cadences and staleness notes.
See `/data` in the running app for the same information in a UI.
```

---

## Task 3: Verify files created

- [ ] Confirm `DATA-CLEANUP.md` exists in project root
- [ ] Confirm `data/README.md` exists (create `data/` directory if it doesn't exist yet)
- [ ] Run: `ls -la /root/projects/hospital-bill-checker/data/`

---

## Task 4: Commit

```bash
cd /root/projects/hospital-bill-checker
git add DATA-CLEANUP.md data/README.md
git commit -m "docs: add data cleanup notes and data/ directory README"
```
