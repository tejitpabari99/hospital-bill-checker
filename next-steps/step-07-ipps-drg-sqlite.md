# Step 07: IPPS/MS-DRG → SQLite (New Data Source)

> **AGENT INSTRUCTIONS:** You are implementing step 07.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–06 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Add CMS IPPS MS-DRG reference data to `data/ipps.sqlite`.
Used only for inpatient bills when the bill explicitly shows a DRG code.
**Never infer or guess a DRG from CPT codes** — only use this when DRG is explicitly on the bill.

**Files to create:**
- `scripts/build_ipps_sqlite.py`
- `data/ipps.sqlite` — generated

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadDrgRate`
- `src/lib/server/audit-rules.ts` — add DRG benchmark for inpatient bills

---

## Task 1: Understand the IPPS/DRG data

**Source:** `https://www.cms.gov/files/zip/fy2026-ipps-fr-table-5.zip`

Inside the ZIP: an Excel `.xlsx` file (Table 5).

The file is titled: "MS-DRGs, Relative Weighting Factors and Geometric and Arithmetic Mean Length of Stay"

**Columns to expect:**
| Column | Use |
|--------|-----|
| MS-DRG | 3-digit DRG code (e.g., `470`) |
| Post-Acute DRG / Type | DRG type (optional) |
| MS-DRG Title / Description | Full title |
| Weights / Relative Weight | Relative weight factor |
| Geometric Mean LOS | Geometric mean length of stay |
| Arithmetic Mean LOS | Arithmetic mean length of stay (optional) |

**Finding the header row:** The Excel may have CMS title rows before the actual column header row.
Scan rows until you find one that contains "MS-DRG" (exact or partial).

**DRG code format:** 3-digit numeric string (e.g., `"470"`, `"001"` — zero-padded to 3 digits).

---

## Task 2: Write the build script

**File:** `scripts/build_ipps_sqlite.py`

