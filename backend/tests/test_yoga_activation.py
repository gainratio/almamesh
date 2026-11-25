"""Unit & integration tests for deterministic Yoga x Vimshottari Dasha activation."""

from __future__ import annotations

from datetime import UTC, datetime

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import Dignity, PlanetName, ZodiacSign
from almamesh.schemas.astrology import (
    DashaPeriod,
    LagnaData,
    PlanetPosition,
    VimshottariDashaData,
    YogaData,
    YogaFormationRule,
    YogaStrengthFactor,
)
from almamesh.yogas.activation import compute_yoga_dasha_activation


def _pos(
    name: PlanetName,
    sign: ZodiacSign,
    longitude: float,
    sign_lord: PlanetName,
    house: int,
    *,
    dignity: Dignity = Dignity.NEUTRAL,
    is_combust: bool = False,
) -> PlanetPosition:
    return PlanetPosition(
        name=name,
        longitude=longitude,
        sign=sign,
        sign_degrees=longitude % 30.0,
        sign_lord=sign_lord,
        nakshatra="Ashwini",
        nakshatra_pada=1,
        nakshatra_lord=PlanetName.KETU,
        house=house,
        dignity=dignity,
        is_combust=is_combust,
    )


def _period(lord: PlanetName) -> DashaPeriod:
    start = datetime(2026, 11, 24, tzinfo=UTC)
    end = datetime(2027, 1, 31, tzinfo=UTC)
    return DashaPeriod(lord=lord, start_date=start, end_date=end, duration_years=0.18)


def _yoga(
    name: str,
    planets_involved: list[PlanetName],
    houses_involved: list[int],
    *,
    rule_houses: list[int] | None = None,
) -> YogaData:
    return YogaData(
        name=name,
        display_name=name,
        category="raja",
        description="Kendra and trikona lord association",
        effects="Constructive authority and creative synthesis",
        grade="moderate",
        strength_factors=[
            YogaStrengthFactor(
                factor_type="house_class",
                planet=planets_involved[0],
                value="kendra",
                basis="BPHS",
                mark=1,
            )
        ],
        planets_involved=planets_involved,
        houses_involved=houses_involved,
        planetary_signature="+".join(p.value for p in planets_involved),
        formation_rules=[
            YogaFormationRule(
                rule="raja.kendra_trikona",
                description="Association of kendra and trikona lords",
                source="BPHS",
                planets=planets_involved,
                houses=houses_involved if rule_houses is None else rule_houses,
            )
        ],
    )


def test_direct_dispositor_aspect_and_mitigations() -> None:
    """Traces direct participation, dispositor chain, Saturn 10th drishti & mitigations."""
    planets = {
        PlanetName.SUN: _pos(PlanetName.SUN, ZodiacSign.AQUARIUS, 310.0, PlanetName.SATURN, 1),
        PlanetName.VENUS: _pos(
            PlanetName.VENUS,
            ZodiacSign.AQUARIUS,
            312.5,
            PlanetName.SATURN,
            1,
            is_combust=True,
        ),
        PlanetName.MERCURY: _pos(
            PlanetName.MERCURY, ZodiacSign.AQUARIUS, 320.0, PlanetName.SATURN, 1
        ),
        PlanetName.SATURN: _pos(PlanetName.SATURN, ZodiacSign.TAURUS, 45.0, PlanetName.VENUS, 4),
        PlanetName.KETU: _pos(PlanetName.KETU, ZodiacSign.GEMINI, 75.0, PlanetName.MERCURY, 5),
    }
    dashas = VimshottariDashaData(
        maha_dasha_sequence=[],
        current_maha=_period(PlanetName.SATURN),
        current_antar=_period(PlanetName.VENUS),
        current_pratyantar=_period(PlanetName.KETU),
    )
    lagna = LagnaData(
        longitude=301.2,
        sign=ZodiacSign.AQUARIUS,
        sign_degrees=1.2,
        sign_lord=PlanetName.SATURN,
        nakshatra="Dhanishta",
        nakshatra_pada=3,
        nakshatra_lord=PlanetName.MARS,
        lagna_cusp_distance_deg=1.2,
        lagna_adjacent_sign=ZodiacSign.CAPRICORN,
        is_near_cusp=True,
    )
    yoga = _yoga("Raja Yoga", [PlanetName.SUN, PlanetName.VENUS], [1])

    act = compute_yoga_dasha_activation(yoga, planets, dashas, lagna)

    assert act.status == "direct"
    assert [(d.level, d.lord) for d in act.direct_lords] == [("antar", PlanetName.VENUS)]
    assert [(c.level, [p.value for p in c.chain]) for c in act.dispositor_chains] == [
        ("maha", ["saturn", "venus"]),
        ("pratyantar", ["ketu", "mercury", "saturn", "venus"]),
    ]
    assert [(a.level, a.lord, a.target, a.house_offset) for a in act.aspect_links] == [
        ("maha", PlanetName.SATURN, PlanetName.SUN, 10),
        ("maha", PlanetName.SATURN, PlanetName.VENUS, 10),
    ]
    kinds = [(m.kind, m.planet, m.house) for m in act.mitigating_factors]
    assert ("combust", PlanetName.VENUS, None) in kinds
    assert ("lagna_near_cusp", None, None) in kinds


