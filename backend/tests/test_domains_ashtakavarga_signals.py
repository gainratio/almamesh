"""Ashtakavarga-gated transit signals per life area and month (technique #3, behind a flag).

Pre-registration: docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md,
amendment (g), part (g2).

Fixture chart: Indira Gandhi, 19 Nov 1917, 23:11 IST (+05:30), Allahabad 25.45N 81.85E
(Rodden AA). Her Lahiri rasi chart is widely published (e.g. AstroSage, Future Point):
Cancer lagna with Saturn; Mars in Leo; Sun and Mercury in Scorpio; Venus (21°) and Rahu
(10°33') in Sagittarius; Moon (5°35') in Capricorn; Jupiter in Taurus; Ketu in Gemini.
``test_should_place_the_grahas_as_the_published_chart`` checks the engine agrees.

Sign indices used below (0 = Aries .. 11 = Pisces): Sun 7, Moon 9, Mars 4, Mercury 7,
Jupiter 1, Venus 8, Saturn 3, Lagna 3.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName as P
from almamesh.domains.ashtakavarga_signals import (
    BAV_DASHA_MOVERS,
    BAV_FAVOURABLE,
    SAV_SUPPORTIVE,
    SLOW_BAV_MOVERS,
    AshtakavargaTransitSettings,
    BinduTable,
    ashtakavarga_score,
    monthly_ashtakavarga_signals,
    mover_strength,
    transit_movers,
)
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.domains import LifeDomain
from almamesh.strength.ashtakavarga import compute_ashtakavarga
from almamesh.transits.natal import sign_index

IST = timezone(timedelta(hours=5, minutes=30))
BORN = datetime(1917, 11, 19, 23, 11, tzinfo=IST)
ARIES, TAURUS, GEMINI, CANCER, LEO, VIRGO = 0, 1, 2, 3, 4, 5
LIBRA, SCORPIO, SAGITTARIUS, CAPRICORN = 6, 7, 8, 9
SEVEN = (P.SUN, P.MOON, P.MARS, P.MERCURY, P.JUPITER, P.VENUS, P.SATURN)
ON_ANY = frozenset({0.0, 0.5, 1.0})


@pytest.fixture(scope="module")
def astro() -> Iterator[SkyfieldAstronomy]:
    with SkyfieldAstronomy() as handle:
        yield handle


@pytest.fixture(scope="module")
def natal(astro: SkyfieldAstronomy) -> SiderealContext:
    return calculate_sidereal_context(BORN, 25.45, 81.85, reference_date=BORN, astronomy=astro)


@pytest.fixture(scope="module")
def table(natal: SiderealContext) -> BinduTable:
    return BinduTable.from_context(compute_ashtakavarga(natal))


def _flat(sav: int = 0, bav: int = 0) -> BinduTable:
    return BinduTable(sav=(sav,) * 12, bav={g: (bav,) * 12 for g in SEVEN})


def _one_sign(sign: int, sav: int, bav: int) -> BinduTable:
    sav_row = tuple(sav if i == sign else 0 for i in range(12))
    bav_row = tuple(bav if i == sign else 0 for i in range(12))
    return BinduTable(sav=sav_row, bav={g: bav_row for g in SEVEN})


# --- 1. The published chart, bindus derived by hand -----------------------------------


PUBLISHED_SIGNS = {
    P.SUN: SCORPIO,
    P.MOON: CAPRICORN,
    P.MARS: LEO,
    P.MERCURY: SCORPIO,
    P.JUPITER: TAURUS,
    P.VENUS: SAGITTARIUS,
    P.SATURN: CANCER,
}


def test_should_place_the_grahas_as_the_published_chart(natal: SiderealContext) -> None:
    # Given the published Lahiri chart's signs (PUBLISHED_SIGNS)
    # When the engine places them
    placed = {g: sign_index(natal.planets[g].longitude) for g in PUBLISHED_SIGNS}
    # Then the engine agrees, lagna included
    assert placed == PUBLISHED_SIGNS
    assert sign_index(natal.lagna.longitude) == CANCER


# Hand derivation from the BPHS Ashtakavarga benefic-place tables (BPHS ch. 66; the same
# lists in B.V. Raman, "Ashtakavarga System of Prediction"). For each subject, a contributor
# gives a bindu when the target sign's offset from it (1 = its own sign) is a benefic place.
#
# Offsets of LEO (4) from each contributor:
#   Sun 10, Moon 8, Mars 1, Mercury 10, Jupiter 4, Venus 9, Saturn 2, Lagna 2.
# Offsets of SCORPIO (7) from each contributor:
#   Sun 1, Moon 11, Mars 4, Mercury 1, Jupiter 7, Venus 12, Saturn 5, Lagna 5.
#
# LEO, contributor: benefic places -> offset -> bindu?
# Sun BAV     Su{1,2,4,7,8,9,10,11}10 y  Mo{3,6,10,11}8 n  Ma{1,2,4,7,8,9,10,11}1 y
#             Me{3,5,6,9,10,11,12}10 y  Ju{5,6,9,11}4 n  Ve{6,7,12}9 n
#             Sa{1,2,4,7,8,9,10,11}2 y  La{3,4,6,10,11,12}2 n                     = 4
# Moon BAV    Su{3,6,7,8,10,11}10 y  Mo{1,3,6,7,10,11}8 n  Ma{2,3,5,6,9,10,11}1 n
#             Me{1,3,4,5,7,8,10,11}10 y  Ju{1,4,7,8,10,11,12}4 y  Ve{3,4,5,7,9,10,11}9 y
#             Sa{3,5,6,11}2 n  La{3,6,10,11}2 n                                   = 4
# Mars BAV    Su{3,5,6,10,11}10 y  Mo{3,6,11}8 n  Ma{1,2,4,7,8,10,11}1 y  Me{3,5,6,11}10 n
#             Ju{6,10,11,12}4 n  Ve{6,8,11,12}9 n  Sa{1,4,7,8,9,10,11}2 n
#             La{1,3,6,10,11}2 n                                                  = 2
# Mercury BAV Su{5,6,9,11,12}10 n  Mo{2,4,6,8,10,11}8 y  Ma{1,2,4,7,8,9,10,11}1 y
#             Me{1,3,5,6,9,10,11,12}10 y  Ju{6,8,11,12}4 n  Ve{1,2,3,4,5,8,9,11}9 y
#             Sa{1,2,4,7,8,9,10,11}2 y  La{1,2,4,6,8,10,11}2 y                    = 6
# Jupiter BAV Su{1,2,3,4,7,8,9,10,11}10 y  Mo{2,5,7,9,11}8 n  Ma{1,2,4,7,8,10,11}1 y
#             Me{1,2,4,5,6,9,10,11}10 y  Ju{1,2,3,4,7,8,10,11}4 y  Ve{2,5,6,9,10,11}9 y
#             Sa{3,5,6,12}2 n  La{1,2,4,5,6,7,9,10,11}2 y                         = 6
# Venus BAV   Su{8,11,12}10 n  Mo{1,2,3,4,5,8,9,11,12}8 y  Ma{3,5,6,9,11,12}1 n
#             Me{3,5,6,9,11}10 n  Ju{5,8,9,10,11}4 n  Ve{1,2,3,4,5,8,9,10,11}9 y
#             Sa{3,4,5,8,9,10,11}2 n  La{1,2,3,4,5,8,9,11}2 y                     = 3
# Saturn BAV  Su{1,2,4,7,8,10,11}10 y  Mo{3,6,11}8 n  Ma{3,5,6,10,11,12}1 n
#             Me{6,8,9,10,11,12}10 y  Ju{5,6,11,12}4 n  Ve{6,11,12}9 n  Sa{3,5,6,11}2 n
#             La{1,3,4,6,10,11}2 n                                                = 2
# SAV LEO = 4 + 4 + 2 + 6 + 6 + 3 + 2 = 27   (one below the 28 threshold)
#
# SCORPIO
# Sun BAV     Su 1 y  Mo 11 y  Ma 4 y  Me 1 n  Ju 7 n  Ve 12 y  Sa 5 n  La 5 n   = 4
# Moon BAV    Su 1 n  Mo 11 y  Ma 4 n  Me 1 y  Ju 7 y  Ve 12 n  Sa 5 y  La 5 n   = 4
# Mars BAV    Su 1 n  Mo 11 y  Ma 4 y  Me 1 n  Ju 7 n  Ve 12 y  Sa 5 n  La 5 n   = 3
# Mercury BAV Su 1 n  Mo 11 y  Ma 4 y  Me 1 y  Ju 7 n  Ve 12 n  Sa 5 n  La 5 n   = 3
# Jupiter BAV Su 1 y  Mo 11 y  Ma 4 y  Me 1 y  Ju 7 y  Ve 12 n  Sa 5 y  La 5 y   = 7
# Venus BAV   Su 1 n  Mo 11 y  Ma 4 n  Me 1 n  Ju 7 n  Ve 12 n  Sa 5 y  La 5 y   = 3
# Saturn BAV  Su 1 y  Mo 11 y  Ma 4 n  Me 1 n  Ju 7 n  Ve 12 y  Sa 5 y  La 5 n   = 4
#   (each y/n read against the same benefic-place sets listed for LEO above)
# SAV SCORPIO = 4 + 4 + 3 + 3 + 7 + 3 + 4 = 28   (exactly on the 28 threshold)
HAND_BAV: dict[tuple[P, int], int] = {
    (P.SUN, LEO): 4,
    (P.MOON, LEO): 4,
    (P.MARS, LEO): 2,
    (P.MERCURY, LEO): 6,
    (P.JUPITER, LEO): 6,
    (P.VENUS, LEO): 3,
    (P.SATURN, LEO): 2,
    (P.SUN, SCORPIO): 4,
    (P.MOON, SCORPIO): 4,
    (P.MARS, SCORPIO): 3,
    (P.MERCURY, SCORPIO): 3,
    (P.JUPITER, SCORPIO): 7,
    (P.VENUS, SCORPIO): 3,
    (P.SATURN, SCORPIO): 4,
}


def test_should_match_hand_derived_bav_cells(table: BinduTable) -> None:
    # Given cells derived by hand above (4 = on the BAV threshold, 3 = one below)
    # When read from the engine's table
    engine = {(g, s): table.bav[g][s] for g, s in HAND_BAV}
    # Then they agree
    assert engine == HAND_BAV


def test_should_match_hand_derived_sav_on_each_side_of_28(table: BinduTable) -> None:
    assert (table.sav[SCORPIO], table.sav[LEO]) == (28, 27)


# Saturn BAV in ARIES (0), used by the March 1971 month below. Offsets of ARIES:
#   Sun 6, Moon 4, Mars 9, Mercury 6, Jupiter 12, Venus 5, Saturn 10, Lagna 10.
# Saturn BAV  Su{1,2,4,7,8,10,11}6 n  Mo{3,6,11}4 n  Ma{3,5,6,10,11,12}9 n
#             Me{6,8,9,10,11,12}6 y  Ju{5,6,11,12}12 y  Ve{6,11,12}5 n  Sa{3,5,6,11}10 n
#             La{1,3,4,6,10,11}10 y                                               = 3
def test_should_match_hand_derived_saturn_bav_in_aries(table: BinduTable) -> None:
    assert table.bav[P.SATURN][ARIES] == 3


def test_should_carry_twelve_signs_for_sav_and_every_graha(table: BinduTable) -> None:
    assert len(table.sav) == 12
    assert set(table.bav) == set(SEVEN)
    assert all(len(row) == 12 for row in table.bav.values())
    assert sum(table.sav) == 337


# --- 2. The pre-registered literals ----------------------------------------------------


def test_should_pin_the_pre_registered_thresholds() -> None:
    # Amendment (g2): SAV >= 28 (337 / 12) and BAV >= 4 (4 of 8).
    assert (SAV_SUPPORTIVE, BAV_FAVOURABLE) == (28, 4)


def test_should_pin_the_pre_registered_mover_sets() -> None:
    assert frozenset({P.JUPITER, P.SATURN}) == SLOW_BAV_MOVERS
    assert frozenset({P.SUN, P.MARS, P.MERCURY, P.JUPITER, P.VENUS, P.SATURN}) == (BAV_DASHA_MOVERS)


# --- 3. mover_strength -----------------------------------------------------------------


def test_should_score_half_when_sav_is_exactly_28() -> None:
    assert mover_strength(_one_sign(ARIES, sav=28, bav=0), P.JUPITER, ARIES) == 0.5


def test_should_score_zero_when_sav_is_27_and_bav_is_3() -> None:
    assert mover_strength(_one_sign(ARIES, sav=27, bav=3), P.JUPITER, ARIES) == 0.0


def test_should_score_half_when_own_bav_is_exactly_4() -> None:
    assert mover_strength(_one_sign(ARIES, sav=0, bav=4), P.SATURN, ARIES) == 0.5


def test_should_score_one_when_sav_and_own_bav_both_clear() -> None:
    assert mover_strength(_one_sign(TAURUS, sav=28, bav=4), P.SUN, TAURUS) == 1.0


def test_should_read_the_movers_own_bav_not_another_grahas() -> None:
    # Given Jupiter strong in Aries and Saturn weak there
    bav = {g: (0,) * 12 for g in SEVEN} | {P.JUPITER: (5,) + (0,) * 11}
    strong_jupiter = BinduTable(sav=(0,) * 12, bav=bav)
    # Then only Jupiter's own BAV counts
    assert mover_strength(strong_jupiter, P.JUPITER, ARIES) == 0.5
    assert mover_strength(strong_jupiter, P.SATURN, ARIES) == 0.0


def test_should_read_the_published_chart_on_each_side_of_both_thresholds(
    table: BinduTable,
) -> None:
    # Scorpio: SAV 28, Saturn 4, Venus 3. Leo: SAV 27, Mercury 6, Mars 2.
    assert mover_strength(table, P.SATURN, SCORPIO) == 1.0
    assert mover_strength(table, P.VENUS, SCORPIO) == 0.5
    assert mover_strength(table, P.MERCURY, LEO) == 0.5
    assert mover_strength(table, P.MARS, LEO) == 0.0


# --- 4. transit_movers ------------------------------------------------------------------


def test_should_always_move_jupiter_and_saturn() -> None:
    assert transit_movers(frozenset()) == frozenset({P.JUPITER, P.SATURN})


def test_should_add_a_running_lord_that_has_a_bav() -> None:
    assert transit_movers(frozenset({P.VENUS, P.MERCURY})) == frozenset(
        {P.JUPITER, P.SATURN, P.VENUS, P.MERCURY}
    )


def test_should_exclude_a_running_moon() -> None:
    assert P.MOON not in transit_movers(frozenset({P.MOON, P.SUN}))


def test_should_exclude_running_nodes() -> None:
    assert transit_movers(frozenset({P.RAHU, P.KETU})) == frozenset({P.JUPITER, P.SATURN})


# --- 5. ashtakavarga_score --------------------------------------------------------------


def _is_aries_or_taurus(sign: int) -> bool:
    return sign in {ARIES, TAURUS}


def test_should_take_the_max_not_the_mean_or_sum() -> None:
    # Given Jupiter on a 1.0 sign and Saturn on a 0.5 sign, both on target
    bav = {g: (0,) * 12 for g in SEVEN} | {P.JUPITER: (4,) + (0,) * 11}
    table = BinduTable(sav=(28, 28) + (0,) * 10, bav=bav)
    signs = {P.JUPITER: ARIES, P.SATURN: TAURUS}
    # When scored
    score = ashtakavarga_score(table, signs, SLOW_BAV_MOVERS, _is_aries_or_taurus)
    # Then the strongest counts
    assert score == 1.0


def test_should_ignore_a_strong_mover_off_target() -> None:
    signs = {P.JUPITER: GEMINI, P.SATURN: ARIES}
    score = ashtakavarga_score(
        _one_sign(GEMINI, 40, 8), signs, SLOW_BAV_MOVERS, _is_aries_or_taurus
    )
    assert score == 0.0


def test_should_score_zero_when_no_mover_is_on_target() -> None:
    signs = {P.JUPITER: VIRGO, P.SATURN: LIBRA}
    assert ashtakavarga_score(_flat(40, 8), signs, SLOW_BAV_MOVERS, _is_aries_or_taurus) == 0.0


def test_should_ignore_a_strong_sign_held_by_a_non_mover() -> None:
    signs = {P.JUPITER: VIRGO, P.SATURN: LIBRA, P.VENUS: ARIES}
    assert ashtakavarga_score(_flat(40, 8), signs, SLOW_BAV_MOVERS, _is_aries_or_taurus) == 0.0


# --- 6. monthly_ashtakavarga_signals ----------------------------------------------------

MONTHS = ((1966, 1), (1971, 3), (1977, 3))


def test_should_return_nothing_when_the_flag_is_off(
    natal: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    off = AshtakavargaTransitSettings()
    assert monthly_ashtakavarga_signals(natal, astro, MONTHS, off) == {}


def test_should_score_every_domain_every_month_when_on(
    natal: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    on = AshtakavargaTransitSettings(enabled=True)
    signals = monthly_ashtakavarga_signals(natal, astro, MONTHS, on)
    assert set(signals) == set(LifeDomain)
    assert all(len(row) == len(MONTHS) for row in signals.values())
    assert {v for row in signals.values() for v in row} <= ON_ANY


# March 1971 (the 1971 general-election landslide), derived by hand:
#   Running maha and antar lord: Saturn, so the movers are Jupiter and Saturn only.
#   15 Mar 1971 12:00 UTC: Jupiter in Scorpio (7), Saturn in Aries (0).
#   Jupiter in Scorpio is house 5 from the Cancer lagna and 11 from the Capricorn Moon;
#   Saturn in Aries is house 10 from the lagna and 4 from the Moon.
#   Jupiter/Scorpio strength = 0.5 (SAV 28) + 0.5 (Jupiter BAV 7) = 1.0.
#   Saturn/Aries strength = 0.5 (SAV Aries >= 28 either way: 32 in the engine, 33 per BPHS)
#                         + 0 (Saturn BAV Aries 3)                    = 0.5.
#   career {10}: Saturn only -> 0.5.  finances {2,11}: Jupiter -> 1.0.
#   relationships {7}: none -> 0.  education {4,5}: max(Saturn 0.5, Jupiter 1.0) -> 1.0.
#   obstacles {6,8,12}: none -> 0.
MARCH_1971 = {
    LifeDomain.CAREER: 0.5,
    LifeDomain.FINANCES: 1.0,
    LifeDomain.RELATIONSHIPS: 0.0,
    LifeDomain.EDUCATION: 1.0,
    LifeDomain.OBSTACLES: 0.0,
}


def test_should_match_the_hand_derived_march_1971_month(
    natal: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    on = AshtakavargaTransitSettings(enabled=True)
    signals = monthly_ashtakavarga_signals(natal, astro, ((1971, 3),), on)
    assert {d: signals[d][0] for d in MARCH_1971} == MARCH_1971
