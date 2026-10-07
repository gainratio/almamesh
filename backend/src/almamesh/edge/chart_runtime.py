"""The deterministic chart core wrapped as an edge-proc Runtime.

A LOCAL_ONLY, DETERMINISTIC task carries birth data; ``execute`` runs the pure
``calculate_sidereal_context`` on-device and returns the full sidereal chart.
Per the Runtime contract, failures are encoded in the ResultEnvelope, never
raised — so the router always gets a clean verdict.
"""

from __future__ import annotations

import math
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime

from edgeproc import (
    CapabilityVerdict,
    PrivacyMode,
    Provenance,
    ResultEnvelope,
    Task,
    TaskKind,
)
from edgeproc.core.models import JsonValue

from almamesh.calculations import calculate_sidereal_context
from almamesh.constants.astrology import EventType
from almamesh.mesh import compute_mesh_edge
from almamesh.predictive import compute_predictive_contexts
from almamesh.rectification import compute_rectification_result
from almamesh.rectification.models import (
    AnchorConfidence,
    EventDatePrecision,
    RectificationEventInput,
    RectificationMode,
)
from almamesh.schemas.astrology import SiderealContext
from almamesh.schemas.mesh import MatchRole, Relationship
from almamesh.snapshot import compute_stamped_chart

_RUNTIME_VERSION = "almamesh-chart/0.1.0"


def _parse_payload_number(value: object, *, field: str) -> float:
    """Parse one supported wire number without accepting booleans or nulls."""
    if isinstance(value, bool) or not isinstance(value, str | int | float):
        raise ValueError(f"invalid numeric field: {field}")
    try:
        number = float(value)
    except ValueError as error:
        raise ValueError(f"invalid numeric field: {field}") from error
    if not math.isfinite(number):
        raise ValueError(f"invalid numeric field: {field}")
    return number


def _compute_chart(payload: Mapping[str, object]) -> dict[str, JsonValue]:
    """Run the deterministic calc core over birth data from a task payload.

    Returns the stamped chart (engine output + ``snapshot``). An optional
    ``reference_date`` (ISO 8601) pins the "current" Vimshottari maha dasha;
    omit it to use the wall clock, which the snapshot then records. Passing it makes the chart fully
    reproducible (required for byte-parity and content-addressed bundles).
    """
    dt = datetime.fromisoformat(str(payload["datetime_utc"]))
    latitude = _parse_payload_number(payload["latitude"], field="latitude")
    longitude = _parse_payload_number(payload["longitude"], field="longitude")
    raw_reference = payload.get("reference_date")
    # The CLI may omit the instant; read the clock ONCE so the snapshot records
    # exactly the instant the "current" dasha was computed for.
    reference_date = (
        datetime.fromisoformat(str(raw_reference)) if raw_reference else datetime.now(UTC)
    )
    return compute_stamped_chart(dt, latitude, longitude, reference_date=reference_date).model_dump(
        mode="json"
    )


def compute_predictive(payload: Mapping[str, object]) -> dict[str, JsonValue]:
    """The LAZY predictive payload (transits + vargas + strength + domains).

    Unlike the natal chart, ``reference_instant`` (ISO 8601) is REQUIRED — there
    is no silent wall-clock fallback. The caller pins the instant, which pins
    both the "current" dasha and the transit "now", so the payload is
    reproducible (and byte-parity-testable) by construction.

    No signing happens here. The four contexts ARE the engine's output; the
    browser Worker seals each domain's strength summary into a receipt in
    TypeScript, so this CPython path and the Pyodide path emit identical bytes.
    """
    contexts = compute_predictive_contexts(
        datetime.fromisoformat(str(payload["datetime_utc"])),
        _parse_payload_number(payload["latitude"], field="latitude"),
        _parse_payload_number(payload["longitude"], field="longitude"),
        datetime.fromisoformat(str(payload["reference_instant"])),
    )
    return contexts.model_dump(mode="json")


def _birth_input(value: object) -> Mapping[str, object]:
    """Narrow a mesh birth input to a mapping — fail loud on anything else."""
    if not isinstance(value, Mapping):
        raise TypeError("birth input must be a mapping with datetime_utc/latitude/longitude")
    return value


def _natal_for_mesh(birth: Mapping[str, object], reference_instant: datetime) -> SiderealContext:
    """One read-only natal context for the mesh, with its dasha clock pinned."""
    return calculate_sidereal_context(
        datetime.fromisoformat(str(birth["datetime_utc"])),
        _parse_payload_number(birth["latitude"], field="latitude"),
        _parse_payload_number(birth["longitude"], field="longitude"),
        reference_date=reference_instant,
    )


