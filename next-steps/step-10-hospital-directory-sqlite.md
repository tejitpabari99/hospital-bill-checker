# Step 10: Hospital Directory SQLite + Trilliant Pricing

> **AGENT INSTRUCTIONS:** You are implementing step 10.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–09 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Replace the existing hospital MRF discovery system with a two-layer approach:
1. `data/hospital_directory.sqlite` — search index (from existing CMS Hospital General Information data)
2. Trilliant/Oria web search → per-hospital DuckDB → convert to local SQLite cache

The current `hospital_index.json` and `fetch_hospital_mrf.py` are replaced by this system.

**Files to create:**
- `scripts/build_hospital_directory_sqlite.py` — builds hospital_directory.sqlite from CMS data
- `scripts/fetch_hospital_trilliant.py` — searches Trilliant, downloads + converts DuckDB to SQLite
- `src/lib/server/hospital-prices-v2.ts` — new hospital price lookup using the two-layer system

**Files to modify:**
- `src/lib/server/claude.ts` — use new `lookupHospitalPricesV2` instead of old `lookupHospitalPrices`

**Files to delete (after confirmed working):**
- `src/lib/data/hospital_index.json`

---

## Task 1: Understand the Trilliant search approach

**Trilliant/Oria website:** `https://oria-data.trillianthealth.com`

**Search URL:** `https://oria-data.trillianthealth.com/hospitals?q={hospital_name}`
- The `q` parameter is the search query (hospital name, possibly include city/state)
- The page returns a list of hospital cards
- Each card has a "Download DuckDB" link or similar link pointing to a URL like:
  `https://oria-data.trillianthealth.com/data/{date}/completed/{hospital_slug}/{hospital_slug}_parsed.duckdb`

**Parse strategy:**
1. `GET https://oria-data.trillianthealth.com/hospitals?q={name}`
2. Parse HTML to find `href` attributes matching `*_parsed.duckdb`
3. Also extract hospital name, city, state from the cards
4. Download the DuckDB file
5. Use Python `duckdb` library (or convert to SQLite) to query standard charge table
6. Cache the SQLite result in `data/hospital_cache/{hospital_id}.sqlite`

**Hospital charge table** (Trilliant standard schema):
- `standard_charges` or `charges` table
- Columns: `code`, `code_type`, `description`, `gross_charge`, `discounted_cash_price`,
  `payer_name`, `plan_name`, `negotiated_charge`, `setting`, etc.

---

## Task 2: Install duckdb Python package

- [ ] Run:

```bash
pip install duckdb requests beautifulsoup4
```

- [ ] Add to `scripts/requirements.txt`:

```
duckdb>=0.10.0
requests>=2.31.0
beautifulsoup4>=4.12.0
```

---

## Task 3: Build hospital_directory.sqlite from CMS data

This replaces `hospital_index.json`.

**File:** `scripts/build_hospital_directory_sqlite.py`

- [ ] Create `scripts/build_hospital_directory_sqlite.py`:

