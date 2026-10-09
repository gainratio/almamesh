# Time Travel Increment A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person type "what happened in June 2019?" into plain chat (Dashboard or MeshEdge) and get an answer about June 2019, because the chat's one timing tool now takes dates.

**Architecture:** `get_current_timing` is renamed `get_timing` and gains optional `start`/`end` (`YYYY-MM-DD`). Pure, date-only logic (argument rules, picking dashas by date, trimming transit events to the period, the `"period"` prompt basis) lives in `@almamesh/llm`. Engine runs for a period go through a new in-memory LRU (`apps/web/src/lib/periodSky.ts`) that never touches the Life Atlas's single store slot. One builder, `buildChatToolset`, replaces the two near-copies in `Dashboard.tsx` and `MeshEdge.tsx`, owns the router, and reads "today" in the viewer (device) zone for both pages.

**Tech Stack:** TypeScript, React 19, Vite, Vitest (packages + web unit), `bun:test` (repo contract tests in `tests/`), Playwright (e2e), Dagger (CI lanes). No Python changes in this increment.

**Spec:** `docs/superpowers/specs/2026-10-08-time-travel-design.md` (Inc A section, plus "Rules the app enforces", "What each section returns", "Dashas by date", "Telling the prompt which period it is", "Computing a period's sky", "The regex router", "One tool builder", Privacy, Performance, Error handling, Testing). Open question 1 is decided: unify "today" on the viewer zone.

## Global Constraints

- Work in a fresh worktree off `main`: `/opt/homebrew/bin/git -C /Users/harish/dev/oss/almamesh worktree add .worktrees/time-travel-inc-a -b claude/time-travel-inc-a origin/main`. All paths below are relative to that worktree. Use `/opt/homebrew/bin/git` (put `/opt/homebrew/bin` first in `PATH`).
- Stage named files only. Never `git add -A` or `git add .`.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
  ```
- **No astrology math in TypeScript** (repo CLAUDE.md rule 2). Everything this plan adds in TS is *selection over engine-stated dates*: string compares of `YYYY-MM-DD`, overlap filters, calendar-day counts. No longitudes, no dasha arithmetic, no ephemeris. Say so in the PR body.
- **SQLite-only for user data.** The period-sky LRU is memory only (recomputable engine output). Nothing new goes into IndexedDB, localStorage or the canonical store.
- Tool contract (spec, verbatim): `section` is `"dashas" | "transits" | "domains" | "strength"` (required); `start` is `YYYY-MM-DD`, omitted → today; `end` is `YYYY-MM-DD`, inclusive, omitted → same as `start`.
- Every result echoes `{ "period": { "start", "end", "days", "basis" } }`, `basis` is `"today"` or `"period"`.
- Caps (spec, verbatim): span over 2 years → dashas only, note `"Over 2 years: showing dashas only. Ask about a shorter span for transits."`; any day after `2052-12-31` → dashas only with a note; before-birth refusal text is the constant `"This period starts before the birth date. Ask about a period after it."` and never contains the birth date.
- Fast grahas (sun, moon, mercury, venus) are dropped from multi-day transit results. Slow grahas kept: mars, jupiter, saturn, rahu, ketu.
- `covered_events` until Inc B: exactly `["jupiter_ingress", "saturn_ingress", "dasha_change", "sade_sati_phase"]`.
- The first maha's start (the birth instant) always crosses as `"birth"`, never a month.
- Timing tool timeout: `150_000` ms. The agent's global tool cap (`AGENT_LIMITS.maxToolTimeoutMs`) must rise to `150_000` or the tool's own timeout is silently clamped to 60 s.
- Period-sky LRU sizes by device tier: `full` 5, `lite` 3, `minimal` 1 (`DevicePolicy.periodSkyCacheSize`).
- Tool errors the model must read (bad dates, before birth) are **returned as `{ "error": "..." }` values, never thrown**. A thrown error reaches the model only as the opaque `"The local tool could not complete safely."` (`packages/llm/src/agent.ts:695`) and forces the final round.
- After every TS task, invoke the `frontend-quality` skill on the changed files. No Python is touched; if that changes, `python-quality` applies.
- Commands: frontend gate `cd frontend && bun run gate`; backend gate `cd backend && poe gate`; contract tests `bun test ./tests/*.test.ts` from the repo root (bun:test, not vitest). Package unit tests: `cd frontend/packages/<pkg> && bunx vitest run <file>`; web unit: `cd frontend/apps/web && bunx vitest run <file>`.
- **Every guard gets a mutation-red step** using the helper below. It applies one exact-text mutation, asserts the text changed, runs the test, restores the file, and exits 0 only when the test went red. The verdict is the helper's exit code, never grepped output. Paste each KILLED line into the PR's mutation table.

Save this once as `"${TMPDIR:-/tmp}/almamesh-mutate.py"` and `export MUTATE="${TMPDIR:-/tmp}/almamesh-mutate.py"`:

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

## Review Focus

1. **"may", "march" and "Marco" in ordinary sentences.** "What may happen today?" must still pre-run today's sky; only "in May", "May 2019", "3 May" count as a period. Test: Task 10.
2. **A period inside the first mahadasha, through the prompt path, not only the tool.** `sanitizeChartForLlm` with a period basis in mid-2000 for a March-2000 birth must not print `2000-03` anywhere (maha window, antar tree). Test: Task 1 (egress).
3. **Period basis on a device west of UTC.** `as_of.date` must be the period's first day (`2026-06-01`), not the day before, even when the process zone is `America/Los_Angeles` (the old `localIsoDate` reads the runtime zone). Test: Task 1.
4. **`end` without `start`.** Must be the error `"start is required when end is given"`, never a silent "today". Test: Task 3.
5. **A failed or timed-out period compute must not poison the cache.** A rejected compute is evicted so the next ask recomputes; a waiter that times out does not cancel the compute, and a later ask joins it. Test: Task 7.

---

### Task 1: The "period" basis in the sanitizer, with the birth start withheld

**Files:**
- Modify: `frontend/packages/llm/src/sanitize.ts` (types at ~222-233, `todayAnalysisInstant` ~258, `localIsoDate` ~263, dasha helpers ~288-375, `sanitizeChartForLlm` ~500)
- Modify: `frontend/packages/llm/src/index.ts:8-14`
- Create: `frontend/packages/llm/src/__tests__/birth-2000-fixture.ts`
- Create: `frontend/packages/llm/src/__tests__/period-basis.test.ts`
- Modify: `frontend/packages/llm/src/__tests__/egress.test.ts`

**Interfaces:**
- Produces: `interface PeriodRange { readonly start: string; readonly end: string }`; `type AnalysisInstant = { basis: "chart" | "today"; instant: Date } | { basis: "period"; instant: Date; period: PeriodRange }`; `SanitizedAsOf` gains optional `period_start`, `period_end`; `periodAnalysisInstant(start: string, end: string): AnalysisInstant`; `dashaBoundaryMonth(iso: string, birthStart: string | undefined): string` (returns `"birth"` or `"YYYY-MM"`). Fixture exports `BIRTH_2000_START`, `BIRTH_2000_DASHAS`, `BIRTH_2000_CHART`.

- [ ] **Step 1: Write the shared fixture**

`frontend/packages/llm/src/__tests__/birth-2000-fixture.ts`:

```ts
// A synthetic dasha tree for someone born 2000-03-15. The dates are made up
// for selection tests; they are NOT engine output. The first maha and its
// first antar both start at the birth instant, exactly as the engine emits
// them (calculations.py `_subdivide_period` starts at the parent's start).
import type { DashaPeriod, SiderealChart, VimshottariDasha } from "@almamesh/browser/types";

export const BIRTH_2000_START = "2000-03-15T04:30:00Z";

function row(lord: string, start: string, end: string, years: number): DashaPeriod {
  return { lord, start_date: start, end_date: end, duration_years: years };
}

const MOON_ANTAR = row("moon", "2022-01-15T00:00:00Z", "2023-09-15T00:00:00Z", 1.67);

export const BIRTH_2000_DASHAS: VimshottariDasha = {
  maha_dasha_sequence: [
    {
      ...row("mercury", BIRTH_2000_START, "2010-09-15T00:00:00Z", 10.5),
      antar_sequence: [
        row("mercury", BIRTH_2000_START, "2001-11-20T00:00:00Z", 1.68),
        row("ketu", "2001-11-20T00:00:00Z", "2002-07-01T00:00:00Z", 0.61),
        row("venus", "2002-07-01T00:00:00Z", "2004-05-01T00:00:00Z", 1.75),
      ],
    },
    {
      ...row("ketu", "2010-09-15T00:00:00Z", "2017-09-15T00:00:00Z", 7),
      antar_sequence: [
        row("ketu", "2010-09-15T00:00:00Z", "2011-02-11T00:00:00Z", 0.41),
        row("venus", "2011-02-11T00:00:00Z", "2012-04-11T00:00:00Z", 1.17),
      ],
    },
    {
      ...row("venus", "2017-09-15T00:00:00Z", "2037-09-15T00:00:00Z", 20),
      antar_sequence: [
        row("venus", "2017-09-15T00:00:00Z", "2021-01-15T00:00:00Z", 3.33),
        row("sun", "2021-01-15T00:00:00Z", "2022-01-15T00:00:00Z", 1),
        MOON_ANTAR,
      ],
    },
  ],
  current_maha: row("venus", "2017-09-15T00:00:00Z", "2037-09-15T00:00:00Z", 20),
  current_antar: MOON_ANTAR,
  current_pratyantar: row("rahu", "2022-04-25T00:00:00Z", "2022-08-15T00:00:00Z", 0.3),
  pratyantar_sequence: [
    row("moon", "2022-01-15T00:00:00Z", "2022-03-15T00:00:00Z", 0.14),
    row("mars", "2022-03-15T00:00:00Z", "2022-04-25T00:00:00Z", 0.1),
    row("rahu", "2022-04-25T00:00:00Z", "2022-08-15T00:00:00Z", 0.3),
  ],
};

export const BIRTH_2000_CHART = {
  ayanamsa_value: 23.85,
  lagna: { sign: "aries" },
  planets: [],
  houses: [],
  yogas: [],
  dashas: BIRTH_2000_DASHAS,
} as unknown as SiderealChart;
```

- [ ] **Step 2: Write the failing tests**

`frontend/packages/llm/src/__tests__/period-basis.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";
import { BIRTH_2000_CHART } from "./birth-2000-fixture";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  // Assigning undefined would set the string "undefined"; delete instead.
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("periodAnalysisInstant", () => {
  it("is the period's first day at UTC midnight, labelled 'period'", () => {
    expect(periodAnalysisInstant("2026-06-01", "2026-06-30")).toEqual({
      basis: "period",
      instant: new Date("2026-06-01T00:00:00.000Z"),
      period: { start: "2026-06-01", end: "2026-06-30" },
    });
  });

  it.each([
    ["2026-6-1", "2026-06-30"],
    ["2026-06-30", "2026-06-01"],
  ])("refuses a malformed or reversed period %s..%s", (start, end) => {
    expect(() => periodAnalysisInstant(start, end)).toThrow(/period/);
  });
});

describe("sanitizeChartForLlm with a period basis", () => {
  it("stamps as_of with the period, not the runtime's calendar day", () => {
    process.env.TZ = "America/Los_Angeles"; // UTC midnight is the PREVIOUS day here
    const chart = sanitizeChartForLlm(BIRTH_2000_CHART, periodAnalysisInstant("2026-06-01", "2026-06-30"));
    expect(chart.as_of).toEqual({
      date: "2026-06-01",
      basis: "period",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
    });
  });

  it("reports the birth row's start as 'birth', never its month", () => {
    const chart = sanitizeChartForLlm(BIRTH_2000_CHART, periodAnalysisInstant("2000-06-01", "2000-06-30"));
    const serialized = JSON.stringify(chart);
    expect(serialized).not.toContain("2000-03");
    expect(chart.dashas?.maha_dasha_sequence[0]).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(chart.dashas?.maha_dasha_sequence[0].antar_sequence?.[0]).toMatchObject({
      lord: "mercury",
      start_month: "birth",
    });
  });

  it("leaves chart and today stamps exactly as before", () => {
    const chart = sanitizeChartForLlm(BIRTH_2000_CHART, {
      basis: "chart",
      instant: new Date("2022-06-01T12:00:00.000Z"),
    });
    expect(chart.as_of).toEqual({ date: expect.stringMatching(/^2022-06-0[12]$/), basis: "chart" });
  });
});
```

Append to `frontend/packages/llm/src/__tests__/egress.test.ts` (keep the existing imports; add the new ones at the top of the file):

```ts
import { buildChatMessages } from "../prompt";
import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";
import { BIRTH_2000_DASHAS } from "./birth-2000-fixture";

describe("egress — a period early in life never reveals the birth month", () => {
  it("keeps 2000-03 out of the prompt for a 2000-03-15 birth asked about June 2000", () => {
    const chart = { ...realChart, dashas: BIRTH_2000_DASHAS };
    const sanitized = sanitizeChartForLlm(chart, periodAnalysisInstant("2000-06-01", "2000-06-30"));
    const prompt = JSON.stringify(buildChatMessages(sanitized, "What was June 2000 like?"));
    expect(prompt).not.toContain("2000-03");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-basis.test.ts src/__tests__/egress.test.ts`
Expected: FAIL. `periodAnalysisInstant` is not exported (TypeError / import error), and the egress case fails on `2000-03`.

- [ ] **Step 4: Implement the period basis and the birth withholding in `sanitize.ts`**

Replace the `AnalysisInstant` / `SanitizedAsOf` block (~line 222-233) with:

```ts
/** A calendar period, both ends inclusive, as `YYYY-MM-DD` days. */
export interface PeriodRange {
  readonly start: string;
  readonly end: string;
}

/**
 * The instant every "current"/"remaining" statement in the prompt is relative
 * to. `chart` = the chart's own stored analysis instant. `today` = the wall
 * clock, only where a caller genuinely asks about today. `period` = a period
 * the user asked about; `instant` is its first day at UTC midnight.
 */
export type AnalysisInstant =
  | { readonly basis: "chart" | "today"; readonly instant: Date }
  | { readonly basis: "period"; readonly instant: Date; readonly period: PeriodRange };

/** The "as of" stamp the prompt carries: a calendar date, its basis, and the period when there is one. */
export interface SanitizedAsOf {
  readonly date: string;
  readonly basis: AnalysisInstant["basis"];
  readonly period_start?: string;
  readonly period_end?: string;
}
```

After `todayAnalysisInstant` add:

```ts
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A labelled "period" basis for a question about a period other than today. */
export function periodAnalysisInstant(start: string, end: string): AnalysisInstant {
  if (!ISO_DAY.test(start) || !ISO_DAY.test(end) || end < start) {
    throw new Error("analysis instant: a period needs YYYY-MM-DD days with start <= end");
  }
  return {
    basis: "period",
    instant: requireInstant(`${start}T00:00:00Z`, "period start"),
    period: { start, end },
  };
}

/** The prompt's as-of stamp. A period is stamped with its own first day, never a runtime-zone date. */
function sanitizedAsOf(asOf: AnalysisInstant): SanitizedAsOf {
  if (asOf.basis === "period") {
    return {
      date: asOf.period.start,
      basis: "period",
      period_start: asOf.period.start,
      period_end: asOf.period.end,
    };
  }
  return { date: localIsoDate(asOf.instant), basis: asOf.basis };
}
```

Thread the birth instant through the dasha helpers. Add next to `monthOf`:

```ts
const BIRTH_BOUNDARY = "birth";

/**
 * A dasha boundary at month precision, or "birth" when it IS the birth
 * instant (the first maha's start, which the engine also uses for that maha's
 * first antar). The birth month must never cross, whatever the as-of.
 */
export function dashaBoundaryMonth(iso: string, birthStart: string | undefined): string {
  return iso === birthStart ? BIRTH_BOUNDARY : monthOf(iso);
}
```

Replace `toDatedPeriod`, `relativizeMahaPeriod`, `relativizeCurrentPeriod`, `relativizeCurrentOrNull` and `sanitizeDashas` with:

```ts
/** A dated sequence row reduced to month precision (the LLM-bound granularity). */
function toDatedPeriod(period: DashaPeriod, birthStart: string | undefined): SanitizedDatedPeriod {
  return {
    lord: period.lord,
    duration_years: period.duration_years,
    start_month: dashaBoundaryMonth(period.start_date, birthStart),
    end_month: dashaBoundaryMonth(period.end_date, birthStart),
  };
}