- [ ] Create `scripts/build_ipps_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/ipps.sqlite from CMS IPPS FY2026 Table 5 MS-DRG weights.

Source: https://www.cms.gov/files/zip/fy2026-ipps-fr-table-5.zip

Usage:
  python3 scripts/build_ipps_sqlite.py
  python3 scripts/build_ipps_sqlite.py /path/to/fy2026-ipps-fr-table-5.zip
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
    print("ERROR: openpyxl required. Run: pip install openpyxl")
    sys.exit(1)

DB_PATH = Path(__file__).parent.parent / "data" / "ipps.sqlite"

IPPS_URL = "https://www.cms.gov/files/zip/fy2026-ipps-fr-table-5.zip"
FISCAL_YEAR = "2026"
SOURCE_URL = "https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps/fy-2026-ipps-final-rule-home-page"

DRG_PATTERN = re.compile(r"^\d{1,3}$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS ipps_drg_rates (
            fiscal_year         TEXT NOT NULL,
            ms_drg              TEXT NOT NULL,
            title               TEXT,
            relative_weight     NUMERIC,
            geometric_mean_los  NUMERIC,
            arithmetic_mean_los NUMERIC,
            source_file         TEXT,
            source_url          TEXT,
            updated_at          TEXT NOT NULL,
            PRIMARY KEY (fiscal_year, ms_drg)
        );

        CREATE INDEX IF NOT EXISTS idx_ipps_drg_code
            ON ipps_drg_rates(ms_drg);

        CREATE TABLE IF NOT EXISTS ipps_payment_parameters (
            fiscal_year                 TEXT PRIMARY KEY,
            operating_standardized_amount NUMERIC,
            capital_base_rate           NUMERIC,
            source_file                 TEXT,
            source_url                  TEXT,
            updated_at                  TEXT NOT NULL
        );
    """)


def find_col(header_row, *candidates: str) -> int | None:
    """Case-insensitive partial match."""
    for i, cell in enumerate(header_row):
        cell_upper = str(cell).strip().upper() if cell is not None else ""
        for candidate in candidates:
            if candidate.upper() in cell_upper:
                return i
    return None


def parse_table5(xlsx_bytes: bytes, source_file: str) -> list[tuple]:
    """
    Parse Table 5 Excel.
    Find header row containing 'MS-DRG', then parse data.
    Returns list of (fiscal_year, ms_drg, title, rel_weight, gmlos, amlos, source_file, source_url, updated_at)
    """
    from datetime import datetime, timezone

    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)

    # Try each sheet — CMS sometimes puts data on a non-active sheet
    header_row = None
    ws_used = None

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            row_strs = [str(c).strip().upper() if c is not None else "" for c in row]
            # Look for a row containing "MS-DRG" or "DRG"
            if any("MS-DRG" in s or (s == "DRG" and i < 10) for s in row_strs):
                header_row = row
                ws_used = ws
                print(f"  Header found on sheet '{sheet_name}' at row {i}: {[str(c)[:20] for c in row[:8]]}")
                break
        if header_row is not None:
            break

    if header_row is None or ws_used is None:
        print("ERROR: Could not find DRG header row in any sheet")
        return []

    drg_col = find_col(header_row, "MS-DRG", "DRG")
    title_col = find_col(header_row, "TITLE", "DESCRIPTION", "MS-DRG TITLE")
    rw_col = find_col(header_row, "WEIGHT", "RELATIVE WEIGHT", "WEIGHTS")
    gmlos_col = find_col(header_row, "GEOMETRIC", "GMLOS", "GEO MEAN")
    amlos_col = find_col(header_row, "ARITHMETIC", "AMLOS", "ARITH MEAN")

    print(f"  Columns — DRG:{drg_col}, Title:{title_col}, Weight:{rw_col}, GMLOS:{gmlos_col}, AMLOS:{amlos_col}")

    updated_at = datetime.now(timezone.utc).isoformat()
    rows: list[tuple] = []
    data_started = False

    for row in ws_used.iter_rows(values_only=True):
        if not data_started:
            if row == tuple(header_row):
                data_started = True
            continue

        if drg_col is None or drg_col >= len(row) or row[drg_col] is None:
            continue

        drg_raw = str(row[drg_col]).strip()
        if not DRG_PATTERN.match(drg_raw):
            continue

        # Zero-pad to 3 digits
        ms_drg = drg_raw.zfill(3)

        def safe_float(val) -> float | None:
            if val is None:
                return None
            try:
                return float(str(val).replace(",", "").strip())
            except (ValueError, TypeError):
                return None

        title = str(row[title_col]).strip() if title_col is not None and title_col < len(row) and row[title_col] else None
        rel_weight = safe_float(row[rw_col] if rw_col is not None and rw_col < len(row) else None)
        gmlos = safe_float(row[gmlos_col] if gmlos_col is not None and gmlos_col < len(row) else None)
        amlos = safe_float(row[amlos_col] if amlos_col is not None and amlos_col < len(row) else None)

        rows.append((
            FISCAL_YEAR, ms_drg, title, rel_weight, gmlos, amlos,
            source_file, SOURCE_URL, updated_at
        ))

    wb.close()
    return rows


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    if len(sys.argv) > 1:
        zip_bytes = Path(sys.argv[1]).read_bytes()
        print(f"Using local file: {sys.argv[1]}")
    else:
        print(f"Downloading {IPPS_URL} ...")
        zip_bytes = download_bytes(IPPS_URL)
        print(f"  Downloaded {len(zip_bytes):,} bytes")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        print(f"ZIP contents: {archive.namelist()}")
        xlsx_files = [n for n in archive.namelist() if n.lower().endswith(".xlsx")
                      and not n.startswith("__")]
        if not xlsx_files:
            print("ERROR: No .xlsx in ZIP")
            sys.exit(1)

        fname = xlsx_files[0]
        print(f"Parsing {fname} ...")
        rows = parse_table5(archive.read(fname), fname)
        print(f"Parsed {len(rows):,} DRG rows")

    # Insert
    inserted = 0
    for row in rows:
        try:
            conn.execute("""INSERT OR REPLACE INTO ipps_drg_rates
                (fiscal_year, ms_drg, title, relative_weight, geometric_mean_los,
                 arithmetic_mean_los, source_file, source_url, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)""", row)
            inserted += 1
        except sqlite3.Error as e:
            print(f"  Insert error: {e}")

    conn.commit()
    print(f"\nInserted {inserted:,} MS-DRG rows")

    # Verify
    for drg in ["470", "291", "001", "470"]:
        row = conn.execute(
            "SELECT ms_drg, title, relative_weight, geometric_mean_los FROM ipps_drg_rates WHERE ms_drg=? AND fiscal_year=?",
            (drg, FISCAL_YEAR)
        ).fetchone()
        print(f"DRG {drg}: {row}")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")
    print("\nNote: ipps_payment_parameters table created but not populated (use for full payment calc in future).")


if __name__ == "__main__":
    main()
```

---

## Task 3: Build the database

