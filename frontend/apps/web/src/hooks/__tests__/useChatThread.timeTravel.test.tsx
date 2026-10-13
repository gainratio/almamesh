import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartLibraryStore, useChatStore, type StoredChart } from '@almamesh/store';

const llm = vi.hoisted(() => ({ configured: true }));
vi.mock('@almamesh/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/llm')>()),
  describeLlmStatus: () => ({ configured: llm.configured }),
}));
vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));
import { waitForStoreSaved } from '../../lib/storeSaved';

import i18n from '../../i18n/config';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { useTimeTravelStore } from '../../lib/timeTravel';
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

function threadId(): string {
  return Object.keys(useChatStore.getState().threads)[0]!;
}

describe('a thread deleted mid-answer', () => {
  it('does not throw, leaves nothing behind and logs no stream failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await askInPin(() => useChatStore.getState().deleteThread(threadId()));
    expect(useChatStore.getState().listThreads(PROFILE)).toEqual([]);
    expect(spy.mock.calls.flat()).not.toContain('[almamesh:error:chat.stream_failed]');
    spy.mockRestore();
  });

  it('a stream that rejects after the delete resolves and appends nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => (fail = resolve));
    const stream = vi.fn(async (): Promise<string> => {
      await gate;
      throw new Error('boom');
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit('Q?', stream);
    });
    useChatStore.getState().deleteThread(threadId());
    await act(async () => {
      fail();
      await expect(pending).resolves.toBeUndefined();
    });
    expect(useChatStore.getState().listThreads(PROFILE)).toEqual([]);
    spy.mockRestore();
  });
});

describe('Back to today mid-answer', () => {
  it('lands the answer in the original pinned thread, not the new one', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    const pinnedId = result.current.threadId!;
    const { stream, release } = deferredStream('Pinned answer.');
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit('Q?', stream);
    });
    await act(() => result.current.backToToday());
    const todayId = result.current.threadId!;
    expect(todayId).not.toBe(pinnedId);
    await act(async () => {
      release();
      await pending;
    });
    const store = useChatStore.getState();
    expect(store.getMessages(pinnedId).map((m) => m.content)).toContain('Pinned answer.');
    expect(store.getMessages(todayId).filter((m) => m.role === 'assistant')).toEqual([]);
  });
});

describe('Change on a normal thread', () => {
  it('does nothing', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    const { stream, release } = deferredStream('Fine.');
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submit('Q?', stream);
    });
    await act(async () => {
      release();
      await pending;
    });
    await act(() => result.current.repin(JUNE));
    expect(useChatStore.getState().threads[result.current.threadId!]?.as_of).toBeUndefined();
  });
});

describe('the chat sheet travels through the seam', () => {
  beforeEach(() => {
    useTimeTravelStore.setState({ moments: {} });
    llm.configured = true;
  });
  afterEach(() => {
    llm.configured = true;
    vi.mocked(waitForStoreSaved).mockImplementation(async () => undefined);
  });
  const MARCH_2019 = { start: '2019-03-01', end: '2019-03-31', granularity: 'month' } as const;

  it('Go in chat also sets the Dashboard moment', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(MARCH_2019));
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(MARCH_2019);
    expect(result.current.asOf).toEqual(MARCH_2019);
  });

  it('Change in chat repins the open thread and moves the Dashboard moment', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    const tid = result.current.threadId;
    await act(() => result.current.repin(MARCH_2019));
    expect(result.current.threadId).toBe(tid);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(MARCH_2019);
  });

  it('Change after a conversation opens a second thread; the first keeps its period and messages (Jan 2027 regression)', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(MARCH_2019));
    const first = result.current.threadId!;
    await act(() => result.current.submit('How was March?', async () => 'Busy.'));
    await act(() => result.current.repin(YEAR));
    expect(result.current.threadId).not.toBe(first);
    expect(result.current.asOf).toEqual(YEAR);
    expect(result.current.messages).toEqual([]);
    expect(useChatStore.getState().threads[first]?.as_of).toEqual(MARCH_2019);
    expect(useChatStore.getState().getMessages(first).map((m) => m.content)).toEqual(['How was March?', 'Busy.']);
  });

  it('Back to today in chat clears the Dashboard moment', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(MARCH_2019));
    await act(() => result.current.backToToday());
    expect(useTimeTravelStore.getState().moments[PROFILE]).toBeUndefined();
    expect(result.current.asOf).toBeUndefined();
  });

  it('with no profile, pin and Back to today do nothing and do not throw', async () => {
    useTimeTravelStore.setState({ moments: { [PROFILE]: YEAR } });
    const { result } = renderHook(() => useChatThread(null, CHART));
    await act(() => result.current.pin(MARCH_2019));
    await act(() => result.current.backToToday());
    expect(result.current.threadId).toBeNull();
    expect(Object.keys(useChatStore.getState().threads)).toHaveLength(0);
    expect(useTimeTravelStore.getState().moments).toEqual({ [PROFILE]: YEAR });
  });

  it('with AI off, pin sets the moment, opens no thread and does not throw', async () => {
    llm.configured = false;
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(MARCH_2019));
    expect(result.current.threadId).toBeNull();
    expect(Object.keys(useChatStore.getState().threads)).toHaveLength(0);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(MARCH_2019);
  });

  it('a failed save rejects and moves nothing', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    vi.mocked(waitForStoreSaved).mockRejectedValue(new Error('disk full'));
    await act(async () => {
      await expect(result.current.repin(MARCH_2019)).rejects.toThrow('disk full');
    });
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(YEAR);
    expect(result.current.asOf).toEqual(YEAR);
  });
});

