#!/usr/bin/env python3
"""
Build data/asp.sqlite from CMS Part B Drug Average Sales Price files.

Source (Q2 2026): https://www.cms.gov/files/zip/april-2026-medicare-part-b-payment-limit-files-03-30-2026-final-file.zip

Tables:
  asp_payment_limits    - HCPCS -> payment limit (stage 1)
  asp_ndc_hcpcs_crosswalk - NDC -> HCPCS mapping (stage 2, schema only)

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

        payment_limit_files = [
            n for n in csv_files
            if "payment limit" in n.lower() and "not payable" not in n.lower()
        ]
        not_payable_files = [n for n in csv_files if "not payable" in n.lower()]

        if payment_limit_files:
            fname = payment_limit_files[0]
            print(f"  Selected payment limits file: {fname}")
        elif csv_files and not not_payable_files:
            # Only one CSV and it's not obviously "not payable" — use it with a warning
            fname = csv_files[0]
            print(f"  WARNING: Could not identify payment limits file by name. Using: {fname}")
            print(f"  All CSV files in ZIP: {csv_files}")
            print("  Verify this file contains 'HCPCS Code' and 'Payment Limit' columns.")
        else:
            print(f"ERROR: Could not find ASP payment limits CSV. ZIP contains: {csv_files}")
            print("Expected a file with 'payment limit' in the name (case-insensitive).")
            print("CMS may have renamed the file. Check: https://www.cms.gov/Medicare/Medicare-Fee-for-Service-Part-B-Drugs/McrPartBDrugAvgSalesPrice/2025ASPFiles")
            sys.exit(1)
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
            print(f"{row[0]}: ${row[1]:.4f} - {row[2]}")
        else:
            print(f"{code}: NOT FOUND")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")
    print("\nNote: asp_ndc_hcpcs_crosswalk table created but not populated (stage 2 future work).")


if __name__ == "__main__":
    main()
