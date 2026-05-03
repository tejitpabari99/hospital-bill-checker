# Step 08: DMEPOS Fee Schedule → SQLite (New Data Source)

> **AGENT INSTRUCTIONS:** You are implementing step 08.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–07 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Add CMS DMEPOS fee schedule to `data/dmepos.sqlite` for DME supplier bill pricing.
Stage 1: non-rural state rates only.
Stage 2 (rural ZIP logic, CBA competitive bidding) is future work — see step-20.

**Files to create:**
- `scripts/build_dmepos_sqlite.py`
- `data/dmepos.sqlite` — generated

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadDmeposRate`
- `src/lib/server/audit-rules.ts` — add DMEPOS benchmark for DME bills

---

## Task 1: Understand the DMEPOS data format

**Source:** `https://www.cms.gov/files/zip/dme26-b.zip`
Inner file: `DMEPOS_APR.xlsx` (or `.csv` or `.txt` — try xlsx first)

The Excel file structure:
- Row 1: Column headers (no pre-header rows in the main data sheet)

**Columns to find:**
| Column | Use |
|--------|-----|
| HCPCS | HCPCS code |
| Mod | Modifier 1 |
| Mod2 | Modifier 2 |
| JURIS | Jurisdiction |
| CATG | Category |
| Ceiling | Max fee ceiling |
| Floor | Min fee floor |
| Description | Item description |
| `<STATE> (NR)` | One column per state, non-rural rate — e.g., `AL (NR)`, `CA (NR)`, `TX (NR)` |

**Skip:** All columns ending in `(R)` — these are rural rates (stage 2).
**Skip:** Former CBA / competitive bidding columns (stage 2).

State code extraction: strip ` (NR)` suffix from column headers → 2-letter state code.
US state codes to accept: AL, AK, AZ, AR, CA, CO, CT, DE, FL, GA, HI, ID, IL, IN, IA, KS, KY, LA, ME, MD,
MA, MI, MN, MS, MO, MT, NE, NV, NH, NJ, NM, NY, NC, ND, OH, OK, OR, PA, RI, SC, SD, TN, TX, UT, VT, VA,
WA, WV, WI, WY, DC, PR, VI, GU

---

## Task 2: Write the build script

**File:** `scripts/build_dmepos_sqlite.py`

