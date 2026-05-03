# Step 05: ASP → SQLite

> **AGENT INSTRUCTIONS:** You are implementing step 05.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–04 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Replace `src/lib/data/asp.json` with `data/asp.sqlite`.
ASP is the CMS Average Sales Price — drug payment limits for Part B injectables (J-codes).
Also create the NDC-HCPCS crosswalk table schema (empty for now — stage 2, not populated yet).

**Files to create:**
- `scripts/build_asp_sqlite.py`
- `data/asp.sqlite` — generated

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadAspLimit`

**Files to delete:**
- `src/lib/data/asp.json`

---

## Task 1: Understand the ASP raw data format

**Source:** `https://www.cms.gov/files/zip/april-2026-medicare-part-b-payment-limit-files-03-30-2026-final-file.zip`

Inside the ZIP: a CSV file.

The CSV structure:
- **Rows 1–8**: Header block (CMS title, disclaimer, date, etc.) — SKIP all of these
- **Row 9 (index 8)**: Column headers — `HCPCS Code`, `Short Description`, `HCPCS Code Dosage`, `Payment Limit`, ...
- **Row 10+**: Data rows

To find the header row programmatically: scan rows until the first cell (stripped, uppercased) equals
`HCPCS CODE` or `HCPCS`. That is row index 8 in practice, but detect dynamically.

Column names:
| Column | Use |
|--------|-----|
| `HCPCS Code` or `HCPCS` | Drug HCPCS code (J-codes, some Q/C codes) |
| `Short Description` | Drug name |
| `HCPCS Code Dosage` | Dosage per billing unit |
| `Payment Limit` | CMS payment limit (ASP + 6%) |

HCPCS pattern to accept (drug codes):
- J-codes: `^J[0-9]{4}$`
- Some Q, C, A, B codes are also included

For stage 1, accept any code matching `^[JQCAB][0-9]{4}$`.

**Important CMS note:** Absence from ASP file does NOT mean the drug is not covered — it just means no ASP-based
payment limit is published for it.

---

## Task 2: Write the build script

**File:** `scripts/build_asp_sqlite.py`

