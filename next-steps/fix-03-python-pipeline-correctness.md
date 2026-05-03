# Fix 03: Python Pipeline Correctness

> **AGENT INSTRUCTIONS:** You are implementing fix 03.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix six bugs in the Python data-build scripts (`scripts/`) that cause silently corrupt or incomplete SQLite databases. Corrupt databases cause wrong audit findings for every patient who runs the checker.

---

## Background

Six bugs were found across the Python pipeline scripts:

- **P1 (CRITICAL):** `build_ncci_sqlite.py` uses `INSERT OR REPLACE` across 9 ZIPs and swallows all SQLite errors silently (`except sqlite3.Error: pass`). If the same code pair appears in multiple ZIP files with the same effective date, later files silently overwrite `modifier_indicator` — the most critical field.
- **P2 (CRITICAL):** `build_ncci_sqlite.py` Medicare/Medicaid layout detection depends on column index 2 being blank or `*`. If CMS changes the Medicare file format (it has happened), all Medicare rows get wrong column offsets and the parser silently loads wrong dates and modifier values.
- **P3 (CRITICAL):** `build_mue_sqlite.py` silently drops CMS-suppressed MUE values (`"*"`) via `continue`. These suppressed codes have no entry in the DB at all, and the `mue_value INTEGER NOT NULL` schema cannot store a NULL sentinel.
- **P4 (IMPORTANT):** `build_opps_sqlite.py` detects data start by comparing `row == tuple(header_row)`. If CMS adds a column to the Excel header, this comparison never matches, 0 rows are parsed, and no error is raised.
- **P7 (IMPORTANT):** `build_mpfs_sqlite.py` uses hardcoded integer indices `NONFAC_TOTAL_COL = 11` and `FAC_TOTAL_COL = 12`. If CMS shifts columns, the wrong dollar amounts are silently loaded.
- **P12 (IMPORTANT):** `build_asp_sqlite.py` selects `csv_files[0]` as fallback when no `payment_limit` file matches. If CMS renames the ZIP contents, it may pick the "not payable" file instead.
- **P10 (CRITICAL):** `requirements.txt` references `beautifulsoup4==4.14.3` which does not exist on PyPI. `pip install -r requirements.txt` fails entirely.

---

## Task 1: Fix P10 — Fix `requirements.txt` bogus version

**File:** `scripts/requirements.txt`

Current content:
```
rapidfuzz==3.14.5
duckdb==1.5.2
requests==2.31.0
beautifulsoup4==4.14.3
openpyxl==3.1.5
```

`beautifulsoup4==4.14.3` does not exist. The latest stable release as of 2025 is `4.12.3`. Replace:

```
rapidfuzz==3.14.5
duckdb==1.5.2
requests==2.31.0
beautifulsoup4==4.12.3
openpyxl==3.1.5
```

Verify: `pip install beautifulsoup4==4.12.3` must succeed. If a newer version is available, you may use it — just confirm it exists on PyPI first.

---

## Task 2: Fix P1 — Log NCCI conflicts instead of silently swallowing them

**File:** `scripts/build_ncci_sqlite.py`

Find the `insert_rows` function (around line 183):

```python
def insert_rows(conn: sqlite3.Connection, rows: list[tuple]) -> int:
    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO ncci_ptp
                   (col1_code, col2_code, effective_date, deletion_date,
                    modifier_indicator, rationale, bill_type, source)
                   VALUES (?,?,?,?,?,?,?,?)""",
                row,
            )
            inserted += 1
        except sqlite3.Error:
            pass
    return inserted
```

Replace with:

