"""Amendment (f): score each event's window and its placebo windows down to centre hits.

Per native: one engine, the event's own window and up to R placebo windows (same target,
centred 73-146 months away). Only centre hits leave the worker, per family set and k, so
an expensive family (``engine_obstacles``) can be resolved lazily and exactly.
"""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

from almamesh.calculations import SkyfieldAstronomy
from almamesh.retrodiction.centre import centre_hits, lazy_centre_hits
from almamesh.retrodiction.controls import PLACEBOS, placebo_centres
from almamesh.retrodiction.engine import (
    OUT_OF_RANGE_BIRTH,
    EngineReadingRangeError,
    SubjectEngine,
    add_months,
    birth_in_range,
)
from almamesh.retrodiction.harness import EventScores, Exclusion, combined, movers_for, score_event
from almamesh.retrodiction.indicators import DISPUTES_TARGET, ENGINE_OBSTACLES, FAMILIES
from almamesh.retrodiction.mapping import MAPPING, PREREGISTERED_KS, PREREGISTERED_WINDOW
from almamesh.retrodiction.placebo import EventHits, HitKey

if TYPE_CHECKING:
    from collections.abc import Sequence

    from almamesh.retrodiction.engine import YearMonth
    from almamesh.retrodiction.events import EventsFile, LifeEvent, Subject
    from almamesh.retrodiction.indicators import Target

AddedFamily = Literal["exact_transits", "engine_obstacles"]
ADDED_FAMILIES: Final[tuple[str, ...]] = ("exact_transits", "engine_obstacles")
BASELINE: Final[str] = "BASELINE"
V1: Final[frozenset[str]] = frozenset(f.name for f in FAMILIES) - {"exact_transits"}
_CHUNKS_PER_WORKER: Final[int] = 8
UNREADABLE: Final[str] = "the engine's month reading reaches outside the ephemeris (amendment c)"


@dataclass(frozen=True)
class RunPlan:
    """Which family is added to the v1 seven, how many placebos, window and k."""

    added: AddedFamily = "exact_transits"
    placebos: int = PLACEBOS
    ks: tuple[int, ...] = PREREGISTERED_KS
    window: int = PREREGISTERED_WINDOW

    @property
    def added_set(self) -> str:
        """The +FAMILY configuration's name."""
        return f"+{self.added}"

    @property
    def lazy(self) -> bool:
        """The added family costs a predictive run per month (amendment f5)."""
        return self.added == "engine_obstacles"

    def eager_sets(self) -> dict[str, frozenset[str]]:
        """Family sets summed directly: BASELINE, and for +exact the set and each family alone."""
        if self.lazy:
            return {BASELINE: V1}
        names = V1 | {self.added}
        alone = {f"only:{n}": frozenset({n}) for n in sorted(names)}
        return {BASELINE: V1, self.added_set: names} | alone

    def wants(self, event: LifeEvent) -> bool:
        """+OBSTACLES can move only the disputes target, so its run scores only that."""
        return not self.lazy or MAPPING[event.category].target == DISPUTES_TARGET


def _lazy_hits(
    engine: SubjectEngine, scores: EventScores, target: Target, plan: RunPlan
) -> dict[HitKey, float]:
    def extra(position: int) -> float:
        month = engine.month(add_months(scores.month, position - plan.window))
        return ENGINE_OBSTACLES.score(engine.frame, month, target)

    hits = lazy_centre_hits(combined(scores, V1), scores.index, plan.ks, extra)
    return {(plan.added_set, k): hit for k, hit in hits.items()}


def _window_hits(
    engine: SubjectEngine, scores: EventScores, target: Target, plan: RunPlan
) -> dict[HitKey, float]:
    hits = {
        (name, k): hit
        for name, names in plan.eager_sets().items()
        for k, hit in centre_hits(combined(scores, names), scores.index, plan.ks).items()
    }
    return hits | (_lazy_hits(engine, scores, target, plan) if plan.lazy else {})


def _at(event: LifeEvent, centre: YearMonth) -> LifeEvent:
    return event.model_copy(
        update={"date": f"{centre[0]:04d}-{centre[1]:02d}", "precision": "month"}
    )


