"""The birth maha is the TAIL of a full maha: its antars and pratyantars keep full length.

A native is born part-way through a maha dasha. Classical practice (and Jagannatha
Hora, PyJHora, Parashara's Light) dates the antars from the maha's virtual start
before birth, so at birth the native is already inside some antar and pratyantar.
The engine used to squeeze all nine antars into the birth balance instead, starting
the birth maha with its own lord's antar at the birth instant; every antar and
pratyantar date in the first maha was wrong (by up to 16 years on public charts).

Reference: Princess Diana, 1961-07-01 19:45 BST (18:45 UT), Sandringham 52.8311 N
0.5054 E, a widely published Rodden AA chart. Dates below are PyJHora 4.x (Lahiri,
mean sidereal year), run locally as a test oracle only, never a dependency. Our
Julian 365.25-day year and Moon agree with it to within a day after the first maha.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import (
    calculate_sidereal_context,
    calculate_vimshottari_dashas,
    subdivide_period,
)
from almamesh.constants.astrology import PlanetName
from almamesh.dasha.vimshottari import compute_vimshottari_periods, find_active_vimshottari
from almamesh.schemas.astrology import DashaPeriod

_BIRTH = datetime(1961, 7, 1, 18, 45, tzinfo=UTC)
_DAY = timedelta(days=1)
_JULIAN = 365.25


@pytest.fixture(scope="module")
def diana():
    return calculate_sidereal_context(_BIRTH, 52.8311, 0.5054, reference_date=_BIRTH)


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


def active_chain(mahas: Sequence[DashaPeriod], instant: datetime) -> list[DashaPeriod]:
    """The maha, antar and pratyantar running at ``instant``, via ``subdivide_period``."""
    chain: list[DashaPeriod] = []
    candidates: Sequence[DashaPeriod] = mahas
    while len(chain) < 3:
        hit = next((p for p in candidates if p.start_date <= instant < p.end_date), None)
        if hit is None:
            break
        chain.append(hit)
        candidates = subdivide_period(hit)
    return chain


def test_birth_maha_antars_resume_mid_sequence_hand_computed() -> None:
    """Moon at mid-Ashwini: Ketu maha with 3.5 of 7 years left, born in the Rahu antar."""
    # Given a Moon half-way through Ashwini (Ketu's star): 3.5 Ketu years have elapsed
    birth = datetime(2000, 1, 1, tzinfo=UTC)
    data = calculate_vimshottari_dashas((360 / 27) / 2, birth, reference_date=birth)
    # When the birth maha's antar tree is read
    antars = data.maha_dasha_sequence[0].antar_sequence
    # Then it resumes mid-sequence: the Ketu..Mars antars (7 * 50/120 = 2.9167 y) ended
    # before birth, so the tree is Rahu (clipped at birth), Jupiter, Saturn, Mercury
    assert [a.lord for a in antars] == [
        PlanetName.RAHU,
        PlanetName.JUPITER,
        PlanetName.SATURN,
        PlanetName.MERCURY,
    ]
    assert antars[0].start_date == birth
    # Jupiter starts 7 * (7+20+6+10+7+18)/120 = 3.9667 y after the virtual maha start
    jupiter_start = birth + timedelta(days=(7 * 68 / 120 - 3.5) * _JULIAN)
    assert abs(antars[1].start_date - jupiter_start) < timedelta(seconds=1)
    # And the tree still tiles the birth maha exactly
    assert antars[-1].end_date == data.maha_dasha_sequence[0].end_date
    assert data.current_antar is not None
    assert data.current_antar.lord is PlanetName.RAHU


@pytest.mark.parametrize(
    ("lord", "start"),
    [
        (PlanetName.KETU, "1961-08-02T23:42"),
        (PlanetName.VENUS, "1961-12-30T03:13"),
        (PlanetName.SUN, "1963-03-01T06:23"),
        (PlanetName.MOON, "1963-07-07T02:33"),
    ],
)
def test_birth_maha_antar_starts_match_the_reference(diana, lord: PlanetName, start: str) -> None:
    """Diana's Mars-maha antars start within a day of the reference dates."""
    # Given Diana's birth maha (Mars)
    maha = diana.dashas.maha_dasha_sequence[0]
    assert maha.lord is PlanetName.MARS
    # When the antar of ``lord`` is looked up
    antar = next(a for a in maha.antar_sequence if a.lord is lord)
    # Then its start matches the reference within a day
    assert abs(antar.start_date - _utc(start)) < _DAY


def test_birth_instant_runs_mars_mercury_saturn(diana) -> None:
    """At birth the reference runs Mars / Mercury / Saturn, not Mars / Mars / Mars."""
    # When the active chain at one hour after birth is read
    chain = active_chain(diana.dashas.maha_dasha_sequence, _BIRTH + timedelta(hours=1))
    # Then maha, antar and pratyantar are the reference lords
    assert [p.lord for p in chain[:3]] == [PlanetName.MARS, PlanetName.MERCURY, PlanetName.SATURN]
    assert chain[1].start_date == _BIRTH


def test_pratyantar_inside_a_full_birth_maha_antar_matches_the_reference(diana) -> None:
    """Mars / Ketu / Venus pratyantar starts 1961-08-11 16:30 UT (reference)."""
    # When the chain is read inside the Ketu antar
    chain = active_chain(diana.dashas.maha_dasha_sequence, _utc("1961-08-20T00:00"))
    # Then the pratyantar is Venus with the reference start
    assert chain[2].lord is PlanetName.VENUS
    assert abs(chain[2].start_date - _utc("1961-08-11T16:30")) < _DAY


def test_dasha_engine_periods_agree_with_the_antar_tree(diana) -> None:
    """The DashaEngine's MD/AD/PD view uses the same birth-maha antars."""
    # When the engine's periods cover the first year of life
    periods = compute_vimshottari_periods(diana, _BIRTH, _BIRTH + timedelta(days=365))
    # Then the first period is Mars / Mercury clipped at birth, ending at the Ketu antar
    assert (periods[0].md_lord, periods[0].ad_lord) == (PlanetName.MARS, PlanetName.MERCURY)
    assert abs(periods[0].end_date - _utc("1961-08-02T23:42")) < _DAY
    # And the active pratyantar at birth is Saturn
    state = find_active_vimshottari(periods, _BIRTH + timedelta(hours=1))
    assert state.pd_lord is PlanetName.SATURN
