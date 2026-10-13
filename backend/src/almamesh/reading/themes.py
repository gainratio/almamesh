"""Per-domain themes: plain agreement booleans, a counted confidence, cited factors.

Agreement is one boolean per technique, never a fused score (the heuristics in
``dasha/scoring.py`` stay quarantined). Every factor string is generated from an
engine fact: a lordship, a karaka, a transit house, a tag, a bindu count.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from almamesh.constants.astrology import PlanetName
from almamesh.reading.common import ordinal, title, utc_date
from almamesh.schemas.reading import ReadingTheme, SkySpan, ThemeAgreement, ThemeWindow
from almamesh.schemas.transits import TransitSeverity

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import datetime

    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.domains import LifeDomainForecast, LifeDomainsContext
    from almamesh.schemas.reading import DashaLevel, YoginiSpan

Direction = Literal["supportive", "mixed", "challenging"]
Confidence = Literal["high", "medium", "low"]

_MAX_THEMES: Final[int] = 6
_MAX_FACTORS: Final[int] = 3
_MAX_WINDOWS: Final[int] = 3
_CONFIDENCE: Final[dict[int, Confidence]] = {3: "high", 2: "medium"}
_SLOW_TRANSITS: Final[frozenset[PlanetName]] = frozenset({PlanetName.JUPITER, PlanetName.SATURN})


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
    """A domain's significators: its houses, their lords and its karakas."""

    forecast: LifeDomainForecast
    houses: tuple[int, ...]
    grahas: frozenset[PlanetName]

    @classmethod
    def of(cls, forecast: LifeDomainForecast) -> _Domain:
        lords = {h.lord for h in forecast.houses} | {k.graha for k in forecast.karakas}
        return cls(forecast, tuple(h.house for h in forecast.houses), frozenset(lords))


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
    """``<label> rules the Nth`` for a house lord, else ``is a karaka of <domain>``."""
    ruled = [h for h in domain.houses if h in natal.planets[lord].houses_ruled]
    if ruled:
        return f"{label} rules the {ordinal(ruled[0])}"
    return f"{label} is a karaka of {domain.forecast.domain.value}"


def _dasha_factor(domain: _Domain, inputs: ThemeInputs) -> str | None:
    """The first running lord that signifies the domain."""
    hit = next(((lvl, lord) for lvl, lord in inputs.running if lord in domain.grahas), None)
    if hit is None:
        return None
    return _signifies(f"{title(hit[1])} ({hit[0].value})", hit[1], domain, inputs.natal)


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


def _strength_factor(forecast: LifeDomainForecast) -> str:
    """The domain's key graha strength, always available."""
    s = forecast.strength_summary
    return f"{title(s.key_graha)} strength is {round(s.strength_pct)}% ({s.band.value})"


def _factors(domain: _Domain, inputs: ThemeInputs) -> list[str]:
    """Up to three cited factors: dasha, transit, Yogini, SAV, then strength."""
    transit = _transit_factors(domain, inputs.sky)
    ordered = [
        _dasha_factor(domain, inputs),
        *transit[:1],
        _yogini_factor(domain, inputs),
        *transit[1:],
        _strength_factor(domain.forecast),
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


def _theme(forecast: LifeDomainForecast, inputs: ThemeInputs) -> ReadingTheme:
    """One domain's theme."""
    domain = _Domain.of(forecast)
    agreement = _agreement(domain, inputs)
    windows = _windows(forecast, inputs)
    severities = (forecast.current_emphasis.transit_severity, *(w.severity for w in windows))
    return ReadingTheme(
        domain=forecast.domain,
        houses=list(domain.houses),
        direction=theme_direction(severities),
        strength=forecast.strength_summary.band,
        strength_pct=round(forecast.strength_summary.strength_pct),
        confidence=confidence_for(_agreeing(agreement)),
        agreement=agreement,
        factors=_factors(domain, inputs),
        windows=_shown(windows),
    )


def _agreeing(agreement: ThemeAgreement) -> int:
    """How many techniques agree."""
    return sum((agreement.vimshottari, agreement.yogini, agreement.transit))


def reading_themes(inputs: ThemeInputs) -> list[ReadingTheme]:
    """Up to six domains, most agreeing techniques first, then strongest."""
    themes = [_theme(f, inputs) for f in inputs.domains.forecasts.values()]
    themes.sort(key=lambda t: (-_agreeing(t.agreement), -t.strength_pct))
    return themes[:_MAX_THEMES]


__all__ = ["ThemeInputs", "confidence_for", "reading_themes", "theme_direction"]
