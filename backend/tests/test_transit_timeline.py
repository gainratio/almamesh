"""12-month forward timeline: dated, sorted, prose-free structured events."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import TransitEventKind
from almamesh.transits import timeline_ingress
from almamesh.transits.timeline import build_timeline

_BIRTH = datetime(1990, 1, 15, 12, 0, 0, tzinfo=UTC)
_DELHI = (28.6139, 77.2090)
# Saturn enters Aries ~2027-06; a window covering it must surface that ingress.
_START = datetime(2027, 1, 1, 0, 0, 0, tzinfo=UTC)
_DESCRIPTOR = re.compile(r"^[a-z0-9]+(\.[a-z0-9_]+)+$")


def _natal():
    return calculate_sidereal_context(_BIRTH, *_DELHI, reference_date=_START)


def test_should_contain_saturn_aries_ingress_with_descriptor() -> None:
    # Given a 12-month window spanning Saturn's 2027 ingress into Aries
    natal = _natal()
    astro = SkyfieldAstronomy()
    # When the timeline is built
    timeline = build_timeline(astro, natal, _BIRTH, _START, window_months=12)
    # Then a Saturn sign-ingress into Aries appears with a stable descriptor
    ingresses = [e for e in timeline.events if e.kind == TransitEventKind.SIGN_INGRESS.value]
    aries = [e for e in ingresses if e.descriptor == "saturn.ingress.aries"]
    assert aries, [e.descriptor for e in ingresses]
    assert datetime(2027, 5, 1, tzinfo=UTC) <= aries[0].date <= datetime(2027, 7, 15, tzinfo=UTC)


def test_should_sort_events_and_keep_them_in_window() -> None:
    # Given the built 12-month timeline
    natal = _natal()
    astro = SkyfieldAstronomy()
    timeline = build_timeline(astro, natal, _BIRTH, _START, window_months=12)
    # Then events are chronologically sorted and all inside [start, end]
    dates = [e.date for e in timeline.events]
    assert dates == sorted(dates)
    for e in timeline.events:
        assert timeline.window_start <= e.date <= timeline.window_end
    # And no fast-graha noise: only slow grahas ingress (Inc B adds Mars and the nodes)
    for e in timeline.events:
        if e.kind == TransitEventKind.SIGN_INGRESS.value and e.graha is not None:
            assert e.graha in {"jupiter", "saturn", "mars", "rahu", "ketu"}


def test_should_emit_descriptor_keys_not_prose() -> None:
    # Given the built timeline
    natal = _natal()
    astro = SkyfieldAstronomy()
    timeline = build_timeline(astro, natal, _BIRTH, _START, window_months=12)
    # Then every descriptor is a dotted machine key, never a sentence
    assert timeline.events  # non-empty so the assertion is meaningful
    for e in timeline.events:
        assert _DESCRIPTOR.match(e.descriptor), e.descriptor
        assert " " not in e.descriptor


def test_should_reuse_ephemeris_samples_across_ingress_cusps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given a ten-day window where the same three instants are checked against all 12 cusps
    start = datetime(2026, 1, 1, tzinfo=UTC)
    sampled: list[datetime] = []

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        sampled.append(when)
        return 15.0

    monkeypatch.setattr(timeline_ingress, "transit_longitude", longitude)

    # When ingress discovery scans a slow graha with no crossing
    events = timeline_ingress.slow_graha_ingress_events(
        object(),
        PlanetName.JUPITER,
        start,
        start + timedelta(days=10),  # type: ignore[arg-type]
    )

    # Then each astronomical instant is evaluated once, not once per zodiac cusp
    assert events == []
    assert sampled == [start, start + timedelta(days=5), start + timedelta(days=10)]


_TWO_YEAR_START = datetime(2026, 6, 9, 12, 0, 0, tzinfo=UTC)


def test_two_year_timeline_covers_mars_nodes_and_stations() -> None:
    # Given a 24-month window from the golden's reference instant
    natal = calculate_sidereal_context(_BIRTH, *_DELHI, reference_date=_TWO_YEAR_START)
    timeline = build_timeline(SkyfieldAstronomy(), natal, _BIRTH, _TWO_YEAR_START, window_months=24)
    # Then every Inc B producer is present, and no fast graha appears
    kinds = {(e.graha, e.kind) for e in timeline.events if e.graha is not None}
    assert {
        ("mars", "sign_ingress"),
        ("rahu", "sign_ingress"),
        ("ketu", "sign_ingress"),
        ("jupiter", "station"),
        ("saturn", "station"),
        ("mars", "station"),
    } <= kinds
    assert not {graha for graha, _ in kinds} & {"sun", "moon", "mercury", "venus"}
    dates = [e.date for e in timeline.events]
    assert dates == sorted(dates)
