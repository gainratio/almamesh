"""Unit tests for multi-day Moon window Panchang, Tarabala, and Chandrabala."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.constants.astrology import NAKSHATRA_NAMES, ZodiacSign
from almamesh.edge.chart_runtime import compute_moon_window_payload
from almamesh.transits.daily_panchang import (
    DayInstantInput,
    NatalMoonRef,
    _day_quality,
    _natal_overlay,
)
from almamesh.transits.moon_window import compute_moon_window, moon_window_from_wire

WEEK_START = datetime(2026, 6, 15, 0, tzinfo=UTC)
WEEK_END = WEEK_START + timedelta(days=7)
WEEK_DAYS = [
    DayInstantInput(
        date=(WEEK_START + timedelta(days=i)).strftime("%Y-%m-%d"),
        when=WEEK_START + timedelta(days=i, hours=12),
    )
    for i in range(7)
]


def test_omitting_days_keeps_serialized_moon_window_byte_identical() -> None:
    window = compute_moon_window(WEEK_START, WEEK_START + timedelta(days=1))
    assert window.days is None
    dumped = window.model_dump(mode="json")
    assert set(dumped) == {"at_place", "event"}
    assert "days" not in window.model_dump_json()


def test_seven_day_window_computes_daily_panchang_and_natal_overlay() -> None:
    natal = NatalMoonRef(sign=ZodiacSign.TAURUS, nakshatra="Rohini")
    window = compute_moon_window(WEEK_START, WEEK_END, days=WEEK_DAYS, natal_moon=natal)
    assert window.days is not None and len(window.days) == 7
    dumped = window.model_dump(mode="json")
    assert len(dumped["days"]) == 7
    for entry in window.days:
        assert 1 <= entry.pada <= 4
        assert 1 <= entry.tithi <= 30
        assert entry.paksha in ("shukla", "krishna")
        assert entry.house_from_moon is not None and 1 <= entry.house_from_moon <= 12
        assert entry.tara_number is not None and 1 <= entry.tara_number <= 9
        assert entry.tara_name is not None
        assert entry.day_quality in ("supportive", "mixed", "caution")


@pytest.mark.parametrize(
    ("offset", "expected_num", "expected_name"),
    [
        (0, 1, "Janma"),
        (1, 2, "Sampat"),
        (2, 3, "Vipat"),
        (3, 4, "Kshema"),
        (4, 5, "Pratyak"),
        (5, 6, "Sadhana"),
        (6, 7, "Naidhana"),
        (7, 8, "Mitra"),
        (8, 9, "Parama Mitra"),
        (9, 1, "Janma"),
        (26, 9, "Parama Mitra"),
    ],
)
def test_tarabala_cycles_all_nine_taras_from_natal_nakshatra(
    offset: int, expected_num: int, expected_name: str
) -> None:
    natal = NatalMoonRef(sign=ZodiacSign.ARIES, nakshatra=NAKSHATRA_NAMES[3])
    transit_nak = NAKSHATRA_NAMES[(3 + offset) % 27]
    house, tara_num, tara_name, quality = _natal_overlay(ZodiacSign.ARIES, transit_nak, natal)
    assert house == 1
    assert (tara_num, tara_name) == (expected_num, expected_name)
    assert quality is not None


def test_chandrabala_houses_one_to_twelve_and_chandrashtama_caution() -> None:
    signs = list(ZodiacSign)
    natal = NatalMoonRef(sign=ZodiacSign.CANCER, nakshatra="Pushya")
    for step in range(12):
        transit_sign = signs[(signs.index(ZodiacSign.CANCER) + step) % 12]
        house, _tara, _name, quality = _natal_overlay(transit_sign, "Rohini", natal)
        assert house == step + 1
        if house == 8:
            assert quality == "caution"
    assert _day_quality(8, 2) == "caution"
    assert _day_quality(1, 2) == "supportive"
    assert _day_quality(4, 3) == "caution"
    assert _day_quality(4, 2) == "mixed"


def test_wire_roundtrip_with_days_vara_override_and_lowercase_natal_sign() -> None:
    payload = {
        "place_start_utc": "2026-06-15T00:00:00+00:00",
        "place_end_utc": "2026-06-29T00:00:00+00:00",
        "days": [
            {"date": "2026-06-15", "datetime_utc": "2026-06-15T12:00:00+00:00", "vara": "Monday"},
            {"date": "2026-06-16", "datetime_utc": "2026-06-16T12:00:00+00:00"},
        ],
        "natal_moon": {"sign": "taurus", "nakshatra": "Rohini"},
    }
    parsed = moon_window_from_wire(payload)
    assert parsed.days is not None and len(parsed.days) == 2
    assert parsed.days[0].vara == "Monday"
    dumped = compute_moon_window_payload(payload)
    assert len(dumped["days"]) == 2  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("patch", "match"),
    [
        ({"days": "not-a-list"}, "invalid days"),
        ({"days": []}, "invalid days"),
        ({"days": ["bad"]}, r"invalid days\[0\]"),
        ({"days": [{"date": "2026-99-99", "datetime_utc": "2026-06-15T12:00:00+00:00"}]}, "date"),
        (
            {
                "days": [
                    {
                        "date": "2026-06-15",
                        "datetime_utc": "2026-06-15T12:00:00+00:00",
                        "vara": "Funday",
                    }
                ]
            },
            "vara",
        ),
        (
            {"days": [{"date": "2026-06-20", "datetime_utc": "2026-06-20T12:00:00+00:00"}]},
            "outside the place bounds",
        ),
        ({"natal_moon": "taurus"}, "invalid natal_moon"),
        ({"natal_moon": {"sign": 123, "nakshatra": "Rohini"}}, "sign must be a string"),
        ({"natal_moon": {"sign": "Pluto", "nakshatra": "Rohini"}}, "invalid natal_moon sign"),
        (
            {"natal_moon": {"sign": "Taurus", "nakshatra": "Unknown"}},
            "invalid natal_moon nakshatra",
        ),
    ],
)
def test_wire_rejects_malformed_days_and_natal_moon(patch: dict[str, object], match: str) -> None:
    base: dict[str, object] = {
        "place_start_utc": "2026-06-15T00:00:00+00:00",
        "place_end_utc": "2026-06-17T00:00:00+00:00",
    }
    with pytest.raises(ValueError, match=match):
        moon_window_from_wire({**base, **patch})


def test_direct_call_rejects_empty_days_list() -> None:
    with pytest.raises(ValueError, match="invalid days"):
        compute_moon_window(WEEK_START, WEEK_END, days=[])
