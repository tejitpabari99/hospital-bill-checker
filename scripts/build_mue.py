#!/usr/bin/env python3
"""
Build CMS Practitioner Services MUE lookup JSON.

Downloads the current CMS Practitioner Services MUE ZIP, reads the packaged CSV,
and emits only the date-of-service edits as a compact code -> max units lookup.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "src" / "lib" / "data" / "mue.json"

MUE_URL = "https://www.cms.gov/files/zip/medicare-ncci-2026-q2-practitioner-services-mue-table.zip"
CSV_NAME_HINT = "PractitionerServices"


def download_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def pick_csv_name(archive: zipfile.ZipFile) -> str:
    csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
    if not csv_names:
        raise RuntimeError("No CSV file found in CMS MUE ZIP")
    preferred = [name for name in csv_names if CSV_NAME_HINT.lower() in name.lower()]
    return preferred[0] if preferred else csv_names[0]


def build_mue(csv_bytes: bytes) -> dict[str, dict[str, object]]:
    mue: dict[str, dict[str, object]] = {}
    text = io.StringIO(csv_bytes.decode("utf-8", errors="replace"))
    reader = csv.reader(text)

    # CMS includes a disclaimer row before the actual header.
    next(reader, None)
    headers = next(reader, None)
    if not headers:
        raise RuntimeError("Missing MUE CSV header row")

    for row in reader:
        if not row:
            continue

        code = str(row[0]).strip().upper() if len(row) > 0 else ""
        if not code:
            continue

        try:
            max_units = int(str(row[1]).strip()) if len(row) > 1 and str(row[1]).strip() else None
        except ValueError:
            continue

        adj = str(row[2]).strip() if len(row) > 2 else ""
        if not adj.startswith("3"):
            continue
        if max_units is None:
            continue

        mue[code] = {
            "maxUnits": max_units,
            "adjudicationType": "date_of_service",
        }

    return mue


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else MUE_URL
    print(f"Downloading CMS MUE table from {url}...")
    data = download_bytes(url)

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        csv_name = pick_csv_name(archive)
        print(f"Parsing {csv_name}...")
        mue = build_mue(archive.read(csv_name))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(mue, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {len(mue):,} entries to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
