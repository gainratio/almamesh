# Time Travel Increment C (Places) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chat knows when a place matters and asks only then. "How was June 2026? I was in LA the first half, then Bogotá" reads June once and says plainly that the places don't change it. "What about June 15?" reads that day in the home time zone and asks "where were you?" only when the Moon's sign differs across the Earth that day. "Bogotá" is looked up on the device, never online, and the model never sees a coordinate.

**Architecture:** A new Python engine function, `compute_moon_window`, reports the Moon's sign, nakshatra and tithi at the two ends of a calendar day as seen anywhere on Earth (00:00 at UTC+14 and 24:00 at UTC−12). Optionally it also reports them at one place's local start and end of day, and the lagna sign plus Moon at one event instant and place. It reaches the browser as a new worker request, `computeMoonWindow`, next to `computePredictive`, and goes through the CPython/Pyodide parity gate. On the app side, a new `resolve_place` tool calls only the bundled offline city list. It returns a label, an IANA zone and a stateless `place_ref` (`city:<row>`); coordinates never leave the tool layer. `get_timing` gains `place_ref`, `time` and `segments`. Its multi-day path merges segments into one period and notes that place changes nothing. Its single-day `transits` path attaches the moon window and `location_sensitive`.

**Tech Stack:** Python 3.13 engine (Skyfield + DE421, Pydantic, pytest, ruff, mypy strict, xenon), Pyodide worker glue, TypeScript (`@almamesh/llm`, `@almamesh/browser`, `@almamesh/store`, `apps/web`), Vitest, `bun:test` (repo contract tests in `tests/`), Playwright, Dagger.

**Spec:** `docs/superpowers/specs/2026-10-08-time-travel-design.md`. Read: Journey 3; Part 2 (When to ask, The location check for a single day, `resolve_place`, Split periods); the Privacy table (rows "Typed city text", "Place coordinates", "Place lookup network calls"); Performance (`resolve_place` under 100 ms); Error handling (place rows); Testing (rows "Location check", "Offline place lookup", "No coordinates to the model"); the Inc C row: "`resolve_place`, `computeMoonWindow`, `location_sensitive`, `segments`, event-time reads with a place. Claim: 'a chat-typed city never leaves the device'. Journey 3 works."

## Rulings

The spec is silent or self-contradictory on these. Each is a decision this plan makes. The PR body repeats them.

