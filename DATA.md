# Data Sources — Hospital Bill Checker

This document describes every data file used by the app, where it came from, how to verify it, and how to refresh it.

**Last updated:** 2026-03-31

---

## Summary Table

| File | Source | Entries | Updated | Status |
|------|--------|---------|---------|--------|
| `src/lib/data/ncci.json` | CMS Medicare NCCI PTP Edits Q2 2026, with Medicaid fallback | 8,150 | Quarterly | ✅ Current |
| `src/lib/data/mpfs.json` | CMS MPFS RVU26A (2026 Physician Fee Schedule) | 7,436 | Annually | ✅ Current |
| `src/lib/data/asp.json` | CMS ASP Q3 2025 (July 2025 pricing file) | 931 | Quarterly | ✅ Current |
| `src/lib/data/clfs.json` | CMS CLFS Q2 2026 (`26CLABQ2`) | 2,006 | Quarterly | ✅ Current |
| `src/lib/data/hospital_index.json` | CMS Hospital General Information | ~7,000 | Monthly | ✅ Existing |
| `data/ncci-q2-2026.zip` | Raw download cache | — | — | Source file |

---

## 1. NCCI — National Correct Coding Initiative

### What it does
NCCI PTP (Procedure-to-Procedure) edits define which CPT codes **cannot be billed together** without a modifier. When a "component" code (Column 2) and its "comprehensive" code (Column 1) both appear on a bill, the component code is being unbundled — it should not be billed separately.

### File location
```
src/lib/data/ncci.json
```

### Format
```json
{
  "93010": {
    "bundledInto": ["93000", "93005"],
    "modifierCanOverride": true
  },
  "70450": {
    "bundledInto": ["70460", "70470", "70496", "77301", "78811", "78812", "78813", "78814", "78815", "78816"],
    "modifierCanOverride": false
  }
}
```

- **Key** = Column 2 code (component — the one being unbundled)
- **bundledInto** = Column 1 codes (comprehensive — the one that includes it). A code can bundle into multiple different Column 1 codes.
- **modifierCanOverride** = `true` means modifier -59 (or X{EPSU}) can override the rule with documented clinical justification. `false` means it's always an error regardless of modifier.

### Source
- **Organization:** Centers for Medicare & Medicaid Services (CMS)
- **Dataset:** Medicare NCCI PTP Edits, with Medicaid Practitioner Services fallback
- **Download page:** https://www.cms.gov/medicare/coding-billing/ncci-medicaid/medicaid-ncci-edit-files
- **Preferred direct URLs:** `https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f1.zip` through `...-f4.zip`
- **Fallback direct URL:** `https://www.cms.gov/files/zip/medicaid-ncci-q2-2026-ptp-edits-practitioner-services.zip`
- **Files used inside ZIP:** the practitioner PTP `.TXT` file(s) inside each CMS ZIP
- **Raw ZIP cache:** optional local ZIPs passed to `scripts/build_ncci.py`

### How the data was built
```bash
python3 scripts/build_ncci.py data/ncci-q2-2026.zip
```

### Key facts about this dataset
- **Total rows in raw file:** 2,518,439
- **Expired/deleted edits (filtered out):** 610,326
- **Invalid code format (filtered out):** 325,829
- **Active entries in output:** 8,150 unique component codes
- **Effective dates:** April 1, 2026 – June 30, 2026

### Important findings about 70450 + 70486
After investigating the NCCI data: **CPT 70450 (CT Head) and CPT 70486 (CT Maxillofacial) are NOT directly bundled with each other** in the NCCI. They are separate anatomical areas (brain vs. face/sinuses) and CAN legitimately be billed together. The AI was hallucinating when it flagged them as an unbundling pair. The correct NCCI rules are:
- 70450 bundles into: 70460, 70470, 70496, 77301, 78811–78816 (with-contrast versions and PET/CT combinations)
- 70486 bundles into: 70487, 70488, 78811–78816

