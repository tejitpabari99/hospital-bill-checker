#!/usr/bin/env python3
"""
Build NCCI (National Correct Coding Initiative) PTP lookup JSON.
Downloads quarterly NCCI PTP edits from CMS and parses the tab-delimited text files.

Output format: { "col2_code": { "bundledInto": ["col1_a", "col1_b"], "modifierCanOverride": bool } }
  - col2_code = component code (bundled, should NOT be billed separately)
  - bundledInto = list of Column 1 (comprehensive) codes it bundles into
  - modifierCanOverride = True if modifier -59/X{EPSU} can override, False if always an error

Run quarterly.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Iterable

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "ncci.json"

SOURCE_GROUPS = [
    {
        "name": "CMS Medicare NCCI PTP 2026 Q2",
        "urls": [
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f1.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f2.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f3.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-practitioner-ptp-edits-ccipra-v321r0-f4.zip",
        ],
    },
    {
        "name": "CMS Medicare NCCI PTP 2026 Q2 Hospital Outpatient",
        "urls": [
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f1.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f2.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f3.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-ptp-edits-ccioph-v321r0-f4.zip",
        ],
    },
    {
        "name": "CMS Medicare NCCI PTP 2026 Q1",
        "urls": [
            "https://www.cms.gov/files/zip/medicare-ncci-2026q1-practitioner-ptp-edits-ccipra-v320r0-f1.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q1-practitioner-ptp-edits-ccipra-v320r0-f2.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q1-practitioner-ptp-edits-ccipra-v320r0-f3.zip",
            "https://www.cms.gov/files/zip/medicare-ncci-2026q1-practitioner-ptp-edits-ccipra-v320r0-f4.zip",
        ],
    },
    {
        "name": "CMS Medicaid NCCI Practitioner Services 2026 Q2",
        "urls": [
            "https://www.cms.gov/files/zip/medicaid-ncci-q2-2026-ptp-edits-practitioner-services.zip",
        ],
    },
    {
        "name": "CMS Medicaid NCCI Practitioner Services 2026 Q1",
        "urls": [
            "https://www.cms.gov/files/zip/medicaid-ncci-q1-2026-ptp-edits-practitioner-services.zip",
        ],
    },
]

# Active date threshold — edits with deletion date before this are expired.
# Update to the first day of the current quarter.
ACTIVE_DATE = 20260401

CODE_PATTERN = re.compile(r"^(?:[0-9]{5}|[0-9]{4}[A-Z]|[A-Z][0-9]{4})$")


def parse_ncci_txt(txt_bytes: bytes) -> dict[str, dict[str, object]]:
    """Parse one NCCI tab-delimited text file."""
    bundling: dict[str, dict[str, object]] = defaultdict(
        lambda: {"bundledInto": [], "modifierCanOverride": None}
    )
    text = io.StringIO(txt_bytes.decode("utf-8", errors="replace"))

    for line in text:
        line = line.rstrip("\r\n")
        if not line:
            continue

        parts = line.split("\t")
        if len(parts) < 5:
            continue

        col1 = parts[0].strip().upper()
        col2 = parts[1].strip().upper()

        if not CODE_PATTERN.match(col1) or not CODE_PATTERN.match(col2):
            continue

        has_medicare_shape = len(parts) > 5 and parts[2].strip() in {"", "*"}
        del_dt_str = parts[4].strip() if has_medicare_shape else parts[3].strip()
        mod_indicator = parts[5].strip() if has_medicare_shape else (parts[4].strip() if len(parts) > 4 else "1")

        try:
            del_dt = int(del_dt_str) if del_dt_str and del_dt_str != "*" else 99991231
        except ValueError:
            del_dt = 99991231

        if del_dt < ACTIVE_DATE:
            continue

        entry = bundling[col2]
        bundled_into = entry["bundledInto"]
        if col1 not in bundled_into:
            bundled_into.append(col1)

        if mod_indicator == "0":
            entry["modifierCanOverride"] = False
        elif entry["modifierCanOverride"] is None and mod_indicator in {"1", "9"}:
            entry["modifierCanOverride"] = True

    return bundling


def merge_bundling(
    target: dict[str, dict[str, object]],
    incoming: dict[str, dict[str, object]],
) -> None:
    for code, data in incoming.items():
        entry = target.setdefault(code, {"bundledInto": [], "modifierCanOverride": None})

        for bundled_code in data["bundledInto"]:
            if bundled_code not in entry["bundledInto"]:
                entry["bundledInto"].append(bundled_code)

        if data["modifierCanOverride"] is False:
            entry["modifierCanOverride"] = False
        elif entry["modifierCanOverride"] is None:
            entry["modifierCanOverride"] = data["modifierCanOverride"]


def finalize(bundling: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    return {
        code: {
            "bundledInto": sorted(entry["bundledInto"]),
            "modifierCanOverride": (
                entry["modifierCanOverride"] if entry["modifierCanOverride"] is not None else True
            ),
        }
        for code, entry in sorted(bundling.items())
    }


def download_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def resolve_zip_sources(args: list[str]) -> tuple[list[str], str, str]:
    local_files = [Path(arg) for arg in args if Path(arg).exists()]
    if local_files:
        print(f"Using local file(s): {', '.join(str(path) for path in local_files)}")
        return [str(path) for path in local_files], "local file(s)", "local"

    for group in SOURCE_GROUPS:
        print(f"Trying source: {group['name']}")
        downloads: list[str] = []
        for url in group["urls"]:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    size = resp.headers.get("Content-Length")
                if size:
                    print(f"  Reachable {url} ({int(size):,} bytes)")
                else:
                    print(f"  Reachable {url}")
                downloads.append(url)
            except Exception as exc:
                print(f"  Failed {url}: {exc}")
                downloads = []
                break

        if downloads:
            print(f"Using source: {group['name']}")
            return downloads, group["name"], "remote"

    print("ERROR: All downloads failed.")
    print(
        "Try a local ZIP download from either:\n"
        "  Medicare: https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits\n"
        "  Medicaid: https://www.cms.gov/medicare/coding-billing/ncci-medicaid/medicaid-ncci-edit-files"
    )
    sys.exit(1)


def iter_zip_sources(sources: list[str], source_type: str) -> Iterable[tuple[str, bytes]]:
    for source in sources:
        if source_type == "local":
            path = Path(source)
            yield path.name, path.read_bytes()
            continue

        data = download_bytes(source)
        print(f"Downloaded {len(data):,} bytes from {source}")
        yield source, data


def parse_zip_sources(sources: list[str], source_type: str) -> dict[str, dict[str, object]]:
    bundling: dict[str, dict[str, object]] = {}

    for source_name, zip_bytes in iter_zip_sources(sources, source_type):
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            txt_files = [name for name in archive.namelist() if name.lower().endswith(".txt")]
            print(f"Files in {source_name}: {archive.namelist()}")

            parsed_any = False
            for filename in txt_files:
                print(f"Parsing {filename}...")
                parsed = parse_ncci_txt(archive.read(filename))
                if not parsed:
                    continue

                merge_bundling(bundling, parsed)
                print(f"  Parsed {len(parsed):,} component codes from {filename}")
                parsed_any = True

            if not parsed_any:
                print(f"WARNING: No practitioner PTP text file parsed from {source_name}")

    return bundling


def main() -> None:
    os.makedirs(OUTPUT_PATH.parent, exist_ok=True)

    sources, source_used, source_type = resolve_zip_sources(sys.argv[1:])
    bundling = parse_zip_sources(sources, source_type)

    if not bundling:
        print("ERROR: No data parsed from ZIP source(s). Check file format.")
        sys.exit(1)

    final = finalize(bundling)
    OUTPUT_PATH.write_text(json.dumps(final, sort_keys=True, indent=2))
    size_kb = OUTPUT_PATH.stat().st_size // 1024

    print(f"Wrote {len(final):,} entries to {OUTPUT_PATH} ({size_kb} KB)")
    print(f"Source used: {source_used}")
    print(f"Sample: 70450 = {final.get('70450', 'NOT FOUND')}")
    print(f"Sample: 93010 = {final.get('93010', 'NOT FOUND')}")
    print(f"Sample: 0001A = {final.get('0001A', 'NOT FOUND')}")


if __name__ == "__main__":
    main()