function relativizeMahaPeriod(
  period: MahaDashaPeriod,
  now: Date,
  birthStart: string | undefined,
): SanitizedMahaPeriod {
  const start = new Date(period.start_date);
  const end = new Date(period.end_date);
  const base = { lord: period.lord, duration_years: period.duration_years };
  const window = period.antar_sequence
    ? {
        start_month: dashaBoundaryMonth(period.start_date, birthStart),
        end_month: dashaBoundaryMonth(period.end_date, birthStart),
      }
    : {};

  if (start <= now && now <= end) {
    const remaining = Math.floor(wholeDaysBetween(now, end) / DAYS_PER_YEAR);
    return {
      ...base,
      status: `current (${remaining} years remaining)`,
      ...window,
      ...(period.antar_sequence
        ? { antar_sequence: period.antar_sequence.map((row) => toDatedPeriod(row, birthStart)) }
        : {}),
    };
  }
  if (now < start) {
    const untilStart = Math.floor(wholeDaysBetween(now, start) / DAYS_PER_YEAR);
    return { ...base, status: `future (starts in ${untilStart} years)`, ...window };
  }
  return { ...base, status: "past" };
}

function relativizeCurrentPeriod(
  period: NonNullable<VimshottariDasha["current_maha"]>,
  now: Date,
  dated: boolean,
  birthStart: string | undefined,
): SanitizedCurrentPeriod {
  const end = new Date(period.end_date);
  const remaining = Math.max(0, Math.floor(wholeDaysBetween(now, end) / DAYS_PER_MONTH));
  return {
    lord: period.lord,
    duration_years: period.duration_years,
    months_remaining: remaining,
    ...(dated
      ? {
          start_month: dashaBoundaryMonth(period.start_date, birthStart),
          end_month: dashaBoundaryMonth(period.end_date, birthStart),
        }
      : {}),
  };
}

function relativizeCurrentOrNull(
  period: VimshottariDasha["current_maha"],
  now: Date,
  dated: boolean,
  birthStart: string | undefined,
): SanitizedCurrentPeriod | null {
  return period ? relativizeCurrentPeriod(period, now, dated, birthStart) : null;
}

function sanitizeDashas(dashas: VimshottariDasha, now: Date): SanitizedDashas {
  const dated = dashas.maha_dasha_sequence.some((p) => p.antar_sequence !== undefined);
  // The first maha starts at the birth instant: that boundary never crosses as a month.
  const birthStart = dashas.maha_dasha_sequence[0]?.start_date;
  return {
    maha_dasha_sequence: dashas.maha_dasha_sequence.map((p) => relativizeMahaPeriod(p, now, birthStart)),
    current_maha: relativizeCurrentOrNull(dashas.current_maha, now, dated, birthStart),
    current_antar: relativizeCurrentOrNull(dashas.current_antar, now, dated, birthStart),
    current_pratyantar: relativizeCurrentOrNull(dashas.current_pratyantar, now, dated, birthStart),
    ...(dashas.pratyantar_sequence
      ? { pratyantar_sequence: dashas.pratyantar_sequence.map((row) => toDatedPeriod(row, birthStart)) }
      : {}),
    ...(dashas.convention ? { convention: dashas.convention } : {}),
  };
}
```

In `sanitizeChartForLlm`, replace `as_of: { date: localIsoDate(now), basis: asOf.basis },` with `as_of: sanitizedAsOf(asOf),`.

In `frontend/packages/llm/src/index.ts`, extend the first export block and the type export:

```ts
export {
  sanitizeChartForLlm,
  IDENTIFIER_FIELDS,
  chartAnalysisInstant,
  todayAnalysisInstant,
  periodAnalysisInstant,
} from "./sanitize";
export type { AnalysisInstant, PeriodRange, SanitizedAsOf } from "./sanitize";
```

- [ ] **Step 5: Run the tests to verify they pass, then the whole llm suite**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-basis.test.ts src/__tests__/egress.test.ts && bunx vitest run && bunx tsc --noEmit`
Expected: PASS. If any existing test asserted a birth month in `start_month`, that test asserted a leak: invert it to expect `"birth"`, never delete it, and record "contract reversed: birth month no longer crosses" for the PR body.

- [ ] **Step 6: Mutation red, twice**

Run from `frontend/packages/llm`:

```bash
python3 "$MUTATE" src/sanitize.ts \
  'return iso === birthStart ? BIRTH_BOUNDARY : monthOf(iso);' \
  'return monthOf(iso);' \
  -- bunx vitest run src/__tests__/period-basis.test.ts src/__tests__/egress.test.ts
python3 "$MUTATE" src/sanitize.ts \
  'date: asOf.period.start,' \
  'date: localIsoDate(asOf.instant),' \
  -- bunx vitest run src/__tests__/period-basis.test.ts
```

Expected: both print `KILLED` and exit 0.

- [ ] **Step 7: frontend-quality, then commit**

Invoke the `frontend-quality` skill on the changed files. Then:

```bash
git add frontend/packages/llm/src/sanitize.ts frontend/packages/llm/src/index.ts \
  frontend/packages/llm/src/__tests__/birth-2000-fixture.ts \
  frontend/packages/llm/src/__tests__/period-basis.test.ts \
  frontend/packages/llm/src/__tests__/egress.test.ts
git commit -m "feat(llm): period analysis basis; birth boundary always crosses as 'birth'"
```

---

### Task 2: Period label in the facts block, and the period rule in the chat system prompt

**Files:**
- Modify: `frontend/packages/llm/src/facts.ts:83-100` (`dashaBlock`)
- Modify: `frontend/packages/llm/src/prompt.ts:196-218` (`CHAT_SYSTEM_PROMPT`)
- Create: `frontend/packages/llm/src/__tests__/period-prompt.test.ts`
- Modify: `frontend/packages/llm/src/__tests__/__snapshots__/prompt-snapshots.test.ts.snap` (regenerated)

**Interfaces:**
- Consumes: `SanitizedAsOf.period_start/period_end`, `periodAnalysisInstant` (Task 1).
- Produces: `formatPeriodLabel(start: string, end: string): string` exported from `facts.ts` (e.g. `"1–30 June 2026"`); the chat system prompt contains `I looked at 1–30 June 2026.`

- [ ] **Step 1: Write the failing tests**

`frontend/packages/llm/src/__tests__/period-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildChartFactsBlock, formatPeriodLabel } from "../facts";
import { buildChatMessages } from "../prompt";
import { periodAnalysisInstant, sanitizeChartForLlm } from "../sanitize";
import { BIRTH_2000_CHART } from "./birth-2000-fixture";

describe("formatPeriodLabel", () => {
  it.each([
    ["2026-06-01", "2026-06-30", "1–30 June 2026"],
    ["2019-01-01", "2019-12-31", "1 January–31 December 2019"],
    ["2026-06-15", "2026-06-15", "15 June 2026"],
    ["2019-11-01", "2020-02-29", "1 November 2019–29 February 2020"],
  ])("%s..%s reads as %s", (start, end, label) => {
    expect(formatPeriodLabel(start, end)).toBe(label);
  });
});

describe("the facts block under a period basis", () => {
  it("names the period asked about instead of 'today'", () => {
    const block = buildChartFactsBlock(
      sanitizeChartForLlm(BIRTH_2000_CHART, periodAnalysisInstant("2026-06-01", "2026-06-30")),
    );
    expect(block).toContain("as of 1–30 June 2026 (the period asked about)");
    expect(block).not.toContain(", today)");
  });
});

describe("the chat system prompt", () => {
  it("requires the answer to name the period it looked at", () => {
    const [system] = buildChatMessages(
      sanitizeChartForLlm(BIRTH_2000_CHART, { basis: "chart", instant: new Date("2022-06-01T00:00:00Z") }),
      "How was June 2019?",
    );
    expect(system.content).toContain("I looked at 1–30 June 2026.");
    expect(system.content).toContain("available: false");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-prompt.test.ts`
Expected: FAIL (`formatPeriodLabel` is not exported).

- [ ] **Step 3: Implement**

In `facts.ts`, add above `dashaBlock` and use it in the header:

```ts
const PERIOD_LABEL_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * A period in plain English (the prompt language): "1–30 June 2026". ICU puts
 * thin spaces around the range dash and their presence varies by ICU version,
 * so the dash is normalized to keep prompts byte-stable.
 */
export function formatPeriodLabel(start: string, end: string): string {
  return PERIOD_LABEL_FORMAT.formatRange(new Date(`${start}T00:00:00Z`), new Date(`${end}T00:00:00Z`)).replace(
    /\s*–\s*/g,
    "–",
  );
}

function dashaHeader(asOf: SanitizedChart["as_of"]): string {
  if (asOf.basis === "period" && asOf.period_start && asOf.period_end) {
    return `Dasha period as of ${formatPeriodLabel(asOf.period_start, asOf.period_end)} (the period asked about):`;
  }
  const basis = asOf.basis === "today" ? "today" : "the chart's analysis date";
  return `Current dasha period (as of ${asOf.date}, ${basis}):`;
}
```

In `dashaBlock`, replace the two lines

```ts
  const basis = chart.as_of.basis === "today" ? "today" : "the chart's analysis date";
  const header = `Current dasha period (as of ${chart.as_of.date}, ${basis}):`;
```

with `const header = dashaHeader(chart.as_of);`.

In `prompt.ts`, add above `CHAT_SYSTEM_PROMPT`:

```ts
// Time travel (spec 2026-10-08): the timing tool can read any period. The model
// must say which period it read, and must not pass today's sky off as another date's.
const PERIOD_RULES = [
  "TIME PERIODS: a timing tool result carries a `period` (start, end, basis). Open your",
  "answer by naming that period in plain words, for example \"I looked at 1–30 June 2026.\"",
  "Never present today's sky as the sky of another date. If a result has notes, follow",
  "them and say what was left out. If a result says available: false, say you couldn't",
  "work out the sky for that period on this device, and that dasha answers still work.",
].join("\n");
```

and insert `"",` then `PERIOD_RULES,` into the `CHAT_SYSTEM_PROMPT` array directly after the `"inventing an answer.",` line.

- [ ] **Step 4: Run, then regenerate and review snapshots**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-prompt.test.ts`
Expected: PASS.

Run: `bunx vitest run -u src/__tests__/prompt-snapshots.test.ts && git diff --stat -- src/__tests__/__snapshots__/ && git diff -- src/__tests__/__snapshots__/ | grep '^[-+][^-+]'`
Expected: the only added lines are the five `PERIOD_RULES` lines plus one blank line, in each chat snapshot. Nothing removed. If anything else moved, stop and investigate.

Then: `bunx vitest run && bunx tsc --noEmit` → PASS.

- [ ] **Step 5: Mutation red**

```bash
cd frontend/packages/llm
python3 "$MUTATE" src/facts.ts \
  'if (asOf.basis === "period" && asOf.period_start && asOf.period_end) {' \
  'if (false) {' \
  -- bunx vitest run src/__tests__/period-prompt.test.ts
python3 "$MUTATE" src/prompt.ts '  PERIOD_RULES,' '' \
  -- bunx vitest run src/__tests__/period-prompt.test.ts
```

Expected: both `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/packages/llm/src/facts.ts frontend/packages/llm/src/prompt.ts \
  frontend/packages/llm/src/__tests__/period-prompt.test.ts \
  frontend/packages/llm/src/__tests__/__snapshots__/prompt-snapshots.test.ts.snap
git commit -m "feat(llm): name the asked-about period in facts and require it in chat answers"
```

---

### Task 3: Period argument rules (pure)

**Files:**
- Create: `frontend/packages/llm/src/period.ts`
- Modify: `frontend/packages/llm/src/index.ts`
- Create: `frontend/packages/llm/src/__tests__/period.test.ts`

**Interfaces:**
- Consumes: `PeriodRange` (Task 1).
- Produces (all exported from `@almamesh/llm`):
  - `ISO_DAY_PATTERN: "^\\d{4}-\\d{2}-\\d{2}$"`
  - `BEFORE_BIRTH_MESSAGE`, `OVER_TWO_YEARS_NOTE`, `PAST_EPHEMERIS_NOTE` (strings)
  - `type PeriodArgs = { kind: "today" } | { kind: "period"; period: PeriodRange } | { kind: "invalid"; error: string }`
  - `parsePeriodArgs(args: { readonly start?: unknown; readonly end?: unknown }): PeriodArgs`
  - `interface PeriodEcho { start: string; end: string; days: number; basis: "today" | "period" }`
  - `periodEcho(period: PeriodRange, basis: PeriodEcho["basis"]): PeriodEcho`
  - `startsBeforeBirth(period: PeriodRange, birthDay: string | undefined): boolean`
  - `interface PeriodLimits { dashasOnly: boolean; notes: readonly string[] }`, `periodLimits(period: PeriodRange): PeriodLimits`

- [ ] **Step 1: Write the failing tests**

`frontend/packages/llm/src/__tests__/period.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  BEFORE_BIRTH_MESSAGE,
  OVER_TWO_YEARS_NOTE,
  PAST_EPHEMERIS_NOTE,
  parsePeriodArgs,
  periodEcho,
  periodLimits,
  startsBeforeBirth,
} from "../period";

describe("parsePeriodArgs", () => {
  it("no dates means today", () => {
    expect(parsePeriodArgs({})).toEqual({ kind: "today" });
  });

  it("start alone is a single day", () => {
    expect(parsePeriodArgs({ start: "2019-03-12" })).toEqual({
      kind: "period",
      period: { start: "2019-03-12", end: "2019-03-12" },
    });
  });

  it("accepts a real leap day", () => {
    expect(parsePeriodArgs({ start: "2024-02-29" }).kind).toBe("period");
  });

  it.each([
    [{ start: "2026-02-30" }, "start must be a date like 2026-06-01"],
    [{ start: "2023-02-29" }, "start must be a date like 2026-06-01"],
    [{ start: "2026-6-1" }, "start must be a date like 2026-06-01"],
    [{ start: 20260601 }, "start must be a date like 2026-06-01"],
    [{ start: "2026-06-01", end: "June" }, "end must be a date like 2026-06-01"],
    [{ start: "2026-06-30", end: "2026-06-01" }, "end is before start"],
    [{ end: "2026-06-30" }, "start is required when end is given"],
  ])("rejects %j with a reason the model can act on", (args, error) => {
    expect(parsePeriodArgs(args)).toEqual({ kind: "invalid", error });
  });
});

describe("periodEcho", () => {
  it("counts days inclusively", () => {
    expect(periodEcho({ start: "2026-06-01", end: "2026-06-30" }, "period")).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
      days: 30,
      basis: "period",
    });
    expect(periodEcho({ start: "2024-01-01", end: "2024-12-31" }, "period").days).toBe(366);
  });
});

describe("startsBeforeBirth", () => {
  it("refuses only periods that start before the birth day", () => {
    expect(startsBeforeBirth({ start: "1990-01-14", end: "1990-02-01" }, "1990-01-15")).toBe(true);
    expect(startsBeforeBirth({ start: "1990-01-15", end: "1990-02-01" }, "1990-01-15")).toBe(false);
    expect(startsBeforeBirth({ start: "1800-01-01", end: "1800-01-01" }, undefined)).toBe(false);
  });

  it("the refusal text never carries a date", () => {
    expect(BEFORE_BIRTH_MESSAGE).toBe(
      "This period starts before the birth date. Ask about a period after it.",
    );
    expect(BEFORE_BIRTH_MESSAGE).not.toMatch(/\d/);
  });
});

