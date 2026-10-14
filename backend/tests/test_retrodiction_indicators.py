"""Indicator families scored on hand-built natal frames and month skies."""

from __future__ import annotations

from dataclasses import replace

import pytest

from almamesh.constants.astrology import PlanetName as P
from almamesh.retrodiction.indicators import (
    ENGINE_OBSTACLES,
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
    if name == ENGINE_OBSTACLES.name:
        return ENGINE_OBSTACLES.score(FRAME, sky, target)
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


DISPUTES = Target(houses=frozenset({6, 8, 12}), karakas=frozenset({P.SATURN, P.RAHU, P.MARS}))
HEALTH = Target(houses=frozenset({1, 6, 8}), karakas=frozenset({P.SUN}))


def _contacts(*pairs: tuple[P, str], maha: P = P.MOON) -> MonthSky:
    sky = _sky({maha}, {P.MOON}, {P.MOON})
    return MonthSky(sky.running, sky.yogini_lord, sky.signs, contacts=frozenset(pairs))


def test_should_score_half_when_a_slow_mover_touches_a_target_significator() -> None:
    # Sun occupies the 10th (career): Saturn on the natal Sun, Sun not a running lord
    assert _score("exact_transits", _contacts((P.SATURN, "sun"))) == 0.5


def test_should_score_one_when_the_touched_significator_is_the_running_maha_lord() -> None:
    assert _score("exact_transits", _contacts((P.SATURN, "sun"), maha=P.SUN)) == 1.0


def test_should_score_zero_when_the_touched_point_does_not_signify_the_target() -> None:
    assert _score("exact_transits", _contacts((P.JUPITER, "venus"))) == 0.0


def test_should_count_mars_only_for_a_target_with_mars_as_karaka() -> None:
    sky = _contacts((P.MARS, "saturn"))  # Saturn rules the 10th; Saturn is a disputes karaka
    assert _score("exact_transits", sky, CAREER) == 0.0
    assert _score("exact_transits", sky, DISPUTES) == 0.5


def test_should_count_the_lagna_when_the_first_house_is_a_target() -> None:
    sky = _contacts((P.RAHU, "lagna"))
    assert _score("exact_transits", sky, HEALTH) == 0.5
    assert _score("exact_transits", sky, CAREER) == 0.0


def test_engine_obstacles_reads_the_engine_activation_for_the_disputes_target() -> None:
    sky = replace(_sky({P.MOON}, {P.MOON}, {P.MOON}), obstacles=lambda: 0.75)
    assert _score("engine_obstacles", sky, DISPUTES) == 0.75


def test_engine_obstacles_is_silent_and_lazy_for_any_other_target() -> None:
    def boom() -> float:
        raise AssertionError("the engine must not run for a non-disputes target")

    sky = replace(_sky({P.MOON}, {P.MOON}, {P.MOON}), obstacles=boom)
    assert _score("engine_obstacles", sky, CAREER) == 0.0
