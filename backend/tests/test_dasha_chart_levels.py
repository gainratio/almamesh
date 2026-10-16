"""Dasha depth: the chart must surface the active antardasha + pratyantardasha.

The natal chart historically emitted only ``current_maha``; ``current_antar``
and ``current_pratyantar`` were always ``None``. A pro reader expects all three
levels. These periods are sub-divisions of the active maha period built under
the SAME declared year convention (so they tile exactly), and the "active"
instant is the injectable ``reference_date`` (never a bare wall-clock read
below the entrypoint) so the chart stays deterministic.

Period intelligence (this file's second half): the product must speak about the
CURRENT period and ALL FUTURE periods with exact dates, so every maha row also
carries its nine dated antardashas (9 x 9 = 81 rows — the whole life at antar
depth) and the payload carries the nine dated pratyantardashas of the CURRENT
antar. Both reuse the same proportional subdivision the active-leg search uses,
so the active legs appear in their sequences with byte-identical dates.
"""

from datetime import UTC, date, datetime, timedelta
from functools import cache

import pytest

from almamesh.calculations import (
    PlanetName,
    calculate_sidereal_context,
    calculate_vimshottari_dashas,
)
from almamesh.constants.astrology import DASHA_SEQUENCE, DASHA_YEARS
from almamesh.dasha.convention import (
    DEFAULT_DASHA_YEAR_CONVENTION,
    DashaYearConvention,
)
from almamesh.schemas.astrology import DashaPeriod, SiderealContext, VimshottariDashaData

# Synthetic reference native (Bengaluru, fictional birth), pinned reference instant.
_REFERENCE_BIRTH = datetime(1988, 8, 8, 1, 14, 0, tzinfo=UTC)  # 06:44 IST
_REFERENCE_LAT, _REFERENCE_LON = 12.9716, 77.5946
_REF = datetime(2025, 1, 1, tzinfo=UTC)


@cache
def _reference_context_at(ref: datetime) -> SiderealContext:
    """One reference chart per reference instant (pure + deterministic, so cached)."""
    return calculate_sidereal_context(
        _REFERENCE_BIRTH, _REFERENCE_LAT, _REFERENCE_LON, reference_date=ref
    )


def _reference_dashas() -> VimshottariDashaData:
    return _reference_context_at(_REF).dashas


def test_chart_populates_current_antar() -> None:
    """The active antardasha is populated, not None."""
    # Given a deterministic reference chart
    dashas = _reference_dashas()
    # Then the current antardasha is present and nested inside the maha period
    assert dashas.current_antar is not None
    assert dashas.current_maha is not None
    assert dashas.current_maha.start_date <= dashas.current_antar.start_date
    assert dashas.current_antar.end_date <= dashas.current_maha.end_date


def test_chart_populates_current_pratyantar() -> None:
    """The active pratyantardasha is populated and nested in the antardasha."""
    # Given a deterministic reference chart
    dashas = _reference_dashas()
    # Then the current pratyantardasha is present and nested inside the antar
    assert dashas.current_pratyantar is not None
    assert dashas.current_antar is not None
    assert dashas.current_antar.start_date <= dashas.current_pratyantar.start_date
    assert dashas.current_pratyantar.end_date <= dashas.current_antar.end_date


def test_active_instant_lies_within_all_three_periods() -> None:
    """The reference instant falls inside maha, antar AND pratyantar."""
    # Given a deterministic reference chart at the pinned reference instant
    dashas = _reference_dashas()
    # Then the reference instant is contained by every active level
    for period in (dashas.current_maha, dashas.current_antar, dashas.current_pratyantar):
        assert period is not None
        assert period.start_date <= _REF < period.end_date


def test_antardashas_tile_the_active_maha_exactly() -> None:
    """The active antar is one of nine ADs that tile the maha with no overhang."""
    # Given the active maha's own span
    dashas = _reference_dashas()
    assert dashas.current_antar is not None
    # When the antar duration is expressed as a fraction of the maha
    maha = dashas.current_maha
    assert maha is not None
    # Then the antar's start aligns to the maha (first AD) or a prior AD end —
    # i.e. it never starts before the maha and never ends after it.
    assert maha.start_date <= dashas.current_antar.start_date < maha.end_date


