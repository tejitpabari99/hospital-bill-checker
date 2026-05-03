# Step 03: MPFS → SQLite (Stage 1)

> **AGENT INSTRUCTIONS:** You are implementing step 03.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–02 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Replace `src/lib/data/mpfs.json` with `data/mpfs.sqlite` for deterministic MPFS rate lookup.
Stage 1 only (national non-facility rate). Stage 2 (GPCI location-specific pricing) is documented in
`step-20-future-steps.md` — do NOT implement it now.

**Files to create:**
- `scripts/build_mpfs_sqlite.py` — new build script
- `data/mpfs.sqlite` — generated

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadMpfsRate`
- `src/lib/server/audit-rules.ts` — update rate lookup

**Files to delete:**
- `src/lib/data/mpfs.json`

---

## Task 1: Understand the MPFS raw data

**Source:** `https://www.cms.gov/files/zip/rvu26a.zip`

Inside the ZIP, the relevant file is: `PPRRVU2026_Jan_nonQPP.xlsx`

The Excel file has:
- Multiple rows before the actual data header — skip everything until you find a row where the first cell equals `HCPCS`
- After the header row, data rows follow

Column map (0-indexed, matching the header row):
| Index | Column name | Use |
|-------|-------------|-----|
| 0 | HCPCS | CPT/HCPCS code |
| 1 | MOD | Modifier — SKIP rows where this is non-blank (modifier-specific rows) |
| 2 | DESCRIPTION | Short description |
| 3 | STATUS CODE | Status — only keep A, R, T |
| 11 | NON-FAC TOTAL | Non-facility total RVU |
| 12 | FAC TOTAL | Facility total RVU (optional) |

**Payment calculation:**
```
nonfac_rate = NON_FAC_TOTAL * CONVERSION_FACTOR
fac_rate = FAC_TOTAL * CONVERSION_FACTOR
```

2026 conversion factor: **33.29** (non-QPP)

Active status codes to include: `A`, `R`, `T`

---

## Task 2: Write the build script

**File:** `scripts/build_mpfs_sqlite.py`

