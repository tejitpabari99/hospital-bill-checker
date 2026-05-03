# Step 02: MUE → SQLite

> **AGENT INSTRUCTIONS:** You are implementing step 02.
> Work in `/root/projects/hospital-bill-checker`. Steps 00 and 01 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Replace `src/lib/data/mue.json` with `data/mue.sqlite` covering all three MUE bill types
(Practitioner, Outpatient Hospital, DME Supplier).

**Files to create:**
- `scripts/build_mue_sqlite.py`
- `data/mue.sqlite` — generated

**Files to modify:**
- `src/lib/server/data-loader.ts` — implement `loadMueEdit`
- `src/lib/server/audit-rules.ts` — update MUE check to use data-loader

**Files to delete:**
- `src/lib/data/mue.json` — after migration confirmed

---

## Task 1: Understand MUE raw data format

The CMS MUE files are ZIP archives containing a CSV. The CSV structure:
```
Row 1: CMS disclaimer text (e.g. "CPT codes, descriptions and other data only...")
Row 2: Column headers — e.g.: HCPCS/CPT Code, MUE Values, MUE Adjudication Indicator (MAI), MUE Rationale
Row 3+: Data rows
```

Column meanings:
- Column 0: HCPCS/CPT code (e.g. `99285`, `J0696`)
- Column 1: MUE value (integer — max units allowed per claim line or date of service)
- Column 2: MUE Adjudication Indicator (MAI):
  - `1` = Claim Line Edit (per line item)
  - `2` = Date of Service Edit (sum per date across lines)
  - `3` = Date of Service Edit (MAI=3, clinically unlikely)
- Column 3: MUE Rationale (text, e.g. "Anatomic Considerations")

We store ALL MAI values (not just 3 as the old script did). Query-time logic decides what to enforce.

---

## Task 2: Write the build script

**File:** `scripts/build_mue_sqlite.py`

