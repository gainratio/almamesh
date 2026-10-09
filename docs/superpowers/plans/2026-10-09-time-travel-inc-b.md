# Time Travel Increment B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone asks the chat about a long period ("how do 2027 and the first half of 2028 look?"), the answer can talk about Mars and Rahu/Ketu sign changes and about Jupiter, Saturn and Mars turning retrograde or direct, for any period up to two years, from one engine run.

**Architecture:** The Python engine's forward timeline (`backend/src/almamesh/transits/timeline.py`) gains three producers: every sign change of Mars, every sign change of Rahu with Ketu mirrored, and retrograde/direct stations of Jupiter, Saturn and Mars. `compute_predictive_contexts` gains a `window_months` keyword (default 12, max 24) that the worker glue and the CPython edge entry read from the wire. On the app side, the period loader asks for 24 months only when the engine's 12-month window would end before the period does, so the Life Atlas slot and its persisted key are untouched. `covered_events` widens to the new kinds, and a repo contract test ties the app's view (engine month, max window, covered kinds) to the engine's own source and golden.

**Tech Stack:** Python 3.13 engine (Skyfield + DE421, Pydantic, pytest, ruff, mypy strict, xenon), Pyodide worker glue, TypeScript (`@almamesh/llm`, `@almamesh/store`, `@almamesh/browser`, `apps/web`), Vitest, `bun:test` (repo contract tests in `tests/`), Playwright, Dagger.

**Spec:** `docs/superpowers/specs/2026-10-08-time-travel-design.md`. Inc B row: "Engine timeline adds Mars and Rahu/Ketu sign changes and `STATION` events for Jupiter, Saturn and Mars. `compute_predictive_contexts` gains a keyword `window_months` (default 12) so a 13–24 month period is one compute. `covered_events` widens. Claim: CPython/Pyodide parity." Also read "What each section returns", "Rules the app enforces" (the 12-month row ends with Inc B), the Privacy table, Performance, and Testing (`covered_events` honest; engine producers get pytest coverage; parity gate stays green).

## Rulings

The spec is silent on these. Each is a decision this plan makes; the PR body repeats them.

1. **Mars and the nodes report every sign change, in its real direction.** Mars retrogrades across cusps (it leaves Leo backward around 6–11 March 2027 and re-enters around 25–30 April 2027). The existing Jupiter/Saturn rule ("a forward ingress that sticks for 30 days") would drop the March exit and report "enters Leo" twice. So Mars, Rahu and Ketu use every-crossing events with real `from_sign` → `to_sign`. **Jupiter and Saturn keep the sticking-ingress rule**, so their events and the Life Atlas are byte-stable.
2. **Ketu is Rahu mirrored.** Same instant, opposite signs, no second scan. The node is the mean node: the predictive path only ever uses the mean node, and the timeline already hard-codes Lahiri + mean (`timeline_ingress._graha_lon_fn`).
3. **A station is the instant the engine's own retrograde flag flips:** the one-day forward motion in tropical-of-date longitude crosses zero, which is exactly the `speed` that `get_planetary_positions` derives `is_retrograde` from (`calculations.py:358-370`). The station's sign is the Lahiri sidereal sign at that instant. Rahu/Ketu get no stations (the mean node never stations; the spec lists Jupiter, Saturn, Mars).
4. **Schema:** a new `StationDirection` enum (`retrograde` | `direct`) and two optional `TimelineEvent` fields, `station_direction` and `station_sign` (default `None`). Station descriptor `<graha>.station.<retrograde|direct>`. Stations and the new ingresses are `severity: neutral`, like today's ingresses.
5. **No new return events.** The spec's Inc B lists ingresses and stations only. `slow_hits` already carries the Saturn return.
6. **The Life Atlas does not change.** Domain windows (`domains/windows.py`) keep the pre-Inc-B event set: Jupiter/Saturn ingresses, dasha changes, Sade Sati phases. No Mars/node ingresses, no stations. `domains_golden_de421.json` must stay byte-identical. Letting them in is a product decision for later, not a side effect of this PR.
7. **Surfaces that render the engine timeline verbatim show the fuller 12-month timeline:** Sky & Timing (`TransitsPanel`), the web report, the PDF report. Stations get real copy in en/es/pt ("Saturn turns retrograde in Pisces"). The PDF artifact gate is re-run.
8. **Window on the wire:** the engine accepts a whole number of months 1..24, default 12. The worker reads `windowMonths`, the CPython edge entry reads `window_months`; absent means 12. The app only ever sends `24`, and only when the engine's 12-month window ends before the period's last day does; otherwise it omits the key, so the Life Atlas request key, the persisted predictive store key and the engine memo key are all unchanged for 12 months.
9. **The timeline cutoff compares instants, not days.** Inc A compared `window_end`'s day with the period's last day, which silently drops events after 06:00 UTC on 31 December for a leap calendar year (2028: 12 × 30.4375 = 365.25 days < 366). Rule 8 now asks for 24 months there, and the cutoff note fires whenever the window ends before the period's last day ends, naming the exact UTC time. Window ends are derived from the model's own `start`, never from birth data, so the time of day is not a privacy leak.
10. **Device tiers unchanged:** `lite` and `minimal` still answer every period with dashas only (`periodSkyComputeAllowed: false`, Inc A); `full` keeps a 5-entry period pool. The measured payload growth (Task 5) is the evidence; if it breaks the budget, stop and report instead of raising it.
11. **Parity is proven in a real browser, in CI.** Today the CI parity gate (`apps/web/scripts/verify-browser-parity.mjs`) checks only the natal chart; the predictive parity harness (`packages/browser/integration/parity.mjs`) needs a local `/private/tmp/almamesh-spike` that does not exist on this machine or in CI. The claim "CPython/Pyodide parity" for Inc B is therefore made true by extending the CI browser gate to the predictive golden, including a new two-year case keyed `"<iso>@24m"`. `parity.mjs` is updated too, so the two harnesses stay in step.

## Spec gaps found

- The spec does not say whether the Life Atlas, Sky & Timing and the report should consume the wider timeline (Rulings 6 and 7).
- It does not say how retrograde sign changes are reported. The existing Jupiter/Saturn sticking rule can show "Jupiter enters Gemini" twice with no exit in between; this plan leaves that alone (Ruling 1) and flags it.
- `build_timeline` takes `ayanamsa_type` and `node_type` and ignores them (pre-existing). Harmless today because the predictive entry never passes non-defaults; flagged, not fixed.
- "Claim: CPython/Pyodide parity" was not enforced in CI for the predictive payload (Ruling 11).
- Inc A's 12-month cutoff had the leap-year gap in Ruling 9.

## Global Constraints

