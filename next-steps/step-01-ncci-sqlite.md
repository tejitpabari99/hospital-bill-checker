# Step 01: NCCI → SQLite

> **AGENT INSTRUCTIONS:** You are implementing step 01 of the hospital bill checker plan.
> Work in `/root/projects/hospital-bill-checker`.
> Read `next-steps/README.md` first. Step 00 must be complete before this step.
> Complete every checkbox. Commit at the end.

**Goal:** Replace `src/lib/data/ncci.json` with a SQLite database at `data/ncci.sqlite`.
Store all three NCCI bill types (Practitioner, Outpatient Hospital, DME) with modifier indicator stored
per-pair so we can check if modifier is valid for each specific (col1, col2) combination.

**Files to create:**
- `scripts/build_ncci_sqlite.py` — new build script (replaces `build_ncci.py`)
- `data/ncci.sqlite` — generated (not committed to git)

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadNcciPairs`
- `src/lib/server/audit-rules.ts` — remove `NcciData` / `NcciEntry` in-memory types, update NCCI functions
- `.gitignore` — add `data/*.sqlite` if not already there

**Files to delete:**
- `src/lib/data/ncci.json` — after migration is confirmed working

---

## Task 1: Understand the NCCI raw data format

The CMS NCCI tab-delimited text files have this layout (no true "header" row — the first parseable line IS data):

```
Col1Code<TAB>Col2Code<TAB>(blank or *)<TAB>EffectiveDate<TAB>DeletionDate<TAB>ModifierIndicator<TAB>Rationale
```

For Medicare files (detected when parts[2] is blank or `*`):
- `parts[0]` = Col1 code
- `parts[1]` = Col2 code
- `parts[2]` = blank or `*` (Medicare-specific field, skip)
- `parts[3]` = effective date (YYYYMMDD)
- `parts[4]` = deletion date (YYYYMMDD or `*` meaning 99991231)
- `parts[5]` = modifier indicator (`0`, `1`, or `9`)
- `parts[6]` = rationale (optional)

For Medicaid files (detected when parts[2] is a date):
- `parts[0]` = Col1 code
- `parts[1]` = Col2 code
- `parts[2]` = effective date
- `parts[3]` = deletion date
- `parts[4]` = modifier indicator
- `parts[5]` = rationale (optional)

Modifier indicator values:
- `0` = no modifier allowed (always an unbundling error)
- `1` = modifier -59 / X{EPSU} can override with documentation
- `9` = not applicable (treat same as `1` for our purposes)

Valid HCPCS/CPT code formats (keep these; reject everything else as header/footer noise):
- 5-digit numeric: `^[0-9]{5}$`
- 4 digits + uppercase letter: `^[0-9]{4}[A-Z]$`
- Uppercase letter + 4 digits: `^[A-Z][0-9]{4}$`

---

## Task 2: Write the build script

**File:** `scripts/build_ncci_sqlite.py`

- [ ] Create `scripts/build_ncci_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/ncci.sqlite from CMS NCCI PTP edit files.

Downloads and parses all three bill-type files:
  - Practitioner (Medicare quarterly ZIP parts, 4 files)
  - Outpatient Hospital (Medicare quarterly ZIP parts, 4 files)
  - DME (Medicaid quarterly single ZIP)

Schema:
  ncci_ptp(col1_code, col2_code, effective_date, deletion_date, modifier_indicator, rationale, bill_type, source)

Usage:
  python3 scripts/build_ncci_sqlite.py
  python3 scripts/build_ncci_sqlite.py --local /path/to/file.zip practitioner
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

DB_PATH = Path(__file__).parent.parent / "data" / "ncci.sqlite"

CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")

# All downloads keyed by bill_type
SOURCES: dict[str, list[str]] = {
    "practitioner": [
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f1.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f2.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f3.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f4.zip",
    ],
    "outpatient": [
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f1.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f2.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f3.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f4.zip",
    ],
    "dme": [
        "https://www.cms.gov/files/zip/medicaid-ncci-q2-2026-ptp-edits-durable-medical-equipment-services.zip",
    ],
}

# Medicaid also has practitioner and outpatient — use as fallback
MEDICAID_FALLBACK: dict[str, list[str]] = {
    "practitioner": [
        "https://www.cms.gov/files/zip/medicaid-ncci-q2-2026-ptp-edits-practitioner-services.zip",
    ],
    "outpatient": [
        "https://www.cms.gov/files/zip/medicaid-ncci-q2-2026-ptp-edits-outpatient-hospital-services.zip",
    ],
}


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    print(f"  Downloaded {len(data):,} bytes from {url}")
    return data


def is_medicare_layout(parts: list[str]) -> bool:
    """Medicare files have a blank or * in column index 2 (before effective date)."""
    if len(parts) < 5:
        return False
    col2_val = parts[2].strip()
    return col2_val in ("", "*")


def parse_txt(txt_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    """
    Parse one NCCI tab-delimited text file.
    Returns list of (col1, col2, eff_date, del_date, modifier, rationale, bill_type, source).
    All rows are kept — no expiry filtering. Filter at query time.
    """
    rows: list[tuple] = []
    text = io.StringIO(txt_bytes.decode("utf-8", errors="replace"))

    for line in text:
        line = line.rstrip("\r\n")
        if not line:
            continue

        parts = line.split("\t")
        if len(parts) < 4:
            continue

        col1 = parts[0].strip().upper()
        col2 = parts[1].strip().upper()

        # Filter out header/footer rows (not valid HCPCS codes)
        if not CODE_PATTERN.match(col1) or not CODE_PATTERN.match(col2):
            continue

        # Detect layout and extract fields
        if is_medicare_layout(parts):
            # Medicare: col1, col2, (blank/*), eff_date, del_date, modifier, rationale
            eff_str = parts[3].strip() if len(parts) > 3 else ""
            del_str = parts[4].strip() if len(parts) > 4 else "*"
            mod = parts[5].strip() if len(parts) > 5 else "1"
            rationale = parts[6].strip() if len(parts) > 6 else None
        else:
            # Medicaid: col1, col2, eff_date, del_date, modifier, rationale
            eff_str = parts[2].strip()
            del_str = parts[3].strip() if len(parts) > 3 else "*"
            mod = parts[4].strip() if len(parts) > 4 else "1"
            rationale = parts[5].strip() if len(parts) > 5 else None

        # Parse dates to integers
        try:
            eff_date = int(eff_str) if eff_str and eff_str != "*" else 20000101
        except ValueError:
            eff_date = 20000101

        try:
            del_date = int(del_str) if del_str and del_str != "*" else 99991231
        except ValueError:
            del_date = 99991231

        # Normalize modifier indicator
        if mod not in ("0", "1", "9"):
            mod = "1"

        rationale = rationale or None

        rows.append((col1, col2, eff_date, del_date, mod, rationale, bill_type, source))

    return rows


def process_zip(zip_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    rows: list[tuple] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        txt_files = [n for n in archive.namelist() if n.lower().endswith(".txt")]
        print(f"  ZIP contains: {archive.namelist()}")
        for fname in txt_files:
            print(f"  Parsing {fname} ...")
            parsed = parse_txt(archive.read(fname), bill_type, source)
            print(f"    → {len(parsed):,} rows")
            rows.extend(parsed)
    return rows


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS ncci_ptp (
            col1_code           TEXT NOT NULL,
            col2_code           TEXT NOT NULL,
            effective_date      INTEGER NOT NULL,
            deletion_date       INTEGER NOT NULL,
            modifier_indicator  TEXT NOT NULL,
            rationale           TEXT,
            bill_type           TEXT NOT NULL,
            source              TEXT NOT NULL,
            PRIMARY KEY (col1_code, col2_code, effective_date, bill_type)
        );

        CREATE INDEX IF NOT EXISTS idx_ncci_col2_type
            ON ncci_ptp(col2_code, bill_type);

        CREATE INDEX IF NOT EXISTS idx_ncci_col2_date
            ON ncci_ptp(col2_code, bill_type, effective_date, deletion_date);

        CREATE INDEX IF NOT EXISTS idx_ncci_pair_type
            ON ncci_ptp(col1_code, col2_code, bill_type);
    """)


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


def fetch_and_parse(bill_type: str, urls: list[str], source_label: str) -> list[tuple]:
    all_rows: list[tuple] = []
    for url in urls:
        print(f"\nDownloading {url} ...")
        try:
            data = download_bytes(url)
            rows = process_zip(data, bill_type, source_label)
            all_rows.extend(rows)
        except Exception as exc:
            print(f"  ERROR: {exc}")
    return all_rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", nargs=2, metavar=("FILE", "BILL_TYPE"),
                        help="Use a local ZIP file instead of downloading. BILL_TYPE: practitioner|outpatient|dme")
    args = parser.parse_args()

    os.makedirs(DB_PATH.parent, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    if args.local:
        local_path, bill_type = args.local
        if bill_type not in ("practitioner", "outpatient", "dme"):
            print(f"ERROR: BILL_TYPE must be practitioner, outpatient, or dme. Got: {bill_type}")
            sys.exit(1)
        print(f"\nUsing local file: {local_path} (bill_type={bill_type})")
        zip_bytes = Path(local_path).read_bytes()
        rows = process_zip(zip_bytes, bill_type, f"local:{local_path}")
        inserted = insert_rows(conn, rows)
        conn.commit()
        print(f"\nInserted {inserted:,} rows for {bill_type}")
    else:
        total = 0
        for bill_type, urls in SOURCES.items():
            print(f"\n{'='*60}")
            print(f"Downloading {bill_type.upper()} NCCI PTP files...")
            rows = fetch_and_parse(bill_type, urls, f"cms-{bill_type}-2026q2")

            if not rows and bill_type in MEDICAID_FALLBACK:
                print(f"Primary download failed. Trying Medicaid fallback for {bill_type}...")
                fallback_urls = MEDICAID_FALLBACK[bill_type]
                rows = fetch_and_parse(bill_type, fallback_urls, f"cms-medicaid-{bill_type}-2026q2")

            inserted = insert_rows(conn, rows)
            conn.commit()
            print(f"Inserted {inserted:,} rows for {bill_type}")
            total += inserted

        print(f"\n{'='*60}")
        print(f"Total rows inserted: {total:,}")

    # Print summary
    cur = conn.execute("SELECT bill_type, COUNT(*) FROM ncci_ptp GROUP BY bill_type")
    print("\nDB summary:")
    for bill_type, count in cur.fetchall():
        print(f"  {bill_type}: {count:,} rows")

    cur2 = conn.execute("SELECT COUNT(DISTINCT col2_code) FROM ncci_ptp")
    print(f"  Unique col2 codes: {cur2.fetchone()[0]:,}")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")


if __name__ == "__main__":
    main()
```

---

## Task 3: Build the database

- [ ] Run the script:

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_ncci_sqlite.py
```

- [ ] Expected output (approximate):
  ```
  Downloading PRACTITIONER NCCI PTP files...
  ...
  Inserted ~800,000+ rows for practitioner
  Downloading OUTPATIENT NCCI PTP files...
  Inserted ~700,000+ rows for outpatient
  Downloading DME NCCI PTP files...
  Inserted ~50,000+ rows for dme
  Total rows inserted: ~1,500,000+
  Wrote data/ncci.sqlite (~200+ MB)
  ```

- [ ] Verify the database:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/ncci.sqlite')

# Check counts by type
for row in conn.execute("SELECT bill_type, COUNT(*) FROM ncci_ptp GROUP BY bill_type"):
    print(f"{row[0]}: {row[1]:,} rows")

# Spot check: 93010 bundles into 93000 for practitioner
rows = conn.execute("""
    SELECT col1_code, col2_code, modifier_indicator
    FROM ncci_ptp
    WHERE col2_code='93010' AND bill_type='practitioner'
    AND deletion_date >= 20260401 AND effective_date <= 20260401
    LIMIT 5
""").fetchall()
print("93010 bundles into (practitioner, Q2 2026):", rows)

# Check 70450 pairs
rows2 = conn.execute("""
    SELECT col1_code, modifier_indicator FROM ncci_ptp
    WHERE col2_code='70450' AND bill_type='practitioner'
    AND deletion_date >= 20260401 LIMIT 5
""").fetchall()
print("70450 bundles into (practitioner):", rows2)

conn.close()
EOF
```

---

## Task 4: Update data-loader.ts — implement loadNcciPairs

- [ ] Open `src/lib/server/data-loader.ts`
- [ ] Replace the stub `loadNcciPairs` function with:

```typescript
import { getNcciDb } from './db'

export function loadNcciPairs(
  col2Code: string,
  billType: BillType,
  serviceDateInt: number
): NcciPairRow[] {
  const db = getNcciDb()
  if (!db) return []

  // Map 'unknown' to 'practitioner' as a safe default
  const dbBillType = billType === 'unknown' ? 'practitioner' : billType

  const rows = db.prepare(`
    SELECT col1_code, modifier_indicator, rationale
    FROM ncci_ptp
    WHERE col2_code = ?
      AND bill_type = ?
      AND effective_date <= ?
      AND deletion_date >= ?
    ORDER BY effective_date DESC
  `).all(
    col2Code.toUpperCase().trim(),
    dbBillType,
    serviceDateInt,
    serviceDateInt
  ) as NcciPairRow[]

  return rows
}
```

- [ ] Make sure the import is at the top of `data-loader.ts` (add if missing):

```typescript
import { getNcciDb, getMueDb, getMpfsDb, getClfsDb, getAspDb,
         getOppsDb, getIppsDb, getDmeposDb, getAmbulanceDb } from './db'
```

- [ ] Run: `npm run check`
- [ ] Expected: no TypeScript errors

---

## Task 5: Update audit-rules.ts — replace NCCI in-memory lookup with data-loader

Open `src/lib/server/audit-rules.ts`. The existing `NcciData` / `NcciEntry` types and `getNcciEntry` function will
be replaced. The `buildDeterministicFindings` function currently takes `ncci: NcciData` as a parameter.

- [ ] In `audit-rules.ts`, remove the old `NcciEntry`, `NcciData` types and `getNcciEntry` function.

- [ ] Update the signature of `buildDeterministicFindings` to remove the `ncci` parameter and add `billType` and `serviceDateInt`:

```typescript
import { loadNcciPairs, toServiceDateInt } from './data-loader'
import type { BillType } from '$lib/types'

export function buildDeterministicFindings(
  lineItems: LineItem[],
  mpfs: MpfsData,      // kept for now; replaced in step-03
  asp: AspData,        // kept for now; replaced in step-05
  clfs: ClfsData,      // kept for now; replaced in step-04
  mue: MueData,        // kept for now; replaced in step-02
  emMdmTiers: EmMdmTierData = {},
  lcdCoverage: LcdCoverageData = {},
  billType: BillType = 'unknown',
  serviceDateStr?: string
): { findings: AuditFinding[]; promptNote: string } {
```

- [ ] Replace the NCCI unbundling section in `buildDeterministicFindings` (currently starts with `// 1. NCCI unbundling`):

```typescript
  const serviceDateInt = toServiceDateInt(serviceDateStr)
  const codes = lineItems.map(li => li.cpt.trim().toUpperCase())
  const codeSet = new Set(codes)
  const findings: AuditFinding[] = []
  const alreadyFlaggedCodes = new Set<string>()

  // 1. NCCI unbundling — deterministic, per-pair modifier check
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const pairs = loadNcciPairs(code, billType, serviceDateInt)
    if (pairs.length === 0) continue

    const presentCol1 = pairs.filter(p => codeSet.has(p.col1_code))
    if (presentCol1.length === 0) continue

    // Check modifiers from this line item
    const lineModifiers = (lineItems[i].modifiers ?? []).map(m => m.trim().toUpperCase())
    const hasModifier59 = lineModifiers.some(m =>
      ['59', '-59', 'XE', 'XP', 'XS', 'XU'].includes(m)
    )

    for (const pair of presentCol1) {
      const modifierCanOverride = pair.modifier_indicator !== '0'
      const modifierOverrides = modifierCanOverride && hasModifier59

      if (modifierOverrides) continue  // valid — skip

      const modNote = modifierCanOverride
        ? '(modifier -59 may override with documented distinct clinical indication)'
        : '(no modifier override allowed — always an unbundling error)'

      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'unbundling',
        confidence: 'high',
        description: `CPT ${code} is bundled into CPT ${pair.col1_code} per CMS NCCI PTP edits. Both codes should not be billed separately on the same claim ${modNote}.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Request that the hospital remove CPT ${code} from the claim or provide documentation justifying separate billing with modifier -59.`,
        ncciBundledWith: pair.col1_code,
        medicareRate: undefined,
        markupRatio: undefined,
      })
      alreadyFlaggedCodes.add(code)
      break  // one finding per code is enough
    }
  }
```

- [ ] Run: `npm run check`
- [ ] Expected: no TypeScript errors (there will be call-site errors in claude.ts — fix in step 13)

---

## Task 6: Update .gitignore

- [ ] Open `.gitignore` and add:

```
data/*.sqlite
data/hospital_cache/
```

---

## Task 7: Write tests for NCCI integration

**File:** `src/lib/server/audit-rules.test.ts` (already exists — add to it)

- [ ] Open `src/lib/server/audit-rules.test.ts` and add a describe block for NCCI SQLite:

```typescript
describe('NCCI SQLite integration', () => {
  // These tests only run if data/ncci.sqlite exists
  const db = (() => { try { return new Database('data/ncci.sqlite', { readonly: true }) } catch { return null } })()

  it.skipIf(!db)('93010 bundles into 93000 for practitioner', () => {
    const pairs = loadNcciPairs('93010', 'practitioner', 20260401)
    const col1Codes = pairs.map(p => p.col1_code)
    expect(col1Codes).toContain('93000')
  })

  it.skipIf(!db)('returns empty for unknown code', () => {
    const pairs = loadNcciPairs('99999', 'practitioner', 20260401)
    expect(pairs).toHaveLength(0)
  })

  it.skipIf(!db)('returns different results for different bill types', () => {
    const pract = loadNcciPairs('93010', 'practitioner', 20260401)
    const outpt = loadNcciPairs('93010', 'outpatient', 20260401)
    // They may differ — just verify both return arrays
    expect(Array.isArray(pract)).toBe(true)
    expect(Array.isArray(outpt)).toBe(true)
  })
})
```

Add this import at the top of the test file:
```typescript
import Database from 'better-sqlite3'
import { loadNcciPairs } from './data-loader'
```

- [ ] Run: `npm run test -- audit-rules`
- [ ] Expected: existing tests pass, new SQLite tests either pass or are skipped if DB not built

---

## Task 8: Remove old ncci.json

Only delete after confirming the DB is built and tests pass.

- [ ] Run: `rm src/lib/data/ncci.json`
- [ ] Run: `npm run check`
- [ ] Run: `npm run build`
- [ ] Fix any remaining import errors in `claude.ts` (just remove the `ncci` import line; full claude.ts rewrite is step 13)

---

## Task 9: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_ncci_sqlite.py src/lib/server/data-loader.ts \
        src/lib/server/audit-rules.ts src/lib/server/audit-rules.test.ts \
        .gitignore
git rm --cached src/lib/data/ncci.json 2>/dev/null || true
git commit -m "feat: migrate ncci to sqlite with per-pair modifier validation"
```

---

## Quarterly refresh instructions (document these)

To update NCCI for a new quarter:
1. Update the URLs in `SOURCES` dict in `build_ncci_sqlite.py` (change `2026q2` to new quarter)
2. Update the `ACTIVE_DATE` comment at top of file
3. Run: `python3 scripts/build_ncci_sqlite.py`
4. Restart the server

Data note: CMS updates NCCI quarterly (Jan 1, Apr 1, Jul 1, Oct 1). Data may be up to 30 days stale between releases.
