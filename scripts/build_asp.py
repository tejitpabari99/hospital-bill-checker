#!/usr/bin/env python3
"""
Build CMS ASP (Average Sales Price) drug pricing lookup JSON.
Downloads quarterly ASP pricing file from CMS.

Output: { "JCODE": payment_limit_per_unit }

CMS page: https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files
URL pattern: https://www.cms.gov/files/zip/{month}-{year}-asp-pricing-file.zip
  e.g. https://www.cms.gov/files/zip/july-2025-asp-pricing-file.zip

The ZIP contains a CSV with an 8-row header block; data starts on row 9.
Columns: HCPCS Code, Short Description, HCPCS Code Dosage, Payment Limit, ...

Payment Limit = ASP + 6% (what Medicare pays providers per billing unit).
Our pharmacy markup threshold is 4.5× this amount.

Run quarterly. Accepts a local zip file: python3 build_asp.py /path/to/asp.zip
"""
import json
import zipfile
import io
import os
import re
import csv
import sys
import urllib.request
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "asp.json"

# Update these each quarter.
# Old pattern: {month}-{year}-asp-pricing-file.zip (through Q3 2025)
# New pattern: {month}-{year}-medicare-part-b-payment-limit-files[-date-final-file].zip (Q4 2025+)
# CMS publishes: January (Q1 effective), April (Q2), July (Q3), October (Q4)
ASP_URLS = [
    "https://www.cms.gov/files/zip/april-2026-medicare-part-b-payment-limit-files-03-30-2026-final-file.zip",  # Q2 2026 (most recent)
    "https://www.cms.gov/files/zip/january-2026-medicare-part-b-payment-limit-files.zip",                       # Q1 2026
    "https://www.cms.gov/files/zip/october-2025-asp-pricing-final-file.zip",                                    # Q4 2025
    "https://www.cms.gov/files/zip/july-2025-asp-pricing-file.zip",                                             # Q3 2025 (fallback)
]

# HCPCS codes to include — J-codes (Part B injectable drugs) and some Q/C codes
HCPCS_PATTERN = re.compile(r'^[JQCAB][0-9]{4}$')


def parse_asp_csv(content: bytes) -> dict[str, float]:
    """
    Parse CMS ASP CSV.
    The file has an 8-row header block; the column header row is row 9 (index 8).
    Columns: HCPCS Code, Short Description, HCPCS Code Dosage, Payment Limit, ...
    """
    asp: dict[str, float] = {}
    text = content.decode('utf-8', errors='replace')
    lines = text.splitlines()

    # Find the header row: first column must be 'HCPCS Code' (exact match, not just any mention)
    header_idx = None
    for i, line in enumerate(lines[:20]):
        first_col = line.split(',')[0].strip().strip('"')
        if first_col.upper() in ('HCPCS CODE', 'HCPCS'):
            header_idx = i
            break

    if header_idx is None:
        # Fallback: skip first 8 rows
        header_idx = 8

    data_text = '\n'.join(lines[header_idx:])
    reader = csv.DictReader(io.StringIO(data_text))

    for row in reader:
        # Normalize column names
        cols = {k.strip().upper().replace(' ', '_'): v.strip() for k, v in row.items() if k}

        code = (
            cols.get('HCPCS_CODE') or
            cols.get('HCPCS') or
            cols.get('CODE')
        )
        rate = (
            cols.get('PAYMENT_LIMIT') or
            cols.get('ASP_PAYMENT_LIMIT') or
            cols.get('AMOUNT')
        )

        if not code or not rate:
            continue

        code = re.sub(r'\s+', '', code).upper()
        rate_str = rate.replace('$', '').replace(',', '').strip()

        if HCPCS_PATTERN.match(code) and rate_str:
            try:
                val = float(rate_str)
                if val > 0:
                    asp[code] = round(val, 4)
            except ValueError:
                pass

    return asp


def main():
    os.makedirs(OUTPUT_PATH.parent, exist_ok=True)

    # Accept local file as argument
    local_file = sys.argv[1] if len(sys.argv) > 1 else None
    if local_file and Path(local_file).exists():
        print(f"Using local file: {local_file}")
        zip_bytes = Path(local_file).read_bytes()
    else:
        zip_bytes = None
        for url in ASP_URLS:
            print(f"Trying {url}...")
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    zip_bytes = resp.read()
                print(f"Downloaded {len(zip_bytes):,} bytes from {url}")
                break
            except Exception as e:
                print(f"  Failed: {e}")

    if not zip_bytes:
        print("ERROR: All downloads failed.")
        print("To update URLs: go to https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files")
        print("Find the latest quarter, right-click the download link → Copy link address.")
        print("URL pattern: https://www.cms.gov/files/zip/{month}-{year}-asp-pricing-file.zip")
        print("Or: python3 build_asp.py /path/to/downloaded.zip")
        sys.exit(1)

    asp: dict[str, float] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        print(f"Files in ZIP: {z.namelist()}")
        # Prefer Section 508 CSV (more reliable encoding)
        csv_files = [n for n in z.namelist() if n.lower().endswith('.csv')]
        xls_files = [n for n in z.namelist() if n.lower().endswith('.xls') or n.lower().endswith('.xlsx')]

        files_to_try = csv_files + xls_files
        for fname in files_to_try:
            print(f"Parsing {fname}...")
            with z.open(fname) as f:
                raw = f.read()

            if fname.lower().endswith('.csv'):
                asp = parse_asp_csv(raw)
            else:
                asp = parse_asp_xlsx(raw, fname)

            if asp:
                print(f"Parsed {len(asp):,} rates from {fname}")
                break

    if not asp:
        print("ERROR: No rates parsed from ZIP.")
        sys.exit(1)

    OUTPUT_PATH.write_text(json.dumps(asp, sort_keys=True, indent=2))
    size_kb = OUTPUT_PATH.stat().st_size // 1024
    print(f"Wrote {len(asp):,} rates to {OUTPUT_PATH} ({size_kb} KB)")
    print(f"Sample: J0696 = {asp.get('J0696', 'NOT FOUND')}")
    print(f"Sample: J9035 = {asp.get('J9035', 'NOT FOUND')}")
    print(f"Sample: J1100 = {asp.get('J1100', 'NOT FOUND')}")


def parse_asp_xlsx(xlsx_bytes: bytes, fname: str) -> dict[str, float]:
    """Parse ASP XLSX file (fallback if CSV not available)."""
    try:
        import openpyxl
    except ImportError:
        print("openpyxl not installed. Run: pip install openpyxl")
        return {}

    asp: dict[str, float] = {}
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes), read_only=True, data_only=True)
    ws = wb.active

    header_row = None
    hcpcs_col = None
    rate_col = None

    for row_idx, row in enumerate(ws.iter_rows(values_only=True)):
        if header_row is None:
            # Find header row
            for col_idx, cell in enumerate(row):
                if cell and 'hcpcs' in str(cell).lower():
                    header_row = row_idx
                    hcpcs_col = col_idx
                elif cell and 'payment' in str(cell).lower() and 'limit' in str(cell).lower():
                    rate_col = col_idx
            if header_row is not None:
                continue

        if hcpcs_col is None or rate_col is None:
            continue

        code = row[hcpcs_col]
        rate = row[rate_col]

        if not code:
            continue

        code_str = re.sub(r'\s+', '', str(code)).upper()
        if not HCPCS_PATTERN.match(code_str):
            continue

        if isinstance(rate, (int, float)) and rate > 0:
            asp[code_str] = round(float(rate), 4)

    return asp


if __name__ == '__main__':
    main()
