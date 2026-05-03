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
INDEX_URL = "https://oria-data.trillianthealth.com/search-index.json"
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


def find_duckdb_url_from_page(hospital_id: str) -> str | None:
    page_url = f"https://oria-data.trillianthealth.com/hospital/{hospital_id}"
    try:
        resp = requests.get(page_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  Trilliant hospital page failed: {exc}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "_parsed.duckdb" in href:
            return href if href.startswith("http") else f"https://oria-data.trillianthealth.com{href}"

    match = re.search(r'(/data/[^"\']+_parsed\.duckdb)', resp.text)
    if match:
        return f"https://oria-data.trillianthealth.com{match.group(1)}"

    return None


def search_trilliant_index(query: str, state: str | None = None) -> list[dict]:
    try:
        resp = requests.get(INDEX_URL, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        hospitals = resp.json()
    except Exception as exc:
        print(f"  Trilliant index failed: {exc}")
        return []

    query_tokens = set(normalize_name(query).split())
    candidates: list[dict] = []

    for hospital in hospitals:
        if hospital.get("status") != "completed":
            continue
        if state and str(hospital.get("state", "")).upper() != state.upper():
            continue

        haystack = normalize_name(" ".join([
            str(hospital.get("locationName", "")),
            str(hospital.get("hospitalName", "")),
            str(hospital.get("city", "")),
            str(hospital.get("state", "")),
        ]))
        haystack_tokens = set(haystack.split())
        overlap = len(query_tokens & haystack_tokens)
        if overlap == 0:
            continue

        candidates.append({
            "hospital_id": hospital["id"],
            "name": hospital.get("locationName") or hospital.get("hospitalName") or hospital["id"],
            "city": hospital.get("city", ""),
            "state": hospital.get("state", ""),
            "duckdb_url": "",
            "score": overlap,
        })

    candidates.sort(key=lambda item: item["score"], reverse=True)
    for candidate in candidates[:5]:
        duckdb_url = find_duckdb_url_from_page(candidate["hospital_id"])
        if duckdb_url:
            candidate["duckdb_url"] = duckdb_url
            print(f"  Found {len(candidates)} candidates on Trilliant for '{query}'")
            return [candidate]

    print(f"  Found 0 downloadable candidates on Trilliant for '{query}'")
    return []


def search_trilliant(query: str, state: str | None = None) -> list[dict]:
    """
    Search Trilliant and return list of hospital candidates:
    [{ name, city, state, duckdb_url, hospital_id }]
    """
    index_candidates = search_trilliant_index(query, state)
    if index_candidates:
        return index_candidates

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
            lines = [line.strip() for line in text.split("\n") if line.strip()]
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


def sql_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def coerce_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def convert_duckdb_to_sqlite(duckdb_path: Path, sqlite_path: Path) -> bool:
    """
    Open DuckDB file, export key tables to SQLite.
    Returns True on success.
    """
    try:
        con = duckdb.connect(str(duckdb_path), read_only=True)

        # List available tables
        tables = [row[0] for row in con.execute("SHOW TABLES").fetchall()]
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
        for preferred in ("standard_charges", "standard_charge_details", "charges"):
            if preferred in tables:
                charge_table = preferred
                break
        if charge_table is None:
            for table_name in tables:
                lowered = table_name.lower()
                if ("charge" in lowered or "standard" in lowered) and "modifier" not in lowered:
                    charge_table = table_name
                    break
        if charge_table is None and tables:
            charge_table = tables[0]

        if charge_table:
            print(f"  Reading charges from table: {charge_table}")
            # Get column names
            cols = [row[0] for row in con.execute(f"DESCRIBE {sql_ident(charge_table)}").fetchall()]
            print(f"  Columns: {cols[:10]}")

            # Map to our schema
            cols_lower = {c.lower(): c for c in cols}

            code_sources = [cols_lower[c] for c in ("cpt", "hcpcs", "ms_drg", "rc", "cdm", "ndc") if c in cols_lower]
            code_expr = "COALESCE(" + ", ".join(sql_ident(c) for c in code_sources) + ")" if code_sources else None
            code_type_cases = []
            for col_name, code_type in (
                ("cpt", "CPT"),
                ("hcpcs", "HCPCS"),
                ("ms_drg", "MS-DRG"),
                ("rc", "RC"),
                ("cdm", "CDM"),
                ("ndc", "NDC"),
            ):
                if col_name in cols_lower:
                    code_type_cases.append(f"WHEN {sql_ident(cols_lower[col_name])} IS NOT NULL THEN '{code_type}'")
            code_type_expr = f"CASE {' '.join(code_type_cases)} ELSE NULL END" if code_type_cases else None

            col_map = {
                "code": code_expr,
                "code_type": code_type_expr or next((sql_ident(c) for c in cols if "code_type" in c.lower() or c.lower() in ("type", "code_type")), None),
                "description": next((sql_ident(c) for c in cols if c.lower() == "description" or "desc" in c.lower() or "name" in c.lower()), None),
                "gross_charge": next((sql_ident(c) for c in cols if "gross" in c.lower()), None),
                "discounted_cash": next((sql_ident(c) for c in cols if "cash" in c.lower() or "discount" in c.lower()), None),
                "min_negotiated": next((sql_ident(c) for c in cols if c.lower() in ("minimum", "min_negotiated_rate", "min_negotiated")), None),
                "max_negotiated": next((sql_ident(c) for c in cols if c.lower() in ("maximum", "max_negotiated_rate", "max_negotiated")), None),
                "setting": next((sql_ident(c) for c in cols if "setting" in c.lower() or "outpatient" in c.lower()), None),
                "payer_name": next((sql_ident(c) for c in cols if c.lower() == "payer_name"), None),
                "plan_name": next((sql_ident(c) for c in cols if c.lower() == "plan_name"), None),
            }
            print(f"  Column mapping: {col_map}")

            select_cols = []
            for dest_col in [
                "code", "code_type", "description", "gross_charge", "discounted_cash",
                "min_negotiated", "max_negotiated", "setting", "payer_name", "plan_name",
            ]:
                src = col_map.get(dest_col)
                select_cols.append(f"{src} AS {dest_col}" if src else f"NULL AS {dest_col}")

            rows = con.execute(f"SELECT {', '.join(select_cols)} FROM {sql_ident(charge_table)}").fetchall()
            print(f"  Fetched {len(rows):,} charge rows")

            for row in rows:
                (
                    code, code_type, description, gross_charge, discounted_cash,
                    min_negotiated, max_negotiated, setting, payer_name, plan_name,
                ) = row
                normalized_code = str(code or "").strip().upper()
                if not normalized_code:
                    continue
                sqlite_con.execute("""INSERT INTO charges
                    (code, code_type, description, gross_charge, discounted_cash,
                     min_negotiated, max_negotiated, setting, payer_name, plan_name)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""", (
                    normalized_code,
                    str(code_type or ""),
                    str(description or ""),
                    coerce_float(gross_charge),
                    coerce_float(discounted_cash),
                    coerce_float(min_negotiated),
                    coerce_float(max_negotiated),
                    str(setting or ""),
                    str(payer_name or ""),
                    str(plan_name or ""),
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
