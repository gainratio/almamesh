"""The SHIPPED browser glue, executed under CPython.

``PY_BOOTSTRAP`` in ``frontend/packages/browser/src/pyodide/chartWorker.ts`` is
the exact Python the Pyodide chart Worker runs in the browser. Every other
engine test calls ``calculate_sidereal_context`` directly and passes a
``reference_date`` the shipped path never passed -- so the suite proved the
reference instant is INJECTABLE and never that it is INJECTED. See
``test_dasha_reference_date.py``: its four tests all hand the engine an
explicit instant, so a chart path that silently read the wall clock sailed
through every one of them.

This module closes that gap by reading the glue OUT of the TypeScript file and
running it, so there is no second copy to drift (a rule written twice in two
languages diverges; a rule read once cannot).

The two user-facing claims under test:

- README "chart computation remains local and deterministic"
- docs/ARCHITECTURE "same inputs -> byte-identical chart on CPython and Pyodide"

Both are true only if the reference instant is one of the recorded inputs.
Three properties make that so, and each fails on its own:

1. The instant is LOAD-BEARING -- two instants give two different charts. This
   is what makes (2) and (3) non-vacuous: without it, "refuses to guess" could
   be satisfied by a hardcoded constant that silently freezes every user's
   dasha.
2. The glue REFUSES a payload with no ``referenceDate`` rather than
   substituting ``now()`` -- the rule ``_almamesh_compute_predictive`` already
   enforces, now enforced on the natal path too.
3. Given the instant, the glue reads NO clock: the same payload computed thirty
   years apart on the wall clock is byte-identical.

Plus the cross-language oracle: the glue reproduces the committed CPython
golden, so "the browser path" and "the trusted backend" are the same numbers.
"""

import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

import pytest

from almamesh import calculations
from tests import test_chart_golden as golden

_WORKER_TS: Final[Path] = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "packages"
    / "browser"
    / "src"
    / "pyodide"
    / "chartWorker.ts"
)
_BOOTSTRAP_RE: Final[re.Pattern[str]] = re.compile(
    r"export const PY_BOOTSTRAP = `(.*?)`;", re.DOTALL
)

# Chennai, 1983-04-05 05:50 IST -> 00:20 UTC (the reference birth used across
# the dasha suite, so a divergence here is comparable with those tests).
_BIRTH: Final[dict[str, float | str]] = {
    "datetimeUtc": "1983-04-05T00:20:00+00:00",
    "latitude": 13.0827,
    "longitude": 80.2707,
}

GenerateChart = Callable[[str], str]


def _extract_bootstrap() -> str:
    """The verbatim PY_BOOTSTRAP source from the shipped worker module."""
    source = _WORKER_TS.read_text(encoding="utf-8")
    match = _BOOTSTRAP_RE.search(source)
    if match is None:
        raise AssertionError(f"PY_BOOTSTRAP template literal not found in {_WORKER_TS}")
    return match.group(1)


@pytest.fixture(scope="module")
def generate_chart() -> GenerateChart:
    """``_almamesh_generate_chart`` as the browser Worker defines it."""
    namespace: dict[str, object] = {}
    # Running the shipped glue is the entire point: a re-implementation here
    # would be a second copy, and the copy is what drifts.
    exec(compile(_extract_bootstrap(), str(_WORKER_TS), "exec"), namespace)  # noqa: S102
    fn = namespace["_almamesh_generate_chart"]
    assert callable(fn)
    return fn


def _freeze_engine_clock(monkeypatch: pytest.MonkeyPatch, instant: datetime) -> None:
    """Pin the wall clock the ENGINE reads (``calculations.datetime.now``)."""

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz: object = None) -> datetime:  # noqa: ARG003
            return instant

    monkeypatch.setattr(calculations, "datetime", _Frozen)


def _payload(**overrides: object) -> str:
    """A birth payload for the glue, with `referenceDate` supplied by default."""
    return json.dumps({**_BIRTH, "referenceDate": "2020-06-01T00:00:00+00:00", **overrides})


def _current_maha_lord(chart_json: str) -> str:
    lord = json.loads(chart_json)["dashas"]["current_maha"]["lord"]
    assert isinstance(lord, str)
    return lord


def test_reference_instant_is_load_bearing(generate_chart: GenerateChart) -> None:
    """Two instants, two charts -- so 'refuses to guess' is not a vacuous rule.

    Without this, the refusal below could be satisfied by hardcoding a constant
    instant, which would freeze every user's "current" dasha forever.
    """
    early = generate_chart(_payload(referenceDate="1990-01-01T00:00:00+00:00"))
    late = generate_chart(_payload(referenceDate="2050-01-01T00:00:00+00:00"))

    assert _current_maha_lord(early) != _current_maha_lord(late)


