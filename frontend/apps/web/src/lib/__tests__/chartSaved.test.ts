/**
 * The one wait a page uses before it leaves or says "saved" after a chart write.
 * Contract: a failed write rejects with a typed error and a fixed console code
 * (never the cause, which could carry birth data); a write that never settles
 * (another tab holds the lock) rejects after a bounded wait, so the page can
 * show its in-app Retry instead of "saving" forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const committed = vi.hoisted(() => ({ next: (): Promise<void> => Promise.resolve() }));
vi.mock('@almamesh/store', () => ({
  whenChartLibraryCommitted: () => committed.next(),
}));

import { CHART_SAVE_TIMEOUT_MS, ChartSaveError, waitForChartSaved } from '../chartSaved';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  committed.next = () => Promise.resolve();
});

describe('waitForChartSaved', () => {
  it('resolves when the chart-library write committed, logging nothing', async () => {
    await expect(waitForChartSaved()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects with reason "failed" and logs a fixed code without the cause when the write failed', async () => {
    committed.next = () => Promise.reject(new Error('disk full for Asha born 1990-01-15'));
    const outcome = waitForChartSaved();
    await expect(outcome).rejects.toBeInstanceOf(ChartSaveError);
    await expect(outcome).rejects.toMatchObject({ reason: 'failed' });
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:chart.save_failed]');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Asha');
  });

  it('rejects with reason "timed_out" when the write never settles', async () => {
    vi.useFakeTimers();
    committed.next = () => new Promise<void>(() => undefined);
    const outcome = waitForChartSaved();
    outcome.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(CHART_SAVE_TIMEOUT_MS - 1);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).rejects.toMatchObject({ reason: 'timed_out' });
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:chart.save_timed_out]');
  });

  it('pins the bound the pages promise: 30 seconds', () => {
    expect(CHART_SAVE_TIMEOUT_MS).toBe(30_000);
  });
});
