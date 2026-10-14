"""Indicator families scored on hand-built natal frames and month skies."""

from __future__ import annotations

import pytest

from almamesh.constants.astrology import PlanetName as P
from almamesh.retrodiction.indicators import (
    FAMILIES,
    SHIPPED_FAMILIES,
    MonthSky,
    NatalFrame,
    Target,
    family_scores,
)

# Lagna Aries (0), Moon Cancer (3). Saturn rules 10/11, Sun rules 5, Venus 2/7, Mars 1/8.
FRAME = NatalFrame(
    lagna_idx=0,
    moon_idx=3,
    rulers={
        P.SATURN: frozenset({10, 11}),
        P.SUN: frozenset({5}),
        P.VENUS: frozenset({2, 7}),
        P.MARS: frozenset({1, 8}),
        P.MERCURY: frozenset({3, 6}),
        P.MOON: frozenset({4}),
        P.JUPITER: frozenset({9, 12}),
        P.RAHU: frozenset(),
        P.KETU: frozenset(),
    },
    occupied={
        P.SATURN: 7,
        P.SUN: 10,
        P.VENUS: 1,
        P.MARS: 6,
        P.MERCURY: 10,
        P.MOON: 4,
        P.JUPITER: 9,
        P.RAHU: 3,
        P.KETU: 9,
    },
)
CAREER = Target(houses=frozenset({10}), karakas=frozenset())
QUIET_SIGNS = {P.JUPITER: 1, P.SATURN: 1, P.MARS: 1, P.RAHU: 1, P.KETU: 7}


def _sky(*running: set[P], yogini: P | None = None, **signs: int) -> MonthSky:
    merged = QUIET_SIGNS | {P(name): idx for name, idx in signs.items()}
    return MonthSky(running=tuple(frozenset(r) for r in running), yogini_lord=yogini, signs=merged)


def _score(name: str, sky: MonthSky, target: Target = CAREER) -> float:
    return family_scores(FRAME, sky, target)[name]


def test_vimshottari_lords_counts_levels_whose_lord_rules_a_target_house() -> None:
    sky = _sky({P.SATURN}, {P.VENUS}, {P.MOON})
    assert _score("vimshottari_lords", sky) == pytest.approx(1 / 3)


def test_vimshottari_lords_counts_a_karaka() -> None:
    target = Target(houses=frozenset({10}), karakas=frozenset({P.VENUS}))
    sky = _sky({P.SATURN}, {P.VENUS}, {P.MOON})
    assert _score("vimshottari_lords", sky, target) == pytest.approx(2 / 3)


def test_vimshottari_lords_counts_any_lord_running_in_the_month_at_a_level() -> None:
    sky = _sky({P.MOON}, {P.MOON}, {P.MOON, P.SATURN})  # pratyantar changes mid-month
    assert _score("vimshottari_lords", sky) == pytest.approx(1 / 3)


def test_vimshottari_occupants_counts_levels_whose_lord_sits_in_a_target_house() -> None:
    sky = _sky({P.SUN}, {P.MERCURY}, {P.MOON})  # Sun and Mercury sit in the 10th
    assert _score("vimshottari_occupants", sky) == pytest.approx(2 / 3)


def test_yogini_scores_when_its_lord_signifies() -> None:
    assert _score("yogini", _sky({P.MOON}, {P.MOON}, {P.MOON}, yogini=P.SATURN)) == 1.0
    assert _score("yogini", _sky({P.MOON}, {P.MOON}, {P.MOON}, yogini=P.VENUS)) == 0.0
    assert _score("yogini", _sky({P.MOON}, {P.MOON}, {P.MOON})) == 0.0


def test_jupiter_saturn_transit_reads_houses_from_lagna_or_moon() -> None:
    # Capricorn (9) is the 10th from an Aries lagna; Aries (0) is the 10th from a Cancer Moon.
    both = _sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=9, saturn=0)
    one = _sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=9)
    assert _score("transit_jupiter_saturn", both) == 1.0
    assert _score("transit_jupiter_saturn", one) == pytest.approx(0.5)


def test_mars_transit_scores_a_target_house() -> None:
    assert _score("transit_mars", _sky({P.MOON}, {P.MOON}, {P.MOON}, mars=9)) == 1.0
    assert _score("transit_mars", _sky({P.MOON}, {P.MOON}, {P.MOON})) == 0.0


def test_node_transit_scores_each_node() -> None:
    # Rahu in Capricorn = 10th from the lagna; Ketu opposite in Cancer = 4th from the lagna.
    sky = _sky({P.MOON}, {P.MOON}, {P.MOON}, rahu=9, ketu=3)
    assert _score("transit_nodes", sky) == pytest.approx(0.5)
    both = Target(houses=frozenset({10, 4}), karakas=frozenset())
    assert _score("transit_nodes", sky, both) == 1.0


def test_double_transit_needs_both_jupiter_and_saturn_on_a_target_house() -> None:
    # 10th from Aries lagna = Capricorn (9). Jupiter in Taurus (1) aspects Capricorn by its 9th;
    # Saturn in Cancer (3) aspects it by its 7th.
    hit = _sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=1, saturn=3)
    miss = _sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=1, saturn=4)
    assert _score("double_transit", hit) == 1.0
    assert _score("double_transit", miss) == 0.0


def test_a_quiet_month_scores_zero_everywhere() -> None:
    scores = family_scores(FRAME, _sky({P.MOON}, {P.MOON}, {P.MOON}), CAREER)
    assert set(scores) == {f.name for f in FAMILIES}
    assert all(value == 0.0 for value in scores.values())


def test_shipped_families_are_the_four_the_themes_use() -> None:
    assert SHIPPED_FAMILIES == frozenset(
        {"vimshottari_lords", "yogini", "transit_jupiter_saturn", "double_transit"}
    )
