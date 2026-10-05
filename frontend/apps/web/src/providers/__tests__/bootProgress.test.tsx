/**
 * Engine boot progress must not starve user input.
 *
 * During the bundle sync the Workers report progress hundreds of times a
 * second. On the 2026-10-02 release tip every report was a new `stage` on the
 * ONE engine context, so every `useChartEngine()` consumer (the whole
 * Onboarding page, birth-date field included) re-rendered per report — that
 * churn is what manufactured the keystroke-loss window in BirthDatePicker.
 *
 * Contract pinned here:
 *   - `useChartEngine().stage` is COARSE: it changes when the bootstrap enters
 *     a new stage, never on byte-level progress.
 *   - byte-level progress lives on `useEngineBootProgress()`, coalesced to at
 *     most one update per 250 ms (<= 4/s), trailing-edge so the last report
 *     always lands; a stage change passes through immediately.
 *   - `lastProgressAt()` still sees EVERY report (the idle budget must not
 *     be throttled).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useRef } from 'react';

import type { BootStage, ChartEngine, OnStage, RuntimeConfig } from '@almamesh/browser';
import { AlmaMeshRuntimeProvider } from '../AlmaMeshRuntimeProvider';
import {
  PROGRESS_COALESCE_MS,
  useChartEngine,
  useEngineBootProgress,
} from '../chartEngineContext';

// The engine boots only once canonical SQLite is durable on OPFS; these tests
// are about other behavior, so storage is ready from the start.
vi.mock('@almamesh/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/store')>()),
  portableStatePersistence: () => 'opfs',
  subscribePortableStatePersistence: () => () => undefined,
}))

beforeEach(() => {
  vi.useFakeTimers();
  window.history.pushState({}, '', '/onboarding');
});
afterEach(() => {
  vi.useRealTimers();
  window.history.pushState({}, '', '/');
});

const fakeEngine = {
  generateChart: vi.fn(),
  computePredictive: vi.fn(),
  computeMeshEdge: vi.fn(),
  meta: () => null,
} as unknown as ChartEngine;

const chunks = (bytesDone: number): BootStage => ({
  kind: 'syncing',
  progress: { phase: 'chunks', bytesDone, bytesTotal: 1000 } as never,
});

/** A runtime whose bootstrap hands the test its `onStage` and never resolves on its own. */
function makeDrivableRuntime() {
  let report: OnStage = () => undefined;
  let finish: () => void = () => undefined;
  const runtime = {
    bootstrap(_config: RuntimeConfig, onStage: OnStage = () => {}) {
      report = onStage;
      return new Promise<ChartEngine>((resolve) => {
        finish = () => resolve(fakeEngine);
      });
    },
  };
  return { runtime, report: (stage: BootStage) => report(stage), finish: () => finish() };
}

/** The live `lastProgressAt` of the mounted provider, read by the consumer below. */
let liveLastProgressAt: (() => number) | undefined;

function EngineConsumer() {
  const renders = useRef(0);
  renders.current += 1;
  const { stage, lastProgressAt } = useChartEngine();
  liveLastProgressAt = lastProgressAt;
  return (
    <div>
      <span data-testid="engine-renders">{renders.current}</span>
      <span data-testid="engine-stage">{stage?.kind ?? 'none'}</span>
      <span data-testid="engine-progress-at">{lastProgressAt?.() ?? 0}</span>
    </div>
  );
}

function ProgressConsumer() {
  const renders = useRef(0);
  renders.current += 1;
  const stage = useEngineBootProgress();
  const bytes = stage?.kind === 'syncing' && stage.progress?.phase === 'chunks' ? stage.progress.bytesDone : -1;
  return (
    <div>
      <span data-testid="progress-renders">{renders.current}</span>
      <span data-testid="progress-bytes">{bytes}</span>
    </div>
  );
}