def test_no_active_periods_when_reference_before_birth() -> None:
    """A reference instant before birth yields no current maha/antar/PD."""
    # Given a reference instant decades before the birth
    before = datetime(1900, 1, 1, tzinfo=UTC)
    data = calculate_vimshottari_dashas(
        moon_long=0.0,
        birth_dt=datetime(2000, 1, 1, tzinfo=UTC),
        reference_date=before,
    )
    # Then no level is active (the chart does not invent a current dasha)
    assert data.current_maha is None
    assert data.current_antar is None
    assert data.current_pratyantar is None


def test_antar_and_pd_lords_start_from_their_parent_lord() -> None:
    """The first AD lord == MD lord; the first PD lord == AD lord (BPHS rule)."""
    # Given a maha that is itself active at its own start instant
    birth = datetime(2000, 1, 1, tzinfo=UTC)
    data = calculate_vimshottari_dashas(moon_long=0.0, birth_dt=birth, reference_date=birth)
    # Then at birth the active AD lord equals the active MD lord ...
    assert data.current_maha is not None
    assert data.current_antar is not None
    assert data.current_antar.lord == data.current_maha.lord
    # ... and the active PD lord equals that AD lord.
    assert data.current_pratyantar is not None
    assert data.current_pratyantar.lord == data.current_antar.lord


def test_convention_field_is_surfaced_and_defaults_julian() -> None:
    """The dasha output exposes the year convention it used (no silent switch)."""
    # Given a default-convention chart
    dashas = _reference_dashas()
    # Then the convention is surfaced as a typed field, defaulting to Julian
    assert dashas.convention == DEFAULT_DASHA_YEAR_CONVENTION
    assert dashas.convention == DashaYearConvention.JULIAN_365_25


def test_convention_field_reflects_explicit_choice() -> None:
    """Choosing a convention is reflected in the output field, not hidden."""
    # Given an explicit savana-360 convention
    data = calculate_vimshottari_dashas(
        moon_long=0.0,
        birth_dt=datetime(2000, 1, 1, tzinfo=UTC),
        convention=DashaYearConvention.SAVANA_360,
        reference_date=datetime(2010, 1, 1, tzinfo=UTC),
    )
    # Then the output reports that exact convention
    assert data.convention == DashaYearConvention.SAVANA_360


def test_active_dashas_are_pure_function_of_reference_date() -> None:
    """Same birth + same reference_date => byte-identical dasha output."""
    # Given two identical computations
    args = dict(
        moon_long=123.456,
        birth_dt=datetime(1985, 7, 23, 4, 30, tzinfo=UTC),
        reference_date=datetime(2025, 6, 9, tzinfo=UTC),
    )
    a = calculate_vimshottari_dashas(**args)  # type: ignore[arg-type]
    b = calculate_vimshottari_dashas(**args)  # type: ignore[arg-type]
    # Then their JSON dumps are identical (determinism for parity)
    assert a.model_dump(mode="json") == b.model_dump(mode="json")
    _ = PlanetName  # keep import meaningful across refactors


# ---------------------------------------------------------------------------
# Period intelligence: every maha's dated antardashas + the current antar's
# dated pratyantardashas. The closing boundary of a subdivided period may sit
# up to 1 microsecond from its parent's end (timedelta * float rounds to whole
# microseconds — the engine's own _BOUNDARY_EPSILON resolution); contiguity
# between consecutive sub-periods is exact by construction.
# ---------------------------------------------------------------------------

_TILING_EPSILON = timedelta(microseconds=1)

# A second, unrelated birth + reference so the tree is generic, never reference-tuned.
_SECOND_MOON_LONG = 211.625
_SECOND_BIRTH = datetime(1995, 11, 3, 16, 20, tzinfo=UTC)
_SECOND_REF = datetime(2026, 6, 1, tzinfo=UTC)

# Reference instant inside a future Saturn PD window of the reference chart.
_REFERENCE_REF_2026 = datetime(2026, 3, 1, tzinfo=UTC)