- [ ] Run:

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_ipps_sqlite.py
```

- [ ] Expected: ~760+ DRG rows (MS-DRGs 001–999, not all used)

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/ipps.sqlite')
print("Total DRGs:", conn.execute("SELECT COUNT(*) FROM ipps_drg_rates").fetchone()[0])
for drg in ['470', '291', '194']:
    row = conn.execute(
        "SELECT ms_drg, title, relative_weight, geometric_mean_los FROM ipps_drg_rates WHERE ms_drg=?", (drg,)
    ).fetchone()
    print(f"DRG {drg}: {row}")
conn.close()
EOF
```

---

## Task 4: Implement loadDrgRate in data-loader.ts

- [ ] Replace stub in `data-loader.ts`:

```typescript
export function loadDrgRate(drgCode: string, fiscalYear?: string): IppsRow | null {
  const db = getIppsDb()
  if (!db) return null

  // Zero-pad to 3 digits
  const ms_drg = drgCode.trim().replace(/[^0-9]/g, '').padStart(3, '0')
  const year = fiscalYear ?? '2026'

  const row = db.prepare(`
    SELECT ms_drg, title, relative_weight, geometric_mean_los, arithmetic_mean_los
    FROM ipps_drg_rates
    WHERE ms_drg = ? AND fiscal_year = ?
  `).get(ms_drg, year) as IppsRow | undefined

  return row ?? null
}
```

- [ ] Run: `npm run check`

---

## Task 5: Add DRG benchmark to audit-rules.ts

In `buildDeterministicFindings`, add a DRG reference finding when `billType === 'inpatient'` and `drgCode` is provided
via the `BillInput`. Note: this function currently receives `lineItems` — we need to also pass `drgCode`.

- [ ] Update the function signature to accept an optional `drgCode` parameter:

```typescript
export function buildDeterministicFindings(
  lineItems: LineItem[],
  // ... existing params ...
  billType: BillType = 'unknown',
  serviceDateStr?: string,
  drgCode?: string   // <-- ADD
): { findings: AuditFinding[]; promptNote: string } {
```

- [ ] Add DRG finding after the existing checks:

```typescript
  // 5. IPPS/DRG inpatient reference — informational
  if (billType === 'inpatient' && drgCode) {
    const drg = loadDrgRate(drgCode)
    if (drg) {
      findings.push({
        lineItemIndex: -1,
        cptCode: `DRG-${drg.ms_drg}`,
        severity: 'info',
        errorType: 'other',
        confidence: 'high',
        description: `This inpatient bill shows MS-DRG ${drg.ms_drg}: "${drg.title}". CMS relative weight: ${drg.relative_weight ?? 'N/A'}. Expected length of stay: ${drg.geometric_mean_los ?? 'N/A'} days (geometric mean).`,
        standardDescription: drg.title ?? undefined,
        recommendation: `Compare your actual length of stay to the CMS expected LOS of ${drg.geometric_mean_los ?? 'N/A'} days for DRG ${drg.ms_drg}. Contact your hospital billing department if the DRG assignment appears incorrect.`,
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
    }
  }
```

- [ ] Add import: `import { loadDrgRate } from './data-loader'`
- [ ] Run: `npm run check`

---

## Task 6: Tests

```typescript
describe('IPPS SQLite integration', () => {
  it.skipIf(!existsSync('data/ipps.sqlite'))('loads DRG 470 (major joint replacement)', () => {
    const row = loadDrgRate('470')
    expect(row).not.toBeNull()
    expect(row!.ms_drg).toBe('470')
    expect(row!.relative_weight).toBeGreaterThan(0)
    expect(row!.geometric_mean_los).toBeGreaterThan(0)
  })

  it.skipIf(!existsSync('data/ipps.sqlite'))('pads DRG code to 3 digits', () => {
    const row = loadDrgRate('1')  // DRG 001
    // May or may not exist, just verify no crash
    if (row) expect(row.ms_drg).toBe('001')
  })

  it.skipIf(!existsSync('data/ipps.sqlite'))('returns null for invalid DRG', () => {
    expect(loadDrgRate('999')).toBeNull()  // 999 is likely not assigned
  })
})
```

- [ ] `npm run test && npm run check && npm run build`

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_ipps_sqlite.py src/lib/server/data-loader.ts \
        src/lib/server/audit-rules.ts src/lib/server/data-loader.test.ts
git commit -m "feat: add ipps ms-drg sqlite — reference lookup for inpatient bills"
```

---

## Annual refresh

Update `IPPS_URL` and `FISCAL_YEAR` in `build_ipps_sqlite.py` each October (new fiscal year starts Oct 1).
URL pattern: `https://www.cms.gov/files/zip/fy{YEAR}-ipps-fr-table-5.zip`
Run: `python3 scripts/build_ipps_sqlite.py`
