"""The LAZY predictive superset: transits + all vargas + strength + life domains.

This is the second runtime entrypoint next to ``calculate_sidereal_context``.
It is computed SEPARATELY from the natal chart call (transits take ~35s under
Pyodide), at an EXPLICIT reference instant — never a silent ``now()`` — so the
payload is byte-reproducible on CPython and Pyodide alike. The natal pipeline
and its golden stay untouched.

This module is deliberately free of any ``edgeproc`` dependency so the Pyodide
chart Worker (which installs only the skyfield stack + the almamesh wheel) can
import it directly; ``edge/chart_runtime.py`` wraps it for task payloads.

CRYPTO-FREE BY DESIGN. This module computes; it does not sign. Each domain's
``StrengthSummary`` is sealed into an Ed25519 receipt by the Worker's TypeScript
(``@gainratio/avow``), outside Pyodide — see
``frontend/packages/browser/src/pyodide/strengthReceipt.ts`` for why, and
``tests/test_engine_is_crypto_free.py`` for the guard that keeps it that way.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Final

from pydantic import BaseModel, ConfigDict

from almamesh.calculations import calculate_sidereal_context
from almamesh.domains import compute_life_domains
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.domains import LifeDomainsContext
from almamesh.schemas.strength import StrengthContext
from almamesh.schemas.transits import TransitContext
from almamesh.schemas.vargas import VargaContext
from almamesh.strength import compute_strength_context
from almamesh.transits import calculate_transit_context
from almamesh.vargas import compute_varga_context


class PredictiveContexts(BaseModel):
    """The four additive predictive contexts for one chart + instant.

    ``model_dump(mode="json")`` of this model IS the wire payload the browser
    receives: each top-level key carries the bare dump of its context. The Worker
    then seals each domain's ``StrengthSummary`` into a signed receipt and adds
    ``domain_strength_receipts`` alongside these four keys before the payload
    reaches app code.
    """

    model_config = ConfigDict(frozen=True)

    transit_context: TransitContext
    varga_context_full: VargaContext
    strength_context: StrengthContext
    domains_context: LifeDomainsContext


_MAX_OFFSET_MINUTES: Final[int] = 18 * 60  # real civil offsets lie within -12 h..+14 h
_DEFAULT_WINDOW_MONTHS: Final[int] = 12
_MAX_WINDOW_MONTHS: Final[int] = 24


def checked_window_months(value: int) -> int:
    """The timeline window in months, refused outside 1..24."""
    if not 1 <= value <= _MAX_WINDOW_MONTHS:
        raise ValueError("invalid window_months: must be 1..24")
    return value


def window_months_from_wire(value: object) -> int:
    """The timeline window from a wire value; absent means the default 12.

    Shared by the CPython edge runtime and the Pyodide worker glue so both
    refuse the same inputs: booleans, strings, fractions, out-of-range values.
    """
    if value is None:
        return _DEFAULT_WINDOW_MONTHS
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("invalid window_months: must be whole months")
    return checked_window_months(value)


def civil_offset_from_minutes(value: object) -> timedelta:
    """The birthplace's civil UTC offset from a wire value in whole minutes.

    Shared by the CPython edge runtime and the Pyodide worker glue so both
    refuse the same inputs: booleans, strings, fractions, out-of-range values.
    """
    if isinstance(value, bool) or not isinstance(value, int | float) or value != int(value):
        raise ValueError("invalid utc_offset_minutes: must be whole minutes")
    if abs(value) > _MAX_OFFSET_MINUTES:
        raise ValueError("invalid utc_offset_minutes: out of range")
    return timedelta(minutes=int(value))


def compute_predictive_contexts(
    birth_dt: datetime,
    latitude: float,
    longitude: float,
    reference_instant: datetime,
    *,
    civil_offset: timedelta,
    window_months: int = _DEFAULT_WINDOW_MONTHS,
) -> PredictiveContexts:
    """All four predictive contexts at one EXPLICIT instant (no silent now()).

    ``civil_offset`` is the birthplace's civil UTC offset at birth; Kalabala
    reads the Vedic weekday off the civil date of the sunrise.

    ``reference_instant`` pins BOTH the natal "current" dasha and the transit
    "now", keeping the whole payload coherent and reproducible — which is what
    makes the CPython<->Pyodide byte-parity gate meaningful.

    ``window_months`` (1..24, default 12) is the forward timeline's length; a
    period of up to two years is one compute.
    """
    checked_window_months(window_months)
    natal = calculate_sidereal_context(
        birth_dt, latitude, longitude, reference_date=reference_instant
    )
    transits = calculate_transit_context(
        natal, birth_dt, transit_instant=reference_instant, window_months=window_months
    )
    return _compose(natal, transits, birth_dt, latitude, longitude, civil_offset)


def _compose(
    natal: SiderealContext,
    transits: TransitContext,
    birth_dt: datetime,
    latitude: float,
    longitude: float,
    civil_offset: timedelta,
) -> PredictiveContexts:
    """The varga, strength and domain contexts, assembled with the transits."""
    vargas = compute_varga_context(natal)
    strength = compute_strength_context(
        natal, birth_dt, latitude, longitude, civil_offset=civil_offset
    )
    domains = compute_life_domains(natal, transits, vargas, strength)
    return PredictiveContexts(
        transit_context=transits,
        varga_context_full=vargas,
        strength_context=strength,
        domains_context=domains,
    )


__all__ = [
    "PredictiveContexts",
    "checked_window_months",
    "civil_offset_from_minutes",
    "compute_predictive_contexts",
    "window_months_from_wire",
]
