import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@almamesh/store';

const save = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock('../storeSaved', () => ({
  waitForStoreSaved: async () => {
    save.calls += 1;
    if (save.fail) throw Object.assign(new Error('Saving chat failed.'), { name: 'StoreSaveError' });
  },
}));

import { applyBackToToday, applyTravel, TimeTravelRefusedError, useTimeTravel, useTimeTravelStore, type TravelDeps } from '../timeTravel';

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

  it("thread 'latest' follows listThreads()[0]: a newer unpinned thread is not repinned over an older pinned one", async () => {
    const chat = useChatStore.getState();
    const older = chat.startThread('p1', 'c1', YEAR_2027);
    const newest = chat.startThread('p1', 'c1');
    expect(useChatStore.getState().listThreads('p1')[0]?.id).toBe(newest);
    const out = await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOn);
    expect(out.threadId).not.toBe(older);
    expect(out.threadId).not.toBe(newest);
    expect(useChatStore.getState().threads[older]?.as_of).toEqual(YEAR_2027);
    expect(useChatStore.getState().listThreads('p1')).toHaveLength(3);
  });

  it('thread { id } repins that pinned thread, with no new thread', async () => {
    const chat = useChatStore.getState();
    const target = chat.startThread('p1', 'c1', YEAR_2027);
    chat.startThread('p1', 'c1', YEAR_2027);
    const out = await applyTravel({ asOf: MARCH_2019, source: 'chat-sheet' }, { ...DASH, thread: { id: target } }, aiOn);
    expect(out.threadId).toBe(target);
    expect(useChatStore.getState().threads[target]?.as_of).toEqual(MARCH_2019);
    expect(useChatStore.getState().listThreads('p1')).toHaveLength(2);
  });

  it.each([
    ['unpinned', () => useChatStore.getState().startThread('p1', 'c1')],
    ['unknown', () => 'no-such-thread'],
  ])('thread { id } of an %s thread starts a new pinned thread', async (_name, makeId) => {
    const id = makeId();
    const before = useChatStore.getState().listThreads('p1').length;
    const out = await applyTravel({ asOf: MARCH_2019, source: 'chat-sheet' }, { ...DASH, thread: { id } }, aiOn);
    expect(out.threadId).not.toBe(id);
    expect(useChatStore.getState().threads[out.threadId as string]?.as_of).toEqual(MARCH_2019);
    expect(useChatStore.getState().listThreads('p1')).toHaveLength(before + 1);
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
    const refusal = applyTravel({ asOf: bad, source: 'chat-sheet' }, DASH, aiOff);
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

  it('a failed save rethrows and leaves the moment set', async () => {
    await applyTravel({ asOf: MARCH_2019, source: 'dashboard-sheet' }, DASH, aiOff);
    save.fail = true;
    await expect(applyBackToToday({ profileId: 'p1', chartId: 'c1' }, aiOn)).rejects.toThrow('Saving chat failed.');
    expect(moment()).toEqual(MARCH_2019);
  });
});

describe('default deps: the birth year comes from the chart library', () => {
  const ancient = { start: '1900-01-01', end: '1900-12-31', granularity: 'year' } as const;

  it('with no chartId there is no birth year to refuse against', async () => {
    await applyTravel({ asOf: ancient, source: 'dashboard-sheet' }, { profileId: 'p1', chartId: null, thread: 'new' });
    expect(moment()).toEqual(ancient);
  });

  it('with a chartId the library does not hold, there is no birth year either', async () => {
    await applyTravel({ asOf: ancient, source: 'dashboard-sheet' }, { profileId: 'p1', chartId: 'missing', thread: 'new' });
    expect(moment()).toEqual(ancient);
  });
});

describe('useTimeTravel', () => {
  it('with no profile: no moment, and travel and backToToday touch nothing', async () => {
    const { result } = renderHook(() => useTimeTravel(null, null));
    expect(result.current.moment).toBeUndefined();
    await act(async () => { await result.current.travel({ asOf: MARCH_2019, source: 'dashboard-sheet' }); });
    await act(async () => { await result.current.backToToday(); });
    expect(useTimeTravelStore.getState().moments).toEqual({});
    expect(useChatStore.getState().listThreads('p1')).toEqual([]);
    expect(save.calls).toBe(0);
  });

  it('with a profile: reads its moment, travels, and goes back to today', async () => {
    useTimeTravelStore.setState({ moments: { p1: YEAR_2027 } });
    const { result } = renderHook(() => useTimeTravel('p1', null));
    expect(result.current.moment).toEqual(YEAR_2027);
    await act(async () => { await result.current.travel({ asOf: MARCH_2019, source: 'dashboard-sheet' }); });
    expect(result.current.moment).toEqual(MARCH_2019);
    await act(async () => { await result.current.backToToday(); });
    expect(result.current.moment).toBeUndefined();
  });
});