def compute_mesh(payload: Mapping[str, object]) -> dict[str, JsonValue]:
    """The relational mesh edge between TWO bare birth inputs (``a`` and ``b``).

    Both natal contexts are recomputed on device from the birth inputs — no
    chart crosses the worker boundary. Like ``compute_predictive``, every
    instant is REQUIRED and explicit: ``reference_instant`` pins both charts'
    "current" dasha and ``window_start``/``window_end`` bound the dasha
    synchrony — never a silent wall clock, so the payload is reproducible
    (and byte-parity-testable) by construction.
    """
    reference_instant = datetime.fromisoformat(str(payload["reference_instant"]))
    edge = compute_mesh_edge(
        _natal_for_mesh(_birth_input(payload["a"]), reference_instant),
        _natal_for_mesh(_birth_input(payload["b"]), reference_instant),
        relationship=Relationship(str(payload["relationship"])),
        role_a=MatchRole(str(payload["role_a"])),
        role_b=MatchRole(str(payload["role_b"])),
        window_start=datetime.fromisoformat(str(payload["window_start"])),
        window_end=datetime.fromisoformat(str(payload["window_end"])),
    )
    return edge.model_dump(mode="json")


def _parse_rect_event(raw: object) -> RectificationEventInput:
    """Parse one raw event mapping into a typed RectificationEventInput."""
    if not isinstance(raw, Mapping):
        raise TypeError(f"event must be a mapping; got {type(raw).__name__}")
    return RectificationEventInput(
        date=date.fromisoformat(str(raw["date"])),
        category=EventType(str(raw["category"])),
        precision=EventDatePrecision(str(raw.get("precision", "exact"))),
    )


def _parse_rect_events(raw: object) -> list[RectificationEventInput]:
    """Narrow the raw events value to a typed list — fail loud on wrong shape."""
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise TypeError(f"events must be a sequence; got {type(raw).__name__}")
    return [_parse_rect_event(e) for e in raw]


def compute_rectification(payload: Mapping[str, object]) -> dict[str, JsonValue]:
    """Rectification scored against user-supplied life events (cusp or window mode).

    ``reference_date`` (ISO 8601) pins the "current" Vimshottari maha dasha for
    all candidate scoring — pass it for determinism (required in parity tests).
    When absent, wall-clock time is used (non-deterministic, fine for live use).
    ``span_minutes`` (int, optional) bounds the window search in WINDOW mode;
    absent or null means the full birth day is scanned.
    ``anchor_confidence`` ("about" | "unknown", optional) sets the E5 anchor
    prior; absent or null defaults per mode (cusp → "about", window → "unknown").
    """
    dt_utc = datetime.fromisoformat(str(payload["datetime_utc"]))
    raw_ref = payload.get("reference_date")
    reference_date = datetime.fromisoformat(str(raw_ref)) if raw_ref else datetime.now(UTC)
    raw_span = payload.get("span_minutes")
    span_minutes = int(str(raw_span)) if raw_span is not None else None
    raw_anchor = payload.get("anchor_confidence")
    anchor_confidence = AnchorConfidence(str(raw_anchor)) if raw_anchor is not None else None
    result = compute_rectification_result(
        dt_utc=dt_utc,
        latitude=_parse_payload_number(payload["latitude"], field="latitude"),
        longitude=_parse_payload_number(payload["longitude"], field="longitude"),
        utc_offset_minutes=int(str(payload["utc_offset_minutes"])),
        events=_parse_rect_events(payload["events"]),
        mode=RectificationMode(str(payload["mode"])),
        reference_date=reference_date,
        span_minutes=span_minutes,
        anchor_confidence=anchor_confidence,
    )
    return result.model_dump(mode="json")


class ChartRuntime:
    """edge-proc Runtime for the deterministic Vedic chart computation."""

    name = "chart"

    def can_handle(self, task: Task) -> CapabilityVerdict:
        if task.privacy_mode != PrivacyMode.LOCAL_ONLY:
            return CapabilityVerdict.REJECT_CAPABILITY
        if task.kind == TaskKind.DETERMINISTIC:
            return CapabilityVerdict.ACCEPT
        return CapabilityVerdict.REJECT_KIND

    async def execute(self, task: Task) -> ResultEnvelope:
        start = time.perf_counter()
        try:
            chart = _compute_chart(task.payload)
        except (KeyError, TypeError, ValueError) as exc:
            return self._envelope(task, start, success=False, payload={}, error=str(exc))
        return self._envelope(task, start, success=True, payload={"chart": chart})

    def _envelope(
        self,
        task: Task,
        start: float,
        *,
        success: bool,
        payload: dict[str, JsonValue],
        error: str | None = None,
    ) -> ResultEnvelope:
        return ResultEnvelope(
            request_id=task.request_id,
            task_kind=task.kind,
            success=success,
            payload=payload,
            runtime_used=self.name,
            privacy_mode=task.privacy_mode,
            confidence=1.0 if success else 0.0,
            latency_ms=(time.perf_counter() - start) * 1000,
            provenance=Provenance(signature_status="unsigned", runtime_version=_RUNTIME_VERSION),
            error=error,
        )
