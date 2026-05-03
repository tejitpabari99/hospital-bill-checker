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
        if mue_val_str == "*":
            # CMS-suppressed value — store as NULL so the code is still visible in the DB
            mue_value = None
        else:
            try:
                mue_value = int(mue_val_str)
            except ValueError:
                # Skip completely unparseable values (non-numeric, non-suppressed)
                print(f"  Skipping unparseable mue_value {mue_val_str!r} for code {code!r}")
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
            mue_value                   INTEGER,
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