def test_parivartana_cycle_terminates_as_dormant_when_unconnected() -> None:
    """Mutual-reception dispositor loop (Saturn <-> Venus) never loops infinitely."""
    planets = {
        PlanetName.MOON: _pos(
            PlanetName.MOON,
            ZodiacSign.SCORPIO,
            220.0,
            PlanetName.MARS,
            12,
            dignity=Dignity.DEBILITATED,
        ),
        PlanetName.MARS: _pos(PlanetName.MARS, ZodiacSign.ARIES, 10.0, PlanetName.MARS, 5),
        PlanetName.SATURN: _pos(PlanetName.SATURN, ZodiacSign.LIBRA, 190.0, PlanetName.VENUS, 11),
        PlanetName.VENUS: _pos(PlanetName.VENUS, ZodiacSign.CAPRICORN, 280.0, PlanetName.SATURN, 2),
        PlanetName.KETU: _pos(PlanetName.KETU, ZodiacSign.GEMINI, 70.0, PlanetName.MERCURY, 7),
        PlanetName.MERCURY: _pos(
            PlanetName.MERCURY, ZodiacSign.CAPRICORN, 285.0, PlanetName.SATURN, 2
        ),
    }
    dashas = VimshottariDashaData(
        maha_dasha_sequence=[],
        current_maha=_period(PlanetName.SATURN),
        current_antar=_period(PlanetName.VENUS),
        current_pratyantar=_period(PlanetName.KETU),
    )
    lagna = LagnaData(
        longitude=255.0,
        sign=ZodiacSign.SAGITTARIUS,
        sign_degrees=15.0,
        sign_lord=PlanetName.JUPITER,
        nakshatra="Purva Ashadha",
        nakshatra_pada=1,
        nakshatra_lord=PlanetName.VENUS,
    )
    yoga = _yoga("Vipareeta Raja Yoga", [PlanetName.MOON], [12], rule_houses=[])

    act = compute_yoga_dasha_activation(yoga, planets, dashas, lagna)

    assert act.status == "dormant"
    assert act.direct_lords == []
    assert act.dispositor_chains == []
    assert act.aspect_links == []
    assert act.mitigating_factors == []


