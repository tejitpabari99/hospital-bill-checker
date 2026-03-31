from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_clfs import parse_clfs_delimited


def test_parse_clfs_delimited_reads_current_cms_layout() -> None:
    raw = (
        "2026 Clinical Diagnostic Laboratory Fee Schedule\n"
        "copyright\n"
        "\n"
        "YEAR,HCPCS,MOD,EFF_DATE,INDICATOR,RATE,SHORTDESC,LONGDESC,EXTENDEDLONGDESC\n"
        '2026,85025,,20260101,N,12.34,CBC short,CBC long,"Blood count; complete (CBC), automated"\n'
        "2026,0001U,,20260101,N,720.00,PLA short,PLA long,Red blood cell typing\n"
    ).encode()

    parsed = parse_clfs_delimited(raw, ",")

    assert parsed["85025"]["rate"] == 12.34
    assert parsed["85025"]["description"] == "Blood count; complete (CBC), automated"
    assert parsed["0001U"]["rate"] == 720.00