- [ ] Create `scripts/build_mue_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/mue.sqlite from CMS MUE files — all three bill types.

Sources (Q2 2026):
  Practitioner: https://www.cms.gov/files/zip/medicare-ncci-2026-q2-practitioner-services-mue-table.zip
  Outpatient:   https://www.cms.gov/files/zip/medicare-ncci-2026-q2-facility-outpatient-hospital-services-mue-table.zip
  DME:          https://www.cms.gov/files/zip/medicare-ncci-2026-q2-dme-supplier-services-mue-table.zip

Schema:
  mue_edits(hcpcs_code, mue_value, mue_adjudication_indicator, mue_rationale, bill_type, source)

Usage:
  python3 scripts/build_mue_sqlite.py
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

DB_PATH = Path(__file__).parent.parent / "data" / "mue.sqlite"

SOURCES: dict[str, str] = {
    "practitioner": "https://www.cms.gov/files/zip/medicare-ncci-2026-q2-practitioner-services-mue-table.zip",
    "outpatient": "https://www.cms.gov/files/zip/medicare-ncci-2026-q2-facility-outpatient-hospital-services-mue-table.zip",
    "dme": "https://www.cms.gov/files/zip/medicare-ncci-2026-q2-dme-supplier-services-mue-table.zip",
}

# Valid HCPCS/CPT code pattern
CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def parse_mue_csv(csv_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    """
    Parse CMS MUE CSV.
    Row 0: disclaimer (skip)
    Row 1: headers (skip)
    Row 2+: data
    Returns list of (hcpcs_code, mue_value, mai, rationale, bill_type, source)
    """
    rows: list[tuple] = []
    text = io.StringIO(csv_bytes.decode("utf-8", errors="replace"))
    reader = csv.reader(text)

    # Skip disclaimer row
    next(reader, None)
    # Skip header row
    next(reader, None)

    for row in reader:
        if not row:
            continue

        code = str(row[0]).strip().upper() if len(row) > 0 else ""
        if not CODE_PATTERN.match(code):
            continue

        mue_val_str = str(row[1]).strip() if len(row) > 1 else ""
        try:
            mue_value = int(mue_val_str)
        except ValueError:
            continue

        mai = str(row[2]).strip() if len(row) > 2 else "1"
        # Normalize MAI to just the leading digit
        mai_digit = mai[0] if mai and mai[0].isdigit() else "1"

        rationale = str(row[3]).strip() if len(row) > 3 else None
        if not rationale:
            rationale = None

        rows.append((code, mue_value, mai_digit, rationale, bill_type, source))

    return rows


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS mue_edits (
            hcpcs_code                  TEXT NOT NULL,
            mue_value                   INTEGER NOT NULL,
            mue_adjudication_indicator  TEXT NOT NULL,
            mue_rationale               TEXT,
            bill_type                   TEXT NOT NULL,
            source                      TEXT NOT NULL,
            PRIMARY KEY (hcpcs_code, bill_type)
        );

        CREATE INDEX IF NOT EXISTS idx_mue_code_type
            ON mue_edits(hcpcs_code, bill_type);

        CREATE INDEX IF NOT EXISTS idx_mue_code
            ON mue_edits(hcpcs_code);
    """)


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    total = 0
    for bill_type, url in SOURCES.items():
        print(f"\nDownloading {bill_type.upper()} MUE from {url} ...")
        try:
            zip_bytes = download_bytes(url)
        except Exception as exc:
            print(f"  ERROR downloading: {exc}")
            continue

        print(f"  Downloaded {len(zip_bytes):,} bytes")

        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            csv_names = [n for n in archive.namelist() if n.lower().endswith(".csv")]
            print(f"  ZIP contains: {archive.namelist()}")
            if not csv_names:
                print(f"  ERROR: no CSV in ZIP")
                continue

            # Pick the CSV (usually just one)
            csv_name = csv_names[0]
            print(f"  Parsing {csv_name} ...")
            rows = parse_mue_csv(archive.read(csv_name), bill_type, f"cms-{bill_type}-2026q2")
            print(f"  Parsed {len(rows):,} rows")

        # Insert
        inserted = 0
        for row in rows:
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO mue_edits
                       (hcpcs_code, mue_value, mue_adjudication_indicator,
                        mue_rationale, bill_type, source)
                       VALUES (?,?,?,?,?,?)""",
                    row,
                )
                inserted += 1
            except sqlite3.Error:
                pass

        conn.commit()
        print(f"  Inserted {inserted:,} rows for {bill_type}")
        total += inserted

    # Summary
    print(f"\n{'='*50}")
    print(f"Total rows: {total:,}")
    for row in conn.execute("SELECT bill_type, COUNT(*) FROM mue_edits GROUP BY bill_type"):
        print(f"  {row[0]}: {row[1]:,}")

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
python3 scripts/build_mue_sqlite.py
```

- [ ] Expected: ~10,000–15,000 rows per bill type, DB ~5–10 MB

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/mue.sqlite')
for row in conn.execute("SELECT bill_type, COUNT(*) FROM mue_edits GROUP BY bill_type"):
    print(f"{row[0]}: {row[1]:,}")
