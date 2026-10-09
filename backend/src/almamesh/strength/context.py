"""Public entrypoint for the Phase-3 strength engine.

``compute_strength_context(natal, birth_dt, lat, lon)`` composes Ashtakavarga +
Shadbala into a standalone, additive ``StrengthContext`` from a read-only natal
``SiderealContext``. The real birth instant + place are required so Kalabala uses
the true civil sunrise (the chart pipeline already has them). The natal chart is
never mutated — parity and the natal golden stay byte-stable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from almamesh.calculations import SkyfieldAstronomy, _to_utc
from almamesh.schemas.strength import StrengthContext
from almamesh.strength.ashtakavarga import compute_ashtakavarga
from almamesh.strength.shadbala import compute_shadbala
from almamesh.strength.sunrise import sun_window

if TYPE_CHECKING:
    from datetime import datetime, timedelta

    from almamesh.schemas.astrology import SiderealContext

__all__ = ["compute_strength_context"]


def compute_strength_context(
    natal: SiderealContext,
    birth_dt: datetime,
    lat: float,
    lon: float,
    *,
    civil_offset: timedelta,
) -> StrengthContext:
    """Compute the full Ashtakavarga + Shadbala strength context for a natal chart.

    ``civil_offset`` is the birthplace's civil UTC offset at birth (required:
    the Vedic weekday is the civil date of the sunrise, see ``SunWindow``).
    """
    birth_utc = _to_utc(birth_dt)
    astro = SkyfieldAstronomy()
    window = sun_window(astro, birth_utc, lat, lon, civil_offset=civil_offset)
    return StrengthContext(
        sunrise_utc_iso=window.sunrise.isoformat(),
        ashtakavarga=compute_ashtakavarga(natal),
        shadbala=compute_shadbala(natal, birth_utc, lat, lon, civil_offset=civil_offset),
    )