_TREE_CASES = ("reference", "second", "second_savana")


def _second_dashas(
    convention: DashaYearConvention = DEFAULT_DASHA_YEAR_CONVENTION,
) -> VimshottariDashaData:
    return calculate_vimshottari_dashas(
        moon_long=_SECOND_MOON_LONG,
        birth_dt=_SECOND_BIRTH,
        convention=convention,
        reference_date=_SECOND_REF,
    )


def _dashas_case(case: str) -> VimshottariDashaData:
    if case == "reference":
        return _reference_dashas()
    if case == "second":
        return _second_dashas()
    return _second_dashas(DashaYearConvention.SAVANA_360)


def _same_period(a: DashaPeriod, b: DashaPeriod) -> bool:
    """Identical (lord, start, end) — the byte-identity the payload promises."""
    return (a.lord, a.start_date, a.end_date) == (b.lord, b.start_date, b.end_date)


@pytest.mark.parametrize("case", _TREE_CASES)
def test_every_maha_row_carries_its_dated_antardashas(case: str) -> None:
    """The birth maha keeps only the antars still running at birth; later mahas have 9.

    CONTRACT REVERSED (was: 9 antars in every maha). The native is born part-way
    through the birth maha, so the antars that ended before birth are not listed.
    """
    # Given any chart's dasha payload
    dashas = _dashas_case(case)
    # Then the full life tree is present at antar depth
    assert len(dashas.maha_dasha_sequence) == 9
    birth_maha, *later = dashas.maha_dasha_sequence
    assert len(birth_maha.antar_sequence) == _antars_running_at_birth(birth_maha)
    for maha in later:
        assert len(maha.antar_sequence) == 9


def _antars_running_at_birth(maha: DashaPeriod) -> int:
    """How many of the birth maha's nine antars end after birth (from elapsed years)."""
    full_years = DASHA_YEARS[maha.lord]
    elapsed = full_years - maha.duration_years
    start = DASHA_SEQUENCE.index(maha.lord)
    ends, total = [], 0.0
    for i in range(9):
        total += full_years * DASHA_YEARS[DASHA_SEQUENCE[(start + i) % 9]] / 120.0
        ends.append(total)
    return sum(1 for end in ends if end > elapsed)


@pytest.mark.parametrize("case", _TREE_CASES)
def test_antar_sequences_tile_each_maha_contiguously(case: str) -> None:
    """Antars open at the maha start, chain end-to-start, and close the maha."""
    # Given each maha row's antar breakdown
    dashas = _dashas_case(case)
    for maha in dashas.maha_dasha_sequence:
        seq = maha.antar_sequence
        # Then the antars tile the maha span: exact open, exact chaining
        # (no gap, no overlap), and a closing end within float resolution.
        assert seq[0].start_date == maha.start_date
        for prev, nxt in zip(seq, seq[1:], strict=False):
            assert prev.end_date == nxt.start_date
        assert abs(seq[-1].end_date - maha.end_date) <= _TILING_EPSILON


@pytest.mark.parametrize("case", _TREE_CASES)
def test_antar_lords_rotate_from_each_maha_lord(case: str) -> None:
    """Classical Vimshottari: AD lords start at the MD lord and follow the cycle."""
    # Given each maha row
    dashas = _dashas_case(case)
    for maha in dashas.maha_dasha_sequence:
        # Then the antar lords are the dasha cycle rotated to the maha lord; the
        # birth maha lists only the tail of that rotation (antars running at birth)
        start = DASHA_SEQUENCE.index(maha.lord)
        expected = [DASHA_SEQUENCE[(start + i) % 9] for i in range(9)]
        lords = [antar.lord for antar in maha.antar_sequence]
        assert lords == expected[9 - len(lords) :]


@pytest.mark.parametrize("case", _TREE_CASES)
def test_current_antar_listed_in_its_maha_row_with_identical_dates(case: str) -> None:
    """The active antar IS one of its maha row's nine antars, byte-identical."""
    # Given the active maha + antar
    dashas = _dashas_case(case)
    assert dashas.current_maha is not None
    assert dashas.current_antar is not None
    # When the maha row matching the active maha is looked up
    row = next(r for r in dashas.maha_dasha_sequence if _same_period(r, dashas.current_maha))
    # Then the active antar appears in that row's sequence with identical dates
    assert any(_same_period(a, dashas.current_antar) for a in row.antar_sequence)


