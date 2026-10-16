"""Render a ``PlaceboCard`` as markdown: aggregates only, ready to paste into the results."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from almamesh.retrodiction.placebo import OldLift, PlaceboSummary, ShiftedControl
    from almamesh.retrodiction.placebo_card import PlaceboCard, PlaceboRow
    from almamesh.retrodiction.scorecard import Corrections

_UNDEFINED = "undefined"


def _interval(value: float | None, low: float | None, high: float | None) -> str:
    if value is None or low is None or high is None:
        return _UNDEFINED
    return f"{value:.2f} [{low:.2f}, {high:.2f}]"


def _old(o: OldLift) -> str:
    return f"{o.lift:.2f} [{o.low:.2f}, {o.high:.2f}]"


def _primary(s: PlaceboSummary) -> str:
    return f"{_interval(s.lift, s.low, s.high)} p={s.p:.3g}"


def _row(r: PlaceboRow) -> str:
    swap = f"{_interval(r.swap.ratio, r.swap.low, r.swap.high)} (n={r.swap.n})"
    cells = [r.area, r.family_set, str(r.summary.n), _primary(r.summary), _old(r.summary.old), swap]
    return "| " + " | ".join(cells) + " |"


def _table(card: PlaceboCard, k: int) -> list[str]:
    return [
        f"## k = {k}",
        "",
        "| area | set | n | placebo-calibrated lift [95% CI], p | old k/N lift [95% CI] "
        "| real/swap centre hits [95% CI] |",
        "|---|---|---|---|---|---|",
        *(_row(r) for r in card.rows if r.k == k),
        "",
    ]


def _cells(cells: list[tuple[str, int]]) -> str:
    return ", ".join(f"{area} k={k}" for area, k in cells) or "none"


def _corrections(name: str, c: Corrections) -> str:
    return (
        f"- {name} ({c.tests} tests): raw {_cells(c.raw)}; Holm {_cells(c.holm)}; BH {_cells(c.bh)}"
    )


def _flag(fails: bool) -> str:
    return "FAIL" if fails else "ok"


def _control(name: str, k: str, c: ShiftedControl) -> str:
    new = f"{_interval(c.placebo.value, c.placebo.low, c.placebo.high)} {_flag(c.fails)}"
    old = f"{_old(c.old)} {_flag(c.old_fails)}"
    return f"| {name} | {k} | {c.n} | {new} | {old} |"


def _controls(card: PlaceboCard) -> list[str]:
    return [
        "## Shifted-month controls (placebo 1 as the event)",
        "",
        "| family set | k | n | placebo-calibrated lift | old k/N lift |",
        "|---|---|---|---|---|",
        *(_control(n, k, c) for n, by_k in card.controls.items() for k, c in by_k.items()),
        "",
    ]


def _names(names: list[str]) -> str:
    return ", ".join(names) or "none"


def _verdict(card: PlaceboCard) -> list[str]:
    v = card.verdicts
    verdict = "controls ok" if v.planted_ok and v.controls_ok else "VOID"
    planted = ", ".join(f"k={k} {_primary(s)}" for k, s in card.planted.items())
    return [
        f"**Verdict: {verdict}.** Planted: {planted}.",
        f"Failing the placebo-calibrated control: {_names(v.failing_sets)}.",
        f"Failing the old k/N control: {_names(v.old_failing_sets)}.",
        "",
    ]


def _run_line(card: PlaceboCard) -> str:
    setup, counts = card.setup, card.counts
    return (
        f"{setup.label}. Window ±{setup.window}, R={setup.placebos} placebos, digest "
        f"`{setup.preregistration_digest[:12]}`. {counts.events_scored} events scored "
        f"({counts.without_placebo} without a placebo window); swap: {counts.swap_events} "
        f"events, {counts.swap_natives_dropped} natives alone in their birth year."
    )


def _header(card: PlaceboCard, evidence: bool) -> list[str]:
    banner = [] if evidence else ["> SYNTHETIC: harness check only, not evidence.", ""]
    title = f"# Placebo-calibrated scorecard (amendment f): BASELINE vs +{card.setup.added_family}"
    return [title, "", *banner, _run_line(card), ""]


def render_placebo_card(card: PlaceboCard, *, evidence: bool) -> str:
    """The scorecard as markdown."""
    lines = _header(card, evidence)
    for k in card.setup.ks:
        lines += _table(card, k)
    lines += ["## Multiple comparisons (alpha 0.05, per configuration)", ""]
    lines += [_corrections(n, c) for n, c in card.corrections.items()] + [""]
    return "\n".join(lines + _controls(card) + _verdict(card))


__all__ = ["render_placebo_card"]