- Work in a fresh worktree off `main` (at or after `2cc59889`, step A merged): `git -C /Users/harish/dev/oss/almamesh worktree add .worktrees/time-travel-inc-b -b claude/time-travel-inc-b origin/main`. All paths below are relative to that worktree.
- Stage named files only. Never `git add -A` or `git add .`. `docs/superpowers` is gitignored: plan or spec files need `git add -f`.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
  ```
- **One PR at the end** (Task 10). Tasks commit to the branch; nothing is pushed for review before Task 10.
- **Step A privacy rules stay intact, unchanged:** refuse only a period that ends before 1 January of the birth year (`endsBeforeBirthYear`), with the constant message; no sky (transits, domains, strength) for any period that starts in or before the birth year (`startsInOrBeforeBirthYear`, gated on the later of local and UTC birth year); nothing beyond today's egress (no new network calls, no new fields that carry birth data; dates inside results stay month precision through the `sanitize.ts` allowlist). This plan touches none of those functions; Task 8's tests re-run the existing ones.
- **Engine math lives in Python** (repo CLAUDE.md rule 2). The TS changes are types, an allowlist, copy, and calendar arithmetic on `YYYY-MM-DD` strings (window choice). No longitudes in TS.
- **Determinism** (rule 3): `window_months` is an explicit input. It is part of the engine memo key (canonical JSON of the input) and of `predictiveRequestKey` when present. Never a default that silently varies.
- **Low-end devices first:** device tiers `full` 5 / `lite` 3 / `minimal` 1 (`DevicePolicy.periodSkyCacheSize`); `lite` and `minimal` get dashas only. Any new engine output is measured: Task 5 pins payload byte budgets (`<= 72 KiB` at 12 months, `<= 88 KiB` at 24 months for the Delhi fixture; measured on `main` before this work: 59,102 bytes at 12 months) and records the Pyodide compute time and RSS for the 24-month case.
- **SQLite only for user data.** Nothing here stores user data. The period pool stays memory only.
- **Python edits follow `python-quality`:** functions ≤ 15 lines, Radon grade A (xenon must not gain a block), mypy strict, no `Dict[str, Any]`, no `TypedDict`, raise don't swallow. Invoke the `python-quality` skill after every Python task. TS edits: invoke `frontend-quality` after every TS task.
- **TDD with red runs.** Write the test, run it, see it fail for the stated reason, then implement. Every guard also gets a **mutation red run** with the helper below; paste each `KILLED` line into the PR's mutation table.
- Commands:
  - Backend single test: `cd backend && uv run pytest tests/<file>.py -q --no-cov` (the coverage floor lives in `addopts`; a single-file run without `--no-cov` fails on coverage, not on the test). Backend gate: `cd backend && uv run poe gate`.
  - Package unit tests: `cd frontend/packages/<pkg> && bunx vitest run <file>`; web unit: `cd frontend/apps/web && bunx vitest run <file>`; frontend gate: `cd frontend && bun run gate`.
  - Contract tests: `bun test ./tests/*.test.ts` from the repo root (`bun:test`, not Vitest).
- Golden regeneration: `cd backend && uv run python -m tests.test_transit_golden` (transit golden) and `cd backend && uv run python -m tests.fixtures.regen_predictive_golden` (predictive golden). Never hand-edit a golden.

Save the mutation helper once as `"${TMPDIR:-/tmp}/almamesh-mutate.py"` and `export MUTATE="${TMPDIR:-/tmp}/almamesh-mutate.py"` (same helper as Inc A):

```python
#!/usr/bin/env python3
"""Apply one exact-text mutation, run a test command, restore the file.

Usage: python3 mutate.py FILE OLD NEW -- CMD [ARGS...]
Exit 0 only when OLD occurred exactly once, the file really changed, and CMD failed.
"""
import pathlib
import subprocess
import sys


def main() -> int:
    sep = sys.argv.index("--")
    path, old, new = sys.argv[1:sep]
    command = sys.argv[sep + 1 :]
    target = pathlib.Path(path)
    original = target.read_text()
    hits = original.count(old)
    if hits != 1:
        print(f"MUTATION NOT APPLIED: {old!r} occurs {hits} times in {path}")
        return 2
    target.write_text(original.replace(old, new, 1))
    try:
        if target.read_text() == original:
            print("MUTATION NOT APPLIED: file unchanged")
            return 2
        code = subprocess.run(command).returncode
    finally:
        target.write_text(original)
    print(f"mutated run exit code: {code}")
    if code == 0:
        print(f"SURVIVED: {path}: {old!r} -> {new!r}")
        return 1
    print(f"KILLED: {path}: {old!r} -> {new!r}")
    return 0


sys.exit(main())
```

Run mutations from the worktree root with paths relative to it, for example:
`python3 "$MUTATE" backend/src/x.py 'old' 'new' -- bash -c 'cd backend && uv run pytest tests/test_x.py -q --no-cov'`.

## Review Focus

1. **Mars going backward across a cusp.** In 2027 Mars leaves Leo for Cancer in early March and re-enters Leo in late April. Both changes must appear, in order, with real `from_sign`/`to_sign`. Never two "enters Leo" lines with no exit between them. Test: Task 3.
2. **A leap calendar year asked as "2028".** The 12-month window ends 2028-12-31 06:00 UTC. The app must ask for 24 months, and if a window ever ends inside the last day, the note must say so. Events on 31 December must not vanish without a word. Tests: Task 7 (`periodWindowMonths`), Task 8 (cutoff by instant).
3. **Rahu and Ketu change sign at the same instant.** The order is deterministic (Rahu first), the signs are opposite, and the two rows render as two rows with distinct React keys (no duplicate-key console error). Tests: Task 3, Task 6.
4. **A predictive payload persisted by an older build** (no `station_direction`/`station_sign` keys) must still reshape, render and sanitize, with the fields read as `null`. Tests: Task 6.
5. **The Life Atlas must not move.** Domain windows ignore the new events (domains golden byte-identical), the 12-month request key is the same literal string as before, and a 24-month request never answers from the Life Atlas slot. Tests: Task 4, Task 7.

---

## Controller amendments (2026-10-09, approved by Harish; these override Rulings 1 and 6 and the "Spec gaps" / "Known gaps" lines where they conflict)

- **A1 (overrides Ruling 1's Jupiter/Saturn clause and part of Ruling 6).** The timeline must never show two consecutive ingresses into the same sign for one planet. Jupiter and Saturn move from the sticking-ingress rule to the same every-crossing producer as Mars (`sign_change_events`, real `from_sign` → `to_sign`). One rule for every planet that ingresses; alternation holds by construction (each event's `from_sign` is the previous event's `to_sign`). `feeds_domain_windows` keeps accepting Jupiter/Saturn `sign_ingress` events in both directions, so if a golden fixture spans a Jupiter/Saturn retrograde cusp crossing the Life Atlas golden changes; the change is produced by regeneration only, diffed, and explained event by event in the PR. Implemented in **Task 4A** (after Task 4). Later tasks' copy that says "Jupiter/Saturn sticking ingresses" reads "every Jupiter, Saturn, Mars and Rahu/Ketu sign change".
- **A2 (resolves the `build_timeline` ayanamsa/node gap).** No production caller passes non-default `ayanamsa_type`/`node_type` (only `calculate_transit_context` forwards its own defaults; `predictive.py` passes neither). The timeline producers are Lahiri + mean node by construction. Remove the two parameters from `build_timeline` and stop forwarding them from `calculate_transit_context`, with a test that pins the signature and a docstring line saying the timeline is Lahiri + mean node. Implemented in **Task 4A**.
- **A3 (keeps Ruling 9).** The leap-year cutoff fix stays in Tasks 7 and 8, each with its red-first regression test run before the fix (`periodWindowMonths` 2028 case; `restrictTransitsToPeriod` 2028-12-31 06:00 UTC note).
- **Branch/worktree.** Work in `/Users/harish/dev/oss/almamesh/.worktrees/time-travel-b-plan` on branch `claude/time-travel-b` (not `.worktrees/time-travel-inc-b`). Task 10 pushes `claude/time-travel-b`, opens ONE PR titled "feat(engine): time travel step B — stations, every sign change, two-year window", and does NOT merge.

- **Preflight rulings (controller, after the conflict scan):**
  - P1 4A repoints test_should_reuse_ephemeris_samples_across_ingress_cusps to sign_change_events (same assertions) and deletes dead _entered_sign/_ingress_event — keeps the sample-reuse guard alive — if wrong: lose a perf guard on the old producer only.
  - P2 4A regenerates domains golden with `uv run python -m tests.fixtures.regen_domains_golden` — it is the only regen path — if wrong: none (regen is deterministic).
  - P3 4A explains every changed window in BOTH domains golden and predictive golden domains_context — the PR must justify any Life Atlas move — if wrong: extra PR text only.
  - P4 Task 6 CHECK 7 compares the four engine keys explicitly (not strip-one-key) — computePredictive also returns domain_strength_assays and strength_signer_public_key — if wrong: CHECK 7 compares too little; reviewer would catch.
  - P5/P6 4A rewords timeline_sign_changes.py docstring, windows.py comment and scope-test docstring, and adds a backward Jupiter ingress row expecting True — keep A1 coherent — if wrong: doc drift only.
  - P7 Task 8 COVERED_EVENTS comment says "every Jupiter, Saturn, Mars and Rahu/Ketu sign change" — per A1.
  - P8 Task 10 uses claude/time-travel-b, title "feat(engine): time travel step B — stations, every sign change, two-year window", no merge/cleanup — user instruction overrides plan.
  - P9 Task 10 PR prints Rulings with A1-A3 applied (1 and 6 marked amended), drops the two Known-gaps items, Life Atlas claim restated as "changes only where a Jupiter/Saturn retrograde crossing is real, explained"; Review Focus 5 reworded likewise.
  - P10 Task 9 e2e asserts real descriptors (mars.ingress.*, mars.station.*) not the covered_events constant; no Rahu assertion unless a Rahu change falls in 2027-01..2028-06 — constant-asserting test proves nothing — if wrong: weaker e2e.
  - P11 Task 7 exports one helper from period.ts for "window end vs end of period's last day" (reuse period.ts MS_PER_DAY); Task 8 imports it — no duplicate rule — if wrong: minor coupling.
  - P12 24-month max stays; a 731-day period (2027-01-01..2028-12-31) gets the cutoff note, pinned by a Task 8 test — honest disclosure beats widening the cap — if wrong: last 12h of a leap two-year question uncovered but disclosed.
  - P13 Task 2 Step 6 golden-diff check judged by exit code (git diff --exit-code) — carried into Task 2 review.

### Task 1: Rahu/Ketu longitude fast path (same bytes, no nine-graha recompute)

The sign-change scan (Task 3) samples Rahu's longitude every 5 days and bisects. Today `transit_longitude` serves the nodes through the full `get_planetary_positions` (14 apparent observations per call). This task gives the nodes the same arithmetic without the other planets.

**Files:**
- Modify: `backend/src/almamesh/transits/positions.py`
- Create: `backend/tests/test_node_longitude_fast_path.py`

**Interfaces:**
- Consumes: `SkyfieldAstronomy.ts`, `SkyfieldAstronomy._node_tropical(t, node_type)` (`calculations.py:421`), `_resolve_ayanamsa`, `_to_utc`.
- Produces: `transit_longitude(astro, graha, when, ayanamsa_type=LAHIRI, node_type=MEAN) -> float` unchanged in signature and bytes; Rahu/Ketu no longer call `get_planetary_positions`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_node_longitude_fast_path.py`:

```python
"""Rahu/Ketu longitudes: byte-identical to the position dict, without computing all nine grahas."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.calculations import AyanamsaType, NodeType, SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName
from almamesh.transits.positions import transit_longitude, transit_positions

_INSTANTS = (
    datetime(1990, 1, 15, 12, tzinfo=UTC),
    datetime(2026, 12, 3, tzinfo=UTC),
    datetime(2052, 12, 31, 23, tzinfo=UTC),
)


@pytest.mark.parametrize("node_type", [NodeType.MEAN, NodeType.TRUE])
@pytest.mark.parametrize("graha", [PlanetName.RAHU, PlanetName.KETU])
def test_node_longitude_matches_the_position_dict_exactly(
    graha: PlanetName, node_type: NodeType
) -> None:
    # Given the full nine-graha position dict as the oracle
    astro = SkyfieldAstronomy()
    for when in _INSTANTS:
        oracle = transit_positions(astro, when, AyanamsaType.LAHIRI, node_type)[graha]
        # When the scalar probe asks for one node / Then it is the same float, bit for bit
        assert transit_longitude(astro, graha, when, AyanamsaType.LAHIRI, node_type) == oracle["longitude"]


def test_node_longitude_does_not_compute_every_graha(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given an engine whose full position dict refuses to run
    astro = SkyfieldAstronomy()

    def refuse(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("a node longitude must not compute all nine grahas")

    monkeypatch.setattr(astro, "get_planetary_positions", refuse)
    # When Rahu and Ketu are probed / Then both answer without it
    for graha in (PlanetName.RAHU, PlanetName.KETU):
        assert 0.0 <= transit_longitude(astro, graha, _INSTANTS[1]) < 360.0
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

Run: `cd backend && uv run pytest tests/test_node_longitude_fast_path.py -q --no-cov`
Expected: the parity test PASSES (it characterizes today's bytes); `test_node_longitude_does_not_compute_every_graha` FAILS with `AssertionError: a node longitude must not compute all nine grahas`.

- [ ] **Step 3: Implement the fast path**

In `backend/src/almamesh/transits/positions.py`: move `PlanetName` out of the `TYPE_CHECKING` block into a runtime import (`from almamesh.constants.astrology import PlanetName`), then add above `transit_longitude`:

```python
def _node_longitude(
    astro: SkyfieldAstronomy,
    graha: PlanetName,
    dt_utc: datetime,
    ayanamsa: float,
    node_type: NodeType,
) -> float:
    """Rahu/Ketu sidereal longitude: `_get_lunar_node_positions`' arithmetic, nodes only."""
    rahu_tropical = astro._node_tropical(astro.ts.from_datetime(dt_utc), node_type)
    tropical = rahu_tropical if graha is PlanetName.RAHU else (rahu_tropical + 180) % 360
    return (tropical - ayanamsa) % 360
```

and replace the last line of `transit_longitude` (the `get_planetary_positions` fallback) so the body ends:

```python
    if graha in astro._STANDARD_TARGETS:
        return astro.graha_sidereal_longitude(graha, dt_utc, ayanamsa)
    return _node_longitude(astro, graha, dt_utc, ayanamsa, node_type)
```

Update its docstring's second paragraph to: "Standard grahas take the single-graha fast path; Rahu/Ketu take the node-only path (no other planets). Byte-identical to `transit_positions(...)[graha]['longitude']` either way." The integer literals `180` and `360` must stay integers: they are what `_get_lunar_node_positions` uses, and the parity test checks bits. `datetime` is only a type here; keep it under `TYPE_CHECKING`.

- [ ] **Step 4: Run it and see it pass**

Run: `cd backend && uv run pytest tests/test_node_longitude_fast_path.py tests/test_transit_positions.py tests/test_transit_golden.py tests/test_predictive_golden.py -q --no-cov`
Expected: all PASS (goldens unchanged: the bytes did not move).

- [ ] **Step 5: Mutation red run**

```bash
python3 "$MUTATE" backend/src/almamesh/transits/positions.py \
  'else (rahu_tropical + 180) % 360' 'else rahu_tropical' \
  -- bash -c 'cd backend && uv run pytest tests/test_node_longitude_fast_path.py -q --no-cov'
```
Expected: `KILLED`.

- [ ] **Step 6: Quality and commit**

Invoke `python-quality` on `positions.py` and the new test. Then:

```bash
git add backend/src/almamesh/transits/positions.py backend/tests/test_node_longitude_fast_path.py
git commit -m "perf(engine): node longitudes skip the nine-graha position dict

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 2: Station events for Jupiter, Saturn and Mars

**Files:**
- Modify: `backend/src/almamesh/schemas/transits.py`
- Create: `backend/src/almamesh/transits/timeline_stations.py`
- Create: `backend/tests/test_timeline_stations.py`
- Modify (regenerated, not hand-edited): `backend/tests/fixtures/transit_golden_de421.json`, `backend/tests/fixtures/predictive_golden_de421.json`

**Interfaces:**
- Consumes: `find_crossings(f, start, end, step_days)` (`transits/ingress.py`), `SkyfieldAstronomy.graha_sidereal_longitude(graha, dt_utc, ayanamsa)`, `transit_longitude`, `sign_index`.
- Produces:
  - `class StationDirection(StrEnum)`: `RETROGRADE = "retrograde"`, `DIRECT = "direct"` (in `schemas/transits.py`).
  - `TimelineEvent.station_direction: StationDirection | None = None`, `TimelineEvent.station_sign: ZodiacSign | None = None`.
  - `station_events(astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime) -> list[TimelineEvent]` (chronological).

Known values (computed on this branch's base with the same algorithm, Delhi-independent): over `2026-06-09T12:00Z + 730.5 days`, Saturn turns retrograde 2026-07-26 (Pisces), direct 2026-12-10 (Pisces), retrograde 2027-08-09 (Aries), direct 2027-12-23 (Pisces); Jupiter retrograde 2026-12-12 (Leo), direct 2027-04-12 (Cancer), retrograde 2028-01-11 (Virgo), direct 2028-05-13 (Leo); Mars retrograde 2027-01-10 (Leo), direct 2027-04-01 (Cancer).

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_timeline_stations.py`:

```python
"""Stations: the instant the engine's own retrograde flag flips, with the sign it happens in."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName
from almamesh.schemas.transits import StationDirection, TimelineEvent, TransitEventKind
from almamesh.transits.positions import transit_positions
from almamesh.transits.timeline_stations import station_events

_START = datetime(2026, 6, 9, 12, tzinfo=UTC)
_END = _START + timedelta(days=730.5)  # the 24-month engine window


@pytest.fixture(scope="module")
def astro() -> SkyfieldAstronomy:
    return SkyfieldAstronomy()


def _summary(events: list[TimelineEvent]) -> list[tuple[str, str | None, str | None]]:
    return [(e.date.date().isoformat(), e.station_direction, e.station_sign) for e in events]


def test_saturn_stations_over_two_years(astro: SkyfieldAstronomy) -> None:
    assert _summary(station_events(astro, PlanetName.SATURN, _START, _END)) == [
        ("2026-07-26", "retrograde", "Pisces"),
        ("2026-12-10", "direct", "Pisces"),
        ("2027-08-09", "retrograde", "Aries"),
        ("2027-12-23", "direct", "Pisces"),
    ]


def test_jupiter_stations_over_two_years(astro: SkyfieldAstronomy) -> None:
    assert _summary(station_events(astro, PlanetName.JUPITER, _START, _END)) == [
        ("2026-12-12", "retrograde", "Leo"),
        ("2027-04-12", "direct", "Cancer"),
        ("2028-01-11", "retrograde", "Virgo"),
        ("2028-05-13", "direct", "Leo"),
    ]


def test_mars_turns_retrograde_in_leo_and_direct_in_cancer(astro: SkyfieldAstronomy) -> None:
    assert _summary(station_events(astro, PlanetName.MARS, _START, _END)) == [
        ("2027-01-10", "retrograde", "Leo"),
        ("2027-04-01", "direct", "Cancer"),
    ]


@pytest.mark.parametrize("graha", [PlanetName.JUPITER, PlanetName.SATURN, PlanetName.MARS])
def test_a_station_is_where_the_engine_retrograde_flag_flips(
    astro: SkyfieldAstronomy, graha: PlanetName
) -> None:
    hour = timedelta(hours=1)
    for event in station_events(astro, graha, _START, _END):
        before = transit_positions(astro, event.date - hour)[graha]["is_retrograde"]
        after = transit_positions(astro, event.date + hour)[graha]["is_retrograde"]
        assert after is (event.station_direction == StationDirection.RETROGRADE.value)
        assert before is not after


def test_station_event_shape(astro: SkyfieldAstronomy) -> None:
    first = station_events(astro, PlanetName.SATURN, _START, _END)[0]
    assert first.kind == TransitEventKind.STATION.value
    assert first.graha == "saturn"
    assert first.descriptor == "saturn.station.retrograde"
    assert (first.from_sign, first.to_sign, first.severity) == (None, None, "neutral")
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend && uv run pytest tests/test_timeline_stations.py -q --no-cov`
Expected: collection ERROR, `ModuleNotFoundError: No module named 'almamesh.transits.timeline_stations'` (and `ImportError` for `StationDirection`).

- [ ] **Step 3: Schema fields**

In `backend/src/almamesh/schemas/transits.py`, after `TransitSeverity` add:

```python
class StationDirection(StrEnum):
    """Which way a graha turns at a station."""

    RETROGRADE = "retrograde"  # starts moving backward
    DIRECT = "direct"  # resumes forward motion
```

and in `TimelineEvent`, after `sade_sati_phase`, add:

```python
    station_direction: StationDirection | None = None  # station: which way it turns
    station_sign: ZodiacSign | None = None  # station: the sign it stations in
```

- [ ] **Step 4: The producer**

`backend/src/almamesh/transits/timeline_stations.py`:

```python
"""Retrograde and direct stations of Jupiter, Saturn and Mars for the timeline.

A station is the instant the engine's own `is_retrograde` flag flips: the
graha's one-day forward motion in tropical-of-date longitude (the `speed`
`get_planetary_positions` derives the flag from) crosses zero. The station's
sign is the Lahiri sidereal sign at that instant. The mean node never stations,
so Rahu/Ketu have none."""

from __future__ import annotations

from datetime import timedelta
from functools import cache
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.transits import (
    StationDirection,
    TimelineEvent,
    TransitEventKind,
    TransitSeverity,
)
from almamesh.transits.ingress import find_crossings
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

_STEP_DAYS: Final[float] = 5.0  # stations of these grahas are 60+ days apart
_ONE_DAY: Final[timedelta] = timedelta(days=1)
_HOUR: Final[timedelta] = timedelta(hours=1)


def _motion_fn(astro: SkyfieldAstronomy, graha: PlanetName) -> Callable[[datetime], float]:
    """Degrees moved over the next day, tropical of date (ayanamsa 0)."""

    @cache
    def tropical(when: datetime) -> float:
        return astro.graha_sidereal_longitude(graha, when, 0.0)

    return lambda when: (tropical(when + _ONE_DAY) - tropical(when) + 180.0) % 360.0 - 180.0


def _direction(motion: Callable[[datetime], float], when: datetime) -> StationDirection:
    """Retrograde when the graha moves backward just after the station."""
    return StationDirection.RETROGRADE if motion(when + _HOUR) < 0.0 else StationDirection.DIRECT


def _station_event(
    astro: SkyfieldAstronomy, graha: PlanetName, when: datetime, direction: StationDirection
) -> TimelineEvent:
    """One station event with a stable descriptor."""
    sign = ZodiacSign(ZODIAC_SIGNS[sign_index(transit_longitude(astro, graha, when))])
    return TimelineEvent(
        date=when,
        kind=TransitEventKind.STATION,
        graha=graha,
        station_direction=direction,
        station_sign=sign,
        severity=TransitSeverity.NEUTRAL,
        descriptor=f"{graha.value}.station.{direction.value}",
    )


def station_events(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Every station of `graha` within [start, end], chronological."""
    motion = _motion_fn(astro, graha)
    return [
        _station_event(astro, graha, when, _direction(motion, when))
        for when in find_crossings(motion, start, end, _STEP_DAYS)
    ]
```

- [ ] **Step 5: Run and see it pass**

Run: `cd backend && uv run pytest tests/test_timeline_stations.py -q --no-cov`
Expected: 7 passed.

- [ ] **Step 6: Regenerate the goldens for the two new null keys, and prove that is all that changed**

Every serialized `TimelineEvent` now carries `"station_direction": null, "station_sign": null`.

```bash
cd backend
uv run python -m tests.test_transit_golden
uv run python -m tests.fixtures.regen_predictive_golden
git diff -U0 tests/fixtures | grep '^[+-] ' | grep -v '"station_direction": null,' | grep -v '"station_sign": null,'; echo "unexpected golden lines above (must be none)"
uv run pytest tests/test_transit_golden.py tests/test_predictive_golden.py tests/test_domains_golden.py -q --no-cov
```
Expected: no lines printed before the echo; goldens pass; `domains_golden_de421.json` untouched (`git diff --exit-code tests/fixtures/domains_golden_de421.json` exits 0).

- [ ] **Step 7: Mutation red runs**

```bash
python3 "$MUTATE" backend/src/almamesh/transits/timeline_stations.py \
  'StationDirection.RETROGRADE if motion(when + _HOUR) < 0.0 else StationDirection.DIRECT' \
  'StationDirection.DIRECT if motion(when + _HOUR) < 0.0 else StationDirection.RETROGRADE' \
  -- bash -c 'cd backend && uv run pytest tests/test_timeline_stations.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/timeline_stations.py \
  '_ONE_DAY: Final[timedelta] = timedelta(days=1)' '_ONE_DAY: Final[timedelta] = timedelta(days=5)' \
  -- bash -c 'cd backend && uv run pytest tests/test_timeline_stations.py::test_a_station_is_where_the_engine_retrograde_flag_flips -q --no-cov'
```
Expected: both `KILLED` (the second shifts each station by about 2.5 days, so the ±1 h flag check goes red).

- [ ] **Step 8: Quality and commit**

Invoke `python-quality` on the new module and test. Then:

```bash
git add backend/src/almamesh/schemas/transits.py backend/src/almamesh/transits/timeline_stations.py \
  backend/tests/test_timeline_stations.py backend/tests/fixtures/transit_golden_de421.json \
  backend/tests/fixtures/predictive_golden_de421.json
git commit -m "feat(engine): station events for Jupiter, Saturn and Mars

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 3: Every sign change of Mars, and of Rahu with Ketu mirrored

**Files:**
- Modify: `backend/src/almamesh/transits/timeline_ingress.py` (rename two helpers to public names; behaviour unchanged)
- Create: `backend/src/almamesh/transits/timeline_sign_changes.py`
- Create: `backend/tests/test_timeline_sign_changes.py`

**Interfaces:**
- Consumes: `find_crossings` (`transits/ingress.py`), `sign_index`, Task 1's node fast path (through `transit_longitude`).
- Produces:
  - In `timeline_ingress.py`: `graha_lon_fn(astro, graha) -> Callable[[datetime], float]` (was `_graha_lon_fn`) and `cusp_gap(lon_fn, cusp) -> Callable[[datetime], float]` (was `_cusp_gap`).
  - `sign_change_events(astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime) -> list[TimelineEvent]` — every change, real direction, chronological.
  - `node_sign_change_events(astro: SkyfieldAstronomy, start: datetime, end: datetime) -> list[TimelineEvent]` — Rahu's changes followed by Ketu's mirrored ones (same instants, opposite signs).
  - Descriptor for both: `<graha>.ingress.<entered sign, lower case>`, `kind: sign_ingress`.

Known values over `2026-06-09T12:00Z + 730.5 days` (5-day scan brackets): Mars changes sign 15 times; in 2027 it goes Leo → Cancer between 6 and 11 March and Cancer → Leo between 25 and 30 April. Rahu goes Aquarius → Capricorn between 1 and 6 December 2026 (Ketu Leo → Cancer at the same instant), and nothing else.

- [ ] **Step 1: Rename the two helpers (pure refactor)**

In `timeline_ingress.py` rename `_graha_lon_fn` → `graha_lon_fn` and `_cusp_gap` → `cusp_gap`, and update their two call sites in `slow_graha_ingress_events`. Run `cd backend && uv run pytest tests/test_transit_timeline.py tests/test_ingress.py -q --no-cov`. Expected: PASS (the existing monkeypatch of `timeline_ingress.transit_longitude` still applies).

- [ ] **Step 2: Write the failing tests**

`backend/tests/test_timeline_sign_changes.py`:

```python
"""Mars and the nodes: every sign change, in its real direction; Ketu mirrors Rahu."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName
from almamesh.transits import timeline_ingress
from almamesh.transits.natal import sign_index
from almamesh.transits.positions import transit_longitude
from almamesh.transits.timeline_sign_changes import node_sign_change_events, sign_change_events

_START = datetime(2026, 6, 9, 12, tzinfo=UTC)
_END = _START + timedelta(days=730.5)
_HALF_DAY = timedelta(hours=12)


@pytest.fixture(scope="module")
def astro() -> SkyfieldAstronomy:
    return SkyfieldAstronomy()


def _sign(astro: SkyfieldAstronomy, graha: PlanetName, when: datetime) -> str:
    return ZODIAC_SIGNS[sign_index(transit_longitude(astro, graha, when))]


def test_mars_retrograde_exit_and_re_entry_both_show(astro: SkyfieldAstronomy) -> None:
    # Given the first half of 2027, when Mars retrogrades from Leo back into Cancer
    events = sign_change_events(
        astro, PlanetName.MARS, datetime(2027, 1, 1, tzinfo=UTC), datetime(2027, 6, 30, tzinfo=UTC)
    )
    # Then the exit and the re-entry both appear, in order, in their real direction
    assert [(e.from_sign, e.to_sign) for e in events] == [("Leo", "Cancer"), ("Cancer", "Leo")]
    assert [e.descriptor for e in events] == ["mars.ingress.cancer", "mars.ingress.leo"]
    assert date(2027, 3, 6) <= events[0].date.date() <= date(2027, 3, 11)
    assert date(2027, 4, 25) <= events[1].date.date() <= date(2027, 4, 30)


def test_every_mars_change_is_real_and_chronological(astro: SkyfieldAstronomy) -> None:
    events = sign_change_events(astro, PlanetName.MARS, _START, _END)
    assert len(events) == 15
    assert [e.date for e in events] == sorted(e.date for e in events)
    for event in events:
        assert _sign(astro, PlanetName.MARS, event.date - _HALF_DAY) == event.from_sign
        assert _sign(astro, PlanetName.MARS, event.date + _HALF_DAY) == event.to_sign


def test_rahu_and_ketu_change_sign_together_in_opposite_signs(astro: SkyfieldAstronomy) -> None:
    events = node_sign_change_events(astro, _START, _END)
    assert [(e.graha, e.from_sign, e.to_sign) for e in events] == [
        ("rahu", "Aquarius", "Capricorn"),
        ("ketu", "Leo", "Cancer"),
    ]
    assert events[0].date == events[1].date
    assert date(2026, 12, 1) <= events[0].date.date() <= date(2026, 12, 6)
    assert [e.descriptor for e in events] == ["rahu.ingress.capricorn", "ketu.ingress.cancer"]
    assert _sign(astro, PlanetName.KETU, events[1].date + _HALF_DAY) == "Cancer"


def test_a_jump_over_two_signs_is_not_invented_as_one_crossing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given a longitude that jumps from Aries to Gemini inside one coarse step
    start = datetime(2026, 1, 1, tzinfo=UTC)

    def longitude(_astro: object, _graha: object, when: datetime, *_args: object) -> float:
        return 5.0 if when == start else 65.0

    monkeypatch.setattr(timeline_ingress, "transit_longitude", longitude)
    # When scanned / Then nothing is reported (no single cusp explains it)
    events = sign_change_events(object(), PlanetName.MARS, start, start + timedelta(days=5))  # type: ignore[arg-type]
    assert events == []
```

- [ ] **Step 3: Run and watch it fail**

Run: `cd backend && uv run pytest tests/test_timeline_sign_changes.py -q --no-cov`
Expected: collection ERROR, `ModuleNotFoundError: No module named 'almamesh.transits.timeline_sign_changes'`.

- [ ] **Step 4: The producer**

`backend/src/almamesh/transits/timeline_sign_changes.py`:

```python
"""Every sign change of Mars and of the lunar nodes, in its real direction.

Jupiter and Saturn keep the sticking-ingress rule (timeline_ingress.py). Mars
retrogrades back across cusps and the nodes always move backward, so for them
every cusp crossing is an event with the real from_sign -> to_sign. Ketu is
Rahu + 180 deg: its events are Rahu's, mirrored, at the same instant."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Final

from almamesh.constants.astrology import ZODIAC_SIGNS, PlanetName, ZodiacSign
from almamesh.schemas.transits import TimelineEvent, TransitEventKind, TransitSeverity
from almamesh.transits.ingress import find_crossings
from almamesh.transits.natal import sign_index
from almamesh.transits.timeline_ingress import cusp_gap, graha_lon_fn

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from datetime import datetime

    from almamesh.calculations import SkyfieldAstronomy

_STEP_DAYS: Final[float] = 5.0  # Mars moves under 1 deg/day: one change per step at most
_SIGN_WIDTH: Final[float] = 30.0


def _steps(start: datetime, end: datetime) -> Iterator[tuple[datetime, datetime]]:
    """Adjacent coarse samples covering [start, end]."""
    step = timedelta(days=_STEP_DAYS)
    lo = start
    while lo < end:
        hi = min(lo + step, end)
        yield lo, hi
        lo = hi


def _cusp_between(from_idx: int, to_idx: int) -> float | None:
    """The cusp two adjacent signs share, whichever way the graha moved; else None."""
    if to_idx == (from_idx + 1) % 12:
        return to_idx * _SIGN_WIDTH
    if from_idx == (to_idx + 1) % 12:
        return from_idx * _SIGN_WIDTH
    return None


def _event(graha: PlanetName, when: datetime, from_idx: int, to_idx: int) -> TimelineEvent:
    """One sign-change event with a stable `<graha>.ingress.<sign>` descriptor."""
    entered = ZodiacSign(ZODIAC_SIGNS[to_idx])
    return TimelineEvent(
        date=when,
        kind=TransitEventKind.SIGN_INGRESS,
        graha=graha,
        from_sign=ZodiacSign(ZODIAC_SIGNS[from_idx]),
        to_sign=entered,
        severity=TransitSeverity.NEUTRAL,
        descriptor=f"{graha.value}.ingress.{entered.value.lower()}",
    )


def _changes_in(
    lon_fn: Callable[[datetime], float], graha: PlanetName, lo: datetime, hi: datetime
) -> list[TimelineEvent]:
    """The sign change inside one coarse step, refined to the cusp instant."""
    from_idx, to_idx = sign_index(lon_fn(lo)), sign_index(lon_fn(hi))
    cusp = None if from_idx == to_idx else _cusp_between(from_idx, to_idx)
    if cusp is None:
        return []
    crossings = find_crossings(cusp_gap(lon_fn, cusp), lo, hi, _STEP_DAYS)
    return [_event(graha, when, from_idx, to_idx) for when in crossings]


def sign_change_events(
    astro: SkyfieldAstronomy, graha: PlanetName, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Every sign change of `graha` in [start, end], chronological."""
    lon_fn = graha_lon_fn(astro, graha)
    events: list[TimelineEvent] = []
    for lo, hi in _steps(start, end):
        events += _changes_in(lon_fn, graha, lo, hi)
    return events


def _opposite(sign: str | None) -> int:
    """The sign index six signs away (Ketu's sign for a Rahu sign)."""
    return (ZODIAC_SIGNS.index(str(sign)) + 6) % 12


def node_sign_change_events(
    astro: SkyfieldAstronomy, start: datetime, end: datetime
) -> list[TimelineEvent]:
    """Rahu's sign changes, then Ketu's mirror of each (same instant)."""
    rahu = sign_change_events(astro, PlanetName.RAHU, start, end)
    ketu = [_event(PlanetName.KETU, e.date, _opposite(e.from_sign), _opposite(e.to_sign)) for e in rahu]
    return rahu + ketu
```

- [ ] **Step 5: Run and see it pass**

Run: `cd backend && uv run pytest tests/test_timeline_sign_changes.py tests/test_transit_timeline.py -q --no-cov`
Expected: all PASS. If `test_every_mars_change_is_real_and_chronological` reports a count other than 15, stop: the count was taken from the same 5-day scan, so a different number means the scan differs from the plan's assumptions; report it, do not edit the number.

- [ ] **Step 6: Mutation red runs**

```bash
python3 "$MUTATE" backend/src/almamesh/transits/timeline_sign_changes.py \
  '    if from_idx == (to_idx + 1) % 12:
        return from_idx * _SIGN_WIDTH
' '' -- bash -c 'cd backend && uv run pytest tests/test_timeline_sign_changes.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/timeline_sign_changes.py \
  'ZODIAC_SIGNS.index(str(sign)) + 6' 'ZODIAC_SIGNS.index(str(sign)) + 0' \
  -- bash -c 'cd backend && uv run pytest tests/test_timeline_sign_changes.py -q --no-cov'
```
Expected: both `KILLED` (the first drops every backward change: Rahu's and Mars's March exit; the second gives Ketu Rahu's signs).

- [ ] **Step 7: Quality and commit**

Invoke `python-quality`. Then:

```bash
git add backend/src/almamesh/transits/timeline_ingress.py backend/src/almamesh/transits/timeline_sign_changes.py \
  backend/tests/test_timeline_sign_changes.py
git commit -m "feat(engine): every sign change of Mars and the nodes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 4: Wire the new events into the timeline; keep the Life Atlas where it is

**Files:**
- Modify: `backend/src/almamesh/transits/timeline.py`
- Modify: `backend/src/almamesh/domains/windows.py`
- Modify: `backend/tests/test_transit_timeline.py`
- Create: `backend/tests/test_domain_windows_scope.py`
- Modify (regenerated): `backend/tests/fixtures/transit_golden_de421.json`, `backend/tests/fixtures/predictive_golden_de421.json`

**Interfaces:**
- Consumes: `station_events` (Task 2), `sign_change_events`, `node_sign_change_events` (Task 3).
- Produces: `build_timeline(...)` unchanged in signature; its events now include Mars/Rahu/Ketu `sign_ingress` and Jupiter/Saturn/Mars `station`. `feeds_domain_windows(event: TimelineEvent) -> bool` in `domains/windows.py`.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_transit_timeline.py`, the assertion block in `test_should_sort_events_and_keep_them_in_window` that says "only the slow grahas (Jupiter/Saturn) ingress" asserts the pre-Inc-B contract. **Invert it, do not delete it** (call this out in the PR as a reversed contract):

```python
    # And no fast-graha noise: only slow grahas ingress (Inc B adds Mars and the nodes)
    for e in timeline.events:
        if e.kind == TransitEventKind.SIGN_INGRESS.value and e.graha is not None:
            assert e.graha in {"jupiter", "saturn", "mars", "rahu", "ketu"}
```

Append:

```python
_TWO_YEAR_START = datetime(2026, 6, 9, 12, 0, 0, tzinfo=UTC)


def test_two_year_timeline_covers_mars_nodes_and_stations() -> None:
    # Given a 24-month window from the golden's reference instant
    natal = calculate_sidereal_context(_BIRTH, *_DELHI, reference_date=_TWO_YEAR_START)
    timeline = build_timeline(SkyfieldAstronomy(), natal, _BIRTH, _TWO_YEAR_START, window_months=24)
    # Then every Inc B producer is present, and no fast graha appears
    kinds = {(e.graha, e.kind) for e in timeline.events if e.graha is not None}
    assert {
        ("mars", "sign_ingress"),
        ("rahu", "sign_ingress"),
        ("ketu", "sign_ingress"),
        ("jupiter", "station"),
        ("saturn", "station"),
        ("mars", "station"),
    } <= kinds
    assert not {graha for graha, _ in kinds} & {"sun", "moon", "mercury", "venus"}
    dates = [e.date for e in timeline.events]
    assert dates == sorted(dates)
```

`backend/tests/test_domain_windows_scope.py`:

```python
"""Life Atlas domain windows keep the pre-Inc-B event set (Ruling 6)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from almamesh.domains.windows import feeds_domain_windows
from almamesh.schemas.transits import TimelineEvent


@pytest.mark.parametrize(
    ("graha", "kind", "expected"),
    [
        ("jupiter", "sign_ingress", True),
        ("saturn", "sign_ingress", True),
        ("mars", "sign_ingress", False),
        ("rahu", "sign_ingress", False),
        ("ketu", "sign_ingress", False),
        ("saturn", "station", False),
        ("mars", "station", False),
        (None, "dasha_change", True),
        (None, "sade_sati_phase", True),
    ],
)
def test_domain_windows_keep_the_pre_inc_b_event_set(
    graha: str | None, kind: str, expected: bool
) -> None:
    event = TimelineEvent.model_validate(
        {
            "date": datetime(2027, 1, 1, tzinfo=UTC),
            "kind": kind,
            "graha": graha,
            "severity": "neutral",
            "descriptor": "test.event",
        }
    )
    assert feeds_domain_windows(event) is expected
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend && uv run pytest tests/test_transit_timeline.py tests/test_domain_windows_scope.py -q --no-cov`
Expected: `test_two_year_timeline_covers_mars_nodes_and_stations` FAILS (the set is missing Mars/node/station pairs); `test_domain_windows_scope.py` ERRORS with `ImportError: cannot import name 'feeds_domain_windows'`.

- [ ] **Step 3: Wire the timeline**

In `backend/src/almamesh/transits/timeline.py`: import `station_events` and `node_sign_change_events, sign_change_events`; replace `_SLOW_GRAHAS` with

```python
_STICKING_INGRESS_GRAHAS = (PlanetName.JUPITER, PlanetName.SATURN)
_STATION_GRAHAS = (PlanetName.JUPITER, PlanetName.SATURN, PlanetName.MARS)
```

and `_collect`'s body with

```python
    events: list[TimelineEvent] = []
    for graha in _STICKING_INGRESS_GRAHAS:
        events += slow_graha_ingress_events(astro, graha, start, end)
    events += sign_change_events(astro, PlanetName.MARS, start, end)
    events += node_sign_change_events(astro, start, end)
    for graha in _STATION_GRAHAS:
        events += station_events(astro, graha, start, end)
    events += dasha_change_events(natal, birth_dt, start, end)
    events += sade_sati_phase_events(astro, natal_moon_index(natal), start, end)
    return events
```

Rewrite the module docstring's first paragraph: "Forward timeline of dated, structured, prose-free events. Jupiter/Saturn sticking sign ingresses; every Mars and Rahu/Ketu sign change; Jupiter/Saturn/Mars retrograde and direct stations; Vimshottari maha/antar handovers; Sade Sati phase boundaries. The Sun, Moon, Mercury and Venus move too fast to be signal over a period." The sort stays `events.sort(key=lambda e: e.date)`: it is stable, so Rahu precedes Ketu at their shared instant.

- [ ] **Step 4: Keep the domain windows where they were**

In `backend/src/almamesh/domains/windows.py` add (with `from typing import Final` if not imported):

```python
# Inc B widened the timeline (Mars and node ingresses, stations). Life Atlas
# windows keep the earlier event set until that is a product decision.
_DOMAIN_INGRESS_GRAHAS: Final[frozenset[PlanetName]] = frozenset(
    {PlanetName.JUPITER, PlanetName.SATURN}
)


def feeds_domain_windows(event: TimelineEvent) -> bool:
    """True for the timeline events Life Atlas windows are built from."""
    kind = TransitEventKind(event.kind)
    if kind is TransitEventKind.STATION:
        return False
    if kind is TransitEventKind.SIGN_INGRESS:
        return event.graha is not None and PlanetName(event.graha) in _DOMAIN_INGRESS_GRAHAS
    return True
```

`TimelineEvent` is imported only under `TYPE_CHECKING` in this module today; that is still enough (annotations are postponed). In `upcoming_windows`, change the loop header to `for event in filter(feeds_domain_windows, transits.timeline.events):`. Add a line to the module docstring's relevance list: "- Mars/Rahu/Ketu ingresses and stations (Inc B): not used, by decision."

- [ ] **Step 5: Run, regenerate, and prove the Life Atlas did not move**

```bash
cd backend
uv run pytest tests/test_transit_timeline.py tests/test_domain_windows_scope.py -q --no-cov
uv run python -m tests.test_transit_golden
uv run python -m tests.fixtures.regen_predictive_golden
git diff --exit-code tests/fixtures/domains_golden_de421.json && echo "domains golden unchanged"
uv run python - <<'EOF'
import json, subprocess
old = json.loads(subprocess.run(
    ["git", "show", "HEAD:backend/tests/fixtures/predictive_golden_de421.json"],
    capture_output=True, text=True, check=True).stdout)
new = json.load(open("tests/fixtures/predictive_golden_de421.json"))
for iso in old:
    for key in ("varga_context_full", "strength_context", "domains_context"):
        assert old[iso][key] == new[iso][key], (iso, key)
print("only transit_context changed")
EOF
uv run pytest -q --no-cov
```
Expected: the two focused files pass; `domains golden unchanged`; `only transit_context changed`; the whole suite passes. If anything outside `transit_context` moved, stop and report.

- [ ] **Step 6: Mutation red runs**

```bash
python3 "$MUTATE" backend/src/almamesh/domains/windows.py \
  'for event in filter(feeds_domain_windows, transits.timeline.events):' \
  'for event in transits.timeline.events:' \
  -- bash -c 'cd backend && uv run pytest tests/test_domains_golden.py tests/test_predictive_golden.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/timeline.py \
  '    events += node_sign_change_events(astro, start, end)
' '' -- bash -c 'cd backend && uv run pytest tests/test_transit_timeline.py -q --no-cov'
```
Expected: both `KILLED`. The first proves the existing goldens guard the Life Atlas (the scope test alone would not catch a bypassed filter).

- [ ] **Step 7: Frontend tests that read the regenerated goldens**

`grep -rl "transit_golden_de421\|predictive_golden_de421" frontend --include='*.ts'` lists them (at least `packages/store/src/adapters/predictive.test.ts`). Run each with Vitest from its package. Expected: PASS (they read fields that did not change shape). A failure here is a finding: report it rather than patching the test.

- [ ] **Step 8: Quality and commit**

Invoke `python-quality`. Then:

```bash
git add backend/src/almamesh/transits/timeline.py backend/src/almamesh/domains/windows.py \
  backend/tests/test_transit_timeline.py backend/tests/test_domain_windows_scope.py \
  backend/tests/fixtures/transit_golden_de421.json backend/tests/fixtures/predictive_golden_de421.json
git commit -m "feat(engine): timeline reports Mars and node sign changes and stations

Life Atlas domain windows keep the earlier event set (domains golden unchanged).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 4A: Jupiter and Saturn report every sign change; `build_timeline` drops the ignored ayanamsa/node arguments

**Files:**
- Modify: `backend/src/almamesh/transits/timeline.py`, `backend/src/almamesh/transits/__init__.py`
- Modify: `backend/src/almamesh/transits/timeline_ingress.py` (delete `slow_graha_ingress_events` and `_STICK_DAYS` if nothing else uses them; keep `graha_lon_fn`/`cusp_gap` used by Task 3)
- Modify: `backend/tests/test_transit_timeline.py` (and any test that asserted sticking-only behaviour: invert, never delete)
- Modify (regenerated only): `backend/tests/fixtures/transit_golden_de421.json`, `backend/tests/fixtures/predictive_golden_de421.json`, and `backend/tests/fixtures/domains_golden_de421.json` only if regeneration changes it

**Interfaces:**
- Consumes: `sign_change_events(astro, graha, start, end)` from Task 3.
- Produces: `build_timeline(astro, natal, birth_dt, start, window_months=12)` (no ayanamsa/node parameters); timeline `sign_ingress` events for Jupiter, Saturn, Mars, Rahu, Ketu are all every-crossing.

- [ ] **Step 1: Failing tests (red first)**
  1. Alternation: over the two-year window from Task 4 (`_TWO_YEAR_START`, 24 months) AND over a window chosen to contain a real Jupiter or Saturn retrograde cusp crossing (find one with a scan, e.g. Jupiter around its Gemini/Cancer or Cancer/Leo cusp in 2025–2027; Saturn Pisces/Aries 2025–2026), for each graha in {jupiter, saturn, mars, rahu, ketu}: consecutive `sign_ingress` events satisfy `next.from_sign == prev.to_sign` and `next.to_sign != prev.to_sign`. Under the old sticking rule this test must FAIL on the retrograde-crossing window (show the red output: two consecutive "enters X").
  2. The retrograde window yields a backward event (`to_sign` is the sign before `from_sign`) for that planet.
  3. Signature: `inspect.signature(build_timeline).parameters` has no `ayanamsa_type`/`node_type`; red before the change.
- [ ] **Step 2:** Run, watch them fail for the stated reason.
- [ ] **Step 3: Implement.** In `_collect`, replace the sticking loop with `for graha in (JUPITER, SATURN, MARS): events += sign_change_events(...)`. Remove the two parameters from `build_timeline` and from the `build_timeline(...)` call in `calculate_transit_context` (gochara and fusion still get them). Update the docstring. Remove dead code in `timeline_ingress.py`.
- [ ] **Step 4: Regenerate goldens** with the commands in Global Constraints (never hand-edit). Then `git diff --stat` the three fixtures. For the transit/predictive goldens, list the Jupiter/Saturn events that changed. If `domains_golden_de421.json` changed, write one line per changed window saying which Jupiter/Saturn crossing caused it, into the task report under "Life Atlas golden diff" (the PR body copies it). If it did not change, say so with the `git diff --exit-code` exit.
- [ ] **Step 5:** Run `tests/test_transit_timeline.py tests/test_timeline_sign_changes.py tests/test_transit_golden.py tests/test_predictive_golden.py tests/test_domains_golden.py tests/test_domain_windows_scope.py` plus every frontend test that reads these goldens (`grep -rl "transit_golden_de421\|predictive_golden_de421\|domains_golden_de421" frontend --include='*.ts'`). PASS.
- [ ] **Step 6: Mutation red runs** (KILLED lines into the report): (i) put Jupiter back on the sticking producer → the alternation test fails; (ii) re-add a non-default-honouring check is not applicable, so instead mutate the signature test target by re-adding `ayanamsa_type` param → signature test fails. Confirm `git status` clean after each.
- [ ] **Step 7:** `python-quality` on the touched Python; `cd backend && uv run poe gate` exit 0. Commit (named files, trailer).

### Task 5: `window_months` on the predictive entry, the worker glue, and a two-year golden

**Files:**
- Modify: `backend/src/almamesh/predictive.py`
- Modify: `backend/src/almamesh/edge/chart_runtime.py:79-101` (`compute_predictive`)
- Modify: `frontend/packages/browser/src/pyodide/chartWorker.ts:75-96` (`_almamesh_compute_predictive` in `PY_BOOTSTRAP`)
- Modify: `frontend/packages/browser/src/pyodide/protocol.ts:40-51` (`PredictiveInput`)
- Modify: `backend/tests/test_predictive_golden.py`, `backend/tests/fixtures/regen_predictive_golden.py`, `backend/tests/test_chart_worker_glue.py`
- Modify (regenerated): `backend/tests/fixtures/predictive_golden_de421.json`
- Modify: `frontend/packages/browser/integration/parity.mjs` (predictive fixtures)
- Create: `backend/tests/test_predictive_window.py`

**Interfaces:**
- Produces (Python): `compute_predictive_contexts(birth_dt, latitude, longitude, reference_instant, *, civil_offset, window_months: int = 12) -> PredictiveContexts`; `window_months_from_wire(value: object) -> int` (None → 12; whole int 1..24 else `ValueError` mentioning `window_months`); `checked_window_months(value: int) -> int`; module constant line exactly `_MAX_WINDOW_MONTHS: Final[int] = 24` (Task 8's contract test reads it).
- Produces (TS): `PredictiveInput.windowMonths?: 24` with the doc comment "Omitted means the engine's default 12 months. Only 24 is ever sent, so 12-month keys never change."
- Golden: `predictive_golden_de421.json` gains key `"1990-01-15T12:00:00+00:00@24m"` (Delhi, offset 330, window 24). Helpers in `test_predictive_golden.py`: `golden_key(iso_dt: str, window_months: int) -> str`, `golden_cases() -> list[tuple[str, tuple[str, float, float, int], int]]`, `WINDOW_24_FIXTURES`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_predictive_window.py`:

```python
"""window_months: one compute covers up to two years; the wire refuses anything else."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from almamesh.edge.chart_runtime import compute_predictive
from almamesh.predictive import compute_predictive_contexts, window_months_from_wire

BIRTH = datetime(1990, 1, 15, 12, tzinfo=UTC)
LAT, LON = 28.6139, 77.2090
REFERENCE = datetime(2026, 6, 9, 12, tzinfo=UTC)


def _payload(**extra: object) -> dict[str, object]:
    return {
        "datetime_utc": BIRTH.isoformat(),
        "latitude": LAT,
        "longitude": LON,
        "reference_instant": REFERENCE.isoformat(),
        "utc_offset_minutes": 330,
        **extra,
    }


def _window_days(result: dict[str, object]) -> float:
    timeline = json.loads(json.dumps(result))["transit_context"]["timeline"]
    span = datetime.fromisoformat(timeline["window_end"]) - datetime.fromisoformat(timeline["window_start"])
    return span / timedelta(days=1)


def test_default_window_is_twelve_engine_months() -> None:
    assert _window_days(compute_predictive(_payload())) == 365.25


def test_window_months_24_is_one_compute_over_two_years() -> None:
    assert _window_days(compute_predictive(_payload(window_months=24))) == 730.5


@pytest.mark.parametrize("bad", [0, 25, -1, 12.0, True, "24"])
def test_wire_refuses_anything_but_whole_months_1_to_24(bad: object) -> None:
    with pytest.raises(ValueError, match="window_months"):
        window_months_from_wire(bad)


def test_absent_wire_value_is_the_default() -> None:
    assert window_months_from_wire(None) == 12


def test_engine_refuses_a_window_past_two_years() -> None:
    with pytest.raises(ValueError, match="window_months"):
        compute_predictive_contexts(
            BIRTH, LAT, LON, REFERENCE, civil_offset=timedelta(minutes=330), window_months=25
        )


def test_payload_bytes_stay_within_the_low_end_budget() -> None:
    # Measured on main before Inc B: 59,102 bytes for this chart at 12 months.
    twelve = len(json.dumps(compute_predictive(_payload())))
    twenty_four = len(json.dumps(compute_predictive(_payload(window_months=24))))
    print(f"predictive payload bytes: 12m={twelve} 24m={twenty_four}")  # noqa: T201 - recorded in the PR
    assert twelve <= 72 * 1024
    assert twenty_four <= 88 * 1024
```

Append to `backend/tests/test_chart_worker_glue.py` (it already extracts and `exec`s `PY_BOOTSTRAP`; reuse `_extract_bootstrap` and `_WORKER_TS`):

```python
def _predictive_glue() -> Callable[[str], str]:
    namespace: dict[str, object] = {}
    exec(compile(_extract_bootstrap(), str(_WORKER_TS), "exec"), namespace)  # noqa: S102
    fn = namespace["_almamesh_compute_predictive"]
    assert callable(fn)
    return fn


def _predictive_input(**extra: object) -> str:
    return json.dumps(
        {
            "datetimeUtc": "1990-01-15T12:00:00+00:00",
            "latitude": 28.6139,
            "longitude": 77.209,
            "referenceInstant": "2026-06-09T12:00:00+00:00",
            "utcOffsetMinutes": 330,
            **extra,
        }
    )


def _window_end(raw: str) -> str:
    return str(json.loads(raw)["transit_context"]["timeline"]["window_end"])


def test_glue_passes_window_months_to_the_engine() -> None:
    glue = _predictive_glue()
    assert _window_end(glue(_predictive_input())).startswith("2027-06-09T18:00:00")
    assert _window_end(glue(_predictive_input(windowMonths=24))).startswith("2028-06-09T00:00:00")


def test_glue_refuses_a_window_past_two_years() -> None:
    with pytest.raises(ValueError, match="window_months"):
        _predictive_glue()(_predictive_input(windowMonths=25))
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd backend && uv run pytest tests/test_predictive_window.py tests/test_chart_worker_glue.py -q --no-cov`
Expected: `test_predictive_window.py` ERRORS with `ImportError: cannot import name 'window_months_from_wire'`; the glue window test FAILS (`windowMonths` is ignored, so the 24-month end is `2027-06-09T18:00`).

- [ ] **Step 3: Engine keyword and wire parser**

In `backend/src/almamesh/predictive.py`, after `_MAX_OFFSET_MINUTES`:

```python
_DEFAULT_WINDOW_MONTHS: Final[int] = 12
_MAX_WINDOW_MONTHS: Final[int] = 24


def checked_window_months(value: int) -> int:
    """The timeline window in months, refused outside 1..24."""
    if not 1 <= value <= _MAX_WINDOW_MONTHS:
        raise ValueError("invalid window_months: must be 1..24")
    return value


def window_months_from_wire(value: object) -> int:
    """The timeline window from a wire value; absent means the default 12.

    Shared by the CPython edge runtime and the Pyodide worker glue so both
    refuse the same inputs: booleans, strings, fractions, out-of-range values.
    """
    if value is None:
        return _DEFAULT_WINDOW_MONTHS
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("invalid window_months: must be whole months")
    return checked_window_months(value)
```

Change `compute_predictive_contexts`' signature to add `window_months: int = _DEFAULT_WINDOW_MONTHS` after `civil_offset`, call `checked_window_months(window_months)` as its first statement, and pass `window_months=window_months` to `calculate_transit_context`. Add one docstring line: "``window_months`` (1..24, default 12) is the forward timeline's length; a period of up to two years is one compute." Keep the body at 15 lines or fewer; add both new names to `__all__`.

In `edge/chart_runtime.py::compute_predictive`, import `window_months_from_wire` and pass `window_months=window_months_from_wire(payload.get("window_months"))` to `compute_predictive_contexts`.

In `chartWorker.ts` `PY_BOOTSTRAP`, `_almamesh_compute_predictive`: import `window_months_from_wire` alongside `civil_offset_from_minutes` and pass `window_months=window_months_from_wire(data.get("windowMonths")),` after `civil_offset=...`.

In `protocol.ts` `PredictiveInput` add:

```ts
  /**
   * The engine timeline's length in months. Omitted means the engine's default
   * 12. Only 24 is ever sent, so 12-month keys (store, memo) never change.
   */
  readonly windowMonths?: 24;