def test_seven_hop_dispositor_chain_and_vipareeta_dusthana_exemption() -> None:
    """Supports a full 7-hop 9-graha dispositor chain and exempts Vipareeta's own dusthana."""
    planets = {
        PlanetName.KETU: _pos(
            PlanetName.KETU, ZodiacSign.SAGITTARIUS, 250.0, PlanetName.JUPITER, 9
        ),
        PlanetName.JUPITER: _pos(PlanetName.JUPITER, ZodiacSign.LEO, 130.0, PlanetName.SUN, 5),
        PlanetName.SUN: _pos(PlanetName.SUN, ZodiacSign.TAURUS, 40.0, PlanetName.VENUS, 2),
        PlanetName.VENUS: _pos(PlanetName.VENUS, ZodiacSign.VIRGO, 160.0, PlanetName.MERCURY, 6),
        PlanetName.MERCURY: _pos(PlanetName.MERCURY, ZodiacSign.ARIES, 10.0, PlanetName.MARS, 1),
        PlanetName.MARS: _pos(PlanetName.MARS, ZodiacSign.CAPRICORN, 280.0, PlanetName.SATURN, 10),
        PlanetName.SATURN: _pos(PlanetName.SATURN, ZodiacSign.CANCER, 100.0, PlanetName.MOON, 4),
        PlanetName.MOON: _pos(
            PlanetName.MOON,
            ZodiacSign.PISCES,
            340.0,
            PlanetName.JUPITER,
            12,
            dignity=Dignity.DEBILITATED,
        ),
    }
    dashas = VimshottariDashaData(
        maha_dasha_sequence=[],
        current_maha=_period(PlanetName.KETU),
    )
    lagna = LagnaData(
        longitude=15.0,
        sign=ZodiacSign.ARIES,
        sign_degrees=15.0,
        sign_lord=PlanetName.MARS,
        nakshatra="Bharani",
        nakshatra_pada=1,
        nakshatra_lord=PlanetName.VENUS,
    )
    yoga = _yoga("Vipareeta Raja Yoga", [PlanetName.MOON], [12], rule_houses=[12])

    act = compute_yoga_dasha_activation(yoga, planets, dashas, lagna)

    assert act.status == "indirect"
    assert [p.value for p in act.dispositor_chains[0].chain] == [
        "ketu",
        "jupiter",
        "sun",
        "venus",
        "mercury",
        "mars",
        "saturn",
        "moon",
    ]
    kinds = [(m.kind, m.planet, m.house) for m in act.mitigating_factors]
    assert ("debilitated", PlanetName.MOON, None) in kinds
    assert ("dusthana", PlanetName.MOON, 12) not in kinds


def test_indirect_activation_when_only_dispositor_or_aspect_fires() -> None:
    """Marks yoga as 'indirect' when no active lord is directly in planets_involved."""
    planets = {
        PlanetName.JUPITER: _pos(PlanetName.JUPITER, ZodiacSign.CANCER, 100.0, PlanetName.MOON, 4),
        PlanetName.MOON: _pos(PlanetName.MOON, ZodiacSign.TAURUS, 40.0, PlanetName.VENUS, 2),
        PlanetName.KETU: _pos(
            PlanetName.KETU, ZodiacSign.SAGITTARIUS, 250.0, PlanetName.JUPITER, 9
        ),
    }
    dashas = VimshottariDashaData(
        maha_dasha_sequence=[],
        current_maha=_period(PlanetName.KETU),
    )
    lagna = LagnaData(
        longitude=15.0,
        sign=ZodiacSign.ARIES,
        sign_degrees=15.0,
        sign_lord=PlanetName.MARS,
        nakshatra="Bharani",
        nakshatra_pada=1,
        nakshatra_lord=PlanetName.VENUS,
    )
    yoga = _yoga("Hamsa Yoga", [PlanetName.JUPITER], [4])

    act = compute_yoga_dasha_activation(yoga, planets, dashas, lagna)

    assert act.status == "indirect"
    assert act.direct_lords == []
    assert [(c.level, [p.value for p in c.chain]) for c in act.dispositor_chains] == [
        ("maha", ["ketu", "jupiter"]),
    ]


def test_sidereal_context_populates_dasha_activation_on_every_yoga() -> None:
    """calculate_sidereal_context attaches dasha_activation to every detected yoga."""
    ctx = calculate_sidereal_context(
        datetime(1990, 1, 15, 12, 0, 0, tzinfo=UTC),
        28.6139,
        77.2090,
        reference_date=datetime(2026, 11, 25, 0, 0, 0, tzinfo=UTC),
    )
    assert len(ctx.yogas) > 0
    assert all(yoga.dasha_activation is not None for yoga in ctx.yogas)
