#!/usr/bin/env python3
"""
Build data/mpfs.sqlite from CMS MPFS Relative Value Files.

Source: https://www.cms.gov/files/zip/rvu26a.zip
Inner file: PPRRVU2026_Jan_nonQPP.xlsx

Stage 1: national non-facility rate only.
Stage 2 (GPCI/location-specific) is documented as future work.

Usage:
  python3 scripts/build_mpfs_sqlite.py
  python3 scripts/build_mpfs_sqlite.py /path/to/rvu26a.zip
"""

from __future__ import annotations

import io
import os
import re
import sqlite3
import sys
import urllib.request
import zipfile
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("ERROR: openpyxl is required. Run: pip install openpyxl")
    sys.exit(1)

DB_PATH = Path(__file__).parent.parent / "data" / "mpfs.sqlite"

MPFS_URLS = [
    "https://www.cms.gov/files/zip/rvu26a.zip",
    "https://www.cms.gov/files/zip/rvu25a.zip",  # fallback
]

CONVERSION_FACTOR = 33.29  # 2026 non-QPP
FISCAL_YEAR = "2026"
SOURCE_FILE = "PPRRVU2026_Jan_nonQPP.xlsx"

ACTIVE_STATUSES = {"A", "R", "T"}
CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(f"""
        CREATE TABLE IF NOT EXISTS mpfs_rates (
            hcpcs_code          TEXT NOT NULL,
            modifier            TEXT,
            description         TEXT,
            status_code         TEXT,
            nonfac_total_rvu    NUMERIC,
            fac_total_rvu       NUMERIC,
            nonfac_rate         NUMERIC,
            fac_rate            NUMERIC,
            conversion_factor   NUMERIC NOT NULL DEFAULT {CONVERSION_FACTOR},
            fiscal_year         TEXT NOT NULL DEFAULT '{FISCAL_YEAR}',
            source_file         TEXT,
            PRIMARY KEY (hcpcs_code, fiscal_year)
        );

        CREATE INDEX IF NOT EXISTS idx_mpfs_code
            ON mpfs_rates(hcpcs_code);

        CREATE INDEX IF NOT EXISTS idx_mpfs_status
            ON mpfs_rates(status_code);
    """)


def parse_xlsx(xlsx_bytes: bytes, source_file: str) -> list[tuple]:
    """
    Parse PPRRVU XLSX.
    Skip rows before the header row (header row has 'HCPCS' in first cell).
    Skip modifier-specific rows (MOD column non-blank).
    Returns list of (hcpcs, modifier, description, status, nonfac_rvu, fac_rvu, nonfac_rate, fac_rate, cf, year, source)
    """
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    # Default (fallback) column positions if header scanning fails
    HCPCS_COL = 0
    MOD_COL = 1
    DESC_COL = 2
    STATUS_COL = 3
    NONFAC_TOTAL_COL = 11  # fallback only — see header scan below
    FAC_TOTAL_COL = 12     # fallback only — see header scan below

    header_found = False
    nonfac_col_found = False
    fac_col_found = False
    rows: list[tuple] = []

    for row in ws.iter_rows(values_only=True):
        if not header_found:
            val = str(row[HCPCS_COL]).strip().upper() if row[HCPCS_COL] is not None else ""
            if val == "HCPCS":
                # Scan the header row to find rate column positions by name
                header_cells = [str(c).strip().upper() if c is not None else "" for c in row]
                for idx, cell in enumerate(header_cells):
                    # CMS MPFS headers: "NON-FACILITY PRICING AMOUNT", "FACILITY PRICING AMOUNT"
                    # or variations like "NONFAC TOTAL" / "FAC TOTAL"
                    if any(kw in cell for kw in ("NON-FAC", "NONFAC", "NON FAC", "NONFACILITY")):
                        if "TOTAL" in cell or "PRICING" in cell or "AMOUNT" in cell:
                            NONFAC_TOTAL_COL = idx
                            nonfac_col_found = True
                            print(f"  Found NONFAC_TOTAL_COL at index {idx}: {cell!r}")
                    if "FAC" in cell and "NON" not in cell:
                        if "TOTAL" in cell or "PRICING" in cell or "AMOUNT" in cell:
                            FAC_TOTAL_COL = idx
                            fac_col_found = True
                            print(f"  Found FAC_TOTAL_COL at index {idx}: {cell!r}")
                if not nonfac_col_found or not fac_col_found:
                    raise ValueError(
                        "Could not find MPFS facility/non-facility pricing columns by header name. "
                        f"Fallback indexes are NONFAC_TOTAL_COL={NONFAC_TOTAL_COL}, FAC_TOTAL_COL={FAC_TOTAL_COL}; "
                        "check the CMS worksheet layout before loading rates."
                    )
                header_found = True
            continue

        hcpcs = str(row[HCPCS_COL]).strip().upper() if row[HCPCS_COL] is not None else ""
        if not CODE_PATTERN.match(hcpcs):
            continue

        modifier = row[MOD_COL]
        if modifier is not None and str(modifier).strip():
            continue  # skip modifier-specific rows

        description = str(row[DESC_COL]).strip() if row[DESC_COL] is not None else None
        status = str(row[STATUS_COL]).strip().upper() if row[STATUS_COL] is not None else ""

        if status not in ACTIVE_STATUSES:
            continue

        def safe_float(val) -> float | None:
            if val is None:
                return None
            try:
                return float(val)
            except (ValueError, TypeError):
                return None

        nonfac_rvu = safe_float(row[NONFAC_TOTAL_COL] if NONFAC_TOTAL_COL < len(row) else None)
        fac_rvu = safe_float(row[FAC_TOTAL_COL] if FAC_TOTAL_COL < len(row) else None)

        nonfac_rate = round(nonfac_rvu * CONVERSION_FACTOR, 2) if nonfac_rvu is not None else None
        fac_rate = round(fac_rvu * CONVERSION_FACTOR, 2) if fac_rvu is not None else None

        rows.append((
            hcpcs, None, description, status,
            nonfac_rvu, fac_rvu,
            nonfac_rate, fac_rate,
            CONVERSION_FACTOR, FISCAL_YEAR, source_file
        ))

    wb.close()
    if rows:
        sample_nonfac = [r[6] for r in rows[:20] if r[6] is not None]
        if sample_nonfac:
            avg = sum(sample_nonfac) / len(sample_nonfac)
            if avg < 1.0:
                print(
                    f"WARNING: Average nonfac_rate is {avg:.4f} — this looks like raw RVUs, not dollars. "
                    "Expected ~$50–$200 for common CPT codes. "
                    "Check that NONFAC_TOTAL_COL points to the dollar column, not the RVU column."
                )
            elif avg > 10_000:
                print(
                    f"WARNING: Average nonfac_rate is {avg:.2f} — this looks too high. "
                    "Check column mapping."
                )
    return rows