### How to verify
```bash
python3 -c "
import json
data = json.load(open('src/lib/data/ncci.json'))
print('Total entries:', len(data))
# Should be ~8,000–10,000 for Q2 2026
print('70450:', data.get('70450'))
print('93010:', data.get('93010'))
# 93010 should bundle into 93000 (ECG interpretation into full ECG)
print('modifierCanOverride=False count:', sum(1 for v in data.values() if not v['modifierCanOverride']))
"
```

### How to refresh (quarterly)
1. Run `python3 scripts/build_ncci.py`
2. The script now tries the Medicare quarterly practitioner PTP ZIP parts first and falls back to the Medicaid Practitioner Services ZIP if Medicare is unavailable.
3. Confirm the script output reports `Source used: ...` and writes the expected entry count.
4. If CMS changes the URLs, update `SOURCE_GROUPS` and `ACTIVE_DATE` in `scripts/build_ncci.py`.
5. Commit the updated `ncci.json`

**Schedule:** Q1 = Jan 1, Q2 = Apr 1, Q3 = Jul 1, Q4 = Oct 1

---

## 2. MPFS — Medicare Physician Fee Schedule

### What it does
Maps CPT codes to their 2026 Medicare payment rates (non-facility, national average). Used to:
- Flag potential upcoding (billed amount >> Medicare rate)
- Estimate potential overcharge in findings
- Provide financial benchmark in dispute letters

### File location
```
src/lib/data/mpfs.json
```

### Format
```json
{
  "99285": {
    "rate": 170.78,
    "description": "Emergency dept visit hi mdm"
  },
  "70450": {
    "rate": 106.20,
    "description": "Ct head/brain w/o dye"
  }
}
```

- **rate** = 2026 non-facility national Medicare payment in USD (Non-Facility Total RVU × $33.29 conversion factor)
- **description** = Short official description from CMS

### Source
- **Organization:** CMS
- **Dataset:** 2026 MPFS Relative Value Files (RVU26A), January release
- **Download page:** https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files
- **Direct URL:** `https://www.cms.gov/files/zip/rvu26a.zip` (5.7 MB)
- **File used inside ZIP:** `PPRRVU2026_Jan_nonQPP.xlsx`

### How the data was built
```bash
python3 scripts/build_mpfs.py  # downloads automatically
# or with local file:
python3 scripts/build_mpfs.py /path/to/rvu26a.zip
```

### Key facts about this dataset
- **Total active codes:** 7,436
- **Status A codes:** ~5,000 (fully active, calculated from RVUs)
- **Conversion factor:** $33.29 (2026 non-QPP)
- **Lab codes (status X):** Excluded — lab codes are paid under the Clinical Laboratory Fee Schedule (CLFS), not MPFS. Common examples: 85025 (CBC), 80053 (metabolic panel), 36415 (venipuncture).

### Lab codes not in MPFS
Lab codes with MPFS status "X" are excluded because their payment comes from the separate CLFS. The app now uses `src/lib/data/clfs.json` as the deterministic fallback for those codes, so common lab and pathology services still get a CMS benchmark without sending the pricing question to AI.

---

## 3. CLFS — Clinical Laboratory Fee Schedule

### What it does
Maps lab and pathology HCPCS/CPT codes to their CLFS payment rate when MPFS has no rate. Used to:
- Provide deterministic Medicare benchmarks for lab codes
- Fill in `medicareRate` for duplicate or other deterministic findings on lab items
- Avoid sending lab-rate lookup work to Gemini when CLFS covers the code

### File location
```
src/lib/data/clfs.json
```

### Format
```json
{
  "85025": {
    "rate": 7.77,
    "description": "Blood count; complete (cbc), automated..."
  }
}
```

- **rate** = CLFS payment amount in USD
- **description** = CMS description from the CLFS release

### Source
- **Organization:** CMS
- **Dataset:** Clinical Laboratory Fee Schedule quarterly release
- **Download page:** https://www.cms.gov/Medicare/Medicare-Fee-for-Service-Payment/ClinicalLabFeeSched/index.html
- **Current direct URL:** `https://www.cms.gov/files/zip/26clabq2.zip`

