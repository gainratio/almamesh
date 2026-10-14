"""Astro-Databank (ADB) export -> the eval's ``EventsFile``, with every drop counted.

Rules (pre-registered in the retrodiction spec, "ADB import" amendment):
- keep only Rodden AA/A (``rrc`` 1/2), public-figure records (``dtc`` 1), people (not
  ``csex`` "e" event charts), a known birth time, and a Gregorian birth date;
- the birth instant is the civil time at the ``stmerid`` offset and must agree with ADB's
  own ``jd_ut`` to within a minute;
- an event maps only through ``adb_codes.ADB_EVENT_CODES`` (id AND label must match);
  ``imonth``/``iday`` "00" set the precision to year/month, and the harness excludes
  year-precision events from month-level scoring;
- records listed in ``<deleted_records>`` are dropped (licence section 7).

The result holds birth data for licensed natives, so it is built in memory only and the
summary carries counts, never a per-person field.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Final
from xml.etree.ElementTree import Element

from pydantic import BaseModel, ConfigDict

from almamesh.retrodiction.adb_codes import ADB_EVENT_CODES, AdbCode
from almamesh.retrodiction.adb_source import (
    ROOT_TAG,
    PasswordSource,
    iter_export,
    open_export,
    zip_password,
)
from almamesh.retrodiction.events import (
    Birth,
    EventsFile,
    LifeEvent,
    Precision,
    RetrodictionInputError,
    Subject,
)

ADB_SOURCE: Final = (
    "Astro-Databank export, (c) Astrodienst AG; licensed research use only. "
    "Publish ADB ids and aggregates only, never rows."
)
_KEPT_RODDEN: Final = frozenset({"1", "2"})
_BDATA: Final = "public_data/bdata"
_JD_TOLERANCE_MINUTES: Final = 1.0
_J2000: Final = datetime(2000, 1, 1, 12, tzinfo=UTC)
_J2000_JD: Final = 2451545.0
_MAX_DEGREES: Final = {"ns": 90, "ew": 180}
# ``h`` counts clock hours (at most 15); ``m`` counts meridian degrees, 15 degrees per hour.
_STMERID_LIMIT_SECONDS: Final = {"h": 15 * 3600, "m": 180 * 3600}
_STMERID_DIVISOR: Final = {"h": 1, "m": 15}
# The tail after the direction letter is MM, MMSS, or an unpadded single minute digit
# (``m9e5`` = 9°05'; the sample's jd_ut confirms 05, not 50).
_STMERID: Final = re.compile(r"^([hm])(\d{1,3})([ew])(\d{4}|\d{1,2})?$")
_COORD: Final = re.compile(r"^(\d{1,3})([nsew])(\d{4}|\d{1,2})$")
_CLOCK: Final = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$")
_PRECISIONS: Final[tuple[Precision, Precision, Precision]] = ("year", "month", "day")


class AdbSummary(BaseModel):
    """What the import kept and dropped, as counts only (safe to print)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    export_file: str
    export_format: str
    licensed: bool
    entries: int
    ratings: dict[str, int]
    subjects_kept: int
    entries_dropped: dict[str, int]
    events_seen: int
    events_mapped: dict[str, int]
    events_by_precision: dict[str, int]
    events_dropped: dict[str, int]
    unmapped_codes: dict[str, int]
    deleted_records: int


@dataclass(frozen=True)
class AdbImport:
    """The in-memory event file and its counts."""

    events: EventsFile
    summary: AdbSummary


