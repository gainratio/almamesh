"""The frozen category -> target mapping and the pre-registration digest.

Classical Parashari significations (BPHS bhava karakatva). The table is a hypothesis
under test, not a fact: a null result may mean the mapping is wrong. Changing it, the
families, the window or k changes ``preregistration_digest`` and needs a dated
amendment in docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Final

from almamesh.constants.astrology import PlanetName as P
from almamesh.retrodiction.events import EventCategory as C
from almamesh.retrodiction.indicators import FAMILIES, Target

PREREGISTERED_WINDOW: Final[int] = 36
PREREGISTERED_KS: Final[tuple[int, ...]] = (3, 6)


@dataclass(frozen=True)
class CategoryTarget:
    """A category's target and the engine life area it corresponds to (or ``none``)."""

    target: Target
    area: str


def _t(houses: tuple[int, ...], karakas: tuple[P, ...], area: str) -> CategoryTarget:
    return CategoryTarget(Target(frozenset(houses), frozenset(karakas)), area)


# Disputes (6th enemies/litigation, 8th sudden events, 12th losses/confinement) with the
# natural malefics; the engine has no such area yet, so this is the before baseline.
_DISPUTES: Final[CategoryTarget] = _t((6, 8, 12), (P.SATURN, P.RAHU, P.MARS), "disputes (pending)")

MAPPING: Final[dict[C, CategoryTarget]] = {
    C.CAREER_CHANGE: _t((10,), (P.SUN, P.SATURN, P.MERCURY), "career"),
    C.JOB_START: _t((10, 6, 11), (P.SUN, P.SATURN, P.MERCURY), "career"),
    C.JOB_LOSS: _t((10, 8, 12), (P.SATURN, P.RAHU), "career"),
    C.LEGAL: _DISPUTES,
    C.RELATIONSHIP_START: _t((7, 5), (P.VENUS,), "relationships"),
    C.MARRIAGE: _t((7, 2, 11), (P.VENUS, P.JUPITER), "relationships"),
    C.SEPARATION: _t((7, 6, 8, 12), (P.VENUS, P.SATURN, P.RAHU), "relationships"),
    C.RELOCATION: _t((4, 12, 3, 9), (P.MOON, P.RAHU), "none"),
    C.HEALTH: _t((1, 6, 8), (P.SUN,), "health"),
    C.ACCIDENT: _DISPUTES,
    C.BIRTH_OF_CHILD: _t((5, 9), (P.JUPITER,), "family"),
    C.DEATH_IN_FAMILY: _t((2, 7, 8, 12), (P.SATURN,), "family"),
    C.FINANCIAL_GAIN: _t((2, 11), (P.JUPITER,), "finances"),
    C.FINANCIAL_LOSS: _t((12, 8), (P.SATURN, P.RAHU), "finances"),
    C.EDUCATION: _t((4, 5, 9), (P.MERCURY, P.JUPITER), "education"),
}


def _canonical(window: int, ks: tuple[int, ...]) -> str:
    """The pre-registered choices as canonical JSON."""
    table = {
        c.value: {
            "houses": sorted(m.target.houses),
            "karakas": sorted(k.value for k in m.target.karakas),
            "area": m.area,
        }
        for c, m in sorted(MAPPING.items())
    }
    families = [f.name for f in FAMILIES]
    return json.dumps(
        {"mapping": table, "families": families, "window": window, "ks": list(ks)}, sort_keys=True
    )


def preregistration_digest(
    window: int = PREREGISTERED_WINDOW, ks: tuple[int, ...] = PREREGISTERED_KS
) -> str:
    """SHA-256 of the mapping, families, window and k."""
    return hashlib.sha256(_canonical(window, ks).encode()).hexdigest()


__all__ = [
    "MAPPING",
    "PREREGISTERED_KS",
    "PREREGISTERED_WINDOW",
    "CategoryTarget",
    "preregistration_digest",
]
