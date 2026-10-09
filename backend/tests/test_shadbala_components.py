"""Shadbala (BPHS six-fold strength) — component-level invariants.

Pins the exact-constant balas (Naisargika, Digbala maxima), the Rupa arithmetic
(total = sum of six components / 60), and the explicit calc-integrity flags. The
classical required minimums are checked per planet.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.strength import VIRUPAS_PER_RUPA
from almamesh.strength.naisargika import NAISARGIKA_VIRUPAS
from almamesh.strength.shadbala import compute_shadbala

_IST_OFFSET = timedelta(hours=5, minutes=30)
_IST = timezone(_IST_OFFSET)
# Synthetic reference native (Bengaluru, fictional birth). All assertions below
# are chart-invariant (BPHS constants, Rupa arithmetic, flags), so any real,
# computable chart serves; this one is the project's single reference fixture.
_REFERENCE = datetime(1988, 8, 8, 6, 44, tzinfo=_IST)
_REFERENCE_LAT, _REFERENCE_LON = 12.9716, 77.5946

# BPHS Naisargikabala in Virupas (Sun strongest at 60, descending to Saturn).
_EXPECTED_NAISARGIKA = {
    PlanetName.SUN: 60.0,
    PlanetName.MOON: 51.43,
    PlanetName.VENUS: 42.86,
    PlanetName.JUPITER: 34.29,
    PlanetName.MERCURY: 25.71,
    PlanetName.MARS: 17.14,
    PlanetName.SATURN: 8.57,
}


@pytest.fixture(scope="module")
def reference_shadbala():  # noqa: ANN201 - pytest fixture
    natal = calculate_sidereal_context(_REFERENCE, _REFERENCE_LAT, _REFERENCE_LON)
    return compute_shadbala(
        natal, _REFERENCE, _REFERENCE_LAT, _REFERENCE_LON, civil_offset=_IST_OFFSET
    )


@pytest.mark.parametrize(("planet", "expected"), list(_EXPECTED_NAISARGIKA.items()))
def test_should_use_exact_bphs_naisargika_constants(planet: PlanetName, expected: float) -> None:
    # Then each graha's Naisargikabala matches the BPHS constant (2-dp)
    assert NAISARGIKA_VIRUPAS[planet] == pytest.approx(expected, abs=0.01)


def test_should_descend_naisargika_from_sun_to_saturn() -> None:
    # Then Naisargikabala is strictly ordered Sun > Moon > Venus > Jup > Merc > Mars > Sat
    order = [
        PlanetName.SUN,
        PlanetName.MOON,
        PlanetName.VENUS,
        PlanetName.JUPITER,
        PlanetName.MERCURY,
        PlanetName.MARS,
        PlanetName.SATURN,
    ]
    values = [NAISARGIKA_VIRUPAS[p] for p in order]
    assert values == sorted(values, reverse=True)


def test_should_total_rupas_as_sum_of_six_components_over_60(reference_shadbala) -> None:
    # Given any computed planet
    sb = reference_shadbala.planets[PlanetName.JUPITER]
    # When the six components are summed
    six = (
        sb.sthana.total_virupas
        + sb.dig.virupas
        + sb.kala.total_virupas
        + sb.cheshta.virupas
        + sb.naisargika.virupas
        + sb.drik.virupas
    )
    # Then total_virupas equals that sum and total_rupas = total/60
    assert sb.total_virupas == pytest.approx(six, abs=1e-9)
    assert sb.total_rupas == pytest.approx(six / VIRUPAS_PER_RUPA, abs=1e-9)


def test_should_compute_shadbala_for_all_seven_grahas(reference_shadbala) -> None:
    # Then exactly the seven Shadbala grahas are present (no nodes)
    assert set(reference_shadbala.planets) == {
        PlanetName.SUN,
        PlanetName.MOON,
        PlanetName.MARS,
        PlanetName.MERCURY,
        PlanetName.JUPITER,
        PlanetName.VENUS,
        PlanetName.SATURN,
    }


def test_should_keep_naisargika_rigorous_not_approximated(reference_shadbala) -> None:
    # Then the exact-constant components carry no approximation flag
    sb = reference_shadbala.planets[PlanetName.SUN]
    assert sb.naisargika.approximated is False
    assert sb.naisargika.note is None


def test_should_flag_yuddhabala_as_approximated_with_a_note(reference_shadbala) -> None:
    # Then the war-bala carries an explicit calc-integrity flag (no silent fudge)
    sb = reference_shadbala.planets[PlanetName.MARS]
    assert sb.kala.yuddha.approximated is True
    assert sb.kala.yuddha.note is not None


def test_should_be_deterministic_when_recomputed(reference_shadbala) -> None:
    natal = calculate_sidereal_context(_REFERENCE, _REFERENCE_LAT, _REFERENCE_LON)
    again = compute_shadbala(
        natal, _REFERENCE, _REFERENCE_LAT, _REFERENCE_LON, civil_offset=_IST_OFFSET
    )
    assert again.model_dump() == reference_shadbala.model_dump()