1. **`location_sensitive` is driven by the Moon's sign only.** Nakshatra and tithi are reported at both ends but do not set the flag. By arithmetic they change in every 50-hour window: the Moon's slowest daily motion is about 11.8°, so 50 h is at least 24.6°, which is more than one nakshatra (13.33°). The Moon−Sun elongation grows at least about 10.4°/day, so 50 h is at least 21.7°, more than one tithi (12°). With them in the flag, it would be `true` every day and the chat would ask "where?" for every single-day question, which is the opposite of the spec's intent ("asked only when it matters"). Task 1 pins this with a property test over every day of 2026 and records the Moon-sign base rate in the PR. Even sign-only, the flag is true on most days: a 50 h arc of 24.6–32.1° crosses a 30° sign boundary 82–100% of the time. This is a spec gap Harish should see (see "Spec gaps").
2. **The home zone's name never goes to the model.** Today's egress carries the birth IANA zone (`get_current_datetime` scope `chart`) but never the viewer's zone. Sending `America/Los_Angeles` as "your home time zone" (spec Journey 3, step 3) would be new egress. A single-day result without a place says `place: { "basis": "home_time_zone" }`. The model says "in your home time zone" without naming it. A place the user typed is echoed with its zone, because the user typed the city.
3. **`resolve_place` and every place read exist only where the sky does.** On `lite` and `minimal` (`periodSkyComputeAllowed: false`) every dated question already gets dashas only. There, `resolve_place` is not registered, and `get_timing` ignores `place_ref`, `time` and `segments` places (dashas only, the existing device note). So the 2 MB city list never loads on a weak device. Low-end first.
4. **`place_ref` is stateless: `city:<row index>`.** Tool results are not saved in chat history (`ChatMessage` stores text only), so a ref only has to live for one agent turn. A ref that is the row index of `cities.min.json` needs no closure map, no lifecycle, and nothing stored. It says nothing beyond the label returned with it. `get_timing` re-reads the row offline. An unknown or malformed ref is a tool error, "unknown place_ref: call resolve_place first".
5. **When a lookup counts as "found".** The query's city part is the text before the first comma, folded the same way `cityLookup.ts` folds. Candidates are `searchCitiesOffline`'s results, up to 5. Exactly one candidate whose folded city name equals the folded city part counts as `found`. So does more than one such candidate when the most populous is at least 10× the next one ("Los Angeles": Los Angeles, United States, over Los Ángeles, Chile). Otherwise any candidates are `ambiguous`, and none is `not_found`.
6. **Which `get_timing` calls run the location check:** a dated, single-day `transits` call that passes every existing gate (birth-year sky gate, 2052 cap, device tier) and whose sky loaded. Dashas, domains and strength don't report the Moon, so they don't check. A call with dates omitted ("today") is unchanged from Inc A: no check, no new fields.
7. **The moon window is sky, so it sits behind the sky gates.** A day in or before the birth year gets dashas only, as today, with no moon window, no `time` read and no place values. That covers the "birth instant at the birth place" case: an event read at the birth time is withheld by the existing `startsInOrBeforeBirthYear` gate.
8. **Event-time reads (`time: "HH:MM"`):** only with a single day and a place (`place_ref`, or the one segment covering that day). The local time at the place is turned into a UTC instant by the existing `localTimeToInstant` (`@almamesh/store`). A time that never happened (DST spring-forward) or happened twice (fall-back) is a tool error naming the problem, never a silent guess. The result gives `lagna_sign` and the Moon's sign, nakshatra and tithi at that instant. There are no coordinates and no degrees.
9. **Place bounds on the wire are instants, computed in TypeScript.** Python gets `place_start_utc` and `place_end_utc` (the place's local 00:00 and the next local 00:00, via `resolveLocalTime`). That way the engine needs no tz database under Pyodide. Python refuses bounds that are not 22–26 h apart (DST days are 23 or 25 h), that fall outside the 50 h window, or that come in reverse order. A local midnight that doesn't exist (a DST jump at 00:00) starts the day at the first instant that does (local 01:00).
10. **Segments.** `segments` holds 1–4 `{ start, end, place_ref? }`, in order and not overlapping. Gaps are allowed and noted. Segments can't be combined with `start`/`end`. The merged period is the first `start` through the last `end`, and every existing period rule applies to it. A multi-day result echoes each segment's label and zone (never coordinates) plus the note "Place doesn't change readings for periods longer than a day…". For a single day, the one segment's `place_ref` is the day's place. A `place_ref` argument that disagrees with it is a tool error.
11. **`computeMoonWindow` is not memoized and is a normal (60 s) worker request.** It is under a second of compute. It joins neither the engine memo (`MemoKind` unchanged) nor the long-request timeout set.
12. **Prompt.** A chat-only `PLACE_RULES` block sits next to `PERIOD_RULES`. `PRIVACY_RULE` is unchanged (other prompts share it). `PLACE_RULES` says the privacy rule is about the birth place, and that places the user names may be repeated back.
13. **Tool budget is unchanged.** The split journey is resolve, resolve (round 1), then `get_timing` with segments (round 2), which is 3 calls in 2 rounds and fits `AGENT_LIMITS` (3 calls, 2 per round, 2 rounds). The single-day follow-up with a place is resolve, then `get_timing`. Tool descriptions tell the model to resolve both places in one round.
14. **Status labels follow Inc A's pattern.** These are English constants on the tool, like `get_timing`'s labels: `resolve_place` gets `'Looking up the place on this device'`. If Inc A routed `get_timing` labels through i18n keys by the time this lands, mirror that for en/es/pt in the same task.
15. **City list memory is measured, and gated loosely the first time.** Task 9 records the heap growth of the first lookup and the request that loads the chunk. It gates growth at ≤ 48 MiB on the full tier. If the measured growth exceeds 48 MiB, stop and report; do not raise the gate.

## Spec gaps found

- **The location check as written is always true** (Ruling 1). Nakshatra and tithi change in every 50 h window. Even the Moon's sign changes on most days. The spec's "Moon covers about 28° in 50 hours, less than one sign" is also off: a fast Moon covers about 32°. The no-false-negative argument still holds (both motions only move forward, and the window is far short of 360°). But the flag carries little information, and Harish should decide whether "ask where" should depend on something narrower, such as whether the Moon changes sign during the home zone's own day.
- Journey 3 step 3 has the model name the home zone (`America/Los_Angeles`). That is new egress the privacy rules forbid (Ruling 2).
- `PRIVACY_RULE` ("never mention city/state/country names") contradicts Journey 3's "Were you in LA or Bogotá?" (Ruling 12).
- The spec doesn't say whether the location check runs for "today" (no dates), for non-transit sections, or behind the birth-year gate (Rulings 6 and 7). It also doesn't define ambiguity (Ruling 5), segment validation (Ruling 10), or what happens to places on weak devices (Ruling 3).
- The spec puts coordinates "in the tool closure keyed by a short opaque place_ref". A stateless row-index ref is equivalent and simpler (Ruling 4).
- The cities chunk is fetched from the app origin as an ES module, not by `fetch`. "Zero network" in the browser therefore means no request to any origin other than the app. The first lookup may load the chunk from the origin or the service-worker precache (Task 3 and Task 10 assert this precisely).

## Global Constraints

- Work in `/Users/harish/dev/oss/almamesh/.worktrees/time-travel-c` on branch `claude/time-travel-c` (off `origin/main` at or after `44b885fe`, step B merged). All paths below are relative to it.
- Stage named files only. Never `git add -A` or `git add .`. `docs/superpowers` is gitignored, so plan or spec files need `git add -f`.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
  ```
- **One PR at the end** (Task 11). Tasks commit to the branch.
- **The step A and B privacy rules stay intact and unchanged.** Refuse only a period that ends before 1 January of the birth year (`endsBeforeBirthYear`, constant message). Give no sky for a period that starts in or before the birth year (`startsInOrBeforeBirthYear`, gated on the later of local and UTC birth year); the moon window and event reads are sky (Ruling 7). Send nothing beyond today's egress. **Today's egress about the birth place is: no city, no country, no coordinates; the birth IANA zone only through `get_current_datetime` scope `chart`.** So no tool result in this increment may carry a latitude, a longitude, or any number derived from them, for any place, at any precision. Nothing in the place path reads `birth.birth_location_details`. A resolved place equal to the birth city is echoed only as its label and zone, because the user typed it.
- **No network geocoding from chat.** The place path imports `searchCitiesOffline` (via new row-level helpers in `cityLookup.ts`) and never `searchCities` or `onlineGeocoder.ts`.
- **Engine math lives in Python** (repo CLAUDE.md rule 2): Moon/Sun longitudes, nakshatra, tithi and lagna are Python. TypeScript does calendar and zone arithmetic on strings and instants only.
- **Determinism** (rule 3): `compute_moon_window` takes explicit instants. There are no wall-clock reads.
- **Low-end devices first:** `lite`/`minimal` get dashas only, with no place tool and no city list (Ruling 3). The city list stays a lazy dynamic import, and its memory is measured (Task 9).
- **SQLite only for user data.** Nothing here stores user data. Place refs are stateless, and moon windows are not cached or persisted.
- **Python edits follow `python-quality`:** functions ≤ 15 lines, Radon grade A (xenon must not gain a block), mypy strict, no `Dict[str, Any]`, no `TypedDict`, Pydantic at boundaries, raise rather than swallow. Invoke `python-quality` after every Python task and `frontend-quality` after every TS task.
- **TDD with red runs.** Write the test, run it, see it fail for the stated reason, then implement. Every guard also gets a **mutation red run** with the helper below. Paste each `KILLED` line into the PR's mutation table.
- Commands:
  - Backend single test: `cd backend && uv run pytest tests/<file>.py -q --no-cov`. Backend gate: `cd backend && uv run poe gate`.
  - Package unit: `cd frontend/packages/<pkg> && bunx vitest run <file>`. Web unit: `cd frontend/apps/web && bunx vitest run <file>`. Frontend gate: `cd frontend && bun run gate`.
  - Contract tests: `bun test ./tests/*.test.ts` from the repo root (`bun:test`, not Vitest). **Do not edit or loosen `tests/dagger-ingress-contract.test.ts`.**
- Golden regeneration: `cd backend && uv run python -m tests.fixtures.regen_moon_window_golden` (new, Task 2). Never hand-edit a golden.

Save the mutation helper once as `"${TMPDIR:-/tmp}/almamesh-mutate.py"` and `export MUTATE="${TMPDIR:-/tmp}/almamesh-mutate.py"` (the same helper as Inc A/B):

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

Run mutations from the worktree root with paths relative to it.

## Review Focus

1. **The user types their birth city as the place** ("I was back home in Delhi on the 15th"). The result must carry the label and zone only. No number, nothing from `birth_location_details`, and no degree-level lagna or Moon. Test: Task 8 egress test (birth fixture Delhi 28.61/77.21, `resolve_place("Delhi")` plus `get_timing` with that ref and a `time`).
2. **A DST day at the place.** Bogotá has no DST, but "Los Angeles, 2026-03-08" is a 23 h day, and "2:30 am" on that day never happened. Bounds must be 23 h apart and the time must be a tool error, not a shifted guess. Also a zone whose midnight is skipped (`America/Santiago` 2026-09-06). Tests: Task 6 (`localDayBounds`, `eventInstant`), Task 1 (bounds validation).
3. **Diacritics and qualifiers in the place text.** "Bogota", "BOGOTÁ", "São Paulo" vs "Sao Paulo", "Los Angeles, US", "Springfield" (many). Folding must match, and "Springfield" must come back `ambiguous` with ≤ 5 candidates that each carry a `place_ref`. Test: Task 3.
4. **The model fabricates or mangles a `place_ref`** (`"city:99999999"`, `"bogota"`, a number). This must be a tool error that tells it to call `resolve_place`, never an exception and never a random city. Test: Task 5 (parse) and Task 7 (unknown row).
5. **A weak device.** On `lite`/`minimal` the tool list has no `resolve_place`, the cities chunk is never requested, and a single-day question with a `place_ref` still answers with dashas only and the device note. Tests: Task 7 (toolset), Task 9 (lazy-load source contract).

---

### Task 1: `compute_moon_window` in the engine

**Files:**
- Create: `backend/src/almamesh/transits/moon_window.py`
- Modify: `backend/src/almamesh/edge/chart_runtime.py` (new `compute_moon_window_payload`, after `compute_predictive`)
- Test: `backend/tests/test_moon_window.py`

**Interfaces:**
- Consumes: `transit_longitude(astro, graha, when)` (`transits/positions.py:52`, Lahiri + mean node), `get_nakshatra_info(longitude) -> (name, pada, lord)` (`calculations.py:521`), `SkyfieldAstronomy` (`calculations.py:299`), `SkyfieldAstronomy.calculate_lagna(dt_utc, lat, lon, ayanamsa)` (`calculations.py:500`), `_resolve_ayanamsa(astro, dt_utc, ayanamsa_type)` (`calculations.py:715`), `validate_coordinates` (`calculations.py:207`), `ZodiacSign`, `PlanetName`, `AyanamsaType`.
- Produces:
  - `class MoonMark(BaseModel)`: `sign: ZodiacSign`, `nakshatra: str`, `tithi: int` (1..30), `paksha: Literal["shukla", "krishna"]`.
  - `class MoonEnds(BaseModel)`: `at_start: MoonMark`, `at_end: MoonMark`.
  - `class EventSky(BaseModel)`: `lagna_sign: ZodiacSign`, `moon: MoonMark`.
  - `class MoonWindow(BaseModel)`: `day: date`, `location_sensitive: bool`, `across_earth: MoonEnds`, `at_place: MoonEnds | None`, `event: EventSky | None`.
  - `class EventPoint(BaseModel)`: `when: datetime`, `latitude: float`, `longitude: float`.
  - `tithi_number(moon_lon: float, sun_lon: float) -> int`
  - `earth_day_bounds(day: date) -> tuple[datetime, datetime]`
  - `compute_moon_window(day: date, *, place_bounds: tuple[datetime, datetime] | None = None, event: EventPoint | None = None, astronomy: SkyfieldAstronomy | None = None) -> MoonWindow`
  - `moon_window_from_wire(payload: Mapping[str, object]) -> MoonWindow` (snake_case keys: `day`, `place_start_utc`, `place_end_utc`, `event` = `{datetime_utc, latitude, longitude}` or absent/None)
  - `chart_runtime.compute_moon_window_payload(payload) -> dict[str, JsonValue]`

- [ ] **Step 1: Find the fixture days with a scan (evidence, not code)**

Run this one-off from `backend/` and paste the output into the PR. It picks the pinned days below.

```bash
cd backend && uv run python - <<'PY'
from datetime import UTC, date, datetime, timedelta
from almamesh.calculations import SkyfieldAstronomy
from almamesh.constants.astrology import PlanetName
from almamesh.transits.positions import transit_longitude
astro = SkyfieldAstronomy()
def sign(when): return int(transit_longitude(astro, PlanetName.MOON, when) // 30)
quiet, flips = [], 0
day = date(2026, 1, 1)
while day.year == 2026:
    s = datetime(day.year, day.month, day.day, tzinfo=UTC) - timedelta(hours=14)
    e = datetime(day.year, day.month, day.day, tzinfo=UTC) + timedelta(hours=36)
    if sign(s) == sign(e): quiet.append(day.isoformat())
    else: flips += 1
    day += timedelta(days=1)
print("sensitive days 2026:", flips, "of 365; quiet:", quiet[:12])
s = datetime(2026, 6, 15, tzinfo=UTC) - timedelta(hours=14)
print("2026-06-15 sensitive:", sign(s) != sign(s + timedelta(hours=50)))
PY
```

Record `QUIET_DAY` = the first quiet day after 2026-06-01 and `SENSITIVE_DAY` = the first sensitive day after 2026-06-01. Write both into the test below in place of the two `"<from scan>"` literals. Also record whether 2026-06-15 is sensitive; Task 10 reads it from the golden, not from this note.

- [ ] **Step 2: Write the failing tests**

`backend/tests/test_moon_window.py`:

```python
"""compute_moon_window: the Moon at the two ends of a day anywhere on Earth (spec 2026-10-08 Part 2)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from almamesh.edge.chart_runtime import compute_moon_window_payload
from almamesh.transits.moon_window import (
    EventPoint,
    compute_moon_window,
    earth_day_bounds,
    moon_window_from_wire,
    tithi_number,
)

QUIET_DAY = date.fromisoformat("<from scan>")
SENSITIVE_DAY = date.fromisoformat("<from scan>")
BOGOTA = (4.711, -74.0721)


def test_earth_day_bounds_are_utc_plus_14_midnight_to_utc_minus_12_midnight() -> None:
    start, end = earth_day_bounds(date(2026, 6, 15))
    assert start == datetime(2026, 6, 14, 10, tzinfo=UTC)
    assert end == datetime(2026, 6, 16, 12, tzinfo=UTC)
    assert end - start == timedelta(hours=50)


@pytest.mark.parametrize(
    ("moon", "sun", "expected"),
    [(0.0, 0.0, 1), (11.999, 0.0, 1), (12.0, 0.0, 2), (180.0, 0.0, 16), (359.9, 0.0, 30), (5.0, 350.0, 2)],
)
def test_tithi_number_counts_twelve_degree_steps_of_moon_minus_sun(moon: float, sun: float, expected: int) -> None:
    assert tithi_number(moon, sun) == expected


def test_a_quiet_day_is_not_location_sensitive() -> None:
    window = compute_moon_window(QUIET_DAY)
    assert window.location_sensitive is False
    assert window.across_earth.at_start.sign == window.across_earth.at_end.sign


def test_a_day_with_a_moon_sign_change_is_location_sensitive() -> None:
    window = compute_moon_window(SENSITIVE_DAY)
    assert window.location_sensitive is True
    assert window.across_earth.at_start.sign != window.across_earth.at_end.sign


def test_nakshatra_and_tithi_always_change_inside_fifty_hours_so_they_do_not_drive_the_flag() -> None:
    # Ruling 1: pinned so nobody "fixes" the flag into a constant True.
    window = compute_moon_window(QUIET_DAY)
    assert window.across_earth.at_start.nakshatra != window.across_earth.at_end.nakshatra
    assert window.across_earth.at_start.tithi != window.across_earth.at_end.tithi
    assert window.location_sensitive is False


def test_paksha_follows_tithi() -> None:
    mark = compute_moon_window(QUIET_DAY).across_earth.at_start
    assert mark.paksha == ("shukla" if mark.tithi <= 15 else "krishna")


def test_place_bounds_give_values_at_the_local_day() -> None:
    start = datetime(2026, 6, 15, 5, tzinfo=UTC)  # Bogotá 00:00 (UTC-5)
    window = compute_moon_window(date(2026, 6, 15), place_bounds=(start, start + timedelta(hours=24)))
    assert window.at_place is not None
    assert window.at_place.at_start.sign in {window.across_earth.at_start.sign, window.across_earth.at_end.sign}


@pytest.mark.parametrize(
    ("offset_hours", "length_hours"),
    [(5, 21), (5, 27), (-20, 24), (30, 24)],
)
def test_place_bounds_outside_the_day_or_not_a_day_long_are_refused(offset_hours: int, length_hours: int) -> None:
    start = datetime(2026, 6, 15, tzinfo=UTC) + timedelta(hours=offset_hours)
    with pytest.raises(ValueError, match="place day"):
        compute_moon_window(date(2026, 6, 15), place_bounds=(start, start + timedelta(hours=length_hours)))


def test_reversed_place_bounds_are_refused() -> None:
    start = datetime(2026, 6, 15, 5, tzinfo=UTC)
    with pytest.raises(ValueError, match="place day"):
        compute_moon_window(date(2026, 6, 15), place_bounds=(start + timedelta(hours=24), start))


def test_event_reports_lagna_sign_and_moon_without_degrees() -> None:
    when = datetime(2026, 6, 15, 20, tzinfo=UTC)  # 15:00 in Bogotá
    window = compute_moon_window(date(2026, 6, 15), event=EventPoint(when=when, latitude=BOGOTA[0], longitude=BOGOTA[1]))
    assert window.event is not None
    dumped = window.model_dump(mode="json")
    assert set(dumped["event"]) == {"lagna_sign", "moon"}
    assert not any(isinstance(v, float) for v in dumped["event"]["moon"].values())


def test_event_outside_the_day_is_refused() -> None:
    when = datetime(2026, 6, 20, tzinfo=UTC)
    with pytest.raises(ValueError, match="event"):
        compute_moon_window(date(2026, 6, 15), event=EventPoint(when=when, latitude=BOGOTA[0], longitude=BOGOTA[1]))


def test_event_with_impossible_coordinates_is_refused() -> None:
    when = datetime(2026, 6, 15, 20, tzinfo=UTC)
    with pytest.raises(ValueError):
        compute_moon_window(date(2026, 6, 15), event=EventPoint(when=when, latitude=95.0, longitude=0.0))


@pytest.mark.parametrize("day", ["1899-12-31", "2053-01-01", "2026-02-30", "2026-6-1", 20260615, None])
def test_wire_refuses_days_outside_the_ephemeris_or_malformed(day: object) -> None:
    with pytest.raises(ValueError, match="day"):
        moon_window_from_wire({"day": day})


def test_wire_and_direct_call_agree_and_the_edge_entry_dumps_json() -> None:
    payload = {
        "day": "2026-06-15",
        "place_start_utc": "2026-06-15T05:00:00+00:00",
        "place_end_utc": "2026-06-16T05:00:00+00:00",
        "event": {"datetime_utc": "2026-06-15T20:00:00+00:00", "latitude": BOGOTA[0], "longitude": BOGOTA[1]},
    }
    direct = compute_moon_window(
        date(2026, 6, 15),
        place_bounds=(datetime(2026, 6, 15, 5, tzinfo=UTC), datetime(2026, 6, 16, 5, tzinfo=UTC)),
        event=EventPoint(when=datetime(2026, 6, 15, 20, tzinfo=UTC), latitude=BOGOTA[0], longitude=BOGOTA[1]),
    )
    assert moon_window_from_wire(payload) == direct
    assert compute_moon_window_payload(payload) == direct.model_dump(mode="json")


def test_wire_refuses_naive_instants() -> None:
    with pytest.raises(ValueError, match="UTC"):
        moon_window_from_wire({"day": "2026-06-15", "place_start_utc": "2026-06-15T05:00:00", "place_end_utc": "2026-06-16T05:00:00+00:00"})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd backend && uv run pytest tests/test_moon_window.py -q --no-cov`
Expected: collection error `ModuleNotFoundError: No module named 'almamesh.transits.moon_window'`.

- [ ] **Step 4: Implement**

`backend/src/almamesh/transits/moon_window.py`:

```python
"""The Moon at the two ends of a calendar day, anywhere on Earth (spec 2026-10-08 Part 2).

A calendar day starts first at UTC+14 and ends last at UTC-12: a 50-hour window.
The Moon's longitude and the Moon-Sun angle only grow, and 50 hours is far short
of a full cycle, so equal values at both ends mean equal values everywhere that
day. Only the Moon's SIGN drives ``location_sensitive``: nakshatra (13.33 deg) and
tithi (12 deg of elongation) change inside every 50-hour window (plan Ruling 1).
Lahiri sidereal, mean node, like the rest of the timeline.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict

from almamesh.calculations import SkyfieldAstronomy, _resolve_ayanamsa, get_nakshatra_info, validate_coordinates
from almamesh.constants.astrology import AyanamsaType, PlanetName, ZodiacSign
from almamesh.transits.positions import transit_longitude

_EARLIEST_ZONE = timedelta(hours=14)
_LATEST_ZONE = timedelta(hours=12)
_MIN_DAY = timedelta(hours=22)
_MAX_DAY = timedelta(hours=26)
_FIRST_DAY = date(1900, 1, 1)
_LAST_DAY = date(2052, 12, 31)
_SIGNS = list(ZodiacSign)


class MoonMark(BaseModel):
    model_config = ConfigDict(frozen=True)
    sign: ZodiacSign
    nakshatra: str
    tithi: int
    paksha: Literal["shukla", "krishna"]


class MoonEnds(BaseModel):
    model_config = ConfigDict(frozen=True)
    at_start: MoonMark
    at_end: MoonMark


class EventPoint(BaseModel):
    model_config = ConfigDict(frozen=True)
    when: datetime
    latitude: float
    longitude: float


class EventSky(BaseModel):
    model_config = ConfigDict(frozen=True)
    lagna_sign: ZodiacSign
    moon: MoonMark


class MoonWindow(BaseModel):
    model_config = ConfigDict(frozen=True)
    day: date
    location_sensitive: bool
    across_earth: MoonEnds
    at_place: MoonEnds | None = None
    event: EventSky | None = None


def tithi_number(moon_lon: float, sun_lon: float) -> int:
    """Tithi 1..30: whole 12-degree steps of the Moon-Sun angle, plus one."""
    return int(((moon_lon - sun_lon) % 360.0) // 12.0) + 1


def earth_day_bounds(day: date) -> tuple[datetime, datetime]:
    """00:00 of ``day`` at UTC+14 and 24:00 of ``day`` at UTC-12, as UTC instants."""
    midnight = datetime(day.year, day.month, day.day, tzinfo=UTC)
    return midnight - _EARLIEST_ZONE, midnight + timedelta(days=1) + _LATEST_ZONE


def _sign_of(longitude: float) -> ZodiacSign:
    return _SIGNS[int((longitude % 360.0) // 30.0)]


def _moon_mark(astro: SkyfieldAstronomy, when: datetime) -> MoonMark:
    moon = transit_longitude(astro, PlanetName.MOON, when)
    tithi = tithi_number(moon, transit_longitude(astro, PlanetName.SUN, when))
    nakshatra, _pada, _lord = get_nakshatra_info(moon)
    return MoonMark(sign=_sign_of(moon), nakshatra=nakshatra, tithi=tithi, paksha="shukla" if tithi <= 15 else "krishna")


def _ends(astro: SkyfieldAstronomy, bounds: tuple[datetime, datetime]) -> MoonEnds:
    return MoonEnds(at_start=_moon_mark(astro, bounds[0]), at_end=_moon_mark(astro, bounds[1]))


def _checked_place_bounds(day: date, bounds: tuple[datetime, datetime]) -> tuple[datetime, datetime]:
    earliest, latest = earth_day_bounds(day)
    start, end = bounds
    inside = earliest <= start and end <= latest
    if not inside or not _MIN_DAY <= end - start <= _MAX_DAY:
        raise ValueError("invalid place day: bounds must be one local day inside the 50-hour window")
    return bounds


def _event_sky(astro: SkyfieldAstronomy, day: date, event: EventPoint) -> EventSky:
    earliest, latest = earth_day_bounds(day)
    if not earliest <= event.when <= latest:
        raise ValueError("invalid event: the instant is not on that day anywhere on Earth")
    validate_coordinates(event.latitude, event.longitude)
    ayanamsa = _resolve_ayanamsa(astro, event.when, AyanamsaType.LAHIRI)
    lagna = astro.calculate_lagna(event.when, event.latitude, event.longitude, ayanamsa)
    return EventSky(lagna_sign=_sign_of(lagna), moon=_moon_mark(astro, event.when))


def compute_moon_window(
    day: date,
    *,
    place_bounds: tuple[datetime, datetime] | None = None,
    event: EventPoint | None = None,
    astronomy: SkyfieldAstronomy | None = None,
) -> MoonWindow:
    """The Moon at both ends of ``day`` everywhere, optionally at one place's day and one event."""
    astro = astronomy if astronomy is not None else SkyfieldAstronomy()
    across = _ends(astro, earth_day_bounds(day))
    at_place = None if place_bounds is None else _ends(astro, _checked_place_bounds(day, place_bounds))
    return MoonWindow(
        day=day,
        location_sensitive=across.at_start.sign != across.at_end.sign,
        across_earth=across,
        at_place=at_place,
        event=None if event is None else _event_sky(astro, day, event),
    )
```

Then the wire helpers in the same file (each ≤ 15 lines):

```python
def _wire_day(value: object) -> date:
    if not isinstance(value, str) or len(value) != 10:
        raise ValueError("invalid day: must be YYYY-MM-DD")
    try:
        day = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("invalid day: must be a real calendar day") from error
    if not _FIRST_DAY <= day <= _LAST_DAY:
        raise ValueError("invalid day: outside the on-device ephemeris (1900..2052)")
    return day


def _wire_instant(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"invalid {field}: must be an ISO 8601 UTC instant")
    when = datetime.fromisoformat(value)
    if when.utcoffset() != timedelta(0):
        raise ValueError(f"invalid {field}: must be a UTC instant")
    return when


def _wire_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"invalid {field}: must be a number")
    return float(value)


def _wire_event(value: object) -> EventPoint | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("invalid event: must be an object")
    return EventPoint(
        when=_wire_instant(value.get("datetime_utc"), "event datetime_utc"),
        latitude=_wire_number(value.get("latitude"), "event latitude"),
        longitude=_wire_number(value.get("longitude"), "event longitude"),
    )


def _wire_bounds(payload: Mapping[str, object]) -> tuple[datetime, datetime] | None:
    start, end = payload.get("place_start_utc"), payload.get("place_end_utc")
    if start is None and end is None:
        return None
    return _wire_instant(start, "place_start_utc"), _wire_instant(end, "place_end_utc")


def moon_window_from_wire(payload: Mapping[str, object]) -> MoonWindow:
    """Shared by the CPython edge runtime and the Pyodide worker glue so both refuse the same inputs."""
    return compute_moon_window(
        _wire_day(payload.get("day")),
        place_bounds=_wire_bounds(payload),
        event=_wire_event(payload.get("event")),
    )
```

The message `"must be a UTC instant"` matches the test's `match="UTC"`. A naive string has `utcoffset() is None`, which `!= timedelta(0)`.

In `backend/src/almamesh/edge/chart_runtime.py`, after `compute_predictive`:

```python
def compute_moon_window_payload(payload: Mapping[str, object]) -> dict[str, JsonValue]:
    """The Moon at the two ends of a day anywhere on Earth (and optionally at a place/event).

    Snake_case wire keys: ``day``, ``place_start_utc``, ``place_end_utc``, ``event``.
    The Pyodide worker glue maps its camelCase input onto the same validator.
    """
    return moon_window_from_wire(payload).model_dump(mode="json")
```

with `from almamesh.transits.moon_window import moon_window_from_wire` at the top. If `validate_coordinates` raises something other than `ValueError`, wrap the call in `_event_sky` so it raises `ValueError("invalid event: coordinates out of range")` from it. Keep the test's `pytest.raises(ValueError)`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd backend && uv run pytest tests/test_moon_window.py -q --no-cov`
Expected: all pass.

- [ ] **Step 6: Mutation red runs**

```bash
python3 "$MUTATE" backend/src/almamesh/transits/moon_window.py 'location_sensitive=across.at_start.sign != across.at_end.sign' 'location_sensitive=across.at_start.sign != across.at_start.sign' -- bash -c 'cd backend && uv run pytest tests/test_moon_window.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/moon_window.py '_EARLIEST_ZONE = timedelta(hours=14)' '_EARLIEST_ZONE = timedelta(hours=0)' -- bash -c 'cd backend && uv run pytest tests/test_moon_window.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/moon_window.py 'if not inside or not _MIN_DAY' 'if False and not _MIN_DAY' -- bash -c 'cd backend && uv run pytest tests/test_moon_window.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/moon_window.py '_LAST_DAY = date(2052, 12, 31)' '_LAST_DAY = date(2099, 12, 31)' -- bash -c 'cd backend && uv run pytest tests/test_moon_window.py -q --no-cov'
python3 "$MUTATE" backend/src/almamesh/transits/moon_window.py 'if not earliest <= event.when <= latest:' 'if False:' -- bash -c 'cd backend && uv run pytest tests/test_moon_window.py -q --no-cov'
```
Expected: five `KILLED` lines (the first is "compare only one end", the spec's mutation for the location check).

- [ ] **Step 7: Quality and commit**

Run `cd backend && uv run poe lint`, then invoke `python-quality` on the two changed files.

```bash
git add backend/src/almamesh/transits/moon_window.py backend/src/almamesh/edge/chart_runtime.py backend/tests/test_moon_window.py
git commit -m "feat(engine): compute_moon_window — Moon sign, nakshatra, tithi across a day; place and event reads"
```

---

### Task 2: `computeMoonWindow` in the worker, a golden, and the browser parity check

**Files:**
- Create: `backend/tests/test_moon_window_golden.py`, `backend/tests/fixtures/regen_moon_window_golden.py`, `backend/tests/fixtures/moon_window_golden_de421.json` (generated)
- Modify: `frontend/packages/browser/src/pyodide/protocol.ts` (`MoonWindowInput`, `MoonMark`, `MoonEnds`, `MoonWindow`, `ComputeMoonWindowRequest`, `MoonWindowOk`, unions)
- Modify: `frontend/packages/browser/src/pyodide/chartWorker.ts` (`PY_BOOTSTRAP` glue `_almamesh_compute_moon_window`, TS wrapper, dispatch branch before the `generateChart` fallthrough)
- Modify: `frontend/packages/browser/src/pyodide/chartEngineClient.ts` (`computeMoonWindow`)
- Modify: `frontend/packages/browser/src/pyodide/runtime.ts` (`ChartEnginePort`, `ChartEngine`, the `memoizeChartEngine({...})` object at :337-345: pass-through)
- Modify: `frontend/packages/browser/src/pyodide/engineMemo.ts` (pass `computeMoonWindow` straight through, like mesh/rectification at :130-131)
- Modify: `frontend/packages/browser/src/types.ts` (public `ChartEngine` mirror)
- Modify: test doubles that implement `ChartEngine`: `packages/browser/src/__tests__/{engineMemo,chartEngineClient,runtime}.test.ts`, `packages/store/src/rectification.test.ts`, `apps/web/src/hooks/useRectification.test.tsx` (add `computeMoonWindow: vi.fn()`)
- Modify: `frontend/apps/web/src/lib/runtimeObservability.ts` (`__almameshComputeMoonWindow` hook) and the provider that publishes `__almameshComputePredictive` (`AlmaMeshRuntimeProvider.tsx:123`, same exit-gate condition)
- Modify: `frontend/apps/web/scripts/verify-browser-parity.mjs` (CHECK 8)
- Modify: `backend/tests/test_chart_worker_glue.py` (exec the new glue under CPython)
- Test: `frontend/packages/browser/src/__tests__/chartEngineClient.test.ts`

**Interfaces:**
- Consumes: Task 1 `moon_window_from_wire`, `MoonWindow` JSON shape.
- Produces (TS, `protocol.ts`, re-exported wherever `PredictiveInput` is):
  ```ts
  export interface MoonWindowEvent { readonly datetimeUtc: string; readonly latitude: number; readonly longitude: number; }
  export interface MoonWindowInput {
    readonly day: string;                 // YYYY-MM-DD
    readonly placeStartUtc?: string;      // ISO UTC instant, with placeEndUtc
    readonly placeEndUtc?: string;
    readonly event?: MoonWindowEvent;
  }
  export interface MoonMark { readonly sign: string; readonly nakshatra: string; readonly tithi: number; readonly paksha: 'shukla' | 'krishna'; }
  export interface MoonEnds { readonly at_start: MoonMark; readonly at_end: MoonMark; }
  export interface MoonWindow {
    readonly day: string;
    readonly location_sensitive: boolean;
    readonly across_earth: MoonEnds;
    readonly at_place: MoonEnds | null;
    readonly event: { readonly lagna_sign: string; readonly moon: MoonMark } | null;
  }
  ```
  `ChartEngine.computeMoonWindow(input: MoonWindowInput): Promise<MoonWindow>`.

- [ ] **Step 1: Golden test first (red)**

`backend/tests/test_moon_window_golden.py`:

```python
"""Golden for compute_moon_window; the browser parity gate (CHECK 8) compares Pyodide to it."""

from __future__ import annotations

import json
from pathlib import Path

from almamesh.edge.chart_runtime import compute_moon_window_payload

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "moon_window_golden_de421.json"


def golden_cases() -> dict[str, dict[str, object]]:
    """Keys MUST equal MOON_WINDOW_FIXTURES in apps/web/scripts/verify-browser-parity.mjs."""
    return {
        "quiet": {"day": "<QUIET_DAY from Task 1>"},
        "sensitive": {"day": "<SENSITIVE_DAY from Task 1>"},
        "2026-06-15": {"day": "2026-06-15"},
        "2026-06-15@bogota": {
            "day": "2026-06-15",
            "place_start_utc": "2026-06-15T05:00:00+00:00",
            "place_end_utc": "2026-06-16T05:00:00+00:00",
            "event": {"datetime_utc": "2026-06-15T20:00:00+00:00", "latitude": 4.711, "longitude": -74.0721},
        },
    }


def test_moon_window_matches_golden() -> None:
    golden = json.loads(GOLDEN_PATH.read_text())
    actual = {key: compute_moon_window_payload(case) for key, case in golden_cases().items()}
    assert actual == golden
```

`backend/tests/fixtures/regen_moon_window_golden.py`:

```python
"""Regenerate moon_window_golden_de421.json: uv run python -m tests.fixtures.regen_moon_window_golden"""

import json

from almamesh.edge.chart_runtime import compute_moon_window_payload
from tests.test_moon_window_golden import GOLDEN_PATH, golden_cases


def main() -> None:
    golden = {key: compute_moon_window_payload(case) for key, case in golden_cases().items()}
    GOLDEN_PATH.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
```

Run: `cd backend && uv run pytest tests/test_moon_window_golden.py -q --no-cov`
Expected: FAIL with `FileNotFoundError` on the golden. Then generate it with `uv run python -m tests.fixtures.regen_moon_window_golden` and re-run. Expected: PASS. Check that the `quiet` case shows `"location_sensitive": false` and `sensitive` shows `true`.

- [ ] **Step 2: Worker glue under CPython (red)**

In `backend/tests/test_chart_worker_glue.py`, next to the predictive glue test (around L208), add:

```python
def test_moon_window_glue_maps_camel_case_onto_the_shared_validator(namespace: dict[str, object]) -> None:
    glue = namespace["_almamesh_compute_moon_window"]
    camel = {
        "day": "2026-06-15",
        "placeStartUtc": "2026-06-15T05:00:00+00:00",
        "placeEndUtc": "2026-06-16T05:00:00+00:00",
        "event": {"datetimeUtc": "2026-06-15T20:00:00+00:00", "latitude": 4.711, "longitude": -74.0721},
    }
    golden = json.loads(GOLDEN_PATH.read_text())["2026-06-15@bogota"]
    assert json.loads(glue(json.dumps(camel))) == golden


def test_moon_window_glue_without_place_or_event(namespace: dict[str, object]) -> None:
    glue = namespace["_almamesh_compute_moon_window"]
    golden = json.loads(GOLDEN_PATH.read_text())["2026-06-15"]
    assert json.loads(glue(json.dumps({"day": "2026-06-15"}))) == golden
```

Reuse whatever fixture name the file already uses for the exec'd `PY_BOOTSTRAP` namespace (L60/L89/L207). Import `GOLDEN_PATH` from `tests.test_moon_window_golden`.
Run: `cd backend && uv run pytest tests/test_chart_worker_glue.py -q --no-cov`. Expected: FAIL with `KeyError: '_almamesh_compute_moon_window'`.

- [ ] **Step 3: Add the glue to `PY_BOOTSTRAP`** (`chartWorker.ts`, after `_almamesh_compute_predictive`)

```python
def _almamesh_compute_moon_window(input_json):
    from almamesh.transits.moon_window import moon_window_from_wire
    data = json.loads(input_json)
    event = data.get("event")
    return json.dumps(moon_window_from_wire({
        "day": data.get("day"),
        "place_start_utc": data.get("placeStartUtc"),
        "place_end_utc": data.get("placeEndUtc"),
        "event": None if event is None else {
            "datetime_utc": event.get("datetimeUtc"),
            "latitude": event.get("latitude"),
            "longitude": event.get("longitude"),
        },
    }).model_dump(mode="json"))
```

The lazy import keeps an older wheel booting. Re-run Step 2's command. Expected: PASS.

- [ ] **Step 4: Client test (red), then the TS plumbing**

In `packages/browser/src/__tests__/chartEngineClient.test.ts`, following the file's existing `computePredictive` round-trip test (same fake-worker helper):

```ts
it('computeMoonWindow sends a computeMoonWindow request and returns the window', async () => {
  const window = { day: '2026-06-15', location_sensitive: true, across_earth: MARKS, at_place: null, event: null };
  const { client, worker } = clientWithFakeWorker();
  const pending = client.computeMoonWindow({ day: '2026-06-15' });
  const request = worker.lastRequest();
  expect(request).toMatchObject({ kind: 'computeMoonWindow', input: { day: '2026-06-15' } });
  worker.reply({ ok: true, kind: 'computeMoonWindow', id: request.id, moonWindow: window });
  await expect(pending).resolves.toEqual(window);
});

it('computeMoonWindow surfaces a worker error', async () => {
  const { client, worker } = clientWithFakeWorker();
  const pending = client.computeMoonWindow({ day: '2053-01-01' });
  worker.reply({ ok: false, id: worker.lastRequest().id, error: 'invalid day: outside the on-device ephemeris (1900..2052)' });
  await expect(pending).rejects.toThrow('invalid day');
});
```

Use the file's own fake-worker helper names. If they differ from `clientWithFakeWorker`/`lastRequest`/`reply`, adapt the calls, not the assertions. `MARKS` is a local constant `{ at_start: MARK, at_end: MARK }` with `MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' }`.
Run: `cd frontend/packages/browser && bunx vitest run src/__tests__/chartEngineClient.test.ts`. Expected: FAIL with `client.computeMoonWindow is not a function`.

Implement:
- `protocol.ts`: the types in **Interfaces**, plus
  ```ts
  export interface ComputeMoonWindowRequest { readonly kind: "computeMoonWindow"; readonly id: number; readonly input: MoonWindowInput; }
  export interface MoonWindowOk { readonly ok: true; readonly kind: "computeMoonWindow"; readonly id: number; readonly moonWindow: MoonWindow; }
  ```
  added to `ChartWorkerRequest` and `ChartWorkerResponse`.
- `chartWorker.ts`: `interface PyMoonWindowFn { (inputJson: string): string; destroy(): void; }`, then
  ```ts
  function computeMoonWindow(input: MoonWindowInput): MoonWindow {
    if (enginePyodide === undefined) { throw new Error("chart worker not booted"); }
    const fn = enginePyodide.globals.get("_almamesh_compute_moon_window") as unknown as PyMoonWindowFn;
    try { return JSON.parse(fn(JSON.stringify(input))) as MoonWindow; } finally { fn.destroy(); }
  }
  ```
  and in `handle`, before the `generateChart` fallthrough:
  ```ts
      if (request.kind === "computeMoonWindow") {
        return { ok: true, kind: "computeMoonWindow", id: request.id, moonWindow: computeMoonWindow(request.input) };
      }
  ```
- `chartEngineClient.ts`:
  ```ts
    public async computeMoonWindow(input: MoonWindowInput): Promise<MoonWindow> {
      const response = await this.#send({ kind: "computeMoonWindow", id: this.#allocId(), input });
      if (response.ok && response.kind === "computeMoonWindow") { return response.moonWindow; }
      throw new Error(response.ok ? "unexpected response kind" : response.error);
    }
  ```
  Do not add it to the long-request kinds (Ruling 11).
- `runtime.ts`: add `computeMoonWindow(input: MoonWindowInput): Promise<MoonWindow>` to `ChartEnginePort` and `ChartEngine`, and `computeMoonWindow: (input) => booted.computeMoonWindow(input),` in the object passed to `memoizeChartEngine`. `engineMemo.ts` passes it through unmemoized. `types.ts` mirrors the method so it stays structurally identical.
- Add `computeMoonWindow: vi.fn()` to every test double listed under **Files** so `tsc` stays green.

Run: `cd frontend/packages/browser && bunx vitest run src/__tests__/chartEngineClient.test.ts && bunx tsc --noEmit -p .`. Expected: PASS, exit 0.

- [ ] **Step 5: Exit-gate hook and CHECK 8**

`runtimeObservability.ts`: add `export type RuntimeMoonWindowComputer = ChartEngine['computeMoonWindow']`, `__almameshComputeMoonWindow?: RuntimeMoonWindowComputer` on `Window`, and `publishRuntimeMoonWindow`/`clearRuntimeMoonWindow`, mirroring `publishRuntimePredictive`. Call them in the provider exactly where `publishRuntimePredictive`/`clearRuntimePredictive` are called, under the same `VITE_EXIT_GATE_HOOKS` condition.

In `verify-browser-parity.mjs`, after CHECK 7, add CHECK 8. It mirrors CHECK 7's structure: a fixture map whose keys equal the golden's keys, a hook-present check, canonicalize, deepEqual, firstDiff, and `record(...)`:

```js
    // Pins MUST match backend/tests/test_moon_window_golden.py golden_cases() (camelCase here).
    const MOON_WINDOW_FIXTURES = {
      quiet: { day: '<QUIET_DAY>' },
      sensitive: { day: '<SENSITIVE_DAY>' },
      '2026-06-15': { day: '2026-06-15' },
      '2026-06-15@bogota': {
        day: '2026-06-15',
        placeStartUtc: '2026-06-15T05:00:00+00:00',
        placeEndUtc: '2026-06-16T05:00:00+00:00',
        event: { datetimeUtc: '2026-06-15T20:00:00+00:00', latitude: 4.711, longitude: -74.0721 },
      },
    }
    const moonGolden = JSON.parse(readFileSync(join(REPO_ROOT, 'backend/tests/fixtures/moon_window_golden_de421.json'), 'utf8'))
    const hasMoon = await page.evaluate(() => typeof window.__almameshComputeMoonWindow === 'function')
    let moonMismatches = hasMoon ? 0 : 1
    if (!hasMoon) console.log('   [FAIL] __almameshComputeMoonWindow=ABSENT (build without VITE_EXIT_GATE_HOOKS=1?)')
    if (Object.keys(moonGolden).sort().join('|') !== Object.keys(MOON_WINDOW_FIXTURES).sort().join('|')) {
      moonMismatches += 1
      console.log('   [FAIL] moon-window golden keys != fixtures')
    }
    for (const key of hasMoon ? Object.keys(MOON_WINDOW_FIXTURES).sort() : []) {
      let payload = null
      try {
        payload = await page.evaluate((arg) => window.__almameshComputeMoonWindow(arg), MOON_WINDOW_FIXTURES[key])
      } catch (e) {
        moonMismatches += 1
        console.log(`   [FAIL] moon window ${key} — threw: ${String(e)}`)
        continue
      }
      const expected = canonicalize(moonGolden[key])
      const actual = canonicalize(payload)
      if (deepEqual(actual, expected)) console.log(`   [ok]   moon window ${key} byte-identical`)
      else {
        moonMismatches += 1
        const d = firstDiff(expected, actual)
        console.log(`   [FAIL] moon window ${key} DIVERGED at ${d.path}: cpython=${JSON.stringify(d.golden)} browser=${JSON.stringify(d.browser)}`)
      }
    }
    const sensitivityControl = moonGolden.quiet?.location_sensitive === false && moonGolden.sensitive?.location_sensitive === true
    if (!sensitivityControl) { moonMismatches += 1; console.log('   [FAIL] golden lost its quiet/sensitive control pair') }
    record('CHECK 8 — moon window byte-identical to the CPython golden', moonMismatches === 0, `cases=${Object.keys(MOON_WINDOW_FIXTURES).length} mismatches=${moonMismatches}`)
```

Run it the way CI does, from `frontend/apps/web`: `VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 bun run build`, serve on 4199, then `node scripts/verify-browser-parity.mjs --reference-date=2025-01-01T00:00:00+00:00` (same flags as `dagger/src/index.ts:493`). Expected: CHECK 8 `[ok]` on all four and exit 0.

- [ ] **Step 6: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/browser/src/pyodide/chartWorker.ts '"place_start_utc": data.get("placeStartUtc"),' '"place_start_utc": None,' -- bash -c 'cd backend && uv run pytest tests/test_chart_worker_glue.py -q --no-cov'
python3 "$MUTATE" frontend/packages/browser/src/pyodide/chartEngineClient.ts 'kind: "computeMoonWindow", id' 'kind: "computePredictive", id' -- bash -c 'cd frontend/packages/browser && bunx vitest run src/__tests__/chartEngineClient.test.ts'
```

CHECK 8 red: edit the built golden copy, not the source. Run the gate with `backend/tests/fixtures/moon_window_golden_de421.json` temporarily changed so the `quiet` case's `at_start.tithi` is off by one: `python3 "$MUTATE" backend/tests/fixtures/moon_window_golden_de421.json '"tithi": <value>' '"tithi": <value+1>' -- node frontend/apps/web/scripts/verify-browser-parity.mjs --reference-date=2025-01-01T00:00:00+00:00`. Pick a `"tithi": N` string that occurs once; if every value repeats, mutate the `"day"` of `quiet` instead. Expected: `KILLED` (CHECK 8 FAIL, exit non-zero).

- [ ] **Step 7: Quality and commit**

Run `frontend-quality` and `python-quality` on the changed files.

```bash
git add backend/tests/test_moon_window_golden.py backend/tests/fixtures/regen_moon_window_golden.py backend/tests/fixtures/moon_window_golden_de421.json backend/tests/test_chart_worker_glue.py \
  frontend/packages/browser/src/pyodide/protocol.ts frontend/packages/browser/src/pyodide/chartWorker.ts frontend/packages/browser/src/pyodide/chartEngineClient.ts \
  frontend/packages/browser/src/pyodide/runtime.ts frontend/packages/browser/src/pyodide/engineMemo.ts frontend/packages/browser/src/types.ts \
  frontend/packages/browser/src/__tests__/engineMemo.test.ts frontend/packages/browser/src/__tests__/chartEngineClient.test.ts frontend/packages/browser/src/__tests__/runtime.test.ts \
  frontend/packages/store/src/rectification.test.ts frontend/apps/web/src/hooks/useRectification.test.tsx \
  frontend/apps/web/src/lib/runtimeObservability.ts frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx frontend/apps/web/scripts/verify-browser-parity.mjs
git commit -m "feat(browser): computeMoonWindow worker request, golden, browser parity CHECK 8"
```

(Adjust the provider path to wherever `publishRuntimePredictive` is called: `grep -rn publishRuntimePredictive frontend/apps/web/src`.)

---

### Task 3: Offline place lookup with stateless refs

**Files:**
- Modify: `frontend/apps/web/src/lib/geo/cityLookup.ts` (row-level search and row read; `searchCitiesOffline` becomes a map over it)
- Create: `frontend/apps/web/src/lib/geo/placeLookup.ts`
- Test: `frontend/apps/web/src/lib/geo/placeLookup.test.ts`

**Interfaces:**
- Consumes: `cityLookup.ts` `loadCityDb` (private, lazy dynamic import), `fold`/`tokenize` (private), `toMatch`, `CityMatch`.
- Produces:
  - `cityLookup.ts`: `export interface IndexedCityMatch { readonly index: number; readonly match: CityMatch }`, `export async function searchCityRowsOffline(query: string, limit = 8): Promise<IndexedCityMatch[]>`, `export async function cityAtIndexOffline(index: number): Promise<CityMatch | undefined>`, `export function foldPlaceText(text: string): string` (the existing `fold`, exported).
  - `placeLookup.ts`:
    ```ts
    export const PLACE_REF_PATTERN = '^city:\\d{1,6}$';
    export const PLACE_CANDIDATE_LIMIT = 5;
    export const DOMINANT_POPULATION_RATIO = 10;
    export interface PlaceSummary { readonly place_ref: string; readonly label: string; readonly timezone: string; }
    export interface ResolvedPlace { readonly summary: PlaceSummary; readonly latitude: number; readonly longitude: number; }
    export type PlaceLookup =
      | { readonly status: 'found'; readonly place: ResolvedPlace }
      | { readonly status: 'ambiguous'; readonly candidates: readonly ResolvedPlace[] }
      | { readonly status: 'not_found' };
    export async function lookupPlaceOffline(query: string): Promise<PlaceLookup>;
    export async function placeFromRef(ref: string): Promise<ResolvedPlace | undefined>;
    ```
    A row with no resolvable zone is skipped. A place without a zone can't be read.

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/lib/geo/placeLookup.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lookupPlaceOffline, placeFromRef, PLACE_CANDIDATE_LIMIT } from './placeLookup';

afterEach(() => vi.unstubAllGlobals());

function refOf(result: Awaited<ReturnType<typeof lookupPlaceOffline>>): string {
  if (result.status !== 'found') throw new Error(`expected found, got ${result.status}`);
  return result.place.summary.place_ref;
}

describe('lookupPlaceOffline', () => {
  it('finds Bogotá with or without the accent, in any case, with its zone', async () => {
    for (const query of ['Bogotá', 'bogota', 'BOGOTÁ']) {
      const result = await lookupPlaceOffline(query);
      expect(result.status).toBe('found');
      if (result.status !== 'found') return;
      expect(result.place.summary.label).toBe('Bogotá, Colombia');
      expect(result.place.summary.timezone).toBe('America/Bogota');
      expect(result.place.summary.place_ref).toMatch(/^city:\d{1,6}$/);
    }
  });

  it('finds Los Angeles by population dominance over Los Ángeles, Chile', async () => {
    const result = await lookupPlaceOffline('Los Angeles');
    expect(result.status).toBe('found');
    if (result.status === 'found') expect(result.place.summary.timezone).toBe('America/Los_Angeles');
  });

  it('honours a country qualifier', async () => {
    const result = await lookupPlaceOffline('Los Angeles, US');
    expect(result.status).toBe('found');
  });

  it('returns up to five candidates, each with its own ref, when the name is shared', async () => {
    const result = await lookupPlaceOffline('Springfield');
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.length).toBeLessThanOrEqual(PLACE_CANDIDATE_LIMIT);
    const refs = result.candidates.map((candidate) => candidate.summary.place_ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('returns not_found for text that names no city', async () => {
    expect(await lookupPlaceOffline('Qwxzvbnm')).toEqual({ status: 'not_found' });
    expect(await lookupPlaceOffline('a')).toEqual({ status: 'not_found' });
  });

  it('never touches the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await lookupPlaceOffline('Bogotá');
    await placeFromRef('city:0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers in under 100 ms once the list is loaded', async () => {
    await lookupPlaceOffline('Bogotá');
    const t0 = performance.now();
    await lookupPlaceOffline('São Paulo');
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('placeFromRef', () => {
  it('round-trips a ref to the same label, zone and coordinates', async () => {
    const found = await lookupPlaceOffline('Bogotá');
    const back = await placeFromRef(refOf(found));
    expect(back).toEqual(found.status === 'found' ? found.place : undefined);
  });

  it.each(['city:99999999', 'city:-1', 'bogota', 'city:', 'city:1.5', ''])('refuses %s', async (ref) => {
    expect(await placeFromRef(ref)).toBeUndefined();
  });
});
```

If `Springfield` or `Los Ángeles, Chile` is not in `cities.min.json`, check with `grep -o '"n":"Springfield"' frontend/apps/web/src/data/cities.min.json | wc -l` and `grep -o '"n":"Los Ángeles"' …`. Pick another shared name (for example `San Jose` or `Córdoba`) and record the choice in the PR. For the dominance test, check the two populations first with a one-line `bun -e` over the JSON. Do not weaken the assertion.

Run: `cd frontend/apps/web && bunx vitest run src/lib/geo/placeLookup.test.ts`
Expected: FAIL with `Failed to resolve import "./placeLookup"`.

- [ ] **Step 2: Row-level helpers in `cityLookup.ts`**

Refactor `searchCitiesOffline` so the scan keeps the row index, then map. Behaviour for existing callers is byte-identical: `cityLookup.test.ts` and `cityLookup.online.test.ts` must stay green unchanged.

```ts
export interface IndexedCityMatch {
  readonly index: number;
  readonly match: CityMatch;
}

/** The offline scan with each row's index in the bundled list (a stable ref within one build). */
export async function searchCityRowsOffline(query: string, limit = 8): Promise<IndexedCityMatch[]> {
  if (query.trim().length < 2) return [];
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const normQuery = tokens.join(' ');
  const db = await loadCityDb();
  const scored: Array<{ index: number; row: CityRow; score: number }> = [];
  db.forEach((row, index) => {
    const name = fold(row.n);
    const qualWords = qualifierWords(row);
    const matched =
      name.includes(normQuery) ||
      cityWithQualifiers(splitWords(name), qualWords, tokens) ||
      tokens.every((token) => qualWords.some((w) => w.startsWith(token)));
    if (matched) scored.push({ index, row, score: nameScore(name, normQuery) });
  });
  scored.sort((a, b) => b.score - a.score || b.row.p - a.row.p);
  return scored.slice(0, limit).map(({ index, row }) => ({ index, match: toMatch(row) }));
}

export async function searchCitiesOffline(query: string, limit = 8): Promise<CityMatch[]> {
  return (await searchCityRowsOffline(query, limit)).map(({ match }) => match);
}

/** One bundled row by index, offline. Undefined for an index outside the list. */
export async function cityAtIndexOffline(index: number): Promise<CityMatch | undefined> {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  const row = (await loadCityDb())[index];
  return row ? toMatch(row) : undefined;
}

/** The fold every offline match uses (NFD, strip diacritics, lower-case). */
export const foldPlaceText = fold;
```

- [ ] **Step 3: `placeLookup.ts`**

```ts
/**
 * resolve_place's offline engine (spec 2026-10-08 Part 2). Bundled list only:
 * never searchCities or the online geocoder. A place_ref is the row's index in
 * the bundled list ("city:<n>"): stateless, nothing stored (plan Ruling 4).
 * Coordinates stay in ResolvedPlace; the tool layer sends only `summary`.
 */
import { cityAtIndexOffline, foldPlaceText, searchCityRowsOffline, type CityMatch, type IndexedCityMatch } from './cityLookup';

export const PLACE_REF_PATTERN = '^city:\\d{1,6}$';
const PLACE_REF = new RegExp(PLACE_REF_PATTERN);
export const PLACE_CANDIDATE_LIMIT = 5;
export const DOMINANT_POPULATION_RATIO = 10;

export interface PlaceSummary {
  readonly place_ref: string;
  readonly label: string;
  readonly timezone: string;
}

export interface ResolvedPlace {
  readonly summary: PlaceSummary;
  readonly latitude: number;
  readonly longitude: number;
}

export type PlaceLookup =
  | { readonly status: 'found'; readonly place: ResolvedPlace }
  | { readonly status: 'ambiguous'; readonly candidates: readonly ResolvedPlace[] }
  | { readonly status: 'not_found' };

function resolved(index: number, match: CityMatch): ResolvedPlace | undefined {
  if (!match.timezone) return undefined;
  const summary = { place_ref: `city:${index}`, label: match.displayName, timezone: match.timezone };
  return { summary, latitude: match.latitude, longitude: match.longitude };
}

function cityPart(query: string): string {
  return foldPlaceText(query.split(',')[0] ?? '').trim().replace(/\s+/g, ' ');
}

/** The single exact-name row, or the most populous one when it dominates the next (Ruling 5). */
function uniqueExact(rows: readonly IndexedCityMatch[], query: string): IndexedCityMatch | undefined {
  const city = cityPart(query);
  const exact = rows.filter(({ match }) => foldPlaceText(match.city) === city);
  const [first, second] = [...exact].sort((a, b) => b.match.population - a.match.population);
  if (!first) return undefined;
  if (!second || first.match.population >= DOMINANT_POPULATION_RATIO * second.match.population) return first;
  return undefined;
}

export async function lookupPlaceOffline(query: string): Promise<PlaceLookup> {
  const rows = await searchCityRowsOffline(query, PLACE_CANDIDATE_LIMIT);
  const exact = uniqueExact(rows, query);
  const place = exact && resolved(exact.index, exact.match);
  if (place) return { status: 'found', place };
  const candidates = rows.flatMap(({ index, match }) => resolved(index, match) ?? []);
  return candidates.length > 0 ? { status: 'ambiguous', candidates } : { status: 'not_found' };
}

export async function placeFromRef(ref: string): Promise<ResolvedPlace | undefined> {
  if (!PLACE_REF.test(ref)) return undefined;
  const index = Number(ref.slice('city:'.length));
  const match = await cityAtIndexOffline(index);
  return match && resolved(index, match);
}
```

Note: `uniqueExact` only sees the top 5 rows. "Los Angeles" ranks both exact-name rows above substring rows (score 3), so both are in the top 5.

Run: `cd frontend/apps/web && bunx vitest run src/lib/geo/` (the new file plus both existing cityLookup suites). Expected: all pass.

- [ ] **Step 4: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/geo/placeLookup.ts 'first.match.population >= DOMINANT_POPULATION_RATIO * second.match.population' 'false' -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/geo/placeLookup.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/geo/placeLookup.ts 'if (!PLACE_REF.test(ref)) return undefined;' '' -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/geo/placeLookup.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/geo/placeLookup.ts "import { cityAtIndexOffline, foldPlaceText, searchCityRowsOffline," "import { searchCities } from './cityLookup';
import { cityAtIndexOffline, foldPlaceText, searchCityRowsOffline," -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/geo/placeLookup.test.ts src/lib/__tests__/placeOffline.contract.test.ts'
```

The third mutation needs Task 4's source contract test (`placeOffline.contract.test.ts`), so run it at the end of Task 4. It is the spec's "Call `searchCities`" mutation. Expected: three `KILLED` lines.

- [ ] **Step 5: Commit**

Invoke `frontend-quality`.

```bash
git add frontend/apps/web/src/lib/geo/cityLookup.ts frontend/apps/web/src/lib/geo/placeLookup.ts frontend/apps/web/src/lib/geo/placeLookup.test.ts
git commit -m "feat(web): offline place lookup with stateless city refs"
```

---

### Task 4: The `resolve_place` tool

**Files:**
- Create: `frontend/apps/web/src/lib/placeTool.ts`
- Test: `frontend/apps/web/src/lib/__tests__/placeTool.test.ts`, `frontend/apps/web/src/lib/__tests__/placeOffline.contract.test.ts`

**Interfaces:**
- Consumes: Task 3 `lookupPlaceOffline`, `PlaceSummary`; `AgentTool`, `AgentJsonObject` from `@almamesh/llm`.
- Produces: `RESOLVE_PLACE_TOOL_NAME = 'resolve_place'`, `RESOLVE_PLACE_STATUS_LABEL = 'Looking up the place on this device'`, `createResolvePlaceTool(lookup = lookupPlaceOffline): AgentTool`. The result is one of `{ status: 'found', place: PlaceSummary }`, `{ status: 'ambiguous', candidates: PlaceSummary[] }`, `{ status: 'not_found' }`, `{ error: string }`.

- [ ] **Step 1: Write the failing tests**

`placeTool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { PlaceLookup } from '../geo/placeLookup';
import { createResolvePlaceTool, RESOLVE_PLACE_TOOL_NAME } from '../placeTool';

const context = () => ({ now: new Date('2026-06-20T00:00:00Z'), signal: new AbortController().signal });
const BOGOTA = { summary: { place_ref: 'city:42', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.711, longitude: -74.0721 };

function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('resolve_place', () => {
  it('is named resolve_place and takes only a query string', () => {
    const tool = createResolvePlaceTool(vi.fn());
    expect(tool.name).toBe(RESOLVE_PLACE_TOOL_NAME);
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 120 } },
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('returns the label, zone and ref of a found place and no coordinates', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'found', place: BOGOTA }));
    const result = await createResolvePlaceTool(lookup).execute({ query: 'Bogotá' }, context());
    expect(result).toEqual({ status: 'found', place: BOGOTA.summary });
    expect(numbersIn(result)).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|4\.71|74\.07/);
  });

  it('returns candidates without coordinates when ambiguous', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'ambiguous', candidates: [BOGOTA, BOGOTA] }));
    const result = await createResolvePlaceTool(lookup).execute({ query: 'Springfield' }, context());
    expect(result).toEqual({ status: 'ambiguous', candidates: [BOGOTA.summary, BOGOTA.summary] });
    expect(numbersIn(result)).toEqual([]);
  });

  it('passes not_found through', async () => {
    const lookup = vi.fn(async (): Promise<PlaceLookup> => ({ status: 'not_found' }));
    expect(await createResolvePlaceTool(lookup).execute({ query: 'Nowhere' }, context())).toEqual({ status: 'not_found' });
  });

  it.each([{}, { query: 7 }, { query: ' ' }, { query: 'x'.repeat(121) }])('refuses %j with a tool error', async (args) => {
    const lookup = vi.fn();
    const result = await createResolvePlaceTool(lookup).execute(args, context());
    expect(result).toEqual({ error: 'query must be a place name of 2–120 characters' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
```

`placeOffline.contract.test.ts` is a source contract: the place path never imports the online geocoder, and the city list is only ever a dynamic import.

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');
const PLACE_PATH_FILES = ['lib/placeTool.ts', 'lib/geo/placeLookup.ts', 'lib/moonWindow.ts', 'lib/timingTool.ts', 'lib/chatToolset.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('a chat-typed city never leaves the device', () => {
  it.each(PLACE_PATH_FILES)('%s never imports the online geocoder or searchCities', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(text).not.toMatch(/onlineGeocoder|geocodeCitiesOnline|\bsearchCities\b/);
  });

  it('the city list is only ever loaded by a dynamic import', () => {
    const statics = sourceFiles(SRC).filter((path) => /^\s*import[^(]*cities\.min\.json/m.test(readFileSync(path, 'utf8')));
    expect(statics).toEqual([]);
    expect(readFileSync(join(SRC, 'lib/geo/cityLookup.ts'), 'utf8')).toContain("import('../../data/cities.min.json')");
  });
});
```

`lib/moonWindow.ts` doesn't exist until Task 6. Until then this test fails on that file with ENOENT. Leave it red-for-that-reason through Task 5 and note it in the task review; it goes green in Task 6. Alternatively, add `lib/moonWindow.ts` to the list in Task 6 instead. **Do that: start the list without `lib/moonWindow.ts`, and Task 6 Step 1 adds it.**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/placeTool.test.ts src/lib/__tests__/placeOffline.contract.test.ts`
Expected: `placeTool.test.ts` fails to resolve `../placeTool`. The contract test fails on `lib/placeTool.ts` with ENOENT.

