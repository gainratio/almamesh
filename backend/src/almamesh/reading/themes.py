"""Per-domain themes: plain agreement booleans, a counted confidence, cited factors.

Agreement is one boolean per technique, never a fused score (the heuristics in
``dasha/scoring.py`` stay quarantined). A graha signifies a domain when it rules
one of its houses, occupies one, or is one of its karakas. Every factor string
is generated from an engine fact: a lordship, an occupancy, a karaka, a transit
house, a tag, a bindu count.

An ``activation_only`` domain (obstacles: the 6th/8th/12th) is guarded against
base rates: its karakas never signify, and its strength is the period's
activation (agreeing techniques plus a dated window; strong needs the window),
never natal Shadbala.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from almamesh.constants.astrology import PlanetName
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.significators import significator_grahas
from almamesh.reading.common import ordinal, title, utc_date
from almamesh.schemas.domains import StrengthBand
from almamesh.schemas.reading import ReadingTheme, SkySpan, ThemeAgreement, ThemeWindow
from almamesh.schemas.transits import TransitSeverity

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import datetime

    from almamesh.domains.recipes import DomainRecipe
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.domains import LifeDomainForecast, LifeDomainsContext
    from almamesh.schemas.reading import DashaLevel, YoginiSpan

Direction = Literal["supportive", "mixed", "challenging"]
Confidence = Literal["high", "medium", "low"]

# Bounded but above the domain count, so no domain theme is ever silently dropped.
_MAX_THEMES: Final[int] = 8
_MAX_FACTORS: Final[int] = 3
_MAX_WINDOWS: Final[int] = 3
_MAX_DASHA_FACTORS: Final[int] = 2
_CONFIDENCE: Final[dict[int, Confidence]] = {3: "high", 2: "medium"}
_SLOW_TRANSITS: Final[frozenset[PlanetName]] = frozenset({PlanetName.JUPITER, PlanetName.SATURN})
# Activation strength: vimshottari, yogini, transit agreement + a dated window.
# A maha/antar lord or a slow transit can hold for years, so without a dated
# window inside the period the band stops at moderate (AlmaMesh heuristic).
_ACTIVATION_SIGNALS: Final[int] = 4
_STRONG_ACTIVATION: Final[int] = 3
_MODERATE_ACTIVATION: Final[int] = 2


@dataclass(frozen=True)
class ThemeInputs:
    """Everything the themes read, all already computed by the run."""

    natal: SiderealContext
    domains: LifeDomainsContext
    running: list[tuple[DashaLevel, PlanetName]]  # first level each lord runs at
    yogini: YoginiSpan | None
    sky: list[SkySpan]
    start: datetime
    end: datetime


@dataclass(frozen=True)
class _Domain:
    """A domain's recipe, houses and significators (lords, occupants, counted karakas)."""

    forecast: LifeDomainForecast
    recipe: DomainRecipe
    houses: tuple[int, ...]
    grahas: frozenset[PlanetName]

    @classmethod
    def of(cls, forecast: LifeDomainForecast, natal: SiderealContext) -> _Domain:
        recipe = DOMAIN_RECIPES[forecast.domain]
        houses = tuple(h.house for h in forecast.houses)
        return cls(forecast, recipe, houses, significator_grahas(natal, recipe))

    def house_text(self, house: int) -> str:
        """``the Nth``, plus ``: <meaning>`` when the recipe labels the house."""
        meaning = next((r.meaning for r in self.recipe.houses if r.house == house), None)
        return f"the {ordinal(house)}: {meaning}" if meaning else f"the {ordinal(house)}"


def theme_direction(severities: Iterable[TransitSeverity | str]) -> Direction:
    """All non-neutral supportive -> supportive; all challenging -> challenging; else mixed."""
    seen = {TransitSeverity(s) for s in severities} - {TransitSeverity.NEUTRAL}
    if seen == {TransitSeverity.SUPPORTIVE}:
        return "supportive"
    if seen == {TransitSeverity.CHALLENGING}:
        return "challenging"
    return "mixed"


def confidence_for(agreeing: int) -> Confidence:
    """3 agreeing techniques = high, 2 = medium, 0-1 = low."""
    return _CONFIDENCE.get(agreeing, "low")


def _span_hit(span: SkySpan, houses: tuple[int, ...]) -> tuple[str, int] | None:
    """The span's domain house counted from the Moon, else from the lagna, else None."""
    for ref, house in (("the Moon", span.from_moon), ("the lagna", span.from_lagna)):
        if house in houses:
            return ref, house
    return None


def _transit_hit(domain: _Domain, sky: list[SkySpan]) -> tuple[SkySpan, str, int] | None:
    """The first Jupiter/Saturn span that falls in a domain house."""
    for span in sky:
        hit = _span_hit(span, domain.houses) if span.graha in _SLOW_TRANSITS else None
        if hit is not None:
            return span, hit[0], hit[1]
    return None


def _agreement(domain: _Domain, inputs: ThemeInputs) -> ThemeAgreement:
    """The three plain booleans."""
    yogini = inputs.yogini
    return ThemeAgreement(
        vimshottari=any(lord in domain.grahas for _, lord in inputs.running),
        yogini=yogini is not None and yogini.lord in domain.grahas,
        transit=_transit_hit(domain, inputs.sky) is not None,
    )


def _signifies(label: str, lord: PlanetName, domain: _Domain, natal: SiderealContext) -> str:
    """``rules the Nth`` (house lord), else ``occupies the Nth``, else ``is a karaka of``."""
    placement = natal.planets[lord]
    ruled = [h for h in domain.houses if h in placement.houses_ruled]
    if ruled:
        return f"{label} rules {domain.house_text(ruled[0])}"
    if placement.house in domain.houses:
        return f"{label} occupies {domain.house_text(placement.house)}"
    return f"{label} is a karaka of {domain.forecast.domain.value}"


