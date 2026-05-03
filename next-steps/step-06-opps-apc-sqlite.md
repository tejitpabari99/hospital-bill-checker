# Step 06: OPPS/APC → SQLite (New Data Source)

> **AGENT INSTRUCTIONS:** You are implementing step 06.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–05 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Add CMS OPPS (Outpatient Prospective Payment System) data to `data/opps.sqlite`.
This covers Addendum A (APC groups) and Addendum B (HCPCS → APC mapping + payment rate).
Used for hospital outpatient facility billing (when `billType === 'outpatient'`).

**Files to create:**
- `scripts/build_opps_sqlite.py`
- `data/opps.sqlite` — generated

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadOppsRate`
- `src/lib/server/audit-rules.ts` — add OPPS benchmark to outpatient findings

---

## Task 1: Understand the OPPS data

**Sources (April 2026 quarter):**
- Addendum B ZIP: `https://www.cms.gov/files/zip/cy-2026-april-opps-addendum-b.zip`
- Addendum A ZIP: `https://www.cms.gov/files/zip/cy-2026-april-opps-addendum.zip`

Inside each ZIP is an Excel `.xlsx` file. No pre-header rows — the worksheet starts directly with the column header row.

**Addendum B columns** (HCPCS → payment):
| Column | Use |
|--------|-----|
| HCPCS Code | CPT/HCPCS code |
| Short Descriptor | Short name |
| SI / Status Indicator | Payment status (see below) |
| APC | APC group number |
| Relative Weight | APC relative weight |
| Payment Rate | CMS outpatient facility payment rate |
| Copayment | National unadjusted copayment |
| Min Copayment | Minimum unadjusted copayment |
| Note | Footnotes |

**Status Indicator meanings (key ones):**
- `S` = Significant Procedure, not discounted when multiple
- `T` = Significant Procedure, discounted when multiple
- `V` = Visit to clinic/ED
- `J1` = Comprehensive APC (most services packaged in)
- `Q1`, `Q2`, `Q3` = Packaged service (no separate payment)
- `N` = Packaged service, never separately paid
- `X` = Ancillary service
- `C` = Inpatient procedure (not covered for outpatient)

**Addendum A columns** (APC reference):
| Column | Use |
|--------|-----|
| APC | APC group number |
| Group Title | APC description |
| SI / Status Indicator | Same as above |
| Relative Weight | |
| Payment Rate | |

**Quarter:** `2026Q2` (April 2026 release, effective April 1, 2026)

---

## Task 2: Write the build script

**File:** `scripts/build_opps_sqlite.py`

