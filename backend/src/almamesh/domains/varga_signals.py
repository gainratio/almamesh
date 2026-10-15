"""Varga-lord signals per life area and month (technique #4, `varga_lords`), behind a flag.

Each scored area reads its own divisional chart (career D10 house 10, relationships D9
house 7, obstacles D30 houses 6, 8 and 12), counting houses whole-sign from that varga's
lagna. The key-house signs' lords and every graha placed in a key-house sign are the
area's varga significators. A month scores 0.5 when a running Vimshottari maha or antar
lord is a significator, plus 0.5 when transiting Jupiter or Saturn (sign on the 15th,
12:00 UTC) sits in a key-house sign. Pre-registered in the retrodiction-eval spec,
amendment (g3); every constant is classical and fixed there.

``VargaSignalSettings.enabled`` defaults off: the shipped reading does not use this
family until it passes the promotion rule on HELD-OUT data (learning-loop spec §2).
The retrodiction harness scores the same rule as the ``varga_lords`` family.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import SIGN_LORDS, ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.domains.exact_signals import YearMonth, running_lords
from almamesh.schemas.domains import LifeDomain
from almamesh.schemas.vargas import DivisionalChart
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude
from almamesh.vargas import compute_varga_context

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.vargas import VargaChart

VARGA_KEYS: Final[Mapping[LifeDomain, tuple[DivisionalChart, frozenset[int]]]] = MappingProxyType(
    {
        LifeDomain.CAREER: (DivisionalChart.D10, frozenset({10})),
        LifeDomain.RELATIONSHIPS: (DivisionalChart.D9, frozenset({7})),
        LifeDomain.OBSTACLES: (DivisionalChart.D30, frozenset({6, 8, 12})),
    }
)
TRANSIT_MOVERS: Final[tuple[PlanetName, ...]] = (PlanetName.JUPITER, PlanetName.SATURN)
_HALF: Final[float] = 0.5
_MID_DAY: Final[int] = 15
_MID_HOUR: Final[int] = 12


@dataclass(frozen=True)
class VargaKey:
    """An area's key-house signs (0 = Aries) and its varga significators."""

    signs: frozenset[int]
    significators: frozenset[PlanetName]


@dataclass(frozen=True)
class VargaSignalSettings:
    """Off by default; the varga and key houses are the pre-registered constants."""

    enabled: bool = False


def _index(sign: str) -> int:
    return ZODIAC_SIGNS.index(sign)


def varga_key(chart: VargaChart, houses: frozenset[int]) -> VargaKey:
    """Key-house signs counted whole-sign from the varga lagna, their lords and occupants."""
    lagna = _index(chart.lagna_sign)
    signs = frozenset((lagna + house - 1) % 12 for house in houses)
    lords = frozenset(SIGN_LORDS[ZodiacSign(ZODIAC_SIGNS[s])] for s in signs)
    occupants = frozenset(
        PlanetName(graha) for graha, p in chart.placements.items() if _index(p.sign) in signs
    )
    return VargaKey(signs=signs, significators=lords | occupants)


def varga_score(
    key: VargaKey, running: frozenset[PlanetName], signs: Mapping[PlanetName, int]
) -> float:
    """0.5 for a running lord among the significators, plus 0.5 for Jupiter/Saturn on a key sign."""
    transit = any(signs[graha] in key.signs for graha in TRANSIT_MOVERS)
    return _HALF * bool(running & key.significators) + _HALF * transit


def _area_keys(natal: SiderealContext) -> dict[LifeDomain, VargaKey]:
    charts = compute_varga_context(natal).charts
    return {d: varga_key(charts[chart], houses) for d, (chart, houses) in VARGA_KEYS.items()}


def _month_running(natal: SiderealContext, ym: YearMonth) -> frozenset[PlanetName]:
    year, month = ym
    start = datetime(year, month, 1, tzinfo=UTC)
    end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC)
    return frozenset(PlanetName(lord) for lord in running_lords(natal, start, end))


def _mid_month_signs(astro: SkyfieldAstronomy, ym: YearMonth) -> dict[PlanetName, int]:
    noon = datetime(ym[0], ym[1], _MID_DAY, _MID_HOUR, tzinfo=UTC)
    return {g: sign_index(transit_longitude(astro, g, noon)) for g in TRANSIT_MOVERS}


def _month_scores(
    natal: SiderealContext,
    astro: SkyfieldAstronomy,
    keys: Mapping[LifeDomain, VargaKey],
    ym: YearMonth,
) -> dict[LifeDomain, float]:
    running, signs = _month_running(natal, ym), _mid_month_signs(astro, ym)
    return {domain: varga_score(key, running, signs) for domain, key in keys.items()}


def monthly_varga_signals(
    natal: SiderealContext,
    astro: SkyfieldAstronomy,
    months: Sequence[YearMonth],
    settings: VargaSignalSettings,
) -> dict[LifeDomain, tuple[float, ...]]:
    """Each varga area's score per month; empty when the flag is off."""
    if not settings.enabled:
        return {}
    keys = _area_keys(natal)
    rows = [_month_scores(natal, astro, keys, ym) for ym in months]
    return {domain: tuple(row[domain] for row in rows) for domain in VARGA_KEYS}


__all__ = [
    "TRANSIT_MOVERS",
    "VARGA_KEYS",
    "VargaKey",
    "VargaSignalSettings",
    "monthly_varga_signals",
    "varga_key",
    "varga_score",
]
