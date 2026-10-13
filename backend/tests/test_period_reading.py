"""The period reading (fifth predictive context) on DELHI_BIRTH, end to end.

DELHI_BIRTH = 1990-01-15T12:00Z, 28.6139 N 77.209 E, IST (+330 min): Gemini
lagna, Leo Moon. May 2019 runs Rahu maha / Rahu antar / Venus pratyantar.
Saturn in Sagittarius (2019) is the 5th from the Leo Moon: NOT Sade Sati.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.dasha.yogini import compute_yogini_periods
from almamesh.predictive import PredictiveContexts, compute_predictive_contexts
from almamesh.reading import compute_period_reading
from almamesh.schemas.reading import DashaLevel, FunctionalNature, PeriodReading

_BIRTH = datetime(1990, 1, 15, 12, tzinfo=UTC)
_FIXTURE_DIR = Path(__file__).resolve().parents[2] / "testdata" / "period-reading"

# (fixture file, reference instant, window months, reading end) — the four golden
# readings, exactly as production asks for them: every period up to a year runs the
# default 12-month window, bounded by the period's own inclusive last day.
READING_CASES: dict[str, tuple[datetime, int, date | None]] = {
    "delhi-2019-05.json": (datetime(2019, 5, 1, tzinfo=UTC), 12, date(2019, 5, 31)),
    "delhi-2019-year.json": (datetime(2019, 1, 1, tzinfo=UTC), 12, date(2019, 12, 31)),
    "delhi-2027-01.json": (datetime(2027, 1, 1, tzinfo=UTC), 12, date(2027, 1, 31)),
    "delhi-2019-09-15-day.json": (datetime(2019, 9, 15, tzinfo=UTC), 12, None),
}


def compute_delhi(
    reference: datetime, window_months: int, reading_end: date | None = None
) -> PredictiveContexts:
    """The full predictive run for DELHI_BIRTH at one reference instant."""
    return compute_predictive_contexts(
        _BIRTH,
        28.6139,
        77.209,
        reference,
        civil_offset=timedelta(minutes=330),
        window_months=window_months,
        reading_end=reading_end,
    )


def wire_reading(contexts: PredictiveContexts) -> dict[str, object]:
    """The JSON wire form of the reading, exactly as the browser receives it."""
    dumped = contexts.model_dump(mode="json")["period_reading"]
    assert isinstance(dumped, dict)
    return dumped


_DASHA_FACTOR = re.compile(r"\b([A-Z][a-z]+) \((maha|antar|pratyantar)\)")


def _cited_lords(reading: PeriodReading) -> set[str]:
    """Every graha a theme factor cites as a running dasha lord, plus every segment's lords."""
    cited = {
        m[0].lower() for t in reading.themes for f in t.factors for m in _DASHA_FACTOR.findall(f)
    }
    for s in reading.segments:
        cited |= {s.maha.value, s.antar.value, s.pratyantar.value}
    return cited | {span.lord.value for span in reading.dasha_spans}


@pytest.mark.parametrize("reading_end", [None, date(2019, 5, 31)])
def test_a_may_2019_trip_cites_only_mays_running_lords(reading_end: date | None) -> None:
    """The app runs a 12-month window for a month; the reading must still be May's.

    Regression: the reading covered the whole window and cited Jupiter (antar)
    and Sun (pratyantar), lords that start long after May 2019.
    """
    contexts = compute_predictive_contexts(
        _BIRTH,
        28.6139,
        77.209,
        datetime(2019, 5, 1, tzinfo=UTC),
        civil_offset=timedelta(minutes=330),
        window_months=12,
        reading_end=reading_end,
    )
    reading = contexts.period_reading
    assert _cited_lords(reading) <= {"rahu", "venus"}
    assert reading.yogini is not None and reading.yogini.lord == PlanetName.MERCURY
    last = reading_end or date(2019, 5, 1)
    window = (reading.window.start, reading.window.end)
    assert window == (date(2019, 5, 1), last + timedelta(days=1))


@pytest.fixture(scope="module")
def may() -> PredictiveContexts:
    return compute_delhi(*READING_CASES["delhi-2019-05.json"])


@pytest.fixture(scope="module")
def year() -> PredictiveContexts:
    return compute_delhi(*READING_CASES["delhi-2019-year.json"])


