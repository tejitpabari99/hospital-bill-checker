#!/usr/bin/env python3
"""
Build hospital name -> CCN lookup JSON from the CMS Hospital General Information dataset.

Output:
    src/lib/data/hospital_index.json
"""

from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
import urllib.request
from pathlib import Path

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "src" / "lib" / "data" / "hospital_index.json"

API_URL = "https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0"
CSV_URL = (
    "https://data.cms.gov/provider-data/sites/default/files/resources/"
    "092256becd267d9eecca15f2a4f206c1_1694479371/Hospital_General_Information.csv"
)

USER_AGENT = "HospitalBillChecker/1.0"


_SYNONYMS = [
    (r"\bst\b\.?\s+", "saint "),
    (r"\bmt\b\.?\s+", "mount "),
    (r"\bmem\b\.?\s+", "memorial "),
    (r"\bmed\s+ctr\b", "medical center"),
    (r"\bhosp\b", "hospital"),
    (r"\buniv\b\.?\s+", "university "),
    (r"\bdr\b\.?\s+", "doctor "),
]


def normalize_name(name: str) -> str:
    name = name.lower()
    name = re.sub(r"'s\b", "s", name)
    name = re.sub(r"'\b", "", name)
    for pattern, replacement in _SYNONYMS:
        name = re.sub(pattern, replacement, name)
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def _fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace")


def _load_rows() -> list[dict]:
    last_error: Exception | None = None

    try:
        rows: list[dict] = []
        offset = 0
        total = None

        while True:
            url = f"{API_URL}?offset={offset}"
            text = _fetch_text(url)
            payload = json.loads(text)

            if not isinstance(payload, dict):
                raise RuntimeError("Unexpected API response shape")

            batch = payload.get("results")
            if not isinstance(batch, list):
                raise RuntimeError("API response is missing results")

            rows.extend([row for row in batch if isinstance(row, dict)])
            total = int(payload.get("count") or len(rows))

            if len(rows) >= total or not batch:
                return rows[:total]

            offset += len(batch)
    except Exception as exc:
        last_error = exc

    try:
        text = _fetch_text(CSV_URL)
        reader = csv.DictReader(io.StringIO(text))
        rows = [row for row in reader if row]
        if rows:
            return rows
    except Exception as exc:  # pragma: no cover - network/runtime failures are surfaced to caller
        last_error = exc

    raise RuntimeError(f"Unable to download CMS hospital dataset: {last_error}")


def _pick(row: dict, *names: str) -> str:
    for name in names:
        value = row.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    rows = _load_rows()

    index: dict[str, dict[str, str | None]] = {}
    for row in rows:
        name = _pick(row, "Facility Name", "facility_name", "Provider Name", "provider_name")
        if not name:
            continue

        state = _pick(row, "State", "state")
        key = f"{normalize_name(name)}|{state.lower()}"

        index[key] = {
            "name": name,
            "city": _pick(row, "City/Town", "citytown", "city_town", "City", "city"),
            "state": state,
            "zip": _pick(row, "ZIP Code", "zip_code", "Zip Code", "zip", "ZIP"),
            "phone": _pick(row, "Phone Number", "telephone_number", "phone_number", "phone"),
            "ccn": _pick(row, "Facility ID", "facility_id", "provider_id", "CCN", "ccn"),
            "domain": None,
            "npi": None,
        }

    OUTPUT_PATH.write_text(json.dumps(index, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"Wrote {len(index):,} hospitals to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
