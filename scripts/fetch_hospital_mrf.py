#!/usr/bin/env python3
"""
Fetch and cache a hospital price transparency MRF as SQLite.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

try:
    from rapidfuzz import fuzz, process as fuzz_process
except ImportError:  # pragma: no cover - exercised only when dependency is unavailable
    from difflib import SequenceMatcher

    class _FallbackFuzz:
        @staticmethod
        def token_set_ratio(left: str, right: str) -> int:
            left_tokens = " ".join(sorted(set(left.split())))
            right_tokens = " ".join(sorted(set(right.split())))
            return int(100 * SequenceMatcher(None, left_tokens, right_tokens).ratio())

    class _FallbackProcess:
        @staticmethod
        def extractOne(query: str, choices: list[str], scorer=None, score_cutoff: int = 0):
            best_choice = None
            best_score = score_cutoff - 1
            best_index = -1
            for index, choice in enumerate(choices):
                score = scorer(query, choice) if scorer else int(100 * SequenceMatcher(None, query, choice).ratio())
                if score >= score_cutoff and score > best_score:
                    best_choice = choice
                    best_score = score
                    best_index = index
            if best_choice is None:
                return None
            return best_choice, best_score, best_index

    fuzz = _FallbackFuzz()
    fuzz_process = _FallbackProcess()

CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "mrf_cache"
INDEX_PATH = Path(__file__).resolve().parent.parent / "src" / "lib" / "data" / "hospital_index.json"
USER_AGENT = "HospitalBillChecker/1.0 (hospital price transparency lookup)"

GENERIC_NAME_PARTS = {
    "hospital",
    "medical",
    "center",
    "medical center",
    "health",
    "health system",
    "system",
    "regional",
    "community",
    "memorial",
}

CODE_TYPES = {"CPT", "HCPCS"}


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


def http_get(url: str, timeout: int = 60) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Encoding": "gzip, deflate",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read()
        encoding = response.headers.get("Content-Encoding", "")
        if encoding == "gzip" or url.endswith(".gz"):
            data = gzip.decompress(data)
        return data


def load_hospital_index() -> dict[str, dict]:
    if not INDEX_PATH.exists():
        return {}
    try:
        return json.loads(INDEX_PATH.read_text())
    except Exception:
        return {}


def _state_candidates(state: str) -> list[str]:
    state = state.strip().upper()
    return [state] if state else [""]


def guess_domain_heuristics(hospital_name: str, state: str) -> list[str]:
    slug = normalize_name(hospital_name)
    for phrase in sorted(GENERIC_NAME_PARTS, key=len, reverse=True):
        slug = re.sub(rf"\b{re.escape(phrase)}\b", "", slug)
    slug = re.sub(r"\s+", "", slug).strip()
    full_slug = re.sub(r"\s+", "", normalize_name(hospital_name))

    candidates: list[str] = []
    for stem in [full_slug, slug]:
        if not stem:
            continue
        candidates.extend(
            [
                f"https://www.{stem}.org",
                f"https://www.{stem}.com",
                f"https://{stem}.org",
                f"https://{stem}.com",
            ]
        )

    # Keep order but remove duplicates.
    seen: set[str] = set()
    ordered: list[str] = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered


def find_mrf_url_from_domain(domain: str) -> str | None:
    for path in ("/cms-hpt.txt", "/.well-known/cms-hpt.txt"):
        url = domain.rstrip("/") + path
        try:
            text = http_get(url, timeout=20).decode("utf-8", errors="replace")
        except Exception:
            continue

        for line in text.splitlines():
            line = line.strip()
            if line.lower().startswith("mrf-url:"):
                value = line.split(":", 1)[1].strip()
                if value.startswith("http"):
                    return value
    return None


def resolve_hospital_domain(hospital_name: str, state: str = "") -> tuple[str | None, str | None]:
    index = load_hospital_index()
    normalized = normalize_name(hospital_name)
    state = state.strip().upper()

    exact_keys = []
    if state:
        exact_keys.append(f"{normalized}|{state.lower()}")
    exact_keys.extend([key for key in index.keys() if key.startswith(f"{normalized}|")])

    for key in exact_keys:
        entry = index.get(key) or {}
        if entry.get("domain"):
            domain = str(entry["domain"]).strip()
            if domain:
                mrf_url = find_mrf_url_from_domain(domain)
                if mrf_url:
                    return domain, mrf_url

    candidates = guess_domain_heuristics(hospital_name, state)
    for domain in candidates:
        try:
            head_request = urllib.request.Request(domain, method="HEAD", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(head_request, timeout=12):
                pass
        except Exception:
            pass

        mrf_url = find_mrf_url_from_domain(domain)
        if mrf_url:
            return domain, mrf_url

    return None, None


def download_mrf(mrf_url: str) -> bytes:
    data = http_get(mrf_url, timeout=300)
    if mrf_url.endswith(".zip") or data.startswith(b"PK"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = [name for name in archive.namelist() if name.lower().endswith((".json", ".csv"))]
            if not names:
                return b""
            return archive.read(names[0])
    return data


def _parse_money(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = str(value).replace("$", "").replace(",", "").strip()
    if not cleaned:
        return None
    try:
        amount = float(cleaned)
    except ValueError:
        return None
    return amount if amount > 0 else None


def _infer_code_type(code: str, code_type: str = "") -> str:
    normalized_type = code_type.strip().upper()
    if normalized_type in CODE_TYPES:
        return normalized_type
    if re.fullmatch(r"\d{4,5}", code):
        return "CPT"
    if re.fullmatch(r"[A-Z]\d{4}", code.upper()):
        return "HCPCS"
    return ""


def _first_non_empty(row: dict[str, str], *candidates: str) -> str:
    for candidate in candidates:
        value = row.get(candidate)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def parse_mrf_json(data: bytes) -> list[dict]:
    obj = json.loads(data.decode("utf-8", errors="replace"))
    records: list[dict] = []

    charge_items = obj.get("standard_charge_information") or obj.get("standard_charges") or []
    if isinstance(charge_items, dict):
        charge_items = [charge_items]

    for item in charge_items:
        if not isinstance(item, dict):
            continue
        description = str(item.get("description") or item.get("plain_language_description") or "").strip()
        codes = item.get("code_information") or []
        if isinstance(codes, dict):
            codes = [codes]
        if not codes and item.get("code"):
            codes = [{"code": item.get("code"), "type": item.get("code_type") or item.get("codeType") or ""}]

        standard_charges = item.get("standard_charges") or item.get("standard_charge") or []
        if isinstance(standard_charges, dict):
            standard_charges = [standard_charges]

        for code_info in codes:
            if not isinstance(code_info, dict):
                continue
            code = str(code_info.get("code") or "").strip()
            code_type = _infer_code_type(code, str(code_info.get("type") or code_info.get("code_type") or ""))
            if not code or code_type not in CODE_TYPES:
                continue

            for charge in standard_charges:
                if not isinstance(charge, dict):
                    continue
                gross = _parse_money(
                    charge.get("gross_charge")
                    or charge.get("standard_charge_gross")
                    or charge.get("gross")
                    or charge.get("gross_charge_dollar")
                )
                cash = _parse_money(
                    charge.get("discounted_cash")
                    or charge.get("discounted_cash_price")
                    or charge.get("cash_price")
                    or charge.get("discounted_cash_dollar")
                )
                min_neg = _parse_money(
                    charge.get("minimum_negotiated_rate")
                    or charge.get("standard_charge_min")
                    or charge.get("min_negotiated")
                )
                max_neg = _parse_money(
                    charge.get("maximum_negotiated_rate")
                    or charge.get("standard_charge_max")
                    or charge.get("max_negotiated")
                )
                setting = str(charge.get("setting") or item.get("setting") or "").strip()

                if gross is None and cash is None:
                    continue

                records.append(
                    {
                        "code": code,
                        "code_type": code_type,
                        "description": description,
                        "gross_charge": gross,
                        "discounted_cash": cash,
                        "min_negotiated": min_neg,
                        "max_negotiated": max_neg,
                        "setting": setting,
                    }
                )

    return records


def parse_mrf_csv_tall(data: bytes) -> list[dict]:
    text = data.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    records: list[dict] = []

    for row in reader:
        if not row:
            continue
        normalized = {str(key).strip().lower(): (value or "").strip() for key, value in row.items() if key}

        description = _first_non_empty(normalized, "description", "plain_language_description")
        setting = _first_non_empty(normalized, "setting")

        code_entries: list[tuple[str, str]] = []
        for header, value in normalized.items():
            if not value:
                continue
            match = re.fullmatch(r"code\|(\d+)\|(cpt|hcpcs)", header)
            if match:
                code_entries.append((value, match.group(2).upper()))
                continue
            if header in {"code", "cpt", "cpt_code", "hcpcs", "hcpcs_code", "billing_code", "standard_charge_code"}:
                inferred = _infer_code_type(value, "CPT" if "cpt" in header else "HCPCS" if "hcpcs" in header else "")
                code_entries.append((value, inferred))

        gross = _parse_money(
            _first_non_empty(
                normalized,
                "standard_charge|gross",
                "standard_charge_gross",
                "gross_charge",
                "gross",
            )
        )
        cash = _parse_money(
            _first_non_empty(
                normalized,
                "standard_charge|discounted_cash",
                "standard_charge_discounted_cash",
                "discounted_cash",
                "discounted_cash_price",
                "cash_price",
            )
        )
        min_neg = _parse_money(
            _first_non_empty(
                normalized,
                "standard_charge|min",
                "standard_charge_min",
                "minimum_negotiated_rate",
                "min_negotiated",
            )
        )
        max_neg = _parse_money(
            _first_non_empty(
                normalized,
                "standard_charge|max",
                "standard_charge_max",
                "maximum_negotiated_rate",
                "max_negotiated",
            )
        )

        if gross is None and cash is None:
            continue

        seen_codes: set[tuple[str, str]] = set()
        for code, code_type in code_entries:
            normalized_code = str(code).strip()
            resolved_type = _infer_code_type(normalized_code, code_type)
            if not normalized_code or resolved_type not in CODE_TYPES:
                continue
            signature = (normalized_code, resolved_type)
            if signature in seen_codes:
                continue
            seen_codes.add(signature)
            records.append(
                {
                    "code": normalized_code,
                    "code_type": resolved_type,
                    "description": description,
                    "gross_charge": gross,
                    "discounted_cash": cash,
                    "min_negotiated": min_neg,
                    "max_negotiated": max_neg,
                    "setting": setting,
                }
            )

    return records


def detect_and_parse_mrf(data: bytes, mrf_url: str) -> list[dict]:
    stripped = data.lstrip()
    if not stripped:
        return []
    if stripped.startswith(b"{") or stripped.startswith(b"["):
        return parse_mrf_json(data)
    return parse_mrf_csv_tall(data)


def write_sqlite(records: list[dict], db_path: Path, hospital_name: str, mrf_url: str) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(
            """
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE charges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL,
                code_type TEXT NOT NULL,
                description TEXT,
                gross_charge REAL,
                discounted_cash REAL,
                min_negotiated REAL,
                max_negotiated REAL,
                setting TEXT
            );

            CREATE INDEX idx_code ON charges(code);
            """
        )

        conn.executemany(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            [
                ("hospital_name", hospital_name),
                ("mrf_url", mrf_url),
                ("fetched_at", dt.datetime.utcnow().isoformat()),
            ],
        )

        conn.executemany(
            """
            INSERT INTO charges (
                code, code_type, description,
                gross_charge, discounted_cash,
                min_negotiated, max_negotiated,
                setting
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    record["code"],
                    record["code_type"],
                    record["description"],
                    record["gross_charge"],
                    record["discounted_cash"],
                    record["min_negotiated"],
                    record["max_negotiated"],
                    record["setting"],
                )
                for record in records
            ],
        )
        conn.commit()
    finally:
        conn.close()