```

- [ ] **Step 4: Run and see them pass**

Run: `cd backend && uv run pytest tests/test_predictive_window.py tests/test_chart_worker_glue.py tests/test_predictive_entry.py -q --no-cov -s`
Expected: PASS, and the `-s` output prints `predictive payload bytes: 12m=… 24m=…`. Record both numbers for the PR. If a budget assertion fails, stop and report the numbers (Ruling 10): do not raise the budget.

- [ ] **Step 5: The two-year golden case**

In `backend/tests/test_predictive_golden.py`: give `_compute` and `_canonical_predictive` a trailing `window_months: int = 12` parameter passed through to `compute_predictive_contexts`, and add:

```python
# One two-year case (Inc B), keyed "<iso>@24m". MUST match parity.mjs and
# apps/web/scripts/verify-browser-parity.mjs PREDICTIVE_FIXTURES.
WINDOW_24_FIXTURES: list[tuple[str, float, float, int]] = [
    ("1990-01-15T12:00:00+00:00", 28.6139, 77.2090, 330),  # Delhi
]


def golden_key(iso_dt: str, window_months: int) -> str:
    """The golden's key for one case: the ISO birth, plus "@24m" for two-year cases."""
    return iso_dt if window_months == 12 else f"{iso_dt}@{window_months}m"


