"""Pratyantardasha (3rd-level Vimshottari) extraction.

`VimshottariState.pd_lord` is consumed by signal extraction but was never
populated. Each pratyantardasha is a fraction of its antardasha's span, the
sequence starting from the antardasha lord, so the nine PDs tile the AD.
"""

from datetime import UTC, datetime, timedelta

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.dasha.models import VimPeriod
from almamesh.dasha.vimshottari import compute_vimshottari_periods, find_active_vimshottari

# A Sun antardasha spanning 120 days: PD lengths are DASHA_YEARS/120 of the
# span, so Sun's PD is the first 6 days, Moon's the next 10, and so on.
_AD_START = datetime(2000, 1, 1, tzinfo=UTC)


def _sun_antardasha() -> VimPeriod:
    return VimPeriod(
        md_lord=PlanetName.SUN,
        ad_lord=PlanetName.SUN,
        start_date=_AD_START,
        end_date=_AD_START + timedelta(days=120),
        antar_start=_AD_START,
        antar_end=_AD_START + timedelta(days=120),
    )


def test_active_state_populates_pratyantardasha() -> None:
    """The active state names a pratyantardasha lord, not None."""
    state = find_active_vimshottari([_sun_antardasha()], _AD_START + timedelta(days=3))
    assert state.pd_lord == PlanetName.SUN  # first PD starts from the AD lord


def test_pratyantardasha_advances_through_sequence() -> None:
    """Past the first PD's span, the next lord in sequence is active."""
    state = find_active_vimshottari([_sun_antardasha()], _AD_START + timedelta(days=8))
    assert state.pd_lord == PlanetName.MOON  # Sun's 6-day PD has elapsed


def test_clipped_window_keeps_the_true_pratyantar() -> None:
    """A window that starts mid-antar must not restart the PD sequence at the clip.

    Regression (B1): DELHI_BIRTH's Rahu-Rahu antar runs 2017-05-13 -> 2020-01-24;
    a window opening 2019-05-01 clipped it, and the PD arithmetic then started a
    fresh Rahu PD at the clip instead of the true Venus PD (2019-02-05 -> 07-19).
    """
    when = datetime(2019, 5, 1, tzinfo=UTC)
    natal = calculate_sidereal_context(
        datetime(1990, 1, 15, 12, tzinfo=UTC), 28.6139, 77.209, reference_date=when
    )
    periods = compute_vimshottari_periods(natal, when, when + timedelta(days=30))
    assert natal.dashas.current_pratyantar is not None
    assert natal.dashas.current_pratyantar.lord == PlanetName.VENUS
    assert find_active_vimshottari(periods, when).pd_lord == PlanetName.VENUS
