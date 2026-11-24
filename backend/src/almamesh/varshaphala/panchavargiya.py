"""Panchavargiya Bala (5-fold Tajaka strength) and Varshesha (Year Lord)."""

from __future__ import annotations

from almamesh.constants.astrology import SIGN_LORDS, ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.varshaphala import PanchavargiyaBala, VarsheshaCandidate

CLASSICAL_GRAHAS: tuple[PlanetName, ...] = (
    PlanetName.SUN,
    PlanetName.MOON,
    PlanetName.MARS,
    PlanetName.MERCURY,
    PlanetName.JUPITER,
    PlanetName.VENUS,
    PlanetName.SATURN,
)

# Exact BPHS exaltation longitudes (degrees 0..360); debilitation is +180 deg.
_EXALTATION_DEG: dict[PlanetName, float] = {
    PlanetName.SUN: 10.0,
    PlanetName.MOON: 33.0,
    PlanetName.MARS: 298.0,
    PlanetName.MERCURY: 165.0,
    PlanetName.JUPITER: 95.0,
    PlanetName.VENUS: 357.0,
    PlanetName.SATURN: 200.0,
}

# Natural planetary friendships (Naisargika Maitri) per BPHS / Tajaka Nilakanthi.
_NATURAL_FRIENDS: dict[PlanetName, frozenset[PlanetName]] = {
    PlanetName.SUN: frozenset({PlanetName.MOON, PlanetName.MARS, PlanetName.JUPITER}),
    PlanetName.MOON: frozenset({PlanetName.SUN, PlanetName.MERCURY}),
    PlanetName.MARS: frozenset({PlanetName.SUN, PlanetName.MOON, PlanetName.JUPITER}),
    PlanetName.MERCURY: frozenset({PlanetName.SUN, PlanetName.VENUS}),
    PlanetName.JUPITER: frozenset({PlanetName.SUN, PlanetName.MOON, PlanetName.MARS}),
    PlanetName.VENUS: frozenset({PlanetName.MERCURY, PlanetName.SATURN}),
    PlanetName.SATURN: frozenset({PlanetName.MERCURY, PlanetName.VENUS}),
}

_NATURAL_ENEMIES: dict[PlanetName, frozenset[PlanetName]] = {
    PlanetName.SUN: frozenset({PlanetName.VENUS, PlanetName.SATURN}),
    PlanetName.MOON: frozenset(),
    PlanetName.MARS: frozenset({PlanetName.MERCURY}),
    PlanetName.MERCURY: frozenset({PlanetName.MOON}),
    PlanetName.JUPITER: frozenset({PlanetName.MERCURY, PlanetName.VENUS}),
    PlanetName.VENUS: frozenset({PlanetName.SUN, PlanetName.MOON}),
    PlanetName.SATURN: frozenset({PlanetName.SUN, PlanetName.MOON, PlanetName.MARS}),
}