def golden_cases() -> list[tuple[str, tuple[str, float, float, int], int]]:
    """Every (key, fixture, window) the predictive golden pins."""
    twelve = [(golden_key(f[0], 12), f, 12) for f in FIXTURES]
    return twelve + [(golden_key(f[0], 24), f, 24) for f in WINDOW_24_FIXTURES]
```

Change `test_all_predictive_fixtures_match_golden` to:

```python
def test_all_predictive_fixtures_match_golden() -> None:
    golden = _load_golden()
    assert sorted(golden) == sorted(key for key, _, _ in golden_cases())
    for key, fixture, window in golden_cases():
        assert _canonical_predictive(*fixture, window_months=window) == golden[key], key
```

In `regen_predictive_golden.py`, import `golden_cases` instead of `FIXTURES` and build `golden = {key: _canonical_predictive(*fixture, window_months=window) for key, fixture, window in golden_cases()}`.

Run: `cd backend && uv run pytest tests/test_predictive_golden.py -q --no-cov` → FAIL (`sorted(golden)` lacks `@24m`). Then `uv run python -m tests.fixtures.regen_predictive_golden` and re-run → PASS. Confirm the 12-month entries did not change: `git diff tests/fixtures/predictive_golden_de421.json | grep '^-' | grep -v '^---'` prints nothing.

- [ ] **Step 6: Keep `parity.mjs` in step**

In `frontend/packages/browser/integration/parity.mjs`: give every `PREDICTIVE_FIXTURES` entry `windowMonths` and `key`, and add the two-year case:

```js
const PREDICTIVE_FIXTURES = [
  // offset = the birthplace civil UTC offset in minutes (the Worker's
  // utcOffsetMinutes); MUST match backend/tests/test_predictive_golden.py.
  { iso: "1990-01-15T12:00:00+00:00", lat: 28.6139, lon: 77.209, offset: 330, windowMonths: 12, key: "1990-01-15T12:00:00+00:00", label: "Delhi" },
  { iso: "2000-12-31T23:59:00+00:00", lat: 40.7128, lon: -74.006, offset: -300, windowMonths: 12, key: "2000-12-31T23:59:00+00:00", label: "NYC" },
  { iso: "1990-01-15T12:00:00+00:00", lat: 28.6139, lon: 77.209, offset: 330, windowMonths: 24, key: "1990-01-15T12:00:00+00:00@24m", label: "Delhi, 24 months" },
];
```

In its embedded Python, `_parity_predictive(iso_dt, lat, lon, offset_minutes, window_months)` passes `window_months=window_months` to `compute_predictive_contexts`. In the loop, call `parityPredictive(fx.iso, fx.lat, fx.lon, fx.offset, fx.windowMonths)`, read `predictiveGolden[fx.key]`, print `fx.key` instead of `fx.iso`, and append `rss=${Math.round(process.memoryUsage().rss / 1048576)}MB` to the PASS/FAIL line. `node --check frontend/packages/browser/integration/parity.mjs` must exit 0. (This harness needs a local `/private/tmp/almamesh-spike`; the CI proof is Task 6's browser gate.)

- [ ] **Step 7: Mutation red runs**

```bash
python3 "$MUTATE" backend/src/almamesh/predictive.py \
  '    if not 1 <= value <= _MAX_WINDOW_MONTHS:' '    if not 1 <= value <= 36:' \
  -- bash -c 'cd backend && uv run pytest tests/test_predictive_window.py -q --no-cov'
