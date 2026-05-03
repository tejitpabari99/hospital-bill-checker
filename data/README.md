# data/

This directory contains all SQLite databases used by the hospital bill checker app.
Files are NOT committed to git — they must be built from CMS source data using the scripts below.

## Directory Structure

```
data/
  ncci.sqlite              — NCCI PTP edits (3 bill types)
  mue.sqlite               — Medically Unlikely Edits (3 bill types)
  mpfs.sqlite              — Medicare Physician Fee Schedule
  clfs.sqlite              — Clinical Lab Fee Schedule
  asp.sqlite               — Average Sales Price (Part B drugs)
  opps.sqlite              — OPPS Addendum B + A (outpatient APC rates)
  ipps.sqlite              — IPPS DRG weights (inpatient)
  dmepos.sqlite            — DMEPOS state fee schedule
  ambulance.sqlite         — Ambulance Fee Schedule + ZIP geography
  hospital_directory.sqlite — CMS hospital directory (for name matching)
  hospital_cache/          — Per-hospital MRF pricing (7-day TTL, auto-populated)
```

## Rebuilding All Databases

Run scripts in order (each is idempotent — safe to re-run):

```bash
python3 scripts/build_ncci_sqlite.py
python3 scripts/build_mue_sqlite.py
python3 scripts/build_mpfs_sqlite.py
python3 scripts/build_clfs_sqlite.py
python3 scripts/build_asp_sqlite.py
python3 scripts/build_opps_sqlite.py
python3 scripts/build_ipps_sqlite.py
python3 scripts/build_dmepos_sqlite.py
python3 scripts/build_ambulance_sqlite.py
python3 scripts/build_hospital_directory_sqlite.py
```

Each script downloads the latest CMS files and creates/replaces the SQLite database.
Scripts require: `pip install requests openpyxl duckdb`

## Checking Database Sizes

```bash
du -sh data/*.sqlite
sqlite3 data/ncci.sqlite "SELECT COUNT(*) FROM ncci_ptp"
sqlite3 data/mue.sqlite "SELECT COUNT(*) FROM mue_edits"
```

## Hospital Cache

The `hospital_cache/` subdirectory is populated automatically when the app processes a bill
that includes a recognized hospital name. You can pre-populate it by running:

```bash
python3 scripts/fetch_hospital_trilliant.py "Hospital Name" --state TX
```

Cache files older than 7 days are automatically refreshed on next lookup.

## Data Freshness

See `DATA-CLEANUP.md` for per-source refresh cadences and staleness notes.
See `/data` in the running app for the same information in a UI.
