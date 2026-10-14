"""The amendment (f) DEV scorecard: placebo-calibrated lift per configuration, area and k.

BASELINE (the v1 seven) and +FAMILY rows, each with the placebo-calibrated lift, its exact
randomization p and the old k/N lift beside it; real over chart-swapped centre hits; Holm and
BH per configuration; per-family shifted-month controls under both metrics; a planted family.
Aggregates only: no native id, date or place reaches the output.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Final

from pydantic import BaseModel

from almamesh.retrodiction.controls import PLANTED, chart_swap
from almamesh.retrodiction.events import RetrodictionInputError
from almamesh.retrodiction.mapping import preregistration_digest
from almamesh.retrodiction.placebo import (
    EventHits,
    PlaceboSummary,
    ShiftedControl,
    SwapComparison,
    placebo_summary,
    shifted_control,
    swap_comparison,
)
from almamesh.retrodiction.placebo_run import BASELINE, RunPlan, score_hits
from almamesh.retrodiction.scorecard import ALL_AREAS, Corrections, corrected
from almamesh.retrodiction.split import SPLIT_SEED
from almamesh.retrodiction.stats import FFT_P_FLOOR, base_rate

if TYPE_CHECKING:
    from collections.abc import Sequence

    from almamesh.retrodiction.events import EventsFile
    from almamesh.retrodiction.harness import Exclusion

_PLANTED_TOLERANCE: Final[float] = 1e-6

__all__ = ["BASELINE", "PlaceboCard", "PlaceboRow", "RunPlan", "Verdicts", "build_placebo_card"]


class PlaceboRow(BaseModel):
    """One configuration, area and k: the primary statistic and the swap comparison."""

    family_set: str
    area: str
    k: int
    summary: PlaceboSummary
    swap: SwapComparison


class Verdicts(BaseModel):
    """The run is void unless the planted family and every configuration's control behave."""

    planted_ok: bool
    controls_ok: bool
    failing_sets: list[str]
    old_failing_sets: list[str]


class PlaceboCard(BaseModel):
    """The whole amendment (f) scorecard for one added family."""

    label: str
    added_family: str
    family_sets: list[str]
    preregistration_digest: str
    window: int
    ks: list[int]
    placebos: int
    events_scored: int
    without_placebo: int
    exclusions: dict[str, int]
    swap_natives_dropped: int
    swap_events: int
    rows: list[PlaceboRow]
    corrections: dict[str, Corrections]
    controls: dict[str, dict[str, ShiftedControl]]
    planted: dict[str, PlaceboSummary]
    verdicts: Verdicts


@dataclass(frozen=True)
class _Runs:
    real: list[EventHits]
    excluded: list[Exclusion]
    swap: list[EventHits]
    swap_dropped: int


def _grouped(events: Sequence[EventHits]) -> dict[str, list[EventHits]]:
    groups: dict[str, list[EventHits]] = defaultdict(list)
    for e in events:
        groups[e.area].append(e)
    return {ALL_AREAS: list(events)} | dict(sorted(groups.items()))


def _rankable(events: Sequence[EventHits]) -> dict[str, list[EventHits]]:
    """Area groups with at least one event that has a placebo window."""
    return {a: g for a, g in _grouped(events).items() if any(e.placebos for e in g)}


def _set_rows(runs: _Runs, name: str, ks: Sequence[int], months: int) -> list[PlaceboRow]:
    return [
        PlaceboRow(
            family_set=name,
            area=area,
            k=k,
            summary=placebo_summary(group, name, k, months, SPLIT_SEED),
            swap=swap_comparison(group, runs.swap, name, k, months, SPLIT_SEED),
        )
        for area, group in _rankable(runs.real).items()
        for k in ks
    ]


def _rows(runs: _Runs, plan: RunPlan, months: int) -> list[PlaceboRow]:
    return [
        r for name in (BASELINE, plan.added_set) for r in _set_rows(runs, name, plan.ks, months)
    ]


def _corrections(rows: Sequence[PlaceboRow], plan: RunPlan) -> dict[str, Corrections]:
    return {
        name: corrected(
            {
                (r.area, r.k): r.summary.p
                for r in rows
                if r.family_set == name and r.area != ALL_AREAS
            }
        )
        for name in (BASELINE, plan.added_set)
    }