describe("periodLimits", () => {
  it("allows exactly two years", () => {
    expect(periodLimits({ start: "2019-01-01", end: "2020-12-31" })).toEqual({ dashasOnly: false, notes: [] });
  });

  it("a 25-month span is dashas only, with the spec's note", () => {
    expect(periodLimits({ start: "2019-01-01", end: "2021-01-31" })).toEqual({
      dashasOnly: true,
      notes: [OVER_TWO_YEARS_NOTE],
    });
    expect(OVER_TWO_YEARS_NOTE).toBe(
      "Over 2 years: showing dashas only. Ask about a shorter span for transits.",
    );
  });

  it("any day after 2052-12-31 is dashas only", () => {
    expect(periodLimits({ start: "2052-12-31", end: "2052-12-31" }).dashasOnly).toBe(false);
    expect(periodLimits({ start: "2053-01-05", end: "2053-01-05" })).toEqual({
      dashasOnly: true,
      notes: [PAST_EPHEMERIS_NOTE],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period.test.ts`
Expected: FAIL, cannot resolve `../period`.

- [ ] **Step 3: Implement `period.ts`**

```ts
// Time travel (spec 2026-10-08): the rules the app enforces on the dates the
// model sends to the timing tool. Pure calendar checks on YYYY-MM-DD strings;
// no astrology lives here.
import type { PeriodRange } from "./sanitize";

export const ISO_DAY_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const ISO_DAY = new RegExp(ISO_DAY_PATTERN);
const MS_PER_DAY = 86_400_000;

/** The last day the on-device ephemeris covers (DE421 ends 2053; slow_hits.py `_EPHEMERIS_MAX`). */
export const EPHEMERIS_LAST_DAY = "2052-12-31";
/** Longer spans get dashas only. */
export const MAX_TRANSIT_SPAN_YEARS = 2;

export const BEFORE_BIRTH_MESSAGE =
  "This period starts before the birth date. Ask about a period after it.";
export const OVER_TWO_YEARS_NOTE =
  "Over 2 years: showing dashas only. Ask about a shorter span for transits.";
export const PAST_EPHEMERIS_NOTE =
  "After 2052: showing dashas only. The on-device ephemeris ends in 2052.";

export type PeriodArgs =
  | { readonly kind: "today" }
  | { readonly kind: "period"; readonly period: PeriodRange }
  | { readonly kind: "invalid"; readonly error: string };

export interface PeriodEcho {
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly basis: "today" | "period";
}

export interface PeriodLimits {
  readonly dashasOnly: boolean;
  readonly notes: readonly string[];
}

/** True for a real calendar day: Date.parse rolls 2026-02-30 to March, so round-trip it. */
function isCalendarDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function dayArgument(value: unknown, key: "start" | "end"): string | { readonly error: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCalendarDay(value)) {
    return { error: `${key} must be a date like 2026-06-01` };
  }
  return value;
}

/** Read the tool's optional start/end. Omitted start and end mean today. */
export function parsePeriodArgs(args: { readonly start?: unknown; readonly end?: unknown }): PeriodArgs {
  const start = dayArgument(args.start, "start");
  const end = dayArgument(args.end, "end");
  if (typeof start === "object") return { kind: "invalid", error: start.error };
  if (typeof end === "object") return { kind: "invalid", error: end.error };
  if (start === undefined) {
    return end === undefined
      ? { kind: "today" }
      : { kind: "invalid", error: "start is required when end is given" };
  }
  const last = end ?? start;
  if (last < start) return { kind: "invalid", error: "end is before start" };
  return { kind: "period", period: { start, end: last } };
}

export function periodEcho(period: PeriodRange, basis: PeriodEcho["basis"]): PeriodEcho {
  const span = Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`);
  return { start: period.start, end: period.end, days: Math.round(span / MS_PER_DAY) + 1, basis };
}

export function startsBeforeBirth(period: PeriodRange, birthDay: string | undefined): boolean {
  return birthDay !== undefined && period.start < birthDay;
}

/** The same month and day N years later, as a string bound (02-29 stays a valid upper bound). */
function yearsLater(day: string, years: number): string {
  return `${String(Number(day.slice(0, 4)) + years).padStart(4, "0")}${day.slice(4)}`;
}

export function periodLimits(period: PeriodRange): PeriodLimits {
  if (period.end > EPHEMERIS_LAST_DAY) return { dashasOnly: true, notes: [PAST_EPHEMERIS_NOTE] };
  if (period.end >= yearsLater(period.start, MAX_TRANSIT_SPAN_YEARS)) {
    return { dashasOnly: true, notes: [OVER_TWO_YEARS_NOTE] };
  }
  return { dashasOnly: false, notes: [] };
}
```

Add to `frontend/packages/llm/src/index.ts`:

```ts
export {
  BEFORE_BIRTH_MESSAGE,
  ISO_DAY_PATTERN,
  OVER_TWO_YEARS_NOTE,
  PAST_EPHEMERIS_NOTE,
  parsePeriodArgs,
  periodEcho,
  periodLimits,
  startsBeforeBirth,
} from "./period";
export type { PeriodArgs, PeriodEcho, PeriodLimits } from "./period";
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Mutation red (reversed check, 2-year cap, ephemeris cap, end-without-start)**

```bash
cd frontend/packages/llm
T="bunx vitest run src/__tests__/period.test.ts"
python3 "$MUTATE" src/period.ts 'if (last < start) return { kind: "invalid", error: "end is before start" };' '' -- $T
python3 "$MUTATE" src/period.ts 'export const MAX_TRANSIT_SPAN_YEARS = 2;' 'export const MAX_TRANSIT_SPAN_YEARS = 3;' -- $T
python3 "$MUTATE" src/period.ts 'if (period.end > EPHEMERIS_LAST_DAY) return { dashasOnly: true, notes: [PAST_EPHEMERIS_NOTE] };' '' -- $T
python3 "$MUTATE" src/period.ts 'return end === undefined' 'return true' -- $T
```

Expected: four `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/packages/llm/src/period.ts frontend/packages/llm/src/index.ts \
  frontend/packages/llm/src/__tests__/period.test.ts
git commit -m "feat(llm): period argument rules for the timing tool"
```

---

### Task 4: `selectDashasForPeriod` (date-overlap selection over the engine's dated tree)

**Files:**
- Create: `frontend/packages/llm/src/period-dashas.ts`
- Modify: `frontend/packages/llm/src/index.ts`
- Create: `frontend/packages/llm/src/__tests__/period-dashas.test.ts`

**Interfaces:**
- Consumes: `PeriodRange`, `dashaBoundaryMonth` (Task 1); fixture `BIRTH_2000_DASHAS` (Task 1).
- Produces: `PRATYANTAR_NOTE`, `NO_TREE_NOTE`; `interface PeriodDashaRow { lord: string; start_month: string; end_month: string }`; `interface PeriodAntarRow extends PeriodDashaRow { maha_lord: string }`; `interface PeriodDashas { maha: readonly PeriodDashaRow[]; antar: readonly PeriodAntarRow[]; pratyantar?: readonly PeriodDashaRow[]; notes: readonly string[] }`; `selectDashasForPeriod(dashas: VimshottariDasha, period: PeriodRange): PeriodDashas`.

This is selection, not astrology: every lord and boundary is read verbatim from engine rows; the only operation is "does this row's date range overlap the period". Rows carry no `duration_years` (it is not needed to read a period and it is one more number that chains back to birth).

- [ ] **Step 1: Write the failing tests**

`frontend/packages/llm/src/__tests__/period-dashas.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { NO_TREE_NOTE, PRATYANTAR_NOTE, selectDashasForPeriod } from "../period-dashas";
import { BIRTH_2000_DASHAS } from "./birth-2000-fixture";

describe("selectDashasForPeriod", () => {
  it("re-picks by date: a period across an antar change lists both antars", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2020-12-01", end: "2021-02-28" });
    expect(result.maha).toEqual([{ lord: "venus", start_month: "2017-09", end_month: "2037-09" }]);
    expect(result.antar).toEqual([
      { maha_lord: "venus", lord: "venus", start_month: "2017-09", end_month: "2021-01" },
      { maha_lord: "venus", lord: "sun", start_month: "2021-01", end_month: "2022-01" },
    ]);
  });

  it("a handover on the period's first day lists both rows", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2021-01-15", end: "2021-01-15" });
    expect(result.antar.map((row) => row.lord)).toEqual(["venus", "sun"]);
  });

  it("a period across a maha change lists both mahas in order", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2017-01-01", end: "2017-12-31" });
    expect(result.maha.map((row) => row.lord)).toEqual(["ketu", "venus"]);
  });

  it("withholds the birth month: the first maha and its first antar start at 'birth'", () => {
    const result = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2000-06-01", end: "2000-06-30" });
    expect(result.maha[0]).toEqual({ lord: "mercury", start_month: "birth", end_month: "2010-09" });
    expect(result.antar[0]).toMatchObject({ lord: "mercury", start_month: "birth" });
    expect(JSON.stringify(result)).not.toContain("2000-03");
  });

  it("gives pratyantars only inside the chart's current antar", () => {
    const inside = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2022-05-01", end: "2022-05-31" });
    expect(inside.pratyantar).toEqual([{ lord: "rahu", start_month: "2022-04", end_month: "2022-08" }]);
    expect(inside.notes).toEqual([]);

    const outside = selectDashasForPeriod(BIRTH_2000_DASHAS, { start: "2019-06-01", end: "2019-06-30" });
    expect(outside.pratyantar).toBeUndefined();
    expect(outside.notes).toEqual([PRATYANTAR_NOTE]);
  });

  it("says so when the chart has no dated antar tree (older bundle)", () => {
    const legacy = {
      ...BIRTH_2000_DASHAS,
      maha_dasha_sequence: BIRTH_2000_DASHAS.maha_dasha_sequence.map(({ antar_sequence: _, ...maha }) => maha),
    };
    const result = selectDashasForPeriod(legacy, { start: "2019-06-01", end: "2019-06-30" });
    expect(result.antar).toEqual([]);
    expect(result.notes).toContain(NO_TREE_NOTE);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-dashas.test.ts`
Expected: FAIL, cannot resolve `../period-dashas`.

- [ ] **Step 3: Implement `period-dashas.ts`**

```ts
// Dashas by date (spec 2026-10-08, "Dashas by date"). The engine already dates
// every maha and antar; this picks the rows that overlap a period. It is a
// date-overlap filter over engine-stated dates, not astrology.
import type { DashaPeriod, VimshottariDasha } from "@almamesh/browser/types";

import { dashaBoundaryMonth, type PeriodRange } from "./sanitize";

export const PRATYANTAR_NOTE = "Pratyantar dashas are only available for the current antar.";
export const NO_TREE_NOTE =
  "This chart was computed before dated antar periods existed. Recompute it to read antars by date.";

export interface PeriodDashaRow {
  readonly lord: string;
  /** "YYYY-MM", or "birth" for the row that starts at the birth instant. */
  readonly start_month: string;
  readonly end_month: string;
}

export interface PeriodAntarRow extends PeriodDashaRow {
  readonly maha_lord: string;
}

export interface PeriodDashas {
  readonly maha: readonly PeriodDashaRow[];
  readonly antar: readonly PeriodAntarRow[];
  readonly pratyantar?: readonly PeriodDashaRow[];
  readonly notes: readonly string[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function overlaps(row: DashaPeriod, period: PeriodRange): boolean {
  return day(row.start_date) <= period.end && day(row.end_date) >= period.start;
}

function toRow(row: DashaPeriod, birthStart: string | undefined): PeriodDashaRow {
  return {
    lord: row.lord,
    start_month: dashaBoundaryMonth(row.start_date, birthStart),
    end_month: dashaBoundaryMonth(row.end_date, birthStart),
  };
}

/** Pratyantars exist only for the chart's current antar; outside it, say so. */
function pratyantarRows(
  dashas: VimshottariDasha,
  period: PeriodRange,
  birthStart: string | undefined,
): { readonly rows?: readonly PeriodDashaRow[]; readonly note?: string } {
  const antar = dashas.current_antar;
  const sequence = dashas.pratyantar_sequence;
  if (!antar || !sequence) return { note: PRATYANTAR_NOTE };
  const inside = day(antar.start_date) <= period.start && period.end <= day(antar.end_date);
  if (!inside) return { note: PRATYANTAR_NOTE };
  return { rows: sequence.filter((row) => overlaps(row, period)).map((row) => toRow(row, birthStart)) };
}

export function selectDashasForPeriod(dashas: VimshottariDasha, period: PeriodRange): PeriodDashas {
  const birthStart = dashas.maha_dasha_sequence[0]?.start_date;
  const mahas = dashas.maha_dasha_sequence.filter((maha) => overlaps(maha, period));
  const antar = mahas.flatMap((maha) =>
    (maha.antar_sequence ?? [])
      .filter((row) => overlaps(row, period))
      .map((row) => ({ maha_lord: maha.lord, ...toRow(row, birthStart) })),
  );
  const notes: string[] = [];
  if (mahas.some((maha) => maha.antar_sequence === undefined)) notes.push(NO_TREE_NOTE);
  const pratyantar = pratyantarRows(dashas, period, birthStart);
  if (pratyantar.note) notes.push(pratyantar.note);
  return {
    maha: mahas.map((maha) => toRow(maha, birthStart)),
    antar,
    ...(pratyantar.rows ? { pratyantar: pratyantar.rows } : {}),
    notes,
  };
}
```

Add to `index.ts`:

```ts
export { NO_TREE_NOTE, PRATYANTAR_NOTE, selectDashasForPeriod } from "./period-dashas";
export type { PeriodAntarRow, PeriodDashaRow, PeriodDashas } from "./period-dashas";
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-dashas.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Mutation red (re-pick by date, birth withheld, pratyantar note)**

```bash
cd frontend/packages/llm
T="bunx vitest run src/__tests__/period-dashas.test.ts"
python3 "$MUTATE" src/period-dashas.ts '      .filter((row) => overlaps(row, period))' \
  '      .filter((row) => row.lord === dashas.current_antar?.lord)' -- $T
python3 "$MUTATE" src/period-dashas.ts '    start_month: dashaBoundaryMonth(row.start_date, birthStart),' \
  '    start_month: row.start_date.slice(0, 7),' -- $T
python3 "$MUTATE" src/period-dashas.ts '  if (!inside) return { note: PRATYANTAR_NOTE };' '' -- $T
```

Expected: three `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/packages/llm/src/period-dashas.ts frontend/packages/llm/src/index.ts \
  frontend/packages/llm/src/__tests__/period-dashas.test.ts
git commit -m "feat(llm): select dashas for a period from the engine's dated tree"
```

---

### Task 5: Trim a transit context to a period

**Files:**
- Create: `frontend/packages/llm/src/period-transits.ts`
- Modify: `frontend/packages/llm/src/index.ts`
- Create: `frontend/packages/llm/src/__tests__/period-transits.test.ts`

**Interfaces:**
- Consumes: `PeriodRange` (Task 1), `TRANSIT_CTX_FIXTURE` (`src/__tests__/predictive-fixture.ts`).
- Produces: `SLOW_GRAHAS: readonly string[]` (`["mars","jupiter","saturn","rahu","ketu"]`); `COVERED_EVENTS` (the four-item tuple); `timelineCutoffNote(windowEnd: string): string`; `interface RestrictedTransits { context: TransitContext; notes: readonly string[] }`; `restrictTransitsToPeriod(ctx: TransitContext, period: PeriodRange, multiDay: boolean): RestrictedTransits`.

Selection only: drop placements by graha name, drop events and slow hits whose engine date falls outside the period.

- [ ] **Step 1: Write the failing tests**

`frontend/packages/llm/src/__tests__/period-transits.test.ts`:

```ts
import type { TransitContext } from "@almamesh/browser/types";
import { describe, expect, it } from "vitest";

import { COVERED_EVENTS, restrictTransitsToPeriod, timelineCutoffNote } from "../period-transits";
import { TRANSIT_CTX_FIXTURE } from "./predictive-fixture";

const saturn = TRANSIT_CTX_FIXTURE.gochara.placements.saturn;
const [saturnIngress] = TRANSIT_CTX_FIXTURE.timeline.events;
const CTX: TransitContext = {
  ...TRANSIT_CTX_FIXTURE,
  gochara: {
    ...TRANSIT_CTX_FIXTURE.gochara,
    placements: {
      saturn,
      moon: { ...saturn, graha: "moon", sign: "aries" },
      sun: { ...saturn, graha: "sun", sign: "capricorn" },
      jupiter: { ...saturn, graha: "jupiter", sign: "cancer" },
      mars: { ...saturn, graha: "mars", sign: "leo" },
    },
  },
  timeline: {
    ...TRANSIT_CTX_FIXTURE.timeline,
    events: [
      saturnIngress, // 2030-03-29
      { ...saturnIngress, date: "2030-07-02T00:00:00Z", graha: "jupiter", descriptor: "Jupiter enters Cancer" },
    ],
  },
};

describe("restrictTransitsToPeriod", () => {
  it("a month keeps only slow grahas and only that month's events", () => {
    const { context, notes } = restrictTransitsToPeriod(CTX, { start: "2030-03-01", end: "2030-03-31" }, true);
    expect(Object.keys(context.gochara.placements).sort()).toEqual(["jupiter", "mars", "saturn"]);
    expect(context.timeline.events.map((event) => event.date)).toEqual(["2030-03-29T00:00:00Z"]);
    expect(context.slow_hits).toEqual([]); // the fixture's hit is 2030-05-20
    expect(notes).toEqual([]);
  });

  it("a single day keeps every graha, the Moon included", () => {
    const { context } = restrictTransitsToPeriod(CTX, { start: "2030-03-29", end: "2030-03-29" }, false);
    expect(Object.keys(context.gochara.placements)).toContain("moon");
    expect(context.timeline.events).toHaveLength(1);
  });

  it("notes when the period runs past the engine's timeline window", () => {
    const { notes } = restrictTransitsToPeriod(CTX, { start: "2030-01-01", end: "2031-06-30" }, true);
    expect(notes).toEqual([timelineCutoffNote("2031-01-01T00:00:00Z")]);
    expect(notes[0]).toContain("2031-01");
  });
});

describe("COVERED_EVENTS", () => {
  it("claims only what the engine checks before Inc B", () => {
    expect(COVERED_EVENTS).toEqual(["jupiter_ingress", "saturn_ingress", "dasha_change", "sade_sati_phase"]);
    expect(COVERED_EVENTS).not.toContain("mars_ingress");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-transits.test.ts`
Expected: FAIL, cannot resolve `../period-transits`.

- [ ] **Step 3: Implement `period-transits.ts`**

```ts
// Transits for a period (spec 2026-10-08, "What each section returns").
// The engine runs once at the period's first day; this keeps what belongs to
// the period. Selection by name and by engine date only, no astrology.
import type { TransitContext } from "@almamesh/browser/types";

import type { PeriodRange } from "./sanitize";

/** Kept in multi-day results. Sun, Moon, Mercury and Venus move too fast for a period. */
export const SLOW_GRAHAS: readonly string[] = ["mars", "jupiter", "saturn", "rahu", "ketu"];

/**
 * The dated event kinds the engine timeline really checks until Inc B
 * (`_SLOW_GRAHAS` in transits/timeline.py is Jupiter and Saturn). The model
 * must not read "no Mars ingress" when Mars was never checked.
 */
export const COVERED_EVENTS = ["jupiter_ingress", "saturn_ingress", "dasha_change", "sade_sati_phase"] as const;

export interface RestrictedTransits {
  readonly context: TransitContext;
  readonly notes: readonly string[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function inPeriod(iso: string, period: PeriodRange): boolean {
  return day(iso) >= period.start && day(iso) <= period.end;
}

export function timelineCutoffNote(windowEnd: string): string {
  return `Transit events are listed only up to ${windowEnd.slice(0, 7)}. Ask about a later start for the rest.`;
}

export function restrictTransitsToPeriod(
  ctx: TransitContext,
  period: PeriodRange,
  multiDay: boolean,
): RestrictedTransits {
  const placements = multiDay
    ? Object.fromEntries(
        Object.entries(ctx.gochara.placements).filter(([, placement]) =>
          SLOW_GRAHAS.includes(placement.graha.toLowerCase()),
        ),
      )
    : ctx.gochara.placements;
  const notes = day(ctx.timeline.window_end) < period.end ? [timelineCutoffNote(ctx.timeline.window_end)] : [];
  return {
    context: {
      ...ctx,
      gochara: { ...ctx.gochara, placements },
      slow_hits: ctx.slow_hits.filter((hit) => inPeriod(hit.exact, period)),
      timeline: { ...ctx.timeline, events: ctx.timeline.events.filter((event) => inPeriod(event.date, period)) },
    },
    notes,
  };
}
```

Add to `index.ts`:

```ts
export { COVERED_EVENTS, SLOW_GRAHAS, restrictTransitsToPeriod, timelineCutoffNote } from "./period-transits";
export type { RestrictedTransits } from "./period-transits";
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-transits.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Mutation red (fast planets, event filter, covered_events)**

```bash
cd frontend/packages/llm
T="bunx vitest run src/__tests__/period-transits.test.ts"
python3 "$MUTATE" src/period-transits.ts '  const placements = multiDay' '  const placements = false' -- $T
python3 "$MUTATE" src/period-transits.ts 'events: ctx.timeline.events.filter((event) => inPeriod(event.date, period))' 'events: ctx.timeline.events' -- $T
python3 "$MUTATE" src/period-transits.ts '"sade_sati_phase"] as const;' '"sade_sati_phase", "mars_ingress"] as const;' -- $T
```

Expected: three `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/packages/llm/src/period-transits.ts frontend/packages/llm/src/index.ts \
  frontend/packages/llm/src/__tests__/period-transits.test.ts
git commit -m "feat(llm): trim transit context to a period; honest covered_events"
```

---

### Task 6: `DevicePolicy.periodSkyCacheSize` (5 / 3 / 1)

**Files:**
- Modify: `frontend/packages/browser/src/deviceTier.ts:22-56`
- Modify: `frontend/packages/browser/src/__tests__/deviceTier.test.ts` (the `devicePolicy` pinned-literal cases)

**Interfaces:**
- Produces: `DevicePolicy.periodSkyCacheSize: number`; `devicePolicy("full").periodSkyCacheSize === 5`, `lite` 3, `minimal` 1.

- [ ] **Step 1: Update the pinned-literal tests first**

In each of the three `devicePolicy(...)` `toEqual` objects in `deviceTier.test.ts`, add the field: `periodSkyCacheSize: 1` (minimal), `periodSkyCacheSize: 3` (lite), `periodSkyCacheSize: 5` (full). Then add:

```ts
  it("period-sky cache: full keeps 5 periods, lite 3, minimal 1", () => {
    expect(devicePolicy("full").periodSkyCacheSize).toBe(5);
    expect(devicePolicy("lite").periodSkyCacheSize).toBe(3);
    expect(devicePolicy("minimal").periodSkyCacheSize).toBe(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/packages/browser && bunx vitest run src/__tests__/deviceTier.test.ts`
Expected: FAIL (field missing).

- [ ] **Step 3: Implement**

In `DevicePolicy` add:

```ts
  /**
   * How many time-travel period computes stay in memory (apps/web periodSky.ts).
   * Each holds a full predictive payload; recomputing one costs ~30 s.
   */
  readonly periodSkyCacheSize: number;
```

and add `periodSkyCacheSize: 1,` to `minimal`, `periodSkyCacheSize: 3,` to `lite`, `periodSkyCacheSize: 5,` to `full`.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend/packages/browser && bunx vitest run src/__tests__/deviceTier.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Mutation red**

```bash
cd frontend/packages/browser
python3 "$MUTATE" src/deviceTier.ts '    periodSkyCacheSize: 5,' '    periodSkyCacheSize: 50,' -- bunx vitest run src/__tests__/deviceTier.test.ts
```

Expected: `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/packages/browser/src/deviceTier.ts frontend/packages/browser/src/__tests__/deviceTier.test.ts
git commit -m "feat(browser): period-sky cache size per device tier (5/3/1)"
```

---

### Task 7: `periodSky.ts`: in-memory LRU of period computes, off the Life Atlas slot

**Files:**
- Create: `frontend/apps/web/src/lib/periodSky.ts`
- Create: `frontend/apps/web/src/lib/__tests__/periodSky.test.ts`

**Interfaces:**
- Consumes: `predictiveRequestKey`, `usePredictiveStore`, `EnsurePredictiveInput`, `PredictiveRuntime`, `CachedPredictiveContexts` (`@almamesh/store`); `devicePolicy` (`@almamesh/browser`, Task 6).
- Produces:
  - `PERIOD_SKY_TIMEOUT_MS = 150_000`
  - `class PeriodSkyTimeoutError extends Error`
  - `periodReferenceInstant(day: string): string` → `"YYYY-MM-DDT00:00:00Z"` (the `predictiveReferenceInstant` shape)
  - `interface PredictiveStoreSnapshot { readonly status: string; readonly requestKey?: string; readonly rawContexts?: CachedPredictiveContexts }`
  - `interface PeriodSkyCacheOptions { capacity: number; readStore?: () => PredictiveStoreSnapshot; timeoutMs?: number }`
  - `interface PeriodSkyCache { load(input: EnsurePredictiveInput, runtime: PredictiveRuntime, signal: AbortSignal): Promise<CachedPredictiveContexts>; keys(): readonly string[] }`
  - `createPeriodSkyCache(options: PeriodSkyCacheOptions): PeriodSkyCache`
  - `periodSkyCache(): PeriodSkyCache` (tab singleton sized by `devicePolicy().periodSkyCacheSize`), `__resetPeriodSkyCacheForTest(): void`

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/lib/__tests__/periodSky.test.ts`:

```ts
import type { PredictiveContexts } from '@almamesh/browser';
import { predictiveRequestKey, usePredictiveStore, type EnsurePredictiveInput } from '@almamesh/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PERIOD_SKY_TIMEOUT_MS,
  PeriodSkyTimeoutError,
  createPeriodSkyCache,
  periodReferenceInstant,
} from '../periodSky';

const SKY = { transit_context: { instant: 'x' } } as unknown as PredictiveContexts;

function input(day: string): EnsurePredictiveInput {
  return {
    profileKey: 'p1',
    datetimeUtc: '1990-01-15T12:00:00.000Z',
    latitude: 28.6139,
    longitude: 77.209,
    referenceInstant: periodReferenceInstant(day),
    utcOffsetMinutes: 330,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const idle = () => ({ status: 'idle' });
const signal = () => new AbortController().signal;

afterEach(() => {
  usePredictiveStore.getState().reset();
  vi.useRealTimers();
});

describe('periodReferenceInstant', () => {
  it('is UTC midnight of the day, the engine reference shape', () => {
    expect(periodReferenceInstant('2019-06-01')).toBe('2019-06-01T00:00:00Z');
  });
});

describe('createPeriodSkyCache', () => {
  it('pins the 150 s deadline literal', () => {
    expect(PERIOD_SKY_TIMEOUT_MS).toBe(150_000);
  });

  it("reuses the predictive store's result when it holds the exact key (no engine call)", async () => {
    const runtime = { computePredictive: vi.fn() };
    const key = predictiveRequestKey(input('2026-10-08'));
    const cache = createPeriodSkyCache({
      capacity: 5,
      readStore: () => ({ status: 'ready', requestKey: key, rawContexts: SKY }),
    });
    await expect(cache.load(input('2026-10-08'), runtime, signal())).resolves.toBe(SKY);
    expect(runtime.computePredictive).not.toHaveBeenCalled();
  });

  it("never touches the Life Atlas's store slot", async () => {
    usePredictiveStore.setState({ status: 'ready', profileKey: 'p1', requestKey: 'today-key' });
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    const cache = createPeriodSkyCache({ capacity: 5 });
    await cache.load(input('2019-06-01'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
    expect(usePredictiveStore.getState().requestKey).toBe('today-key');
  });

  it('keeps at most `capacity` periods; the sixth evicts the oldest', async () => {
    const runtime = { computePredictive: vi.fn(async () => SKY) };
    const cache = createPeriodSkyCache({ capacity: 5, readStore: idle });
    const days = ['2019-01-01', '2019-02-01', '2019-03-01', '2019-04-01', '2019-05-01', '2019-06-01'];
    for (const day of days) await cache.load(input(day), runtime, signal());
    expect(cache.keys()).toHaveLength(5);
    expect(cache.keys()).not.toContain(predictiveRequestKey(input('2019-01-01')));
    await cache.load(input('2019-01-01'), runtime, signal());
    expect(runtime.computePredictive).toHaveBeenCalledTimes(7);
  });

  it('joins a second request for the same period', async () => {
    const gate = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn(() => gate.promise) };
    const cache = createPeriodSkyCache({ capacity: 5, readStore: idle });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    const second = cache.load(input('2019-06-01'), runtime, signal());
    gate.resolve(SKY);
    await expect(Promise.all([first, second])).resolves.toEqual([SKY, SKY]);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it('runs one period compute at a time', async () => {
    const gate = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(SKY) };
    const cache = createPeriodSkyCache({ capacity: 5, readStore: idle });
    const first = cache.load(input('2019-06-01'), runtime, signal());
    const second = cache.load(input('2027-01-01'), runtime, signal());
    await Promise.resolve();
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
    gate.resolve(SKY);
    await Promise.all([first, second]);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
  });

  it('evicts a failed compute so the next ask recomputes', async () => {
    const runtime = {
      computePredictive: vi.fn().mockRejectedValueOnce(new Error('engine down')).mockResolvedValue(SKY),
    };
    const cache = createPeriodSkyCache({ capacity: 5, readStore: idle });
    await expect(cache.load(input('2019-06-01'), runtime, signal())).rejects.toThrow('engine down');
    await expect(cache.load(input('2019-06-01'), runtime, signal())).resolves.toBe(SKY);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(2);
  });

  it('a timed-out waiter does not cancel the compute; a later ask joins it', async () => {
    const gate = deferred<PredictiveContexts>();
    const runtime = { computePredictive: vi.fn(() => gate.promise) };
    const shortWait = createPeriodSkyCache({ capacity: 5, readStore: idle, timeoutMs: 5 });
    await expect(shortWait.load(input('2019-06-01'), runtime, signal())).rejects.toBeInstanceOf(
      PeriodSkyTimeoutError,
    );
    // The second load starts its own 5 ms timer, but gate.resolve runs
    // synchronously first, so it resolves with SKY from the same compute.
    const joined = shortWait.load(input('2019-06-01'), runtime, signal()).catch((error: unknown) => error);
    gate.resolve(SKY);
    await expect(joined).resolves.toBe(SKY);
    expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
  });

  it('rejects at once when the turn is cancelled', async () => {
    const runtime = { computePredictive: vi.fn(() => new Promise<PredictiveContexts>(() => {})) };
    const cache = createPeriodSkyCache({ capacity: 5, readStore: idle });
    const controller = new AbortController();
    const pending = cache.load(input('2019-06-01'), runtime, controller.signal);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/periodSky.test.ts`
Expected: FAIL, cannot resolve `../periodSky`.

- [ ] **Step 3: Implement `periodSky.ts`**

```ts
/**
 * Time travel (spec 2026-10-08, "Computing a period's sky"): engine runs for a
 * period other than today. They must NOT go through `usePredictiveStore`: it
 * holds ONE persisted result, and a period compute there would evict today's
 * Life Atlas (which then recomputes for ~30 s on next open).
 *
 * Memory only: this is recomputable engine output, not user data, so it is
 * never persisted or exported (SQLite-only rule).
 */
import { devicePolicy } from '@almamesh/browser';
import {
  predictiveRequestKey,
  usePredictiveStore,
  type CachedPredictiveContexts,
  type EnsurePredictiveInput,
  type PredictiveRuntime,
} from '@almamesh/store';

/** One queued Life Atlas compute (~30 s) plus this one (~30 s+), under the worker's own 180 s limit. */
export const PERIOD_SKY_TIMEOUT_MS = 150_000;

export class PeriodSkyTimeoutError extends Error {
  constructor() {
    super('The period sky calculation timed out.');
    this.name = 'PeriodSkyTimeoutError';
  }
}

export interface PredictiveStoreSnapshot {
  readonly status: string;
  readonly requestKey?: string;
  readonly rawContexts?: CachedPredictiveContexts;
}

export interface PeriodSkyCacheOptions {
  readonly capacity: number;
  readonly readStore?: () => PredictiveStoreSnapshot;
  readonly timeoutMs?: number;
}

export interface PeriodSkyCache {
  load(input: EnsurePredictiveInput, runtime: PredictiveRuntime, signal: AbortSignal): Promise<CachedPredictiveContexts>;
  keys(): readonly string[];
}

/** The engine's reference instant for a calendar day (the `predictiveReferenceInstant` shape). */
export function periodReferenceInstant(day: string): string {
  return `${day}T00:00:00Z`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

/** Wait for `work` until the turn is cancelled or the deadline passes. The work itself keeps running. */
function waitWithDeadline<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(() => finish(() => reject(new PeriodSkyTimeoutError())), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error('The period sky calculation failed.'))),
    );
  });
}

export function createPeriodSkyCache(options: PeriodSkyCacheOptions): PeriodSkyCache {
  const capacity = Math.max(1, options.capacity);
  const readStore = options.readStore ?? ((): PredictiveStoreSnapshot => usePredictiveStore.getState());
  const timeoutMs = options.timeoutMs ?? PERIOD_SKY_TIMEOUT_MS;
  const entries = new Map<string, Promise<CachedPredictiveContexts>>();
  let queue: Promise<unknown> = Promise.resolve();

  const remember = (key: string, value: Promise<CachedPredictiveContexts>): void => {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const compute = (key: string, input: EnsurePredictiveInput, runtime: PredictiveRuntime) => {
    // One period compute at a time: the Pyodide worker is serial anyway.
    const run: Promise<CachedPredictiveContexts> = queue.then(() => runtime.computePredictive(input));
    queue = run.catch(() => undefined);
    run.catch(() => {
      if (entries.get(key) === run) entries.delete(key); // a failure is never replayed
    });
    remember(key, run);
    return run;
  };

  return {
    load(input, runtime, signal) {
      const key = predictiveRequestKey(input);
      const store = readStore();
      if (store.status === 'ready' && store.requestKey === key && store.rawContexts) {
        return Promise.resolve(store.rawContexts);
      }
      const cached = entries.get(key);
      if (cached) remember(key, cached);
      return waitWithDeadline(cached ?? compute(key, input, runtime), signal, timeoutMs);
    },
    keys: () => [...entries.keys()],
  };
}

let shared: PeriodSkyCache | undefined;

/** This tab's period-sky cache, sized by the device tier (5 / 3 / 1). */
export function periodSkyCache(): PeriodSkyCache {
  shared ??= createPeriodSkyCache({ capacity: devicePolicy().periodSkyCacheSize });
  return shared;
}

export function __resetPeriodSkyCacheForTest(): void {
  shared = undefined;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/periodSky.test.ts && cd ../.. && bun run --filter @almamesh/web typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation red (slot untouched, store reuse, LRU bound, failure eviction)**

```bash
cd frontend/apps/web
T="bunx vitest run src/lib/__tests__/periodSky.test.ts"
python3 "$MUTATE" src/lib/periodSky.ts \
  'queue.then(() => runtime.computePredictive(input));' \
  'queue.then(() => usePredictiveStore.getState().ensurePredictive(runtime, input).then(() => usePredictiveStore.getState().rawContexts as CachedPredictiveContexts));' \
  -- $T
python3 "$MUTATE" src/lib/periodSky.ts "if (store.status === 'ready' && store.requestKey === key && store.rawContexts) {" 'if (false) {' -- $T
python3 "$MUTATE" src/lib/periodSky.ts '    while (entries.size > capacity) {' '    while (false) {' -- $T
python3 "$MUTATE" src/lib/periodSky.ts '      if (entries.get(key) === run) entries.delete(key);' '' -- $T
```

Expected: four `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/apps/web/src/lib/periodSky.ts frontend/apps/web/src/lib/__tests__/periodSky.test.ts
git commit -m "feat(web): in-memory period-sky LRU that never evicts the Life Atlas slot"
```

---

### Task 8: Raise the agent's global tool-timeout cap to 150 s

**Files:**
- Modify: `frontend/packages/llm/src/agent.ts:14-23` (`AGENT_LIMITS`)
- Modify: `frontend/packages/llm/src/__tests__/agent.test.ts` (add one case)

**Interfaces:**
- Produces: `AGENT_LIMITS.maxToolTimeoutMs === 150_000`. Without this the timing tool's own `timeoutMs: 150_000` is clamped to 60 s by `executeWithDeadline` (`agent.ts:484-490`).

- [ ] **Step 1: Write the failing test** (append to `agent.test.ts`; `AGENT_LIMITS` is exported from `../agent`)

```ts
import { AGENT_LIMITS } from "../agent";

describe("AGENT_LIMITS", () => {
  it("lets a period compute run 150 s (one queued Life Atlas compute plus its own)", () => {
    expect(AGENT_LIMITS.maxToolTimeoutMs).toBe(150_000);
    expect(AGENT_LIMITS.toolTimeoutMs).toBe(2_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/agent.test.ts -t AGENT_LIMITS`
Expected: FAIL, `60000` received.

- [ ] **Step 3: Implement**: in `AGENT_LIMITS` change `maxToolTimeoutMs: 60_000,` to `maxToolTimeoutMs: 150_000,` and add the comment `// The timing tool's period computes (time travel): 150 s, under the worker's own 180 s.` above it.

- [ ] **Step 4: Run**: `cd frontend/packages/llm && bunx vitest run src/__tests__/agent.test.ts` → PASS.

- [ ] **Step 5: Mutation red**

```bash
cd frontend/packages/llm
python3 "$MUTATE" src/agent.ts '  maxToolTimeoutMs: 150_000,' '  maxToolTimeoutMs: 60_000,' -- bunx vitest run src/__tests__/agent.test.ts -t AGENT_LIMITS
```

Expected: `KILLED`.

- [ ] **Step 6: commit**

```bash
git add frontend/packages/llm/src/agent.ts frontend/packages/llm/src/__tests__/agent.test.ts
git commit -m "feat(llm): allow 150 s local tools for period computes"
```

---

### Task 9: `get_timing`: the timing tool takes dates

**Files:**
- Create: `frontend/apps/web/src/lib/agentArgs.ts` (move `enumArgument` here)
- Create: `frontend/apps/web/src/lib/timingTool.ts`
- Modify: `frontend/apps/web/src/lib/chatAgentTools.ts` (remove the inline `get_current_timing`, compose `createTimingTool`)
- Create: `frontend/apps/web/src/lib/__tests__/timingTool.test.ts`
- Modify: `frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts:47-57,107-134`
- Modify: `frontend/apps/web/src/pages/Dashboard.tsx:360`, `frontend/apps/web/src/pages/MeshEdge.tsx:351` (name lookup only; Task 11 replaces these blocks)
- Modify: `frontend/apps/web/src/pages/__tests__/MeshEdge.test.tsx:327`, `frontend/apps/web/e2e/chat.grounding.spec.ts:431`, `frontend/apps/web/e2e/dashboard.agentic.real.spec.ts:199`

**Interfaces:**
- Consumes: Task 1 (`periodAnalysisInstant`, `PeriodRange`), Task 3 (`parsePeriodArgs`, `periodEcho`, `periodLimits`, `startsBeforeBirth`, `BEFORE_BIRTH_MESSAGE`, `ISO_DAY_PATTERN`), Task 4 (`selectDashasForPeriod`), Task 5 (`restrictTransitsToPeriod`, `COVERED_EVENTS`), Task 7 (`PeriodSkyTimeoutError`), Task 8.
- Produces:
  - `agentArgs.ts`: `enumArgument(args: AgentJsonObject, key: string, allowed: readonly string[]): string`
  - `timingTool.ts`: `TIMING_TOOL_NAME = 'get_timing'`, `TIMING_TOOL_TIMEOUT_MS = 150_000`, `TIMING_SECTIONS`, `type TimingSection`, `type PeriodSkyFailure = 'engine_unavailable' | 'timeout' | 'incomplete_birth_data'`, `class PeriodSkyUnavailableError extends Error { readonly reason: PeriodSkyFailure }`, `interface TimingToolInput`, `createTimingTool(input: TimingToolInput): AgentTool`
  - `CreateChatAgentToolsInput` gains `birthDay?: string`, `todayDay?: (now: Date) => string`, `loadPeriodChart?: (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>`.
  - Result shape for every successful call: `{ period: PeriodEcho, section, shown, notes, data, covered_events?, measured_at? }`. Errors the model must read: `{ error: string }`.

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/lib/__tests__/timingTool.test.ts`:

```ts
import type { SiderealChart, TransitContext } from '@almamesh/browser/types';
import { BEFORE_BIRTH_MESSAGE, OVER_TWO_YEARS_NOTE, PAST_EPHEMERIS_NOTE } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import { PeriodSkyTimeoutError } from '../periodSky';
import { PeriodSkyUnavailableError, TIMING_TOOL_TIMEOUT_MS, createTimingTool } from '../timingTool';

const BIRTH = '1990-01-15T12:00:00Z';
const DASHAS = {
  maha_dasha_sequence: [
    {
      lord: 'rahu', start_date: BIRTH, end_date: '2007-06-01T00:00:00Z', duration_years: 17.4,
      antar_sequence: [{ lord: 'rahu', start_date: BIRTH, end_date: '1992-06-01T00:00:00Z', duration_years: 2.4 }],
    },
    {
      lord: 'jupiter', start_date: '2007-06-01T00:00:00Z', end_date: '2023-06-01T00:00:00Z', duration_years: 16,
      antar_sequence: [
        { lord: 'saturn', start_date: '2017-01-01T00:00:00Z', end_date: '2019-06-15T00:00:00Z', duration_years: 2.5 },
        { lord: 'mercury', start_date: '2019-06-15T00:00:00Z', end_date: '2021-09-01T00:00:00Z', duration_years: 2.2 },
      ],
    },
  ],
  current_maha: null,
  current_antar: null,
  current_pratyantar: null,
};
const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [], dashas: DASHAS } as unknown as SiderealChart;

const placement = (graha: string) => ({
  graha, longitude: 0, sign: 'aries', sign_degrees: 0, nakshatra: 'ashwini', nakshatra_pada: 1,
  is_retrograde: false, house_from_lagna: 1, house_from_moon: 1, natal_sign_occupied: 'aries',
});
const event = (date: string, graha: string) => ({
  date, kind: 'sign_ingress', graha, from_sign: 'scorpio', to_sign: 'sagittarius', from_lord: null,
  to_lord: null, sade_sati_phase: null, severity: 'supportive', descriptor: `${graha} changes sign`,
});
const TRANSITS = {
  instant: '2019-06-01T00:00:00Z',
  gochara: {
    instant: '2019-06-01T00:00:00Z', transit_ayanamsa: 24.1,
    placements: { moon: placement('moon'), saturn: placement('saturn'), jupiter: placement('jupiter') },
  },
  sade_sati: { is_active: false, current_phase: 'none', natal_moon_sign: 'aries', cycle: [], cycle_start: null, cycle_end: null },
  slow_hits: [],
  fusion: {
    instant: '2019-06-01T00:00:00Z', maha_lord: 'jupiter', antar_lord: 'saturn',
    maha_lord_transit_house_from_moon: 9, maha_lord_transit_house_from_lagna: 9,
    reinforcing: [], afflicting: [], net_weight: 0, severity: 'neutral',
  },
  timeline: {
    window_start: '2019-06-01T00:00:00Z', window_end: '2020-06-01T00:00:00Z',
    events: [event('2019-06-10T00:00:00Z', 'jupiter'), event('2019-09-01T00:00:00Z', 'saturn')],
  },
} as unknown as TransitContext;
const SKY_CHART = { ...CHART, transit_context: TRANSITS } as SiderealChart;

const NOW = new Date('2026-03-08T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });

function tool(overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthDay: '1990-01-15',
    todayDay: () => '2026-03-08',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    ...overrides,
  });
}

describe('get_timing contract', () => {
  it('is named get_timing, takes optional start/end days, and waits up to 150 s', () => {
    const timing = tool();
    expect(timing.name).toBe('get_timing');
    expect(TIMING_TOOL_TIMEOUT_MS).toBe(150_000);
    expect(timing.timeoutMs).toBe(150_000);
    expect(timing.parameters).toMatchObject({
      properties: {
        section: { enum: ['dashas', 'transits', 'domains', 'strength'] },
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['section'],
    });
  });
});

describe('get_timing with no dates', () => {
  it("means today, labelled 'today', and never loads a period sky", async () => {
    const loadPeriodChart = vi.fn();
    const result = await tool({ loadPeriodChart }).execute({ section: 'dashas' }, context());
    expect(result).toMatchObject({
      period: { start: '2026-03-08', end: '2026-03-08', days: 1, basis: 'today' },
      section: 'dashas',
    });
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });
});

describe('get_timing with dates', () => {
  it('echoes the resolved period on every result', async () => {
    const result = await tool().execute({ section: 'dashas', start: '2019-06-01', end: '2019-06-30' }, context());
    expect(result).toMatchObject({ period: { start: '2019-06-01', end: '2019-06-30', days: 30, basis: 'period' } });
  });

  it('picks dashas by date without an engine run', async () => {
    const loadPeriodChart = vi.fn();
    const result = (await tool({ loadPeriodChart }).execute(
      { section: 'dashas', start: '2019-06-01', end: '2019-06-30' },
      context(),
    )) as { data: { antar: Array<{ lord: string }> } };
    expect(result.data.antar.map((row) => row.lord)).toEqual(['saturn', 'mercury']);
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it.each([
    [{ start: '2026-02-30' }, 'start must be a date like 2026-06-01'],
    [{ start: '2026-06-30', end: '2026-06-01' }, 'end is before start'],
  ])('returns a readable error for %j', async (dates, error) => {
    await expect(tool().execute({ section: 'transits', ...dates }, context())).resolves.toEqual({ error });
  });

  it('refuses a period before birth without revealing the birth date', async () => {
    const result = await tool().execute({ section: 'dashas', start: '1989-06-01', end: '1990-06-30' }, context());
    expect(result).toEqual({ error: BEFORE_BIRTH_MESSAGE });
    expect(JSON.stringify(result)).not.toMatch(/1990-01|1990/);
  });

  it('a span over two years gives dashas only, with a note, and no engine run', async () => {
    const loadPeriodChart = vi.fn();
    const result = await tool({ loadPeriodChart }).execute(
      { section: 'transits', start: '2019-01-01', end: '2021-02-01' },
      context(),
    );
    expect(result).toMatchObject({ shown: 'dashas' });
    // The cap note comes first; dasha-selection notes (pratyantar) may follow.
    expect((result as { notes: string[] }).notes[0]).toBe(OVER_TWO_YEARS_NOTE);
    expect(loadPeriodChart).not.toHaveBeenCalled();
  });

  it('a day after 2052 gives dashas only', async () => {
    const result = await tool().execute({ section: 'transits', start: '2053-01-05' }, context());
    expect(result).toMatchObject({ shown: 'dashas' });
    expect((result as { notes: string[] }).notes[0]).toBe(PAST_EPHEMERIS_NOTE);
  });

  it('a month of transits drops fast planets and events outside the month', async () => {
    const result = (await tool().execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    )) as { data: { gochara: Array<{ graha: string }>; timeline: Array<{ month: string }> }; covered_events: string[] };
    expect(result.data.gochara.map((row) => row.graha).sort()).toEqual(['jupiter', 'saturn']);
    expect(result.data.timeline.map((row) => row.month)).toEqual(['2019-06']);
    expect(result.covered_events).not.toContain('mars_ingress');
  });

  it('a single day keeps the Moon', async () => {
    const result = (await tool().execute({ section: 'transits', start: '2019-06-10' }, context())) as {
      data: { gochara: Array<{ graha: string }> };
    };
    expect(result.data.gochara.map((row) => row.graha)).toContain('moon');
  });

  it.each([
    [new PeriodSkyUnavailableError('engine_unavailable'), 'engine_unavailable'],
    [new PeriodSkyTimeoutError(), 'timeout'],
    [new Error('worker crashed'), 'engine_unavailable'],
  ])('tells the model why the sky is missing (%s)', async (error, reason) => {
    const loadPeriodChart = vi.fn(async () => {
      throw error;
    });
    const result = await tool({ loadPeriodChart }).execute(
      { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
      context(),
    );
    expect(result).toMatchObject({ data: { available: false, reason } });
  });

  it('rethrows when the turn itself was cancelled', async () => {
    const controller = new AbortController();
    const loadPeriodChart = vi.fn(async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      throw new Error('aborted');
    });
    await expect(
      tool({ loadPeriodChart }).execute(
        { section: 'transits', start: '2019-06-01', end: '2019-06-30' },
        { now: NOW, signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});
```

In `chatAgentTools.test.ts`: change the expected names in "exposes exactly the three bounded read-only capabilities" to `['get_current_datetime', 'get_chart_facts', 'get_timing']`; in "calculates current timing on demand…" change the assertion to `.resolves.toMatchObject({ period: { basis: 'today' }, data: { sav_total: 337 } })` and `expect(tools[2].timeoutMs).toBe(150_000);`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.test.ts src/lib/__tests__/chatAgentTools.test.ts`
Expected: FAIL (`../timingTool` missing; names differ).

- [ ] **Step 3: Implement**

`frontend/apps/web/src/lib/agentArgs.ts`:

```ts
import type { AgentJsonObject } from '@almamesh/llm';

/** One string argument from a closed set, or a thrown error naming the set. */
export function enumArgument(args: AgentJsonObject, key: string, allowed: readonly string[]): string {
  const value = args[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}
```

`frontend/apps/web/src/lib/timingTool.ts`:

```ts
/**
 * `get_timing` (spec 2026-10-08, Part 1): the chat's ONE timing tool, for
 * today or any period. The model turns words into dates; this checks them,
 * picks dashas by date, and runs the engine for the period's sky. Errors the
 * model must act on are RETURNED (`{ error }`): a thrown error reaches the
 * model only as an opaque "could not complete safely".
 */
import type { SiderealChart } from '@almamesh/browser/types';
import {
  BEFORE_BIRTH_MESSAGE,
  COVERED_EVENTS,
  ISO_DAY_PATTERN,
  parsePeriodArgs,
  periodAnalysisInstant,
  periodEcho,
  periodLimits,
  restrictTransitsToPeriod,
  sanitizeChartForLlm,
  selectDashasForPeriod,
  startsBeforeBirth,
  todayAnalysisInstant,
  type AgentJsonObject,
  type AgentTool,
  type AgentToolContext,
  type PeriodEcho,
  type PeriodRange,
  type SanitizedChart,
} from '@almamesh/llm';

import { enumArgument } from './agentArgs';
import { PeriodSkyTimeoutError } from './periodSky';

export const TIMING_TOOL_NAME = 'get_timing';
/** One queued Life Atlas compute plus one period compute (spec, Performance). */
export const TIMING_TOOL_TIMEOUT_MS = 150_000;
export const TIMING_SECTIONS = ['dashas', 'transits', 'domains', 'strength'] as const;
export type TimingSection = (typeof TIMING_SECTIONS)[number];

export type PeriodSkyFailure = 'engine_unavailable' | 'timeout' | 'incomplete_birth_data';

export class PeriodSkyUnavailableError extends Error {
  constructor(readonly reason: PeriodSkyFailure) {
    super(`The period sky is unavailable: ${reason}`);
    this.name = 'PeriodSkyUnavailableError';
  }
}

export interface TimingToolInput {
  /** The stored natal chart: its dated dasha tree is read for every period. */
  readonly chart: SiderealChart;
  /** The local birth day (YYYY-MM-DD). Used only to refuse earlier periods; never echoed. */
  readonly birthDay: string | undefined;
  /** Today's calendar day in the one "today" zone (the viewer's). */
  readonly todayDay: (now: Date) => string;
  /** Today's engine facts (the Life Atlas store path). */
  readonly loadCurrentChart?: (context: AgentToolContext) => Promise<SiderealChart>;
  /** A period's engine facts (the period-sky LRU path). */
  readonly loadPeriodChart?: (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>;
}

const DAY = { type: 'string', pattern: ISO_DAY_PATTERN } as const;

const DESCRIPTION = [
  'Read deterministic planetary timing on this device, for today or for any period. It never makes a network request.',
  'Omit start and end for today. For a period send YYYY-MM-DD dates, end inclusive:',
  '"12 March 2019" -> start=end=2019-03-12; "June 2026" -> start=2026-06-01, end=2026-06-30;',
  '"2019" -> start=2019-01-01, end=2019-12-31. For vague ranges ("summer 2019") pick a sensible range and say which.',
  'Every result carries `period`: name it in your answer, e.g. "I looked at 1–30 June 2026."',
  'Respect `notes`. Only the events in `covered_events` were checked; do not claim anything about other planets.',
].join(' ');

function sectionData(chart: SanitizedChart, section: TimingSection): unknown {
  if (section === 'dashas') return chart.dashas ?? { available: false };
  return chart.predictive?.[section] ?? { available: false };
}

async function todayTiming(input: TimingToolInput, section: TimingSection, context: AgentToolContext) {
  // Dashas need no engine run: the stored tree already carries every date.
  const source =
    section === 'dashas' || !input.loadCurrentChart ? input.chart : await input.loadCurrentChart(context);
  const chart = sanitizeChartForLlm(source, todayAnalysisInstant(context.now));
  const today = input.todayDay(context.now);
  return {
    period: periodEcho({ start: today, end: today }, 'today'),
    section,
    shown: section,
    notes: [],
    data: sectionData(chart, section),
  };
}

function failureReason(error: unknown): PeriodSkyFailure {
  if (error instanceof PeriodSkyUnavailableError) return error.reason;
  if (error instanceof PeriodSkyTimeoutError) return 'timeout';
  return 'engine_unavailable';
}

async function skyTiming(
  input: TimingToolInput,
  section: Exclude<TimingSection, 'dashas'>,
  period: PeriodRange,
  echo: PeriodEcho,
  context: AgentToolContext,
) {
  let sky: SiderealChart;
  try {
    if (!input.loadPeriodChart) throw new PeriodSkyUnavailableError('engine_unavailable');
    sky = await input.loadPeriodChart(period, context);
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { period: echo, section, shown: section, notes: [], data: { available: false, reason: failureReason(error) } };
  }
  const multiDay = echo.days > 1;
  const asOf = periodAnalysisInstant(period.start, period.end);
  if (section === 'transits') {
    if (!sky.transit_context) return { period: echo, section, shown: section, notes: [], data: { available: false } };
    const restricted = restrictTransitsToPeriod(sky.transit_context, period, multiDay);
    const chart = sanitizeChartForLlm({ ...sky, transit_context: restricted.context }, asOf);
    return {
      period: echo,
      section,
      shown: section,
      notes: restricted.notes,
      covered_events: COVERED_EVENTS,
      data: sectionData(chart, section),
    };
  }
  return {
    period: echo,
    section,
    shown: section,
    notes: [],
    measured_at: multiDay ? 'start_of_period' : 'that_day',
    data: sectionData(sanitizeChartForLlm(sky, asOf), section),
  };
}

async function periodTiming(
  input: TimingToolInput,
  section: TimingSection,
  period: PeriodRange,
  context: AgentToolContext,
) {
  if (startsBeforeBirth(period, input.birthDay)) return { error: BEFORE_BIRTH_MESSAGE };
  const echo = periodEcho(period, 'period');
  const limits = periodLimits(period);
  if (section === 'dashas' || limits.dashasOnly) {
    const dashas = input.chart.dashas ? selectDashasForPeriod(input.chart.dashas, period) : undefined;
    const limitNotes = section === 'dashas' ? [] : limits.notes;
    return {
      period: echo,
      section,
      shown: 'dashas' as const,
      notes: [...limitNotes, ...(dashas?.notes ?? [])],
      data: dashas ?? { available: false },
    };
  }
  return skyTiming(input, section, period, echo, context);
}

export function createTimingTool(input: TimingToolInput): AgentTool {
  return {
    name: TIMING_TOOL_NAME,
    description: DESCRIPTION,
    statusLabel: 'Working out the sky… (about 30 s)',
    timeoutMs: TIMING_TOOL_TIMEOUT_MS,
    parameters: {
      type: 'object',
      properties: { section: { type: 'string', enum: TIMING_SECTIONS }, start: DAY, end: DAY },
      required: ['section'],
      additionalProperties: false,
    },
    execute: async (args: AgentJsonObject, context: AgentToolContext) => {
      const section = enumArgument(args, 'section', TIMING_SECTIONS) as TimingSection;
      const parsed = parsePeriodArgs(args);
      if (parsed.kind === 'invalid') return { error: parsed.error };
      if (parsed.kind === 'today') return todayTiming(input, section, context);
      return periodTiming(input, section, parsed.period, context);
    },
  };
}
```

Export `SanitizedChart` from `@almamesh/llm` already exists (index.ts type block). Confirm `AgentJsonObject`, `AgentTool`, `AgentToolContext` are exported there (they are imported the same way in `chatAgentTools.ts`).

In `chatAgentTools.ts`:
- Delete the local `enumArgument` and import it: `import { enumArgument } from './agentArgs';`.
- Replace the whole `get_current_timing` object (lines 149-177) with `createTimingTool({ chart: input.chart, birthDay: input.birthDay, todayDay: input.todayDay ?? defaultTodayDay, loadCurrentChart: input.loadCurrentChart, loadPeriodChart: input.loadPeriodChart }),`.
- Remove the now-unused `timingSections` constant and the `todayAnalysisInstant` import.
- Add imports and the default:

```ts
import type { PeriodRange } from '@almamesh/llm';
import { viewerTimeZone } from './analysisInstant';
import { predictiveReferenceInstant } from './predictive';
import { createTimingTool } from './timingTool';

/** Today's calendar day in the viewer's zone, the one "today" for every page. */
function defaultTodayDay(now: Date): string {
  return predictiveReferenceInstant(now, viewerTimeZone()).slice(0, 10);
}
```

- Extend `CreateChatAgentToolsInput`:

```ts
  /** The local birth day (YYYY-MM-DD); periods before it are refused. */
  readonly birthDay?: string;
  /** Today's calendar day; defaults to the viewer's zone. */
  readonly todayDay?: (now: Date) => string;
  /** Engine facts for a period other than today (periodSky.ts). */
  readonly loadPeriodChart?: (period: PeriodRange, context: AgentToolContext) => Promise<SiderealChart>;
```

- Update the `chartAsOf` doc comment: replace `get_current_timing` with `get_timing`.

Rename the lookups: in `Dashboard.tsx:360` and `MeshEdge.tsx:351` replace `tool.name === 'get_current_timing'` with `tool.name === 'get_timing'`. In `MeshEdge.test.tsx:327`, `e2e/chat.grounding.spec.ts:431` and `e2e/dashboard.agentic.real.spec.ts:199` replace the string `'get_current_timing'` with `'get_timing'`.

- [ ] **Step 4: Run to verify pass, plus nothing else still names the old tool**

Run:

```bash
cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.test.ts src/lib/__tests__/chatAgentTools.test.ts src/pages/__tests__/MeshEdge.test.tsx
cd .. && bun run --filter @almamesh/web typecheck
grep -rn "get_current_timing" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules; test $? -eq 1
```

Expected: PASS, typecheck clean, and the final grep finds nothing (exit status 1, so `test` passes).

- [ ] **Step 5: Mutation red (today default, echo, before-birth secrecy, dashas-only cap path)**

```bash
cd frontend/apps/web
T="bunx vitest run src/lib/__tests__/timingTool.test.ts"
python3 "$MUTATE" src/lib/timingTool.ts '  const today = input.todayDay(context.now);' "  const today = '2025-01-01';" -- $T
python3 "$MUTATE" src/lib/timingTool.ts "  const echo = periodEcho(period, 'period');" "  const echo = periodEcho({ start: '1970-01-01', end: '1970-01-01' }, 'period');" -- $T
python3 "$MUTATE" src/lib/timingTool.ts '  if (startsBeforeBirth(period, input.birthDay)) return { error: BEFORE_BIRTH_MESSAGE };' \
  '  if (startsBeforeBirth(period, input.birthDay)) return { error: `${BEFORE_BIRTH_MESSAGE} (${input.birthDay})` };' -- $T
python3 "$MUTATE" src/lib/timingTool.ts "  if (section === 'dashas' || limits.dashasOnly) {" "  if (section === 'dashas') {" -- $T
```

Expected: four `KILLED`.

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/apps/web/src/lib/agentArgs.ts frontend/apps/web/src/lib/timingTool.ts \
  frontend/apps/web/src/lib/chatAgentTools.ts \
  frontend/apps/web/src/lib/__tests__/timingTool.test.ts frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts \
  frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/MeshEdge.tsx \
  frontend/apps/web/src/pages/__tests__/MeshEdge.test.tsx \
  frontend/apps/web/e2e/chat.grounding.spec.ts frontend/apps/web/e2e/dashboard.agentic.real.spec.ts
git commit -m "feat(web): get_timing takes start/end; dashas by date; period sky with honest failures"
```

---

### Task 10: The router skips today's pre-run for dated questions

**Files:**
- Modify: `frontend/apps/web/src/lib/chatAgentTools.ts:73-80`
- Modify: `frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts` (new describe blocks)

**Interfaces:**
- Produces: `mentionsExplicitPeriod(question: string): boolean`; `shouldPreRunToday(question: string): boolean` (= `requiresCurrentPlanetaryContext(q) && !mentionsExplicitPeriod(q)`). Task 11's builder calls `shouldPreRunToday`.

- [ ] **Step 1: Write the failing tests** (append to `chatAgentTools.test.ts`, and add `mentionsExplicitPeriod, shouldPreRunToday` to its import)

```ts
describe('mentionsExplicitPeriod', () => {
  it.each([
    'What happened in June 2019?',
    'transits in June 2019',
    'How was 2019 for me?',
    'What about 15 June?',
    'what may happen in May?',
    'Tell me about May 2027',
    '¿Cómo fue marzo de 2020?',
    '¿Qué pasó en julio?',
    'Como foi março para mim?',
    'E em setembro?',
  ])('sees an explicit period in: %s', (question) => {
    expect(mentionsExplicitPeriod(question)).toBe(true);
  });

  it.each([
    'What may happen today?',
    'What are my current transits?',
    'Ask Marco about this week',
    'How should I march forward this month?',
    'Where is my natal Mars?',
    'Explain my ascendant.',
  ])('sees no explicit period in: %s', (question) => {
    expect(mentionsExplicitPeriod(question)).toBe(false);
  });
});

describe('shouldPreRunToday', () => {
  it('pre-runs today only for "today" questions with no explicit period', () => {
    expect(shouldPreRunToday('What are my current transits?')).toBe(true);
    expect(shouldPreRunToday('What may happen today?')).toBe(true);
    expect(shouldPreRunToday('transits in June 2019')).toBe(false);
    expect(shouldPreRunToday('Where is my natal Mars?')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatAgentTools.test.ts`
Expected: FAIL (`mentionsExplicitPeriod` is not a function).

- [ ] **Step 3: Implement** (in `chatAgentTools.ts`, below `requiresCurrentPlanetaryContext`; also refactor that function to use `foldQuestion`)

```ts
/** Lowercase with accents folded, the way the router has always matched. */
function foldQuestion(question: string): string {
  return question.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Month names in en/es/pt (folded). "may" and "march" are also an English
// verb and "marco" is a first name, so those three count only beside a date
// word (Review Focus 1). Portuguese "março" is caught before folding.
const MONTH_WORDS = [
  'january', 'february', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre',
  'octubre', 'noviembre', 'diciembre',
  'janeiro', 'fevereiro', 'maio', 'junho', 'julho', 'setembro', 'outubro', 'novembro', 'dezembro',
];
const YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
const MONTH_PATTERN = new RegExp(`\\b(?:${MONTH_WORDS.join('|')})\\b`);
const MARCO_PATTERN = /\bmarço\b/;
const AMBIGUOUS_MONTH = '(?:may|march|marco)';
const AMBIGUOUS_MONTH_PATTERN = new RegExp(
  [
    `\\b(?:in|of|since|until|by|en|em|de|desde|hasta|ate)\\s+${AMBIGUOUS_MONTH}\\b`,
    `\\b${AMBIGUOUS_MONTH}\\s+(?:de\\s+)?\\d{1,4}\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:de\\s+)?${AMBIGUOUS_MONTH}\\b`,
  ].join('|'),
);

/** True when the question names a year or a month: the model should send dates, not get today. */
export function mentionsExplicitPeriod(question: string): boolean {
  const folded = foldQuestion(question);
  return (
    YEAR_PATTERN.test(folded) ||
    MONTH_PATTERN.test(folded) ||
    MARCO_PATTERN.test(question.toLowerCase()) ||
    AMBIGUOUS_MONTH_PATTERN.test(folded)
  );
}

/**
 * The router (spec, "The regex router"): pre-run TODAY's sky only for a
 * "today" question with no explicit period. "Transits in June 2019" matches
 * "transits", but pre-running today would label the prompt "today" and spend
 * 30 s on the wrong sky.
 */
export function shouldPreRunToday(question: string): boolean {
  return requiresCurrentPlanetaryContext(question) && !mentionsExplicitPeriod(question);
}
```

Change `requiresCurrentPlanetaryContext` to `return CURRENT_CONTEXT_PATTERN.test(foldQuestion(question));`.

Note: "this month" in a question is a today-word, not an explicit period. Do not add "month" to `MONTH_WORDS`.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatAgentTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation red (router drop, ambiguous-month guard)**

```bash
cd frontend/apps/web
T="bunx vitest run src/lib/__tests__/chatAgentTools.test.ts"
python3 "$MUTATE" src/lib/chatAgentTools.ts '  return requiresCurrentPlanetaryContext(question) && !mentionsExplicitPeriod(question);' \
  '  return requiresCurrentPlanetaryContext(question);' -- $T
python3 "$MUTATE" src/lib/chatAgentTools.ts "  'january', 'february', 'april'," "  'january', 'february', 'march', 'may', 'april'," -- $T
```

Expected: two `KILLED` (the second makes "What may happen today?" and "march forward" count as periods).

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/apps/web/src/lib/chatAgentTools.ts frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts
git commit -m "feat(web): router leaves dated questions to get_timing instead of pre-running today"
```

---

### Task 11: One shared builder for Dashboard and MeshEdge; "today" unified on the viewer zone

**Files:**
- Create: `frontend/apps/web/src/lib/chatToolset.ts`
- Create: `frontend/apps/web/src/lib/__tests__/chatToolset.test.ts`
- Create: `frontend/apps/web/src/test/viewerToday.ts`
- Create: `frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts`
- Modify: `frontend/apps/web/src/pages/Dashboard.tsx:300-399` and imports (`:15-20`, `:47`, `:81-85`)
- Modify: `frontend/apps/web/src/pages/MeshEdge.tsx:302-387` and imports (`:40-46`, `:77-81`)
- Modify: `frontend/apps/web/src/pages/__tests__/Dashboard.chatZone.test.tsx`, `frontend/apps/web/src/pages/__tests__/MeshEdge.test.tsx`

**Interfaces:**
- Consumes: `createChatAgentTools`, `shouldPreRunToday` (Tasks 9-10), `TIMING_TOOL_NAME`, `PeriodSkyUnavailableError` (Task 9), `periodSkyCache`, `periodReferenceInstant` (Task 7), `ensureCurrentPlanetaryContext` (`currentPlanetaryContext.ts`), `buildEnsurePredictiveInput`, `predictiveReferenceInstant` (`predictive.ts`), `viewerTimeZone` (`analysisInstant.ts`), `ChartEngineContextValue` (`providers/chartEngineContext.ts`).
- Produces:
  - `interface BuildChatToolsetInput { chart; chartAsOf; chartTimeZone; profileKey; birth; engine; viewerZone?: () => string }`
  - `interface PrepareOptions { now: Date; signal: AbortSignal; onStatus?: (label: string) => void }`
  - `interface PreparedChatContext { chart: SiderealChart; asOf: AnalysisInstant; currentContextUnavailable: boolean }`
  - `interface ChatToolset { tools: readonly AgentTool[]; prepare(question: string, options: PrepareOptions): Promise<PreparedChatContext> }`
  - `buildChatToolset(input: BuildChatToolsetInput): ChatToolset`
  - test helper `expectToolsetReadsViewerToday(toolset: ChatToolset, birthZone: string): Promise<void>`

Decision (spec open question 1, decided): pages pass **no** day zone. The builder reads today with `viewerTimeZone()`. `viewerZone` exists only as a test seam; the wiring test fails if a page passes it.

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/test/viewerToday.ts`:

```ts
import { expect } from 'vitest';

import { viewerTimeZone } from '../lib/analysisInstant';
import type { ChatToolset } from '../lib/chatToolset';
import { predictiveReferenceInstant } from '../lib/predictive';

/** 20:00 UTC: already the next calendar day in Asia/Kolkata, still today in UTC and the Americas. */
export const SPLIT_DAY_NOW = new Date('2026-03-08T20:00:00.000Z');

/**
 * Pin a page's chat "today" to the viewer zone (spec open question 1, decided).
 * The precondition proves the test can tell the two zones apart on this machine.
 */
export async function expectToolsetReadsViewerToday(toolset: ChatToolset, birthZone: string): Promise<void> {
  const viewerDay = predictiveReferenceInstant(SPLIT_DAY_NOW, viewerTimeZone()).slice(0, 10);
  const birthDay = predictiveReferenceInstant(SPLIT_DAY_NOW, birthZone).slice(0, 10);
  expect(viewerDay, 'run this test in a zone west of UTC+04:00 so the days differ').not.toBe(birthDay);
  const timing = toolset.tools.find((tool) => tool.name === 'get_timing');
  if (!timing) throw new Error('get_timing is missing');
  const result = (await timing.execute(
    { section: 'dashas' },
    { now: SPLIT_DAY_NOW, signal: new AbortController().signal },
  )) as { period: { start: string } };
  expect(result.period.start).toBe(viewerDay);
}
```

`frontend/apps/web/src/lib/__tests__/chatToolset.test.ts`:

```ts
import type { SiderealChart } from '@almamesh/browser/types';
import type { ProcessedBirthData } from '@almamesh/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SPLIT_DAY_NOW } from '../../test/viewerToday';

const ensureMock = vi.hoisted(() => vi.fn());
vi.mock('../currentPlanetaryContext', () => ({ ensureCurrentPlanetaryContext: ensureMock }));

const loadMock = vi.hoisted(() => vi.fn());
vi.mock('../periodSky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../periodSky')>();
  return { ...actual, periodSkyCache: () => ({ load: loadMock, keys: () => [] }) };
});

import { buildChatToolset } from '../chatToolset';

const CHART = { ayanamsa_value: 23.7, lagna: {}, planets: [], houses: [], yogas: [] } as unknown as SiderealChart;
const BIRTH = {
  birth_datetime_utc: '1990-01-15T06:30:00Z',
  birth_datetime_local: '1990-01-15T12:00:00',
  birth_location_details: { city: 'Delhi', latitude: 28.61, longitude: 77.21, timezone: 'Asia/Kolkata' },
} as unknown as ProcessedBirthData;
const ENGINE = {
  engine: { computePredictive: vi.fn() },
  startBootstrap: vi.fn(),
  whenReady: vi.fn(),
} as never;

function toolset(viewerZone = () => 'America/Los_Angeles') {
  return buildChatToolset({
    chart: CHART,
    chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') },
    chartTimeZone: 'Asia/Kolkata',
    profileKey: 'p1',
    birth: BIRTH,
    engine: ENGINE,
    viewerZone,
  });
}

beforeEach(() => {
  ensureMock.mockReset().mockResolvedValue({ ...CHART, transit_context: undefined });
  loadMock.mockReset().mockResolvedValue({});
});

describe('buildChatToolset: one "today", the viewer zone', () => {
  it('get_timing with no dates reads today in the viewer zone, not the birth zone', async () => {
    const timing = toolset().tools.find((tool) => tool.name === 'get_timing')!;
    const result = await timing.execute({ section: 'dashas' }, { now: SPLIT_DAY_NOW, signal: new AbortController().signal });
    expect(result).toMatchObject({ period: { start: '2026-03-08', basis: 'today' } }); // Kolkata is already 03-09
  });

  it("the router's today pre-run asks the engine for the viewer's day", async () => {
    await toolset().prepare('What are my transits today?', { now: SPLIT_DAY_NOW, signal: new AbortController().signal });
    expect(ensureMock).toHaveBeenCalledWith(expect.objectContaining({ chartTimeZone: 'America/Los_Angeles' }));
  });
});

describe('buildChatToolset: router', () => {
  it('does not pre-run today for a dated question', async () => {
    const prepared = await toolset().prepare('transits in June 2019', {
      now: SPLIT_DAY_NOW,
      signal: new AbortController().signal,
    });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(prepared.asOf.basis).toBe('chart');
  });

  it('labels the prompt "today" after a today pre-run', async () => {
    const prepared = await toolset().prepare('What matters today?', {
      now: SPLIT_DAY_NOW,
      signal: new AbortController().signal,
    });
    expect(prepared.asOf.basis).toBe('today');
    expect(prepared.currentContextUnavailable).toBe(false);
  });

  it('marks the context unavailable when the today pre-run fails', async () => {
    ensureMock.mockRejectedValue(new Error('engine down'));
    const prepared = await toolset().prepare('What matters today?', {
      now: SPLIT_DAY_NOW,
      signal: new AbortController().signal,
    });
    expect(prepared.currentContextUnavailable).toBe(true);
  });
});

describe('buildChatToolset: period sky', () => {
  it('loads a period through the period-sky cache at the period start', async () => {
    const timing = toolset().tools.find((tool) => tool.name === 'get_timing')!;
    await timing.execute(
      { section: 'strength', start: '2019-06-01', end: '2019-06-30' },
      { now: SPLIT_DAY_NOW, signal: new AbortController().signal },
    );
    expect(loadMock).toHaveBeenCalledWith(
      expect.objectContaining({ referenceInstant: '2019-06-01T00:00:00Z', profileKey: 'p1', utcOffsetMinutes: 330 }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('refuses periods before the local birth day', async () => {
    const timing = toolset().tools.find((tool) => tool.name === 'get_timing')!;
    const result = await timing.execute(
      { section: 'dashas', start: '1990-01-14' },
      { now: SPLIT_DAY_NOW, signal: new AbortController().signal },
    );
    expect(result).toHaveProperty('error');
  });
});
```

`frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Both chat surfaces build their tools through ONE builder and pass no day
// zone, so they cannot disagree on "today" again (spec open question 1).
const pages = ['Dashboard.tsx', 'MeshEdge.tsx'].map((name) => ({
  name,
  source: readFileSync(resolve(__dirname, '../../pages', name), 'utf8'),
}));

describe.each(pages)('$name chat wiring', ({ source }) => {
  it('builds its tools with buildChatToolset', () => {
    expect(source).toContain('buildChatToolset(');
  });

  it('does not build tools, run the router, or pick a day zone itself', () => {
    expect(source).not.toContain('createChatAgentTools(');
    expect(source).not.toContain('ensureCurrentPlanetaryContext(');
    expect(source).not.toContain('requiresCurrentPlanetaryContext(');
    expect(source).not.toContain('viewerZone');
  });
});
```

Page-level pins. In `Dashboard.chatZone.test.tsx`, add a wrapper mock below the existing `vi.mock` calls and a new case in the describe:

```ts
vi.mock('../../lib/chatToolset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/chatToolset')>();
  return { ...actual, buildChatToolset: vi.fn(actual.buildChatToolset) };
});
import { buildChatToolset, type ChatToolset } from '../../lib/chatToolset';
import { expectToolsetReadsViewerToday } from '../../test/viewerToday';
```

```ts
  it('reads chat "today" in the viewer zone, like MeshEdge', async () => {
    const chart = chartWithZone('Asia/Kolkata');
    useChartLibraryStore.setState({ charts: { 'chart-1': chart }, hydrated: true });
    vi.mocked(readLocalPrimaryChart).mockResolvedValue(response(chart));
    renderDashboardWithChatOpen();
    await ask('What does my chart say about career?');
    await waitFor(() => expect(vi.mocked(buildChatToolset)).toHaveBeenCalled());
    const toolset = vi.mocked(buildChatToolset).mock.results[0].value as ChatToolset;
    await expectToolsetReadsViewerToday(toolset, 'Asia/Kolkata');
  });
```

In `MeshEdge.test.tsx`, add the same `vi.mock('../../lib/chatToolset', …)` wrapper and imports, and at the end of the existing "Discuss in chat" test that asserts the tool names (after `waitFor(() => expect(llmMocks.streamAgentChat).toHaveBeenCalledTimes(1))`), add:

```ts
    const toolset = vi.mocked(buildChatToolset).mock.results.at(-1)!.value as ChatToolset;
    await expectToolsetReadsViewerToday(toolset, 'Asia/Kolkata'); // the anchor's birth zone in this fixture
```

Both pages assert the same function of the same instant, so a page that reads its birth zone fails.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts src/lib/__tests__/chatToolsetWiring.test.ts src/pages/__tests__/Dashboard.chatZone.test.tsx src/pages/__tests__/MeshEdge.test.tsx`
Expected: FAIL (`../chatToolset` missing; wiring finds `createChatAgentTools(` in both pages).

- [ ] **Step 3: Implement `chatToolset.ts`**

```ts
/**
 * The ONE chat tool builder for Dashboard and MeshEdge (spec 2026-10-08,
 * "One tool builder"). It owns today's engine load, the period-sky load, the
 * router, and the one "today": the viewer's (device) zone for every page
 * (open question 1, decided 2026-10-08). Pages pass no zone.
 */
import type { SiderealChart } from '@almamesh/browser/types';
import {
  todayAnalysisInstant,
  type AgentTool,
  type AgentToolContext,
  type AnalysisInstant,
  type PeriodRange,
} from '@almamesh/llm';
import type { PredictiveRuntime } from '@almamesh/store';
import type { ProcessedBirthData } from '@almamesh/shared-types';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { viewerTimeZone } from './analysisInstant';
import { createChatAgentTools, shouldPreRunToday } from './chatAgentTools';
import { ensureCurrentPlanetaryContext } from './currentPlanetaryContext';
import { buildEnsurePredictiveInput, predictiveReferenceInstant } from './predictive';
import { periodReferenceInstant, periodSkyCache } from './periodSky';
import { PeriodSkyUnavailableError, TIMING_TOOL_NAME } from './timingTool';

export interface BuildChatToolsetInput {
  readonly chart: SiderealChart;
  readonly chartAsOf: AnalysisInstant;
  /** The birth zone. Only `get_current_datetime`'s "chart" scope reads it. */
  readonly chartTimeZone: string;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  /** Test seam only. Pages never pass it (pinned by chatToolsetWiring.test.ts). */
  readonly viewerZone?: () => string;
}

export interface PrepareOptions {
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly onStatus?: (label: string) => void;
}

export interface PreparedChatContext {
  /** The chart to sanitize into the prompt. */
  readonly chart: SiderealChart;
  readonly asOf: AnalysisInstant;
  /** A today question whose engine facts could not be computed. */
  readonly currentContextUnavailable: boolean;
}

export interface ChatToolset {
  readonly tools: readonly AgentTool[];
  prepare(question: string, options: PrepareOptions): Promise<PreparedChatContext>;
}

async function readyRuntime(engine: ChartEngineContextValue | null): Promise<PredictiveRuntime> {
  if (!engine) throw new PeriodSkyUnavailableError('engine_unavailable');
  engine.startBootstrap();
  return engine.engine ?? (await engine.whenReady());
}

/** The birth's local calendar day, for refusing earlier periods. Never sent to the model. */
function birthDayOf(birth: ProcessedBirthData | undefined): string | undefined {
  const stamp = birth?.birth_datetime_local || birth?.birth_datetime_utc;
  return stamp && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : undefined;
}

export function buildChatToolset(input: BuildChatToolsetInput): ChatToolset {
  const zone = input.viewerZone ?? viewerTimeZone;
  let promptChart = input.chart;
  let usesToday = false;

  const loadCurrentChart = async (context: AgentToolContext): Promise<SiderealChart> => {
    const runtime = await readyRuntime(input.engine);
    promptChart = await ensureCurrentPlanetaryContext({
      chart: input.chart,
      profileKey: input.profileKey,
      birth: input.birth,
      // The viewer's day: the zone every "As of" prints in, so a today-question
      // about a chart computed today joins the Life Atlas's calculation.
      chartTimeZone: zone(),
      now: context.now,
      runtime,
      signal: context.signal,
    });
    usesToday = true;
    return promptChart;
  };

  const loadPeriodChart = async (period: PeriodRange, context: AgentToolContext): Promise<SiderealChart> => {
    const predictiveInput = buildEnsurePredictiveInput(
      input.profileKey,
      input.birth,
      periodReferenceInstant(period.start),
    );
    if (!predictiveInput) throw new PeriodSkyUnavailableError('incomplete_birth_data');
    const runtime = await readyRuntime(input.engine);
    const contexts = await periodSkyCache().load(predictiveInput, runtime, context.signal);
    return { ...input.chart, ...contexts } as SiderealChart;
  };

  const tools = createChatAgentTools({
    chart: input.chart,
    chartAsOf: input.chartAsOf,
    chartTimeZone: input.chartTimeZone,
    birthDay: birthDayOf(input.birth),
    todayDay: (now) => predictiveReferenceInstant(now, zone()).slice(0, 10),
    loadCurrentChart,
    loadPeriodChart,
  });

  return {
    tools,
    async prepare(question, options) {
      let currentContextUnavailable = false;
      if (shouldPreRunToday(question)) {
        const timing = tools.find((tool) => tool.name === TIMING_TOOL_NAME);
        if (!timing) throw new Error('The timing tool is unavailable.');
        options.onStatus?.(timing.statusLabel ?? TIMING_TOOL_NAME);
        try {
          await timing.execute({ section: 'transits' }, { now: new Date(options.now.getTime()), signal: options.signal });
        } catch (error) {
          if (options.signal.aborted) throw error;
          currentContextUnavailable = true;
        }
      }
      return {
        chart: promptChart,
        asOf: usesToday ? todayAnalysisInstant(options.now) : input.chartAsOf,
        currentContextUnavailable,
      };
    },
  };
}
```

Wire `Dashboard.tsx` (`askLocalLlm`). Replace everything from `const now = new Date();` through the end of the `if (currentContextUnavailable) { … }` block (~lines 306-398) with:

```ts
    // `now` is ONLY for questions genuinely about today. Everything else
    // describes the chart as of its own analysis instant.
    const now = new Date();
    const rectification = rectificationRecord
      ? {
          band: rectificationRecord.band,
          originalSign: rectificationRecord.originalSign,
          rectifiedSign: rectificationRecord.rectifiedSign,
          mode: rectificationRecord.mode,
        }
      : undefined;

    // No `?? 'UTC'`: the chat's "current time in the chart's zone" tool would
    // silently answer in UTC. A chart without a zone is refused, visibly.
    const chartTimeZone = requireBirthTimeZone(
      storedChart?.birth_data?.birth_location_details.timezone,
      'chat',
    );
    const toolset = buildChatToolset({
      chart: withRawPredictive(chart, chartId),
      chartAsOf: storedChartAnalysisInstant(storedChart!),
      chartTimeZone,
      profileKey: storedChart?.profile_id ?? chartId ?? 'primary',
      birth: storedChart?.birth_data as ProcessedBirthData | undefined,
      engine: chartEngineContext,
    });
    const prepared = await toolset.prepare(question, {
      now,
      signal,
      onStatus: (label) => onAgentStatus?.(label),
    });

    let messages = buildChatMessages(
      sanitizeChartForLlm(prepared.chart, prepared.asOf),
      question,
      chatMode,
      history,
      retrievedContext,
      interpretationText,
      language,
      undefined,
      rectification,
    );
    if (prepared.currentContextUnavailable) {
      const [system, ...rest] = messages;
      messages = [
        {
          ...system,
          content:
            `${system.content ?? ''}\n\n` +
            'CURRENT-CONTEXT SAFETY: This question requires exact-day planetary facts, but the on-device calculation was unavailable. Say that plainly and do not infer current transits or timing from natal facts.',
        },
        ...rest,
      ];
    }
```

and in the `streamAgentChat({ … })` call change `tools,` to `tools: toolset.tools,`. Imports: remove `createChatAgentTools`, `requiresCurrentPlanetaryContext` (the whole `../lib/chatAgentTools` import), `ensureCurrentPlanetaryContext`, `todayAnalysisInstant`, and `viewerTimeZone` if typecheck/lint reports them unused; add `import { buildChatToolset } from "../lib/chatToolset";`.

Wire `MeshEdge.tsx` (`askMeshLlm`) the same way. Replace from `const now = new Date();` through its `if (currentContextUnavailable) { … }` block with:

```ts
    const now = new Date();
    // No `?? 'UTC'`: the chat's "current time in the chart's zone" tool would
    // silently answer in UTC. A chart without a zone is refused, visibly.
    const chartTimeZone = requireBirthTimeZone(
      anchorChart?.birth_data?.birth_location_details.timezone,
      'chat',
    );
    const toolset = buildChatToolset({
      chart: siderealChart,
      chartAsOf: storedChartAnalysisInstant(anchorChart!),
      chartTimeZone,
      profileKey: anchorChart?.profile_id ?? anchorChart?.chart_id ?? anchor.id,
      birth: anchorChart?.birth_data as ProcessedBirthData | undefined,
      engine: chartEngineContext,
    });
    const prepared = await toolset.prepare(question, {
      now,
      signal,
      onStatus: (label) => onAgentStatus?.(label),
    });

    let messages = buildChatMessages(
      sanitizeChartForLlm(prepared.chart, prepared.asOf),
      question,
      chatMode,
      history,
      retrievedContext,
      undefined,
      language,
      entry.edge ? sanitizeMeshEdgeForLlm(entry.edge) : undefined,
    );
    if (prepared.currentContextUnavailable) {
      const [system, ...rest] = messages;
      messages = [
        {
          ...system,
          content:
            `${system.content ?? ''}\n\n` +
            'CURRENT-CONTEXT SAFETY: This question requires exact-day planetary facts, but the on-device calculation was unavailable. Say that plainly and do not infer current transits or timing from natal or relationship facts.',
        },
        ...rest,
      ];
    }
```

and `tools: toolset.tools,` in its `streamAgentChat` call. Remove the now-unused imports (`createChatAgentTools`, `requiresCurrentPlanetaryContext`, `ensureCurrentPlanetaryContext`, `todayAnalysisInstant`); add `import { buildChatToolset } from '../lib/chatToolset';`. This is the behaviour change for MeshEdge: its "today" moves from the birth zone to the viewer zone.

- [ ] **Step 4: Run to verify pass**

```bash
cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts src/lib/__tests__/chatToolsetWiring.test.ts \
  src/pages/__tests__/Dashboard.chatZone.test.tsx src/pages/__tests__/MeshEdge.test.tsx src/lib/__tests__/chatAgentTools.test.ts
cd .. && bun run --filter @almamesh/web typecheck && bun run --filter @almamesh/web lint && bun run knip
```

Expected: all PASS. If `knip` flags `requiresCurrentPlanetaryContext` or `__resetPeriodSkyCacheForTest` as unused exports, un-export the first only if nothing outside `chatAgentTools.ts` uses it, and use the second from `periodSky.test.ts` (add an `afterEach(__resetPeriodSkyCacheForTest)`).

- [ ] **Step 5: Mutation red (viewer zone, router in builder, page wiring)**

```bash
cd frontend/apps/web
python3 "$MUTATE" src/lib/chatToolset.ts '  const zone = input.viewerZone ?? viewerTimeZone;' "  const zone = input.viewerZone ?? (() => input.chartTimeZone);" \
  -- bunx vitest run src/pages/__tests__/Dashboard.chatZone.test.tsx src/pages/__tests__/MeshEdge.test.tsx
python3 "$MUTATE" src/lib/chatToolset.ts '      if (shouldPreRunToday(question)) {' '      if (true) {' \
  -- bunx vitest run src/lib/__tests__/chatToolset.test.ts
python3 "$MUTATE" src/lib/chatToolset.ts '      chartTimeZone: zone(),' '      chartTimeZone: input.chartTimeZone,' \
  -- bunx vitest run src/lib/__tests__/chatToolset.test.ts
```

Expected: three `KILLED` (the second pre-runs today for "transits in June 2019"; the third asks the engine for the birth zone's day).

- [ ] **Step 6: frontend-quality, commit**

```bash
git add frontend/apps/web/src/lib/chatToolset.ts frontend/apps/web/src/lib/__tests__/chatToolset.test.ts \
  frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts frontend/apps/web/src/test/viewerToday.ts \
  frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/MeshEdge.tsx \
  frontend/apps/web/src/pages/__tests__/Dashboard.chatZone.test.tsx frontend/apps/web/src/pages/__tests__/MeshEdge.test.tsx
git commit -m "refactor(web): one chat tool builder; Dashboard and MeshEdge share the viewer's today"
```

---

### Task 12: End-to-end journey "what happened in June 2019?", wired into CI

**Files:**
- Create: `frontend/apps/web/e2e/time-travel.spec.ts`
- Create: `frontend/apps/web/playwright.time-travel.config.ts`
- Modify: `frontend/apps/web/package.json` (scripts)
- Modify: `dagger/src/index.ts:490-495` (browserJourneys lane)
- Modify: `tests/dagger-gates.test.ts:291` (commands list)

**Interfaces:**
- Consumes: everything above; `bootEngine`, `seedChart`, `LLM_SETTINGS_KEY` from `e2e/interpretation.helpers.ts` (seeded chart: Delhi, born `1990-01-15T12:00:00Z`, reference `2025-01-01`).
- Produces: `bun run test:e2e:time-travel` (Playwright, chromium in CI).

- [ ] **Step 1: Pin the CI command first (contract test, red)**

In `tests/dagger-gates.test.ts`, add right after the `TIME_HANDLING_E2E_BASE_URL=…` entry in the `commands` array:

```ts
    "TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium",
```

Run: `bun test ./tests/dagger-gates.test.ts`
Expected: FAIL on `runs exactly once: TIME_TRAVEL_E2E_BASE_URL=…`.

- [ ] **Step 2: Write the Playwright config**

`frontend/apps/web/playwright.time-travel.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

/**
 * Time-travel journeys (e2e/time-travel.spec.ts, spec 2026-10-08 Inc A): a
 * dated question typed into plain Dashboard chat, a stubbed provider that
 * calls get_timing with dates, and the REAL in-browser engine.
 *
 * Point TIME_TRAVEL_E2E_BASE_URL at an existing preview (CI's browserJourneys
 * lane serves its build on :4199) to skip the local build.
 */
const PORT = Number(process.env.TIME_TRAVEL_E2E_PORT ?? 4216);
const EXTERNAL_BASE_URL = process.env.TIME_TRAVEL_E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /time-travel\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 420_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 300_000,
        cwd: __dirname,
      },
});
```

Check the port is free of other configs: `grep -n 4216 frontend/apps/web/playwright.*.ts` must list only this file.

In `frontend/apps/web/package.json` scripts, add after `test:e2e:time-handling`:

```json
    "test:e2e:time-travel": "playwright test --config=playwright.time-travel.config.ts",
```

- [ ] **Step 3: Write the journey**

`frontend/apps/web/e2e/time-travel.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { LLM_SETTINGS_KEY, bootEngine, seedChart } from './interpretation.helpers';

/**
 * Journey 1 (spec 2026-10-08): "what was going on for me in June 2019?" typed
 * into plain Dashboard chat. The provider is stubbed with page.route (as in
 * chat.grounding.spec.ts) so the run is deterministic; the engine is real.
 */
const LLM_CONFIG = {
  apiBase: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'deepseek/deepseek-v4-pro',
  privacyMode: 'cloud_premium',
  engine: 'openai-http',
};
const QUESTION = 'What was going on for me in June 2019? Any big transits?';
const ANSWER = 'I looked at 1–30 June 2019. A Saturn antar was ending and Jupiter was moving.';
const BIRTH_MONTH = '1990-01'; // DELHI_BIRTH.datetimeUtc

interface WireMessage {
  role: string;
  name?: string;
  content?: string | null;
}

test('[contract/stubbed] a typed June 2019 question reads June 2019, not today', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(
    ([key, cfg]) => window.localStorage.setItem(key as string, cfg as string),
    [LLM_SETTINGS_KEY, JSON.stringify(LLM_CONFIG)] as const,
  );

  const agentRequests: Array<{ messages: WireMessage[]; tools: Array<{ function: { name: string } }> }> = [];
  await page.route('**/chat/completions', async (route) => {
    const parsed = JSON.parse(route.request().postData() ?? '{}') as {
      messages?: WireMessage[];
      tools?: Array<{ function: { name: string } }>;
    };
    if (!Array.isArray(parsed.tools) || !JSON.stringify(parsed.messages).includes('June 2019')) {
      // Anything else (summaries, other features): a harmless empty answer.
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '' } }] }),
      });
    }
    agentRequests.push({ messages: parsed.messages ?? [], tools: parsed.tools });
    const hasToolResults = (parsed.messages ?? []).some((message) => message.role === 'tool');
    if (!hasToolResults) {
      const call = (id: string, section: string) => ({
        id,
        type: 'function',
        function: {
          name: 'get_timing',
          arguments: JSON.stringify({ section, start: '2019-06-01', end: '2019-06-30' }),
        },
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [call('dashas-june', 'dashas'), call('sky-june', 'transits')] } }],
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: ANSWER } }] }),
    });
  });

  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // The seeded chart re-anchors to today first; an answer streamed across that
  // is discarded by design, so chat about the chart the user will see.
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
  );
  const footer = page.getByTestId('provenance-footer');
  await expect(footer).toContainText(`As of ${today}`, { timeout: 120_000 });

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await page.getByTestId('chat-input').fill(QUESTION);
  await page.getByTestId('chat-send-button').click();

  // The period compute runs the real engine (~30 s) and says so.
  await expect(page.getByTestId('chat-agent-status')).toContainText('Working out the sky', { timeout: 60_000 });
  const chatPanel = page.getByTestId('chat-panel');
  await expect(chatPanel.getByText('I looked at 1–30 June 2019.', { exact: false })).toBeVisible({ timeout: 240_000 });

  expect(agentRequests).toHaveLength(2);
  const [decision, final] = agentRequests;
  expect(decision.tools.map((tool) => tool.function.name)).toEqual([
    'get_current_datetime',
    'get_chart_facts',
    'get_timing',
  ]);
  // Router: "transits" alone used to pre-run TODAY and label the prompt "today".
  const prompt = decision.messages.map((message) => message.content ?? '').join('\n');
  expect(prompt).not.toContain(', today):');

  const toolResults = final.messages.filter((message) => message.role === 'tool');
  expect(toolResults.map((message) => message.name)).toEqual(['get_timing', 'get_timing']);
  for (const result of toolResults) {
    expect(result.content).toContain('"period":{"start":"2019-06-01","end":"2019-06-30","days":30,"basis":"period"}');
    expect(result.content).not.toContain(BIRTH_MONTH);
  }
  expect(toolResults[0].content).toContain('"antar"');
  expect(toolResults[1].content).toContain('"covered_events"');
  expect(toolResults[1].content).not.toContain('"available":false');

  // The Life Atlas still describes today: the period compute did not take its slot.
  await expect(footer).toContainText(`As of ${today}`);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  await page.screenshot({ path: 'test-results/time-travel-june-2019.png', fullPage: true });
});
```

- [ ] **Step 4: Wire into the browserJourneys lane**

In `dagger/src/index.ts`, after the `TIME_HANDLING_E2E_BASE_URL=…` command (inside the same array), add:

```ts
      // Time travel (spec 2026-10-08, Inc A): "what happened in June 2019?"
      // typed in plain chat; a stubbed provider calls get_timing with dates;
      // the real engine computes June 2019. Chromium only.
      "TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium",
```

- [ ] **Step 5: Run the contract test and the journey**

```bash
bun test ./tests/dagger-gates.test.ts
cd frontend/apps/web && bun run test:e2e:time-travel --project=chromium
```

Expected: contract PASS; journey PASS with the screenshot at `frontend/apps/web/test-results/time-travel-june-2019.png`. Look at the screenshot.

- [ ] **Step 6: Red runs (CI pin and the journey)**

```bash
python3 "$MUTATE" dagger/src/index.ts \
  '      "TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium",' '' \
  -- bun test ./tests/dagger-gates.test.ts
cd frontend/apps/web
python3 "$MUTATE" src/lib/chatAgentTools.ts \
  '  return requiresCurrentPlanetaryContext(question) && !mentionsExplicitPeriod(question);' \
  '  return requiresCurrentPlanetaryContext(question);' \
  -- bun run test:e2e:time-travel --project=chromium
```

Expected: both `KILLED`. The second fails on `not.toContain(', today):')`. It rebuilds the bundle (several minutes).

- [ ] **Step 7: commit**

```bash
git add frontend/apps/web/e2e/time-travel.spec.ts frontend/apps/web/playwright.time-travel.config.ts \
  frontend/apps/web/package.json dagger/src/index.ts tests/dagger-gates.test.ts
git commit -m "test(e2e): typed June 2019 question reads June 2019; wired into browserJourneys"
```

---

### Task 13: Full gate, live drive, northstar grade, one PR

**Files:** none new. Evidence only.

- [ ] **Step 1: Full gates from the worktree root**

```bash
cd frontend && bun run gate; echo "frontend gate exit $?"
cd ../backend && poe gate; echo "backend gate exit $?"
cd .. && bun test ./tests/*.test.ts; echo "contract exit $?"
cd frontend/apps/web && bun run test:e2e:chat:grounding && bun run test:e2e:time-travel --project=chromium; echo "e2e exit $?"
```

Expected: every exit code 0. Record test counts. Then invoke `frontend-quality` on the whole diff (`git diff --name-only origin/main -- frontend`).

- [ ] **Step 2: Drive it live**

`cd frontend/apps/web && VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port 4216`. In a real browser: open `/dashboard` with a chart, open chat, type "What was going on for me in June 2019?". If an OpenRouter key is configured on this machine, use it and confirm the answer opens with the period ("I looked at 1–30 June 2019") and that the status line showed "Working out the sky… (about 30 s)". Also ask "what about today?" and confirm today still works. Take screenshots, read the console (must be clean). With no key, say plainly in the PR that the real-model drive is unverified and the stubbed journey is the evidence.

- [ ] **Step 3: Northstar grade**

Dispatch the `northstar` agent (standing approval) on the branch with: claim "only sanitized facts reach the model" (plus "MeshEdge and Dashboard agree on today"), the mutation table, the e2e screenshot, and the gate exits. Fix anything below A, re-run Step 1, re-grade.

- [ ] **Step 4: One PR**

```bash
git push -u origin claude/time-travel-inc-a
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-inc-a \
  --title "feat: time travel Inc A — get_timing takes dates" --body-file /tmp/inc-a-pr.md
```

The PR body (write `/tmp/inc-a-pr.md`) states: what ships (Inc A rows of the spec); claim touched ("only sanitized facts reach the model"); the decided open question 1 and MeshEdge's visible change (its "today" now follows the device zone); "no astrology math in TS: date-overlap selection only"; the evidence table (gate exits + counts, e2e pass + screenshot, live-drive result or "unverified"); the mutation table (every `KILLED` line from Tasks 1-12); any inverted test called out as a reversed contract; a link to spec PR #297. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
```

- [ ] **Step 5: Merge and clean up in the same breath**

When CI is green and northstar is A: `gh pr merge --squash --delete-branch`, then `git worktree remove .worktrees/time-travel-inc-a`, `git branch -D claude/time-travel-inc-a`, confirm CI green on `main`, and confirm the deploy serves the merge SHA (`build.json` `git_sha` equals the merge SHA with `content-type: application/json`). Run `dangling_audit.py` before reporting done.

---

## Self-review notes (spec coverage)

| Spec item (Inc A) | Task |
| --- | --- |
| Rename to `get_timing`, optional `start`/`end` | 9 |
| Validation rules (format, reversed, before birth, 2-year cap, 2052 cap, 12-month timeline note) | 3, 5, 9 |
| Period echo on every result; model must state it | 3, 9, 2 |
| Dashas by date, pratyantar note, first maha start as "birth" | 4, 1 |
| Fast planets out of multi-day; events filtered; `covered_events` | 5, 9 |
| `AnalysisInstant` period basis; `SanitizedAsOf.period_*`; facts label | 1, 2 |
| `periodSky.ts`: keyed by request key, store reuse, LRU, single flight, join | 7 |
| LRU size by tier (5/3/1) | 6 |
| 150 s timeout (tool + agent cap) | 8, 9, 7 |
| Router `mentionsExplicitPeriod` (en/es/pt, accents folded) | 10 |
| `buildChatToolset` for both pages; unify on the viewer zone (decided) | 11 |
| Privacy egress fixture born 2000-03-15, period 2000-06 | 1 |
| Journey 1 e2e, wired into browserJourneys + contract pin | 12 |
| Error handling: engine unavailable / timeout / incomplete birth data as reasons | 9, 11 |

Known gaps, deliberately not tasks in Inc A: the status line cannot name the period ("Working out the sky for June 2019…") because `AgentTool.statusLabel` is static and must not carry arguments (`agent.ts:40`); the "about a minute" queued-compute variant; measuring the LRU payload on a throttled profile (spec open question 2).
