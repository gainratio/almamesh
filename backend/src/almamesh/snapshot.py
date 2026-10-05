"""One snapshot identity per computed chart.

A chart is fully determined by: the engine that computed it, the data it read
(DE421 ephemeris + Lahiri table), the calculation conventions, the birth
instant, and the analysis instant (``reference_date``, which picks the
"current" dasha). ``ChartSnapshot`` records all of them as plain strings, and
``snapshot_id`` is the SHA-256 of their canonical JSON form:

    json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

Every field is an ASCII string, so the browser can recompute the same id with
``JSON.stringify`` over sorted keys and WebCrypto, and reject a chart whose
stamp does not hash to its id.
"""

from __future__ import annotations

import functools
import hashlib
import importlib.metadata
import importlib.resources
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

from almamesh.calculations import (
    DEFAULT_EPHEMERIS_FILE,
    HOUSE_SYSTEM,
    AyanamsaType,
    NodeType,
    calculate_sidereal_context,
    resolve_ephemeris_path,
)
from almamesh.dasha.convention import DEFAULT_DASHA_YEAR_CONVENTION, DashaYearConvention
from almamesh.schemas.astrology import SiderealContext

SNAPSHOT_SCHEMA: Final = "1"
_AYANAMSA_TABLE: Final = "lahiri_ayanamsa.txt"
_CHUNK_BYTES: Final = 1 << 20


class ChartSnapshot(BaseModel):
    """The identity of one computed chart. Immutable; every field a string."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    snapshot_schema: str
    engine_version: str
    ephemeris_file: str
    data_hash: str
    ayanamsa: str
    node_type: str
    house_system: str
    dasha_year_convention: str
    birth_utc: str
    reference_date: str
    snapshot_id: str


class StampedChart(SiderealContext):
    """The engine's chart plus the snapshot that identifies it."""

    snapshot: ChartSnapshot


def engine_version() -> str:
    """The installed ``almamesh`` wheel version (same wheel on CPython and Pyodide)."""
    return importlib.metadata.version("almamesh")


@functools.cache
def _file_sha256(path: Path) -> str:
    """SHA-256 of a file, streamed so the 16 MB ephemeris never sits in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(_CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def _table_sha256() -> str:
    resource = importlib.resources.files("almamesh.resources").joinpath(_AYANAMSA_TABLE)
    return hashlib.sha256(resource.read_bytes()).hexdigest()


def data_hash(ephemeris_file: str = DEFAULT_EPHEMERIS_FILE) -> str:
    """One hash over every data file the numbers depend on."""
    ephemeris = _file_sha256(resolve_ephemeris_path(ephemeris_file))
    manifest = f"{ephemeris_file}:{ephemeris}\n{_AYANAMSA_TABLE}:{_table_sha256()}\n"
    return hashlib.sha256(manifest.encode("ascii")).hexdigest()


def _utc_iso(instant: datetime) -> str:
    """Naive means UTC (the engine's rule); aware is converted, never relabelled."""
    aware = instant.replace(tzinfo=UTC) if instant.tzinfo is None else instant
    return aware.astimezone(UTC).isoformat()


def snapshot_id_for(fields: dict[str, str]) -> str:
    """SHA-256 of the canonical JSON of the snapshot fields (id excluded)."""
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_snapshot(
    *,
    birth_utc: datetime,
    reference_date: datetime,
    ayanamsa_type: AyanamsaType = AyanamsaType.LAHIRI,
    node_type: NodeType = NodeType.MEAN,
    dasha_year_convention: DashaYearConvention = DEFAULT_DASHA_YEAR_CONVENTION,
) -> ChartSnapshot:
    """Stamp one chart's identity from its inputs, versions and data."""
    fields = {
        "snapshot_schema": SNAPSHOT_SCHEMA,
        "engine_version": engine_version(),
        "ephemeris_file": DEFAULT_EPHEMERIS_FILE,
        "data_hash": data_hash(),
        "ayanamsa": ayanamsa_type.value,
        "node_type": node_type.value,
        "house_system": HOUSE_SYSTEM.value,
        "dasha_year_convention": dasha_year_convention.value,
        "birth_utc": _utc_iso(birth_utc),
        "reference_date": _utc_iso(reference_date),
    }
    return ChartSnapshot(**fields, snapshot_id=snapshot_id_for(fields))


def compute_stamped_chart(
    dt_utc: datetime, latitude: float, longitude: float, *, reference_date: datetime
) -> StampedChart:
    """The natal chart every entry point hands out: engine output + its snapshot."""
    context = calculate_sidereal_context(dt_utc, latitude, longitude, reference_date=reference_date)
    stamp = build_snapshot(
        birth_utc=dt_utc,
        reference_date=reference_date,
        dasha_year_convention=context.dashas.convention,
    )
    return StampedChart.model_construct(**dict(context), snapshot=stamp)
