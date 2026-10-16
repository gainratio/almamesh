"""Technique #4 (`varga_lords`): dasha lords and slow transits tied to an area's varga.

Pre-registration: docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md,
amendment (g), part (g3). Career -> D10 house 10, relationships -> D9 house 7,
obstacles (disputes) -> D30 houses 6, 8 and 12, all counted whole-sign from that
varga's own lagna.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta, timezone

import pytest

from almamesh.calculations import SkyfieldAstronomy, calculate_sidereal_context
from almamesh.constants.astrology import PlanetName as P
from almamesh.domains.exact_signals import running_lords
from almamesh.domains.varga_signals import (
    VARGA_KEYS,
    VargaKey,
    VargaSignalSettings,
    monthly_varga_signals,
    varga_key,
    varga_score,
)
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.domains import LifeDomain
from almamesh.schemas.vargas import DivisionalChart as D
from almamesh.schemas.vargas import VargaContext
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude
from almamesh.vargas import compute_varga_context

# Indira Gandhi: 19 Nov 1917, 23:11 IST (+05:30), Allahabad 25.45N 81.85E, Rodden AA.
IST = timezone(timedelta(hours=5, minutes=30))
INDIRA_BORN = datetime(1917, 11, 19, 23, 11, tzinfo=IST)

# Sign indices, 0 = Aries .. 11 = Pisces.
ARIES, TAURUS, GEMINI, CANCER, LEO, VIRGO = 0, 1, 2, 3, 4, 5
LIBRA, SCORPIO, SAGITTARIUS, CAPRICORN, AQUARIUS, PISCES = 6, 7, 8, 9, 10, 11


@pytest.fixture(scope="module")
def astro() -> Iterator[SkyfieldAstronomy]:
    with SkyfieldAstronomy() as handle:
        yield handle


@pytest.fixture(scope="module")
def indira(astro: SkyfieldAstronomy) -> SiderealContext:
    return calculate_sidereal_context(
        INDIRA_BORN, 25.45, 81.85, reference_date=INDIRA_BORN, astronomy=astro
    )


@pytest.fixture(scope="module")
def vargas(indira: SiderealContext) -> VargaContext:
    return compute_varga_context(indira)


# Engine natal longitudes (Lahiri), matching the published Rasi chart: Cancer lagna.
#   lagna   117.4582 = Cancer   27.4582      jupiter  45.0067 = Taurus      15.0067 (R)
#   sun     214.1303 = Scorpio   4.1303      venus   261.0105 = Sagittarius 21.0105
#   moon    275.5965 = Capricorn 5.5965      saturn  111.7922 = Cancer      21.7922 (R)
#   mars    136.3800 = Leo      16.3800      rahu    250.5658 = Sagittarius 10.5658
#   mercury 223.2347 = Scorpio  13.2347      ketu     70.5658 = Gemini      10.5658
# BPHS odd/even: odd sign = Aries, Gemini, Leo, Libra, Sagittarius, Aquarius.


def test_should_pin_the_indira_natal_lagna_used_by_the_hand_derivation(
    indira: SiderealContext,
) -> None:
    # Given the engine chart / When read / Then it is the Cancer 27°27' the derivation uses
    assert indira.lagna.longitude == pytest.approx(117.4582, abs=1e-3)


def test_should_derive_the_indira_d10_career_key_by_hand(vargas: VargaContext) -> None:
    # D10 Dasamsa, 3° parts; odd sign counts from itself, even sign from its 9th (+8).
    #   lagna  Cancer(3) even, 27.46° -> part 9; start 3+8=11 Pisces; 11+9=20 -> Sagittarius
    #   sun    Scorpio(7) even, 4.13 -> part 1; start 3 Cancer; 3+1 = Leo
    #   moon   Capricorn(9) even, 5.60 -> part 1; start 5 Virgo; 5+1 = Libra
    #   mars   Leo(4) odd, 16.38 -> part 5; 4+5 = Capricorn
    #   mercury Scorpio(7) even, 13.23 -> part 4; 3+4 = Scorpio
    #   jupiter Taurus(1) even, 15.01 -> part 5; start 9; 9+5=14 -> Gemini
    #   venus  Sagittarius(8) odd, 21.01 -> part 7; 8+7=15 -> Cancer
    #   saturn Cancer(3) even, 21.79 -> part 7; start 11; 11+7=18 -> Libra
    #   rahu   Sagittarius(8) odd, 10.57 -> part 3; 8+3 = Pisces
    #   ketu   Gemini(2) odd, 10.57 -> part 3; 2+3 = Virgo
    # 10th from the D10 lagna Sagittarius(8): 8+9=17 -> Virgo(5); lord Mercury; Ketu there.
    # Given the engine's D10 / When keyed on house 10 / Then
    key = varga_key(vargas.charts[D.D10], frozenset({10}))
    assert key == VargaKey(signs=frozenset({VIRGO}), significators=frozenset({P.MERCURY, P.KETU}))


def test_should_derive_the_indira_d9_relationships_key_by_hand(vargas: VargaContext) -> None:
    # D9 Navamsa, 3°20' parts: absolute navamsa = floor(longitude * 9 / 30) mod 12.
    #   lagna 117.4582*0.3=35.24 -> 35%12=11 Pisces   (Cancer 27°27' is past 26°40')
    #   sun 64.24->4 Leo; moon 82.68->10 Aquarius; mars 40.91->4 Leo; mercury 66.97->6 Libra
    #   jupiter 13.50->1 Taurus; venus 78.30->6 Libra; saturn 33.54->9 Capricorn
    #   rahu 75.17->3 Cancer; ketu 21.17->9 Capricorn
    # Published navamsa: Venus (Libra) and Saturn (Capricorn) in own navamsa and Jupiter
    # vargottama in Taurus all match the engine. One published reading puts the Moon in the
    # navamsa lagna (Aquarius), which needs the lagna below Cancer 26°40'; at the Rodden AA
    # time the engine's 27°27' gives Pisces, which is what BPHS arithmetic yields above.
    # 7th from Pisces(11): 11+6=17 -> Virgo(5); lord Mercury; no graha placed in Virgo.
    # Given the engine's D9 / When keyed on house 7 / Then
    key = varga_key(vargas.charts[D.D9], frozenset({7}))
    assert key == VargaKey(signs=frozenset({VIRGO}), significators=frozenset({P.MERCURY}))


def test_should_derive_the_indira_d30_obstacles_key_by_hand(vargas: VargaContext) -> None:
    # D30 Trimsamsa, unequal parts. Odd: 0-5 Aries, 5-10 Aquarius, 10-18 Sagittarius,
    # 18-25 Gemini, 25-30 Libra. Even: 0-5 Taurus, 5-12 Virgo, 12-20 Pisces, 20-25
    # Capricorn, 25-30 Scorpio.
    #   lagna Cancer even 27.46 -> Scorpio(7)
    #   sun Scorpio even 4.13 -> Taurus; moon Capricorn even 5.60 -> Virgo
    #   mars Leo odd 16.38 -> Sagittarius; mercury Scorpio even 13.23 -> Pisces
    #   jupiter Taurus even 15.01 -> Pisces; venus Sagittarius odd 21.01 -> Gemini
    #   saturn Cancer even 21.79 -> Capricorn; rahu, ketu odd 10.57 -> Sagittarius
    # From Scorpio(7): 6th 7+5=12 -> Aries(0, Mars), 8th 7+7=14 -> Gemini(2, Mercury),
    # 12th 7+11=18 -> Libra(6, Venus). Venus occupies Gemini (already a lord).
    # Given the engine's D30 / When keyed on houses 6, 8, 12 / Then
    key = varga_key(vargas.charts[D.D30], frozenset({6, 8, 12}))
    assert key == VargaKey(
        signs=frozenset({ARIES, GEMINI, LIBRA}),
        significators=frozenset({P.MARS, P.MERCURY, P.VENUS}),
    )


def test_should_pin_the_pre_registered_varga_and_key_houses() -> None:
    # Given the (g3) pre-registration / When read / Then each area maps to its literal key
    assert VARGA_KEYS[LifeDomain.CAREER] == (D.D10, frozenset({10}))
    assert VARGA_KEYS[LifeDomain.RELATIONSHIPS] == (D.D9, frozenset({7}))
    assert VARGA_KEYS[LifeDomain.OBSTACLES] == (D.D30, frozenset({6, 8, 12}))
    assert set(VARGA_KEYS) == {
        LifeDomain.CAREER,
        LifeDomain.RELATIONSHIPS,
        LifeDomain.OBSTACLES,
    }


KEY = VargaKey(signs=frozenset({VIRGO}), significators=frozenset({P.MERCURY, P.KETU}))
AWAY = {P.JUPITER: ARIES, P.SATURN: ARIES, P.MARS: ARIES, P.RAHU: ARIES}


def test_should_score_zero_when_neither_dasha_nor_transit_touches_the_key() -> None:
    assert varga_score(KEY, frozenset({P.SUN, P.MOON}), AWAY) == 0.0


def test_should_score_half_when_only_a_running_lord_is_a_significator() -> None:
    assert varga_score(KEY, frozenset({P.SUN, P.KETU}), AWAY) == 0.5


def test_should_score_half_when_only_jupiter_transits_a_key_sign() -> None:
    assert varga_score(KEY, frozenset({P.SUN}), {**AWAY, P.JUPITER: VIRGO}) == 0.5


def test_should_score_half_when_only_saturn_transits_a_key_sign() -> None:
    assert varga_score(KEY, frozenset({P.SUN}), {**AWAY, P.SATURN: VIRGO}) == 0.5


def test_should_score_one_when_dasha_and_transit_both_touch_the_key() -> None:
    signs = {**AWAY, P.JUPITER: VIRGO, P.SATURN: VIRGO}
    assert varga_score(KEY, frozenset({P.MERCURY}), signs) == 1.0


def test_should_ignore_mars_and_rahu_transiting_a_key_sign() -> None:
    signs = {**AWAY, P.MARS: VIRGO, P.RAHU: VIRGO}
    assert varga_score(KEY, frozenset({P.SUN}), signs) == 0.0


def test_should_count_every_d30_key_house(vargas: VargaContext) -> None:
    # Given the three-house D30 key / When Saturn sits in each key sign in turn / Then 0.5
    key = varga_key(vargas.charts[D.D30], frozenset({6, 8, 12}))
    scores = [varga_score(key, frozenset(), {**AWAY, P.SATURN: s}) for s in sorted(key.signs)]
    assert len(key.signs) == 3
    assert scores == [0.5, 0.5, 0.5]


def test_should_return_nothing_when_the_flag_is_off(
    indira: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    assert VargaSignalSettings().enabled is False
    assert monthly_varga_signals(indira, astro, [(1966, 1)], VargaSignalSettings()) == {}


MONTHS = [(1966, 1), (1966, 2), (1977, 3), (1980, 1)]


def test_should_score_the_three_areas_per_month_on_a_real_chart(
    indira: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    # Given Indira Gandhi's chart and four months / When the flag is on
    rows = monthly_varga_signals(indira, astro, MONTHS, VargaSignalSettings(enabled=True))
    # Then exactly the three varga areas, one score per month, each 0, 0.5 or 1
    assert set(rows) == {LifeDomain.CAREER, LifeDomain.RELATIONSHIPS, LifeDomain.OBSTACLES}
    assert all(len(row) == len(MONTHS) for row in rows.values())
    assert {v for row in rows.values() for v in row} <= {0.0, 0.5, 1.0}


# Engine facts for five months: (maha, antar) lords running in the month, and the
# sidereal sign of Jupiter and Saturn on the 15th at 12:00 UTC.
MONTH_FACTS = {
    (1966, 1): ({P.JUPITER, P.SUN}, TAURUS, AQUARIUS),  # became prime minister on the 24th
    (1975, 6): ({P.SATURN, P.MERCURY}, PISCES, GEMINI),  # Allahabad verdict, Emergency
    (1977, 3): ({P.SATURN, P.KETU}, TAURUS, CANCER),  # lost the general election
    (1980, 1): ({P.SATURN, P.VENUS}, LEO, VIRGO),  # returned to power
    (1984, 10): ({P.SATURN, P.RAHU}, SAGITTARIUS, LIBRA),  # assassinated on the 31st
}


def test_should_pin_the_month_facts_the_score_table_uses(
    indira: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    for (year, month), (lords, jupiter, saturn) in MONTH_FACTS.items():
        start = datetime(year, month, 1, tzinfo=UTC)
        end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC)
        noon = datetime(year, month, 15, 12, tzinfo=UTC)
        assert running_lords(indira, start, end) == frozenset(g.value for g in lords)
        assert sign_index(transit_longitude(astro, P.JUPITER, noon)) == jupiter
        assert sign_index(transit_longitude(astro, P.SATURN, noon)) == saturn


def test_should_score_each_area_from_its_own_varga_key(
    indira: SiderealContext, astro: SkyfieldAstronomy
) -> None:
    # Given the hand keys: career {Virgo; Mercury, Ketu}, relationships {Virgo; Mercury},
    # obstacles {Aries, Gemini, Libra; Mars, Mercury, Venus}, and MONTH_FACTS:
    #   1966-01 Jupiter/Sun, J Taurus S Aquarius: nothing touches any key       -> 0, 0, 0
    #   1975-06 Saturn/Mercury, S Gemini: Mercury everywhere, Saturn on obstacles -> .5, .5, 1
    #   1977-03 Saturn/Ketu, S Cancer: Ketu is a D10 career occupant only        -> .5, 0, 0
    #   1980-01 Saturn/Venus, S Virgo: Saturn on D10 10th and D9 7th, Venus a D30 lord
    #                                                                           -> .5, .5, .5
    #   1984-10 Saturn/Rahu, S Libra: Saturn on the D30 12th only                -> 0, 0, .5
    # When scored month by month
    rows = monthly_varga_signals(indira, astro, list(MONTH_FACTS), VargaSignalSettings(True))
    # Then
    assert rows == {
        LifeDomain.CAREER: (0.0, 0.5, 0.5, 0.5, 0.0),
        LifeDomain.RELATIONSHIPS: (0.0, 0.5, 0.0, 0.5, 0.0),
        LifeDomain.OBSTACLES: (0.0, 1.0, 0.0, 0.5, 0.5),
    }
