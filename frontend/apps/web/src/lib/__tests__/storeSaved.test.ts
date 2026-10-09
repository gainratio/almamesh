/**
 * The one wait a surface runs before it says user data is saved (or moves on
 * as if it were). Contract mirrors `waitForChartSaved`: a failed write rejects
 * with a typed reason and a fixed console code (never the cause, which could
 * carry a name or a message); a write that never settles rejects after a
 * bounded wait. Each store waits on its OWN barrier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const committed = vi.hoisted(() => ({
  people: (): Promise<void> => Promise.resolve(),
  life_events: (): Promise<void> => Promise.resolve(),
  chat: (): Promise<void> => Promise.resolve(),
}));
vi.mock('@almamesh/store', () => ({
  whenProfilesCommitted: () => committed.people(),
  whenLifeEventsCommitted: () => committed.life_events(),
  whenChatCommitted: () => committed.chat(),
}));

import {
  STORE_SAVE_TIMEOUT_MS,
  StoreSaveError,
  waitForStoreSaved,
  type SavedStore,
} from '../storeSaved';

const STORES: readonly SavedStore[] = ['people', 'life_events', 'chat'];
const never = (): Promise<void> => new Promise<void>(() => undefined);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of STORES) committed[store] = () => Promise.resolve();
});

describe.each(STORES)('waitForStoreSaved(%s)', (store) => {
  it('resolves when that store committed, logging nothing', async () => {
    await expect(waitForStoreSaved(store)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('waits on its own barrier, not another store’s', async () => {
    for (const other of STORES) if (other !== store) committed[other] = never;
    await expect(waitForStoreSaved(store)).resolves.toBeUndefined();
  });

  it('rejects with reason "failed" and a fixed code without the cause', async () => {
    committed[store] = () => Promise.reject(new Error('disk full while saving Asha Rao'));
    const outcome = waitForStoreSaved(store);
    await expect(outcome).rejects.toBeInstanceOf(StoreSaveError);
    await expect(outcome).rejects.toMatchObject({ store, reason: 'failed' });
    expect(warn).toHaveBeenCalledWith(`[almamesh:warn:${store}.save_failed]`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Asha');
  });

  it('rejects with reason "timed_out" when the write never settles', async () => {
    vi.useFakeTimers();
    committed[store] = never;
    const outcome = waitForStoreSaved(store);
    outcome.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(STORE_SAVE_TIMEOUT_MS - 1);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).rejects.toMatchObject({ store, reason: 'timed_out' });
    expect(warn).toHaveBeenCalledWith(`[almamesh:warn:${store}.save_timed_out]`);
  });
});

it('pins the bound: 30 seconds, the same as a chart save', () => {
  expect(STORE_SAVE_TIMEOUT_MS).toBe(30_000);
});