- [ ] **Step 2: Implement `placeTool.ts`**

```ts
/**
 * resolve_place (spec 2026-10-08 Part 2): typed place text -> label + IANA zone
 * + a place_ref, from the bundled offline list only. Coordinates never enter a
 * result: the model sees only what the user typed, the label and the zone.
 */
import type { AgentJsonObject, AgentTool } from '@almamesh/llm';

import { lookupPlaceOffline, type PlaceLookup, type ResolvedPlace } from './geo/placeLookup';

export const RESOLVE_PLACE_TOOL_NAME = 'resolve_place';
export const RESOLVE_PLACE_STATUS_LABEL = 'Looking up the place on this device';
const QUERY_ERROR = 'query must be a place name of 2–120 characters';

const DESCRIPTION = [
  'Look up a city the user named, on this device only (no network). Returns a label, an IANA time zone and a place_ref.',
  'Pass place_ref to get_timing for a single day or a time of day. If several places are named, resolve them all in the same round.',
  'status "ambiguous": list the candidates and ask which one. status "not_found": ask for the nearest larger city.',
  'Never use this for the birth place.',
].join(' ');

function query(args: AgentJsonObject): string | undefined {
  const value = args.query;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 2 && value.length <= 120 ? trimmed : undefined;
}

function forModel(result: PlaceLookup): unknown {
  const summary = (place: ResolvedPlace) => place.summary;
  if (result.status === 'found') return { status: 'found', place: summary(result.place) };
  if (result.status === 'ambiguous') return { status: 'ambiguous', candidates: result.candidates.map(summary) };
  return { status: 'not_found' };
}

export function createResolvePlaceTool(lookup: (query: string) => Promise<PlaceLookup> = lookupPlaceOffline): AgentTool {
  return {
    name: RESOLVE_PLACE_TOOL_NAME,
    description: DESCRIPTION,
    statusLabel: RESOLVE_PLACE_STATUS_LABEL,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 120 } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args: AgentJsonObject) => {
      const text = query(args);
      return text === undefined ? { error: QUERY_ERROR } : forModel(await lookup(text));
    },
  };
}
```