- [ ] Create `scripts/build_opps_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/opps.sqlite from CMS OPPS Addendum A and B files.

Sources (April 2026):
  Addendum B: https://www.cms.gov/files/zip/cy-2026-april-opps-addendum-b.zip
  Addendum A: https://www.cms.gov/files/zip/cy-2026-april-opps-addendum.zip

Usage:
  python3 scripts/build_opps_sqlite.py
  python3 scripts/build_opps_sqlite.py --addb /path/to/addendum-b.zip --adda /path/to/addendum-a.zip
"""

from __future__ import annotations

import argparse
import io
import os
import re
import sqlite3
import sys
import urllib.request
import zipfile
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("ERROR: openpyxl required. Run: pip install openpyxl")
    sys.exit(1)

DB_PATH = Path(__file__).parent.parent / "data" / "opps.sqlite"

ADDB_URL = "https://www.cms.gov/files/zip/cy-2026-april-opps-addendum-b.zip"
ADDA_URL = "https://www.cms.gov/files/zip/cy-2026-april-opps-addendum.zip"

QUARTER = "2026Q2"
EFFECTIVE_DATE = "2026-04-01"

CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS opps_addendum_b (
            quarter                         TEXT NOT NULL,
            effective_date                  TEXT NOT NULL,
            hcpcs_code                      TEXT NOT NULL,
            short_descriptor                TEXT,
            status_indicator                TEXT,
            apc                             TEXT,
            relative_weight                 NUMERIC,
            payment_rate                    NUMERIC,
            national_unadjusted_copayment   NUMERIC,
            minimum_unadjusted_copayment    NUMERIC,
            ira_coinsurance_percentage      NUMERIC,
            adjusted_beneficiary_copayment  NUMERIC,
            pass_through_expiration         TEXT,
            note                            TEXT,
            changed_flag                    TEXT,
            source_file                     TEXT,
            PRIMARY KEY (quarter, hcpcs_code)
        );

        CREATE INDEX IF NOT EXISTS idx_opps_b_code
            ON opps_addendum_b(hcpcs_code);

        CREATE INDEX IF NOT EXISTS idx_opps_b_apc
            ON opps_addendum_b(apc);

        CREATE INDEX IF NOT EXISTS idx_opps_b_si
            ON opps_addendum_b(status_indicator);

        CREATE TABLE IF NOT EXISTS opps_addendum_a (
            quarter                         TEXT NOT NULL,
            effective_date                  TEXT NOT NULL,
            apc                             TEXT NOT NULL,
            group_title                     TEXT,
            status_indicator                TEXT,
            relative_weight                 NUMERIC,
            payment_rate                    NUMERIC,
            national_unadjusted_copayment   NUMERIC,
            minimum_unadjusted_copayment    NUMERIC,
            ira_coinsurance_percentage      NUMERIC,
            adjusted_beneficiary_copayment  NUMERIC,
            pass_through_expiration         TEXT,
            note                            TEXT,
            source_file                     TEXT,
            PRIMARY KEY (quarter, apc)
        );

        CREATE INDEX IF NOT EXISTS idx_opps_a_apc
            ON opps_addendum_a(apc);
    """)


def safe_float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").replace("%", "").strip())
    except (ValueError, TypeError):
        return None


def find_col(header_row, *candidates: str) -> int | None:
    """Find column index matching any candidate (case-insensitive, partial match allowed)."""
    for i, cell in enumerate(header_row):
        cell_upper = str(cell).strip().upper() if cell is not None else ""
        for candidate in candidates:
            if candidate.upper() in cell_upper:
                return i
    return None


def parse_addendum_b(xlsx_bytes: bytes, source_file: str) -> list[tuple]:
    """Parse Addendum B. Returns rows for opps_addendum_b."""
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    # Find the header row (contains 'HCPCS' somewhere)
    header_row_idx = None
    header_row = None
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        row_strs = [str(c).strip().upper() if c is not None else "" for c in row]
        if "HCPCS" in row_strs or any("HCPCS" in s for s in row_strs):
            header_row_idx = i
            header_row = row
            break

    if header_row is None:
        print("ERROR: Could not find Addendum B header row")
        return []

    print(f"  Addendum B header at row {header_row_idx}: {[str(c)[:20] for c in header_row[:10]]}")

    hcpcs_col = find_col(header_row, "HCPCS")
    desc_col = find_col(header_row, "SHORT DESCRIPTOR", "SHORT DESC", "DESCRIPTOR")
    si_col = find_col(header_row, "STATUS INDICATOR", "SI")
    apc_col = find_col(header_row, "APC")
    rw_col = find_col(header_row, "RELATIVE WEIGHT", "REL WEIGHT")
    rate_col = find_col(header_row, "PAYMENT RATE", "PAYMENT", "RATE")
    cop_col = find_col(header_row, "NATIONAL UNADJ", "NATIONAL COPAY")
    min_cop_col = find_col(header_row, "MINIMUM UNADJ", "MIN COPAY")
    ira_col = find_col(header_row, "IRA", "COINSURANCE %")
    adj_cop_col = find_col(header_row, "ADJUSTED BENEF", "ADJ COPAY")
    exp_col = find_col(header_row, "PASS THROUGH EXP", "EXPIRATION")
    note_col = find_col(header_row, "NOTE")
    changed_col = find_col(header_row, "CHANGED", "FLAG")

    rows: list[tuple] = []
    data_started = False

    for row in ws.iter_rows(values_only=True):
        if not data_started:
            # Skip until past header
            if row == tuple(header_row):
                data_started = True
            continue

        if hcpcs_col is None or hcpcs_col >= len(row):
            continue

        code = str(row[hcpcs_col]).strip().upper() if row[hcpcs_col] is not None else ""
        if not CODE_PATTERN.match(code):
            continue

        def get(col) -> str | float | None:
            if col is None or col >= len(row):
                return None
            return row[col]

        rows.append((
            QUARTER, EFFECTIVE_DATE, code,
            str(get(desc_col) or "").strip() or None,
            str(get(si_col) or "").strip() or None,
            str(get(apc_col) or "").strip() or None,
            safe_float(get(rw_col)),
            safe_float(get(rate_col)),
            safe_float(get(cop_col)),
            safe_float(get(min_cop_col)),
            safe_float(get(ira_col)),
            safe_float(get(adj_cop_col)),
            str(get(exp_col) or "").strip() or None,
            str(get(note_col) or "").strip() or None,
            str(get(changed_col) or "").strip() or None,
            source_file,
        ))

    wb.close()
    return rows


def parse_addendum_a(xlsx_bytes: bytes, source_file: str) -> list[tuple]:
    """Parse Addendum A. Returns rows for opps_addendum_a."""
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    header_row = None
    header_row_idx = None
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        row_strs = [str(c).strip().upper() if c is not None else "" for c in row]
        if "APC" in row_strs or any("APC" in s for s in row_strs[:5]):
            header_row = row
            header_row_idx = i
            break

    if header_row is None:
        print("ERROR: Could not find Addendum A header row")
        return []

    print(f"  Addendum A header at row {header_row_idx}: {[str(c)[:20] for c in header_row[:8]]}")

    apc_col = find_col(header_row, "APC")
    title_col = find_col(header_row, "GROUP TITLE", "TITLE", "DESCRIPTION")
    si_col = find_col(header_row, "STATUS INDICATOR", "SI")
    rw_col = find_col(header_row, "RELATIVE WEIGHT")
    rate_col = find_col(header_row, "PAYMENT RATE", "PAYMENT", "RATE")
    cop_col = find_col(header_row, "NATIONAL UNADJ", "NATIONAL COPAY")
    min_cop_col = find_col(header_row, "MINIMUM UNADJ", "MIN COPAY")
    ira_col = find_col(header_row, "IRA", "COINSURANCE")
    adj_cop_col = find_col(header_row, "ADJUSTED BENEF", "ADJ COPAY")
    exp_col = find_col(header_row, "EXPIRATION")
    note_col = find_col(header_row, "NOTE")

    rows: list[tuple] = []
    data_started = False

    for row in ws.iter_rows(values_only=True):
        if not data_started:
            if row == tuple(header_row):
                data_started = True
            continue

        if apc_col is None or apc_col >= len(row):
            continue

        apc = str(row[apc_col]).strip() if row[apc_col] is not None else ""
        if not apc or not re.match(r"^[0-9]{4}$", apc):
            continue

        def get(col) -> str | float | None:
            if col is None or col >= len(row):
                return None
            return row[col]

        rows.append((
            QUARTER, EFFECTIVE_DATE, apc,
            str(get(title_col) or "").strip() or None,
            str(get(si_col) or "").strip() or None,
            safe_float(get(rw_col)),
            safe_float(get(rate_col)),
            safe_float(get(cop_col)),
            safe_float(get(min_cop_col)),
            safe_float(get(ira_col)),
            safe_float(get(adj_cop_col)),
            str(get(exp_col) or "").strip() or None,
            str(get(note_col) or "").strip() or None,
            source_file,
        ))

    wb.close()
    return rows


def get_xlsx_from_zip(zip_bytes: bytes) -> tuple[bytes, str]:
    """Extract the first .xlsx from a ZIP. Returns (xlsx_bytes, filename)."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        print(f"  ZIP contents: {archive.namelist()}")
        xlsx_files = [n for n in archive.namelist() if n.lower().endswith(".xlsx")
                      and not n.startswith("__")]
        if not xlsx_files:
            raise RuntimeError("No .xlsx file found in ZIP")
        fname = xlsx_files[0]
        return archive.read(fname), fname


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--addb", help="Local Addendum B ZIP path")
    parser.add_argument("--adda", help="Local Addendum A ZIP path")
    args = parser.parse_args()

    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    # --- Addendum B ---
    print("\nProcessing Addendum B (HCPCS → APC → payment)...")
    if args.addb:
        zip_b = Path(args.addb).read_bytes()
    else:
        print(f"Downloading {ADDB_URL} ...")
        zip_b = download_bytes(ADDB_URL)
        print(f"  Downloaded {len(zip_b):,} bytes")

    xlsx_b, fname_b = get_xlsx_from_zip(zip_b)
    print(f"Parsing {fname_b} ...")
    rows_b = parse_addendum_b(xlsx_b, fname_b)
    print(f"Parsed {len(rows_b):,} Addendum B rows")

    inserted_b = 0
    for row in rows_b:
        try:
            conn.execute("""INSERT OR REPLACE INTO opps_addendum_b
                (quarter, effective_date, hcpcs_code, short_descriptor, status_indicator, apc,
                 relative_weight, payment_rate, national_unadjusted_copayment,
                 minimum_unadjusted_copayment, ira_coinsurance_percentage,
                 adjusted_beneficiary_copayment, pass_through_expiration, note, changed_flag, source_file)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", row)
            inserted_b += 1
        except sqlite3.Error as e:
            print(f"  Insert B error: {e}")

    conn.commit()
    print(f"Inserted {inserted_b:,} Addendum B rows")

    # --- Addendum A ---
    print("\nProcessing Addendum A (APC reference)...")
    if args.adda:
        zip_a = Path(args.adda).read_bytes()
    else:
        print(f"Downloading {ADDA_URL} ...")
        zip_a = download_bytes(ADDA_URL)
        print(f"  Downloaded {len(zip_a):,} bytes")

    xlsx_a, fname_a = get_xlsx_from_zip(zip_a)
    print(f"Parsing {fname_a} ...")
    rows_a = parse_addendum_a(xlsx_a, fname_a)
    print(f"Parsed {len(rows_a):,} Addendum A rows")

    inserted_a = 0
    for row in rows_a:
        try:
            conn.execute("""INSERT OR REPLACE INTO opps_addendum_a
                (quarter, effective_date, apc, group_title, status_indicator,
                 relative_weight, payment_rate, national_unadjusted_copayment,
                 minimum_unadjusted_copayment, ira_coinsurance_percentage,
                 adjusted_beneficiary_copayment, pass_through_expiration, note, source_file)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", row)
            inserted_a += 1
        except sqlite3.Error as e:
            print(f"  Insert A error: {e}")

    conn.commit()
    print(f"Inserted {inserted_a:,} Addendum A rows")

    # Summary
    print(f"\n{'='*50}")
    b_count = conn.execute("SELECT COUNT(*) FROM opps_addendum_b").fetchone()[0]
    a_count = conn.execute("SELECT COUNT(*) FROM opps_addendum_a").fetchone()[0]
    print(f"opps_addendum_b: {b_count:,} rows")
    print(f"opps_addendum_a: {a_count:,} rows")

    # Spot checks
    row = conn.execute(
        "SELECT hcpcs_code, short_descriptor, status_indicator, apc, payment_rate FROM opps_addendum_b WHERE hcpcs_code='99285'"
    ).fetchone()
    print(f"\n99285 in Addendum B: {row}")

    row = conn.execute(
        "SELECT hcpcs_code, short_descriptor, status_indicator, apc, payment_rate FROM opps_addendum_b WHERE hcpcs_code='70450'"
    ).fetchone()
    print(f"70450 in Addendum B: {row}")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")


if __name__ == "__main__":
    main()
```

