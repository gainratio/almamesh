# Time Travel You Can Find — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can reach time travel from the Dashboard on any device, with or without AI. Picking a moment shows that moment's dashas and transits on the Dashboard. Day and "Where?" work on iPhone and Safari within a memory budget. A chat tool moves the thread and the Dashboard through the same code as the sheet.

**Architecture:** One seam, `lib/timeTravel.ts`, owns "travel to a moment". It checks the moment, saves the chat pin when AI is on, and then sets an in-memory Dashboard moment. The sheet, the banner, the Dashboard and the chat tool all go through it. The Dashboard's moment card reuses the pure `@almamesh/llm` selectors and the period-sky queue, so no new astrology is written in TypeScript. Part 3 moves city rows and per-day sky results into one SQLite database on OPFS, opened through one seam (`lib/derivedDb.ts`, the only importer of `@gainratio/browser/sql`). That bounds what JS keeps, and lets every tier turn on Day and "Where?". Part 4 adds a `time_travel` tool. It records a pending move during the turn, and the chat UI applies it through the seam after the turn ends.

**Tech Stack:** TypeScript, React, Zustand, react-i18next, `@almamesh/llm`, `@almamesh/store`, `@almamesh/browser`, `@gainratio/browser/sql` (SQLite 3.53.4 + FTS5 on OPFS), Vitest (happy-dom), Playwright (Chromium, WebKit, macOS WebKit lane), Dagger.

**Spec:** `docs/superpowers/specs/2026-10-10-time-travel-reachable-design.md`. Read it in full, including **Rulings** (1–7) and Part 3's **Corrections found while planning**. The earlier plans `docs/superpowers/plans/2026-10-09-time-travel-inc-{c,d}.md` explain the pieces this builds on (the sheet, `asOfFromDraft`, `timeTravelThreads`, the place tool).

## Three PRs

| PR | Parts | Branch / worktree | Tasks | Depends on |
|----|-------|-------------------|-------|------------|
| A | 1 + 2 (Ruling 2) | `claude/time-travel-reach-a`, `.worktrees/time-travel-reach-a` | A1–A7 | `main` |
| B | 3 | `claude/time-travel-reach-b`, `.worktrees/time-travel-reach-b` | B1–B8 | PR A merged; **PR #317 merged** (or its `scripts/webkitProcessMemory.mjs` + `e2e/webkitDiagnostics.ts` on `main`) |
| C | 4 | `claude/time-travel-reach-c`, `.worktrees/time-travel-reach-c` | C1–C4 | PR A and PR B merged |

If B1's baseline shows the first Day compute over budget, PR B splits into **B-3a** (slim `compute_period_sky` entry, Ruling 4) and **B-3b** (B2–B8). See B1 Step 6.

## Plan rulings (where the spec is silent or the code disagrees)

1. **The Dashboard moment is set only after the chat pin is saved.** The spec lists "set moment" before "pin chat". If the pin save fails, the move must not show on the Dashboard while chat stays put. So `applyTravel` saves the pin first (when AI is on), then sets the moment. With AI off there is no save, and the moment is set right away.
2. **Which thread a move touches is explicit.** `TravelTarget.thread` is `'new'` (the chat ⏳ button: always a new pinned thread, as today), `{ id }` (the chat banner's Change, and the chat tool: repin that thread if pinned, else start a new pinned thread), or `'latest'` (the Dashboard: the profile's latest thread, which is the one chat shows when opened, `listThreads(profileId)[0]`). This keeps today's chat behaviour byte for byte.
3. **The Dashboard banner has its own copy.** The chat banner says "answers are about this period". The Dashboard banner says "the cards below are about this moment" (`dashboard:time_travel.banner_about`). `TimeTravelBanner` gains `testIdPrefix` and `about` props; the chat keeps its defaults.
4. **The dashas-only note gets a UI string.** `DEVICE_DASHAS_ONLY_NOTE` is a model-facing English constant in `lib/timingTool.ts:156`. The card uses `dashboard:time_travel.dashas_only` with the same meaning, in en/es/pt.
5. **The e2e "known boundary" native is the existing Delhi seed.** There is no synthetic e2e native. The engine CLI gives, for `DELHI_BIRTH` (1990-01-15T12:00Z, 28.6139, 77.209): Rahu maha 2017-05-13 → 2035-05-14; Rahu antar 2017-05-13 → 2020-01-24; Mercury antar 2025-04-25 → 2027-11-12. March 2019 is Rahu/Rahu. Today (October 2026) is Rahu/Mercury. So a card computed for today fails the March 2019 assertion. A2 Step 1 re-derives these numbers before they are pinned.
6. **A Day moment's place does not change the Dashboard transits.** The period sky is computed for the day; the place only changes the Moon window, which stays a chat tool feature. The card shows the place in the banner label only.
7. **PR A adds an `iphone-15-webkit` project; it does not replace iPhone 13** (spec, Per-PR proof). Tag new iPhone 15 tests `@iphone15`.

## Global Constraints

- Paths below are relative to the PR's worktree. `W` = `frontend/apps/web`. Line numbers refer to `main` at `821bd6e8`; re-check them after rebasing.
- Create each PR's worktree from fresh `main`: `git -C /Users/harish/dev/oss/almamesh fetch origin && git -C /Users/harish/dev/oss/almamesh worktree add .worktrees/time-travel-reach-a -b claude/time-travel-reach-a origin/main` (b and c the same way, after their dependencies merge). Install: `cd frontend && bun install --frozen-lockfile`; then `cd apps/web && ./scripts/setup-dev-assets.sh`.
- Stage named files only. Never `git add -A` or `git add .`. Files under `docs/superpowers/` need `git add -f`.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
  ```
- **No new astrology in TypeScript.** Dasha selection is `selectDashasForPeriod`, transit trimming is `restrictTransitsToPeriod`, and both come from `@almamesh/llm`. Importing them loads no AI.
- **Period computes go through `periodSkyCache()` only.** Never `usePredictiveStore` (it holds today's Life Atlas result; `lib/periodSky.ts` header).
- **One engine queue.** No new Worker for the engine, no second Pyodide runtime. The cache-hit path must not touch the engine.
- **SQLite on OPFS is the only durable home for new data.** No IndexedDB, no `localStorage`, no `sessionStorage`, no in-memory SQLite fallback (`fallback: 'none'`). The Dashboard moment is React/Zustand memory only (Ruling 1).
- **Lego seam:** `@gainratio/browser/sql` is imported only in `W/src/lib/derivedDb.ts` (and its test via `@gainratio/browser/sql/node`).
- **Coordinates never reach the model.** Only a place label and an IANA zone do.
- **Budgets are never raised to make a red run green** (spec, Memory budget). The memory gate fails on NaN, like `overBudget`.
- **User strings:** plain English, short sentences. en is authoritative; es and pt land in the same commit; the namespace parity tests (`locales/*.parity.test.ts`) stay green.
- **Tool status labels** stay English constants in the tool file, like `timingTool.ts:326`.
- **TDD.** Each step that adds a test runs it red first, for the stated reason, and the red output goes in the PR body.
- **Quality skills:** invoke `frontend-quality` after each task. Invoke `python-quality` after any Python edit (only B-3a has one).
- Commands:
  - Web unit, one file: `cd frontend/apps/web && bunx vitest run <path>`.
  - Package unit: `cd frontend/packages/<pkg> && bunx vitest run <path>`.
  - Frontend gate: `cd frontend && bun run gate`. Full gate: `make gate` from the worktree root.
  - Contract tests: `bun test ./tests/*.test.ts` from the worktree root.
  - Time-travel e2e: `cd frontend/apps/web && bun run test:e2e:time-travel --project=<chromium|webkit|iphone-webkit|iphone-15-webkit>` (the config builds with `VITE_EXIT_GATE_HOOKS=1` and serves on 4216).

### Mutation helper (every PR)

Save once as `"${TMPDIR:-/tmp}/almamesh-mutate.py"` and `export MUTATE="${TMPDIR:-/tmp}/almamesh-mutate.py"`. It is the same helper as Inc A–D:

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

Every mutation's NEW text contains the marker `MUTANT_TT`, either in a comment (`/* MUTANT_TT */`) or a string. After each PR's mutation block, run the **restore check**:

```bash
git diff --exit-code -- frontend backend && echo "tree clean"
! git grep -n "MUTANT_TT" -- frontend backend && echo "no mutation left"
```

Both lines must print. The verdict is the helper's exit code (0 = `KILLED`), never grepped test output. Paste every `KILLED` line, and both restore-check lines, into the PR's mutation table.

## Review Focus

These are the inputs most likely to bite a real person that the spec implies but does not name. Each has a test in the task shown.

1. **Switching profile while a moment is set.** The moment is keyed by profile. Profile B must not show profile A's March 2019 card, and switching back to A shows A's moment again. Test: A1 ("keys the moment by profile").
2. **The pin save fails (OPFS full, quota) while travelling from the Dashboard with AI on.** The sheet stays open and says "Couldn't save this on your device", and the Dashboard does not move. Test: A1 ("a failed pin save moves nothing").
3. **A moment changes while the ~30 s sky compute is running.** Pick March 2019, then quickly pick 2027. The 2019 result must never paint under the 2027 banner. Test: A5 ("a late result for an old moment is dropped").
4. **A city lookup with accents, mixed case or a country qualifier after the move to SQLite.** "bogota", "Bogotá", "BOGOTÁ, Colombia", "Sao Paulo", "Paris FR" give the same top 5 as today. Test: B3 (parity corpus).
5. **A tampered or stale `period_sky` row.** A row from an old engine bundle, or one carrying a boot-signed receipt, is never served. Tests: B4 ("refuses a row that carries a receipt", "an old engine hash is a miss and is swept").

---
# PR A — Parts 1 + 2: Dashboard "Time travel" button that works without AI

Claims touched: **"Time travel is one tap away on every device."** (new, added to the README), **"The chart is pure calculation; AI is optional."**, **"Nothing leaves your browser with AI off."**

### Task A1: The travel seam `lib/timeTravel.ts`

**Files:**
- Create: `W/src/lib/timeTravel.ts`
- Test: `W/src/lib/__tests__/timeTravel.test.ts`

**Interfaces:**
- Consumes: `startPinnedThread(profileId, chartId, asOf): Promise<string>`, `repinThread(threadId, asOf): Promise<void>`, `todayThread(profileId, chartId): Promise<string>` (`lib/timeTravelThreads.ts:21,25,38`); `chatAsOfProblem(value: unknown): string | undefined` (`@almamesh/store`); `endsBeforeBirthYear(period, birthYear)` and `describeLlmStatus()` (`@almamesh/llm`); `birthYearOf(birth)` (`lib/periodChart.ts:73`); `useChatStore.getState().listThreads(profileId)` and `.threads`.
- Produces (used by A2, A4, A5, C2):
  ```ts
  export type TravelSource = 'dashboard-sheet' | 'chat-sheet' | 'chat-tool';
  export interface TravelRequest { readonly asOf: ChatThreadAsOf; readonly source: TravelSource; }
  export type TravelThread = 'new' | 'latest' | { readonly id: string };
  export interface TravelTarget { readonly profileId: string; readonly chartId: string | null; readonly thread: TravelThread; }
  export interface TravelDeps { aiConfigured(): boolean; birthYear(chartId: string | null): number | undefined; }
  export interface TravelOutcome { readonly threadId: string | undefined; }
  export class TimeTravelRefusedError extends Error { readonly reason: 'malformed' | 'before_birth'; }
  export const useTimeTravelStore: UseBoundStore<StoreApi<TimeTravelState>>;
  export function applyTravel(request: TravelRequest, target: TravelTarget, deps?: TravelDeps): Promise<TravelOutcome>;
  export function applyBackToToday(target: Omit<TravelTarget, 'thread'>, deps?: TravelDeps): Promise<TravelOutcome>;
  export interface TimeTravelController { readonly moment: ChatThreadAsOf | undefined; travel(request: TravelRequest): Promise<void>; backToToday(): Promise<void>; }
  export function useTimeTravel(profileId: string | null, chartId: string | null): TimeTravelController;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// W/src/lib/__tests__/timeTravel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@almamesh/store';

const save = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock('../storeSaved', () => ({
  waitForStoreSaved: async () => {
    save.calls += 1;
    if (save.fail) throw Object.assign(new Error('Saving chat failed.'), { name: 'StoreSaveError' });
  },
}));

import { applyBackToToday, applyTravel, TimeTravelRefusedError, useTimeTravelStore, type TravelDeps } from '../timeTravel';

const MARCH_2019 = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' } as const;
const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const aiOn: TravelDeps = { aiConfigured: () => true, birthYear: () => 1990 };
const aiOff: TravelDeps = { aiConfigured: () => false, birthYear: () => 1990 };
const DASH = { profileId: 'p1', chartId: 'c1', thread: 'latest' } as const;
const moment = (profileId = 'p1') => useTimeTravelStore.getState().moments[profileId];

function reset() {
  save.calls = 0;
  save.fail = false;
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useTimeTravelStore.setState({ moments: {} });
}
beforeEach(reset);
afterEach(reset);

describe('applyTravel: one path for every way to travel', () => {
  it('with AI off, sets the Dashboard moment and touches no chat thread', async () => {
    const out = await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOff);
    expect(moment()).toEqual(MARCH_2019);
    expect(out.threadId).toBeUndefined();
    expect(useChatStore.getState().listThreads('p1')).toEqual([]);
    expect(save.calls).toBe(0);
  });

  it('with AI on and no pinned latest thread, starts a pinned thread and sets the moment', async () => {
    const out = await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOn);
    expect(out.threadId).toBeDefined();
    expect(useChatStore.getState().threads[out.threadId as string]?.as_of).toEqual(MARCH_2019);
    expect(moment()).toEqual(MARCH_2019);
  });

  it("with AI on and a pinned latest thread, repins it (no second thread)", async () => {
    const first = await applyTravel({ asOf: YEAR_2027, source: 'dashboard-sheet' }, DASH, aiOn);
    const second = await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOn);
    expect(second.threadId).toBe(first.threadId);
    expect(useChatStore.getState().listThreads('p1')).toHaveLength(1);
    expect(useChatStore.getState().threads[first.threadId as string]?.as_of).toEqual(MARCH_2019);
  });

  it("thread 'new' always starts a pinned thread, as the chat ⏳ button does today", async () => {
    await applyTravel({ asOf: YEAR_2027, source: 'chat-sheet' }, { ...DASH, thread: 'new' }, aiOn);
    await applyTravel({ asOf: MARCH_2019, source: 'chat-sheet' }, { ...DASH, thread: 'new' }, aiOn);
    expect(useChatStore.getState().listThreads('p1')).toHaveLength(2);
  });

  it('a failed pin save moves nothing: no moment, no thread, and it rethrows', async () => {
    save.fail = true;
    await expect(applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOn)).rejects.toThrow('Saving chat failed.');
    expect(moment()).toBeUndefined();
    expect(useChatStore.getState().listThreads('p1')).toEqual([]);
  });

  it('refuses a moment that ends before the birth year, never clamps it', async () => {
    const before = { start: '1989-01-01', end: '1989-12-31', granularity: 'year' } as const;
    await expect(applyTravel({ asOf: before, source: 'dashboard-sheet' }, DASH, aiOff)).rejects.toMatchObject({ reason: 'before_birth' });
    expect(moment()).toBeUndefined();
  });

  it('refuses a malformed moment and names the problem', async () => {
    const bad = { start: '2019-03-01', end: '2019-02-30', granularity: 'month' } as const;
    const refusal = applyTravel({ asOf: bad, source: 'chat-tool' }, DASH, aiOff);
    await expect(refusal).rejects.toBeInstanceOf(TimeTravelRefusedError);
    await expect(refusal).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('keys the moment by profile', async () => {
    await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOff);
    expect(moment('p2')).toBeUndefined();
    await applyTravel({ asOf: YEAR_2027, source: 'dashboard-sheet' }, { ...DASH, profileId: 'p2' }, aiOff);
    expect(moment('p1')).toEqual(MARCH_2019);
    expect(moment('p2')).toEqual(YEAR_2027);
  });
});

