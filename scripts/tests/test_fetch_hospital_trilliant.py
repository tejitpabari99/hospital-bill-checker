from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fetch_hospital_trilliant as trilliant


def test_normalize_trilliant_duckdb_url_accepts_expected_url() -> None:
    url = (
        "https://oria-data.trillianthealth.com/data/2026-04-30/completed/"
        "example_hospital/example_hospital_parsed.duckdb"
    )

    assert trilliant.normalize_trilliant_duckdb_url(url) == url


def test_normalize_trilliant_duckdb_url_accepts_relative_path() -> None:
    path = "/data/2026-04-30/completed/example/example_parsed.duckdb"

    assert trilliant.normalize_trilliant_duckdb_url(path) == (
        "https://oria-data.trillianthealth.com"
        "/data/2026-04-30/completed/example/example_parsed.duckdb"
    )


def test_normalize_trilliant_duckdb_url_rejects_untrusted_urls() -> None:
    rejected = [
        "http://oria-data.trillianthealth.com/data/2026/completed/a/a_parsed.duckdb",
        "https://evil.example/data/2026/completed/a/a_parsed.duckdb",
        "https://oria-data.trillianthealth.com/data/2026/pending/a/a_parsed.duckdb",
        "https://oria-data.trillianthealth.com/data/2026/completed/a/a.duckdb",
        "https://oria-data.trillianthealth.com/data/2026/completed/a/a_parsed.duckdb?token=x",
    ]

    for url in rejected:
        assert trilliant.normalize_trilliant_duckdb_url(url) is None