```python
#!/usr/bin/env python3
"""
Build data/hospital_directory.sqlite from CMS Hospital General Information dataset.

This is the search index used to find hospitals by name/city/state/phone.
Does NOT contain pricing — pricing comes from Trilliant (fetch_hospital_trilliant.py).

Source: https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0

Usage:
  python3 scripts/build_hospital_directory_sqlite.py
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import sqlite3
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "hospital_directory.sqlite"

API_URL = "https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0"
CSV_URL = (
    "https://data.cms.gov/provider-data/sites/default/files/resources/"
    "092256becd267d9eecca15f2a4f206c1_1694479371/Hospital_General_Information.csv"
)
USER_AGENT = "HospitalBillChecker/1.0"

SYNONYMS = [
    (r"\bst\b\.?\s+", "saint "),
    (r"\bmt\b\.?\s+", "mount "),
    (r"\bmem\b\.?\s+", "memorial "),
    (r"\bmed\s+ctr\b", "medical center"),
    (r"\bhosp\b", "hospital"),
    (r"\buniv\b\.?\s+", "university "),
]


def normalize_name(name: str) -> str:
    name = name.lower()
    name = re.sub(r"'s\b", "s", name)
    name = re.sub(r"'\b", "", name)
    for pattern, replacement in SYNONYMS:
        name = re.sub(pattern, replacement, name)
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def normalize_phone(phone: str) -> str:
    return re.sub(r"[^0-9]", "", phone)


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS hospitals (
            hospital_id     TEXT PRIMARY KEY,
            hospital_name   TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            hospital_address TEXT,
            hospital_city   TEXT,
            hospital_state  TEXT,
            hospital_zip    TEXT,
            hospital_phone  TEXT,
            phone_digits    TEXT,
            ccn             TEXT,
            npi             TEXT,
            hospital_type   TEXT,
            ownership       TEXT,
            mrf_url         TEXT,
            source_page_url TEXT,
            duckdb_url      TEXT,
            last_updated_on TEXT,
            source          TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_hospitals_name
            ON hospitals(normalized_name);

        CREATE INDEX IF NOT EXISTS idx_hospitals_city_state
            ON hospitals(hospital_city, hospital_state);

        CREATE INDEX IF NOT EXISTS idx_hospitals_zip
            ON hospitals(hospital_zip);

        CREATE INDEX IF NOT EXISTS idx_hospitals_ccn
            ON hospitals(ccn);

        CREATE INDEX IF NOT EXISTS idx_hospitals_phone
            ON hospitals(phone_digits);
    """)


def fetch_cms_hospitals() -> list[dict]:
    """Fetch hospital data from CMS API."""
    req = urllib.request.Request(API_URL, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        results = data.get("results", data.get("data", []))
        if results:
            return results
    except Exception as exc:
        print(f"API failed: {exc}. Falling back to CSV...")

    # Fallback to CSV
    req = urllib.request.Request(CSV_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        content = resp.read().decode("utf-8", errors="replace")

    reader = csv.DictReader(io.StringIO(content))
    return list(reader)


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    print("Fetching CMS Hospital General Information...")
    hospitals = fetch_cms_hospitals()
    print(f"Fetched {len(hospitals):,} hospital records")

    updated_at = datetime.now(timezone.utc).isoformat()
    inserted = 0

    for h in hospitals:
        # Normalize key names (CMS uses different key formats in API vs CSV)
        def get(*keys: str, default: str = "") -> str:
            for k in keys:
                v = h.get(k, h.get(k.lower(), h.get(k.replace(" ", "_").lower(), "")))
                if v:
                    return str(v).strip()
            return default

        name = get("Hospital Name", "hospital_name", "name")
        if not name:
            continue

        ccn = get("Provider ID", "provider_id", "ccn")
        hospital_id = ccn or re.sub(r"[^a-z0-9]", "_", name.lower())[:60]

        address = get("Address", "address", "hospital_address")
        city = get("City", "city", "hospital_city")
        state = get("State", "state", "hospital_state")
        zip_code = get("ZIP Code", "zip_code", "hospital_zip")
        phone = get("Phone Number", "phone_number", "hospital_phone")
        hospital_type = get("Hospital Type", "hospital_type")
        ownership = get("Hospital Ownership", "hospital_ownership", "ownership")

        normalized = normalize_name(name)
        phone_digits = normalize_phone(phone)

        try:
            conn.execute("""INSERT OR REPLACE INTO hospitals
                (hospital_id, hospital_name, normalized_name, hospital_address,
                 hospital_city, hospital_state, hospital_zip, hospital_phone,
                 phone_digits, ccn, npi, hospital_type, ownership,
                 mrf_url, source_page_url, duckdb_url,
                 last_updated_on, source, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,NULL,NULL,NULL,'cms',?)""",
                (hospital_id, name, normalized, address, city, state, zip_code,
                 phone, phone_digits, ccn, hospital_type, ownership, updated_at))
            inserted += 1
        except sqlite3.Error as e:
            print(f"  Insert error for {name}: {e}")

    conn.commit()

    print(f"\nInserted {inserted:,} hospitals")
    # Verify
    for row in conn.execute(
        "SELECT hospital_name, hospital_city, hospital_state FROM hospitals WHERE hospital_state='MA' LIMIT 3"
    ).fetchall():
        print(f"  {row}")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")


if __name__ == "__main__":
    main()
```

