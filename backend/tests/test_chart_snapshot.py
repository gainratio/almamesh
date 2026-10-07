"""One snapshot identity per computed chart.

Every chart the engine hands out carries a ``snapshot`` block: which engine and
which data built it, under which conventions, for which birth instant, as of
which analysis instant -- and a ``snapshot_id`` that is the SHA-256 of a
canonical serialization of exactly those fields.

The claim: two charts share a ``snapshot_id`` only when every input that can
change the numbers is the same. Each test below breaks one input and watches
the id move; the canonical-form test pins the hashing rule the browser
re-checks at the worker boundary.
"""

import hashlib
import json
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest

from almamesh import snapshot
from almamesh.calculations import AyanamsaType, NodeType
from almamesh.snapshot import ChartSnapshot, build_snapshot, compute_stamped_chart

_BIRTH = datetime(1990, 1, 15, 12, 0, tzinfo=UTC)
_REFERENCE = datetime(2025, 1, 1, tzinfo=UTC)
_DELHI = (28.6139, 77.2090)


def _stamp(**overrides: object) -> ChartSnapshot:
    kwargs: dict[str, object] = {"birth_utc": _BIRTH, "reference_date": _REFERENCE}
    kwargs.update(overrides)
    return build_snapshot(**kwargs)  # type: ignore[arg-type]


def test_stamped_chart_carries_the_snapshot_block() -> None:
    chart = compute_stamped_chart(_BIRTH, *_DELHI, reference_date=_REFERENCE).model_dump(
        mode="json"
    )

    block = chart["snapshot"]
    assert isinstance(block, dict)
    assert block["birth_utc"] == "1990-01-15T12:00:00+00:00"
    assert block["reference_date"] == "2025-01-01T00:00:00+00:00"
    assert block["engine_version"] == "0.1.0"
    assert block["ephemeris_file"] == "de421.bsp"
    assert block["ayanamsa"] == "LAHIRI"
    assert block["node_type"] == "mean"
    assert block["house_system"] == "whole_sign"
    assert block["dasha_year_convention"] == "julian_365_25"
    assert block["snapshot_schema"] == "1"


def test_stamped_chart_keeps_every_engine_field() -> None:
    chart = compute_stamped_chart(_BIRTH, *_DELHI, reference_date=_REFERENCE).model_dump(
        mode="json"
    )

    assert {"lagna", "planets", "houses", "dashas", "yogas", "navamsa"} <= chart.keys()


def test_snapshot_id_is_sha256_of_the_canonical_fields() -> None:
    stamp = _stamp()
    fields = stamp.model_dump(exclude={"snapshot_id"})
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    assert stamp.snapshot_id == hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    assert len(stamp.snapshot_id) == 64


def test_instants_are_normalized_to_utc() -> None:
    ist = timezone(timedelta(hours=5, minutes=30))
    shifted = _stamp(birth_utc=_BIRTH.astimezone(ist), reference_date=_REFERENCE.astimezone(ist))

    assert shifted == _stamp()


@pytest.mark.parametrize(
    "overrides",
    [
        {"birth_utc": _BIRTH + timedelta(minutes=1)},
        {"reference_date": _REFERENCE + timedelta(days=1)},
        {"ayanamsa_type": AyanamsaType.TRUE_CHITRA},
        {"node_type": NodeType.TRUE},
    ],
)
def test_every_input_moves_the_snapshot_id(overrides: dict[str, object]) -> None:
    assert _stamp(**overrides).snapshot_id != _stamp().snapshot_id


def test_engine_version_moves_the_snapshot_id(monkeypatch: pytest.MonkeyPatch) -> None:
    before = _stamp().snapshot_id
    monkeypatch.setattr(snapshot, "engine_version", lambda: "9.9.9")

    after = _stamp()

    assert after.engine_version == "9.9.9"
    assert after.snapshot_id != before


def test_data_hash_reads_the_ephemeris_bytes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    before = _stamp()
    fake = tmp_path / "de421.bsp"
    fake.write_bytes(b"not the real ephemeris")
    monkeypatch.setattr(snapshot, "resolve_ephemeris_path", lambda _name: fake)

    after = _stamp()

    assert after.data_hash != before.data_hash
    assert after.snapshot_id != before.snapshot_id


def test_data_hash_pins_the_shipped_data() -> None:
    """The literal is the hash of the vendored DE421 + Lahiri table. If it moves,
    the shipped data moved: regenerate the chart golden on purpose."""
    assert _stamp().data_hash == _EXPECTED_DATA_HASH


def test_snapshot_is_immutable() -> None:
    stamp = _stamp()

    with pytest.raises(ValueError, match="frozen"):
        stamp.reference_date = "2030-01-01T00:00:00+00:00"  # type: ignore[misc]


_EXPECTED_DATA_HASH = "81de915e5e0168224c93fd2e54d8ac254748d0db090fcb09c5c14c9f70193cba"