```python
def insert_rows(conn: sqlite3.Connection, rows: list[tuple]) -> int:
    """
    Insert rows, logging any conflicts where modifier_indicator differs.
    INSERT OR REPLACE is kept intentionally — later ZIPs are assumed to be more authoritative —
    but conflicts are logged so they can be investigated if needed.
    """
    inserted = 0
    replaced = 0
    for row in rows:
        col1, col2, eff_date, del_date, mod, rationale, bill_type, source = row
        try:
            # Check for existing row with different modifier_indicator
            existing = conn.execute(
                """SELECT modifier_indicator FROM ncci_ptp
                   WHERE col1_code=? AND col2_code=? AND effective_date=? AND bill_type=?""",
                (col1, col2, eff_date, bill_type),
            ).fetchone()
            if existing and existing[0] != mod:
                print(
                    f"  CONFLICT: {col1}/{col2} eff={eff_date} {bill_type}: "
                    f"modifier {existing[0]!r} -> {mod!r} (source={source})"
                )
                replaced += 1
            conn.execute(
                """INSERT OR REPLACE INTO ncci_ptp
                   (col1_code, col2_code, effective_date, deletion_date,
                    modifier_indicator, rationale, bill_type, source)
                   VALUES (?,?,?,?,?,?,?,?)""",
                row,
            )
            inserted += 1
        except sqlite3.Error as e:
            print(f"  ERROR inserting {col1}/{col2}: {e}")
    if replaced:
        print(f"  WARNING: {replaced} rows had modifier_indicator conflicts — review output above.")
    return inserted
```

---

## Task 3: Fix P2 — Add verification for NCCI layout detection

**File:** `scripts/build_ncci_sqlite.py`

After `parse_txt` parses a file, add a row-count sanity check. Find `process_zip` (around line 145):

```python
def process_zip(zip_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    rows: list[tuple] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        txt_files = [n for n in archive.namelist() if n.lower().endswith(".txt")]
        print(f"  ZIP contains: {archive.namelist()}")
        for fname in txt_files:
            print(f"  Parsing {fname} ...")
            parsed = parse_txt(archive.read(fname), bill_type, source)
            print(f"    -> {len(parsed):,} rows")
            rows.extend(parsed)
    return rows
```

Replace with:

```python
MIN_EXPECTED_NCCI_ROWS = 5_000  # NCCI files typically have 200k+ pairs; 5k is a hard floor

def process_zip(zip_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    rows: list[tuple] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        txt_files = [n for n in archive.namelist() if n.lower().endswith(".txt")]
        print(f"  ZIP contains: {archive.namelist()}")
        for fname in txt_files:
            print(f"  Parsing {fname} ...")
            parsed = parse_txt(archive.read(fname), bill_type, source)
            print(f"    -> {len(parsed):,} rows")
            if len(parsed) < MIN_EXPECTED_NCCI_ROWS:
                raise ValueError(
                    f"Suspiciously few rows from {fname}: {len(parsed):,} "
                    f"(expected >= {MIN_EXPECTED_NCCI_ROWS:,}). "
                    "This usually means the layout detection (is_medicare_layout) failed. "
                    "Check that column offsets match the current CMS file format."
                )
            rows.extend(parsed)
    return rows
```

---

## Task 4: Fix P3 — Handle CMS-suppressed MUE values (`"*"`)

**File:** `scripts/build_mue_sqlite.py`

**Part A:** Update the schema to allow nullable `mue_value`:

Find `create_schema` (around line 91):

```python
        CREATE TABLE IF NOT EXISTS mue_edits (
            hcpcs_code                  TEXT NOT NULL,
            mue_value                   INTEGER NOT NULL,
            mue_adjudication_indicator  TEXT NOT NULL,
```

Change `mue_value INTEGER NOT NULL` to `mue_value INTEGER`:

```python
        CREATE TABLE IF NOT EXISTS mue_edits (
            hcpcs_code                  TEXT NOT NULL,
            mue_value                   INTEGER,
            mue_adjudication_indicator  TEXT NOT NULL,
```

**Part B:** Store suppressed values as NULL instead of dropping them. Find the parse loop (around line 72):

```python
        mue_val_str = str(row[1]).strip() if len(row) > 1 else ""
        try:
            mue_value = int(mue_val_str)
        except ValueError:
            continue
```

Replace with:

```python
        mue_val_str = str(row[1]).strip() if len(row) > 1 else ""
        if mue_val_str == "*":
            # CMS-suppressed value — store as NULL so the code is still visible in the DB
            mue_value = None
        else:
            try:
                mue_value = int(mue_val_str)
            except ValueError:
                # Skip completely unparseable values (non-numeric, non-suppressed)
                print(f"  Skipping unparseable mue_value {mue_val_str!r} for code {code!r}")
                continue
```

