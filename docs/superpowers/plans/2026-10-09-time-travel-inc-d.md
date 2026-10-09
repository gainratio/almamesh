# Time Travel Increment D (Button and Pinned Threads) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tap opens a chat thread pinned to a period. Marco taps "⏳ Time travel" beside the chat input, picks Year → 2027 and taps Go. A new thread opens with a ⏳ badge, the title "Time travel · 2027", a banner ("answers are about this period · Change · Back to today") and future-tense starters. "Will work get easier?" reads 2027 without the model sending dates, and the answer is in the future tense. A Day pin asks "Where?" with no default and searches cities on the device only. The pin is saved in SQLite, survives a reload, and travels with export and import.

**Architecture:** `ChatThread` gains an optional `as_of: ChatThreadAsOf` (start, end, granularity, and a place only for a Day pin). The chat store goes from v2 to v3; migration keeps old threads and drops a malformed `as_of`, and portable import refuses a malformed one, naming the field. One shape check, `chatAsOfProblem`, serves both. `useChatThread` hands the pin to the page's stream function, binds each answer to the natal chart plus the pin (so a pin change drops a late answer, but a daily re-anchor does not), and saves every pin change behind `waitForStoreSaved('chat')`. `buildChatToolset` takes the pin: `get_timing` with no dates reads the pinned period, the pinned place reaches the place path through a reserved internal ref the model cannot name, `get_current_datetime` adds `pinned_period` and `relative`, and the router warms the pinned period's sky instead of today's. The prompt carries a `PINNED PERIOD` rule with the tense. The UI adds a button, a sheet (Day / Month / Year; "Where?" on Day only, full-tier devices only), a banner, badge-and-title labels and starters by tense, in en/es/pt.

**Tech Stack:** TypeScript (`@almamesh/shared-types`, `@almamesh/llm`, `@almamesh/store`, `apps/web`), React, Zustand, react-i18next, Vitest, `bun:test` (repo contract tests in `tests/`), Playwright, Dagger.

**Spec:** `docs/superpowers/specs/2026-10-08-time-travel-design.md` (the copy on the step C branch, revised 2026-10-09). Read: Journey 2; Part 3 (the button and the sheet, the pinned thread, stale answers and the daily re-anchor); Data and storage; Privacy (rows "Period start/end", "The device's time zone", "Place coordinates"); Error handling (rows "Before the birth year", "User changes the pin mid-answer", "Malformed `as_of` in a backup"); Testing (rows "Pinned router", "Tense", "Stale guard", "Re-anchor skip", "Store migration", "Import validation", the e2e rows for Journey 2 and the Day pin, "Export and import round trip", "i18n"); the Inc D row.

## Rulings

The spec leaves these open or contradicts itself. This plan settles them; the PR body repeats them.

