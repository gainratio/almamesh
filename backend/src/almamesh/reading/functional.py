"""Functional nature by lagna lordship (Parashari), deterministic and stated.

The rule, in order (the first matching house set decides):

1. ``yogakaraka`` if the engine flags it;
2. the lagna lord and a trikona (5th, 9th) lord are ``benefic``;
3. a lord of 3/6/8/11 ruling no trikona is ``malefic``;
4. a lord of 2/7 ruling no trikona is ``maraka``;
5. otherwise ``neutral``.

The 12th lord: Laghu Parashari (Uḍu Dāya Pradīpa), Sañjñā-adhyāya, the verse
on the 2nd and 12th lords (also BPHS ch. 34, "Yogakarakas"): the lords of the
2nd and 12th are neutral by themselves and give the results of the OTHER house
they own, or of their association. So the 12th lordship is set aside and the
graha is classed by its other house: Saturn for Aquarius (1st + 12th) is
``benefic`` as the lagna lord, Saturn for Pisces (11th + 12th) ``malefic``,
Venus for Scorpio (7th + 12th) ``maraka``, and a sole 12th lord (the Moon for
Leo, the Sun for Virgo) ``neutral``. The 2nd lord keeps its maraka role from
rule 4 (the maraka houses are the 2nd and 7th). The 12th lordship itself is
never hidden: ``NatalLord.rules`` lists it and the obstacles theme cites it.
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
# Houses whose lordship takes the nature of the other house owned (Laghu Parashari).
_BY_OTHER_HOUSE: Final[frozenset[int]] = frozenset({12})


def functional_nature(rules: Iterable[int], *, is_yogakaraka: bool) -> FunctionalNature:
    """The functional nature of a graha that rules ``rules`` (houses from the lagna)."""
    if is_yogakaraka:
        return FunctionalNature.YOGAKARAKA
    ruled = frozenset(rules) - _BY_OTHER_HOUSE
    return next((nature for houses, nature in _ORDER if ruled & houses), FunctionalNature.NEUTRAL)


__all__ = ["functional_nature"]
