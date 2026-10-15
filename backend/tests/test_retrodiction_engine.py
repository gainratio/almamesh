"""The engine seam: natal frame and month skies from the real engine (synthetic native)."""

from __future__ import annotations

import pickle
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from skyfield.errors import EphemerisRangeError

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName as P
from almamesh.domains.ashtakavarga_signals import BinduTable
from almamesh.domains.exact_signals import SLOW_MOVERS
from almamesh.domains.varga_signals import varga_key
from almamesh.retrodiction import engine as engine_module
from almamesh.retrodiction.engine import (
    EngineReadingRangeError,
    SubjectEngine,
    obstacles_activation,
)
from almamesh.retrodiction.events import Birth, LifeEvent
from almamesh.retrodiction.harness import movers_for
from almamesh.retrodiction.mapping import MAPPING
from almamesh.schemas.vargas import DivisionalChart
from almamesh.strength.ashtakavarga import compute_ashtakavarga
from almamesh.transits.exact import astro_movers, exact_hits
from almamesh.vargas import compute_varga_context

SYNTHETIC = Birth(
    datetime=datetime.fromisoformat("1980-03-04T05:06:00+05:30"), latitude=13.08, longitude=80.27
)


@pytest.fixture(scope="module")
def engine() -> Iterator[SubjectEngine]:
    with SkyfieldAstronomy() as astronomy:
        yield SubjectEngine(SYNTHETIC, astronomy)


def test_the_natal_frame_has_every_graha(engine: SubjectEngine) -> None:
    frame = engine.frame
    assert set(frame.rulers) == set(P)
    assert set(frame.occupied) == set(P)
    assert 0 <= frame.lagna_idx < 12
    assert 0 <= frame.moon_idx < 12
    ruled = sorted(h for houses in frame.rulers.values() for h in houses)
    assert ruled == list(range(1, 13))


def test_a_month_sky_reads_the_real_sky(engine: SubjectEngine) -> None:
    sky = engine.month((2019, 5))
    # May 2019, sidereal (Lahiri): Saturn in Sagittarius, Jupiter (retrograde) in Scorpio.
    assert sky.signs[P.SATURN] == 8
    assert sky.signs[P.JUPITER] == 7
    assert sky.signs[P.KETU] == (sky.signs[P.RAHU] + 6) % 12
    assert len(sky.running) == 3
    assert all(level for level in sky.running)
    assert sky.yogini_lord is not None


def test_month_skies_are_cached(engine: SubjectEngine) -> None:
    assert engine.month((2019, 6)) is engine.month((2019, 6))


def test_coverage_is_bounded_by_birth_and_the_ephemeris(engine: SubjectEngine) -> None:
    assert engine.covers((1980, 4))
    assert not engine.covers((1980, 3))  # birth month is partial
    assert not engine.covers((1979, 12))
    assert not engine.covers((2053, 1))


def test_a_month_sky_lists_the_exact_contacts_of_its_month(engine: SubjectEngine) -> None:
    # Given the month in which transit Saturn is exactly on this native's natal Sun
    sun = engine.points["sun"]
    saturn = astro_movers(engine.astronomy)[P.SATURN]
    start, end = datetime(2000, 1, 1, tzinfo=UTC), datetime(2030, 1, 1, tzinfo=UTC)
    hit = exact_hits(saturn, sun, start, end, 5.0)[0]
    # When / Then
    assert (P.SATURN, "sun") in engine.month((hit.year, hit.month)).contacts
    assert (P.SATURN, "sun") not in engine.month((hit.year - 6, hit.month)).contacts


def test_should_scan_only_the_movers_a_native_needs() -> None:
    with SkyfieldAstronomy() as astronomy:
        slow = SubjectEngine(SYNTHETIC, astronomy, movers=SLOW_MOVERS)
        contacts = {
            g for ym in [(2019, m) for m in range(1, 13)] for g, _ in slow.month(ym).contacts
        }
    assert P.MARS not in contacts


def test_should_add_mars_only_for_natives_with_a_disputes_event() -> None:
    career = [LifeEvent(category="job_start", date="2019-05", precision="month")]
    legal = [*career, LifeEvent(category="legal", date="2012-11", precision="month")]
    assert movers_for(career) == SLOW_MOVERS
    assert movers_for(legal) == SLOW_MOVERS | {P.MARS}