### How the data was built
```bash
python3 scripts/build_clfs.py
```

### Key facts about this dataset
- **Total active codes:** 2,006
- **Examples covered:** 85025 (CBC), 80053 (comprehensive metabolic panel), 36415 (venipuncture), 85610 (PT), PLA codes such as 0001U
- **Usage:** only as a fallback when MPFS has no rate for the billed code

### How to verify
```bash
python3 -c "
import json
data = json.load(open('src/lib/data/clfs.json'))
print('Total codes:', len(data))
for code in ['85025', '80053', '36415', '0001U', '85610']:
    print(code, data.get(code))
"
```

### How to refresh (quarterly)
1. Run `python3 scripts/build_clfs.py`
2. If CMS changes the quarterly ZIP name, update `CLFS_URLS` in `scripts/build_clfs.py`
3. Commit the updated `clfs.json`

### How to verify
```bash
python3 -c "
import json
data = json.load(open('src/lib/data/mpfs.json'))
print('Total codes:', len(data))
# Should be ~7,000+
for code in ['99285', '70450', '70486', '99213']:
    r = data.get(code)
    print(f'{code}: \${r[\"rate\"]} — {r[\"description\"]}' if r else f'{code}: NOT FOUND')
"
```

Expected output:
```
Total codes: 7436
99285: $170.78 — Emergency dept visit hi mdm
70450: $106.20 — Ct head/brain w/o dye
70486: $127.83 — Ct maxillofacial w/o dye
99213: $94.88 — Office o/p est low 20 min
```

### How to refresh (annually)
1. Go to: https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files
2. Download the new year's RVU file (e.g., `rvu27a.zip` for 2027)
3. Update `MPFS_URLS` and `CONVERSION_FACTOR` in `scripts/build_mpfs.py` 
4. Run: `python3 scripts/build_mpfs.py`
5. Commit the updated `mpfs.json`

**Schedule:** Annually in January. CMS also releases quarterly updates (B, C, D versions) for minor corrections — re-run if billing codes are being missed.

---

## 3. ASP — CMS Average Sales Price (Drug Pricing)

### What it does
Maps J-codes (Part B drug codes) to their CMS-allowed payment limit. Used to detect pharmacy markup fraud: if a hospital bills more than 4.5× the ASP limit, it's flagged as a pharmacy markup error.

### File location
```
src/lib/data/asp.json
```

### Format
```json
{
  "J0696": 1.45,
  "J9035": 694.89
}
```

- **Key** = J-code (HCPCS Level II drug code)
- **Value** = CMS ASP payment limit per billing unit in USD
- **CMS policy:** Hospitals can bill up to 106% of ASP (6% allowed markup). Over 4.5× = pharmacy markup error.

### Source
- **Organization:** CMS
- **Dataset:** Part B Drug Average Sales Price quarterly files
- **Page:** https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files

### Current status
✅ **931 J/Q-codes from CMS ASP Q3 2025 (July 2025 pricing file).**  
Effective July 1 – September 30, 2025. Based on 1Q25 ASP data.

### How to refresh (quarterly)
1. Go to: https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files
2. Download the latest quarter's pricing ZIP (right-click → Copy link address)
3. Update `ASP_URLS` list at the top of `scripts/build_asp.py` with the new URL
4. Run: `python3 scripts/build_asp.py`

**URL pattern:** `https://www.cms.gov/files/zip/{month}-{year}-asp-pricing-file.zip`  
Example: `https://www.cms.gov/files/zip/october-2025-asp-pricing-file.zip`  
Months: `january`, `april`, `july`, `october`

### How to verify
```bash
python3 -c "
import json
data = json.load(open('src/lib/data/asp.json'))
print('Total J-codes:', len(data))
# Should be ~900+ for current quarter
print('J0696 (Ceftriaxone):', data.get('J0696'))   # ~0.48 in Q3 2025
print('J9035 (Bevacizumab):', data.get('J9035'))   # ~73.05 in Q3 2025
print('J1100 (Dexamethasone):', data.get('J1100')) # ~0.12 in Q3 2025
"
```