python3 "$MUTATE" frontend/packages/browser/src/pyodide/chartWorker.ts \
  '        window_months=window_months_from_wire(data.get("windowMonths")),
' '' -- bash -c 'cd backend && uv run pytest tests/test_chart_worker_glue.py -q --no-cov'
```
Expected: both `KILLED`.

- [ ] **Step 8: Quality and commit**

Invoke `python-quality` (Python) and `frontend-quality` (`protocol.ts`, `chartWorker.ts`). Run `cd frontend/packages/browser && bunx tsc --noEmit -p .` (or the package's `typecheck` script). Then:

```bash
git add backend/src/almamesh/predictive.py backend/src/almamesh/edge/chart_runtime.py \
  backend/tests/test_predictive_window.py backend/tests/test_chart_worker_glue.py \
  backend/tests/test_predictive_golden.py backend/tests/fixtures/regen_predictive_golden.py \
  backend/tests/fixtures/predictive_golden_de421.json \
  frontend/packages/browser/src/pyodide/chartWorker.ts frontend/packages/browser/src/pyodide/protocol.ts \
  frontend/packages/browser/integration/parity.mjs
git commit -m "feat(engine): window_months on the predictive entry (one compute up to two years)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 6: Types, adapter, sanitizer and copy for station events; predictive parity in the CI browser gate

**Files:**
- Modify: `frontend/packages/browser/src/pyodide/predictive.ts:129-140` (`TimelineEvent`)
- Modify: `frontend/packages/shared-types/src/index.ts:345-357` (`TransitTimelineEventData`)
- Modify: `frontend/packages/store/src/adapters/predictive.ts:186-199` (`toTimelineEvent`)
- Modify: `frontend/packages/llm/src/sanitize.ts:155-163,497-505`
- Modify: `frontend/apps/web/src/lib/predictiveEventCopy.ts` (`station` case)
- Modify: `frontend/apps/web/src/locales/{en,es,pt}/predictive.json` (`events`)
- Modify: `frontend/apps/web/src/test/predictiveFixtures.ts` (UI event literals)
- Modify: `frontend/apps/web/src/lib/runtimeObservability.ts`, `frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx:349`
- Modify: `frontend/apps/web/scripts/verify-browser-parity.mjs`
- Test: `frontend/packages/store/src/adapters/predictive.test.ts`, `frontend/packages/llm/src/__tests__/sanitize.test.ts`, `frontend/apps/web/src/lib/__tests__/predictiveEventCopy.test.ts`, `frontend/apps/web/src/components/features/predictive/__tests__/TransitsPanel.test.tsx` (create if absent)

**Interfaces:**
- Consumes: engine `TimelineEvent.station_direction` / `station_sign` (Task 2), the `@24m` golden (Task 5).
- Produces:
  - Engine type: `TimelineEvent.station_direction?: StationDirection | null; station_sign?: string | null;` and `export type StationDirection = "retrograde" | "direct"` (exported from `@almamesh/browser/types` beside `TimelineEvent`). Optional: payloads persisted by an older build lack them.
  - UI type: `TransitTimelineEventData.station_direction: StationDirection | null; station_sign: ZodiacSign | null;` with `export type StationDirection = 'retrograde' | 'direct'` in shared-types. Required: the adapter always sets them.
  - Sanitized: `SanitizedTransitEvent.station_direction: string | null; station_sign: string | null;`.
  - i18n keys `predictive:events.station_retrograde`, `predictive:events.station_direct` (`{{graha}}`, `{{sign}}`).
  - Hook (exit-gate builds only): `window.__almameshComputePredictive?: (input: PredictiveInput) => Promise<PredictiveContexts>`, published by `publishRuntimePredictive`.