describe('applyBackToToday', () => {
  it('clears the moment; with AI off it opens no thread', async () => {
    await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOff);
    const out = await applyBackToToday({ profileId: 'p1', chartId: 'c1' }, aiOff);
    expect(moment()).toBeUndefined();
    expect(out.threadId).toBeUndefined();
  });

  it('with AI on, also returns the today thread', async () => {
    await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOn);
    const out = await applyBackToToday({ profileId: 'p1', chartId: 'c1' }, aiOn);
    expect(out.threadId).toBeDefined();
    expect(useChatStore.getState().threads[out.threadId as string]?.as_of).toBeUndefined();
    expect(moment()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravel.test.ts`
Expected: FAIL, `Failed to resolve import "../timeTravel"`.

- [ ] **Step 3: Implement**

```ts
// W/src/lib/timeTravel.ts
/**
 * The one way to travel to a moment (spec "One code path for travel to a
 * moment"). The Dashboard sheet, the chat sheet and banner, and the chat tool
 * all call applyTravel / applyBackToToday, so the same input gives the same
 * `as_of` and the same saves.
 *
 * Order (plan ruling 1): check, then save the chat pin (AI on only), then set
 * the Dashboard moment. A failed save moves nothing and rethrows.
 * The Dashboard moment is view state: memory only, never persisted (Ruling 1).
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { describeLlmStatus, endsBeforeBirthYear } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData } from '@almamesh/shared-types';
import { chatAsOfProblem, useChartLibraryStore, useChatStore } from '@almamesh/store';

import { birthYearOf } from './periodChart';
import { repinThread, startPinnedThread, todayThread } from './timeTravelThreads';

export type TravelSource = 'dashboard-sheet' | 'chat-sheet' | 'chat-tool';
export interface TravelRequest { readonly asOf: ChatThreadAsOf; readonly source: TravelSource; }
/** 'new': always a new pinned thread. { id }: repin it if pinned, else a new pinned thread. 'latest': the thread chat shows. */
export type TravelThread = 'new' | 'latest' | { readonly id: string };
export interface TravelTarget { readonly profileId: string; readonly chartId: string | null; readonly thread: TravelThread; }
export interface TravelDeps { aiConfigured(): boolean; birthYear(chartId: string | null): number | undefined; }
export interface TravelOutcome { readonly threadId: string | undefined; }

export class TimeTravelRefusedError extends Error {
  constructor(readonly reason: 'malformed' | 'before_birth', detail: string) {
    super(`Time travel refused (${reason}): ${detail}`);
    this.name = 'TimeTravelRefusedError';
  }
}

interface TimeTravelState {
  readonly moments: Readonly<Record<string, ChatThreadAsOf>>;
  setMoment(profileId: string, asOf: ChatThreadAsOf | undefined): void;
}

export const useTimeTravelStore = create<TimeTravelState>((set) => ({
  moments: {},
  setMoment: (profileId, asOf) => set((state) => {
    const moments = { ...state.moments };
    if (asOf) moments[profileId] = asOf;
    else delete moments[profileId];
    return { moments };
  }),
}));

const DEFAULT_DEPS: TravelDeps = {
  aiConfigured: () => describeLlmStatus().configured,
  birthYear: (chartId) => birthYearOf(chartId
    ? (useChartLibraryStore.getState().getChart(chartId)?.birth_data as ProcessedBirthData | undefined)
    : undefined),
};

function check(asOf: ChatThreadAsOf, birthYear: number | undefined): void {
  const problem = chatAsOfProblem(asOf);
  if (problem) throw new TimeTravelRefusedError('malformed', problem);
  if (endsBeforeBirthYear(asOf, birthYear)) throw new TimeTravelRefusedError('before_birth', asOf.start);
}

function threadToMove(target: TravelTarget): string | undefined {
  if (target.thread === 'new') return undefined;
  const id = target.thread === 'latest'
    ? useChatStore.getState().listThreads(target.profileId)[0]?.id
    : target.thread.id;
  return id && useChatStore.getState().threads[id]?.as_of ? id : undefined;
}

async function pinChat(asOf: ChatThreadAsOf, target: TravelTarget): Promise<string> {
  const pinned = threadToMove(target);
  if (!pinned) return startPinnedThread(target.profileId, target.chartId, asOf);
  await repinThread(pinned, asOf);
  return pinned;
}

export async function applyTravel(request: TravelRequest, target: TravelTarget, deps: TravelDeps = DEFAULT_DEPS): Promise<TravelOutcome> {
  check(request.asOf, deps.birthYear(target.chartId));
  const threadId = deps.aiConfigured() ? await pinChat(request.asOf, target) : undefined;
  useTimeTravelStore.getState().setMoment(target.profileId, request.asOf);
  return { threadId };
}

export async function applyBackToToday(target: Omit<TravelTarget, 'thread'>, deps: TravelDeps = DEFAULT_DEPS): Promise<TravelOutcome> {
  const threadId = deps.aiConfigured() ? await todayThread(target.profileId, target.chartId) : undefined;
  useTimeTravelStore.getState().setMoment(target.profileId, undefined);
  return { threadId };
}

export interface TimeTravelController {
  readonly moment: ChatThreadAsOf | undefined;
  travel(request: TravelRequest): Promise<void>;
  backToToday(): Promise<void>;
}

/** The Dashboard's handle on the seam. Moves the profile's latest chat thread (plan ruling 2). */
export function useTimeTravel(profileId: string | null, chartId: string | null): TimeTravelController {
  const moment = useTimeTravelStore((s) => (profileId ? s.moments[profileId] : undefined));
  const travel = useCallback(async (request: TravelRequest) => {
    if (profileId) await applyTravel(request, { profileId, chartId, thread: 'latest' });
  }, [profileId, chartId]);
  const backToToday = useCallback(async () => {
    if (profileId) await applyBackToToday({ profileId, chartId });
  }, [profileId, chartId]);
  return { moment, travel, backToToday };
}
```

Check before running: `useChartLibraryStore` and `useChatStore` are exported by `@almamesh/store` (`App.rootRoute.test.tsx:4`, `lib/timeTravelThreads.ts:7`); `ProcessedBirthData` is from `@almamesh/shared-types` (`lib/periodChart.ts:14`); `getChart` is the method `Dashboard.tsx:274` uses. If `chatAsOfProblem` accepts `2019-02-30` as a month end, the malformed test fails: then use the input `{ start: '2019-03-01', end: '2019-03-30', granularity: 'month' }` (not the month's last day), which the Inc D shape check refuses (Inc D Ruling 7).

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravel.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/timeTravel.ts frontend/apps/web/src/lib/__tests__/timeTravel.test.ts
git commit -m "feat(time-travel): one seam for travelling to a moment, with an in-memory Dashboard moment"
```

### Task A2: The chat sheet and banner go through the seam

**Files:**
- Modify: `W/src/hooks/useChatThread.ts:438-456` (`pin`, `repin`, `backToToday`)
- Test: `W/src/hooks/__tests__/useChatThread.timeTravel.test.tsx` (add cases)

**Interfaces:**
- Consumes: `applyTravel`, `applyBackToToday`, `useTimeTravelStore` (A1).
- Produces: `UseChatThreadResult` gains `travelFromTool(asOf: ChatThreadAsOf): Promise<void>` (used by C2). `pin`, `repin`, `backToToday` keep their signatures.

- [ ] **Step 1: Write the failing tests**

Add to `useChatThread.timeTravel.test.tsx`, reusing that file's existing render helper, its `waitForStoreSaved` mock and its AI-configured setup (read the top of the file and follow it):

```tsx
import { useTimeTravelStore } from '../../lib/timeTravel';

describe('the chat sheet travels through the seam', () => {
  beforeEach(() => useTimeTravelStore.setState({ moments: {} }));

  it('Go in chat also sets the Dashboard moment', async () => {
    const { result } = renderThread('p1', 'c1');
    await act(() => result.current.pin(MARCH_2019));
    expect(useTimeTravelStore.getState().moments.p1).toEqual(MARCH_2019);
    expect(result.current.asOf).toEqual(MARCH_2019);
  });

  it('Change in chat repins the open thread and moves the Dashboard moment', async () => {
    const { result } = renderThread('p1', 'c1');
    await act(() => result.current.pin(YEAR_2027));
    const tid = result.current.threadId;
    await act(() => result.current.repin(MARCH_2019));
    expect(result.current.threadId).toBe(tid);
    expect(useTimeTravelStore.getState().moments.p1).toEqual(MARCH_2019);
  });

  it('Back to today in chat clears the Dashboard moment', async () => {
    const { result } = renderThread('p1', 'c1');
    await act(() => result.current.pin(MARCH_2019));
    await act(() => result.current.backToToday());
    expect(useTimeTravelStore.getState().moments.p1).toBeUndefined();
    expect(result.current.asOf).toBeUndefined();
  });

  it('travelFromTool in an unpinned thread opens a pinned thread right away (Ruling 7)', async () => {
    const { result } = renderThread('p1', 'c1');
    await act(() => result.current.travelFromTool(MARCH_2019));
    expect(result.current.asOf).toEqual(MARCH_2019);
    expect(useTimeTravelStore.getState().moments.p1).toEqual(MARCH_2019);
  });
});
```

If the file's helper has another name than `renderThread`, or its constants differ, use the file's names; define `MARCH_2019` and `YEAR_2027` as in A1 if missing.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend/apps/web && bunx vitest run src/hooks/__tests__/useChatThread.timeTravel.test.tsx`
Expected: FAIL. The first three fail with `expected undefined to deeply equal {...}` (the moment is never set); the last with `result.current.travelFromTool is not a function`.

- [ ] **Step 3: Implement**

Replace `pin`, `repin` and `backToToday` (`useChatThread.ts:438-456`) with:

```ts
  const go = useCallback(async (asOf: ChatThreadAsOf, source: TravelSource, thread: TravelThread) => {
    if (!profileId) return;
    const { threadId: moved } = await applyTravel({ asOf, source }, { profileId, chartId, thread });
    if (moved) setSelectedThreadId(moved);
  }, [profileId, chartId]);
  const pin = useCallback((asOf: ChatThreadAsOf) => go(asOf, 'chat-sheet', 'new'), [go]);
  const repin = useCallback(async (asOf: ChatThreadAsOf) => {
    if (threadId && activeThread?.as_of) await go(asOf, 'chat-sheet', { id: threadId });
  }, [go, threadId, activeThread?.as_of]);
  const travelFromTool = useCallback(
    (asOf: ChatThreadAsOf) => go(asOf, 'chat-tool', threadId ? { id: threadId } : 'new'),
    [go, threadId],
  );
  const backToToday = useCallback(async () => {
    if (!profileId) return;
    const { threadId: today } = await applyBackToToday({ profileId, chartId });
    if (today) setSelectedThreadId(today);
  }, [profileId, chartId]);
```

Add `travelFromTool: (asOf: ChatThreadAsOf) => Promise<void>;` to `UseChatThreadResult` (`:71-92`) and to the returned object (`:458-469`). Import `applyBackToToday, applyTravel, type TravelSource, type TravelThread` from `'../lib/timeTravel'`. Remove the now-unused imports of `startPinnedThread`, `repinThread`, `todayThread`.

Chat only runs with AI on, so `applyTravel`'s `aiConfigured()` is true here, and the threads behave exactly as before.

- [ ] **Step 4: Run to verify it passes, and the old chat tests still pass**

Run: `cd frontend/apps/web && bunx vitest run src/hooks/__tests__/useChatThread.timeTravel.test.tsx src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx src/lib/__tests__/timeTravelThreads.test.ts`
Expected: PASS. If an old test mocks `../lib/timeTravelThreads` and now sees no call, the seam calls it from `lib/timeTravel.ts`; mock the same module path from the test (it resolves to the same module), and do not change the assertion.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/hooks/useChatThread.ts frontend/apps/web/src/hooks/__tests__/useChatThread.timeTravel.test.tsx
git commit -m "refactor(time-travel): chat sheet, banner and Back to today go through the travel seam"
```

### Task A3: Banner props for the Dashboard, and the composer label on phones

**Files:**
- Modify: `W/src/components/features/chat/TimeTravelBanner.tsx`
- Modify: `W/src/components/features/chat/ChatPanel.tsx:298`
- Test: `W/src/components/features/chat/__tests__/TimeTravelBanner.test.tsx`, `W/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx`

**Interfaces:**
- Produces: `TimeTravelBanner` props gain `testIdPrefix?: string` (default `'time-travel'`) and `about?: string` (default `t('time_travel.banner.about')`). Testids become `${testIdPrefix}-banner`, `-badge`, `-title`, `-change`, `-back`, `-back-failed`.

- [ ] **Step 1: Write the failing tests**

In `TimeTravelBanner.test.tsx` add:

```tsx
it('takes a testid prefix and its own "about" line for the Dashboard', () => {
  render(<TimeTravelBanner asOf={MARCH_2019} language="en" onChange={() => {}} onBack={() => {}}
    testIdPrefix="dashboard-time-travel" about="the cards below are about this moment" />);
  expect(screen.getByTestId('dashboard-time-travel-banner')).toHaveTextContent('the cards below are about this moment');
  expect(screen.getByTestId('dashboard-time-travel-title')).toHaveTextContent('Time travel · March 2019');
  expect(screen.getByTestId('dashboard-time-travel-change')).toBeInTheDocument();
  expect(screen.getByTestId('dashboard-time-travel-back')).toBeInTheDocument();
  expect(screen.queryByTestId('time-travel-banner')).toBeNull();
});
```

(`MARCH_2019` as in A1; if the file has no such constant, add it.)

In `ChatPanel.timeTravel.test.tsx` add (using the file's AI-on render helper):

```tsx
it('the composer button shows its text label at every width (no sm:inline)', () => {
  renderPanel();
  const label = screen.getByTestId('time-travel-button').querySelector('span:not([aria-hidden])');
  expect(label).toHaveTextContent('Time travel');
  expect(label?.className ?? '').not.toMatch(/\bhidden\b/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend/apps/web && bunx vitest run src/components/features/chat/__tests__/TimeTravelBanner.test.tsx src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx`
Expected: FAIL. The banner test fails with `Unable to find an element by: [data-testid="dashboard-time-travel-banner"]`; the composer test with `expected 'ml-1 hidden sm:inline' not to match /\bhidden\b/`.

- [ ] **Step 3: Implement**

`TimeTravelBanner.tsx`: add to the props interface

```ts
  /** Testid prefix. Default 'time-travel' (chat). The Dashboard passes 'dashboard-time-travel'. */
  readonly testIdPrefix?: string;
  /** The "about" line. Default: chat's "answers are about this period". */
  readonly about?: string;
```

Destructure `testIdPrefix = 'time-travel', about`, compute `const id = (part: string) => `${testIdPrefix}-${part}`;`, replace each hard-coded testid (`time-travel-banner` → `id('banner')`, and likewise `badge`, `title`, `change`, `back`, `back-failed`), and render `{about ?? t('time_travel.banner.about')}` in place of `{t('time_travel.banner.about')}`. Update the file's first comment to mention the Dashboard.

`ChatPanel.tsx:298`: change `<span className="ml-1 hidden sm:inline">` to `<span className="ml-1">`.

- [ ] **Step 4: Run to verify they pass**

Same command. Expected: PASS, and all older banner and panel tests still pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/components/features/chat/TimeTravelBanner.tsx frontend/apps/web/src/components/features/chat/ChatPanel.tsx frontend/apps/web/src/components/features/chat/__tests__/TimeTravelBanner.test.tsx frontend/apps/web/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx
git commit -m "feat(time-travel): banner takes a testid prefix and copy; composer label shows on phones"
```

### Task A4: The Dashboard button, sheet overlay, banner, copy and README claim

**Files:**
- Create: `W/src/components/features/dashboard/DashboardTimeTravelSheet.tsx`
- Modify: `W/src/pages/Dashboard.tsx` (button between `:760` and `:761`; banner and sheet near the top of the page body; imports)
- Modify: `W/src/locales/{en,es,pt}/dashboard.json` (`actions.time_travel`, new `time_travel` block)
- Modify: `README.md:185-211` (`## What you can do`)
- Test: `W/src/pages/__tests__/Dashboard.timeTravel.test.tsx` (new, modelled on `Dashboard.chatZone.test.tsx`)

**Interfaces:**
- Consumes: `useTimeTravel` (A1); `TimeTravelBanner` with `testIdPrefix`/`about` (A3); `TimeTravelSheet` props `{ open, current?, birthYear?, today, onGo, onClose }` (`TimeTravelSheet.tsx:16-27`); `viewerTodayDay(now)` (`lib/chatAgentTools`, as `ChatPanel.tsx:103` uses it); `birthYearOf` (`lib/periodChart`).
- Produces: testids `dashboard-time-travel-button`, `dashboard-time-travel-sheet-overlay`, `dashboard-time-travel-banner` (+ `-title`, `-change`, `-back`); `DashboardTimeTravelSheet` props `{ open: boolean; current?: ChatThreadAsOf; birthYear?: number; today: string; onGo(asOf): Promise<void>; onClose(): void }`.

Copy (en; es and pt in the same commit):

```json
"actions": { "...": "...", "time_travel": "Time travel" },
"time_travel": {
  "banner_about": "the cards below are about this moment",
  "dashas_only": "This device shows dashas only for other dates, to stay within memory.",
  "moment_title": "At this moment",
  "maha": "Main period (maha dasha)",
  "antar": "Sub-period (antar dasha)",
  "transits_title": "Planets in the sky then",
  "working": "Working out the sky for {{period}}… (about 30 s)",
  "failed": "Couldn't work out the sky for this moment. Try again.",
  "retry": "Try again",
  "today_label": "Today"
}
```

es: `"time_travel": "Viaje en el tiempo"`, `banner_about` "las tarjetas de abajo hablan de este momento", `dashas_only` "Este dispositivo muestra solo los dashas para otras fechas, para no gastar demasiada memoria.", `moment_title` "En este momento", `maha` "Periodo principal (maha dasha)", `antar` "Subperiodo (antar dasha)", `transits_title` "Los planetas en el cielo entonces", `working` "Calculando el cielo para {{period}}… (unos 30 s)", `failed` "No se pudo calcular el cielo para este momento. Inténtalo de nuevo.", `retry` "Reintentar", `today_label` "Hoy".
pt: `"time_travel": "Viagem no tempo"`, `banner_about` "os cartões abaixo falam deste momento", `dashas_only` "Este aparelho mostra só os dashas para outras datas, para não gastar memória demais.", `moment_title` "Neste momento", `maha` "Período principal (maha dasha)", `antar` "Subperíodo (antar dasha)", `transits_title` "Os planetas no céu naquela época", `working` "Calculando o céu para {{period}}… (cerca de 30 s)", `failed` "Não foi possível calcular o céu para este momento. Tente de novo.", `retry` "Tentar de novo", `today_label` "Hoje".

All keys land now (A5 uses the card keys), so the parity tests pass at every commit.

- [ ] **Step 1: Write the failing tests**

Create `Dashboard.timeTravel.test.tsx`. Copy the module mocks, providers and seeded chart from `Dashboard.chatZone.test.tsx` (`vi.mock('@almamesh/llm', importOriginal)`, `../../lib/localChartRead`, `../../providers/chartEngineContext`, `../../components/features/dashboard`, `../../lib/chatToolset`; `QueryClientProvider` + `MemoryRouter initialEntries={['/dashboard']}`). Add a mock for the period loader so nothing computes: `vi.mock('../../lib/periodChart', async (orig) => ({ ...(await orig()), createPeriodChartLoader: () => () => new Promise(() => {}) }))`. Then:

```tsx
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useTimeTravelStore } from '../../lib/timeTravel';

beforeEach(() => useTimeTravelStore.setState({ moments: {} }));

describe('Dashboard Time travel', () => {
  it('shows a labelled, enabled button with AI off', () => {
    renderDashboard({ ai: 'off' });
    const button = screen.getByTestId('dashboard-time-travel-button');
    expect(button).toHaveTextContent('Time travel');
    expect(button).toBeEnabled();
    expect(button.className).toContain('min-h-11');
    expect(button.querySelector('.hidden')).toBeNull();
  });

  it('sits immediately before the timeline button in the header', () => {
    renderDashboard({ ai: 'off' });
    const timeline = screen.getByTestId(/^(generate|regenerate)-timeline$/);
    expect(timeline.previousElementSibling).toBe(screen.getByTestId('dashboard-time-travel-button'));
  });

  it('opens the sheet in a fixed overlay, and Cancel returns focus to the button', async () => {
    renderDashboard({ ai: 'off' });
    const button = screen.getByTestId('dashboard-time-travel-button');
    button.focus();
    fireEvent.click(button);
    const overlay = screen.getByTestId('dashboard-time-travel-sheet-overlay');
    expect(overlay.className).toContain('fixed');
    expect(within(overlay).getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('time-travel-cancel'));
    expect(screen.queryByTestId('time-travel-sheet')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Escape closes the sheet and returns focus to the button', () => {
    renderDashboard({ ai: 'off' });
    const button = screen.getByTestId('dashboard-time-travel-button');
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByTestId('time-travel-sheet'), { key: 'Escape' });
    expect(screen.queryByTestId('time-travel-sheet')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('with AI off, Go shows the Dashboard banner for the moment', async () => {
    renderDashboard({ ai: 'off' });
    fireEvent.click(screen.getByTestId('dashboard-time-travel-button'));
    fireEvent.click(screen.getByTestId('time-travel-tab-year'));
    fireEvent.change(screen.getByTestId('time-travel-year'), { target: { value: '2019' } });
    await act(async () => { fireEvent.click(screen.getByTestId('time-travel-go')); });
    expect(screen.getByTestId('dashboard-time-travel-title')).toHaveTextContent('Time travel · 2019');
    expect(screen.getByTestId('dashboard-time-travel-banner')).toHaveTextContent('the cards below are about this moment');
  });

  it('Change reopens the sheet on the current moment; Back to today removes the banner', async () => {
    renderDashboard({ ai: 'off' });
    act(() => useTimeTravelStore.getState().setMoment(PROFILE_ID, { start: '2019-01-01', end: '2019-12-31', granularity: 'year' }));
    fireEvent.click(screen.getByTestId('dashboard-time-travel-change'));
    expect(screen.getByTestId('time-travel-year')).toHaveValue('2019');
    fireEvent.click(screen.getByTestId('time-travel-cancel'));
    await act(async () => { fireEvent.click(screen.getByTestId('dashboard-time-travel-back')); });
    expect(screen.queryByTestId('dashboard-time-travel-banner')).toBeNull();
  });
});
```

`renderDashboard({ ai })` is a local helper that hydrates AI settings as `Dashboard.chatZone.test.tsx:60` does for `'on'` (`hydrateLlmSettings` + `writeLlmSettings(openRouterPreset(...))`) and clears them for `'off'`, then renders. `PROFILE_ID` is the active profile id that file seeds.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend/apps/web && bunx vitest run src/pages/__tests__/Dashboard.timeTravel.test.tsx`
Expected: FAIL, `Unable to find an element by: [data-testid="dashboard-time-travel-button"]`.

- [ ] **Step 3: Implement the overlay**

```tsx
// W/src/components/features/dashboard/DashboardTimeTravelSheet.tsx
/**
 * The chat's Time travel sheet, on the Dashboard. The sheet is `absolute
 * inset-x-0 bottom-0` and needs a positioned parent: this fixed scrim is that
 * parent. role="dialog", the focus trap and return-focus stay on the sheet.
 */
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { TimeTravelSheet } from '../chat/TimeTravelSheet';

export interface DashboardTimeTravelSheetProps {
  readonly open: boolean;
  readonly current?: ChatThreadAsOf;
  readonly birthYear?: number;
  readonly today: string;
  readonly onGo: (asOf: ChatThreadAsOf) => Promise<void>;
  readonly onClose: () => void;
}

export function DashboardTimeTravelSheet(props: DashboardTimeTravelSheetProps) {
  if (!props.open) return null;
  return (
    <div data-testid="dashboard-time-travel-sheet-overlay" className="fixed inset-0 z-50 bg-black/50">
      <TimeTravelSheet open current={props.current} birthYear={props.birthYear} today={props.today}
        onGo={props.onGo} onClose={props.onClose} />
    </div>
  );
}
```

Clicking the scrim does not close the sheet (the sheet has Cancel and Esc), so a stray tap on a phone never loses a half-picked moment.

- [ ] **Step 4: Wire the Dashboard**

In `Dashboard.tsx`:

```tsx
import { TimeTravelBanner } from "../components/features/chat/TimeTravelBanner";
import { DashboardTimeTravelSheet } from "../components/features/dashboard/DashboardTimeTravelSheet";
import { viewerTodayDay } from "../lib/chatAgentTools";
import { useTimeTravel } from "../lib/timeTravel";
import { birthYearOf } from "../lib/periodChart"; // if not already imported
```

After `activeProfileId` (`:170`):

```tsx
  const timeTravel = useTimeTravel(activeProfileId, chartId);
  const [travelSheet, setTravelSheet] = useState<'closed' | 'new' | 'change'>('closed');
  const [travelBack, setTravelBack] = useState<'idle' | 'busy' | 'failed'>('idle');
  const travelBirthYear = birthYearOf(chartId
    ? (useChartLibraryStore.getState().getChart(chartId)?.birth_data as ProcessedBirthData | undefined)
    : undefined);
  const goToMoment = (asOf: ChatThreadAsOf) => timeTravel.travel({ asOf, source: 'dashboard-sheet' });
  const backFromMoment = async () => {
    setTravelBack('busy');
    try { await timeTravel.backToToday(); setTravelBack('idle'); } catch { setTravelBack('failed'); }
  };
```

At module level in `Dashboard.tsx` (the spec's 44 px floor, named so a mutation can target it):

```tsx
/** 44×44 CSS px, the touch-target floor (spec Part 1). Pinned by Dashboard.timeTravel.test.tsx and the @iphone15 box check. */
const TIME_TRAVEL_BUTTON_SIZE = "min-h-11 min-w-11";
```

Between `:760` and `:761` (just before the timeline button), using the exact class of the reading/timeline buttons:

```tsx
              <button
                type="button"
                data-testid="dashboard-time-travel-button"
                onClick={() => setTravelSheet('new')}
                disabled={!chartId}
                className={`inline-flex ${TIME_TRAVEL_BUTTON_SIZE} items-center gap-1.5 whitespace-nowrap rounded-md border border-ui-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-gold disabled:cursor-not-allowed disabled:border-ui-border/60 disabled:text-text-tertiary disabled:hover:border-ui-border/60`}
              >
                <span aria-hidden="true">⏳</span>
                <span>{t("dashboard:actions.time_travel")}</span>
              </button>
```

Right after the `IdentityStrip` element closes (`:797`), render the banner and the overlay:

```tsx
        {timeTravel.moment && (
          <TimeTravelBanner asOf={timeTravel.moment} language={i18n.language}
            testIdPrefix="dashboard-time-travel" about={t("dashboard:time_travel.banner_about")}
            onChange={() => setTravelSheet('change')} onBack={() => void backFromMoment()}
            backBusy={travelBack === 'busy'} backFailed={travelBack === 'failed'} />
        )}
        <DashboardTimeTravelSheet open={travelSheet !== 'closed'}
          current={travelSheet === 'change' ? timeTravel.moment : undefined}
          birthYear={travelBirthYear} today={viewerTodayDay(new Date())}
          onGo={goToMoment} onClose={() => setTravelSheet('closed')} />
```

Use the page's existing `i18n` handle (from its `useTranslation` call at `:107`) and existing `ChatThreadAsOf`/`ProcessedBirthData` type imports (add them from `@almamesh/shared-types` if missing). The button never reads `aiConfigured`.

- [ ] **Step 5: Copy and README**

Add the `dashboard.json` keys above in en, es, pt. In `README.md` under `## What you can do`, before the "Optionally turn on AI…" bullet, add:

```markdown
- Travel to any day, month or year with the ⏳ **Time travel** button on the Dashboard, on any device and with or without AI. You see the dashas and the planets for that moment, worked out on your device.
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd frontend/apps/web && bunx vitest run src/pages/__tests__/Dashboard.timeTravel.test.tsx src/locales/dashboard.parity.test.ts src/pages/__tests__/Dashboard.chatZone.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/src/components/features/dashboard/DashboardTimeTravelSheet.tsx frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/__tests__/Dashboard.timeTravel.test.tsx frontend/apps/web/src/locales/en/dashboard.json frontend/apps/web/src/locales/es/dashboard.json frontend/apps/web/src/locales/pt/dashboard.json README.md
git commit -m "feat(dashboard): Time travel button on every screen, with or without AI"
```

### Task A5: The moment card (dashas + transits), and "Today" labels

**Files:**
- Create: `W/src/lib/momentSky.ts`
- Create: `W/src/components/features/dashboard/DashboardMomentCard.tsx`
- Modify: `W/src/pages/Dashboard.tsx` (render the card under the banner; "Today" labels at `:1154-1156` and `:1162-1179`)
- Test: `W/src/lib/__tests__/momentSky.test.ts`, `W/src/components/features/dashboard/__tests__/DashboardMomentCard.test.tsx`

**Interfaces:**
- Consumes: `selectDashasForPeriod(dashas: VimshottariDasha, period: PeriodRange, birthYear?: number): PeriodDashas` (`@almamesh/llm`, `period-dashas.ts:87`); `restrictTransitsToPeriod(ctx: TransitContext, period: PeriodRange, multiDay: boolean): { context: TransitContext; notes }` (`@almamesh/llm`, `period-transits.ts:56`); `createPeriodChartLoader(input: { chart; profileKey; birth; engine; cache? }): (period, context: { now: Date; signal: AbortSignal }) => Promise<SiderealChart>` (`lib/periodChart.ts:44`); `toTransitCtx(raw): TransitCtx | undefined` (`@almamesh/store`); `TransitsPanel({ transitCtx })` (`components/features/predictive/TransitsPanel.tsx:262`); `devicePolicy().periodSkyComputeAllowed` (`@almamesh/browser`); `formatPinLabel` (`lib/timeTravelSheet`); `asOfKey` (`lib/pinnedPeriod`).
- Produces:
  ```ts
  export function momentPeriod(asOf: ChatThreadAsOf): PeriodRange;
  export type MomentSky =
    | { readonly kind: 'dashas-only' }
    | { readonly kind: 'working' }
    | { readonly kind: 'ready'; readonly transits: TransitCtx }
    | { readonly kind: 'failed' };
  export interface MomentSkyInput {
    readonly asOf: ChatThreadAsOf; readonly chart: SiderealChart | null; readonly profileKey: string;
    readonly birth: ProcessedBirthData | undefined; readonly engine: ChartEngineContextValue | null;
    /** Test seam. Default devicePolicy().periodSkyComputeAllowed. */ readonly skyAllowed?: boolean;
    /** Test seam. Default createPeriodChartLoader. */ readonly loader?: PeriodChartLoader;
  }
  export function useMomentSky(input: MomentSkyInput): { readonly sky: MomentSky; retry(): void };
  ```
  Card testids: `time-travel-moment-card`, `time-travel-moment-dasha` (with children `time-travel-moment-maha`, `time-travel-moment-antar`), `time-travel-moment-transits`, `time-travel-moment-working`, `time-travel-moment-dashas-only`, `time-travel-moment-failed`; labels `dashboard-today-label-life-atlas`, `dashboard-today-label-sky`.

- [ ] **Step 1: Write the failing hook tests**

```ts
// W/src/lib/__tests__/momentSky.test.ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePredictiveStore } from '@almamesh/store';

import { SKY_CHART } from './timingFixtures';
import { CHART } from './timingFixtures';
import { momentPeriod, useMomentSky, type MomentSkyInput } from '../momentSky';

const MARCH_2019 = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' } as const;
const YEAR_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

function input(over: Partial<MomentSkyInput> = {}): MomentSkyInput {
  return { asOf: MARCH_2019, chart: CHART, profileKey: 'p1', birth: undefined, engine: null, skyAllowed: true,
    loader: vi.fn(async () => SKY_CHART), ...over };
}

describe('momentPeriod', () => {
  it('is the moment, never today', () => {
    expect(momentPeriod(MARCH_2019)).toEqual({ start: '2019-03-01', end: '2019-03-31' });
  });
});

describe('useMomentSky', () => {
  it('on a device that cannot compute the sky, says dashas only and never calls the loader', () => {
    const loader = vi.fn();
    const { result } = renderHook(() => useMomentSky(input({ skyAllowed: false, loader })));
    expect(result.current.sky).toEqual({ kind: 'dashas-only' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('works, then shows the transits for the moment (asked for the moment, not today)', async () => {
    const loader = vi.fn(async () => SKY_CHART);
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    expect(result.current.sky.kind).toBe('working');
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
    expect(loader).toHaveBeenCalledWith({ start: '2019-03-01', end: '2019-03-31' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('a late result for an old moment is dropped', async () => {
    let finishOld: (value: typeof SKY_CHART) => void = () => {};
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook((props: MomentSkyInput) => useMomentSky(props), { initialProps: input({ loader }) });
    rerender(input({ loader, asOf: YEAR_2027 }));
    await act(async () => { finishOld(SKY_CHART); });
    expect(result.current.sky.kind).toBe('working');
  });

  it('a failed compute shows failed, and retry runs it again', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('engine_unavailable')).mockResolvedValueOnce(SKY_CHART);
    const { result } = renderHook(() => useMomentSky(input({ loader })));
    await waitFor(() => expect(result.current.sky.kind).toBe('failed'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.sky.kind).toBe('ready'));
  });

  it("never touches today's Life Atlas result in usePredictiveStore", async () => {
    const before = usePredictiveStore.getState();
    const ensure = vi.spyOn(before, 'ensurePredictive');
    const { result } = renderHook(() => useMomentSky(input({ loader: undefined, engine: null })));
    await waitFor(() => expect(result.current.sky.kind).not.toBe('working'));
    expect(ensure).not.toHaveBeenCalled();
    expect(usePredictiveStore.getState()).toBe(before);
  });
});
```

The last test uses the real `createPeriodChartLoader` with no engine, so it ends in `failed` (`PeriodSkyUnavailableError('engine_unavailable')`) without computing, and proves the moment path never writes the predictive store. `CHART` and `SKY_CHART` come from `lib/__tests__/timingFixtures.ts`; merge the two import lines into one.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/momentSky.test.ts`
Expected: FAIL, `Failed to resolve import "../momentSky"`.

- [ ] **Step 3: Implement the hook**

```ts
// W/src/lib/momentSky.ts
/**
 * The sky for a Dashboard moment: the period-sky queue (periodSkyCache, via
 * createPeriodChartLoader), trimmed to the moment. Never usePredictiveStore,
 * which holds today's Life Atlas (lib/periodSky.ts header). No AI is loaded or
 * called: restrictTransitsToPeriod is a pure selector.
 */
import { useCallback, useEffect, useState } from 'react';
import { devicePolicy } from '@almamesh/browser';
import type { SiderealChart } from '@almamesh/browser';
import { restrictTransitsToPeriod, type PeriodRange } from '@almamesh/llm';
import type { ChatThreadAsOf, ProcessedBirthData, TransitCtx } from '@almamesh/shared-types';
import { toTransitCtx } from '@almamesh/store';

import type { ChartEngineContextValue } from '../providers/chartEngineContext';
import { createPeriodChartLoader, type PeriodChartLoader } from './periodChart';
import { asOfKey } from './pinnedPeriod';

export type MomentSky =
  | { readonly kind: 'dashas-only' }
  | { readonly kind: 'working' }
  | { readonly kind: 'ready'; readonly transits: TransitCtx }
  | { readonly kind: 'failed' };

export interface MomentSkyInput {
  readonly asOf: ChatThreadAsOf;
  readonly chart: SiderealChart | null;
  readonly profileKey: string;
  readonly birth: ProcessedBirthData | undefined;
  readonly engine: ChartEngineContextValue | null;
  readonly skyAllowed?: boolean;
  readonly loader?: PeriodChartLoader;
}

export function momentPeriod(asOf: ChatThreadAsOf): PeriodRange {
  return { start: asOf.start, end: asOf.end };
}

async function computeSky(input: MomentSkyInput, chart: SiderealChart, signal: AbortSignal): Promise<MomentSky> {
  const load = input.loader ?? createPeriodChartLoader({ chart, profileKey: input.profileKey, birth: input.birth, engine: input.engine });
  const period = momentPeriod(input.asOf);
  const sky = await load(period, { now: new Date(), signal });
  if (!sky.transit_context) return { kind: 'failed' };
  const trimmed = restrictTransitsToPeriod(sky.transit_context, period, input.asOf.granularity !== 'day');
  const transits = toTransitCtx(trimmed.context);
  return transits ? { kind: 'ready', transits } : { kind: 'failed' };
}

export function useMomentSky(input: MomentSkyInput): { readonly sky: MomentSky; retry(): void } {
  const skyAllowed = input.skyAllowed ?? devicePolicy().periodSkyComputeAllowed;
  const [sky, setSky] = useState<MomentSky>(skyAllowed ? { kind: 'working' } : { kind: 'dashas-only' });
  const [attempt, setAttempt] = useState(0);
  const key = asOfKey(input.asOf);
  useEffect(() => {
    if (!skyAllowed || !input.chart) { setSky({ kind: 'dashas-only' }); return undefined; }
    const controller = new AbortController();
    setSky({ kind: 'working' });
    computeSky(input, input.chart, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setSky(next); })
      .catch(() => { if (!controller.signal.aborted) setSky({ kind: 'failed' }); });
    return () => controller.abort();
    // `input` is read through `key`, the chart and the attempt; listing it would rerun on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, input.chart, skyAllowed, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { sky, retry };
}
```

Check the imports against the real exports before running: `SiderealChart` is exported from `@almamesh/browser` (as `lib/periodChart.ts` imports it — copy that file's import), `ChartEngineContextValue` from `providers/chartEngineContext` (as `lib/periodChart.ts` imports it), `TransitCtx` from `@almamesh/shared-types`, `PeriodChartLoader` from `lib/periodChart.ts`. If the eslint config bans the disable comment, depend on `[key, input.chart, input.loader, input.engine, input.profileKey, input.birth, skyAllowed, attempt]` instead and keep the tests green.

- [ ] **Step 4: Run to verify the hook passes**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/momentSky.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing card test**

```tsx
// W/src/components/features/dashboard/__tests__/DashboardMomentCard.test.tsx
import '../../../../i18n/config';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FOUNDER_DASHAS } from '../../../../test/dashaFixtures';
import { DashboardMomentCard } from '../DashboardMomentCard';

const MARCH_2025 = { start: '2025-03-01', end: '2025-03-31', granularity: 'month' } as const;

describe('DashboardMomentCard', () => {
  it('shows the maha and antar at the moment, from the chart dasha list', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(screen.getByTestId('time-travel-moment-maha')).toHaveTextContent('Saturn');
    expect(screen.getByTestId('time-travel-moment-antar')).toHaveTextContent('Venus');
  });

  it('on a weak device, says dashas only (no transits table)', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'dashas-only' }} onRetry={() => {}} language="en" />);
    expect(screen.getByTestId('time-travel-moment-dashas-only')).toHaveTextContent('dashas only');
    expect(screen.queryByTestId('time-travel-moment-transits')).toBeNull();
  });

  it('while working, names the period in the progress line', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'working' }} onRetry={() => {}} language="en" />);
    expect(screen.getByTestId('time-travel-moment-working')).toHaveTextContent('Working out the sky for March 2025');
  });

  it('a failed compute offers Try again', () => {
    render(<DashboardMomentCard asOf={MARCH_2025} dashas={FOUNDER_DASHAS} birthYear={1980}
      sky={{ kind: 'failed' }} onRetry={() => {}} language="en" />);
    expect(screen.getByTestId('time-travel-moment-failed')).toHaveTextContent('Try again');
  });
});
```

Check `FOUNDER_DASHAS`'s Saturn maha (2017→2036) and Venus antar (2023-12-01→2027-01-31) in `src/test/dashaFixtures.ts` before running; pick a month inside both if they differ. `birthYear` must be at or before the fixture's first maha year.

- [ ] **Step 6: Run to verify it fails**

Run: `cd frontend/apps/web && bunx vitest run src/components/features/dashboard/__tests__/DashboardMomentCard.test.tsx`
Expected: FAIL, `Failed to resolve import "../DashboardMomentCard"`.

- [ ] **Step 7: Implement the card**

```tsx
// W/src/components/features/dashboard/DashboardMomentCard.tsx
/**
 * What the Dashboard shows for a time-travel moment: the maha and antar dasha
 * (pure selection over the chart's own dasha list) and the transits from the
 * period sky. No astrology here, no AI.
 */