def _placebo_windows(
    engine: SubjectEngine,
    subject: str,
    ordinal: int,
    event: LifeEvent,
    real: EventScores,
    count: int,
) -> list[EventScores]:
    window = real.index

    def fits(centre: YearMonth) -> bool:
        ends = (add_months(centre, -window), add_months(centre, window))
        return engine.covers(ends[0]) and engine.covers(ends[1])

    centres = placebo_centres(real.month, subject, ordinal, fits, count)
    scored = [score_event(engine, subject, _at(event, c), window) for c in centres]
    return [s for s in scored if isinstance(s, EventScores)]


def _readable_hits(
    engine: SubjectEngine, scores: EventScores, target: Target, plan: RunPlan
) -> dict[HitKey, float] | None:
    """The window's centre hits, or None when an evaluated month cannot be read."""
    try:
        return _window_hits(engine, scores, target, plan)
    except EngineReadingRangeError:
        return None


def _event_hits(
    engine: SubjectEngine, subject: str, ordinal: int, event: LifeEvent, plan: RunPlan
) -> EventHits | Exclusion:
    real = score_event(engine, subject, event, plan.window)
    if isinstance(real, Exclusion):
        return real
    target = MAPPING[event.category].target
    own = _readable_hits(engine, real, target, plan)
    if own is None:
        return Exclusion(subject, event.category, event.date, UNREADABLE)
    windows = _placebo_windows(engine, subject, ordinal, event, real, plan.placebos)
    placebos = [_readable_hits(engine, w, target, plan) for w in windows]
    return EventHits(subject, ordinal, real.area, own, tuple(p for p in placebos if p is not None))


def _out_of_range(subject: Subject, events: Sequence[LifeEvent]) -> list[EventHits | Exclusion]:
    return [Exclusion(subject.id, e.category, e.date, OUT_OF_RANGE_BIRTH) for e in events]


def _subject_hits(
    subject: Subject, astronomy: SkyfieldAstronomy, plan: RunPlan
) -> list[EventHits | Exclusion]:
    wanted = _wanted(subject, plan)
    if not birth_in_range(subject.birth):
        return _out_of_range(subject, [e for _, e in wanted])
    engine = SubjectEngine(subject.birth, astronomy, movers_for(subject.events))
    return [_event_hits(engine, subject.id, i, e, plan) for i, e in wanted]


def _wanted(subject: Subject, plan: RunPlan) -> list[tuple[int, LifeEvent]]:
    """The events this run scores, with their ordinal in the native's own list."""
    return [(i, e) for i, e in enumerate(subject.events) if plan.wants(e)]


def _score_chunk(subjects: Sequence[Subject], plan: RunPlan) -> list[EventHits | Exclusion]:
    results: list[EventHits | Exclusion] = []
    with SkyfieldAstronomy() as astronomy:
        for subject in subjects:
            results += _subject_hits(subject, astronomy, plan)
    return results


def _split(results: Sequence[EventHits | Exclusion]) -> tuple[list[EventHits], list[Exclusion]]:
    hits = [r for r in results if isinstance(r, EventHits)]
    return hits, [r for r in results if isinstance(r, Exclusion)]


def score_hits(
    events_file: EventsFile, plan: RunPlan, workers: int = 1
) -> tuple[list[EventHits], list[Exclusion]]:
    """Every wanted event's centre hits (own window and placebos), or why not; file order."""
    subjects = events_file.subjects
    if workers <= 1:
        return _split(_score_chunk(subjects, plan))
    size = max(1, -(-len(subjects) // (workers * _CHUNKS_PER_WORKER)))
    chunks = [subjects[i : i + size] for i in range(0, len(subjects), size)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        parts = pool.map(_score_chunk, chunks, [plan] * len(chunks))
        return _split([r for part in parts for r in part])


__all__ = [
    "ADDED_FAMILIES",
    "BASELINE",
    "UNREADABLE",
    "V1",
    "AddedFamily",
    "RunPlan",
    "score_hits",
]
