"""``almamesh-eval retrodiction``: score an event file and write report.json + report.md.

    uv run almamesh-eval retrodiction --events ~/.almamesh/retrodiction/events.yaml \
        --window 36 --k 3,6
    uv run almamesh-eval adb-summary --adb ~/.almamesh/retrodiction/adb/adb_export_X.xml
    uv run almamesh-eval retrodiction --adb ~/.almamesh/retrodiction/adb/adb_export_X.xml

Refusals print one line and exit 2 with nothing written.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, NoReturn

import typer

from almamesh.retrodiction.adb import import_adb
from almamesh.retrodiction.events import (
    EventsFile,
    RetrodictionInputError,
    inside_git_tree,
    load_events,
)
from almamesh.retrodiction.markdown import render_markdown
from almamesh.retrodiction.report import Report, build_report

app = typer.Typer(name="almamesh-eval", help="Measure the engine against dated life events.")
_REFUSED = 2
_ADB_HELP = "Astro-Databank export, .xml or .zip (kept outside git trees)"


@app.callback()
def main() -> None:
    """AlmaMesh evals (deterministic, no LLM)."""


def parse_ks(text: str, window: int) -> tuple[int, ...]:
    """Comma-separated k values, each in 1..N-1 for N = 2*window + 1."""
    months = 2 * window + 1
    try:
        ks = tuple(int(part) for part in text.split(","))
    except ValueError as exc:
        raise RetrodictionInputError(f"--k must be comma-separated integers, got {text!r}") from exc
    if not all(0 < k < months for k in ks):
        raise RetrodictionInputError(f"--k values must be in 1..{months - 1}, got {text!r}")
    return ks


def _load(events: Path | None, adb: Path | None) -> tuple[EventsFile, Path, bool]:
    """The event file, the path its report sits beside, and whether that report is private."""
    if adb is not None and events is None:
        return import_adb(adb).events, adb, True
    if events is not None and adb is None:
        loaded = load_events(events)
        return loaded, events, loaded.kind == "personal"
    raise RetrodictionInputError("give exactly one of --events or --adb")


def _out_dir(source: Path, out: Path | None, private: bool) -> Path:
    target = out if out is not None else source.parent / "retrodiction-report"
    if private and inside_git_tree(target / "report.json"):
        raise RetrodictionInputError(
            f"{target} is inside a git working tree; personal and licensed reports stay outside"
        )
    return target


def _write(report: Report, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "report.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    (target / "report.md").write_text(render_markdown(report), encoding="utf-8")


def _run(events: Path | None, adb: Path | None, window: int, k: str, out: Path | None) -> str:
    loaded, source, private = _load(events, adb)
    ks = parse_ks(k, window)
    target = _out_dir(source, out, private)
    report = build_report(loaded, window, ks)
    _write(report, target)
    first = report.overall[str(ks[0])]
    label = "evidence" if report.run.evidence else "synthetic, not evidence"
    headline = f"{first.n} events, k={ks[0]}: lift {first.lift:.2f}, p={first.p_value:.3g}"
    return f"{headline} ({label}) -> {target}"


@app.command()
def retrodiction(
    events: Annotated[
        Path | None, typer.Option(help="Event YAML (personal files must live outside git trees)")
    ] = None,
    adb: Annotated[Path | None, typer.Option(help=_ADB_HELP)] = None,
    window: Annotated[
        int, typer.Option(min=1, max=120, help="Months either side of each event")
    ] = 36,
    k: Annotated[str, typer.Option(help="Top-k cut-offs, comma-separated")] = "3,6",
    out: Annotated[
        Path | None, typer.Option(help="Report directory (default: next to the events file)")
    ] = None,
) -> None:
    """Rank each event month among its window and compare with chance."""
    try:
        typer.echo(_run(events, adb, window, k, out))
    except RetrodictionInputError as exc:
        _refuse(exc)


def _refuse(exc: RetrodictionInputError) -> NoReturn:
    typer.echo(f"refused: {exc}", err=True)
    raise typer.Exit(_REFUSED) from exc


@app.command("adb-summary")
def adb_summary(
    adb: Annotated[Path, typer.Option(help=_ADB_HELP)],
) -> None:
    """Import an ADB export and print counts only (no native, no date, no place)."""
    try:
        typer.echo(import_adb(adb).summary.model_dump_json(indent=2))
    except RetrodictionInputError as exc:
        _refuse(exc)


__all__ = ["app", "parse_ks"]
