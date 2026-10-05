"""
Sidereal Vedic astrology calculations using Skyfield (NO Swiss Ephemeris).

COHESION: All astronomy-related calculations in one place.
COUPLING: Zero dependencies on database, API, or LLM.

This module consolidates:
- Constants (Zodiac, Nakshatras, etc.)
- Ayanamsa (Lahiri with lookup table)
- Lagna (Ascendant) using spherical geometry
- Planetary positions (9 planets + 2 nodes) using Skyfield
- House cusps (Whole Sign system)
- Divisional Charts (D1 Rasi + D9 Navamsa only)
- Dashas (Vimshottari)
- Yogas (audited classical rules; almamesh.yogas)

Guidelines:
- Pure functions where possible
- No external I/O except loading ephemeris and ayanamsa data
- Strictly use Skyfield (no swisseph)
"""

import importlib.resources
import logging
import math
from bisect import bisect_right
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import Any

import numpy as np
from skyfield.api import Loader, Star, load_file
from skyfield.framelib import ecliptic_frame
from skyfield.nutationlib import earth_tilt

from almamesh.constants.astrology import (
    DASHA_SEQUENCE,
    DASHA_YEARS,
    DEBILITATION_SIGN,
    EXALTATION_SIGN,
    NAKSHATRA_LORDS,
    NAKSHATRA_NAMES,
    SIGN_LORDS,
    ZODIAC_SIGNS,
    Dignity,
    PlanetName,
    ZodiacSign,
)
from almamesh.dasha.convention import (
    DEFAULT_DASHA_YEAR_CONVENTION,
    DashaYearConvention,
)
from almamesh.navamsa import navamsa_sign
from almamesh.schemas.astrology import (
    DashaPeriod,
    HouseCuspData,
    LagnaData,
    MahaDashaPeriod,
    NavamsaChart,
    PlanetPosition,
    SiderealContext,
    VargaPlanet,
    VimshottariDashaData,
    YogaData,
    YogaStrengthFactor,
)
from almamesh.yogas.combustion import (
    combustion_orb_deg,
    combustion_separation_deg,
    is_combust,
)
from almamesh.yogas.lordship import houses_ruled, yogakaraka_planet

logger = logging.getLogger(__name__)