- [ ] **Step 1: Write the failing tests**

Adapter (`packages/store/src/adapters/predictive.test.ts`, inside `describe("toTransitCtx", …)`; `TransitContext` is already imported as a type in this file, add it if not):

```ts
  it("carries a station's direction and sign, and reads a pre-Inc-B payload as null", () => {
    const raw = transitGolden["1990-01-15T12:00:00+00:00"] as unknown as TransitContext;
    const station = toTransitCtx(raw)?.timeline.events.find((e) => e.kind === "station" && e.graha === "saturn");
    expect(station).toMatchObject({ station_direction: "retrograde", station_sign: "pisces" });
    const legacy: TransitContext = {
      ...raw,
      timeline: {
        ...raw.timeline,
        events: raw.timeline.events.map(({ station_direction: _d, station_sign: _s, ...rest }) => rest),
      },
    };
    const events = toTransitCtx(legacy)?.timeline.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.station_direction === null && e.station_sign === null)).toBe(true);
  });
```

Sanitizer (`packages/llm/src/__tests__/sanitize.test.ts`): the existing `expect(transits?.timeline).toContainEqual({ month: "2030-03", … descriptor: "Saturn enters Pisces" })` must gain `station_direction: null, station_sign: null` (the allowlist grew; the fixture event has no station). Add after it, in the same `describe`:

```ts
  it("keeps a station's direction and sign, and its date at month precision", () => {
    const [ingress] = TRANSIT_CTX_FIXTURE.timeline.events;
    const station = {
      ...ingress,
      date: "2030-07-26T07:56:00Z",
      kind: "station",
      graha: "saturn",
      from_sign: null,
      to_sign: null,
      station_direction: "retrograde",
      station_sign: "pisces",
      descriptor: "saturn.station.retrograde",
    } as const;
    const chart = {
      ...predictiveChart,
      transit_context: { ...TRANSIT_CTX_FIXTURE, timeline: { ...TRANSIT_CTX_FIXTURE.timeline, events: [station] } },
    } as unknown as SiderealChart;
    const transits = sanitizeChartForLlm(chart, { basis: "chart", instant: NOW }).predictive?.transits;
    expect(transits?.timeline).toEqual([
      {
        month: "2030-07",
        kind: "station",
        graha: "saturn",
        from_sign: null,
        to_sign: null,
        station_direction: "retrograde",
        station_sign: "pisces",
        severity: "challenging",
        descriptor: "saturn.station.retrograde",
      },
    ]);
    expect(allStrings(transits).filter((s) => DAY_PRECISION.test(s))).toEqual([]);
  });
```

Copy (`apps/web/src/lib/__tests__/predictiveEventCopy.test.ts`, inside `describe('timelineEventLabel', …)`):

```ts
  const station = {
    ...TRANSIT_CTX.timeline.events[0],
    kind: 'station',
    graha: 'saturn',
    from_sign: null,
    to_sign: null,
    station_direction: 'retrograde',
    station_sign: 'pisces',
    descriptor: 'saturn.station.retrograde',
  } as const;

  it('renders a station with its direction and sign, in every language', () => {
    expect(timelineEventLabel(t, station)).toBe('Saturn turns retrograde in Pisces');
    expect(timelineEventLabel(t, { ...station, station_direction: 'direct' })).toBe('Saturn turns direct in Pisces');
    expect(timelineEventLabel(i18n.getFixedT('es'), station)).toBe('Saturno inicia su retrógrado en Piscis');
    expect(timelineEventLabel(i18n.getFixedT('pt'), station)).toBe('Saturno fica retrógrado em Peixes');
  });

  it('a station without its direction keeps the plain line', () => {
    expect(timelineEventLabel(t, { ...station, station_direction: null })).toBe('Saturn stations');
  });
```

Rahu and Ketu at one instant render as two rows. Create `apps/web/src/components/features/predictive/__tests__/TransitsPanel.test.tsx` if no TransitsPanel test exists (if one exists, add the `it` to it and reuse its render helper):

```tsx
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import i18n from '../../../../i18n/config';
import { TRANSIT_CTX } from '../../../../test/predictiveFixtures';
import { TransitsPanel } from '../TransitsPanel';

describe('TransitsPanel timeline', () => {
  it('renders Rahu and Ketu changing sign at the same instant as two rows, without a key warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { ...TRANSIT_CTX.timeline.events[0], kind: 'sign_ingress', from_lord: null, to_lord: null } as const;
    const ctx = {
      ...TRANSIT_CTX,
      timeline: {
        ...TRANSIT_CTX.timeline,
        events: [
          { ...base, date: '2026-12-03', graha: 'rahu', from_sign: 'aquarius', to_sign: 'capricorn', descriptor: 'rahu.ingress.capricorn' },
          { ...base, date: '2026-12-03', graha: 'ketu', from_sign: 'leo', to_sign: 'cancer', descriptor: 'ketu.ingress.cancer' },
        ],
      },
    };
    render(
      <I18nextProvider i18n={i18n}>
        <TransitsPanel ctx={ctx} />
      </I18nextProvider>,
    );
    expect(screen.getByText('Rahu enters Capricorn')).toBeInTheDocument();
    expect(screen.getByText('Ketu enters Cancer')).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
```

Before running, open `TransitsPanel.tsx` and match its real export name and props (the timeline section reads `ctx`, line 221). If the panel requires more props, pass the minimal ones its existing callers pass. Adjust only the render call, never the assertions.

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend/packages/store && bunx vitest run src/adapters/predictive.test.ts
cd ../llm && bunx vitest run src/__tests__/sanitize.test.ts
cd ../../apps/web && bunx vitest run src/lib/__tests__/predictiveEventCopy.test.ts src/components/features/predictive/__tests__/TransitsPanel.test.tsx
```
Expected: adapter test FAILS (`station_direction` missing from the reshaped event); sanitizer tests FAIL (keys absent); copy test FAILS (`'Saturn stations'` instead of the new line). The TransitsPanel test is a characterization of keys and may already PASS; it stays as the guard for Review Focus 3.

- [ ] **Step 3: Implement**

Engine type (`packages/browser/src/pyodide/predictive.ts`): add `export type StationDirection = "retrograde" | "direct";` and to `TimelineEvent`:

```ts
  /** Station events only (Inc B). Absent on payloads saved by older builds. */
  readonly station_direction?: StationDirection | null;
  readonly station_sign?: string | null;
```

Export `StationDirection` from `packages/browser/src/types.ts` next to `TimelineEvent`.

Shared types (`packages/shared-types/src/index.ts`): add `export type StationDirection = 'retrograde' | 'direct';` and to `TransitTimelineEventData`:

```ts
  /** Station events: which way the graha turns, and the sign it turns in. */
  station_direction: StationDirection | null;
  station_sign: ZodiacSign | null;
```

Adapter (`toTimelineEvent`): add `station_direction: raw.station_direction ?? null,` and `station_sign: toUiSignOrNull(raw.station_sign ?? null),`.

UI fixtures (`apps/web/src/test/predictiveFixtures.ts`): add `station_direction: null, station_sign: null,` to every `TransitTimelineEventData` literal (`bun run --filter '*' typecheck` lists any you missed).

Sanitizer: add to `SanitizedTransitEvent` `readonly station_direction: string | null;` and `readonly station_sign: string | null;` (after `to_sign`), and to the timeline map `station_direction: event.station_direction ?? null, station_sign: event.station_sign ?? null,`.

Copy (`predictiveEventCopy.ts`, `case 'station':`):

```ts
    case 'station':
      if (event.graha && event.station_direction && event.station_sign) {
        return t(`predictive:events.station_${event.station_direction}`, {
          graha: grahaName(t, event.graha),
          sign: signName(t, event.station_sign),
        });
      }
      if (event.graha) {
        return t('predictive:events.station', { graha: grahaName(t, event.graha) });
      }
      return generic(t, event.descriptor);
```

Locales, inside `"events"` after `"station"`:
- en: `"station_retrograde": "{{graha}} turns retrograde in {{sign}}", "station_direct": "{{graha}} turns direct in {{sign}}"`
- es: `"station_retrograde": "{{graha}} inicia su retrógrado en {{sign}}", "station_direct": "{{graha}} retoma el movimiento directo en {{sign}}"`
- pt: `"station_retrograde": "{{graha}} fica retrógrado em {{sign}}", "station_direct": "{{graha}} volta ao movimento direto em {{sign}}"`

- [ ] **Step 4: Run and see them pass**

Re-run the Step 2 commands. Expected: PASS. Then `cd frontend && bun run --filter '*' typecheck` exits 0 and the locale parity tests pass (`cd frontend/apps/web && bunx vitest run src/i18n`).

- [ ] **Step 5: Predictive parity in the CI browser gate (Ruling 11)**

`apps/web/src/lib/runtimeObservability.ts`: import `type { ChartEngine } from '@almamesh/browser'` is already there; add

```ts
export type RuntimePredictiveComputer = ChartEngine['computePredictive']
```

add `__almameshComputePredictive?: RuntimePredictiveComputer` to the `Window` interface, and

```ts
export const publishRuntimePredictive = (compute: RuntimePredictiveComputer): void => {
  window.__almameshComputePredictive = compute
}
```

In `AlmaMeshRuntimeProvider.tsx`, next to `publishRuntimeGenerator((birth) => ready.generateChart(birth))` (line 349, inside the exit-gate-hooks branch), add `publishRuntimePredictive((input) => ready.computePredictive(input))`, and wherever `clearRuntimeGenerator()` runs, also `delete window.__almameshComputePredictive`.

`apps/web/scripts/verify-browser-parity.mjs`: after CHECK 4 and before CHECK 5, add CHECK 7. It reads `backend/tests/fixtures/predictive_golden_de421.json`, requires its key set to equal the fixture keys exactly (the script's own coverage rule), and compares each case byte-for-byte after canonicalization:

```js
// --- CHECK 7: the predictive payload (transits/vargas/strength/domains) is byte-identical ---
// Pins MUST match backend/tests/test_predictive_golden.py (FIXTURES + WINDOW_24_FIXTURES).
const PREDICTIVE_REFERENCE_INSTANT = '2026-06-09T12:00:00+00:00'
const PREDICTIVE_FIXTURES = {
  '1990-01-15T12:00:00+00:00': { iso: '1990-01-15T12:00:00+00:00', latitude: 28.6139, longitude: 77.209, utcOffsetMinutes: 330 },
  '2000-12-31T23:59:00+00:00': { iso: '2000-12-31T23:59:00+00:00', latitude: 40.7128, longitude: -74.006, utcOffsetMinutes: -300 },
  '1990-01-15T12:00:00+00:00@24m': { iso: '1990-01-15T12:00:00+00:00', latitude: 28.6139, longitude: 77.209, utcOffsetMinutes: 330, windowMonths: 24 },
}
const predictiveGolden = JSON.parse(
  readFileSync(join(REPO_ROOT, 'backend/tests/fixtures/predictive_golden_de421.json'), 'utf8'),
)
const goldenKeys = Object.keys(predictiveGolden).sort()
const fixtureKeys = Object.keys(PREDICTIVE_FIXTURES).sort()
let predictiveMismatches = goldenKeys.join('|') === fixtureKeys.join('|') ? 0 : 1
if (predictiveMismatches) console.log(`   [FAIL] predictive golden keys ${goldenKeys} != fixtures ${fixtureKeys}`)
for (const key of fixtureKeys) {
  const { iso, windowMonths, ...place } = PREDICTIVE_FIXTURES[key]
  const input = { datetimeUtc: iso, ...place, referenceInstant: PREDICTIVE_REFERENCE_INSTANT, ...(windowMonths ? { windowMonths } : {}) }
  const t0 = Date.now()
  const payload = await page.evaluate((arg) => window.__almameshComputePredictive(arg), input)
  // The four engine contexts only: strength receipts are minted in TypeScript, not by the engine.
  const { domain_strength_receipts: _receipts, ...contexts } = payload
  const same = deepEqual(canonicalize(contexts), canonicalize(predictiveGolden[key]))
  if (!same) predictiveMismatches += 1
  console.log(`   [${same ? 'ok' : 'FAIL'}]   predictive ${key}  ${Date.now() - t0}ms`)
}
record('CHECK 7 — predictive payloads byte-identical to the CPython golden (incl. 24 months)', predictiveMismatches === 0, `mismatches=${predictiveMismatches}`)
```

Place it inside the same `try` block that holds CHECK 3–6 so `page`, `record`, `canonicalize`, `deepEqual` are in scope. Extend the "hook present" probe near line 256 to also report `hasPredictive: typeof window.__almameshComputePredictive === 'function'` and fail CHECK 7 loudly if it is absent.

Run it locally exactly as the script header says:

```bash
cd frontend/apps/web
VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-verify
VITE_API_URL= ./node_modules/.bin/vite preview --outDir dist-verify --port 4199 --strictPort &
node scripts/verify-browser-parity.mjs http://127.0.0.1:4199 --reference-date=2025-01-01T00:00:00+00:00; echo "parity exit $?"
kill %1
```
Expected: CHECK 7 `[ok]` for all three keys, `parity exit 0`. Record the 24-month `ms` for the PR (it must stay under 70 s: half of the 140 s period-sky deadline). The build needs the dev bundle carrying this branch's wheel; if the engine boot fails on a stale bundle, run `./scripts/setup-dev-assets.sh` first.

- [ ] **Step 6: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/llm/src/sanitize.ts \
  'station_direction: event.station_direction ?? null,' 'station_direction: null,' \
  -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/sanitize.test.ts'
python3 "$MUTATE" frontend/packages/store/src/adapters/predictive.ts \
  'station_direction: raw.station_direction ?? null,' 'station_direction: raw.station_direction as never,' \
  -- bash -c 'cd frontend/packages/store && bunx vitest run src/adapters/predictive.test.ts'
python3 "$MUTATE" frontend/apps/web/src/components/features/predictive/TransitsPanel.tsx \
  'key={`${event.date}-${event.descriptor}`}' 'key={event.date}' \
  -- bash -c 'cd frontend/apps/web && bunx vitest run src/components/features/predictive/__tests__/TransitsPanel.test.tsx'
```
Expected: all `KILLED` (the second turns the legacy payload's `undefined` into a non-null miss; the third produces React's duplicate-key console error). For the browser gate, break the property once by hand: run the parity script against a build where `chartWorker.ts` drops the `window_months=` line; CHECK 7 must go red on the `@24m` key. Paste that red line into the PR.

- [ ] **Step 7: Quality and commit**

Invoke `frontend-quality` on the changed TS files. Then:

