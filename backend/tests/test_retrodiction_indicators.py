"""Indicator families scored on hand-built natal frames and month skies."""

from __future__ import annotations

from dataclasses import replace

import pytest

from almamesh.constants.astrology import PlanetName as P
from almamesh.domains.ashtakavarga_signals import BAV_DASHA_MOVERS, BinduTable
from almamesh.domains.varga_signals import VargaKey
from almamesh.retrodiction import indicators as indicators_module
from almamesh.retrodiction.indicators import (
    ENGINE_OBSTACLES,
    FAMILIES,
    SHIPPED_FAMILIES,
    SKY_GRAHAS,
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
QUIET_SIGNS = {
    P.JUPITER: 1,
    P.SATURN: 1,
    P.MARS: 1,
    P.RAHU: 1,
    P.KETU: 7,
    P.SUN: 1,
    P.MERCURY: 1,
    P.VENUS: 1,
}


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


# --- Technique #3, ashtakavarga_transits (amendment g2) --------------------------------
# CAREER's 10th is Capricorn (9) from the Aries lagna and Aries (0) from the Cancer Moon.
CAPRICORN, ARIES, TAURUS = 9, 0, 1
_SEVEN = (P.SUN, P.MOON, P.MARS, P.MERCURY, P.JUPITER, P.VENUS, P.SATURN)


def _row(**by_sign: int) -> tuple[int, ...]:
    """A 12-sign row: zero except the named sign indices (``s9=30``)."""
    return tuple(by_sign.get(f"s{i}", 0) for i in range(12))


BINDUS = BinduTable(
    sav=_row(s9=30, s0=27, s1=40),
    bav={g: _row() for g in _SEVEN}
    | {P.JUPITER: _row(s9=5, s1=8), P.SATURN: _row(s9=2), P.SUN: _row(s0=4)},
)
AV_FRAME = replace(FRAME, bindus=BINDUS)


def _av(sky: MonthSky, target: Target = CAREER) -> float:
    return family_scores(AV_FRAME, sky, target)["ashtakavarga_transits"]


def test_should_score_one_when_jupiter_is_on_target_with_sav_and_own_bav_strong() -> None:
    assert _av(_sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=CAPRICORN)) == 1.0


def test_should_score_half_when_only_the_sav_clears_28() -> None:
    assert _av(_sky({P.MOON}, {P.MOON}, {P.MOON}, saturn=CAPRICORN)) == 0.5


def test_should_score_zero_when_on_target_but_sav_27_and_bav_below_4() -> None:
    assert _av(_sky({P.MOON}, {P.MOON}, {P.MOON}, saturn=ARIES)) == 0.0


def test_should_score_zero_when_strong_bindus_sit_off_target() -> None:
    # Taurus holds SAV 40 and Jupiter BAV 8, but it is the 2nd/11th, not the 10th
    assert _av(_sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=TAURUS)) == 0.0


def test_should_take_the_strongest_on_target_mover() -> None:
    sky = _sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=CAPRICORN, saturn=ARIES)
    assert _av(sky) == 1.0


def test_should_count_a_running_maha_or_antar_lord_as_a_mover() -> None:
    # The Sun on Aries (BAV 4) counts only while it runs as maha or antar lord
    assert _av(_sky({P.SUN}, {P.MOON}, {P.MOON}, sun=ARIES)) == 0.5
    assert _av(_sky({P.MOON}, {P.SUN}, {P.MOON}, sun=ARIES)) == 0.5
    assert _av(_sky({P.MOON}, {P.MOON}, {P.SUN}, sun=ARIES)) == 0.0


def test_should_score_zero_for_a_frame_without_bindus() -> None:
    assert (
        family_scores(FRAME, _sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=CAPRICORN), CAREER)[
            "ashtakavarga_transits"
        ]
        == 0.0
    )


def test_should_delegate_the_ashtakavarga_rule_to_the_engine_seam(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given the seam replaced by a recorder
    seen: list[tuple[frozenset[P], bool, bool]] = []

    def recorder(table, signs, movers, on_target) -> float:  # noqa: ANN001
        seen.append((movers, on_target(CAPRICORN), on_target(TAURUS)))
        return 0.25

    monkeypatch.setattr(indicators_module, "ashtakavarga_score", recorder)
    # When
    score = _av(_sky({P.VENUS}, {P.MARS}, {P.SUN}))
    # Then the family returns the seam's value, with the seam's movers and target test
    assert score == 0.25
    assert seen == [(frozenset({P.JUPITER, P.SATURN, P.VENUS, P.MARS}), True, False)]


def test_should_read_every_bav_mover_in_the_month_sky() -> None:
    assert BAV_DASHA_MOVERS <= set(SKY_GRAHAS)


# --- Technique #4, varga_lords (amendment g3) -----------------------------------------
LEO = 4
# CAREER's varga key: its D10 10th is Leo, ruled by the Sun, with Venus placed there.
VARGA_FRAME = replace(
    FRAME,
    varga_keys={
        CAREER: VargaKey(signs=frozenset({LEO}), significators=frozenset({P.SUN, P.VENUS}))
    },
)


def _vl(sky: MonthSky, target: Target = CAREER) -> float:
    return family_scores(VARGA_FRAME, sky, target)["varga_lords"]


def test_should_score_half_when_the_running_maha_lord_is_a_varga_significator() -> None:
    assert _vl(_sky({P.VENUS}, {P.MOON}, {P.MOON})) == 0.5


def test_should_score_half_when_the_running_antar_lord_is_a_varga_significator() -> None:
    assert _vl(_sky({P.MOON}, {P.SUN}, {P.MOON})) == 0.5


def test_should_not_count_a_pratyantar_lord_as_running() -> None:
    assert _vl(_sky({P.MOON}, {P.MOON}, {P.SUN})) == 0.0


def test_should_score_half_when_jupiter_or_saturn_transits_a_varga_key_sign() -> None:
    assert _vl(_sky({P.MOON}, {P.MOON}, {P.MOON}, jupiter=LEO)) == 0.5
    assert _vl(_sky({P.MOON}, {P.MOON}, {P.MOON}, saturn=LEO)) == 0.5
    assert _vl(_sky({P.MOON}, {P.MOON}, {P.MOON}, mars=LEO)) == 0.0


def test_should_score_one_when_the_dasha_and_the_transit_both_hold() -> None:
    assert _vl(_sky({P.VENUS}, {P.MOON}, {P.MOON}, saturn=LEO)) == 1.0


def test_should_score_zero_for_a_target_with_no_varga() -> None:
    assert _vl(_sky({P.VENUS}, {P.SUN}, {P.MOON}, jupiter=LEO), HEALTH) == 0.0


def test_should_delegate_the_varga_rule_to_the_engine_seam(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given the seam replaced by a recorder
    seen: list[tuple[VargaKey, frozenset[P], int]] = []

    def recorder(key, running, signs) -> float:  # noqa: ANN001
        seen.append((key, running, signs[P.JUPITER]))
        return 0.25

    monkeypatch.setattr(indicators_module, "varga_score", recorder)
    # When
    score = _vl(_sky({P.VENUS}, {P.MARS}, {P.SUN}, jupiter=LEO))
    # Then the family returns the seam's value for the target's key and the maha/antar lords
    assert score == 0.25
    assert seen == [(VARGA_FRAME.varga_keys[CAREER], frozenset({P.VENUS, P.MARS}), LEO)]


def test_should_append_the_two_new_families_after_exact_transits() -> None:
    names = [f.name for f in FAMILIES]
    assert names[-3:] == ["exact_transits", "ashtakavarga_transits", "varga_lords"]