- [ ] Create `scripts/build_asp_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/asp.sqlite from CMS Part B Drug Average Sales Price files.

Source (Q2 2026): https://www.cms.gov/files/zip/april-2026-medicare-part-b-payment-limit-files-03-30-2026-final-file.zip

Tables:
  asp_payment_limits    — HCPCS → payment limit (stage 1)
  asp_ndc_hcpcs_crosswalk — NDC → HCPCS mapping (stage 2, schema only)

Usage:
  python3 scripts/build_asp_sqlite.py
  python3 scripts/build_asp_sqlite.py /path/to/asp.zip
"""

from __future__ import annotations

import csv
import io
import os
import re
import sqlite3
import sys
import urllib.request
import zipfile
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "asp.sqlite"

ASP_URLS = [
    "https://www.cms.gov/files/zip/april-2026-medicare-part-b-payment-limit-files-03-30-2026-final-file.zip",
    "https://www.cms.gov/files/zip/january-2026-medicare-part-b-payment-limit-files.zip",
    "https://www.cms.gov/files/zip/october-2025-asp-pricing-final-file.zip",
]

EFFECTIVE_QUARTER = "2026Q2"
# Accept J, Q, C, A, B prefix drug codes
DRUG_CODE_PATTERN = re.compile(r"^[JQCAB][0-9]{4}$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS asp_payment_limits (
            hcpcs_code          TEXT PRIMARY KEY,
            payment_limit       NUMERIC NOT NULL,
            description         TEXT,
            dosage              TEXT,
            effective_quarter   TEXT,
            source_release      TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_asp_code
            ON asp_payment_limits(hcpcs_code);

        -- Stage 2: NDC crosswalk (not populated in stage 1)
        CREATE TABLE IF NOT EXISTS asp_ndc_hcpcs_crosswalk (
            ndc11               TEXT NOT NULL,
            hcpcs_code          TEXT NOT NULL,
            description         TEXT,
            effective_quarter   TEXT,
            source_release      TEXT,
            PRIMARY KEY (ndc11, hcpcs_code)
        );
    """)


def find_header_row_index(lines: list[str]) -> int:
    """Find the 0-based index of the row containing 'HCPCS Code' or 'HCPCS' as first cell."""
    for i, line in enumerate(lines[:15]):  # only scan first 15 rows
        first_col = line.split(",")[0].strip().strip('"').upper()
        if first_col in ("HCPCS CODE", "HCPCS", "HCPCS_CODE"):
            return i
    return 8  # CMS default: header is row 9 (0-indexed: 8)


def parse_asp_csv(csv_bytes: bytes, quarter: str, source: str) -> list[tuple]:
    """Returns list of (hcpcs, payment_limit, description, dosage, quarter, source)."""
    text = csv_bytes.decode("utf-8", errors="replace")
    lines = text.splitlines()

    header_idx = find_header_row_index(lines)
    print(f"  Header found at row {header_idx}: {lines[header_idx][:80]}")

    data_text = "\n".join(lines[header_idx:])
    reader = csv.DictReader(io.StringIO(data_text))

    # Normalize column names
    results: list[tuple] = []

    for row in reader:
        # Normalize keys
        cols = {k.strip().upper().replace(" ", "_"): v.strip() for k, v in row.items() if k}

        code = (
            cols.get("HCPCS_CODE") or cols.get("HCPCS") or cols.get("CODE", "")
        ).strip().upper()

        if not DRUG_CODE_PATTERN.match(code):
            continue

        payment_limit_str = (
            cols.get("PAYMENT_LIMIT") or cols.get("PAYMENT LIMIT", "")
        ).replace(",", "").replace("$", "").strip()

        if not payment_limit_str:
            continue
        try:
            payment_limit = float(payment_limit_str)
        except ValueError:
            continue

        description = (
            cols.get("SHORT_DESCRIPTION") or cols.get("SHORT DESCRIPTION") or
            cols.get("DESCRIPTION", "")
        ).strip() or None

        dosage = (
            cols.get("HCPCS_CODE_DOSAGE") or cols.get("HCPCS CODE DOSAGE", "")
        ).strip() or None

        results.append((code, payment_limit, description, dosage, quarter, source))

    return results


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    if len(sys.argv) > 1:
        local_path = Path(sys.argv[1])
        print(f"Using local file: {local_path}")
        zip_bytes = local_path.read_bytes()
    else:
        zip_bytes = None
        for url in ASP_URLS:
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

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        print(f"ZIP contents: {archive.namelist()}")
        csv_files = [n for n in archive.namelist() if n.lower().endswith(".csv")]
        if not csv_files:
            print("ERROR: No CSV in ZIP")
            sys.exit(1)

        fname = csv_files[0]
        print(f"Parsing {fname} ...")
        rows = parse_asp_csv(archive.read(fname), EFFECTIVE_QUARTER, f"cms-asp-{EFFECTIVE_QUARTER}")
        print(f"Parsed {len(rows):,} rows")

    # Insert
    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO asp_payment_limits
                   (hcpcs_code, payment_limit, description, dosage, effective_quarter, source_release)
                   VALUES (?,?,?,?,?,?)""",
                row,
            )
            inserted += 1
        except sqlite3.Error as e:
            print(f"  Insert error: {e}")

    conn.commit()
    print(f"\nInserted {inserted:,} J/Q/C-code entries")

    # Verify
    for code in ["J0696", "J9035", "J1100", "J0129"]:
        row = conn.execute(
            "SELECT hcpcs_code, payment_limit, description FROM asp_payment_limits WHERE hcpcs_code=?", (code,)
        ).fetchone()
        if row:
            print(f"{row[0]}: ${row[1]:.4f} — {row[2]}")
        else:
            print(f"{code}: NOT FOUND")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")
    print("\nNote: asp_ndc_hcpcs_crosswalk table created but not populated (stage 2 future work).")


if __name__ == "__main__":
    main()
```

---

## Task 3: Build the database