```bash
git add frontend/packages/browser/src/pyodide/predictive.ts frontend/packages/browser/src/types.ts \
  frontend/packages/shared-types/src/index.ts frontend/packages/store/src/adapters/predictive.ts \
  frontend/packages/store/src/adapters/predictive.test.ts frontend/packages/llm/src/sanitize.ts \
  frontend/packages/llm/src/__tests__/sanitize.test.ts frontend/apps/web/src/lib/predictiveEventCopy.ts \
  frontend/apps/web/src/lib/__tests__/predictiveEventCopy.test.ts \
  frontend/apps/web/src/locales/en/predictive.json frontend/apps/web/src/locales/es/predictive.json \
  frontend/apps/web/src/locales/pt/predictive.json frontend/apps/web/src/test/predictiveFixtures.ts \
  frontend/apps/web/src/components/features/predictive/__tests__/TransitsPanel.test.tsx \
  frontend/apps/web/src/lib/runtimeObservability.ts frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx \
  frontend/apps/web/scripts/verify-browser-parity.mjs
git commit -m "feat(app): station events end to end; predictive parity in the browser gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 7: Ask the engine for 24 months when a period needs it

**Files:**
- Modify: `frontend/packages/llm/src/period.ts` (+ `index.ts` exports)
- Modify: `frontend/packages/store/src/predictive.ts:63-73,123-132`
- Modify: `frontend/apps/web/src/lib/predictive.ts:65-90` (`buildEnsurePredictiveInput`)
- Modify: `frontend/apps/web/src/lib/periodSky.ts` (`engineInput`)
- Modify: `frontend/apps/web/src/lib/periodChart.ts` (`createPeriodChartLoader`)
- Test: `frontend/packages/llm/src/__tests__/period.test.ts`, `frontend/packages/store/src/predictive.test.ts`, `frontend/apps/web/src/lib/__tests__/periodSky.test.ts`, `frontend/apps/web/src/lib/__tests__/periodChart.test.ts`

**Interfaces:**
- Consumes: `PredictiveInput.windowMonths?: 24` (Task 5).
- Produces:
  - `ENGINE_DAYS_PER_MONTH = 30.4375`, `LONG_PERIOD_WINDOW_MONTHS = 24` (exported constants), `periodWindowMonths(period: PeriodRange): typeof LONG_PERIOD_WINDOW_MONTHS | undefined` in `@almamesh/llm`.
  - `EnsurePredictiveInput.windowMonths?: 24`; `predictiveRequestKey` appends it only when present.
  - `buildEnsurePredictiveInput(profileKey, birth, referenceInstant, windowMonths?: 24)`.

- [ ] **Step 1: Write the failing tests**

`packages/llm/src/__tests__/period.test.ts` (import the three new names from `../period`):

```ts
describe("periodWindowMonths", () => {
  it("keeps the engine's default window when 12 engine months cover the whole period", () => {
    expect(periodWindowMonths({ start: "2026-06-01", end: "2026-06-30" })).toBeUndefined();
    expect(periodWindowMonths({ start: "2027-01-01", end: "2027-12-31" })).toBeUndefined();
  });

  it("asks for 24 months when 12 would stop short, a leap year's 31 December included", () => {
    expect(periodWindowMonths({ start: "2028-01-01", end: "2028-12-31" })).toBe(24);
    expect(periodWindowMonths({ start: "2027-01-01", end: "2028-06-30" })).toBe(24);
  });

  it("pins the engine's month length and the long window", () => {
    expect(ENGINE_DAYS_PER_MONTH).toBe(30.4375);
    expect(LONG_PERIOD_WINDOW_MONTHS).toBe(24);
  });
});
```

`packages/store/src/predictive.test.ts`:

```ts
describe("predictiveRequestKey", () => {
  const BASE: EnsurePredictiveInput = {
    profileKey: "p1",
    datetimeUtc: "1990-01-15T12:00:00Z",
    latitude: 28.6139,
    longitude: 77.209,
    referenceInstant: "2026-06-01T00:00:00Z",
    utcOffsetMinutes: 330,
  };

  it("is unchanged for the default 12-month window (the persisted Life Atlas key)", () => {
    expect(predictiveRequestKey(BASE)).toBe('["p1","1990-01-15T12:00:00Z",28.6139,77.209,"2026-06-01T00:00:00Z",330]');
  });

  it("names a 24-month window, so it can never match a 12-month reading", () => {
    expect(predictiveRequestKey({ ...BASE, windowMonths: 24 })).toBe(
      '["p1","1990-01-15T12:00:00Z",28.6139,77.209,"2026-06-01T00:00:00Z",330,24]',
    );
  });
});
```

`apps/web/src/lib/__tests__/periodSky.test.ts` (add imports it lacks: `predictiveRequestKey`, `type EnsurePredictiveInput`, `type CachedPredictiveContexts`, `type PredictiveRuntime` from `@almamesh/store`, `vi` from `vitest`):

```ts
describe('periodSky and the 24-month window', () => {
  const TWELVE: EnsurePredictiveInput = {
    profileKey: 'p1',
    datetimeUtc: '1990-01-15T12:00:00Z',
    latitude: 28.6139,
    longitude: 77.209,
    referenceInstant: '2027-01-01T00:00:00Z',
    utcOffsetMinutes: 330,
  };

  it('never answers a 24-month period from the 12-month Life Atlas reading', async () => {
    const stored = { transit_context: 'stored' } as unknown as CachedPredictiveContexts;
    const fresh = { transit_context: 'fresh' } as unknown as CachedPredictiveContexts;
    const computePredictive = vi.fn(async () => fresh);
    const runtime = { computePredictive } as unknown as PredictiveRuntime;
    const cache = createPeriodSkyCache({
      readStore: () => ({ status: 'ready', requestKey: predictiveRequestKey(TWELVE), rawContexts: stored }),
    });
    await expect(cache.load(TWELVE, runtime, new AbortController().signal)).resolves.toBe(stored);
    await expect(cache.load({ ...TWELVE, windowMonths: 24 }, runtime, new AbortController().signal)).resolves.toBe(fresh);
    expect(computePredictive).toHaveBeenCalledTimes(1);
    expect(computePredictive.mock.calls[0]?.[0]).toMatchObject({ windowMonths: 24 });
  });
});
```

`apps/web/src/lib/__tests__/periodChart.test.ts`, inside `describe('createPeriodChartLoader', …)`:

```ts
  it('asks the engine for 24 months only when 12 would end before the period does', async () => {
    const { engine, computePredictive } = rawEngine(async () => SKY);
    const load = loader(engineContext(engine));
    await load(JUNE, toolContext());
    await load({ start: '2027-01-01', end: '2028-06-30' }, toolContext());
    expect(computePredictive.mock.calls[0]?.[0]).not.toHaveProperty('windowMonths');
    expect(computePredictive.mock.calls[1]?.[0]).toMatchObject({
      referenceInstant: '2027-01-01T00:00:00Z',
      windowMonths: 24,
    });
  });
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend/packages/llm && bunx vitest run src/__tests__/period.test.ts
cd ../store && bunx vitest run src/predictive.test.ts
cd ../../apps/web && bunx vitest run src/lib/__tests__/periodSky.test.ts src/lib/__tests__/periodChart.test.ts
```
Expected: `periodWindowMonths` is not exported (import error); the 24-month key test FAILS (no `,24]`); periodSky FAILS (the 24-month load returns the stored reading); periodChart FAILS (no `windowMonths` on the second call).

- [ ] **Step 3: Implement**

`packages/llm/src/period.ts`, after `MAX_TRANSIT_SPAN_YEARS`:

```ts
/** The engine's month for its timeline window (`_DAYS_PER_MONTH`, backend/src/almamesh/transits/timeline.py). */
export const ENGINE_DAYS_PER_MONTH = 30.4375;
/** The engine's longest timeline window (`_MAX_WINDOW_MONTHS`, backend/src/almamesh/predictive.py). */
export const LONG_PERIOD_WINDOW_MONTHS = 24;
```

and at the end of the file:

```ts
/**
 * 24 when the engine's default 12-month window, starting at the period's first
 * day, ends before the period's last day does; otherwise undefined (send no
 * window, so 12-month store and memo keys stay as they were). Calendar
 * arithmetic only.
 */
export function periodWindowMonths(period: PeriodRange): typeof LONG_PERIOD_WINDOW_MONTHS | undefined {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  const afterLastDay = Date.parse(`${period.end}T00:00:00Z`) + MS_PER_DAY;
  const twelveMonthsEnd = start + 12 * ENGINE_DAYS_PER_MONTH * MS_PER_DAY;
  return twelveMonthsEnd >= afterLastDay ? undefined : LONG_PERIOD_WINDOW_MONTHS;
}
```

Export all three from `packages/llm/src/index.ts` next to the other `./period` exports.

`packages/store/src/predictive.ts`: add to `EnsurePredictiveInput`

```ts
  /** The engine timeline's length; omitted means 12. Only a time-travel period sends 24. */
  readonly windowMonths?: 24;
```

and make `predictiveRequestKey` return

```ts
  const base = [
    input.profileKey,
    input.datetimeUtc,
    input.latitude,
    input.longitude,
    input.referenceInstant,
    input.utcOffsetMinutes,
  ];
  return JSON.stringify(input.windowMonths === undefined ? base : [...base, input.windowMonths]);
```

`apps/web/src/lib/predictive.ts` `buildEnsurePredictiveInput`: add a fourth parameter `windowMonths?: 24` and end the returned object with `...(windowMonths === undefined ? {} : { windowMonths }),`.

`apps/web/src/lib/periodSky.ts` `engineInput`: add `...(input.windowMonths === undefined ? {} : { windowMonths: input.windowMonths }),` as the last property, and extend its doc comment: "A 12-month input sends no window, so the memo key equals the store's."

`apps/web/src/lib/periodChart.ts`: import `periodWindowMonths` from `@almamesh/llm` and pass `periodWindowMonths(period)` as `buildEnsurePredictiveInput`'s fourth argument.

- [ ] **Step 4: Run and see them pass**

Re-run the Step 2 commands. Expected: PASS. Then `cd frontend && bun run --filter '*' typecheck`.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/llm/src/period.ts \
  'const afterLastDay = Date.parse(`${period.end}T00:00:00Z`) + MS_PER_DAY;' \
  'const afterLastDay = Date.parse(`${period.end}T00:00:00Z`);' \
  -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period.test.ts'
python3 "$MUTATE" frontend/packages/store/src/predictive.ts \
  'input.windowMonths === undefined ? base : [...base, input.windowMonths]' 'base' \
  -- bash -c 'cd frontend/packages/store && bunx vitest run src/predictive.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/periodSky.ts \
  '...(input.windowMonths === undefined ? {} : { windowMonths: input.windowMonths }),' '' \
  -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/periodSky.test.ts src/lib/__tests__/periodChart.test.ts'
```
Expected: all `KILLED` (the first is the leap-year case of Review Focus 2).

- [ ] **Step 6: Quality and commit**

Invoke `frontend-quality`. Then:

```bash
git add frontend/packages/llm/src/period.ts frontend/packages/llm/src/index.ts \
  frontend/packages/llm/src/__tests__/period.test.ts frontend/packages/store/src/predictive.ts \
  frontend/packages/store/src/predictive.test.ts frontend/apps/web/src/lib/predictive.ts \
  frontend/apps/web/src/lib/periodSky.ts frontend/apps/web/src/lib/periodChart.ts \
  frontend/apps/web/src/lib/__tests__/periodSky.test.ts frontend/apps/web/src/lib/__tests__/periodChart.test.ts
git commit -m "feat(chat): a period longer than the 12-month window asks the engine for 24

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 8: `covered_events` widens; honest notes; a contract test that ties the app to the engine

**Files:**
- Modify: `frontend/packages/llm/src/period-transits.ts`
- Modify: `frontend/packages/llm/src/__tests__/period-transits.test.ts`
- Create: `tests/time-travel-engine-contract.test.ts`

**Interfaces:**
- Consumes: Task 5's golden key `"1990-01-15T12:00:00+00:00@24m"` and the line `_MAX_WINDOW_MONTHS: Final[int] = 24`; Task 7's `ENGINE_DAYS_PER_MONTH`, `LONG_PERIOD_WINDOW_MONTHS`.
- Produces: `COVERED_EVENTS = ["jupiter_ingress", "saturn_ingress", "mars_ingress", "rahu_ingress", "ketu_ingress", "jupiter_station", "saturn_station", "mars_station", "dasha_change", "sade_sati_phase"] as const`; `placementsAsOfNote(start)` and `timelineCutoffNote(windowEnd)` with the texts below; the cutoff now compares instants.

- [ ] **Step 1: Write the failing tests (two inverted, one new, one contract)**

In `period-transits.test.ts`, the `COVERED_EVENTS` test and the "labels a multi-day result's placements" test assert the pre-Inc-B contract. **Invert them** (call out in the PR):

```ts
describe("COVERED_EVENTS", () => {
  it("claims exactly what the Inc B engine timeline checks", () => {
    expect(COVERED_EVENTS).toEqual([
      "jupiter_ingress",
      "saturn_ingress",
      "mars_ingress",
      "rahu_ingress",
      "ketu_ingress",
      "jupiter_station",
      "saturn_station",
      "mars_station",
      "dasha_change",
      "sade_sati_phase",
    ]);
  });
});
```

```ts
  it("labels a multi-day result's placements as of the period's first day", () => {
    const { notes } = restrictTransitsToPeriod(CTX, { start: "2030-03-01", end: "2030-03-31" }, true);
    expect(notes).toContain(
      "Planet signs and houses are as of 2030-03-01, the period's first day. Sign changes and stations during the period are listed in the timeline.",
    );
  });
```

Add, in the `restrictTransitsToPeriod` describe:

```ts
  it("notes a window that ends during the period's last day, to the minute", () => {
    const ctx = { ...CTX, timeline: { ...CTX.timeline, window_end: "2028-12-31T06:00:00Z" } };
    const { notes } = restrictTransitsToPeriod(ctx, { start: "2028-01-01", end: "2028-12-31" }, true);
    expect(notes).toContain("Transit events are listed only until 2028-12-31 06:00 UTC. Ask about a later start for the rest.");
  });

  it("adds no cutoff note when the window outlasts the period's last day", () => {
    const ctx = { ...CTX, timeline: { ...CTX.timeline, window_end: "2028-01-01T06:00:00Z" } };
    const { notes } = restrictTransitsToPeriod(ctx, { start: "2027-01-01", end: "2027-12-31" }, true);
    expect(notes.some((note) => note.startsWith("Transit events are listed only until"))).toBe(false);
  });
