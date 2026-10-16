"""The scorecard's controls: chart swap, shifted months and the planted family."""

from __future__ import annotations

import pytest

from almamesh.retrodiction.controls import chart_swap, planted, shift_months
from almamesh.retrodiction.events import Birth, EventCategory, EventsFile, LifeEvent, Subject
from almamesh.retrodiction.harness import EventScores, summarize


def _subject(name: str, year: int, *dates: str) -> Subject:
    birth = Birth(datetime=f"{year}-05-06T07:08:00+00:00", latitude=1.0, longitude=2.0)
    events = [
        LifeEvent(category="marriage", date=d, precision="month" if len(d) == 7 else "year")
        for d in dates
    ]
    return Subject(id=name, birth=birth, events=events)


def _file(*subjects: Subject) -> EventsFile:
    return EventsFile(kind="public", label="controls", source="unit test", subjects=list(subjects))


def test_should_give_each_native_the_next_same_year_chart_when_swapped() -> None:
    # Given three natives born in 1950 and one alone in 1960
    a, b, c = (
        _subject("a", 1950, "1980-01"),
        _subject("b", 1950, "1981-02"),
        _subject("c", 1950, "1982-03"),
    )
    lone = _subject("lone", 1960, "1990-04")
    # When
    swapped, dropped = chart_swap(_file(a, lone, b, c))
    # Then a reads b's chart, b reads c's, c reads a's; their events are unchanged
    assert [(s.id, s.birth, s.events) for s in swapped.subjects] == [
        ("a~b", b.birth, a.events),
        ("b~c", c.birth, b.events),
        ("c~a", a.birth, c.events),
    ]
    assert dropped == 1
    assert "chart-swap" in swapped.label


def test_should_move_every_month_event_outside_its_window_when_shifted() -> None:
    # Given
    events = _file(_subject("a", 1950, "1980-01", "1990-06", "1999"))
    # When
    shifted = shift_months(events, seed=7)
    again = shift_months(events, seed=7)
    # Then each month event moved 73..146 months, deterministically; year events stay
    moved = shifted.subjects[0].events
    assert moved == again.subjects[0].events
    for before, after in zip(events.subjects[0].events[:2], moved[:2], strict=True):
        b_year, b_month = map(int, before.date.split("-"))
        a_year, a_month = map(int, after.date.split("-"))
        assert 73 <= abs((a_year * 12 + a_month) - (b_year * 12 + b_month)) <= 146
        assert after.precision == "month"
    assert moved[2] == events.subjects[0].events[2]
    assert "shifted-months" in shifted.label


def test_should_reach_the_ceiling_lift_when_the_planted_family_peeks() -> None:
    # Given real-looking windows with flat scores
    flat = {"x": tuple(0.0 for _ in range(73))}
    events = [EventScores("s", EventCategory.MARRIAGE, (2000, 1), "relationships", flat, 36)] * 30
    # When
    summary = summarize(planted(events), {"planted"}, 3)
    # Then
    assert summary.lift == pytest.approx(73 / 3)
    assert summary.p_value < 1e-20
