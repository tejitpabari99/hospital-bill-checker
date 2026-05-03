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
    tokens = name.split()
    if len(tokens) > 1:
        return f"{name} {' '.join(reversed(tokens))}"
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
    try:
        results = []
        offset = 0
        total = None
        while total is None or offset < total:
            url = f"{API_URL}?limit=1500&offset={offset}"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            page = data.get("results", data.get("data", []))
            total = int(data.get("count", len(page)))
            if not page:
                break
            results.extend(page)
            offset += len(page)
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

        name = get("Hospital Name", "hospital_name", "facility_name", "name")
        if not name:
            continue

        ccn = get("Provider ID", "provider_id", "facility_id", "ccn")
        hospital_id = ccn or re.sub(r"[^a-z0-9]", "_", name.lower())[:60]

        address = get("Address", "address", "hospital_address")
        city = get("City", "city", "citytown", "hospital_city")
        state = get("State", "state", "hospital_state")
        zip_code = get("ZIP Code", "zip_code", "hospital_zip")
        phone = get("Phone Number", "phone_number", "telephone_number", "hospital_phone")
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
