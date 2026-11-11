"""Rich divisional-chart (D1..D60) detail: houses, dignity, sensitivity, and D60 amsas.

Pure, deterministic calculation built on ``almamesh.vargas.divisions`` and
``almamesh.constants.astrology`` so CPython and Pyodide emit byte-identical JSON.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict

from almamesh.constants.astrology import (
    DEBILITATION_SIGN,
    EXALTATION_SIGN,
    SIGN_LORDS,
    ZODIAC_SIGNS,
    PlanetName,
    ZodiacSign,
)
from almamesh.schemas.vargas import DivisionalChart
from almamesh.vargas.divisions import varga_sign
from almamesh.vargas.shashtiamsa import ShashtiamsaAmsa, shashtiamsa_amsa

VargaDignity = Literal["exalted", "own", "debilitated", "neutral"]

_SIGN_WIDTH: Final[float] = 30.0
_MINUTES_PER_DEG: Final[float] = 4.0
_CUSP_MINUTES_FLOOR: Final[float] = 4.0
_NARROW_WINDOW_MINUTES: Final[float] = 6.0
_SIGN_INDEX: Final[dict[ZodiacSign, int]] = {
    ZodiacSign(name): i for i, name in enumerate(ZODIAC_SIGNS)
}
_D30_ODD_BOUNDS: Final[tuple[tuple[float, float], ...]] = (
    (0.0, 5.0), (5.0, 10.0), (10.0, 18.0), (18.0, 25.0), (25.0, 30.0),
)  # fmt: skip
_D30_EVEN_BOUNDS: Final[tuple[tuple[float, float], ...]] = (
    (0.0, 5.0), (5.0, 12.0), (12.0, 20.0), (20.0, 25.0), (25.0, 30.0),
)  # fmt: skip


class VargaPlanetInput(BaseModel):
    model_config = ConfigDict(frozen=True)
    longitude: float
    is_combust: bool = False


class VargaLagnaSensitivity(BaseModel):
    model_config = ConfigDict(frozen=True)
    nominal_window_minutes: float
    margin_prev_deg: float
    margin_next_deg: float
    approx_minutes_to_cusp: float
    high_time_sensitivity: bool


class VargaDetailPlacement(BaseModel):
    model_config = ConfigDict(frozen=True, use_enum_values=True)
    graha: PlanetName
    sign: ZodiacSign
    sign_lord: PlanetName
    house: int
    dignity: VargaDignity
    is_combust: bool
    same_sign_as_d1: bool
    vargottama: bool
    shashtiamsa: ShashtiamsaAmsa | None = None


class VargaDetailResult(BaseModel):
    model_config = ConfigDict(frozen=True, use_enum_values=True)
    chart: DivisionalChart
    lagna_sign: ZodiacSign
    lagna_sign_lord: PlanetName
    lagna_vargottama: bool
    lagna_shashtiamsa: ShashtiamsaAmsa | None
    sensitivity: VargaLagnaSensitivity
    placements: dict[PlanetName, VargaDetailPlacement]


def _d30_part_bounds(sign_index: int, deg_in_sign: float) -> tuple[float, float]:
    bounds = _D30_ODD_BOUNDS if sign_index % 2 == 0 else _D30_EVEN_BOUNDS
    for lower, upper in bounds:
        if deg_in_sign < upper:
            return lower, upper
    return bounds[-1]


def _varga_part_bounds(
    chart: DivisionalChart, sign_index: int, deg_in_sign: float
) -> tuple[float, float]:
    if chart == DivisionalChart.D30:
        return _d30_part_bounds(sign_index, deg_in_sign)
    divisions = int(chart.value[1:])
    part = min(int(deg_in_sign * divisions // _SIGN_WIDTH), divisions - 1)
    step = _SIGN_WIDTH / divisions
    return part * step, (part + 1) * step


def _compute_sensitivity(chart: DivisionalChart, lagna_longitude: float) -> VargaLagnaSensitivity:
    long_mod = lagna_longitude % 360.0
    sign_index = int(long_mod // _SIGN_WIDTH)
    deg_in_sign = long_mod - sign_index * _SIGN_WIDTH
    lower_deg, upper_deg = _varga_part_bounds(chart, sign_index, deg_in_sign)
    nominal = round((upper_deg - lower_deg) * _MINUTES_PER_DEG, 2)
    prev_deg = round(max(0.0, deg_in_sign - lower_deg), 4)
    next_deg = round(max(0.0, upper_deg - deg_in_sign), 4)
    cusp_min = round(min(prev_deg, next_deg) * _MINUTES_PER_DEG, 2)
    is_sens = cusp_min < _CUSP_MINUTES_FLOOR or nominal <= _NARROW_WINDOW_MINUTES
    return VargaLagnaSensitivity(
        nominal_window_minutes=nominal, margin_prev_deg=prev_deg, margin_next_deg=next_deg,
        approx_minutes_to_cusp=cusp_min, high_time_sensitivity=is_sens,
    )  # fmt: skip


def _varga_dignity(graha: PlanetName, sign: ZodiacSign, sign_lord: PlanetName) -> VargaDignity:
    if EXALTATION_SIGN.get(graha) == sign:
        return "exalted"
    if DEBILITATION_SIGN.get(graha) == sign:
        return "debilitated"
    return "own" if sign_lord == graha else "neutral"


def _build_placement(
    chart: DivisionalChart, lagna_sign: ZodiacSign, graha: PlanetName, item: VargaPlanetInput
) -> VargaDetailPlacement:
    sign = varga_sign(chart, item.longitude)
    d1_sign = varga_sign(DivisionalChart.D1, item.longitude)
    lord = SIGN_LORDS[sign]
    house = ((_SIGN_INDEX[sign] - _SIGN_INDEX[lagna_sign]) % 12) + 1
    amsa = shashtiamsa_amsa(item.longitude) if chart == DivisionalChart.D60 else None
    vargottama = d1_sign == varga_sign(DivisionalChart.D9, item.longitude)
    return VargaDetailPlacement(
        graha=graha, sign=sign, sign_lord=lord, house=house,
        dignity=_varga_dignity(graha, sign, lord), is_combust=item.is_combust,
        same_sign_as_d1=(sign == d1_sign), vargottama=vargottama, shashtiamsa=amsa,
    )  # fmt: skip


def compute_varga_detail(
    chart: DivisionalChart, lagna_longitude: float, planets: Mapping[PlanetName, VargaPlanetInput]
) -> VargaDetailResult:
    """Compute divisional lagna sensitivity, whole-sign houses, dignities, and D60 amsas."""
    lagna_norm = lagna_longitude % 360.0
    lagna_sign = varga_sign(chart, lagna_norm)
    lagna_d1 = varga_sign(DivisionalChart.D1, lagna_norm)
    lagna_amsa = shashtiamsa_amsa(lagna_norm) if chart == DivisionalChart.D60 else None
    placements = {g: _build_placement(chart, lagna_sign, g, p) for g, p in planets.items()}
    return VargaDetailResult(
        chart=chart, lagna_sign=lagna_sign, lagna_sign_lord=SIGN_LORDS[lagna_sign],
        lagna_vargottama=(lagna_d1 == varga_sign(DivisionalChart.D9, lagna_norm)),
        lagna_shashtiamsa=lagna_amsa, sensitivity=_compute_sensitivity(chart, lagna_norm),
        placements=placements,
    )  # fmt: skip


def _wire_finite_float(raw: object, field: str) -> float:
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        raise ValueError(f"invalid {field}: must be a finite number")
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError(f"invalid {field}: must be a finite number")
    return value


def _wire_chart(raw: object) -> DivisionalChart:
    if not isinstance(raw, str):
        raise ValueError("invalid chart: must be a DivisionalChart string (D1..D60)")
    try:
        return DivisionalChart(raw)
    except ValueError as error:
        raise ValueError(f"invalid chart: {raw}") from error


def _wire_planet_entry(key: object, raw: object) -> tuple[PlanetName, VargaPlanetInput]:
    if not isinstance(key, str) or not isinstance(raw, Mapping):
        raise ValueError("invalid planets entry: expected planet key -> object")
    try:
        graha = PlanetName(key)
    except ValueError as error:
        raise ValueError(f"invalid planet name: {key}") from error
    combust = raw.get("is_combust", False)
    if not isinstance(combust, bool):
        raise ValueError(f"invalid planets.{key}.is_combust: must be a boolean")
    lon = _wire_finite_float(raw.get("longitude"), f"planets.{key}.longitude")
    return graha, VargaPlanetInput(longitude=lon, is_combust=combust)


def varga_detail_from_wire(payload: Mapping[str, object]) -> VargaDetailResult:
    """Validate snake_case wire payload and compute divisional chart detail."""
    chart = _wire_chart(payload.get("chart"))
    lagna_lon = _wire_finite_float(payload.get("lagna_longitude"), "lagna_longitude")
    raw_planets = payload.get("planets")
    if not isinstance(raw_planets, Mapping):
        raise ValueError("invalid planets: must be an object mapping planet names to longitudes")
    planets = dict(_wire_planet_entry(k, v) for k, v in raw_planets.items())
    return compute_varga_detail(chart, lagna_lon, planets)
