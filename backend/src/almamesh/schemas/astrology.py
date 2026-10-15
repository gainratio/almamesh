"""Astrological Pydantic models for AlmaMesh."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from almamesh.constants.astrology import (
    Dignity,
    PlanetName,
    ZodiacSign,
)
from almamesh.dasha.convention import (
    DEFAULT_DASHA_YEAR_CONVENTION,
    DashaYearConvention,
)

# Explicit re-exports for mypy
__all__ = [
    # Re-exported from constants
    "PlanetName",
    "ZodiacSign",
    "Dignity",
    # Models
    "PlanetPosition",
    "LagnaData",
    "HouseCuspData",
    "DashaPeriod",
    "MahaDashaPeriod",
    "VimshottariDashaData",
    "YogaGrade",
    "YogaStrengthFactor",
    "YogaFormationRule",
    "YogaData",
    "VargaPlanet",
    "NavamsaChart",
    "SiderealContext",
]


class PlanetPosition(BaseModel):
    name: PlanetName
    longitude: float
    latitude: float = 0.0
    distance: float = 0.0
    speed: float = 0.0
    is_retrograde: bool = False
    sign: ZodiacSign
    sign_degrees: float
    sign_lord: PlanetName
    nakshatra: str
    nakshatra_pada: int
    nakshatra_lord: PlanetName
    house: int
    dignity: Dignity = Dignity.NEUTRAL
    # Combustion (asta): computed from the angular separation to the Sun using
    # the classical orbs in ``almamesh.yogas.combustion``. The separation is
    # surfaced so no consumer (UI/LLM) ever re-derives it; None for the Sun
    # itself and for the nodes (asta does not apply to them).
    is_combust: bool = False
    combustion_separation_deg: float | None = None
    # Whole-sign lordship from the lagna (``almamesh.yogas.lordship``); empty
    # for Rahu/Ketu, which lord no sign in the Parashari scheme. Emitted so
    # downstream consumers (UI/LLM) never derive lordships themselves.
    houses_ruled: list[int] = []
    # True when this graha lords both a kendra (4/7/10) and a trikona (5/9)
    # from the lagna (BPHS, Yogakaraka adhyaya).
    is_yogakaraka: bool = False


class LagnaData(BaseModel):
    longitude: float
    sign: ZodiacSign
    sign_degrees: float
    sign_lord: PlanetName
    nakshatra: str
    nakshatra_pada: int
    nakshatra_lord: PlanetName
    # --- Cusp proximity: the single source of truth for the UI's near-cusp
    # "Birth-time sensitivity" banner (mirrors apps/web/src/lib/lagnaCusp.ts).
    # The engine ALWAYS populates these; the additive defaults exist only so
    # partial test constructions still validate (cf. ``navamsa: ... = None``). ---
    # Degrees from the Lagna to the NEAREST 0/30 deg sign boundary.
    lagna_cusp_distance_deg: float = 0.0
    # The sign across that nearest boundary (previous at the lower edge, next at
    # the upper). None only on a partial construction that omitted it.
    lagna_adjacent_sign: ZodiacSign | None = None
    # True when ``lagna_cusp_distance_deg`` is within the near-cusp threshold (~3 deg).
    is_near_cusp: bool = False


class HouseCuspData(BaseModel):
    """One whole-sign house (see ``almamesh.calculations.HOUSE_SYSTEM``).

    Houses are whole-sign: each house IS one full 30 deg sign. ``longitude`` is
    therefore the **sign-start** (always a 30 deg multiple), NOT an interpolated
    Placidus/Koch quadrant cusp. Despite the legacy name "Cusp", no quadrant
    cusp interpolation is performed.
    """

    house: int
    longitude: float  # sign-start (30 deg multiple), not a quadrant cusp
    sign: ZodiacSign
    sign_lord: PlanetName


class DashaPeriod(BaseModel):
    """One dasha row. ``cycle_start`` is set only on a row clipped at birth.

    The native is born part-way through a maha (and an antar, a pratyantar): such a
    row starts at birth, and ``cycle_start`` is where the full period began before
    birth, so its sub-periods keep their full lengths. In-process only (excluded
    from the payload); every row's dates are already final.
    """

    lord: PlanetName
    start_date: datetime
    end_date: datetime
    duration_years: float
    cycle_start: datetime | None = Field(default=None, exclude=True)


class MahaDashaPeriod(DashaPeriod):
    """A maha-dasha row enriched with its nine dated antardashas.

    ``antar_sequence`` is the maha's full antar breakdown: each entry is a plain
    :class:`DashaPeriod` built by the SAME proportional subdivision (and year
    convention) the active-leg search uses, so the payload's ``current_antar``
    always appears in its maha row with byte-identical dates. ``duration_years``
    means the same thing at EVERY level: the row's own actual span in
    dasha-years (a ~3.17-year Venus antar inside a 19-year Saturn maha carries
    ~3.17, never Venus's nominal 20 — the nominal years are only the proportion
    numerator), exactly like the partial birth-balance maha row does. Frozen:
    rows are emitted once by the engine and never mutated downstream.
    """

    model_config = ConfigDict(frozen=True)

    antar_sequence: list[DashaPeriod]


class VimshottariDashaData(BaseModel):
    """Vimshottari dasha output: the dated life tree + the three active levels.

    ``maha_dasha_sequence`` holds nine :class:`MahaDashaPeriod` rows, each
    carrying its nine dated antardashas (9 x 9 = 81 rows — the whole life at
    antar depth), so the UI/LLM can speak about the CURRENT period and ALL
    FUTURE periods with engine-stated dates. ``pratyantar_sequence`` dates the
    nine pratyantardashas of the CURRENT antar; it is ``None`` exactly when
    ``current_antar`` is ``None`` (reference instant outside the covered
    120-year cycle). ``convention`` records WHICH dasha-year length built every
    period (Gregorian 365.2425 / Julian 365.25 / Savana 360). It is surfaced
    explicitly so the convention is never silently switched and so the
    UI/report/LLM can cite it.
    """

    maha_dasha_sequence: list[MahaDashaPeriod]
    current_maha: DashaPeriod | None = None
    current_antar: DashaPeriod | None = None
    current_pratyantar: DashaPeriod | None = None
    # The current antar's nine dated pratyantardashas (additive field).
    pratyantar_sequence: list[DashaPeriod] | None = None
    # The declared year convention used for every period above (additive field).
    convention: DashaYearConvention = DEFAULT_DASHA_YEAR_CONVENTION


# Qualitative yoga grade + a CALIBRATED structural strength %. The banned thing
# was never "a percentage" — it was the old "effective_strength 77.9": an
# UN-calibrated, HIDDEN, false-precise number that multiplied a base score by a
# STUB shadbala ratio (real Shadbala lives in the lazy strength context, never
# on the natal path). What is now REQUIRED instead: strength_pct is anchored to
# the yoga's own max-favorable/max-unfavorable mark lattice (yogas/factors.py),
# monotonic, chart-invariant, golden-locked, and tagged strength_tier="structural"
# so it never implies empirical validity (a Layer-2 MODEL output, not a measured
# fact). STILL FORBIDDEN: any hidden or uncalibrated magnitude, and any per-signal
# numeric that isn't auditable to its ledger.
YogaGrade = Literal["strong", "moderate", "weak"]

# The only factor kinds a yoga grade may cite: each is real, computable from
# the natal positions, and classically grounded (see almamesh.yogas.factors).
YogaFactorType = Literal["dignity", "combustion", "retrograde", "house_class"]


class YogaStrengthFactor(BaseModel):
    """One real, observed factor behind a yoga's qualitative grade."""

    factor_type: YogaFactorType
    planet: PlanetName
    value: str  # the observed value, e.g. "exalted", "combust (3.2 deg from Sun)"
    basis: str  # human-readable classical basis for counting this factor
    # The signed ±1 this factor contributes to the yoga's net marks (0 = neutral).
    # Additive with a default so older stored payloads still validate; the marks
    # across a yoga's factors sum EXACTLY to ``YogaData.net_marks``.
    mark: int = 0


