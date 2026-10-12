"""Jupiter/Saturn transits over natal points, and Saturn/Jupiter returns.

A conjunction/return is a root-find of the circular gap between a transiting
graha's longitude and a fixed natal target. Severity is a coarse, deterministic,
classical-leaning heuristic (Saturn-on-Moon/Lagna challenges, Jupiter supports,
returns are neutral milestones); the LLM refines downstream."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Final

from almamesh.calculations import AyanamsaType, NodeType
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import SlowTransitHit, TransitEventKind, TransitSeverity
from almamesh.transits.ingress import find_first_crossing
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable

    from almamesh.calculations import SkyfieldAstronomy

_STEP_DAYS: Final[float] = 5.0
# Numerical contact tolerance in degrees (0.0036 arcseconds), not an aspect orb.
# Bisection must finish on the conjunction branch, never the antipodal wrap.
_CONTACT_TOLERANCE_DEG: Final[float] = 1e-6
# Jupiter conjuncts a fixed point every ~12 yr; Saturn returns every ~29.5 yr.
# Conjunctions share a ~13-year search horizon; a later Saturn contact may be absent.
# Saturn returns search a full period + slack, subject to the ephemeris clamp below.
_JUPITER_PERIOD_DAYS: Final[float] = 11.862 * 365.25
_CONJ_WINDOW_DAYS: Final[float] = _JUPITER_PERIOD_DAYS + 365.25
_SATURN_PERIOD_DAYS: Final[float] = 29.457 * 365.25
_RETURN_WINDOW_DAYS: Final[float] = _SATURN_PERIOD_DAYS + 365.25
# DE421 covers ~1900-2053; clamp any forward search so probes stay in range.
# NOTE: a clamped window TRUNCATES the search, so a crossing that genuinely
# falls after the horizon comes back as None ("no hit"), indistinguishable from
# "no crossing exists". Surfacing that distinction needs a schema change and is
# deliberately left out of scope here.
_EPHEMERIS_MAX = datetime(2053, 1, 1, tzinfo=UTC)


def _clamp(when: datetime) -> datetime:
    """Keep a search horizon inside the DE421 ephemeris range."""
    return min(when, _EPHEMERIS_MAX)


def _gap_fn(
    astro: SkyfieldAstronomy, graha: PlanetName, target: float
) -> Callable[[datetime], float]:
    """Circular gap in [-180, 180), discontinuous at opposition, not conjunction."""

    def f(when: datetime) -> float:
        lon = transit_longitude(astro, graha, when, AyanamsaType.LAHIRI, NodeType.MEAN)
        return (lon - target + 180.0) % 360.0 - 180.0

    return f


def _first_crossing(
    astro: SkyfieldAstronomy, graha: PlanetName, target: float, start: datetime, end: datetime
) -> datetime | None:
    """The earliest true contact; a circular gap's opposition jump is not a root.

    Jupiter and Saturn cannot move 180 degrees in one five-day sample interval.
    A sign change with a jump that large therefore crosses the wrapper's seam,
    not the target. Refine only continuous near-zero brackets and independently
    validate their angular residual before publishing a conjunction or return.
    Keep scanning after a rejected bracket rather than losing a later contact.
    """
    gap = _gap_fn(astro, graha, target)
    lo = start
    gap_lo = gap(lo)
    if abs(gap_lo) <= _CONTACT_TOLERANCE_DEG:
        return lo
    step = timedelta(days=_STEP_DAYS)
    while lo < end:
        hi = min(lo + step, end)
        gap_hi = gap(hi)
        continuous_crossing = (gap_lo >= 0.0) != (gap_hi >= 0.0) and abs(gap_hi - gap_lo) < 180.0
        if continuous_crossing:
            exact = find_first_crossing(gap, lo, hi, _STEP_DAYS)
            if exact is not None and abs(gap(exact)) <= _CONTACT_TOLERANCE_DEG:
                return exact
        if abs(gap_hi) <= _CONTACT_TOLERANCE_DEG:
            return hi
        lo, gap_lo = hi, gap_hi
    return None


def _hit(
    graha: PlanetName, natal_point: str, exact: datetime, kind: TransitEventKind
) -> SlowTransitHit:
    """Build a SlowTransitHit with the deterministic severity heuristic."""
    return SlowTransitHit(
        graha=graha,
        kind=kind,
        natal_point=natal_point,
        exact=exact,
        severity=_severity(graha, kind),
    )


def _severity(graha: PlanetName, kind: TransitEventKind) -> TransitSeverity:
    """Coarse classical valence: Saturn challenges, Jupiter supports, returns neutral."""
    if kind is TransitEventKind.RETURN:
        return TransitSeverity.NEUTRAL
    if graha is PlanetName.JUPITER:
        return TransitSeverity.SUPPORTIVE
    return TransitSeverity.CHALLENGING


def next_conjunction(
    astro: SkyfieldAstronomy,
    graha: PlanetName,
    target: float,
    natal_point: str,
    after: datetime,
) -> SlowTransitHit | None:
    """Next exact conjunction of `graha` over a natal `target` longitude.

    A conjunction over the Moon/Lagna is the graha arriving on the point; the
    enum's SIGN_INGRESS is the closest "graha reaches a longitude" semantics.
    """
    end = _clamp(after + timedelta(days=_CONJ_WINDOW_DAYS))
    exact = _first_crossing(astro, graha, target, after, end)
    return None if exact is None else _hit(graha, natal_point, exact, TransitEventKind.SIGN_INGRESS)


def next_saturn_return(
    astro: SkyfieldAstronomy, natal_saturn: float, after: datetime
) -> SlowTransitHit | None:
    """Next exact Saturn return (transit Saturn over natal Saturn) after `after`."""
    end = _clamp(after + timedelta(days=_RETURN_WINDOW_DAYS))
    exact = _first_crossing(astro, PlanetName.SATURN, natal_saturn, after, end)
    return (
        None
        if exact is None
        else _hit(PlanetName.SATURN, "natal_saturn", exact, TransitEventKind.RETURN)
    )
