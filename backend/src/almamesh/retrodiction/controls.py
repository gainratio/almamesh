"""Controls the scorecard runs beside the real scoring (amendment d, learning-loop §1, §8).

- ``chart_swap``: each native's events read the chart of another native born in the same
  UTC year, so a family that only tracks the calendar scores as well as the real chart.
- ``shift_months``: each month event moves 73-146 months, outside its own window, so the
  true month cannot sit in the ranked window: lift must be chance.
- ``planted``: a family that peeks at the event month, so lift must hit its ceiling N/k.
- ``placebo_centres``: amendment (f1)'s R placebo windows per event, same native and target,
  centred 73-146 months away (sign flipped once if out of range, else dropped).
"""

from __future__ import annotations

import random
from collections import defaultdict
from datetime import UTC
from typing import TYPE_CHECKING, Final

from almamesh.retrodiction.engine import add_months
from almamesh.retrodiction.harness import EventScores
from almamesh.retrodiction.split import SPLIT_SEED

if TYPE_CHECKING:
    from collections.abc import Callable

    from almamesh.retrodiction.engine import YearMonth
    from almamesh.retrodiction.events import EventsFile, LifeEvent, Subject

PLANTED: Final[str] = "planted"
PLACEBOS: Final[int] = 4
_SHIFT_MIN, _SHIFT_MAX = 73, 146


def _by_birth_year(subjects: list[Subject]) -> dict[int, list[Subject]]:
    groups: dict[int, list[Subject]] = defaultdict(list)
    for subject in subjects:
        groups[subject.birth.datetime.astimezone(UTC).year].append(subject)
    return groups


def _rotated(group: list[Subject]) -> dict[str, Subject]:
    """Native i reads native i+1's chart (the last reads the first's), keyed by native."""
    partners = group[1:] + group[:1]
    return {
        s.id: s.model_copy(update={"id": f"{s.id}~{p.id}", "birth": p.birth})
        for s, p in zip(group, partners, strict=True)
    }


def chart_swap(events: EventsFile) -> tuple[EventsFile, int]:
    """Every native's events on a same-birth-year partner's chart; natives alone are dropped."""
    swapped: dict[str, Subject] = {}
    for group in _by_birth_year(list(events.subjects)).values():
        swapped |= _rotated(group) if len(group) > 1 else {}
    kept = [swapped[s.id] for s in events.subjects if s.id in swapped]
    dropped = len(events.subjects) - len(kept)
    label = f"{events.label} [chart-swap control]"
    return events.model_copy(update={"subjects": kept, "label": label}), dropped


def _shifted(event: LifeEvent, rng: random.Random) -> LifeEvent:
    month = event.month
    if month is None:
        return event
    offset = rng.choice((-1, 1)) * rng.randint(_SHIFT_MIN, _SHIFT_MAX)
    year, moved = add_months(month, offset)
    return event.model_copy(update={"date": f"{year:04d}-{moved:02d}", "precision": "month"})


def shift_months(events: EventsFile, seed: int) -> EventsFile:
    """Every month event moved outside its own window by a seeded offset."""
    rng = random.Random(seed)
    subjects = [
        s.model_copy(update={"events": [_shifted(e, rng) for e in s.events]})
        for s in events.subjects
    ]
    label = f"{events.label} [shifted-months control]"
    return events.model_copy(update={"subjects": subjects, "label": label})


def _fitting(month: YearMonth, offset: int, fits: Callable[[YearMonth], bool]) -> YearMonth | None:
    """The centre ``offset`` months away, or the mirrored one, if its window fits."""
    for signed in (offset, -offset):
        centre = add_months(month, signed)
        if fits(centre):
            return centre
    return None


def placebo_centres(
    month: YearMonth,
    native: str,
    ordinal: int,
    fits: Callable[[YearMonth], bool],
    count: int = PLACEBOS,
) -> list[YearMonth]:
    """Amendment (f1): seeded per event, so every run and worker draws the same centres."""
    rng = random.Random(f"{SPLIT_SEED}:{native}:{ordinal}")
    offsets = [rng.choice((-1, 1)) * rng.randint(_SHIFT_MIN, _SHIFT_MAX) for _ in range(count)]
    centres = [_fitting(month, offset, fits) for offset in offsets]
    return [c for c in centres if c is not None]


def planted(scored: list[EventScores]) -> list[EventScores]:
    """Each event with a family scoring 1 in its own month and 0 elsewhere."""
    return [_with_planted(e) for e in scored]


def _with_planted(e: EventScores) -> EventScores:
    months = len(next(iter(e.families.values())))
    peek = tuple(float(i == e.index) for i in range(months))
    return EventScores(e.subject, e.category, e.month, e.area, {PLANTED: peek}, e.index)


__all__ = ["PLACEBOS", "PLANTED", "chart_swap", "placebo_centres", "planted", "shift_months"]
