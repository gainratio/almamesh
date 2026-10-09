"""Behavioral + invariant tests for the Phase-4 life-domain synthesis engine.

``compute_life_domains`` fuses the four predictive contexts (natal + transit +
varga + strength) into one ``LifeDomainForecast`` per life domain. Everything
asserted here is re-derived from the engine inputs inside the test — never a
hardcoded chart value — so the suite stays generic across charts (the synthetic
reference native is one case among others, per the calc-integrity mandate).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.domains import compute_life_domains
from almamesh.domains.recipes import DOMAIN_RECIPES
from almamesh.domains.strength_summary import _band, _pct_sav, _pct_shadbala
from almamesh.schemas.domains import (
    LifeDomain,
    LifeDomainsContext,
    WindowSource,
)
from almamesh.schemas.transits import TransitEventKind
from almamesh.schemas.vargas import DivisionalChart
from almamesh.strength import compute_strength_context
from almamesh.transits import calculate_transit_context
from almamesh.vargas import compute_varga_context

if TYPE_CHECKING:
    from almamesh.domains.recipes import DomainRecipe
    from almamesh.schemas.astrology import SiderealContext
    from almamesh.schemas.strength import StrengthContext
    from almamesh.schemas.transits import TransitContext
    from almamesh.schemas.vargas import VargaContext

# Pinned instants so every test run sees the same dashas + transits.
FIXED_REFERENCE_DATE = datetime(2025, 1, 1, tzinfo=UTC)
FIXED_TRANSIT_INSTANT = datetime(2025, 1, 1, tzinfo=UTC)

# (iso birth, lat, lon) — the synthetic reference native is ONE generic case among others.
# The birthplace civil offset (IST) rides along: Kalabala needs it explicitly.
_IST = timedelta(minutes=330)
CASES: dict[str, tuple[str, float, float]] = {
    "reference_native": ("1988-08-08T06:44:00+05:30", 12.9716, 77.5946),
    "delhi_1990": ("1990-01-15T12:00:00+00:00", 28.6139, 77.2090),
}

Pipeline = tuple[
    "SiderealContext", "TransitContext", "VargaContext", "StrengthContext", LifeDomainsContext
]


def _build_pipeline(iso: str, lat: float, lon: float) -> Pipeline:
    birth = datetime.fromisoformat(iso)
    natal = calculate_sidereal_context(birth, lat, lon, reference_date=FIXED_REFERENCE_DATE)
    transits = calculate_transit_context(natal, birth, transit_instant=FIXED_TRANSIT_INSTANT)
    vargas = compute_varga_context(natal)
    strength = compute_strength_context(natal, birth, lat, lon, civil_offset=_IST)
    domains = compute_life_domains(natal, transits, vargas, strength)
    return natal, transits, vargas, strength, domains


@pytest.fixture(scope="module")
def pipelines() -> dict[str, Pipeline]:
    """The four predictive contexts + the domain synthesis, per fixture case."""
    return {name: _build_pipeline(*case) for name, case in CASES.items()}


def _significator_grahas(natal: SiderealContext, recipe: DomainRecipe) -> set[PlanetName]:
    """Independent re-derivation: house lords + karakas + occupants of the houses."""
    houses = {h.house for h in recipe.houses}
    lords = {natal.houses[h].sign_lord for h in houses}
    karakas = {k.graha for k in recipe.karakas}
    occupants = {p.name for p in natal.planets.values() if p.house in houses}
    return lords | karakas | occupants


# --- the recipe registry encodes the approved classical map ---


def test_registry_covers_all_seven_domains() -> None:
    assert set(DOMAIN_RECIPES) == set(LifeDomain)


def test_registry_encodes_classical_houses_and_vargas() -> None:
    expected: dict[LifeDomain, tuple[set[int], DivisionalChart]] = {
        LifeDomain.CAREER: ({10}, DivisionalChart.D10),
        LifeDomain.FINANCES: ({2, 11}, DivisionalChart.D2),
        LifeDomain.HEALTH: ({1, 6, 8}, DivisionalChart.D30),
        LifeDomain.RELATIONSHIPS: ({7}, DivisionalChart.D9),
        LifeDomain.SPIRITUAL: ({9, 12, 5}, DivisionalChart.D20),
        LifeDomain.EDUCATION: ({4, 5}, DivisionalChart.D24),
        LifeDomain.FAMILY: ({2, 4, 5, 9}, DivisionalChart.D12),
    }
    for domain, (houses, varga) in expected.items():
        recipe = DOMAIN_RECIPES[domain]
        assert {h.house for h in recipe.houses} == houses, domain
        assert recipe.varga.chart == varga, domain


def test_registry_career_karakas_are_sun_saturn_mercury() -> None:
    karakas = {k.graha for k in DOMAIN_RECIPES[LifeDomain.CAREER].karakas}
    assert karakas == {PlanetName.SUN, PlanetName.SATURN, PlanetName.MERCURY}


# --- invariants ---


def test_all_seven_domains_always_present(pipelines: dict[str, Pipeline]) -> None:
    for *_, domains in pipelines.values():
        assert set(domains.forecasts) == set(LifeDomain)


def test_instant_echoes_the_transit_instant(pipelines: dict[str, Pipeline]) -> None:
    for _, transits, _, _, domains in pipelines.values():
        assert domains.instant == transits.instant


def test_output_is_deterministic(pipelines: dict[str, Pipeline]) -> None:
    for natal, transits, vargas, strength, domains in pipelines.values():
        rerun = compute_life_domains(natal, transits, vargas, strength)
        assert rerun.model_dump_json() == domains.model_dump_json()


def test_inputs_are_not_mutated(pipelines: dict[str, Pipeline]) -> None:
    for natal, transits, vargas, strength, _ in pipelines.values():
        before = [m.model_dump_json() for m in (natal, transits, vargas, strength)]
        compute_life_domains(natal, transits, vargas, strength)
        after = [m.model_dump_json() for m in (natal, transits, vargas, strength)]
        assert before == after


def test_serialization_round_trips_byte_identical(pipelines: dict[str, Pipeline]) -> None:
    for *_, domains in pipelines.values():
        dumped = domains.model_dump_json()
        assert LifeDomainsContext.model_validate_json(dumped).model_dump_json() == dumped


# --- windows ---


def test_windows_sorted_with_timezone_aware_dates(pipelines: dict[str, Pipeline]) -> None:
    for *_, domains in pipelines.values():
        for forecast in domains.forecasts.values():
            dates = [w.date for w in forecast.upcoming_windows]
            assert all(d.tzinfo is not None for d in dates)
            assert dates == sorted(dates)


def test_every_window_traces_to_a_real_timeline_event(pipelines: dict[str, Pipeline]) -> None:
    """No invented events: each window maps back to an engine timeline event."""
    for _, transits, _, _, domains in pipelines.values():
        by_descriptor = {(e.descriptor, e.date) for e in transits.timeline.events}
        for forecast in domains.forecasts.values():
            for window in forecast.upcoming_windows:
                domain, source, engine_key = window.descriptor.split(".", 2)
                assert domain == forecast.domain.value
                assert source == window.source.value
                assert (engine_key, window.date) in by_descriptor


def test_dasha_windows_carry_dasha_kind_and_significator_trigger(
    pipelines: dict[str, Pipeline],
) -> None:
    for natal, _, _, _, domains in pipelines.values():
        for domain, forecast in domains.forecasts.items():
            sigs = _significator_grahas(natal, DOMAIN_RECIPES[domain])
            for window in forecast.upcoming_windows:
                if window.source is WindowSource.DASHA:
                    assert window.kind == TransitEventKind.DASHA_CHANGE
                    assert window.trigger in sigs


# --- houses & karakas mirror the natal chart ---


def test_career_house_significator_matches_natal(pipelines: dict[str, Pipeline]) -> None:
    for natal, _, _, _, domains in pipelines.values():
        (tenth,) = domains.forecasts[LifeDomain.CAREER].houses
        lord = natal.houses[10].sign_lord
        assert tenth.house == 10
        assert tenth.sign == natal.houses[10].sign
        assert tenth.lord == lord
        assert tenth.lord_house == natal.planets[lord].house
        assert tenth.lord_sign == natal.planets[lord].sign
        assert tenth.lord_dignity == natal.planets[lord].dignity


def test_relationships_venus_karaka_matches_natal(pipelines: dict[str, Pipeline]) -> None:
    for natal, _, _, _, domains in pipelines.values():
        karakas = {k.graha: k for k in domains.forecasts[LifeDomain.RELATIONSHIPS].karakas}
        venus = karakas[PlanetName.VENUS]
        natal_venus = natal.planets[PlanetName.VENUS]
        assert venus.house == natal_venus.house
        assert venus.sign == natal_venus.sign
        assert venus.dignity == natal_venus.dignity
        assert venus.is_retrograde == natal_venus.is_retrograde


# --- varga + strength summaries mirror their engines ---


def test_varga_summary_uses_the_domain_defining_chart(pipelines: dict[str, Pipeline]) -> None:
    for _, _, vargas, _, domains in pipelines.values():
        for domain, forecast in domains.forecasts.items():
            recipe = DOMAIN_RECIPES[domain]
            placed = vargas.charts[recipe.varga.chart].placements[recipe.key_graha]
            d1_sign = vargas.charts[DivisionalChart.D1].placements[recipe.key_graha].sign
            assert forecast.varga.chart == recipe.varga.chart
            assert forecast.varga.graha == recipe.key_graha
            assert forecast.varga.sign == placed.sign
            assert forecast.varga.sign_lord == placed.sign_lord
            assert forecast.varga.same_sign_as_d1 == (d1_sign == placed.sign)


def test_vargottama_is_claimed_only_for_the_d9_navamsa(pipelines: dict[str, Pipeline]) -> None:
    """Classical BPHS vargottama is a D1==D9 marker; other vargas only get the
    honest generalized ``same_sign_as_d1`` flag, never the vargottama label."""
    for _, _, vargas, _, domains in pipelines.values():
        for domain, forecast in domains.forecasts.items():
            recipe = DOMAIN_RECIPES[domain]
            placed = vargas.charts[recipe.varga.chart].placements[recipe.key_graha]
            d1_sign = vargas.charts[DivisionalChart.D1].placements[recipe.key_graha].sign
            if recipe.varga.chart is DivisionalChart.D9:
                assert forecast.varga.vargottama == (d1_sign == placed.sign)
            else:
                assert forecast.varga.vargottama is False


def test_strength_summary_fuses_shadbala_and_sav(pipelines: dict[str, Pipeline]) -> None:
    for natal, _, _, strength, domains in pipelines.values():
        for domain, forecast in domains.forecasts.items():
            recipe = DOMAIN_RECIPES[domain]
            bala = strength.shadbala.planets[recipe.key_graha]
            sav = strength.ashtakavarga.sarva.bindus
            expected_bindus = sum(sav[natal.houses[h.house].sign] for h in recipe.houses)
            summary = forecast.strength_summary
            assert summary.key_graha == recipe.key_graha
            assert summary.key_graha_rupas == bala.total_rupas
            assert summary.key_graha_meets_minimum == bala.meets_minimum
            assert summary.sav_bindus == expected_bindus
            expected_avg = expected_bindus / len(recipe.houses)
            assert summary.band is _band(bala.meets_minimum, expected_avg)
            assert summary.approximated is True  # banding is a flagged heuristic


def test_strength_summary_threads_the_calibrated_pct_axes(pipelines: dict[str, Pipeline]) -> None:
    """The Stage-2 calibrated %s wire through on real charts: two anchored axes
    (re-derived here from the engine inputs) and a min-combiner headline, all in
    [0, 100], tier-tagged ``model`` (Tier M — a Layer-2 model, never measured)."""
    for natal, _, _, strength, domains in pipelines.values():
        for domain, forecast in domains.forecasts.items():
            recipe = DOMAIN_RECIPES[domain]
            bala = strength.shadbala.planets[recipe.key_graha]
            sav = strength.ashtakavarga.sarva.bindus
            bindus = sum(sav[natal.houses[h.house].sign] for h in recipe.houses)
            expected_shadbala = _pct_shadbala(bala.total_rupas, bala.required_rupas)
            expected_sav = _pct_sav(bindus / len(recipe.houses))
            summary = forecast.strength_summary
            assert summary.shadbala_pct == pytest.approx(expected_shadbala)
            assert summary.sav_pct == pytest.approx(expected_sav)
            assert summary.strength_pct == pytest.approx(min(expected_shadbala, expected_sav))
            assert 0.0 <= summary.strength_pct <= 100.0
            assert summary.strength_tier == "model"


# --- current emphasis ---


def test_dasha_emphasis_matches_independent_significator_set(
    pipelines: dict[str, Pipeline],
) -> None:
    for natal, _, _, _, domains in pipelines.values():
        levels = {
            "maha": natal.dashas.current_maha,
            "antar": natal.dashas.current_antar,
            "pratyantar": natal.dashas.current_pratyantar,
        }
        for domain, forecast in domains.forecasts.items():
            sigs = _significator_grahas(natal, DOMAIN_RECIPES[domain])
            expected = [name for name, p in levels.items() if p and p.lord in sigs]
            emphasis = forecast.current_emphasis
            assert emphasis.dasha_levels == expected
            assert emphasis.active_dasha_significator == bool(expected)
            assert all(lord in sigs for lord in emphasis.matched_dasha_lords)


def test_emphasis_severity_is_a_flagged_vote_sum_heuristic(
    pipelines: dict[str, Pipeline],
) -> None:
    """The net transit valence is a coarse vote-sum, and it says so explicitly."""
    for *_, domains in pipelines.values():
        for forecast in domains.forecasts.values():
            emphasis = forecast.current_emphasis
            assert emphasis.approximated is True
            assert "vote" in emphasis.note


def test_under_sade_sati_requires_active_cycle_and_health_is_sensitive(
    pipelines: dict[str, Pipeline],
) -> None:
    for _, transits, _, _, domains in pipelines.values():
        flags = {d: f.current_emphasis.under_sade_sati for d, f in domains.forecasts.items()}
        if not transits.sade_sati.is_active:
            assert not any(flags.values())
        else:
            assert flags[LifeDomain.HEALTH] is True