import { useTranslation } from 'react-i18next';
import type { VimshottariDasha } from '@almamesh/browser';
import { selectDashasForPeriod } from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';

import { momentPeriod, type MomentSky } from '../../../lib/momentSky';
import { formatPinLabel } from '../../../lib/timeTravelSheet';
import { TransitsPanel } from '../predictive/TransitsPanel';

export interface DashboardMomentCardProps {
  readonly asOf: ChatThreadAsOf;
  readonly dashas: VimshottariDasha | undefined;
  readonly birthYear: number | undefined;
  readonly sky: MomentSky;
  readonly onRetry: () => void;
  readonly language: string;
}

function SkyPart({ sky, period, onRetry }: { sky: MomentSky; period: string; onRetry: () => void }) {
  const { t } = useTranslation('dashboard');
  if (sky.kind === 'dashas-only') return <p data-testid="time-travel-moment-dashas-only" className="text-sm text-text-secondary">{t('time_travel.dashas_only')}</p>;
  if (sky.kind === 'working') return <p data-testid="time-travel-moment-working" role="status" className="text-sm text-text-secondary">{t('time_travel.working', { period })}</p>;
  if (sky.kind === 'failed') {
    return (
      <p data-testid="time-travel-moment-failed" role="alert" className="text-sm text-status-error">
        {t('time_travel.failed')}{' '}
        <button type="button" onClick={onRetry} className="min-h-11 underline">{t('time_travel.retry')}</button>
      </p>
    );
  }
  return (
    <section data-testid="time-travel-moment-transits" aria-label={t('time_travel.transits_title')}>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('time_travel.transits_title')}</h3>
      <TransitsPanel transitCtx={sky.transits} />
    </section>
  );
}

export function DashboardMomentCard({ asOf, dashas, birthYear, sky, onRetry, language }: DashboardMomentCardProps) {
  const { t } = useTranslation(['dashboard', 'predictive']);
  const selected = dashas ? selectDashasForPeriod(dashas, momentPeriod(asOf), birthYear) : undefined;
  const maha = selected?.maha[0];
  const antar = selected?.antar[0];
  return (
    <div data-testid="time-travel-moment-card" className="mx-4 mt-3 space-y-3 rounded-lg border border-accent-gold/30 p-4">
      <h2 className="text-base font-semibold text-text-primary">{t('dashboard:time_travel.moment_title')}</h2>
      <dl data-testid="time-travel-moment-dasha" className="grid grid-cols-2 gap-2 text-sm">
        <dt>{t('dashboard:time_travel.maha')}</dt>
        <dd data-testid="time-travel-moment-maha">{maha ? t(`predictive:graha.${maha.lord}`) : '—'}</dd>
        <dt>{t('dashboard:time_travel.antar')}</dt>
        <dd data-testid="time-travel-moment-antar">{antar ? t(`predictive:graha.${antar.lord}`) : '—'}</dd>
      </dl>
      <SkyPart sky={sky} period={formatPinLabel(asOf, language)} onRetry={onRetry} />
    </div>
  );
}
```

`selected.maha` and `selected.antar` list every row that overlaps the period, in order; a month or year that crosses a boundary has two. Showing the first is enough for this card only if the test month sits inside one row. Render all rows instead, joined with " → " (`selected.maha.map((row) => t(`predictive:graha.${row.lord}`)).join(' → ')`), so a Year that crosses a boundary shows both lords. Use that form in the implementation; the tests above still pass because March 2025 has one of each. Check the lord strings are lowercase keys (`'saturn'`), as `predictive.json`'s `graha` block expects; if `PeriodDashaRow.lord` is capitalised, lowercase it at the call.

- [ ] **Step 8: Mount the card and the Today labels**

In `Dashboard.tsx`, after the banner from A4:

```tsx
        {timeTravel.moment && (
          <DashboardMoment asOf={timeTravel.moment} chart={siderealChart} chartId={chartId}
            engine={chartEngineContext} birthYear={travelBirthYear} language={i18n.language} />
        )}
```

and define `DashboardMoment` in `DashboardMomentCard.tsx` (exported), which calls `useMomentSky` and renders the card:

```tsx
export function DashboardMoment(props: { asOf: ChatThreadAsOf; chart: SiderealChart | null; chartId: string | null;
  engine: ChartEngineContextValue | null; birthYear: number | undefined; language: string }) {
  const stored = props.chartId ? useChartLibraryStore.getState().getChart(props.chartId) : undefined;
  const { sky, retry } = useMomentSky({ asOf: props.asOf, chart: props.chart,
    profileKey: stored?.profile_id ?? props.chartId ?? 'primary',
    birth: stored?.birth_data as ProcessedBirthData | undefined, engine: props.engine });
  return <DashboardMomentCard asOf={props.asOf} dashas={props.chart?.dashas} birthYear={props.birthYear}
    sky={sky} onRetry={retry} language={props.language} />;
}
```

`profileKey` and `birth` are derived exactly as `Dashboard.tsx:327-328` does for chat, so the period sky is keyed the same way and a chat answer and the card share one compute.

Today labels: at `:1154-1156`, wrap `<LifeAtlas />` so that, when `timeTravel.moment` is set, a `<span data-testid="dashboard-today-label-life-atlas" className="rounded bg-ui-border/40 px-2 py-0.5 text-xs">{t("dashboard:time_travel.today_label")}</span>` renders just above it. Do the same inside the Sky & Timing card (`:1162-1179`) with `data-testid="dashboard-today-label-sky"`, before the `predictive-link`.

Add a Dashboard test to `Dashboard.timeTravel.test.tsx`:

```tsx
it('labels Life Atlas and Sky & Timing "Today" while a moment is set, and only then', () => {
  renderDashboard({ ai: 'off' });
  expect(screen.queryByTestId('dashboard-today-label-life-atlas')).toBeNull();
  act(() => useTimeTravelStore.getState().setMoment(PROFILE_ID, { start: '2019-03-01', end: '2019-03-31', granularity: 'month' }));
  expect(screen.getByTestId('dashboard-today-label-life-atlas')).toHaveTextContent('Today');
  expect(screen.getByTestId('dashboard-today-label-sky')).toHaveTextContent('Today');
  expect(screen.getByTestId('time-travel-moment-card')).toBeInTheDocument();
});
```

- [ ] **Step 9: Run to verify everything passes**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/momentSky.test.ts src/components/features/dashboard/__tests__/DashboardMomentCard.test.tsx src/pages/__tests__/Dashboard.timeTravel.test.tsx`
Expected: PASS. Run the Dashboard test once before Step 8's code to see the new label test fail with `Unable to find an element by: [data-testid="dashboard-today-label-life-atlas"]`, then after to see it pass.

- [ ] **Step 10: Commit**

```bash
git add frontend/apps/web/src/lib/momentSky.ts frontend/apps/web/src/lib/__tests__/momentSky.test.ts frontend/apps/web/src/components/features/dashboard/DashboardMomentCard.tsx frontend/apps/web/src/components/features/dashboard/__tests__/DashboardMomentCard.test.tsx frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/__tests__/Dashboard.timeTravel.test.tsx
git commit -m "feat(dashboard): the moment card shows that moment's dashas and transits, computed on the device"
```

### Task A6: End-to-end journeys and the iPhone 15 project

**Files:**
- Modify: `W/playwright.time-travel.config.ts` (add the `iphone-15-webkit` project)
- Modify: `W/e2e/time-travel.spec.ts` (new `describe('Dashboard time travel')`; extend the `@sw` test at `:1023-1055`)
- Modify: `W/scripts/webkit-macos-lane.sh` (add `--project=iphone-15-webkit` to the time-travel run)

**Interfaces:**
- Consumes: `bootEngine`, `seedChart`, `DELHI_BIRTH` (`e2e/interpretation.helpers.ts`), `captureConsole` (`:66`), `prepare`/`configureStubbedAi` (`:76-90`), `scripted` (`:451`), `openDashboard` (`:61`), `serviceWorkerOffOrigin` (`:982`), `gotoSettled`.

- [ ] **Step 1: Re-derive the known-boundary dashas (plan ruling 5)**

```bash
cd backend && uv run almamesh-chart "1990-01-15T12:00:00+00:00" 28.6139 77.209 > "${TMPDIR:-/tmp}/delhi.json"
python3 -c "
import json,sys
d=json.load(open('${TMPDIR:-/tmp}/delhi.json'))['dashas']['maha_dasha_sequence']
for m in d:
  for a in m['antar_sequence']:
    for month in ('2019-03', '$(date +%Y-%m)'):
      if a['start_date'][:7] <= month <= a['end_date'][:7]: print(month, m['lord'], a['lord'])
"
```
Expected: `2019-03 rahu rahu` and `<this month> rahu mercury` (on 2026-10-10). If the output differs, pin what it prints. The two months' antars must differ; if they do not, pick another past month whose antar differs from today's and use it throughout.

- [ ] **Step 2: Add the iPhone 15 project**

Check the device exists in the installed Playwright: `cd frontend/apps/web && node -e "console.log(require('@playwright/test').devices['iPhone 15'].viewport)"` prints `{ width: 393, height: 659 }` (or similar). If it is undefined, stop and report: the spec's iPhone 15 lane needs a Playwright upgrade. Then add to `projects`:

```ts
      { name: "iphone-15-webkit", use: { ...devices["iPhone 15"], serviceWorkers: "block" }, grep: /@iphone15/ },
```

