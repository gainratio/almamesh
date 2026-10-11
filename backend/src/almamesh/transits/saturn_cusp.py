"""Saturn sign-cusp ingress timing with retrograde correctness.

Saturn spends ~2.5y per sign but retrogrades ~140 days/yr, so it can cross a sign
cusp up to 3x before settling. The canonical *entry* into a sign is the LAST
forward crossing of that cusp (spec section 3.2/3.6). Everything here is pure and
deterministic — the instant is always passed in; no `now()`."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Final

from almamesh.calculations import AyanamsaType, NodeType
from almamesh.constants.astrology import PlanetName
from almamesh.transits.ingress import find_crossings
from almamesh.transits.positions import EPHEMERIS_LAST_INSTANT, transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

_SIGN_WIDTH: Final[float] = 30.0
_SATURN_STEP_DAYS: Final[float] = 5.0  # matched to Saturn's ~0.03 deg/day
# Saturn spends ~2.5 yr per sign; a 3-year look-back/forward window always
# contains the relevant ingress (plus its retrograde loop) without overscanning.
_INGRESS_WINDOW_DAYS: Final[float] = 1095.0
# A retrograde excursion back across a cusp completes within ~4 months; a sticking
# entry is one still inside the sign this long after the crossing.
_STICK_DAYS: Final[float] = 150.0


def _signed_gap(lon: float, cusp: float) -> float:
    """Seam-unwrapped (lon - cusp) in (-180, 180]."""
    return (lon - cusp + 180.0) % 360.0 - 180.0


def saturn_cusp_fn(astro: SkyfieldAstronomy, cusp_deg: float) -> Callable[[datetime], float]:
    """f(t) = unwrapped distance of transiting Saturn from a sign cusp."""

    def f(when: datetime) -> float:
        lon = transit_longitude(astro, PlanetName.SATURN, when, AyanamsaType.LAHIRI, NodeType.MEAN)
        return _signed_gap(lon, cusp_deg)

    return f


def _is_forward_entry(f: Callable[[datetime], float], crossing: datetime) -> bool:
    """True if Saturn moves below->above the cusp here (a real entry, not exit)."""
    eps = timedelta(hours=12)
    return f(crossing - eps) < 0.0 <= f(crossing + eps)


def _sticks(f: Callable[[datetime], float], crossing: datetime) -> bool:
    """True if Saturn is still inside the sign past the retrograde loop window.

    A non-sticking June entry that retrogrades back out within ~4 months reads as
    below-cusp at +`_STICK_DAYS`; the final sticking entry stays above. This is
    the spec's last-crossing rule expressed as durability, not mere ordinality.
    """
    return f(crossing + timedelta(days=_STICK_DAYS)) >= 0.0


def _entries_in(
    astro: SkyfieldAstronomy, sign_idx: int, start: datetime, end: datetime
) -> list[datetime]:
    """All sticking forward entries of Saturn into sign_idx within [start, end]."""
    f = saturn_cusp_fn(astro, (sign_idx % 12) * _SIGN_WIDTH)
    crossings = find_crossings(f, start, end, _SATURN_STEP_DAYS)
    return [c for c in crossings if _is_forward_entry(f, c) and _sticks(f, c)]


def ingress_before(astro: SkyfieldAstronomy, sign_idx: int, anchor: datetime) -> datetime | None:
    """Saturn's last sticking entry into sign_idx at/before `anchor` (~3y back)."""
    start = anchor - timedelta(days=_INGRESS_WINDOW_DAYS)
    entries = [c for c in _entries_in(astro, sign_idx, start, anchor) if c <= anchor]
    return entries[-1] if entries else None


def ingress_after(astro: SkyfieldAstronomy, sign_idx: int, anchor: datetime) -> datetime | None:
    """Saturn's last sticking entry into sign_idx after `anchor` (~3y forward).

    The look-ahead stops at the ephemeris end, so an entry past it reads as None
    (no hit), like `slow_hits`; reading past DE421 would raise instead.
    """
    end = min(anchor + timedelta(days=_INGRESS_WINDOW_DAYS), EPHEMERIS_LAST_INSTANT)
    entries = [c for c in _entries_in(astro, sign_idx, anchor, end) if c > anchor]
    return entries[-1] if entries else None