class YogaFormationRule(BaseModel):
    """An explicit formation clause that fired, with its classical source.

    Every emitted yoga names WHICH condition formed it, for WHICH planets and
    houses — a yoga with no trace is schema-impossible (see ``YogaData``).
    """

    rule: str  # machine id, e.g. "neecha_bhanga.dispositor_in_kendra"
    description: str  # e.g. "Dispositor Saturn ... in a kendra (4th) from Lagna"
    source: str  # classical citation
    planets: list[PlanetName] = []
    houses: list[int] = []


class YogaData(BaseModel):
    """A detected yoga with a complete, honest trace.

    ``min_length=1`` on every trace list makes a trace-less yoga (the old
    empty-Neechabhanga bug) impossible at the schema level — fail loud.
    """

    name: str
    display_name: str
    category: str
    description: str
    effects: str
    grade: YogaGrade
    strength_factors: list[YogaStrengthFactor] = Field(min_length=1)
    # --- Calibrated structural strength (rigor-upgrade §A.1, Tier S). All
    # additive with defaults so older stored payloads still validate. ``net_marks``
    # is the signed favorable-minus-unfavorable count over the involved planets;
    # ``max_favorable``/``max_unfavorable`` are the yoga's OWN achievable range
    # (per-planet dignity/house/retrograde-or-combust where applicable), so the %
    # is chart-invariant rather than yoga-size-dependent. ``strength_pct`` is the
    # linear anchor 100·(net + max_unfavorable)/(max_favorable + max_unfavorable).
    # ``strength_tier`` is always "structural": a Layer-2 MODEL output over the
    # uniform ±1 mark lattice, NEVER an empirically-measured fact. ---
    net_marks: int = 0
    max_favorable: int = 0
    max_unfavorable: int = 0
    strength_pct: float = 0.0
    strength_tier: Literal["structural"] = "structural"
    planets_involved: list[PlanetName] = Field(min_length=1)
    houses_involved: list[int] = Field(min_length=1)
    planetary_signature: str
    formation_rules: list[YogaFormationRule] = Field(min_length=1)


