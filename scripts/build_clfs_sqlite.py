#!/usr/bin/env python3
"""
Build data/clfs.sqlite from CMS Clinical Laboratory Fee Schedule.

Source: https://www.cms.gov/files/zip/26clabq2.zip

Two tables:
  clfs_rates   — full quarterly history
  clfs_current — latest rate per code (for fast lookup)

Usage:
  python3 scripts/build_clfs_sqlite.py
  python3 scripts/build_clfs_sqlite.py /path/to/26clabq2.zip
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

DB_PATH = Path(__file__).parent.parent / "data" / "clfs.sqlite"

CLFS_URLS = [
    "https://www.cms.gov/files/zip/26clabq2.zip",
    "https://www.cms.gov/files/zip/26clabq1.zip",
]

SOURCE_RELEASE = "2026Q2"
CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS clfs_rates (
            hcpcs_code      TEXT NOT NULL,
            eff_date        TEXT,
            indicator       TEXT,
            rate            NUMERIC NOT NULL,
            description     TEXT,
            year            INTEGER,
            source_release  TEXT,
            PRIMARY KEY (hcpcs_code, eff_date)
        );

        CREATE INDEX IF NOT EXISTS idx_clfs_code
            ON clfs_rates(hcpcs_code);

        CREATE TABLE IF NOT EXISTS clfs_current (
            hcpcs_code      TEXT PRIMARY KEY,
            rate            NUMERIC NOT NULL,
            description     TEXT,
            indicator       TEXT,
            eff_date        TEXT,
            source_release  TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_clfs_current_code
            ON clfs_current(hcpcs_code);
    """)


def detect_delimiter(raw_text: str) -> str:
    """Check first few lines to detect tab vs comma."""
    sample = raw_text[:2000]
    if sample.count("\t") > sample.count(","):
        return "\t"
    return ","


def find_col(header: list[str], *candidates: str) -> int | None:
    """Find column index matching any candidate name (case-insensitive)."""
    normalized = [h.strip().upper().replace(" ", "_") for h in header]
    for candidate in candidates:
        candidate_norm = candidate.upper().replace(" ", "_")
        for i, h in enumerate(normalized):
            if h == candidate_norm:
                return i
    return None


def parse_clfs_file(raw_bytes: bytes, source_release: str) -> list[tuple]:
    """Returns list of (hcpcs, eff_date, indicator, rate, description, year, source)."""
    # Decode with BOM handling
    text = raw_bytes.decode("utf-8-sig", errors="replace")
    delimiter = detect_delimiter(text)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)

    # Find header row — scan up to first 5 rows
    header = None
    rows_before_header = 0
    for row in reader:
        normalized = [str(c).strip().upper() for c in row]
        if "HCPCS" in normalized and ("RATE" in normalized or "PAYMENT_RATE" in normalized
                                      or "PAYMENT RATE" in normalized):
            header = [str(c).strip() for c in row]
            break
        rows_before_header += 1
        if rows_before_header > 5:
            break

    if not header:
        print("ERROR: Could not find CLFS header row")
        return []

    print(f"  Header found at row {rows_before_header}: {header[:8]}")

    code_idx = find_col(header, "HCPCS")
    rate_idx = find_col(header, "RATE", "PAYMENT RATE", "PAYMENT_RATE")
    mod_idx = find_col(header, "MOD", "MODIFIER")
    eff_date_idx = find_col(header, "EFF_DATE", "EFFECTIVE DATE", "EFFECTIVE_DATE")
    indicator_idx = find_col(header, "INDICATOR", "RATE INDICATOR")
    ext_desc_idx = find_col(header, "EXTENDEDLONGDESC", "EXTENDED LONG DESCRIPTION")
    long_desc_idx = find_col(header, "LONGDESC", "LONG DESCRIPTION", "LONG DESCRIPTOR")
    short_desc_idx = find_col(header, "SHORTDESC", "SHORT DESCRIPTION", "SHORT DESCRIPTOR")

    if code_idx is None or rate_idx is None:
        print("ERROR: Missing HCPCS or RATE column")
        return []

    results: list[tuple] = []

    for row in reader:
        if not row:
            continue

        code = str(row[code_idx]).strip().upper() if code_idx < len(row) else ""
        if not CODE_PATTERN.match(code):
            continue

        # Skip modifier-specific rows (stage 1)
        if mod_idx is not None and mod_idx < len(row):
            mod_val = str(row[mod_idx]).strip()
            if mod_val:
                continue

        # Parse rate
        raw_rate = str(row[rate_idx]).strip().replace(",", "").replace("$", "") if rate_idx < len(row) else ""
        if not raw_rate:
            continue
        try:
            rate = float(raw_rate)
        except ValueError:
            continue

        eff_date = str(row[eff_date_idx]).strip() if eff_date_idx is not None and eff_date_idx < len(row) else None
        indicator = str(row[indicator_idx]).strip() if indicator_idx is not None and indicator_idx < len(row) else None

        # Best description available
        description = None
        for idx in [ext_desc_idx, long_desc_idx, short_desc_idx]:
            if idx is not None and idx < len(row):
                desc = str(row[idx]).strip()
                if desc:
                    description = desc
                    break

        year = None
        if eff_date:
            try:
                year = int(eff_date[:4])
            except (ValueError, IndexError):
                pass

        results.append((code, eff_date, indicator, rate, description, year, source_release))

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
        for url in CLFS_URLS:
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
        # Find text/csv files
        data_files = [
            n for n in archive.namelist()
            if n.lower().endswith((".csv", ".txt")) and not n.startswith("__")
        ]
        if not data_files:
            print("ERROR: No data files in ZIP")
            sys.exit(1)

        fname = data_files[0]
        print(f"Parsing {fname} ...")
        rows = parse_clfs_file(archive.read(fname), SOURCE_RELEASE)
        print(f"Parsed {len(rows):,} rows")

    # Insert into clfs_rates
    inserted_rates = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO clfs_rates
                   (hcpcs_code, eff_date, indicator, rate, description, year, source_release)
                   VALUES (?,?,?,?,?,?,?)""",
                row,
            )
            inserted_rates += 1
        except sqlite3.Error as e:
            print(f"  Insert error: {e}")

    # Build clfs_current — latest rate per code
    conn.execute("DELETE FROM clfs_current")
    conn.execute("""
        INSERT OR REPLACE INTO clfs_current (hcpcs_code, rate, description, indicator, eff_date, source_release)
        SELECT hcpcs_code, rate, description, indicator, eff_date, source_release
        FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY hcpcs_code ORDER BY eff_date DESC) AS rn
            FROM clfs_rates
        )
        WHERE rn = 1
    """)

    conn.commit()

    # Summary
    print(f"\nInserted {inserted_rates:,} rows into clfs_rates")
    current_count = conn.execute("SELECT COUNT(*) FROM clfs_current").fetchone()[0]
    print(f"clfs_current: {current_count:,} codes")

    for code in ["85025", "80053", "36415", "0001U"]:
        row = conn.execute(
            "SELECT hcpcs_code, rate, description FROM clfs_current WHERE hcpcs_code=?", (code,)
        ).fetchone()
        if row:
            print(f"{row[0]}: ${row[1]} — {row[2]}")
        else:
            print(f"{code}: NOT FOUND")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")


if __name__ == "__main__":
    main()