The agent's default per-tool timeout is 2 s (`AGENT_LIMITS.toolTimeoutMs`). The first lookup includes the lazy chunk load. Task 9 measures it. If the first lookup on a throttled profile exceeds 1.5 s, set `timeoutMs: 10_000` here with a comment citing the measurement. Don't set it pre-emptively.

Run: Step 1's command. Expected: PASS.

- [ ] **Step 3: Mutation red runs, then run Task 3's third mutation**

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/placeTool.ts "const summary = (place: ResolvedPlace) => place.summary;" "const summary = (place: ResolvedPlace) => ({ ...place.summary, latitude: place.latitude });" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/placeTool.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/placeTool.ts "return trimmed.length >= 2 && value.length <= 120 ? trimmed : undefined;" "return trimmed;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/placeTool.test.ts'
```

The first is the spec's "Include latitude" mutation. Expected: two `KILLED`, plus Task 3 Step 4's third `KILLED`.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/src/lib/placeTool.ts frontend/apps/web/src/lib/__tests__/placeTool.test.ts frontend/apps/web/src/lib/__tests__/placeOffline.contract.test.ts
git commit -m "feat(web): resolve_place tool — offline only, no coordinates to the model"
```

---

### Task 5: `get_timing` arguments: `place_ref`, `time`, `segments`

