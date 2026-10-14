"""The frozen category mapping and its pre-registration digest."""

from __future__ import annotations

from almamesh.constants.astrology import PlanetName as P
from almamesh.retrodiction.events import EventCategory
from almamesh.retrodiction.mapping import MAPPING, preregistration_digest

# Pinned in docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md. Changing the
# mapping, the families, the window or k turns this red: amend the spec, then the literal.
PREREGISTERED_DIGEST = "2ae6e16dddc429e888dfb6f3e95f2b1c4adc807f02db5d41ac816e6714d441de"


def test_every_category_has_a_target() -> None:
    assert set(MAPPING) == set(EventCategory)


def test_legal_and_accident_use_the_disputes_target() -> None:
    for category in (EventCategory.LEGAL, EventCategory.ACCIDENT):
        target = MAPPING[category].target
        assert target.houses == frozenset({6, 8, 12})
        assert target.karakas == frozenset({P.SATURN, P.RAHU, P.MARS})


def test_career_categories_point_at_the_tenth() -> None:
    for category in (EventCategory.CAREER_CHANGE, EventCategory.JOB_START, EventCategory.JOB_LOSS):
        assert 10 in MAPPING[category].target.houses
        assert MAPPING[category].area == "career"


def test_the_preregistered_digest_is_pinned() -> None:
    assert preregistration_digest() == PREREGISTERED_DIGEST


def test_a_different_window_is_not_the_preregistered_run() -> None:
    assert preregistration_digest(window=24) != PREREGISTERED_DIGEST