---

## 4. Hospital Index

### What it does
Maps hospital names to their CMS Certification Number (CCN), domain, NPI, and address. Used by the hospital price lookup feature to find a hospital's CMS machine-readable file (MRF) for price comparison.

### File location
```
src/lib/data/hospital_index.json
```

### Source
- **Organization:** CMS
- **Dataset:** Hospital General Information
- **API:** `https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0`
- **Script:** `scripts/build_hospital_index.py`

### How to verify
```bash
python3 -c "
import json
data = json.load(open('src/lib/data/hospital_index.json'))
print('Total hospitals:', len(data))
# Should be 5,000–8,000
"
```

### How to refresh (monthly)
```bash
python3 scripts/build_hospital_index.py
```

---

## 5. Hospital MRF Cache (runtime)

### What it does
On-demand SQLite databases storing a specific hospital's own published prices (gross charge, cash discount) from their CMS-required Machine-Readable File (MRF). Used to compare a patient's billed amount against what the hospital itself publishes.

### File location
```
data/mrf_cache/{hospital_slug}.db
```

### How it works
- Fetched on-demand when an audit includes a recognizable hospital name
- 24-hour TTL — refetched if cache is older than 24 hours
- Python script: `scripts/fetch_hospital_mrf.py`
- Not committed to git (in `.gitignore`)

### How to verify
```bash
ls -lh data/mrf_cache/
# Each .db file represents one hospital's price data
python3 -c "
import sqlite3
db = sqlite3.connect('data/mrf_cache/[hospital_slug].db')
print(db.execute('SELECT COUNT(*) FROM charges').fetchone())
db.close()
"
```

---

## Data File Sizes (as of 2026-03-31)

| File | Size | Entries |
|------|------|---------|
| `ncci.json` | 575 KB | 8,150 |
| `mpfs.json` | 615 KB | 7,436 |
| `asp.json` | ~17 KB | 931 (Q3 2025) |
| `clfs.json` | 454 KB | 2,006 |
| `hospital_index.json` | varies | ~7,000 |

---

## How Data is Used in the Audit

The data is loaded at server startup (not per-request):
```typescript
// src/lib/server/claude.ts lines 56-64
let mpfs = {}
let ncci = {}
let asp = {}
let clfs = {}
try { mpfs = (await import('$lib/data/mpfs.json')).default } catch {}
try { ncci = (await import('$lib/data/ncci.json')).default } catch {}
try { asp = (await import('$lib/data/asp.json')).default } catch {}
try { clfs = (await import('$lib/data/clfs.json')).default } catch {}
```

Per-request, only data for codes **actually on the bill** is used:
1. **NCCI**: For each code on the bill, check if it's a component (Col2) code AND its Col1 code is also on the bill → deterministic unbundling finding
2. **MPFS**: For each code on the bill, look up Medicare rate → inject into prompt for AI upcoding analysis
3. **ASP**: For each J-code on the bill, check markup ratio → deterministic pharmacy markup finding
4. **CLFS**: For lab codes missing from MPFS, look up the CLFS rate → deterministic Medicare benchmark for prompt context and findings
5. **Hospital MRF**: When a hospital price transparency file is available, compare billed amount to the hospital's own published gross charge and add an `above_hospital_list_price` finding for otherwise clean items

This means:
- **A bill with 10 codes** → at most 10 NCCI lookups, 10 MPFS/CLFS lookups, 10 ASP lookups, plus hospital price lookups when the hospital can be identified
- **Context sent to AI** = only the relevant data for those 10 codes, not the entire dataset
- **Deterministic findings** (NCCI unbundling, pharmacy markup, duplicates, CLFS-supported pricing context, hospital list-price comparisons) are applied **before** or alongside the AI flow

---

## Update Schedule Summary