and add `@iphone15` to the `grepInvert` of the `chromium` and `webkit` projects (`/@iphone|@safari/` already matches `@iphone15` for chromium; webkit's `/@iphone/` also matches it — confirm both by `--list`).

- [ ] **Step 3: Write the failing e2e tests**

Add to `time-travel.spec.ts`:

```ts
const MARCH_2019_MAHA = 'Rahu';
const MARCH_2019_ANTAR = 'Rahu';
const DASHBOARD_BUTTON = 'dashboard-time-travel-button';

async function pickMonth(page: Page, month: string) {
  await page.getByTestId(DASHBOARD_BUTTON).click();
  await page.getByTestId('time-travel-tab-month').click();
  await page.getByTestId('time-travel-month').selectOption(month.slice(5));
  await page.getByTestId('time-travel-month-year').selectOption(month.slice(0, 4));
  await page.getByTestId('time-travel-go').click();
  await expect(page.getByTestId('time-travel-sheet')).toBeHidden();
}

test.describe('Dashboard time travel', () => {
  test('[contract/real] with AI off, desktop: the button opens the sheet and March 2019 shows its dashas and transits', async ({ page }, testInfo) => {
    const consoleErrors = captureConsole(page);
    await page.addInitScript((tier) => {
      Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => tier.deviceMemory });
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => tier.hardwareConcurrency });
    }, FULL_TIER);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const button = page.getByTestId(DASHBOARD_BUTTON);
    await expect(button).toBeVisible();
    await expect(button).toHaveText(/Time travel/);
    await expect(button).toBeEnabled();
    await button.focus();
    await button.click();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/March 2019/);
    await expect(page.getByTestId('time-travel-moment-maha')).toHaveText(MARCH_2019_MAHA);
    await expect(page.getByTestId('time-travel-moment-antar')).toHaveText(MARCH_2019_ANTAR);
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('dashboard-today-label-life-atlas')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('dashboard-march-2019-desktop.png'), fullPage: true });
    await page.getByTestId('dashboard-time-travel-change').click();
    await expect(page.getByTestId('time-travel-month')).toHaveValue('03');
    await page.getByTestId('time-travel-cancel').click();
    await page.getByTestId('dashboard-time-travel-back').click();
    await expect(page.getByTestId('dashboard-time-travel-banner')).toHaveCount(0);
    await expect(page.getByTestId('time-travel-moment-card')).toHaveCount(0);
    expect(consoleErrors, 'the journey must keep a clean console').toEqual([]);
  });

  test("[contract/real] Back to today shows today's Life Atlas at once: the moment never evicted it", async ({ page }) => {
    const consoleErrors = captureConsole(page);
    await page.addInitScript((tier) => {
      Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => tier.deviceMemory });
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => tier.hardwareConcurrency });
    }, FULL_TIER);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await expect.poll(() => predictiveRequestKeys(page), { timeout: 180_000 }).toHaveLength(1);
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('dashboard-time-travel-back').click();
    expect(await predictiveRequestKeys(page), "no second Life Atlas compute after Back to today").toHaveLength(1);
    expect(consoleErrors).toEqual([]);
  });

  test('[contract/stubbed] with AI on, Go from the Dashboard also opens a pinned chat thread', async ({ page }) => {
    const consoleErrors = await prepare(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await pickMonth(page, '2019-03');
    await page.getByTestId('floating-chat-button').click();
    await expect(page.getByTestId('time-travel-title')).toHaveText(/March 2019/);
    expect((await pinnedThreads(page)).length).toBe(1);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe('Dashboard time travel on an iPhone 15', () => {
  test('[contract/real] @iphone15 the button reads "Time travel", is at least 44×44, and with AI off shows dashas only', async ({ page }, testInfo) => {
    const consoleErrors = captureConsole(page);
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    const button = page.getByTestId(DASHBOARD_BUTTON);
    await expect(button).toBeVisible();
    await expect(button).toHaveText(/Time travel/);
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath('dashboard-button-iphone15.png') });
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('time-travel-moment-maha')).toHaveText(MARCH_2019_MAHA);
    await expect(page.getByTestId('time-travel-moment-dashas-only')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('dashboard-march-2019-iphone15.png'), fullPage: true });
    expect(consoleErrors).toEqual([]);
  });
});
```

Notes for the implementer:
- `prepare(page)` already returns or sets up the console capture. Read `:84-92` and use it the way the other tests do (if it does not return the errors array, call `captureConsole` first, as the `@iphone` test does).
- The month select testids and values (`time-travel-month` holds `MM` or `YYYY-MM`?) must match `TimeTravelSheet.tsx`. Read the sheet's month controls and adjust `pickMonth` to how they really take values. Keep the helper.
- The Dashboard tests run in the `chromium` project (no `@iphone`/`@safari` tag). The `@iphone15` test runs only in `iphone-15-webkit`, whose iOS UA makes the tier minimal, so it sees `dashas-only` until PR B.

Extend the `@sw` test (`:1023-1055`). Keep the existing composer assertion — it is still true with AI off (`time-travel-button` lives only in the AI composer) — and after `chat-connect-ai` is visible, close chat and add:

```ts
    await expect(page.getByTestId('dashboard-time-travel-button'), 'Time travel works without AI').toBeEnabled();
    await pickMonth(page, '2019-03');
    await expect(page.getByTestId('time-travel-moment-maha')).toBeVisible();
    await expect(page.getByTestId('time-travel-moment-card')).toBeVisible();
    await page.waitForLoadState('networkidle');
```

before the existing off-origin assertions, so `serviceWorkerOffOrigin(page, origin)` and `pageOffOrigin` now cover the Dashboard moment journey. The `@sw` test runs in `iphone-webkit` (minimal, dashas only) and in `chromium` if not inverted; on chromium the transits compute runs too. Wait for `time-travel-moment-transits` or `time-travel-moment-dashas-only` (whichever the tier gives) before `networkidle`: `await expect(page.getByTestId('time-travel-moment-transits').or(page.getByTestId('time-travel-moment-dashas-only'))).toBeVisible({ timeout: 180_000 });`.

- [ ] **Step 4: Run red against `main`'s app, then green**

Red: run the new tests against `main`'s Dashboard (A4 and A5 are already committed, so take the old file back for one run). `git checkout origin/main -- frontend/apps/web/src/pages/Dashboard.tsx`, then `(cd frontend/apps/web && bun run test:e2e:time-travel --project=chromium --grep "Dashboard time travel")`, then `git checkout HEAD -- frontend/apps/web/src/pages/Dashboard.tsx`. Expected: FAIL, `locator('[data-testid="dashboard-time-travel-button"]')` not found. Then `git status --short` must be clean.

Green:
```bash
cd frontend/apps/web
bun run test:e2e:time-travel --project=chromium
bun run test:e2e:time-travel --project=iphone-webkit
```
Expected: all pass. The `iphone-15-webkit` and `webkit` projects need the macOS lane (Linux WebKit cannot open SQLite's nested-Worker OPFS): run `bash scripts/webkit-macos-lane.sh` on this Mac, or read the `webkit-macos.yml` run on the PR. Keep every screenshot from `test-results/`.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/playwright.time-travel.config.ts frontend/apps/web/e2e/time-travel.spec.ts frontend/apps/web/scripts/webkit-macos-lane.sh
git commit -m "test(e2e): Dashboard time travel with AI off, AI on, iPhone 15, and the no-egress journey"
```

### Task A7: Mutations, gate, live drive, northstar, PR A

**Files:** none new. Evidence only.

- [ ] **Step 1: Mutation red runs (from the worktree root)**

```bash
B=frontend/apps/web
# 1. Label hidden on phones again -> the iPhone 15 label/box test goes red
python3 "$MUTATE" $B/src/pages/Dashboard.tsx '<span>{t("dashboard:actions.time_travel")}</span>' '<span className="hidden sm:inline">{t("dashboard:actions.time_travel")}</span>{/* MUTANT_TT */}' -- \
  bash -c 'cd frontend/apps/web && bunx vitest run "$@"' _ src/pages/__tests__/Dashboard.timeTravel.test.tsx
# 2. Button only when AI is configured -> the AI-off Dashboard test goes red
python3 "$MUTATE" $B/src/pages/Dashboard.tsx 'disabled={!chartId}' 'disabled={!chartId || !aiConfigured /* MUTANT_TT */}' -- \
  bash -c 'cd frontend/apps/web && bunx vitest run "$@"' _ src/pages/__tests__/Dashboard.timeTravel.test.tsx
# 3. Shrink the button -> the min-h-11 assertion goes red (and the 44 px box in e2e)
python3 "$MUTATE" $B/src/pages/Dashboard.tsx 'const TIME_TRAVEL_BUTTON_SIZE = "min-h-11 min-w-11";' 'const TIME_TRAVEL_BUTTON_SIZE = "min-h-8 min-w-8 MUTANT_TT";' -- \
  bash -c 'cd frontend/apps/web && bunx vitest run "$@"' _ src/pages/__tests__/Dashboard.timeTravel.test.tsx
# 4. Compute the moment with today's date -> momentPeriod unit (and the March 2019 e2e) go red
python3 "$MUTATE" $B/src/lib/momentSky.ts 'return { start: asOf.start, end: asOf.end };' 'const day = new Date().toISOString().slice(0, 10); /* MUTANT_TT */ return { start: day, end: day };' -- \
  bash -c 'cd frontend/apps/web && bunx vitest run "$@"' _ src/lib/__tests__/momentSky.test.ts
# 5. Route the moment compute through usePredictiveStore -> the not-evicted unit goes red
python3 "$MUTATE" $B/src/lib/momentSky.ts '  const sky = await load(period, { now: new Date(), signal });' '  void usePredictiveStore.getState().ensurePredictive({} as never, {} as never); /* MUTANT_TT */
  const sky = await load(period, { now: new Date(), signal });' -- \
  bash -c 'cd frontend/apps/web && bunx vitest run "$@"' _ src/lib/__tests__/momentSky.test.ts
# 6. A cross-origin fetch in the moment path -> the @sw no-egress e2e goes red
python3 "$MUTATE" $B/src/lib/momentSky.ts '  const period = momentPeriod(input.asOf);' '  void fetch("https://example.com/MUTANT_TT").catch(() => undefined);
  const period = momentPeriod(input.asOf);' -- \
  bash -c "cd $B && bun run test:e2e:time-travel --project=chromium --grep @sw"
# 7. Travel without saving the pin first (moment set before the save) -> A1 "a failed pin save moves nothing" goes red
python3 "$MUTATE" $B/src/lib/timeTravel.ts '  const threadId = deps.aiConfigured() ? await pinChat(request.asOf, target) : undefined;
  useTimeTravelStore.getState().setMoment(target.profileId, request.asOf);' '  useTimeTravelStore.getState().setMoment(target.profileId, request.asOf); /* MUTANT_TT */
  const threadId = deps.aiConfigured() ? await pinChat(request.asOf, target) : undefined;' -- \
  bash -c 'cd frontend/apps/web && bunx vitest run "$@"' _ src/lib/__tests__/timeTravel.test.ts
```

Mutation 5 needs `usePredictiveStore` imported in the mutant; add `import { usePredictiveStore } from '@almamesh/store';` to the OLD/NEW pair if the typechecker blocks the run (Vitest does not typecheck, so the run itself works). Mutation 4 also goes red in the e2e: run `bun run test:e2e:time-travel --project=chromium --grep "March 2019 shows"` under it once and paste the line. Mutation 1 is pinned in unit by "`button.querySelector('.hidden')` is null"; also run it against the `@iphone15` e2e on the macOS lane once.

Expected: seven `KILLED` lines. Then run the restore check (both lines must print).

- [ ] **Step 2: Full gate**

```bash
make gate; echo "gate exit $?"
bun test ./tests/*.test.ts; echo "contract exit $?"
```
Expected: both 0. Record test counts. `lib/timeTravel.ts` and `lib/momentSky.ts` at 100% branch coverage, every `throw` covered (`cd frontend/apps/web && bunx vitest run --coverage src/lib/__tests__/timeTravel.test.ts src/lib/__tests__/momentSky.test.ts`). Invoke `frontend-quality` on `git diff --name-only origin/main -- frontend`.

- [ ] **Step 3: Live end-to-end, desktop Chromium and iPhone 15 WebKit**

`cd frontend/apps/web && VITE_API_URL= bun run build && VITE_API_URL= bun run preview --host 127.0.0.1 --port 4216`. Drive it with the project's Playwright (the MCP_DOCKER browser cannot boot the engine), with **no hooks**, through real onboarding: type a name, birth date and time, pick a city, Generate, wait for the engine, see the chart.
- Desktop Chromium (1280×800), AI off: the header shows "⏳ Time travel" before the timeline button. Tap it → Month → March 2019 → Go. See the banner ("the cards below are about this moment"), the maha and antar, then the transits table after the compute. "Today" sits on Life Atlas and Sky & Timing. Change, then Back to today. Reload: the Dashboard is on today (Ruling 1). Screenshot each step and save the console log; it must be clean.
- Desktop Chromium, AI on (an OpenRouter key from this machine's keychain, or the stubbed config if none; say which): Go from the Dashboard, open chat, see the pinned thread.
- iPhone 15 WebKit (Playwright `devices['iPhone 15']`, macOS WebKit): the button label is visible, the box is ≥ 44×44, Month → March 2019 shows dashas and the dashas-only line. Screenshots and a clean console.
- es and pt: the button, banner and card read in that language.

- [ ] **Step 4: Northstar grade**

Dispatch the `northstar` agent (standing approval) on the branch, with the three claims, the mutation table, the gate output and coverage, the e2e screenshots and the live-drive screenshots. Fix anything below A, re-run Steps 1–3, re-grade.

- [ ] **Step 5: Open PR A**

```bash
git push -u origin claude/time-travel-reach-a
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-reach-a \
  --title "feat(time-travel): a Dashboard button that works without AI" --body-file "${TMPDIR:-/tmp}/tt-reach-a.md"
```

The body: what ships (Parts 1 and 2), the claims touched, Rulings 1–3 and plan rulings 1–3 and 5, the TDD red runs, the mutation table with the restore check, the evidence table (gate, coverage, e2e lanes, macOS lane run link, live screenshots and console logs, northstar grade), and anything not verified, named as unverified. End with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QfxWgyzxj7Q4LtWoUmxvg7
```

- [ ] **Step 6: Merge and clean up in the same breath**

When CI (including the macOS WebKit lane) is green and the grade is A: `gh pr merge --squash --delete-branch`; `git -C /Users/harish/dev/oss/almamesh worktree remove .worktrees/time-travel-reach-a`; `git -C /Users/harish/dev/oss/almamesh branch -D claude/time-travel-reach-a`; confirm CI is green on `main`; confirm the deploy serves the merge SHA (`build.json` `git_sha` equals the merge SHA, with `content-type: application/json`); then drive Step 3's desktop journey once against production.

---
# PR B — Part 3: Day and "Where?" on iPhone and Safari, bounded by SQLite

Claims touched: **"Every feature works on every device, within a memory budget."** and **"SQLite on OPFS is the only place your data lives."**

**Start gate (do not skip):** PR A is merged, and PR #317 is merged (check: `gh pr view 317 -R gainratio/almamesh --json state -q .state` prints `MERGED`, and `test -f frontend/apps/web/scripts/webkitProcessMemory.mjs && test -f frontend/apps/web/e2e/webkitDiagnostics.ts` on fresh `main`). If #317 is still open, B2–B5 may proceed (they do not measure WebKit), but B1 and B7 wait.

Plan rulings for PR B:

8. **The engine-hash sweep runs on the first durable access per session, not at boot.** Opening the derived database at every boot would spend a Worker and its page cache on visits that never travel. So the first `period_sky` read in a session deletes rows of other engine hashes, once.
9. **Reset removes the whole derived database; profile delete removes that profile's rows; restore empties `period_sky`.** City rows are reference data and survive profile delete and restore, but not reset (reset means "as if never installed").
10. **The period-sky durable cache is used only when the runtime names its engine** (`PredictiveRuntime.identity?()`). Test runtimes without it stay memory-only, so no unit test needs OPFS.

### Task B1: Measure first — the time-travel memory journey and its budgets

**Files:**
- Modify: `W/e2e/memoryBudget.ts` (add `TIME_TRAVEL_MEMORY_BUDGET`, `TimeTravelMemorySample`, `overTimeTravelBudget`)
- Create: `W/e2e/time-travel-memory.e2e.spec.ts` (Chromium lane, in `playwright.memory-budget.config.ts`'s `testMatch`)
- Create: `W/e2e/time-travel-memory.webkit.spec.ts` (macOS WebKit lane; uses #317's `startWebKitDiagnostics`)
- Modify: `W/playwright.memory-budget.config.ts` (include the new spec), `W/scripts/webkit-macos-lane.sh` (run the WebKit memory spec with `--project=iphone-15-webkit --retries=0`), `W/playwright.time-travel.config.ts` (`testMatch` must include `time-travel-memory.webkit.spec.ts` for the iPhone 15 project)
- Test: `W/src/test/memoryBudget.contract.test.ts` (new; pins the literals)

**Interfaces:**
- Produces:
  ```ts
  export interface TimeTravelMemoryBudget { readonly heapPeakMiB: number; readonly revisitHeapGrowthMiB: number; readonly cityLookupHeapGrowthMiB: number; readonly webContentRssOverBaselineMiB: number; }
  export const TIME_TRAVEL_MEMORY_BUDGET: TimeTravelMemoryBudget; // provisional: 440 / 5 / 8 / 250
  export interface TimeTravelMemorySample { readonly heapPeakMiB: number; readonly revisitHeapGrowthMiB: number; readonly cityLookupHeapGrowthMiB: number; }
  export function overTimeTravelBudget(sample: TimeTravelMemorySample, budget?: TimeTravelMemoryBudget): string[];
  ```

- [ ] **Step 1: Pin the budget literals (failing)**

```ts
// W/src/test/memoryBudget.contract.test.ts
import { describe, expect, it } from 'vitest';
import { overTimeTravelBudget, TIME_TRAVEL_MEMORY_BUDGET } from '../../e2e/memoryBudget';

describe('time-travel memory budget', () => {
  it('pins the spec numbers (raise only with a new spec, never to turn a run green)', () => {
    expect(TIME_TRAVEL_MEMORY_BUDGET).toEqual({ heapPeakMiB: 440, revisitHeapGrowthMiB: 5, cityLookupHeapGrowthMiB: 8, webContentRssOverBaselineMiB: 250 });
  });
  it('an unmeasured NaN fails every metric', () => {
    expect(overTimeTravelBudget({ heapPeakMiB: Number.NaN, revisitHeapGrowthMiB: Number.NaN, cityLookupHeapGrowthMiB: Number.NaN })).toHaveLength(3);
  });
  it('names exactly the metric over its budget', () => {
    expect(overTimeTravelBudget({ heapPeakMiB: 441, revisitHeapGrowthMiB: 1, cityLookupHeapGrowthMiB: 1 })).toEqual(['heapPeakMiB']);
  });
});
```

Run: `cd frontend/apps/web && bunx vitest run src/test/memoryBudget.contract.test.ts`. Expected: FAIL, `TIME_TRAVEL_MEMORY_BUDGET` is not exported. (If `vitest.config.ts`'s `include` does not reach `e2e/`, the import still works: it is a plain relative import from a test under `src/`.)

- [ ] **Step 2: Implement the budget**

Append to `W/e2e/memoryBudget.ts`:

```ts
/** Spec "Memory budget" (2026-10-10). Provisional until B1's runs; then max + 5 %, never raised. */
export interface TimeTravelMemoryBudget {
  readonly heapPeakMiB: number;
  readonly revisitHeapGrowthMiB: number;
  readonly cityLookupHeapGrowthMiB: number;
  readonly webContentRssOverBaselineMiB: number;
}
export const TIME_TRAVEL_MEMORY_BUDGET: TimeTravelMemoryBudget = {
  heapPeakMiB: 440,
  revisitHeapGrowthMiB: 5,
  cityLookupHeapGrowthMiB: 8,
  webContentRssOverBaselineMiB: 250,
};
export interface TimeTravelMemorySample {
  readonly heapPeakMiB: number;
  readonly revisitHeapGrowthMiB: number;
  readonly cityLookupHeapGrowthMiB: number;
}
export function overTimeTravelBudget(sample: TimeTravelMemorySample, budget: TimeTravelMemoryBudget = TIME_TRAVEL_MEMORY_BUDGET): string[] {
  const keys = ['heapPeakMiB', 'revisitHeapGrowthMiB', 'cityLookupHeapGrowthMiB'] as const;
  // `!(x <= y)` so an unmeasured NaN fails, like overBudget.
  return keys.filter((key) => !(sample[key] <= budget[key]));
}
```

Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Write the Chromium journey spec**

`W/e2e/time-travel-memory.e2e.spec.ts`, copying the helpers of `e2e/memory-budget.e2e.spec.ts` (`onboardToDashboard` `:83`, `pageHeap` `:125`, `sampleLoop` `:137`, `settledHeap` `:39`, `rendererRss` `:109`; import `formatMemoryReport` from `../scripts/processMemory.mjs`). The journey (spec, Memory budget):

```ts
test('time-travel journey stays inside TIME_TRAVEL_MEMORY_BUDGET (tier: minimal, iPhone UA)', async ({ page }, testInfo) => {
  const granularity = process.env.TT_MEMORY_GRANULARITY === 'month' ? 'month' : 'day';
  await onboardToDashboard(page);
  const sampler = sampleLoop(page);                        // page+workers heap every 500 ms
  await page.getByTestId('dashboard-time-travel-button').click();
  await pickMoment(page, granularity, '2019-03-14', 'Bogotá');   // Day + place, or Month on main
  const beforeLookup = await settledHeap(page);             // measured around the first city lookup
  await expect(page.getByTestId('time-travel-moment-transits').or(page.getByTestId('time-travel-moment-dashas-only'))).toBeVisible({ timeout: 240_000 });
  const cityLookupGrowth = /* heap right after the lookup resolves */ (await settledHeap(page)) - beforeLookup;
  await pickMoment(page, granularity, '2019-03-15', 'Bogotá');  // a second, different moment
  await expect(page.getByTestId('time-travel-moment-transits').or(page.getByTestId('time-travel-moment-dashas-only'))).toBeVisible({ timeout: 240_000 });
  const beforeRevisit = await settledHeap(page);
  await pickMoment(page, granularity, '2019-03-14', 'Bogotá');  // back to the first: a cache hit
  await expect(page.getByTestId('time-travel-moment-transits').or(page.getByTestId('time-travel-moment-dashas-only'))).toBeVisible({ timeout: 30_000 });
  const revisitGrowth = (await settledHeap(page)) - beforeRevisit;
  await page.getByTestId('dashboard-time-travel-back').click();
  const peak = await sampler.stop();
  const sample = { heapPeakMiB: peak.heapPeakMiB, revisitHeapGrowthMiB: revisitGrowth, cityLookupHeapGrowthMiB: cityLookupGrowth };
  await testInfo.attach('time-travel-memory.json', { body: JSON.stringify({ granularity, sample, rssPeakMiB: peak.rendererRssPeakMiB }), contentType: 'application/json' });
  console.log(formatMemoryReport('time-travel', { ...sample, rendererRssPeakMiB: peak.rendererRssPeakMiB }));
  expect(overTimeTravelBudget(sample)).toEqual([]);
});
```

`pickMoment(page, granularity, day, city)` opens the sheet, picks the Day tab and types `day` and the city into "Where?" (choosing the first candidate), or for `month` picks the Month tab with `day.slice(0, 7)` and ignores the city. Read the real `sampleLoop`/`settledHeap` return types and adapt the names (`peak.heapPeakMiB` etc.) to them. The city-lookup growth must be measured around the "Where?" search only: take `settledHeap` right before typing the city and right after the candidate list shows.

- [ ] **Step 4: Write the WebKit RSS spec**

`W/e2e/time-travel-memory.webkit.spec.ts`, tagged `@iphone15`: the same journey (Month only on `main`), with `const diag = startWebKitDiagnostics(testInfo, 'time-travel-memory')`; `diag.watch(page.context())` before boot; `await diag.finish()` at the end; read `summarizeWebKitRss(samples).peakSingleWebMiB` (the WebContent process, the one jetsam kills). A first test, `@iphone15 boot baseline`, only boots to the Dashboard and records `peakSingleWebMiB` as the baseline. The journey test asserts `peakSingleWebMiB <= baseline + TIME_TRAVEL_MEMORY_BUDGET.webContentRssOverBaselineMiB`, with baseline read from env `TT_WEBKIT_BASELINE_MIB` (set from the 5 baseline runs; NaN or missing fails the assertion).

- [ ] **Step 5: Baseline runs on `main` (Month), and the probe runs (Day on minimal)**

```bash
# Chromium lane, 5 runs on the branch with nothing else changed (Day is off on minimal, so Month):
cd frontend/apps/web && for i in 1 2 3 4 5; do TT_MEMORY_GRANULARITY=month bunx playwright test -c playwright.memory-budget.config.ts e2e/time-travel-memory.e2e.spec.ts --retries=0; done
# macOS WebKit lane, 5 baseline + 5 Month journeys:
for i in 1 2 3 4 5; do bunx playwright test -c playwright.time-travel.config.ts e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --retries=0; done
```

Then the **probe**: the first Day compute on minimal, before shipping anything. Apply the B6 tier flip by hand (in `frontend/packages/browser/src/deviceTier.ts`, minimal and lite `periodSkyComputeAllowed: true`), rebuild, and run both lanes 5 times with `TT_MEMORY_GRANULARITY=day`. Without B3 the city lookup still parses the JSON, so record its growth but judge only `heapPeakMiB` and the WebContent RSS here. Then `git checkout -- frontend/packages/browser/src/deviceTier.ts` and run the restore check.

Record every sample (10 per lane) in `docs/superpowers/plans/2026-10-10-time-travel-reachable-b1-samples.md` (a table: lane, run, granularity, each metric) and commit it with `git add -f`.

- [ ] **Step 6: Decide (stop here if over budget)**

- If the probe's max `heapPeakMiB` × 1.05 ≤ 440 and max WebContent RSS ≤ baseline max + 250: set each budget to measured max + 5 % **only if that is lower** than the provisional value (never higher), update the Step 1 literals to match, and continue with B2.
- If not: stop PR B here. Open PR B-3a with Task B-3a (below), merge it, re-run Step 5's probe with the slim entry wired in, and only then continue with B2 as PR B-3b. Do not raise any budget.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/web/e2e/memoryBudget.ts frontend/apps/web/e2e/time-travel-memory.e2e.spec.ts frontend/apps/web/e2e/time-travel-memory.webkit.spec.ts frontend/apps/web/playwright.memory-budget.config.ts frontend/apps/web/playwright.time-travel.config.ts frontend/apps/web/scripts/webkit-macos-lane.sh frontend/apps/web/src/test/memoryBudget.contract.test.ts
git add -f docs/superpowers/plans/2026-10-10-time-travel-reachable-b1-samples.md
git commit -m "test(memory): time-travel journey budget, with baseline and probe samples"
```

### Task B-3a (only if B1 Step 6 says over budget): the slim `compute_period_sky` engine entry

Ships as its own PR before the tier change (Ruling 4). Skip it entirely when B1 passes.

**Files:**
- Modify: `backend/src/almamesh/predictive.py` (add `compute_period_sky_contexts`), `backend/src/almamesh/edge/chart_runtime.py` (add `compute_period_sky`)
- Create: `backend/tests/test_period_sky_golden.py`, `backend/tests/fixtures/period_sky_golden_de421.json`
- Modify: `frontend/packages/browser/src/pyodide/{chartWorker.ts,protocol.ts,predictive.ts,engineMemo.ts,runtime.ts}` (a `computePeriodSky` call beside `computePredictive`, same `retention: 'period'` pool), `W/scripts/verify-browser-parity.mjs` (a `PERIOD_SKY_FIXTURES` block with the same keys as the golden), `W/src/lib/periodSky.ts` (call `runtime.computePeriodSky` when present)

- [ ] **Step 1: Failing golden test**

```python
"""Golden for compute_period_sky; the browser parity gate compares Pyodide to it."""
from __future__ import annotations
import json
from pathlib import Path
from almamesh.edge.chart_runtime import compute_period_sky

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "period_sky_golden_de421.json"
DELHI = {"datetime_utc": "1990-01-15T12:00:00+00:00", "latitude": 28.6139, "longitude": 77.209, "utc_offset_minutes": 330}

def golden_cases() -> dict[str, dict[str, object]]:
    """Keys MUST equal PERIOD_SKY_FIXTURES in apps/web/scripts/verify-browser-parity.mjs."""
    return {
        "delhi-2019-03-14": {**DELHI, "reference_instant": "2019-03-14T00:00:00+00:00"},
        "delhi-2019-03..2020-02": {**DELHI, "reference_instant": "2019-03-01T00:00:00+00:00", "window_months": 12},
    }

def test_period_sky_matches_golden() -> None:
    golden = json.loads(GOLDEN_PATH.read_text())
    assert {key: compute_period_sky(case) for key, case in golden_cases().items()} == golden

def test_period_sky_transits_equal_the_full_predictive_transits() -> None:
    from almamesh.edge.chart_runtime import compute_predictive
    case = golden_cases()["delhi-2019-03-14"]
    assert compute_period_sky(case)["transit_context"] == compute_predictive(case)["transit_context"]
```

Run: `cd backend && uv run pytest tests/test_period_sky_golden.py -q`. Expected: FAIL, `ImportError: cannot import name 'compute_period_sky'`.

- [ ] **Step 2: Implement**

In `predictive.py`, next to `compute_predictive_contexts`:

```python
def compute_period_sky_contexts(
    birth_dt: datetime, latitude: float, longitude: float, reference_instant: datetime,
    *, window_months: int = _DEFAULT_WINDOW_MONTHS,
) -> TransitContext:
    """Transits (and the natal dasha basis) for a period only: no vargas, Shadbala, Ashtakavarga or domains."""
    checked_window_months(window_months)
    natal = calculate_sidereal_context(birth_dt, latitude, longitude, reference_date=reference_instant)
    return calculate_transit_context(natal, birth_dt, transit_instant=reference_instant, window_months=window_months)
```

In `chart_runtime.py`:

```python
def compute_period_sky(payload: Mapping[str, object]) -> dict[str, JsonValue]:
    """The slim period entry: ``{"transit_context": ...}`` only. Same required inputs as compute_predictive."""
    transits = compute_period_sky_contexts(
        datetime.fromisoformat(str(payload["datetime_utc"])),
        _parse_payload_number(payload["latitude"], field="latitude"),
        _parse_payload_number(payload["longitude"], field="longitude"),
        datetime.fromisoformat(str(payload["reference_instant"])),
        window_months=window_months_from_wire(payload.get("window_months")),
    )
    return {"transit_context": transits.model_dump(mode="json")}
```

Generate the golden once: `cd backend && uv run python -c "import json; from tests.test_period_sky_golden import golden_cases; from almamesh.edge.chart_runtime import compute_period_sky; print(json.dumps({k: compute_period_sky(v) for k, v in golden_cases().items()}, indent=2, sort_keys=True))" > tests/fixtures/period_sky_golden_de421.json`, then run the test: PASS. Run `uv run poe gate` and invoke `python-quality`.

- [ ] **Step 3: Wire the browser entry and parity**

Mirror `computeMoonWindow` end to end (it is the most recent entry added the same way): a `compute_period_sky` message in `protocol.ts` and `chartWorker.ts`, `computePeriodSky(input: PredictiveInput, options?: PredictiveCallOptions): Promise<{ transit_context: TransitContext }>` on the engine and in `memoizeChartEngine` (pool `options?.retention ?? 'default'`), add `computePeriodSky?` to `PredictiveRuntime`, and in `periodSky.ts`'s `start` call `runtime.computePeriodSky ?? runtime.computePredictive`. Add the two fixtures to `verify-browser-parity.mjs` and run `cd frontend/packages/browser && bun run test:parity`: PASS. Write a unit in `periodSky.test.ts`: "uses the slim entry when the runtime has it" (a runtime with both, asserting only `computePeriodSky` was called).

- [ ] **Step 4: Prove and ship B-3a**

Mutation: in `chart_runtime.py` change `window_months=window_months_from_wire(payload.get("window_months")),` inside `compute_period_sky` to `window_months=12,  # MUTANT_TT` → the golden test goes red. Restore check. Gate, parity, northstar, PR "feat(engine): slim period-sky entry for time travel (PR 3a)", merge and clean up as in A7 Steps 4–6. Then re-run B1 Step 5's probe; continue only when it passes.

### Task B2: The derived-data SQL seam `lib/derivedDb.ts`

**Files:**
- Create: `W/src/lib/derivedDb.ts`, `W/src/lib/__tests__/derivedDb.test.ts`
- Modify: `W/package.json` (add `"@gainratio/browser": "^0.4.1"` to `dependencies` if `apps/web` does not list it; it is a dependency of `packages/browser`, `store`, `memory`)
- Test also: `W/src/lib/__tests__/legoSeams.test.ts` (new): only `derivedDb.ts` imports `@gainratio/browser/sql`

**Interfaces:**
- Consumes: `openSqlDatabase(options: { name; persistence?: 'opfs' | 'memory'; fallback?: 'none' | 'memory' }): Promise<SqlDatabase>` and `removeSqlDatabase(name)` (`@gainratio/browser/sql`); `SqlDatabase.exec(sql, bind?)`, `.query<R>(sql, bind?)`, `.transaction(...)`, `.executeMany(sql, rows)`, `.close()` (`edgeproc-browser/src/sql/client.ts:55`); `openNodeSqlDatabase({ name })` (`@gainratio/browser/sql/node`, tests only).
- Produces:
  ```ts
  export const DERIVED_DB_NAME = 'almamesh-derived';
  export const DERIVED_SCHEMA_VERSION = 1;
  export type { SqlDatabase } from '@gainratio/browser/sql';
  export function derivedDb(): Promise<SqlDatabase>;            // lazy, one per tab, OPFS, fail closed
  export async function migrateDerivedDb(db: SqlDatabase): Promise<void>;
  export async function removeDerivedDb(): Promise<void>;        // reset (plan ruling 9)
  export function __setDerivedDbForTest(db: SqlDatabase | undefined): void;
  ```

- [ ] **Step 1: Failing tests**

```ts
// W/src/lib/__tests__/derivedDb.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';

import { DERIVED_SCHEMA_VERSION, migrateDerivedDb } from '../derivedDb';

const open = () => openNodeSqlDatabase({ name: `derived-test-${Math.random()}` });

describe('derived database schema', () => {
  it('creates cities, cities_fts (trigram), period_sky and dataset_meta, at user_version 1', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    const tables = (await db.query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type IN ('table') ORDER BY name")).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['cities', 'cities_fts', 'dataset_meta', 'period_sky']));
    expect((await db.query<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version).toBe(DERIVED_SCHEMA_VERSION);
    await db.close();
  });

  it('is idempotent', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    await migrateDerivedDb(db);
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM cities'))[0]?.n).toBe(0);
    await db.close();
  });

  it('the trigram index finds a substring in the middle of a folded name', async () => {
    const db = await open();
    await migrateDerivedDb(db);
    await db.exec("INSERT INTO cities (idx, n, c, cc, lat, lon, p, name_fold, search_fold) VALUES (7, 'Bogotá', 'Colombia', 'CO', 4.6, -74.08, 7000000, 'bogota', 'bogota colombia co')");
    await db.exec("INSERT INTO cities_fts(cities_fts) VALUES ('rebuild')");
    const rows = await db.query<{ idx: number }>("SELECT rowid AS idx FROM cities_fts WHERE cities_fts MATCH '\"ogot\"'");
    expect(rows).toEqual([{ idx: 7 }]);
    await db.close();
  });
});
```

```ts
// W/src/lib/__tests__/legoSeams.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('Lego seams', () => {
  it('only lib/derivedDb.ts imports @gainratio/browser/sql (tests may use /sql/node)', () => {
    const importers = files(SRC)
      .filter((path) => !/__tests__|\.test\./.test(path))
      .filter((path) => /from ['"]@gainratio\/browser\/sql['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(importers).toEqual(['lib/derivedDb.ts']);
  });
});
```

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/derivedDb.test.ts src/lib/__tests__/legoSeams.test.ts`. Expected: FAIL, `Failed to resolve import "../derivedDb"` and `expected [] to deeply equal [ 'lib/derivedDb.ts' ]`.

- [ ] **Step 2: Implement**

```ts
// W/src/lib/derivedDb.ts
/**
 * The one door to the derived-data SQLite database (spec Part 3). City rows
 * (reference data) and per-day period-sky results (derived personal data,
 * recomputable, never exported) live here, on OPFS, under the device's memory
 * profile. Fail closed: no in-memory fallback. The ONLY importer of
 * @gainratio/browser/sql (Lego seam; legoSeams.test.ts).
 */
import { openSqlDatabase, removeSqlDatabase, type SqlDatabase } from '@gainratio/browser/sql';

export type { SqlDatabase } from '@gainratio/browser/sql';
export const DERIVED_DB_NAME = 'almamesh-derived';
export const DERIVED_SCHEMA_VERSION = 1;

const SCHEMA_V1: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE IF NOT EXISTS cities (idx INTEGER PRIMARY KEY, n TEXT NOT NULL, c TEXT NOT NULL, cc TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, p INTEGER NOT NULL, name_fold TEXT NOT NULL, search_fold TEXT NOT NULL) STRICT',
  "CREATE VIRTUAL TABLE IF NOT EXISTS cities_fts USING fts5(search_fold, content='cities', content_rowid='idx', tokenize='trigram')",
  'CREATE TABLE IF NOT EXISTS period_sky (engine_hash TEXT NOT NULL, request_key TEXT NOT NULL, profile_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (engine_hash, request_key)) STRICT',
  'CREATE INDEX IF NOT EXISTS period_sky_profile ON period_sky (profile_key)',
  `PRAGMA user_version = ${DERIVED_SCHEMA_VERSION}`,
];

export async function migrateDerivedDb(db: SqlDatabase): Promise<void> {
  for (const statement of SCHEMA_V1) await db.exec(statement);
}

let opening: Promise<SqlDatabase> | undefined;

export function derivedDb(): Promise<SqlDatabase> {
  opening ??= openSqlDatabase({ name: DERIVED_DB_NAME, persistence: 'opfs', fallback: 'none' })
    .then(async (db) => { await migrateDerivedDb(db); return db; })
    .catch((error: unknown) => { opening = undefined; throw error; });
  return opening;
}

export async function removeDerivedDb(): Promise<void> {
  const current = opening;
  opening = undefined;
  if (current) await current.then((db) => db.close(), () => undefined);
  await removeSqlDatabase(DERIVED_DB_NAME);
}

export function __setDerivedDbForTest(db: SqlDatabase | undefined): void {
  opening = db ? Promise.resolve(db) : undefined;
}
```

Check the real signatures before running: `removeSqlDatabase`'s argument (name or options), whether `query` returns plain objects, and that `openNodeSqlDatabase` is exported at `@gainratio/browser/sql/node` in the installed 0.4.x. If `exec` cannot run `PRAGMA user_version = 1`, use `db.exec('PRAGMA user_version = 1')` as a separate call (it is one already).

- [ ] **Step 3: Run to verify it passes**

Same command. Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/src/lib/derivedDb.ts frontend/apps/web/src/lib/__tests__/derivedDb.test.ts frontend/apps/web/src/lib/__tests__/legoSeams.test.ts frontend/apps/web/package.json frontend/bun.lock
git commit -m "feat(storage): one seam for the derived SQLite database on OPFS (cities, period sky)"
```

(Stage `frontend/bun.lock` only if `bun install` changed it.)

### Task B3: Cities in SQLite, imported part by part, looked up by SQL

**Files:**
- Modify: `frontend/scripts/generate-cities.mjs` (emit `W/src/data/cities/cities-part-NN.json`, 1,000 rows each, plus `W/src/data/cities/manifest.json` `{ "version": "<sha256 of the parts>", "rows": 24293, "parts": 25 }`; stop emitting `cities.min.json`)
- Delete: `W/src/data/cities.min.json` (after Step 1's golden is captured)
- Create: `W/src/lib/geo/citySql.ts`, `W/src/lib/geo/__tests__/citySql.test.ts`, `W/src/lib/geo/__tests__/cityLookupParity.golden.json`
- Modify: `W/src/lib/geo/cityLookup.ts` (`:49-74` loading; `:190-230` offline search and index read; extract the row matcher)
- Modify: `W/e2e/memory-budget.e2e.spec.ts:264-337` (city requests are now `cities-part-`; the growth gate reads `TIME_TRAVEL_MEMORY_BUDGET.cityLookupHeapGrowthMiB`), `W/e2e/memoryBudget.ts` (`PLACE_LOOKUP_HEAP_GROWTH_MIB` 48 → removed; its one user now reads the new 8 MiB budget)

**Interfaces:**
- Consumes: `derivedDb()` (B2); `fold` / `foldPlaceText` (`cityLookup.ts:231`); `CityRow { n; c; cc; lat; lon; p }` (`:49`).
- Produces:
  ```ts
  // cityLookup.ts (exported for citySql.ts)
  export function citySearchText(row: CityRow): string;          // fold(name + country + cc + alias words)
  export function cityMatchRank(row: CityRow, normQuery: string, tokens: readonly string[]): 0 | 1 | 2 | 3; // 0 = no match; same rules as today
  // citySql.ts
  export const CITY_SQL_CANDIDATES = 200;
  export async function ensureCitiesImported(db: SqlDatabase, parts?: CityPartLoader): Promise<void>;
  export async function cityCandidates(db: SqlDatabase, query: string): Promise<IndexedCityRow[]>;
  export async function cityRowAt(db: SqlDatabase, index: number): Promise<CityRow | undefined>;
  export type CityPartLoader = () => Promise<{ version: string; parts: readonly (() => Promise<readonly CityRow[]>)[] }>;
  ```
  `searchCityRowsOffline(query, limit)` and `cityAtIndexOffline(index)` keep their signatures; `placeFromRef` and `lookupPlaceOffline` (`placeLookup.ts:98,110`) are unchanged and so keep `city:<index>` refs valid.

- [ ] **Step 1: Capture today's answers as the golden (before changing any lookup code)**

Write `W/src/lib/geo/__tests__/cityLookupParity.capture.test.ts` (temporary; deleted in Step 6) that runs today's `searchCityRowsOffline` over this corpus and writes the results:

```ts
export const PARITY_QUERIES = ['bogota', 'Bogotá', 'BOGOTÁ, Colombia', 'Sao Paulo', 'são paulo brazil', 'Paris FR', 'paris, france', 'paris tx', 'delhi', 'New Delhi', 'york', 'new york usa', 'london gb', 'london uk', 'Dubai AE', 'dubai uae', 'springfield', 'santiago', 'san', 'la', 'mexico', 'méxico df', 'zürich', 'zurich', 'kyiv', 'st petersburg', 'saint petersburg russia', 'xx', 'qqqq', ' '];
```

For each query store `{ query, results: (await searchCityRowsOffline(query, 8)).map((m) => m.index) }` into `cityLookupParity.golden.json`. Run it once on the untouched code, commit the golden in Step 7. Put `PARITY_QUERIES` in `W/src/lib/geo/__tests__/cityParityQueries.ts` so the parity test reuses it.

- [ ] **Step 2: Failing tests**

```ts
// W/src/lib/geo/__tests__/citySql.test.ts
import { describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';

import { migrateDerivedDb, __setDerivedDbForTest } from '../../derivedDb';
import { cityCandidates, cityRowAt, ensureCitiesImported } from '../citySql';
import { searchCityRowsOffline } from '../cityLookup';
import golden from './cityLookupParity.golden.json';

async function freshDb() {
  const db = await openNodeSqlDatabase({ name: `cities-${Math.random()}` });
  await migrateDerivedDb(db);
  return db;
}

describe('city rows in SQLite', () => {
  it('imports once per version, keeping each row at its list index (place refs stay valid)', async () => {
    const db = await freshDb();
    const parts = async () => ({ version: 'v1', parts: [async () => [{ n: 'A', c: 'X', cc: 'XX', lat: 1, lon: 2, p: 10 }], async () => [{ n: 'Bogotá', c: 'Colombia', cc: 'CO', lat: 4.6, lon: -74.08, p: 7 }]] });
    await ensureCitiesImported(db, parts);
    await ensureCitiesImported(db, parts);
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM cities'))[0]?.n).toBe(2);
    expect((await cityRowAt(db, 1))?.n).toBe('Bogotá');
  });

  it('a new version replaces the rows; a failed import leaves the old version marked absent so it retries', async () => {
    const db = await freshDb();
    await ensureCitiesImported(db, async () => ({ version: 'v1', parts: [async () => [{ n: 'A', c: 'X', cc: 'XX', lat: 1, lon: 2, p: 1 }]] }));
    await expect(ensureCitiesImported(db, async () => ({ version: 'v2', parts: [async () => { throw new Error('chunk failed'); }] }))).rejects.toThrow('chunk failed');
    expect((await db.query<{ value: string }>("SELECT value FROM dataset_meta WHERE key = 'cities_version'"))).toEqual([]);
  });

  it('returns at most 200 candidates and never the whole table', async () => {
    const db = await freshDb();
    const many = Array.from({ length: 500 }, (_, i) => ({ n: `San ${i}`, c: 'Spain', cc: 'ES', lat: 0, lon: 0, p: i }));
    await ensureCitiesImported(db, async () => ({ version: 'v1', parts: [async () => many] }));
    expect((await cityCandidates(db, 'san')).length).toBe(200);
  });
});

describe('lookup parity with the JS list (Review Focus 4)', () => {
  it('gives the same top 8 as before for every corpus query', async () => {
    const db = await freshDb();
    await ensureCitiesImported(db);            // the real parts, from src/data/cities/
    __setDerivedDbForTest(db);
    for (const { query, results } of golden as { query: string; results: number[] }[]) {
      expect((await searchCityRowsOffline(query, 8)).map((m) => m.index), query).toEqual(results);
    }
    __setDerivedDbForTest(undefined);
  }, 120_000);
});
```

Run: `cd frontend/apps/web && bunx vitest run src/lib/geo/__tests__/citySql.test.ts`. Expected: FAIL, `Failed to resolve import "../citySql"`.

- [ ] **Step 3: Split the list at build time**

In `generate-cities.mjs`, where it writes `cities.min.json`, write instead `cities-part-${String(i).padStart(2, '0')}.json` for each 1,000-row slice (keeping row order, so the global index is `part * 1000 + offset`), and `manifest.json` with `version` = sha256 hex of the concatenated part files, `rows`, `parts`. Run it: `node frontend/scripts/generate-cities.mjs`. Confirm `ls W/src/data/cities | wc -l` is 26 and `jq .rows W/src/data/cities/manifest.json` is 24293. Delete `W/src/data/cities.min.json` with `git rm`.

- [ ] **Step 4: Implement `citySql.ts` and route `cityLookup.ts` through it**

```ts
// W/src/lib/geo/citySql.ts
/**
 * City rows live in SQLite (spec Part 3): JS keeps only the candidates of one
 * lookup. The list is imported once per version, one same-origin part at a
 * time, so the import's peak is a part, not the 2 MB file. Row index = rowid,
 * so `city:<index>` refs in saved pins stay valid.
 */
import type { SqlDatabase } from '../derivedDb';
import { citySearchText, foldPlaceText, type CityRow } from './cityLookup';

export const CITY_SQL_CANDIDATES = 200;
export interface IndexedCityRow { readonly index: number; readonly row: CityRow; }
export type CityPartLoader = () => Promise<{ version: string; parts: readonly (() => Promise<readonly CityRow[]>)[] }>;

const PART_MODULES = import.meta.glob<{ default: readonly CityRow[] }>('../../data/cities/cities-part-*.json');
const realParts: CityPartLoader = async () => {
  const manifest = (await import('../../data/cities/manifest.json')).default as { version: string };
  const parts = Object.keys(PART_MODULES).sort().map((path) => async () => (await PART_MODULES[path]()).default);
  return { version: manifest.version, parts };
};

let importing: Promise<void> | undefined;

async function importAll(db: SqlDatabase, load: CityPartLoader): Promise<void> {
  const { version, parts } = await load();
  const current = await db.query<{ value: string }>("SELECT value FROM dataset_meta WHERE key = 'cities_version'");
  if (current[0]?.value === version) return;
  await db.exec("DELETE FROM dataset_meta WHERE key = 'cities_version'");
  await db.exec('DELETE FROM cities');
  let index = 0;
  for (const part of parts) {
    const rows = await part();
    await db.executeMany(
      'INSERT INTO cities (idx, n, c, cc, lat, lon, p, name_fold, search_fold) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rows.map((row) => [index++, row.n, row.c, row.cc, row.lat, row.lon, row.p, foldPlaceText(row.n), citySearchText(row)]),
    );
  }
  await db.exec("INSERT INTO cities_fts(cities_fts) VALUES ('rebuild')");
  await db.exec("INSERT INTO dataset_meta (key, value) VALUES ('cities_version', ?)", [version]);
}

export function ensureCitiesImported(db: SqlDatabase, load: CityPartLoader = realParts): Promise<void> {
  if (load !== realParts) return importAll(db, load);
  importing ??= importAll(db, load).catch((error: unknown) => { importing = undefined; throw error; });
  return importing;
}

function ftsQuery(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

export async function cityCandidates(db: SqlDatabase, query: string): Promise<IndexedCityRow[]> {
  const norm = foldPlaceText(query).trim();
  const tokens = norm.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const long = tokens.filter((token) => token.length >= 3);
  const short = tokens.filter((token) => token.length < 3);
  const where = [
    ...(long.length ? ['idx IN (SELECT rowid FROM cities_fts WHERE cities_fts MATCH ?)'] : []),
    ...short.map(() => "search_fold LIKE '%' || ? || '%'"),
  ].join(' AND ');
  const binds = [...(long.length ? [ftsQuery(long)] : []), ...short, norm, `${norm}%`, CITY_SQL_CANDIDATES];
  const rows = await db.query<CityRow & { idx: number }>(
    `SELECT idx, n, c, cc, lat, lon, p FROM cities WHERE ${where} ORDER BY (name_fold = ?) DESC, (name_fold LIKE ?) DESC, p DESC LIMIT ?`,
    binds,
  );
  return rows.map(({ idx, ...row }) => ({ index: idx, row }));
}

export async function cityRowAt(db: SqlDatabase, index: number): Promise<CityRow | undefined> {
  const rows = await db.query<CityRow>('SELECT n, c, cc, lat, lon, p FROM cities WHERE idx = ?', [index]);
  return rows[0];
}
```

In `cityLookup.ts`:
- Extract today's per-row match test from `searchCityRowsOffline` (`:200-222`) into `export function cityMatchRank(row, normQuery, tokens): 0 | 1 | 2 | 3` (exact 3, prefix 2, substring or qualifier match 1, no match 0), with no change to its rules.
- Add `export function citySearchText(row: CityRow): string` = `fold` of the name, the country, the country code and every alias word the qualifier rules accept (US→usa, GB→uk, AE→uae, …), joined by spaces. Every token the old matcher accepts is then a substring of `search_fold`, so the SQL filter is a superset of today's matches.
- Make `searchCityRowsOffline` = `const db = await derivedDb(); await ensureCitiesImported(db); const candidates = await cityCandidates(db, query);` then rank them with `cityMatchRank`, drop rank 0, sort by rank then population (today's order), map to `IndexedCityMatch`, take `limit`.
- Make `cityAtIndexOffline(index)` read `cityRowAt(await derivedDb(), index)` after `ensureCitiesImported`.
- Remove `loadCityDb` and its JSON import (`:62-74`). Export `CityRow`.

If the parity test shows a query whose old answer is outside the 200 SQL candidates, raise `CITY_SQL_CANDIDATES` only as far as that query needs and keep it below the 8 MiB lookup budget (B7 measures it); never change the golden.

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend/apps/web && bunx vitest run src/lib/geo/__tests__/citySql.test.ts src/lib/geo src/lib/__tests__/placeEgress.test.ts src/lib/__tests__/timingTool.places.test.ts`. Expected: PASS. Older geo tests that mocked the JSON import now need the derived DB: give them the in-process database with `__setDerivedDbForTest(await freshDb())` plus `ensureCitiesImported(db, <small parts loader>)` in `beforeEach`. Do not loosen an assertion.

- [ ] **Step 6: The memory e2e follows the parts**

In `memory-budget.e2e.spec.ts:264-337`, match city requests with `/cities-part-\d\d/` (not `cities.min`), assert every one is same-origin and that their count is ≤ 25 on the first lookup and 0 on the second, and gate the heap growth on `TIME_TRAVEL_MEMORY_BUDGET.cityLookupHeapGrowthMiB`. Keep `:316` ("on a lite device opening chat never requests the city list") with the new pattern. Delete `cityLookupParity.capture.test.ts`. Remove `PLACE_LOOKUP_HEAP_GROWTH_MIB` from `memoryBudget.ts` (its doc said "never raised"; it is replaced by a lower number, 8, which the PR states).

- [ ] **Step 7: Commit**

```bash
git add frontend/scripts/generate-cities.mjs frontend/apps/web/src/data/cities frontend/apps/web/src/lib/geo/citySql.ts frontend/apps/web/src/lib/geo/cityLookup.ts frontend/apps/web/src/lib/geo/__tests__/citySql.test.ts frontend/apps/web/src/lib/geo/__tests__/cityLookupParity.golden.json frontend/apps/web/src/lib/geo/__tests__/cityParityQueries.ts frontend/apps/web/e2e/memory-budget.e2e.spec.ts frontend/apps/web/e2e/memoryBudget.ts
git rm --cached -q frontend/apps/web/src/data/cities.min.json 2>/dev/null; git add -u frontend/apps/web/src/data
git commit -m "feat(places): city rows live in SQLite on OPFS; lookups are SQL, imported part by part"
```

Check `git status` before committing: only the files above (plus edited geo tests, named one by one) are staged.

### Task B4: Per-day period-sky rows in SQLite, without boot proofs

**Files:**
- Modify: `frontend/packages/store/src/predictive.ts:192` (export `withoutBootProof`), `frontend/packages/store/src/index.ts` (re-export it)
- Modify: `frontend/packages/browser/src/pyodide/engineMemo.ts` (`memoizeChartEngine` adds `identity(): string`), `frontend/packages/store/src/predictive.ts:58` (`PredictiveRuntime` gains `identity?(): string`)
- Create: `W/src/lib/periodSkyRows.ts`, `W/src/lib/__tests__/periodSkyRows.test.ts`
- Modify: `W/src/lib/periodSky.ts` (durable read before compute, write after; engine-call counter; first-use sweep)
- Modify: `W/src/lib/runtimeObservability.ts` (publish `__almameshPeriodEngineCalls`)
- Test: `W/src/lib/__tests__/periodSky.test.ts` (add cases), `frontend/packages/browser/src/__tests__/engineMemo.test.ts` (or the file that tests `memoizeChartEngine`)

**Interfaces:**
- Produces:
  ```ts
  // @almamesh/store
  export function withoutBootProof(raw: CachedPredictiveContexts | undefined): CachedPredictiveContexts | undefined;
  // periodSkyRows.ts
  export class DurableReceiptError extends Error {}
  export interface PeriodSkyRows {
    read(engineHash: string, requestKey: string): Promise<CachedPredictiveContexts | undefined>;
    write(engineHash: string, requestKey: string, profileKey: string, payload: CachedPredictiveContexts): Promise<void>;
    deleteForProfile(profileKey: string): Promise<void>;
    sweepOtherEngines(engineHash: string): Promise<number>;
    clear(): Promise<void>;
  }
  export function createPeriodSkyRows(db: () => Promise<SqlDatabase>): PeriodSkyRows;
  export function periodSkyRows(): PeriodSkyRows; // over derivedDb()
  // periodSky.ts
  export interface PeriodSkyCacheOptions { readStore?; timeoutMs?; rows?: PeriodSkyRows | null; }
  export function periodEngineCallCount(): number;
  ```

- [ ] **Step 1: Failing row-store tests**

```ts
// W/src/lib/__tests__/periodSkyRows.test.ts
import { describe, expect, it } from 'vitest';
import { openNodeSqlDatabase } from '@gainratio/browser/sql/node';

import { migrateDerivedDb } from '../derivedDb';
import { createPeriodSkyRows, DurableReceiptError } from '../periodSkyRows';

async function rows() {
  const db = await openNodeSqlDatabase({ name: `sky-${Math.random()}` });
  await migrateDerivedDb(db);
  return { db, rows: createPeriodSkyRows(async () => db) };
}
const PAYLOAD = { transit_context: { reference: '2019-03-14T00:00:00Z' } } as never;

describe('period_sky rows', () => {
  it('reads back what it wrote, by engine hash and request key', async () => {
    const { rows: store } = await rows();
    await store.write('hashA', 'key1', 'p1', PAYLOAD);
    expect(await store.read('hashA', 'key1')).toEqual(PAYLOAD);
    expect(await store.read('hashB', 'key1')).toBeUndefined();
  });

  it('refuses to write a payload that carries a boot-signed receipt', async () => {
    const { rows: store } = await rows();
    const forged = { ...PAYLOAD, domain_strength_receipts: [{ sig: 'x' }] } as never;
    await expect(store.write('hashA', 'key1', 'p1', forged)).rejects.toBeInstanceOf(DurableReceiptError);
    const withSigner = { ...PAYLOAD, strength_signer_public_key: 'k' } as never;
    await expect(store.write('hashA', 'key1', 'p1', withSigner)).rejects.toBeInstanceOf(DurableReceiptError);
  });

  it('a tampered row carrying a receipt is a miss, and is deleted', async () => {
    const { db, rows: store } = await rows();
    await db.exec("INSERT INTO period_sky VALUES ('hashA', 'key1', 'p1', ?)", [JSON.stringify({ ...PAYLOAD, domain_strength_receipts: [] })]);
    expect(await store.read('hashA', 'key1')).toBeUndefined();
    expect((await db.query<{ n: number }>('SELECT count(*) AS n FROM period_sky'))[0]?.n).toBe(0);
  });

  it('an old engine hash is a miss and is swept', async () => {
    const { rows: store } = await rows();
    await store.write('old', 'key1', 'p1', PAYLOAD);
    await store.write('new', 'key2', 'p1', PAYLOAD);
    expect(await store.sweepOtherEngines('new')).toBe(1);
    expect(await store.read('old', 'key1')).toBeUndefined();
    expect(await store.read('new', 'key2')).toEqual(PAYLOAD);
  });

  it("deletes one profile's rows only", async () => {
    const { rows: store } = await rows();
    await store.write('h', 'k1', 'p1', PAYLOAD);
    await store.write('h', 'k2', 'p2', PAYLOAD);
    await store.deleteForProfile('p1');
    expect(await store.read('h', 'k1')).toBeUndefined();
    expect(await store.read('h', 'k2')).toEqual(PAYLOAD);
  });
});
```

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/periodSkyRows.test.ts`. Expected: FAIL, `Failed to resolve import "../periodSkyRows"`.

- [ ] **Step 2: Implement the row store and export `withoutBootProof`**

In `packages/store/src/predictive.ts:192` change `function withoutBootProof(` to `export function withoutBootProof(`, and add `withoutBootProof` to the predictive export line in `packages/store/src/index.ts`.

```ts
// W/src/lib/periodSkyRows.ts
/**
 * Durable per-day period-sky results (spec Part 3). Derived personal data:
 * recomputable, never exported, purged with the profile. Payloads must carry
 * no per-boot proof (engineMemo.ts header): a write with a receipt or signer
 * key is refused, and a stored row with one is a miss and is deleted.
 */
import type { CachedPredictiveContexts } from '@almamesh/store';

import { derivedDb, type SqlDatabase } from './derivedDb';

export class DurableReceiptError extends Error {
  constructor() {
    super('A period-sky payload with a boot-signed receipt must never be stored.');
    this.name = 'DurableReceiptError';
  }
}

export interface PeriodSkyRows {
  read(engineHash: string, requestKey: string): Promise<CachedPredictiveContexts | undefined>;
  write(engineHash: string, requestKey: string, profileKey: string, payload: CachedPredictiveContexts): Promise<void>;
  deleteForProfile(profileKey: string): Promise<void>;
  sweepOtherEngines(engineHash: string): Promise<number>;
  clear(): Promise<void>;
}

function carriesBootProof(payload: object): boolean {
  return 'domain_strength_receipts' in payload || 'strength_signer_public_key' in payload;
}

export function createPeriodSkyRows(db: () => Promise<SqlDatabase>): PeriodSkyRows {
  return {
    async read(engineHash, requestKey) {
      const conn = await db();
      const found = await conn.query<{ payload: string }>('SELECT payload FROM period_sky WHERE engine_hash = ? AND request_key = ?', [engineHash, requestKey]);
      if (!found[0]) return undefined;
      const payload = JSON.parse(found[0].payload) as CachedPredictiveContexts;
      if (!carriesBootProof(payload)) return payload;
      await conn.exec('DELETE FROM period_sky WHERE engine_hash = ? AND request_key = ?', [engineHash, requestKey]);
      return undefined;
    },
    async write(engineHash, requestKey, profileKey, payload) {
      if (carriesBootProof(payload)) throw new DurableReceiptError();
      await (await db()).exec('INSERT OR REPLACE INTO period_sky (engine_hash, request_key, profile_key, payload) VALUES (?, ?, ?, ?)', [engineHash, requestKey, profileKey, JSON.stringify(payload)]);
    },
    async deleteForProfile(profileKey) {
      await (await db()).exec('DELETE FROM period_sky WHERE profile_key = ?', [profileKey]);
    },
    async sweepOtherEngines(engineHash) {
      const conn = await db();
      const stale = await conn.query<{ n: number }>('SELECT count(*) AS n FROM period_sky WHERE engine_hash <> ?', [engineHash]);
      await conn.exec('DELETE FROM period_sky WHERE engine_hash <> ?', [engineHash]);
      return stale[0]?.n ?? 0;
    },
    async clear() {
      await (await db()).exec('DELETE FROM period_sky');
    },
  };
}

let shared: PeriodSkyRows | undefined;
export function periodSkyRows(): PeriodSkyRows {
  shared ??= createPeriodSkyRows(derivedDb);
  return shared;
}
```

Run Step 1's command. Expected: PASS (5 tests).

- [ ] **Step 3: Failing `periodSky` tests (durable read/write, counter, sweep)**

Add to `W/src/lib/__tests__/periodSky.test.ts`, following that file's runtime and input fakes:

```ts
import { createPeriodSkyRows } from '../periodSkyRows';
import { periodEngineCallCount } from '../periodSky';

function memoryRows() {
  const map = new Map<string, unknown>();
  const swept: string[] = [];
  return {
    swept,
    rows: {
      read: async (h: string, k: string) => map.get(`${h}|${k}`) as never,
      write: async (h: string, k: string, _p: string, v: unknown) => { map.set(`${h}|${k}`, v); },
      deleteForProfile: async () => {},
      sweepOtherEngines: async (h: string) => { swept.push(h); return 0; },
      clear: async () => map.clear(),
    },
    map,
  };
}

it('a second visit to the same day reads SQLite and never calls the engine', async () => {
  const { rows } = memoryRows();
  const runtime = { computePredictive: vi.fn(async () => CONTEXTS_WITH_RECEIPTS), identity: () => 'hashA' };
  const first = createPeriodSkyCache({ rows, readStore: emptyStore });
  await first.load(INPUT, runtime, new AbortController().signal);
  const second = createPeriodSkyCache({ rows, readStore: emptyStore });   // a new tab session
  await second.load(INPUT, runtime, new AbortController().signal);
  expect(runtime.computePredictive).toHaveBeenCalledTimes(1);
});

it('writes the payload without its boot proof', async () => {
  const { rows, map } = memoryRows();
  const runtime = { computePredictive: async () => CONTEXTS_WITH_RECEIPTS, identity: () => 'hashA' };
  await createPeriodSkyCache({ rows, readStore: emptyStore }).load(INPUT, runtime, new AbortController().signal);
  const stored = [...map.values()][0] as Record<string, unknown>;
  expect(stored).not.toHaveProperty('domain_strength_receipts');
  expect(stored).not.toHaveProperty('strength_signer_public_key');
});

it('sweeps other engine hashes once, on first durable use', async () => {
  const { rows, swept } = memoryRows();
  const runtime = { computePredictive: async () => CONTEXTS_WITH_RECEIPTS, identity: () => 'hashA' };
  const cache = createPeriodSkyCache({ rows, readStore: emptyStore });
  await cache.load(INPUT, runtime, new AbortController().signal);
  await cache.load({ ...INPUT, referenceInstant: '2019-03-15T00:00:00Z' }, runtime, new AbortController().signal);
  expect(swept).toEqual(['hashA']);
});

it('without an engine identity, stays memory-only (plan ruling 10)', async () => {
  const { rows, map } = memoryRows();
  await createPeriodSkyCache({ rows, readStore: emptyStore }).load(INPUT, { computePredictive: async () => CONTEXTS_WITH_RECEIPTS }, new AbortController().signal);
  expect(map.size).toBe(0);
});

it('counts engine calls, and a cache hit adds none', async () => {
  const before = periodEngineCallCount();
  const { rows } = memoryRows();
  const runtime = { computePredictive: async () => CONTEXTS_WITH_RECEIPTS, identity: () => 'hashA' };
  await createPeriodSkyCache({ rows, readStore: emptyStore }).load(INPUT, runtime, new AbortController().signal);
  await createPeriodSkyCache({ rows, readStore: emptyStore }).load(INPUT, runtime, new AbortController().signal);
  expect(periodEngineCallCount() - before).toBe(1);
});
```

`CONTEXTS_WITH_RECEIPTS` is the file's predictive fixture plus `domain_strength_receipts: []` and `strength_signer_public_key: 'k'`; `emptyStore` is a `readStore` returning `{ status: 'idle' }` (copy the shape the file already uses). `createPeriodSkyRows` is imported so the type of `rows` is checked against it: `const _typed: ReturnType<typeof createPeriodSkyRows> = memoryRows().rows;`.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/periodSky.test.ts`. Expected: FAIL, `periodEngineCallCount is not exported` and the engine called twice.

- [ ] **Step 4: Implement in `periodSky.ts` and the engine identity**

```ts
// additions to W/src/lib/periodSky.ts
import { withoutBootProof } from '@almamesh/store';
import { periodSkyRows, type PeriodSkyRows } from './periodSkyRows';

export interface PeriodSkyCacheOptions {
  readonly readStore?: () => PredictiveStoreSnapshot;
  readonly timeoutMs?: number;
  /** Durable rows. Default: SQLite on OPFS. null: memory only (tests). */
  readonly rows?: PeriodSkyRows | null;
}

let engineCalls = 0;
/** Engine calls made by period computes in this tab (exit-gate hook: a cache hit must add none). */
export function periodEngineCallCount(): number {
  return engineCalls;
}
```

In `createPeriodSkyCache`: `const rows = options.rows === undefined ? periodSkyRows() : options.rows; let swept = false;`. In `start`, increment `engineCalls += 1` inside the queued callback, right before `runtime.computePredictive(...)`. Replace `load` with:

```ts
    load(input, runtime, signal) {
      if (signal.aborted) return Promise.reject(abortReason(signal));
      const key = predictiveRequestKey(input);
      const store = readStore();
      if (store.status === 'ready' && store.requestKey === key && store.rawContexts) {
        return Promise.resolve(store.rawContexts);
      }
      const engineHash = runtime.identity?.();
      const work = inFlight.get(key) ?? (rows && engineHash ? durable(rows, engineHash, key, input, runtime) : start(key, input, runtime));
      return withDeadline(work, signal, deadline);
    },
```

with, inside `createPeriodSkyCache`:

```ts
  const durable = async (store: PeriodSkyRows, engineHash: string, key: string, input: EnsurePredictiveInput, runtime: PredictiveRuntime) => {
    if (!swept) { swept = true; await store.sweepOtherEngines(engineHash).catch(() => 0); }
    const hit = await store.read(engineHash, key).catch(() => undefined);
    if (hit) return hit;
    const fresh = await start(key, input, runtime);
    const safe = withoutBootProof(fresh);
    if (safe) await store.write(engineHash, key, input.profileKey, safe).catch(() => undefined);
    return fresh;
  };
```

A failed SQLite read or write never fails the moment: the engine result is still returned (the storage block screen already covers a refused OPFS). Track the durable promise in `inFlight` the same way `start` does, so two callers join one compute.

`engineMemo.ts`: in the object `memoizeChartEngine` returns, add `identity: () => identity` (the manifest hash it already receives). Add `identity?(): string` to `PredictiveRuntime` (`packages/store/src/predictive.ts:58`) and to the `ChartEngine` type the runtime returns (wherever `memoizeChartEngine`'s return type is declared). Add a unit in the engine-memo test: "identity() is the manifest hash it was built with".

`runtimeObservability.ts`: declare `__almameshPeriodEngineCalls?: () => number` on `Window` and publish it next to `publishPinnedThreads` (`:104`), under the same hooks-only guard: `window.__almameshPeriodEngineCalls = periodEngineCallCount;`. Call the publisher from `AlmaMeshRuntimeProvider.tsx:128` where the others are installed.

- [ ] **Step 5: Run to verify it passes**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/periodSky.test.ts src/lib/__tests__/periodSkyRows.test.ts src/lib/__tests__/momentSky.test.ts && cd ../../packages/browser && bunx vitest run src/__tests__ && cd ../store && bunx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/packages/store/src/predictive.ts frontend/packages/store/src/index.ts frontend/packages/browser/src/pyodide/engineMemo.ts frontend/apps/web/src/lib/periodSkyRows.ts frontend/apps/web/src/lib/__tests__/periodSkyRows.test.ts frontend/apps/web/src/lib/periodSky.ts frontend/apps/web/src/lib/__tests__/periodSky.test.ts frontend/apps/web/src/lib/runtimeObservability.ts frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx
git commit -m "feat(time-travel): per-day sky results kept in SQLite without boot proofs; a revisit never runs the engine"
```

(Add the engine-memo test file and any `ChartEngine` type file you touched, by name.)

### Task B5: Purge, reset, restore, export and legal copy

**Files:**
- Modify: `W/src/lib/profileDataLifecycle.ts` (`ProfileDataLifecycleDeps` `:54`, `DEFAULT_DEPS` `:114-120`, `deleteProfileData` `:209-~245`)
- Modify: `W/src/lib/resetEverything.ts:181` (remove the derived DB), `W/src/lib/backupService.ts:486-487` (empty `period_sky` on restore)
- Modify: `W/e2e/portable-invariants.spec.ts` (a `DERIVED_CACHES_NOT_EXPORTED` list and assertion)
- Modify: `W/src/locales/{en,es,pt}/legal.json` (`s1_sub2_li1_text` and `deleted_p1`)
- Test: `W/src/lib/profileDataLifecycle.test.ts`, `W/src/locales/legal.periodSky.test.ts` (new), the reset and backup tests that already cover `clearMemory`

**Interfaces:**
- Consumes: `periodSkyRows()` (B4), `removeDerivedDb()` (B2).
- Produces: `ProfileDataLifecycleDeps.deletePeriodSkyForProfile(profileId: string): Promise<void>`.

- [ ] **Step 1: Failing tests**

In `profileDataLifecycle.test.ts`, following its deps-fake pattern:

```ts
it('profile delete removes its period_sky rows', async () => {
  const deletePeriodSkyForProfile = vi.fn(async () => {});
  await deleteProfileData('p1', { ...fakeDeps(), deletePeriodSkyForProfile });
  expect(deletePeriodSkyForProfile).toHaveBeenCalledWith('p1');
});

it('a failed period_sky purge is warned, not thrown, like derived memory', async () => {
  const deletePeriodSkyForProfile = vi.fn(async () => { throw new Error('opfs gone'); });
  await expect(deleteProfileData('p1', { ...fakeDeps(), deletePeriodSkyForProfile })).resolves.not.toThrow();
});
```

In the reset test (the one asserting `clearMemory` is called), add `expect(removeDerivedDb).toHaveBeenCalled()` with `vi.mock('../derivedDb', ...)`. In the backup restore test that asserts `clearChatMemory`, add a `clearPeriodSky` override and assert it ran.

`W/src/locales/legal.periodSky.test.ts`, following `legal.quarantine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import en from './en/legal.json';
import es from './es/legal.json';
import pt from './pt/legal.json';

const STORAGE = {
  en: 'Worked-out skies for dates you time-travel to are kept on your device so a second visit is instant. They are recomputable, are never exported, and are deleted with the profile.',
  es: 'Los cielos calculados para las fechas a las que viajas en el tiempo se guardan en tu dispositivo para que una segunda visita sea inmediata. Se pueden recalcular, nunca se exportan y se borran con el perfil.',
  pt: 'Os céus calculados para as datas para onde você viaja no tempo ficam no seu aparelho, para que uma segunda visita seja instantânea. Podem ser recalculados, nunca são exportados e são apagados com o perfil.',
};

describe('legal copy names the time-travel sky cache', () => {
  it.each([['en', en], ['es', es], ['pt', pt]] as const)('%s storage inventory', (lang, catalog) => {
    expect(JSON.stringify(catalog)).toContain(STORAGE[lang]);
  });
});
```

In `portable-invariants.spec.ts`, add to the first round-trip scenario (`:390`) after export: travel to a Month on the Dashboard first (so `period_sky` has a row on a full-tier-forced page), then:

```ts
const DERIVED_CACHES_NOT_EXPORTED = ['almamesh-derived'] as const; // cache, not exported (spec Part 3)
const exported = new TextDecoder().decode(bytes);
expect(exported, 'the period sky is a cache, not exported').not.toContain('2019-03-01T00:00:00Z');
expect(exported).not.toContain(DERIVED_CACHES_NOT_EXPORTED[0]);
```

Run: `cd frontend/apps/web && bunx vitest run src/lib/profileDataLifecycle.test.ts src/locales/legal.periodSky.test.ts`. Expected: FAIL (`deletePeriodSkyForProfile` never called; the legal string not found).

- [ ] **Step 2: Implement**

- `ProfileDataLifecycleDeps`: add `readonly deletePeriodSkyForProfile?: (profileId: string) => Promise<void>;`. `DEFAULT_DEPS`: `deletePeriodSkyForProfile: (id) => periodSkyRows().deleteForProfile(id)`. In `deleteProfileData`, right after the derived-memory delete, `await withinDerivedMemoryDeleteSla(deps.deletePeriodSkyForProfile?.(profileId) ?? Promise.resolve())` with the same `safeWarn` on failure.
- `resetEverything.ts:181`: after `clearMemory()`, `await removeDerivedDb().catch(safeWarnOrIgnoreStorageUnavailable)` (follow how it tolerates `SemanticMemoryStorageUnavailableError`).
- `backupService.ts:486-487`: add `override?.clearPeriodSky ?? (() => periodSkyRows().clear())` and call it where `clearChatMemory` runs on restore.
- Legal: append the en/es/pt sentences above to `s1_sub2_li1_text`, and add "time-travel skies" to the list in `deleted_p1` in each language.

- [ ] **Step 3: Run to verify it passes**

Run Step 1's command plus the reset and backup tests. Expected: PASS. Then `bun run test:e2e:portable-invariants --project=chromium`: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/src/lib/profileDataLifecycle.ts frontend/apps/web/src/lib/profileDataLifecycle.test.ts frontend/apps/web/src/lib/resetEverything.ts frontend/apps/web/src/lib/backupService.ts frontend/apps/web/e2e/portable-invariants.spec.ts frontend/apps/web/src/locales/en/legal.json frontend/apps/web/src/locales/es/legal.json frontend/apps/web/src/locales/pt/legal.json frontend/apps/web/src/locales/legal.periodSky.test.ts
git commit -m "feat(privacy): time-travel skies are purged with the profile, removed on reset, emptied on restore, never exported"
```

(Add the reset and backup test files you edited, by name.)

### Task B6: Turn Day and "Where?" on for every tier (contract reversals)

**Files:**
- Modify: `frontend/packages/browser/src/deviceTier.ts:47-73` (`minimal` and `lite`: `periodSkyComputeAllowed: true`; every tier `periodSkyCacheSize: 1`), its doc comment at `:37-43`
- Modify: `W/src/lib/chatToolset.ts:155-181` (register `resolve_place`, the place reader and the Moon loader on every tier)
- Modify (contract reversals, inverted not deleted): `frontend/packages/browser/src/__tests__/deviceTier.test.ts:36-83`, `W/src/lib/__tests__/chatToolset.test.ts:168,217,223,238,250,258,329,371`

**Interfaces:** `DevicePolicy` is unchanged in shape. The flag stays as the test seam.

- [ ] **Step 1: Invert the tests first (they go red against today's code)**

`deviceTier.test.ts`:
- `:36` minimal: pin `periodSkyCacheSize: 1, periodSkyComputeAllowed: true`.
- `:48` lite: pin `periodSkyCacheSize: 1, periodSkyComputeAllowed: true`.
- `:60` full: pin `periodSkyCacheSize: 1, periodSkyComputeAllowed: true`.
- `:72` rename to `'period-sky memory pool: one per tier; the durable copy is in SQLite'` and assert `1` for all three.
- `:78` rename to `'period skies: every tier computes them (spec Part 3; was full-only)'` and assert `true` for all three.

`chatToolset.test.ts`: invert each of the eight lite-tier tests. Keep each test, rename it to the new behaviour, and flip the assertion:
- `:168` → "a lite device answers a dated question with transits" (expect the loader called).
- `:217` → "registers resolve_place on every tier".
- `:223` → "follows devicePolicy: every tier gets resolve_place" (`names(4)` contains `'resolve_place'`).
- `:238` → "a lite device gets the place reader and the Moon loader".
- `:250`, `:258` → a lite device looks the place up / asks where, as full does.
- `:329` → "a lite device answers a Day pin with transits and reads the place".
- `:371` → "hands a lite device the place reader for a Day pin".

Run: `cd frontend/packages/browser && bunx vitest run src/__tests__/deviceTier.test.ts; cd ../../apps/web && bunx vitest run src/lib/__tests__/chatToolset.test.ts`. Expected: FAIL on every inverted assertion (e.g. `expected false to be true`). Paste the counts in the PR.

- [ ] **Step 2: Implement**

`deviceTier.ts`: set `periodSkyComputeAllowed: true` and `periodSkyCacheSize: 1` in all three tiers. Rewrite the `:37-43` comment: "Every tier computes period skies (spec 2026-10-10 Part 3). Memory stays bounded because results live in SQLite on OPFS and one stays in memory; the first compute's peak is gated by `TIME_TRAVEL_MEMORY_BUDGET` (e2e/memoryBudget.ts). Kept as a flag: it is the test seam."

`chatToolset.ts:155-181`: keep `skyAllowed` for the timing tool's description, but make the place path unconditional:

```ts
    const agentTools = createChatAgentTools({ ...
      periodSkyAllowed: skyAllowed,
      ...(pinned ? { pinned: pinnedTiming(pinned) } : {}),
      loadMoonWindow: createMoonWindowLoader(input.engine),
      placeFromRef: reader,
    });
    const tools = [...agentTools, createResolvePlaceTool()];
```

and update the comment above it ("every tier reads places: city rows are SQL queries, so a lookup holds only its candidates").

- [ ] **Step 3: Run to verify it passes**

Same commands as Step 1, plus `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolsetWiring.test.ts src/components/features/chat/__tests__/TimeTravelSheet.test.tsx`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/packages/browser/src/deviceTier.ts frontend/packages/browser/src/__tests__/deviceTier.test.ts frontend/apps/web/src/lib/chatToolset.ts frontend/apps/web/src/lib/__tests__/chatToolset.test.ts
git commit -m "feat(time-travel)!: Day and Where? on every tier; one period sky in memory, the rest in SQLite

Contract reversal: lite and minimal used to answer dated questions with dashas
only and never load places. They now compute period skies and read places."
```

### Task B7: End-to-end on iPhone 15 and Safari, the memory budget, and the JSC crash count

**Files:**
- Modify: `W/e2e/time-travel.spec.ts:883-947` (`@iphone` test) and `:950-…` (`@safari` test) — contract reversals; add a `@iphone15` Day journey
- Modify: `W/scripts/verify-webkit-engine.mjs` (run the Day journey in the durable pass and keep the "no IndexedDB, no in-memory SQLite" invariants)

- [ ] **Step 1: Invert the two e2e contracts and add the Day journey (red first)**

- `:886` rename to `'[contract/stubbed] @iphone offers Day, Month and Year; a Day pin with Bogotá reads the Moon rows'`. Replace `expect(page.getByTestId('time-travel-tab-day'), …).toHaveCount(0)` with `await expect(page.getByTestId('time-travel-tab-day')).toBeVisible()`. Replace `not.toContain('resolve_place')` with `toContain('resolve_place')`. Change the expected tool list to the one a Day question now produces (read the `@safari`/full-tier Day test in the same file for the sequence, e.g. `['get_current_datetime', 'resolve_place', 'get_timing']`). Keep `expectBannerWrapsCleanlyAt380` and the clean console.
- `:950` rename to `'[contract/stubbed] @safari Day pin works on the lite tier'`. Keep `expect('deviceMemory' in navigator).toBe(false)`. Replace the Day `toHaveCount(0)` with a Day pin journey: Day tab → a day → "Where?" Bogotá → Go → `time-travel-title` contains the day and the banner shows "Bogotá".
- New, tagged `@iphone15`:

```ts
test('[contract/real] @iphone15 Day + Bogotá on the Dashboard shows dashas and transits; a revisit runs no engine', async ({ page }, testInfo) => {
  const consoleErrors = captureConsole(page);
  await bootEngine(page);
  await seedChart(page);
  await openDashboard(page);
  const pickDay = async (day: string) => {
    await page.getByTestId('dashboard-time-travel-button').click();
    await page.getByTestId('time-travel-tab-day').click();
    await page.getByTestId('time-travel-day').fill(day);
    await page.getByTestId('time-travel-where').fill('Bogotá');
    await page.getByRole('option', { name: /Bogotá/ }).first().click();
    await page.getByTestId('time-travel-go').click();
    await expect(page.getByTestId('time-travel-moment-transits')).toBeVisible({ timeout: 240_000 });
  };
  await pickDay('2019-03-14');
  await expect(page.getByTestId('time-travel-moment-maha')).toHaveText('Rahu');
  await expect(page.getByTestId('dashboard-time-travel-banner')).toContainText('Bogotá');
  await page.screenshot({ path: testInfo.outputPath('iphone15-day-bogota.png'), fullPage: true });
  await pickDay('2019-03-15');
  const calls = await page.evaluate(() => window.__almameshPeriodEngineCalls?.() ?? Number.NaN);
  await pickDay('2019-03-14');
  expect(await page.evaluate(() => window.__almameshPeriodEngineCalls?.() ?? Number.NaN), 'the revisit reads SQLite').toBe(calls);
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)), 'no IndexedDB').toEqual([]);
  expect(consoleErrors).toEqual([]);
});
```

Read the "Where?" candidate control in `TimeTravelSheet.tsx` and use its real role/testid for picking Bogotá (the Inc D e2e at `:840-870` does it). Run on this Mac: `cd frontend/apps/web && bun run test:e2e:time-travel --project=iphone-webkit --project=webkit --project=iphone-15-webkit --retries=0` against a build **without** B6 (B6 is `HEAD` while B7 is uncommitted: `git log -1 --oneline` must show B6's commit; then `git checkout HEAD~1 -- frontend/packages/browser/src/deviceTier.ts frontend/apps/web/src/lib/chatToolset.ts`, run, then `git checkout HEAD -- frontend/packages/browser/src/deviceTier.ts frontend/apps/web/src/lib/chatToolset.ts` and confirm `git status --short` is clean): expected FAIL (no Day tab). Then with B6: PASS.

- [ ] **Step 2: The WebKit engine gate covers the journey**

In `verify-webkit-engine.mjs`'s durable (`--first-session`) pass, after the chart is ready, drive Dashboard → Time travel → Day → Bogotá → Go, wait for `time-travel-moment-transits`, then re-read `storageEvidence(page)` and keep the existing invariants for this pass: `databases.length === 0` and no in-memory SQLite (`__almameshVerifySqliteMemory` reports OPFS). Run `node scripts/verify-webkit-engine.mjs --first-session` on this Mac: PASS.

- [ ] **Step 3: The memory budget, after**

Run B1 Step 5's two lanes 5 times each on the branch with `TT_MEMORY_GRANULARITY=day`. Every run must be within `TIME_TRAVEL_MEMORY_BUDGET` (as finalised in B1 Step 6) and the WebKit WebContent peak within baseline + 250 MiB. Add the 10 samples to the B1 samples file. If any run is over: stop, and go to B-3a. Never raise a budget.

Show the gate can fail: run the Chromium lane once with `TIME_TRAVEL_MEMORY_BUDGET.heapPeakMiB` temporarily set to 100 through the mutation helper (`python3 "$MUTATE" frontend/apps/web/e2e/memoryBudget.ts '  heapPeakMiB: 440,' '  heapPeakMiB: 100, // MUTANT_TT' -- bash -c 'cd frontend/apps/web && bunx playwright test -c playwright.memory-budget.config.ts e2e/time-travel-memory.e2e.spec.ts --retries=0'`). Expected `KILLED`. (Use the finalised number in OLD if B1 lowered it.)

- [ ] **Step 4: JSC wasm-fault count, before and after**

```bash
cd frontend/apps/web
for i in $(seq 1 20); do bun run test:e2e:time-travel --project=iphone-webkit --project=iphone-15-webkit --retries=0 > "${TMPDIR:-/tmp}/tt-after-$i.log" 2>&1; echo "run $i exit $?"; done
```

Do the same on `origin/main` (a temporary worktree, removed afterwards) for the "before" count. A crash is a run whose log contains the #317 diagnostics' WebContent-lost marker (`startWebKitDiagnostics` names it; grep its exact string from `e2e/webkitDiagnostics.ts`). Count runs by exit code and marker. The after count must not exceed the before count. Put both counts and the 40 exit codes in the PR.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/e2e/time-travel.spec.ts frontend/apps/web/scripts/verify-webkit-engine.mjs
git add -f docs/superpowers/plans/2026-10-10-time-travel-reachable-b1-samples.md
git commit -m "test(e2e)!: Day and Where? on iPhone and Safari; revisit reads SQLite; memory and crash counts recorded

Contract reversal: '@iphone offers Month and Year' and '@safari no Day pin on
the lite tier' asserted the old restriction; both now assert the Day pin works."
```

### Task B8: Mutations, gate, live drive, northstar, PR B

**Files:** none new. Evidence only.

- [ ] **Step 1: Mutation red runs**

```bash
B=frontend/apps/web
VT='cd frontend/apps/web && bunx vitest run "$@"'
# 1. minimal can't compute again -> deviceTier unit + iPhone Day e2e go red
python3 "$MUTATE" frontend/packages/browser/src/deviceTier.ts '    periodSkyComputeAllowed: true,
  },
  lite:' '    periodSkyComputeAllowed: false, // MUTANT_TT
  },
  lite:' -- bash -c 'cd frontend/packages/browser && bunx vitest run src/__tests__/deviceTier.test.ts'
# 2. Look cities up by parsing the JSON instead of SQL -> the lookup heap gate (8 MiB) goes red
python3 "$MUTATE" $B/src/lib/geo/cityLookup.ts '  const candidates = await cityCandidates(db, query);' '  const candidates = (await Promise.all(Object.values(import.meta.glob<{ default: CityRow[] }>("../../data/cities/cities-part-*.json")).map(async (load) => (await load()).default))).flat().map((row, index) => ({ index, row })); // MUTANT_TT' -- \
  bash -c 'cd frontend/apps/web && bunx playwright test -c playwright.memory-budget.config.ts e2e/memory-budget.e2e.spec.ts --grep "first place lookup" --retries=0'
# 3. Keep period payloads in an unbounded JS Map -> the time-travel memory budget gate goes red
python3 "$MUTATE" $B/src/lib/periodSky.ts '    const hit = await store.read(engineHash, key).catch(() => undefined);' '    const hit = (globalThis as { __tt?: Map<string, unknown> }).__tt?.get(key) as CachedPredictiveContexts | undefined ?? await store.read(engineHash, key).catch(() => undefined); /* MUTANT_TT */ (globalThis as { __tt?: Map<string, unknown> }).__tt ??= new Map(); for (let i = 0; i < 40; i++) (globalThis as { __tt?: Map<string, unknown> }).__tt?.set(`${key}#${i}`, structuredClone(await start(key, input, runtime)));' -- \
  bash -c 'cd frontend/apps/web && TT_MEMORY_GRANULARITY=day bunx playwright test -c playwright.memory-budget.config.ts e2e/time-travel-memory.e2e.spec.ts --retries=0'
# 4. Write a row without stripping the boot proof -> the durable-receipt unit goes red
python3 "$MUTATE" $B/src/lib/periodSkyRows.ts '      if (carriesBootProof(payload)) throw new DurableReceiptError();' '      // MUTANT_TT' -- bash -c "$VT" _ src/lib/__tests__/periodSkyRows.test.ts
# 5. Skip the period_sky purge on profile delete -> the deletion test goes red
python3 "$MUTATE" $B/src/lib/profileDataLifecycle.ts 'deps.deletePeriodSkyForProfile?.(profileId)' 'undefined /* MUTANT_TT */' -- bash -c "$VT" _ src/lib/profileDataLifecycle.test.ts
# 6. A revisit runs the engine (durable read skipped) -> the periodSky revisit unit and the @iphone15 revisit e2e go red
python3 "$MUTATE" $B/src/lib/periodSky.ts '    if (hit) return hit;' '    if (hit && false) return hit; /* MUTANT_TT */' -- bash -c "$VT" _ src/lib/__tests__/periodSky.test.ts
# 7. City import drops the row index (refs break) -> citySql "keeping each row at its list index" goes red
python3 "$MUTATE" $B/src/lib/geo/citySql.ts 'rows.map((row) => [index++, row.n,' 'rows.map((row) => [(index++) + 1 /* MUTANT_TT */, row.n,' -- bash -c "$VT" _ src/lib/geo/__tests__/citySql.test.ts
```

Mutation 1's OLD text must occur once: if the `minimal` block's closing differs, adjust OLD to the exact three lines in `deviceTier.ts` (the block that precedes `lite:`). Mutation 3 is deliberately brutal (40 retained copies per load); if its run is not over budget, increase the loop to 100 in NEW and say so in the PR. Also run mutation 1 against the `@iphone15` e2e on the macOS lane once and paste the line.

Expected: seven `KILLED` lines, plus the budget mutation from B7 Step 3. Run the restore check.

- [ ] **Step 2: Full gate**

`make gate; echo "gate exit $?"` and `bun test ./tests/*.test.ts; echo "contract exit $?"`, both 0. `derivedDb.ts`, `citySql.ts`, `periodSkyRows.ts` and the new `periodSky.ts` branches at 100% branch coverage, every `throw` covered. `frontend-quality` on the diff. `cd frontend/packages/browser && bun run test:parity` (unchanged engine; must stay green).

- [ ] **Step 3: Live end-to-end**

No-hooks build and preview as in A7 Step 3, through real onboarding:
- iPhone 15 WebKit (macOS, `devices['iPhone 15']`): Dashboard → Time travel → Day → 14 March 2019 → "Where?" Bogotá → Go. Dashas and transits show. Pick another day, then 14 March again: instant. Open chat (AI on, if a key is on this machine; else say unverified for the real model and point to the stubbed `@iphone` e2e) and ask "What was the Moon doing that day?": the answer names Bogotá rows. Screenshots, clean console.
- Desktop Safari (lite): the same Day + Bogotá journey.
- Desktop Chromium: the same, plus DevTools → Application: OPFS holds `almamesh-derived`; IndexedDB has no databases.
- Delete the profile: `period_sky` rows for it are gone (check with the `__almameshVerifySqliteMemory` hook or a hooks build query).

- [ ] **Step 4: Northstar grade**

Dispatch `northstar` with both claims, the B1 samples, the before/after crash counts, the mutation table, the contract reversals list (spec table: five rows), the gate output and the live screenshots. Fix anything below A and re-grade.

- [ ] **Step 5: Open PR B**

```bash
git push -u origin claude/time-travel-reach-b
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-reach-b \
  --title "feat(time-travel)!: Day and Where? on iPhone and Safari, bounded by SQLite" --body-file "${TMPDIR:-/tmp}/tt-reach-b.md"
```

The body says loudly, near the top, that it **reverses stated contracts**: the five rows of the spec's reversal table, plus `PLACE_LOOKUP_HEAP_GROWTH_MIB` 48 → `cityLookupHeapGrowthMiB` 8 and `periodSkyCacheSize` 5/3/1 → 1. It names the dependency on #317, the B1 decision (3a or not) with the samples, the crash counts, the mutation table, the evidence table and anything unverified. End with the two attribution lines.

- [ ] **Step 6: Merge and clean up**

As A7 Step 6, for `claude/time-travel-reach-b` and `.worktrees/time-travel-reach-b`, then drive the iPhone 15 Day journey against production once.

---
# PR C — Part 4: the chat `time_travel` tool

Claim touched: **"Coordinates never reach the model; only a place label and its time zone do."**

Plan rulings for PR C:

11. **The tool builds `as_of` through the sheet's own `asOfFromDraft`.** There is no `YYYY-MM` or `YYYY` parser in the app; the sheet builds a `SheetDraft` from its selects. The tool builds the same `SheetDraft` from its arguments, so the two produce byte-equal `as_of` by construction, and a unit proves it.
12. **The pending move is a per-turn slot, passed down like `asOf`.** `buildChatToolset` is built fresh for each question inside `askLocalLlm` (`Dashboard.tsx:322`) and `askMeshLlm` (`MeshEdge.tsx:321`), and there is no per-turn context object. So `ChatPanel` makes a slot per send and threads its `record` function down the existing stream call as one more optional argument; it reads the slot after `submit` resolves.
13. **A pending move is dropped if the user moved the pin during the turn.** If the thread's pin at the end of the turn differs from the pin at its start, the user acted last, and the tool's move is not applied (last action wins, not last tool call).
14. **The tool is registered only when the stream passes a recorder.** Chat only runs with AI on (`Dashboard.tsx:284` backstop), so "only when AI is configured" holds, and the timing tests that build a toolset without a recorder are unchanged.

### Task C1: The tool `lib/timeTravelTool.ts`

**Files:**
- Create: `W/src/lib/timeTravelTool.ts`, `W/src/lib/__tests__/timeTravelTool.test.ts`
- Modify: `W/src/lib/__tests__/placeEgress.test.ts` (add the tool's result to the wire scan)

**Interfaces:**
- Consumes: `AgentTool`, `AgentJsonObject`, `NEEDS_PLACE_ERROR`, `PLACE_REF_ARG_PATTERN`, `PLACE_REF_ERROR`, `BEFORE_BIRTH_MESSAGE`, `endsBeforeBirthYear` (`@almamesh/llm`); `PlaceReader` (`lib/timingPlaces.ts:31`); `asOfFromDraft(draft: SheetDraft): ChatThreadAsOf | undefined`, `formatPinLabel`, `SheetDraft` (`lib/timeTravelSheet.ts:10,64,77`); `chatAsOfProblem` (`@almamesh/store`).
- Produces:
  ```ts
  export const TIME_TRAVEL_TOOL_NAME = 'time_travel';
  export const TIME_TRAVEL_STATUS_LABEL = 'Moving to that time';
  export const TIME_TRAVEL_DATE_PATTERN = '^\\d{4}(-\\d{2}(-\\d{2})?)?$';
  export type TravelRecorder = (asOf: ChatThreadAsOf) => void;
  export interface TravelSlot { readonly record: TravelRecorder; take(): ChatThreadAsOf | undefined; }
  export function createTravelSlot(): TravelSlot;                       // last call wins
  export function draftFromToolArgs(period: 'day' | 'month' | 'year', date: string, place?: ChatThreadAsOf['place']): SheetDraft | undefined;
  export interface TimeTravelToolInput { readonly birthYear: number | undefined; readonly placeFromRef: PlaceReader; readonly language: string; readonly record: TravelRecorder; }
  export function createTimeTravelTool(input: TimeTravelToolInput): AgentTool;
  // result: { status: 'moved'; period_label: string; place_label?: string; time_zone?: string } | { error: string }
  ```

- [ ] **Step 1: Failing tests**

```ts
// W/src/lib/__tests__/timeTravelTool.test.ts
import { describe, expect, it, vi } from 'vitest';
import { BEFORE_BIRTH_MESSAGE, NEEDS_PLACE_ERROR, PLACE_REF_ERROR } from '@almamesh/llm';

import { asOfFromDraft, type SheetDraft } from '../timeTravelSheet';
import { createTimeTravelTool, createTravelSlot, draftFromToolArgs, TIME_TRAVEL_TOOL_NAME } from '../timeTravelTool';

const BOGOTA = { summary: { place_ref: 'city:4021', label: 'Bogotá, Colombia', timezone: 'America/Bogota' }, latitude: 4.60971, longitude: -74.08175 };
const context = () => ({ now: new Date('2026-10-10T12:00:00Z'), signal: new AbortController().signal });

function tool(record = vi.fn()) {
  return {
    record,
    tool: createTimeTravelTool({ birthYear: 1990, language: 'en', record,
      placeFromRef: vi.fn(async (ref: string) => (ref === 'city:4021' ? BOGOTA : undefined)) }),
  };
}

describe('time_travel tool', () => {
  it('is named by its constant and refuses unknown keys', () => {
    const { tool: t } = tool();
    expect(t.name).toBe(TIME_TRAVEL_TOOL_NAME);
    expect(t.parameters).toMatchObject({ required: ['period', 'date'], additionalProperties: false });
  });

  it('"take me to March 2019" records a Month and says moved', async () => {
    const { tool: t, record } = tool();
    const result = await t.execute({ period: 'month', date: '2019-03' }, context());
    expect(result).toEqual({ status: 'moved', period_label: 'March 2019' });
    expect(record).toHaveBeenCalledWith({ start: '2019-03-01', end: '2019-03-31', granularity: 'month' });
  });

  it('a Day without a place asks for one, and records nothing', async () => {
    const { tool: t, record } = tool();
    expect(await t.execute({ period: 'day', date: '2019-03-14' }, context())).toEqual({ error: NEEDS_PLACE_ERROR });
    expect(record).not.toHaveBeenCalled();
  });

  it('a Day with a place: coordinates go into the pin, never into the result', async () => {
    const { tool: t, record } = tool();
    const result = await t.execute({ period: 'day', date: '2019-03-14', place_ref: 'city:4021' }, context());
    expect(result).toEqual({ status: 'moved', period_label: expect.stringContaining('2019'), place_label: 'Bogotá, Colombia', time_zone: 'America/Bogota' });
    expect(JSON.stringify(result)).not.toMatch(/4\.6|74\.08|latitude|longitude|"lat"|"lon"/);
    expect(record.mock.calls[0]?.[0]?.place).toEqual({ label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.60971, longitude: -74.08175 });
  });

  it('an unknown or malformed place_ref is refused', async () => {
    const { tool: t } = tool();
    expect(await t.execute({ period: 'day', date: '2019-03-14', place_ref: 'city:9' }, context())).toEqual({ error: PLACE_REF_ERROR });
    expect(await t.execute({ period: 'day', date: '2019-03-14', place_ref: 'pinned' }, context())).toEqual({ error: PLACE_REF_ERROR });
  });

  it('before the birth year: an error, and nothing moves', async () => {
    const { tool: t, record } = tool();
    expect(await t.execute({ period: 'year', date: '1989' }, context())).toEqual({ error: BEFORE_BIRTH_MESSAGE });
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    [{ period: 'week', date: '2019-03' }],
    [{ period: 'month', date: '2019-3' }],
    [{ period: 'month', date: '2019-13' }],
    [{ period: 'day', date: '2019-02-30', place_ref: 'city:4021' }],
    [{ period: 'year', date: '2053' }],
    [{ period: 'year' }],
  ])('refuses %j and records nothing', async (args) => {
    const { tool: t, record } = tool();
    expect(await t.execute(args, context())).toHaveProperty('error');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('the sheet and the tool give byte-equal as_of', () => {
  it.each([
    ['month', '2019-03', { granularity: 'month', day: '2019-03-01', month: '2019-03', year: 2019 }],
    ['year', '2027', { granularity: 'year', day: '2027-01-01', month: '2027-01', year: 2027 }],
  ] as const)('%s %s', (period, date, sheet) => {
    const fromTool = asOfFromDraft(draftFromToolArgs(period, date) as SheetDraft);
    expect(JSON.stringify(fromTool)).toBe(JSON.stringify(asOfFromDraft(sheet as SheetDraft)));
  });

  it('day with a place', () => {
    const place = { label: 'Bogotá, Colombia', timezone: 'America/Bogota', latitude: 4.60971, longitude: -74.08175 };
    const sheet: SheetDraft = { granularity: 'day', day: '2019-03-14', month: '2019-03', year: 2019, place };
    expect(JSON.stringify(asOfFromDraft(draftFromToolArgs('day', '2019-03-14', place) as SheetDraft))).toBe(JSON.stringify(asOfFromDraft(sheet)));
  });
});

describe('createTravelSlot', () => {
  it('last call wins, and take() empties it', () => {
    const slot = createTravelSlot();
    slot.record({ start: '2019-01-01', end: '2019-12-31', granularity: 'year' });
    slot.record({ start: '2019-03-01', end: '2019-03-31', granularity: 'month' });
    expect(slot.take()).toEqual({ start: '2019-03-01', end: '2019-03-31', granularity: 'month' });
    expect(slot.take()).toBeUndefined();
  });
});
```

Check `SheetDraft`'s real field set (`timeTravelSheet.ts:10-16`) before running; the sheet's own `sheetDefaults` shows what `day`/`month`/`year` hold for a Month or a Year draft. If `asOfFromDraft` for a Month reads only `month`, the other fields still must be what the sheet sets, so the stringified drafts match too.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelTool.test.ts`. Expected: FAIL, `Failed to resolve import "../timeTravelTool"`.

- [ ] **Step 2: Implement**

```ts
// W/src/lib/timeTravelTool.ts
/**
 * `time_travel`: "take me to March 2019" moves the thread and the Dashboard
 * (spec Part 4). execute only RECORDS the move; the chat UI applies it through
 * lib/timeTravel.ts after the turn, so the pin never changes mid-answer
 * (useChatThread's pin_changed guard). The as_of is built with the sheet's own
 * asOfFromDraft (byte-equal by construction). Coordinates go into the pin and
 * never into the result: the model sees a period label, a place label and an
 * IANA zone. Errors are returned, never thrown (like get_timing).
 */
import {
  BEFORE_BIRTH_MESSAGE, endsBeforeBirthYear, NEEDS_PLACE_ERROR, PLACE_REF_ARG_PATTERN, PLACE_REF_ERROR,
  type AgentJsonObject, type AgentTool,
} from '@almamesh/llm';
import type { ChatThreadAsOf } from '@almamesh/shared-types';
import { chatAsOfProblem } from '@almamesh/store';

import type { PlaceReader } from './timingPlaces';
import { asOfFromDraft, formatPinLabel, type SheetDraft } from './timeTravelSheet';

export const TIME_TRAVEL_TOOL_NAME = 'time_travel';
export const TIME_TRAVEL_STATUS_LABEL = 'Moving to that time';
export const TIME_TRAVEL_DATE_PATTERN = '^\\d{4}(-\\d{2}(-\\d{2})?)?$';
const DATE_FOR: Readonly<Record<'day' | 'month' | 'year', RegExp>> = {
  day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/, year: /^\d{4}$/,
};
const PERIODS = ['day', 'month', 'year'] as const;
const PERIOD_ERROR = 'period must be day, month or year';
const DATE_ERROR = 'date must be YYYY-MM-DD for a day, YYYY-MM for a month, YYYY for a year, between 1900 and 2052';
const PLACE_PATTERN = new RegExp(PLACE_REF_ARG_PATTERN);
const DESCRIPTION = 'Move this conversation to a day, month or year, as if the user tapped Time travel. Use only when the user asks to go to a time. A day needs place_ref from resolve_place. Answers refer to that time from the next message on.';

export type TravelRecorder = (asOf: ChatThreadAsOf) => void;
export interface TravelSlot { readonly record: TravelRecorder; take(): ChatThreadAsOf | undefined; }

export function createTravelSlot(): TravelSlot {
  let pending: ChatThreadAsOf | undefined;
  return {
    record: (asOf) => { pending = asOf; },
    take: () => { const next = pending; pending = undefined; return next; },
  };
}

export function draftFromToolArgs(period: 'day' | 'month' | 'year', date: string, place?: ChatThreadAsOf['place']): SheetDraft | undefined {
  if (!DATE_FOR[period].test(date)) return undefined;
  const year = Number(date.slice(0, 4));
  if (period === 'year') return { granularity: 'year', day: `${date}-01-01`, month: `${date}-01`, year };
  if (period === 'month') return { granularity: 'month', day: `${date}-01`, month: date, year };
  return { granularity: 'day', day: date, month: date.slice(0, 7), year, ...(place ? { place } : {}) };
}

export interface TimeTravelToolInput {
  readonly birthYear: number | undefined;
  readonly placeFromRef: PlaceReader;
  readonly language: string;
  readonly record: TravelRecorder;
}

type ToolResult = { status: 'moved'; period_label: string; place_label?: string; time_zone?: string } | { error: string };

async function placeFor(input: TimeTravelToolInput, ref: unknown): Promise<ChatThreadAsOf['place'] | { error: string } | undefined> {
  if (ref === undefined) return undefined;
  if (typeof ref !== 'string' || !PLACE_PATTERN.test(ref)) return { error: PLACE_REF_ERROR };
  const found = await input.placeFromRef(ref);
  if (!found) return { error: PLACE_REF_ERROR };
  return { label: found.summary.label, timezone: found.summary.timezone, latitude: found.latitude, longitude: found.longitude };
}

async function travel(input: TimeTravelToolInput, args: AgentJsonObject): Promise<ToolResult> {
  const period = PERIODS.find((value) => value === args.period);
  if (!period) return { error: PERIOD_ERROR };
  if (typeof args.date !== 'string' || !DATE_FOR[period].test(args.date)) return { error: DATE_ERROR };
  if (period === 'day' && args.place_ref === undefined) return { error: NEEDS_PLACE_ERROR };
  const place = await placeFor(input, args.place_ref);
  if (place && 'error' in place) return place;
  const draft = draftFromToolArgs(period, args.date, period === 'day' ? place : undefined);
  const asOf = draft ? asOfFromDraft(draft) : undefined;
  if (!asOf || chatAsOfProblem(asOf)) return { error: DATE_ERROR };
  if (endsBeforeBirthYear(asOf, input.birthYear)) return { error: BEFORE_BIRTH_MESSAGE };
  input.record(asOf);
  return {
    status: 'moved',
    period_label: formatPinLabel(asOf, input.language),
    ...(asOf.place ? { place_label: asOf.place.label, time_zone: asOf.place.timezone } : {}),
  };
}

export function createTimeTravelTool(input: TimeTravelToolInput): AgentTool {
  return {
    name: TIME_TRAVEL_TOOL_NAME,
    description: DESCRIPTION,
    statusLabel: TIME_TRAVEL_STATUS_LABEL,
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: [...PERIODS] },
        date: { type: 'string', pattern: TIME_TRAVEL_DATE_PATTERN },
        place_ref: { type: 'string', pattern: PLACE_REF_ARG_PATTERN },
      },
      required: ['period', 'date'],
      additionalProperties: false,
    },
    execute: (args) => travel(input, args),
  };
}
```

`asOfFromDraft` refuses days outside 1900–2052 and unreal days (`isRealDay`), so `2053` and `2019-02-30` return undefined and become `DATE_ERROR`.

- [ ] **Step 3: Add the tool to the egress scan**

In `placeEgress.test.ts`, after `found`/`day`/`asked` are computed, add:

```ts
    const travelled = await createTimeTravelTool({ birthYear: 1990, language: 'en', record: () => {},
      placeFromRef: async () => DELHI_RESOLVED }).execute({ period: 'day', date: '2026-03-08', place_ref: 'city:1' }, options());