class VargaPlanet(BaseModel):
    """A graha's placement in a divisional (varga) chart: sign + its lord.

    A varga maps a continuous longitude onto a sign only — there is no
    independent ``sign_degrees`` in a divisional chart — so this is a slimmer
    model than ``PlanetPosition``.
    """

    name: PlanetName
    sign: ZodiacSign
    sign_lord: PlanetName
    # Combustion (asta) is a D1 graha-level fact (real longitude vs the Sun),
    # independent of the division — so the SAME flag the natal ``PlanetPosition``
    # carries is copied verbatim onto every varga placement (never recomputed).
    # False for the Sun and the nodes, exactly as on the natal chart.
    is_combust: bool = False


class NavamsaChart(BaseModel):
    """The D9 Navamsa divisional chart: each graha's navamsa sign + the lagna.

    Derived deterministically from the rasi (D1) longitudes via the BPHS
    navamsa rule (``almamesh.navamsa``). ``name`` is the varga label ("D9").
    """

    name: str = "D9"
    lagna_sign: ZodiacSign
    lagna_sign_lord: PlanetName
    planets: dict[PlanetName, VargaPlanet]


class SiderealContext(BaseModel):
    ayanamsa_value: float
    lagna: LagnaData
    planets: dict[PlanetName, PlanetPosition]
    houses: dict[int, HouseCuspData]
    dashas: VimshottariDashaData
    yogas: list[YogaData]
    # D9 Navamsa divisional chart (additive; D1 fields stay byte-stable).
    navamsa: NavamsaChart | None = None

    def get_planet(self, planet: PlanetName | str) -> PlanetPosition | None:
        """Get planet position by name (for yogas module compatibility)."""
        if isinstance(planet, str):
            try:
                planet_key = PlanetName(planet.lower())
            except ValueError:
                return None
        else:
            planet_key = planet
        return self.planets.get(planet_key)


# --- Type Aliases for Yogas Module Compatibility ---
ComprehensiveAstrologicalData = SiderealContext
