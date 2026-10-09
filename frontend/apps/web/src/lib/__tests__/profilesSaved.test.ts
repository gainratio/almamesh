/**
 * The one wait a surface runs before it says a person was added (or navigates
 * as if they were). Contract mirrors `waitForChartSaved`: a failed write
 * rejects with a typed reason and a fixed console code (never the cause, which
 * could carry a name); a write that never settles rejects after a bounded wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const committed = vi.hoisted(() => ({ next: (): Promise<void> => Promise.resolve() }));
vi.mock('@almamesh/store', () => ({
  whenProfilesCommitted: () => committed.next(),
}));

import { PROFILES_SAVE_TIMEOUT_MS, ProfilesSaveError, waitForProfilesSaved } from '../profilesSaved';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  committed.next = () => Promise.resolve();
});

describe('waitForProfilesSaved', () => {
  it('resolves when the profiles write committed, logging nothing', async () => {
    await expect(waitForProfilesSaved()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects with reason "failed" and a fixed code without the cause', async () => {
    committed.next = () => Promise.reject(new Error('disk full while saving Asha Rao'));
    const outcome = waitForProfilesSaved();
    await expect(outcome).rejects.toBeInstanceOf(ProfilesSaveError);
    await expect(outcome).rejects.toMatchObject({ reason: 'failed' });
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:people.save_failed]');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Asha');
  });

  it('rejects with reason "timed_out" when the write never settles', async () => {
    vi.useFakeTimers();
    committed.next = () => new Promise<void>(() => undefined);
    const outcome = waitForProfilesSaved();
    outcome.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(PROFILES_SAVE_TIMEOUT_MS - 1);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).rejects.toMatchObject({ reason: 'timed_out' });
    expect(warn).toHaveBeenCalledWith('[almamesh:warn:people.save_timed_out]');
  });

  it('pins the bound: 30 seconds, the same as a chart save', () => {
    expect(PROFILES_SAVE_TIMEOUT_MS).toBe(30_000);
  });
});