```

(using the file's own resolved-Delhi fixture; name it as that file does) and include `travelled` in the `[found, day, asked]` array scanned against `COORDINATE_LIKE`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/timeTravelTool.test.ts src/lib/__tests__/placeEgress.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/timeTravelTool.ts frontend/apps/web/src/lib/__tests__/timeTravelTool.test.ts frontend/apps/web/src/lib/__tests__/placeEgress.test.ts
git commit -m "feat(chat): time_travel tool records a move; the model sees labels, never coordinates"
```

### Task C2: Register the tool and apply the move after the turn

**Files:**
- Modify: `W/src/lib/chatToolset.ts` (`BuildChatToolsetInput` `:31-50` gains `onTravel?: TravelRecorder`; `:181` adds the tool when present)
- Modify: `W/src/pages/Dashboard.tsx` (`handleAskQuestionStream` `:389` and `askLocalLlm` `:265`/`:322` pass `onTravel`), `W/src/pages/MeshEdge.tsx` (`askMeshLlm` `:293`/`:321`, its stream handler, same)
- Modify: `W/src/components/features/chat/ChatPanel.tsx` (`ChatPanelProps.onAskQuestionStream` `:52-64` gains a 9th optional parameter; `handleSubmit` `:120-139`; `streamAnswer` `:413-438`)
- Test: `W/src/lib/__tests__/chatToolsetWiring.test.ts`, `W/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx`

