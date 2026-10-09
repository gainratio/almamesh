"""Contract tests for the LAZY predictive runtime entrypoint.

The predictive superset (transits + all 16 vargas + strength + life domains) is
computed SEPARATELY from the natal chart call — transits take ~35s under
Pyodide, so the natal pipeline stays fast and byte-identical. The entrypoint
takes an EXPLICIT reference instant (never a silent ``now()``): it pins BOTH
the natal "current" dasha and the transit "now", making the payload fully
reproducible (required for the CPython==Pyodide byte-parity gate).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import calculate_sidereal_context
from almamesh.domains import compute_life_domains
from almamesh.edge.chart_runtime import compute_predictive
from almamesh.predictive import PredictiveContexts, compute_predictive_contexts
from almamesh.strength import compute_strength_context
from almamesh.transits import calculate_transit_context
from almamesh.vargas import compute_varga_context

BIRTH_ISO = "1990-01-15T12:00:00+00:00"  # the Delhi golden fixture
LATITUDE = 28.6139
LONGITUDE = 77.2090
REFERENCE_INSTANT = datetime(2026, 6, 9, 12, 0, 0, tzinfo=UTC)
IST_MINUTES = 330  # Asia/Kolkata, the birthplace's civil offset
IST = timedelta(minutes=IST_MINUTES)

PAYLOAD_KEYS = frozenset(
    {
        "transit_context",
        "varga_context_full",
        "strength_context",
        "domains_context",
    }
)


@pytest.fixture(scope="module")
def contexts() -> PredictiveContexts:
    birth = datetime.fromisoformat(BIRTH_ISO)
    return compute_predictive_contexts(
        birth, LATITUDE, LONGITUDE, REFERENCE_INSTANT, civil_offset=IST
    )


@pytest.fixture(scope="module")
def payload() -> dict[str, object]:
    return compute_predictive(
        {
            "datetime_utc": BIRTH_ISO,
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "reference_instant": REFERENCE_INSTANT.isoformat(),
            "utc_offset_minutes": IST_MINUTES,
        }
    )


def test_contexts_match_the_standalone_pipeline(contexts: PredictiveContexts) -> None:
    """The composed entrypoint is byte-equal to calling the four engines directly."""
    birth = datetime.fromisoformat(BIRTH_ISO)
    natal = calculate_sidereal_context(birth, LATITUDE, LONGITUDE, reference_date=REFERENCE_INSTANT)
    transits = calculate_transit_context(natal, birth, transit_instant=REFERENCE_INSTANT)
    vargas = compute_varga_context(natal)
    strength = compute_strength_context(natal, birth, LATITUDE, LONGITUDE, civil_offset=IST)
    domains = compute_life_domains(natal, transits, vargas, strength)
    assert contexts.transit_context.model_dump_json() == transits.model_dump_json()
    assert contexts.varga_context_full.model_dump_json() == vargas.model_dump_json()
    assert contexts.strength_context.model_dump_json() == strength.model_dump_json()
    assert contexts.domains_context.model_dump_json() == domains.model_dump_json()


def test_payload_has_exactly_the_four_context_keys(payload: dict[str, object]) -> None:
    """The four contexts and NOTHING else — the engine computes, it does not sign.

    Strength receipts are added by the browser Worker's TypeScript after this
    payload crosses the runtime boundary, so this CPython path and the Pyodide
    path emit identical bytes."""
    assert set(payload) == PAYLOAD_KEYS


def test_payload_values_are_the_bare_context_dumps(
    payload: dict[str, object], contexts: PredictiveContexts
) -> None:
    """Each top-level key is the bare ``model_dump(mode="json")`` of its context."""
    assert payload["transit_context"] == contexts.transit_context.model_dump(mode="json")
    assert payload["varga_context_full"] == contexts.varga_context_full.model_dump(mode="json")
    assert payload["strength_context"] == contexts.strength_context.model_dump(mode="json")
    assert payload["domains_context"] == contexts.domains_context.model_dump(mode="json")


def test_strength_context_is_the_bare_object(payload: dict[str, object]) -> None:
    strength = payload["strength_context"]
    assert isinstance(strength, dict)
    assert set(strength) == {"sunrise_utc_iso", "ashtakavarga", "shadbala"}


def test_reference_instant_is_required_no_silent_now() -> None:
    """Omitting the reference instant must raise — the engine never reads the clock."""
    with pytest.raises(KeyError):
        compute_predictive(
            {
                "datetime_utc": BIRTH_ISO,
                "latitude": LATITUDE,
                "longitude": LONGITUDE,
                "utc_offset_minutes": IST_MINUTES,
            }
        )


def test_payload_is_deterministic(payload: dict[str, object]) -> None:
    rerun = compute_predictive(
        {
            "datetime_utc": BIRTH_ISO,
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "reference_instant": REFERENCE_INSTANT.isoformat(),
            "utc_offset_minutes": IST_MINUTES,
        }
    )
    assert rerun == payload


def test_should_refuse_payload_when_civil_offset_is_missing() -> None:
    """No birthplace offset, no weekday: the engine never guesses one."""
    # Given a payload without utc_offset_minutes / When computed / Then it raises
    with pytest.raises(KeyError):
        compute_predictive(
            {
                "datetime_utc": BIRTH_ISO,
                "latitude": LATITUDE,
                "longitude": LONGITUDE,
                "reference_instant": REFERENCE_INSTANT.isoformat(),
            }
        )


@pytest.mark.parametrize("bad", [330.5, 24 * 60, -24 * 60, True, "330", None])
def test_should_refuse_payload_when_civil_offset_is_not_whole_minutes_in_range(
    bad: object,
) -> None:
    # Given a malformed offset / When computed / Then it raises ValueError
    with pytest.raises(ValueError, match="utc_offset_minutes"):
        compute_predictive(
            {
                "datetime_utc": BIRTH_ISO,
                "latitude": LATITUDE,
                "longitude": LONGITUDE,
                "reference_instant": REFERENCE_INSTANT.isoformat(),
                "utc_offset_minutes": bad,
            }
        )