**Files:**
- Create: `frontend/packages/llm/src/period-places.ts`
- Modify: `frontend/packages/llm/src/index.ts` (barrel, next to the period exports at L388-410)
- Test: `frontend/packages/llm/src/__tests__/period-places.test.ts`

**Interfaces:**
- Consumes: `parsePeriodArgs`, `PeriodRange`, `ISO_DAY_PATTERN` (`period.ts`).
- Produces:
  ```ts
  export const PLACE_REF_ARG_PATTERN = "^city:\\d{1,6}$";
  export const TIME_OF_DAY_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
  export const MAX_SEGMENTS = 4;
  export interface TimingSegment { readonly start: string; readonly end: string; readonly place_ref?: string; }
  export type TimingArgs =
    | { readonly kind: "today" }
    | { readonly kind: "period"; readonly period: PeriodRange; readonly placeRef?: string; readonly time?: string; readonly segments?: readonly TimingSegment[] }
    | { readonly kind: "invalid"; readonly error: string };
  export function parseTimingArgs(args: Readonly<Record<string, unknown>>): TimingArgs;
  export const SEGMENT_GAP_NOTE: string;
  ```
  Error constants (exported, so tests and the tool use the same text): `SEGMENTS_WITH_DATES_ERROR`, `SEGMENTS_SHAPE_ERROR`, `SEGMENTS_ORDER_ERROR`, `PLACE_REF_ERROR`, `TIME_FORMAT_ERROR`, `TIME_NEEDS_DAY_ERROR`, `TIME_NEEDS_PLACE_ERROR`, `PLACE_CONFLICT_ERROR`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import {
  PLACE_CONFLICT_ERROR,
  PLACE_REF_ERROR,
  SEGMENTS_ORDER_ERROR,
  SEGMENTS_SHAPE_ERROR,
  SEGMENTS_WITH_DATES_ERROR,
  TIME_FORMAT_ERROR,
  TIME_NEEDS_DAY_ERROR,
  TIME_NEEDS_PLACE_ERROR,
  parseTimingArgs,
} from "../period-places";

const LA = "city:101";
const BOG = "city:202";

describe("parseTimingArgs", () => {
  it("keeps Inc A behaviour: no dates is today; start/end is a period", () => {
    expect(parseTimingArgs({ section: "transits" })).toEqual({ kind: "today" });
    expect(parseTimingArgs({ start: "2026-06-01", end: "2026-06-30" })).toEqual({
      kind: "period",
      period: { start: "2026-06-01", end: "2026-06-30" },
    });
  });

  it("merges ordered segments into one period and keeps them", () => {
    const segments = [
      { start: "2026-06-01", end: "2026-06-15", place_ref: LA },
      { start: "2026-06-16", end: "2026-06-30", place_ref: BOG },
    ];
    expect(parseTimingArgs({ segments })).toEqual({
      kind: "period",
      period: { start: "2026-06-01", end: "2026-06-30" },
      segments,
    });
  });

  it("allows a gap between segments", () => {
    const parsed = parseTimingArgs({ segments: [{ start: "2026-06-01", end: "2026-06-10" }, { start: "2026-06-20", end: "2026-06-30" }] });
    expect(parsed.kind).toBe("period");
  });

  it.each([
    [{ start: "2026-06-01", segments: [{ start: "2026-06-01", end: "2026-06-02" }] }, SEGMENTS_WITH_DATES_ERROR],
    [{ segments: [] }, SEGMENTS_SHAPE_ERROR],
    [{ segments: "June" }, SEGMENTS_SHAPE_ERROR],
    [{ segments: Array.from({ length: 5 }, () => ({ start: "2026-06-01", end: "2026-06-01" })) }, SEGMENTS_SHAPE_ERROR],
    [{ segments: [{ start: "2026-06-01" }] }, SEGMENTS_SHAPE_ERROR],
    [{ segments: [{ start: "2026-06-10", end: "2026-06-01" }] }, "end is before start"],
    [{ segments: [{ start: "2026-6-1", end: "2026-06-02" }] }, "start must be a date like 2026-06-01"],
    [{ segments: [{ start: "2026-06-01", end: "2026-06-15" }, { start: "2026-06-15", end: "2026-06-30" }] }, SEGMENTS_ORDER_ERROR],
    [{ segments: [{ start: "2026-06-16", end: "2026-06-30" }, { start: "2026-06-01", end: "2026-06-15" }] }, SEGMENTS_ORDER_ERROR],
    [{ segments: [{ start: "2026-06-01", end: "2026-06-02", place_ref: "bogota" }] }, PLACE_REF_ERROR],
    [{ start: "2026-06-15", place_ref: 7 }, PLACE_REF_ERROR],
    [{ start: "2026-06-15", place_ref: BOG, time: "3pm" }, TIME_FORMAT_ERROR],
    [{ start: "2026-06-15", place_ref: BOG, time: "24:00" }, TIME_FORMAT_ERROR],
    [{ start: "2026-06-01", end: "2026-06-30", place_ref: BOG, time: "15:00" }, TIME_NEEDS_DAY_ERROR],
    [{ time: "15:00" }, TIME_NEEDS_DAY_ERROR],
    [{ start: "2026-06-15", time: "15:00" }, TIME_NEEDS_PLACE_ERROR],
    [{ segments: [{ start: "2026-06-15", end: "2026-06-15", place_ref: LA }], place_ref: BOG }, PLACE_CONFLICT_ERROR],
  ])("refuses %j", (args, error) => {
    expect(parseTimingArgs(args)).toEqual({ kind: "invalid", error });
  });

  it("takes a single day's place from its one segment", () => {
    expect(parseTimingArgs({ segments: [{ start: "2026-06-15", end: "2026-06-15", place_ref: BOG }], time: "15:00" })).toEqual({
      kind: "period",
      period: { start: "2026-06-15", end: "2026-06-15" },
      segments: [{ start: "2026-06-15", end: "2026-06-15", place_ref: BOG }],
      placeRef: BOG,
      time: "15:00",
    });
  });

  it("accepts a place_ref on a multi-day period (the tool notes it changes nothing)", () => {
    expect(parseTimingArgs({ start: "2026-06-01", end: "2026-06-30", place_ref: BOG })).toEqual({
      kind: "period",
      period: { start: "2026-06-01", end: "2026-06-30" },
      placeRef: BOG,
    });
  });
});
```

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-places.test.ts`
Expected: FAIL to resolve `../period-places`.

- [ ] **Step 2: Implement `period-places.ts`**

```ts
// Time travel Inc C (spec 2026-10-08 Part 2): places, times of day and split
// periods on the timing tool. Pure argument checks on strings; no astrology.
import { parsePeriodArgs, type PeriodArgs } from "./period";
import type { PeriodRange } from "./sanitize";

export const PLACE_REF_ARG_PATTERN = "^city:\\d{1,6}$";
const PLACE_REF = new RegExp(PLACE_REF_ARG_PATTERN);
export const TIME_OF_DAY_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
const TIME_OF_DAY = new RegExp(TIME_OF_DAY_PATTERN);
export const MAX_SEGMENTS = 4;

export const SEGMENTS_WITH_DATES_ERROR = "send either start/end or segments, not both";
export const SEGMENTS_SHAPE_ERROR = `segments must be 1–${MAX_SEGMENTS} items of { start, end, place_ref? }`;
export const SEGMENTS_ORDER_ERROR = "segments must be in date order and must not overlap";
export const PLACE_REF_ERROR = "unknown place_ref: call resolve_place first";
export const TIME_FORMAT_ERROR = "time must be HH:MM, 24-hour, like 15:00";
export const TIME_NEEDS_DAY_ERROR = "a time of day needs a single day: send start only, or one one-day segment";
export const TIME_NEEDS_PLACE_ERROR = "a time of day needs a place: ask where, call resolve_place, then pass place_ref";
export const PLACE_CONFLICT_ERROR = "place_ref disagrees with the segment's place_ref for that day";
export const SEGMENT_GAP_NOTE = "The places you gave leave some days uncovered; the reading still spans the whole period.";

export interface TimingSegment {
  readonly start: string;
  readonly end: string;
  readonly place_ref?: string;
}

export type TimingArgs =
  | { readonly kind: "today" }
  | {
      readonly kind: "period";
      readonly period: PeriodRange;
      readonly placeRef?: string;
      readonly time?: string;
      readonly segments?: readonly TimingSegment[];
    }
  | { readonly kind: "invalid"; readonly error: string };

type Parsed<T> = T | { readonly error: string };
const invalid = (error: string): TimingArgs => ({ kind: "invalid", error });
const failed = <T>(value: Parsed<T>): value is { readonly error: string } =>
  typeof value === "object" && value !== null && "error" in value;

function placeRefArg(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return undefined;
  return typeof value === "string" && PLACE_REF.test(value) ? value : { error: PLACE_REF_ERROR };
}

function segmentArg(value: unknown): Parsed<TimingSegment> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: SEGMENTS_SHAPE_ERROR };
  const raw = value as Readonly<Record<string, unknown>>;
  if (raw.start === undefined || raw.end === undefined) return { error: SEGMENTS_SHAPE_ERROR };
  const dates = parsePeriodArgs(raw);
  if (dates.kind === "invalid") return { error: dates.error };
  if (dates.kind !== "period") return { error: SEGMENTS_SHAPE_ERROR };
  const placeRef = placeRefArg(raw.place_ref);
  if (failed(placeRef)) return placeRef;
  return { ...dates.period, ...(placeRef ? { place_ref: placeRef } : {}) };
}

function segmentsArg(value: unknown): Parsed<readonly TimingSegment[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEGMENTS) return { error: SEGMENTS_SHAPE_ERROR };
  const segments: TimingSegment[] = [];
  for (const item of value) {
    const segment = segmentArg(item);
    if (failed(segment)) return segment;
    const previous = segments[segments.length - 1];
    if (previous && segment.start <= previous.end) return { error: SEGMENTS_ORDER_ERROR };
    segments.push(segment);
  }
  return segments;
}
```

Then the composition (each function ≤ 15 lines):

```ts
function datesFrom(args: Readonly<Record<string, unknown>>): Parsed<{ dates: PeriodArgs; segments?: readonly TimingSegment[] }> {
  if (args.segments === undefined) return { dates: parsePeriodArgs(args) };
  if (args.start !== undefined || args.end !== undefined) return { error: SEGMENTS_WITH_DATES_ERROR };
  const segments = segmentsArg(args.segments);
  if (failed(segments)) return segments;
  const first = segments[0] as TimingSegment;
  const last = segments[segments.length - 1] as TimingSegment;
  return { dates: { kind: "period", period: { start: first.start, end: last.end } }, segments };
}

function dayPlace(period: PeriodRange, segments: readonly TimingSegment[] | undefined, placeRef: string | undefined): Parsed<string | undefined> {
  const fromSegment = period.start === period.end ? segments?.[0]?.place_ref : undefined;
  if (placeRef && fromSegment && placeRef !== fromSegment) return { error: PLACE_CONFLICT_ERROR };
  return placeRef ?? fromSegment;
}

function timeArg(value: unknown, period: PeriodRange | undefined, place: string | undefined): Parsed<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TIME_OF_DAY.test(value)) return { error: TIME_FORMAT_ERROR };
  if (!period || period.start !== period.end) return { error: TIME_NEEDS_DAY_ERROR };
  return place ? value : { error: TIME_NEEDS_PLACE_ERROR };
}

/** Read get_timing's arguments: dates or segments, plus an optional place_ref and time. */
export function parseTimingArgs(args: Readonly<Record<string, unknown>>): TimingArgs {
  const read = datesFrom(args);
  if (failed(read)) return invalid(read.error);
  if (read.dates.kind === "invalid") return invalid(read.dates.error);
  const placeArg = placeRefArg(args.place_ref);
  if (failed(placeArg)) return invalid(placeArg.error);
  const period = read.dates.kind === "period" ? read.dates.period : undefined;
  const place = period ? dayPlace(period, read.segments, placeArg) : placeArg;
  if (failed(place)) return invalid(place.error);
  const time = timeArg(args.time, period, place);
  if (failed(time)) return invalid(time.error);
  if (!period) return { kind: "today" };
  return { kind: "period", period, ...(read.segments ? { segments: read.segments } : {}), ...(place ? { placeRef: place } : {}), ...(time ? { time } : {}) };
}
```

Two cases need care so they don't slip through:
- `{ time: "15:00" }` with no dates. `period` is undefined, so `timeArg` returns `TIME_NEEDS_DAY_ERROR`. That is correct, and the test pins it.
- `{ place_ref: BOG }` with no dates. The result is `{ kind: "today" }` (a place for "today" changes nothing; Ruling 6).

If xenon flags `parseTimingArgs` above grade A, split the final object build into a `periodArgs(period, segments, place, time)` helper.