**Part C:** Update the audit engine to handle NULL `mue_value`. In `src/lib/server/audit-rules.ts`, Check 2:

```typescript
    const maxUnits = mueEntry.mue_value
    const mai = String(mueEntry.mue_adjudication_indicator ?? '')

    if (mai === '3' && unitsBilled > maxUnits) {
```

Update to:

```typescript
    const maxUnits = mueEntry.mue_value
    const mai = String(mueEntry.mue_adjudication_indicator ?? '')

    // mue_value is NULL for CMS-suppressed codes — skip the check (no limit published)
    if (maxUnits == null) continue
    if (mai === '3' && unitsBilled > maxUnits) {
```

---

## Task 5: Fix P4 — Make OPPS header detection robust to extra CMS columns

**File:** `scripts/build_opps_sqlite.py`

Find the data start detection (around line 162):

```python
    data_started = False

    for row in ws.iter_rows(values_only=True):
        if not data_started:
            # Skip until past header
            if row == tuple(header_row):
                data_started = True
            continue
```

Replace with a more robust approach — check that the HCPCS column of the current row contains a valid code (starts with digit or letter, 5 chars), instead of requiring exact header row equality:

```python
    data_started = False
    rows_attempted = 0

    for row in ws.iter_rows(values_only=True):
        if not data_started:
            # Detect data start: look for a cell matching a HCPCS code pattern
            # in the HCPCS column position. More robust than exact header row equality.
            if hcpcs_col is not None and hcpcs_col < len(row) and row[hcpcs_col] is not None:
                candidate = str(row[hcpcs_col]).strip().upper()
                if CODE_PATTERN.match(candidate):
                    data_started = True
                    # Fall through — process this row as data
                else:
                    continue
            else:
                continue
```

After the loop, add a row count assertion:

```python
    MIN_EXPECTED_OPPS_ROWS = 1_000
    if len(rows) < MIN_EXPECTED_OPPS_ROWS:
        raise ValueError(
            f"OPPS: only {len(rows):,} rows parsed (expected >= {MIN_EXPECTED_OPPS_ROWS:,}). "
            "Header detection may have failed — check Excel column layout."
        )
```

---

## Task 6: Fix P7 — Use header-name lookup for MPFS rate columns

**File:** `scripts/build_mpfs_sqlite.py`

Find the hardcoded column indices (around line 89):

```python
    HCPCS_COL = 0
    MOD_COL = 1
    DESC_COL = 2
    STATUS_COL = 3
    NONFAC_TOTAL_COL = 11
    FAC_TOTAL_COL = 12
```

These are fine as fallbacks, but the critical rate columns should be found by header name. Replace the entire block with a header-scanning approach:

```python
    # Default (fallback) column positions if header scanning fails
    HCPCS_COL = 0
    MOD_COL = 1
    DESC_COL = 2
    STATUS_COL = 3
    NONFAC_TOTAL_COL = 11  # fallback only — see header scan below
    FAC_TOTAL_COL = 12     # fallback only — see header scan below

    header_found = False
    rows: list[tuple] = []

    for row in ws.iter_rows(values_only=True):
        if not header_found:
            val = str(row[HCPCS_COL]).strip().upper() if row[HCPCS_COL] is not None else ""
            if val == "HCPCS":
                # Scan the header row to find rate column positions by name
                header_cells = [str(c).strip().upper() if c is not None else "" for c in row]
                for idx, cell in enumerate(header_cells):
                    # CMS MPFS headers: "NON-FACILITY PRICING AMOUNT", "FACILITY PRICING AMOUNT"
                    # or variations like "NONFAC TOTAL" / "FAC TOTAL"
                    if any(kw in cell for kw in ("NON-FAC", "NONFAC", "NON FAC", "NONFACILITY")):
                        if "TOTAL" in cell or "PRICING" in cell or "AMOUNT" in cell:
                            NONFAC_TOTAL_COL = idx
                            print(f"  Found NONFAC_TOTAL_COL at index {idx}: {cell!r}")
                    if "FAC" in cell and "NON" not in cell:
                        if "TOTAL" in cell or "PRICING" in cell or "AMOUNT" in cell:
                            FAC_TOTAL_COL = idx
                            print(f"  Found FAC_TOTAL_COL at index {idx}: {cell!r}")
                header_found = True
            continue
```