def main() -> None:
    os.makedirs(DB_PATH.parent, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    create_schema(conn)

    # Determine source
    if len(sys.argv) > 1:
        local_path = Path(sys.argv[1])
        print(f"Using local file: {local_path}")
        zip_bytes = local_path.read_bytes()
    else:
        zip_bytes = None
        for url in MPFS_URLS:
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

    # Extract and parse the XLSX
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        print(f"ZIP contents: {archive.namelist()}")
        # Find the PPRRVU xlsx file (name may vary slightly)
        xlsx_names = [
            n for n in archive.namelist()
            if n.upper().startswith("PPRRVU") and n.lower().endswith(".xlsx")
            and "nonqpp" in n.lower()
        ]
        if not xlsx_names:
            # Fallback: any xlsx
            xlsx_names = [n for n in archive.namelist() if n.lower().endswith(".xlsx")]

        if not xlsx_names:
            print("ERROR: No XLSX file found in ZIP")
            sys.exit(1)

        xlsx_name = xlsx_names[0]
        print(f"Parsing {xlsx_name} ...")
        rows = parse_xlsx(archive.read(xlsx_name), xlsx_name)
        print(f"Parsed {len(rows):,} rows")

    # Insert
    inserted = 0
    for row in rows:
        try:
            conn.execute(
                """INSERT OR REPLACE INTO mpfs_rates
                   (hcpcs_code, modifier, description, status_code,
                    nonfac_total_rvu, fac_total_rvu, nonfac_rate, fac_rate,
                    conversion_factor, fiscal_year, source_file)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                row,
            )
            inserted += 1
        except sqlite3.Error as e:
            print(f"  Insert error: {e}")

    conn.commit()

    # Summary
    print(f"\nInserted {inserted:,} rows")
    row = conn.execute("SELECT nonfac_rate, description FROM mpfs_rates WHERE hcpcs_code='99285'").fetchone()
    print(f"99285 (ER hi): ${row[0]} - {row[1]}" if row else "99285: NOT FOUND")
    row = conn.execute("SELECT nonfac_rate, description FROM mpfs_rates WHERE hcpcs_code='70450'").fetchone()
    print(f"70450 (CT head): ${row[0]} - {row[1]}" if row else "70450: NOT FOUND")

    conn.close()
    size_kb = DB_PATH.stat().st_size // 1024
    print(f"\nWrote {DB_PATH} ({size_kb:,} KB)")
    print("\nFuture stage 2 note: rvu26b.zip contains GPCI2026.xlsx and 26LOCCO.xlsx for location-specific pricing.")
    print("See step-20-future-steps.md for implementation details.")


if __name__ == "__main__":
    main()
