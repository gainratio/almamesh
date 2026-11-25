"""Deterministic Yoga x Vimshottari Dasha activation mapping.

Evaluates whether and how the active Mahadasha, Antardasha, and Pratyantardasha
lords activate each formed natal yoga via:
1. Direct participation (active lord is in ``yoga.planets_involved``),
2. Natal Rasi dispositor chains (``lord -> sign_lord -> ... -> target``),
3. Classical Parashari whole-sign conjunction / Graha Drishti, and
4. Mitigating factors (combustion, debilitation, dusthana placement, near-cusp lagna).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import Dignity, PlanetName
from almamesh.schemas.astrology import (
    LagnaData,
    PlanetPosition,
    VimshottariDashaData,
    YogaActivationStatus,
    YogaAspectLink,
    YogaDashaActivation,
    YogaDashaLevel,
    YogaDashaLink,
    YogaData,
    YogaDispositorChain,
    YogaMitigatingFactor,
)
from almamesh.transits.aspects import drishti_offsets
from almamesh.transits.natal import sign_index

if TYPE_CHECKING:
    from almamesh.schemas.astrology import SiderealContext

_DUSTHANA_HOUSES: Final[frozenset[int]] = frozenset({6, 8, 12})
_MAX_DISPOSITOR_HOPS: Final[int] = len(PlanetName)


def _active_dasha_lords(
    dashas: VimshottariDashaData,
) -> list[tuple[YogaDashaLevel, PlanetName]]:
    """Ordered active (level, lord) pairs present at the chart's reference instant."""
    pairs: list[tuple[YogaDashaLevel, PlanetName]] = []
    if dashas.current_maha is not None:
        pairs.append(("maha", dashas.current_maha.lord))
    if dashas.current_antar is not None:
        pairs.append(("antar", dashas.current_antar.lord))
    if dashas.current_pratyantar is not None:
        pairs.append(("pratyantar", dashas.current_pratyantar.lord))
    return pairs


def _trace_dispositor_chain(
    start: PlanetName,
    targets: frozenset[PlanetName],
    planets: dict[PlanetName, PlanetPosition],
) -> list[PlanetName] | None:
    """Cycle-safe Rasi sign-lord walk from ``start`` to the first yoga participant."""
    if start in targets or start not in planets:
        return None
    chain: list[PlanetName] = [start]
    visited: set[PlanetName] = {start}
    curr = start
    for _ in range(_MAX_DISPOSITOR_HOPS):
        nxt = planets[curr].sign_lord
        chain.append(nxt)
        if nxt in targets:
            return chain
        if nxt in visited or nxt not in planets:
            return None
        visited.add(nxt)
        curr = nxt
    return None


def _dispositor_chains_for(
    active: list[tuple[YogaDashaLevel, PlanetName]],
    targets: frozenset[PlanetName],
    planets: dict[PlanetName, PlanetPosition],
) -> list[YogaDispositorChain]:
    """Dispositor chains for active lords that are not already direct participants."""
    chains: list[YogaDispositorChain] = []
    for level, lord in active:
        traced = _trace_dispositor_chain(lord, targets, planets)
        if traced is not None:
            chains.append(YogaDispositorChain(level=level, lord=lord, chain=traced))
    return chains


def _aspect_links_for(
    active: list[tuple[YogaDashaLevel, PlanetName]],
    yoga_planets: list[PlanetName],
    targets: frozenset[PlanetName],
    planets: dict[PlanetName, PlanetPosition],
) -> list[YogaAspectLink]:
    """Whole-sign conjunction (1) and Parashari drishti from non-direct active lords."""
    links: list[YogaAspectLink] = []
    for level, lord in active:
        if lord in targets or lord not in planets:
            continue
        from_idx = sign_index(planets[lord].longitude)
        allowed = drishti_offsets(lord) | {1}
        for target in yoga_planets:
            if target not in planets:
                continue
            offset = (sign_index(planets[target].longitude) - from_idx) % 12 + 1
            if offset in allowed:
                links.append(
                    YogaAspectLink(level=level, lord=lord, target=target, house_offset=offset)
                )
    return links


def _planet_mitigations(
    planet: PlanetName,
    pos: PlanetPosition,
    formation_dusthanas: frozenset[int],
) -> list[YogaMitigatingFactor]:
    """Qualifying conditions on one involved or activating graha."""
    items: list[YogaMitigatingFactor] = []
    if pos.is_combust:
        items.append(YogaMitigatingFactor(kind="combust", planet=planet))
    if pos.dignity == Dignity.DEBILITATED:
        items.append(YogaMitigatingFactor(kind="debilitated", planet=planet))
    if pos.house in _DUSTHANA_HOUSES and pos.house not in formation_dusthanas:
        items.append(YogaMitigatingFactor(kind="dusthana", planet=planet, house=pos.house))
    return items


def _mitigating_factors_for(
    yoga: YogaData,
    status: YogaActivationStatus,
    activating_lords: list[PlanetName],
    planets: dict[PlanetName, PlanetPosition],
    lagna: LagnaData,
) -> list[YogaMitigatingFactor]:
    """Qualifying conditions for an activated yoga (empty when dormant)."""
    if status == "dormant":
        return []
    formation_dusthanas = frozenset(
        h for rule in yoga.formation_rules for h in rule.houses if h in _DUSTHANA_HOUSES
    )
    ordered = list(dict.fromkeys([*yoga.planets_involved, *activating_lords]))
    factors = [
        item
        for planet in ordered
        if planet in planets
        for item in _planet_mitigations(planet, planets[planet], formation_dusthanas)
    ]
    if lagna.is_near_cusp and any(rule.houses for rule in yoga.formation_rules):
        factors.append(YogaMitigatingFactor(kind="lagna_near_cusp"))
    return factors


def _activation_status(
    direct: list[YogaDashaLink],
    chains: list[YogaDispositorChain],
    aspects: list[YogaAspectLink],
) -> YogaActivationStatus:
    """Classify activation tier from direct vs dispositor/aspect participation."""
    if direct:
        return "direct"
    if chains or aspects:
        return "indirect"
    return "dormant"


def compute_yoga_dasha_activation(
    yoga: YogaData,
    planets: dict[PlanetName, PlanetPosition],
    dashas: VimshottariDashaData,
    lagna: LagnaData,
) -> YogaDashaActivation:
    """Compute the deterministic Dasha activation breakdown for a single natal yoga."""
    active = _active_dasha_lords(dashas)
    targets = frozenset(yoga.planets_involved)
    direct = [YogaDashaLink(level=lvl, lord=lord) for lvl, lord in active if lord in targets]
    chains = _dispositor_chains_for(active, targets, planets)
    aspects = _aspect_links_for(active, yoga.planets_involved, targets, planets)
    activating = [
        *(link.lord for link in direct),
        *(chain.lord for chain in chains),
        *(aspect.lord for aspect in aspects),
    ]
    status = _activation_status(direct, chains, aspects)
    return YogaDashaActivation(
        status=status,
        direct_lords=direct,
        dispositor_chains=chains,
        aspect_links=aspects,
        mitigating_factors=_mitigating_factors_for(yoga, status, activating, planets, lagna),
    )


def attach_yoga_activations(yogas: list[YogaData], context: SiderealContext) -> list[YogaData]:
    """Return ``yogas`` enriched with deterministic ``dasha_activation``."""
    return [
        yoga.model_copy(
            update={
                "dasha_activation": compute_yoga_dasha_activation(
                    yoga, context.planets, context.dashas, context.lagna
                )
            }
        )
        for yoga in yogas
    ]