```

The existing "notes when the period runs past the engine's timeline window" test keeps its `toEqual([placementsAsOfNote(...), timelineCutoffNote(...)])` and `toContain("2031-01")` assertions unchanged.

`tests/time-travel-engine-contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { COVERED_EVENTS } from "../frontend/packages/llm/src/period-transits.ts"
import { ENGINE_DAYS_PER_MONTH, LONG_PERIOD_WINDOW_MONTHS } from "../frontend/packages/llm/src/period.ts"

const root = resolve(import.meta.dir, "..")
const read = (path: string): string => readFileSync(resolve(root, path), "utf8")

interface GoldenEvent {
  readonly kind: string
  readonly graha: string | null
}

/** The covered_events token an engine timeline event belongs to. */
function token(event: GoldenEvent): string {
  if (event.kind === "sign_ingress") return `${event.graha}_ingress`
  if (event.kind === "station") return `${event.graha}_station`
  return event.kind
}

describe("time travel: the app's view of the engine is the engine's", () => {
  test("the app's engine month and longest window are the engine's own constants", () => {
    expect(read("backend/src/almamesh/transits/timeline.py")).toContain(`_DAYS_PER_MONTH = ${ENGINE_DAYS_PER_MONTH}\n`)
    expect(read("backend/src/almamesh/predictive.py")).toContain(
      `_MAX_WINDOW_MONTHS: Final[int] = ${LONG_PERIOD_WINDOW_MONTHS}\n`,
    )
  })

  test("covered_events names every kind the two-year golden holds, and every graha kind is really produced", () => {
    const golden = JSON.parse(read("backend/tests/fixtures/predictive_golden_de421.json"))
    const events: GoldenEvent[] = golden["1990-01-15T12:00:00+00:00@24m"].transit_context.timeline.events
    const produced = new Set(events.map(token))
    for (const kind of produced) expect(COVERED_EVENTS as readonly string[]).toContain(kind)
    const grahaKinds = COVERED_EVENTS.filter((kind) => kind.endsWith("_ingress") || kind.endsWith("_station"))
    for (const kind of grahaKinds) expect(produced.has(kind)).toBe(true)
  })
})
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd frontend/packages/llm && bunx vitest run src/__tests__/period-transits.test.ts
cd ../../.. && bun test ./tests/time-travel-engine-contract.test.ts
```
Expected: the inverted tests and the 06:00 cutoff test FAIL (old list, old note text, day compare); the contract's covered-events test FAILS on `mars_ingress` (produced by the golden, not covered yet). The constants test PASSES (Tasks 5 and 7 already aligned them); its mutation in Step 5 proves it can fail.

- [ ] **Step 3: Implement**

In `period-transits.ts`:

```ts
/**
 * The dated event kinds the engine timeline checks (Inc B: transits/timeline.py).
 * Jupiter/Saturn sticking ingresses; every Mars and Rahu/Ketu sign change;
 * Jupiter/Saturn/Mars stations; dasha changes; Sade Sati phases. The model must
 * not claim anything about a kind that is not listed.
 */
export const COVERED_EVENTS = [
  "jupiter_ingress",
  "saturn_ingress",
  "mars_ingress",
  "rahu_ingress",
  "ketu_ingress",
  "jupiter_station",
  "saturn_station",
  "mars_station",
  "dasha_change",
  "sade_sati_phase",
] as const;

const MS_PER_DAY = 86_400_000;

export function timelineCutoffNote(windowEnd: string): string {
  return `Transit events are listed only until ${windowEnd.slice(0, 10)} ${windowEnd.slice(11, 16)} UTC. Ask about a later start for the rest.`;
}

export function placementsAsOfNote(start: string): string {
  return `Planet signs and houses are as of ${start}, the period's first day. Sign changes and stations during the period are listed in the timeline.`;
}

/** True when the engine window ends before the period's last day ends (instants, not days). */
function windowEndsEarly(windowEnd: string, period: PeriodRange): boolean {
  return Date.parse(windowEnd) < Date.parse(`${period.end}T00:00:00Z`) + MS_PER_DAY;
}
```

and in `restrictTransitsToPeriod` replace the `cutoff` line with
`const cutoff = windowEndsEarly(ctx.timeline.window_end, period) ? [timelineCutoffNote(ctx.timeline.window_end)] : [];`.

- [ ] **Step 4: Run and see them pass**

Re-run Step 2's commands, then `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.test.ts`. Expected: all PASS. Re-run the Step-A privacy suites unchanged, as the proof that Global Constraint "Step A privacy rules stay intact" still holds: `cd frontend/packages/llm && bunx vitest run src/__tests__/egress.test.ts src/__tests__/period.test.ts src/__tests__/period-dashas.test.ts` → PASS.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/llm/src/period-transits.ts '  "mars_station",
' '' -- bun test ./tests/time-travel-engine-contract.test.ts
python3 "$MUTATE" frontend/packages/llm/src/period.ts \
  'export const ENGINE_DAYS_PER_MONTH = 30.4375;' 'export const ENGINE_DAYS_PER_MONTH = 30.5;' \
  -- bun test ./tests/time-travel-engine-contract.test.ts
python3 "$MUTATE" frontend/packages/llm/src/period-transits.ts \
  '+ MS_PER_DAY;' ';' \
  -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-transits.test.ts'
```
Expected: all `KILLED`.

- [ ] **Step 6: Quality and commit**

Invoke `frontend-quality`. Then:

```bash
git add frontend/packages/llm/src/period-transits.ts frontend/packages/llm/src/__tests__/period-transits.test.ts \
  tests/time-travel-engine-contract.test.ts
git commit -m "feat(chat): covered_events lists Mars, the nodes and stations; cutoff by instant

Reverses two Inc A tests that pinned the pre-Inc-B coverage and Mars note.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 9: End-to-end journey: "2027 and the first half of 2028"

**Files:**
- Modify: `frontend/apps/web/e2e/time-travel.spec.ts`

**Interfaces:**
- Consumes: the whole stack. The model is stubbed with `page.route`; the engine is real (as in Inc A's journey).

- [ ] **Step 1: Extract the shared set-up, then write the failing journey**

Move the first three set-up statements of the June 2019 test (console capture, `FULL_TIER` init script, LLM settings init script) into a helper and call it from that test, unchanged in behaviour:

```ts
async function prepare(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  await page.addInitScript((tier) => {
    for (const [name, value] of Object.entries(tier)) {
      Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
    }
  }, FULL_TIER);
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );
  return consoleErrors;
}
```

Append the journey:

```ts
const LONG_QUESTION = 'How do 2027 and the first half of 2028 look for me?';
const LONG_ANSWER = 'I looked at 1 January 2027 to 30 June 2028. Mars turns retrograde in January 2027.';

test('[contract/stubbed] an 18-month period is one engine run with Mars, nodes and stations', async ({ page }) => {
  test.setTimeout(600_000);
  const consoleErrors = await prepare(page);
  const toolResults: WireMessage[] = [];
  await page.route('**/chat/completions', async (route) => {
    const parsed = JSON.parse(route.request().postData() ?? '{}') as { messages?: WireMessage[]; tools?: unknown[] };
    const messages = parsed.messages ?? [];
    if (!Array.isArray(parsed.tools) || !JSON.stringify(messages).includes('first half of 2028')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    }
    const results = messages.filter((message) => message.role === 'tool');
    if (results.length === 0) {
      const call = {
        id: 'sky-long',
        type: 'function',
        function: { name: 'get_timing', arguments: JSON.stringify({ section: 'transits', start: '2027-01-01', end: '2028-06-30' }) },
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] } }] }),
      });
    }
    toolResults.push(...results);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: LONG_ANSWER } }] }) });
  });

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  // As in the June 2019 journey: wait for the re-anchor to today, or the answer is discarded by design.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await page.getByTestId('chat-input').fill(LONG_QUESTION);
  await page.getByTestId('chat-send-button').click();

  await expect(page.getByTestId('chat-panel').getByText('I looked at 1 January 2027', { exact: false })).toBeVisible({
    timeout: 480_000,
  });
  expect(toolResults).toHaveLength(1);
  const content = toolResults[0].content ?? '';
  expect(content).toContain('"period":{"start":"2027-01-01","end":"2028-06-30","days":547,"basis":"period"}');
  expect(content).not.toContain('"available":false');
  expect(content).not.toContain('Transit events are listed only until');
  for (const kind of ['"mars_ingress"', '"rahu_ingress"', '"mars_station"']) expect(content).toContain(kind);
  expect(content).toContain('"kind":"station"');
  expect(content).toContain('"station_direction":"retrograde"');
  expect(content).toContain('"graha":"mars"');
  expect(content).not.toContain(BIRTH_MONTH);
  await page.screenshot({ path: 'test-results/time-travel-18-months.png', fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
```

(547 days: 365 for 2027 + 182 for 1 Jan–30 Jun 2028, a leap year.)

- [ ] **Step 2: Run against the pre-Inc-B app to see it fail, then against this branch**

Build and serve this branch the way Inc A's journey is run (`playwright.time-travel.config.ts` header). To watch it fail for the right reason, run once with Task 8's `COVERED_EVENTS` mutated back to the four Inc A kinds (or with Task 7's `periodSky` window line removed): the `"mars_ingress"` assertion, or the "listed only until" assertion, goes red. Then run unmutated:

```bash
cd frontend/apps/web && TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium; echo "e2e exit $?"
```
Expected: both journeys pass, `e2e exit 0`, screenshot written. Record the wall time of the 18-month compute from the Playwright report.

- [ ] **Step 3: Commit**

Invoke `frontend-quality` on the spec file. Then:

```bash
git add frontend/apps/web/e2e/time-travel.spec.ts
git commit -m "test(e2e): an 18-month period reads Mars, the nodes and stations from one engine run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7"
```

---

### Task 10: Full gates, parity, PDF, memory, live drive, northstar, one PR

**Files:** none new. Evidence only.

- [ ] **Step 1: Full gates from the worktree root**

```bash
cd backend && uv run poe gate; echo "backend gate exit $?"
cd ../frontend && bun run gate; echo "frontend gate exit $?"
cd .. && bun test ./tests/*.test.ts; echo "contract exit $?"
```
Expected: every exit 0. Record test counts, coverage and the xenon line (no new B/C blocks). Invoke `python-quality` on `git diff --name-only origin/main -- backend` and `frontend-quality` on `git diff --name-only origin/main -- frontend`.

- [ ] **Step 2: Parity, PDF, memory**

- Browser parity with CHECK 7 (Task 6 Step 5 commands). Expected: exit 0; record the three predictive timings, the 24-month one under 70 s.
- PDF artifact gate (repo CLAUDE.md): `cd frontend/apps/web && bun run report:pdf:sample && node scripts/verify-report-pdf.mjs` and `bun run test:e2e:report:pdf`. The transits timeline table now has more rows; Poppler text must show the last timeline row and the footer bounds must hold in both the Node and the browser-downloaded PDF. Inspect the rendered transits page. A footer overlap is a finding to fix in this PR (with a test), not to waive.
- Memory: `bun run test:e2e:memory-budget` (or the script named in `package.json` for `playwright.memory-budget.config.ts`) must stay green. In the PR, list the payload bytes from Task 5 Step 4 and the RSS from `parity.mjs` if the spike directory was available (else say "unmeasured under Node Pyodide; browser timing from CHECK 7"). State whether tier sizes change (Ruling 10 says no unless the numbers say otherwise).

- [ ] **Step 3: Drive it live**

`cd frontend/apps/web && VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port 4216`. In Playwright Chromium (the MCP_DOCKER browser cannot boot the engine): onboard a chart, open `/predictive` (Sky & Timing) and confirm the timeline shows Mars sign changes and "Saturn turns retrograde in …" lines in English, then switch to Spanish and Portuguese and confirm the same rows are translated. Open chat and ask "How do 2027 and the first half of 2028 look?". With an OpenRouter key on this machine, confirm the answer names the period and mentions a Mars or node change; with no key, say plainly in the PR that the real-model drive is unverified and Task 9's stubbed journey is the evidence. Screenshots plus a clean console for each.

- [ ] **Step 4: Northstar grade**

Dispatch the `northstar` agent (standing approval) on the branch with: claim "CPython/Pyodide parity" (plus "only sanitized facts reach the model" and "the Life Atlas is unchanged"), the mutation table, the CHECK 7 output, the e2e screenshot, the PDF check output, and the gate exits. Fix anything below A, re-run Step 1, re-grade.

- [ ] **Step 5: One PR**

```bash
git push -u origin claude/time-travel-inc-b
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-inc-b \
  --title "feat: time travel Inc B — Mars, nodes and stations; 24-month window" --body-file /tmp/inc-b-pr.md
```

The body states: what ships (the Inc B row); the claim touched ("CPython/Pyodide parity", now enforced for the predictive payload in the CI browser gate); the Rulings list verbatim; the two reversed Inc A contracts (`COVERED_EVENTS` without Mars; the Mars "can change sign" note) and the inverted engine test (Jupiter/Saturn-only ingress); the evidence table (gate exits and counts, CHECK 7 timings, payload bytes, PDF checks, e2e pass and screenshot, live drive or "unverified"); the mutation table (every `KILLED` line from Tasks 1–9 plus the CHECK 7 red line). End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
```

- [ ] **Step 6: Merge and clean up in the same breath**

When CI is green and northstar is A: `gh pr merge --squash --delete-branch`, then `git worktree remove .worktrees/time-travel-inc-b`, `git branch -D claude/time-travel-inc-b`, confirm CI green on `main`, and confirm the deploy serves the merge SHA (`build.json` `git_sha` equals the merge SHA with `content-type: application/json`). Run `dangling_audit.py` before reporting done.

---

## Self-review notes (spec coverage)

| Spec item (Inc B) | Task |
| --- | --- |
| Mars sign changes in the timeline | 3, 4 |
| Rahu/Ketu sign changes | 1 (fast path), 3, 4 |
| `STATION` events for Jupiter, Saturn, Mars | 2, 4 |
| `compute_predictive_contexts(..., window_months=12)`; a 13–24 month period is one compute | 5, 7 |
| `covered_events` widens | 8 |
| "Span over 12 months (until Inc B)" row retired: the app asks for 24 months | 7, 8 |
| Engine producers get pytest coverage | 1–5 |
| CPython/Pyodide parity stays green (and now covers the predictive payload in CI) | 5, 6 |
| Privacy table unchanged; month precision for event dates | 6 (sanitizer), 8 (re-run) |
| Performance: device tiers, LRU sizes, 150 s budget | 5 (bytes), 6 (browser timing), 10 |
| Fast planets stay out of multi-day results | 4 (engine), Inc A filter unchanged |

Known gaps, deliberately not tasks: exact sign-change times inside a day for the UI (events carry instants; the model sees months); Jupiter/Saturn retrograde re-entries under the sticking rule (Spec gaps); the ignored `ayanamsa_type`/`node_type` arguments of `build_timeline` (pre-existing).
