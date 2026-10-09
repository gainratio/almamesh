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
