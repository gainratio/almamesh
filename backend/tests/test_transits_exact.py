"""Degree-level transit contacts: exact hits, in-orb spells and month contacts."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName as P
from almamesh.transits.exact import (
    EXACT_ORB_DEG,
    ContactBook,
    Spell,
    astro_movers,
    exact_hits,
    natal_points,
    orb_spells,
)

T0 = datetime(2001, 1, 1, tzinfo=UTC)
DAY = timedelta(days=1)
ONE_MINUTE = timedelta(minutes=1)


@pytest.fixture(scope="module")
def astro() -> Iterator[SkyfieldAstronomy]:
    with SkyfieldAstronomy() as handle:
        yield handle


def _days(when: datetime) -> float:
    return (when - T0) / DAY


def _linear(when: datetime) -> float:
    """10 degrees at T0, moving 0.1 degree a day."""
    return 10.0 + 0.1 * _days(when)


def _retrograde(when: datetime) -> float:
    """0 -> 20 over 100 days, back to 10 by day 150, then forward again."""
    d = _days(when)
    if d <= 100:
        return 0.2 * d
    if d <= 150:
        return 20.0 - 0.2 * (d - 100)
    return 10.0 + 0.2 * (d - 150)


def _near(actual: datetime, day: float, tolerance: timedelta = ONE_MINUTE) -> bool:
    return abs(actual - (T0 + day * DAY)) <= tolerance


def _on_day(actual: datetime, published: str) -> bool:
    """Within one day of a published calendar date (published dates are local, IST)."""
    expected = datetime.fromisoformat(published).replace(tzinfo=UTC) + DAY / 2
    return abs(actual - expected) <= DAY + DAY / 2


# --- hand-checked public dates (Lahiri, sidereal; published Vedic ingress dates) ---------


def test_should_find_saturns_three_aquarius_ingresses_when_it_retrogrades(
    astro: SkyfieldAstronomy,
) -> None:
    # Given Saturn crossing 300 degrees (0 Aquarius) in 2022-23: in on 2022-04-29, back
    # into Capricorn on 2022-07-12 (retrograde), in again on 2023-01-17
    saturn = astro_movers(astro)[P.SATURN]
    # When
    hits = exact_hits(
        saturn, 300.0, datetime(2022, 1, 1, tzinfo=UTC), datetime(2023, 6, 30, tzinfo=UTC), 5.0
    )
    # Then
    assert len(hits) == 3
    assert _on_day(hits[0], "2022-04-29")
    assert _on_day(hits[1], "2022-07-12")
    assert _on_day(hits[2], "2023-01-17")


def test_should_find_jupiters_taurus_ingress_on_its_published_date(
    astro: SkyfieldAstronomy,
) -> None:
    jupiter = astro_movers(astro)[P.JUPITER]
    hits = exact_hits(
        jupiter, 30.0, datetime(2024, 1, 1, tzinfo=UTC), datetime(2024, 12, 31, tzinfo=UTC), 5.0
    )
    assert len(hits) == 1
    assert _on_day(hits[0], "2024-05-01")


def test_should_find_saturns_pisces_ingress_on_its_published_date(
    astro: SkyfieldAstronomy,
) -> None:
    saturn = astro_movers(astro)[P.SATURN]
    hits = exact_hits(
        saturn, 330.0, datetime(2025, 1, 1, tzinfo=UTC), datetime(2025, 12, 31, tzinfo=UTC), 5.0
    )
    assert len(hits) == 1
    assert _on_day(hits[0], "2025-03-29")


# --- the root-finding contract on synthetic motion --------------------------------------


def test_should_return_the_orb_spell_when_a_point_is_passed_directly() -> None:
    # Given 0.1 degree a day toward 15 degrees with a 1 degree orb
    # When
    spells = orb_spells(_linear, 15.0, T0, T0 + 100 * DAY, 1.0, 5.0)
    # Then the spell runs from 14 degrees (day 40) to 16 degrees (day 60)
    assert len(spells) == 1
    assert _near(spells[0].start, 40)
    assert _near(spells[0].end, 60)


def test_should_find_every_retrograde_re_hit_when_the_mover_turns_back() -> None:
    hits = exact_hits(_retrograde, 15.0, T0, T0 + 250 * DAY, 5.0)
    assert [round(_days(h), 3) for h in hits] == [75.0, 125.0, 175.0]


def test_should_return_one_spell_per_pass_when_the_mover_turns_back() -> None:
    spells = orb_spells(_retrograde, 15.0, T0, T0 + 250 * DAY, 1.0, 5.0)
    assert [(round(_days(s.start), 3), round(_days(s.end), 3)) for s in spells] == [
        (70.0, 80.0),
        (120.0, 130.0),
        (170.0, 180.0),
    ]


def test_should_clip_spells_to_the_scan_when_it_starts_and_ends_in_orb() -> None:
    spells = orb_spells(_linear, 15.0, T0 + 45 * DAY, T0 + 55 * DAY, 1.0, 5.0)
    assert spells == [Spell(T0 + 45 * DAY, T0 + 55 * DAY)]


def test_should_ignore_the_opposite_point_when_the_gap_wraps() -> None:
    # Given a mover crossing 195 degrees, the point opposite 15
    def opposite(when: datetime) -> float:
        return 190.0 + 0.1 * _days(when)

    # When / Then the wrap of the circular gap is not a contact
    assert exact_hits(opposite, 15.0, T0, T0 + 100 * DAY, 5.0) == []
    assert orb_spells(opposite, 15.0, T0, T0 + 100 * DAY, 1.0, 5.0) == []


def test_should_find_nothing_when_the_point_stays_out_of_orb() -> None:
    assert orb_spells(_linear, 30.0, T0, T0 + 100 * DAY, 1.0, 5.0) == []


# --- month contacts ---------------------------------------------------------------------


def test_should_count_a_contact_in_every_month_its_spell_touches() -> None:
    # Given Saturn moving linearly over a natal Sun at 15 degrees (in orb days 40-60)
    book = ContactBook({P.SATURN: _linear}, {"sun": 15.0, "lagna": 100.0}, orb=1.0)
    # When / Then: 2001-02-10 .. 2001-03-02 touches February and March, not January or April
    assert (
        book.month(datetime(2001, 1, 1, tzinfo=UTC), datetime(2001, 2, 1, tzinfo=UTC))
        == frozenset()
    )
    feb = book.month(datetime(2001, 2, 1, tzinfo=UTC), datetime(2001, 3, 1, tzinfo=UTC))
    mar = book.month(datetime(2001, 3, 1, tzinfo=UTC), datetime(2001, 4, 1, tzinfo=UTC))
    apr = book.month(datetime(2001, 4, 1, tzinfo=UTC), datetime(2001, 5, 1, tzinfo=UTC))
    assert feb == mar == frozenset({(P.SATURN, "sun")})
    assert apr == frozenset()


def test_should_refuse_a_month_that_crosses_a_year_boundary() -> None:
    book = ContactBook({P.SATURN: _linear}, {"sun": 15.0})
    with pytest.raises(ValueError, match="one calendar year"):
        book.month(datetime(2001, 12, 15, tzinfo=UTC), datetime(2002, 1, 15, tzinfo=UTC))


def test_should_use_a_one_degree_orb_by_default() -> None:
    assert EXACT_ORB_DEG == 1.0
    book = ContactBook({P.SATURN: _linear}, {"sun": 15.0})
    # Day 38-39 is 13.8-13.9 degrees: inside a 2 degree orb, outside 1 degree
    start = T0 + 38 * DAY
    assert book.month(start, start + DAY) == frozenset()


def test_should_read_the_nine_grahas_and_the_lagna_as_natal_points(
    astro: SkyfieldAstronomy,
) -> None:
    born = datetime(1980, 3, 4, 0, 36, tzinfo=UTC)
    natal = calculate_sidereal_context(born, 13.08, 80.27, reference_date=born, astronomy=astro)
    points = natal_points(natal)
    assert set(points) == {p.value for p in P} | {"lagna"}
    assert points["lagna"] == natal.lagna.longitude
    assert points["sun"] == natal.planets[P.SUN].longitude


def test_should_move_rahu_and_ketu_opposite_each_other(astro: SkyfieldAstronomy) -> None:
    movers = astro_movers(astro)
    when = datetime(2010, 6, 1, tzinfo=UTC)
    assert set(movers) == {P.SATURN, P.JUPITER, P.RAHU, P.KETU, P.MARS}
    assert (movers[P.KETU](when) - movers[P.RAHU](when)) % 360 == pytest.approx(180.0)


def _month_starts(year: int) -> list[datetime]:
    return [datetime(year, m, 1, tzinfo=UTC) for m in range(1, 13)] + [
        datetime(year + 1, 1, 1, tzinfo=UTC)
    ]


def test_should_match_the_exact_spells_month_by_month_on_a_real_native(
    astro: SkyfieldAstronomy,
) -> None:
    # Given a real chart and the book's month-resolution scan of 2010-2012
    born = datetime(1971, 8, 9, 3, 15, tzinfo=UTC)
    natal = calculate_sidereal_context(born, 51.5, -0.12, reference_date=born, astronomy=astro)
    movers, points = astro_movers(astro), natal_points(natal)
    book = ContactBook(movers, points)
    for year in (2010, 2011, 2012):
        bounds = _month_starts(year)
        for graha, lon in movers.items():
            for name, point in points.items():
                # When the exact spells are computed for the same year
                exact = orb_spells(
                    lon, point, bounds[0], bounds[-1], 1.0, 5.0 if graha is not P.MARS else 2.0
                )
                for start, end in zip(bounds, bounds[1:], strict=False):
                    touched = any(s.start < end and s.end >= start for s in exact)
                    # Then every month answer is identical
                    assert ((graha, name) in book.month(start, end)) == touched, (
                        graha,
                        name,
                        start,
                    )


def test_should_scan_only_the_movers_it_is_given() -> None:
    book = ContactBook({P.SATURN: _linear}, {"sun": 15.0})
    feb = book.month(datetime(2001, 2, 1, tzinfo=UTC), datetime(2001, 3, 1, tzinfo=UTC))
    assert {graha for graha, _ in feb} == {P.SATURN}
