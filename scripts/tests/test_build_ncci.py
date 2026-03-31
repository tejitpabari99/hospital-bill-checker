from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_ncci import parse_ncci_txt


def test_parse_ncci_txt_supports_suffix_codes_and_modifier_flag() -> None:
    raw = (
        "copyright\n"
        "header\n"
        "Column 1\tColumn 2\t*=in existence\tEffective\tDeletion\tModifier\tRationale\n"
        "70460\t70450\t\t20220101\t99991231\t0\tExample\n"
        "93000\t93010\t\t20220101\t99991231\t1\tExample\n"
        "0001A\t0591T\t\t20220101\t99991231\t1\tExample\n"
    ).encode()

    parsed = parse_ncci_txt(raw)

    assert parsed["70450"]["bundledInto"] == ["70460"]
    assert parsed["70450"]["modifierCanOverride"] is False
    assert parsed["93010"]["bundledInto"] == ["93000"]
    assert parsed["0591T"]["bundledInto"] == ["0001A"]