- [ ] Run:

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_asp_sqlite.py
```

- [ ] Expected: ~900–1,000 J-code entries

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/asp.sqlite')
print("Total codes:", conn.execute("SELECT COUNT(*) FROM asp_payment_limits").fetchone()[0])
# Verify a known drug
for code in ['J0696', 'J9035', 'J1100']:
    row = conn.execute(
        "SELECT hcpcs_code, payment_limit, description FROM asp_payment_limits WHERE hcpcs_code=?", (code,)
    ).fetchone()
    print(f"{code}: {row}")
# Verify crosswalk schema exists
print("Crosswalk schema:", conn.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='asp_ndc_hcpcs_crosswalk'"
).fetchone())
conn.close()
EOF
```

---

## Task 4: Implement loadAspLimit in data-loader.ts

- [ ] Replace stub in `data-loader.ts`:

```typescript
export function loadAspLimit(hcpcsCode: string): AspRow | null {
  const db = getAspDb()
  if (!db) return null

  const row = db.prepare(`
    SELECT hcpcs_code, payment_limit, description, dosage
    FROM asp_payment_limits
    WHERE hcpcs_code = ?
  `).get(hcpcsCode.toUpperCase().trim()) as AspRow | undefined

  return row ?? null
}
```

- [ ] Run: `npm run check`

---

## Task 5: Update pharmacy markup check in audit-rules.ts

The current check uses `asp[code]`. Update to use `loadAspLimit`:

- [ ] Find the pharmacy markup section in `buildDeterministicFindings` and update:

```typescript
  // 3. Pharmacy markup check (ASP) — deterministic
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    if (alreadyFlaggedCodes.has(code)) continue

    const aspRow = loadAspLimit(code)
    if (!aspRow) continue

    const billed = lineItems[i].billedAmount
    const limit = aspRow.payment_limit
    const ratio = billed / limit

    // CMS allows up to 106% of ASP (6% markup). Over 4.5× = pharmacy markup error.
    if (ratio > 4.5) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'pharmacy_markup',
        confidence: 'high',
        description: `${code} (${aspRow.description ?? 'drug code'}) is billed at $${billed.toFixed(2)}, which is ${ratio.toFixed(1)}× the CMS ASP payment limit of $${limit.toFixed(2)}.`,
        standardDescription: aspRow.description ?? undefined,
        recommendation: `Request itemized drug administration records and justification for the markup above 4.5× the CMS Average Sales Price limit.`,
        medicareRate: limit,
        markupRatio: ratio,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    }
  }
```

- [ ] Remove the `asp: AspData` parameter from `buildDeterministicFindings` signature.
- [ ] Run: `npm run check`

---

## Task 6: Remove asp.json and tests

- [ ] `rm src/lib/data/asp.json`
- [ ] Add to `src/lib/server/data-loader.test.ts`:

```typescript
describe('ASP SQLite integration', () => {
  it.skipIf(!existsSync('data/asp.sqlite'))('returns limit for J0696 (Ceftriaxone)', () => {
    const row = loadAspLimit('J0696')
    expect(row).not.toBeNull()
    expect(row!.payment_limit).toBeGreaterThan(0)
  })

  it.skipIf(!existsSync('data/asp.sqlite'))('returns null for non-drug code', () => {
    expect(loadAspLimit('99285')).toBeNull()
  })
})
```

- [ ] `npm run test && npm run check && npm run build`

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_asp_sqlite.py src/lib/server/data-loader.ts \
        src/lib/server/audit-rules.ts src/lib/server/data-loader.test.ts
git rm --cached src/lib/data/asp.json 2>/dev/null || true
git commit -m "feat: migrate asp to sqlite with ndc crosswalk schema for stage 2"
```

---

## Quarterly refresh

Update `ASP_URLS` and `EFFECTIVE_QUARTER` in `build_asp_sqlite.py` each quarter.
URL pattern: `https://www.cms.gov/files/zip/{month}-{year}-medicare-part-b-payment-limit-files...zip`
Months: january, april, july, october
Run: `python3 scripts/build_asp_sqlite.py`

## Stage 2 note (future)

Populate `asp_ndc_hcpcs_crosswalk` when bills contain NDC drug codes.
Source: CMS NDC-HCPCS crosswalk file (same quarterly release, separate file in ZIP).