function mount() {
  const drive = makeDrivableRuntime();
  render(
    <AlmaMeshRuntimeProvider runtime={drive.runtime}>
      <EngineConsumer />
      <ProgressConsumer />
    </AlmaMeshRuntimeProvider>,
  );
  return drive;
}

const text = (id: string) => screen.getByTestId(id).textContent;
const num = (id: string) => Number(text(id));

describe('engine boot progress — coalesced, and off the engine context', () => {
  it('pins the coalescing window at 250 ms (<= 4 updates/s)', () => {
    expect(PROGRESS_COALESCE_MS).toBe(250);
  });

  it('a stage change reaches both contexts immediately', () => {
    const drive = mount();
    act(() => drive.report({ kind: 'syncing' }));
    expect(text('engine-stage')).toBe('syncing');
    act(() => drive.report({ kind: 'synced', result: {} as never }));
    expect(text('engine-stage')).toBe('synced');
  });

  it('byte-level progress never re-renders a useChartEngine() consumer', () => {
    const drive = mount();
    act(() => drive.report({ kind: 'syncing' }));
    const before = num('engine-renders');
    act(() => {
      for (let i = 1; i <= 100; i += 1) drive.report(chunks(i));
    });
    act(() => vi.advanceTimersByTime(PROGRESS_COALESCE_MS * 4));
    expect(num('engine-renders')).toBe(before);
    expect(text('engine-stage')).toBe('syncing');
  });

  it('coalesces a burst of reports into at most one progress update per window, keeping the last', () => {
    const drive = mount();
    act(() => drive.report({ kind: 'syncing' }));
    const before = num('progress-renders');
    act(() => {
      for (let i = 1; i <= 100; i += 1) drive.report(chunks(i));
    });
    // Leading edge: the first report of the window may land at once ...
    expect(num('progress-renders') - before).toBeLessThanOrEqual(1);
    // ... and the LAST one lands when the window closes, nothing in between.
    act(() => vi.advanceTimersByTime(PROGRESS_COALESCE_MS));
    expect(num('progress-bytes')).toBe(100);
    expect(num('progress-renders') - before).toBeLessThanOrEqual(2);
  });

  it('spreads a steady stream to <= 4 updates per second', () => {
    const drive = mount();
    act(() => drive.report({ kind: 'syncing' }));
    const before = num('progress-renders');
    // 1 s of reports every 5 ms (200 reports), like the chunk phase on a fast link.
    act(() => {
      for (let i = 1; i <= 200; i += 1) {
        drive.report(chunks(i));
        vi.advanceTimersByTime(5);
      }
    });
    expect(num('progress-renders') - before).toBeLessThanOrEqual(5);
    act(() => vi.advanceTimersByTime(PROGRESS_COALESCE_MS));
    expect(num('progress-bytes')).toBe(200);
  });

  it('every report still refreshes lastProgressAt() (the idle budget is not throttled)', () => {
    const drive = mount();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    act(() => drive.report({ kind: 'syncing' }));
    const first = num('engine-progress-at');
    vi.setSystemTime(new Date('2026-10-02T00:00:00.050Z'));
    act(() => drive.report(chunks(1)));
    // The engine context did not re-render (coarse), but the clock behind it moved.
    expect(screen.getByTestId('engine-progress-at').textContent).toBe(String(first));
    expect(liveLastProgressAt?.()).toBe(first + 50);
  });

  it('a late stage change flushes nothing stale from the previous window', () => {
    const drive = mount();
    act(() => drive.report({ kind: 'syncing' }));
    act(() => drive.report(chunks(1)));
    act(() => drive.report(chunks(2)));
    act(() => drive.report({ kind: 'synced', result: {} as never }));
    act(() => vi.advanceTimersByTime(PROGRESS_COALESCE_MS * 2));
    // The held chunk report must not overwrite the newer stage.
    expect(text('engine-stage')).toBe('synced');
    expect(num('progress-bytes')).toBe(-1);
  });
});