# Egyptian terms (Hadda) used in classical Tajaka Nilakanthi: (end_deg, lord).
_HADDA_TERMS: tuple[tuple[tuple[float, PlanetName], ...], ...] = (
    (
        (6, PlanetName.JUPITER),
        (12, PlanetName.VENUS),
        (20, PlanetName.MERCURY),
        (25, PlanetName.MARS),
        (30, PlanetName.SATURN),
    ),
    (
        (8, PlanetName.VENUS),
        (14, PlanetName.MERCURY),
        (22, PlanetName.JUPITER),
        (27, PlanetName.SATURN),
        (30, PlanetName.MARS),
    ),
    (
        (6, PlanetName.MERCURY),
        (12, PlanetName.JUPITER),
        (17, PlanetName.VENUS),
        (24, PlanetName.MARS),
        (30, PlanetName.SATURN),
    ),
    (
        (7, PlanetName.MARS),
        (13, PlanetName.VENUS),
        (19, PlanetName.MERCURY),
        (26, PlanetName.JUPITER),
        (30, PlanetName.SATURN),
    ),
    (
        (6, PlanetName.JUPITER),
        (11, PlanetName.VENUS),
        (18, PlanetName.SATURN),
        (24, PlanetName.MERCURY),
        (30, PlanetName.MARS),
    ),
    (
        (7, PlanetName.MERCURY),
        (17, PlanetName.VENUS),
        (21, PlanetName.JUPITER),
        (28, PlanetName.MARS),
        (30, PlanetName.SATURN),
    ),
    (
        (6, PlanetName.SATURN),
        (14, PlanetName.MERCURY),
        (21, PlanetName.JUPITER),
        (28, PlanetName.VENUS),
        (30, PlanetName.MARS),
    ),
    (
        (7, PlanetName.MARS),
        (11, PlanetName.VENUS),
        (19, PlanetName.MERCURY),
        (24, PlanetName.JUPITER),
        (30, PlanetName.SATURN),
    ),
    (
        (12, PlanetName.JUPITER),
        (17, PlanetName.VENUS),
        (21, PlanetName.MERCURY),
        (26, PlanetName.SATURN),
        (30, PlanetName.MARS),
    ),
    (
        (7, PlanetName.MERCURY),
        (14, PlanetName.JUPITER),
        (22, PlanetName.VENUS),
        (26, PlanetName.SATURN),
        (30, PlanetName.MARS),
    ),
    (
        (7, PlanetName.MERCURY),
        (13, PlanetName.VENUS),
        (20, PlanetName.JUPITER),
        (25, PlanetName.MARS),
        (30, PlanetName.SATURN),
    ),
    (
        (12, PlanetName.VENUS),
        (16, PlanetName.JUPITER),
        (19, PlanetName.MERCURY),
        (28, PlanetName.MARS),
        (30, PlanetName.SATURN),
    ),
)

# Tri-Rashi Pati by sign element (sign_idx % 4): (day_lord, night_lord).
_TRI_RASHI_LORDS: tuple[tuple[PlanetName, PlanetName], ...] = (
    (PlanetName.SUN, PlanetName.JUPITER),  # Fire: Aries, Leo, Sagittarius
    (PlanetName.VENUS, PlanetName.MOON),  # Earth: Taurus, Virgo, Capricorn
    (PlanetName.SATURN, PlanetName.MERCURY),  # Air: Gemini, Libra, Aquarius
    (PlanetName.VENUS, PlanetName.MARS),  # Water: Cancer, Scorpio, Pisces
)

_TAJAKA_ASPECT_HOUSES: frozenset[int] = frozenset({1, 3, 4, 5, 7, 9, 10, 11})


def _relation_factor(graha: PlanetName, lord: PlanetName) -> float:
    """Return Tajaka dignity fraction: own=1.0, friend=0.75, neutral=0.5, enemy=0.25."""
    if graha is lord:
        return 1.0
    if lord in _NATURAL_FRIENDS[graha]:
        return 0.75
    if lord in _NATURAL_ENEMIES[graha]:
        return 0.25
    return 0.5


def _hadda_lord(sign_idx: int, sign_deg: float) -> PlanetName:
    """Egyptian Hadda (term) lord for a sign index (0..11) and degree (0..30)."""
    for limit, lord in _HADDA_TERMS[sign_idx]:
        if sign_deg < limit:
            return lord
    return _HADDA_TERMS[sign_idx][-1][1]


