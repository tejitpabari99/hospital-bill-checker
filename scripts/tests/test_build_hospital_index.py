from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from build_hospital_index import normalize_name


def test_normalize_name_basic() -> None:
    assert normalize_name("St. Mary's Hospital") == "st mary s hospital"


def test_normalize_name_apostrophe() -> None:
    assert normalize_name("Children's Medical Center") == "children s medical center"


def test_normalize_name_unicode() -> None:
    assert normalize_name("Hôpital Général") == "hopital general"


def test_normalize_name_extra_whitespace() -> None:
    assert normalize_name("  General   Hospital  ") == "general hospital"
