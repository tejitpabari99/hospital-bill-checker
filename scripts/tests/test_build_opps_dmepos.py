from __future__ import annotations

import io
import sqlite3
import sys
import zipfile
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_dmepos_sqlite
from build_opps_sqlite import parse_addendum_a


def _xlsx_bytes(rows: list[list[object]]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)

    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


def test_parse_addendum_a_handles_extra_cms_column() -> None:
    raw = _xlsx_bytes([
        ["CMS OPPS Addendum A"],
        ["APC", "GROUP TITLE", "STATUS INDICATOR", "RELATIVE WEIGHT", "PAYMENT RATE", "CMS EXTRA"],
        ["5025", "Level 5 Type A ED Visits", "J1", 3.1, 608.43, "ignored"],
    ])

    rows = parse_addendum_a(raw, "addendum-a.xlsx")

    assert len(rows) == 1
    assert rows[0][2] == "5025"
    assert rows[0][3] == "Level 5 Type A ED Visits"
    assert rows[0][6] == 608.43


def test_build_dmepos_main_is_idempotent(tmp_path: Path, monkeypatch) -> None:
    xlsx = _xlsx_bytes([
        ["HCPCS", "MOD", "MOD2", "JURIS", "CATG", "CEILING", "FLOOR", "DESCRIPTION", "TX (NR)"],
        ["E0601", None, None, "J-A", "DME", 100.00, 10.00, "CPAP device", 50.91],
    ])
    zip_path = tmp_path / "dme.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("DMEPOS_APR.xlsx", xlsx)

    db_path = tmp_path / "dmepos.sqlite"
    monkeypatch.setattr(build_dmepos_sqlite, "DB_PATH", db_path)
    monkeypatch.setattr(sys, "argv", ["build_dmepos_sqlite.py", str(zip_path)])

    build_dmepos_sqlite.main()
    build_dmepos_sqlite.main()

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM dmepos_base").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM dmepos_state_rates").fetchone()[0] == 1
    finally:
        conn.close()
