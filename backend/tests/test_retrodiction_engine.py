"""The engine seam: natal frame and month skies from the real engine (synthetic native)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

import pytest

from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName as P
from almamesh.retrodiction.engine import SubjectEngine
from almamesh.retrodiction.events import Birth

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