def _control_sets(plan: RunPlan) -> list[str]:
    return sorted(set(plan.eager_sets()) | {plan.added_set})


def _controls(
    events: Sequence[EventHits], plan: RunPlan, months: int
) -> dict[str, dict[str, ShiftedControl]]:
    return {
        name: {str(k): shifted_control(events, name, k, months, SPLIT_SEED) for k in plan.ks}
        for name in _control_sets(plan)
    }


def _planted_hits(e: EventHits, ks: Sequence[int], months: int) -> EventHits:
    """A family scoring 1 at the event month, 0 elsewhere: hit 1 at the centre, and k/N in
    every placebo window, where all months tie at 0."""
    real = {(PLANTED, k): 1.0 for k in ks}
    tied = {(PLANTED, k): base_rate(k, months) for k in ks}
    return EventHits(e.subject, e.ordinal, e.area, real, tuple(tied for _ in e.placebos))


def _planted(events: Sequence[EventHits], plan: RunPlan, months: int) -> dict[str, PlaceboSummary]:
    planted = [_planted_hits(e, plan.ks, months) for e in events]
    return {str(k): placebo_summary(planted, PLANTED, k, months, SPLIT_SEED) for k in plan.ks}


def _planted_ok(planted: dict[str, PlaceboSummary], months: int) -> bool:
    def ok(k: int, s: PlaceboSummary) -> bool:
        ceiling = months / k
        lift = s.lift if s.lift is not None else 0.0
        return abs(lift - ceiling) <= _PLANTED_TOLERANCE * ceiling and s.p <= FFT_P_FLOOR

    return all(ok(int(k), s) for k, s in planted.items())


def _failing(controls: dict[str, dict[str, ShiftedControl]], *, old: bool) -> list[str]:
    return sorted(
        name
        for name, by_k in controls.items()
        if any(c.old_fails if old else c.fails for c in by_k.values())
    )


def _verdicts(
    controls: dict[str, dict[str, ShiftedControl]],
    planted: dict[str, PlaceboSummary],
    plan: RunPlan,
    months: int,
) -> Verdicts:
    failing = _failing(controls, old=False)
    return Verdicts(
        planted_ok=_planted_ok(planted, months),
        controls_ok=not {BASELINE, plan.added_set} & set(failing),
        failing_sets=failing,
        old_failing_sets=_failing(controls, old=True),
    )


def _score(events_file: EventsFile, plan: RunPlan, workers: int) -> _Runs:
    real, excluded = score_hits(events_file, plan, workers)
    swap_file, dropped = chart_swap(events_file)
    swap, _ = score_hits(swap_file, replace(plan, placebos=0), workers)
    return _Runs(real, excluded, swap, dropped)


def _assemble(runs: _Runs, label: str, plan: RunPlan) -> PlaceboCard:
    months = 2 * plan.window + 1
    rows = _rows(runs, plan, months)
    controls, planted = _controls(runs.real, plan, months), _planted(runs.real, plan, months)
    return PlaceboCard(
        label=label,
        added_family=plan.added,
        family_sets=_control_sets(plan),
        preregistration_digest=preregistration_digest(plan.window, plan.ks),
        window=plan.window,
        ks=list(plan.ks),
        placebos=plan.placebos,
        events_scored=len(runs.real),
        without_placebo=sum(1 for e in runs.real if not e.placebos),
        exclusions=dict(sorted(Counter(x.reason for x in runs.excluded).items())),
        swap_natives_dropped=runs.swap_dropped,
        swap_events=len(runs.swap),
        rows=rows,
        corrections=_corrections(rows, plan),
        controls=controls,
        planted=planted,
        verdicts=_verdicts(controls, planted, plan, months),
    )


def build_placebo_card(events_file: EventsFile, plan: RunPlan, workers: int) -> PlaceboCard:
    """Score real and chart-swapped windows (placebos on the real ones) and summarise."""
    runs = _score(events_file, plan, workers)
    if not any(e.placebos for e in runs.real):
        raise RetrodictionInputError("no event could be ranked against a placebo window")
    return _assemble(runs, events_file.label, plan)
