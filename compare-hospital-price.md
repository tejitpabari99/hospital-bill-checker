# Compare Against Hospital Prices — Feature Specification

_Written: 2026-03-31. Target branch: `feature/hospital-price-compare`_

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Data Sources](#2-data-sources)
3. [Data Ingestion Scripts](#3-data-ingestion-scripts)
4. [Data Storage Schema](#4-data-storage-schema)
5. [Backend Integration](#5-backend-integration)
6. [Frontend Integration](#6-frontend-integration)
7. [TypeScript Types](#7-typescript-types)
8. [Test Plan](#8-test-plan)
9. [Deployment Steps](#9-deployment-steps)
10. [Fallback Behavior](#10-fallback-behavior)

---

## 1. Feature Overview

### What it does

Every US hospital is legally required by CMS (45 CFR Part 180) to publish a machine-readable file (MRF) listing their gross charges, discounted cash prices, and payer-specific negotiated rates for every billable service. This feature downloads and indexes that file for the specific hospital identified on the user's bill, then shows three columns for every flagged line item:

- **Billed** — what the hospital actually charged the patient
- **Hospital's own price** — the hospital's gross charge or discounted cash price for that CPT code
- **Medicare benchmark** — the existing MPFS rate

A charge that exceeds the hospital's own published price is unambiguous evidence of overbilling and strengthens any dispute letter considerably.

### Why it matters

The current tool compares billed charges against Medicare rates, which a hospital can always argue are irrelevant ("we're not a Medicare-only facility"). A comparison against the **hospital's own published chargemaster** removes that counterargument entirely. If a hospital published a gross charge of $450 for CPT 99285 but billed you $1,200, that is a straightforward factual discrepancy between two public documents.

### User-facing value

- Results page gains a third price column: "Hospital's published price"
- Summary strip gains a new stat: "Above hospital's own price list"
- Dispute letter gains a new paragraph citing the hospital's own MRF URL as evidence
- When hospital data is unavailable, the existing Medicare-only view is shown with an explanatory note

### Scope boundaries

This feature does **not**:
- Look up insurance negotiated rates (payer-specific columns in MRFs are large and variable; that is a follow-on feature)
- Let users upload their own MRF
- Work for physicians' practice bills (only facility/hospital MRFs are in scope)

---

## 2. Data Sources

### 2.1 CMS Price Transparency Rule — the MRF

**Regulation:** 45 CFR Part 180. Effective January 1, 2021, enforced with escalating penalties since 2022.

**What hospitals must publish:** A single machine-readable file containing:
- Gross charge (chargemaster price)
- Discounted cash price (what a self-pay patient is charged)
- Payer-specific negotiated rates (one row per payer per service)
- De-identified min/max negotiated charges
- Estimated allowed amounts (required from January 2025)

**Permitted file formats (as of July 1, 2024):** JSON, CSV "tall", or CSV "wide" using the CMS template. Excel and XML are non-compliant.

**File naming convention:** `[ein]_[hospital-name]_standardcharges.[json|csv]`

**File sizes:** Range from ~5 MB for small critical access hospitals to >2 GB for large academic medical centers with thousands of payer–service combinations.

### 2.2 cms-hpt.txt — The Machine-Discoverable Index

Every hospital must publish a file at one of these two paths on their public website:
```
https://[hospital-domain]/cms-hpt.txt
https://[hospital-domain]/.well-known/cms-hpt.txt
```

The file uses a key:value text format:
```
location-name: General Hospital Main Campus
source-page-url: https://generalhospital.org/patients/billing/
mrf-url: https://generalhospital.org/files/123456789_generalhospital_standardcharges.json
contact-name: Billing Compliance
contact-email: billing@generalhospital.org

location-name: General Hospital North Campus
source-page-url: https://generalhospital.org/patients/billing/north/
mrf-url: https://generalhospital.org/files/123456789_generalhospital-north_standardcharges.json
contact-name: Billing Compliance
contact-email: billing@generalhospital.org
```

This is the starting point for automated MRF discovery.

### 2.3 CMS Hospital General Information Dataset

CMS publishes a catalog of all Medicare-registered hospitals with NPI numbers, hospital names, addresses, and CCN (CMS Certification Number).

**API endpoint (JSON):**
```
https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0
```

**Direct CSV download:**
```
https://data.cms.gov/provider-data/sites/default/files/resources/092256becd267d9eecca15f2a4f206c1_1694479371/Hospital_General_Information.csv
```

This dataset maps hospital names (as printed on bills) to their domain names and NPI numbers. Fields used: `Facility Name`, `Address`, `City/Town`, `State`, `ZIP Code`, `Phone Number`, `NPI Number`.

**Update cadence:** Monthly.

### 2.4 DoltHub Hospital Price Transparency Dataset (supplemental, offline only)

DoltHub maintains a Dolt database of MRFs scraped from over 1,000 hospitals. It is the best freely available pre-aggregated dataset. However, it has not been actively updated since mid-2024. Useful for offline development and testing only, not for production lookups.

```
# Install dolt (https://docs.dolthub.com/introduction/installation)
dolt clone dolthub/transparency-in-pricing
```

**Do not use this as the production data source.** It is outdated and incomplete. The production path is on-demand MRF fetching from the hospital's own published URL.

### 2.5 CMS HPT Validator CLI (for schema validation during ingest)

```
https://github.com/CMSgov/hpt-validator-cli
```

Useful to validate that a downloaded MRF conforms to the CMS template before parsing it.

### 2.6 Data Availability Reality Check

As of early 2026:
- ~90% of hospitals have posted an MRF file
- ~75% are broadly compliant with the format requirement
- ~21% are fully compliant with all data quality requirements
- Large hospitals (>500 beds) have near-universal coverage
- Critical access hospitals (~1,300 in the US) often post minimal files

**Production strategy:** Attempt on-demand MRF fetch for the specific hospital identified on the bill. Cache the parsed result for 24 hours on disk. If fetch fails or the file does not contain the queried CPT code, show the Medicare-only view with an explanatory note.

---

## 3. Data Ingestion Scripts

### 3.1 Overview of New Scripts

Two new Python scripts go in `/scripts/`:

| Script | Purpose | Run cadence |
|--------|---------|-------------|
| `build_hospital_index.py` | Downloads CMS Hospital General Information CSV, builds a name→domain→NPI lookup JSON | Monthly |
| `fetch_hospital_mrf.py` | Given a hospital name or NPI, fetches the hospital's cms-hpt.txt, follows the MRF URL, parses the CMS JSON/CSV, and writes a per-hospital SQLite file | On-demand (at audit time) |

### 3.2 `scripts/build_hospital_index.py`

This script builds the "hospital index" — a static JSON that maps hospital names to their web domains and NPI numbers. This is used to find a hospital's website when only a name appears on the bill.

```python
#!/usr/bin/env python3
"""
Build hospital name → website domain + NPI lookup JSON.

Source: CMS Hospital General Information dataset (monthly updated).
Output: src/lib/data/hospital_index.json

Usage:
    python3 scripts/build_hospital_index.py
"""

import json
import csv
import io
import urllib.request
import re
import unicodedata
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "hospital_index.json"

# CMS Hospital General Information CSV — monthly updated
# Dataset: https://data.cms.gov/provider-data/dataset/xubh-q36u
HOSPITAL_INFO_URL = (
    "https://data.cms.gov/provider-data/sites/default/files/resources/"
    "092256becd267d9eecca15f2a4f206c1_1694479371/Hospital_General_Information.csv"
)

def normalize_name(name: str) -> str:
    """
    Lowercase, strip punctuation, collapse whitespace.
    Used as the lookup key so fuzzy matching works across slight name variations.
    Example: "St. Mary's Medical Center" → "st marys medical center"
    """
    name = name.lower()
    name = unicodedata.normalize("NFKD", name)
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name

def main():
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    print(f"Downloading CMS Hospital General Information from {HOSPITAL_INFO_URL}...")
    try:
        req = urllib.request.Request(HOSPITAL_INFO_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            content = resp.read().decode("utf-8", errors="replace")
        print(f"Downloaded {len(content):,} bytes")
    except Exception as e:
        print(f"Download failed: {e}")
        print("Run this script with network access to build the hospital index.")
        raise SystemExit(1)

    reader = csv.DictReader(io.StringIO(content))
    index: dict[str, dict] = {}  # normalized_name → entry

    for row in reader:
        # CSV columns (from CMS dataset):
        # Facility Name, Address, City/Town, State, ZIP Code, County/Parish,
        # Phone Number, Hospital Type, Hospital Ownership, Emergency Services,
        # Meets criteria for meaningful use of EHRs, Hospital overall rating,
        # Hospital overall rating footnote, MORT Group Measure Count, ...
        # NPI Number is in a separate dataset; we join by CCN/facility name

        name = (row.get("Facility Name") or "").strip()
        city = (row.get("City/Town") or "").strip()
        state = (row.get("State") or "").strip()
        zipcode = (row.get("ZIP Code") or "").strip()
        phone = (row.get("Phone Number") or "").strip()
        facility_id = (row.get("Facility ID") or "").strip()  # This is the CCN

        if not name:
            continue

        norm = normalize_name(name)
        # Key: "normalized_name|state" to disambiguate same-name hospitals in different states
        key = f"{norm}|{state.lower()}"

        index[key] = {
            "name": name,
            "city": city,
            "state": state,
            "zip": zipcode,
            "phone": phone,
            "ccn": facility_id,  # CMS Certification Number
            # domain is not in this dataset — it will be populated by a
            # separate enrichment step or left null for on-demand lookup
            "domain": None,
            "npi": None,
        }

    print(f"Built index with {len(index):,} hospitals")
    OUTPUT_PATH.write_text(json.dumps(index, indent=2))
    print(f"Wrote to {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
```

**Important note:** The CMS Hospital General Information CSV does not include hospital website domains. The domain must be inferred at runtime from the hospital name. See section 5.2 for the domain inference logic used during live lookups.

### 3.3 `scripts/fetch_hospital_mrf.py`

This script fetches the MRF for a specific hospital and writes a compact SQLite database file. It is called **at audit time** by the server (not pre-built). It can also be run manually to pre-cache an MRF.

```python
#!/usr/bin/env python3
"""
Fetch and parse a hospital's price transparency MRF.

Given a hospital name (and optionally state), this script:
1. Finds the hospital's website domain (via Google-style name search or heuristic)
2. Fetches /cms-hpt.txt from that domain
3. Follows the mrf-url in the txt file
4. Parses the CMS JSON or CSV MRF
5. Writes a compact SQLite file: data/mrf_cache/{ccn}.db

Usage:
    python3 scripts/fetch_hospital_mrf.py "General Hospital" --state TX
    python3 scripts/fetch_hospital_mrf.py --ccn 450123

Output file: data/mrf_cache/{ccn_or_slug}.db
Schema: see section 4.2 of the spec.
"""

import json
import csv
import sqlite3
import io
import re
import sys
import os
import time
import gzip
import zipfile
import urllib.request
import urllib.error
import urllib.parse
import argparse
import unicodedata
from pathlib import Path

CACHE_DIR = Path(__file__).parent.parent / "data" / "mrf_cache"
INDEX_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "hospital_index.json"

USER_AGENT = "HospitalBillChecker/1.0 (open-source patient billing audit tool; contact@hospitalbillchecker.com)"

# ── Utilities ──────────────────────────────────────────────────────────────────

def normalize_name(name: str) -> str:
    name = name.lower()
    name = unicodedata.normalize("NFKD", name)
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name

def http_get(url: str, timeout: int = 60) -> bytes:
    """Fetch URL bytes, following redirects, supporting gzip responses."""
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept-Encoding": "gzip, deflate",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        enc = resp.headers.get("Content-Encoding", "")
        if enc == "gzip":
            data = gzip.decompress(data)
        return data

# ── Step 1: Find hospital domain ───────────────────────────────────────────────

def guess_domain_heuristics(hospital_name: str, state: str) -> list[str]:
    """
    Generate plausible domain guesses from the hospital name.
    Returns a list to try in order.

    Examples:
      "General Hospital" → ["generalhospital.org", "generalhospital.com"]
      "St. Mary's Medical Center" → ["stmarysmedicalcenter.org", "stmarys.org"]
      "UCSF Medical Center" → ["ucsfhealth.org", "ucsf.edu"]
    """
    slug = normalize_name(hospital_name)
    slug = re.sub(r"\b(hospital|medical center|health system|health|center|regional|community|memorial)\b", "", slug)
    slug = re.sub(r"\s+", "", slug.strip())

    full_slug = re.sub(r"\s+", "", normalize_name(hospital_name))

    candidates = []
    for s in [full_slug, slug]:
        if s:
            candidates.append(f"https://www.{s}.org")
            candidates.append(f"https://www.{s}.com")
            candidates.append(f"https://{s}.org")
    return candidates

def find_mrf_url_from_domain(domain: str) -> str | None:
    """
    Given a hospital domain, attempt to fetch /cms-hpt.txt or /.well-known/cms-hpt.txt
    and extract the first mrf-url value.
    Returns the MRF URL string or None if not found.
    """
    for path in ["/cms-hpt.txt", "/.well-known/cms-hpt.txt"]:
        url = domain.rstrip("/") + path
        try:
            data = http_get(url, timeout=15)
            text = data.decode("utf-8", errors="replace")
            # Parse key:value format
            for line in text.splitlines():
                line = line.strip()
                if line.lower().startswith("mrf-url:"):
                    mrf_url = line.split(":", 1)[1].strip()
                    if mrf_url.startswith("http"):
                        return mrf_url
        except Exception:
            continue
    return None

def resolve_hospital_domain(hospital_name: str, state: str = "") -> tuple[str | None, str | None]:
    """
    Try to find the hospital domain and MRF URL.
    Returns (domain, mrf_url) or (None, None).
    """
    candidates = guess_domain_heuristics(hospital_name, state)
    for domain in candidates:
        try:
            # Quick HEAD check that the domain exists
            req = urllib.request.Request(domain, method="HEAD", headers={"User-Agent": USER_AGENT})
            urllib.request.urlopen(req, timeout=10)
            # Domain responded — now look for the MRF txt file
            mrf_url = find_mrf_url_from_domain(domain)
            if mrf_url:
                print(f"Found MRF URL via {domain}: {mrf_url}")
                return domain, mrf_url
        except Exception:
            continue
    return None, None

# ── Step 2: Download and decompress the MRF ───────────────────────────────────

def download_mrf(mrf_url: str) -> bytes:
    """
    Download the MRF file. Supports .gz and .zip compression.
    Raises on failure.
    Note: files can be 50MB–2GB. Reads into memory.
    For very large files a streaming parse should be used (see parse_mrf_json_stream).
    """
    print(f"Downloading MRF: {mrf_url}")
    data = http_get(mrf_url, timeout=300)
    print(f"Downloaded {len(data):,} bytes")

    # Decompress if needed
    if mrf_url.endswith(".gz") or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
        print(f"Decompressed to {len(data):,} bytes")
    elif mrf_url.endswith(".zip") or data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if n.endswith(".json") or n.endswith(".csv")]
            if not names:
                raise ValueError("ZIP contains no JSON or CSV files")
            data = z.read(names[0])
            print(f"Extracted {names[0]}: {len(data):,} bytes")

    return data

# ── Step 3: Parse MRF data ────────────────────────────────────────────────────

def parse_mrf_json(data: bytes) -> list[dict]:
    """
    Parse a CMS-format JSON MRF and return a flat list of charge records.

    CMS JSON MRF top-level structure (v3.0 schema):
    {
      "hospital_name": "...",
      "last_updated_on": "2024-11-01",
      "version": "3.0.0",
      "hospital_location": [...],
      "hospital_address": [...],
      "license_information": {...},
      "standard_charge_information": [
        {
          "description": "COMPREHENSIVE METABOLIC PANEL",
          "drug_information": {...},   // optional, for drugs
          "code_information": [
            { "code": "80053", "type": "CPT" }
          ],
          "standard_charges": [
            {
              "minimum_negotiated_rate": 45.00,
              "maximum_negotiated_rate": 210.00,
              "gross_charge": 350.00,
              "discounted_cash": 175.00,
              "setting": "outpatient",   // "inpatient" | "outpatient" | "both"
              "payers_information": [
                {
                  "payer_name": "Aetna",
                  "plan_name": "HMO",
                  "additional_generic_notes": "",
                  "standard_charge_dollar": 120.00,
                  "standard_charge_percent": null,
                  "standard_charge_algorithm": null,
                  "estimated_allowed_amount": 120.00
                }
              ]
            }
          ]
        }
      ]
    }

    Returns flat records:
    [
      {
        "code": "80053",
        "code_type": "CPT",
        "description": "COMPREHENSIVE METABOLIC PANEL",
        "gross_charge": 350.00,
        "discounted_cash": 175.00,
        "min_negotiated": 45.00,
        "max_negotiated": 210.00,
        "setting": "outpatient"
      },
      ...
    ]
    """
    obj = json.loads(data.decode("utf-8", errors="replace"))

    records = []
    for item in obj.get("standard_charge_information", []):
        description = item.get("description", "")
        codes = item.get("code_information", [])

        # A single charge item may have multiple codes (CPT, HCPCS, etc.)
        for code_info in codes:
            code = (code_info.get("code") or "").strip()
            code_type = (code_info.get("type") or "").strip().upper()

            # Only keep CPT and HCPCS codes — skip DRG, NDC, RC, CDM, LOCAL
            if code_type not in ("CPT", "HCPCS"):
                continue
            if not code:
                continue

            for sc in item.get("standard_charges", []):
                gross = sc.get("gross_charge")
                cash = sc.get("discounted_cash")
                min_neg = sc.get("minimum_negotiated_rate")
                max_neg = sc.get("maximum_negotiated_rate")
                setting = sc.get("setting", "")

                # At least one price must be present
                if gross is None and cash is None:
                    continue

                records.append({
                    "code": code,
                    "code_type": code_type,
                    "description": description,
                    "gross_charge": float(gross) if gross is not None else None,
                    "discounted_cash": float(cash) if cash is not None else None,
                    "min_negotiated": float(min_neg) if min_neg is not None else None,
                    "max_negotiated": float(max_neg) if max_neg is not None else None,
                    "setting": setting,
                })

    print(f"Parsed {len(records):,} charge records from JSON MRF")
    return records


def parse_mrf_csv_tall(data: bytes) -> list[dict]:
    """
    Parse a CMS-format CSV "tall" MRF.

    CMS CSV tall format columns (required):
      hospital_name, last_updated_on, version, hospital_location,
      hospital_address, license_information,
      description, setting, drug_unit_of_measurement, drug_type_of_measurement,
      modifiers, standard_charge|gross, standard_charge|discounted_cash,
      standard_charge|min, standard_charge|max,
      standard_charge|[payer_name]|[plan_name]|negotiated_dollar,
      standard_charge|[payer_name]|[plan_name]|negotiated_percent,
      standard_charge|[payer_name]|[plan_name]|negotiated_algorithm,
      standard_charge|[payer_name]|[plan_name]|estimated_allowed_amount,
      code|[n]|[type]   (one column per code, e.g., code|1|CPT, code|2|HCPCS)

    We only extract the columns we need.
    """
    text = data.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    records = []

    for row in reader:
        # Normalize header names to lowercase stripped
        norm = {k.strip().lower(): (v or "").strip() for k, v in row.items()}

        description = norm.get("description", "")
        setting = norm.get("setting", "")

        # Find code columns: "code|1|cpt", "code|2|hcpcs", etc.
        code_cols = {k: v for k, v in norm.items() if k.startswith("code|") and v}
        if not code_cols:
            continue

        gross_str = norm.get("standard_charge|gross", "") or norm.get("standard_charge_gross", "")
        cash_str = norm.get("standard_charge|discounted_cash", "") or norm.get("standard_charge_discounted_cash", "")
        min_str = norm.get("standard_charge|min", "") or norm.get("standard_charge_minimum", "")
        max_str = norm.get("standard_charge|max", "") or norm.get("standard_charge_maximum", "")

        def parse_dollar(s: str) -> float | None:
            s = s.replace("$", "").replace(",", "").strip()
            try:
                v = float(s)
                return v if v > 0 else None
            except ValueError:
                return None

        gross = parse_dollar(gross_str)
        cash = parse_dollar(cash_str)
        min_neg = parse_dollar(min_str)
        max_neg = parse_dollar(max_str)

        if gross is None and cash is None:
            continue

        # Emit one record per CPT/HCPCS code found in this row
        for col_key, code_val in code_cols.items():
            parts = col_key.split("|")
            code_type = parts[2].upper() if len(parts) >= 3 else ""
            if code_type not in ("CPT", "HCPCS"):
                continue
            code = code_val.strip()
            if not code:
                continue

            records.append({
                "code": code,
                "code_type": code_type,
                "description": description,
                "gross_charge": gross,
                "discounted_cash": cash,
                "min_negotiated": min_neg,
                "max_negotiated": max_neg,
                "setting": setting,
            })

    print(f"Parsed {len(records):,} charge records from CSV MRF")
    return records


def detect_and_parse_mrf(data: bytes, mrf_url: str) -> list[dict]:
    """Auto-detect format (JSON vs CSV) and parse accordingly."""
    stripped = data.lstrip()
    if stripped.startswith(b"{") or stripped.startswith(b"["):
        return parse_mrf_json(data)
    # Try CSV
    return parse_mrf_csv_tall(data)

# ── Step 4: Write SQLite cache ─────────────────────────────────────────────────

def write_sqlite(records: list[dict], db_path: Path, hospital_name: str, mrf_url: str) -> None:
    """
    Write parsed charge records to a compact SQLite database.
    Schema described in section 4.2 of the spec.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    c = conn.cursor()

    c.executescript("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS charges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            code_type TEXT NOT NULL,
            description TEXT,
            gross_charge REAL,
            discounted_cash REAL,
            min_negotiated REAL,
            max_negotiated REAL,
            setting TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_code ON charges(code);
    """)

    # Write metadata
    import datetime
    c.execute("INSERT OR REPLACE INTO meta VALUES ('hospital_name', ?)", (hospital_name,))
    c.execute("INSERT OR REPLACE INTO meta VALUES ('mrf_url', ?)", (mrf_url,))
    c.execute("INSERT OR REPLACE INTO meta VALUES ('fetched_at', ?)", (datetime.datetime.utcnow().isoformat(),))

    # Write charge records in batches
    batch = [
        (r["code"], r["code_type"], r["description"],
         r["gross_charge"], r["discounted_cash"],
         r["min_negotiated"], r["max_negotiated"],
         r["setting"])
        for r in records
    ]
    c.executemany(
        "INSERT INTO charges (code, code_type, description, gross_charge, discounted_cash, min_negotiated, max_negotiated, setting) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        batch
    )

    conn.commit()
    conn.close()
    print(f"Wrote {len(records):,} records to {db_path}")

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch and cache a hospital MRF")
    parser.add_argument("hospital_name", nargs="?", help="Hospital name (e.g. 'Memorial Hospital')")
    parser.add_argument("--state", default="", help="Two-letter state code (e.g. TX)")
    parser.add_argument("--ccn", default="", help="CMS Certification Number if known")
    parser.add_argument("--mrf-url", default="", help="Direct MRF URL (skip discovery)")
    args = parser.parse_args()

    if not args.hospital_name and not args.ccn:
        parser.print_help()
        sys.exit(1)

    hospital_name = args.hospital_name or args.ccn

    # Determine output file path
    slug = re.sub(r"[^a-z0-9]", "_", normalize_name(hospital_name))[:60]
    db_filename = f"{args.ccn or slug}.db"
    db_path = CACHE_DIR / db_filename

    # Check if cache is fresh (< 24 hours)
    if db_path.exists():
        age_hours = (time.time() - db_path.stat().st_mtime) / 3600
        if age_hours < 24:
            print(f"Cache is fresh ({age_hours:.1f}h old): {db_path}")
            sys.exit(0)

    # Find MRF URL
    mrf_url = args.mrf_url
    if not mrf_url:
        domain, mrf_url = resolve_hospital_domain(hospital_name, args.state)
        if not mrf_url:
            print(f"ERROR: Could not find MRF for '{hospital_name}' (state={args.state})")
            print("Try providing --mrf-url directly.")
            sys.exit(2)

    # Download and parse
    raw = download_mrf(mrf_url)
    records = detect_and_parse_mrf(raw, mrf_url)

    if not records:
        print("ERROR: No charge records parsed from MRF")
        sys.exit(3)

    # Write to SQLite
    write_sqlite(records, db_path, hospital_name, mrf_url)
    print(f"Done. Cache written to: {db_path}")

if __name__ == "__main__":
    main()
```

### 3.4 Running the scripts

```bash
# Build the hospital name index (run monthly)
python3 scripts/build_hospital_index.py

# Manually pre-cache a specific hospital (optional — the server does this on demand)
python3 scripts/fetch_hospital_mrf.py "Memorial Hermann Hospital" --state TX

# Direct URL if you already know the MRF location
python3 scripts/fetch_hospital_mrf.py "General Hospital" --mrf-url https://hospital.org/files/standard-charges.json
```

---

## 4. Data Storage Schema

### 4.1 Hospital Index JSON

**Path:** `src/lib/data/hospital_index.json`
**Built by:** `build_hospital_index.py`
**Size:** ~2–4 MB (all ~6,000 Medicare-registered hospitals)
**Committed to repo:** Yes (like mpfs.json, ncci.json, asp.json)

```json
{
  "memorial hospital|tx": {
    "name": "Memorial Hospital",
    "city": "Houston",
    "state": "TX",
    "zip": "77030",
    "phone": "7135550000",
    "ccn": "450123",
    "domain": null,
    "npi": null
  },
  "st marys medical center|ca": {
    "name": "St. Mary's Medical Center",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94117",
    "phone": "4155550000",
    "ccn": "050001",
    "domain": null,
    "npi": null
  }
}
```

The `domain` and `npi` fields are `null` in the base build (the CMS CSV does not include websites). They are populated during live resolution if a domain is successfully found.

### 4.2 Per-Hospital MRF Cache (SQLite)

**Path:** `data/mrf_cache/{ccn_or_slug}.db`  
**Built by:** `fetch_hospital_mrf.py` (on-demand at audit time)  
**Size:** 1–50 MB per hospital depending on MRF size  
**Committed to repo:** No (gitignored — runtime artifact like `data/stats.json`)  
**Add to `.gitignore`:** `data/mrf_cache/`

SQLite schema:

```sql
-- Metadata about this cache file
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
-- Populated with:
-- hospital_name: "Memorial Hospital"
-- mrf_url:       "https://hospital.org/files/standard-charges.json"
-- fetched_at:    "2026-03-31T14:22:00"

-- Charge records extracted from the MRF
CREATE TABLE charges (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    code           TEXT NOT NULL,    -- CPT or HCPCS code, e.g. "80053"
    code_type      TEXT NOT NULL,    -- "CPT" or "HCPCS"
    description    TEXT,             -- e.g. "COMPREHENSIVE METABOLIC PANEL"
    gross_charge   REAL,             -- hospital's chargemaster price
    discounted_cash REAL,            -- cash/self-pay price
    min_negotiated REAL,             -- de-identified minimum negotiated rate
    max_negotiated REAL,             -- de-identified maximum negotiated rate
    setting        TEXT              -- "inpatient" | "outpatient" | "both" | ""
);

CREATE INDEX idx_code ON charges(code);
```

**Lookup query used at audit time:**

```sql
SELECT
    code,
    description,
    gross_charge,
    discounted_cash,
    min_negotiated,
    max_negotiated,
    setting
FROM charges
WHERE code = ?
ORDER BY gross_charge DESC
LIMIT 1;
```

If multiple rows exist for the same code (can happen when the same service has different rows for inpatient vs outpatient), prefer the row matching setting="outpatient", then fall back to any row.

---

## 5. Backend Integration

### 5.1 New file: `src/lib/server/hospital-prices.ts`

This is the main server-side module for hospital price lookups. It is called from `claude.ts` during audit enrichment.

```typescript
// src/lib/server/hospital-prices.ts
// On-demand hospital price transparency MRF lookup.
// Spawns fetch_hospital_mrf.py if the cache is missing/stale, then queries SQLite.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)

const CACHE_DIR = join(process.cwd(), 'data', 'mrf_cache')
const FETCH_SCRIPT = join(process.cwd(), 'scripts', 'fetch_hospital_mrf.py')
const FETCH_TIMEOUT_MS = 45_000  // 45s max to fetch + parse an MRF

export interface HospitalChargeRecord {
  code: string
  description: string
  grossCharge: number | null
  discountedCash: number | null
  minNegotiated: number | null
  maxNegotiated: number | null
  setting: string
}

export interface HospitalPriceResult {
  hospitalName: string
  mrfUrl: string
  fetchedAt: string
  charges: Record<string, HospitalChargeRecord>  // code → record
}

/**
 * Normalize a hospital name to a filesystem-safe slug for cache file naming.
 * Matches the slug logic in fetch_hospital_mrf.py.
 */
function hospitalSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60)
}

/**
 * Check if a SQLite cache file exists and is fresh (less than 24 hours old).
 */
function isCacheFresh(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false
  const ageSecs = (Date.now() - statSync(dbPath).mtimeMs) / 1000
  return ageSecs < 86_400  // 24 hours
}

/**
 * Spawn fetch_hospital_mrf.py to build or refresh the SQLite cache.
 * Returns true on success, false on failure.
 */
async function ensureCache(hospitalName: string, state: string, dbPath: string): Promise<boolean> {
  try {
    const args = [FETCH_SCRIPT, hospitalName]
    if (state) args.push('--state', state)
    await execFileAsync('python3', args, { timeout: FETCH_TIMEOUT_MS })
    return existsSync(dbPath)
  } catch (err) {
    console.warn(`[hospital-prices] MRF fetch failed for "${hospitalName}":`, err)
    return false
  }
}

/**
 * Query the SQLite cache for a list of CPT/HCPCS codes.
 * Returns a map of code → charge record.
 */
function queryCache(dbPath: string, codes: string[]): HospitalPriceResult | null {
  let db: Database.Database
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }

  try {
    // Read metadata
    const meta = Object.fromEntries(
      (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[])
        .map(r => [r.key, r.value])
    )

    const charges: Record<string, HospitalChargeRecord> = {}

    for (const code of codes) {
      // Prefer outpatient setting when there are multiple rows
      const row = (db.prepare(`
        SELECT code, description, gross_charge, discounted_cash, min_negotiated, max_negotiated, setting
        FROM charges
        WHERE code = ?
        ORDER BY
          CASE WHEN setting = 'outpatient' THEN 0
               WHEN setting = 'both' THEN 1
               ELSE 2 END,
          gross_charge DESC
        LIMIT 1
      `).get(code)) as {
        code: string; description: string;
        gross_charge: number | null; discounted_cash: number | null;
        min_negotiated: number | null; max_negotiated: number | null;
        setting: string
      } | undefined

      if (row) {
        charges[code] = {
          code: row.code,
          description: row.description,
          grossCharge: row.gross_charge,
          discountedCash: row.discounted_cash,
          minNegotiated: row.min_negotiated,
          maxNegotiated: row.max_negotiated,
          setting: row.setting,
        }
      }
    }

    return {
      hospitalName: meta.hospital_name ?? '',
      mrfUrl: meta.mrf_url ?? '',
      fetchedAt: meta.fetched_at ?? '',
      charges,
    }
  } finally {
    db.close()
  }
}

/**
 * Main export: look up hospital prices for the given codes.
 *
 * @param hospitalName  Hospital name extracted from the bill (e.g. "Memorial Hermann")
 * @param state         Optional two-letter state (improves name matching)
 * @param codes         List of CPT/HCPCS codes to look up
 * @returns             HospitalPriceResult or null if hospital data unavailable
 */
export async function lookupHospitalPrices(
  hospitalName: string,
  state: string,
  codes: string[]
): Promise<HospitalPriceResult | null> {
  if (!hospitalName || codes.length === 0) return null

  const slug = hospitalSlug(hospitalName)
  const dbPath = join(CACHE_DIR, `${slug}.db`)

  // Use cache if fresh
  if (!isCacheFresh(dbPath)) {
    const ok = await ensureCache(hospitalName, state, dbPath)
    if (!ok) return null
  }

  return queryCache(dbPath, codes)
}
```

**Dependency: `better-sqlite3`**

Add to `package.json`:
```bash
bun add better-sqlite3
bun add -d @types/better-sqlite3
```

`better-sqlite3` is a synchronous SQLite binding for Node.js. It is the right choice here because SQLite reads are fast and synchronous, avoiding async overhead for a local file query.

### 5.2 Changes to `src/lib/server/claude.ts`

Add hospital price enrichment as a post-processing step after the Gemini audit call returns. This does not change the Gemini prompt — hospital prices are enriched server-side using the extracted metadata.

**Add import at the top of `claude.ts`:**
```typescript
import { lookupHospitalPrices } from './hospital-prices'
```

**Replace the `return { ...call1Result, ...call2Result }` line at the bottom of `auditBill()` with:**

```typescript
  // ── Hospital price enrichment ────────────────────────────────────────────
  // After both Gemini calls succeed, enrich findings with hospital's own MRF prices.
  // This runs server-side and does NOT add to Gemini latency.

  const hospitalName = input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? ''
  // Extract state from hospitalName if it contains one (e.g. "Memorial Hospital - TX")
  // Otherwise leave blank; the MRF fetcher will use heuristics only.
  const stateMatch = hospitalName.match(/\b([A-Z]{2})\b/)
  const state = stateMatch ? stateMatch[1] : ''

  const allCodes = input.lineItems.map(li => li.cpt)
  let hospitalPrices: import('./hospital-prices').HospitalPriceResult | null = null

  try {
    hospitalPrices = await lookupHospitalPrices(hospitalName, state, allCodes)
  } catch (err) {
    // Non-fatal — hospital prices are supplemental
    console.warn('[claude.ts] Hospital price lookup failed:', err)
  }

  // Attach hospitalCharge to each finding that has a matching MRF record
  const enrichedFindings = call1Result.findings.map(finding => {
    if (!hospitalPrices) return finding
    const rec = hospitalPrices.charges[finding.cptCode]
    if (!rec) return finding
    return {
      ...finding,
      hospitalGrossCharge: rec.grossCharge ?? undefined,
      hospitalCashPrice: rec.discountedCash ?? undefined,
      hospitalPriceSource: hospitalPrices.mrfUrl,
    }
  })

  // Compute hospital-price-specific summary stats
  let aboveHospitalListCount = 0
  let aboveHospitalListTotal = 0
  for (const finding of enrichedFindings) {
    const f = finding as typeof finding & { hospitalGrossCharge?: number }
    const lineItem = input.lineItems[finding.lineItemIndex]
    if (f.hospitalGrossCharge != null && lineItem.billedAmount > f.hospitalGrossCharge) {
      aboveHospitalListCount++
      aboveHospitalListTotal += lineItem.billedAmount - f.hospitalGrossCharge
    }
  }

  const enrichedSummary = {
    ...call1Result.summary,
    aboveHospitalListCount,
    aboveHospitalListTotal,
    hospitalName: hospitalPrices?.hospitalName ?? undefined,
    hospitalMrfUrl: hospitalPrices?.mrfUrl ?? undefined,
  }

  return {
    findings: enrichedFindings,
    summary: enrichedSummary,
    extractedMeta: call1Result.extractedMeta,
    disputeLetter: call2Result.disputeLetter,
  } as AuditResult
```

### 5.3 Changes to `src/routes/api/audit/+server.ts`

No API endpoint changes are needed. The audit endpoint already returns the full `AuditResult` as JSON — the new fields (`hospitalGrossCharge`, `hospitalCashPrice`, `aboveHospitalListCount`, etc.) flow through automatically as long as the TypeScript types are updated (see section 7).

However, add a processing step annotation to the log output so it is visible in Railway logs:

```typescript
// In the audit endpoint, after calling auditBill():
console.log(`[audit] Hospital price enrichment: ${result.summary.aboveHospitalListCount ?? 0} codes above hospital list`)
```

### 5.4 Updating the processing steps on the frontend

In `src/routes/+page.svelte`, add a new step to the `STEPS` array so the processing screen communicates the new work being done:

```typescript
// Change STEPS from:
const STEPS = [
  'Reading your bill...',
  'Extracting billing codes...',
  'Checking NCCI bundling rules...',
  'Comparing CMS Medicare rates...',
  'Checking pharmacy markup...',
  'Analyzing findings...',
  'Generating dispute letter...',
]

// To:
const STEPS = [
  'Reading your bill...',
  'Extracting billing codes...',
  'Checking NCCI bundling rules...',
  'Comparing CMS Medicare rates...',
  'Checking pharmacy markup...',
  'Looking up hospital published prices...',  // ← NEW
  'Analyzing findings...',
  'Generating dispute letter...',
]
```

---

## 6. Frontend Integration

### 6.1 Changes to `src/lib/types.ts`

(Shown fully in section 7 below — read that section first before making frontend changes.)

### 6.2 Changes to `src/lib/components/LineItemCard.svelte`

The card currently shows a `price-comparison` row with "Billed → Expected (Medicare)" when a finding is present. Extend this to show a second row for the hospital's own price when available.

**In the `<script>` block, add a new derived value after `priceComparison`:**

```typescript
  // Hospital price comparison row.
  // Shown when the finding has hospitalGrossCharge or hospitalCashPrice.
  const hospitalPriceComparison = $derived((() => {
    if (!finding) return null
    const f = finding as AuditFinding & { hospitalGrossCharge?: number; hospitalCashPrice?: number; hospitalPriceSource?: string }
    const hospitalPrice = f.hospitalGrossCharge ?? f.hospitalCashPrice ?? null
    if (hospitalPrice == null) return null
    if (item.billedAmount <= 0) return null
    return {
      price: hospitalPrice,
      label: f.hospitalGrossCharge != null ? 'Hospital gross charge' : 'Hospital cash price',
      source: f.hospitalPriceSource ?? null,
      overcharge: item.billedAmount > hospitalPrice ? item.billedAmount - hospitalPrice : null,
    }
  })())
```

**In the expanded detail section, add the hospital price row immediately after the existing `price-comparison` block:**

```svelte
  {#if expanded}
    <div class="item-detail">
      {#if finding}
        <p class="detail-description">{finding.description}</p>

        <!-- Existing Medicare comparison row (unchanged) -->
        {#if priceComparison}
          <div class="price-comparison">
            <span class="pc-billed">Billed: <span class="pc-mono">{formatDollars(item.billedAmount)}</span></span>
            <span class="pc-arrow">→</span>
            <span class="pc-expected">Medicare expected: <span class="pc-mono">{formatDollars(priceComparison.expected)}</span></span>
            {#if priceComparison.zeroLabel}
              <span class="pc-save pc-zero">({priceComparison.zeroLabel})</span>
            {:else}
              <span class="pc-save">(save ~<span class="pc-mono">{formatDollars(item.billedAmount - priceComparison.expected)}</span>)</span>
            {/if}
          </div>
        {/if}

        <!-- NEW: Hospital published price comparison row -->
        {#if hospitalPriceComparison}
          <div class="price-comparison hospital-price">
            <span class="pc-billed">Billed: <span class="pc-mono">{formatDollars(item.billedAmount)}</span></span>
            <span class="pc-arrow">→</span>
            <span class="pc-expected">
              {hospitalPriceComparison.label}:
              <span class="pc-mono">{formatDollars(hospitalPriceComparison.price)}</span>
            </span>
            {#if hospitalPriceComparison.overcharge != null}
              <span class="pc-save pc-hospital-flag">
                ({formatDollars(hospitalPriceComparison.overcharge)} above hospital's own price list)
              </span>
            {:else}
              <span class="pc-save pc-zero">(within hospital's published price)</span>
            {/if}
          </div>
          {#if hospitalPriceComparison.source}
            <p class="hospital-mrf-source">
              Source: hospital's required CMS price transparency file
              <a
                href={hospitalPriceComparison.source}
                target="_blank"
                rel="noopener noreferrer"
                onclick={(e) => e.stopPropagation()}
              >View file ↗</a>
            </p>
          {/if}
        {/if}

        <!-- Existing detail-grid (unchanged) -->
        <div class="detail-grid">
          {#if finding.medicareRate}
            <span class="detail-label">Medicare rate</span>
            <span class="detail-value">{formatDollars(finding.medicareRate)}</span>
          {/if}
          <!-- NEW hospital price fields in the detail grid -->
          {#if (finding as any).hospitalGrossCharge != null}
            <span class="detail-label">Hospital gross charge</span>
            <span class="detail-value">{formatDollars((finding as any).hospitalGrossCharge)}</span>
          {/if}
          {#if (finding as any).hospitalCashPrice != null}
            <span class="detail-label">Hospital cash price</span>
            <span class="detail-value">{formatDollars((finding as any).hospitalCashPrice)}</span>
          {/if}
          {#if finding.markupRatio}
            <span class="detail-label">Markup ratio</span>
            <span class="detail-value {finding.markupRatio > 4.5 ? 'text-error' : 'text-warning'}">
              {finding.markupRatio.toFixed(1)}× above CMS limit
            </span>
          {/if}
          {#if finding.ncciBundledWith}
            <span class="detail-label">Bundled into</span>
            <span class="detail-value">
              <a
                class="code-link"
                href={aapcUrl(finding.ncciBundledWith)}
                target="_blank"
                rel="noopener noreferrer"
                onclick={(e) => e.stopPropagation()}
              >{finding.ncciBundledWith} ↗</a>
            </span>
          {/if}
          {#if item.icd10Codes?.length}
            <span class="detail-label">Diagnosis codes</span>
            <span class="detail-value">{item.icd10Codes.join(', ')}</span>
          {/if}
        </div>
        <!-- Existing recommendation block (unchanged) -->
        <div class="detail-recommendation">
          <strong>What to do:</strong> {finding.recommendation}
        </div>
      {:else}
        <p class="detail-clean">This charge looks consistent with standard billing practices.</p>
        {#if item.icd10Codes?.length}
          <p class="detail-meta">Diagnosis codes: {item.icd10Codes.join(', ')}</p>
        {/if}
      {/if}
    </div>
  {/if}
```

**Add these CSS rules to the `<style>` block in `LineItemCard.svelte`:**

```css
  /* Hospital price comparison row — distinct from the Medicare row */
  .price-comparison.hospital-price {
    background: #EFF6FF;
    border-color: #BFDBFE;
  }

  .pc-hospital-flag {
    color: #1D4ED8;
    font-size: 12px;
    font-weight: 600;
  }

  .hospital-mrf-source {
    font-size: 11px;
    color: var(--text-muted);
    margin: 4px 0 10px;
    padding: 0;
  }
  .hospital-mrf-source a {
    color: var(--accent);
    text-decoration: none;
  }
  .hospital-mrf-source a:hover {
    text-decoration: underline;
  }
```

### 6.3 Changes to `src/lib/components/ResultsSummary.svelte`

Add a fifth stat tile showing how many charges exceed the hospital's own published price. The tile should only be rendered when `summary.aboveHospitalListCount > 0`.

**Replace the component entirely with this updated version:**

```svelte
<script lang="ts">
  import type { AuditResult } from '$lib/types'

  let { summary }: { summary: AuditResult['summary'] } = $props()

  function formatDollars(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  }

  const showHospitalStat = $derived(
    (summary.aboveHospitalListCount ?? 0) > 0
  )
</script>

<div class="summary-strip" class:five-col={showHospitalStat}>
  <div class="stat error">
    <span class="stat-value">{summary.errorCount}</span>
    <span class="stat-label">Likely {summary.errorCount === 1 ? 'error' : 'errors'}</span>
  </div>
  <div class="stat warning">
    <span class="stat-value">{summary.warningCount}</span>
    <span class="stat-label">Worth reviewing</span>
  </div>
  <div class="stat overcharge">
    <span class="stat-value">{formatDollars(summary.potentialOvercharge)}</span>
    <span class="stat-label">Potential overcharge</span>
  </div>
  <div class="stat clean">
    <span class="stat-value">{summary.cleanCount}</span>
    <span class="stat-label">{summary.cleanCount === 1 ? 'Code looks' : 'Codes look'} fine</span>
  </div>
  {#if showHospitalStat}
    <div class="stat hospital-above">
      <span class="stat-value">{summary.aboveHospitalListCount}</span>
      <span class="stat-label">Above hospital's own price list</span>
    </div>
  {/if}
</div>

{#if summary.hospitalMrfUrl}
  <p class="mrf-attribution">
    Hospital prices sourced from
    <a href={summary.hospitalMrfUrl} target="_blank" rel="noopener noreferrer">
      {summary.hospitalName ?? 'this hospital'}'s required CMS price transparency file ↗
    </a>
  </p>
{/if}

<style>
  .summary-strip {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px;
    margin-bottom: 8px;
  }
  .summary-strip.five-col {
    grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
  }
  @media (max-width: 700px) {
    .summary-strip,
    .summary-strip.five-col { grid-template-columns: 1fr 1fr; }
  }

  .stat {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 12px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 700;
    line-height: 1;
  }
  .stat-label {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .stat.error .stat-value { color: var(--error); }
  .stat.warning .stat-value { color: var(--warning); }
  .stat.overcharge .stat-value { color: var(--text-primary); font-size: 22px; }
  .stat.clean .stat-value { color: var(--success); }
  .stat.hospital-above .stat-value { color: #1D4ED8; }
  .stat.hospital-above {
    border-color: #BFDBFE;
    background: #EFF6FF;
  }

  .mrf-attribution {
    font-size: 11px;
    color: var(--text-muted);
    margin: 4px 0 20px;
    text-align: right;
  }
  .mrf-attribution a {
    color: var(--accent);
    text-decoration: none;
  }
  .mrf-attribution a:hover {
    text-decoration: underline;
  }
</style>
```

### 6.4 Changes to the dispute letter (claude.ts prompt)

When hospital price data is available, the Gemini dispute letter prompt should mention it. In `claude.ts`, modify the second call's prompt to include hospital price context:

```typescript
  // Build hospital price context for the dispute letter prompt
  const hospitalPriceLines: string[] = []
  if (hospitalPrices) {
    for (const finding of enrichedFindings) {
      const f = finding as typeof finding & { hospitalGrossCharge?: number }
      if (f.hospitalGrossCharge != null) {
        const lineItem = input.lineItems[finding.lineItemIndex]
        if (lineItem.billedAmount > f.hospitalGrossCharge) {
          hospitalPriceLines.push(
            `CPT ${finding.cptCode}: billed $${lineItem.billedAmount.toFixed(2)}, ` +
            `hospital's own published gross charge $${f.hospitalGrossCharge.toFixed(2)} ` +
            `(source: ${hospitalPrices.mrfUrl})`
          )
        }
      }
    }
  }

  const hospitalPriceContext = hospitalPriceLines.length > 0
    ? `\n\nHospital's own CMS-required price transparency file shows these discrepancies:\n${hospitalPriceLines.join('\n')}\n\nInclude a paragraph citing these discrepancies and the MRF URL as evidence.`
    : ''

  const prompt2 = `You are a medical billing auditor helping a patient write a dispute letter.
  ...
  ${hospitalPriceContext}
  ...`
```

### 6.5 No new Svelte components required

The feature fits cleanly into existing components. Do not create new component files.

---

## 7. TypeScript Types

**File: `src/lib/types.ts`**

Make the following additions. The rest of the file is unchanged.

```typescript
// Add to AuditFinding interface:
export interface AuditFinding {
  lineItemIndex: number
  cptCode: string
  severity: 'error' | 'warning' | 'info'
  errorType: 'upcoding' | 'unbundling' | 'pharmacy_markup' | 'icd10_mismatch' | 'duplicate' | 'other'
  confidence?: ConfidenceLevel
  description: string
  standardDescription?: string
  medicareRate?: number
  markupRatio?: number
  ncciBundledWith?: string
  recommendation: string
  // ── NEW fields ──────────────────────────────────────────────────────────────
  hospitalGrossCharge?: number      // Hospital's own chargemaster price from MRF
  hospitalCashPrice?: number        // Hospital's discounted cash price from MRF
  hospitalPriceSource?: string      // URL of the hospital's MRF file
}

// Add to AuditResult['summary']:
export interface AuditResult {
  findings: AuditFinding[]
  disputeLetter: DisputeLetter
  summary: {
    totalBilled: number
    potentialOvercharge: number
    errorCount: number
    warningCount: number
    cleanCount: number
    // ── NEW fields ────────────────────────────────────────────────────────────
    aboveHospitalListCount?: number   // Count of charges exceeding hospital's own price
    aboveHospitalListTotal?: number   // Dollar sum of those overages
    hospitalName?: string             // Hospital name confirmed from MRF
    hospitalMrfUrl?: string           // URL to the hospital's MRF (for attribution link)
  }
  extractedMeta: {
    hospitalName?: string
    accountNumber?: string
    dateOfService?: string
  }
}
```

No other type changes are needed. The `HospitalPriceResult` and `HospitalChargeRecord` interfaces live in `src/lib/server/hospital-prices.ts` and are not exposed to the frontend (they are server-only).

---

## 8. Test Plan

### 8.1 Unit tests for `build_hospital_index.py`

**File:** `scripts/tests/test_build_hospital_index.py`

```python
import pytest
import sys; sys.path.insert(0, "scripts")
from build_hospital_index import normalize_name

def test_normalize_name_basic():
    assert normalize_name("St. Mary's Hospital") == "st marys hospital"

def test_normalize_name_apostrophe():
    assert normalize_name("Children's Medical Center") == "childrens medical center"

def test_normalize_name_unicode():
    assert normalize_name("Hôpital Général") == "hopital general"

def test_normalize_name_extra_whitespace():
    assert normalize_name("  General   Hospital  ") == "general hospital"
```

Run with: `python3 -m pytest scripts/tests/test_build_hospital_index.py`

### 8.2 Unit tests for `fetch_hospital_mrf.py`

**File:** `scripts/tests/test_fetch_hospital_mrf.py`

```python
import pytest, json, sys
sys.path.insert(0, "scripts")
from fetch_hospital_mrf import parse_mrf_json, parse_mrf_csv_tall, detect_and_parse_mrf

# Minimal valid CMS JSON MRF
SAMPLE_JSON_MRF = json.dumps({
    "hospital_name": "Test Hospital",
    "last_updated_on": "2024-11-01",
    "version": "3.0.0",
    "standard_charge_information": [
        {
            "description": "COMPREHENSIVE METABOLIC PANEL",
            "code_information": [
                {"code": "80053", "type": "CPT"}
            ],
            "standard_charges": [
                {
                    "gross_charge": 350.00,
                    "discounted_cash": 175.00,
                    "minimum_negotiated_rate": 45.00,
                    "maximum_negotiated_rate": 210.00,
                    "setting": "outpatient",
                    "payers_information": []
                }
            ]
        }
    ]
}).encode()

def test_parse_json_mrf_basic():
    records = parse_mrf_json(SAMPLE_JSON_MRF)
    assert len(records) == 1
    assert records[0]["code"] == "80053"
    assert records[0]["code_type"] == "CPT"
    assert records[0]["gross_charge"] == 350.00
    assert records[0]["discounted_cash"] == 175.00
    assert records[0]["min_negotiated"] == 45.00
    assert records[0]["setting"] == "outpatient"

def test_parse_json_mrf_skips_drg():
    data = json.dumps({
        "standard_charge_information": [
            {
                "description": "DRG SERVICE",
                "code_information": [{"code": "470", "type": "MS-DRG"}],
                "standard_charges": [{"gross_charge": 20000.0, "setting": "inpatient"}]
            }
        ]
    }).encode()
    records = parse_mrf_json(data)
    assert len(records) == 0, "DRG codes should be excluded"

def test_parse_json_mrf_skips_no_price():
    data = json.dumps({
        "standard_charge_information": [
            {
                "description": "SOMETHING",
                "code_information": [{"code": "99213", "type": "CPT"}],
                "standard_charges": [{"setting": "outpatient"}]  # no gross_charge or discounted_cash
            }
        ]
    }).encode()
    records = parse_mrf_json(data)
    assert len(records) == 0

SAMPLE_CSV_TALL = b"""description,setting,code|1|CPT,standard_charge|gross,standard_charge|discounted_cash,standard_charge|min,standard_charge|max
METABOLIC PANEL,outpatient,80053,350.00,175.00,45.00,210.00
EMERGENCY VISIT,outpatient,99285,1200.00,600.00,200.00,900.00
DRG SERVICE,inpatient,,200.00,,,
"""

def test_parse_csv_tall_basic():
    records = parse_mrf_csv_tall(SAMPLE_CSV_TALL)
    assert len(records) == 2
    codes = {r["code"] for r in records}
    assert "80053" in codes
    assert "99285" in codes

def test_detect_and_parse_json():
    records = detect_and_parse_mrf(SAMPLE_JSON_MRF, "https://example.org/charges.json")
    assert len(records) == 1

def test_detect_and_parse_csv():
    records = detect_and_parse_mrf(SAMPLE_CSV_TALL, "https://example.org/charges.csv")
    assert len(records) == 2
```

### 8.3 Unit tests for `src/lib/server/hospital-prices.ts`

**File:** `src/lib/server/hospital-prices.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, rmSync } from 'fs'
import { lookupHospitalPrices } from './hospital-prices'

// Create a test SQLite DB in a temp directory
const TEST_CACHE_DIR = '/tmp/mrf_test_cache'
const TEST_DB_PATH = join(TEST_CACHE_DIR, 'test_hospital.db')

beforeAll(() => {
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  const db = new Database(TEST_DB_PATH)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      code_type TEXT NOT NULL,
      description TEXT,
      gross_charge REAL,
      discounted_cash REAL,
      min_negotiated REAL,
      max_negotiated REAL,
      setting TEXT
    );
    CREATE INDEX idx_code ON charges(code);
    INSERT INTO meta VALUES ('hospital_name', 'Test Hospital');
    INSERT INTO meta VALUES ('mrf_url', 'https://testhospital.org/charges.json');
    INSERT INTO meta VALUES ('fetched_at', '2026-03-31T00:00:00');
    INSERT INTO charges (code, code_type, description, gross_charge, discounted_cash, min_negotiated, max_negotiated, setting)
    VALUES ('80053', 'CPT', 'COMPREHENSIVE METABOLIC PANEL', 350.00, 175.00, 45.00, 210.00, 'outpatient');
    INSERT INTO charges (code, code_type, description, gross_charge, discounted_cash, min_negotiated, max_negotiated, setting)
    VALUES ('99285', 'CPT', 'EMERGENCY VISIT HIGH COMPLEXITY', 1200.00, 600.00, 200.00, 900.00, 'outpatient');
  `)
  db.close()
})

afterAll(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
})

describe('hospital-prices', () => {
  it('returns null for empty hospital name', async () => {
    const result = await lookupHospitalPrices('', '', ['80053'])
    expect(result).toBeNull()
  })

  it('returns null for empty code list', async () => {
    const result = await lookupHospitalPrices('Test Hospital', 'TX', [])
    expect(result).toBeNull()
  })

  // Note: The full integration test requires the SQLite file to be at the
  // expected cache path. For unit testing, mock the cache path via an env var
  // or dependency injection. The tests below are pseudocode for the pattern.

  it('queryCache returns correct records', () => {
    // Import the internal queryCache function for direct testing
    // (export it with @internal tag in hospital-prices.ts for test access)
    const { queryCache } = require('./hospital-prices')  // or use vi.importActual
    const result = queryCache(TEST_DB_PATH, ['80053', '99285', 'XXXXX'])
    expect(result).not.toBeNull()
    expect(result!.charges['80053'].grossCharge).toBe(350.00)
    expect(result!.charges['99285'].grossCharge).toBe(1200.00)
    expect(result!.charges['XXXXX']).toBeUndefined()
    expect(result!.hospitalName).toBe('Test Hospital')
    expect(result!.mrfUrl).toBe('https://testhospital.org/charges.json')
  })
})
```

### 8.4 Integration test (end-to-end flow)

Run this manually against a real hospital file. Use Memorial Hermann Hospital (large Texas health system with a compliant MRF).

```bash
# 1. Fetch the MRF
python3 scripts/fetch_hospital_mrf.py "Memorial Hermann Hospital" --state TX

# 2. Verify the SQLite file was created
ls -lh data/mrf_cache/

# 3. Run a manual SQLite query to confirm data
python3 - <<'EOF'
import sqlite3, glob
files = glob.glob("data/mrf_cache/*.db")
db = sqlite3.connect(files[0])
rows = db.execute("SELECT code, gross_charge, discounted_cash FROM charges WHERE code IN ('99285','80053','85025') LIMIT 10").fetchall()
for r in rows: print(r)
print("Total rows:", db.execute("SELECT COUNT(*) FROM charges").fetchone()[0])
EOF

# 4. Upload a sample bill and verify the results page shows the hospital-price column
# Use the bill from examples/test-images/ that references Memorial Hermann
bun run dev
# Upload bill, check that LineItemCard shows "Hospital gross charge" row
```

### 8.5 Regression test cases

| Input | Expected output |
|-------|----------------|
| Hospital name "Memorial Hermann" in TX, CPT 99285 billed $2,500 | `hospitalGrossCharge` populated; `aboveHospitalListCount = 1` |
| Hospital name not on bill (null) | `hospitalPrices = null`; no hospital tile in summary |
| Hospital found but CPT code not in MRF | `hospitalGrossCharge = undefined`; no hospital price row in LineItemCard |
| MRF fetch fails (network error) | Graceful degradation; audit result returned without hospital prices |
| Billed amount less than hospital gross charge | `overcharge = null`; renders "within hospital's published price" |
| Hospital MRF is gzip-compressed `.json.gz` | Decompressed transparently; records parsed correctly |

---

## 9. Deployment Steps

### 9.1 Dependencies to add

```bash
# better-sqlite3 for Node.js SQLite access
bun add better-sqlite3
bun add -d @types/better-sqlite3

# Verify it builds
bun run build
```

`better-sqlite3` ships native binaries. It is compatible with Node.js 18+ and Railway's Linux environment. No additional system packages needed.

### 9.2 Build step changes

Add `build_hospital_index.py` to the CMS data refresh documentation in `CONTRIBUTING.md`:

```bash
# Run this monthly (add to CMS data refresh section):
python3 scripts/build_hospital_index.py
```

The resulting `src/lib/data/hospital_index.json` must be committed to the repo (it is a static data file, not a runtime artifact).

### 9.3 Gitignore additions

Add to `.gitignore`:
```
data/mrf_cache/
```

This directory holds the per-hospital SQLite files fetched on-demand. They are transient and should not be committed.

### 9.4 Railway deployment

The `data/mrf_cache/` directory must be writable at runtime. On Railway, the working directory is writable by default with `adapter-node`. No special volume mounts needed.

However: **Railway ephemeral filesystems reset on each deploy.** This means MRF cache files are lost after each deployment. This is acceptable: the first audit after deploy for a given hospital will re-fetch the MRF (45s penalty), after which the cache is warm for 24 hours.

If Railway persistent volumes are available on the project plan, mount one at `/app/data/mrf_cache` to preserve cache across deploys. Check `railway.json` or `railway.toml` for volume configuration options.

### 9.5 Environment variables

No new environment variables are required. The MRF fetcher uses public URLs.

### 9.6 Python dependency check

The `fetch_hospital_mrf.py` script uses only Python standard library modules (`json`, `csv`, `sqlite3`, `urllib`, `gzip`, `zipfile`, `argparse`). No additional `pip install` steps are needed beyond what is already required for the existing scripts.

### 9.7 Deploy checklist

1. `bun add better-sqlite3` and commit `package.json` + `bun.lockb`
2. Run `python3 scripts/build_hospital_index.py` and commit the output `src/lib/data/hospital_index.json`
3. Add `data/mrf_cache/` to `.gitignore` and commit
4. Run `bun run check` — must pass with zero type errors
5. Run `bun run build` — must produce a clean build
6. Deploy to Railway
7. Smoke test: upload a bill from a large US hospital. Verify:
   - Processing step "Looking up hospital published prices..." appears in the UI
   - Results page shows "Above hospital's own price list" tile if applicable
   - LineItemCard shows "Hospital gross charge" row in the expanded view
   - No errors in Railway logs relating to `hospital-prices.ts`

---

## 10. Fallback Behavior

The hospital price feature is entirely supplemental. Every failure path must degrade gracefully to the existing Medicare-only audit view.

### 10.1 Failure modes and fallbacks

| Failure | Behavior |
|---------|----------|
| Hospital name not extracted from bill | `lookupHospitalPrices` returns `null`. No hospital stat tile. No hospital price rows. Audit result still returned. |
| Hospital domain not found (heuristic fails) | `resolve_hospital_domain` returns `(None, None)`. `ensureCache` returns `false`. Same as above. |
| cms-hpt.txt not present at hospital domain | `find_mrf_url_from_domain` returns `None`. Same fallback. |
| MRF download times out (> 45s) | `execFileAsync` rejects. `lookupHospitalPrices` catches, returns `null`. |
| MRF file is Excel or XML (non-compliant format) | `detect_and_parse_mrf` returns empty list. `write_sqlite` writes 0 records. `queryCache` returns empty charges map. No hospital price rows shown. |
| MRF file is valid but CPT code not listed | `queryCache` finds no rows for that code. `hospitalGrossCharge` is `undefined`. No hospital price row shown for that line item. |
| SQLite file corrupted or unreadable | `new Database(dbPath, { fileMustExist: true })` throws. `queryCache` catches, returns `null`. |
| `better-sqlite3` native module unavailable | `lookupHospitalPrices` throws at import. Wrap the import in a try/catch at module load time and set `hospitalPricesAvailable = false`. Skip lookup entirely. |

### 10.2 User messaging for no hospital data

When `summary.hospitalMrfUrl` is `undefined` (i.e. no hospital price data was found), the results page should show a short informational note. Add this to `+page.svelte` below the `<ResultsSummary>` component:

```svelte
  {#if !result.summary.hospitalMrfUrl && result.extractedMeta?.hospitalName}
    <p class="hospital-data-note">
      Hospital price comparison not available for {result.extractedMeta.hospitalName} — we couldn't locate their required CMS price transparency file.
      <a href="/how-it-works#price-transparency" target="_blank" rel="noopener noreferrer">Learn more ↗</a>
    </p>
  {/if}
```

Add the CSS:
```css
  .hospital-data-note {
    font-size: 12px;
    color: var(--text-muted);
    margin: -16px 0 20px;
    padding: 8px 12px;
    background: #FAFAFA;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
```

### 10.3 Timeout strategy

The MRF fetch (`fetch_hospital_mrf.py`) is capped at 45 seconds via `execFileAsync`'s `timeout` option. This is a background enrichment step that runs **after** both Gemini calls complete. The total audit request timeout is already 90 seconds (for the first Gemini call). Hospital price lookup adds at most 45 seconds on a cold cache for a large hospital.

If this is too slow in practice, the solution is to make the audit endpoint return immediately and have hospital prices arrive via a second `/api/hospital-prices` endpoint polled by the frontend. That architecture is described below as an optional enhancement.

### 10.4 Optional: async two-request architecture (future enhancement)

If the 45s MRF fetch proves too slow to include in the main audit response time, split into two requests:

1. `/api/audit` returns immediately with the Gemini-only result (existing timing)
2. Frontend polls `/api/hospital-prices?hospital=...&codes=...` (new endpoint)
3. When hospital prices arrive, the results page updates the cards in place

This is **not required for the initial ship** — implement only if production data shows the synchronous approach adds unacceptable latency. For most audits, the hospital name lookup will either succeed in under 20s (small MRF) or fail fast with a network error, keeping the total time reasonable.

---

## Summary of files changed

| File | Change type |
|------|-------------|
| `scripts/build_hospital_index.py` | New file |
| `scripts/fetch_hospital_mrf.py` | New file |
| `src/lib/data/hospital_index.json` | New generated file (committed) |
| `data/mrf_cache/` | New gitignored directory |
| `src/lib/server/hospital-prices.ts` | New file |
| `src/lib/server/claude.ts` | Add import + hospital price enrichment block at bottom of `auditBill()` |
| `src/lib/types.ts` | Add `hospitalGrossCharge`, `hospitalCashPrice`, `hospitalPriceSource` to `AuditFinding`; add `aboveHospitalListCount`, `aboveHospitalListTotal`, `hospitalName`, `hospitalMrfUrl` to `summary` |
| `src/lib/components/LineItemCard.svelte` | Add `hospitalPriceComparison` derived value; add hospital price row in expanded view; add CSS |
| `src/lib/components/ResultsSummary.svelte` | Add fifth stat tile; add MRF attribution line; update grid to `five-col` variant |
| `src/routes/+page.svelte` | Add processing step; add `hospital-data-note` element |
| `package.json` + `bun.lockb` | Add `better-sqlite3` dependency |
| `.gitignore` | Add `data/mrf_cache/` |
| `CONTRIBUTING.md` | Document `build_hospital_index.py` in CMS data refresh section |