def _slugify(name: str) -> str:
    slug = normalize_name(name)
    slug = re.sub(r"[^a-z0-9]", "_", slug)
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug[:60]


def lookup_index_entry(hospital_name: str, state: str = "") -> dict | None:
    index = load_hospital_index()
    normalized = normalize_name(hospital_name)
    state = state.strip().lower()

    if state:
        entry = index.get(f"{normalized}|{state}")
        if entry:
            return entry

    for key, entry in index.items():
        if key.startswith(f"{normalized}|"):
            return entry

    candidates = (
        [(key, entry) for key, entry in index.items() if key.endswith(f"|{state}")]
        if state
        else list(index.items())
    )
    if not candidates:
        return None

    key_names = [key.rsplit("|", 1)[0] for key, _ in candidates]
    result = fuzz_process.extractOne(
        normalized,
        key_names,
        scorer=fuzz.token_set_ratio,
        score_cutoff=85,
    )
    if result:
        _, _, idx = result
        return candidates[idx][1]

    if state:
        all_candidates = list(index.items())
        all_key_names = [key.rsplit("|", 1)[0] for key, _ in all_candidates]
        result = fuzz_process.extractOne(
            normalized,
            all_key_names,
            scorer=fuzz.token_set_ratio,
            score_cutoff=88,
        )
        if result:
            _, _, idx = result
            return all_candidates[idx][1]

    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch and cache a hospital MRF")
    parser.add_argument("hospital_name", nargs="?", help="Hospital name (e.g. 'Memorial Hospital')")
    parser.add_argument("--state", default="", help="Two-letter state code (e.g. TX)")
    parser.add_argument("--ccn", default="", help="CMS Certification Number if known")
    parser.add_argument("--mrf-url", default="", help="Direct MRF URL (skip discovery)")
    parser.add_argument("--dry-run", action="store_true", help="Print the matched hospital index entry and exit")
    args = parser.parse_args()

    if not args.hospital_name and not args.ccn:
        parser.print_help()
        sys.exit(1)

    hospital_name = args.hospital_name or args.ccn
    slug = _slugify(hospital_name)
    db_filename = f"{args.ccn or slug}.db"
    db_path = CACHE_DIR / db_filename

    if args.dry_run:
        entry = lookup_index_entry(hospital_name, args.state)
        print(json.dumps(entry, indent=2, sort_keys=True, ensure_ascii=False))
        sys.exit(0 if entry else 2)

    if db_path.exists():
        age_hours = (time.time() - db_path.stat().st_mtime) / 3600
        if age_hours < 24:
            print(f"Cache is fresh ({age_hours:.1f}h old): {db_path}")
            sys.exit(0)

    mrf_url = args.mrf_url
    if not mrf_url:
        entry = lookup_index_entry(hospital_name, args.state)
        if entry and entry.get("domain"):
            _, mrf_url = resolve_hospital_domain(hospital_name, args.state)
        else:
            _, mrf_url = resolve_hospital_domain(hospital_name, args.state)

    if not mrf_url:
        print(f"ERROR: Could not find MRF for '{hospital_name}' (state={args.state})")
        print("Try providing --mrf-url directly.")
        sys.exit(2)

    try:
        raw = download_mrf(mrf_url)
        records = detect_and_parse_mrf(raw, mrf_url)
        write_sqlite(records, db_path, hospital_name, mrf_url)
        print(f"Wrote {len(records):,} records to {db_path}")
    except Exception as exc:
        print(f"ERROR: {exc}")
        sys.exit(3)


if __name__ == "__main__":
    main()