@pytest.mark.parametrize("case", _TREE_CASES)
def test_pratyantar_sequence_is_the_nine_pds_of_the_current_antar(case: str) -> None:
    """pratyantar_sequence dates the current antar's nine PDs, incl. the active one."""
    # Given an active antar
    dashas = _dashas_case(case)
    antar = dashas.current_antar
    assert antar is not None
    # Then its nine PDs are dated, tile it, start from its lord ...
    seq = dashas.pratyantar_sequence
    assert seq is not None
    assert len(seq) == 9
    assert seq[0].lord == antar.lord
    assert seq[0].start_date == antar.start_date
    assert abs(seq[-1].end_date - antar.end_date) <= _TILING_EPSILON
    # ... and the active PD appears among them with identical dates.
    assert dashas.current_pratyantar is not None
    assert any(_same_period(p, dashas.current_pratyantar) for p in seq)


@pytest.mark.parametrize(
    "ref",
    [datetime(1900, 1, 1, tzinfo=UTC), datetime(2200, 1, 1, tzinfo=UTC)],
    ids=["before_birth", "after_cycle"],
)
def test_pratyantar_sequence_none_outside_cycle_but_tree_still_dated(ref: datetime) -> None:
    """No active antar (ref outside the cycle) => null PDs, yet the 81-row tree stands."""
    # Given a reference instant outside the covered 120-year cycle
    data = calculate_vimshottari_dashas(
        moon_long=0.0, birth_dt=datetime(2000, 1, 1, tzinfo=UTC), reference_date=ref
    )
    # Then there is no current antar and no pratyantar breakdown ...
    assert data.current_antar is None
    assert data.pratyantar_sequence is None
    # ... but every maha still carries its dated antars (the tree is unconditional).
    assert all(len(maha.antar_sequence) == 9 for maha in data.maha_dasha_sequence)


def test_reference_saturn_maha_antar_dates_match_engine_values() -> None:
    """Saturn maha 2025-03-02..2044-03-02 carries Venus antar 2031-12-23..2035-02-22."""
    # Given the reference chart's Saturn maha row
    dashas = _reference_dashas()
    saturn = next(m for m in dashas.maha_dasha_sequence if m.lord == PlanetName.SATURN)
    assert saturn.start_date.date() == date(2025, 3, 2)
    assert saturn.end_date.date() == date(2044, 3, 2)
    # Then its antar breakdown dates the Venus antar exactly as the engine emits
    venus = next(a for a in saturn.antar_sequence if a.lord == PlanetName.VENUS)
    assert venus.start_date.date() == date(2031, 12, 23)
    assert venus.end_date.date() == date(2035, 2, 22)


def test_reference_pratyantar_sequence_dates_a_future_pd_in_the_active_antar() -> None:
    """At the 2025-01-01 reference the PD list already dates a FUTURE Mars PD."""
    # Given the reference chart at the pinned 2025-01-01 reference (Rahu antar active)
    dashas = _reference_dashas()
    assert dashas.current_antar is not None
    assert dashas.current_antar.lord == PlanetName.RAHU
    # Then the PD breakdown names the future Mars window with exact dates
    assert dashas.pratyantar_sequence is not None
    mars_pd = next(p for p in dashas.pratyantar_sequence if p.lord == PlanetName.MARS)
    assert mars_pd.start_date.date() == date(2025, 1, 10)
    assert mars_pd.end_date.date() == date(2025, 3, 2)


def test_reference_current_pd_at_a_2026_reference_is_the_ketu_window() -> None:
    """With reference 2026-03-01 the CURRENT PD is Ketu 2026-01-26..2026-03-31."""
    # Given the reference chart at a reference inside the Saturn-maha Ketu PD window
    dashas = _reference_context_at(_REFERENCE_REF_2026).dashas
    pd = dashas.current_pratyantar
    # Then the current PD is that exact dated Ketu window ...
    assert pd is not None
    assert pd.lord == PlanetName.KETU
    assert pd.start_date.date() == date(2026, 1, 26)
    assert pd.end_date.date() == date(2026, 3, 31)
    # ... and it appears in pratyantar_sequence with identical dates.
    assert dashas.pratyantar_sequence is not None
    assert any(_same_period(p, pd) for p in dashas.pratyantar_sequence)