**Interfaces:**
- Consumes: `createTimeTravelTool`, `createTravelSlot`, `TravelRecorder` (C1); `useChatThread(...).travelFromTool(asOf)` (A2); `asOfKey` (`lib/pinnedPeriod`).
- Produces: `onAskQuestionStream(question, onToken, onMeta, viewMode?, history, retrievedContext, onAgentStatus?, asOf?, onTravel?: TravelRecorder)`.

- [ ] **Step 1: Failing tests**

`chatToolsetWiring.test.ts`:

```ts
it('registers time_travel only when the stream passes a recorder (AI chat)', () => {
  expect(names(buildChatToolset(baseInput()))).not.toContain(TIME_TRAVEL_TOOL_NAME);
  expect(names(buildChatToolset({ ...baseInput(), onTravel: () => {} }))).toContain(TIME_TRAVEL_TOOL_NAME);
});

it('names the time-travel tool by its constant, not a literal', () => {
  const source = readFileSync(join(__dirname, '..', 'chatToolset.ts'), 'utf8');
  expect(source).not.toMatch(/['"]time_travel['"]/);
});
```

(`names` and `baseInput` are the file's helpers; use its real names. Import `TIME_TRAVEL_TOOL_NAME` from `../timeTravelTool`.)

`ChatPanel.timeTravel.test.tsx`, with a stub `onAskQuestionStream` that calls the 9th argument the way the tool would:

```tsx
const MARCH_2019 = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' } as const;

function streamThatTravels(asOf = MARCH_2019) {
  return vi.fn(async (_q, onToken, _m, _v, _h, _r, _s, _asOf, onTravel?: (a: typeof MARCH_2019) => void) => {
    onTravel?.(asOf);
    onToken('Moved.');
    return { answer: 'Moved.' };
  });
}

it('applies the move after the turn: banner and Dashboard moment show March 2019', async () => {
  renderPanel({ onAskQuestionStream: streamThatTravels() });
  await send('take me to March 2019');
  expect(screen.getByTestId('time-travel-title')).toHaveTextContent('March 2019');
  expect(useTimeTravelStore.getState().moments[PROFILE_ID]).toEqual(MARCH_2019);
});

it('the move never lands mid-turn: the answer is attached, not dropped as pin_changed', async () => {
  renderPanel({ onAskQuestionStream: streamThatTravels() });
  await send('take me to March 2019');
  expect(screen.getByText('Moved.')).toBeInTheDocument();
  expect(screen.queryByText(/changed the period/i)).toBeNull();   // the en text of chat:errors.pin_changed
});

it('if the user changed the pin during the turn, the tool move is dropped (plan ruling 13)', async () => {
  const stream = vi.fn(async (_q, onToken, _m, _v, _h, _r, _s, _asOf, onTravel?: (a: unknown) => void) => {
    onTravel?.(MARCH_2019);
    await act(() => useChatStore.getState().setThreadAsOf(currentThreadId(), { start: '2027-01-01', end: '2027-12-31', granularity: 'year' }));
    onToken('x');
    return { answer: 'x' };
  });
  renderPanel({ onAskQuestionStream: stream, startPinned: true });
  await send('take me to March 2019');
  expect(useTimeTravelStore.getState().moments[PROFILE_ID]).not.toEqual(MARCH_2019);
});
```

Use the file's real helpers for render, send, profile id and the current thread id, and the real en text of `chat:errors.pin_changed` from `locales/en/chat.json`. Before running, confirm the en text so the `queryByText` really matches it when it appears.

Run: `cd frontend/apps/web && bunx vitest run src/lib/__tests__/chatToolsetWiring.test.ts src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx`. Expected: FAIL (the tool is never registered; the banner never shows March 2019).

- [ ] **Step 2: Implement**

`chatToolset.ts`: add to `BuildChatToolsetInput`

```ts
  /** The per-turn travel slot's recorder (plan ruling 12). Present only for an AI chat turn. */
  readonly onTravel?: TravelRecorder;
```

and at `:181`:

```ts
    const travelTool = input.onTravel
      ? [createTimeTravelTool({ birthYear: birthYearOf(input.birth), placeFromRef: baseReader, language: i18n.language, record: input.onTravel })]
      : [];
    const tools = [...agentTools, createResolvePlaceTool(), ...travelTool];
```

`baseReader` (not the pinned reader): the model names a real `city:` ref; the reserved `pinned` ref is refused by the tool's pattern. Import `i18n` from the app's i18n module the way other `lib/` files do (grep `from '../i18n` in `lib/`), and `birthYearOf` from `./periodChart`.

`Dashboard.tsx` and `MeshEdge.tsx`: add a trailing `onTravel?: TravelRecorder` parameter to the stream handler and to `askLocalLlm`/`askMeshLlm`, and pass `onTravel` into `buildChatToolset({ ..., onTravel })`.

`ChatPanel.tsx`:
- `ChatPanelProps.onAskQuestionStream`: add the trailing `onTravel?: TravelRecorder` parameter.
- `streamAnswer(input, onAskQuestionStream, viewMode, onAgentStatus, preparingLabel, onTravel?: TravelRecorder)`: pass `onTravel` as the 9th argument after `input.asOf`.
- Destructure `travelFromTool` from `useChatThread` (`:81`).
- `handleSubmit`:

```tsx
    const slot = createTravelSlot();
    const pinAtStart = asOfKey(asOf);
    await submit(q, (input) => streamAnswer(input, onAskQuestionStream, viewMode, setAgentActivity, t('agent.preparing'), slot.record));
    const pending = slot.take();
    const pinNow = asOfKey(useChatStore.getState().threads[threadIdRef.current ?? '']?.as_of);
    if (pending && pinNow === pinAtStart) {
      try { await travelFromTool(pending); } catch { setBackState('failed'); }
    }
```

`threadIdRef` is a ref kept equal to `useChatThread`'s `threadId` (add `const threadIdRef = useRef(threadId); threadIdRef.current = threadId;`), because the closure's `threadId` is from the render that started the send. A failed save reuses the banner's existing "Couldn't save this on your device" line (`time-travel-back-failed`).

- [ ] **Step 3: Run to verify it passes**

Same command, plus `bunx vitest run src/hooks/__tests__/useChatThread.timeTravel.test.tsx src/pages/__tests__/Dashboard.chatZone.test.tsx`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/src/lib/chatToolset.ts frontend/apps/web/src/lib/__tests__/chatToolsetWiring.test.ts frontend/apps/web/src/pages/Dashboard.tsx frontend/apps/web/src/pages/MeshEdge.tsx frontend/apps/web/src/components/features/chat/ChatPanel.tsx frontend/apps/web/src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx
git commit -m "feat(chat): the time_travel tool moves the thread and the Dashboard after the turn, through the travel seam"
```

### Task C3: End-to-end (stubbed, desktop and iPhone 15) and the nightly real-model run

**Files:**
- Modify: `W/e2e/time-travel.spec.ts` (a `describe('chat time_travel tool')`)
- Create: `W/e2e/time-travel.tool.real.spec.ts`, `W/playwright.time-travel.tool.real.config.ts`
- Modify: `W/package.json` (script `"test:e2e:time-travel:tool:real"`), `dagger/src/index.ts:105-112` (`NIGHTLY_REPORTED_E2E` gains `"time-travel:tool:real"`), `W/src/test/realModelSpecs.contract.test.ts` (covers the new spec automatically if it globs `*.real.spec.ts`; check), and `W/e2e/realModel.ts` only if Step 3 finds a cheaper model

- [ ] **Step 1: Stubbed e2e (red, then green)**

```ts
test.describe('chat time_travel tool', () => {
  for (const tag of ['', '@iphone15 '] as const) {
    test(`[contract/stubbed] ${tag}"take me to March 2019" moves chat and the Dashboard; the next answer reads March 2019`, async ({ page }, testInfo) => {
      const consoleErrors = await prepare(page);
      const seen: AgentRequest[] = [];
      const bodies: string[] = [];
      await scripted(page, {
        'take me to March 2019': (tools) => tools.length === 0
          ? { content: null, tool_calls: [call('tt', 'time_travel', { period: 'month', date: '2019-03' })] }
          : { content: 'Done. We are in March 2019 now.' },
        'how was work then?': (tools) => tools.length === 0
          ? { content: null, tool_calls: [call('t1', 'get_timing', { section: 'dashas' })] }
          : { content: 'In March 2019 you were in Rahu–Rahu.' },
      }, seen, bodies, new Set());
      await bootEngine(page);
      await seedChart(page);
      await openDashboard(page);
      await page.getByTestId('floating-chat-button').click();
      await sendChat(page, 'take me to March 2019');
      await expect(page.getByTestId('time-travel-title')).toHaveText(/March 2019/);
      await page.getByTestId('floating-chat-minimize').click();
      await expect(page.getByTestId('dashboard-time-travel-title')).toHaveText(/March 2019/);
      await page.getByTestId('floating-chat-button').click();
      await sendChat(page, 'how was work then?');
      const timing = turnTools(seen.at(-1)?.messages ?? []).find((m) => m.content?.includes('2019-03'));
      expect(timing, 'get_timing with no dates read the March 2019 pin').toBeDefined();
      await page.screenshot({ path: testInfo.outputPath(`tool-march-2019${tag ? '-iphone15' : ''}.png`), fullPage: true });
      expect(consoleErrors).toEqual([]);
    });
  }

  test('[contract/stubbed] a Day with Bogotá: no model request body contains coordinates', async ({ page }) => {
    const consoleErrors = await prepare(page);
    const seen: AgentRequest[] = [];
    const bodies: string[] = [];
    await scripted(page, {
      'take me to 14 March 2019 in Bogotá': (tools) => tools.length === 0
        ? { content: null, tool_calls: [call('rp', 'resolve_place', { query: 'Bogotá' })] }
        : tools.length === 1
          ? { content: null, tool_calls: [call('tt', 'time_travel', { period: 'day', date: '2019-03-14', place_ref: refFrom(tools[0]?.content ?? '') })] }
          : { content: 'We are in Bogotá on 14 March 2019.' },
    }, seen, bodies, new Set());
    await bootEngine(page);
    await seedChart(page);
    await openDashboard(page);
    await page.getByTestId('floating-chat-button').click();
    await sendChat(page, 'take me to 14 March 2019 in Bogotá');
    await expect(page.getByTestId('time-travel-banner')).toContainText('Bogotá');
    expect(bodies.flatMap(leaks), 'no coordinates reach the model').toEqual([]);
    const COORDINATES = /4\.6097|-?74\.0817|latitude|longitude/i;
    expect(bodies.filter((body) => COORDINATES.test(body)), 'no model request body carries coordinates').toEqual([]);
    expect(bodies.some((body) => body.includes('America/Bogota')), 'the time zone reaches the model').toBe(true);
    expect(consoleErrors).toEqual([]);
  });
});
```

`sendChat` is the file's existing "type in the composer and press send, then wait for the answer" sequence; if no helper exists, extract it from the `@iphone` test (`:883-947`) into one. Use the real minimize testid of `FloatingChatPanel`. The scripted handler shape (`(tools) =>`) is `Script = (turn: WireMessage[]) => object` (`:449`); the turn passed is the tool messages since the last user message (`turnTools`), so `tools.length` counts this turn's tool results. Read `scripted` (`:451-487`) to confirm before running.

Red: run without C2's registration (`git checkout origin/main -- frontend/apps/web/src/lib/chatToolset.ts`, run `(cd frontend/apps/web && bun run test:e2e:time-travel --project=chromium --grep "time_travel tool")`, then `git checkout HEAD -- frontend/apps/web/src/lib/chatToolset.ts` and confirm `git status --short` is clean). Expected: FAIL (the model's `time_travel` call hits an unknown tool, the banner never shows). Green: `--project=chromium`, then the macOS lane for `--project=iphone-15-webkit`.

- [ ] **Step 2: Nightly real-model spec**

`W/e2e/time-travel.tool.real.spec.ts`, modelled on `e2e/dashboard.agentic.real.spec.ts` (imports `bootEngine`, `seedChart`, `LLM_SETTINGS_KEY` from `./interpretation.helpers` and `E2E_REAL_MODEL` from `./realModel`; self-skips without `OPENROUTER_API_KEY`): configure OpenRouter with `E2E_REAL_MODEL`, open chat, send "Take me to March 2019, please.", and assert `time-travel-title` shows March 2019 within 120 s and the Dashboard banner too. Record the request bodies with `page.on('request')` filtered to `openrouter.ai` and assert none matches the coordinate pattern above. `playwright.time-travel.tool.real.config.ts` copies `playwright.dashboard.agentic.real.config.ts` with the new `testMatch`. Add the package script and the `NIGHTLY_REPORTED_E2E` entry (`dagger/src/index.ts:105-112`). Run `bun test ./tests/*.test.ts` (Dagger contract tests) and `bunx vitest run src/test/realModelSpecs.contract.test.ts`: PASS.

- [ ] **Step 3: Cheapest model by live price**

```bash
curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
models=json.load(sys.stdin)['data']
tool=[m for m in models if 'tools' in (m.get('supported_parameters') or [])]
rows=sorted(((float(m['pricing']['prompt'])+float(m['pricing']['completion']), m['id']) for m in tool if m['id'].startswith(('deepseek/','qwen/','google/','mistralai/','meta-llama/'))))[:8]
print('\n'.join(f'{p*1e6:.3f} USD/Mtok in+out  {i}' for p,i in rows))
"
```

Compare with `E2E_REAL_MODEL` (`deepseek/deepseek-v4-pro`). If a cheaper tool-capable model is listed, run the real spec once with it locally (`OPENROUTER_API_KEY` from the keychain); switch `E2E_REAL_MODEL` and the pinned value in `realModelSpecs.contract.test.ts` only if it passes, and note the prices with today's date in `realModel.ts`'s comment. If no key is available on this machine, say "real-model run unverified locally; covered by the nightly" in the PR.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/web/e2e/time-travel.spec.ts frontend/apps/web/e2e/time-travel.tool.real.spec.ts frontend/apps/web/playwright.time-travel.tool.real.config.ts frontend/apps/web/package.json dagger/src/index.ts
git commit -m "test(e2e): time_travel tool, stubbed on desktop and iPhone 15, plus a nightly real-model run"
```

(Add `e2e/realModel.ts` and the contract test only if Step 3 changed the model.)

### Task C4: Mutations, gate, live drive, northstar, PR C

**Files:** none new. Evidence only.

- [ ] **Step 1: Mutation red runs**

```bash
B=frontend/apps/web
VT='cd frontend/apps/web && bunx vitest run "$@"'
# 1. Add latitude to the tool result -> coordinate-leak unit (+ e2e body scan) go red
python3 "$MUTATE" $B/src/lib/timeTravelTool.ts '    ...(asOf.place ? { place_label: asOf.place.label, time_zone: asOf.place.timezone } : {}),' '    ...(asOf.place ? { place_label: asOf.place.label, time_zone: asOf.place.timezone, latitude: asOf.place.latitude /* MUTANT_TT */ } : {}),' -- \
  bash -c "$VT" _ src/lib/__tests__/timeTravelTool.test.ts src/lib/__tests__/placeEgress.test.ts
