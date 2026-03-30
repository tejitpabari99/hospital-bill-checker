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

def parse_mpfs_zip(zip_bytes: bytes) -> dict[str, dict]:
    """Parse MPFS ZIP file and extract CPT → { rate, description } mapping."""
    rates: dict[str, dict] = {}

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

                    # Description — try multiple column names
                    description = (cols.get('DESCRIPTION') or cols.get('SHORT_DESCRIPTION') or
                                   cols.get('LONG_DESCRIPTION') or cols.get('DESC') or '')

                    code = code.strip()
                    amount_str = amount_str.replace('$', '').replace(',', '').strip()

                    if code and amount_str:
                        try:
                            amount = float(amount_str)
                            if amount > 0:
                                entry: dict = {"rate": round(amount, 2)}
                                if description:
                                    entry["description"] = description
                                rates[code] = entry
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
            "99202": {"rate": 72.68, "description": "Office or other outpatient visit, new patient, low complexity"},
            "99203": {"rate": 111.57, "description": "Office or other outpatient visit, new patient, moderate complexity"},
            "99204": {"rate": 167.36, "description": "Office or other outpatient visit, new patient, moderate-high complexity"},
            "99205": {"rate": 211.93, "description": "Office or other outpatient visit, new patient, high complexity"},
            "99211": {"rate": 24.76, "description": "Office or other outpatient visit, established patient, minimal"},
            "99212": {"rate": 54.74, "description": "Office or other outpatient visit, established patient, straightforward"},
            "99213": {"rate": 92.31, "description": "Office or other outpatient visit, established patient, low complexity"},
            "99214": {"rate": 130.70, "description": "Office or other outpatient visit, established patient, moderate complexity"},
            "99215": {"rate": 171.89, "description": "Office or other outpatient visit, established patient, high complexity"},
            "99281": {"rate": 22.00, "description": "Emergency department visit, self-limited or minor problem"},
            "99282": {"rate": 50.46, "description": "Emergency department visit, low complexity"},
            "99283": {"rate": 84.73, "description": "Emergency department visit, moderate complexity"},
            "99284": {"rate": 175.64, "description": "Emergency department visit, high complexity"},
            "99285": {"rate": 225.87, "description": "Emergency department visit, high medical decision making complexity"},
            "99221": {"rate": 113.91, "description": "Initial hospital care, low complexity"},
            "99222": {"rate": 165.81, "description": "Initial hospital care, moderate complexity"},
            "99223": {"rate": 218.12, "description": "Initial hospital care, high complexity"},
            "73721": {"rate": 120.00, "description": "Magnetic resonance imaging, any joint of lower extremity"},
            "93005": {"rate": 19.24, "description": "Electrocardiogram, routine ECG with at least 12 leads; tracing only"},
            "85025": {"rate": 8.06, "description": "Blood count; complete (CBC), automated"},
            "80053": {"rate": 14.56, "description": "Comprehensive metabolic panel"},
            "27447": {"rate": 1250.00, "description": "Arthroplasty, knee, condyle and plateau; medical and lateral compartments"},
            "26410": {"rate": 280.00, "description": "Repair, extensor tendon, finger, primary or secondary; without free graft"},
            "27370": {"rate": 90.00, "description": "Injection, contrast agent, for knee arthrography"},
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