def _drekkana_lord(sign_idx: int, sign_deg: float) -> PlanetName:
    """Parashari Drekkana (1st/5th/9th sign) lord."""
    decanate = min(int(sign_deg // 10.0), 2)
    target_sign = ZodiacSign(ZODIAC_SIGNS[(sign_idx + decanate * 4) % 12])
    return SIGN_LORDS[target_sign]


def _navamsa_lord(lon: float) -> PlanetName:
    """Navamsa sign lord from sidereal longitude (0..360)."""
    navamsa_idx = int((lon % 360.0) / (30.0 / 9.0)) % 12
    return SIGN_LORDS[ZodiacSign(ZODIAC_SIGNS[navamsa_idx])]


def _uchcha_bala(graha: PlanetName, lon: float) -> float:
    """Uchcha (exaltation) strength in 0..20 range."""
    debil = (_EXALTATION_DEG[graha] + 180.0) % 360.0
    diff = abs(((lon - debil + 180.0) % 360.0) - 180.0)
    return round(diff / 9.0, 2)


def _dignity_band(total: float) -> str:
    """Classify 0..20 Panchavargiya Virupa total into a clear band."""
    if total >= 10.0:
        return "strong"
    if total >= 5.0:
        return "moderate"
    return "weak"


def compute_planet_panchavargiya(graha: PlanetName, lon: float) -> PanchavargiyaBala:
    """Compute the 5-fold Tajaka strength for one classical graha."""
    sign_idx = int((lon % 360.0) // 30.0)
    sign_deg = lon % 30.0
    rasi_lord = SIGN_LORDS[ZodiacSign(ZODIAC_SIGNS[sign_idx])]

    kshetra = round(30.0 * _relation_factor(graha, rasi_lord), 2)
    uchcha = _uchcha_bala(graha, lon)
    hadda = round(15.0 * _relation_factor(graha, _hadda_lord(sign_idx, sign_deg)), 2)
    drekkana = round(10.0 * _relation_factor(graha, _drekkana_lord(sign_idx, sign_deg)), 2)
    navamsa = round(5.0 * _relation_factor(graha, _navamsa_lord(lon)), 2)
    total = round((kshetra + uchcha + hadda + drekkana + navamsa) / 4.0, 2)
    band = _dignity_band(total)
    return PanchavargiyaBala(
        kshetra=kshetra,
        uchcha=uchcha,
        hadda=hadda,
        drekkana=drekkana,
        navamsa=navamsa,
        total=total,
        dignity_band=band,  # type: ignore[arg-type]
    )


def compute_panchavargiya_bala(
    varsha_chart: SiderealContext,
) -> dict[PlanetName, PanchavargiyaBala]:
    """Compute Panchavargiya Bala for all 7 classical grahas in the Varsha chart."""
    return {
        graha: compute_planet_panchavargiya(graha, varsha_chart.planets[graha].longitude)
        for graha in CLASSICAL_GRAHAS
    }


def tri_rashi_lord(varsha_lagna_sign: ZodiacSign, is_day_chart: bool) -> PlanetName:
    """Tri-Rashi Pati for the Varsha Lagna sign and day/night polarity."""
    sign_idx = ZODIAC_SIGNS.index(varsha_lagna_sign.value)
    day_lord, night_lord = _TRI_RASHI_LORDS[sign_idx % 4]
    return day_lord if is_day_chart else night_lord


def din_ratri_lord(varsha_chart: SiderealContext, is_day_chart: bool) -> PlanetName:
    """Day-Night lord: Varsha Sun's sign lord by day, Moon's sign lord by night."""
    anchor = PlanetName.SUN if is_day_chart else PlanetName.MOON
    return SIGN_LORDS[varsha_chart.planets[anchor].sign]


def _collect_roles(office_map: list[tuple[str, PlanetName]]) -> dict[PlanetName, list[str]]:
    """Group Panchadhikari office role names by planet."""
    grouped: dict[PlanetName, list[str]] = {}
    for role, graha in office_map:
        grouped.setdefault(graha, []).append(role)
    return grouped


def determine_varshesha(
    natal: SiderealContext,
    varsha_chart: SiderealContext,
    muntha_lord: PlanetName,
    is_day_chart: bool,
    strengths: dict[PlanetName, PanchavargiyaBala],
) -> tuple[PlanetName, list[VarsheshaCandidate]]:
    """Select the Varshesha (Year Lord) among the five Panchadhikaris."""
    offices = [
        ("muntha_lord", muntha_lord),
        ("birth_lagna_lord", SIGN_LORDS[natal.lagna.sign]),
        ("varsha_lagna_lord", SIGN_LORDS[varsha_chart.lagna.sign]),
        ("tri_rashi_lord", tri_rashi_lord(varsha_chart.lagna.sign, is_day_chart)),
        ("din_ratri_lord", din_ratri_lord(varsha_chart, is_day_chart)),
    ]
    candidates = [
        VarsheshaCandidate(
            graha=graha,
            roles=roles,
            panchavargiya_total=strengths[graha].total,
            aspects_varsha_lagna=varsha_chart.planets[graha].house in _TAJAKA_ASPECT_HOUSES,
        )
        for graha, roles in _collect_roles(offices).items()
    ]
    aspecting = [c for c in candidates if c.aspects_varsha_lagna]
    pool = aspecting or candidates
    winner = max(pool, key=lambda c: (c.panchavargiya_total, len(c.roles)))
    return winner.graha, sorted(candidates, key=lambda c: (-c.panchavargiya_total, c.graha.value))