# 2. Apply the pin inside execute (mid-turn) -> the pin_changed test goes red
python3 "$MUTATE" $B/src/lib/timeTravelTool.ts '  input.record(asOf);' '  input.record(asOf); void import("./timeTravel").then((m) => m.applyTravel({ asOf, source: "chat-tool" }, { profileId: "MUTANT_TT", chartId: null, thread: "latest" }));' -- \
  bash -c "$VT" _ src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx
# 3. Call setThreadAsOf directly instead of travel() -> the Dashboard moment test goes red
python3 "$MUTATE" $B/src/components/features/chat/ChatPanel.tsx '      try { await travelFromTool(pending); } catch { setBackState('"'"'failed'"'"'); }' '      useChatStore.getState().setThreadAsOf(threadIdRef.current ?? "", pending); /* MUTANT_TT */' -- \
  bash -c "$VT" _ src/components/features/chat/__tests__/ChatPanel.timeTravel.test.tsx
# 4. Build the tool's as_of by hand instead of asOfFromDraft -> the byte-equality unit goes red
python3 "$MUTATE" $B/src/lib/timeTravelTool.ts '  const asOf = draft ? asOfFromDraft(draft) : undefined;' '  const asOf = draft ? ({ granularity: draft.granularity, start: asOfFromDraft(draft)?.start ?? "", end: asOfFromDraft(draft)?.end ?? "" } as ChatThreadAsOf) : undefined; /* MUTANT_TT */' -- \
  bash -c "$VT" _ src/lib/__tests__/timeTravelTool.test.ts
