"""Scoring a whole file: natives outside the engine's range, and parallel scoring."""

from __future__ import annotations

from datetime import datetime

from almamesh.retrodiction.events import Birth, EventCategory, EventsFile, LifeEvent, Subject
from almamesh.retrodiction.harness import EventScores
from almamesh.retrodiction.report import sample_subjects, score_file


def _subject(sid: str, born: str, *dates: str) -> Subject:
    events = [LifeEvent(category=EventCategory.LEGAL, date=d, precision="month") for d in dates]
    birth = Birth(datetime=datetime.fromisoformat(born), latitude=13.08, longitude=80.27)
    return Subject(id=sid, birth=birth, events=events)


def _file(*subjects: Subject) -> EventsFile:
    return EventsFile(kind="synthetic", label="report test", subjects=list(subjects))


def test_a_native_born_before_1900_is_excluded_not_fatal() -> None:
    early = _subject("early", "1899-06-01T12:00:00+05:30", "1935-04", "1950-02")
    scored, excluded = score_file(
        _file(early, _subject("late", "1980-03-04T05:06:00+05:30", "2019-05")), 36
    )
    assert [e.subject for e in scored] == ["late"]
    assert [(x.subject, x.date) for x in excluded] == [("early", "1935-04"), ("early", "1950-02")]
    assert all("1900" in x.reason for x in excluded)


def test_parallel_scoring_matches_serial() -> None:
    natives = [
        _subject("a", "1980-03-04T05:06:00+05:30", "2019-05", "2012-11"),
        _subject("b", "1975-07-21T23:40:00-04:00", "2001-09"),
        _subject("c", "1899-06-01T12:00:00+05:30", "1935-04"),
        _subject("d", "1990-01-15T08:00:00+01:00", "2020-02", "1990-03"),
    ]
    serial = score_file(_file(*natives), 36)
    parallel = score_file(_file(*natives), 36, workers=2)
    assert parallel == serial
    assert all(isinstance(e, EventScores) for e in parallel[0])


def test_a_native_sample_is_seeded_and_keeps_file_order() -> None:
    natives = [_subject(str(i), "1980-03-04T05:06:00+05:30", "2019-05") for i in range(20)]
    first = sample_subjects(_file(*natives), 5, seed=20261014)
    again = sample_subjects(_file(*natives), 5, seed=20261014)
    ids = [s.id for s in first.subjects]
    assert ids == [s.id for s in again.subjects]
    assert ids == sorted(ids, key=int)
    assert len(set(ids)) == 5
    assert [s.id for s in sample_subjects(_file(*natives), 5, seed=1).subjects] != ids


def test_a_sample_as_large_as_the_file_is_the_whole_file() -> None:
    whole = _file(*[_subject(str(i), "1980-03-04T05:06:00+05:30", "2019-05") for i in range(3)])
    assert sample_subjects(whole, 10, seed=1) == whole