Add an assertion after header scanning to fail loudly if the critical columns weren't found via the header and are still using hardcoded fallbacks:

```python
    # After parsing, verify we got reasonable data for the critical columns
    if rows:
        sample_nonfac = [r[3] for r in rows[:20] if r[3] is not None]  # nonfac_rate is 4th element
        if sample_nonfac:
            avg = sum(sample_nonfac) / len(sample_nonfac)
            if avg < 1.0:
                print(
                    f"WARNING: Average nonfac_rate is {avg:.4f} — this looks like raw RVUs, not dollars. "
                    "Expected ~$50–$200 for common CPT codes. "
                    "Check that NONFAC_TOTAL_COL points to the dollar column, not the RVU column."
                )
            elif avg > 10_000:
                print(
                    f"WARNING: Average nonfac_rate is {avg:.2f} — this looks too high. "
                    "Check column mapping."
                )
```

---

## Task 7: Fix P12 — Make ASP file selection fail loudly on ambiguous content

**File:** `scripts/build_asp_sqlite.py`

Find the file selection logic (around line 164):

```python
        payment_limit_files = [
            n for n in csv_files
            if "payment limit" in n.lower() and "not payable" not in n.lower()
        ]
        fname = payment_limit_files[0] if payment_limit_files else csv_files[0]
```

Replace with:

```python
        payment_limit_files = [
            n for n in csv_files
            if "payment limit" in n.lower() and "not payable" not in n.lower()
        ]
        not_payable_files = [n for n in csv_files if "not payable" in n.lower()]

        if payment_limit_files:
            fname = payment_limit_files[0]
            print(f"  Selected payment limits file: {fname}")
        elif csv_files and not not_payable_files:
            # Only one CSV and it's not obviously "not payable" — use it with a warning
            fname = csv_files[0]
            print(f"  WARNING: Could not identify payment limits file by name. Using: {fname}")
            print(f"  All CSV files in ZIP: {csv_files}")
            print("  Verify this file contains 'HCPCS Code' and 'Payment Limit' columns.")
        else:
            print(f"ERROR: Could not find ASP payment limits CSV. ZIP contains: {csv_files}")
            print("Expected a file with 'payment limit' in the name (case-insensitive).")
            print("CMS may have renamed the file. Check: https://www.cms.gov/Medicare/Medicare-Fee-for-Service-Part-B-Drugs/McrPartBDrugAvgSalesPrice/2025ASPFiles")
            sys.exit(1)
```

---

## Verification

- [ ] `pip install -r scripts/requirements.txt` succeeds
- [ ] `python scripts/build_ncci_sqlite.py` exits non-zero if row count is suspiciously low
- [ ] `python scripts/build_mue_sqlite.py` logs (does not skip) suppressed `"*"` values
- [ ] After running `build_mpfs_sqlite.py`, check: `sqlite3 data/mpfs.sqlite "SELECT AVG(nonfac_rate) FROM mpfs_rates WHERE nonfac_rate > 0"` — result should be between $10 and $500, not 0.5 or 50000
- [ ] `python scripts/build_asp_sqlite.py` exits with error if only a "not payable" CSV is found
- [ ] `npm run check` passes (TypeScript changes in audit-rules.ts)
- [ ] `npm run test` passes

---

## Commit

```bash
git add scripts/requirements.txt scripts/build_ncci_sqlite.py scripts/build_mue_sqlite.py scripts/build_opps_sqlite.py scripts/build_mpfs_sqlite.py scripts/build_asp_sqlite.py src/lib/server/audit-rules.ts
git commit -m "fix: python pipeline — requirements.txt, NCCI conflict logging, MUE NULL suppressed, OPPS header robustness, MPFS column lookup, ASP file selection"
```
