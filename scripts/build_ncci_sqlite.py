#!/usr/bin/env python3
"""
Build data/ncci.sqlite from CMS NCCI PTP edit files.

ACTIVE_DATE: 2026 Q2 (effective April 1, 2026)

Downloads and parses all three bill-type files:
  - Practitioner (Medicare quarterly ZIP parts, 4 files)
  - Outpatient Hospital (Medicare quarterly ZIP parts, 4 files)
  - DME (Medicaid quarterly single ZIP)

Schema:
  ncci_ptp(col1_code, col2_code, effective_date, deletion_date, modifier_indicator, rationale, bill_type, source)

Usage:
  python3 scripts/build_ncci_sqlite.py
  python3 scripts/build_ncci_sqlite.py --local /path/to/file.zip practitioner

Quarterly refresh:
  1. Update the URLs in SOURCES for the new quarter.
  2. Update the ACTIVE_DATE comment above.
  3. Run: python3 scripts/build_ncci_sqlite.py
  4. Restart the server.

CMS updates NCCI quarterly (Jan 1, Apr 1, Jul 1, Oct 1). Data may be up to
30 days stale between releases.
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
MIN_EXPECTED_NCCI_ROWS = 5_000  # NCCI files typically have 200k+ pairs; 5k is a hard floor

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

# Medicaid also has practitioner and outpatient; use as fallback.
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
    """Medicare files have a blank or * in column index 2 before effective date."""
    if len(parts) < 5:
        return False
    col2_val = parts[2].strip()
    return col2_val in ("", "*")


def parse_txt(txt_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    """
    Parse one NCCI tab-delimited text file.
    Returns rows of (col1, col2, eff_date, del_date, modifier, rationale, bill_type, source).
    All rows are kept; expiry filtering happens at query time.
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

        # Filter out header/footer rows.
        if not CODE_PATTERN.match(col1) or not CODE_PATTERN.match(col2):
            continue

        if is_medicare_layout(parts):
            eff_str = parts[3].strip() if len(parts) > 3 else ""
            del_str = parts[4].strip() if len(parts) > 4 else "*"
            mod = parts[5].strip() if len(parts) > 5 else "1"
            rationale = parts[6].strip() if len(parts) > 6 else None
        else:
            eff_str = parts[2].strip()
            del_str = parts[3].strip() if len(parts) > 3 else "*"
            mod = parts[4].strip() if len(parts) > 4 else "1"
            rationale = parts[5].strip() if len(parts) > 5 else None

        try:
            eff_date = int(eff_str) if eff_str and eff_str != "*" else 20000101
        except ValueError:
            eff_date = 20000101

        try:
            del_date = int(del_str) if del_str and del_str != "*" else 99991231
        except ValueError:
            del_date = 99991231

        if mod not in ("0", "1", "9"):
            mod = "1"

        rows.append((col1, col2, eff_date, del_date, mod, rationale or None, bill_type, source))

    return rows


def process_zip(zip_bytes: bytes, bill_type: str, source: str) -> list[tuple]:
    rows: list[tuple] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        txt_files = [n for n in archive.namelist() if n.lower().endswith(".txt")]
        print(f"  ZIP contains: {archive.namelist()}")
        for fname in txt_files:
            print(f"  Parsing {fname} ...")
            parsed = parse_txt(archive.read(fname), bill_type, source)
            print(f"    -> {len(parsed):,} rows")
            if len(parsed) < MIN_EXPECTED_NCCI_ROWS:
                raise ValueError(
                    f"Suspiciously few rows from {fname}: {len(parsed):,} "
                    f"(expected >= {MIN_EXPECTED_NCCI_ROWS:,}). "
                    "This usually means the layout detection (is_medicare_layout) failed. "
                    "Check that column offsets match the current CMS file format."
                )
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
    """
    Insert rows, logging any conflicts where modifier_indicator differs.
    INSERT OR REPLACE is kept intentionally — later ZIPs are assumed to be more authoritative —
    but conflicts are logged so they can be investigated if needed.
    """
    inserted = 0
    replaced = 0
    for row in rows:
        col1, col2, eff_date, del_date, mod, rationale, bill_type, source = row
        try:
            existing = conn.execute(
                """SELECT modifier_indicator FROM ncci_ptp
                   WHERE col1_code=? AND col2_code=? AND effective_date=? AND bill_type=?""",
                (col1, col2, eff_date, bill_type),
            ).fetchone()
            if existing and existing[0] != mod:
                print(
                    f"  CONFLICT: {col1}/{col2} eff={eff_date} {bill_type}: "
                    f"modifier {existing[0]!r} -> {mod!r} (source={source})"
                )
                replaced += 1
            conn.execute(
                """INSERT OR REPLACE INTO ncci_ptp
                   (col1_code, col2_code, effective_date, deletion_date,
                    modifier_indicator, rationale, bill_type, source)
                   VALUES (?,?,?,?,?,?,?,?)""",
                row,
            )
            inserted += 1
        except sqlite3.Error as e:
            print(f"  ERROR inserting {col1}/{col2}: {e}")
    if replaced:
        print(f"  WARNING: {replaced} rows had modifier_indicator conflicts — review output above.")
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
    parser.add_argument(
        "--local",
        nargs=2,
        metavar=("FILE", "BILL_TYPE"),
        help="Use a local ZIP file instead of downloading. BILL_TYPE: practitioner|outpatient|dme",
    )
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
            print(f"\n{'=' * 60}")
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

        print(f"\n{'=' * 60}")
        print(f"Total rows inserted: {total:,}")

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
