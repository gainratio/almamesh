"""Run the eval over an event file and render the JSON and markdown reports.

The report carries no timestamp and no absolute path, so the same file and engine
always produce the same bytes.
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING

from pydantic import BaseModel

from almamesh.calculations import SkyfieldAstronomy
from almamesh.retrodiction.engine import SubjectEngine
from almamesh.retrodiction.events import RetrodictionInputError
from almamesh.retrodiction.harness import (
    EventScores,
    Exclusion,
    Saturation,
    Summary,
    ablation_variants,
    combined,
    saturation,
    score_event,
    summarize,
)
from almamesh.retrodiction.indicators import FAMILIES
from almamesh.retrodiction.mapping import (
    PREREGISTERED_KS,
    PREREGISTERED_WINDOW,
    preregistration_digest,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from almamesh.retrodiction.events import EventsFile, Subject

ALL_FAMILIES = frozenset(f.name for f in FAMILIES)


class EventRow(BaseModel):
    """One ranked event: misses are reported like hits."""

    subject: str
    category: str
    month: str
    area: str
    score: float
    months_above: int
    months_tied: int
    hits: dict[str, float]


class ExclusionRow(BaseModel):
    """One event that could not be ranked."""

    subject: str
    category: str
    date: str
    reason: str


class CategoryRow(BaseModel):
    """Per-category results and the saturation control."""

    category: str
    area: str
    summaries: dict[str, Summary]
    saturation: Saturation


class AblationRow(BaseModel):
    """One family subset's overall result."""

    variant: str
    summaries: dict[str, Summary]


class RunInfo(BaseModel):
    """What was run: the set, its kind, and the pre-registered choices."""

    label: str
    kind: str
    source: str | None
    evidence: bool
    window: int
    ks: list[int]
    months_per_window: int
    preregistration_digest: str
    preregistered: bool
    families: list[str]

    @classmethod
    def of(cls, events_file: EventsFile, window: int, ks: Sequence[int]) -> RunInfo:
        """The run header; ``preregistered`` is true only for the frozen window and k."""
        digest = preregistration_digest(window, tuple(ks))
        frozen = preregistration_digest(PREREGISTERED_WINDOW, PREREGISTERED_KS)
        return cls(
            label=events_file.label,
            kind=events_file.kind,
            source=events_file.source,
            evidence=events_file.kind != "synthetic",
            window=window,
            ks=list(ks),
            months_per_window=2 * window + 1,
            preregistration_digest=digest,
            preregistered=digest == frozen,
            families=sorted(ALL_FAMILIES),
        )


class Report(BaseModel):
    """The whole retrodiction report."""

    run: RunInfo
    overall: dict[str, Summary]
    categories: list[CategoryRow]
    ablation: list[AblationRow]
    events: list[EventRow]
    exclusions: list[ExclusionRow]


def _subject_results(
    subject: Subject, astronomy: SkyfieldAstronomy, window: int
) -> list[EventScores | Exclusion]:
    engine = SubjectEngine(subject.birth, astronomy)
    return [score_event(engine, subject.id, event, window) for event in subject.events]


def score_file(events_file: EventsFile, window: int) -> tuple[list[EventScores], list[Exclusion]]:
    """Every event of every subject, scored or excluded."""
    results: list[EventScores | Exclusion] = []
    with SkyfieldAstronomy() as astronomy:
        for subject in events_file.subjects:
            results += _subject_results(subject, astronomy, window)
    return _split(results)


def _split(results: list[EventScores | Exclusion]) -> tuple[list[EventScores], list[Exclusion]]:
    scored = [r for r in results if isinstance(r, EventScores)]
    return scored, [r for r in results if isinstance(r, Exclusion)]


def _by_k(
    events: Sequence[EventScores], names: frozenset[str], ks: Sequence[int]
) -> dict[str, Summary]:
    return {str(k): summarize(events, names, k) for k in ks}


def _event_row(e: EventScores, ks: Sequence[int]) -> EventRow:
    series = combined(e, ALL_FAMILIES)
    score = series[e.index]
    hits = {str(k): summarize([e], ALL_FAMILIES, k).hits for k in ks}
    return EventRow(
        subject=e.subject,
        category=e.category.value,
        month=f"{e.month[0]:04d}-{e.month[1]:02d}",
        area=e.area,
        score=score,
        months_above=sum(v > score for v in series),
        months_tied=series.count(score) - 1,
        hits=hits,
    )


def _categories(events: Sequence[EventScores], ks: Sequence[int]) -> list[CategoryRow]:
    groups: dict[str, list[EventScores]] = defaultdict(list)
    for e in events:
        groups[e.category.value].append(e)
    return [
        CategoryRow(
            category=c,
            area=g[0].area,
            summaries=_by_k(g, ALL_FAMILIES, ks),
            saturation=saturation(g, ALL_FAMILIES),
        )
        for c, g in sorted(groups.items())
    ]


def _exclusion_row(x: Exclusion) -> ExclusionRow:
    return ExclusionRow(subject=x.subject, category=x.category.value, date=x.date, reason=x.reason)


def _ablation(scored: Sequence[EventScores], ks: Sequence[int]) -> list[AblationRow]:
    variants = ablation_variants().items()
    return [AblationRow(variant=v, summaries=_by_k(scored, n, ks)) for v, n in variants]


def build_report(events_file: EventsFile, window: int, ks: Sequence[int]) -> Report:
    """Score the file and assemble the report; refuses a file with nothing rankable."""
    scored, excluded = score_file(events_file, window)
    if not scored:
        raise RetrodictionInputError("no event could be ranked (see exclusions)")
    return Report(
        run=RunInfo.of(events_file, window, ks),
        overall=_by_k(scored, ALL_FAMILIES, ks),
        categories=_categories(scored, ks),
        ablation=_ablation(scored, ks),
        events=[_event_row(e, ks) for e in scored],
        exclusions=[_exclusion_row(x) for x in excluded],
    )


__all__ = ["Report", "RunInfo", "build_report", "score_file"]
