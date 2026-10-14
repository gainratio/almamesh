"""Typed Pydantic contract for the per-life-domain predictive SYNTHESIS layer.

This is the prose-free, deterministic fusion of the four predictive subsystems
(natal ``SiderealContext`` + ``TransitContext`` + ``VargaContext`` +
``StrengthContext``) into one ``LifeDomainForecast`` for each facet of life. The
engine fuses signals and CITES the classical rule it applied; the LLM/i18n layer
narrates later. Calc-integrity: any value that is a documented simplification
carries an explicit ``approximated`` flag rather than shipping a guess as fact.

Like the transit/varga/strength contexts, this is a SEPARATE, additive object
built READ-ONLY off already-computed contexts — it is NOT nested into the natal
output, so the natal golden and CPython<->Pyodide byte-parity stay untouched (a
later integration wave composes it). All enums are closed sets serialized as
their ``.value`` for the browser.

Exposed via this module's own symbols; the package ``domains`` re-exports the
public entrypoint. A shared ``schemas/__init__`` is intentionally NOT edited.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from almamesh.constants.astrology import Dignity, PlanetName, ZodiacSign
from almamesh.schemas.transits import TransitEventKind, TransitSeverity
from almamesh.schemas.vargas import DivisionalChart


class LifeDomain(StrEnum):
    """The closed set of life facets this synthesis layer forecasts."""

    CAREER = "career"
    FINANCES = "finances"
    HEALTH = "health"
    RELATIONSHIPS = "relationships"
    SPIRITUAL = "spiritual"
    EDUCATION = "education"
    FAMILY = "family"
    OBSTACLES = "obstacles"  # 6th/8th/12th: disputes, setbacks, losses (see domains/recipes.py)


class StrengthBand(StrEnum):
    """Coarse, deterministic strength verdict for a domain's key significator."""

    STRONG = "strong"
    MODERATE = "moderate"
    WEAK = "weak"


class WindowSource(StrEnum):
    """Which subsystem produced an upcoming window."""

    DASHA = "dasha"  # a maha/antar/pratyantar sub-period boundary
    TRANSIT = "transit"  # a dated event from the 12-month transit timeline


# --- atomic, cited significators ---


class HouseSignificator(BaseModel):
    """One of a domain's houses, resolved to its sign + lord from the natal chart.

    ``lord_house`` / ``lord_sign`` / ``lord_dignity`` describe WHERE that house's
    lord sits — the classical "lord placement" reading the synthesis fuses.
    """

    model_config = ConfigDict(frozen=True)

    house: int  # 1..12
    sign: ZodiacSign
    lord: PlanetName
    lord_house: int  # the house the lord occupies (1..12)
    lord_sign: ZodiacSign
    lord_dignity: Dignity
    rule: str  # classical citation, e.g. "career: 10th house of karma"


class KarakaSignificator(BaseModel):
    """A natural karaka for the domain, resolved to its natal placement."""

    model_config = ConfigDict(frozen=True)

    graha: PlanetName
    house: int  # 1..12 the karaka occupies
    sign: ZodiacSign
    dignity: Dignity
    is_retrograde: bool
    rule: str  # classical citation, e.g. "Venus is the karaka of marriage"


class VargaPlacementSummary(BaseModel):
    """The domain's defining divisional chart: the key graha's sign in that varga.

    For career this is the D10 Dasamsa, for relationships the D9 Navamsa, etc.
    ``same_sign_as_d1`` is the honest generalized marker (D1 sign == this varga
    sign, in WHATEVER varga defines the domain). ``vargottama`` is reserved for
    the classical BPHS claim — it is True only when the defining varga is the
    D9 Navamsa and the sign repeats; every other varga reports False.
    """

    model_config = ConfigDict(frozen=True)

    chart: DivisionalChart
    graha: PlanetName  # the key significator placed in this varga
    sign: ZodiacSign
    sign_lord: PlanetName
    same_sign_as_d1: bool  # generalized D1-sign repeat marker (any varga)
    vargottama: bool  # classical BPHS marker: D9-only (chart is D9 AND sign repeats)
    rule: str  # e.g. "D10 Dasamsa governs career & public status"


