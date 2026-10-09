"""Mars and the nodes: every sign change, in its real direction; Ketu mirrors Rahu."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName
from almamesh.schemas.transits import TimelineEvent
from almamesh.transits import timeline_ingress, timeline_sign_changes
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude
from almamesh.transits.timeline_sign_changes import node_sign_change_events, sign_change_events

_START = datetime(2026, 6, 9, 12, tzinfo=UTC)
_END = _START + timedelta(days=730.5)
_HALF_DAY = timedelta(hours=12)


@pytest.fixture(scope="module")
def astro() -> SkyfieldAstronomy:
    return SkyfieldAstronomy()


def _sign(astro: SkyfieldAstronomy, graha: PlanetName, when: datetime) -> str:
    return ZODIAC_SIGNS[sign_index(transit_longitude(astro, graha, when))]


def _assert_real_crossing(astro: SkyfieldAstronomy, event: TimelineEvent) -> None:
    assert event.graha is not None
    graha = PlanetName(event.graha)
    assert _sign(astro, graha, event.date - _HALF_DAY) == event.from_sign
    assert _sign(astro, graha, event.date + _HALF_DAY) == event.to_sign


def test_mars_retrograde_exit_and_re_entry_both_show(astro: SkyfieldAstronomy) -> None:
    # Given the first half of 2027, when Mars retrogrades from Leo back into Cancer
    events = sign_change_events(
        astro, PlanetName.MARS, datetime(2027, 1, 1, tzinfo=UTC), datetime(2027, 6, 30, tzinfo=UTC)
    )
    # Then the exit and the re-entry both appear, in order, in their real direction
    assert [(e.from_sign, e.to_sign) for e in events] == [("Leo", "Cancer"), ("Cancer", "Leo")]
    assert [e.descriptor for e in events] == ["mars.ingress.cancer", "mars.ingress.leo"]
    assert date(2027, 3, 6) <= events[0].date.date() <= date(2027, 3, 11)
    assert date(2027, 4, 25) <= events[1].date.date() <= date(2027, 4, 30)


def test_every_mars_change_is_real_and_chronological(astro: SkyfieldAstronomy) -> None:
    events = sign_change_events(astro, PlanetName.MARS, _START, _END)
    assert len(events) == 15
    assert [e.date for e in events] == sorted(e.date for e in events)
    for event in events:
        _assert_real_crossing(astro, event)


def test_rahu_and_ketu_change_sign_together_in_opposite_signs(astro: SkyfieldAstronomy) -> None:
    events = node_sign_change_events(astro, _START, _END)
    assert [(e.graha, e.from_sign, e.to_sign) for e in events] == [
        ("rahu", "Aquarius", "Capricorn"),
        ("ketu", "Leo", "Cancer"),
    ]
    assert events[0].date == events[1].date
    assert date(2026, 12, 1) <= events[0].date.date() <= date(2026, 12, 6)
    _assert_real_crossing(astro, events[1])
    assert [e.descriptor for e in events] == ["rahu.ingress.capricorn", "ketu.ingress.cancer"]


def test_a_jump_over_two_signs_is_not_invented_as_one_crossing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given a longitude that jumps from Aries to Gemini inside one coarse step
    start = datetime(2026, 1, 1, tzinfo=UTC)

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        return 5.0 if when == start else 65.0

    monkeypatch.setattr(timeline_ingress, "transit_longitude", longitude)
    # When scanned / Then nothing is reported (no single cusp explains it)
    events = sign_change_events(object(), PlanetName.MARS, start, start + timedelta(days=5))  # type: ignore[arg-type]
    assert events == []


# The fixture window, plus the 2022-24 window: Mars's retrograde loop there is
# short enough that a coarse step can step over both cusp crossings, which the
# fixture window never exercises (a 40-day step still matches daily there).
_WINDOWS = [_START, datetime(2022, 6, 9, 12, tzinfo=UTC)]
_INGRESSING = [PlanetName.JUPITER, PlanetName.SATURN, PlanetName.MARS, PlanetName.RAHU]


def _fine_scan(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """The same producer, scanned with a 1-day step: the reference answer."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(timeline_sign_changes, "_STEP_DAYS", 1.0)
        return sign_change_events(astro, graha, start, end)


@pytest.mark.parametrize("start", _WINDOWS, ids=lambda when: when.date().isoformat())
@pytest.mark.parametrize("graha", _INGRESSING, ids=lambda graha: graha.value)
def test_the_coarse_step_finds_every_sign_change_a_daily_scan_finds(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime
) -> None:
    # Given two years scanned with the production step and with a 1-day step
    end = start + timedelta(days=730.5)
    coarse = sign_change_events(astro, graha, start, end)
    fine = _fine_scan(astro, graha, start, end)
    # Then both find the same sign changes, each to within a minute
    assert [(e.from_sign, e.to_sign) for e in coarse] == [(e.from_sign, e.to_sign) for e in fine]
    for got, want in zip(coarse, fine, strict=True):
        assert abs(got.date - want.date) <= timedelta(minutes=1)