class _DroppedError(Exception):
    """An entry or event the import skips, with the reason it is counted under."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class _Tally:
    """Mutable accumulator for one streaming pass."""

    export_file: str = ""
    export_format: str = ""
    licensed: bool = False
    deleted: frozenset[int] = frozenset()
    subjects: list[tuple[int, Subject]] = field(default_factory=list)
    ratings: Counter[str] = field(default_factory=Counter)
    entries_dropped: Counter[str] = field(default_factory=Counter)
    events_mapped: Counter[str] = field(default_factory=Counter)
    events_by_precision: Counter[str] = field(default_factory=Counter)
    events_dropped: Counter[str] = field(default_factory=Counter)
    unmapped_codes: Counter[str] = field(default_factory=Counter)
    events_seen: int = 0


def _minutes_seconds(tail: str | None) -> tuple[int, int]:
    """``MMSS`` -> (MM, SS); ``M`` or ``MM`` -> (M, 0); nothing -> (0, 0)."""
    digits = tail or "0"
    split = 2 if len(digits) == 4 else len(digits)
    return int(digits[:split]), int(digits[split:] or 0)


def _sexagesimal(text: str, whole: str, tail: str | None) -> int:
    """``whole`` units + the MM[SS] tail, in sixtieths-of-sixtieths (arc or clock seconds)."""
    parts = _minutes_seconds(tail)
    if max(parts) >= 60:
        raise ValueError(f"minutes/seconds out of range in {text!r}")
    return int(whole) * 3600 + parts[0] * 60 + parts[1]


def stmerid_offset(text: str) -> timedelta:
    """ADB ``stmerid`` as an offset east of UTC: ``h5w30`` zone hours, ``m2e2015`` LMT degrees."""
    match = _STMERID.match(text)
    if match is None:
        raise ValueError(f"unreadable stmerid {text!r}")
    kind, whole, side, tail = match.groups()
    total = _sexagesimal(f"stmerid {text}", whole, tail)
    limit = _STMERID_LIMIT_SECONDS[kind]
    if total > limit:
        raise ValueError(f"stmerid {text!r} is out of range")
    seconds_east = round(total / _STMERID_DIVISOR[kind])
    return timedelta(seconds=seconds_east if side == "e" else -seconds_east)


def coordinate(text: str, axis: str) -> float:
    """ADB ``slati``/``slong`` (``52n0445`` = 52°04'45" N) in signed decimal degrees."""
    match = _COORD.match(text)
    if match is None or match.group(2) not in axis:
        raise ValueError(f"unreadable coordinate {text!r} for axis {axis!r}")
    value = _sexagesimal(f"coordinate {text}", match[1], match[3]) / 3600
    if value > _MAX_DEGREES[axis]:
        raise ValueError(f"coordinate {text!r} is beyond {_MAX_DEGREES[axis]} degrees")
    return -value if match.group(2) in "sw" else value


def _attr(element: Element, path: str, name: str) -> str | None:
    found = element.find(path)
    return None if found is None else found.get(name)


def _child(element: Element, path: str) -> Element:
    found = element.find(path)
    if found is None:
        raise _DroppedError("birth_unparseable")
    return found


_ENTRY_CHECKS: Final[tuple[tuple[str, Callable[[Element], bool]], ...]] = (
    ("rodden_rating", lambda e: _attr(e, "public_data/roddenrating", "rrc") in _KEPT_RODDEN),
    ("datatype", lambda e: _attr(e, "public_data/datatype", "dtc") == "1"),
    ("event_chart", lambda e: _attr(e, "public_data/gender", "csex") != "e"),
    ("time_unknown", lambda e: not _attr(e, f"{_BDATA}/sbtime", "time_unknown")),
    ("julian_birth", lambda e: _attr(e, f"{_BDATA}/sbdate", "ccalendar") == "g"),
)


def _check_entry(entry: Element) -> None:
    for reason, passes in _ENTRY_CHECKS:
        if not passes(entry):
            raise _DroppedError(reason)


def _ymd(sbdate: Element) -> tuple[int, int, int]:
    year, month, day = (int(sbdate.get(k, "")) for k in ("iyear", "imonth", "iday"))
    return year, month, day


def _clock(sbtime: Element) -> tuple[int, int, int]:
    clock = _CLOCK.match((sbtime.text or "").strip())
    if clock is None:
        raise ValueError("unreadable birth time")
    hour, minute, second = clock.groups()
    return int(hour), int(minute), int(second or 0)


def _local_birth(bdata: Element) -> datetime:
    sbtime = _child(bdata, "sbtime")
    zone = timezone(stmerid_offset(sbtime.get("stmerid", "")))
    return datetime(*_ymd(_child(bdata, "sbdate")), *_clock(sbtime), tzinfo=zone)


def _julian_day(instant: datetime) -> float:
    return (instant.astimezone(UTC) - _J2000).total_seconds() / 86400 + _J2000_JD


def _check_jd(instant: datetime, bdata: Element) -> None:
    recorded = float(_child(bdata, "sbtime").get("jd_ut", ""))
    if abs(_julian_day(instant) - recorded) * 1440 > _JD_TOLERANCE_MINUTES:
        raise _DroppedError("birth_time_mismatch")


def _birth(entry: Element) -> Birth:
    bdata = _child(entry, _BDATA)
    try:
        instant = _local_birth(bdata)
        place = _child(bdata, "place")
        latitude = coordinate(place.get("slati", ""), "ns")
        longitude = coordinate(place.get("slong", ""), "ew")
        _check_jd(instant, bdata)
    except ValueError as exc:
        raise _DroppedError("birth_unparseable") from exc
    return Birth(datetime=instant, latitude=latitude, longitude=longitude)


def event_date(year: int, month: int, day: int) -> tuple[str, Precision]:
    """ADB's (y, m, d) with 0 for unknown -> the eval's date text and precision."""
    if year < 1 or (month == 0 and day != 0):
        raise ValueError(f"unusable event date {year}/{month}/{day}")
    known = (month > 0) + (day > 0)
    text = "-".join([f"{year:04d}", *(f"{part:02d}" for part in (month, day)[:known])])
    return text, _PRECISIONS[known]


def _code(event: Element, tally: _Tally) -> AdbCode:
    evn_id, label = event.get("evn_id", ""), event.get("sevcode", "")
    code = ADB_EVENT_CODES.get(int(evn_id)) if evn_id.isdigit() else None
    if code is None or code.label != label:
        tally.unmapped_codes[f"{evn_id} {label}"] += 1
        raise _DroppedError("unmapped")
    return code


def _gregorian_date(event: Element) -> Element:
    sbdate = event.find("event_data/sbdate")
    if sbdate is None or sbdate.get("ccalendar") != "g":
        raise _DroppedError("julian_date")
    return sbdate


def _mapped(event: Element, tally: _Tally) -> LifeEvent:
    code = _code(event, tally)
    sbdate = _gregorian_date(event)
    try:
        text, precision = event_date(*_ymd(sbdate))
        return LifeEvent(category=code.category, date=text, precision=precision)
    except ValueError as exc:
        raise _DroppedError("invalid_date") from exc


def _event(event: Element, tally: _Tally) -> LifeEvent | None:
    tally.events_seen += 1
    try:
        mapped = _mapped(event, tally)
    except _DroppedError as dropped:
        if dropped.reason != "unmapped":
            tally.events_dropped[dropped.reason] += 1
        return None
    tally.events_mapped[mapped.category.value] += 1
    tally.events_by_precision[mapped.precision] += 1
    return mapped


def _subject(entry: Element, tally: _Tally) -> Subject:
    _check_entry(entry)
    birth = _birth(entry)
    found = (_event(e, tally) for e in entry.iterfind("research_data/events/event"))
    events = [e for e in found if e is not None]
    if not events:
        raise _DroppedError("no_mapped_events")
    return Subject(id=f"adb-{entry.get('adb_id')}", birth=birth, events=events)


def _on_entry(entry: Element, tally: _Tally) -> None:
    tally.ratings[(entry.findtext("public_data/roddenrating") or "?").strip()] += 1
    try:
        tally.subjects.append((int(entry.get("adb_id", "0")), _subject(entry, tally)))
    except _DroppedError as dropped:
        tally.entries_dropped[dropped.reason] += 1


def _on_root(root: Element, tally: _Tally) -> None:
    tally.export_file = root.get("filename", "")
    tally.export_format = root.get("export_format", "")


def _on_licence(_: Element, tally: _Tally) -> None:
    tally.licensed = True


def _on_deleted(element: Element, tally: _Tally) -> None:
    tally.deleted = frozenset(int(i) for i in re.findall(r"\d+", element.text or ""))


_HANDLERS: Final[dict[str, Callable[[Element, _Tally], None]]] = {
    ROOT_TAG: _on_root,
    "license_data": _on_licence,
    "adb_entry": _on_entry,
    "deleted_records": _on_deleted,
}


def _kept_subjects(tally: _Tally) -> list[Subject]:
    kept = [s for adb_id, s in tally.subjects if adb_id not in tally.deleted]
    removed = len(tally.subjects) - len(kept)
    if removed:
        tally.entries_dropped["deleted_record"] += removed
    return kept


def _summary(tally: _Tally, kept: int) -> AdbSummary:
    def counts(counter: Counter[str]) -> dict[str, int]:
        return dict(sorted(counter.items()))

    return AdbSummary(
        export_file=tally.export_file,
        export_format=tally.export_format,
        licensed=tally.licensed,
        entries=sum(tally.ratings.values()),
        ratings=counts(tally.ratings),
        subjects_kept=kept,
        entries_dropped=counts(tally.entries_dropped),
        events_seen=tally.events_seen,
        events_mapped=counts(tally.events_mapped),
        events_by_precision=counts(tally.events_by_precision),
        events_dropped=counts(tally.events_dropped),
        unmapped_codes=counts(tally.unmapped_codes),
        deleted_records=len(tally.deleted),
    )


def import_adb(path: Path, password: PasswordSource = zip_password) -> AdbImport:
    """Stream an ADB export zip into a public ``EventsFile``; refuse rather than guess."""
    tally = _Tally()
    with open_export(path, password) as raw:
        for element in iter_export(raw):
            handler = _HANDLERS.get(element.tag)
            if handler is not None:
                handler(element, tally)
    kept = _kept_subjects(tally)
    if not kept:
        raise RetrodictionInputError(f"no AA/A native with a mapped, dated event in {path}")
    label = f"astro-databank {tally.export_file}"
    events = EventsFile(kind="public", label=label, source=ADB_SOURCE, subjects=kept)
    return AdbImport(events=events, summary=_summary(tally, len(kept)))


__all__ = ["ADB_SOURCE", "AdbImport", "AdbSummary", "coordinate", "import_adb", "stmerid_offset"]