1. **There is no thread list, so the ⏳ badge and the title ride in the banner and in search labels.** The app has no thread switcher; the only place thread labels appear is `ChatSearch` (results). The banner reads "⏳ Time travel · 2027 · answers are about this period · Change · Back to today". `ChatSearch` labels a pinned thread "⏳ Time travel · 2027". The label is built at render time with `Intl.DateTimeFormat` in the UI language; it is never stored as `title` (a stored title would not follow a language change).
2. **`relative` uses the viewer's (device) day, not the chart zone.** The spec's Part 3 says "worked out in the chart zone", but open question 1 (decided 2026-10-08) unified every "today" on `viewerTimeZone()`. `relative` reads the same `todayDay` the timing tool already uses.
3. **In a pinned thread, no dates means the pin.** Part 3 ("`get_timing` defaults to the pinned period") wins over the router table's "compare with today → call without dates". The prompt tells the model to compare with now by sending the first and last day of the current month (a week or longer, so it never needs a place).
4. **A pinned answer is bound to the natal chart plus the pin, not to `snapshot_id`.** The re-anchor changes only `reference_date`, which changes `snapshot_id`. Keying a pinned answer on `snapshot_id` would drop every pinned answer that spans a re-anchor, which makes the re-anchor skip pointless. So a pinned answer's identity is every snapshot field except `reference_date` and `snapshot_id`, plus the pin key. A birth-data change still drops it; a pin change drops it with its own message; a re-anchor keeps it. Unpinned threads keep `snapshot_id` exactly as today.
5. **The Day tab exists only on full-tier devices.** A Day pin needs a place, the place needs the 2 MB city list, and step C Ruling 3 keeps that list off `lite` and `minimal`. Those devices get Month and Year. A Day pin restored from a backup onto a weak device still works: the tool answers it with dashas only (the device gate comes first), and "Change" opens on the Month tab.
6. **The button shows only when AI is configured.** With no AI the composer is replaced by the Connect-AI call to action; a pinned thread with no way to ask would be a dead end.
7. **`as_of` has one strict shape.** `start`/`end` are real days, years 1900–2099. Day: `end == start` and a place is required. Month: the 1st to the month's last day. Year: 1 January to 31 December. Only a Day pin carries a place: label (1–120 chars), a valid IANA zone, latitude in [-90, 90], longitude in [-180, 180]. Unknown keys are refused (nothing can ride along). Migration drops a malformed `as_of` and keeps the thread; import refuses the backup and names the field (`as_of.place.latitude`).
8. **The pinned "pre-run" warms the pin's sky.** For a pinned thread `prepare` calls `get_timing({ section: 'transits' })` with no dates, which now reads the pin, so the period sky lands in the in-memory LRU and the model's own call is instant. The prompt is labelled with the period basis ("as of 1 January–31 December 2027 (the period asked about)"). Today is never pre-run in a pinned thread. On a weak device the call answers dashas only and the engine never runs.
9. **The pinned place reaches the tool through the reserved ref `pinned`.** Model-supplied refs must match `^city:\d{1,6}$` (step C), so the model cannot name `pinned`. The toolset injects it after argument parsing and resolves it from the pin. The model sees only the label and the zone.
10. **The sheet's years run from the birth year (or 1900) to 2052.** 2052 is the ephemeris end. A typed Day before 1 January of the birth year shows "That's before you were born. Pick a later period." and Go stays disabled. The check is `endsBeforeBirthYear`, the same year boundary the tool uses, never the birth day.
11. **Journey 2 runs on the Dashboard in e2e.** The button lives in `ChatPanel`, which both pages mount through `FloatingChatPanel`. Seeding a mesh pair in e2e needs a second onboarded person and a mesh compute, which is a lot of harness for the same component. MeshEdge is pinned by the source wiring test (Task 10) and driven live in Task 13.
12. **Every pin change is saved before the UI moves on.** Go, Change and "Back to today" (when it creates a thread) await `waitForStoreSaved('chat')`. On failure the change is rolled back in memory, the sheet stays open and says "Couldn't save this on your device. Try again."
13. **Status labels.** The pinned pre-run shows a localized "Working out the sky for 2027… (about 30 s)" only when the engine will run; otherwise the tool's own fixed label. Tool labels stay English constants (step C Ruling 14).
14. **No test asserts "future" for a year the calendar will pass.** Unit tests that need a future pin use 2050. The e2e journey pins next year (`new Date().getUTCFullYear() + 1`, which is 2027 today, the spec's journey) and computes 365 or 366 days.

## Spec gaps found

- "Back to today opens the last normal thread, or a new one": "last" means the most recently updated unpinned thread of the active profile.
- "Starter questions follow `relative`": the spec lists two per tense; this plan ships exactly those two, and `contains_today` keeps the current eight.
- The spec does not say whether an empty pinned thread (Go, then nothing asked) should be cleaned up. It is kept, like an empty normal thread today.

## Global Constraints

- **Start only after step C is merged.** Work in `/Users/harish/dev/oss/almamesh/.worktrees/time-travel-d` on branch `claude/time-travel-d`. Before Task 1: `git fetch origin && git rebase origin/main`, then confirm `test -f frontend/apps/web/src/lib/geo/placeLookup.ts && test -f frontend/apps/web/src/lib/placeTool.ts` (step C's files). All paths below are relative to the worktree, and line numbers refer to `main` with step C merged.
- Stage named files only. Never `git add -A` or `git add .`. `docs/superpowers` is gitignored, so plan or spec files need `git add -f`.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
  ```
- **One PR at the end** (Task 13). Tasks commit to the branch.
- **SQLite is the only system of record.** `as_of` rides in the chat store's existing row (`deletionAwareIdbStorage` → canonical SQLite). No new IndexedDB, `localStorage` or `sessionStorage` key holds user data. The sheet's draft state is React state only.
- **Commit barriers go through `waitForStoreSaved('chat')`** (`apps/web/src/lib/storeSaved.ts`), never a direct `whenChatCommitted()` call from UI code.
- **Low-end tiers 5 / 3 / 1 are unchanged.** `DevicePolicy.periodSkyCacheSize` stays `full` 5, `lite` 3, `minimal` 1. This increment adds no resident cache. The Day tab and the city list exist only where `periodSkyComputeAllowed` is true (Ruling 5); the pinned pre-run never computes on `lite`/`minimal`.
- **The step A, B and C privacy rules stay intact.** The pin's dates may reach the model (the user chose them). The pin's coordinates never do: no prompt, tool result or status line carries a latitude, a longitude or any number derived from them. The device's zone is never sent. The birth year is used only in the UI to bound the sheet and in the existing tool gates.
- **Plain English in every user string** (the repo's README rule): short sentences, ordinary words. en is authoritative; es and pt are added in the same commit, and `chat.parity.test.ts` must stay green.
- **TDD with red runs.** Write the test, run it, see it fail for the stated reason, then implement. Every guard also gets a **mutation red run** with the helper below. Paste each `KILLED` line into the PR's mutation table.
- Invoke `frontend-quality` after every task (all code here is TypeScript).
- Commands:
  - Package unit: `cd frontend/packages/<pkg> && bunx vitest run <file>`. Web unit: `cd frontend/apps/web && bunx vitest run <file>`. Frontend gate: `cd frontend && bun run gate`.
  - Contract tests: `bun test ./tests/*.test.ts` from the repo root (`bun:test`, not Vitest). **Do not edit or loosen `tests/dagger-ingress-contract.test.ts`.**
  - Hooked build for e2e: `cd frontend/apps/web && VITE_EXIT_GATE_HOOKS=1 bun run build --outDir dist-verify && bunx vite preview --outDir dist-verify --host 127.0.0.1 --port 4199 --strictPort` (leave it running in another shell for Tasks 11 and 12).

Save the mutation helper once as `"${TMPDIR:-/tmp}/almamesh-mutate.py"` and `export MUTATE="${TMPDIR:-/tmp}/almamesh-mutate.py"` (the same helper as Inc A–C):

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

1. **A Day pin restored onto a weak phone.** A Day pin (with Bogotá) made on a laptop is imported on a 2 GB phone. The thread opens with its banner, the answer is dashas only, the city list never loads, nothing reads the pinned place, and "Change" opens on Month. Tests: Task 6 ("a lite device answers a Day pin with dashas only and reads no place"), Task 8 (`sheetDefaults` with `dayAllowed: false`).
2. **Today sits on the pin's edge, or the viewer is far from UTC.** Today = start and today = end are `contains_today`; the day before start is `future`; the day after end is `past`. At 20:00 UTC on 8 March 2026 a Los Angeles viewer is still on the 8th. Tests: Task 4 (boundaries), Task 6 (`SPLIT_DAY_NOW` with the viewer zone, not the birth zone).
3. **The pin changes, or the user goes back to today, while an answer streams.** The late answer must not land under the new pin. A daily re-anchor in the middle of a pinned answer must not drop it. A thread deleted mid-answer must not throw. Tests: Task 7.
4. **A backup from an older build, or a tampered one.** A v2 chat row imports and migrates. An `as_of` with an extra key (`birth_place`), latitude 91, granularity `week`, a month ending on the 30th of February, or a Month pin with a place is refused by import (naming the field) and dropped by migration (keeping the thread). A v4 row is "too new". Tests: Tasks 1, 2, 3.
5. **Calendar edges in the sheet.** February 2028 (leap) ends on the 29th; December's year rollover; Year 2052 is the last offered; a birth in 1990 offers no year before 1990; a Day typed before the birth year disables Go. Tests: Task 8.

---

### Task 1: The `as_of` type and its one shape check

**Files:**
- Modify: `frontend/packages/shared-types/src/chat.ts` (add `ChatThreadAsOf`, extend `ChatThread`)
- Modify: `frontend/packages/llm/src/period.ts` (export `isCalendarDay`), `frontend/packages/llm/src/index.ts` (re-export it on the `./period` line that exports `parsePeriodArgs`)
- Create: `frontend/packages/store/src/chatAsOf.ts`
- Modify: `frontend/packages/store/src/index.ts` (export `chatAsOfProblem`, `isChatThreadAsOf`)
- Test: `frontend/packages/store/src/chatAsOf.test.ts`

**Interfaces:**
- Consumes: `isCalendarDay(value: string): boolean` (`packages/llm/src/period.ts`, currently private).
- Produces:
  - `interface ChatThreadAsOf { readonly start: string; readonly end: string; readonly granularity: 'day' | 'month' | 'year'; readonly place?: { readonly label: string; readonly timezone: string; readonly latitude: number; readonly longitude: number } }` in `@almamesh/shared-types`; `ChatThread.as_of?: ChatThreadAsOf`.
  - `chatAsOfProblem(value: unknown): string | undefined`: the first bad field as a path (`'as_of'`, `'as_of.start'`, `'as_of.end'`, `'as_of.granularity'`, `'as_of.place'`, `'as_of.place.label'`, `'as_of.place.timezone'`, `'as_of.place.latitude'`, `'as_of.place.longitude'`), or `undefined` when valid.
  - `isChatThreadAsOf(value: unknown): value is ChatThreadAsOf`.

- [ ] **Step 1: Write the failing test**

`frontend/packages/store/src/chatAsOf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { chatAsOfProblem, isChatThreadAsOf } from './chatAsOf';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const MONTH = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;
const DAY = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;

describe('chatAsOfProblem', () => {
  it.each([
    ['a Year pin', YEAR],
    ['a Month pin', MONTH],
    ['a leap February', { start: '2028-02-01', end: '2028-02-29', granularity: 'month' }],
    ['a Day pin with a place', DAY],
    ['the first year', { start: '1900-01-01', end: '1900-12-31', granularity: 'year' }],
    ['the last year', { start: '2099-01-01', end: '2099-12-31', granularity: 'year' }],
  ])('accepts %s', (_label, value) => {
    expect(chatAsOfProblem(value)).toBeUndefined();
    expect(isChatThreadAsOf(value)).toBe(true);
  });

  it.each([
    ['not an object', 'June 2026', 'as_of'],
    ['an array', [], 'as_of'],
    ['an extra key', { ...YEAR, birth_place: 'Delhi' }, 'as_of'],
    ['a non-day start', { ...YEAR, start: '2027-1-1' }, 'as_of.start'],
    ['an impossible day', { ...DAY, start: '2026-02-30', end: '2026-02-30' }, 'as_of.start'],
    ['a year before 1900', { start: '1899-01-01', end: '1899-12-31', granularity: 'year' }, 'as_of.start'],
    ['a year after 2099', { start: '2100-01-01', end: '2100-12-31', granularity: 'year' }, 'as_of.start'],
    ['an unknown granularity', { ...MONTH, granularity: 'week' }, 'as_of.granularity'],
    ['a month not starting on the 1st', { ...MONTH, start: '2026-06-02' }, 'as_of.start'],
    ['a month ending early', { ...MONTH, end: '2026-06-29' }, 'as_of.end'],
    ['a non-leap 29 February', { start: '2027-02-01', end: '2027-02-29', granularity: 'month' }, 'as_of.end'],
    ['a year ending early', { ...YEAR, end: '2027-12-30' }, 'as_of.end'],
    ['a day spanning two days', { ...DAY, end: '2026-06-16' }, 'as_of.end'],
    ['a Day pin with no place', { start: '2026-06-15', end: '2026-06-15', granularity: 'day' }, 'as_of.place'],
    ['a Month pin with a place', { ...MONTH, place: BOGOTA }, 'as_of.place'],
    ['a place with an extra key', { ...DAY, place: { ...BOGOTA, altitude: 2640 } }, 'as_of.place'],
    ['an empty label', { ...DAY, place: { ...BOGOTA, label: '' } }, 'as_of.place.label'],
    ['a long label', { ...DAY, place: { ...BOGOTA, label: 'x'.repeat(121) } }, 'as_of.place.label'],
    ['a bad zone', { ...DAY, place: { ...BOGOTA, timezone: 'Mars/Olympus' } }, 'as_of.place.timezone'],
    ['latitude 91', { ...DAY, place: { ...BOGOTA, latitude: 91 } }, 'as_of.place.latitude'],
    ['a string latitude', { ...DAY, place: { ...BOGOTA, latitude: '4.7' } }, 'as_of.place.latitude'],
    ['longitude -181', { ...DAY, place: { ...BOGOTA, longitude: -181 } }, 'as_of.place.longitude'],
    ['a NaN longitude', { ...DAY, place: { ...BOGOTA, longitude: Number.NaN } }, 'as_of.place.longitude'],
  ])('refuses %s, naming the field', (_label, value, field) => {
    expect(chatAsOfProblem(value)).toBe(field);
    expect(isChatThreadAsOf(value)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/packages/store && bunx vitest run src/chatAsOf.test.ts`
Expected: FAIL, "Failed to resolve import './chatAsOf'".

- [ ] **Step 3: Write the type, the export and the check**

In `frontend/packages/shared-types/src/chat.ts`, above `ChatThread`:

```ts
/**
 * A time-travel pin (spec 2026-10-08, Data and storage): the period a thread is
 * about. Only a Day pin carries a place; its coordinates never reach the model.
 */
export interface ChatThreadAsOf {
  readonly start: string;
  readonly end: string;
  readonly granularity: 'day' | 'month' | 'year';
  readonly place?: {
    readonly label: string;
    readonly timezone: string;
    readonly latitude: number;
    readonly longitude: number;
  };
}
```

and in `ChatThread`, after `message_count: number;`:

```ts
  /** Set only on a time-travel thread: the period its answers are about. */
  as_of?: ChatThreadAsOf;
```

In `frontend/packages/llm/src/period.ts` change `function isCalendarDay(` to `export function isCalendarDay(`, and add `isCalendarDay,` to the `./period` export block in `frontend/packages/llm/src/index.ts`.

`frontend/packages/store/src/chatAsOf.ts`:

```ts
/**
 * The one shape check for a time-travel pin (plan Ruling 7). Migration uses it
 * to drop a malformed pin and keep the thread; portable import uses it to
 * refuse the backup and name the field.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { isCalendarDay } from '@almamesh/llm';

const AS_OF_KEYS = new Set(['start', 'end', 'granularity', 'place']);
const PLACE_KEYS = new Set(['label', 'timezone', 'latitude', 'longitude']);
const GRANULARITIES: readonly string[] = ['day', 'month', 'year'];
const FIRST_YEAR = 1900;
const LAST_YEAR = 2099;
const MAX_LABEL = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isZone(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function inRange(value: unknown, limit: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

function placeProblem(place: unknown): string | undefined {
  if (!isRecord(place) || !onlyKeys(place, PLACE_KEYS)) return 'as_of.place';
  const { label, timezone, latitude, longitude } = place;
  if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL) return 'as_of.place.label';
  if (!isZone(timezone)) return 'as_of.place.timezone';
  if (!inRange(latitude, 90)) return 'as_of.place.latitude';
  return inRange(longitude, 180) ? undefined : 'as_of.place.longitude';
}

function startFits(start: string, granularity: string): boolean {
  if (granularity === 'month') return start.endsWith('-01');
  return granularity === 'year' ? start.endsWith('-01-01') : true;
}

/** The last day the granularity allows for this start (UTC calendar arithmetic only). */
function endFor(start: string, granularity: string): string {
  if (granularity === 'day') return start;
  const year = Number(start.slice(0, 4));
  if (granularity === 'year') return `${year}-12-31`;
  const month = Number(start.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function startProblem(start: unknown): string | undefined {
  if (typeof start !== 'string' || !isCalendarDay(start)) return 'as_of.start';
  const year = Number(start.slice(0, 4));
  return year < FIRST_YEAR || year > LAST_YEAR ? 'as_of.start' : undefined;
}

export function chatAsOfProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !onlyKeys(value, AS_OF_KEYS)) return 'as_of';
  const { start, end, granularity, place } = value;
  const badStart = startProblem(start);
  if (badStart) return badStart;
  if (typeof granularity !== 'string' || !GRANULARITIES.includes(granularity)) return 'as_of.granularity';
  if (!startFits(start as string, granularity)) return 'as_of.start';
  if (end !== endFor(start as string, granularity)) return 'as_of.end';
  if (granularity === 'day') return place === undefined ? 'as_of.place' : placeProblem(place);
  return place === undefined ? undefined : 'as_of.place';
}

export function isChatThreadAsOf(value: unknown): value is ChatThreadAsOf {
  return chatAsOfProblem(value) === undefined;
}
```

`chatAsOfProblem` is 11 lines. Add to `frontend/packages/store/src/index.ts`: `export { chatAsOfProblem, isChatThreadAsOf } from './chatAsOf';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend/packages/store && bunx vitest run src/chatAsOf.test.ts`
Expected: PASS (29 cases).

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/store/src/chatAsOf.ts "if (!isRecord(value) || !onlyKeys(value, AS_OF_KEYS)) return 'as_of';" "if (!isRecord(value)) return 'as_of';" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chatAsOf.test.ts'
python3 "$MUTATE" frontend/packages/store/src/chatAsOf.ts "if (!inRange(latitude, 90)) return 'as_of.place.latitude';" "" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chatAsOf.test.ts'
python3 "$MUTATE" frontend/packages/store/src/chatAsOf.ts "if (end !== endFor(start as string, granularity)) return 'as_of.end';" "" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chatAsOf.test.ts'
python3 "$MUTATE" frontend/packages/store/src/chatAsOf.ts "return place === undefined ? undefined : 'as_of.place';" "return undefined;" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chatAsOf.test.ts'
```
Expected: four `KILLED` lines (extra key, latitude 91, month ending early, Month pin with a place).

- [ ] **Step 6: Typecheck and commit**

Run: `cd frontend && bun run --filter '*' typecheck`. Expected: exit 0.

```bash
git add frontend/packages/shared-types/src/chat.ts frontend/packages/llm/src/period.ts frontend/packages/llm/src/index.ts frontend/packages/store/src/chatAsOf.ts frontend/packages/store/src/chatAsOf.test.ts frontend/packages/store/src/index.ts
git commit -m "feat(store): ChatThreadAsOf and one strict shape check for a time-travel pin"
```

---

### Task 2: Chat store v3: migration, `startThread`, `setThreadAsOf`

**Files:**
- Modify: `frontend/packages/store/src/chat.ts` (`CHAT_PERSIST_VERSION` 2 → 3 at line 30; `migrateChatPersistedState` at line 50; `ChatStore` interface; `makeThread`; two new actions)
- Test: `frontend/packages/store/src/chat.test.ts` (new `describe` blocks)

**Interfaces:**
- Consumes: `chatAsOfProblem`, `isChatThreadAsOf` (Task 1).
- Produces:
  - `CHAT_PERSIST_VERSION === 3`.
  - `ChatStore.startThread(profileId: string, chartId?: string, asOf?: ChatThreadAsOf): string`: always creates a new thread (unlike `ensureThread`), pinned when `asOf` is given; throws `Error('Invalid time-travel period: <field>')` for a malformed pin.
  - `ChatStore.setThreadAsOf(threadId: string, asOf: ChatThreadAsOf): void`: replaces the pin and bumps `updated_at`; throws for a malformed pin, a missing thread, or a thread that has no pin (`'Only a time-travel thread can change its period.'`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/packages/store/src/chat.test.ts` (it already has `newStore()` and imports `migrateChatPersistedState`; add `CHAT_PERSIST_VERSION` to that import):

```ts
const PIN_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const PIN_JUNE = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;

describe('chat store v3: time-travel pins', () => {
  it('is persisted as version 3', () => {
    expect(CHAT_PERSIST_VERSION).toBe(3);
  });

  it('migrates a v2 blob with its threads and messages intact (no as_of = a normal thread)', () => {
    const v2 = {
      threads: { t1: { id: 't1', profile_id: 'p1', title: 'Career', message_count: 1 } },
      messages: { t1: [{ id: 'm1', thread_id: 't1', role: 'user', content: 'Hi' }] },
      summaries: {},
    };
    const out = migrateChatPersistedState(v2, 2);
    expect(out.threads.t1).toEqual(v2.threads.t1);
    expect(out.messages.t1).toEqual(v2.messages.t1);
  });

  it('keeps a valid pin and drops a malformed one, keeping that thread', () => {
    const out = migrateChatPersistedState(
      {
        threads: {
          good: { id: 'good', profile_id: 'p1', as_of: PIN_2027 },
          bad: { id: 'bad', profile_id: 'p1', title: 'Kept', as_of: { ...PIN_2027, granularity: 'week' } },
        },
        messages: { good: [], bad: [] },
        summaries: {},
      },
      2,
    );
    expect(out.threads.good?.as_of).toEqual(PIN_2027);
    expect(out.threads.bad).toEqual({ id: 'bad', profile_id: 'p1', title: 'Kept' });
  });

  it('startThread always opens a new thread, pinned when asked', () => {
    const store = newStore();
    const normal = store.getState().startThread('p1', 'c1');
    const pinned = store.getState().startThread('p1', 'c1', PIN_2027);
    expect(pinned).not.toBe(normal);
    expect(store.getState().threads[normal]?.as_of).toBeUndefined();
    expect(store.getState().threads[pinned]).toMatchObject({ profile_id: 'p1', chart_id: 'c1', as_of: PIN_2027, title: null });
    expect(store.getState().getActiveThread('p1')?.id).toBe(pinned);
  });

  it('startThread refuses a malformed pin and creates nothing', () => {
    const store = newStore();
    expect(() => store.getState().startThread('p1', undefined, { ...PIN_2027, end: '2027-12-30' })).toThrow(
      'Invalid time-travel period: as_of.end',
    );
    expect(store.getState().listThreads('p1')).toEqual([]);
  });

  it('setThreadAsOf changes a pin and keeps the messages', () => {
    const store = newStore();
    const id = store.getState().startThread('p1', undefined, PIN_2027);
    store.getState().appendMessage(id, 'user', 'Will work get easier?');
    store.getState().setThreadAsOf(id, PIN_JUNE);
    expect(store.getState().threads[id]?.as_of).toEqual(PIN_JUNE);
    expect(store.getState().getMessages(id)).toHaveLength(1);
  });

  it('setThreadAsOf refuses a malformed pin, a missing thread and a normal thread', () => {
    const store = newStore();
    const pinned = store.getState().startThread('p1', undefined, PIN_2027);
    const normal = store.getState().startThread('p1');
    expect(() => store.getState().setThreadAsOf(pinned, { ...PIN_JUNE, start: '2026-06-02' })).toThrow(
      'Invalid time-travel period: as_of.start',
    );
    expect(() => store.getState().setThreadAsOf('gone', PIN_JUNE)).toThrow('does not exist');
    expect(() => store.getState().setThreadAsOf(normal, PIN_JUNE)).toThrow(
      'Only a time-travel thread can change its period.',
    );
    expect(store.getState().threads[pinned]?.as_of).toEqual(PIN_2027);
  });

  it('a pin survives the serialize → fresh-store round trip', () => {
    const before = newStore();
    const id = before.getState().startThread('p1', 'c1', PIN_2027);
    const { threads, messages, summaries } = before.getState();
    const after = newStore();
    after.setState(JSON.parse(JSON.stringify({ threads, messages, summaries })) as Partial<ChatStore>);
    expect(after.getState().threads[id]?.as_of).toEqual(PIN_2027);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/packages/store && bunx vitest run src/chat.test.ts`
Expected: FAIL. "expected 2 to be 3"; "startThread is not a function"; the malformed-pin migration keeps `as_of`.

- [ ] **Step 3: Implement**

In `frontend/packages/store/src/chat.ts`:

1. `import type { ChatMessage, ChatThread, ChatThreadAsOf, ChatThreadSummary } from '@almamesh/shared-types';` and `import { chatAsOfProblem, isChatThreadAsOf } from './chatAsOf';`.
2. `export const CHAT_PERSIST_VERSION = 3;`
3. Above `migrateChatPersistedState`:

```ts
/** v3 (time travel): a thread whose pin is malformed keeps everything but the pin. */
function withoutMalformedPins(threads: PersistedChatState['threads']): PersistedChatState['threads'] {
  return Object.fromEntries(
    Object.entries(threads).map(([id, thread]) => {
      if (!isPlainRecord(thread) || !('as_of' in thread) || isChatThreadAsOf(thread.as_of)) return [id, thread];
      const { as_of: _malformed, ...kept } = thread as ChatThread;
      return [id, kept];
    }),
  ) as PersistedChatState['threads'];
}
```

   In `migrateChatPersistedState`, wrap the threads value: `const threads = withoutMalformedPins(isPlainRecord(source.threads) ? (source.threads as PersistedChatState['threads']) : {});`.
4. In the `ChatStore` interface, after `ensureThread`:

```ts
  /** Open a NEW thread (never reuses one); pinned to a period when `asOf` is given. */
  startThread: (profileId: string, chartId?: string, asOf?: ChatThreadAsOf) => string;
  /** Change a time-travel thread's period; its messages stay. */
  setThreadAsOf: (threadId: string, asOf: ChatThreadAsOf) => void;
```

5. Add a guard and extend `makeThread`:

```ts
function assertPin(asOf: ChatThreadAsOf): void {
  const problem = chatAsOfProblem(asOf);
  if (problem) throw new Error(`Invalid time-travel period: ${problem}`);
}

/** A fresh, empty thread owned by a profile; `as_of` stays the last key. */
function makeThread(profileId: string, chartId?: string, asOf?: ChatThreadAsOf): ChatThread {
  const now = new Date().toISOString();
  return {
    id: nextId('thread'),
    profile_id: profileId,
    chart_id: chartId,
    title: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
    message_count: 0,
    ...(asOf ? { as_of: asOf } : {}),
  };
}
```

6. In `chatStoreCreator`, after `ensureThread`:

```ts
  startThread: (profileId, chartId, asOf) => {
    if (asOf) assertPin(asOf);
    const thread = makeThread(profileId, chartId, asOf);
    set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
    return thread.id;
  },

  setThreadAsOf: (threadId, asOf) => {
    assertPin(asOf);
    const thread = get().threads[threadId];
    if (!thread) throw new Error(`Cannot change the period: thread ${threadId} does not exist.`);
    if (!thread.as_of) throw new Error('Only a time-travel thread can change its period.');
    const next: ChatThread = { ...thread, as_of: asOf, updated_at: new Date().toISOString() };
    set((state) => ({ threads: { ...state.threads, [threadId]: next } }));
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/packages/store && bunx vitest run src/chat.test.ts`
Expected: PASS, including every existing test in the file.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/store/src/chat.ts "export const CHAT_PERSIST_VERSION = 3;" "export const CHAT_PERSIST_VERSION = 2;" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chat.test.ts'
python3 "$MUTATE" frontend/packages/store/src/chat.ts "if (!isPlainRecord(thread) || !('as_of' in thread) || isChatThreadAsOf(thread.as_of)) return [id, thread];" "return [id, thread];" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chat.test.ts'
python3 "$MUTATE" frontend/packages/store/src/chat.ts "    if (asOf) assertPin(asOf);
" "" -- bash -c 'cd frontend/packages/store && bunx vitest run src/chat.test.ts'
```
Expected: three `KILLED` lines.

- [ ] **Step 6: Commit**

```bash
git add frontend/packages/store/src/chat.ts frontend/packages/store/src/chat.test.ts
git commit -m "feat(store): chat store v3 — time-travel pins on threads; malformed pins dropped on migration"
```

---

### Task 3: Portable import and export carry `as_of`

**Files:**
- Modify: `frontend/packages/store/src/portableState.ts` (`PORTABLE_STORE_MAX_VERSIONS['almamesh-chat-history']` 2 → 3 at line 109; the thread loop in `validateCanonicalDataset` at line 1021)
- Test: `frontend/packages/store/src/portableState.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `chatAsOfProblem` (Task 1), `CHAT_PERSIST_VERSION` (Task 2).
- Produces: export and import (`readPortableStateDatabase` and `PortableStateRepository.exportBytes`, both via `validateCanonicalDataset`) refuse a malformed pin with `Portable state row "almamesh-chat-history" thread "<id>" has an invalid <field>.`; a valid pin passes through byte for byte.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/packages/store/src/portableState.test.ts` (it already defines `MemorySqliteStore` and imports `PortableStateRepository`, `PortableStateTooNewError`, `PORTABLE_STORE_MAX_VERSIONS`, `migrateLegacyState`). Add `import { CHAT_PERSIST_VERSION } from './chat';` at the top.

```ts
describe('time-travel pins in a backup (chat store v3)', () => {
  const DAY_PIN = {
    start: '2026-06-15',
    end: '2026-06-15',
    granularity: 'day',
    place: { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 },
  };

  function envelope(state: unknown, version: number): string {
    return JSON.stringify({ state, version, datasetEpoch: 0 });
  }

  async function seedChat(thread: Record<string, unknown>, version = 3) {
    const sqlite = new MemorySqliteStore();
    const handed: Array<ReadonlyMap<string, string>> = [];
    const repository = new PortableStateRepository(
      sqlite,
      async (bytes) => bytes[0] ?? -1,
      async (canonical) => {
        handed.push(canonical);
        return new Uint8Array([sqlite.epoch]);
      },
    );
    await migrateLegacyState(repository, { get: async () => null, delete: async () => undefined }, []);
    await repository.write(
      'almamesh-profiles',
      envelope({ profiles: { p1: { id: 'p1' } }, activeProfileId: 'p1' }, 1),
    );
    await repository.write(
      'almamesh-chat-history',
      envelope({ threads: { t1: { id: 't1', profile_id: 'p1', ...thread } }, messages: { t1: [] }, summaries: {} }, version),
    );
    return { repository, handed };
  }

  it('reads chat store version 3 (the store and the importer agree)', () => {
    expect(PORTABLE_STORE_MAX_VERSIONS['almamesh-chat-history']).toBe(3);
    expect(CHAT_PERSIST_VERSION).toBe(3);
  });

  it('exports a Day pin with its place field for field', async () => {
    const { repository, handed } = await seedChat({ as_of: DAY_PIN });
    await repository.exportBytes();
    const chat = JSON.parse(handed.at(-1)!.get('almamesh-chat-history')!) as {
      state: { threads: Record<string, { as_of?: unknown }> };
    };
    expect(chat.state.threads.t1?.as_of).toEqual(DAY_PIN);
  });

  it('still accepts a v2 chat row with no pins', async () => {
    const { repository } = await seedChat({}, 2);
    await expect(repository.exportBytes()).resolves.toBeDefined();
  });

  it.each([
    ['latitude 91', { ...DAY_PIN, place: { ...DAY_PIN.place, latitude: 91 } }, 'as_of.place.latitude'],
    ['an extra key', { ...DAY_PIN, birth_place: 'Delhi' }, 'as_of'],
    ['granularity week', { ...DAY_PIN, granularity: 'week' }, 'as_of.granularity'],
    ['a Month pin with a place', { ...DAY_PIN, start: '2026-06-01', end: '2026-06-30', granularity: 'month' }, 'as_of.place'],
  ])('refuses a backup whose pin has %s, naming the row, thread and field', async (_label, asOf, field) => {
    const { repository } = await seedChat({ as_of: asOf });
    await expect(repository.exportBytes()).rejects.toThrow(
      `Portable state row "almamesh-chat-history" thread "t1" has an invalid ${field}.`,
    );
  });

  it('calls a v4 chat row too new', async () => {
    const { repository } = await seedChat({}, 4);
    await expect(repository.exportBytes()).rejects.toBeInstanceOf(PortableStateTooNewError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/packages/store && bunx vitest run src/portableState.test.ts -t "time-travel pins"`
Expected: FAIL. The version pin reads 2; the Day pin export rejects with `PortableStateTooNewError` (version 3 > 2); the malformed-pin cases also reject as "too new", not with the field message.

- [ ] **Step 3: Implement**

In `frontend/packages/store/src/portableState.ts`:
1. `import { chatAsOfProblem } from './chatAsOf';`
2. `'almamesh-chat-history': 3,` in `PORTABLE_STORE_MAX_VERSIONS`.
3. In the thread loop of `validateCanonicalDataset`, after the two `assertKnownReference(...)` lines:

```ts
      const pinProblem = thread.as_of === undefined ? undefined : chatAsOfProblem(thread.as_of);
      if (pinProblem) {
        throw new Error(`Portable state row "almamesh-chat-history" thread "${threadId}" has an invalid ${pinProblem}.`);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/packages/store && bunx vitest run src/portableState.test.ts src/backup.test.ts src/chat.test.ts`
Expected: PASS, every existing case included. (`apps/web/src/lib/backupService.test.ts` mocks a v3 chat row already; run it too: `cd frontend/apps/web && bunx vitest run src/lib/backupService.test.ts`, expected PASS.)

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/store/src/portableState.ts "      if (pinProblem) {" "      if (false && pinProblem) {" -- bash -c 'cd frontend/packages/store && bunx vitest run src/portableState.test.ts -t "time-travel pins"'
python3 "$MUTATE" frontend/packages/store/src/portableState.ts "'almamesh-chat-history': 3," "'almamesh-chat-history': 2," -- bash -c 'cd frontend/packages/store && bunx vitest run src/portableState.test.ts -t "time-travel pins"'
```
Expected: two `KILLED` lines.

- [ ] **Step 6: Commit**

```bash
git add frontend/packages/store/src/portableState.ts frontend/packages/store/src/portableState.test.ts
git commit -m "feat(store): backups carry chat v3 pins; a malformed pin refuses the import, naming the field"
```

---

### Task 4: Tense and the `PINNED PERIOD` prompt rule

**Files:**
- Create: `frontend/packages/llm/src/period-pin.ts`
- Modify: `frontend/packages/llm/src/prompt.ts` (`buildChatMessages` at line 506 gains a last parameter `pinned?: PinnedPrompt`)
- Modify: `frontend/packages/llm/src/index.ts` (export the new module)
- Test: `frontend/packages/llm/src/__tests__/period-pin.test.ts`, `frontend/packages/llm/src/__tests__/prompt-chat-context.test.ts` (new `describe`, reusing its real-shape `CHART`)

**Interfaces:**
- Consumes: `PeriodRange` (`sanitize.ts:229`).
- Produces:
  - `type PinRelative = 'past' | 'future' | 'contains_today'`.
  - `interface PinnedPrompt extends PeriodRange { readonly relative: PinRelative }`.
  - `pinRelative(period: PeriodRange, today: string): PinRelative` (`today` is a `YYYY-MM-DD` day).
  - `pinnedPeriodRules(pin: PinnedPrompt): string`.
  - `buildChatMessages(chart, question, mode, history, retrievedContext, interpretationText, language, meshEdge, rectification, budget, places, pinned?)`: with `pinned`, the system prompt ends with `pinnedPeriodRules(pinned)`; without it, byte-identical to today.

- [ ] **Step 1: Write the failing test**

`frontend/packages/llm/src/__tests__/period-pin.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { pinRelative, pinnedPeriodRules } from '../index';

const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31' };

describe('pinRelative', () => {
  it.each([
    ['2026-12-31', 'future'],
    ['2027-01-01', 'contains_today'],
    ['2027-06-15', 'contains_today'],
    ['2027-12-31', 'contains_today'],
    ['2028-01-01', 'past'],
  ] as const)('today %s is %s', (today, expected) => {
    expect(pinRelative(YEAR_2027, today)).toBe(expected);
  });

  it('a single-day pin contains only its own day', () => {
    const day = { start: '2026-06-15', end: '2026-06-15' };
    expect(pinRelative(day, '2026-06-14')).toBe('future');
    expect(pinRelative(day, '2026-06-15')).toBe('contains_today');
    expect(pinRelative(day, '2026-06-16')).toBe('past');
  });
});

describe('pinnedPeriodRules', () => {
  it.each([
    ['future', 'future tense'],
    ['past', 'past tense'],
    ['contains_today', 'present tense'],
  ] as const)('tells the model which tense to use when %s', (relative, tense) => {
    const rules = pinnedPeriodRules({ ...YEAR_2027, relative });
    expect(rules).toContain('PINNED PERIOD: this conversation is about 2027-01-01 to 2027-12-31');
    expect(rules).toContain('get_timing called without dates reads this period');
    expect(rules).toContain(tense);
    expect(rules).toContain('first and last day of the current month');
  });
});

```

Append to `frontend/packages/llm/src/__tests__/prompt-chat-context.test.ts` (it already defines a real-shape `CHART: SanitizedChart` and imports `buildChatMessages`):

```ts
const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31' };

describe('buildChatMessages with a pin', () => {
  it('adds the pinned rule to the system prompt only when a pin is given', () => {
    const plain = buildChatMessages(CHART, 'Will work get easier?');
    const pinned = buildChatMessages(
      CHART, 'Will work get easier?', 'layman', [], [], undefined, 'en', undefined, undefined, undefined, false,
      { ...YEAR_2027, relative: 'future' },
    );
    expect(plain[0]?.content).not.toContain('PINNED PERIOD');
    expect(pinned[0]?.content).toContain('PINNED PERIOD: this conversation is about 2027-01-01 to 2027-12-31');
    expect(pinned[0]?.content).toContain('future tense');
  });

  it('is byte-identical without a pin (snapshot-locked prompts stay put)', () => {
    const before = buildChatMessages(CHART, 'q', 'layman', [], [], undefined, 'en', undefined, undefined, undefined, false);
    const after = buildChatMessages(CHART, 'q', 'layman', [], [], undefined, 'en', undefined, undefined, undefined, false, undefined);
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-pin.test.ts src/__tests__/prompt-chat-context.test.ts`
Expected: FAIL, "pinRelative is not a function" (not exported), and the pinned prompt lacks `PINNED PERIOD`.

- [ ] **Step 3: Implement**

`frontend/packages/llm/src/period-pin.ts`:

```ts
// Time travel Inc D (spec 2026-10-08, Part 3): a thread pinned to a period.
// Pure calendar comparison on YYYY-MM-DD strings; no astrology lives here.
import type { PeriodRange } from "./sanitize";

export type PinRelative = "past" | "future" | "contains_today";

export interface PinnedPrompt extends PeriodRange {
  readonly relative: PinRelative;
}

/** Where today falls against the pin. Today on either edge is inside it. */
export function pinRelative(period: PeriodRange, today: string): PinRelative {
  if (today < period.start) return "future";
  if (today > period.end) return "past";
  return "contains_today";
}

const TENSE: Readonly<Record<PinRelative, string>> = {
  past: "Use the past tense: this period is over.",
  future: "Use the future tense: this period has not started yet.",
  contains_today: "Use the present tense: today is inside this period.",
};

export function pinnedPeriodRules(pin: PinnedPrompt): string {
  return [
    `PINNED PERIOD: this conversation is about ${pin.start} to ${pin.end} (relative: ${pin.relative}).`,
    "get_timing called without dates reads this period. Answer about it unless the user asks about another one.",
    TENSE[pin.relative],
    "To compare with now, call get_timing with the first and last day of the current month.",
  ].join("\n");
}
```

In `frontend/packages/llm/src/index.ts`: `export { pinRelative, pinnedPeriodRules, type PinRelative, type PinnedPrompt } from "./period-pin";`.

In `frontend/packages/llm/src/prompt.ts`: `import { pinnedPeriodRules, type PinnedPrompt } from "./period-pin";`; add the parameter after `places = false,`:

```ts
  pinned?: PinnedPrompt,
```

and replace the `const base = ...` line with:

```ts
  const withPlaces = places ? CHAT_SYSTEM_PROMPT + "\n\n" + PLACE_RULES : CHAT_SYSTEM_PROMPT;
  // Inc D: a pinned thread says which period and which tense (period-pin.ts).
  const base = pinned ? withPlaces + "\n\n" + pinnedPeriodRules(pinned) : withPlaces;
```

Document the new parameter in the function's doc comment: "The optional `pinned` is a time-travel thread's period and tense; when absent, the prompt is byte-identical to the unpinned path."

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/packages/llm && bunx vitest run src/__tests__/period-pin.test.ts && bunx vitest run`
Expected: PASS; the whole llm suite (prompt snapshots included) stays green.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/packages/llm/src/period-pin.ts 'if (today < period.start) return "future";' 'if (today <= period.start) return "future";' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-pin.test.ts'
python3 "$MUTATE" frontend/packages/llm/src/period-pin.ts 'if (today > period.end) return "past";' 'if (today >= period.end) return "past";' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/period-pin.test.ts'
python3 "$MUTATE" frontend/packages/llm/src/prompt.ts '  const base = pinned ? withPlaces + "\n\n" + pinnedPeriodRules(pinned) : withPlaces;' '  const base = withPlaces;' -- bash -c 'cd frontend/packages/llm && bunx vitest run src/__tests__/prompt-chat-context.test.ts'
```
Expected: three `KILLED` lines (the spec's "Use `<` for `<=`" mutation, both edges).

- [ ] **Step 6: Commit**

```bash
git add frontend/packages/llm/src/period-pin.ts frontend/packages/llm/src/prompt.ts frontend/packages/llm/src/index.ts frontend/packages/llm/src/__tests__/period-pin.test.ts frontend/packages/llm/src/__tests__/prompt-chat-context.test.ts
git commit -m "feat(llm): pinned period rule with tense by relative; pinRelative boundaries are inclusive"
```

---

### Task 5: `get_timing` defaults to the pin; `get_current_datetime` reports it

**Files:**
- Modify: `frontend/apps/web/src/lib/timingTool.ts` (`TimingToolInput.pinned`, `withPin`, `execute`, `statusLabelFor`)
- Modify: `frontend/apps/web/src/lib/chatAgentTools.ts` (`CreateChatAgentToolsInput.pinned`; `get_current_datetime`; pass `pinned` to `createTimingTool`)
- Test: `frontend/apps/web/src/lib/__tests__/timingTool.pinned.test.ts`, `frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `parseTimingArgs`, `type TimingArgs` (`@almamesh/llm`, step C); `pinRelative` (Task 4); fixtures `CHART`, `SKY_CHART` (`lib/__tests__/timingFixtures.ts`).
- Produces:
  - `interface PinnedTiming { readonly period: PeriodRange; readonly placeRef?: string }` exported from `timingTool.ts`.
  - `TimingToolInput.pinned?: PinnedTiming` and `CreateChatAgentToolsInput.pinned?: PinnedTiming`.
  - `withPin(pinned: PinnedTiming | undefined, parsed: TimingArgs): TimingArgs` (exported for tests): no dates → the pinned period (with the pin's place ref); a call for exactly the pinned period with no place → gains the pin's place ref; anything else unchanged.
  - `get_current_datetime` result in a pinned thread: `{ scope, isoUtc, localDate, localTime, utcOffset, timeZone, pinned_period: { start, end }, relative }`; unpinned: unchanged (no `pinned_period`, no `relative` keys).

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/lib/__tests__/timingTool.pinned.test.ts`:

```ts
import { NEEDS_PLACE_ERROR } from '@almamesh/llm';
import { describe, expect, it, vi } from 'vitest';

import { DASHAS_STATUS_LABEL, createTimingTool, withPin, type PinnedTiming } from '../timingTool';
import { CHART, SKY_CHART } from './timingFixtures';

const NOW = new Date('2026-03-08T09:30:00.000Z');
const context = () => ({ now: NOW, signal: new AbortController().signal });
const YEAR_PIN: PinnedTiming = { period: { start: '2027-01-01', end: '2027-12-31' } };
const DAY_PIN: PinnedTiming = { period: { start: '2026-06-15', end: '2026-06-15' }, placeRef: 'pinned' };
const PINNED_BOGOTA = {
  summary: { place_ref: 'pinned', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};

function tool(pinned: PinnedTiming | undefined, overrides: Partial<Parameters<typeof createTimingTool>[0]> = {}) {
  return createTimingTool({
    chart: CHART,
    birthYear: 1990,
    todayDay: () => '2026-03-08',
    loadPeriodChart: vi.fn(async () => SKY_CHART),
    periodSkyAllowed: true,
    placeFromRef: vi.fn(async (ref: string) => (ref === 'pinned' ? PINNED_BOGOTA : undefined)),
    pinned,
    ...overrides,
  });
}

describe('withPin', () => {
  it('turns "no dates" into the pinned period', () => {
    expect(withPin(YEAR_PIN, { kind: 'today' })).toEqual({ kind: 'period', period: YEAR_PIN.period });
    expect(withPin(DAY_PIN, { kind: 'today' })).toEqual({ kind: 'period', period: DAY_PIN.period, placeRef: 'pinned' });
  });

  it('lends the pin place only to a call for exactly the pinned day with no place of its own', () => {
    const same = { kind: 'period', period: DAY_PIN.period } as const;
    const other = { kind: 'period', period: { start: '2026-06-16', end: '2026-06-16' } } as const;
    const placed = { kind: 'period', period: DAY_PIN.period, placeRef: 'city:202' } as const;
    expect(withPin(DAY_PIN, same)).toEqual({ ...same, placeRef: 'pinned' });
    expect(withPin(DAY_PIN, other)).toEqual(other);
    expect(withPin(DAY_PIN, placed)).toEqual(placed);
  });

  it('leaves everything alone in an unpinned thread', () => {
    expect(withPin(undefined, { kind: 'today' })).toEqual({ kind: 'today' });
  });
});

describe('get_timing in a pinned thread', () => {
  it('reads the pinned period when called without dates, never today', async () => {
    const loadPeriodChart = vi.fn(async () => SKY_CHART);
    const loadCurrentChart = vi.fn();
    const result = (await tool(YEAR_PIN, { loadPeriodChart, loadCurrentChart }).execute({ section: 'transits' }, context())) as {
      period: unknown;
    };
    expect(result.period).toEqual({ start: '2027-01-01', end: '2027-12-31', days: 365, basis: 'period' });
    expect(loadPeriodChart).toHaveBeenCalledWith(YEAR_PIN.period, expect.anything());
    expect(loadCurrentChart).not.toHaveBeenCalled();
  });

  it('still honours other dates the model sends to compare', async () => {
    const result = (await tool(YEAR_PIN).execute({ section: 'dashas', start: '2026-06-01', end: '2026-06-30' }, context())) as {
      period: { start: string };
    };
    expect(result.period.start).toBe('2026-06-01');
  });

  it('a Day pin reads its own place: no needs_place, label and zone only, no coordinates', async () => {
    const result = await tool(DAY_PIN).execute({ section: 'transits' }, context());
    expect(result).not.toEqual({ error: NEEDS_PLACE_ERROR });
    const text = JSON.stringify(result);
    expect(text).toContain('"label":"Bogotá, Colombia"');
    expect(text).not.toMatch(/4\.711|74\.07|latitude|longitude/);
  });

  it('a different single day in a Day-pinned thread still needs a place', async () => {
    const result = await tool(DAY_PIN).execute({ section: 'transits', start: '2026-07-03' }, context());
    expect(result).toEqual({ error: NEEDS_PLACE_ERROR });
  });

  it('says "reading dasha periods", not "working out the sky", on a weak device', () => {
    expect(tool(YEAR_PIN, { periodSkyAllowed: false }).statusLabelFor?.({ section: 'transits' })).toBe(DASHAS_STATUS_LABEL);
    expect(tool(undefined, { periodSkyAllowed: false }).statusLabelFor?.({ section: 'transits' })).toBeUndefined();
  });
});
```

Append to `frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts` (it already imports `createChatAgentTools`; reuse its chart fixture, named `CHART` there, or `timingFixtures`' `CHART`):

```ts
describe('get_current_datetime in a pinned thread', () => {
  const NOW = new Date('2026-03-08T20:00:00.000Z');
  function datetime(pinned?: { period: { start: string; end: string } }) {
    const tools = createChatAgentTools({
      chart: CHART,
      chartAsOf: { basis: 'chart', instant: new Date('2025-01-01T00:00:00Z') },
      chartTimeZone: 'Asia/Kolkata',
      todayDay: () => '2026-03-08',
      periodSkyAllowed: false,
      pinned,
    });
    const tool = tools.find((candidate) => candidate.name === 'get_current_datetime');
    return tool!.execute({ scope: 'chart' }, { now: NOW, signal: new AbortController().signal }) as Record<string, unknown>;
  }

  it('returns the real now plus the pinned period and where today falls', () => {
    const result = datetime({ period: { start: '2027-01-01', end: '2027-12-31' } });
    expect(result.isoUtc).toBe('2026-03-08T20:00:00.000Z');
    expect(result.pinned_period).toEqual({ start: '2027-01-01', end: '2027-12-31' });
    expect(result.relative).toBe('future');
  });

  it('is "contains_today" when today is the pin\'s first or last day, "past" after it', () => {
    expect(datetime({ period: { start: '2026-03-08', end: '2026-03-31' } }).relative).toBe('contains_today');
    expect(datetime({ period: { start: '2026-03-01', end: '2026-03-08' } }).relative).toBe('contains_today');
    expect(datetime({ period: { start: '2026-02-01', end: '2026-02-28' } }).relative).toBe('past');
  });

  it('adds nothing in an unpinned thread', () => {
    const result = datetime();
    expect(result).not.toHaveProperty('pinned_period');
    expect(result).not.toHaveProperty('relative');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.pinned.test.ts src/lib/__tests__/chatAgentTools.test.ts`
Expected: FAIL. "withPin is not a function"; the no-dates call echoes today (`2026-03-08`, basis `today`); `pinned_period` is missing.

- [ ] **Step 3: Implement**

In `frontend/apps/web/src/lib/timingTool.ts`, add `type TimingArgs` to the `@almamesh/llm` import, then:

```ts
/** A pinned thread's period (spec Part 3) and, for a Day pin, the reserved ref of its place. */
export interface PinnedTiming {
  readonly period: PeriodRange;
  readonly placeRef?: string;
}
```

In `TimingToolInput`, add:

```ts
  /** A time-travel thread's pin: no dates read it, and the pinned day uses its place. */
  readonly pinned?: PinnedTiming;
```

Above `createTimingTool`:

```ts
function samePeriod(a: PeriodRange, b: PeriodRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Plan Ruling 3 and 9: in a pinned thread no dates mean the pin, and the pinned day keeps its place. */
export function withPin(pinned: PinnedTiming | undefined, parsed: TimingArgs): TimingArgs {
  if (!pinned || parsed.kind === 'invalid') return parsed;
  const place = pinned.placeRef ? { placeRef: pinned.placeRef } : {};
  if (parsed.kind === 'today') return { kind: 'period', period: pinned.period, ...place };
  const unplaced = !parsed.placeRef && !parsed.segments;
  return unplaced && samePeriod(parsed.period, pinned.period) ? { ...parsed, ...place } : parsed;
}
```

In `statusLabelFor` and in `execute`, replace `const parsed = parseTimingArgs(args);` with `const parsed = withPin(input.pinned, parseTimingArgs(args));` (two places).

In `frontend/apps/web/src/lib/chatAgentTools.ts`: `import { pinRelative } from '@almamesh/llm';` (add to the existing `@almamesh/llm` import), `import { createTimingTool, type PinnedTiming } from './timingTool';`. In `CreateChatAgentToolsInput` add:

```ts
  /** A time-travel thread's pin (chatToolset.ts builds it from the thread's as_of). */
  readonly pinned?: PinnedTiming;
```

Replace the `get_current_datetime` `execute` with:

```ts
      execute: (args, context) => {
        const scope = enumArgument(args, 'scope', ['chart', 'utc']);
        const zone = scope === 'chart' ? input.chartTimeZone : 'UTC';
        const now = { scope, ...currentDateTimeForZone(context.now, zone) };
        if (!input.pinned) return now;
        // Plan Ruling 2: the viewer's day, the same "today" get_timing reads.
        const today = (input.todayDay ?? viewerTodayDay)(context.now);
        const { start, end } = input.pinned.period;
        return { ...now, pinned_period: { start, end }, relative: pinRelative(input.pinned.period, today) };
      },
```

and add `pinned: input.pinned,` to the `createTimingTool({ ... })` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.pinned.test.ts src/lib/__tests__/chatAgentTools.test.ts src/lib/__tests__/timingTool.test.ts src/lib/__tests__/timingTool.places.test.ts`
Expected: PASS, the step A–C timing suites unchanged.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/timingTool.ts "  if (parsed.kind === 'today') return { kind: 'period', period: pinned.period, ...place };
" "" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.pinned.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/timingTool.ts "  return unplaced && samePeriod(parsed.period, pinned.period) ? { ...parsed, ...place } : parsed;" "  return unplaced ? { ...parsed, ...place } : parsed;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/timingTool.pinned.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/chatAgentTools.ts "        if (!input.pinned) return now;" "        return now;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatAgentTools.test.ts'
```
Expected: three `KILLED` lines (the spec's "Default `start` to today" mutation, the place lent to every day, the date tool without the pin).

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/lib/timingTool.ts frontend/apps/web/src/lib/chatAgentTools.ts frontend/apps/web/src/lib/__tests__/timingTool.pinned.test.ts frontend/apps/web/src/lib/__tests__/chatAgentTools.test.ts
git commit -m "feat(web): get_timing defaults to the pinned period; date tool reports pinned_period and relative"
```

---

### Task 6: The toolset takes the pin; the router warms the pin, never today

**Files:**
- Create: `frontend/apps/web/src/lib/pinnedPeriod.ts`
- Modify: `frontend/apps/web/src/lib/chatToolset.ts` (`BuildChatToolsetInput.pinned`, `PrepareOptions.pinnedStatus`, `PreparedChatContext.pinned`, the place reader, `prepare`)
- Test: `frontend/apps/web/src/lib/__tests__/pinnedPeriod.test.ts`, `frontend/apps/web/src/lib/__tests__/chatToolset.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `PinnedTiming` (Task 5); `PlaceReader` (`timingPlaces.ts`), `placeFromRef` (`geo/placeLookup.ts`); `periodAnalysisInstant`, `pinRelative`, `type PinnedPrompt` (`@almamesh/llm`); `viewerTodayDay` (`chatAgentTools.ts`).
- Produces (`pinnedPeriod.ts`):
  - `PINNED_PLACE_REF = 'pinned'`.
  - `pinnedTiming(asOf: ChatThreadAsOf): PinnedTiming`.
  - `pinnedPlaceReader(asOf: ChatThreadAsOf, base: PlaceReader): PlaceReader`.
  - `asOfKey(asOf: ChatThreadAsOf | undefined): string` (`'today'` when unpinned).
- Produces (`chatToolset.ts`):
  - `BuildChatToolsetInput.pinned?: ChatThreadAsOf`.
  - `PrepareOptions.pinnedStatus?: string` (already localized by the page).
  - `PreparedChatContext.pinned?: PinnedPrompt` (set only for a pinned thread).

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/lib/__tests__/pinnedPeriod.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { PINNED_PLACE_REF, asOfKey, pinnedPlaceReader, pinnedTiming } from '../pinnedPeriod';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
const DAY = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

describe('pinnedPeriod', () => {
  it('maps a pin to the timing tool\'s period, with the reserved ref only for a placed Day pin', () => {
    expect(pinnedTiming(YEAR)).toEqual({ period: { start: '2027-01-01', end: '2027-12-31' } });
    expect(pinnedTiming(DAY)).toEqual({ period: { start: '2026-06-15', end: '2026-06-15' }, placeRef: PINNED_PLACE_REF });
  });

  it('the reserved ref can never be sent by the model (step C ref pattern)', () => {
    expect(new RegExp('^city:\\d{1,6}$').test(PINNED_PLACE_REF)).toBe(false);
  });

  it('resolves the reserved ref from the pin and every other ref from the city list', async () => {
    const base = vi.fn(async () => undefined);
    const read = pinnedPlaceReader(DAY, base);
    expect(await read(PINNED_PLACE_REF)).toEqual({
      summary: { place_ref: PINNED_PLACE_REF, label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
      latitude: 4.711,
      longitude: -74.0721,
    });
    await read('city:202');
    expect(base).toHaveBeenCalledWith('city:202');
    expect(pinnedPlaceReader(YEAR, base)).toBe(base);
  });

  it('keys a pin by its period and place, and an unpinned thread as today', () => {
    expect(asOfKey(undefined)).toBe('today');
    expect(asOfKey(YEAR)).not.toBe(asOfKey({ ...YEAR, start: '2028-01-01', end: '2028-12-31' }));
    expect(asOfKey(DAY)).not.toBe(asOfKey({ ...DAY, place: { ...BOGOTA, latitude: 4.6 } }));
  });
});
```

Append to `frontend/apps/web/src/lib/__tests__/chatToolset.test.ts` (it already has `toolset()`, `options()`, `loadMock`, `ensureMock`, `engineContext()`, `SPLIT_DAY_NOW`):

```ts
describe('a pinned thread', () => {
  const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
  const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };
  const DAY_PIN = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;

  beforeEach(() => {
    loadMock.mockReset();
    ensureMock.mockReset();
    loadMock.mockResolvedValue(CHART);
  });

  it('warms the pinned period before the model runs, and never today, whatever the question', async () => {
    const pinned = toolset({ pinned: YEAR_2027, periodSkyAllowed: true });
    await pinned.prepare("what's happening today?", options());
    expect(ensureMock).not.toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadMock.mock.calls[0])).toContain('2027-01-01');
  });

  it('labels the prompt with the period and hands back the pin with its tense (viewer day)', async () => {
    const prepared = await toolset({ pinned: YEAR_2027, periodSkyAllowed: true }).prepare('Will work get easier?', options());
    expect(prepared.asOf).toMatchObject({ basis: 'period', period: { start: '2027-01-01', end: '2027-12-31' } });
    expect(prepared.pinned).toEqual({ start: '2027-01-01', end: '2027-12-31', relative: 'future' });
    expect(prepared.currentContextUnavailable).toBe(false);
  });

  it('shows the page\'s localized status only when the engine will run', async () => {
    const full = vi.fn();
    await toolset({ pinned: YEAR_2027, periodSkyAllowed: true }).prepare('q', {
      ...options(), onStatus: full, pinnedStatus: 'Working out the sky for 2027… (about 30 s)',
    });
    expect(full).toHaveBeenCalledWith('Working out the sky for 2027… (about 30 s)');
    const lite = vi.fn();
    await toolset({ pinned: YEAR_2027, periodSkyAllowed: false }).prepare('q', {
      ...options(), onStatus: lite, pinnedStatus: 'Working out the sky for 2027… (about 30 s)',
    });
    expect(lite).toHaveBeenCalledWith('Reading dasha periods');
  });

  it('a lite device answers a Day pin with dashas only and reads no place', async () => {
    const placeFromRef = vi.fn();
    const pinned = toolset({ pinned: DAY_PIN, periodSkyAllowed: false, placeFromRef });
    await pinned.prepare('q', options());
    const timing = pinned.tools.find((tool) => tool.name === 'get_timing')!;
    const result = (await timing.execute({ section: 'transits' }, options())) as { shown: string };
    expect(result.shown).toBe('dashas');
    expect(loadMock).not.toHaveBeenCalled();
    expect(placeFromRef).not.toHaveBeenCalled();
  });

  it('a full device reads a Day pin at its place and sends no coordinate anywhere', async () => {
    // The Moon read fails fast here, so the 8 s Moon deadline never runs in a unit test.
    const engine = engineContextWith({ computeMoonWindow: vi.fn(async () => Promise.reject(new Error('no moon in tests'))) });
    const pinned = toolset({ pinned: DAY_PIN, periodSkyAllowed: true, placeFromRef: vi.fn(async () => undefined), engine });
    const timing = pinned.tools.find((tool) => tool.name === 'get_timing')!;
    const datetime = pinned.tools.find((tool) => tool.name === 'get_current_datetime')!;
    const results = [
      await timing.execute({ section: 'transits' }, options()),
      await datetime.execute({ scope: 'utc' }, options()),
      await pinned.prepare('q', options()),
    ];
    const text = JSON.stringify(results);
    expect(text).toContain('Bogotá, Colombia');
    expect(text).not.toMatch(/4\.711|74\.07|"latitude"|"longitude"/);
  });

  it('an unpinned thread keeps the step A router (today pre-run for a today question)', async () => {
    ensureMock.mockResolvedValue(TODAY_CHART);
    const prepared = await toolset({ periodSkyAllowed: true }).prepare("what's happening today?", options());
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(prepared.pinned).toBeUndefined();
  });
});
```

(If `beforeEach`/`vi` are not yet imported in that file, they are: it imports `afterEach, beforeEach, describe, expect, it, vi` from vitest.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/pinnedPeriod.test.ts src/lib/__tests__/chatToolset.test.ts`
Expected: FAIL. "Failed to resolve import '../pinnedPeriod'"; `pinned` is not an input of `buildChatToolset` (a today question pre-runs today; `prepared.pinned` is undefined).

- [ ] **Step 3: Implement**

`frontend/apps/web/src/lib/pinnedPeriod.ts`:

```ts
/**
 * A time-travel thread's pin, as the chat tools see it (spec Part 3; plan
 * Rulings 3, 4 and 9). The pinned place travels under a reserved ref the model
 * cannot send (step C refs match ^city:\d{1,6}$); its coordinates stay here.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import type { ResolvedPlace } from './geo/placeLookup';
import type { PlaceReader } from './timingPlaces';
import type { PinnedTiming } from './timingTool';

export const PINNED_PLACE_REF = 'pinned';

export function pinnedTiming(asOf: ChatThreadAsOf): PinnedTiming {
  const period = { start: asOf.start, end: asOf.end };
  return asOf.place ? { period, placeRef: PINNED_PLACE_REF } : { period };
}

export function pinnedPlaceReader(asOf: ChatThreadAsOf, base: PlaceReader): PlaceReader {
  const place = asOf.place;
  if (!place) return base;
  const pinned: ResolvedPlace = {
    summary: { place_ref: PINNED_PLACE_REF, label: place.label, timezone: place.timezone },
    latitude: place.latitude,
    longitude: place.longitude,
  };
  return async (ref) => (ref === PINNED_PLACE_REF ? pinned : base(ref));
}

/** What a pinned answer is about, as a comparable string; 'today' when unpinned. */
export function asOfKey(asOf: ChatThreadAsOf | undefined): string {
  if (!asOf) return 'today';
  const place = asOf.place ? `${asOf.place.timezone}@${asOf.place.latitude},${asOf.place.longitude}` : '';
  return `${asOf.granularity}:${asOf.start}..${asOf.end}:${place}`;
}
```

In `frontend/apps/web/src/lib/chatToolset.ts`:
1. Imports: add `periodAnalysisInstant, pinRelative, type PinnedPrompt` to the `@almamesh/llm` import; `import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';`; `import { pinnedPlaceReader, pinnedTiming } from './pinnedPeriod';`.
2. `BuildChatToolsetInput` gains:

```ts
  /** A time-travel thread's pin: tools default to it and the router warms it (spec Part 3). */
  readonly pinned?: ChatThreadAsOf;
```

3. `PrepareOptions` gains `readonly pinnedStatus?: string;` with the comment "Localized 'Working out the sky for <period>…' shown when the pinned pre-run computes."
4. `PreparedChatContext` gains `readonly pinned?: PinnedPrompt;`.
5. After `preRunToday`:

```ts
/** Warm the pinned period's sky (plan Ruling 8). Failures are the model's to see through get_timing. */
async function preRunPin(tools: readonly AgentTool[], options: PrepareOptions): Promise<void> {
  const timing = tools.find((tool) => tool.name === TIMING_TOOL_NAME);
  if (!timing) throw new Error('The timing tool is unavailable.');
  const args = { section: 'transits' };
  // A fixed tool label (dashas only, needs a place) wins: the engine will not run.
  options.onStatus?.(timing.statusLabelFor?.(args) ?? options.pinnedStatus ?? timing.statusLabel ?? TODAY_STATUS_FALLBACK);
  try {
    await timing.execute(args, { now: new Date(options.now.getTime()), signal: options.signal });
  } catch (error) {
    if (options.signal.aborted) throw error;
  }
}
```

6. In `buildChatToolset`, before `createChatAgentTools`:

```ts
  const pinned = input.pinned;
  const baseReader = input.placeFromRef ?? placeFromRef;
  const reader = pinned ? pinnedPlaceReader(pinned, baseReader) : baseReader;
```

   In the `createChatAgentTools({ ... })` call add `...(pinned ? { pinned: pinnedTiming(pinned) } : {}),` and change the full-tier spread to `{ loadMoonWindow: createMoonWindowLoader(input.engine), placeFromRef: reader }`.
7. Replace the body of `prepare` with:

```ts
    async prepare(question, options) {
      if (pinned) {
        // A pinned thread never pre-runs today (spec router table: "Pinned | Anything | The pinned period").
        await preRunPin(tools, options);
        const period = { start: pinned.start, end: pinned.end };
        const relative = pinRelative(period, viewerTodayDay(options.now, zone()));
        return {
          chart: natalPrompt,
          asOf: periodAnalysisInstant(pinned.start, pinned.end),
          currentContextUnavailable: false,
          pinned: { ...period, relative },
        };
      }
      // A small deterministic router: an undated today-question gets exact-day
      // engine facts before the model runs; a dated one is left to get_timing.
      const needsToday = shouldPreRunToday(question);
      const currentContextUnavailable = needsToday && !(await preRunToday(tools, options));
      return {
        chart: todayChart ?? natalPrompt,
        asOf: todayChart ? todayAnalysisInstant(options.now) : input.chartAsOf,
        currentContextUnavailable,
      };
    },
```

   `viewerTodayDay` is already exported from `chatAgentTools.ts`; add it to the existing import from `./chatAgentTools`. If `prepare` grows past 15 lines, extract the pinned branch into `async function preparePinned(...)` in the same file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/pinnedPeriod.test.ts src/lib/__tests__/chatToolset.test.ts src/lib/__tests__/chatToolsetWiring.test.ts`
Expected: PASS, the step A–C toolset tests unchanged.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/lib/chatToolset.ts "      if (pinned) {
        // A pinned thread never pre-runs today" "      if (false && pinned) {
        // A pinned thread never pre-runs today" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/pinnedPeriod.ts "  return async (ref) => (ref === PINNED_PLACE_REF ? pinned : base(ref));" "  return base;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts src/lib/__tests__/pinnedPeriod.test.ts'
python3 "$MUTATE" frontend/apps/web/src/lib/pinnedPeriod.ts "    summary: { place_ref: PINNED_PLACE_REF, label: place.label, timezone: place.timezone }," "    summary: { place_ref: PINNED_PLACE_REF, label: place.label, timezone: place.timezone, latitude: place.latitude } as never," -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts'
```
Expected: three `KILLED` lines (the spec's "Pinned router: Pre-run today" mutation; the pinned place unknown; a coordinate leaking into the summary).

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/lib/pinnedPeriod.ts frontend/apps/web/src/lib/chatToolset.ts frontend/apps/web/src/lib/__tests__/pinnedPeriod.test.ts frontend/apps/web/src/lib/__tests__/chatToolset.test.ts
git commit -m "feat(web): chat toolset takes a pin — warms the pinned sky, never today; pinned place by reserved ref"
```

---

### Task 7: `useChatThread` carries the pin, guards stale answers, and saves pin changes

**Files:**
- Create: `frontend/apps/web/src/lib/timeTravelThreads.ts`
- Modify: `frontend/apps/web/src/hooks/useChatThread.ts` (`ChatStreamInput.asOf`; `answerIdentity`; `submit`; `UseChatThreadResult` gains `asOf`, `pin`, `repin`, `backToToday`)
- Modify: `frontend/apps/web/src/locales/{en,es,pt}/chat.json` (`errors.pin_changed`)
- Test: `frontend/apps/web/src/lib/__tests__/timeTravelThreads.test.ts`, `frontend/apps/web/src/hooks/__tests__/useChatThread.timeTravel.test.tsx`

**Interfaces:**
- Consumes: `startThread`, `setThreadAsOf` (Task 2); `asOfKey` (Task 6); `waitForStoreSaved('chat')`.
- Produces:
  - `startPinnedThread(profileId: string, chartId: string | null, asOf: ChatThreadAsOf): Promise<string>`; `repinThread(threadId: string, asOf: ChatThreadAsOf): Promise<void>`; `todayThread(profileId: string, chartId: string | null): Promise<string>`. Each rolls back and rethrows the `StoreSaveError` when the save fails.
  - `ChatStreamInput.asOf?: ChatThreadAsOf` (present only for a pinned thread).
  - `answerIdentity(chartId: string | null, asOf: ChatThreadAsOf | undefined): string | null` (exported for tests).
  - `UseChatThreadResult.asOf: ChatThreadAsOf | undefined`, `pin(asOf): Promise<void>`, `repin(asOf): Promise<void>`, `backToToday(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/lib/__tests__/timeTravelThreads.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@almamesh/store';

const save = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock('../storeSaved', () => ({
  waitForStoreSaved: async (store: string) => {
    if (store !== 'chat') throw new Error(`unexpected store ${store}`);
    save.calls += 1;
    if (save.fail) throw Object.assign(new Error('Saving chat failed.'), { name: 'StoreSaveError' });
  },
}));

import { repinThread, startPinnedThread, todayThread } from '../timeTravelThreads';

const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const JUNE = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;

beforeEach(() => {
  save.calls = 0;
  save.fail = false;
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
});
afterEach(() => useChatStore.setState({ threads: {}, messages: {}, summaries: {} }));

describe('pin changes reach disk before the UI moves on', () => {
  it('Go creates a pinned thread and waits for the chat row to save', async () => {
    const id = await startPinnedThread('p1', 'c1', YEAR);
    expect(save.calls).toBe(1);
    expect(useChatStore.getState().threads[id]?.as_of).toEqual(YEAR);
  });

  it('a failed save removes the new thread and rejects', async () => {
    save.fail = true;
    await expect(startPinnedThread('p1', 'c1', YEAR)).rejects.toThrow('Saving chat failed.');
    expect(useChatStore.getState().listThreads('p1')).toEqual([]);
  });

  it('Change saves the new pin, and a failed save puts the old one back', async () => {
    const id = useChatStore.getState().startThread('p1', undefined, YEAR);
    await repinThread(id, JUNE);
    expect(useChatStore.getState().threads[id]?.as_of).toEqual(JUNE);
    save.fail = true;
    await expect(repinThread(id, YEAR)).rejects.toThrow('Saving chat failed.');
    expect(useChatStore.getState().threads[id]?.as_of).toEqual(JUNE);
  });

  it('Back to today opens the latest normal thread without writing anything', async () => {
    const normal = useChatStore.getState().startThread('p1');
    useChatStore.getState().startThread('p1', undefined, YEAR);
    expect(await todayThread('p1', null)).toBe(normal);
    expect(save.calls).toBe(0);
  });

  it('Back to today with no normal thread creates one and saves it first', async () => {
    useChatStore.getState().startThread('p1', undefined, YEAR);
    const id = await todayThread('p1', 'c1');
    expect(useChatStore.getState().threads[id]?.as_of).toBeUndefined();
    expect(save.calls).toBe(1);
  });
});
```

`frontend/apps/web/src/hooks/__tests__/useChatThread.timeTravel.test.tsx`:

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartLibraryStore, useChatStore, type StoredChart } from '@almamesh/store';

vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import i18n from '../../i18n/config';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { useChatThread, type ChatStreamInput } from '../useChatThread';

const PROFILE = 'profile-A';
const CHART = 'chart-A';
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const JUNE = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;
const NATAL = {
  snapshot_schema: '1', engine_version: 'e', ephemeris_file: 'de421.bsp', data_hash: 'd', ayanamsa: 'lahiri',
  node_type: 'mean', house_system: 'whole_sign', dasha_year_convention: '365.25',
  birth_utc: '1990-01-15T12:00:00Z', reference_date: '2026-03-08T00:00:00Z', snapshot_id: 'a'.repeat(64),
};

function chartWith(snapshot: Record<string, string>): StoredChart {
  return { chart_id: CHART, profile_id: PROFILE, person_name: 'P', is_primary: true, sidereal_chart: { snapshot } } as unknown as StoredChart;
}

function deferredStream(answer: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stream = vi.fn(async (_input: ChatStreamInput) => {
    await gate;
    return answer;
  });
  return { stream, release };
}

beforeEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartLibraryStore.setState({ charts: { [CHART]: chartWith(NATAL) } });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartLibraryStore.setState({ charts: {} });
  __resetMemoryForTest();
});

async function askInPin(mutate: () => void) {
  const { result } = renderHook(() => useChatThread(PROFILE, CHART));
  await act(() => result.current.pin(YEAR));
  const { stream, release } = deferredStream('Work eases in spring 2027.');
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.submit('Will work get easier?', stream);
  });
  mutate();
  await act(async () => {
    release();
    await pending;
  });
  return { result, stream };
}

describe('useChatThread in a pinned thread', () => {
  it('opens the new pinned thread and hands the pin to the stream function', async () => {
    const { result, stream } = await askInPin(() => undefined);
    expect(result.current.asOf).toEqual(YEAR);
    expect(stream.mock.calls[0]?.[0].asOf).toEqual(YEAR);
    expect(result.current.messages.at(-1)?.content).toBe('Work eases in spring 2027.');
  });

  it('drops the late answer when the pin changes mid-answer, and says why', async () => {
    const { result } = await askInPin(() => {
      const id = Object.keys(useChatStore.getState().threads)[0]!;
      useChatStore.getState().setThreadAsOf(id, JUNE);
    });
    const contents = result.current.messages.map((m) => m.content);
    expect(contents).not.toContain('Work eases in spring 2027.');
    expect(result.current.messages.at(-1)).toMatchObject({ error: true, content: i18n.t('chat:errors.pin_changed') });
  });

  it('keeps the answer across a daily re-anchor (only the analysis instant changed)', async () => {
    const { result } = await askInPin(() =>
      useChartLibraryStore.setState({
        charts: { [CHART]: chartWith({ ...NATAL, reference_date: '2026-03-09T00:00:00Z', snapshot_id: 'b'.repeat(64) }) },
      }),
    );
    expect(result.current.messages.at(-1)?.content).toBe('Work eases in spring 2027.');
  });

  it('drops the answer when the birth data changed under it', async () => {
    const { result } = await askInPin(() =>
      useChartLibraryStore.setState({
        charts: { [CHART]: chartWith({ ...NATAL, birth_utc: '1990-01-15T13:00:00Z', snapshot_id: 'c'.repeat(64) }) },
      }),
    );
    expect(result.current.messages.at(-1)).toMatchObject({ error: true, content: i18n.t('chat:errors.chart_changed') });
  });

  it('Back to today leaves the pinned thread', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    await act(() => result.current.backToToday());
    expect(result.current.asOf).toBeUndefined();
  });

  it('an unpinned thread sends no asOf', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    const { stream, release } = deferredStream('Fine.');
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit('How is today?', stream);
    });
    await act(async () => {
      release();
      await pending;
    });
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('asOf');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelThreads.test.ts src/hooks/__tests__/useChatThread.timeTravel.test.tsx`
Expected: FAIL. "Failed to resolve import '../timeTravelThreads'"; `result.current.pin is not a function`.

- [ ] **Step 3: Implement**

`frontend/apps/web/src/lib/timeTravelThreads.ts`:

```ts
/**
 * Pin changes (Go, Change, Back to today) are on disk before the UI moves on
 * (plan Ruling 12). A failed save is rolled back in memory and rethrown, so the
 * sheet can say so and stay open.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { useChatStore } from '@almamesh/store';

import { waitForStoreSaved } from './storeSaved';

async function savedOrRemoved(threadId: string): Promise<string> {
  try {
    await waitForStoreSaved('chat');
  } catch (error) {
    useChatStore.getState().deleteThread(threadId);
    throw error;
  }
  return threadId;
}

export async function startPinnedThread(profileId: string, chartId: string | null, asOf: ChatThreadAsOf): Promise<string> {
  return savedOrRemoved(useChatStore.getState().startThread(profileId, chartId ?? undefined, asOf));
}

export async function repinThread(threadId: string, asOf: ChatThreadAsOf): Promise<void> {
  const previous = useChatStore.getState().threads[threadId]?.as_of;
  useChatStore.getState().setThreadAsOf(threadId, asOf);
  try {
    await waitForStoreSaved('chat');
  } catch (error) {
    if (previous) useChatStore.getState().setThreadAsOf(threadId, previous);
    throw error;
  }
}

/** The profile's latest unpinned thread, or a new one saved first. */
export async function todayThread(profileId: string, chartId: string | null): Promise<string> {
  const latest = useChatStore.getState().listThreads(profileId).find((thread) => !thread.as_of);
  if (latest) return latest.id;
  return savedOrRemoved(useChatStore.getState().startThread(profileId, chartId ?? undefined));
}
```

In `frontend/apps/web/src/hooks/useChatThread.ts`:
1. Imports: `ChatThreadAsOf` from `@almamesh/shared-types`; `import { asOfKey } from '../lib/pinnedPeriod';`; `import { repinThread, startPinnedThread, todayThread } from '../lib/timeTravelThreads';`.
2. `ChatStreamInput` gains:

```ts
  /** The thread's time-travel pin; absent in a normal thread. */
  readonly asOf?: ChatThreadAsOf;
```

3. `UseChatThreadResult` gains:

```ts
  /** The active thread's pin, or undefined in a normal thread. */
  readonly asOf: ChatThreadAsOf | undefined;
  /** Open a new thread pinned to `asOf` (saved first). */
  readonly pin: (asOf: ChatThreadAsOf) => Promise<void>;
  /** Change this thread's pin (saved first). */
  readonly repin: (asOf: ChatThreadAsOf) => Promise<void>;
  /** Open the latest normal thread, or a new one. */
  readonly backToToday: () => Promise<void>;
```

4. After `chartSnapshotIdentity`:

```ts
/** Every snapshot field but the analysis instant: what a pinned answer depends on (plan Ruling 4). */
function natalIdentity(chartId: string): string {
  const snapshot = useChartLibraryStore.getState().getChart(chartId)?.sidereal_chart?.snapshot;
  if (!snapshot) return `chart:${chartId}`;
  const { snapshot_id: _id, reference_date: _today, ...natal } = snapshot;
  return `chart:${chartId}|${JSON.stringify(natal)}`;
}

/** The identity an answer is bound to. A pinned thread does not depend on today, so a re-anchor keeps it. */
export function answerIdentity(chartId: string | null, asOf: ChatThreadAsOf | undefined): string | null {
  if (!asOf) return chartSnapshotIdentity(chartId);
  return `${chartId === null ? 'no-chart' : natalIdentity(chartId)}|${asOfKey(asOf)}`;
}
```

5. In `submit`: replace `const askedAbout = chartSnapshotIdentity(chartId);` with

```ts
      const askedAsOf = store.threads[tid]?.as_of;
      const askedAbout = answerIdentity(chartId, askedAsOf);
```

   pass the pin to the stream: in the `stream({ ... })` object add `...(askedAsOf ? { asOf: askedAsOf } : {}),`; and replace the stale check block with:

```ts
        const liveAsOf = useChatStore.getState().threads[tid]?.as_of;
        if (answerIdentity(currentChartId.current, liveAsOf) !== askedAbout) {
          // Dropped, not attached: flagged so it never enters history or RAG.
          const why = asOfKey(liveAsOf) === asOfKey(askedAsOf) ? 'chat:errors.chart_changed' : 'chat:errors.pin_changed';
          store.appendMessage(tid, 'assistant', i18n.t(why), { error: true });
          return;
        }
```

   (If the thread was deleted mid-answer, `appendMessage` throws into the existing `catch`, which already tolerates a missing thread through `settleChatTurn`; keep that path unchanged.)
6. Before `return`:

```ts
  const pin = useCallback(
    async (asOf: ChatThreadAsOf) => {
      if (profileId) setSelectedThreadId(await startPinnedThread(profileId, chartId, asOf));
    },
    [profileId, chartId],
  );
  const repin = useCallback(
    async (asOf: ChatThreadAsOf) => {
      if (threadId) await repinThread(threadId, asOf);
    },
    [threadId],
  );
  const backToToday = useCallback(async () => {
    if (profileId) setSelectedThreadId(await todayThread(profileId, chartId));
  }, [profileId, chartId]);
```

   and return `{ messages, threadId, isStreaming, streamingDraft, submit, openThread, asOf: activeThread?.as_of, pin, repin, backToToday }`.

Locales, `errors` block of `frontend/apps/web/src/locales/{en,es,pt}/chat.json`:
- en: `"pin_changed": "You changed the period while this answer was being written, so it was discarded. Ask again to get an answer for the new period."`
- es: `"pin_changed": "Cambiaste el periodo mientras se escribía esta respuesta, así que se descartó. Vuelve a preguntar para obtener una respuesta del nuevo periodo."`
- pt: `"pin_changed": "Você mudou o período enquanto esta resposta era escrita, então ela foi descartada. Pergunte de novo para ter uma resposta sobre o novo período."`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelThreads.test.ts src/hooks/__tests__/ src/locales/chat.parity.test.ts`
Expected: PASS, the existing `useChatThread.test.tsx` and `useChatThread.durability.test.tsx` included.

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/hooks/useChatThread.ts "  return \`\${chartId === null ? 'no-chart' : natalIdentity(chartId)}|\${asOfKey(asOf)}\`;" "  return chartId === null ? 'no-chart' : natalIdentity(chartId);" -- bash -c 'cd frontend/apps/web && bunx vitest run src/hooks/__tests__/useChatThread.timeTravel.test.tsx'
python3 "$MUTATE" frontend/apps/web/src/hooks/useChatThread.ts "  if (!asOf) return chartSnapshotIdentity(chartId);" "  return chartSnapshotIdentity(chartId);" -- bash -c 'cd frontend/apps/web && bunx vitest run src/hooks/__tests__/useChatThread.timeTravel.test.tsx'
python3 "$MUTATE" frontend/apps/web/src/lib/timeTravelThreads.ts "    useChatStore.getState().deleteThread(threadId);
    throw error;" "    return threadId;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelThreads.test.ts'
```
Expected: three `KILLED` lines (the spec's "Key on `snapshot_id` only" twice over: the pin ignored, and the re-anchor dropping a pinned answer; a failed save reported as success).

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/lib/timeTravelThreads.ts frontend/apps/web/src/hooks/useChatThread.ts frontend/apps/web/src/lib/__tests__/timeTravelThreads.test.ts frontend/apps/web/src/hooks/__tests__/useChatThread.timeTravel.test.tsx frontend/apps/web/src/locales/en/chat.json frontend/apps/web/src/locales/es/chat.json frontend/apps/web/src/locales/pt/chat.json
git commit -m "feat(web): pinned answers bound to natal chart + pin; pin changes saved before the UI moves on"
```

---

### Task 8: The Time travel sheet (When? / Where?) and its copy

**Files:**
- Create: `frontend/apps/web/src/lib/timeTravelSheet.ts`
- Create: `frontend/apps/web/src/components/features/chat/TimeTravelSheet.tsx`
- Create: `frontend/apps/web/src/components/features/chat/PlacePicker.tsx`
- Modify: `frontend/apps/web/src/locales/{en,es,pt}/chat.json` (new `time_travel` block)
- Test: `frontend/apps/web/src/lib/__tests__/timeTravelSheet.test.ts`, `frontend/apps/web/src/components/features/chat/__tests__/TimeTravelSheet.test.tsx`

**Interfaces:**
- Consumes: `ChatThreadAsOf`; `endsBeforeBirthYear` (`@almamesh/llm`); `devicePolicy` (`@almamesh/browser`); `lookupPlaceOffline`, `type PlaceLookup`, `type ResolvedPlace` (`lib/geo/placeLookup.ts`, step C), loaded with a dynamic `import()`.
- Produces (`timeTravelSheet.ts`):
  - `type PinGranularity = ChatThreadAsOf['granularity']`.
  - `interface SheetDraft { readonly granularity: PinGranularity; readonly day: string; readonly month: string /* YYYY-MM */; readonly year: number; readonly place?: ChatThreadAsOf['place'] }`.
  - `SHEET_LAST_YEAR = 2052`; `sheetYears(birthYear?: number): number[]`.
  - `sheetDefaults(today: string, current: ChatThreadAsOf | undefined, dayAllowed: boolean): SheetDraft`.
  - `asOfFromDraft(draft: SheetDraft): ChatThreadAsOf | undefined` (undefined when a Day draft has no place or no real day).
  - `formatPinLabel(asOf: Pick<ChatThreadAsOf, 'start' | 'granularity'>, language: string): string`.
- Produces (components):
  - `TimeTravelSheet` props: `{ open: boolean; current?: ChatThreadAsOf; birthYear?: number; today: string; dayAllowed?: boolean; lookupPlace?: (query: string) => Promise<PlaceLookup>; onGo: (asOf: ChatThreadAsOf) => Promise<void>; onClose: () => void }`.
  - Test ids: `time-travel-sheet`, `time-travel-tab-day|month|year`, `time-travel-day`, `time-travel-month`, `time-travel-month-year`, `time-travel-year`, `time-travel-where`, `time-travel-where-input`, `time-travel-where-option-<n>`, `time-travel-where-required`, `time-travel-where-none`, `time-travel-before-birth`, `time-travel-save-failed`, `time-travel-go`, `time-travel-cancel`.

- [ ] **Step 1: Add the copy (all `time_travel` keys, used here and in Task 9)**

`frontend/apps/web/src/locales/en/chat.json`, new top-level block:

```json
"time_travel": {
  "button": "Time travel",
  "title": "Time travel · {{period}}",
  "status_working": "Working out the sky for {{period}}… (about 30 s)",
  "sheet": {
    "title": "Time travel",
    "intro": "Pick a time. Answers in the new chat will be about it.",
    "when": "When?",
    "tabs": { "day": "Day", "month": "Month", "year": "Year" },
    "day_label": "Day",
    "month_label": "Month",
    "year_label": "Year",
    "where": "Where?",
    "where_hint": "Type a city. The search stays on this device.",
    "where_placeholder": "Search for a city",
    "where_required": "Pick where you were (or will be) that day.",
    "where_none": "No city found. Try a nearby larger city.",
    "before_birth": "That's before you were born. Pick a later period.",
    "save_failed": "Couldn't save this on your device. Try again.",
    "go": "Go",
    "cancel": "Cancel"
  },
  "banner": {
    "about": "answers are about this period",
    "change": "Change",
    "back": "Back to today"
  },
  "starters": {
    "past": { "hard": "Why did this time feel hard?", "teaching": "What was this period teaching me?" },
    "future": { "prepare": "What should I prepare for?", "strongest": "Which months look strongest?" }
  }
}
```

`es/chat.json`:

```json
"time_travel": {
  "button": "Viaje en el tiempo",
  "title": "Viaje en el tiempo · {{period}}",
  "status_working": "Calculando el cielo de {{period}}… (unos 30 s)",
  "sheet": {
    "title": "Viaje en el tiempo",
    "intro": "Elige un momento. Las respuestas del nuevo chat serán sobre él.",
    "when": "¿Cuándo?",
    "tabs": { "day": "Día", "month": "Mes", "year": "Año" },
    "day_label": "Día",
    "month_label": "Mes",
    "year_label": "Año",
    "where": "¿Dónde?",
    "where_hint": "Escribe una ciudad. La búsqueda se queda en este dispositivo.",
    "where_placeholder": "Busca una ciudad",
    "where_required": "Elige dónde estabas (o estarás) ese día.",
    "where_none": "No se encontró la ciudad. Prueba con una ciudad grande cercana.",
    "before_birth": "Eso es antes de que nacieras. Elige un periodo posterior.",
    "save_failed": "No se pudo guardar en tu dispositivo. Inténtalo de nuevo.",
    "go": "Ir",
    "cancel": "Cancelar"
  },
  "banner": {
    "about": "las respuestas son sobre este periodo",
    "change": "Cambiar",
    "back": "Volver a hoy"
  },
  "starters": {
    "past": { "hard": "¿Por qué fue difícil esta época?", "teaching": "¿Qué me estaba enseñando este periodo?" },
    "future": { "prepare": "¿Para qué debo prepararme?", "strongest": "¿Qué meses se ven más fuertes?" }
  }
}
```

`pt/chat.json`:

```json
"time_travel": {
  "button": "Viagem no tempo",
  "title": "Viagem no tempo · {{period}}",
  "status_working": "Calculando o céu de {{period}}… (cerca de 30 s)",
  "sheet": {
    "title": "Viagem no tempo",
    "intro": "Escolha um momento. As respostas no novo chat serão sobre ele.",
    "when": "Quando?",
    "tabs": { "day": "Dia", "month": "Mês", "year": "Ano" },
    "day_label": "Dia",
    "month_label": "Mês",
    "year_label": "Ano",
    "where": "Onde?",
    "where_hint": "Digite uma cidade. A busca fica neste dispositivo.",
    "where_placeholder": "Busque uma cidade",
    "where_required": "Escolha onde você estava (ou estará) nesse dia.",
    "where_none": "Cidade não encontrada. Tente uma cidade maior perto dali.",
    "before_birth": "Isso é antes de você nascer. Escolha um período depois.",
    "save_failed": "Não foi possível salvar no seu dispositivo. Tente de novo.",
    "go": "Ir",
    "cancel": "Cancelar"
  },
  "banner": {
    "about": "as respostas são sobre este período",
    "change": "Mudar",
    "back": "Voltar para hoje"
  },
  "starters": {
    "past": { "hard": "Por que essa época foi difícil?", "teaching": "O que esse período estava me ensinando?" },
    "future": { "prepare": "Para o que devo me preparar?", "strongest": "Quais meses parecem mais fortes?" }
  }
}
```

Run: `cd frontend/apps/web && bunx vitest run src/locales/chat.parity.test.ts`. Expected: PASS.

- [ ] **Step 2: Write the failing tests**

`frontend/apps/web/src/lib/__tests__/timeTravelSheet.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { asOfFromDraft, formatPinLabel, sheetDefaults, sheetYears, SHEET_LAST_YEAR } from '../timeTravelSheet';

const BOGOTA = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 };

describe('timeTravelSheet', () => {
  it('defaults to Month and the current month, with no place', () => {
    expect(sheetDefaults('2026-10-09', undefined, true)).toEqual({
      granularity: 'month', day: '2026-10-09', month: '2026-10', year: 2026,
    });
  });

  it('prefills Change from the current pin, and falls back to Month for a Day pin on a weak device', () => {
    const day = { start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA } as const;
    expect(sheetDefaults('2026-10-09', day, true)).toEqual({
      granularity: 'day', day: '2026-06-15', month: '2026-06', year: 2026, place: BOGOTA,
    });
    expect(sheetDefaults('2026-10-09', day, false)).toEqual({
      granularity: 'month', day: '2026-06-15', month: '2026-06', year: 2026,
    });
  });

  it('turns a draft into a pin', () => {
    const draft = { day: '2026-06-15', month: '2028-02', year: 2027 };
    expect(asOfFromDraft({ ...draft, granularity: 'year' })).toEqual({ start: '2027-01-01', end: '2027-12-31', granularity: 'year' });
    expect(asOfFromDraft({ ...draft, granularity: 'month' })).toEqual({ start: '2028-02-01', end: '2028-02-29', granularity: 'month' });
    expect(asOfFromDraft({ ...draft, month: '2026-12', granularity: 'month' })).toEqual({ start: '2026-12-01', end: '2026-12-31', granularity: 'month' });
    expect(asOfFromDraft({ ...draft, granularity: 'day', place: BOGOTA })).toEqual({
      start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: BOGOTA,
    });
  });

  it('never makes a Day pin without a place or a real day', () => {
    expect(asOfFromDraft({ granularity: 'day', day: '2026-06-15', month: '2026-06', year: 2026 })).toBeUndefined();
    expect(asOfFromDraft({ granularity: 'day', day: '', month: '2026-06', year: 2026, place: BOGOTA })).toBeUndefined();
  });

  it('offers years from the birth year (or 1900) to 2052', () => {
    expect(SHEET_LAST_YEAR).toBe(2052);
    expect(sheetYears(1990)[0]).toBe(1990);
    expect(sheetYears(1990).at(-1)).toBe(2052);
    expect(sheetYears(undefined)[0]).toBe(1900);
  });

  it('labels a pin in the UI language with Intl, never by hand', () => {
    expect(formatPinLabel({ start: '2027-01-01', granularity: 'year' }, 'en')).toBe('2027');
    expect(formatPinLabel({ start: '2026-06-01', granularity: 'month' }, 'en')).toBe('June 2026');
    expect(formatPinLabel({ start: '2026-06-01', granularity: 'month' }, 'es')).toBe('junio de 2026');
    expect(formatPinLabel({ start: '2026-06-01', granularity: 'month' }, 'pt')).toBe('junho de 2026');
    expect(formatPinLabel({ start: '2026-06-15', granularity: 'day' }, 'en')).toBe(
      new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date('2026-06-15T12:00:00Z'),
      ),
    );
  });
});
```

`frontend/apps/web/src/components/features/chat/__tests__/TimeTravelSheet.test.tsx`:

```tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '../../../../i18n/config';
import { TimeTravelSheet } from '../TimeTravelSheet';

const BOGOTA = {
  summary: { place_ref: 'city:202', label: 'Bogotá, Colombia', timezone: 'America/Bogota' },
  latitude: 4.711,
  longitude: -74.0721,
};

function renderSheet(overrides: Partial<Parameters<typeof TimeTravelSheet>[0]> = {}) {
  const onGo = vi.fn(async () => undefined);
  const lookupPlace = vi.fn(async () => ({ status: 'found' as const, place: BOGOTA }));
  render(
    <TimeTravelSheet open today="2026-10-09" birthYear={1990} dayAllowed onGo={onGo} onClose={vi.fn()} lookupPlace={lookupPlace} {...overrides} />,
  );
  return { onGo, lookupPlace };
}

const go = () => screen.getByTestId('time-travel-go') as HTMLButtonElement;

describe('TimeTravelSheet', () => {
  it('opens on Month with the current month and no "Where?"', () => {
    renderSheet();
    expect(screen.getByTestId('time-travel-tab-month').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('time-travel-month') as HTMLSelectElement).value).toBe('10');
    expect(screen.queryByTestId('time-travel-where')).toBeNull();
  });

  it('Year 2027 → Go opens a pin for all of 2027; there is no "Where?"', async () => {
    const { onGo } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-year'));
    expect(screen.queryByTestId('time-travel-where')).toBeNull();
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2027' } });
    fireEvent.click(go());
    await waitFor(() => expect(onGo).toHaveBeenCalledWith({ start: '2027-01-01', end: '2027-12-31', granularity: 'year' }));
  });

  it('Day shows an empty, required "Where?" that searches only what the user types', async () => {
    const { onGo, lookupPlace } = renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    expect((screen.getByTestId('time-travel-where-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('time-travel-where-required')).toBeTruthy();
    expect(go().disabled).toBe(true);
    expect(lookupPlace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '2026-06-15' } });
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Bogotá' } });
    await waitFor(() => expect(lookupPlace).toHaveBeenCalledWith('Bogotá'));
    fireEvent.click(await screen.findByTestId('time-travel-where-option-0'));
    expect(go().disabled).toBe(false);
    fireEvent.click(go());
    await waitFor(() =>
      expect(onGo).toHaveBeenCalledWith({
        start: '2026-06-15', end: '2026-06-15', granularity: 'day',
        place: { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.711, longitude: -74.0721 },
      }),
    );
  });

  it('says so when no city matches', async () => {
    renderSheet({ lookupPlace: vi.fn(async () => ({ status: 'not_found' as const })) });
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    fireEvent.change(screen.getByTestId('time-travel-where-input'), { target: { value: 'Atlantis' } });
    expect(await screen.findByTestId('time-travel-where-none')).toBeTruthy();
  });

  it('has no Day tab on a weak device', () => {
    renderSheet({ dayAllowed: false });
    expect(screen.queryByTestId('time-travel-tab-day')).toBeNull();
  });

  it('refuses a day before the birth year in plain words, without naming the birth date', async () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('time-travel-tab-day'));
    fireEvent.change(screen.getByTestId('time-travel-day'), { target: { value: '1989-06-01' } });
    const message = screen.getByTestId('time-travel-before-birth').textContent ?? '';
    expect(message).toBe("That's before you were born. Pick a later period.");
    expect(go().disabled).toBe(true);
  });

  it('keeps the sheet open and says so when the pin could not be saved', async () => {
    const onClose = vi.fn();
    renderSheet({ onGo: vi.fn(async () => Promise.reject(new Error('Saving chat failed.'))), onClose });
    fireEvent.click(go());
    expect(await screen.findByTestId('time-travel-save-failed')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('prefills Change from the current pin', () => {
    renderSheet({ current: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } });
    expect(screen.getByTestId('time-travel-tab-year').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2027');
  });

  it('loads the city list lazily, from the offline lookup only (source contract)', () => {
    const source = readFileSync(resolve(__dirname, '../PlacePicker.tsx'), 'utf8');
    expect(source).toContain("import('../../../lib/geo/placeLookup')");
    expect(source).not.toMatch(/from '\.\.\/\.\.\/\.\.\/lib\/geo\/(placeLookup|cityLookup)'/);
    expect(source).not.toContain('searchCities(');
    expect(source).not.toContain('onlineGeocoder');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelSheet.test.ts src/components/features/chat/__tests__/TimeTravelSheet.test.tsx`
Expected: FAIL, unresolved imports `../timeTravelSheet` and `../TimeTravelSheet`.

- [ ] **Step 4: Implement the helpers**

`frontend/apps/web/src/lib/timeTravelSheet.ts`:

```ts
/**
 * The sheet's pure parts (spec Part 3, "The button and the sheet"): defaults,
 * draft → pin, the year range, and the period label (Intl in the UI language).
 * Calendar strings only; no astrology, no clock reads.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

export type PinGranularity = ChatThreadAsOf['granularity'];

export interface SheetDraft {
  readonly granularity: PinGranularity;
  readonly day: string;
  readonly month: string;
  readonly year: number;
  readonly place?: ChatThreadAsOf['place'];
}

/** The ephemeris ends in 2052 (step A); the sheet offers nothing later. */
export const SHEET_LAST_YEAR = 2052;
const SHEET_FIRST_YEAR = 1900;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function sheetYears(birthYear?: number): number[] {
  const first = Math.max(SHEET_FIRST_YEAR, birthYear ?? SHEET_FIRST_YEAR);
  return Array.from({ length: SHEET_LAST_YEAR - first + 1 }, (_, index) => first + index);
}

export function sheetDefaults(today: string, current: ChatThreadAsOf | undefined, dayAllowed: boolean): SheetDraft {
  const anchor = current?.start ?? today;
  const base = { day: anchor, month: anchor.slice(0, 7), year: Number(anchor.slice(0, 4)) };
  if (!current) return { granularity: 'month', ...base };
  if (current.granularity === 'day' && !dayAllowed) return { granularity: 'month', ...base };
  return { granularity: current.granularity, ...base, ...(current.place ? { place: current.place } : {}) };
}

function lastDayOf(month: string): string {
  const [year, monthIndex] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

/** A real calendar day: '' and '2026-02-30' are not (toISOString throws on an invalid Date). */
function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function asOfFromDraft(draft: SheetDraft): ChatThreadAsOf | undefined {
  if (draft.granularity === 'year') {
    return { start: `${draft.year}-01-01`, end: `${draft.year}-12-31`, granularity: 'year' };
  }
  if (draft.granularity === 'month') {
    return { start: `${draft.month}-01`, end: lastDayOf(draft.month), granularity: 'month' };
  }
  if (!draft.place || !isRealDay(draft.day)) return undefined;
  return { start: draft.day, end: draft.day, granularity: 'day', place: draft.place };
}

const LABEL_FORMAT: Readonly<Record<PinGranularity, Intl.DateTimeFormatOptions>> = {
  year: { year: 'numeric', timeZone: 'UTC' },
  month: { month: 'long', year: 'numeric', timeZone: 'UTC' },
  day: { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
};

export function formatPinLabel(asOf: Pick<ChatThreadAsOf, 'start' | 'granularity'>, language: string): string {
  // Noon UTC so no zone shifts the calendar day.
  return new Intl.DateTimeFormat(language, LABEL_FORMAT[asOf.granularity]).format(new Date(`${asOf.start}T12:00:00Z`));
}
```

- [ ] **Step 5: Implement the components**

`frontend/apps/web/src/components/features/chat/PlacePicker.tsx`:

```tsx
/**
 * "Where?" for a Day pin. Offline only (step C Ruling 16): the bundled city list,
 * loaded lazily the first time someone types, never the online geocoder.
 * Never pre-filled from the device zone or the birth place.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import type { PlaceLookup, ResolvedPlace } from '../../../lib/geo/placeLookup';

type PinPlace = NonNullable<ChatThreadAsOf['place']>;

export async function lookupPlaceLazily(query: string): Promise<PlaceLookup> {
  return (await import('../../../lib/geo/placeLookup')).lookupPlaceOffline(query);
}

function candidatesOf(result: PlaceLookup): readonly ResolvedPlace[] {
  if (result.status === 'found') return [result.place];
  return result.status === 'ambiguous' ? result.candidates : [];
}

function toPinPlace(place: ResolvedPlace): PinPlace {
  return { label: place.summary.label, timezone: place.summary.timezone, latitude: place.latitude, longitude: place.longitude };
}

interface PlacePickerProps {
  readonly place: PinPlace | undefined;
  readonly lookup: (query: string) => Promise<PlaceLookup>;
  readonly onPick: (place: PinPlace | undefined) => void;
}

const DEBOUNCE_MS = 200;

export function PlacePicker({ place, lookup, onPick }: PlacePickerProps) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState(place?.label ?? '');
  const [options, setOptions] = useState<readonly ResolvedPlace[] | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2 || text === place?.label) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void lookup(text).then((result) => {
        if (!cancelled) setOptions(candidatesOf(result));
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, lookup, place?.label]);

  return (
    <div data-testid="time-travel-where" className="mt-3">
      <label className="text-sm font-medium text-text-primary" htmlFor="time-travel-where-input">{t('time_travel.sheet.where')}</label>
      <p className="text-xs text-text-muted">{t('time_travel.sheet.where_hint')}</p>
      <input
        id="time-travel-where-input"
        data-testid="time-travel-where-input"
        type="search"
        autoComplete="off"
        value={query}
        placeholder={t('time_travel.sheet.where_placeholder')}
        onChange={(event) => {
          setQuery(event.target.value);
          onPick(undefined);
        }}
        className="mt-1 w-full rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary"
      />
      {!place && <p data-testid="time-travel-where-required" className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_required')}</p>}
      {options?.length === 0 && <p data-testid="time-travel-where-none" className="mt-1 text-xs text-text-muted">{t('time_travel.sheet.where_none')}</p>}
      {!place && options && options.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {options.map((option, index) => (
            <li key={option.summary.place_ref}>
              <button
                type="button"
                data-testid={`time-travel-where-option-${index}`}
                onClick={() => {
                  onPick(toPinPlace(option));
                  setQuery(option.summary.label);
                  setOptions(null);
                }}
                className="w-full rounded-lg border border-ui-border px-3 py-2 text-left text-sm hover:border-accent-gold"
              >
                {option.summary.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`frontend/apps/web/src/components/features/chat/TimeTravelSheet.tsx`:

```tsx
/**
 * The Time travel sheet (spec Part 3). When? is Day / Month / Year (Month,
 * current month, by default). Where? shows on Day only, starts empty, and is
 * required. Go waits for the pin to be saved (plan Ruling 12).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { devicePolicy } from '@almamesh/browser';
import { endsBeforeBirthYear } from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import type { PlaceLookup } from '../../../lib/geo/placeLookup';
import { asOfFromDraft, sheetDefaults, sheetYears, type PinGranularity, type SheetDraft } from '../../../lib/timeTravelSheet';
import { PlacePicker, lookupPlaceLazily } from './PlacePicker';

interface TimeTravelSheetProps {
  readonly open: boolean;
  readonly current?: ChatThreadAsOf;
  readonly birthYear?: number;
  readonly today: string;
  /** Test seam. Default: this device's `devicePolicy().periodSkyComputeAllowed` (plan Ruling 5). */
  readonly dayAllowed?: boolean;
  /** Test seam. Default: the offline city list, loaded on first use. */
  readonly lookupPlace?: (query: string) => Promise<PlaceLookup>;
  readonly onGo: (asOf: ChatThreadAsOf) => Promise<void>;
  readonly onClose: () => void;
}

const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

export function TimeTravelSheet(props: TimeTravelSheetProps) {
  const { t, i18n } = useTranslation('chat');
  const dayAllowed = props.dayAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const [draft, setDraft] = useState<SheetDraft>(() => sheetDefaults(props.today, props.current, dayAllowed));
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (props.open) setDraft(sheetDefaults(props.today, props.current, dayAllowed));
  }, [props.open, props.today, props.current, dayAllowed]);
  if (!props.open) return null;

  const asOf = asOfFromDraft(draft);
  const beforeBirth = asOf !== undefined && endsBeforeBirthYear(asOf, props.birthYear);
  const tabs: readonly PinGranularity[] = dayAllowed ? ['day', 'month', 'year'] : ['month', 'year'];
  const years = sheetYears(props.birthYear);
  const monthName = (month: string) =>
    new Intl.DateTimeFormat(i18n.language, { month: 'long', timeZone: 'UTC' }).format(new Date(`2000-${month}-15T12:00:00Z`));

  const submit = async () => {
    if (!asOf || beforeBirth || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await props.onGo(asOf);
      props.onClose();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="time-travel-sheet-title" data-testid="time-travel-sheet"
      className="absolute inset-x-0 bottom-0 z-20 max-h-full overflow-y-auto rounded-t-2xl border border-ui-border bg-background-secondary p-4 shadow-xl"
      onKeyDown={(event) => event.key === 'Escape' && props.onClose()}>
      <h4 id="time-travel-sheet-title" className="font-semibold text-text-primary">⏳ {t('time_travel.sheet.title')}</h4>
      <p className="text-xs text-text-muted">{t('time_travel.sheet.intro')}</p>
      <p className="mt-3 text-sm font-medium text-text-primary">{t('time_travel.sheet.when')}</p>
      <div role="tablist" className="mt-1 flex gap-2">
        {tabs.map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={draft.granularity === tab} data-testid={`time-travel-tab-${tab}`}
            onClick={() => setDraft({ ...draft, granularity: tab })}
            className={`rounded-full border px-3 py-1 text-xs ${draft.granularity === tab ? 'border-accent-gold text-accent-gold' : 'border-ui-border text-text-secondary'}`}>
            {t(`time_travel.sheet.tabs.${tab}`)}
          </button>
        ))}
      </div>
      {draft.granularity === 'day' && (
        <>
          <input type="date" aria-label={t('time_travel.sheet.day_label')} data-testid="time-travel-day" value={draft.day}
            min={`${years[0]}-01-01`} max={`${years.at(-1)}-12-31`}
            onChange={(event) => setDraft({ ...draft, day: event.target.value })}
            className="mt-2 rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary" />
          <PlacePicker place={draft.place} lookup={props.lookupPlace ?? lookupPlaceLazily}
            onPick={(place) => setDraft({ ...draft, place })} />
        </>
      )}
      {draft.granularity === 'month' && (
        <div className="mt-2 flex gap-2">
          <select aria-label={t('time_travel.sheet.month_label')} data-testid="time-travel-month" value={draft.month.slice(5, 7)}
            onChange={(event) => setDraft({ ...draft, month: `${draft.month.slice(0, 4)}-${event.target.value}` })}
            className="rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary">
            {MONTHS.map((month) => <option key={month} value={month}>{monthName(month)}</option>)}
          </select>
          <select aria-label={t('time_travel.sheet.year_label')} data-testid="time-travel-month-year" value={draft.month.slice(0, 4)}
            onChange={(event) => setDraft({ ...draft, month: `${event.target.value}-${draft.month.slice(5, 7)}` })}
            className="rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary">
            {years.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </div>
      )}
      {draft.granularity === 'year' && (
        <select aria-label={t('time_travel.sheet.year_label')} data-testid="time-travel-year" value={draft.year}
          onChange={(event) => setDraft({ ...draft, year: Number(event.target.value) })}
          className="mt-2 rounded-lg border border-ui-border bg-background-primary px-3 py-2 text-sm text-text-primary">
          {years.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      )}
      {beforeBirth && <p data-testid="time-travel-before-birth" role="alert" className="mt-2 text-xs text-status-error">{t('time_travel.sheet.before_birth')}</p>}
      {saveFailed && <p data-testid="time-travel-save-failed" role="alert" className="mt-2 text-xs text-status-error">{t('time_travel.sheet.save_failed')}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" data-testid="time-travel-cancel" onClick={props.onClose} className="rounded-lg px-4 py-2 text-sm text-text-secondary">
          {t('time_travel.sheet.cancel')}
        </button>
        <button type="button" data-testid="time-travel-go" disabled={!asOf || beforeBirth || saving} onClick={() => void submit()}
          className="rounded-lg bg-accent-gold px-4 py-2 text-sm font-semibold text-background-primary disabled:opacity-50">
          {t('time_travel.sheet.go')}
        </button>
      </div>
    </div>
  );
}
```

If `frontend-quality` flags the component's length, move the three `When?` input blocks into a `WhenInputs` component in the same file; behaviour and test ids stay the same.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelSheet.test.ts src/components/features/chat/__tests__/TimeTravelSheet.test.tsx src/locales/chat.parity.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/components/features/chat/TimeTravelSheet.tsx "  const beforeBirth = asOf !== undefined && endsBeforeBirthYear(asOf, props.birthYear);" "  const beforeBirth = false;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/TimeTravelSheet.test.tsx'
python3 "$MUTATE" frontend/apps/web/src/lib/timeTravelSheet.ts "  if (!draft.place || !isRealDay(draft.day)) return undefined;" "  if (!isRealDay(draft.day)) return undefined;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelSheet.test.ts src/components/features/chat/__tests__/TimeTravelSheet.test.tsx'
python3 "$MUTATE" frontend/apps/web/src/components/features/chat/TimeTravelSheet.tsx "  const tabs: readonly PinGranularity[] = dayAllowed ? ['day', 'month', 'year'] : ['month', 'year'];" "  const tabs: readonly PinGranularity[] = ['day', 'month', 'year'];" -- bash -c 'cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/TimeTravelSheet.test.tsx'
```
Expected: three `KILLED` lines (before-birth gate; "Where?" not required; Day on a weak device).

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/web/src/lib/timeTravelSheet.ts frontend/apps/web/src/components/features/chat/TimeTravelSheet.tsx frontend/apps/web/src/components/features/chat/PlacePicker.tsx frontend/apps/web/src/lib/__tests__/timeTravelSheet.test.ts frontend/apps/web/src/components/features/chat/__tests__/TimeTravelSheet.test.tsx frontend/apps/web/src/locales/en/chat.json frontend/apps/web/src/locales/es/chat.json frontend/apps/web/src/locales/pt/chat.json
git commit -m "feat(web): Time travel sheet — Day/Month/Year, required offline Where? on Day, before-birth guard; en/es/pt"
```

---

### Task 9: The button, banner, badge, starters by tense and the re-anchor skip in `ChatPanel`

**Files:**
- Create: `frontend/apps/web/src/components/features/chat/TimeTravelBanner.tsx`
- Modify: `frontend/apps/web/src/components/features/chat/ChatPanel.tsx`
- Modify: `frontend/apps/web/src/components/features/chat/FloatingChatPanel.tsx` (`birthYear` prop; `onAskQuestionStream` gains `asOf`)
- Modify: `frontend/apps/web/src/components/features/chat/SuggestedQuestions.tsx` (`relative` prop)
- Modify: `frontend/apps/web/src/components/features/chat/ChatSearch.tsx` (label at line 37)
- Test: `frontend/apps/web/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx`, `frontend/apps/web/src/components/features/chat/__tests__/ChatSearch.test.tsx` (one new case)

**Interfaces:**
- Consumes: `useChatThread` `asOf`, `pin`, `repin`, `backToToday` (Task 7); `TimeTravelSheet` (Task 8); `formatPinLabel` (Task 8); `pinRelative`, `type PinRelative` (`@almamesh/llm`); `viewerTodayDay` (`lib/chatAgentTools.ts`); `useLanguageStore` (`@almamesh/store`).
- Produces:
  - `ChatPanelProps.birthYear?: number`; `onAskQuestionStream(question, onToken, onMeta, viewMode?, history?, retrievedContext?, onAgentStatus?, asOf?: ChatThreadAsOf)`.
  - `FloatingChatPanelProps.birthYear?: number` (passed through), same `onAskQuestionStream` type.
  - `SuggestedQuestions` prop `relative?: PinRelative`.
  - Test ids: `time-travel-button`, `time-travel-banner`, `time-travel-badge`, `time-travel-title`, `time-travel-change`, `time-travel-back`.

- [ ] **Step 1: Write the failing tests**

`frontend/apps/web/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useChatStore } from '@almamesh/store';
import { hydrateLlmSettings, openRouterPreset, writeLlmSettings } from '@almamesh/llm';

vi.mock('../../../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import { ChatPanel } from '../ChatPanel';
import { __resetMemoryForTest, __setMemoryForTest } from '../../../../lib/chatMemory';
import { useChartReanchorStatus } from '../../../../lib/chartReanchorStatus';

// 2050: stays in the future for decades, so 'future' starters do not flip with the calendar.
const YEAR_2050 = { start: '2050-01-01', end: '2050-12-31', granularity: 'year' } as const;
const PAST = { start: '2019-06-01', end: '2019-06-30', granularity: 'month' } as const;

function renderPanel(onAsk = vi.fn(async () => ({ answer: 'ok' })), configured = true) {
  if (configured) writeLlmSettings(openRouterPreset('sk-or-v1-0000-synthetic-test-key', 'test-org/test-model'));
  render(
    <MemoryRouter>
      <ChatPanel personName="Marco" profileId="p1" chartId="c1" viewMode="layman" birthYear={1990} onAskQuestionStream={onAsk as never} />
    </MemoryRouter>,
  );
  return onAsk;
}

async function pinYear(year: string) {
  fireEvent.click(screen.getByTestId('time-travel-button'));
  fireEvent.click(screen.getByTestId('time-travel-tab-year'));
  fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: year } });
  fireEvent.click(screen.getByTestId('time-travel-go'));
  await screen.findByTestId('time-travel-banner');
}

beforeEach(() => {
  hydrateLlmSettings(null);
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartReanchorStatus.setState({ pendingChartIds: new Set() });
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  hydrateLlmSettings(null);
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartReanchorStatus.setState({ pendingChartIds: new Set() });
  __resetMemoryForTest();
  vi.restoreAllMocks();
});

describe('ChatPanel time travel', () => {
  it('shows the Time travel button beside the input only when AI is configured', () => {
    renderPanel(undefined, false);
    expect(screen.queryByTestId('time-travel-button')).toBeNull();
  });

  it('Year 2050 → Go opens a pinned thread with badge, title, banner and future starters', async () => {
    renderPanel();
    await pinYear('2050');
    expect(screen.getByTestId('time-travel-badge').textContent).toBe('⏳');
    expect(screen.getByTestId('time-travel-title').textContent).toBe('Time travel · 2050');
    expect(screen.getByTestId('time-travel-banner').textContent).toContain('answers are about this period');
    expect(screen.getByRole('button', { name: 'What should I prepare for?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Which months look strongest?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'What are my career strengths?' })).toBeNull();
    const threads = Object.values(useChatStore.getState().threads);
    expect(threads.map((thread) => thread.as_of)).toEqual([YEAR_2050]);
  });

  it('shows past starters for a pin that is over', async () => {
    useChatStore.getState().startThread('p1', 'c1', PAST);
    renderPanel();
    expect(screen.getByRole('button', { name: 'Why did this time feel hard?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What was this period teaching me?' })).toBeTruthy();
  });

  it('hands the pin to the page with every question', async () => {
    const onAsk = renderPanel();
    await pinYear('2050');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Will work get easier?' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(onAsk).toHaveBeenCalled());
    expect(onAsk.mock.calls[0]?.[7]).toEqual(YEAR_2050);
  });

  it('a pinned thread can send while the chart re-anchors to a new day', async () => {
    useChatStore.getState().startThread('p1', 'c1', YEAR_2050);
    useChartReanchorStatus.getState().begin('c1');
    renderPanel();
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Will work get easier?' } });
    expect((screen.getByTestId('chat-send-button') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('chat-reanchor-status')).toBeNull();
  });

  it('Change updates this thread\'s pin; Back to today leaves it', async () => {
    renderPanel();
    await pinYear('2050');
    fireEvent.click(screen.getByTestId('time-travel-change'));
    expect((screen.getByTestId('time-travel-year') as HTMLSelectElement).value).toBe('2050');
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2051' } });
    fireEvent.click(screen.getByTestId('time-travel-go'));
    await waitFor(() => expect(screen.getByTestId('time-travel-title').textContent).toBe('Time travel · 2051'));
    expect(Object.keys(useChatStore.getState().threads)).toHaveLength(1);

    await act(async () => fireEvent.click(screen.getByTestId('time-travel-back')));
    await waitFor(() => expect(screen.queryByTestId('time-travel-banner')).toBeNull());
  });
});
```

Inside the `describe('ChatSearch', ...)` block of `frontend/apps/web/src/components/features/chat/__tests__/ChatSearch.test.tsx` (it already has `PROFILE`, `memoryReturning(threadId)` and `__setMemoryForTest`), add:

```tsx
  it('labels a pinned thread with the badge and its period, not its first question', async () => {
    const tid = useChatStore.getState().startThread(PROFILE, undefined, {
      start: '2050-01-01', end: '2050-12-31', granularity: 'year',
    });
    useChatStore.getState().appendMessage(tid, 'user', 'Will work get easier?');
    __setMemoryForTest(memoryReturning(tid));

    render(<ChatSearch profileId={PROFILE} onOpenResult={vi.fn()} />);
    fireEvent.change(screen.getByTestId('chat-search-input'), { target: { value: 'work' } });

    expect(await screen.findByText('⏳ Time travel · 2050')).toBeTruthy();
    expect(screen.queryByText('Will work get easier?')).toBeNull();
  });
```

(Import `'../../../../i18n/config'` at the top of the file if it is not already initialised there, so the label renders in English rather than as a key.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/`
Expected: FAIL. No `time-travel-button`; the search label shows the stored title.

- [ ] **Step 3: Implement**

`frontend/apps/web/src/components/features/chat/TimeTravelBanner.tsx`:

```tsx
/** "⏳ Time travel · 2027 · answers are about this period · Change · Back to today" (plan Ruling 1). */
import { useTranslation } from 'react-i18next';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { formatPinLabel } from '../../../lib/timeTravelSheet';

interface TimeTravelBannerProps {
  readonly asOf: ChatThreadAsOf;
  readonly language: string;
  readonly onChange: () => void;
  readonly onBack: () => void;
}

export function TimeTravelBanner({ asOf, language, onChange, onBack }: TimeTravelBannerProps) {
  const { t } = useTranslation('chat');
  const period = formatPinLabel(asOf, language);
  return (
    <div data-testid="time-travel-banner" role="status"
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-1 rounded-lg border border-accent-gold/40 bg-accent-gold/5 px-3 py-2 text-xs text-text-secondary">
      <span data-testid="time-travel-badge" aria-hidden="true">⏳</span>
      <span data-testid="time-travel-title" className="font-semibold text-text-primary">{t('time_travel.title', { period })}</span>
      {asOf.place && <span>· {asOf.place.label}</span>}
      <span>· {t('time_travel.banner.about')} ·</span>
      <button type="button" data-testid="time-travel-change" onClick={onChange} className="underline">{t('time_travel.banner.change')}</button>
      <span>·</span>
      <button type="button" data-testid="time-travel-back" onClick={onBack} className="underline">{t('time_travel.banner.back')}</button>
    </div>
  );
}
```

`SuggestedQuestions.tsx`: add `import type { PinRelative } from '@almamesh/llm';`, a prop `relative?: PinRelative`, and:

```ts
/** Time travel starters by tense (spec Part 3); "contains_today" keeps the current set. */
const PINNED_STARTER_KEYS = {
  past: ['time_travel.starters.past.hard', 'time_travel.starters.past.teaching'],
  future: ['time_travel.starters.future.prepare', 'time_travel.starters.future.strongest'],
} as const;
```

and inside the component: `const keys = relative === 'past' || relative === 'future' ? PINNED_STARTER_KEYS[relative] : SUGGESTED_QUESTION_KEYS.map((key) => \`suggested.questions.${key}\`);` then map `keys` with `const question = t(key);` and `key={key}`.

`ChatSearch.tsx`: import `useLanguageStore` from `@almamesh/store` and `formatPinLabel` from `../../../lib/timeTravelSheet`; replace `threadLabel` with:

```ts
  const language = useLanguageStore((s) => s.language);
  /** A pinned thread is "⏳ Time travel · <period>"; others their title, else a fallback. */
  const threadLabel = (thread: ChatThread | undefined): string =>
    thread?.as_of
      ? `⏳ ${t('time_travel.title', { period: formatPinLabel(thread.as_of, language) })}`
      : thread?.title?.trim() || t('search.thread_fallback');
```

and call it as `threadLabel(threadsById[hit.thread_id])` (import `type ChatThread` from `@almamesh/shared-types`).

`ChatPanel.tsx`:
1. Imports: `ChatThreadAsOf` type; `pinRelative` from `@almamesh/llm` (merge into the existing import); `useLanguageStore` from `@almamesh/store`; `viewerTodayDay` from `../../../lib/chatAgentTools`; `TimeTravelSheet`, `TimeTravelBanner`.
2. Props: `birthYear?: number;` and the eighth `onAskQuestionStream` parameter `asOf?: ChatThreadAsOf,`.
3. Hook destructuring: `const { messages, isStreaming, streamingDraft, submit, openThread, asOf, pin, repin, backToToday } = useChatThread(...)`.
4. Replace the send gate:

```ts
  // A pinned thread doesn't depend on today, so it skips the re-anchor wait (spec Part 3).
  const reanchorWaits = reanchoring && asOf === undefined;
  const sendBlocked = !aiConfigured || isStreaming || reanchorWaits;
  const language = useLanguageStore((s) => s.language);
  const today = viewerTodayDay(new Date());
  const relative = asOf ? pinRelative(asOf, today) : undefined;
  const [sheet, setSheet] = useState<'closed' | 'new' | 'change'>('closed');
```

   and use `reanchorWaits` instead of `reanchoring` for the `chat-reanchor-status` block and the `SuggestedQuestions disabled` prop.
5. `streamAnswer`: pass `input.asOf` as the eighth argument of `onAskQuestionStream(...)`.
6. After the `ChatSearch` line:

```tsx
      {asOf && (
        <TimeTravelBanner asOf={asOf} language={language} onChange={() => setSheet('change')} onBack={() => void backToToday()} />
      )}
```

7. `SuggestedQuestions` gets `relative={relative}`.
8. Inside `ComposerPrimitive.Root`, before `ComposerPrimitive.Input`:

```tsx
          <button type="button" data-testid="time-travel-button" onClick={() => setSheet('new')}
            aria-label={t('time_travel.button')}
            className="flex-shrink-0 rounded-xl border border-ui-border px-3 py-3 text-sm text-text-secondary hover:border-accent-gold">
            <span aria-hidden="true">⏳</span>
            <span className="ml-1 hidden sm:inline">{t('time_travel.button')}</span>
          </button>
```

9. Just before `</ThreadPrimitive.Root>` (the root is `flex flex-col h-[500px] ... overflow-hidden`; add `relative` to its className so the sheet overlays the panel):

```tsx
      <TimeTravelSheet
        open={sheet !== 'closed'}
        current={sheet === 'change' ? asOf : undefined}
        birthYear={birthYear}
        today={today}
        onGo={sheet === 'change' ? repin : pin}
        onClose={() => setSheet('closed')}
      />
```

`FloatingChatPanel.tsx`: add `birthYear?: number` to the props interface, pass `birthYear={birthYear}` to `ChatPanel`, and add the eighth parameter `asOf?: ChatThreadAsOf` to its `onAskQuestionStream` type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/ src/locales/chat.parity.test.ts`
Expected: PASS, including the existing ChatPanel re-anchor tests (an unpinned thread still waits).

- [ ] **Step 5: Mutation red runs**

```bash
python3 "$MUTATE" frontend/apps/web/src/components/features/chat/ChatPanel.tsx "  const reanchorWaits = reanchoring && asOf === undefined;" "  const reanchorWaits = reanchoring;" -- bash -c 'cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx'
python3 "$MUTATE" frontend/apps/web/src/components/features/chat/SuggestedQuestions.tsx "relative === 'past' || relative === 'future' ? PINNED_STARTER_KEYS[relative] :" "false ? PINNED_STARTER_KEYS.past :" -- bash -c 'cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx'
```
Expected: two `KILLED` lines (the spec's "Re-anchor skip: Keep the wait"; starters ignoring tense).

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/web/src/components/features/chat/TimeTravelBanner.tsx frontend/apps/web/src/components/features/chat/ChatPanel.tsx frontend/apps/web/src/components/features/chat/FloatingChatPanel.tsx frontend/apps/web/src/components/features/chat/SuggestedQuestions.tsx frontend/apps/web/src/components/features/chat/ChatSearch.tsx frontend/apps/web/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx frontend/apps/web/src/components/features/chat/__tests__/ChatSearch.test.tsx
git commit -m "feat(web): Time travel button, banner with badge and title, starters by tense; pinned threads skip the re-anchor wait"
```

---

### Task 10: Dashboard and MeshEdge pass the pin to the toolset and the prompt

**Files:**
- Modify: `frontend/apps/web/src/pages/Dashboard.tsx` (`askLocalLlm` at line 261, `handleAskQuestionStream` at line 381, `FloatingChatPanel` at line 1177)
- Modify: `frontend/apps/web/src/pages/MeshEdge.tsx` (`askMeshLlm`, `handleAskQuestionStream` at line 389, `FloatingChatPanel` at line 518)
- Test: `frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts`

**Interfaces:**
- Consumes: `buildChatToolset({ ..., pinned })`, `prepare(..., { pinnedStatus })`, `prepared.pinned` (Task 6); `buildChatMessages(..., places, pinned)` (Task 4); `formatPinLabel` (Task 8); `birthYearOf` (`lib/periodChart.ts`).
- Produces: both pages forward the thread's pin from `ChatPanel` into the toolset and the prompt, and pass `birthYear` to `FloatingChatPanel`.

- [ ] **Step 1: Write the failing test**

In `frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts`, inside `describe.each(pages)`, add:

```ts
  it('forwards the thread pin to the toolset and the prompt, and bounds the sheet by birth year', () => {
    expect(source).toContain('...(asOf ? { pinned: asOf } : {})');
    expect(source).toContain('pinnedStatus:');
    expect(source).toContain('prepared.pinned');
    expect(source).toContain('birthYear={');
    expect(source).not.toContain('pinnedPlaceReader(');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolsetWiring.test.ts`
Expected: FAIL for both pages ("expected ... to contain '...(asOf ? { pinned: asOf } : {})'").

- [ ] **Step 3: Implement, Dashboard**

In `frontend/apps/web/src/pages/Dashboard.tsx`:
1. Imports: `type ChatThreadAsOf` (add to the existing `@almamesh/shared-types` import); `import { formatPinLabel } from '../lib/timeTravelSheet';`; `import { birthYearOf } from '../lib/periodChart';`.
2. `askLocalLlm` gains a seventh parameter after `onAgentStatus`: `asOf?: ChatThreadAsOf,`.
3. The `buildChatToolset({ ... })` call gains, after `engine: chartEngineContext,`: `...(asOf ? { pinned: asOf } : {}),`.
4. The `toolset.prepare(question, { ... })` options gain:

```ts
      pinnedStatus: asOf ? t('chat:time_travel.status_working', { period: formatPinLabel(asOf, language) }) : undefined,
```

5. The `buildChatMessages(...)` call gains a last argument `prepared.pinned,` after the `toolset.tools.some((tool) => tool.name === 'resolve_place'),` line.
6. `handleAskQuestionStream` gains an eighth parameter `asOf?: ChatThreadAsOf,` and passes it as the last argument of `askLocalLlm(...)`.
7. `<FloatingChatPanel ...>` gains:

```tsx
        birthYear={birthYearOf(chartId ? (useChartLibraryStore.getState().getChart(chartId)?.birth_data as ProcessedBirthData | undefined) : undefined)}
```

   (`useChartLibraryStore` and `ProcessedBirthData` are already imported in this file; check with `grep -n "useChartLibraryStore\|ProcessedBirthData" src/pages/Dashboard.tsx`.)

- [ ] **Step 4: Implement, MeshEdge**

In `frontend/apps/web/src/pages/MeshEdge.tsx`, the same seven edits:
1. Imports: `type ChatThreadAsOf`; `formatPinLabel` from `../lib/timeTravelSheet`; `birthYearOf` from `../lib/periodChart`.
2. `askMeshLlm` gains `asOf?: ChatThreadAsOf,` after `onAgentStatus`.
3. `buildChatToolset({ ... })` gains `...(asOf ? { pinned: asOf } : {}),` after `engine: chartEngineContext,`.
4. `toolset.prepare(question, { ... })` gains `pinnedStatus: asOf ? t('chat:time_travel.status_working', { period: formatPinLabel(asOf, language) }) : undefined,`.
5. `buildChatMessages(...)` gains `prepared.pinned,` as its last argument.
6. `handleAskQuestionStream` gains `asOf?: ChatThreadAsOf,` as its eighth parameter and passes it to `askMeshLlm(...)`.
7. `<FloatingChatPanel ...>` gains `birthYear={birthYearOf(anchorChart?.birth_data as ProcessedBirthData | undefined)}`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolsetWiring.test.ts src/pages/__tests__/ && cd .. && bun run --filter '*' typecheck`
Expected: PASS and exit 0; the existing Dashboard and MeshEdge page tests stay green.

- [ ] **Step 6: Mutation red run**

```bash
python3 "$MUTATE" frontend/apps/web/src/pages/MeshEdge.tsx "      ...(asOf ? { pinned: asOf } : {})," "" -- bash -c 'cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolsetWiring.test.ts'
```
Expected: `KILLED`.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/MeshEdge.tsx frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts
git commit -m "feat(web): Dashboard and MeshEdge forward the thread pin to the chat tools and prompt"
```

---

### Task 11: End-to-end Journey 2 ("2027") and the Day pin, in browserJourneys

**Files:**
- Modify: `frontend/apps/web/src/lib/runtimeObservability.ts` (exit-gate hook `__almameshPinnedThreads`)
- Modify: `frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx` (install it in the `EXIT_GATE_HOOKS` block at line 128)
- Modify: `frontend/apps/web/e2e/time-travel.spec.ts` (Journey 2 and the Day pin journey)
- Modify: `dagger/src/index.ts` (the comment above the time-travel command only)
- Test: `frontend/apps/web/src/lib/__tests__/runtimeObservability.test.ts` (one new case)

**Interfaces:**
- Consumes: everything above; from `time-travel.spec.ts`: `prepare`, `scripted`, `call`, `toolMessages`, `predictiveRequestKeys`, `WireMessage`, `AgentRequest`, `bootEngine`, `seedChart` (seeded chart born 1990 in Delhi, so 2027 and June 2026 pass every birth gate).
- Produces:
  - `publishPinnedThreads(read: () => readonly PinnedThreadRow[]): void`, `interface PinnedThreadRow { readonly id: string; readonly as_of: unknown }`, `window.__almameshPinnedThreads` (hooked builds only).
  - Two `[contract/stubbed]` tests in `time-travel.spec.ts`. browserJourneys already runs `TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium` on the hooked build, so the journeys are in CI with no new lane line.

- [ ] **Step 1: The exit-gate hook (red first)**

Append to `frontend/apps/web/src/lib/__tests__/runtimeObservability.test.ts`:

```ts
it('publishes the pinned threads for the e2e suites (ids and pins only)', () => {
  publishPinnedThreads(() => [{ id: 't1', as_of: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } }]);
  expect(window.__almameshPinnedThreads?.()).toEqual([
    { id: 't1', as_of: { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } },
  ]);
});
```

(add `publishPinnedThreads` to that file's import from `../runtimeObservability`). Run `cd frontend/apps/web && bunx vitest run src/lib/__tests__/runtimeObservability.test.ts`: FAIL, not exported. Then in `runtimeObservability.ts` add `__almameshPinnedThreads?: () => readonly PinnedThreadRow[]` to the `Window` declaration and:

```ts
export interface PinnedThreadRow {
  readonly id: string
  readonly as_of: unknown
}

/** Exit-gate builds only: lets the time-travel and backup suites compare pins field for field. */
export const publishPinnedThreads = (read: () => readonly PinnedThreadRow[]): void => {
  window.__almameshPinnedThreads = read
}
```

In `AlmaMeshRuntimeProvider.tsx`, add `useChatStore` to the `@almamesh/store` import and `publishPinnedThreads` to the `runtimeObservability` import, and inside `if (typeof window !== 'undefined' && EXIT_GATE_HOOKS) {`:

```ts
  publishPinnedThreads(() =>
    Object.values(useChatStore.getState().threads).flatMap((thread) =>
      thread.as_of ? [{ id: thread.id, as_of: thread.as_of }] : [],
    ),
  )
```

Re-run the unit test: PASS.

- [ ] **Step 2: Write Journey 2 and the Day pin journey**

Add to `frontend/apps/web/e2e/time-travel.spec.ts`:

```ts
/**
 * Journey 2 (spec 2026-10-08, Inc D; plan Ruling 11: the shared ChatPanel, on the
 * Dashboard): ⏳ Time travel → Year 2027 (next year) → Go. The thread is pinned, survives a
 * reload, shows the badge, title, banner and future starters, and a question
 * with no dates reads that year in the future tense. Today is never pre-run.
 */
const PIN_QUESTION = 'Will work get easier?';
// Next year: 2027 when this lands (the spec's journey), and never a past year as the calendar moves.
const PIN_YEAR = String(new Date().getUTCFullYear() + 1);
const PIN_DAYS = new Date(Date.UTC(Number(PIN_YEAR), 1, 29)).getUTCMonth() === 1 ? 366 : 365;
const PIN_ANSWER = `I looked at 1 January–31 December ${PIN_YEAR}. Work should get easier from spring.`;
const PIN_SCREENSHOT = 'test-results/time-travel-next-year.png';

async function openPinnedYear(page: Page, year: string): Promise<void> {
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeVisible();
  await page.getByTestId('time-travel-tab-year').click();
  await expect(page.getByTestId('time-travel-where')).toHaveCount(0);
  await page.getByTestId('time-travel-year').selectOption(year);
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-banner')).toBeVisible();
}

test('[contract/stubbed] Time travel → next year pins a thread that reads it without dates', async ({ page }) => {
  const consoleErrors = await prepare(page);
  const seen: AgentRequest[] = [];
  const fulfilled = new Set<string>();
  await scripted(
    page,
    {
      [PIN_QUESTION]: (messages) =>
        toolMessages(messages).length === 0
          ? { content: null, tool_calls: [call('when', 'get_current_datetime', { scope: 'chart' }), call('sky', 'get_timing', { section: 'transits' })] }
          : { content: PIN_ANSWER },
    },
    seen,
    fulfilled,
  );
  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date()),
  );
  await expect(page.getByTestId('provenance-footer')).toContainText(`As of ${today}`, { timeout: 120_000 });
  await expect(page.getByTestId('life-atlas').getByText(/^As of /)).toBeVisible({ timeout: 240_000 });
  const keysBefore = await predictiveRequestKeys(page);

  await page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
  await openPinnedYear(page, PIN_YEAR);
  await expect(page.getByTestId('time-travel-badge')).toHaveText('⏳');
  await expect(page.getByTestId('time-travel-title')).toHaveText(`Time travel · ${PIN_YEAR}`);
  await expect(page.getByTestId('time-travel-banner')).toContainText('answers are about this period');
  await expect(page.getByRole('button', { name: 'What should I prepare for?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Which months look strongest?' })).toBeVisible();

  // The pin was on disk before the sheet closed: a full reload keeps it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await expect(page.getByTestId('time-travel-title')).toHaveText(`Time travel · ${PIN_YEAR}`);
  expect(await page.evaluate(() => window.__almameshPinnedThreads?.().map((row) => row.as_of))).toEqual([
    { start: `${PIN_YEAR}-01-01`, end: `${PIN_YEAR}-12-31`, granularity: 'year' },
  ]);

  await page.evaluate(() => {
    const history: string[] = [];
    (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory = history;
    new MutationObserver(() => {
      const text = document.querySelector('[data-testid="chat-agent-status"]')?.textContent;
      if (text && history.at(-1) !== text) history.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByTestId('chat-input').fill(PIN_QUESTION);
  await page.getByTestId('chat-send-button').click();
  await expect(page.getByTestId('chat-panel').getByText(PIN_ANSWER)).toBeVisible({ timeout: 240_000 });

  const last = seen.at(-1)!;
  const tools = toolMessages(last.messages);
  expect(tools.map((m) => m.name)).toEqual(['get_current_datetime', 'get_timing']);
  expect(tools[0]?.content).toContain(`"pinned_period":{"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31"}`);
  expect(tools[0]?.content).toContain('"relative":"future"');
  expect(tools[1]?.content).toContain(`"period":{"start":"${PIN_YEAR}-01-01","end":"${PIN_YEAR}-12-31","days":${PIN_DAYS},"basis":"period"}`);
  const system = last.messages.find((m) => m.role === 'system')?.content ?? '';
  expect(system).toContain(`PINNED PERIOD: this conversation is about ${PIN_YEAR}-01-01 to ${PIN_YEAR}-12-31 (relative: future)`);
  expect(system).toContain('future tense');
  const statuses = await page.evaluate(() => (window as unknown as { __agentStatusHistory: string[] }).__agentStatusHistory);
  expect(statuses.some((text) => text.startsWith(`Working out the sky for ${PIN_YEAR}`))).toBe(true);
  expect((await predictiveRequestKeys(page)).slice(keysBefore.length), 'the Life Atlas slot keeps its requestKey').toEqual([]);
  await page.screenshot({ path: PIN_SCREENSHOT, fullPage: true });
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});

/**
 * The Day pin (spec Testing, e2e): "Where?" shows on Day only, starts empty, is
 * required, and the city search makes no request off the app origin. Then
 * Change → Month and Back to today.
 */
test('[contract/stubbed] a Day pin needs a place found on the device, then Change and Back to today', async ({ page }) => {
  const consoleErrors = await prepare(page);
  const fulfilled = new Set<string>();
  await scripted(page, {}, [], fulfilled);
  await bootEngine(page);
  await seedChart(page);
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  const origin = new URL(page.url()).origin;
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
  });

  await page.getByTestId('floating-chat-button').click({ timeout: 120_000 });
  await page.getByTestId('time-travel-button').click();
  await expect(page.getByTestId('time-travel-where')).toHaveCount(0);
  await page.getByTestId('time-travel-tab-day').click();
  await expect(page.getByTestId('time-travel-where-input')).toHaveValue('');
  await expect(page.getByTestId('time-travel-where-required')).toBeVisible();
  await page.getByTestId('time-travel-day').fill('2026-06-15');
  await expect(page.getByTestId('time-travel-go')).toBeDisabled();
  await page.getByTestId('time-travel-where-input').fill('Bogotá');
  await page.getByTestId('time-travel-where-option-0').click({ timeout: 30_000 });
  await expect(page.getByTestId('time-travel-go')).toBeEnabled();
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-banner')).toContainText('Bogotá, Colombia');
  const [dayPin] = (await page.evaluate(() => window.__almameshPinnedThreads?.())) ?? [];
  expect(dayPin?.as_of).toMatchObject({ start: '2026-06-15', end: '2026-06-15', granularity: 'day', place: { timezone: 'America/Bogota' } });

  await page.getByTestId('time-travel-change').click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption('06');
  await page.getByTestId('time-travel-month-year').selectOption('2026');
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-title')).toHaveText('Time travel · June 2026');
  await expect(page.getByTestId('time-travel-banner')).not.toContainText('Bogotá');

  await page.getByTestId('time-travel-back').click();
  await expect(page.getByTestId('time-travel-banner')).toHaveCount(0);
  expect(offOrigin.filter((url) => !fulfilled.has(url)), 'nothing may leave the app origin').toEqual([]);
  expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
});
```

Add to the file's global `Window` typing (or a local cast) `__almameshPinnedThreads?: () => Array<{ id: string; as_of: unknown }>`. If step C's `scripted` helper is typed for a non-empty script map, the `{}` map makes every provider call return the harmless empty answer, which is what this journey wants.

Run (preview from the Global Constraints running):
```bash
cd frontend/apps/web && TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium
```
Expected: every time-travel journey passes (steps A–C plus these two). Keep `test-results/time-travel-next-year.png`.

- [ ] **Step 3: Red runs (rebuild the hooked bundle inside each command)**

```bash
REBUILD='cd frontend/apps/web && VITE_EXIT_GATE_HOOKS=1 bun run build --outDir dist-verify && TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium'
python3 "$MUTATE" frontend/apps/web/src/lib/timingTool.ts "  if (parsed.kind === 'today') return { kind: 'period', period: pinned.period, ...place };
" "" -- bash -c "$REBUILD"
python3 "$MUTATE" frontend/apps/web/src/components/features/chat/PlacePicker.tsx "  return (await import('../../../lib/geo/placeLookup')).lookupPlaceOffline(query);" "  await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(query)).catch(() => undefined);
  return (await import('../../../lib/geo/placeLookup')).lookupPlaceOffline(query);" -- bash -c "$REBUILD"
python3 "$MUTATE" frontend/apps/web/src/lib/chatToolset.ts "      if (pinned) {
        // A pinned thread never pre-runs today" "      if (false && pinned) {
        // A pinned thread never pre-runs today" -- bash -c "$REBUILD"
```
Expected: three `KILLED` lines (no-date call reads today, not the pinned year; the city search leaves the origin; the pinned prompt rule and status disappear). Rebuild once more without mutations afterwards so the running preview serves the real bundle.

- [ ] **Step 4: Comment-only lane update, contract tests**

In `dagger/src/index.ts`, change the comment above the time-travel command to "Time travel (spec 2026-10-08), Inc A, B, C and D journeys: June 2019 typed in plain chat, an 18-month period, places, and the Time travel button (2027 pinned; a Day pin found on the device). A stubbed provider, the real engine. Chromium only." Leave the command string alone. Run `bun test ./tests/*.test.ts` from the root. Expected: all pass; `tests/dagger-ingress-contract.test.ts` untouched.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/runtimeObservability.ts frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx frontend/apps/web/src/lib/__tests__/runtimeObservability.test.ts frontend/apps/web/e2e/time-travel.spec.ts dagger/src/index.ts
git commit -m "test(e2e): time travel journey 2 — 2027 pinned, survives reload, reads 2027 undated; Day pin found on device"
```

---

### Task 12: Export and import round trip of a pinned thread, in browserChromium

**Files:**
- Modify: `frontend/apps/web/e2e/portable-invariants.spec.ts` (new `test.describe`)

**Interfaces:**
- Consumes: `freshBrowser`, `gotoSettled`, `onboard`, `SELF`, `connectAi`, `spaNavigate`, `exportBackup`, `importBackup`, `expectCleanBrowser` (all in that spec or `portableInvariants.helpers.ts`); `window.__almameshPinnedThreads` (Task 11). The browserChromium lane already runs `PORTABLE_INVARIANTS_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:portable-invariants --project=chromium` on the hooked build.
- Produces: the claim "export/import carries everything" proven for `as_of`, field for field, with the banner shown after restore.

- [ ] **Step 1: Write the journey**

```ts
test.describe('a pinned time-travel thread round-trips (chat store v3)', () => {
  async function pinnedThreads(page: Page): Promise<Array<{ id: string; as_of: unknown }>> {
    await page.waitForFunction(() => ((window as unknown as { __almameshPinnedThreads?: () => unknown[] }).__almameshPinnedThreads?.() ?? []).length > 0);
    return page.evaluate(
      () => (window as unknown as { __almameshPinnedThreads: () => Array<{ id: string; as_of: unknown }> }).__almameshPinnedThreads(),
    );
  }

  test('a Day pin with a place survives export and import field for field', async ({ browser }, testInfo) => {
    const a = await freshBrowser(browser, testInfo);
    await test.step('seed: onboard, connect AI, pin 15 June 2026 in Bogotá', async () => {
      await gotoSettled(a.page, '/onboarding');
      await onboard(a.page, SELF);
      await connectAi(a.page);
      await spaNavigate(a.page, '/dashboard');
      await a.page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
      await a.page.getByTestId('time-travel-button').click();
      await a.page.getByTestId('time-travel-tab-day').click();
      await a.page.getByTestId('time-travel-day').fill('2026-06-15');
      await a.page.getByTestId('time-travel-where-input').fill('Bogotá');
      await a.page.getByTestId('time-travel-where-option-0').click({ timeout: 30_000 });
      await a.page.getByTestId('time-travel-go').click();
      await expect(a.page.getByTestId('time-travel-banner')).toContainText('Bogotá, Colombia');
    });
    const before = await pinnedThreads(a.page);
    expect(before).toHaveLength(1);
    expect(before[0]?.as_of).toMatchObject({ granularity: 'day', place: { timezone: 'America/Bogota' } });

    const exportPath = testInfo.outputPath('pinned.almamesh');
    await test.step('export from browser A', async () => {
      await exportBackup(a.page, exportPath);
      expectCleanBrowser(a.problems, 'browser A');
    });
    await a.close();

    const b = await freshBrowser(browser, testInfo);
    await test.step('import into browser B: the same pin, field for field, and its banner', async () => {
      await importBackup(b.page, exportPath);
      await spaNavigate(b.page, '/dashboard');
      expect(await pinnedThreads(b.page)).toEqual(before);
      await b.page.getByTestId('floating-chat-button').click({ timeout: 60_000 });
      await expect(b.page.getByTestId('time-travel-banner')).toContainText('Bogotá, Colombia');
      expectCleanBrowser(b.problems, 'browser B');
    });
    await b.close();
  });
});
```

Run:
```bash
cd frontend/apps/web && PORTABLE_INVARIANTS_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:portable-invariants --project=chromium -g "pinned time-travel"
```
Expected: PASS.

- [ ] **Step 2: Red run (strip `as_of` in the export path)**

```bash
python3 "$MUTATE" frontend/packages/store/src/portableState.ts "      const canonical = await this.#rebuildExport(repaired.values);" "      const canonical = await this.#rebuildExport(new Map([...repaired.values].map(([key, value]) => [key, key === 'almamesh-chat-history' ? value.replace(/,\"as_of\":\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\}/g, '') : value])));" -- bash -c 'cd frontend/apps/web && VITE_EXIT_GATE_HOOKS=1 bun run build --outDir dist-verify && PORTABLE_INVARIANTS_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:portable-invariants --project=chromium -g "pinned time-travel"'
```
Expected: `KILLED` (browser B shows no pinned thread; `pinnedThreads` times out or compares unequal). This is the spec's "strip `as_of` in the export path" mutation. Rebuild without the mutation afterwards.

- [ ] **Step 3: Full suite and commit**

Run the whole portable-invariants spec (`--project=chromium`, no `-g`). Expected: every scenario passes.

```bash
git add frontend/apps/web/e2e/portable-invariants.spec.ts
git commit -m "test(e2e): a Day pin with a place survives export and import field for field"
```

---

### Task 13: Full gates, live drive, northstar, one PR

**Files:** none new. Evidence only.

- [ ] **Step 1: Full gates from the worktree root**

```bash
cd frontend && bun run gate; echo "frontend gate exit $?"
cd .. && bun test ./tests/*.test.ts; echo "contract exit $?"
cd backend && uv run poe gate; echo "backend gate exit $?"
```
Expected: every exit is 0. Record test counts and coverage. `chatAsOf.ts`, `period-pin.ts`, `pinnedPeriod.ts`, `timeTravelThreads.ts` and `timeTravelSheet.ts` must be at 100% branch coverage, every `throw` covered. Invoke `frontend-quality` on `git diff --name-only origin/main -- frontend`. An uncovered line inside a `raise`/`throw` branch is a gate failure: add the test.

- [ ] **Step 2: Both e2e lanes once more**

From a fresh hooked build: `bun run test:e2e:time-travel --project=chromium` and `bun run test:e2e:portable-invariants --project=chromium`. Paste pass counts. Keep `time-travel-next-year.png`.

- [ ] **Step 3: Drive it live**

`cd frontend/apps/web && VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port 4216`. Use Playwright Chromium (the MCP_DOCKER browser cannot boot the engine). Onboard a real chart through the UI, connect AI, and:
- On the Dashboard: ⏳ Time travel → Year 2027 → Go. Confirm the badge, the title, the banner, future starters, and no "Where?". Reload; the pin is still there. Ask "Will work get easier?". With an OpenRouter key on this machine, the answer names 2027 and speaks in the future tense; without one, say so in the PR and point to Task 11's stubbed journey.
- On `/mesh/<member>` (add a person on `/mesh` first): open chat, tap ⏳ Time travel → Month → June 2019 → Go. Confirm the banner and past starters, and (with a key) a past-tense answer. This is the MeshEdge evidence for Ruling 11.
- A Day pin with "Where?": the field starts empty, Go stays disabled until a city is picked, and the network panel shows no request off the app origin.
- Change and Back to today, both surfaces.
- Repeat once with `deviceMemory` pinned to 2 (lite): no Day tab, a pinned Year answers with dashas only, and no `cities.min` request.
- Switch the language to es and pt: the button, sheet, banner and starters read in that language, and the period label is Intl's ("junio de 2026", "junho de 2026").
- Screenshots of each, and a clean console for each.

- [ ] **Step 4: Northstar grade**

Dispatch the `northstar` agent (standing approval) on the branch with:
- the claim "export/import carries everything", plus "only sanitized facts reach the model" (the pinned place's coordinates) and "a chat-typed city never leaves the device" (the "Where?" field);
- the mutation table;
- the e2e screenshots and the live-drive screenshots (Dashboard, MeshEdge, lite, es/pt);
- the gate exits and coverage.

Fix anything below A, re-run Step 1, and re-grade.

- [ ] **Step 5: One PR**

```bash
git push -u origin claude/time-travel-d
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-d \
  --title "feat: time travel step D — Time travel button, pinned threads, export/import of the pin" --body-file /tmp/inc-d-pr.md
```

The body states:
- what ships (the Inc D row; Journey 2);
- the claim touched ("export/import carries everything"), and that the pin's coordinates never reach the model;
- the Rulings list verbatim, flagging Ruling 4 (pinned answers keyed on the natal chart plus the pin, not `snapshot_id`), Ruling 3 (no dates in a pinned thread means the pin) and Ruling 11 (Journey 2 on the Dashboard in e2e, MeshEdge driven live);
- the stated contracts changed on purpose: chat store v2 → v3 and the importer's max chat version 2 → 3 (an older build now refuses a v3 backup with "This backup was made by a newer version of AlmaMesh");
- the evidence table: gate exits and counts, coverage of the five new modules, both e2e lanes, the live drive (or "unverified" for the real-model part), lite and es/pt checks;
- the mutation table: every `KILLED` line from Tasks 1–12.

End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
```

- [ ] **Step 6: Merge and clean up in the same breath**

When CI is green and northstar is A:
1. `gh pr merge --squash --delete-branch`.
2. `git worktree remove .worktrees/time-travel-d`, then `git branch -D claude/time-travel-d`.
3. Confirm CI is green on `main`.
4. Confirm the deploy serves the merge SHA: `build.json` `git_sha` equals the merge SHA, with `content-type: application/json`.
5. Run `dangling_audit.py` before reporting done.

---

## Self-review notes (spec coverage)

| Spec item (Inc D / Part 3, Data and storage, Testing) | Task |
| --- | --- |
| "⏳ Time travel" beside the chat input in `ChatPanel`, both surfaces via `FloatingChatPanel` | 9, 10 |
| Sheet: When? Day / Month / Year, Month and current month by default | 8 |
| Where? on Day only, empty, required, offline city search, never pre-filled | 8, 11 (network), Ruling 5 |
| Go opens a new thread pinned to the period | 2, 7, 9 |
| Banner "⏳ … · answers are about this period · Change · Back to today" | 9 (Ruling 1) |
| Change reopens the sheet and updates this thread's pin; Back to today opens the last normal thread or a new one | 7, 9, 11 |
| ⏳ badge and "Time travel · June 2026" title (`ChatSearch` labels) | 9 (Ruling 1) |
| `get_timing` defaults to the pin; other dates still allowed | 5 |
| `get_current_datetime` returns real now + `pinned_period` + `relative` | 5 (Ruling 2) |
| Prompt matches tense to `relative` | 4, 6, 10 |
| Starters by `relative` | 9 |
| "Working out the sky for June 2026… (about 30 s)" on the first question | 6, 10, 11 |
| Stale guard: `snapshot + as_of`; pin change mid-answer drops the late answer | 7 (Ruling 4) |
| Re-anchor skip for pinned threads | 9 |
| `ChatStreamInput.asOf` | 7 |
| `ChatThreadAsOf` + `ChatThread.as_of` | 1 |
| Chat store 2 → 3; migration keeps v2, drops malformed `as_of` | 2 |
| Import accepts v3; malformed `as_of` refuses the backup, naming row and field | 3 |
| Nothing new in IndexedDB or localStorage | Global Constraints (rides the existing chat row) |
| Pinned router: pre-run the pin, never today | 6 (Ruling 8) |
| Privacy: device zone never sent; place coordinates never to the model | 5, 6 (egress tests), Ruling 9 |
| Error handling: before the birth year (user copy) | 8 (Ruling 10) |
| Error handling: pin changed mid-answer | 7 |
| i18n: `chat` namespace en/es/pt; `Intl.DateTimeFormat` period labels | 7, 8, 9 |
| e2e Journey 2 "2027"; Day pin with a place; clean console | 11 |
| Export/import round trip in browserChromium, with the strip-`as_of` red run | 12 |
| Low-end: tiers 5/3/1 unchanged; Day tab and city list full tier only | 6, 8, Global Constraints |

Known gaps, deliberately not tasks:
- Side-by-side comparison, a timeline scrubber and a PDF of a time-travel reading (out of scope for v1 per spec).
- A thread list UI (none exists; Ruling 1).
- MeshEdge in e2e (Ruling 11; live drive in Task 13).