def test_may_2019_runs_rahu_rahu_venus(may: PredictiveContexts) -> None:
    spans = {(s.level, s.lord) for s in may.period_reading.dasha_spans}
    assert spans == {
        (DashaLevel.MAHA, PlanetName.RAHU),
        (DashaLevel.ANTAR, PlanetName.RAHU),
        (DashaLevel.PRATYANTAR, PlanetName.VENUS),
    }
    first = may.period_reading.segments[0]
    assert (first.maha, first.antar, first.pratyantar) == (
        PlanetName.RAHU,
        PlanetName.RAHU,
        PlanetName.VENUS,
    )


def test_dasha_spans_are_clipped_to_the_window(may: PredictiveContexts) -> None:
    reading = may.period_reading
    assert reading.window.start == date(2019, 5, 1)
    for span in reading.dasha_spans:
        assert reading.window.start <= span.start < span.end <= reading.window.end


def test_leo_moon_means_no_sade_sati_in_2019(year: PredictiveContexts) -> None:
    """Saturn in Sagittarius is 5th from the Leo Moon: no Sade Sati tag at all."""
    assert year.transit_context.sade_sati.natal_moon_sign == "Leo"
    saturn = [s for s in year.period_reading.sky if s.graha == PlanetName.SATURN]
    assert {s.sign for s in saturn} == {"sagittarius"}
    assert all(s.from_moon == 5 and s.tags == [] for s in saturn)


def test_jupiter_ingress_splits_the_year(year: PredictiveContexts) -> None:
    """Jupiter enters Sagittarius in Nov 2019: a segment starts there and a sky span too."""
    reading = year.period_reading
    ingress = next(
        e
        for e in year.transit_context.timeline.events
        if e.descriptor == "jupiter.ingress.sagittarius"
    )
    starts = {s.start for s in reading.segments}
    assert ingress.date.date() in starts
    jupiter = [s for s in reading.sky if s.graha == PlanetName.JUPITER]
    assert jupiter[-1].sign == "sagittarius" and jupiter[-1].tags == ["jupiter_from_moon_5"]
    assert jupiter[0].sign == "scorpio" and jupiter[0].tags == ["jupiter_from_moon_4"]


def test_segments_tile_the_window(year: PredictiveContexts) -> None:
    reading = year.period_reading
    segments = reading.segments
    assert segments[0].start == reading.window.start
    assert segments[-1].end == reading.window.end
    for prev, curr in zip(segments, segments[1:], strict=False):
        assert prev.end == curr.start and prev.start < prev.end


def test_segments_split_at_every_pratyantar_change(year: PredictiveContexts) -> None:
    reading = year.period_reading
    starts = {s.start for s in reading.segments}
    pratyantars = [s for s in reading.dasha_spans if s.level == DashaLevel.PRATYANTAR]
    assert len(pratyantars) >= 3
    assert all(p.start in starts for p in pratyantars)


def test_every_window_event_lands_in_a_segment(year: PredictiveContexts) -> None:
    placed = [e for s in year.period_reading.segments for e in s.events]
    events = year.transit_context.timeline.events
    assert placed == [f"{e.date.astimezone(UTC).date().isoformat()} {e.descriptor}" for e in events]


def test_segment_events_carry_a_date_inside_their_segment(year: PredictiveContexts) -> None:
    """A change point the model cites needs its day.

    P1 drive 2026-10-13: the May 2019 reading listed an undated Mars ingress.
    """
    for segment in year.period_reading.segments:
        for event in segment.events:
            day, _, descriptor = event.partition(" ")
            assert descriptor
            assert segment.start <= date.fromisoformat(day) < segment.end


def test_sky_spans_tile_the_window_per_graha(year: PredictiveContexts) -> None:
    reading = year.period_reading
    for graha in (PlanetName.JUPITER, PlanetName.SATURN, PlanetName.RAHU, PlanetName.KETU):
        spans = [s for s in reading.sky if s.graha == graha]
        assert spans[0].start == reading.window.start and spans[-1].end == reading.window.end
        for prev, curr in zip(spans, spans[1:], strict=False):
            assert prev.end == curr.start


def test_saturn_station_flips_retro_in_the_sky(year: PredictiveContexts) -> None:
    """Saturn turns direct in Sep 2019: one retro span, then a direct span, same sign."""
    saturn = [s for s in year.period_reading.sky if s.graha == PlanetName.SATURN]
    assert [s.retro for s in saturn][-2:] == [True, False]


def test_sky_bindus_read_the_ashtakavarga(may: PredictiveContexts) -> None:
    av = may.strength_context.ashtakavarga
    for span in may.period_reading.sky:
        sign = span.sign.capitalize()
        assert span.sav == av.sarva.bindus[sign]  # type: ignore[index]
        expected = av.bhinna[span.graha].bindus[sign] if span.graha in av.bhinna else None  # type: ignore[index]
        assert span.bav == expected


