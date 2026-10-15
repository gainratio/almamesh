"""Canonical Parashari Bhinnashtakavarga benefic-place tables (BPHS).

For each SUBJECT planet, and each CONTRIBUTOR (the 7 grahas + the Lagna), the
listed house numbers (1 = the contributor's own sign) are the places in which the
subject earns one bindu, counted forward (whole-sign) from the contributor.

These tables are the authority. Their per-subject row sums are chart-invariants —
Sun 48, Moon 49, Mars 39, Mercury 54, Jupiter 56, Venus 52, Saturn 39 — and the
SAV grand total is always 337. ``tests/test_ashtakavarga_bindu.py`` pins those.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

from almamesh.constants.astrology import PlanetName

# The Lagna is a contributor but not a subject; we key it with a sentinel.
LAGNA_CONTRIBUTOR: Final[str] = "lagna"

BINDU_CONTRIBUTORS: Final[tuple[PlanetName | str, ...]] = (
    PlanetName.SUN,
    PlanetName.MOON,
    PlanetName.MARS,
    PlanetName.MERCURY,
    PlanetName.JUPITER,
    PlanetName.VENUS,
    PlanetName.SATURN,
    LAGNA_CONTRIBUTOR,
)

_RAW: Final[dict[PlanetName, dict[PlanetName | str, tuple[int, ...]]]] = {
    PlanetName.SUN: {
        PlanetName.SUN: (1, 2, 4, 7, 8, 9, 10, 11),
        PlanetName.MOON: (3, 6, 10, 11),
        PlanetName.MARS: (1, 2, 4, 7, 8, 9, 10, 11),
        PlanetName.MERCURY: (3, 5, 6, 9, 10, 11, 12),
        PlanetName.JUPITER: (5, 6, 9, 11),
        PlanetName.VENUS: (6, 7, 12),
        PlanetName.SATURN: (1, 2, 4, 7, 8, 9, 10, 11),
        LAGNA_CONTRIBUTOR: (3, 4, 6, 10, 11, 12),
    },
    PlanetName.MOON: {
        PlanetName.SUN: (3, 6, 7, 8, 10, 11),
        PlanetName.MOON: (1, 3, 6, 7, 10, 11),
        PlanetName.MARS: (2, 3, 5, 6, 9, 10, 11),
        PlanetName.MERCURY: (1, 3, 4, 5, 7, 8, 10, 11),
        PlanetName.JUPITER: (1, 4, 7, 8, 10, 11, 12),
        PlanetName.VENUS: (3, 4, 5, 7, 9, 10, 11),
        PlanetName.SATURN: (3, 5, 6, 11),
        LAGNA_CONTRIBUTOR: (3, 6, 10, 11),
    },
    PlanetName.MARS: {
        PlanetName.SUN: (3, 5, 6, 10, 11),
        PlanetName.MOON: (3, 6, 11),
        PlanetName.MARS: (1, 2, 4, 7, 8, 10, 11),
        PlanetName.MERCURY: (3, 5, 6, 11),
        PlanetName.JUPITER: (6, 10, 11, 12),
        PlanetName.VENUS: (6, 8, 11, 12),
        PlanetName.SATURN: (1, 4, 7, 8, 9, 10, 11),
        LAGNA_CONTRIBUTOR: (1, 3, 6, 10, 11),
    },
    PlanetName.MERCURY: {
        PlanetName.SUN: (5, 6, 9, 11, 12),
        PlanetName.MOON: (2, 4, 6, 8, 10, 11),
        PlanetName.MARS: (1, 2, 4, 7, 8, 9, 10, 11),
        PlanetName.MERCURY: (1, 3, 5, 6, 9, 10, 11, 12),
        PlanetName.JUPITER: (6, 8, 11, 12),
        PlanetName.VENUS: (1, 2, 3, 4, 5, 8, 9, 11),
        PlanetName.SATURN: (1, 2, 4, 7, 8, 9, 10, 11),
        LAGNA_CONTRIBUTOR: (1, 2, 4, 6, 8, 10, 11),
    },
    PlanetName.JUPITER: {
        PlanetName.SUN: (1, 2, 3, 4, 7, 8, 9, 10, 11),
        PlanetName.MOON: (2, 5, 7, 9, 11),
        PlanetName.MARS: (1, 2, 4, 7, 8, 10, 11),
        PlanetName.MERCURY: (1, 2, 4, 5, 6, 9, 10, 11),
        PlanetName.JUPITER: (1, 2, 3, 4, 7, 8, 10, 11),
        PlanetName.VENUS: (2, 5, 6, 9, 10, 11),
        PlanetName.SATURN: (3, 5, 6, 12),
        LAGNA_CONTRIBUTOR: (1, 2, 4, 5, 6, 7, 9, 10, 11),
    },
    PlanetName.VENUS: {
        PlanetName.SUN: (8, 11, 12),
        PlanetName.MOON: (1, 2, 3, 4, 5, 8, 9, 11, 12),
        PlanetName.MARS: (3, 5, 6, 9, 11, 12),
        PlanetName.MERCURY: (3, 5, 6, 9, 11),
        PlanetName.JUPITER: (5, 8, 9, 10, 11),
        PlanetName.VENUS: (1, 2, 3, 4, 5, 8, 9, 10, 11),
        PlanetName.SATURN: (3, 4, 5, 8, 9, 10, 11),
        LAGNA_CONTRIBUTOR: (1, 2, 3, 4, 5, 8, 9, 11),
    },
    PlanetName.SATURN: {
        PlanetName.SUN: (1, 2, 4, 7, 8, 10, 11),
        PlanetName.MOON: (3, 6, 11),
        PlanetName.MARS: (3, 5, 6, 10, 11, 12),
        PlanetName.MERCURY: (6, 8, 9, 10, 11, 12),
        PlanetName.JUPITER: (5, 6, 11, 12),
        PlanetName.VENUS: (6, 11, 12),
        PlanetName.SATURN: (3, 5, 6, 11),
        LAGNA_CONTRIBUTOR: (1, 3, 4, 6, 10, 11),
    },
}

# Frozen view so the authoritative tables cannot be mutated at runtime.
BINDU_TABLES: Final[MappingProxyType[PlanetName, dict[PlanetName | str, tuple[int, ...]]]] = (
    MappingProxyType(_RAW)
)