def test_glue_refuses_to_invent_a_reference_instant(generate_chart: GenerateChart) -> None:
    """No `referenceDate` -> refuse. Never a silent `now()`.

    Birth data ALONE does not determine a chart (see the test above), so a path
    that accepts birth data alone is guessing. `_almamesh_compute_predictive`
    has always refused; the natal path used to substitute the wall clock, which
    is what made the shipped chart differ run to run.
    """
    birth_only = json.dumps(_BIRTH)

    with pytest.raises(KeyError, match="referenceDate"):
        generate_chart(birth_only)


def test_glue_reads_no_clock_when_the_instant_is_given(
    generate_chart: GenerateChart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same payload, wall clock thirty years apart -> byte-identical chart."""
    payload = _payload()

    _freeze_engine_clock(monkeypatch, datetime(2000, 1, 1, tzinfo=UTC))
    first = generate_chart(payload)
    _freeze_engine_clock(monkeypatch, datetime(2030, 1, 1, tzinfo=UTC))
    second = generate_chart(payload)

    assert first == second


def test_glue_reproduces_the_cpython_golden(generate_chart: GenerateChart) -> None:
    """The browser glue and the trusted CPython oracle are the same numbers.

    This is the cross-language claim in docs/ARCHITECTURE, checked against the
    committed golden rather than against a second computation of the same code.
    """
    committed = golden._load_golden()
    reference = golden.FIXED_REFERENCE_DATE.isoformat()

    for iso_dt, lat, lon in golden.FIXTURES:
        chart = generate_chart(
            json.dumps(
                {
                    "datetimeUtc": iso_dt,
                    "latitude": lat,
                    "longitude": lon,
                    "referenceDate": reference,
                }
            )
        )
        assert golden._canonicalize(json.loads(chart)) == committed[iso_dt]


def test_glue_rejects_out_of_range_latitude(generate_chart: GenerateChart) -> None:
    """The Pyodide Worker calls the engine directly (no ChartRuntime), so the
    ENGINE is where the coordinate guard must live. lat=200 used to alias to the
    lat=20 chart through tan()'s 180-deg period; now the shipped glue refuses it
    with the same stable message on CPython and (same wheel) Pyodide.
    """
    from almamesh.calculations import InvalidBirthInputError

    with pytest.raises(
        InvalidBirthInputError, match=r"^invalid coordinate: latitude out of range \(-90, 90\)$"
    ):
        generate_chart(_payload(latitude=200.0))


def test_glue_stamps_the_chart_with_its_snapshot(generate_chart: GenerateChart) -> None:
    """The browser path hands out the same snapshot block CPython stamps, naming
    the exact birth and analysis instants it was asked for."""
    chart = json.loads(generate_chart(_payload()))

    stamp = chart["snapshot"]
    assert stamp["birth_utc"] == "1983-04-05T00:20:00+00:00"
    assert stamp["reference_date"] == "2020-06-01T00:00:00+00:00"
    assert len(stamp["snapshot_id"]) == 64


def _predictive_glue() -> Callable[[str], str]:
    namespace: dict[str, object] = {}
    exec(compile(_extract_bootstrap(), str(_WORKER_TS), "exec"), namespace)  # noqa: S102
    fn = namespace["_almamesh_compute_predictive"]
    assert callable(fn)
    return fn


def _predictive_input(**extra: object) -> str:
    return json.dumps(
        {
            "datetimeUtc": "1990-01-15T12:00:00+00:00",
            "latitude": 28.6139,
            "longitude": 77.209,
            "referenceInstant": "2026-06-09T12:00:00+00:00",
            "utcOffsetMinutes": 330,
            **extra,
        }
    )


def _window_end(raw: str) -> str:
    return str(json.loads(raw)["transit_context"]["timeline"]["window_end"])


def test_glue_passes_window_months_to_the_engine() -> None:
    glue = _predictive_glue()
    assert _window_end(glue(_predictive_input())).startswith("2027-06-09T18:00:00")
    assert _window_end(glue(_predictive_input(windowMonths=24))).startswith("2028-06-09T00:00:00")


def test_glue_refuses_a_window_past_two_years() -> None:
    with pytest.raises(ValueError, match="window_months"):
        _predictive_glue()(_predictive_input(windowMonths=25))
