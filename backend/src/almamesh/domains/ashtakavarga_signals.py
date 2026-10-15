"""Ashtakavarga-gated transit signals per life area and month (technique #3), behind a flag.

A month scores for a domain when a mover transits a sign that is a domain house counted
from the natal lagna or Moon, and that sign is strong in the natal Ashtakavarga: 0.5 if
the sign's SAV is at least 28, plus 0.5 if the mover's own BAV there is at least 4. The
month's score is the strongest on-target mover (so 0, 0.5 or 1). Movers are transiting
Jupiter and Saturn, plus any running Vimshottari maha or antar lord that has a BAV.

Pre-registered in docs/superpowers/specs/2026-10-14-retrodiction-eval-design.md,
amendment (g2). ``AshtakavargaTransitSettings.enabled`` defaults off: the shipped
reading does not use this family until it passes the promotion rule on HELD-OUT data.
The retrodiction harness scores the same rule as the ``ashtakavarga_transits`` family.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from functools import partial
from types import MappingProxyType
from typing import TYPE_CHECKING, Final, TypeAlias

from almamesh.constants.astrology import PlanetName, ZodiacSign
from almamesh.domains.exact_signals import running_lords
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.significators import domain_house_numbers
from almamesh.strength.ashtakavarga import compute_ashtakavarga
from almamesh.transits.natal import (
    natal_lagna_index,
    natal_moon_index,
    sign_index,
    whole_sign_house,
)
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence

    from almamesh.calculations import SkyfieldAstronomy
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.domains import LifeDomain
    from almamesh.schemas.strength import AshtakavargaContext

YearMonth: TypeAlias = tuple[int, int]

# Classical constants, fixed by amendment (g2): 28 is the SAV average (337 / 12) and 4 of
# 8 is the BAV midpoint.
SAV_SUPPORTIVE: Final[int] = 28
BAV_FAVOURABLE: Final[int] = 4
SLOW_BAV_MOVERS: Final[frozenset[PlanetName]] = frozenset({PlanetName.JUPITER, PlanetName.SATURN})
# No Moon (it crosses every sign in a month); no Rahu or Ketu (no Parashari BAV).
BAV_DASHA_MOVERS: Final[frozenset[PlanetName]] = frozenset(
    {
        PlanetName.SUN,
        PlanetName.MARS,
        PlanetName.MERCURY,
        PlanetName.JUPITER,
        PlanetName.VENUS,
        PlanetName.SATURN,
    }
)
_HALF: Final[float] = 0.5
_MID_DAY: Final[int] = 15
_MID_HOUR: Final[int] = 12


def _by_sign(bindus: Mapping[ZodiacSign, int]) -> tuple[int, ...]:
    """Bindus as a 12-tuple, sign index 0 = Aries .. 11 = Pisces."""
    return tuple(bindus[sign] for sign in ZodiacSign)


@dataclass(frozen=True)
class BinduTable:
    """Natal SAV and the seven grahas' BAV, each indexed by sign (0 = Aries)."""

    sav: tuple[int, ...]
    bav: Mapping[PlanetName, tuple[int, ...]]

    @classmethod
    def from_context(cls, ctx: AshtakavargaContext) -> BinduTable:
        """Read the engine's Ashtakavarga (``strength/ashtakavarga.py``) into sign tuples."""
        bav = {graha: _by_sign(chart.bindus) for graha, chart in ctx.bhinna.items()}
        return cls(sav=_by_sign(ctx.sarva.bindus), bav=MappingProxyType(bav))


@dataclass(frozen=True)
class AshtakavargaTransitSettings:
    """Off by default; the thresholds are the pre-registered constants above."""

    enabled: bool = False


def transit_movers(running: frozenset[PlanetName]) -> frozenset[PlanetName]:
    """Jupiter and Saturn, plus every running maha or antar lord that has a BAV."""
    return SLOW_BAV_MOVERS | (running & BAV_DASHA_MOVERS)