def _to_utc(dt: datetime) -> datetime:
    """Normalize to a true UTC instant. Naive -> assume UTC; aware -> CONVERT
    (never .replace, which silently drops the offset)."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


# Re-export from constants for backward compatibility
__all__ = [
    # From constants.astrology
    "PlanetName",
    "ZodiacSign",
    "Dignity",
    # Local models
    "PlanetPosition",
    "LagnaData",
    "HouseCuspData",
    "DashaPeriod",
    "VimshottariDashaData",
    "YogaStrengthFactor",
    "YogaData",
    "SiderealContext",
    "ComprehensiveAstrologicalData",
    # Functions
    "calculate_sidereal_context",
    "calculate_vimshottari_dashas",
    "detect_yogas",
    "get_nakshatra_info",
    "get_dignity",
]

# --- Type Aliases for Yogas Module Compatibility ---
ComprehensiveAstrologicalData = SiderealContext


# --- Ayanamsa Logic ---


class AyanamsaType(StrEnum):
    """Sidereal zero-point convention."""

    LAHIRI = "LAHIRI"  # official Chitrapaksha (default)
    TRUE_CHITRA = "TRUE_CHITRA"  # Spica forced to exactly 180.000 deg


class NodeType(StrEnum):
    """Lunar-node model."""

    MEAN = "mean"  # Meeus polynomial (default, backward-compatible)
    TRUE = "true"  # osculating node from the Moon's state vector


class HouseSystem(StrEnum):
    """House-division convention the engine uses.

    AlmaMesh uses **whole-sign** houses (Vedic standard): each house is one
    full 30 deg sign, the 1st house being the whole sign occupied by the Lagna.
    There is intentionally no quadrant (Placidus/Koch/Equal-from-Asc) option —
    ``HouseCuspData.longitude`` is therefore a *sign-start*, never an
    interpolated cusp. This enum exists so the UI/report can label the system
    honestly and so a silent switch to a quadrant system is impossible.
    """

    WHOLE_SIGN = "whole_sign"


# The single house system AlmaMesh computes; surfaced as an importable,
# machine-readable label for the frontend/report (NOT serialized into the
# chart JSON, so existing golden output is byte-unchanged).
HOUSE_SYSTEM: HouseSystem = HouseSystem.WHOLE_SIGN


# Documented J2000.0 Lahiri/Chitrapaksha anchor: 23 deg 51' 11" = 23.85306 deg.
# This is the official sidereal-zero epoch used by the Indian Astronomical
# Ephemeris (IAE) / Rashtriya Panchang for Lahiri (Chitrapaksha) ayanamsa.
LAHIRI_J2000_ANCHOR_DEG = 23.85306
_J2000_JD = 2451545.0
_ARCSEC_TO_DEG = 1.0 / 3600.0


def get_ayanamsa(jd: float) -> float:
    """Lahiri ayanamsa (degrees) from rigorous IAU 2006 general precession.

    Precession model: **IAU 2006** general precession in longitude p_A
    (Capitaine, Wallace & Chapront 2003), accumulated from J2000.0 and added to
    the documented Lahiri anchor `LAHIRI_J2000_ANCHOR_DEG`. This is auditable
    (a closed-form series, no opaque table read) and is validated to agree with
    the official Lahiri/Chitrapaksha daily lookup table to < 0.004 deg across
    1900-2050 (see `tests/test_ayanamsa_formula.py`).

    `jd` is the Terrestrial-Time Julian Date of the instant.
    """
    t = (jd - _J2000_JD) / 36525.0
    p_arcsec = (
        5028.796195 * t
        + 1.1054348 * t**2
        + 0.00007964 * t**3
        - 0.000023857 * t**4
        - 0.0000000383 * t**5
    )
    return LAHIRI_J2000_ANCHOR_DEG + p_arcsec * _ARCSEC_TO_DEG


class InvalidBirthInputError(ValueError):
    """A birth coordinate is non-numeric, non-finite, or out of range.

    A ValueError so every runtime boundary that already turns ValueError into an
    error envelope (``ChartRuntime.execute``, the Pyodide worker) keeps doing so.
    Messages are stable and value-free.
    """


# Poles are EXCLUDED: the Ascendant is undefined at a geographic pole (the
# lagna formula divides through ``tan(lat)``, a ~1.6e16 float at 90 deg rather
# than an error, so a pole would yield an arbitrary-but-plausible sign). The
# accepted latitude interval is therefore OPEN, (-90, 90); longitude is the
# CLOSED interval [-180, 180] (both ends name the same meridian).
_LATITUDE_LIMIT = 90.0
_LONGITUDE_LIMIT = 180.0


def _require_finite_coordinate(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise InvalidBirthInputError(f"invalid coordinate: {field} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise InvalidBirthInputError(f"invalid coordinate: {field} must be a finite number")
    return number


def validate_coordinates(latitude: float, longitude: float) -> None:
    """Fail closed on a coordinate the engine cannot compute honestly.

    Without this, ``calculate_lagna``'s ``tan(radians(lat))`` (period 180 deg)
    silently turned ``lat=200`` into the ``lat=20`` chart.
    """
    lat = _require_finite_coordinate(latitude, "latitude")
    lon = _require_finite_coordinate(longitude, "longitude")
    if not -_LATITUDE_LIMIT < lat < _LATITUDE_LIMIT:
        raise InvalidBirthInputError("invalid coordinate: latitude out of range (-90, 90)")
    if not -_LONGITUDE_LIMIT <= lon <= _LONGITUDE_LIMIT:
        raise InvalidBirthInputError("invalid coordinate: longitude out of range [-180, 180]")


class AyanamsaCalculator:
    """Official Lahiri/Chitrapaksha daily lookup table (regression cross-check).

    Source: the Lahiri (Chitrapaksha) standard as published by the Indian
    Astronomical Ephemeris (IAE) / Rashtriya Panchang, shipped as a daily table
    in `resources/lahiri_ayanamsa.txt` and linearly interpolated. Used as a
    cross-check against `get_ayanamsa`; FAILS CLOSED (raises) if the resource is
    missing rather than guessing with a divergent polynomial.
    """

    def __init__(self) -> None:
        self._table = self._load_lahiri_table()

    def _load_lahiri_table(self) -> list[tuple[float, float]]:
        table: list[tuple[float, float]] = []
        file_path = importlib.resources.files("almamesh.resources").joinpath("lahiri_ayanamsa.txt")
        with file_path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("#") or not line.strip():
                    continue
                parts = line.split()
                if len(parts) >= 5:
                    table.append((float(parts[3]), float(parts[4])))
        return table

    def get_ayanamsa(self, jd: float) -> float:
        """Interpolate the official table; fail closed if it is unavailable."""
        if not self._table:
            raise RuntimeError(
                "Lahiri ayanamsa table missing or empty; refusing to guess "
                "(fail-closed). Expected resources/lahiri_ayanamsa.txt."
            )
        if not self._table[0][0] <= jd <= self._table[-1][0]:
            # Fail closed: never clamp to the table's end value (that silently
            # returned the 1900/2100 ayanamsa for any instant outside the table).
            raise ValueError(
                "Lahiri ayanamsa table range exceeded: instant outside "
                "1900-01-01..2100-12-31 (fail-closed)"
            )
        # `bisect_right` finds the SAME bracketing entry the former linear scan
        # did (the first entry with jd < entry_jd), and the interpolation
        # arithmetic is unchanged, so every in-range value (and every golden
        # fixture) stays byte-identical.
        idx = bisect_right(self._table, jd, key=lambda entry: entry[0])
        if idx == len(self._table):
            return self._table[-1][1]  # jd == the table's last entry
        prev_jd, prev_val = self._table[idx - 1]
        entry_jd, val = self._table[idx]
        frac = (jd - prev_jd) / (entry_jd - prev_jd)
        return prev_val + frac * (val - prev_val)


ayanamsa_calc = AyanamsaCalculator()

# --- Astronomy Logic ---


# DE421 (~16 MB) is the shippable ephemeris for the in-browser bundle; DE440
# (~114 MB) is unnecessary for the 1900-2050 range AlmaMesh targets. Keep this in
# lockstep with `Settings.EPHEMERIS_FILE` (the publisher's source of truth).
DEFAULT_EPHEMERIS_FILE = "de421.bsp"

# Vendored copy lives at the backend repo root (backend/de421.bsp), OUTSIDE the
# src/almamesh package so `uv build` never bloats the wheel the Pyodide bundle
# ships. calculations.py is backend/src/almamesh/ -> parents[2] == backend/.
_VENDORED_EPHEMERIS_DIR = Path(__file__).resolve().parents[2]


def resolve_ephemeris_path(ephemeris_file: str = DEFAULT_EPHEMERIS_FILE) -> Path:
    """The ephemeris file the engine reads: the vendored copy on CPython, else
    the bundle-seeded ``~/.skyfield-data`` copy (Pyodide). One resolver, so the
    snapshot hashes exactly the bytes the numbers came from."""
    vendored = _VENDORED_EPHEMERIS_DIR / ephemeris_file
    if vendored.exists():
        return vendored
    return Path(Loader("~/.skyfield-data").path_to(ephemeris_file))


class SkyfieldAstronomy:
    """Core astronomy calculations using Skyfield."""

    def __init__(self, ephemeris_file: str = DEFAULT_EPHEMERIS_FILE):
        # Timescale data still loads via the Loader's ~/.skyfield-data home so
        # the Pyodide bundle path (which seeds that virtual dir) is unchanged.
        self.loader = Loader("~/.skyfield-data")
        # Prefer the vendored ephemeris (offline, self-contained, zero download)
        # via Skyfield's explicit-path loader. Under Pyodide the vendored file is
        # absent -> fall back to Loader(...) reading the bundle's ~/.skyfield-data
        # exactly as before. Same de421 bytes -> byte-identical numbers.
        path = resolve_ephemeris_path(ephemeris_file)
        self.eph = load_file(str(path)) if path.exists() else self.loader(ephemeris_file)
        self.ts = self.loader.timescale()

    def _apparent_tropical_longitude(self, target: str, when: datetime) -> float:
        """Apparent ecliptic longitude (aberration + deflection, equinox of date)."""
        t = self.ts.from_datetime(_to_utc(when))
        apparent = self.eph["earth"].at(t).observe(self.eph[target]).apparent()
        _, lon, _ = apparent.ecliptic_latlon(epoch="date")
        return float(lon.degrees)

    def _astrometric_tropical_longitude(self, target: str, when: datetime) -> float:
        """Astrometric (no aberration/deflection) longitude — for tests only."""
        t = self.ts.from_datetime(_to_utc(when))
        astrometric = self.eph["earth"].at(t).observe(self.eph[target])
        _, lon, _ = astrometric.ecliptic_latlon(epoch="date")
        return float(lon.degrees)

    def _true_obliquity_deg(self, when: datetime) -> float:
        """True obliquity of date = mean eps(of date) + nutation in obliquity."""
        t = self.ts.from_datetime(_to_utc(when))
        _, true_obliquity_deg, _, _, _ = earth_tilt(t)
        return float(true_obliquity_deg)

    def _get_standard_planet_positions(
        # Any: Skyfield's Time `t` and barycentric `earth` are untyped at the
        # library boundary; positions hold mixed float/str astro fields.
        self,
        t: Any,
        earth: Any,
        ayanamsa: float,
        positions: dict[PlanetName, dict[str, Any]],
    ) -> None:
        """Calculate positions for the 7 standard planets."""
        planets_map = {
            PlanetName.SUN: "sun",
            PlanetName.MOON: "moon",
            PlanetName.MARS: "mars barycenter",
            PlanetName.MERCURY: "mercury barycenter",
            PlanetName.JUPITER: "jupiter barycenter",
            PlanetName.VENUS: "venus barycenter",
            PlanetName.SATURN: "saturn barycenter",
        }

        for name, target in planets_map.items():
            apparent = earth.at(t).observe(self.eph[target]).apparent()
            lat, lon, dist = apparent.ecliptic_latlon(epoch="date")

            # Daily motion (speed)
            t_next = self.ts.tt_jd(t.tt + 1.0)
            apparent_next = earth.at(t_next).observe(self.eph[target]).apparent()
            _, lon_next, _ = apparent_next.ecliptic_latlon(epoch="date")

            speed = (lon_next.degrees - lon.degrees + 180) % 360 - 180

            positions[name] = {
                "longitude": (lon.degrees - ayanamsa) % 360,
                "latitude": lat.degrees,
                "distance": dist.au,
                "speed": speed,
                "is_retrograde": speed < 0,
            }

    # JPL barycenter target names for the standard (non-node) grahas — reused by
    # the single-graha fast path the transit root-finds probe thousands of times.
    _STANDARD_TARGETS: dict[PlanetName, str] = {
        PlanetName.SUN: "sun",
        PlanetName.MOON: "moon",
        PlanetName.MARS: "mars barycenter",
        PlanetName.MERCURY: "mercury barycenter",
        PlanetName.JUPITER: "jupiter barycenter",
        PlanetName.VENUS: "venus barycenter",
        PlanetName.SATURN: "saturn barycenter",
    }

    def graha_sidereal_longitude(
        self, graha: PlanetName, dt_utc: datetime, ayanamsa: float
    ) -> float:
        """One standard graha's sidereal longitude — no speed, no other planets.

        The hot path for transit root-finds (ingress/return/conjunction probes),
        which only need a single longitude per evaluation. Byte-identical to the
        value `get_planetary_positions` produces for the same graha and instant.
        """
        t = self.ts.from_datetime(_to_utc(dt_utc))
        target = self.eph[self._STANDARD_TARGETS[graha]]
        apparent = self.eph["earth"].at(t).observe(target).apparent()
        _, lon, _ = apparent.ecliptic_latlon(epoch="date")
        return (float(lon.degrees) - ayanamsa) % 360

    def _mean_node_tropical(self, t: Any) -> float:
        """Mean ascending node longitude (deg, tropical of date) — Meeus."""
        tc = (float(t.tt) - 2451545.0) / 36525.0
        return (125.04452 - 1934.136261 * tc + 0.0020708 * tc**2 + (tc**3) / 450000) % 360

    def _true_node_tropical(self, t: Any) -> float:
        """True (osculating) ascending node from the Moon's state vector.

        Uses the geocentric Moon position r and velocity v in the
        ecliptic-of-date frame: angular momentum h = r x v, node direction
        n = z_hat x h, longitude = atan2(n_y, n_x). This is the rigorous
        oscillating node (~123.96 deg at J2000, mean +/- ~1.08 deg) — NOT
        `osculating_elements_of`, which resolves in the wrong frame.
        """
        geo = (self.eph["moon"] - self.eph["earth"]).at(t)
        r = geo.frame_xyz(ecliptic_frame).au
        v = geo.frame_xyz_and_velocity(ecliptic_frame)[1].au_per_d
        h = np.cross(r, v)
        n = np.cross(np.array([0.0, 0.0, 1.0]), h)
        return float(np.degrees(np.arctan2(n[1], n[0])) % 360)

    def _node_tropical(self, t: Any, node_type: NodeType) -> float:
        """Rahu's tropical-of-date ascending-node longitude for the model."""
        if node_type is NodeType.TRUE:
            return self._true_node_tropical(t)
        return self._mean_node_tropical(t)

    def _node_speed(self, t: Any, node_type: NodeType) -> float:
        """Rahu daily motion (deg/day) by one-day finite difference.

        Same two-instant method the nine standard grahas use: the mean node is
        ~-0.0529 deg/day (always retrograde); the TRUE node oscillates and is
        sometimes DIRECT, so the sign is derived, never assumed.
        """
        lon = self._node_tropical(t, node_type)
        lon_next = self._node_tropical(self.ts.tt_jd(t.tt + 1.0), node_type)
        return (lon_next - lon + 180) % 360 - 180

    def _get_lunar_node_positions(
        # Any: Skyfield's Time `t` is untyped; positions hold mixed astro fields.
        self,
        t: Any,
        ayanamsa: float,
        positions: dict[PlanetName, dict[str, Any]],
        node_type: NodeType,
    ) -> None:
        """Place Rahu/Ketu for the selected node model (Ketu = Rahu + 180)."""
        rahu_tropical = self._node_tropical(t, node_type)
        ketu_tropical = (rahu_tropical + 180) % 360
        speed = self._node_speed(t, node_type)

        for name, tropical in (
            (PlanetName.RAHU, rahu_tropical),
            (PlanetName.KETU, ketu_tropical),
        ):
            positions[name] = {
                "longitude": (tropical - ayanamsa) % 360,
                "latitude": 0.0,
                "distance": 1.0,
                "speed": speed,
                "is_retrograde": speed < 0,
            }

    def get_planetary_positions(
        self,
        dt_utc: datetime,
        ayanamsa: float,
        node_type: NodeType = NodeType.MEAN,
    ) -> dict[PlanetName, dict[str, Any]]:
        """Calculate positions for all 9 planets including nodes."""
        t = self.ts.from_datetime(_to_utc(dt_utc))
        earth = self.eph["earth"]
        positions: dict[PlanetName, dict[str, Any]] = {}

        self._get_standard_planet_positions(t, earth, ayanamsa, positions)
        self._get_lunar_node_positions(t, ayanamsa, positions, node_type)

        return positions

    def spica_chitra_ayanamsa(self, dt_utc: datetime) -> float:
        """True-Chitra ayanamsa = Spica apparent ecliptic longitude - 180 deg.

        Spica (Chitra) is forced to exactly 180.000 deg at the chart instant.
        Spica's apparent geocentric ecliptic longitude (of date) is computed in
        pure Skyfield from a `Star` with its ICRS position + proper motion
        (Hipparcos). Fail-closed: any failure raises rather than approximating.
        """
        t = self.ts.from_datetime(_to_utc(dt_utc))
        spica = Star(
            ra_hours=(13, 25, 11.579),
            dec_degrees=(-11, 9, 40.75),
            ra_mas_per_year=-42.50,
            dec_mas_per_year=-31.73,
            parallax_mas=13.06,
            radial_km_per_s=1.0,
        )
        apparent = self.eph["earth"].at(t).observe(spica).apparent()
        _, lon, _ = apparent.ecliptic_latlon(epoch="date")
        return (float(lon.degrees) - 180.0) % 360

    def calculate_lagna(self, dt_utc: datetime, lat: float, lon: float, ayanamsa: float) -> float:
        t = self.ts.from_datetime(_to_utc(dt_utc))
        gast = t.gast  # apparent sidereal time (nutation in), not GMST
        lst_deg = (gast * 15.0 + lon) % 360

        ramc_rad = math.radians(lst_deg)
        eps_rad = math.radians(self._true_obliquity_deg(dt_utc))  # true obliquity of date
        lat_rad = math.radians(lat)

        num = -math.cos(ramc_rad)
        den = (math.sin(ramc_rad) * math.cos(eps_rad)) + (math.tan(lat_rad) * math.sin(eps_rad))

        lagna_tropical = (math.degrees(math.atan2(num, den)) + 180) % 360
        logger.debug(f"LST: {lst_deg}, RAMC: {ramc_rad}, EPS: {eps_rad}, LAT: {lat_rad}")
        logger.debug(f"NUM: {num}, DEN: {den}, TROPICAL: {lagna_tropical}, AYANAMSA: {ayanamsa}")
        return (lagna_tropical - ayanamsa) % 360