Add `export * from "./period-places";` to the barrel (or named exports, matching the file's existing style at L388-410).

Run: Step 1's command. Expected: PASS.

- [ ] **Step 3: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/llm/src/period-places.ts 'if (previous && segment.start <= previous.end) return { error: SEGMENTS_ORDER_ERROR };' '' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-places.test.ts'
python3 "$MUTATE" frontend/packages/llm/src/period-places.ts 'return place ? value : { error: TIME_NEEDS_PLACE_ERROR };' 'return value;' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-places.test.ts'
python3 "$MUTATE" frontend/packages/llm/src/period-places.ts 'if (args.start !== undefined || args.end !== undefined) return { error: SEGMENTS_WITH_DATES_ERROR };' '' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-places.test.ts'
python3 "$MUTATE" frontend/packages/llm/src/period-places.ts 'if (placeRef && fromSegment && placeRef !== fromSegment) return { error: PLACE_CONFLICT_ERROR };' '' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-places.test.ts'
```
Expected: four `KILLED`.

- [ ] **Step 4: Commit**

```bash
git add frontend/packages/llm/src/period-places.ts frontend/packages/llm/src/index.ts frontend/packages/llm/src/__tests__/period-places.test.ts
git commit -m "feat(llm): get_timing argument rules for place_ref, time and segments"
```

---

### Task 6: Moon-window loader: place day bounds and event instants in TypeScript

**Files:**
- Create: `frontend/apps/web/src/lib/moonWindow.ts`
- Modify: `frontend/apps/web/src/lib/__tests__/placeOffline.contract.test.ts` (add `lib/moonWindow.ts` to `PLACE_PATH_FILES`)
- Test: `frontend/apps/web/src/lib/__tests__/moonWindow.test.ts`

**Interfaces:**
- Consumes: `resolveLocalTime`, `localTimeToInstant`, `LocalTimeError` (`@almamesh/store`, `adapters/localBirthTime.ts`); `readyEngine` (`periodChart.ts:38`, returns the engine; widen its return type to `ChartEngine` from `@almamesh/browser` if it is typed as `PredictiveRuntime`); `MoonWindow`, `MoonWindowInput` (Task 2); `AgentToolContext`; `withDeadline` and `periodSkyDeadline()` as `periodChart.ts` uses them.
- Produces:
  ```ts
  export interface MoonWindowRequest {
    readonly day: string;                                   // YYYY-MM-DD
    readonly zone: string;                                  // IANA: the place's, or the home zone
    readonly place?: { readonly latitude: number; readonly longitude: number };
    readonly time?: string;                                 // HH:MM at `zone`; needs `place`
  }
  export type MoonWindowLoader = (request: MoonWindowRequest, context: AgentToolContext) => Promise<MoonWindow>;
  export function localDayBounds(day: string, zone: string): { readonly startUtc: string; readonly endUtc: string };
  export function eventInstantUtc(day: string, time: string, zone: string): string;   // throws LocalTimeError
  export function moonWindowInput(request: MoonWindowRequest): MoonWindowInput;
  export function createMoonWindowLoader(engine: ChartEngineContextValue | null): MoonWindowLoader;
  ```

- [ ] **Step 1: Write the failing tests** (and add `'lib/moonWindow.ts'` to the contract list)

```ts
import { LocalTimeError } from '@almamesh/store';
import { describe, expect, it, vi } from 'vitest';

import type { ChartEngineContextValue } from '../../providers/chartEngineContext';
import { createMoonWindowLoader, eventInstantUtc, localDayBounds, moonWindowInput } from '../moonWindow';

const context = () => ({ now: new Date('2026-06-20T00:00:00Z'), signal: new AbortController().signal });

describe('localDayBounds', () => {
  it('is local midnight to the next local midnight in UTC', () => {
    expect(localDayBounds('2026-06-15', 'America/Bogota')).toEqual({
      startUtc: '2026-06-15T05:00:00.000Z',
      endUtc: '2026-06-16T05:00:00.000Z',
    });
  });

  it('is 23 hours on a spring-forward day', () => {
    const { startUtc, endUtc } = localDayBounds('2026-03-08', 'America/Los_Angeles');
    expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(23 * 3_600_000);
  });

  it('starts at the first real instant when local midnight is skipped', () => {
    // Chile springs forward at 00:00 -> 01:00 (first Sunday of September 2026).
    const { startUtc } = localDayBounds('2026-09-06', 'America/Santiago');
    expect(startUtc).toBe('2026-09-06T04:00:00.000Z');
  });
});

describe('eventInstantUtc', () => {
  it('turns 15:00 in Bogotá into 20:00 UTC', () => {
    expect(eventInstantUtc('2026-06-15', '15:00', 'America/Bogota')).toBe('2026-06-15T20:00:00.000Z');
  });

  it('refuses a time that never happened', () => {
    expect(() => eventInstantUtc('2026-03-08', '02:30', 'America/Los_Angeles')).toThrow(LocalTimeError);
  });

  it('refuses a time that happened twice', () => {
    expect(() => eventInstantUtc('2026-11-01', '01:30', 'America/Los_Angeles')).toThrow(LocalTimeError);
  });
});

describe('moonWindowInput', () => {
  it('sends the day, the place day and the event, with coordinates only on the device-side wire', () => {
    expect(moonWindowInput({ day: '2026-06-15', zone: 'America/Bogota', place: { latitude: 4.711, longitude: -74.0721 }, time: '15:00' })).toEqual({
      day: '2026-06-15',
      placeStartUtc: '2026-06-15T05:00:00.000Z',
      placeEndUtc: '2026-06-16T05:00:00.000Z',
      event: { datetimeUtc: '2026-06-15T20:00:00.000Z', latitude: 4.711, longitude: -74.0721 },
    });
  });

  it('sends no event without a time', () => {
    expect(moonWindowInput({ day: '2026-06-15', zone: 'America/Bogota' })).toEqual({
      day: '2026-06-15',
      placeStartUtc: '2026-06-15T05:00:00.000Z',
      placeEndUtc: '2026-06-16T05:00:00.000Z',
    });
  });
});

describe('createMoonWindowLoader', () => {
  it('calls the engine once with the built input', async () => {
    const computeMoonWindow = vi.fn(async () => ({ day: '2026-06-15' }));
    const engine = { engine: { computeMoonWindow }, startBootstrap: vi.fn(), whenReady: vi.fn() } as unknown as ChartEngineContextValue;
    await createMoonWindowLoader(engine)({ day: '2026-06-15', zone: 'America/Bogota' }, context());
    expect(computeMoonWindow).toHaveBeenCalledWith(moonWindowInput({ day: '2026-06-15', zone: 'America/Bogota' }));
  });

  it('fails as engine_unavailable without an engine', async () => {
    await expect(createMoonWindowLoader(null)({ day: '2026-06-15', zone: 'UTC' }, context())).rejects.toMatchObject({ reason: 'engine_unavailable' });
  });
});
```

The Santiago case: Chile moves from UTC−4 to UTC−3 at local 00:00 on the first Saturday→Sunday of September. Confirm the 2026 date with `bun -e` and `Intl` before pinning. If 2026's change falls on 2026-09-06 at 00:00 local, the first instant of that day is 01:00 −03:00 = 04:00Z. Adjust the literal only to what `Intl` shows, and record it.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/moonWindow.test.ts src/lib/__tests__/placeOffline.contract.test.ts`
Expected: FAIL to resolve `../moonWindow` (and ENOENT in the contract test).

- [ ] **Step 2: Implement `moonWindow.ts`**

```ts
/**
 * Inputs for the engine's moon window (spec 2026-10-08 Part 2). Calendar and
 * zone arithmetic only: local midnights and a local time of day become UTC
 * instants here, so the Python engine needs no tz database (plan Ruling 9).
 * Coordinates go to the on-device worker only; nothing here is model-facing.
 */
import type { MoonWindow, MoonWindowInput } from '@almamesh/browser';
import type { AgentToolContext } from '@almamesh/llm';
import { localTimeToInstant, resolveLocalTime } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { readyEngine } from './periodChart';

export interface MoonWindowRequest {
  readonly day: string;
  readonly zone: string;
  readonly place?: { readonly latitude: number; readonly longitude: number };
  readonly time?: string;
}

export type MoonWindowLoader = (request: MoonWindowRequest, context: AgentToolContext) => Promise<MoonWindow>;

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The first instant of `day` at `zone`: local 00:00, or 01:00 when midnight was skipped. */
function firstInstant(day: string, zone: string): string {
  for (const time of ['00:00', '01:00']) {
    const resolved = resolveLocalTime(day, time, zone);
    if (resolved.kind === 'unique') return resolved.instant.utc;
    if (resolved.kind === 'ambiguous') return resolved.earlier.utc;
  }
  throw new RangeError(`no start of day for ${day} in ${zone}`);
}

export function localDayBounds(day: string, zone: string): { readonly startUtc: string; readonly endUtc: string } {
  return { startUtc: firstInstant(day, zone), endUtc: firstInstant(nextDay(day), zone) };
}

export function eventInstantUtc(day: string, time: string, zone: string): string {
  return localTimeToInstant(day, time, zone).utc;
}

export function moonWindowInput(request: MoonWindowRequest): MoonWindowInput {
  const { startUtc, endUtc } = localDayBounds(request.day, request.zone);
  const base = { day: request.day, placeStartUtc: startUtc, placeEndUtc: endUtc };
  if (!request.time || !request.place) return base;
  const datetimeUtc = eventInstantUtc(request.day, request.time, request.zone);
  return { ...base, event: { datetimeUtc, latitude: request.place.latitude, longitude: request.place.longitude } };
}

export function createMoonWindowLoader(engine: ChartEngineContextValue | null): MoonWindowLoader {
  return async (request) => {
    const input = moonWindowInput(request);
    const runtime = await readyEngine(engine);
    return runtime.computeMoonWindow(input);
  };
}
```

- The UTC-ISO format from `resolveLocalTime` is `toISOString()` (`.000Z`). Python's `datetime.fromisoformat` accepts `Z` on 3.11+. Task 1's `_wire_instant` check `utcoffset() == 0` holds.
- `readyEngine` must return a type with `computeMoonWindow`. If it returns `PredictiveRuntime`, change its return type to `ChartEngine` (it already returns `engine.engine ?? await engine.whenReady()`, which is a `ChartEngine`). `periodChart.ts`'s own call site still type-checks, because `ChartEngine` has `computePredictive`.
- `readyEngine(null)` throws `PeriodSkyUnavailableError('engine_unavailable')`, which carries `reason`.
- Re-export `MoonWindow`/`MoonWindowInput` from `@almamesh/browser`'s index if Task 2 didn't.
- The moon-window call rides inside `get_timing`'s 150 s budget and its abort signal (the tool's deadline wraps it). It needs no own deadline.

Run: Step 1's command. Expected: PASS.

- [ ] **Step 3: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/moonWindow.ts "for (const time of ['00:00', '01:00'])" "for (const time of ['00:00'])" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/moonWindow.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/moonWindow.ts "return { startUtc: firstInstant(day, zone), endUtc: firstInstant(nextDay(day), zone) };" "return { startUtc: firstInstant(day, zone), endUtc: new Date(Date.parse(firstInstant(day, zone)) + 86_400_000).toISOString() };" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/moonWindow.test.ts'
```
Expected: two `KILLED` (the skipped midnight; the 23-hour day).

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/src/lib/moonWindow.ts frontend/apps/web/src/lib/periodChart.ts frontend/apps/web/src/lib/__tests__/moonWindow.test.ts frontend/apps/web/src/lib/__tests__/placeOffline.contract.test.ts
git commit -m "feat(web): moon-window inputs — local day bounds and event instants, DST-safe"
```

---

### Task 7: `get_timing` reads places; the toolset registers `resolve_place` on full devices

**Files:**
- Modify: `frontend/apps/web/src/lib/timingTool.ts`
- Modify: `frontend/apps/web/src/lib/chatAgentTools.ts` (`CreateChatAgentToolsInput` passes the new timing inputs through)
- Modify: `frontend/apps/web/src/lib/chatToolset.ts` (moon loader, home zone, place-ref reader, `resolve_place` behind the tier)
- Test: `frontend/apps/web/src/lib/__tests__/timingTool.places.test.ts` (new), `frontend/apps/web/src/lib/__tests__/chatToolset.test.ts` (extend)
- Modify (expected, intended extension): `frontend/apps/web/e2e/time-travel.spec.ts` Journey 1's tool-list assertion (Task 10 does it)

**Interfaces:**
- Consumes: Task 5 `parseTimingArgs`, `TimingSegment`, `SEGMENT_GAP_NOTE`, `PLACE_REF_ERROR`; Task 3 `placeFromRef`, `ResolvedPlace`; Task 4 `createResolvePlaceTool`; Task 6 `MoonWindowLoader`, `createMoonWindowLoader`, `LocalTimeError`; `MoonWindow`.
- Produces:
  - New `TimingToolInput` fields:
    ```ts
    /** The engine's moon window for one day (Task 6). Absent: no location check. */
    readonly loadMoonWindow?: MoonWindowLoader;
    /** The home zone (the viewer's device zone). Used for a day read with no place; never echoed. */
    readonly homeZone?: () => string;
    /** Re-read a place_ref offline (geo/placeLookup.ts placeFromRef). */
    readonly placeFromRef?: (ref: string) => Promise<ResolvedPlace | undefined>;
    ```
  - Result additions on `TimingResult`:
    ```ts
    place?: { readonly basis: 'home_time_zone' } | { readonly basis: 'place'; readonly label: string; readonly timezone: string };
    location_sensitive?: boolean;
    moon?: { readonly across_earth: MoonEnds; readonly at_place: MoonEnds | null };
    event?: { readonly local_time: string; readonly lagna_sign: string; readonly moon: MoonMark };
    segments?: readonly { readonly start: string; readonly end: string; readonly label?: string; readonly timezone?: string }[];
    ```
  - Exported notes: `PLACE_DOES_NOT_CHANGE_NOTE = "Place doesn't change readings for periods longer than a day: dashas come from the birth chart and planet positions are the same from anywhere on Earth."` and `LOCATION_CHECK_UNAVAILABLE_NOTE = "Couldn't check whether the place changes this day's Moon; ask where they were only if it matters."`
  - `BuildChatToolsetInput` gains test seams `periodSkyAllowed?: boolean` and `placeFromRef?`. Pages never pass them; extend `chatToolsetWiring.test.ts`'s "pages never pass" pin to cover the new keys.

- [ ] **Step 1: Write the failing tool tests**

`timingTool.places.test.ts` reuses the fixtures of `timingTool.test.ts` (`CHART`, `SKY_CHART`, `NOW`). Import them if they are exported, or move them to `src/lib/__tests__/timingFixtures.ts` in this step and import from both files. The move is a pure refactor, so `timingTool.test.ts` stays green.

```ts
import { describe, expect, it, vi } from 'vitest';

import type { MoonWindow } from '@almamesh/browser';
import { BIRTH_YEAR_SKY_NOTE, PLACE_REF_ERROR, TIME_NEEDS_PLACE_ERROR } from '@almamesh/llm';

import { createTimingTool, DEVICE_DASHAS_ONLY_NOTE, LOCATION_CHECK_UNAVAILABLE_NOTE, PLACE_DOES_NOT_CHANGE_NOTE } from '../timingTool';
import { CHART, SKY_CHART } from './timingFixtures';

const NOW = new Date('2026-06-20T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });
const MARK = { sign: 'taurus', nakshatra: 'Rohini', tithi: 3, paksha: 'shukla' } as const;
const NEXT = { sign: 'gemini', nakshatra: 'Mrigashira', tithi: 5, paksha: 'shukla' } as const;
const WINDOW: MoonWindow = {
  day: '2026-06-15',
  location_sensitive: true,
  across_earth: { at_start: MARK, at_end: NEXT },
  at_place: { at_start: MARK, at_end: NEXT },
  event: null,
};
const BOGOTA = { summary: { place_ref: 'city:202', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.711, longitude: -74.0721 };
const LA = { summary: { place_ref: 'city:101', label: 'Los Angeles, United States', timezone: 'America/Los_Angeles' }, latitude: 34.05, longitude: -118.24 };

function tool(overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthYear: 1990,
    todayDay: () => '2026-06-20',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    periodSkyAllowed: true,
    loadMoonWindow: vi.fn(async () => WINDOW),
    homeZone: () => 'America/Los_Angeles',
    placeFromRef: vi.fn(async (ref: string) => ({ 'city:202': BOGOTA, 'city:101': LA })[ref]),
    ...overrides,
  });
}

function numbersUnder(value: unknown, key: string): number[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = key in record ? JSON.stringify(record[key]).match(/-?\d+\.\d+/g) ?? [] : [];
  return [...own.map(Number), ...Object.values(record).flatMap((child) => numbersUnder(child, key))];
}

describe('get_timing with places', () => {
  it('a single dated day of transits carries the location check in the home zone, without naming the zone', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'transits', start: '2026-06-15' }, context());
    expect(result).toMatchObject({ location_sensitive: true, place: { basis: 'home_time_zone' }, moon: { across_earth: WINDOW.across_earth } });
    expect(load).toHaveBeenCalledWith({ day: '2026-06-15', zone: 'America/Los_Angeles' }, expect.anything());
    expect(JSON.stringify(result)).not.toContain('America/Los_Angeles');
  });

  it('a quiet day says so', async () => {
    const result = await tool({ loadMoonWindow: vi.fn(async () => ({ ...WINDOW, location_sensitive: false })) }).execute({ section: 'transits', start: '2026-06-15' }, context());
    expect(result).toMatchObject({ location_sensitive: false });
  });

  it('a day at a resolved place reads that place, echoes label and zone, and sends coordinates only to the loader', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:202' }, context());
    expect(result).toMatchObject({ place: { basis: 'place', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, moon: { at_place: WINDOW.at_place } });
    expect(load).toHaveBeenCalledWith({ day: '2026-06-15', zone: 'America/Bogota', place: { latitude: 4.711, longitude: -74.0721 } }, expect.anything());
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|4\.711|74\.07/);
  });

  it('a time of day at a place returns the lagna sign and the Moon, no degrees', async () => {
    const event = { lagna_sign: 'scorpio', moon: MARK };
    const load = vi.fn(async () => ({ ...WINDOW, event }));
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:202', time: '15:00' }, context());
    expect(result).toMatchObject({ event: { local_time: '15:00', lagna_sign: 'scorpio', moon: MARK } });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ time: '15:00' }), expect.anything());
  });

  it('a time that never happened at the place is a tool error, not a guess', async () => {
    // The stub builds the real wire input, so LocalTimeError fires before any engine call.
    const load = vi.fn(async (request: MoonWindowRequest) => {
      moonWindowInput(request);
      return WINDOW;
    });
    const result = await tool({ loadMoonWindow: load }).execute(
      { section: 'transits', start: '2026-03-08', place_ref: 'city:101', time: '02:30' },
      context(),
    );
    expect(result).toEqual({ error: expect.stringContaining('did not exist') });
  });

  it('an unknown place_ref is a tool error', async () => {
    const result = await tool().execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:999999' }, context());
    expect(result).toEqual({ error: PLACE_REF_ERROR });
  });

  it('a time without a place is a tool error', async () => {
    expect(await tool().execute({ section: 'transits', start: '2026-06-15', time: '15:00' }, context())).toEqual({ error: TIME_NEEDS_PLACE_ERROR });
  });

  it('split June: one merged period, labels echoed, a plain note, no moon window', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load }).execute(
      { section: 'transits', segments: [{ start: '2026-06-01', end: '2026-06-15', place_ref: 'city:101' }, { start: '2026-06-16', end: '2026-06-30', place_ref: 'city:202' }] },
      context(),
    );
    expect(result).toMatchObject({
      period: { start: '2026-06-01', end: '2026-06-30', days: 30, basis: 'period' },
      segments: [
        { start: '2026-06-01', end: '2026-06-15', label: 'Los Angeles, United States', timezone: 'America/Los_Angeles' },
        { start: '2026-06-16', end: '2026-06-30', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
      ],
    });
    expect((result as { notes: string[] }).notes).toContain(PLACE_DOES_NOT_CHANGE_NOTE);
    expect(load).not.toHaveBeenCalled();
    expect(numbersUnder(result, 'segments')).toEqual([]);
  });

  it('dashas, domains and strength do not run the location check', async () => {
    for (const section of ['dashas', 'domains', 'strength']) {
      const load = vi.fn(async () => WINDOW);
      const result = await tool({ loadMoonWindow: load }).execute({ section, start: '2026-06-15' }, context());
      expect(load).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('location_sensitive');
    }
  });

  it('today (no dates) is unchanged: no check', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load, loadCurrentChart: vi.fn(async () => SKY_CHART) }).execute({ section: 'transits' }, context());
    expect(load).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('location_sensitive');
  });

  it('a birth-year day gets dashas only and no moon window, even with a place and time', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load }).execute({ section: 'transits', start: '1990-06-15', place_ref: 'city:202', time: '15:00' }, context());
    expect(result).toMatchObject({ shown: 'dashas', notes: [BIRTH_YEAR_SKY_NOTE] });
    expect(load).not.toHaveBeenCalled();
  });

  it('a weak device gets dashas only and no moon window', async () => {
    const load = vi.fn(async () => WINDOW);
    const result = await tool({ loadMoonWindow: load, periodSkyAllowed: false }).execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:202' }, context());
    expect(result).toMatchObject({ shown: 'dashas', notes: [DEVICE_DASHAS_ONLY_NOTE] });
    expect(load).not.toHaveBeenCalled();
  });

  it('a failed moon window keeps the sky answer and says the check was unavailable', async () => {
    const result = await tool({ loadMoonWindow: vi.fn(async () => { throw new Error('worker died'); }) }).execute({ section: 'transits', start: '2026-06-15' }, context());
    expect(result).toMatchObject({ shown: 'transits' });
    expect(result).not.toHaveProperty('location_sensitive');
    expect((result as { notes: string[] }).notes).toContain(LOCATION_CHECK_UNAVAILABLE_NOTE);
  });
});
```