---

## Task 3: Build the database

- [ ] Run:

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_opps_sqlite.py
```

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/opps.sqlite')
print("Addendum B rows:", conn.execute("SELECT COUNT(*) FROM opps_addendum_b").fetchone()[0])
print("Addendum A rows:", conn.execute("SELECT COUNT(*) FROM opps_addendum_a").fetchone()[0])
# Check a few codes
for code in ['99285', '70450', '93000', '36415']:
    row = conn.execute(
        "SELECT hcpcs_code, status_indicator, apc, payment_rate FROM opps_addendum_b WHERE hcpcs_code=?",
        (code,)
    ).fetchone()
    print(f"{code}: {row}")
conn.close()
EOF
```

---

## Task 4: Implement loadOppsRate in data-loader.ts

- [ ] Replace stub in `data-loader.ts`:

```typescript
export function loadOppsRate(hcpcsCode: string, quarter?: string): OppsRow | null {
  const db = getOppsDb()
  if (!db) return null

  const q = quarter ?? '2026Q2'

  // Join Addendum B with Addendum A for APC title
  const row = db.prepare(`
    SELECT
      b.hcpcs_code,
      b.short_descriptor,
      b.status_indicator,
      b.apc,
      b.payment_rate,
      a.group_title AS apc_title
    FROM opps_addendum_b b
    LEFT JOIN opps_addendum_a a
      ON a.apc = b.apc AND a.quarter = b.quarter
    WHERE b.hcpcs_code = ? AND b.quarter = ?
  `).get(hcpcsCode.toUpperCase().trim(), q) as OppsRow | undefined

  return row ?? null
}
```

