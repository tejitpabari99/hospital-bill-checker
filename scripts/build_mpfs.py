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
import urllib.request
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "mpfs.json"

# CMS MPFS 2024 national payment rates CSV (ZIP)
# Check https://www.cms.gov/medicare/physician-fee-schedule/search for latest year URL
# Format varies by year — this targets the "MPFS Relative Value Files" download
MPFS_URL = "https://downloads.cms.gov/medicare/physician-fee-schedule/2024/January/RVU24A.zip"

def parse_mpfs_zip(zip_bytes: bytes) -> dict[str, float]:
    """Parse MPFS ZIP file and extract CPT → par amount mapping."""
    rates: dict[str, float] = {}

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        # Find the RVU CSV file inside the ZIP
        csv_names = [n for n in z.namelist() if n.upper().endswith('.csv') or n.upper().endswith('.txt')]
        print(f"Files in ZIP: {z.namelist()}")

        if not csv_names:
            print("ERROR: No CSV found in ZIP")
            return rates

        # Try each file looking for HCPCS codes
        for fname in csv_names:
            with z.open(fname) as f:
                content = f.read().decode('utf-8', errors='replace')
                reader = csv.DictReader(io.StringIO(content))

                # Normalize column names
                for row in reader:
                    cols = {k.strip().upper(): v.strip() for k, v in row.items() if k}

                    # Try various column name patterns CMS uses across years
                    code = cols.get('HCPCS') or cols.get('CPT') or cols.get('HCPCS_CD') or cols.get('CODE')
                    if not code:
                        continue

                    # Par amount (participating provider) — try multiple column names
                    amount_str = (cols.get('PAR_AMOUNT') or cols.get('PHYSICIAN_WORK_RVU') or
                                  cols.get('PAR_NONFACILITY_PRICE') or cols.get('NONFACILITY_PRICE') or '')

                    code = code.strip()
                    amount_str = amount_str.replace('$', '').replace(',', '').strip()

                    if code and amount_str:
                        try:
                            amount = float(amount_str)
                            if amount > 0:
                                rates[code] = round(amount, 2)
                        except ValueError:
                            pass

                if rates:
                    print(f"Parsed {len(rates)} rates from {fname}")
                    break

    return rates

def main():
    os.makedirs(OUTPUT_PATH.parent, exist_ok=True)

    print(f"Downloading MPFS from {MPFS_URL}...")
    try:
        with urllib.request.urlopen(MPFS_URL, timeout=60) as resp:
            zip_bytes = resp.read()
        print(f"Downloaded {len(zip_bytes):,} bytes")
    except Exception as e:
        print(f"Download failed: {e}")
        print("Generating minimal fallback with common codes...")
        # Fallback: common E&M codes with approximate 2024 Medicare rates
        rates = {
            "99202": 72.68, "99203": 111.57, "99204": 167.36, "99205": 211.93,
            "99211": 24.76, "99212": 54.74, "99213": 92.31, "99214": 130.70, "99215": 171.89,
            "99281": 22.00, "99282": 50.46, "99283": 84.73, "99284": 175.64, "99285": 225.87,
            "99221": 113.91, "99222": 165.81, "99223": 218.12,
            "73721": 120.00, "93005": 19.24, "85025": 8.06, "80053": 14.56,
            "27447": 1250.00, "26410": 280.00, "27370": 90.00,
        }
        OUTPUT_PATH.write_text(json.dumps(rates, indent=2))
        print(f"Wrote {len(rates)} fallback rates to {OUTPUT_PATH}")
        return

    rates = parse_mpfs_zip(zip_bytes)

    if not rates:
        print("WARNING: No rates parsed — check URL and column format")
        sys.exit(1)

    OUTPUT_PATH.write_text(json.dumps(rates, indent=2))
    print(f"Wrote {len(rates):,} rates to {OUTPUT_PATH}")

if __name__ == '__main__':
    main()
