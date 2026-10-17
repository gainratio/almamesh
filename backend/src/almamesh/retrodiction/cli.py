"""``almamesh-eval retrodiction``: score an event file and write report.json + report.md.

    uv run almamesh-eval retrodiction --events ~/.almamesh/retrodiction/events.yaml \
        --window 36 --k 3,6
    uv run almamesh-eval adb-summary --adb ~/.almamesh/retrodiction/adb/adb_export_X.xml
    uv run almamesh-eval retrodiction --adb ~/.almamesh/retrodiction/adb/adb_export_X.xml
    uv run almamesh-eval adb-split --adb ~/.almamesh/retrodiction/adb/adb_export_X.xml
    uv run almamesh-eval retrodiction --adb ... --split dev
    uv run almamesh-eval scorecard --adb ... --split dev --workers 6

Refusals print one line and exit 2 with nothing written.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, NoReturn, cast

import typer

from almamesh.retrodiction.adb import import_adb
from almamesh.retrodiction.controls import PLACEBOS
from almamesh.retrodiction.events import (
    EventsFile,
    RetrodictionInputError,
    inside_git_tree,
    load_events,
)
from almamesh.retrodiction.mapping import PREREGISTERED_KS, PREREGISTERED_WINDOW
from almamesh.retrodiction.markdown import render_markdown
from almamesh.retrodiction.placebo_card import PlaceboCard, build_placebo_card
from almamesh.retrodiction.placebo_markdown import render_placebo_card
from almamesh.retrodiction.placebo_run import ADDED_FAMILIES, AddedFamily, RunPlan
from almamesh.retrodiction.report import Report, build_report, sample_subjects
from almamesh.retrodiction.scorecard import Scorecard, build_scorecard
from almamesh.retrodiction.scorecard_markdown import render_scorecard
from almamesh.retrodiction.split import (
    ADB_SPLIT_DIGEST,
    SPLIT_SEED,
    NativeSplit,
    Part,
    checked_split,
    select_part,
    split_natives,
)

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


def _half(loaded: EventsFile, part: Part | None, release_look: bool) -> EventsFile:
    """One half of the pinned split; HELD-OUT only for a declared release look."""
    if part is None:
        return loaded
    if part == "held-out" and not release_look:
        raise RetrodictionInputError(
            "HELD-OUT is scored only for a release candidate: pass --release-look and log "
            "the look in docs/eval/holdout-ledger.md"
        )
    return select_part(loaded, checked_split(loaded, ADB_SPLIT_DIGEST), part)


def _load(events: Path | None, adb: Path | None) -> tuple[EventsFile, Path, bool]:
    """The event file, the path its report sits beside, and whether that report is private."""
    if adb is not None and events is None:
        return import_adb(adb).events, adb, True
    if events is not None and adb is None:
        loaded = load_events(events)
        return loaded, events, loaded.kind == "personal"
    raise RetrodictionInputError("give exactly one of --events or --adb")


def _out_dir(
    source: Path, out: Path | None, private: bool, name: str = "retrodiction-report"
) -> Path:
    target = out if out is not None else source.parent / name
    if private and inside_git_tree(target / "report.json"):
        raise RetrodictionInputError(
            f"{target} is inside a git working tree; personal and licensed reports stay outside"
        )
    return target


def _write(report: Report, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "report.json").write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    (target / "report.md").write_text(render_markdown(report), encoding="utf-8")


@dataclass(frozen=True)
class _Options:
    """How to run: window, k, report directory, processes and an optional native sample."""

    window: int
    k: str
    out: Path | None
    workers: int
    sample: int | None
    seed: int | None
    split: Part | None = None
    release_look: bool = False


def _sampled(loaded: EventsFile, options: _Options) -> EventsFile:
    if options.sample is None:
        return loaded
    if options.seed is None:
        raise RetrodictionInputError("--sample-natives needs --seed (record it in the spec)")
    return sample_subjects(loaded, options.sample, options.seed)


def _prepare(
    events: Path | None, adb: Path | None, options: _Options
) -> tuple[EventsFile, Path, bool]:
    """The (split, sampled) event file, the path its output sits beside, and privacy."""
    if options.split is not None and adb is None:
        raise RetrodictionInputError("--split applies to an ADB export (--adb)")
    loaded, source, private = _load(events, adb)
    if adb is not None and options.split is None:
        raise RetrodictionInputError(
            "an ADB run needs --split dev (HELD-OUT is spent; see docs/eval/holdout-ledger.md)"
        )
    half = _half(loaded, options.split, options.release_look)
    if options.split == "held-out" and options.sample is not None:
        raise RetrodictionInputError(
            "a HELD-OUT look scores the whole half; --sample-natives with a seed is a free draw"
        )
    return _sampled(half, options), source, private


def _require_preregistered(options: _Options, ks: tuple[int, ...]) -> None:
    """HELD-OUT is scored only at the pre-registered window and k, never at a tuned one."""
    if options.split == "held-out" and (
        options.window != PREREGISTERED_WINDOW or ks != PREREGISTERED_KS
    ):
        raise RetrodictionInputError(
            f"HELD-OUT is scored only at the pre-registered window {PREREGISTERED_WINDOW} "
            f"and k {','.join(map(str, PREREGISTERED_KS))}"
        )


def _report(loaded: EventsFile, options: _Options, ks: tuple[int, ...]) -> Report:
    report = build_report(loaded, options.window, ks, options.workers)
    if options.sample is not None:
        report.run.sample_natives, report.run.sample_seed = options.sample, options.seed
    return report


def _run(events: Path | None, adb: Path | None, options: _Options) -> str:
    loaded, source, private = _prepare(events, adb, options)
    ks = parse_ks(options.k, options.window)
    _require_preregistered(options, ks)
    target = _out_dir(source, options.out, private)
    report = _report(loaded, options, ks)
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
    workers: Annotated[
        int, typer.Option(min=1, max=64, help="Processes scoring natives (same result as 1)")
    ] = 1,
    sample_natives: Annotated[
        int | None, typer.Option(min=1, help="Score a random sample of this many natives")
    ] = None,
    seed: Annotated[int | None, typer.Option(help="Seed for --sample-natives")] = None,
    split: Annotated[
        str | None, typer.Option(help="Score one half of the pinned ADB split: dev or held-out")
    ] = None,
    release_look: Annotated[
        bool, typer.Option(help="Declare a logged HELD-OUT look for a release candidate")
    ] = False,
) -> None:
    """Rank each event month among its window and compare with chance."""
    try:
        options = _Options(
            window, k, out, workers, sample_natives, seed, _part(split), release_look
        )
        typer.echo(_run(events, adb, options))
    except RetrodictionInputError as exc:
        _refuse(exc)


def _part(text: str | None) -> Part | None:
    if text is None or text in {"dev", "held-out"}:
        return cast("Part | None", text)
    raise RetrodictionInputError(f"--split must be dev or held-out, got {text!r}")


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


def _write_card(card: Scorecard, target: Path, *, evidence: bool) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "scorecard.json").write_text(card.model_dump_json(indent=2) + "\n", "utf-8")
    (target / "scorecard.md").write_text(render_scorecard(card, evidence=evidence), "utf-8")


def _scorecard(events: Path | None, adb: Path | None, options: _Options) -> str:
    loaded, source, private = _prepare(events, adb, options)
    target = _out_dir(source, options.out, private, "scorecard")
    card = build_scorecard(
        loaded, PREREGISTERED_WINDOW, PREREGISTERED_KS, options.workers, SPLIT_SEED
    )
    _write_card(card, target, evidence=loaded.kind != "synthetic")
    verdict = "controls ok" if card.verdicts.planted_ok and card.verdicts.shuffled_ok else "VOID"
    return f"{card.events_scored} events scored, {verdict} -> {target}"


@app.command()
def scorecard(
    events: Annotated[Path | None, typer.Option(help="Event YAML")] = None,
    adb: Annotated[Path | None, typer.Option(help=_ADB_HELP)] = None,
    split: Annotated[str | None, typer.Option(help="dev or held-out (ADB only)")] = None,
    release_look: Annotated[bool, typer.Option(help="Declare a logged HELD-OUT look")] = False,
    out: Annotated[Path | None, typer.Option(help="Scorecard directory")] = None,
    workers: Annotated[int, typer.Option(min=1, max=64, help="Processes")] = 1,
    sample_natives: Annotated[int | None, typer.Option(min=1, help="Native sample")] = None,
    seed: Annotated[int | None, typer.Option(help="Seed for --sample-natives")] = None,
) -> None:
    """Per-area BASELINE vs +exact_transits with chart-swap, shifted and planted controls.

    The bootstrap and the shifted-months control use the split seed (20261015).
    """
    try:
        options = _Options(
            PREREGISTERED_WINDOW, "", out, workers, sample_natives, seed, _part(split), release_look
        )
        typer.echo(_scorecard(events, adb, options))
    except RetrodictionInputError as exc:
        _refuse(exc)


def _plan(added: str, placebos: int, day_precision_only: bool) -> RunPlan:
    if added not in ADDED_FAMILIES:
        raise RetrodictionInputError(
            f"--added must be one of {', '.join(ADDED_FAMILIES)}, got {added!r}"
        )
    family = cast("AddedFamily", added)
    return RunPlan(added=family, placebos=placebos, day_precision_only=day_precision_only)


def _dev_only(adb: Path | None, options: _Options, plan: RunPlan) -> None:
    """Amendment (h3): an ADB run of classical_dasha reads the DEV half, never HELD-OUT."""
    if plan.added == "classical_dasha" and adb is not None and options.split != "dev":
        raise RetrodictionInputError(
            "classical_dasha is scored on the DEV half only (amendment h3): pass --split dev; "
            "HELD-OUT is not read for this family"
        )


def _write_placebo(card: PlaceboCard, target: Path, *, evidence: bool) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "placebo-scorecard.json").write_text(card.model_dump_json(indent=2) + "\n", "utf-8")
    markdown = render_placebo_card(card, evidence=evidence)
    (target / "placebo-scorecard.md").write_text(markdown, "utf-8")


def _placebo(events: Path | None, adb: Path | None, options: _Options, plan: RunPlan) -> str:
    _dev_only(adb, options, plan)
    loaded, source, private = _prepare(events, adb, options)
    target = _out_dir(source, options.out, private, f"placebo-scorecard-{plan.added}")
    card = build_placebo_card(loaded, plan, options.workers)
    _write_placebo(card, target, evidence=loaded.kind != "synthetic")
    v = card.verdicts
    verdict = "controls ok" if v.planted_ok and v.controls_ok else "VOID"
    return f"{card.counts.events_scored} events scored, {verdict} -> {target}"


@app.command("placebo-scorecard")
def placebo_scorecard(
    events: Annotated[Path | None, typer.Option(help="Event YAML")] = None,
    adb: Annotated[Path | None, typer.Option(help=_ADB_HELP)] = None,
    split: Annotated[str | None, typer.Option(help="dev or held-out (ADB only)")] = None,
    release_look: Annotated[bool, typer.Option(help="Declare a logged HELD-OUT look")] = False,
    added: Annotated[str, typer.Option(help=", ".join(ADDED_FAMILIES))] = ("exact_transits"),
    placebos: Annotated[int, typer.Option(min=1, max=PLACEBOS, help="Placebo windows")] = PLACEBOS,
    day_precision_only: Annotated[
        bool, typer.Option(help="Score only day-precision events (amendment h5)")
    ] = False,
    out: Annotated[Path | None, typer.Option(help="Scorecard directory")] = None,
    workers: Annotated[int, typer.Option(min=1, max=64, help="Processes")] = 1,
    sample_natives: Annotated[int | None, typer.Option(min=1, help="Native sample")] = None,
    seed: Annotated[int | None, typer.Option(help="Seed for --sample-natives")] = None,
) -> None:
    """Amendment (f): placebo-calibrated BASELINE vs +family, swap ratio and controls."""
    try:
        plan = _plan(added, placebos, day_precision_only)
        options = _Options(
            PREREGISTERED_WINDOW, "", out, workers, sample_natives, seed, _part(split), release_look
        )
        typer.echo(_placebo(events, adb, options, plan))
    except RetrodictionInputError as exc:
        _refuse(exc)


def _split_file(export: Path, split: NativeSplit) -> Path:
    target = export.parent / f"split-{split.digest[:12]}.json"
    body = {"digest": split.digest, "dev": split.dev, "held_out": split.held_out}
    target.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")
    return target


@app.command("adb-split")
def adb_split(
    adb: Annotated[Path, typer.Option(help=_ADB_HELP)],
) -> None:
    """Split the export's natives into DEV and HELD-OUT; ids go beside the export only.

    The import already refuses an export inside a git tree, so the id file never lands in one.
    """
    try:
        split = split_natives(import_adb(adb).events)
        target = _split_file(adb, split)
    except RetrodictionInputError as exc:
        _refuse(exc)
    pinned = "pinned" if split.digest == ADB_SPLIT_DIGEST else "NOT the pinned split"
    typer.echo(
        f"split {split.digest} ({pinned}): dev {len(split.dev)}, "
        f"held-out {len(split.held_out)} natives -> {target}"
    )


__all__ = ["app", "parse_ks"]