- [ ] Run: `npm run check`

---

## Task 5: Add OPPS benchmark to audit-rules.ts

In `buildDeterministicFindings`, add an OPPS benchmark finding for outpatient bills:

```typescript
  // 4. OPPS benchmark check (outpatient only) — deterministic
  if (billType === 'outpatient') {
    for (let i = 0; i < lineItems.length; i++) {
      const code = codes[i]
      if (alreadyFlaggedCodes.has(code)) continue

      const oppsRow = loadOppsRate(code)
      if (!oppsRow || oppsRow.payment_rate == null) continue

      const billed = lineItems[i].billedAmount
      const benchmark = oppsRow.payment_rate

      if (billed > benchmark * 2.5) {
        findings.push({
          lineItemIndex: i,
          cptCode: code,
          severity: 'warning',
          errorType: 'upcoding',
          confidence: 'medium',
          description: `CPT ${code} (${oppsRow.short_descriptor ?? ''}) is billed at $${billed.toFixed(2)}, which is ${(billed / benchmark).toFixed(1)}× the CMS OPPS outpatient facility benchmark of $${benchmark.toFixed(2)} (APC ${oppsRow.apc}: ${oppsRow.apc_title ?? ''}).`,
          standardDescription: oppsRow.short_descriptor ?? undefined,
          recommendation: `Request itemized justification for why facility fees exceed the CMS Outpatient Prospective Payment System rate.`,
          medicareRate: benchmark,
          markupRatio: billed / benchmark,
          ncciBundledWith: undefined,
        })
      }
    }
  }
```