def test_a_month_carries_the_engine_obstacles_activation(engine: SubjectEngine) -> None:
    # The app's own month reading for this native: obstacles 75% in Jan 2019, 100% in Mar 2019.
    assert engine.month((2019, 1)).obstacles() == 0.75
    assert engine.month((2019, 3)).obstacles() == 1.0


def test_should_raise_a_picklable_range_error_when_the_reading_leaves_the_ayanamsa_table() -> None:
    # Given a 1901 birth, whose month reading searches back before 1900-01-01
    early = Birth(datetime="1901-08-01T06:00:00+00:00", latitude=28.6, longitude=77.2)
    # When / Then
    with pytest.raises(EngineReadingRangeError) as caught:
        obstacles_activation(early, (1904, 6))
    assert pickle.loads(pickle.dumps(caught.value)).args == caught.value.args


def test_should_raise_a_range_error_when_the_reading_leaves_de421(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def outside(*_: object) -> None:
        raise EphemerisRangeError("segment covers 1899-07-29 through 2053-10-09", 0, 0, None, None)

    monkeypatch.setattr(engine_module, "_month_reading", outside)
    with pytest.raises(EngineReadingRangeError, match="1990-01"):
        obstacles_activation(SYNTHETIC, (1990, 1))


def test_should_let_any_other_reading_error_through(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(*_: object) -> None:
        raise ValueError("invalid reading_end: past the window end")

    monkeypatch.setattr(engine_module, "_month_reading", broken)
    with pytest.raises(ValueError, match="invalid reading_end") as caught:
        obstacles_activation(SYNTHETIC, (1990, 1))
    assert not isinstance(caught.value, EngineReadingRangeError)


def test_should_refuse_a_birth_without_a_utc_offset() -> None:
    naive = Birth.model_construct(datetime=datetime(1980, 1, 1), latitude=0.0, longitude=0.0)
    with pytest.raises(ValueError, match="UTC offset"):
        obstacles_activation(naive, (2000, 1))


def _synthetic_natal():  # noqa: ANN202 - the engine's SiderealContext
    born = SYNTHETIC.datetime.astimezone(UTC)
    with SkyfieldAstronomy() as astronomy:
        return calculate_sidereal_context(
            born, SYNTHETIC.latitude, SYNTHETIC.longitude, reference_date=born, astronomy=astronomy
        )


def test_should_carry_the_natives_ashtakavarga_in_the_natal_frame(engine: SubjectEngine) -> None:
    # Given the same native charted independently
    natal = _synthetic_natal()
    # Then the frame's bindus are the engine's Ashtakavarga for that chart
    assert engine.frame.bindus == BinduTable.from_context(compute_ashtakavarga(natal))
    assert engine.frame.bindus is not None
    assert sum(engine.frame.bindus.sav) == 337


def test_should_read_the_sun_and_venus_in_the_month_sky(engine: SubjectEngine) -> None:
    # 15 Jan 2019, sidereal (Lahiri): Sun just into Capricorn, Venus in Scorpio
    sky = engine.month((2019, 1))
    assert (sky.signs[P.SUN], sky.signs[P.VENUS]) == (9, 7)
    assert 0 <= sky.signs[P.MERCURY] < 12


_VARGA_OF_AREA = {
    "career": (DivisionalChart.D10, frozenset({10})),
    "relationships": (DivisionalChart.D9, frozenset({7})),
    "disputes (pending)": (DivisionalChart.D30, frozenset({6, 8, 12})),
}


def test_should_key_every_career_relationship_and_disputes_target_to_its_varga(
    engine: SubjectEngine,
) -> None:
    # Given the same native's vargas computed independently
    charts = compute_varga_context(_synthetic_natal()).charts
    expected = {
        m.target: varga_key(charts[_VARGA_OF_AREA[m.area][0]], _VARGA_OF_AREA[m.area][1])
        for m in MAPPING.values()
        if m.area in _VARGA_OF_AREA
    }
    # Then the frame holds exactly those seven targets' keys (3 career, 3 relationships, disputes)
    assert len(expected) == 7
    assert dict(engine.frame.varga_keys) == expected