# --- Astrological Helpers ---


def get_nakshatra_info(longitude: float) -> tuple[str, int, PlanetName]:
    idx = int((longitude % 360) / (360 / 27))
    name = NAKSHATRA_NAMES[idx]
    pada = int((longitude % (360 / 27)) / (360 / 27 / 4)) + 1
    lord = NAKSHATRA_LORDS[idx]
    return name, pada, lord


def get_dignity(planet: PlanetName, sign: ZodiacSign, lord: PlanetName) -> Dignity:
    """Sign dignity from the shared BPHS exaltation/debilitation tables."""
    if EXALTATION_SIGN.get(planet) == sign:
        return Dignity.EXALTED
    if DEBILITATION_SIGN.get(planet) == sign:
        return Dignity.DEBILITATED
    if lord == planet:
        return Dignity.OWN
    return Dignity.NEUTRAL


# --- Main API ---


# A Lagna within this many degrees of a sign boundary is "near a cusp": minutes
# of recorded birth time can flip the rising sign. Mirrors the UI's near-cusp
# threshold (apps/web/src/lib/lagnaCusp.ts) so the engine stays the single source
# of truth for the "Birth-time sensitivity" banner.
CUSP_THRESHOLD_DEG = 3.0


def _cusp_proximity(longitude: float) -> tuple[float, ZodiacSign, bool]:
    """Distance to the nearest sign boundary, the sign across it, and near-cusp.

    Mirrors the UI cusp contract (apps/web/src/lib/lagnaCusp.ts): a sign spans
    30 deg; ``to_lower`` is the distance back to this sign's 0 deg edge and
    ``to_upper`` the distance forward to its 30 deg edge. The NEARER edge wins
    (ties go to the lower edge); its neighbour is the PREVIOUS sign at the lower
    edge, the NEXT sign at the upper edge, and the zodiac wraps Aries<->Pisces.
    ``is_near_cusp`` is true when that distance is within ``CUSP_THRESHOLD_DEG``
    (inclusive). Pure: it only MEASURES the engine's longitude, never recomputes.
    """
    sign_idx = int((longitude % 360) // 30)
    sign_degrees = longitude % 30
    to_lower = sign_degrees
    to_upper = 30.0 - sign_degrees
    if to_lower <= to_upper:
        distance = to_lower
        adjacent_idx = (sign_idx - 1) % 12
    else:
        distance = to_upper
        adjacent_idx = (sign_idx + 1) % 12
    adjacent_sign = ZodiacSign(ZODIAC_SIGNS[adjacent_idx])
    return distance, adjacent_sign, distance <= CUSP_THRESHOLD_DEG


def _calculate_lagna_data(
    astro: SkyfieldAstronomy,
    dt_utc: datetime,
    latitude: float,
    longitude: float,
    ayanamsa: float,
) -> tuple[LagnaData, int]:
    """Calculate Lagna (Ascendant) and its sign index."""
    lagna_long = astro.calculate_lagna(dt_utc, latitude, longitude, ayanamsa)
    lagna_sign_idx = int(lagna_long // 30)
    lagna_sign = ZodiacSign(ZODIAC_SIGNS[lagna_sign_idx])
    n_name, n_pada, n_lord = get_nakshatra_info(lagna_long)
    cusp_distance, adjacent_sign, near_cusp = _cusp_proximity(lagna_long)

    lagna_data = LagnaData(
        longitude=lagna_long,
        sign=lagna_sign,
        sign_degrees=lagna_long % 30,
        sign_lord=SIGN_LORDS[lagna_sign],
        nakshatra=n_name,
        nakshatra_pada=n_pada,
        nakshatra_lord=n_lord,
        lagna_cusp_distance_deg=cusp_distance,
        lagna_adjacent_sign=adjacent_sign,
        is_near_cusp=near_cusp,
    )
    return lagna_data, lagna_sign_idx


def _combustion_fields(
    name: PlanetName, p_long: float, sun_long: float, retrograde: bool
) -> tuple[bool, float | None]:
    """(is_combust, separation) — separation is None where asta cannot apply."""
    if combustion_orb_deg(name, retrograde) is None:
        return False, None
    separation = combustion_separation_deg(p_long, sun_long)
    return is_combust(name, separation, retrograde), separation


def _build_planet_position(
    name: PlanetName,
    pos: dict[str, Any],
    sun_long: float,
    lagna_sign_idx: int,
) -> PlanetPosition:
    """Build a PlanetPosition object for a single planet."""
    p_long = pos["longitude"]
    sign_idx = int(p_long // 30)
    sign = ZodiacSign(ZODIAC_SIGNS[sign_idx])
    lagna_sign = ZodiacSign(ZODIAC_SIGNS[lagna_sign_idx])
    lord = SIGN_LORDS[sign]
    n_name, n_pada, n_lord = get_nakshatra_info(p_long)
    combust, separation = _combustion_fields(name, p_long, sun_long, pos["is_retrograde"])

    return PlanetPosition(
        name=name,
        longitude=p_long,
        latitude=pos["latitude"],
        distance=pos["distance"],
        speed=pos["speed"],
        is_retrograde=pos["is_retrograde"],
        sign=sign,
        sign_degrees=p_long % 30,
        sign_lord=lord,
        nakshatra=n_name,
        nakshatra_pada=n_pada,
        nakshatra_lord=n_lord,
        house=(sign_idx - lagna_sign_idx + 12) % 12 + 1,
        dignity=get_dignity(name, sign, lord),
        is_combust=combust,
        combustion_separation_deg=separation,
        houses_ruled=houses_ruled(name, lagna_sign),
        is_yogakaraka=yogakaraka_planet(lagna_sign) == name,
    )


def _calculate_planetary_positions(
    astro: SkyfieldAstronomy,
    dt_utc: datetime,
    ayanamsa: float,
    lagna_sign_idx: int,
    node_type: NodeType,
) -> dict[PlanetName, PlanetPosition]:
    """Calculate positions for all planets."""
    raw_positions = astro.get_planetary_positions(dt_utc, ayanamsa, node_type)
    sun_long = raw_positions[PlanetName.SUN]["longitude"]

    return {
        name: _build_planet_position(name, pos, sun_long, lagna_sign_idx)
        for name, pos in raw_positions.items()
    }


def _calculate_house_data(lagna_sign_idx: int) -> dict[int, HouseCuspData]:
    """Build the 12 whole-sign houses (system: ``HOUSE_SYSTEM``).

    Whole-sign means each house IS one full 30 deg sign, so every
    ``HouseCuspData.longitude`` is the sign-start (a 30 deg multiple), NOT an
    interpolated quadrant cusp. The 1st house is the whole sign of the Lagna.
    """
    houses = {}
    for i in range(1, 13):
        h_sign_idx = (lagna_sign_idx + i - 1) % 12
        h_sign = ZodiacSign(ZODIAC_SIGNS[h_sign_idx])
        houses[i] = HouseCuspData(
            house=i,
            longitude=h_sign_idx * 30.0,
            sign=h_sign,
            sign_lord=SIGN_LORDS[h_sign],
        )
    return houses


def _navamsa_planet(name: PlanetName, position: PlanetPosition) -> VargaPlanet:
    """The graha's D9 navamsa placement (sign + lord), carrying the D1 combustion.

    Combustion is a D1 fact (real longitude vs the Sun); the navamsa CARRIES the
    natal ``is_combust`` verbatim rather than recomputing it per varga.
    """
    sign = navamsa_sign(position.longitude)
    return VargaPlanet(
        name=name,
        sign=sign,
        sign_lord=SIGN_LORDS[sign],
        is_combust=position.is_combust,
    )


def _calculate_navamsa(
    lagna_long: float, planets: dict[PlanetName, PlanetPosition]
) -> NavamsaChart:
    """Build the D9 Navamsa chart from rasi longitudes (BPHS navamsa rule)."""
    lagna_sign = navamsa_sign(lagna_long)
    return NavamsaChart(
        lagna_sign=lagna_sign,
        lagna_sign_lord=SIGN_LORDS[lagna_sign],
        planets={n: _navamsa_planet(n, p) for n, p in planets.items()},
    )


def _resolve_ayanamsa(
    astro: SkyfieldAstronomy, dt_utc: datetime, ayanamsa_type: AyanamsaType
) -> float:
    """Ayanamsa for the chosen convention; fail-closed on anything unknown.

    LAHIRI uses the official Chitrapaksha daily lookup table (IAE / Rashtriya
    Panchang), which matches published Swiss-Ephemeris Lahiri to ~0.0001 deg and
    is the engine's primary source. The rigorous IAU 2006 `get_ayanamsa` formula
    is shipped as an auditable cross-check (validated < 0.004 deg of the table,
    1900-2050) rather than the runtime source, since the table is the closer
    match to the established reference.
    """
    if ayanamsa_type is AyanamsaType.LAHIRI:
        t = astro.ts.from_datetime(_to_utc(dt_utc))
        return ayanamsa_calc.get_ayanamsa(t.tt)
    if ayanamsa_type is AyanamsaType.TRUE_CHITRA:
        return astro.spica_chitra_ayanamsa(dt_utc)
    raise NotImplementedError(f"Unsupported ayanamsa_type: {ayanamsa_type}")


def calculate_sidereal_context(
    dt_utc: datetime,
    latitude: float,
    longitude: float,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
    reference_date: datetime | None = None,
    astronomy: SkyfieldAstronomy | None = None,
) -> SiderealContext:
    """
    Orchestrate full sidereal context calculation.
    Target function size: < 30 lines.

    `ayanamsa_type` selects LAHIRI (official, default) vs TRUE_CHITRA (Spica
    forced to 180.000 deg). `node_type` selects the mean (default) vs true
    lunar node. `reference_date` selects which Vimshottari maha dasha is
    "current"; when None it defaults to the wall clock, but callers that need
    reproducible output (browser parity, content-addressed bundles) must pass
    it explicitly. `astronomy` is an optional pre-warmed SkyfieldAstronomy
    instance; when provided it is reused (avoids repeated de421 loads for
    multi-candidate scoring). Default None = unchanged single-call behavior.
    """
    validate_coordinates(latitude, longitude)
    # Normalize to a true UTC instant (CONVERT aware datetimes; never relabel).
    dt_utc = _to_utc(dt_utc)

    astro = astronomy if astronomy is not None else SkyfieldAstronomy()
    ayanamsa = _resolve_ayanamsa(astro, dt_utc, ayanamsa_type)

    # Stages
    lagna_data, lagna_sign_idx = _calculate_lagna_data(astro, dt_utc, latitude, longitude, ayanamsa)
    planets = _calculate_planetary_positions(astro, dt_utc, ayanamsa, lagna_sign_idx, node_type)
    houses = _calculate_house_data(lagna_sign_idx)
    dashas = calculate_vimshottari_dashas(
        planets[PlanetName.MOON].longitude, dt_utc, reference_date=reference_date
    )

    context = SiderealContext(
        ayanamsa_value=ayanamsa,
        lagna=lagna_data,
        planets=planets,
        houses=houses,
        dashas=dashas,
        yogas=[],
        navamsa=_calculate_navamsa(lagna_data.longitude, planets),
    )
    context.yogas = detect_yogas(context)

    return context


# --- Dasha Calculation ---


def _dasha_balance_at_birth(moon_long: float) -> tuple[PlanetName, float]:
    """Return the lord running at birth and the years left in its maha dasha."""
    idx = int((moon_long % 360) / (360 / 27))
    start_lord = NAKSHATRA_LORDS[idx]
    portion_consumed = (moon_long - idx * (360 / 27)) / (360 / 27)
    remaining_years = DASHA_YEARS[start_lord] * (1 - portion_consumed)
    return start_lord, remaining_years


def _build_maha_sequence(
    start_lord: PlanetName,
    remaining_years: float,
    birth_dt: datetime,
    days_per_year: float,
) -> list[DashaPeriod]:
    """Build the 9 maha-dasha periods: the partial balance, then the full cycle."""
    lord_idx = DASHA_SEQUENCE.index(start_lord)
    periods: list[DashaPeriod] = []
    curr_start = birth_dt
    for offset in range(9):
        lord = start_lord if offset == 0 else DASHA_SEQUENCE[(lord_idx + offset) % 9]
        years = remaining_years if offset == 0 else DASHA_YEARS[lord]
        curr_end = curr_start + timedelta(days=years * days_per_year)
        periods.append(
            DashaPeriod(lord=lord, start_date=curr_start, end_date=curr_end, duration_years=years)
        )
        curr_start = curr_end
    return periods


def _resolve_reference_instant(reference_date: datetime | None) -> datetime:
    """The instant whose containing maha dasha is "current" (default = now, UTC)."""
    ref = reference_date if reference_date is not None else datetime.now(UTC)
    return ref if ref.tzinfo is not None else ref.replace(tzinfo=UTC)


def _subdivide_period(parent: DashaPeriod) -> list[DashaPeriod]:
    """The 9 sub-periods of ``parent``, each a fraction of the parent's ACTUAL
    span (so they tile it exactly under whatever year convention built it). The
    sub-sequence starts from the parent lord; the proportions are DASHA_YEARS/120.

    ``duration_years`` on each sub-row is the row's OWN length in dasha-years
    (``parent.duration_years * fraction``) — the same actual-span semantics the
    maha rows carry (cf. the partial birth-balance maha) — never the sub-lord's
    nominal cycle years, which are only the proportion numerator.
    """
    parent_span = parent.end_date - parent.start_date
    lord_idx = DASHA_SEQUENCE.index(parent.lord)
    subs: list[DashaPeriod] = []
    curr_start = parent.start_date
    for offset in range(9):
        lord = DASHA_SEQUENCE[(lord_idx + offset) % 9]
        fraction = DASHA_YEARS[lord] / 120.0
        curr_end = curr_start + parent_span * fraction
        subs.append(
            DashaPeriod(
                lord=lord,
                start_date=curr_start,
                end_date=curr_end,
                duration_years=parent.duration_years * fraction,
            )
        )
        curr_start = curr_end
    return subs


_BOUNDARY_EPSILON = timedelta(microseconds=1)


def _at_final_boundary(last: DashaPeriod, ref: datetime) -> bool:
    """True if ``ref`` lands within one microsecond past ``last``'s end.

    Float-edge care (cf. the near-cusp sub-microsecond maha boundary): accumulated
    float drift must never drop an instant that is "really" inside the period.
    """
    return timedelta(0) <= (ref - last.end_date) < _BOUNDARY_EPSILON


def _contains(period: DashaPeriod, ref: datetime) -> bool:
    """True if ``ref`` is inside ``period`` on a half-open [start, end) interval."""
    return period.start_date <= ref < period.end_date


def _active_period(periods: list[DashaPeriod], ref: datetime) -> DashaPeriod | None:
    """The period in ``periods`` containing ``ref`` (half-open), else None."""
    contained = [p for p in periods if _contains(p, ref)]
    if contained:
        return contained[0]
    return _final_boundary_period(periods, ref)


def _final_boundary_period(periods: list[DashaPeriod], ref: datetime) -> DashaPeriod | None:
    """The last period iff ``ref`` sits within one microsecond of its end."""
    if not periods:
        return None
    return periods[-1] if _at_final_boundary(periods[-1], ref) else None


def _active_subperiods(
    curr_maha: DashaPeriod | None, ref: datetime
) -> tuple[DashaPeriod | None, DashaPeriod | None]:
    """Active (antardasha, pratyantardasha) for the active maha at ``ref``."""
    if curr_maha is None:
        return None, None
    curr_antar = _active_period(_subdivide_period(curr_maha), ref)
    if curr_antar is None:
        return None, None
    curr_pratyantar = _active_period(_subdivide_period(curr_antar), ref)
    return curr_antar, curr_pratyantar


def _with_antar_sequence(maha: DashaPeriod) -> MahaDashaPeriod:
    """A maha row enriched with its nine dated antardashas.

    Uses the SAME ``_subdivide_period`` math (and thus convention) as the
    active-leg search, so ``current_antar`` always appears in its maha row's
    ``antar_sequence`` with byte-identical dates.
    """
    return MahaDashaPeriod(
        lord=maha.lord,
        start_date=maha.start_date,
        end_date=maha.end_date,
        duration_years=maha.duration_years,
        antar_sequence=_subdivide_period(maha),
    )


def calculate_vimshottari_dashas(
    moon_long: float,
    birth_dt: datetime,
    convention: DashaYearConvention = DEFAULT_DASHA_YEAR_CONVENTION,
    reference_date: datetime | None = None,
) -> VimshottariDashaData:
    """Vimshottari maha sequence + the three active levels at ``reference_date``.

    All levels (maha, antar, pratyantar) use the SAME declared ``convention`` —
    each sub-period is a fraction of its parent's actual span, so they tile
    exactly (no mixed-convention drift). ``reference_date`` is the injectable
    "now"; nothing below the entrypoint reads the wall clock when it is passed,
    keeping the chart deterministic for byte-parity. The chosen ``convention``
    is recorded on the output so it is never silently switched.

    Period intelligence (additive): every maha row carries its nine dated
    antardashas (the 81-row life tree) and ``pratyantar_sequence`` dates the
    current antar's nine pratyantardashas — ``None`` exactly when
    ``current_antar`` is ``None`` — so the product can speak about the current
    period and all future periods with engine-stated dates.
    """
    start_lord, remaining_years = _dasha_balance_at_birth(moon_long)
    periods = _build_maha_sequence(start_lord, remaining_years, birth_dt, convention.days_per_year)
    ref = _resolve_reference_instant(reference_date)
    curr_maha = _active_period(periods, ref)
    curr_antar, curr_pratyantar = _active_subperiods(curr_maha, ref)
    return VimshottariDashaData(
        maha_dasha_sequence=[_with_antar_sequence(period) for period in periods],
        current_maha=curr_maha,
        current_antar=curr_antar,
        current_pratyantar=curr_pratyantar,
        pratyantar_sequence=None if curr_antar is None else _subdivide_period(curr_antar),
        convention=convention,
    )


# --- Yoga Detection (Simplified) ---


def detect_yogas(context: SiderealContext) -> list[YogaData]:
    """
    Detect yogas via the audited classical rule engine (almamesh.yogas).

    Degrades gracefully on a KNOWN rule defect: a malformed yoga rule
    (`YogaRuleError`) yields an empty yoga list with a logged warning, so the
    rest of the chart (planets/houses/dasha) still generates correctly — a
    single broken rule must never nuke the whole chart. Yogas degrade visibly
    (empty), not silently. Truly unexpected errors are NOT caught: they
    propagate and fail loud, per the calculation-integrity mandate.
    """
    from almamesh.yogas.engine import YogaRuleError, create_yoga_engine

    try:
        engine = create_yoga_engine(context)
        return engine.evaluate_all_yogas()
    except ImportError:
        logger.warning("Yoga engine not available, returning empty list")
        return []
    except YogaRuleError:
        logger.warning(
            "Yoga rule defect during detection; degrading to empty yoga list "
            "(planets/houses/dasha unaffected)",
            exc_info=True,
        )
        return []