def _dasha_factors(domain: _Domain, inputs: ThemeInputs) -> list[str]:
    """The first two running lords that signify the domain, outermost level first."""
    hits = [(lvl, lord) for lvl, lord in inputs.running if lord in domain.grahas]
    return [
        _signifies(f"{title(lord)} ({lvl.value})", lord, domain, inputs.natal)
        for lvl, lord in hits[:_MAX_DASHA_FACTORS]
    ]


def _yogini_factor(domain: _Domain, inputs: ThemeInputs) -> str | None:
    """The Yogini maha lord, when it signifies the domain."""
    yogini = inputs.yogini
    if yogini is None or yogini.lord not in domain.grahas:
        return None
    label = f"Yogini {yogini.name.capitalize()} ({title(yogini.lord)})"
    return _signifies(label, yogini.lord, domain, inputs.natal)


def _transit_factors(domain: _Domain, sky: list[SkySpan]) -> list[str]:
    """``<Graha> transits the Nth from <ref> (<tag>)`` and its sign's SAV."""
    hit = _transit_hit(domain, sky)
    if hit is None:
        return []
    span, ref, house = hit
    tags = [t for t in span.tags if not t.startswith("jupiter_from_moon")]
    suffix = f" ({tags[0]})" if tags else ""
    text = f"{title(span.graha)} transits the {ordinal(house)} from {ref}{suffix}"
    return [text, f"{title(span.graha)}'s SAV in {span.sign.capitalize()} is {span.sav}"]


def _strength_factor(domain: _Domain) -> str | None:
    """The domain's key graha strength; none for an activation-only domain."""
    if domain.recipe.activation_only:
        return None
    s = domain.forecast.strength_summary
    return f"{title(s.key_graha)} strength is {round(s.strength_pct)}% ({s.band.value})"


def _factors(domain: _Domain, inputs: ThemeInputs) -> list[str]:
    """Up to three cited factors: dasha, transit, a second dasha lord, Yogini, SAV, strength."""
    dasha = _dasha_factors(domain, inputs)
    transit = _transit_factors(domain, inputs.sky)
    ordered = [
        *dasha[:1],
        *transit[:1],
        *dasha[1:],
        _yogini_factor(domain, inputs),
        *transit[1:],
        _strength_factor(domain),
    ]
    return [f for f in ordered if f is not None][:_MAX_FACTORS]


def _windows(forecast: LifeDomainForecast, inputs: ThemeInputs) -> list[ThemeWindow]:
    """The domain's dated windows inside the half-open reading window (all of them)."""
    return [
        ThemeWindow(date=utc_date(w.date), descriptor=w.descriptor, severity=w.severity)
        for w in forecast.upcoming_windows
        if inputs.start <= w.date < inputs.end
    ]


def _shown(windows: list[ThemeWindow]) -> list[ThemeWindow]:
    """At most three windows, non-neutral before neutral, then earliest; chronological.

    The full list stays in ``domains_context.upcoming_windows``; every ingress and
    dasha change is also dated in ``segments`` and ``sky``.
    """
    ranked = sorted(windows, key=lambda w: (w.severity == TransitSeverity.NEUTRAL, w.date))
    return sorted(ranked[:_MAX_WINDOWS], key=lambda w: (w.date, w.descriptor))


def _strength(
    domain: _Domain, agreement: ThemeAgreement, windows: list[ThemeWindow]
) -> tuple[StrengthBand, int]:
    """Natal band and %, or for an activation-only domain the period's activation."""
    if not domain.recipe.activation_only:
        summary = domain.forecast.strength_summary
        return summary.band, round(summary.strength_pct)
    hits = _agreeing(agreement) + bool(windows)
    return _activation_band(hits, dated=bool(windows)), round(100 * hits / _ACTIVATION_SIGNALS)


def _activation_band(hits: int, *, dated: bool) -> StrengthBand:
    """3-4 signals with a dated window strong; 2+ moderate; 0-1 weak."""
    if dated and hits >= _STRONG_ACTIVATION:
        return StrengthBand.STRONG
    if hits >= _MODERATE_ACTIVATION:
        return StrengthBand.MODERATE
    return StrengthBand.WEAK


def _theme(forecast: LifeDomainForecast, inputs: ThemeInputs) -> ReadingTheme:
    """One domain's theme."""
    domain = _Domain.of(forecast, inputs.natal)
    agreement = _agreement(domain, inputs)
    windows = _windows(forecast, inputs)
    severities = (forecast.current_emphasis.transit_severity, *(w.severity for w in windows))
    band, pct = _strength(domain, agreement, windows)
    return ReadingTheme(
        domain=forecast.domain,
        houses=list(domain.houses),
        direction=theme_direction(severities),
        strength=band,
        strength_pct=pct,
        confidence=confidence_for(_agreeing(agreement)),
        agreement=agreement,
        factors=_factors(domain, inputs),
        windows=_shown(windows),
    )


def _agreeing(agreement: ThemeAgreement) -> int:
    """How many techniques agree."""
    return sum((agreement.vimshottari, agreement.yogini, agreement.transit))


def reading_themes(inputs: ThemeInputs) -> list[ReadingTheme]:
    """Every domain (at most eight), most agreeing techniques first, then strongest."""
    themes = [_theme(f, inputs) for f in inputs.domains.forecasts.values()]
    themes.sort(key=lambda t: (-_agreeing(t.agreement), -t.strength_pct))
    return themes[:_MAX_THEMES]


__all__ = ["ThemeInputs", "confidence_for", "reading_themes", "theme_direction"]