Notes on the tests:
- The weak-device test relies on `placeFromRef` not being called. The tier gate runs before any place work, so refs aren't even read on a weak device. Assert that too: pass `placeFromRef: vi.fn()` and expect it not called.
- Add `import { moonWindowInput, type MoonWindowRequest } from '../moonWindow';` for the "time that never happened" test.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.places.test.ts`
Expected: FAIL. `LOCATION_CHECK_UNAVAILABLE_NOTE`/`PLACE_DOES_NOT_CHANGE_NOTE` are not exported, and the assertions fail.

- [ ] **Step 2: Implement in `timingTool.ts`**

1. Switch `execute` and `statusLabelFor` from `parsePeriodArgs(args)` to `parseTimingArgs(args)`. The `period` branch now carries `placeRef`, `time`, `segments`. `todayTiming` is untouched.
2. Extend the parameter schema:
   ```ts
   const PLACE_REF = { type: 'string', pattern: PLACE_REF_ARG_PATTERN } as const;
   properties: {
     section: { type: 'string', enum: TIMING_SECTIONS },
     start: DAY,
     end: DAY,
     place_ref: PLACE_REF,
     time: { type: 'string', pattern: TIME_OF_DAY_PATTERN },
     segments: {
       type: 'array', minItems: 1, maxItems: MAX_SEGMENTS,
       items: { type: 'object', properties: { start: DAY, end: DAY, place_ref: PLACE_REF }, required: ['start', 'end'], additionalProperties: false },
     },
   },
   ```
3. Extend `DESCRIPTION` with three sentences: "Places never change a period longer than a day: for 'first half in LA, then Bogotá' send segments with each place_ref and say plainly that place doesn't change the reading. For a single day of transits the result says location_sensitive: ask where they were only when it is true; otherwise say you read the day in their home time zone (do not name a zone you weren't given). For a time of day, always ask where, call resolve_place, then send start, place_ref and time (HH:MM)."
4. Thread a `PlaceRequest` (`{ placeRef?: string; time?: string; segments?: readonly TimingSegment[] }`) from `execute` into `periodTiming`. `periodTiming` keeps its gate order exactly: refusal, then `dashasOnlyNotes`, then dashas. Only after a sky result succeeds does it call `withPlaces(input, result, period, places, context)`. That puts the birth-year and device gates ahead of any place work (Ruling 7, Ruling 3).
5. New helpers (each ≤ 15 lines, in `timingTool.ts` or a sibling `timingPlaces.ts` if the file passes ~300 lines):
   ```ts
   export const PLACE_DOES_NOT_CHANGE_NOTE = "Place doesn't change readings for periods longer than a day: dashas come from the birth chart and planet positions are the same from anywhere on Earth.";
   export const LOCATION_CHECK_UNAVAILABLE_NOTE = "Couldn't check whether the place changes this day's Moon; ask where they were only if it matters.";

   type PlaceEcho = { readonly basis: 'home_time_zone' } | { readonly basis: 'place'; readonly label: string; readonly timezone: string };

   async function readPlace(input: TimingToolInput, ref: string | undefined): Promise<ResolvedPlace | undefined | 'unknown'> {
     if (!ref) return undefined;
     const place = await input.placeFromRef?.(ref);
     return place ?? 'unknown';
   }

   async function segmentEcho(input: TimingToolInput, segments: readonly TimingSegment[]): Promise<TimingResult['segments'] | 'unknown'> {
     const echoed = [];
     for (const segment of segments) {
       const place = await readPlace(input, segment.place_ref);
       if (place === 'unknown') return 'unknown';
       echoed.push({ start: segment.start, end: segment.end, ...(place ? { label: place.summary.label, timezone: place.summary.timezone } : {}) });
     }
     return echoed;
   }

   function hasGap(segments: readonly TimingSegment[]): boolean {
     return segments.some((segment, i) => i > 0 && periodEcho({ start: (segments[i - 1] as TimingSegment).end, end: segment.start }, 'period').days > 2);
   }
   ```
   `multiDayPlaces(input, result, places)`: if neither `segments` nor `placeRef` was sent, return `result` unchanged. If `segmentEcho` returns `'unknown'` (or `placeRef` reads `'unknown'`), return `{ error: PLACE_REF_ERROR }`. Otherwise return `{ ...result, segments, notes: [...result.notes, PLACE_DOES_NOT_CHANGE_NOTE, ...(hasGap ? [SEGMENT_GAP_NOTE] : [])] }`. This applies to every section, including dashas-only answers, so the note shows even on a weak device. The `'unknown'` check runs only on the sky or dashas path after the gates. On a weak device the dashas-only path skips `multiDayPlaces`' ref read entirely, so the Task 7 weak-device test holds.
   `dayPlaces(input, result, period, places, context)`: only when `result.section === 'transits'`, `result.shown === 'transits'`, `period.start === period.end`, and `input.loadMoonWindow` exists.
   - Read the place. `'unknown'` gives `{ error: PLACE_REF_ERROR }`.
   - `zone = place?.summary.timezone ?? input.homeZone?.()`. With no zone, return `result` plus `LOCATION_CHECK_UNAVAILABLE_NOTE`.
   - Call `input.loadMoonWindow({ day, zone, ...(place ? { place: { latitude, longitude } } : {}), ...(time ? { time } : {}) }, context)`.
   - On `LocalTimeError`, return `{ error: error.message }`. On an abort, rethrow. On any other failure, return `{ ...result, notes: [...result.notes, LOCATION_CHECK_UNAVAILABLE_NOTE] }`.
   - On success, return `{ ...result, place: echo, location_sensitive: w.location_sensitive, moon: { across_earth: w.across_earth, at_place: w.at_place }, ...(w.event && time ? { event: { local_time: time, ...w.event } } : {}) }`.
6. `statusLabelFor`: unchanged behaviour (dashas label when the engine won't run). Use `parseTimingArgs` there too.

Keep the result-size limit in mind: a day result adds about 400 chars, well under 8 KB.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.places.test.ts src/lib/__tests__/timingTool.test.ts`
Expected: all pass. Inc A's suite stays green unchanged. If an Inc A test must change, stop: it's a finding (see CLAUDE.md "A test that must change to fix a bug is a finding").

- [ ] **Step 3: Toolset wiring tests (red), then wire**

Extend `chatToolset.test.ts`:

```ts
it('registers resolve_place only where the device computes the sky', () => {
  const names = (allowed: boolean) => toolset({ periodSkyAllowed: allowed }).tools.map((t) => t.name);
  expect(names(true)).toEqual(['get_current_datetime', 'get_chart_facts', 'get_timing', 'resolve_place']);
  expect(names(false)).toEqual(['get_current_datetime', 'get_chart_facts', 'get_timing']);
});

it('reads a day without a place in the viewer zone, never the birth zone', async () => {
  const computeMoonWindow = vi.fn(async () => WINDOW);
  loadMock.mockResolvedValue(PREDICTIVE_CONTEXTS);
  const set = toolset({ engine: engineContextWith({ computeMoonWindow }), periodSkyAllowed: true });
  const timing = set.tools.find((t) => t.name === 'get_timing');
  await timing?.execute({ section: 'transits', start: '2026-06-15' }, options());
  const input = computeMoonWindow.mock.calls[0]?.[0];
  // America/Los_Angeles (the viewerZone seam), 2026-06-15 local midnight = 07:00Z; not Asia/Kolkata (birth).
  expect(input).toMatchObject({ day: '2026-06-15', placeStartUtc: '2026-06-15T07:00:00.000Z' });
});

it('the place path never reads the birth place', async () => {
  const placeFromRef = vi.fn(async () => undefined);
  const set = toolset({ placeFromRef, periodSkyAllowed: true });
  await set.tools.find((t) => t.name === 'get_timing')?.execute({ section: 'transits', start: '2026-06-15', place_ref: 'city:1' }, options());
  expect(placeFromRef).toHaveBeenCalledWith('city:1');
  expect(JSON.stringify(placeFromRef.mock.calls)).not.toContain('Delhi');
});
```

`engineContextWith(overrides)` extends the file's `engineContext()` so `engine` and `whenReady` resolve to `{ computePredictive: vi.fn(), ...overrides }`. `WINDOW` and `PREDICTIVE_CONTEXTS` are local constants. Reuse whatever the file already uses to make `loadMock` resolve a sky chart.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts src/lib/__tests__/chatToolsetWiring.test.ts`. Expected: FAIL (no `resolve_place`, and the moon loader is not wired).

Wire `chatToolset.ts`:

```ts
const skyAllowed = input.periodSkyAllowed ?? devicePolicy().periodSkyComputeAllowed;
const tools = createChatAgentTools({
  // ...existing fields...
  periodSkyAllowed: skyAllowed,
  loadMoonWindow: createMoonWindowLoader(input.engine),
  homeZone: zone,
  placeFromRef: input.placeFromRef ?? placeFromRef,
});
return {
  tools: skyAllowed ? [...tools, createResolvePlaceTool()] : tools,
  prepare: /* unchanged */,
};
```

`createChatAgentTools` passes `loadMoonWindow`, `homeZone` and `placeFromRef` to `createTimingTool` unchanged. `placeFromRef` is imported from `./geo/placeLookup`. That module imports `cityLookup.ts`, which loads the JSON only through the existing dynamic `import()`, so importing it costs no data until a lookup runs.

Run: Step 3's command plus the full `src/lib/__tests__` folder. Expected: PASS. If `chatAgentTools.test.ts` pins `createChatAgentTools`' tool list, it is unchanged: `resolve_place` is added by the toolset, not by `createChatAgentTools`.

- [ ] **Step 4: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/chatToolset.ts "tools: skyAllowed ? [...tools, createResolvePlaceTool()] : tools," "tools: [...tools, createResolvePlaceTool()]," -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/timingTool.ts "label: place.summary.label, timezone: place.summary.timezone } : {})" "label: place.summary.label, timezone: place.summary.timezone, latitude: place.latitude } : {})" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.places.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/chatToolset.ts "homeZone: zone," "homeZone: () => input.chartTimeZone," -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts'
```

Add one more for the single-day gate: change the `period.start === period.end` condition in `dayPlaces` to `true` and run `timingTool.places.test.ts`; the split-June test's `load` must have been called, so it dies. And one for the home-zone echo: change `{ basis: 'home_time_zone' }` to `{ basis: 'home_time_zone', timezone: zone }`; the first test dies on `not.toContain('America/Los_Angeles')`. Expected: five `KILLED`.

- [ ] **Step 5: Commit**

Invoke `frontend-quality`.

```bash
git add frontend/apps/web/src/lib/timingTool.ts frontend/apps/web/src/lib/chatAgentTools.ts frontend/apps/web/src/lib/chatToolset.ts \
  frontend/apps/web/src/lib/__tests__/timingTool.places.test.ts frontend/apps/web/src/lib/__tests__/timingFixtures.ts \
  frontend/apps/web/src/lib/__tests__/timingTool.test.ts frontend/apps/web/src/lib/__tests__/chatToolset.test.ts frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts
git commit -m "feat(web): get_timing reads places — location check, event time, split periods; resolve_place on full devices"
```

---

### Task 8: Prompt rules and the place egress test

**Files:**
- Modify: `frontend/packages/llm/src/prompt.ts` (`PLACE_RULES` beside `PERIOD_RULES`, inserted into `CHAT_SYSTEM_PROMPT`)
- Modify: `frontend/packages/llm/src/__tests__/__snapshots__/prompt-snapshots.test.ts.snap` (regenerated)
- Test: `frontend/packages/llm/src/__tests__/prompt-places.test.ts`, `frontend/apps/web/src/lib/__tests__/placeEgress.test.ts`

**Interfaces:**
- Consumes: `CHAT_SYSTEM_PROMPT` assembly (`prompt.ts:206-223`), `PRIVACY_RULE` (`prompt.ts:118`); Task 7 toolset.
- Produces: `PLACE_RULES` (not exported, like `PERIOD_RULES`).

- [ ] **Step 1: Failing prompt test**

```ts
import { describe, expect, it } from "vitest";

import { buildChatMessages } from "../prompt";
import { sanitizeChartForLlm, todayAnalysisInstant } from "../sanitize";
import { CHART_FIXTURE } from "./predictive-fixture";

describe("chat prompt place rules", () => {
  const system = buildChatMessages(sanitizeChartForLlm(CHART_FIXTURE, todayAnalysisInstant(new Date("2026-06-20T00:00:00Z"))), "hi")[0]?.content ?? "";

  it("tells the model when to ask where", () => {
    expect(system).toContain("PLACES:");
    expect(system).toContain("location_sensitive");
    expect(system).toContain("For a specific time of day, always ask where");
  });

  it("keeps the birth place private while allowing places the user named", () => {
    expect(system).toContain("never mention city/state/country names");
    expect(system).toContain("Never name or guess the birth place");
  });
});
```

Use whatever chart fixture `prompt-snapshots.test.ts` uses if `CHART_FIXTURE` isn't the right export name.
Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/prompt-places.test.ts`. Expected: FAIL on `"PLACES:"`.

- [ ] **Step 2: Add `PLACE_RULES`**

```ts
// Time travel Inc C: places. The PRIVACY rule above is about the birth place;
// places the user names in this conversation may be repeated back to them.
const PLACE_RULES = [
  "PLACES: a place never changes a reading longer than a day. If the user names several",
  "places for a month or longer, say plainly that being there doesn't change the reading,",
  "and don't ask where. For a single day, a timing result has location_sensitive: ask where",
  "they were only when it is true; otherwise say in one line that you read the day in their",
  "home time zone. For a specific time of day, always ask where, then call resolve_place.",
  "Places the user names may be repeated back to them. Never name or guess the birth place.",
].join("\n");
```

Insert it into `CHAT_SYSTEM_PROMPT` right after `PERIOD_RULES` (with a `""` spacer line). Regenerate the snapshot: `bunx vitest run src/__tests__/prompt-snapshots.test.ts -u`. Review the diff: only the six new lines and a blank should appear.

Run: both prompt tests. Expected: PASS.

- [ ] **Step 3: Place egress test across real tools**

`frontend/apps/web/src/lib/__tests__/placeEgress.test.ts` drives the real toolset with a Delhi birth (lat 28.61, lon 77.21), real `resolve_place` against the real city list, and a stub engine. It asserts on the JSON the agent would send (`JSON.stringify({ ok: true, value })`, as `safeToolResult` does):

```ts
import { describe, expect, it, vi } from 'vitest';

// ...same vi.mock('../periodSky') / vi.mock('../currentPlanetaryContext') prelude as chatToolset.test.ts...

const BIRTH_COORDS = [/28\.6/, /77\.2/];

describe('a chat-typed city never leaves the device, and the birth place never does', () => {
  it('resolve_place + get_timing (day, place, time) for the birth city carry no coordinates and no birth fields', async () => {
    const computeMoonWindow = vi.fn(async (input) => ({ ...WINDOW, day: input.day, event: { lagna_sign: 'leo', moon: MARK } }));
    const set = toolset({ engine: engineContextWith({ computeMoonWindow }), periodSkyAllowed: true });
    const resolve = set.tools.find((t) => t.name === 'resolve_place');
    const timing = set.tools.find((t) => t.name === 'get_timing');
    const found = (await resolve?.execute({ query: 'Delhi' }, options())) as { status: string; place: { place_ref: string } };
    expect(found.status).toBe('found');
    const day = await timing?.execute({ section: 'transits', start: '2026-06-15', place_ref: found.place.place_ref, time: '15:00' }, options());
    const wire = JSON.stringify({ ok: true, value: found }) + JSON.stringify({ ok: true, value: day });
    for (const pattern of BIRTH_COORDS) expect(wire).not.toMatch(pattern);
    expect(wire).not.toMatch(/latitude|longitude|birth_location|location_name|"lat"|"lon"/);
    // The worker (on device) did get coordinates: that is where they belong.
    expect(computeMoonWindow.mock.calls[0]?.[0].event).toMatchObject({ latitude: expect.any(Number) });
  });
});
```

