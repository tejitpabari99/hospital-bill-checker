from __future__ import annotations

import gzip
import io
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fetch_hospital_mrf as mrf


SAMPLE_JSON_MRF = json.dumps(
    {
        "hospital_name": "Test Hospital",
        "last_updated_on": "2024-11-01",
        "version": "3.0.0",
        "standard_charge_information": [
            {
                "description": "COMPREHENSIVE METABOLIC PANEL",
                "code_information": [{"code": "80053", "type": "CPT"}],
                "standard_charges": [
                    {
                        "gross_charge": 350.0,
                        "discounted_cash": 175.0,
                        "minimum_negotiated_rate": 45.0,
                        "maximum_negotiated_rate": 210.0,
                        "setting": "outpatient",
                    }
                ],
            }
        ],
    }
).encode()

SAMPLE_CSV_TALL = b"""description,setting,code|1|CPT,standard_charge|gross,standard_charge|discounted_cash,standard_charge|min,standard_charge|max
METABOLIC PANEL,outpatient,80053,350.00,175.00,45.00,210.00
EMERGENCY VISIT,outpatient,99285,1200.00,600.00,200.00,900.00
DRG SERVICE,inpatient,,200.00,,,
"""


def test_parse_json_mrf_basic() -> None:
    records = mrf.parse_mrf_json(SAMPLE_JSON_MRF)
    assert len(records) == 1
    assert records[0]["code"] == "80053"
    assert records[0]["code_type"] == "CPT"
    assert records[0]["gross_charge"] == 350.0
    assert records[0]["discounted_cash"] == 175.0
    assert records[0]["min_negotiated"] == 45.0
    assert records[0]["setting"] == "outpatient"


def test_parse_json_mrf_skips_drg() -> None:
    data = json.dumps(
        {
            "standard_charge_information": [
                {
                    "description": "DRG SERVICE",
                    "code_information": [{"code": "470", "type": "MS-DRG"}],
                    "standard_charges": [{"gross_charge": 20000.0, "setting": "inpatient"}],
                }
            ]
        }
    ).encode()
    assert mrf.parse_mrf_json(data) == []


def test_parse_json_mrf_skips_no_price() -> None:
    data = json.dumps(
        {
            "standard_charge_information": [
                {
                    "description": "SOMETHING",
                    "code_information": [{"code": "99213", "type": "CPT"}],
                    "standard_charges": [{"setting": "outpatient"}],
                }
            ]
        }
    ).encode()
    assert mrf.parse_mrf_json(data) == []


def test_parse_csv_tall_basic() -> None:
    records = mrf.parse_mrf_csv_tall(SAMPLE_CSV_TALL)
    assert len(records) == 2
    codes = {record["code"] for record in records}
    assert {"80053", "99285"} <= codes


def test_detect_and_parse_json() -> None:
    records = mrf.detect_and_parse_mrf(SAMPLE_JSON_MRF, "https://example.org/charges.json")
    assert len(records) == 1


def test_detect_and_parse_csv() -> None:
    records = mrf.detect_and_parse_mrf(SAMPLE_CSV_TALL, "https://example.org/charges.csv")
    assert len(records) == 2


def test_http_get_decompresses_gzip(monkeypatch) -> None:
    payload = gzip.compress(SAMPLE_JSON_MRF)

    class FakeHeaders:
        def get(self, key: str, default: str = "") -> str:
            return "gzip" if key.lower() == "content-encoding" else default

    class FakeResponse:
        headers = FakeHeaders()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self) -> bytes:
            return payload

    monkeypatch.setattr(mrf.urllib.request, "urlopen", lambda request, timeout=60: FakeResponse())

    result = mrf.http_get("https://example.org/charges.json.gz")
    assert result == SAMPLE_JSON_MRF


def test_lookup_index_entry_prefers_state_specific_match(monkeypatch) -> None:
    monkeypatch.setattr(
        mrf,
        "load_hospital_index",
        lambda: {
            "general hospital|tx": {"name": "General Hospital", "state": "TX", "domain": "https://example.org"},
            "general hospital|ca": {"name": "General Hospital", "state": "CA", "domain": "https://ca.example.org"},
        },
    )

    entry = mrf.lookup_index_entry("General Hospital", "TX")
    assert entry is not None
    assert entry["domain"] == "https://example.org"


def test_write_sqlite_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "hospital.db"
    records = [
        {
            "code": "80053",
            "code_type": "CPT",
            "description": "COMPREHENSIVE METABOLIC PANEL",
            "gross_charge": 350.0,
            "discounted_cash": 175.0,
            "min_negotiated": 45.0,
            "max_negotiated": 210.0,
            "setting": "outpatient",
        }
    ]

    mrf.write_sqlite(records, db_path, "Test Hospital", "https://example.org/charges.json")

    conn = sqlite3.connect(db_path)
    try:
        meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        row = conn.execute(
            "SELECT code, code_type, gross_charge, discounted_cash, setting FROM charges WHERE code = ?",
            ("80053",),
        ).fetchone()
    finally:
        conn.close()

    assert meta["hospital_name"] == "Test Hospital"
    assert meta["mrf_url"] == "https://example.org/charges.json"
    assert row == ("80053", "CPT", 350.0, 175.0, "outpatient")
