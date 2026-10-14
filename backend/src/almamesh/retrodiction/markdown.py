"""Render a retrodiction ``Report`` as plain markdown tables."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from almamesh.retrodiction.harness import Summary
    from almamesh.retrodiction.report import CategoryRow, EventRow, Report, RunInfo


def _row(*cells: str) -> str:
    return "| " + " | ".join(cells) + " |"


def _run_line(run: RunInfo) -> str:
    status = "pre-registered run" if run.preregistered else "NOT the pre-registered run"
    ks = ", ".join(map(str, run.ks))
    return (
        f"Kind `{run.kind}`. Source: {run.source or 'n/a'}. "
        f"Window ±{run.window} months ({run.months_per_window} months), k = {ks}. "
        f"{status} (digest `{run.preregistration_digest[:12]}`). "
        "Hit = event month in the top k of its window; ties split exactly, "
        "so chance is k/N for every event."
    )


def _title(report: Report) -> list[str]:
    lines = [f"# Retrodiction report: {report.run.label}", ""]
    if not report.run.evidence:
        lines += ["> **SYNTHETIC set: harness sanity only, not evidence.**", ""]
    return [*lines, _run_line(report.run), ""]


def _cells(s: Summary) -> str:
    return (
        f"{s.hits:.2f}/{s.n} | {s.rate:.1%} | {s.base_rate:.1%} | {s.lift:.2f} "
        f"[{s.lift_low:.2f}, {s.lift_high:.2f}] | {s.p_value:.3g}"
    )


def _summary_table(title: str, rows: list[tuple[str, dict[str, Summary]]]) -> list[str]:
    lines = [
        f"## {title}",
        "",
        "| row | k | hits | rate | chance | lift [95% CI] | p |",
        "|---|---|---|---|---|---|---|",
    ]
    for name, by_k in rows:
        lines += [f"| {name} | {k} | {_cells(s)} |" for k, s in by_k.items()]
    return [*lines, ""]


def _saturation_line(row: CategoryRow) -> str:
    s = row.saturation
    shares = (f"{s.share_nonzero:.0%}", f"{s.top_tie_share:.0%}")
    return _row(row.category, row.area, f"{s.mean_score:.2f}", *shares)


def _saturation(report: Report) -> list[str]:
    lines = [
        "## Saturation control (all families)",
        "",
        "| category | area | mean month score | months > 0 | window tied at top |",
        "|---|---|---|---|---|",
    ]
    return [*lines, *(_saturation_line(row) for row in report.categories), ""]


def _event_line(e: EventRow, ks: list[int]) -> str:
    hits = [f"{e.hits[str(k)]:.2f}" for k in ks]
    cells = [e.subject, e.category, e.month, f"{e.score:.2f}", str(e.months_above)]
    return _row(*cells, str(e.months_tied), *hits)


def _events(report: Report) -> list[str]:
    head = " | ".join(f"hit@{k}" for k in report.run.ks)
    lines = [
        "## Every event (misses included)",
        "",
        f"| subject | category | month | score | months above | tied | {head} |",
        "|---|---|---|---|---|---|" + "---|" * len(report.run.ks),
    ]
    lines += [_event_line(e, report.run.ks) for e in report.events]
    excluded = [f"- {x.subject} {x.category} {x.date}: {x.reason}" for x in report.exclusions]
    return [*lines, "", "Excluded:", "", *(excluded or ["- none"]), ""]


def render_markdown(report: Report) -> str:
    """The whole report as markdown."""
    lines = _title(report)
    lines += _summary_table("Overall (all families)", [("all", report.overall)])
    lines += _summary_table(
        "Per category (exploratory)", [(c.category, c.summaries) for c in report.categories]
    )
    lines += _saturation(report)
    lines += _summary_table(
        "Ablation (exploratory)", [(a.variant, a.summaries) for a in report.ablation]
    )
    lines += _events(report)
    return "\n".join(lines)


__all__ = ["render_markdown"]