class StrengthSummary(BaseModel):
    """Numeric + banded strength for the domain, with its derivation cited.

    ``key_graha_rupas`` is the Shadbala (Rupas) of the domain's primary
    significator; ``sav_bindus`` is the Sarvashtakavarga bindu count summed over
    the domain's houses. ``band`` is the deterministic verdict. ``approximated``
    is True because the band thresholds are an AlmaMesh heuristic over the
    rigorous BPHS inputs (Shadbala + SAV), not a single canonical scalar — the
    underlying Rupas/bindus themselves are exact.

    The Stage-2 rigor upgrade adds a CALIBRATED headline % under two anchored,
    monotonic, chart-invariant axes (see ``domains/strength_summary.py`` and
    rigor spec §A.1/§A.2). ``shadbala_pct`` is piecewise-linear on the classical
    ``required_rupas`` pass line (-> 60%); ``sav_pct`` is linear over the 56
    bindus/house hard max (the śāstric average 28 -> 50%); ``strength_pct`` is
    their ``min()`` — a domain is only as strong as its weaker classical signal,
    matching today's conjunctive band. ``strength_tier`` is ``"model"``: these
    percents are a Layer-2 MODEL over exact BPHS inputs, never a measured fact.
    All four are additive with defaults so older stored payloads still validate.
    """

    model_config = ConfigDict(frozen=True)

    key_graha: PlanetName
    key_graha_rupas: float
    key_graha_meets_minimum: bool
    sav_bindus: int  # SAV summed over the domain's houses
    band: StrengthBand
    shadbala_pct: float = 0.0  # 0..100; required_rupas -> 60% pass line, 2×required -> 100%
    sav_pct: float = 0.0  # 0..100; 100·avg_bindus/56, so the śāstric average 28 -> 50%
    strength_pct: float = 0.0  # headline = min(shadbala_pct, sav_pct): the weaker classical axis
    strength_tier: Literal["model"] = "model"  # Layer-2 model over exact BPHS inputs, not measured
    approximated: bool = True
    note: str = (
        "band = AlmaMesh heuristic over exact Shadbala Rupas + SAV bindus; "
        "inputs are BPHS-rigorous, the threshold mapping is a coarse synthesis."
    )


class CurrentEmphasis(BaseModel):
    """Is the domain "lit up" right now — by the active dasha and/or a transit?

    ``active_dasha_significator`` is True when the running maha/antar/pratyantar
    lord is one of the domain's house-lords or karakas. ``dasha_levels`` lists
    which levels match (e.g. ["maha", "antar"]). ``under_sade_sati`` and the
    severity capture whether a domain-relevant slow transit is in play now.
    ``transit_severity`` is a coarse vote-sum (supportive minus challenging
    signal counts), so it is explicitly flagged ``approximated`` — the inputs
    (dashas, gochara, Sade Sati) are exact; the net valence is a heuristic.
    """

    model_config = ConfigDict(frozen=True)

    active_dasha_significator: bool
    dasha_levels: list[str] = Field(default_factory=list)  # subset of maha/antar/pratyantar
    matched_dasha_lords: list[PlanetName] = Field(default_factory=list)
    under_sade_sati: bool
    transit_severity: TransitSeverity  # net valence of domain-relevant transits now
    approximated: bool = True
    note: str = (
        "transit_severity = sign of a coarse vote-sum over domain-relevant "
        "transit signals; the signals are exact, the netting is an AlmaMesh "
        "heuristic (not a BPHS quantity)."
    )
    rule: str


class DomainWindow(BaseModel):
    """One dated, structured, prose-free upcoming event for THIS domain.

    Sourced from a dasha sub-period boundary or a transit-timeline event that
    touches one of the domain's significators (house-lords / karakas). The LLM
    narrates later — this is a machine key + valence only.
    """

    model_config = ConfigDict(frozen=True)

    date: datetime  # UTC instant of the window
    source: WindowSource
    kind: TransitEventKind  # DASHA_CHANGE for dasha windows; the event kind otherwise
    trigger: PlanetName | None = None  # the graha whose motion/lordship triggered it
    severity: TransitSeverity  # supportive / neutral / challenging
    descriptor: str  # STABLE machine key, e.g. "career.dasha.maha.saturn"


# --- one domain's full forecast ---


class LifeDomainForecast(BaseModel):
    """The deterministic synthesis for ONE life domain."""

    model_config = ConfigDict(frozen=True)

    domain: LifeDomain
    houses: list[HouseSignificator]
    karakas: list[KarakaSignificator]
    varga: VargaPlacementSummary
    strength_summary: StrengthSummary
    current_emphasis: CurrentEmphasis
    upcoming_windows: list[DomainWindow]  # chronologically sorted


class LifeDomainsContext(BaseModel):
    """Every life-domain forecast for one chart + instant.

    Computed deterministically and READ-ONLY from the four injected predictive
    contexts (the contexts already pin their reference instant). ``instant`` is
    echoed from the transit context for audit. Separate from the natal output by
    design; ``forecasts`` always carries every member of ``LifeDomain``.
    """

    model_config = ConfigDict(frozen=True)

    instant: datetime  # the transit "now" the forecast is anchored to (UTC)
    forecasts: dict[LifeDomain, LifeDomainForecast]


__all__ = [
    "CurrentEmphasis",
    "DomainWindow",
    "HouseSignificator",
    "KarakaSignificator",
    "LifeDomain",
    "LifeDomainForecast",
    "LifeDomainsContext",
    "StrengthBand",
    "StrengthSummary",
    "VargaPlacementSummary",
    "WindowSource",
]
