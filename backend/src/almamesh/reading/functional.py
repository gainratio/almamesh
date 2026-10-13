"""Functional nature by lagna lordship (BPHS), deterministic and stated.

``yogakaraka`` if the engine flags it; the lagna lord and a trikona (5th, 9th)
lord are ``benefic``; a lord of 3/6/8/11 ruling no trikona is ``malefic``; a
lord of 2/7 ruling no trikona is ``maraka``; otherwise ``neutral``. The order
of the checks IS the rule: the first matching house set decides.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from almamesh.schemas.reading import FunctionalNature

if TYPE_CHECKING:
    from collections.abc import Iterable

_ORDER: Final[tuple[tuple[frozenset[int], FunctionalNature], ...]] = (
    (frozenset({1, 5, 9}), FunctionalNature.BENEFIC),
    (frozenset({3, 6, 8, 11}), FunctionalNature.MALEFIC),
    (frozenset({2, 7}), FunctionalNature.MARAKA),
)


def functional_nature(rules: Iterable[int], *, is_yogakaraka: bool) -> FunctionalNature:
    """The functional nature of a graha that rules ``rules`` (houses from the lagna)."""
    if is_yogakaraka:
        return FunctionalNature.YOGAKARAKA
    ruled = frozenset(rules)
    return next((nature for houses, nature in _ORDER if ruled & houses), FunctionalNature.NEUTRAL)


__all__ = ["functional_nature"]
