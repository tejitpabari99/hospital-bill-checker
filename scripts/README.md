# CMS Data Pipeline Scripts

These Python scripts download CMS public data and build the static JSON lookup tables used by the audit engine.

Run them once before building, and re-run quarterly when CMS updates their files.

## Setup

```bash
pip install openpyxl requests
```

## Scripts

| Script | Data source | Output | Update frequency |
|--------|------------|--------|-----------------|
| `build_mpfs.py` | CMS Medicare Physician Fee Schedule | `src/lib/data/mpfs.json` | Annual (Jan) |
| `build_ncci.py` | CMS NCCI PTP Edits | `src/lib/data/ncci.json` | Quarterly |
| `build_asp.py` | CMS Average Sales Price | `src/lib/data/asp.json` | Quarterly |

## Run all

```bash
python3 scripts/build_mpfs.py
python3 scripts/build_ncci.py
python3 scripts/build_asp.py
```

## Data sources

- MPFS: https://www.cms.gov/medicare/physician-fee-schedule/search
- NCCI: https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits
- ASP: https://www.cms.gov/medicare/medicare-part-b-drug-average-sales-price
