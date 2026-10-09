"""12-month forward timeline: dated, sorted, prose-free structured events."""

from __future__ import annotations

import inspect
import re
from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.transits import TransitEventKind
from almamesh.transits import timeline_ingress
from almamesh.transits.timeline import build_timeline
from almamesh.transits.timeline_sign_changes import sign_change_events

_BIRTH = datetime(1990, 1, 15, 12, 0, 0, tzinfo=UTC)
_DELHI = (28.6139, 77.2090)
# Saturn enters Aries ~2027-06; a window covering it must surface that ingress.
_START = datetime(2027, 1, 1, 0, 0, 0, tzinfo=UTC)
_DESCRIPTOR = re.compile(r"^[a-z0-9]+(\.[a-z0-9_]+)+$")


def _natal() -> SiderealContext:
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


def test_should_sample_each_instant_once_when_sign_change_scan_finds_no_crossing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given a ten-day window where the same three instants are checked against all 12 cusps
    start = datetime(2026, 1, 1, tzinfo=UTC)
    sampled: list[datetime] = []

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        sampled.append(when)
        return 15.0

    monkeypatch.setattr(timeline_ingress, "transit_longitude", longitude)

    # When sign-change discovery scans a slow graha with no crossing
    events = sign_change_events(
        object(),
        PlanetName.JUPITER,
        start,
        start + timedelta(days=10),
    )

    # Then each astronomical instant is evaluated once
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


# Jupiter goes back from Virgo into Leo (~2028-02) and Saturn from Aries into
# Pisces (~2027-10) inside this window: both cross a cusp retrograde.
_RETROGRADE_START = datetime(2027, 1, 1, 0, 0, 0, tzinfo=UTC)
_INGRESS_GRAHAS = ("jupiter", "saturn", "mars", "rahu", "ketu")


def _sign_ingresses(start: datetime, graha: str) -> list[tuple[str | None, str | None]]:
    natal = calculate_sidereal_context(_BIRTH, *_DELHI, reference_date=start)
    timeline = build_timeline(SkyfieldAstronomy(), natal, _BIRTH, start, window_months=24)
    return [
        (e.from_sign, e.to_sign)
        for e in timeline.events
        if e.kind == TransitEventKind.SIGN_INGRESS.value and e.graha == graha
    ]


@pytest.mark.parametrize("start", [_TWO_YEAR_START, _RETROGRADE_START])
@pytest.mark.parametrize("graha", _INGRESS_GRAHAS)
def test_should_alternate_sign_ingresses_when_any_ingressing_graha_crosses_cusps(
    start: datetime, graha: str
) -> None:
    # Given a two-year window
    # When one graha's sign ingresses are listed
    changes = _sign_ingresses(start, graha)
    assert changes, graha
    # Then each starts where the previous one ended and never re-enters the same sign
    for (_, prev_to), (next_from, next_to) in zip(changes, changes[1:], strict=False):
        assert next_from == prev_to, changes
        assert next_to != prev_to, changes


@pytest.mark.parametrize(
    ("graha", "backward"),
    [("jupiter", ("Virgo", "Leo")), ("saturn", ("Aries", "Pisces"))],
)
def test_should_report_backward_ingress_when_graha_retrogrades_across_a_cusp(
    graha: str, backward: tuple[str, str]
) -> None:
    # Given a window where the graha retrogrades back across a cusp
    # When its sign ingresses are listed
    changes = _sign_ingresses(_RETROGRADE_START, graha)
    # Then the backward change is an event of its own, in its real direction
    assert backward in changes, changes


def test_should_build_timeline_that_takes_no_ayanamsa_or_node_arguments() -> None:
    # Given the timeline is Lahiri + mean node by construction
    # When its signature is read
    parameters = inspect.signature(build_timeline).parameters
    # Then it accepts no knobs it would ignore
    assert "ayanamsa_type" not in parameters
    assert "node_type" not in parameters