---

## Task 4: Build the hospital directory

- [ ] Run:

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_hospital_directory_sqlite.py
```

- [ ] Verify:

```bash
python3 - << 'EOF'
import sqlite3
conn = sqlite3.connect('data/hospital_directory.sqlite')
print("Total hospitals:", conn.execute("SELECT COUNT(*) FROM hospitals").fetchone()[0])
# Search for Mass General
rows = conn.execute(
    "SELECT hospital_name, hospital_city, hospital_state FROM hospitals WHERE normalized_name LIKE '%general%massachusetts%' LIMIT 3"
).fetchall()
print("MA General search:", rows)
conn.close()
EOF
```

---

## Task 5: Create Trilliant fetch script

**File:** `scripts/fetch_hospital_trilliant.py`

- [ ] Create `scripts/fetch_hospital_trilliant.py`:

```python
#!/usr/bin/env python3
"""
Search Trilliant/Oria for a hospital, download its DuckDB, convert to SQLite cache.

Trilliant search: https://oria-data.trillianthealth.com/hospitals?q={query}
DuckDB pattern: https://oria-data.trillianthealth.com/data/{date}/completed/{slug}/{slug}_parsed.duckdb

Cache stored at: data/hospital_cache/{hospital_id}.sqlite (7-day TTL)

Usage:
  python3 scripts/fetch_hospital_trilliant.py "Mass General Hospital" --state MA
  python3 scripts/fetch_hospital_trilliant.py "Mayo Clinic" --state MN --phone 5072842511
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import tempfile
import time
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    import duckdb
except ImportError:
    print("ERROR: duckdb required. Run: pip install duckdb")
    sys.exit(1)

CACHE_DIR = Path(__file__).parent.parent / "data" / "hospital_cache"
SEARCH_BASE = "https://oria-data.trillianthealth.com/hospitals"
CACHE_TTL_DAYS = 7
USER_AGENT = "HospitalBillChecker/1.0"

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml",
}


def normalize_name(name: str) -> str:
    name = name.lower()
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    return re.sub(r"\s+", " ", name).strip()


def make_cache_path(hospital_id: str) -> Path:
    safe = re.sub(r"[^a-z0-9_-]", "_", hospital_id.lower())[:80]
    return CACHE_DIR / f"{safe}.sqlite"


def is_cache_fresh(path: Path) -> bool:
    if not path.exists():
        return False
    age = datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return age < timedelta(days=CACHE_TTL_DAYS)


def search_trilliant(query: str, state: str | None = None) -> list[dict]:
    """
    Search Trilliant and return list of hospital candidates:
    [{ name, city, state, duckdb_url, hospital_id }]
    """
    params = {"q": query}
    if state:
        params["q"] = f"{query} {state}"

    try:
        resp = requests.get(SEARCH_BASE, params=params, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  Trilliant search failed: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")

    candidates: list[dict] = []

    # Find all DuckDB download links
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "_parsed.duckdb" not in href:
            continue

        # Extract hospital ID from URL pattern:
        # /data/{date}/completed/{hospital_id}/{hospital_id}_parsed.duckdb
        match = re.search(r"/completed/([^/]+)/[^/]+_parsed\.duckdb", href)
        if not match:
            continue

        hospital_id = match.group(1)
        duckdb_url = href if href.startswith("http") else f"https://oria-data.trillianthealth.com{href}"

        # Try to extract name from surrounding context
        parent = link.find_parent(["div", "article", "li", "tr"])
        name_text = ""
        city_text = ""
        state_text = ""
        if parent:
            text = parent.get_text(" ", strip=True)
            # Heuristic: first line-ish text is usually the name
            lines = [l.strip() for l in text.split("\n") if l.strip()]
            if lines:
                name_text = lines[0]
            # Look for state pattern (2-letter)
            state_match = re.search(r"\b([A-Z]{2})\b", text)
            if state_match:
                state_text = state_match.group(1)

        candidates.append({
            "hospital_id": hospital_id,
            "name": name_text or hospital_id.replace("_", " ").title(),
            "city": city_text,
            "state": state_text,
            "duckdb_url": duckdb_url,
        })

    print(f"  Found {len(candidates)} candidates on Trilliant for '{query}'")
    return candidates


def download_duckdb(url: str, dest: Path) -> bool:
    """Download DuckDB file. Returns True on success."""
    print(f"  Downloading DuckDB from {url} ...")
    try:
        resp = requests.get(url, headers=HEADERS, stream=True, timeout=300)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        print(f"  Downloaded {len(resp.content):,} bytes → {dest}")
        return True
    except Exception as exc:
        print(f"  Download failed: {exc}")
        return False


def convert_duckdb_to_sqlite(duckdb_path: Path, sqlite_path: Path) -> bool:
    """
    Open DuckDB file, export key tables to SQLite.
    Returns True on success.
    """
    try:
        con = duckdb.connect(str(duckdb_path), read_only=True)

        # List available tables
        tables = con.execute("SHOW TABLES").fetchdf()["name"].tolist()
        print(f"  DuckDB tables: {tables}")

        sqlite_con = sqlite3.connect(str(sqlite_path))
        sqlite_con.execute("PRAGMA journal_mode=WAL")

        # Create charges table in SQLite
        sqlite_con.execute("""
            CREATE TABLE IF NOT EXISTS charges (
                code            TEXT,
                code_type       TEXT,
                description     TEXT,
                gross_charge    REAL,
                discounted_cash REAL,
                min_negotiated  REAL,
                max_negotiated  REAL,
                setting         TEXT,
                payer_name      TEXT,
                plan_name       TEXT
            )
        """)
        sqlite_con.execute("CREATE INDEX IF NOT EXISTS idx_charges_code ON charges(code)")

        # Create meta table
        sqlite_con.execute("""
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)
        """)

        # Find the charges/standard_charges table
        charge_table = None
        for t in tables:
            if "charge" in t.lower() or "standard" in t.lower():
                charge_table = t
                break
        if charge_table is None and tables:
            charge_table = tables[0]

        if charge_table:
            print(f"  Reading charges from table: {charge_table}")
            # Get column names
            cols = con.execute(f"DESCRIBE {charge_table}").fetchdf()["column_name"].tolist()
            print(f"  Columns: {cols[:10]}")

            # Map to our schema
            col_map = {
                "code": next((c for c in cols if "code" in c.lower() and "type" not in c.lower()), None),
                "code_type": next((c for c in cols if "code_type" in c.lower() or c.lower() in ("type", "code_type")), None),
                "description": next((c for c in cols if "desc" in c.lower() or "name" in c.lower()), None),
                "gross_charge": next((c for c in cols if "gross" in c.lower()), None),
                "discounted_cash": next((c for c in cols if "cash" in c.lower() or "discount" in c.lower()), None),
                "setting": next((c for c in cols if "setting" in c.lower() or "outpatient" in c.lower()), None),
            }
            print(f"  Column mapping: {col_map}")

            select_cols = []
            for dest_col in ["code", "code_type", "description", "gross_charge", "discounted_cash", "setting"]:
                src = col_map.get(dest_col)
                select_cols.append(f"{src} AS {dest_col}" if src else f"NULL AS {dest_col}")

            df = con.execute(f"SELECT {', '.join(select_cols)} FROM {charge_table}").fetchdf()
            print(f"  Fetched {len(df):,} charge rows")

            for _, row in df.iterrows():
                sqlite_con.execute("""INSERT INTO charges
                    (code, code_type, description, gross_charge, discounted_cash, setting)
                    VALUES (?,?,?,?,?,?)""", (
                    str(row.get("code", "") or "").strip().upper(),
                    str(row.get("code_type", "") or ""),
                    str(row.get("description", "") or ""),
                    float(row["gross_charge"]) if row.get("gross_charge") is not None else None,
                    float(row["discounted_cash"]) if row.get("discounted_cash") is not None else None,
                    str(row.get("setting", "") or ""),
                ))

        # Store metadata
        sqlite_con.execute("INSERT OR REPLACE INTO meta VALUES ('source', ?)", (str(duckdb_path.name),))
        sqlite_con.execute("INSERT OR REPLACE INTO meta VALUES ('converted_at', ?)",
                           (datetime.now(timezone.utc).isoformat(),))

        sqlite_con.commit()
        sqlite_con.close()
        con.close()
        return True

    except Exception as exc:
        print(f"  DuckDB conversion failed: {exc}")
        return False


def fetch_hospital_pricing(
    hospital_name: str,
    state: str | None = None,
    phone: str | None = None,
) -> Path | None:
    """
    Main entry point. Returns path to SQLite cache file, or None if failed.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Build a stable hospital_id for the cache
    hospital_id = normalize_name(hospital_name).replace(" ", "_")[:60]
    if state:
        hospital_id += f"_{state.lower()}"
    cache_path = make_cache_path(hospital_id)

    if is_cache_fresh(cache_path):
        print(f"  Using cached data: {cache_path}")
        return cache_path

    # Search Trilliant
    candidates = search_trilliant(hospital_name, state)
    if not candidates:
        print(f"  No Trilliant results for '{hospital_name}'")
        return None

    # Pick best match (first result for now — simple)
    best = candidates[0]
    print(f"  Selected: {best['name']} ({best['state']}) — {best['duckdb_url']}")

    # Download DuckDB to temp file
    with tempfile.NamedTemporaryFile(suffix=".duckdb", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    if not download_duckdb(best["duckdb_url"], tmp_path):
        tmp_path.unlink(missing_ok=True)
        return None

    # Convert to SQLite
    print(f"  Converting DuckDB → SQLite: {cache_path}")
    success = convert_duckdb_to_sqlite(tmp_path, cache_path)
    tmp_path.unlink(missing_ok=True)

    if not success:
        cache_path.unlink(missing_ok=True)
        return None

    return cache_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("hospital_name")
    parser.add_argument("--state", default=None)
    parser.add_argument("--phone", default=None)
    args = parser.parse_args()

    result = fetch_hospital_pricing(args.hospital_name, args.state, args.phone)
    if result:
        # Show sample charges
        conn = sqlite3.connect(str(result))
        total = conn.execute("SELECT COUNT(*) FROM charges").fetchone()[0]
        print(f"\nCached {total:,} charges at {result}")
        sample = conn.execute(
            "SELECT code, description, gross_charge, setting FROM charges WHERE code LIKE '9%' LIMIT 5"
        ).fetchall()
        for row in sample:
            print(f"  {row}")
        conn.close()
    else:
        print("Failed to fetch hospital pricing.")
        sys.exit(1)


if __name__ == "__main__":
    main()
```

---

## Task 6: Create hospital-prices-v2.ts

**File:** `src/lib/server/hospital-prices-v2.ts`

- [ ] Create `src/lib/server/hospital-prices-v2.ts`:

```typescript
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { getHospitalCacheDb } from './db'
import type { HospitalChargeRecord, HospitalPriceResult } from './hospital-prices'

const execFileAsync = promisify(execFile)
const FETCH_SCRIPT = join(process.cwd(), 'scripts', 'fetch_hospital_trilliant.py')
const FETCH_TIMEOUT_MS = 90_000

async function ensureTrilliantCache(
  hospitalName: string,
  state: string,
  phone?: string
): Promise<boolean> {
  const args = [FETCH_SCRIPT, hospitalName]
  if (state) args.push('--state', state)
  if (phone) args.push('--phone', phone)
  try {
    await execFileAsync('python3', args, { timeout: FETCH_TIMEOUT_MS })
    return true
  } catch (err) {
    console.warn(`[hospital-v2] Trilliant fetch failed for "${hospitalName}":`, err)
    return false
  }
}

function hospitalCacheId(hospitalName: string, state: string): string {
  return (hospitalName.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + state.toLowerCase()).slice(0, 80)
}

export async function lookupHospitalPricesV2(
  hospitalName: string,
  hospitalState: string,
  codes: string[],
  hospitalPhone?: string
): Promise<HospitalPriceResult | null> {
  const cacheId = hospitalCacheId(hospitalName, hospitalState)
  const cacheFile = join(process.cwd(), 'data', 'hospital_cache', `${cacheId}.sqlite`)

  // Ensure cache exists (trigger fetch if missing or stale)
  const cacheExists = existsSync(cacheFile) &&
    (Date.now() - statSync(cacheFile).mtimeMs) < 7 * 86_400_000

  if (!cacheExists) {
    const ok = await ensureTrilliantCache(hospitalName, hospitalState, hospitalPhone)
    if (!ok) return null
  }

  const db = getHospitalCacheDb(cacheId)
  if (!db) return null

  const charges: Record<string, HospitalChargeRecord> = {}

  for (const code of codes) {
    const row = db.prepare(`
      SELECT code, description, gross_charge, discounted_cash, min_negotiated, max_negotiated, setting
      FROM charges
      WHERE code = ?
      ORDER BY
        CASE WHEN setting = 'outpatient' THEN 0 WHEN setting = 'both' THEN 1 ELSE 2 END,
        COALESCE(gross_charge, discounted_cash, 0) DESC
      LIMIT 1
    `).get(code.toUpperCase().trim()) as {
      code: string; description: string | null;
      gross_charge: number | null; discounted_cash: number | null;
      min_negotiated: number | null; max_negotiated: number | null;
      setting: string | null;
    } | undefined

    if (row) {
      charges[code] = {
        code: row.code,
        description: row.description ?? '',
        grossCharge: row.gross_charge,
        discountedCash: row.discounted_cash,
        minNegotiated: row.min_negotiated,
        maxNegotiated: row.max_negotiated,
        setting: row.setting ?? '',
      }
    }
  }

  if (Object.keys(charges).length === 0) return null

  const meta = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>
  const metaObj = Object.fromEntries(meta.map(r => [r.key, r.value]))

  return {
    hospitalName,
    mrfUrl: metaObj.source ?? '',
    fetchedAt: metaObj.converted_at ?? new Date().toISOString(),
    charges,
  }
}
```

- [ ] Run: `npm run check`

---

## Task 7: Build the directory

- [ ] Run:

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_hospital_directory_sqlite.py
```

- [ ] Test the Trilliant fetch (requires internet):

```bash
python3 scripts/fetch_hospital_trilliant.py "Massachusetts General Hospital" --state MA
```

---

## Task 8: Remove old hospital_index.json

- [ ] `rm src/lib/data/hospital_index.json`
- [ ] `npm run check && npm run build`

---

## Task 9: Tests

```typescript
describe('hospital directory sqlite', () => {
  it.skipIf(!existsSync('data/hospital_directory.sqlite'))('has hospitals', () => {
    const db = new Database('data/hospital_directory.sqlite', { readonly: true })
    const count = db.prepare('SELECT COUNT(*) as c FROM hospitals').get() as { c: number }
    expect(count.c).toBeGreaterThan(1000)
    db.close()
  })

  it.skipIf(!existsSync('data/hospital_directory.sqlite'))('can search by name', () => {
    const db = new Database('data/hospital_directory.sqlite', { readonly: true })
    const rows = db.prepare(
      "SELECT hospital_name FROM hospitals WHERE normalized_name LIKE ? LIMIT 3"
    ).all('%general%') as Array<{ hospital_name: string }>
    expect(rows.length).toBeGreaterThan(0)
    db.close()
  })
})
```

- [ ] `npm run test`

---

## Task 10: Commit

```bash
cd /root/projects/hospital-bill-checker
git add scripts/build_hospital_directory_sqlite.py scripts/fetch_hospital_trilliant.py \
        scripts/requirements.txt src/lib/server/hospital-prices-v2.ts \
        src/lib/server/data-loader.test.ts
git rm --cached src/lib/data/hospital_index.json 2>/dev/null || true
git commit -m "feat: hospital directory sqlite + trilliant on-demand pricing"
```

---

## Monthly refresh

Run: `python3 scripts/build_hospital_directory_sqlite.py` monthly (CMS Hospital General Info updates ~monthly).
Hospital cache files in `data/hospital_cache/` refresh automatically when TTL (7 days) expires.