- [ ] Create `scripts/build_mpfs_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/mpfs.sqlite from CMS MPFS Relative Value Files.

Source: https://www.cms.gov/files/zip/rvu26a.zip
Inner file: PPRRVU2026_Jan_nonQPP.xlsx

Stage 1: national non-facility rate only.
Stage 2 (GPCI/location-specific) is documented as future work.

Usage:
  python3 scripts/build_mpfs_sqlite.py
  python3 scripts/build_mpfs_sqlite.py /path/to/rvu26a.zip
"""

from __future__ import annotations

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
    print("ERROR: openpyxl is required. Run: pip install openpyxl")
    sys.exit(1)

DB_PATH = Path(__file__).parent.parent / "data" / "mpfs.sqlite"

MPFS_URLS = [
    "https://www.cms.gov/files/zip/rvu26a.zip",
    "https://www.cms.gov/files/zip/rvu25a.zip",  # fallback
]

CONVERSION_FACTOR = 33.29  # 2026 non-QPP
FISCAL_YEAR = "2026"
SOURCE_FILE = "PPRRVU2026_Jan_nonQPP.xlsx"

ACTIVE_STATUSES = {"A", "R", "T"}
CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(f"""
        CREATE TABLE IF NOT EXISTS mpfs_rates (
            hcpcs_code          TEXT NOT NULL,
            modifier            TEXT,
            description         TEXT,
            status_code         TEXT,
            nonfac_total_rvu    NUMERIC,
            fac_total_rvu       NUMERIC,
            nonfac_rate         NUMERIC,
            fac_rate            NUMERIC,
            conversion_factor   NUMERIC NOT NULL DEFAULT {CONVERSION_FACTOR},
            fiscal_year         TEXT NOT NULL DEFAULT '{FISCAL_YEAR}',
            source_file         TEXT,
            PRIMARY KEY (hcpcs_code, fiscal_year)
        );

        CREATE INDEX IF NOT EXISTS idx_mpfs_code
            ON mpfs_rates(hcpcs_code);

        CREATE INDEX IF NOT EXISTS idx_mpfs_status
            ON mpfs_rates(status_code);
    """)


def parse_xlsx(xlsx_bytes: bytes, source_file: str) -> list[tuple]:
    """
    Parse PPRRVU XLSX.
    Skip rows before the header row (header row has 'HCPCS' in first cell).
    Skip modifier-specific rows (MOD column non-blank).
    Returns list of (hcpcs, modifier, description, status, nonfac_rvu, fac_rvu, nonfac_rate, fac_rate, cf, year, source)
    """
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    HCPCS_COL = 0
    MOD_COL = 1
    DESC_COL = 2
    STATUS_COL = 3
    NONFAC_TOTAL_COL = 11
    FAC_TOTAL_COL = 12

    header_found = False
    rows: list[tuple] = []

    for row in ws.iter_rows(values_only=True):
        if not header_found:
            # Look for the row where first cell is 'HCPCS'
            val = str(row[HCPCS_COL]).strip().upper() if row[HCPCS_COL] is not None else ""
            if val == "HCPCS":
                header_found = True
            continue

        hcpcs = str(row[HCPCS_COL]).strip().upper() if row[HCPCS_COL] is not None else ""
        if not CODE_PATTERN.match(hcpcs):
            continue

        modifier = row[MOD_COL]
        if modifier is not None and str(modifier).strip():
            continue  # skip modifier-specific rows

        description = str(row[DESC_COL]).strip() if row[DESC_COL] is not None else None
        status = str(row[STATUS_COL]).strip().upper() if row[STATUS_COL] is not None else ""

        if status not in ACTIVE_STATUSES:
            continue

        def safe_float(val) -> float | None:
            if val is None:
                return None
            try:
                return float(val)
            except (ValueError, TypeError):
                return None

        nonfac_rvu = safe_float(row[NONFAC_TOTAL_COL] if NONFAC_TOTAL_COL < len(row) else None)
        fac_rvu = safe_float(row[FAC_TOTAL_COL] if FAC_TOTAL_COL < len(row) else None)

        nonfac_rate = round(nonfac_rvu * CONVERSION_FACTOR, 2) if nonfac_rvu is not None else None
        fac_rate = round(fac_rvu * CONVERSION_FACTOR, 2) if fac_rvu is not None else None

        rows.append((
            hcpcs, None, description, status,
            nonfac_rvu, fac_rvu,
            nonfac_rate, fac_rate,
            CONVERSION_FACTOR, FISCAL_YEAR, source_file
        ))

    wb.close()
    return rows


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    # Determine source
    if len(sys.argv) > 1:
        local_path = Path(sys.argv[1])
        print(f"Using local file: {local_path}")
        zip_bytes = local_path.read_bytes()
    else:
        zip_bytes = None
        for url in MPFS_URLS:
            print(f"Downloading {url} ...")
            try:
                zip_bytes = download_bytes(url)
                print(f"  Downloaded {len(zip_bytes):,} bytes")
                break
            except Exception as exc:
                print(f"  Failed: {exc}")

        if zip_bytes is None:
            print("ERROR: All downloads failed.")
            sys.exit(1)

    # Extract and parse the XLSX
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        print(f"ZIP contents: {archive.namelist()}")
        # Find the PPRRVU xlsx file (name may vary slightly)
        xlsx_names = [
            n for n in archive.namelist()
            if n.upper().startswith("PPRRVU") and n.lower().endswith(".xlsx")
            and "nonqpp" in n.lower()
        ]
        if not xlsx_names:
            # Fallback: any xlsx
            xlsx_names = [n for n in archive.namelist() if n.lower().endswith(".xlsx")]

        if not xlsx_names:
            print("ERROR: No XLSX file found in ZIP")
            sys.exit(1)

        xlsx_name = xlsx_names[0]
        print(f"Parsing {xlsx_name} ...")
        rows = parse_xlsx(archive.read(xlsx_name), xlsx_name)
        print(f"Parsed {len(rows):,} rows")

    # Insert
    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO mpfs_rates
                   (hcpcs_code, modifier, description, status_code,
                    nonfac_total_rvu, fac_total_rvu, nonfac_rate, fac_rate,
                    conversion_factor, fiscal_year, source_file)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                row,
            )
            inserted += 1
        except sqlite3.Error as e:
            print(f"  Insert error: {e}")

    conn.commit()

    # Summary
    print(f"\nInserted {inserted:,} rows")
    row = conn.execute("SELECT nonfac_rate, description FROM mpfs_rates WHERE hcpcs_code='99285'").fetchone()
    print(f"99285 (ER hi): ${row[0]} — {row[1]}" if row else "99285: NOT FOUND")
    row = conn.execute("SELECT nonfac_rate, description FROM mpfs_rates WHERE hcpcs_code='70450'").fetchone()
    print(f"70450 (CT head): ${row[0]} — {row[1]}" if row else "70450: NOT FOUND")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")
    print("\nFuture stage 2 note: rvu26b.zip contains GPCI2026.xlsx and 26LOCCO.xlsx for location-specific pricing.")
    print("See step-20-future-steps.md for implementation details.")


if __name__ == "__main__":
    main()
```

---

## Task 3: Build the database

- [ ] Run:

```bash
cd /root/projects/hospital-bill-checker
pip install openpyxl  # if not installed
python3 scripts/build_mpfs_sqlite.py
```