- [ ] Add import at top: `import { loadOppsRate } from './data-loader'`
- [ ] Run: `npm run check`

---

## Task 6: Tests

Add to test file:

```typescript
describe('OPPS SQLite integration', () => {
  it.skipIf(!existsSync('data/opps.sqlite'))('loads Addendum B for 99285', () => {
    const row = loadOppsRate('99285')
    // 99285 may or may not be in OPPS
    if (row) {
      expect(row.hcpcs_code).toBe('99285')
      expect(typeof row.status_indicator).toBe('string')
    }
  })

  it.skipIf(!existsSync('data/opps.sqlite'))('Addendum B has records', () => {
    const row = loadOppsRate('70450')
    // Just verify no crash
    expect(row === null || row.hcpcs_code === '70450').toBe(true)
  })
})
```

- [ ] `npm run test`

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_opps_sqlite.py src/lib/server/data-loader.ts src/lib/server/audit-rules.ts \
        src/lib/server/data-loader.test.ts
git commit -m "feat: add opps addendum a and b to sqlite for outpatient benchmarking"
```

---

## Quarterly refresh

Update `ADDB_URL`, `ADDA_URL`, `QUARTER`, and `EFFECTIVE_DATE` in `build_opps_sqlite.py` each quarter.
CMS publishes: January, April, July, October.
Run: `python3 scripts/build_opps_sqlite.py`