The label `Delhi, India` and the zone `Asia/Kolkata` are allowed (the user typed Delhi; the birth zone is already in today's egress via `get_current_datetime`). The property under test is "no coordinates, no birth fields".

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/placeEgress.test.ts`. Expected: PASS. Then the red run:

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/placeTool.ts "const summary = (place: ResolvedPlace) => place.summary;" "const summary = (place: ResolvedPlace) => ({ ...place.summary, at: \`\${place.latitude.toFixed(1)},\${place.longitude.toFixed(1)}\` });" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/placeEgress.test.ts'
python3 "$MUTATE" frontend/packages/llm/src/prompt.ts '"Places the user names may be repeated back to them. Never name or guess the birth place.",' '' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/prompt-places.test.ts'
```

The first proves a coarse (one-decimal) coordinate in a string is caught, not just number fields. Expected: two `KILLED`.

- [ ] **Step 4: Commit**

```bash
git add frontend/packages/llm/src/prompt.ts frontend/packages/llm/src/__tests__/prompt-places.test.ts frontend/packages/llm/src/__tests__/__snapshots__/prompt-snapshots.test.ts.snap frontend/apps/web/src/lib/__tests__/placeEgress.test.ts
git commit -m "feat(llm): place rules in the chat prompt; egress test for place and birth coordinates"
```

---

### Task 9: City list stays lazy and its memory is measured

**Files:**
- Modify: `frontend/apps/web/e2e/memory-budget.e2e.spec.ts` (a report-and-gate test for the first place lookup)
- Modify: `frontend/apps/web/src/lib/runtimeObservability.ts` (exit-gate hook `__almameshResolvePlace`, published where `publishRuntimeMoonWindow` is, same condition)
- Modify: `frontend/apps/web/src/lib/memoryBudget.test.ts` if it pins budget literals (add the new `PLACE_LOOKUP_HEAP_GROWTH_MIB = 48` literal pin)
- Modify: `frontend/apps/web/e2e/memoryBudget.ts` (export `PLACE_LOOKUP_HEAP_GROWTH_MIB = 48`)

**Interfaces:**
- Consumes: `lookupPlaceOffline` (Task 3); `performance.measureUserAgentSpecificMemory()` as the memory spec already uses it (L106-111).
- Produces: `window.__almameshResolvePlace?: (query: string) => Promise<unknown>` on hooked builds; `PLACE_LOOKUP_HEAP_GROWTH_MIB`.

- [ ] **Step 1: Pin the literal first (red)**

In `memoryBudget.test.ts`: `expect(PLACE_LOOKUP_HEAP_GROWTH_MIB).toBe(48);`. Run it: FAIL (not exported). Export it from `e2e/memoryBudget.ts`. Run: PASS.

- [ ] **Step 2: The measurement test**

In `memory-budget.e2e.spec.ts`, after the existing gated test, add a test that:
1. Boots the app like the other tests and waits for the engine stage.
2. Records every request URL from `page.on('request')`.
3. Asserts no URL so far contains `cities.min` (the chunk is not loaded at boot).
4. Measures heap (`measureUserAgentSpecificMemory`, the spec's own helper).
5. Calls `await page.evaluate(() => window.__almameshResolvePlace?.('Bogotá'))` and checks it returns `status: 'found'`.
6. Asserts exactly one request URL now contains `cities.min`, that it is same-origin, and that no request went to any other origin.
7. Measures heap again and attaches `{ before, after, growthMiB, firstLookupMs }` with `test.info().attach` / `console.log` (report).
8. Gates `growthMiB <= PLACE_LOOKUP_HEAP_GROWTH_MIB`.

Time the first lookup with `performance.now()` inside the evaluate.

The hook only exists on hooked builds. If the memory-budget lane builds without `VITE_EXIT_GATE_HOOKS=1` (check `dagger/src/index.ts:~560`), run this test only when the hook exists (`test.skip(!hasHook, 'needs VITE_EXIT_GATE_HOOKS=1')`). Run it locally against a hooked build, and say in the PR which build CI uses. Do not change the lane's build flags in this PR.

Run locally (hooked build):
```bash
cd frontend/apps/web && VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 ./node_modules/.bin/vite build --outDir dist-real \
  && (./node_modules/.bin/vite preview --outDir dist-real --port 4199 &) \
  && MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:memory-budget
```
Expected: pass, with the growth and first-lookup time printed. Record both in the PR.
- Growth over 48 MiB means **stop and report** (Ruling 15).
- A first lookup over 1.5 s on the default profile means set `resolve_place`'s `timeoutMs: 10_000` (Task 4 note). Then run the 4× CPU throttle profile the spec's tier note used, and record that number too.

- [ ] **Step 3: Red run for the lazy load**

Temporarily make the import static in `cityLookup.ts`:
```bash
python3 "$MUTATE" frontend/apps/web/src/lib/geo/cityLookup.ts "cityDbPromise = import('../../data/cities.min.json').then(" "cityDbPromise = Promise.resolve(CITY_DB_STATIC).then(" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/placeOffline.contract.test.ts'
```
That alone fails the source contract (the dynamic import string disappears): `KILLED`. Paste it in the PR as the lazy-load guard's red run. The e2e chunk assertion is the end-to-end proof, so don't mutate the build for it.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/e2e/memory-budget.e2e.spec.ts frontend/apps/web/e2e/memoryBudget.ts frontend/apps/web/src/lib/memoryBudget.test.ts frontend/apps/web/src/lib/runtimeObservability.ts frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx
git commit -m "test(web): city list loads lazily, same-origin only; first-lookup heap growth measured and gated"
```

---

### Task 10: End-to-end journey "June in LA then Bogotá, then the 15th", in browserJourneys

**Files:**
- Modify: `frontend/apps/web/e2e/time-travel.spec.ts` (Journey 3; Journey 1's tool-list assertion gains `resolve_place`)
- Modify: `dagger/src/index.ts` (comment above the time-travel command only: "Inc A, B and C journeys"). The command line itself is unchanged, so `tests/dagger-gates.test.ts` stays green as is.

**Interfaces:**
- Consumes: everything above; `prepare`, `predictiveRequestKeys`, `bootEngine`, `seedChart` (`time-travel.spec.ts`, `interpretation.helpers.ts`); the moon-window golden (Task 2) for the expected `location_sensitive` of 2026-06-15.
- Produces: the third `[contract/stubbed]` test in `time-travel.spec.ts`. `playwright.time-travel.config.ts` matches the file, and browserJourneys already runs `TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium` on the hooked build. So the journey is in CI with no new lane line.

- [ ] **Step 1: Update Journey 1's tool list (intended extension)**

In Journey 1, the `decision.tools` expectation becomes `['get_current_datetime', 'get_chart_facts', 'get_timing', 'resolve_place']`. That spec pins `FULL_TIER`, so `resolve_place` is registered. Say so in the PR: an extended contract, not a reversed one.

- [ ] **Step 2: Write Journey 3 (red until the build has Tasks 1–9; run it after they land)**

```ts
/**
 * Journey 3 (spec 2026-10-08, Inc C): "June 2026, first half LA then Bogotá"
 * reads June once and says places don't change it; "what about June 15?"
 * reads the day in the home zone with the location check; "Bogotá" reads the
 * day there. Every city lookup stays on the device: no request leaves the app
 * origin except the stubbed provider.
 */
const SPLIT_QUESTION = 'How was June 2026 for me? I was in LA the first half, then Bogotá.';
const SPLIT_ANSWER = "I looked at 1–30 June 2026. Being in LA and then Bogotá doesn't change June's reading.";
const DAY_QUESTION = 'What about June 15 itself?';
const DAY_ANSWER = 'I read 15 June 2026 in your home time zone.';
const PLACE_REPLY = 'I was in Bogotá that day.';
const PLACE_ANSWER = 'On 15 June 2026 in Bogotá, Colombia, the Moon was';
const SPLIT_SCREENSHOT = 'test-results/time-travel-la-bogota.png';
const MOON_GOLDEN = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../backend/tests/fixtures/moon_window_golden_de421.json'), 'utf8'),
) as Record<string, { location_sensitive: boolean }>;

type Script = (messages: WireMessage[]) => object;

/** The stubbed provider: one script per user question, keyed by its text. */
function scripted(page: Page, scripts: Record<string, Script>, seen: AgentRequest[]): Promise<void> {
  return page.route('**/chat/completions', async (route) => {
    const parsed = JSON.parse(route.request().postData() ?? '{}') as { messages?: WireMessage[]; tools?: AgentRequest['tools'] };
    const messages = parsed.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const key = Object.keys(scripts).find((text) => lastUser.includes(text));
    if (!Array.isArray(parsed.tools) || !key) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '' } }] }) });
    }
    seen.push({ messages, tools: parsed.tools });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: scripts[key](messages) }] }) });
  });
}

const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolMessages = (messages: WireMessage[]) => messages.filter((m) => m.role === 'tool');
const refFrom = (content: string | null | undefined) => (JSON.parse(content ?? '{}') as { value: { place: { place_ref: string } } }).value.place.place_ref;
```

The scripts:
- **SPLIT_QUESTION**
  - No tool messages yet: reply `tool_calls: [resolve_place {query:'Los Angeles'}, resolve_place {query:'Bogotá'}]`.
  - After two tool messages: read both refs and reply `tool_calls: [get_timing {section:'transits', segments:[{start:'2026-06-01', end:'2026-06-15', place_ref: la}, {start:'2026-06-16', end:'2026-06-30', place_ref: bog}]}]`.
  - After three: `content: SPLIT_ANSWER`.
- **DAY_QUESTION**: `get_timing {section:'transits', start:'2026-06-15'}`, then `content: DAY_ANSWER`.
- **PLACE_REPLY**: `resolve_place {query:'Bogotá'}`, then `get_timing {section:'transits', start:'2026-06-15', place_ref}`, then `content: PLACE_ANSWER + ' …'`.

The test body follows Journey 1's skeleton (boot, seed, Dashboard, wait for footer and Life Atlas, record `keysBefore`), then:

```ts
  const offOrigin: string[] = [];
  const cityChunks: string[] = [];
  const origin = new URL(page.url()).origin;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('cities.min')) cityChunks.push(request.url());
    if (url.origin !== origin && !url.pathname.endsWith('/chat/completions')) offOrigin.push(request.url());
  });
  expect(cityChunks, 'the city list must not load before a place is asked about').toEqual([]);

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  const ask = async (text: string, answer: string) => {
    await page.getByTestId('chat-input').fill(text);
    await page.getByTestId('chat-send-button').click();
    await expect(page.getByTestId('chat-panel').getByText(answer, { exact: false })).toBeVisible({ timeout: 240_000 });
  };

  await ask(SPLIT_QUESTION, SPLIT_ANSWER);
  const splitTools = toolMessages(seen.filter((r) => JSON.stringify(r.messages).includes('first half')).at(-1)?.messages ?? []);
  expect(splitTools.map((m) => m.name)).toEqual(['resolve_place', 'resolve_place', 'get_timing']);
  expect(splitTools[0]?.content).toContain('"timezone":"America/Los_Angeles"');
  expect(splitTools[1]?.content).toContain('"label":"Bogotá, Colombia"');
  expect(splitTools[2]?.content).toContain('"period":{"start":"2026-06-01","end":"2026-06-30","days":30,"basis":"period"}');
  expect(splitTools[2]?.content).toContain("Place doesn't change readings for periods longer than a day");
  expect(splitTools[2]?.content).not.toContain('location_sensitive');

  await ask(DAY_QUESTION, DAY_ANSWER);
  const dayTool = toolMessages(seen.at(-1)?.messages ?? []).at(-1);
  expect(dayTool?.content).toContain('"place":{"basis":"home_time_zone"}');
  expect(dayTool?.content).toContain(`"location_sensitive":${MOON_GOLDEN['2026-06-15']?.location_sensitive}`);

  await ask(PLACE_REPLY, PLACE_ANSWER);
  const placeTools = toolMessages(seen.at(-1)?.messages ?? []);
  expect(placeTools.map((m) => m.name)).toEqual(['resolve_place', 'get_timing']);
  expect(placeTools[1]?.content).toContain('"basis":"place","label":"Bogotá, Colombia","timezone":"America/Bogota"');
  expect(placeTools[1]?.content).toContain('"at_place":{');

  for (const message of seen.flatMap((r) => toolMessages(r.messages))) {
    expect(message.content ?? '').not.toMatch(/latitude|longitude|4\.71|74\.07|34\.05|118\.2|28\.6|77\.2/);
  }
  expect(offOrigin, 'no request may leave the app origin except the stubbed provider').toEqual([]);
  expect(cityChunks.length, 'the city list loads at most once, from the app origin').toBeLessThanOrEqual(1);
  expect(cityChunks.every((url) => new URL(url).origin === origin)).toBe(true);
  expect((await predictiveRequestKeys(page)).slice(keysBefore.length), 'the Life Atlas slot must keep its requestKey').toEqual([]);
  await page.screenshot({ path: SPLIT_SCREENSHOT, fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
```

Add `import { readFileSync } from 'node:fs'; import { resolve } from 'node:path';` at the top.
- **Service-worker case.** If the service worker serves the chunk, no request event may fire for it. `cityChunks.length` can then be 0, which the `<= 1` assertion allows, and the "not before" assertion still holds. Put that in the PR as part of the precise "zero network" claim.
- **Seeded chart year.** The seeded chart is born 1990, so 2026 passes every birth gate.

Run:
```bash
cd frontend/apps/web && bun run test:e2e:time-travel --project=chromium
```
Expected: three tests pass. Keep the screenshot. Then the red run: the place path calling the online geocoder must turn the journey red.

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/geo/placeLookup.ts "const rows = await searchCityRowsOffline(query, PLACE_CANDIDATE_LIMIT);" "await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(query)).catch(() => undefined);
  const rows = await searchCityRowsOffline(query, PLACE_CANDIDATE_LIMIT);" -- bash -c 'cd frontend/apps/web && bun run test:e2e:time-travel --project=chromium'
```
Expected: `KILLED`. `offOrigin` lists the Open-Meteo URL; a COEP block still fires the request event.

- [ ] **Step 3: Comment-only lane update, contract tests**

In `dagger/src/index.ts`, change the comment above the time-travel command to name Inc C's journey. Leave the command string alone. Run `bun test ./tests/*.test.ts` from the root. Expected: all pass. `tests/dagger-ingress-contract.test.ts` is untouched.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/e2e/time-travel.spec.ts dagger/src/index.ts
git commit -m "test(e2e): time travel journey 3 — LA then Bogotá, the 15th, and a place, all on device"
```

---

### Task 11: Full gates, parity, memory, live drive, northstar, one PR

**Files:** none new. Evidence only.

- [ ] **Step 1: Full gates from the worktree root**

```bash
cd backend && uv run poe gate; echo "backend gate exit $?"
cd ../frontend && bun run gate; echo "frontend gate exit $?"
cd .. && bun test ./tests/*.test.ts; echo "contract exit $?"
```
Expected: every exit is 0. Record test counts, coverage (backend ≥ 90%; `moon_window.py` 100% branch, including every `raise`), and the xenon line (no new B/C blocks). Invoke `python-quality` on `git diff --name-only origin/main -- backend` and `frontend-quality` on `git diff --name-only origin/main -- frontend`. An uncovered line inside a `raise`/`throw` branch is a gate failure: add the test.

- [ ] **Step 2: Parity and memory**

- Browser parity on a hooked build (Task 2 Step 5 command). Expected: CHECK 7 and CHECK 8 `[ok]`, exit 0. Paste the CHECK 8 line.
- Memory (Task 9 Step 2 command). Paste growth MiB and first-lookup ms, and say whether CI ran the place-lookup test or skipped it for lack of hooks.

- [ ] **Step 3: Drive it live**

`cd frontend/apps/web && VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port 4216`. Use Playwright Chromium (the MCP_DOCKER browser cannot boot the engine). Onboard a chart, open chat, and ask the three Journey 3 questions.
- With an OpenRouter key on this machine: confirm that (a) the June answer says places don't change it and doesn't ask where; (b) the 15th answer names "home time zone" and asks where only if `location_sensitive` was true; (c) after "Bogotá" the answer names Bogotá and the Moon at the start and end of that day. Watch the network panel and confirm no request to any host but the app origin and the provider.
- With no key: say plainly in the PR that the real-model drive is unverified and Task 10's stubbed journey is the evidence.
- Take screenshots and confirm a clean console for each. Repeat once with `deviceMemory` pinned to 2 (lite). There must be no `resolve_place` in the tool list (check the provider request body), a dashas-only answer, and no `cities.min` request.

- [ ] **Step 4: Northstar grade**

Dispatch the `northstar` agent (standing approval) on the branch with:
- the claim "a chat-typed city never leaves the device", plus "only sanitized facts reach the model" and "CPython/Pyodide parity";
- the mutation table;
- the CHECK 8 output, the memory numbers, and the e2e screenshot;
- the lite-tier drive and the gate exits.

Fix anything below A, re-run Step 1, and re-grade.

- [ ] **Step 5: One PR**

```bash
git push -u origin claude/time-travel-c
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-c \
  --title "feat: time travel step C — places, location check, split periods (on device)" --body-file /tmp/inc-c-pr.md
```

The body states:
- what ships (the Inc C row);
- the claim touched ("a chat-typed city never leaves the device", with its precise browser meaning: no request off the app origin; the city chunk is same-origin, lazy and at most once);
- the Rulings list verbatim, with the "location check is almost always true" finding at the top for Harish's call;
- Journey 1's extended tool list (an extension, not a reversal);
- the evidence table: gate exits and counts, CHECK 8, memory growth and first-lookup time, e2e pass plus screenshot, lite-tier drive, and the live drive or "unverified";
- the mutation table: every `KILLED` line from Tasks 1–10.

End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
```

- [ ] **Step 6: Merge and clean up in the same breath**

When CI is green and northstar is A:
1. `gh pr merge --squash --delete-branch`.
2. `git worktree remove .worktrees/time-travel-c`, then `git branch -D claude/time-travel-c`.
3. Confirm CI is green on `main`.
4. Confirm the deploy serves the merge SHA: `build.json` `git_sha` equals the merge SHA, with `content-type: application/json`.
5. Run `dangling_audit.py` before reporting done.

---

## Self-review notes (spec coverage)

| Spec item (Inc C / Part 2) | Task |
| --- | --- |
| `resolve_place`, offline only, `searchCitiesOffline`, never `searchCities` | 3, 4 (source contract), 10 (network) |
| One / several (≤ 5) / none → found / ambiguous / not_found | 3, 4 |
| Model sees only typed text, label, IANA zone; coordinates stay on device, keyed by `place_ref` | 3 (stateless ref, Ruling 4), 4, 7, 8 |
| Location check: Moon sign, nakshatra, tithi at 00:00 UTC+14 and 24:00 UTC−12 | 1 (flag on sign only, Ruling 1), 2 |
| `compute_moon_window` in Python; tithi new; `get_nakshatra_info` reused | 1 |
| `computeMoonWindow` worker request beside `computePredictive`; parity gate | 2 |
| Values at the place's local start and end of day when the place is known | 1, 6, 7 |
| Single day: default to home zone and say so; ask only when `location_sensitive` | 7, 8 (no zone name, Ruling 2) |
| A month or longer: never ask; several places: say why | 7 (note), 8 (prompt) |
| Specific time of day: always ask; event ascendant needs lat/lon | 1 (lagna sign), 5 (`time` needs a place), 6, 7, 8 |
| `segments: [{ start, end, place_ref }]` merged for dashas/slow transits; only single-day reads use a segment's place | 5, 7 |
| Error handling: place not found / ambiguous | 3, 4 |
| Performance: `resolve_place` < 100 ms once loaded | 3 (unit), 9 (measured in browser) |
| Testing rows: Location check; Offline place lookup (fetch spy); No coordinates to the model | 1, 3, 4, 8 |
| Journey 3 end to end, in browserJourneys | 10 |
| Privacy: A/B rules intact; no new egress about the birth place | 7 (gate order), 8 (egress), Global Constraints |
| Low-end: dashas only on lite/minimal; lazy city list, memory measured | 7, 9, 11 |

Known gaps, deliberately not tasks:
- exact change times inside a day (out of scope for v1 per spec);
- persisting a chosen place on a thread (`as_of.place` is Inc D);
- i18n of tool status labels (Ruling 14);
- whether `location_sensitive` should use a narrower definition (Spec gaps, for Harish).