| Dataset | Frequency | Who triggers | How |
|---------|-----------|--------------|-----|
| NCCI | Quarterly (Jan, Apr, Jul, Oct) | Developer | `python3 scripts/build_ncci.py [downloaded.zip]` |
| MPFS | Annually (January) | Developer | `python3 scripts/build_mpfs.py` |
| ASP | Quarterly | Developer | `python3 scripts/build_asp.py` (fix URL first) |
| CLFS | Quarterly | Developer | `python3 scripts/build_clfs.py` |
| Hospital Index | Monthly | Developer | `python3 scripts/build_hospital_index.py` |
| Hospital MRF Cache | Auto (24h TTL) | Server | Triggered on audit with recognized hospital |

---

## Verifying a Fresh Build End-to-End

After running build scripts, verify all four core files:

```bash
cd /root/projects/hospital-bill-checker

python3 << 'EOF'
import json

ncci = json.load(open('src/lib/data/ncci.json'))
mpfs = json.load(open('src/lib/data/mpfs.json'))
asp = json.load(open('src/lib/data/asp.json'))
clfs = json.load(open('src/lib/data/clfs.json'))

print("=== NCCI ===")
print(f"Total entries: {len(ncci)}")
print(f"Format check (should be dict): {type(list(ncci.values())[0])}")
print(f"93010 bundles into: {ncci.get('93010', {}).get('bundledInto')}")  # ECG interpretation → full ECG
print(f"70450 bundles into: {ncci.get('70450', {}).get('bundledInto')}")  # CT head → with-contrast/PET versions

print("\n=== MPFS ===")
print(f"Total entries: {len(mpfs)}")
print(f"99285 (ER visit hi): ${mpfs.get('99285', {}).get('rate')}")  # Should be ~$170–230
print(f"70450 (CT head): ${mpfs.get('70450', {}).get('rate')}")      # Should be ~$100–130
print(f"70486 (CT face): ${mpfs.get('70486', {}).get('rate')}")      # Should be ~$120–160

print("\n=== ASP ===")
print(f"Total entries: {len(asp)}")
print(f"J0696 (Ceftriaxone): ${asp.get('J0696')}")  # Should be ~$1.45 per unit

print("\n=== CLFS ===")
print(f"Total entries: {len(clfs)}")
print(f"85025 (CBC): ${clfs.get('85025', {}).get('rate')}")
print(f"80053 (CMP): ${clfs.get('80053', {}).get('rate')}")

print("\n=== PASS CRITERIA ===")
print("NCCI: PASS" if len(ncci) > 5000 else "NCCI: FAIL (too few entries)")
print("MPFS: PASS" if len(mpfs) > 5000 else "MPFS: FAIL (too few entries)")
print("ASP: PASS" if len(asp) > 100 else "ASP: WARNING - only fallback data (need to run build_asp.py)")
print("CLFS: PASS" if len(clfs) > 1000 else "CLFS: FAIL (too few entries)")
EOF
```

---

## Notes on Data Accuracy

1. **NCCI source order matters**: `scripts/build_ncci.py` now prefers Medicare practitioner PTP ZIP parts first and falls back to Medicaid Practitioner Services only if the Medicare source is unavailable. The script prints the exact source used so refreshes are auditable.

2. **MPFS rates are professional component only**: These rates apply to physician/practitioner billing. Hospital facility fees (UB-04 bills) are paid under OPPS (Outpatient Prospective Payment System), which has different rates. The MPFS rates are still useful as benchmarks but will be lower than total facility charges.

3. **Conversion factor varies**: The $33.29 CF used for 2026 may not account for QPP (Quality Payment Program) adjustments. QPP participants may have a slightly different CF. The non-QPP rate is used as the conservative baseline.

4. **Lab codes missing from MPFS**: Codes with status "X" (lab codes: 80xxx, 85xxx, 36415) are paid under CLFS rather than MPFS. They still show as NOT FOUND in `mpfs.json`, but the app now consults `clfs.json` before falling back to AI.

5. **Hospital list-price findings are supplemental**: `above_hospital_list_price` is intentionally a hospital-transparency comparison, not a Medicare-rule violation. It only appears when the hospital's own MRF can be matched and the billed charge exceeds the hospital's published gross charge.