describe('Change then Back to today with a slow save', () => {
  it('ends on today: no moment, the today thread selected, no banner', async () => {
    const today = useChatStore.getState().startThread(PROFILE, CHART);
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    const pinned = result.current.threadId!;
    expect(result.current.asOf).toEqual(YEAR);

    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(waitForStoreSaved).mockImplementationOnce(() => slow);
    let change!: Promise<void>;
    act(() => {
      change = result.current.repin(JUNE);
    });
    await act(() => result.current.backToToday());
    expect(result.current.threadId).toBe(today);
    await act(async () => {
      release();
      await change;
    });
    expect(result.current.threadId).toBe(today);
    expect(result.current.asOf).toBeUndefined();
    expect(useTimeTravelStore.getState().moments[PROFILE]).toBeUndefined();
    expect(pinned).not.toBe(today);
  });
});

describe('chat tool actions apply after a successful durable turn', () => {
  beforeEach(() => {
    useTimeTravelStore.setState({ moments: {} });
    llm.configured = true;
    vi.mocked(waitForStoreSaved).mockImplementation(async () => undefined);
  });
  afterEach(() => vi.mocked(waitForStoreSaved).mockImplementation(async () => undefined));

  it('keeps the current pin during streaming, then opens a new trip for the Dashboard and the next question', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    const originalThread = result.current.threadId;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pending!: Promise<void>;
    const stream = vi.fn(async (input: ChatStreamInput) => {
      input.onTravel?.({ kind: 'travel', asOf: JUNE });
      await gate;
      return 'Moving to June.';
    });
    act(() => { pending = result.current.submit('Take me to June', stream); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.asOf).toEqual(YEAR);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(YEAR);
    await act(async () => { release(); await pending; });
    // Contract reversed 2026-10-13: the tool opens a NEW trip; the answered one keeps its period.
    expect(result.current.threadId).not.toBe(originalThread);
    expect(useChatStore.getState().threads[originalThread!]?.as_of).toEqual(YEAR);
    expect(result.current.asOf).toEqual(JUNE);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(JUNE);
    const next = vi.fn(async (_input: ChatStreamInput) => 'June facts.');
    await act(() => result.current.submit('What about work?', next));
    expect(next.mock.calls[0]?.[0].asOf).toEqual(JUNE);
  });

  it('a tool Back to today leaves the pin and clears the Dashboard moment', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    await act(() => result.current.submit('Back to today', async ({ onTravel }) => {
      onTravel?.({ kind: 'back_to_today' });
      return 'Returning to today.';
    }));
    expect(result.current.asOf).toBeUndefined();
    expect(useTimeTravelStore.getState().moments[PROFILE]).toBeUndefined();
  });

  it.each(['stream', 'save'])('discards a pending move after a %s failure', async (failure) => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    if (failure === 'save') vi.mocked(waitForStoreSaved).mockRejectedValueOnce(new Error('disk full'));
    await act(() => result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      if (failure === 'stream') throw new Error('provider failed');
      return 'Moving.';
    }));
    expect(result.current.asOf).toEqual(YEAR);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(YEAR);
  });

  it.each(['', '   '])('discards movement and shows an error after an empty final answer (%j)', async (answer) => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    await act(() => result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      return answer;
    }));
    expect(result.current.asOf).toEqual(YEAR);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(YEAR);
    expect(result.current.messages.at(-1)?.error).toBe(true);
    expect(result.current.messages.filter((message) => message.role === 'assistant' && !message.error)).toEqual([]);
  });

  it('drops a tool action if the user chooses Back to today while it streams', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pending!: Promise<void>;
    act(() => { pending = result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      await gate;
      return 'Moving.';
    }); });
    await act(() => result.current.backToToday());
    await act(async () => { release(); await pending; });
    expect(result.current.asOf).toBeUndefined();
    expect(useTimeTravelStore.getState().moments[PROFILE]).toBeUndefined();
  });

  it('drops a tool action after switching profiles even when both use the same chart', async () => {
    const { result, rerender } = renderHook(({ profileId }) => useChatThread(profileId, CHART), { initialProps: { profileId: PROFILE } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pending!: Promise<void>;
    act(() => { pending = result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      await gate;
      return 'Moving.';
    }); });
    rerender({ profileId: 'profile-B' });
    await act(async () => { release(); await pending; });
    expect(useTimeTravelStore.getState().moments).toEqual({});
    expect(result.current.asOf).toBeUndefined();
  });

  it.each(['thread', 'profile', 'chart', 'today'] as const)('does not finish a tool move after a %s change during its pin save', async (change) => {
    let otherThread!: string;
    act(() => { otherThread = useChatStore.getState().startThread(PROFILE, CHART); });
    const { result, rerender } = renderHook(
      ({ profileId, chartId }) => useChatThread(profileId, chartId),
      { initialProps: { profileId: PROFILE, chartId: CHART } },
    );
    await act(() => result.current.pin(YEAR));
    let release!: () => void;
    let saving!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { saving = resolve; });
    vi.mocked(waitForStoreSaved)
      .mockResolvedValueOnce(undefined) // The answer is durable before the move.
      .mockImplementationOnce(() => { saving(); return held; });
    let pending!: Promise<void>;
    act(() => { pending = result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      return 'Moving to June.';
    }); });
    await act(async () => { await started; });
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(YEAR);
    if (change === 'thread') act(() => result.current.openThread(otherThread));
    if (change === 'profile') rerender({ profileId: 'profile-B', chartId: CHART });
    if (change === 'chart') rerender({ profileId: PROFILE, chartId: 'chart-B' });
    if (change === 'today') await act(() => result.current.backToToday());
    const selected = result.current.threadId;
    await act(async () => { release(); await pending; });
    expect(result.current.threadId).toBe(selected);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(change === 'today' ? undefined : YEAR);
    expect(useTimeTravelStore.getState().moments['profile-B']).toBeUndefined();
    expect(result.current.isStreaming).toBe(false);
  });

  it('keeps a newly selected today thread and no Dashboard moment when an old unpinned turn finishes saving its move', async () => {
    const source = useChatStore.getState().startThread(PROFILE, CHART);
    const selected = useChatStore.getState().startThread(PROFILE, CHART);
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    act(() => result.current.openThread(source));
    let release!: () => void;
    let saving!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { saving = resolve; });
    vi.mocked(waitForStoreSaved).mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => { saving(); return held; });
    let pending!: Promise<void>;
    act(() => { pending = result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      return 'Moving to June.';
    }); });
    await act(async () => { await started; });
    act(() => result.current.openThread(selected));
    await act(async () => { release(); await pending; });
    expect(result.current.threadId).toBe(selected);
    expect(result.current.asOf).toBeUndefined();
    expect(useTimeTravelStore.getState().moments[PROFILE]).toBeUndefined();
    expect(useChatStore.getState().getMessages(source).at(-1)?.content).toBe('Moving to June.');
  });

  it('does not move the Dashboard after the source pinned thread is deleted during the movement save', async () => {
    let fallback!: string;
    act(() => { fallback = useChatStore.getState().startThread(PROFILE, CHART); });
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(() => result.current.pin(YEAR));
    const source = result.current.threadId!;
    let release!: () => void;
    let saving!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { saving = resolve; });
    vi.mocked(waitForStoreSaved).mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => { saving(); return held; });
    let pending!: Promise<void>;
    act(() => { pending = result.current.submit('Go to June', async ({ onTravel }) => {
      onTravel?.({ kind: 'travel', asOf: JUNE });
      return 'Moving to June.';
    }); });
    await act(async () => { await started; });
    act(() => useChatStore.getState().deleteThread(source));
    // While the move saves, its new (empty) trip is listed; it is removed once the move is cancelled.
    await act(async () => { release(); await pending; });
    expect(useChatStore.getState().threads[source]).toBeUndefined();
    expect(result.current.threadId).toBe(fallback);
    expect(useTimeTravelStore.getState().moments[PROFILE]).toEqual(YEAR);
    expect(result.current.isStreaming).toBe(false);
  });
});