# 5. Skip the before-birth check -> the before-birth unit goes red
python3 "$MUTATE" $B/src/lib/timeTravelTool.ts '  if (endsBeforeBirthYear(asOf, input.birthYear)) return { error: BEFORE_BIRTH_MESSAGE };' '  // MUTANT_TT' -- \
  bash -c "$VT" _ src/lib/__tests__/timeTravelTool.test.ts
```

Mutation 2 must make the pin change while the answer streams, so the guard at `useChatThread.ts:376-386` drops the answer; if the async import resolves after the turn in the test, replace NEW with a synchronous `useChatStore.getState().setThreadAsOf(...)` on the active thread (import `useChatStore` in the mutant) so the move lands mid-turn. Mutation 4's key order differs from `asOfFromDraft`'s (`granularity` first), so the stringified compare fails. Also run mutation 1 against the C3 Bogotá e2e once and paste the line.

Expected: five `KILLED` lines. Run the restore check.

- [ ] **Step 2: Full gate**

`make gate` and `bun test ./tests/*.test.ts`, both 0. `timeTravelTool.ts` at 100% branch coverage. `frontend-quality` on the diff.

- [ ] **Step 3: Live end-to-end**

No-hooks build and preview, real onboarding, AI on with this machine's OpenRouter key (or say unverified and point to C3):
- Desktop Chromium: in chat, "take me to March 2019". The banner moves; minimise chat; the Dashboard banner and card show March 2019. Ask "how was work then?": the answer is about March 2019. "Take me to 14 March 2019 in Bogotá": the banner shows Bogotá. DevTools Network: no request body to the AI endpoint contains `4.60` or `-74.08`. Screenshots, clean console.
- iPhone 15 WebKit (macOS): the same first two steps. Screenshots, clean console.

- [ ] **Step 4: Northstar grade**

Dispatch `northstar` with the claim, the mutation table, the gate output, the e2e and live screenshots, and the nightly run link (or a manual `workflow_dispatch` run of `nightly-e2e.yml` on the branch). Fix anything below A and re-grade.

- [ ] **Step 5: Open PR C, merge, clean up**

```bash
git push -u origin claude/time-travel-reach-c
gh pr create --repo gainratio/almamesh --base main --head claude/time-travel-reach-c \
  --title "feat(chat): time_travel tool — 'take me to March 2019' moves chat and the Dashboard" --body-file "${TMPDIR:-/tmp}/tt-reach-c.md"
```

The body: the claim, plan rulings 11–14, Ruling 6 (no life-events tool) and Ruling 7 (moves right away), the mutation table with the restore check, the evidence table, anything unverified. End with the two attribution lines. When green and graded A, merge and clean up as in A7 Step 6, for `-c`.

---

## Self-review (run against the spec, 2026-10-10)

**Spec coverage.**

| Spec item | Task |
|-----------|------|
| One code path, `TravelRequest`/`TimeTravelController`/`useTimeTravel` | A1 (adds `TravelTarget.thread`, plan ruling 2), A2 |
| Validate, reject before-birth/malformed, never clamp | A1, C1 |
| Moment in a Zustand slice keyed by profile, not persisted (Ruling 1) | A1 |
| Pin chat when AI on; failed save rolls back and rethrows | A1 (plan ruling 1) |
| Dashboard button, testid, label at every width, 44 px, enabled without AI | A4, A6, A7 mutations 1–3 |
| Fixed overlay, focus trap and return focus reused | A4 |
| Composer label on phones | A3 |
| Dashboard banner with `testIdPrefix` | A3, A4 |
| Parts 1 + 2 ship together (Ruling 2) | PR A |
| README claim | A4 |
| Moment card: dashas, transits, working, dashas-only | A5 |
| Through `periodSkyCache()` only, never `usePredictiveStore` | A5, A7 mutation 5 |
| "Today" labels (Ruling 3) | A5 |
| Back to today clears the moment, and chat with AI on | A1, A2, A4 |
| AI-off desktop + iPhone e2e; Change; Back; `@sw` no egress; Life Atlas not evicted | A6, A7 mutations 4–6 |
| iPhone 15 project beside iPhone 13 | A6 |
| Tier flag true everywhere, kept as seam | B6 |
| Cities in SQLite, FTS5 (Ruling 5), ≤ 5 candidates in JS, import per version in parts | B2, B3 |
| `period_sky` keyed by engine hash + request key; read before, write after; pool 1 | B4, B6 |
| Boot proof stripped; forged receipt refused | B4, B8 mutation 4 |
| New engine hash sweep | B4 (plan ruling 8) |
| Profile delete, reset, restore purge; not exported; portable-invariants list | B5 |
| No IndexedDB, no in-memory SQLite, one SQLite library | B2 (`fallback: 'none'`, seam test), B7 Step 2 |
| `resolve_place`, place reader, Moon loader on every tier | B6 |
| Measure first; 3a if over budget (Ruling 4) | B1, B-3a |
| Contract reversals (five rows) inverted, not deleted | B6, B7 |
| `:316` "opening chat never requests the city list" still true | B3 Step 6 |
| Memory budgets, max + 5 %, never raised, NaN fails | B1, B7 Step 3 |
| WebKit RSS via #317 (dependency) | B start gate, B1 Step 4 |
| JSC crash count 20× before/after | B7 Step 4 |
| Second visit reads SQLite, no engine call | B4, B7 Step 1 |
| Legal copy line, en/es/pt | B5 |
| `time_travel` schema, NEEDS_PLACE, place on device, no coordinates in result | C1 |
| UI-applied after the turn, last call wins | C1 (slot), C2 |
| Byte-equal `as_of`, sheet vs tool | C1, C4 mutation 4 |
| Registered on every tier, only with AI | C2 (plan ruling 14), B6 |
| Life-events tool out of scope (Ruling 6) | stated in PR C |
| Move right away in an unpinned thread (Ruling 7) | A2 `travelFromTool`, C2 |
| Stubbed e2e desktop + iPhone 15; coordinate body scan; nightly real run on the cheapest model | C3 |
| Per-PR proof: TDD red, mutation red, gate, live Chromium, live iPhone 15 WebKit, northstar A | A7, B8, C4 |

**Placeholder scan.** No "TBD", "TODO" or "similar to Task N". Where a step depends on a name the plan could not read with certainty (a test file's local helper, a select's value format), the step names the file and line to read and says what to do with each outcome.

**Type consistency.** `applyTravel(request, target, deps?)`, `TravelTarget.thread: 'new' | 'latest' | { id }`, `useTimeTravelStore.moments`, `travelFromTool(asOf)`, `momentPeriod`, `useMomentSky(...).sky/retry`, `PeriodSkyRows`, `periodSkyRows()`, `derivedDb()`, `removeDerivedDb()`, `ensureCitiesImported`, `cityCandidates`, `cityRowAt`, `TravelRecorder`, `createTravelSlot().record/take`, `createTimeTravelTool`, `draftFromToolArgs` are spelled the same in every task that uses them.

**Review Focus.** Each of the five lines has a test in its owning task: profile keying (A1), failed save (A1), late result (A5), lookup parity (B3), tampered/stale rows (B4).