def test_savana_convention_builds_360_day_years_in_the_tree() -> None:
    """The declared convention drives the dated tree: a full Savana maha = years*360d."""
    # Given an explicit Savana-360 payload
    data = _second_dashas(DashaYearConvention.SAVANA_360)
    assert data.convention == DashaYearConvention.SAVANA_360
    # Then a full maha (index 0 is the partial balance) spans years * 360 days
    full_md = data.maha_dasha_sequence[1]
    expected = timedelta(days=DASHA_YEARS[full_md.lord] * 360.0)
    assert (full_md.end_date - full_md.start_date) == expected


def test_payload_shape_is_additive_and_exact() -> None:
    """Maha rows = period keys + antar_sequence; sub-rows and current legs stay plain."""
    # Given the serialized reference payload
    payload = _reference_dashas().model_dump(mode="json")
    period_keys = {"lord", "start_date", "end_date", "duration_years"}
    # Then the top level gains exactly pratyantar_sequence ...
    assert set(payload) == {
        "maha_dasha_sequence",
        "current_maha",
        "current_antar",
        "current_pratyantar",
        "pratyantar_sequence",
        "convention",
    }
    # ... each maha row gains exactly antar_sequence ...
    for row in payload["maha_dasha_sequence"]:
        assert set(row) == period_keys | {"antar_sequence"}
        for antar in row["antar_sequence"]:
            assert set(antar) == period_keys
    # ... and the current legs + PD rows keep the plain period shape (byte-stable).
    assert set(payload["current_maha"]) == period_keys
    assert set(payload["current_antar"]) == period_keys
    assert set(payload["current_pratyantar"]) == period_keys
    for pd_row in payload["pratyantar_sequence"]:
        assert set(pd_row) == period_keys


def _assert_row_duration_is_its_span(row: DashaPeriod, days_per_year: float) -> None:
    """``duration_years`` must agree with the row's own dated span (±1e-6 y)."""
    span_years = (row.end_date - row.start_date) / timedelta(days=days_per_year)
    assert row.duration_years == pytest.approx(span_years, abs=1e-6)


@pytest.mark.parametrize("case", _TREE_CASES)
def test_sub_period_duration_years_is_the_rows_actual_span(case: str) -> None:
    """Antar/PD rows carry their OWN length in dasha-years, not the lord's cycle.

    Regression: sub-rows used to carry ``DASHA_YEARS[lord]`` (the proportion
    numerator), so a ~3.17-year Venus antardasha inside a 19-year Saturn maha
    rendered as "20 y" in the Periods explorer and the report tables, and fed
    the LLM a 20-year period. The field must mean the same thing at every
    level — the period's actual span — exactly as the (partial-balance-aware)
    maha rows already do.
    """
    # Given any chart's dasha payload
    dashas = _dashas_case(case)
    days_per_year = dashas.convention.days_per_year
    # Then every antar row's duration is the maha-proportional actual span
    birth_maha, *later = dashas.maha_dasha_sequence
    for antar in birth_maha.antar_sequence:
        _assert_row_duration_is_its_span(antar, days_per_year)
    for maha in later:
        for antar in maha.antar_sequence:
            expected = maha.duration_years * (DASHA_YEARS[antar.lord] / 120.0)
            assert antar.duration_years == pytest.approx(expected, rel=1e-9)
            _assert_row_duration_is_its_span(antar, days_per_year)
    # ... and the current legs + the PD rows agree with their dated spans too.
    assert dashas.current_antar is not None
    assert dashas.pratyantar_sequence is not None
    _assert_row_duration_is_its_span(dashas.current_antar, days_per_year)
    for pd_row in dashas.pratyantar_sequence:
        _assert_row_duration_is_its_span(pd_row, days_per_year)