def test_natal_lords_state_lordship_and_functional_nature(may: PredictiveContexts) -> None:
    lords = may.period_reading.natal_lords
    assert list(lords) == list(PlanetName)
    assert lords[PlanetName.SATURN].rules == [8, 9]
    assert lords[PlanetName.SATURN].functional is FunctionalNature.BENEFIC
    assert lords[PlanetName.MARS].functional is FunctionalNature.MALEFIC
    assert lords[PlanetName.JUPITER].functional is FunctionalNature.MARAKA
    assert lords[PlanetName.RAHU].functional is FunctionalNature.NEUTRAL
    assert "Vipareeta Raja Yoga" in lords[PlanetName.MARS].yogas
    assert lords[PlanetName.JUPITER].yogas.count("Raja Yoga") == 1  # deduplicated
    assert lords[PlanetName.MOON].sign == "leo"


def test_natal_lords_carry_the_varga_signs(may: PredictiveContexts) -> None:
    charts = may.varga_context_full.charts
    for graha, lord in may.period_reading.natal_lords.items():
        assert lord.d9_sign == str(charts["D9"].placements[graha].sign).lower()  # type: ignore[index]
        assert lord.d10_sign == str(charts["D10"].placements[graha].sign).lower()  # type: ignore[index]


def test_transit_lords_are_the_running_lords(may: PredictiveContexts) -> None:
    reading = may.period_reading
    assert reading.sookshma is not None
    running = {PlanetName.RAHU, PlanetName.VENUS, reading.sookshma.lord}
    assert set(reading.transit_lords) == running
    venus = may.transit_context.gochara.placements[PlanetName.VENUS]
    assert reading.transit_lords[PlanetName.VENUS].from_moon == venus.house_from_moon


def test_sookshma_contains_the_reference_day(may: PredictiveContexts) -> None:
    sookshma = may.period_reading.sookshma
    assert sookshma is not None
    assert sookshma.start <= date(2019, 5, 1) <= sookshma.end


def test_double_transit_may_2019_is_empty(may: PredictiveContexts) -> None:
    """Jupiter in Scorpio touches 6/10/12/2 from Gemini; Saturn in Sagittarius 7/9/1/4."""
    assert may.period_reading.double_transit == []


def test_double_transit_after_jupiter_joins_saturn() -> None:
    """Jan 2020: both in Sagittarius (7th from Gemini lagna)."""
    reading = compute_delhi(datetime(2020, 1, 1, tzinfo=UTC), 1).period_reading
    # Jupiter (Sag) touches 7, 11, 1, 3; Saturn (Sag) touches 7, 9, 1, 4.
    assert reading.double_transit == [1, 7]


def test_sandhi_names_the_antar_change_inside_the_window() -> None:
    """Rahu-Rahu hands over to Rahu-Jupiter on 2020-01-24."""
    reading = compute_delhi(datetime(2020, 1, 10, tzinfo=UTC), 1, date(2020, 2, 8)).period_reading
    assert reading.sandhi is not None
    assert (reading.sandhi.level, reading.sandhi.date) == (DashaLevel.ANTAR, date(2020, 1, 24))


def test_no_sandhi_when_the_antar_runs_through(may: PredictiveContexts) -> None:
    assert may.period_reading.sandhi is None


def test_yogini_is_the_running_yogini_maha(may: PredictiveContexts) -> None:
    yogini = may.period_reading.yogini
    assert yogini is not None
    natal = calculate_sidereal_context(_BIRTH, 28.6139, 77.209, reference_date=_BIRTH)
    periods = compute_yogini_periods(natal, _BIRTH, datetime(2100, 1, 1, tzinfo=UTC))
    running = next(p for p in periods if p.start_date.date() == yogini.start)
    assert (running.lord, running.yogini_name.lower()) == (yogini.lord, yogini.name)
    assert yogini.start <= date(2019, 5, 1) < yogini.end
    assert yogini.name == yogini.name.lower()


def test_themes_are_ranked_and_capped(year: PredictiveContexts) -> None:
    themes = year.period_reading.themes
    assert 1 <= len(themes) <= 6
    keys = [(-sum(t.agreement.model_dump().values()), -t.strength_pct) for t in themes]
    assert keys == sorted(keys)
    for theme in themes:
        agreeing = sum(theme.agreement.model_dump().values())
        assert theme.confidence == {3: "high", 2: "medium"}.get(agreeing, "low")
        assert 1 <= len(theme.factors) <= 3
        assert all(len(f) <= 80 for f in theme.factors)