- [ ] Create `scripts/build_dmepos_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/dmepos.sqlite from CMS DMEPOS fee schedule.

Source (Q2 2026 / April): https://www.cms.gov/files/zip/dme26-b.zip
Inner file: DMEPOS_APR.xlsx

Two tables:
  dmepos_base       — one row per HCPCS/mod/mod2 combination
  dmepos_state_rates — non-rural state rates (one row per state per base row)

Stage 1: non-rural state rates only.

Usage:
  python3 scripts/build_dmepos_sqlite.py
  python3 scripts/build_dmepos_sqlite.py /path/to/dme26-b.zip
"""

from __future__ import annotations

import io
import os
import re
import sqlite3
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("ERROR: openpyxl required. Run: pip install openpyxl")
    sys.exit(1)

DB_PATH = Path(__file__).parent.parent / "data" / "dmepos.sqlite"

DMEPOS_URL = "https://www.cms.gov/files/zip/dme26-b.zip"
QUARTER = "2026Q2"
EFFECTIVE_DATE = "2026-04-01"
SOURCE_URL = "https://www.cms.gov/medicare/payment/fee-schedules/dmepos/dmepos-fee-schedule"

CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")

# All valid US state/territory codes
VALID_STATES = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
    "VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP",
}


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS dmepos_base (
            dmepos_id       INTEGER PRIMARY KEY AUTOINCREMENT,
            quarter         TEXT NOT NULL,
            effective_date  TEXT NOT NULL,
            hcpcs_code      TEXT NOT NULL,
            mod             TEXT,
            mod2            TEXT,
            jurisdiction    TEXT,
            category        TEXT,
            ceiling         NUMERIC,
            floor           NUMERIC,
            description     TEXT,
            source_file     TEXT,
            source_url      TEXT,
            updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_dmepos_base_code
            ON dmepos_base(hcpcs_code);

        CREATE INDEX IF NOT EXISTS idx_dmepos_base_code_mods
            ON dmepos_base(hcpcs_code, mod, mod2);

        CREATE TABLE IF NOT EXISTS dmepos_state_rates (
            dmepos_id       INTEGER NOT NULL,
            state_code      TEXT NOT NULL,
            fee_amount      NUMERIC,
            PRIMARY KEY (dmepos_id, state_code),
            FOREIGN KEY (dmepos_id) REFERENCES dmepos_base(dmepos_id)
        );

        CREATE INDEX IF NOT EXISTS idx_dmepos_state_lookup
            ON dmepos_state_rates(dmepos_id, state_code);

        CREATE INDEX IF NOT EXISTS idx_dmepos_state_code
            ON dmepos_state_rates(state_code);
    """)


def safe_float(val) -> float | None:
    if val is None:
        return None
    s = str(val).replace(",", "").replace("$", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def find_col(header: list[str], *candidates: str) -> int | None:
    normalized = [str(h).strip().upper() if h is not None else "" for h in header]
    for candidate in candidates:
        cand_upper = candidate.upper()
        for i, h in enumerate(normalized):
            if h == cand_upper:
                return i
    return None


def parse_state_columns(header: list[str]) -> dict[str, int]:
    """Return {state_code: col_index} for all STATE (NR) columns."""
    state_cols: dict[str, int] = {}
    for i, h in enumerate(header):
        h_str = str(h).strip().upper() if h is not None else ""
        # Match pattern: "XX (NR)" where XX is a 2-letter state code
        match = re.match(r"^([A-Z]{2})\s*\(NR\)$", h_str)
        if match:
            state = match.group(1)
            if state in VALID_STATES:
                state_cols[state] = i
    return state_cols


def parse_dmepos_xlsx(xlsx_bytes: bytes, source_file: str) -> tuple[list[tuple], dict[int, dict[str, float | None]]]:
    """
    Parse DMEPOS_APR.xlsx.
    Returns:
      base_rows: list of (quarter, eff_date, hcpcs, mod, mod2, juris, catg, ceil, floor, desc, source, url, updated_at)
      state_rates: {row_index: {state_code: fee_amount}}
    """
    updated_at = datetime.now(timezone.utc).isoformat()
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    # Find header row
    header_row = None
    header_row_idx = None
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        row_strs = [str(c).strip().upper() if c is not None else "" for c in row]
        if "HCPCS" in row_strs:
            header_row = list(row)
            header_row_idx = i
            break

    if header_row is None:
        raise RuntimeError("Could not find DMEPOS header row")

    print(f"  Header at row {header_row_idx}: {[str(c)[:15] for c in header_row[:12]]}")

    hcpcs_col = find_col(header_row, "HCPCS")
    mod_col = find_col(header_row, "MOD", "MODIFIER")
    mod2_col = find_col(header_row, "MOD2", "MODIFIER2", "MOD 2")
    juris_col = find_col(header_row, "JURIS", "JURISDICTION")
    catg_col = find_col(header_row, "CATG", "CATEGORY")
    ceil_col = find_col(header_row, "CEILING")
    floor_col = find_col(header_row, "FLOOR")
    desc_col = find_col(header_row, "DESCRIPTION", "DESC")

    state_cols = parse_state_columns(header_row)
    print(f"  Found {len(state_cols)} state (NR) columns: {sorted(state_cols.keys())[:5]}...")

    base_rows: list[tuple] = []
    state_data: dict[int, dict[str, float | None]] = {}
    row_idx = 0
    data_started = False

    for row in ws.iter_rows(values_only=True):
        if not data_started:
            if tuple(row) == tuple(header_row):
                data_started = True
            continue

        if hcpcs_col is None or hcpcs_col >= len(row) or row[hcpcs_col] is None:
            continue

        code = str(row[hcpcs_col]).strip().upper()
        if not CODE_PATTERN.match(code):
            continue

        def get_str(col) -> str | None:
            if col is None or col >= len(row) or row[col] is None:
                return None
            s = str(row[col]).strip()
            return s if s else None

        mod = get_str(mod_col)
        mod2 = get_str(mod2_col)
        juris = get_str(juris_col)
        catg = get_str(catg_col)
        ceiling = safe_float(row[ceil_col] if ceil_col is not None and ceil_col < len(row) else None)
        floor_val = safe_float(row[floor_col] if floor_col is not None and floor_col < len(row) else None)
        desc = get_str(desc_col)

        base_rows.append((
            QUARTER, EFFECTIVE_DATE, code, mod, mod2, juris, catg,
            ceiling, floor_val, desc, source_file, SOURCE_URL, updated_at
        ))

        # State rates for this row
        row_states: dict[str, float | None] = {}
        for state, col in state_cols.items():
            if col < len(row):
                fee = safe_float(row[col])
                if fee is not None:
                    row_states[state] = fee

        state_data[row_idx] = row_states
        row_idx += 1

    wb.close()
    return base_rows, state_data


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    if len(sys.argv) > 1:
        zip_bytes = Path(sys.argv[1]).read_bytes()
        print(f"Using local file: {sys.argv[1]}")
    else:
        print(f"Downloading {DMEPOS_URL} ...")
        zip_bytes = download_bytes(DMEPOS_URL)
        print(f"  Downloaded {len(zip_bytes):,} bytes")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        print(f"ZIP contents: {archive.namelist()}")
        # Prefer XLSX
        xlsx_files = [n for n in archive.namelist() if n.lower().endswith(".xlsx") and "DMEPOS" in n.upper()]
        if not xlsx_files:
            xlsx_files = [n for n in archive.namelist() if n.lower().endswith(".xlsx")]
        if not xlsx_files:
            print("ERROR: No XLSX in ZIP")
            sys.exit(1)

        fname = xlsx_files[0]
        print(f"Parsing {fname} ...")
        base_rows, state_data = parse_dmepos_xlsx(archive.read(fname), fname)
        print(f"Parsed {len(base_rows):,} DMEPOS base rows")

    # Insert base rows
    inserted_base = 0
    dmepos_ids: list[int] = []
    for row in base_rows:
        try:
            cursor = conn.execute("""INSERT INTO dmepos_base
                (quarter, effective_date, hcpcs_code, mod, mod2, jurisdiction, category,
                 ceiling, floor, description, source_file, source_url, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", row)
            dmepos_ids.append(cursor.lastrowid)
            inserted_base += 1
        except sqlite3.Error as e:
            dmepos_ids.append(-1)
            print(f"  Base insert error: {e}")

    conn.commit()
    print(f"Inserted {inserted_base:,} base rows")

    # Insert state rates
    inserted_states = 0
    for row_idx, (dmepos_id, states) in enumerate(zip(dmepos_ids, [state_data.get(i, {}) for i in range(len(dmepos_ids))])):
        if dmepos_id < 0:
            continue
        for state, fee in states.items():
            if fee is None:
                continue
            try:
                conn.execute("""INSERT OR REPLACE INTO dmepos_state_rates
                    (dmepos_id, state_code, fee_amount) VALUES (?,?,?)""",
                    (dmepos_id, state, fee))
                inserted_states += 1
            except sqlite3.Error:
                pass

    conn.commit()
    print(f"Inserted {inserted_states:,} state rate rows")

    # Summary
    base_count = conn.execute("SELECT COUNT(*) FROM dmepos_base").fetchone()[0]
    state_count = conn.execute("SELECT COUNT(*) FROM dmepos_state_rates").fetchone()[0]
    print(f"\ndmepos_base: {base_count:,}")
    print(f"dmepos_state_rates: {state_count:,}")

    # Spot check
    row = conn.execute("""
        SELECT b.hcpcs_code, b.description, r.state_code, r.fee_amount
        FROM dmepos_base b
        JOIN dmepos_state_rates r ON r.dmepos_id = b.dmepos_id
        WHERE b.hcpcs_code = 'E0601' AND r.state_code = 'TX'
        LIMIT 1
    """).fetchone()
    print(f"\nE0601 (CPAP) in TX: {row}")

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
python3 scripts/build_dmepos_sqlite.py
```

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/dmepos.sqlite')
print("Base rows:", conn.execute("SELECT COUNT(*) FROM dmepos_base").fetchone()[0])
print("State rates:", conn.execute("SELECT COUNT(*) FROM dmepos_state_rates").fetchone()[0])
# Check states present
states = conn.execute("SELECT DISTINCT state_code FROM dmepos_state_rates ORDER BY state_code").fetchall()
print(f"States: {[r[0] for r in states]}")
conn.close()
EOF
```

---

## Task 4: Implement loadDmeposRate in data-loader.ts

- [ ] Replace stub in `data-loader.ts`:

```typescript
export function loadDmeposRate(hcpcsCode: string, stateCode: string): DmeposRow | null {
  const db = getDmeposDb()
  if (!db) return null

  const state = stateCode.toUpperCase().trim()

  // Prefer rows with blank mod/mod2 (base rates)
  const row = db.prepare(`
    SELECT
      b.hcpcs_code,
      b.description,
      b.mod,
      b.mod2,
      b.category,
      b.ceiling,
      b.floor,
      r.state_code,
      r.fee_amount
    FROM dmepos_base b
    JOIN dmepos_state_rates r ON r.dmepos_id = b.dmepos_id
    WHERE b.hcpcs_code = ?
      AND r.state_code = ?
    ORDER BY
      CASE WHEN COALESCE(b.mod, '') = '' THEN 0 ELSE 1 END,
      CASE WHEN COALESCE(b.mod2, '') = '' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(hcpcsCode.toUpperCase().trim(), state) as DmeposRow | undefined

  return row ?? null
}
```

- [ ] Run: `npm run check`

---

## Task 5: Add DMEPOS benchmark to audit-rules.ts

In `buildDeterministicFindings`, add DMEPOS pricing for DME bills.
The function needs `patientState` — add it to the parameter list:

```typescript
export function buildDeterministicFindings(
  lineItems: LineItem[],
  // ...
  billType: BillType = 'unknown',
  serviceDateStr?: string,
  drgCode?: string,
  patientState?: string   // <-- ADD
): { findings: AuditFinding[]; promptNote: string } {
```

Add the check:

```typescript
  // 6. DMEPOS benchmark (DME supplier bills) — deterministic
  if (billType === 'dme' && patientState) {
    for (let i = 0; i < lineItems.length; i++) {
      const code = codes[i]
      if (alreadyFlaggedCodes.has(code)) continue

      const dmeRow = loadDmeposRate(code, patientState)
      if (!dmeRow || dmeRow.fee_amount == null) continue

      const billed = lineItems[i].billedAmount
      const benchmark = dmeRow.fee_amount

      if (billed > benchmark * 2.0) {
        findings.push({
          lineItemIndex: i,
          cptCode: code,
          severity: 'warning',
          errorType: 'upcoding',
          confidence: 'medium',
          description: `${code} (${dmeRow.description ?? 'DME item'}) is billed at $${billed.toFixed(2)}, which is ${(billed / benchmark).toFixed(1)}× the CMS DMEPOS fee schedule rate of $${benchmark.toFixed(2)} for ${dmeRow.state_code}.`,
          standardDescription: dmeRow.description ?? undefined,
          recommendation: `Request itemized documentation. CMS DMEPOS fee schedule rate for this code is $${benchmark.toFixed(2)} in ${dmeRow.state_code}.`,
          medicareRate: benchmark,
          markupRatio: billed / benchmark,
          ncciBundledWith: undefined,
        })
      }
    }
  }
```

- [ ] Add import: `import { loadDmeposRate } from './data-loader'`
- [ ] Run: `npm run check`

---

## Task 6: Tests

```typescript
describe('DMEPOS SQLite integration', () => {
  it.skipIf(!existsSync('data/dmepos.sqlite'))('returns rate for E0601 in TX', () => {
    const row = loadDmeposRate('E0601', 'TX')
    if (row) {
      expect(row.fee_amount).toBeGreaterThan(0)
    }
  })

  it.skipIf(!existsSync('data/dmepos.sqlite'))('returns null for unknown code', () => {
    expect(loadDmeposRate('ZZZZZ', 'CA')).toBeNull()
  })
})
```

- [ ] `npm run test && npm run check && npm run build`

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_dmepos_sqlite.py src/lib/server/data-loader.ts \
        src/lib/server/audit-rules.ts src/lib/server/data-loader.test.ts
git commit -m "feat: add dmepos fee schedule sqlite — non-rural state rates stage 1"
```

---

## Quarterly refresh

Update `DMEPOS_URL`, `QUARTER`, and `EFFECTIVE_DATE` in `build_dmepos_sqlite.py` each quarter.
URL pattern: `https://www.cms.gov/files/zip/dme{YY}{QUARTER_LETTER}.zip`
(e.g., `dme26-a.zip` for Jan 2026, `dme26-b.zip` for Apr 2026, `dme26-c.zip` for Jul, `dme26-d.zip` for Oct)
