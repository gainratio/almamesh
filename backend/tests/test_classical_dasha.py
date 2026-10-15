"""Classical dasha rules (spec 2026-10-15-classical-dasha-rules.md), each on hand-checked facts.

Reference chart: Princess Diana, 1961-07-01 18:45 UT, Sandringham (Rodden AA), as in
``test_dasha_birth_balance.py``. Scorpio lagna. PyJHora 4.8.7 (Lahiri, oracle only) and
swisseph agree with the engine on her placements: Sun Gemini (8th), Moon Aquarius (4th), Mars
Leo (10th), Mercury Gemini (8th, combust, retrograde), Jupiter Capricorn (3rd, debilitated,
retrograde), Venus Taurus (7th, own), Saturn Capricorn (3rd, own, retrograde), Rahu Leo,
Ketu Aquarius. Her Shadbala meets the BPHS minimum for all seven grahas (engine).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName, ZodiacSign
from almamesh.dasha.depth import active_chain, level_spans
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.significators import significator_grahas
from almamesh.reading.classical import (
    AGREEMENT_THRESHOLD,
    ChartLords,
    area_of,
    dasha_tone,
    relation_from,
    sign_dignity,
    strength_band,
    vimshottari_score,
    yogini_score,
)
from almamesh.schemas.domains import LifeDomain
from almamesh.schemas.reading import LordStrength, Relation, SignDignity
from almamesh.strength import compute_strength_context

_BIRTH = datetime(1961, 7, 1, 18, 45, tzinfo=UTC)
_LAT, _LON = 52.8311, 0.5054
P = PlanetName


@pytest.fixture(scope="module")
def lords() -> ChartLords:
    natal = calculate_sidereal_context(_BIRTH, _LAT, _LON, reference_date=_BIRTH)
    strength = compute_strength_context(natal, _BIRTH, _LAT, _LON, civil_offset=timedelta(hours=1))
    return ChartLords(natal, strength.shadbala)


def _day(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


# --- R2: a sub-lord counted from its parent lord ---------------------------------------


@pytest.mark.parametrize(
    ("child", "house", "relation"),
    [
        # Diana's Jupiter maha (Capricorn, idx 9), each antar lord's natal sign
        (9, 1, Relation.SUPPORT),  # Saturn, Capricorn: same sign (kendra)
        (1, 5, Relation.SUPPORT),  # Venus, Taurus: trikona
        (2, 6, Relation.FRICTION),  # Mercury/Sun, Gemini
        (4, 8, Relation.FRICTION),  # Mars/Rahu, Leo
        (10, 2, Relation.NEUTRAL),  # Moon/Ketu, Aquarius
        (8, 12, Relation.FRICTION),  # a Sagittarius lord
        (0, 4, Relation.SUPPORT),  # an Aries lord: kendra
        (7, 11, Relation.SUPPORT),  # a Scorpio lord: 11th (BPHS 53.61, Phaladeepika XX.29)
        (11, 3, Relation.NEUTRAL),  # a Pisces lord
    ],
)
def test_relation_counts_whole_signs_from_the_parent(
    child: int, house: int, relation: Relation
) -> None:
    assert relation_from(9, child) == (house, relation)


# --- R3: sign dignity and strength ------------------------------------------------------


@pytest.mark.parametrize(
    ("graha", "sign", "expected"),
    [
        (P.MARS, ZodiacSign.LEO, SignDignity.FRIEND),  # Diana; PyJHora code 3 (friend)
        (P.JUPITER, ZodiacSign.CAPRICORN, SignDignity.DEBILITATED),  # Diana; PyJHora 0
        (P.MERCURY, ZodiacSign.GEMINI, SignDignity.OWN),  # Diana; PyJHora 5
        (P.SUN, ZodiacSign.GEMINI, SignDignity.NEUTRAL),  # Diana; PyJHora 2
        (P.MOON, ZodiacSign.AQUARIUS, SignDignity.NEUTRAL),  # Diana; PyJHora 2
        (P.SATURN, ZodiacSign.LEO, SignDignity.ENEMY),  # the Sun is Saturn's enemy (BPHS 3)
        (P.VENUS, ZodiacSign.CANCER, SignDignity.ENEMY),  # the Moon is Venus's enemy
        (P.SATURN, ZodiacSign.LIBRA, SignDignity.EXALTED),
        (P.RAHU, ZodiacSign.LEO, SignDignity.NEUTRAL),  # nodes: no agreed dignity
    ],
)
def test_sign_dignity_uses_exaltation_then_natural_friendship(
    graha: PlanetName, sign: ZodiacSign, expected: SignDignity
) -> None:
    assert sign_dignity(graha, sign) is expected


@pytest.mark.parametrize(
    ("dignity", "combust", "retro", "meets", "expected"),
    [
        (SignDignity.OWN, True, True, True, LordStrength.WEAK),  # combust = debilitated (PD XX.30)
        (SignDignity.DEBILITATED, False, True, True, LordStrength.STRONG),  # retro (PD XX.14)
        (SignDignity.DEBILITATED, False, False, True, LordStrength.WEAK),
        (SignDignity.EXALTED, False, False, False, LordStrength.STRONG),
        (SignDignity.OWN, False, False, None, LordStrength.STRONG),
        (SignDignity.FRIEND, False, False, True, LordStrength.STRONG),
        (SignDignity.FRIEND, False, False, False, LordStrength.ORDINARY),
        (SignDignity.ENEMY, False, False, False, LordStrength.WEAK),
        (SignDignity.ENEMY, False, False, True, LordStrength.ORDINARY),
        (SignDignity.NEUTRAL, False, False, True, LordStrength.ORDINARY),
        (SignDignity.NEUTRAL, False, False, None, LordStrength.ORDINARY),  # a node
    ],
)
def test_strength_band(
    dignity: SignDignity, combust: bool, retro: bool, meets: bool | None, expected: LordStrength
) -> None:
    assert strength_band(dignity, combust=combust, retro=retro, meets_minimum=meets) is expected


def test_diana_lord_strengths(lords: ChartLords) -> None:
    # Then each graha's band follows from its hand-checked natal facts
    assert {g: lords.strength(g) for g in P} == {
        P.SUN: LordStrength.ORDINARY,  # neutral sign
        P.MOON: LordStrength.ORDINARY,  # neutral sign
        P.MARS: LordStrength.STRONG,  # friend's sign, Shadbala 6.24 >= 5.0
        P.MERCURY: LordStrength.WEAK,  # combust
        P.JUPITER: LordStrength.STRONG,  # debilitated but retrograde
        P.VENUS: LordStrength.STRONG,  # own sign
        P.SATURN: LordStrength.STRONG,  # own sign
        P.RAHU: LordStrength.ORDINARY,
        P.KETU: LordStrength.ORDINARY,
    }


# --- R1: relevance (lordship, occupancy, karaka) ----------------------------------------


def test_career_relevance_counts_occupants_and_halves_karakas(lords: ChartLords) -> None:
    # Given career = the 10th (Leo) with karakas Sun, Saturn, Mercury
    career = area_of(DOMAIN_RECIPES[LifeDomain.CAREER])
    # Then the 10th lord and its occupants are full, karakas only half
    assert {g: lords.relevance(g, career) for g in P} == {
        P.SUN: 1.0,  # rules Leo
        P.MARS: 1.0,  # sits in Leo
        P.RAHU: 1.0,  # sits in Leo
        P.SATURN: 0.5,  # karaka only
        P.MERCURY: 0.5,  # karaka only
        P.MOON: 0.0,
        P.JUPITER: 0.0,
        P.VENUS: 0.0,
        P.KETU: 0.0,
    }


def test_activation_only_area_counts_no_karakas(lords: ChartLords) -> None:
    # Given obstacles (6/8/12, activation only): Saturn is its karaka but rules 3/4, sits 3rd
    obstacles = area_of(DOMAIN_RECIPES[LifeDomain.OBSTACLES])
    assert lords.relevance(P.SATURN, obstacles) == 0.0
    assert lords.relevance(P.MARS, obstacles) == 1.0  # rules Aries, the 6th


# --- R7: graded score, threshold, tone ---------------------------------------------------


def test_month_score_is_level_and_strength_weighted(lords: ChartLords) -> None:
    # Given March 1985: Jupiter maha / Saturn antar / Venus pratyantar all month
    start, end = _day("1985-03-01"), _day("1985-04-01")
    rel = area_of(DOMAIN_RECIPES[LifeDomain.RELATIONSHIPS])
    career = area_of(DOMAIN_RECIPES[LifeDomain.CAREER])
    # Then relationships = (3 x 0.5 [Jupiter karaka] + 1 x 1 [Venus 7th lord]) / 6 = 42
    assert vimshottari_score(lords, rel, start, end) == 42
    # And career = 2 x 0.5 [Saturn karaka] / 6 = 17: the old any-lord rule fired here
    assert vimshottari_score(lords, career, start, end) == 17


def test_month_score_is_time_weighted_across_a_pratyantar_change(lords: ChartLords) -> None:
    # Given February 1985: Ketu pratyantar until 1985-02-19 11:48 UT, then Venus
    start, end = _day("1985-02-01"), _day("1985-03-01")
    rel = area_of(DOMAIN_RECIPES[LifeDomain.RELATIONSHIPS])
    # Then Venus counts for 9.508 / 28 of the month: (1.5 + 0.3396) / 6 = 31
    assert vimshottari_score(lords, rel, start, end) == 31


def test_strong_maha_lord_tied_to_the_area_fires(lords: ChartLords) -> None:
    # Given 1961-07-02: Mars maha / Mercury antar / Saturn pratyantar (PyJHora order)
    start, end = _day("1961-07-02"), _day("1961-07-03")
    health = area_of(DOMAIN_RECIPES[LifeDomain.HEALTH])
    # Then health = (3 x 1 x 1 [Mars rules 1/6, strong] + 2 x 1 x 0.5 [Mercury in 8th, weak]) / 6
    assert vimshottari_score(lords, health, start, end) == 67


def test_tone_reads_nature_strength_and_placement(lords: ChartLords) -> None:
    start, end = _day("1961-07-02"), _day("1961-07-03")
    health = area_of(DOMAIN_RECIPES[LifeDomain.HEALTH])
    # Mars maha: benefic (+1, lagna lord) + strong (+1) = +2; Mercury antar: malefic (-1)
    # + weak (-1) + 11th from Mars (+1) = -1 -> mixed
    assert dasha_tone(lords, health, start, end) == "mixed"
    # March 1985 relationships: Jupiter maha benefic +1, strong +1 = +2; Venus pratyantar
    # maraka -1, strong +1, 5th from Saturn +1 = +1 -> supportive
    rel = area_of(DOMAIN_RECIPES[LifeDomain.RELATIONSHIPS])
    assert dasha_tone(lords, rel, _day("1985-03-01"), _day("1985-04-01")) == "supportive"


def test_no_relevant_lord_means_no_tone(lords: ChartLords) -> None:
    # Given obstacles (6th Aries, 8th Gemini, 12th Libra; no counted karakas)
    obstacles = area_of(DOMAIN_RECIPES[LifeDomain.OBSTACLES])
    # In March 1985 Venus (pratyantar) rules the 12th: 1 x 1 / 6 = 17, with a tone
    assert vimshottari_score(lords, obstacles, _day("1985-03-01"), _day("1985-04-01")) == 17
    assert dasha_tone(lords, obstacles, _day("1985-03-01"), _day("1985-04-01")) is not None
    # On 1985-01-01 (Jupiter / Saturn / Ketu, Ketu in the 4th) no running lord is tied to it
    assert vimshottari_score(lords, obstacles, _day("1985-01-01"), _day("1985-01-02")) == 0
    assert dasha_tone(lords, obstacles, _day("1985-01-01"), _day("1985-01-02")) is None


def test_yogini_score_weights_maha_over_antar(lords: ChartLords) -> None:
    # Given 1961-07-02: Pingala (Sun) maha, Siddha (Venus) antar (test_yogini_antar.py)
    start, end = _day("1961-07-02"), _day("1961-07-03")
    health = area_of(DOMAIN_RECIPES[LifeDomain.HEALTH])
    rel = area_of(DOMAIN_RECIPES[LifeDomain.RELATIONSHIPS])
    # Then health = 2 x 1 [Sun in 8th] x 0.75 [ordinary] / 3 = 50, relationships = 1 x 1 / 3 = 33
    assert yogini_score(lords, health, start, end) == 50
    assert yogini_score(lords, rel, start, end) == 33


# --- R6: sookshma (level 4) against PyJHora ----------------------------------------------


@pytest.mark.parametrize(
    ("chain", "start"),
    [
        # PyJHora 4.8.7 sookshma rows (Lahiri), local +1 converted to UT
        ((P.JUPITER, P.SATURN, P.KETU, P.RAHU), "1985-01-19T01:50"),
        ((P.JUPITER, P.SATURN, P.KETU, P.SATURN), "1985-02-03T08:52"),
        ((P.JUPITER, P.SATURN, P.VENUS, P.VENUS), "1985-02-19T13:30"),
        ((P.JUPITER, P.SATURN, P.VENUS, P.MOON), "1985-03-24T23:27"),
        ((P.JUPITER, P.SATURN, P.VENUS, P.RAHU), "1985-04-15T19:47"),
    ],
)
def test_sookshma_matches_pyjhora(
    lords: ChartLords, chain: tuple[PlanetName, ...], start: str
) -> None:
    # When the active chain is read a few hours after the PyJHora start
    pyjhora = _day(start)
    found = active_chain(lords.natal.dashas.maha_dasha_sequence, pyjhora + timedelta(hours=3))
    # Then the four lords match and the sookshma starts within 3 h (365.25 vs 365.2564-day year)
    assert tuple(p.lord for p in found) == chain
    assert abs(found[3].start_date - pyjhora) < timedelta(hours=3)


# --- R7 against saturation ----------------------------------------------------------------


def _months(first_year: int) -> list[tuple[datetime, datetime]]:
    starts = [datetime(first_year + i // 12, i % 12 + 1, 1, tzinfo=UTC) for i in range(74)]
    return list(zip(starts, starts[1:], strict=False))


def _firing_shares(lords: ChartLords, first_year: int) -> tuple[float, float]:
    """(old any-significator rule, new graded rule): share of area-months that fire."""
    old = new = total = 0
    for recipe in DOMAIN_RECIPES.values():
        grahas, area = significator_grahas(lords.natal, recipe), area_of(recipe)
        for start, end in _months(first_year):
            spans = level_spans(lords.natal.dashas.maha_dasha_sequence, start, end)
            old += any(p.lord in grahas for level in spans.values() for p in level)
            new += vimshottari_score(lords, area, start, end) >= AGREEMENT_THRESHOLD
            total += 1
    return old / total, new / total


def test_graded_rule_fires_far_less_often_than_any_significator(lords: ChartLords) -> None:
    # Given Diana's 73 months from 1980 across all eight areas (584 area-months)
    old, new = _firing_shares(lords, 1980)
    # Then the old rule fires in 82% of them and the graded rule in 36% (measured 2026-10-15)
    assert old == pytest.approx(0.82, abs=0.01)
    assert new == pytest.approx(0.36, abs=0.01)
