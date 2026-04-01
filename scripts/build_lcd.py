#!/usr/bin/env python3
"""
Build CMS LCD coverage lookup JSON.

This pulls the public final LCD report, resolves related billing articles for each
LCD, and combines each article's CPT/HCPCS code table with its ICD-10 covered /
noncovered tables.

Output: src/lib/data/lcd_coverage.json
"""

from __future__ import annotations

import argparse
import html
import json
import re
import urllib.request
from functools import lru_cache
from pathlib import Path

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "src" / "lib" / "data" / "lcd_coverage.json"
BASE_URL = "https://api.coverage.cms.gov/v1"
REPORT_URL = f"{BASE_URL}/reports/local-coverage-final-lcds/"
LICENSE_URL = f"{BASE_URL}/metadata/license-agreement/"


def fetch_json(url: str, token: str | None = None) -> dict:
    headers = {"User-Agent": "HospitalBillChecker/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def get_license_token() -> str:
    payload = fetch_json(LICENSE_URL)
    data = payload.get("data") or []
    if not data:
        raise RuntimeError("Coverage API license endpoint returned no token")
    token = data[0].get("Token")
    if not token:
        raise RuntimeError("Coverage API license endpoint did not include a token")
    return str(token)


def normalize_code(code: str) -> str:
    return str(code).strip().upper()


def is_valid_hcpc(code: str) -> bool:
    return bool(re.fullmatch(r"(?:[0-9]{5}|[A-Z][0-9]{4})", code))


def is_meaningful_icd(code: str) -> bool:
    code = normalize_code(code)
    if not code or code.startswith("XX"):
        return False
    return bool(re.fullmatch(r"[A-TV-Z][0-9][A-Z0-9](?:\.?[A-Z0-9]{0,4})?", code))


def extract_article_id(article_url: str) -> int | None:
    match = re.search(r"articleid=(\d+)", article_url)
    return int(match.group(1)) if match else None


def extract_article_ids(text: str) -> list[int]:
    text = html.unescape(text)
    ids = {int(match) for match in re.findall(r"A(\d{5})", text)}
    return sorted(ids)


@lru_cache(maxsize=None)
def fetch_lcd_detail(lcdid: int, ver: int, token: str) -> dict:
    url = f"{BASE_URL}/data/lcd?lcdid={lcdid}&ver={ver}"
    payload = fetch_json(url, token)
    data = payload.get("data") or []
    if not data:
        raise RuntimeError(f"LCD {lcdid} version {ver} returned no detail rows")
    return data[0]


@lru_cache(maxsize=None)
def fetch_lcd_related_articles(lcdid: int, ver: int, token: str) -> list[tuple[int, int]]:
    url = f"{BASE_URL}/data/lcd/related-documents?lcdid={lcdid}&ver={ver}"
    payload = fetch_json(url, token)
    related: list[tuple[int, int]] = []
    for row in payload.get("data") or []:
        article_id = row.get("r_article_id")
        article_version = row.get("r_article_version")
        if isinstance(article_id, int) and isinstance(article_version, int):
            related.append((article_id, article_version))
            continue
        url_field = str(row.get("url") or "")
        parsed_article_id = extract_article_id(url_field)
        if parsed_article_id and isinstance(article_version, int):
            related.append((parsed_article_id, article_version))
    return related


@lru_cache(maxsize=None)
def fetch_article_detail(article_id: int, token: str) -> dict:
    url = f"{BASE_URL}/data/article?articleid={article_id}"
    payload = fetch_json(url, token)
    data = payload.get("data") or []
    if not data:
        raise RuntimeError(f"Article {article_id} returned no detail rows")
    return data[0]


@lru_cache(maxsize=None)
def fetch_article_codes(article_id: int, ver: int, token: str) -> tuple[list[str], list[str], list[str]]:
    hcpc_url = f"{BASE_URL}/data/article/hcpc-code?articleid={article_id}&ver={ver}"
    covered_url = f"{BASE_URL}/data/article/icd10-covered?articleid={article_id}&ver={ver}"
    noncovered_url = f"{BASE_URL}/data/article/icd10-noncovered?articleid={article_id}&ver={ver}"

    hcpc_payload = fetch_json(hcpc_url, token)
    covered_payload = fetch_json(covered_url, token)
    noncovered_payload = fetch_json(noncovered_url, token)

    codes: list[str] = []
    for row in hcpc_payload.get("data") or []:
        code = normalize_code(row.get("hcpc_code_id") or row.get("code") or "")
        if is_valid_hcpc(code):
            codes.append(code)

    covered_codes: list[str] = []
    for row in covered_payload.get("data") or []:
        code = normalize_code(row.get("icd10_code_id") or row.get("code") or "")
        if is_meaningful_icd(code):
            covered_codes.append(code)

    noncovered_codes: list[str] = []
    for row in noncovered_payload.get("data") or []:
        code = normalize_code(row.get("icd10_code_id") or row.get("code") or "")
        if is_meaningful_icd(code):
            noncovered_codes.append(code)

    return codes, covered_codes, noncovered_codes


def finalize_coverage(coverage: dict[str, dict[str, set[str]]]) -> dict[str, dict[str, object]]:
    return {
        code: {
            "covered": sorted(values["covered"]),
            "notCovered": sorted(values["notCovered"]),
            "lcdIds": sorted(values["lcdIds"]),
        }
        for code, values in sorted(coverage.items())
    }


def build_lcd_coverage(token: str, target_entries: int = 500) -> dict[str, dict[str, object]]:
    report = fetch_json(REPORT_URL).get("data") or []
    coverage: dict[str, dict[str, set[str]]] = {}
    article_cache: set[tuple[int, int]] = set()
    processed_lcds = 0

    for row in report:
        lcdid = row.get("document_id")
        ver = row.get("document_version")
        if not isinstance(lcdid, int) or not isinstance(ver, int):
            continue

        lcd_detail = fetch_lcd_detail(lcdid, ver, token)
        related_articles: list[tuple[int, int]] = []

        # Prefer the billing/coding article referenced directly by the LCD.
        for field_name in ("associated_info", "source_info", "cms_cov_policy", "reference_article"):
            field_value = lcd_detail.get(field_name)
            if isinstance(field_value, str):
                for article_id in extract_article_ids(field_value):
                    try:
                        article_detail = fetch_article_detail(article_id, token)
                        article_ver = article_detail.get("article_version")
                        if isinstance(article_ver, int):
                            related_articles.append((article_id, article_ver))
                    except Exception:
                        continue

        # Some LCDs expose billing articles via associated docs rather than the LCD payload itself.
        if not related_articles:
            related_articles = fetch_lcd_related_articles(lcdid, ver, token)

        if not related_articles:
            continue

        for article_id, article_ver in related_articles:
            cache_key = (article_id, article_ver)
            if cache_key in article_cache:
                continue
            article_cache.add(cache_key)

            try:
                codes, covered_codes, noncovered_codes = fetch_article_codes(article_id, article_ver, token)
            except Exception:
                continue

            if not codes:
                continue

            for code in codes:
                entry = coverage.setdefault(code, {"covered": set(), "notCovered": set(), "lcdIds": set()})
                entry["covered"].update(covered_codes)
                entry["notCovered"].update(noncovered_codes)
                entry["lcdIds"].add(f"L{lcdid}")

                if len(coverage) >= target_entries:
                    print(f"Reached target of {target_entries:,} CPT/HCPCS entries")
                    return finalize_coverage(coverage)

        processed_lcds += 1
        if processed_lcds % 50 == 0:
            print(f"Processed {processed_lcds:,} LCDs; {len(coverage):,} CPT/HCPCS codes so far")

    return finalize_coverage(coverage)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build CMS LCD coverage JSON")
    parser.add_argument("--output", default=str(OUTPUT_PATH), help="Output JSON path")
    parser.add_argument(
        "--target-entries",
        type=int,
        default=500,
        help="Stop once this many CPT/HCPCS entries have been collected",
    )
    args = parser.parse_args()

    token = get_license_token()
    data = build_lcd_coverage(token, args.target_entries)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

    print(f"Wrote {len(data):,} CPT/HCPCS entries to {output_path}")


if __name__ == "__main__":
    main()
