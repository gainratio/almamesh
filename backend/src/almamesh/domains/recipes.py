"""The closed classical significator registry for each life domain.

Each ``DomainRecipe`` is the prose-free, frozen rule set the synthesis engine
applies: which bhavas (houses), which natural karakas, and which defining varga
chart govern the domain — every entry carries the classical citation string the
forecast surfaces. This is the single source of truth for the domain→signator
mapping; the engine never hard-codes houses inline.

Significators follow BPHS / standard Parashari karakatva:
- career:        10th (karma) + karakas Sun/Saturn/Mercury + D10 Dasamsa
- finances:      2nd (dhana) & 11th (labha) + karaka Jupiter + D2 Hora
- health:        1st/6th/8th + karaka Sun (vitality) + D30 Trimsamsa
- relationships: 7th + karakas Venus & Jupiter + D9 Navamsa
- spiritual:     9th/12th/5th + karakas Jupiter & Ketu + D20 Vimsamsa
- education:     4th/5th + karakas Mercury & Jupiter + D24 Siddhamsa
- family:        2nd/4th (+5th progeny) + D12 Dwadasamsa
- obstacles:     6th (ripu), 8th (randhra), 12th (vyaya) — the dusthanas — + D30
                 Trimsamsa; karakas Saturn/Mars/Rahu are CONTEXT ONLY (see
                 ``DomainRecipe.activation_only``)
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from almamesh.constants.astrology import PlanetName
from almamesh.schemas.domains import LifeDomain
from almamesh.schemas.vargas import DivisionalChart


class HouseRule(BaseModel):
    """One bhava that signifies a domain, with its classical citation.

    ``meaning`` is an optional plain-language label the period reading appends
    to a factor that cites this house (e.g. "losses and expenses").
    """

    model_config = ConfigDict(frozen=True)

    house: int
    rule: str
    meaning: str | None = None


class KarakaRule(BaseModel):
    """One natural karaka for a domain, with its classical citation."""

    model_config = ConfigDict(frozen=True)

    graha: PlanetName
    rule: str


class VargaRule(BaseModel):
    """The defining divisional chart for a domain, with its citation."""

    model_config = ConfigDict(frozen=True)

    chart: DivisionalChart
    rule: str


class DomainRecipe(BaseModel):
    """The full classical recipe for one life domain.

    ``key_graha`` is the single primary significator whose Shadbala anchors the
    strength band (the most karaka of the karakas for that domain).
    ``sade_sati_sensitive`` marks the domains classically afflicted by Sade Sati
    itself (Saturn over the natal Moon = body/mind), beyond the generic
    Moon-as-significator relevance the engine always applies.

    ``activation_only`` is the base-rate guard for a domain every chart always
    has (the dusthanas). Its karakas are context labels only: they never make a
    graha a significator, so a running Saturn activates the domain only when
    Saturn rules or occupies one of its houses. And its reading strength is the
    period's activation, never a karaka's natal Shadbala, which would read the
    same every month for the same person.

    ``mars_windows`` dates a window whenever Mars enters one of the domain's
    house signs or the natal Moon's or lagna's sign. Mars changes sign about
    every six weeks, too often to be signal for most domains; for obstacles its
    transit over the dusthanas and the natal Moon/lagna is the classical trigger.
    """

    model_config = ConfigDict(frozen=True)

    domain: LifeDomain
    houses: tuple[HouseRule, ...]
    karakas: tuple[KarakaRule, ...]
    varga: VargaRule
    key_graha: PlanetName
    sade_sati_sensitive: bool = False
    activation_only: bool = False
    mars_windows: bool = False


def _h(house: int, rule: str, meaning: str | None = None) -> HouseRule:
    return HouseRule(house=house, rule=rule, meaning=meaning)


def _k(graha: PlanetName, rule: str) -> KarakaRule:
    return KarakaRule(graha=graha, rule=rule)


_CAREER = DomainRecipe(
    domain=LifeDomain.CAREER,
    houses=(_h(10, "career: 10th house of karma/profession"),),
    karakas=(
        _k(PlanetName.SUN, "Sun = karaka of authority & status"),
        _k(PlanetName.SATURN, "Saturn = karaka of work, service & discipline"),
        _k(PlanetName.MERCURY, "Mercury = karaka of commerce & skill"),
    ),
    varga=VargaRule(chart=DivisionalChart.D10, rule="D10 Dasamsa governs career & public standing"),
    key_graha=PlanetName.SATURN,
)

_FINANCES = DomainRecipe(
    domain=LifeDomain.FINANCES,
    houses=(
        _h(2, "finances: 2nd house of accumulated wealth (dhana)"),
        _h(11, "finances: 11th house of gains (labha)"),
    ),
    karakas=(_k(PlanetName.JUPITER, "Jupiter = karaka of wealth & expansion"),),
    varga=VargaRule(chart=DivisionalChart.D2, rule="D2 Hora governs wealth & prosperity"),
    key_graha=PlanetName.JUPITER,
)

_HEALTH = DomainRecipe(
    domain=LifeDomain.HEALTH,
    houses=(
        _h(1, "health: 1st house of body & vitality"),
        _h(6, "health: 6th house of disease & recovery"),
        _h(8, "health: 8th house of chronic illness & longevity"),
    ),
    karakas=(_k(PlanetName.SUN, "Sun = karaka of vitality (aatma/prana)"),),
    varga=VargaRule(chart=DivisionalChart.D30, rule="D30 Trimsamsa governs misfortunes & health"),
    key_graha=PlanetName.SUN,
    sade_sati_sensitive=True,  # Sade Sati = Saturn over the natal Moon: body & mind
)

_RELATIONSHIPS = DomainRecipe(
    domain=LifeDomain.RELATIONSHIPS,
    houses=(_h(7, "relationships: 7th house of marriage & partnership"),),
    karakas=(
        _k(PlanetName.VENUS, "Venus = karaka of marriage & love"),
        _k(
            PlanetName.JUPITER,
            "Jupiter = classical karaka of spouse/dharma (texts cite it for the "
            "husband; applied gender-neutrally — the engine takes no gender input)",
        ),
    ),
    varga=VargaRule(chart=DivisionalChart.D9, rule="D9 Navamsa governs spouse & marital dharma"),
    key_graha=PlanetName.VENUS,
)

_SPIRITUAL = DomainRecipe(
    domain=LifeDomain.SPIRITUAL,
    houses=(
        _h(9, "spiritual: 9th house of dharma & higher wisdom"),
        _h(12, "spiritual: 12th house of moksha & liberation"),
        _h(5, "spiritual: 5th house of purva-punya & mantra"),
    ),
    karakas=(
        _k(PlanetName.JUPITER, "Jupiter = karaka of dharma & wisdom"),
        _k(PlanetName.KETU, "Ketu = karaka of moksha & detachment"),
    ),
    varga=VargaRule(chart=DivisionalChart.D20, rule="D20 Vimsamsa governs spiritual pursuits"),
    key_graha=PlanetName.JUPITER,
)

_EDUCATION = DomainRecipe(
    domain=LifeDomain.EDUCATION,
    houses=(
        _h(4, "education: 4th house of foundational schooling"),
        _h(5, "education: 5th house of intelligence & learning"),
    ),
    karakas=(
        _k(PlanetName.MERCURY, "Mercury = karaka of intellect & learning"),
        _k(PlanetName.JUPITER, "Jupiter = karaka of knowledge & teachers"),
    ),
    varga=VargaRule(chart=DivisionalChart.D24, rule="D24 Siddhamsa governs education & learning"),
    key_graha=PlanetName.MERCURY,
)

_FAMILY = DomainRecipe(
    domain=LifeDomain.FAMILY,
    houses=(
        _h(2, "family: 2nd house of kutumba (immediate family)"),
        _h(4, "family: 4th house of mother & home"),
        _h(5, "family: 5th house of progeny"),
        _h(9, "family: 9th house of father & lineage dharma"),
    ),
    karakas=(_k(PlanetName.JUPITER, "Jupiter = karaka of progeny & family lineage"),),
    varga=VargaRule(chart=DivisionalChart.D12, rule="D12 Dwadasamsa governs parents & lineage"),
    key_graha=PlanetName.JUPITER,
)

# BPHS ch. 11 (bhava significations): the 6th is ripu/roga (enemies, disputes,
# litigation, debts), the 8th randhra (sudden reversals, obstacles), the 12th
# vyaya (losses, expenses, confinement). Saturn, Mars and Rahu are their natural
# malefic karakas; with ``activation_only`` they label context, never count.
_OBSTACLES = DomainRecipe(
    domain=LifeDomain.OBSTACLES,
    houses=(
        _h(
            6,
            "obstacles: 6th house of disputes, litigation, friction with rules or authorities",
            "legal or administrative matters",
        ),
        _h(8, "obstacles: 8th house of sudden setbacks and reversals", "unexpected setbacks"),
        _h(12, "obstacles: 12th house of losses, expenses and confinement", "losses and expenses"),
    ),
    karakas=(
        _k(PlanetName.SATURN, "Saturn = karaka of delay, hardship & restriction (context only)"),
        _k(PlanetName.MARS, "Mars = karaka of conflict, accidents & disputes (context only)"),
        _k(PlanetName.RAHU, "Rahu = karaka of upheaval & the unexpected (context only)"),
    ),
    varga=VargaRule(chart=DivisionalChart.D30, rule="D30 Trimsamsa governs misfortunes & evils"),
    # Natal context only (Saturn is the classical karaka of the 8th and 12th):
    # the reading's obstacles strength is period activation, see activation_only.
    key_graha=PlanetName.SATURN,
    activation_only=True,
    mars_windows=True,
)


DOMAIN_RECIPES: dict[LifeDomain, DomainRecipe] = {
    LifeDomain.CAREER: _CAREER,
    LifeDomain.FINANCES: _FINANCES,
    LifeDomain.HEALTH: _HEALTH,
    LifeDomain.RELATIONSHIPS: _RELATIONSHIPS,
    LifeDomain.SPIRITUAL: _SPIRITUAL,
    LifeDomain.EDUCATION: _EDUCATION,
    LifeDomain.FAMILY: _FAMILY,
    LifeDomain.OBSTACLES: _OBSTACLES,
}


__all__ = ["DOMAIN_RECIPES", "DomainRecipe", "HouseRule", "KarakaRule", "VargaRule"]