def mover_strength(table: BinduTable, graha: PlanetName, sign_idx: int) -> float:
    """0.5 for SAV >= 28 in the sign, plus 0.5 for the graha's own BAV >= 4 there."""
    sav_ok = table.sav[sign_idx] >= SAV_SUPPORTIVE
    bav_ok = table.bav[graha][sign_idx] >= BAV_FAVOURABLE
    return _HALF * sav_ok + _HALF * bav_ok


def ashtakavarga_score(
    table: BinduTable,
    signs: Mapping[PlanetName, int],
    movers: frozenset[PlanetName],
    on_target: Callable[[int], bool],
) -> float:
    """The strongest on-target mover's strength; 0.0 when no mover is on target."""
    strengths = [
        mover_strength(table, graha, signs[graha]) for graha in movers if on_target(signs[graha])
    ]
    return max(strengths, default=0.0)


def _month_bounds(ym: YearMonth) -> tuple[datetime, datetime, datetime]:
    """The month's start, its 15th at 12:00 UTC (the v1 convention), and its end."""
    year, month = ym
    end = datetime(year + month // 12, month % 12 + 1, 1, tzinfo=UTC)
    mid = datetime(year, month, _MID_DAY, _MID_HOUR, tzinfo=UTC)
    return datetime(year, month, 1, tzinfo=UTC), mid, end


@dataclass(frozen=True)
class _NatalFrame:
    """The natal facts the rule reads: bindus, and the lagna and Moon signs."""

    table: BinduTable
    lagna_idx: int
    moon_idx: int

    def in_houses(self, sign_idx: int, houses: frozenset[int]) -> bool:
        """The sign is one of the houses counted from the lagna or the Moon."""
        counted = {
            whole_sign_house(sign_idx, self.lagna_idx),
            whole_sign_house(sign_idx, self.moon_idx),
        }
        return bool(counted & houses)


def _natal_frame(natal: SiderealContext) -> _NatalFrame:
    table = BinduTable.from_context(compute_ashtakavarga(natal))
    return _NatalFrame(table, natal_lagna_index(natal), natal_moon_index(natal))


def _month_signs(
    natal: SiderealContext, astro: SkyfieldAstronomy, ym: YearMonth
) -> dict[PlanetName, int]:
    """Each of the month's movers and its sidereal sign on the 15th, 12:00 UTC."""
    start, mid, end = _month_bounds(ym)
    running = frozenset(PlanetName(lord) for lord in running_lords(natal, start, end))
    return {g: sign_index(transit_longitude(astro, g, mid)) for g in transit_movers(running)}


def _month_scores(frame: _NatalFrame, signs: Mapping[PlanetName, int]) -> dict[LifeDomain, float]:
    """Every domain's score for one month of mover signs."""
    movers = frozenset(signs)
    return {
        domain: ashtakavarga_score(
            frame.table,
            signs,
            movers,
            partial(frame.in_houses, houses=domain_house_numbers(recipe)),
        )
        for domain, recipe in DOMAIN_RECIPES.items()
    }


def monthly_ashtakavarga_signals(
    natal: SiderealContext,
    astro: SkyfieldAstronomy,
    months: Sequence[YearMonth],
    settings: AshtakavargaTransitSettings,
) -> dict[LifeDomain, tuple[float, ...]]:
    """Each domain's Ashtakavarga-transit score per month; empty when the flag is off."""
    if not settings.enabled:
        return {}
    frame = _natal_frame(natal)
    rows = [_month_scores(frame, _month_signs(natal, astro, ym)) for ym in months]
    return {domain: tuple(row[domain] for row in rows) for domain in DOMAIN_RECIPES}


__all__ = [
    "BAV_DASHA_MOVERS",
    "BAV_FAVOURABLE",
    "SAV_SUPPORTIVE",
    "SLOW_BAV_MOVERS",
    "AshtakavargaTransitSettings",
    "BinduTable",
    "ashtakavarga_score",
    "monthly_ashtakavarga_signals",
    "mover_strength",
    "transit_movers",
]