def test_theme_windows_stay_inside_the_window(year: PredictiveContexts) -> None:
    reading = year.period_reading
    for theme in reading.themes:
        assert all(reading.window.start <= w.date <= reading.window.end for w in theme.windows)


def test_theme_factors_cite_engine_facts(may: PredictiveContexts) -> None:
    """Rahu rules nothing; Venus (pratyantar) rules the 5th and 12th for Gemini."""
    factors = [f for t in may.period_reading.themes for f in t.factors]
    assert any(f.startswith("Venus (pratyantar) rules the 5th") for f in factors) or any(
        f.startswith("Venus (pratyantar) rules the 12th") for f in factors
    )


def test_panchang_is_stated_at_the_reference_instant(may: PredictiveContexts) -> None:
    panchang = may.period_reading.panchang
    assert panchang.instant == datetime(2019, 5, 1, tzinfo=UTC)
    moon = may.transit_context.gochara.placements[PlanetName.MOON]
    assert panchang.nakshatra == moon.nakshatra
    assert panchang.vara == "Wednesday"


def test_rules_state_every_counting_rule(may: PredictiveContexts) -> None:
    text = " ".join(may.period_reading.rules)
    for needle in ("functional nature", "confidence", "direction", "agreement", "sade_sati"):
        assert needle in text
    assert all(len(rule) <= 200 for rule in may.period_reading.rules)


def test_the_reading_makes_no_ephemeris_call(
    may: PredictiveContexts, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rebuilt from the run's own contexts with every astronomy entry point disabled."""
    natal = calculate_sidereal_context(
        _BIRTH, 28.6139, 77.209, reference_date=datetime(2019, 5, 1, tzinfo=UTC)
    )

    def _refuse(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("the period reading must not touch the ephemeris")

    for name in _ASTRONOMY_ENTRY_POINTS:
        monkeypatch.setattr(SkyfieldAstronomy, name, _refuse)
    rebuilt = compute_period_reading(
        natal,
        may.transit_context,
        may.varga_context_full,
        may.strength_context,
        may.domains_context,
        reading_end=date(2019, 5, 31),
    )
    assert rebuilt == may.period_reading


_ASTRONOMY_ENTRY_POINTS = (
    "__init__",
    "graha_sidereal_longitude",
    "get_planetary_positions",
    "calculate_lagna",
    "spica_chitra_ayanamsa",
)


@pytest.mark.parametrize("name", sorted(READING_CASES))
def test_golden_reading_fixtures_are_current(name: str) -> None:
    """testdata/period-reading/*.json is the frontend's copy; it must match the engine."""
    computed = wire_reading(compute_delhi(*READING_CASES[name]))
    committed = json.loads((_FIXTURE_DIR / name).read_text())
    assert computed == committed


def test_the_reading_round_trips_byte_identically(may: PredictiveContexts) -> None:
    dumped = may.period_reading.model_dump_json()
    assert PeriodReading.model_validate_json(dumped).model_dump_json() == dumped


def test_yogini_agreement_when_the_yogini_lord_signifies(may: PredictiveContexts) -> None:
    """Bhadrika (Mercury) runs 2016-2021; Mercury rules the 4th: education agrees."""
    assert may.period_reading.yogini is not None
    assert may.period_reading.yogini.lord == PlanetName.MERCURY
    education = next(t for t in may.period_reading.themes if t.domain == "education")
    assert education.agreement.yogini is True
    assert "Yogini Bhadrika (Mercury) rules the 4th" in education.factors


@pytest.fixture(scope="module")
def two_years() -> PredictiveContexts:
    # The last reading day the 24-month window allows: its end is 2028-06-09T00:00Z.
    return compute_delhi(datetime(2026, 6, 9, 12, tzinfo=UTC), 24, date(2028, 6, 8))


def test_theme_windows_are_capped_non_neutral_first(two_years: PredictiveContexts) -> None:
    """At most 3 windows per theme, chronological; a non-neutral window is never dropped
    for a neutral one (the full list stays in domains_context.upcoming_windows)."""
    forecasts = two_years.domains_context.forecasts
    for theme in two_years.period_reading.themes:
        dates = [w.date for w in theme.windows]
        assert len(dates) <= 3 and dates == sorted(dates)
        all_windows = forecasts[theme.domain].upcoming_windows
        loud = [w for w in all_windows if w.severity != "neutral"]
        kept = sum(w.severity != "neutral" for w in theme.windows)
        assert kept == min(len(loud), 3)
    spiritual = next(t for t in two_years.period_reading.themes if t.domain == "spiritual")
    assert len(spiritual.windows) == 3
