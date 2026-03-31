#!/usr/bin/env python3
"""
Build MPFS (Medicare Physician Fee Schedule) lookup JSON.
Downloads the annual MPFS CSV from CMS and extracts CPT → payment rate.

CMS MPFS data: https://www.cms.gov/medicare/physician-fee-schedule/search
The downloadable ZIP contains a CSV with columns including:
  HCPCS, DESCRIPTION, PAR_AMOUNT, NON_PAR_AMOUNT, LIMITING_CHARGE

We use PAR_AMOUNT (participating provider rate) as the benchmark.
"""
import json
import csv
import zipfile
import io
import sys
import os
import re
import urllib.request
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "mpfs.json"

# CMS MPFS Relative Value Files — updated annually in January
# Direct download URL pattern: https://www.cms.gov/files/zip/rvu{YY}a.zip
# Get latest from: https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files
MPFS_URLS = [
    "https://www.cms.gov/files/zip/rvu26a.zip",   # 2026
    "https://www.cms.gov/files/zip/rvu25a.zip",   # 2025 fallback
]

# 2026 Medicare non-QPP conversion factor (CF × total non-facility RVU = payment)
# Update annually. Source: https://www.cms.gov/newsroom/fact-sheets/calendar-year-cy-2026-medicare-physician-fee-schedule-final-rule-cms-1832-f
CONVERSION_FACTOR = 33.29

# Active status codes that have calculated payment rates
ACTIVE_STATUSES = {'A', 'R', 'T'}

CPT_PATTERN = re.compile(r'^[0-9]{5}$|^[JGABC][0-9]{4}$')


def parse_mpfs_xlsx(xlsx_bytes: bytes) -> dict:
    """Parse MPFS XLSX (PPRRVU file) and return CPT → { rate, description }."""
    try:
        import openpyxl
    except ImportError:
        print("openpyxl not installed. Run: pip install openpyxl")
        return {}

    rates = {}
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    # Column indices from the known PPRRVU header (row with 'HCPCS'):
    # 0=HCPCS, 1=MOD, 2=DESCRIPTION, 3=STATUS, 4=NOT_USED, 5=WORK_RVU,
    # 6=NONFAC_PE_RVU, 7=NONFAC_NA_IND, 8=FAC_PE_RVU, 9=FAC_NA_IND,
    # 10=MP_RVU, 11=NONFAC_TOTAL, 12=FAC_TOTAL, ...
    HCPCS_COL, MOD_COL, DESC_COL, STATUS_COL = 0, 1, 2, 3
    NONFAC_TOTAL_COL = 11

    header_found = False
    for row in ws.iter_rows(values_only=True):
        if not header_found:
            if row[HCPCS_COL] == 'HCPCS':
                header_found = True
            continue

        if not row[HCPCS_COL]:
            continue

        hcpcs = str(row[HCPCS_COL]).strip()
        mod = row[MOD_COL]
        description = str(row[DESC_COL]).strip() if row[DESC_COL] else ''
        status = str(row[STATUS_COL]).strip() if row[STATUS_COL] else ''
        nonfac_total = row[NONFAC_TOTAL_COL]

        # Skip modifier-specific rows
        if mod:
            continue

        if status not in ACTIVE_STATUSES or not CPT_PATTERN.match(hcpcs):
            continue

        if isinstance(nonfac_total, (int, float)) and nonfac_total > 0:
            rates[hcpcs] = {
                "rate": round(float(nonfac_total) * CONVERSION_FACTOR, 2),
                "description": description,
            }

    return rates


def main():
    os.makedirs(OUTPUT_PATH.parent, exist_ok=True)

    # Accept local file as argument
    local_file = sys.argv[1] if len(sys.argv) > 1 else None
    if local_file and Path(local_file).exists():
        print(f"Using local file: {local_file}")
        zip_bytes = Path(local_file).read_bytes()
    else:
        zip_bytes = None
        for url in MPFS_URLS:
            print(f"Trying {url}...")
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    zip_bytes = resp.read()
                print(f"Downloaded {len(zip_bytes):,} bytes")
                break
            except Exception as e:
                print(f"  Failed: {e}")

    if not zip_bytes:
        print("ERROR: All downloads failed.")
        print("Download from: https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files")
        sys.exit(1)

    rates = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        print(f"Files in ZIP: {z.namelist()}")
        # Find PPRRVU non-QPP XLSX (the main payment file)
        xlsx_files = [n for n in z.namelist() if 'nonqpp' in n.lower() and n.lower().endswith('.xlsx')]
        if not xlsx_files:
            xlsx_files = [n for n in z.namelist() if 'pprrvu' in n.lower() and n.lower().endswith('.xlsx')]
        if not xlsx_files:
            xlsx_files = [n for n in z.namelist() if n.lower().endswith('.xlsx')]

        for fname in xlsx_files:
            print(f"Parsing {fname}...")
            with z.open(fname) as f:
                rates = parse_mpfs_xlsx(f.read())
            if rates:
                print(f"Parsed {len(rates):,} rates from {fname}")
                break

    if not rates:
        print("ERROR: No rates parsed.")
        sys.exit(1)

    OUTPUT_PATH.write_text(json.dumps(rates, sort_keys=True, indent=2))
    size_kb = OUTPUT_PATH.stat().st_size // 1024
    print(f"Wrote {len(rates):,} rates to {OUTPUT_PATH} ({size_kb} KB)")
    print(f"Sample: 99285 = {rates.get('99285', 'NOT FOUND')}")
    print(f"Sample: 70450 = {rates.get('70450', 'NOT FOUND')}")
    print(f"Sample: 70486 = {rates.get('70486', 'NOT FOUND')}")


if __name__ == '__main__':
    main()