- [ ] Expected output (approximate):
  ```
  Parsed 7,000+ rows
  99285 (ER hi): $170.78 — Emergency dept visit hi mdm
  70450 (CT head): $106.20 — Ct head/brain w/o dye
  Wrote data/mpfs.sqlite
  ```

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/mpfs.sqlite')
print("Total rows:", conn.execute("SELECT COUNT(*) FROM mpfs_rates").fetchone()[0])
for code in ['99285', '70450', '70486', '99213', '85025']:
    row = conn.execute(
        "SELECT hcpcs_code, nonfac_rate, description FROM mpfs_rates WHERE hcpcs_code=?", (code,)
    ).fetchone()
    if row:
        print(f"{row[0]}: ${row[1]} — {row[2]}")
    else:
        print(f"{code}: NOT FOUND (may be in CLFS)")
conn.close()
EOF
```

Note: Lab codes (85025, 80053, 36415) may not appear in MPFS — they are in CLFS (step 04).

---

## Task 4: Implement loadMpfsRate in data-loader.ts

- [ ] Open `src/lib/server/data-loader.ts`, replace the stub `loadMpfsRate` with:

```typescript
export function loadMpfsRate(hcpcsCode: string): MpfsRow | null {
  const db = getMpfsDb()
  if (!db) return null

  const row = db.prepare(`
    SELECT hcpcs_code, description, status_code, nonfac_rate, fac_rate
    FROM mpfs_rates
    WHERE hcpcs_code = ?
    ORDER BY fiscal_year DESC
    LIMIT 1
  `).get(hcpcsCode.toUpperCase().trim()) as MpfsRow | undefined

  return row ?? null
}
```

- [ ] Run: `npm run check`

---

## Task 5: Update audit-rules.ts MPFS usage

In `buildDeterministicFindings`, the rate lookup currently calls `getMpfsRate(mpfs[code])`.
Update to use the data-loader:

- [ ] Find the rate lookup in the upcoding / rate comparison section and update:

```typescript
  // Rate lookup — MPFS first, CLFS fallback (step 04 adds CLFS)
  function getEffectiveRate(code: string): { rate: number; source: string } | null {
    const mpfsRow = loadMpfsRate(code)
    if (mpfsRow?.nonfac_rate != null) {
      return { rate: mpfsRow.nonfac_rate, source: 'MPFS' }
    }
    const clfsRow = loadClfsRate(code)
    if (clfsRow?.rate != null) {
      return { rate: clfsRow.rate, source: 'CLFS' }
    }
    return null
  }
```

Also update `buildDataContext` in `audit-rules.ts` to use `loadMpfsRate` / `loadClfsRate` instead of the
`mpfs` / `clfs` parameters (remove those parameters from the signature).

- [ ] Run: `npm run check`

---

## Task 6: Write tests

Add to `src/lib/server/audit-rules.test.ts` (or `src/lib/server/data-loader.test.ts`):

```typescript
describe('MPFS SQLite integration', () => {
  it.skipIf(!existsSync('data/mpfs.sqlite'))('returns rate for 99285', () => {
    const row = loadMpfsRate('99285')
    expect(row).not.toBeNull()
    expect(row!.nonfac_rate).toBeGreaterThan(100)
    expect(row!.nonfac_rate).toBeLessThan(500)
  })

  it.skipIf(!existsSync('data/mpfs.sqlite'))('returns rate for 70450', () => {
    const row = loadMpfsRate('70450')
    expect(row).not.toBeNull()
    expect(row!.nonfac_rate).toBeGreaterThan(80)
  })

  it.skipIf(!existsSync('data/mpfs.sqlite'))('returns null for unknown code', () => {
    expect(loadMpfsRate('ZZZZZ')).toBeNull()
  })
})
```

Add import: `import { existsSync } from 'fs'`
Add import: `import { loadMpfsRate } from './data-loader'`

- [ ] Run: `npm run test`

---

## Task 7: Remove old mpfs.json

- [ ] `rm src/lib/data/mpfs.json`
- [ ] `npm run check && npm run build`

---

## Task 8: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_mpfs_sqlite.py src/lib/server/data-loader.ts src/lib/server/audit-rules.ts \
        src/lib/server/audit-rules.test.ts
git rm --cached src/lib/data/mpfs.json 2>/dev/null || true
git commit -m "feat: migrate mpfs to sqlite stage 1 (national non-facility rate)"
```

---

## Annual refresh

Update `MPFS_URLS` in `build_mpfs_sqlite.py` each January (e.g., `rvu27a.zip` for 2027).
Update `CONVERSION_FACTOR` and `FISCAL_YEAR` constants.
Run: `python3 scripts/build_mpfs_sqlite.py`
