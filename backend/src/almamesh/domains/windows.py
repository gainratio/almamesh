"""Filter the engine's forward timeline down to one domain's dated windows.

Every ``DomainWindow`` maps 1:1 to a REAL ``TimelineEvent`` the transit/dasha
engines computed — this module never invents or extrapolates an event (the
window descriptor embeds the source event's stable descriptor, so the mapping is
auditable). Dasha windows come exclusively from the timeline's DASHA_CHANGE
events because those boundaries were computed by the Vimshottari engine itself;
re-deriving sub-period successors here would be a second (riskier) dasha
implementation, which calc-integrity forbids.

Which events feed windows (``feeds_domain_windows``): Jupiter and Saturn sign
ingresses in both directions (a retrograde move back across a cusp is a window
of its own), dasha changes, Sade Sati phases and returns. Rahu/Ketu ingresses
and all stations are not used, by decision. Mars ingresses are used only by a
recipe with ``mars_windows`` (obstacles): Mars entering one of its house signs
or the natal Moon's or lagna's sign is a dated trigger (source ``transit``).

Relevance per event kind:
- DASHA_CHANGE: the incoming lord is a domain significator  -> source ``dasha``;
- SADE_SATI_PHASE: the domain is Sade Sati-relevant         -> source ``transit``
  (trigger Saturn — Sade Sati IS the Saturn transit);
- Jupiter/Saturn SIGN_INGRESS: the moving graha is a domain significator, or the
  entered sign is one of the domain's whole-sign bhavas     -> source ``transit``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import PlanetName
from almamesh.domains.emphasis import sade_sati_relevant
from almamesh.domains.significators import domain_house_signs
from almamesh.schemas.domains import DomainWindow, WindowSource
from almamesh.schemas.transits import TransitEventKind, TransitSeverity

if TYPE_CHECKING:
    from almamesh.constants.astrology import ZodiacSign
    from almamesh.domains.recipes import DomainRecipe
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.transits import TimelineEvent, TransitContext

# Inc B widened the timeline (Mars and node ingresses, stations). Life Atlas
# windows take only Jupiter/Saturn ingresses (every crossing, either direction),
# dasha changes and Sade Sati phases; widening further is a product decision.
_DOMAIN_INGRESS_GRAHAS: Final[frozenset[PlanetName]] = frozenset(
    {PlanetName.JUPITER, PlanetName.SATURN}
)


def feeds_domain_windows(event: TimelineEvent) -> bool:
    """True for the timeline events Life Atlas windows are built from."""
    kind = TransitEventKind(event.kind)
    if kind is TransitEventKind.STATION:
        return False
    if kind is TransitEventKind.SIGN_INGRESS:
        return event.graha is not None and PlanetName(event.graha) in _DOMAIN_INGRESS_GRAHAS
    return True


# (source, trigger) verdict for a relevant event; None = not this domain's event.
_Verdict = tuple[WindowSource, PlanetName | None]


def _classify_transit_event(
    event: TimelineEvent,
    sigs: frozenset[PlanetName],
    house_signs: frozenset[ZodiacSign],
) -> _Verdict | None:
    """Ingress/return relevance: significator graha or domain-bhava sign."""
    if event.graha is None:
        return None
    enters_domain_sign = event.to_sign is not None and event.to_sign in house_signs
    if event.graha in sigs or enters_domain_sign:
        return WindowSource.TRANSIT, PlanetName(event.graha)
    return None


def _classify_dasha_event(event: TimelineEvent, sigs: frozenset[PlanetName]) -> _Verdict | None:
    """A dasha handover is the domain's window when the incoming lord signifies it."""
    if event.to_lord is not None and event.to_lord in sigs:
        return WindowSource.DASHA, PlanetName(event.to_lord)
    return None


def _classify(
    event: TimelineEvent,
    sigs: frozenset[PlanetName],
    house_signs: frozenset[ZodiacSign],
    is_sade_sati_relevant: bool,
) -> _Verdict | None:
    """Route one timeline event to a window source, or drop it as irrelevant."""
    kind = TransitEventKind(event.kind)
    if kind is TransitEventKind.DASHA_CHANGE:
        return _classify_dasha_event(event, sigs)
    if kind is TransitEventKind.SADE_SATI_PHASE:
        return (WindowSource.TRANSIT, PlanetName.SATURN) if is_sade_sati_relevant else None
    return _classify_transit_event(event, sigs, house_signs)


@dataclass(frozen=True)
class _Scope:
    """What makes an event this domain's: significators, house signs, Sade Sati, Mars signs."""

    sigs: frozenset[PlanetName]
    house_signs: frozenset[ZodiacSign]
    sade_sati: bool
    mars_signs: frozenset[ZodiacSign]


def _mars_signs(natal: SiderealContext, recipe: DomainRecipe) -> frozenset[ZodiacSign]:
    """The signs a Mars ingress into is a window: domain houses + natal Moon + lagna."""
    if not recipe.mars_windows:
        return frozenset()
    natal_points = {natal.planets[PlanetName.MOON].sign, natal.houses[1].sign}
    return domain_house_signs(natal, recipe) | natal_points


def _mars_trigger(event: TimelineEvent, scope: _Scope) -> _Verdict | None:
    """A Mars ingress into one of the scope's Mars signs."""
    is_mars_ingress = event.kind == TransitEventKind.SIGN_INGRESS and event.graha == PlanetName.MARS
    if is_mars_ingress and event.to_sign in scope.mars_signs:
        return WindowSource.TRANSIT, PlanetName.MARS
    return None


def _verdict(event: TimelineEvent, scope: _Scope) -> _Verdict | None:
    """The shared Life Atlas event set first, then the opt-in Mars trigger."""
    if feeds_domain_windows(event):
        return _classify(event, scope.sigs, scope.house_signs, scope.sade_sati)
    return _mars_trigger(event, scope)


def _window(
    recipe: DomainRecipe, source: WindowSource, trigger: PlanetName | None, event: TimelineEvent
) -> DomainWindow:
    """One window, descriptor-chained to the engine event it came from."""
    return DomainWindow(
        date=event.date,
        source=source,
        kind=TransitEventKind(event.kind),
        trigger=trigger,
        severity=TransitSeverity(event.severity),
        descriptor=f"{recipe.domain.value}.{source.value}.{event.descriptor}",
    )


def upcoming_windows(
    natal: SiderealContext,
    transits: TransitContext,
    recipe: DomainRecipe,
    sigs: frozenset[PlanetName],
) -> list[DomainWindow]:
    """The domain-relevant subset of the forward timeline, chronologically sorted."""
    scope = _Scope(
        sigs=sigs,
        house_signs=domain_house_signs(natal, recipe),
        sade_sati=sade_sati_relevant(natal, recipe, sigs),
        mars_signs=_mars_signs(natal, recipe),
    )
    windows: list[DomainWindow] = []
    for event in transits.timeline.events:
        verdict = _verdict(event, scope)
        if verdict is not None:
            windows.append(_window(recipe, verdict[0], verdict[1], event))
    return sorted(windows, key=lambda w: (w.date, w.descriptor))