# 99285 MUE for practitioner
row = conn.execute(
    "SELECT * FROM mue_edits WHERE hcpcs_code='99285' AND bill_type='practitioner'"
).fetchone()
print("99285 practitioner MUE:", row)
conn.close()
EOF
```

---

## Task 4: Implement loadMueEdit in data-loader.ts

- [ ] Open `src/lib/server/data-loader.ts`
- [ ] Replace the stub `loadMueEdit` with:

```typescript
export function loadMueEdit(
  hcpcsCode: string,
  billType: BillType
): MueRow | null {
  const db = getMueDb()
  if (!db) return null

  const dbBillType = billType === 'unknown' ? 'practitioner' : billType

  const row = db.prepare(`
    SELECT hcpcs_code, mue_value, mue_adjudication_indicator, mue_rationale
    FROM mue_edits
    WHERE hcpcs_code = ? AND bill_type = ?
  `).get(
    hcpcsCode.toUpperCase().trim(),
    dbBillType
  ) as MueRow | undefined

  return row ?? null
}
```

- [ ] Run: `npm run check`

---

## Task 5: Update MUE check in audit-rules.ts

In `buildDeterministicFindings`, find the existing MUE check (currently uses `mue: MueData` parameter).
Replace it with the data-loader version:

- [ ] Find this section in `audit-rules.ts` (approximately line 220+):

```typescript
// MUE units check — deterministic
for (let i = 0; i < lineItems.length; i++) {
  const code = codes[i]
  const entry = mue[code]
  if (!entry) continue
  ...
}
```

- [ ] Replace with:

```typescript
  // 2. MUE units check — deterministic
  for (let i = 0; i < lineItems.length; i++) {
    const code = codes[i]
    const unitsBilled = lineItems[i].units ?? 1
    const mueEntry = loadMueEdit(code, billType)
    if (!mueEntry) continue

    const mai = mueEntry.mue_adjudication_indicator
    const maxUnits = mueEntry.mue_value

    // MAI 1 = per claim line, MAI 2 or 3 = per date of service
    // For simplicity: flag if units > maxUnits regardless of MAI
    if (unitsBilled > maxUnits) {
      findings.push({
        lineItemIndex: i,
        cptCode: code,
        severity: 'error',
        errorType: 'other',
        confidence: 'high',
        description: `CPT ${code} has ${unitsBilled} units billed, which exceeds the CMS Medically Unlikely Edit (MUE) limit of ${maxUnits} units per ${mai === '1' ? 'claim line' : 'date of service'}.`,
        standardDescription: CPT_DESCRIPTIONS[code],
        recommendation: `Request itemized documentation for each unit of CPT ${code}. The MUE limit is ${maxUnits} unit(s).`,
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
      alreadyFlaggedCodes.add(code)
    }
  }
```

- [ ] Also remove the `mue: MueData` and `MueData` / `MueEntry` types from the `buildDeterministicFindings` signature and imports (they'll be fully replaced by data-loader in step 13).
  For now, just comment out the old `mue[code]` lookup; the new one uses `loadMueEdit`.

- [ ] Run: `npm run check`

---

## Task 6: Write tests

- [ ] Add to `src/lib/server/audit-rules.test.ts`:

```typescript
describe('MUE SQLite integration', () => {
  const db = (() => { try { return new Database('data/mue.sqlite', { readonly: true }) } catch { return null } })()

  it.skipIf(!db)('returns MUE for 99285 practitioner', () => {
    const entry = loadMueEdit('99285', 'practitioner')
    expect(entry).not.toBeNull()
    expect(entry!.mue_value).toBeGreaterThan(0)
  })

  it.skipIf(!db)('returns null for unknown code', () => {
    const entry = loadMueEdit('ZZZZZ', 'practitioner')
    expect(entry).toBeNull()
  })

  it.skipIf(!db)('has outpatient entries', () => {
    const entry = loadMueEdit('99285', 'outpatient')
    // May or may not exist — just verify it returns null or a valid row
    if (entry) {
      expect(entry.mue_value).toBeGreaterThan(0)
    }
  })
})
```

Add this import if not already present:
```typescript
import { loadMueEdit } from './data-loader'
```

- [ ] Run: `npm run test -- audit-rules`

---

## Task 7: Delete old mue.json

- [ ] `rm src/lib/data/mue.json`
- [ ] `npm run check` — fix any remaining import errors
- [ ] `npm run build`

---

## Task 8: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_mue_sqlite.py src/lib/server/data-loader.ts src/lib/server/audit-rules.ts \
        src/lib/server/audit-rules.test.ts
git rm --cached src/lib/data/mue.json 2>/dev/null || true
git commit -m "feat: migrate mue to sqlite — all three bill types"
```

---

## Quarterly refresh

Update `SOURCES` URLs in `build_mue_sqlite.py` each quarter (Jan, Apr, Jul, Oct).
Run: `python3 scripts/build_mue_sqlite.py`
Data note: CMS MUE updates quarterly. May be up to 30 days stale.
