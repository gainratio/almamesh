"""Astro-Databank export -> retrodiction events: filters, precision, code mapping, counts.

Every fixture is a hand-written FAKE native (ids 9000xx); no ADB record is in this repo.
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from almamesh.retrodiction.adb import AdbImport, coordinate, import_adb, stmerid_offset
from almamesh.retrodiction.events import EventCategory, RetrodictionInputError
from tests.adb_xml import FakeEntry, FakeEvent, export_xml, plain_zip


def _no_password() -> bytes:
    raise AssertionError("an unencrypted export must never ask the Keychain")


def _import(tmp_path: Path, *entries: FakeEntry, deleted: str = "") -> AdbImport:
    path = plain_zip(tmp_path / "export.zip", {"x.xml": export_xml(entries, deleted=deleted)})
    return import_adb(path, password=_no_password)


def test_should_convert_an_aa_entry_into_a_public_subject(tmp_path: Path) -> None:
    # Given one AA native born 14:30 at UTC+1 with a dated new job
    # When imported
    result = _import(tmp_path, FakeEntry())
    # Then the subject keeps its ADB id, birth instant, coordinates and event
    subject = result.events.subjects[0]
    assert result.events.kind == "public"
    assert result.events.source is not None and "Astro-Databank" in result.events.source
    assert subject.id == "adb-900001"
    assert subject.birth.datetime.isoformat() == "1950-06-15T14:30:00+01:00"
    assert subject.birth.latitude == pytest.approx(48 + 52 / 60)
    assert subject.birth.longitude == pytest.approx(2 + 20 / 60 + 15 / 3600)
    event = subject.events[0]
    assert (event.category, event.date, event.precision) == (
        EventCategory.JOB_START,
        "1990-05-12",
        "day",
    )
    assert event.place is None


def test_should_keep_a_ratings_and_drop_b_ratings(tmp_path: Path) -> None:
    # Given an A native and a B native (Rodden B is a biography source, not a record)
    a_rated = FakeEntry(adb_id=900002, rrc="2", rating="A")
    b_rated = FakeEntry(adb_id=900003, rrc="3", rating="B")
    # When imported
    result = _import(tmp_path, a_rated, b_rated)
    # Then only the A native survives, and the B is counted, not silently lost
    assert [s.id for s in result.events.subjects] == ["adb-900002"]
    assert result.summary.ratings == {"A": 1, "B": 1}
    assert result.summary.entries_dropped == {"rodden_rating": 1}
    assert result.summary.subjects_kept == 1


@pytest.mark.parametrize(
    ("ymd", "date", "precision"),
    [((1990, 5, 0), "1990-05", "month"), ((1990, 0, 0), "1990", "year")],
)
def test_should_set_precision_from_a_partial_date(
    tmp_path: Path, ymd: tuple[int, int, int], date: str, precision: str
) -> None:
    # Given an event whose unknown day (and month) is written as "00"
    entry = FakeEntry(events=(FakeEvent(ymd=ymd),))
    # When imported
    result = _import(tmp_path, entry)
    # Then the event carries the coarser precision instead of a made-up day
    event = result.events.subjects[0].events[0]
    assert (event.date, event.precision) == (date, precision)
    assert result.summary.events_by_precision == {precision: 1}


def test_should_count_unmapped_codes_and_drop_natives_left_without_events(
    tmp_path: Path,
) -> None:
    # Given a native whose only event is their own death (deliberately unmapped)
    own_death = FakeEvent(evn_id=771, sevcode="Death, Cause unspecified")
    kept = FakeEntry(adb_id=900004, events=(FakeEvent(), own_death))
    lost = FakeEntry(adb_id=900005, events=(own_death,))
    # When imported
    result = _import(tmp_path, kept, lost)
    # Then the code is reported by id and label, and the eventless native is dropped
    assert result.summary.unmapped_codes == {"771 Death, Cause unspecified": 2}
    assert result.summary.entries_dropped == {"no_mapped_events": 1}
    assert result.summary.events_mapped == {"job_start": 1}
    assert result.summary.events_seen == 3


def test_should_not_map_a_known_id_whose_label_drifted(tmp_path: Path) -> None:
    # Given evn_id 822 (New Job in the frozen table) under a different label
    drifted = FakeEvent(evn_id=822, sevcode="Work : Something Else")
    # When imported next to a valid event
    result = _import(tmp_path, FakeEntry(events=(FakeEvent(), drifted)))
    # Then the drifted pair is unmapped, never guessed
    assert result.summary.unmapped_codes == {"822 Work : Something Else": 1}
    assert len(result.events.subjects[0].events) == 1


@pytest.mark.parametrize(
    ("event", "reason"),
    [
        (FakeEvent(calendar="j"), "julian_date"),
        (FakeEvent(ymd=(1990, 2, 30)), "invalid_date"),
        (FakeEvent(ymd=(1990, 0, 5)), "invalid_date"),
        (FakeEvent(ymd=(0, 0, 0)), "invalid_date"),
    ],
)
def test_should_drop_and_count_an_unusable_event_date(
    tmp_path: Path, event: FakeEvent, reason: str
) -> None:
    # Given a native with one good event and one unusable one
    entry = FakeEntry(events=(FakeEvent(), event))
    # When imported
    result = _import(tmp_path, entry)
    # Then the bad event is counted by reason and the good one survives
    assert result.summary.events_dropped == {reason: 1}
    assert len(result.events.subjects[0].events) == 1


@pytest.mark.parametrize(
    ("entry", "reason"),
    [
        (FakeEntry(dtc="4"), "datatype"),
        (FakeEntry(csex="e"), "event_chart"),
        (FakeEntry(time_unknown="yes"), "time_unknown"),
        (FakeEntry(calendar="j"), "julian_birth"),
        (FakeEntry(jd_shift_minutes=5), "birth_time_mismatch"),
        (FakeEntry(stmerid="x1e"), "birth_unparseable"),
        (FakeEntry(lat="48q52"), "birth_unparseable"),
        (FakeEntry(lat="98n00"), "birth_unparseable"),
        (FakeEntry(clock="noon"), "birth_unparseable"),
        (FakeEntry(with_place=False), "birth_unparseable"),
    ],
)
def test_should_drop_and_count_an_unusable_entry(
    tmp_path: Path, entry: FakeEntry, reason: str
) -> None:
    # Given one usable native and one unusable one
    # When imported
    result = _import(tmp_path, FakeEntry(adb_id=900010), entry)
    # Then the unusable entry is counted by its reason
    assert result.summary.entries_dropped == {reason: 1}
    assert [s.id for s in result.events.subjects] == ["adb-900010"]


def test_should_drop_records_listed_as_deleted(tmp_path: Path) -> None:
    # Given an export whose deleted_records lists one of its natives
    first, second = FakeEntry(adb_id=900011), FakeEntry(adb_id=900012)
    # When imported
    result = _import(tmp_path, first, second, deleted="900012, 77")
    # Then that native is removed (licence section 7) and counted
    assert [s.id for s in result.events.subjects] == ["adb-900011"]
    assert result.summary.entries_dropped == {"deleted_record": 1}
    assert result.summary.deleted_records == 2


def test_should_refuse_an_export_with_no_usable_native(tmp_path: Path) -> None:
    # Given an export holding only a C-rated native
    # When imported / Then refused rather than scoring an empty set
    with pytest.raises(RetrodictionInputError, match="no AA/A native"):
        _import(tmp_path, FakeEntry(rrc="4", rating="C"))


def test_should_report_licence_and_format_without_personal_fields(tmp_path: Path) -> None:
    # Given a licensed export
    result = _import(tmp_path, FakeEntry())
    # Then the summary names the file and format; the licensee e-mail never appears
    summary = result.summary
    assert (summary.export_file, summary.export_format, summary.licensed) == (
        "fake_export.xml",
        "260911",
        True,
    )
    assert "x@y.z" not in summary.model_dump_json()
    assert summary.entries == 1


def test_should_note_a_missing_licence_element(tmp_path: Path) -> None:
    # Given the free sample format, which has no license_data
    xml = export_xml((FakeEntry(),), licensed=False)
    path = plain_zip(tmp_path / "sample.zip", {"s.xml": xml})
    # When imported / Then the summary says so
    assert import_adb(path, password=_no_password).summary.licensed is False


@pytest.mark.parametrize(
    ("text", "hours"),
    [
        ("h1e", 1.0),
        ("h5w", -5.0),
        ("h5w30", -5.5),
        ("h5e3045", 5 + 30 / 60 + 45 / 3600),
        ("m72e30", 72.5 / 15),
        ("m9e", 9 / 15),
        ("m2e2015", (2 + 20 / 60 + 15 / 3600) / 15),
        ("m84w0315", -(84 + 3 / 60 + 15 / 3600) / 15),
        ("m9e5", (9 + 5 / 60) / 15),
    ],
)
def test_should_read_stmerid_as_a_utc_offset(text: str, hours: float) -> None:
    # Given an ADB time-zone code (h = zone hours, m = local-mean-time meridian degrees)
    # When parsed / Then it is the civil offset east of UTC, to the second
    assert stmerid_offset(text) == timedelta(seconds=round(hours * 3600))


@pytest.mark.parametrize("text", ["", "h", "h5", "x5e", "h5n", "h25e", "m181e", "h5w75", "m9e045"])
def test_should_refuse_an_unreadable_stmerid(text: str) -> None:
    with pytest.raises(ValueError, match="stmerid"):
        stmerid_offset(text)


@pytest.mark.parametrize(
    ("text", "axis", "value"),
    [
        ("52n0445", "ns", 52 + 4 / 60 + 45 / 3600),
        ("33s52", "ns", -(33 + 52 / 60)),
        ("118w15", "ew", -118.25),
        ("2e20", "ew", 2 + 20 / 60),
        ("52n4", "ns", 52 + 4 / 60),
    ],
)
def test_should_read_adb_coordinates(text: str, axis: str, value: float) -> None:
    assert coordinate(text, axis) == pytest.approx(value)


@pytest.mark.parametrize(
    ("text", "axis"),
    [("52e04", "ns"), ("52n", "ns"), ("200e00", "ew"), ("52n0475", "ns"), ("52n045", "ns")],
)
def test_should_refuse_an_unreadable_coordinate(text: str, axis: str) -> None:
    with pytest.raises(ValueError, match="coordinate"):
        coordinate(text, axis)
