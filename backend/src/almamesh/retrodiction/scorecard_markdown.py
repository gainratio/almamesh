"""Render a ``Scorecard`` as markdown: aggregates only, ready to paste into a PR."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from almamesh.retrodiction.harness import Summary
    from almamesh.retrodiction.scorecard import AreaRow, Corrections, Ratio, Scorecard


def _lift(s: Summary) -> str:
    return f"{s.lift:.2f} [{s.lift_low:.2f}, {s.lift_high:.2f}] p={s.p_value:.3g}"


def _ratio(r: Ratio) -> str:
    if r.value is None or r.low is None or r.high is None:
        return "undefined (baseline never hits)"
    return f"{r.value:.2f} [{r.low:.2f}, {r.high:.2f}]"


def _row(row: AreaRow) -> str:
    swap = row.swap
    cells = [row.area, str(row.n), _lift(row.baseline), _lift(row.added), _ratio(row.ratio)]
    cells += [str(swap.n), _lift(swap.baseline), _lift(swap.added)] if swap else ["0", "-", "-"]
    return "| " + " | ".join(cells) + " |"


def _table(card: Scorecard, k: int) -> list[str]:
    added = card.added_family
    return [
        f"## k = {k} (chance {k}/{2 * card.window + 1})",
        "",
        f"| area | n | BASELINE lift [95% CI] | +{added} lift [95% CI] | ratio [95% CI] "
        "| swap n | swap BASELINE | swap +family |",
        "|---|---|---|---|---|---|---|---|",
        *(_row(r) for r in card.rows if r.k == k),
        "",
    ]


def _cells(cells: list[tuple[str, int]]) -> str:
    return ", ".join(f"{area} k={k}" for area, k in cells) or "none"


def _corrections(c: Corrections, added: str) -> list[str]:
    return [
        f"## Multiple comparisons (+{added}, per area x k: {c.tests} tests, alpha 0.05)",
        "",
        f"- raw p < 0.05: {_cells(c.raw)}",
        f"- Holm survivors: {_cells(c.holm)}",
        f"- Benjamini-Hochberg survivors: {_cells(c.bh)}",
        "",
    ]


def _control_lines(name: str, rows: dict[str, Summary]) -> list[str]:
    return [f"- {name}, k={k}: lift {_lift(s)}" for k, s in rows.items()]


def _controls(card: Scorecard) -> list[str]:
    v = card.verdicts
    verdict = "ok" if v.planted_ok and v.shuffled_ok else "VOID: a control misbehaved"
    return [
        f"## Controls ({verdict})",
        "",
        *_control_lines("planted (must be N/k, p at the 1e-12 floor)", card.planted),
        *_control_lines("shifted months (CI must include 1)", card.shuffled),
        f"- chart swap: {card.swap_natives_dropped} natives alone in their birth year dropped; "
        f"exclusions {card.swap_exclusions or 'none'}",
        "",
    ]


def render_scorecard(card: Scorecard, *, evidence: bool) -> str:
    """The scorecard as markdown."""
    lines = [f"# Scorecard: {card.label}", ""]
    if not evidence:
        lines += ["> **SYNTHETIC set: harness sanity only, not evidence.**", ""]
    lines += [
        f"Measures `{card.added_family}`. Window ±{card.window}, k = "
        f"{', '.join(map(str, card.ks))}. Pre-registration digest "
        f"`{card.preregistration_digest[:12]}`. {card.events_scored} events scored; "
        f"exclusions {card.exclusions or 'none'}. Ratio = +family hits / BASELINE hits, "
        "bootstrap over natives.",
        "",
    ]
    for k in card.ks:
        lines += _table(card, k)
    lines += _corrections(card.corrections, card.added_family)
    return "\n".join([*lines, *_controls(card)])


__all__ = ["render_scorecard"]
