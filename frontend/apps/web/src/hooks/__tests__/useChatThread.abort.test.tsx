import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartLibraryStore, useChatStore, type StoredChart } from '@almamesh/store';

const llm = vi.hoisted(() => ({ configured: true }));
vi.mock('@almamesh/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@almamesh/llm')>()),
  describeLlmStatus: () => ({ configured: llm.configured }),
}));
vi.mock('../../lib/storeSaved', () => ({ waitForStoreSaved: vi.fn(async () => undefined) }));

import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';
import { useChatThread, type ChatStreamInput } from '../useChatThread';

const PROFILE = 'profile-A';
const CHART = 'chart-A';
const YEAR = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;

beforeEach(() => {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  useChartLibraryStore.setState({ charts: { [CHART]: { chart_id: CHART, profile_id: PROFILE, person_name: 'P', is_primary: true, sidereal_chart: {} } as unknown as StoredChart } });
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

/** Starts a turn that waits on its own signal, as the real fetch does; returns the signal it was given. */
async function startTurn(result: { current: ReturnType<typeof useChatThread> }) {
  let seen: AbortSignal | undefined;
  const stream = vi.fn(async (input: ChatStreamInput) => {
    seen = input.signal;
    await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve()));
    return 'late';
  });
  let pending!: Promise<void>;
  act(() => { pending = result.current.submit('How is work?', stream); });
  await vi.waitFor(() => expect(seen).toBeDefined());
  return { signal: seen!, pending };
}

describe('a chat turn can be cancelled', () => {
  it('hands the stream a live signal', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    const { signal, pending } = await startTurn(result);
    expect(signal.aborted).toBe(false);
    act(() => { signal.dispatchEvent(new Event('abort')); });
    await act(async () => { await pending; });
  });

  it('leaving the page (unmount) aborts the in-flight turn', async () => {
    const { result, unmount } = renderHook(() => useChatThread(PROFILE, CHART));
    const { signal, pending } = await startTurn(result);
    unmount();
    expect(signal.aborted).toBe(true);
    await pending;
  });

  it('starting a new trip thread aborts the in-flight turn', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    const { signal, pending } = await startTurn(result);
    await act(() => result.current.pin(YEAR));
    expect(signal.aborted).toBe(true);
    await act(async () => { await pending; });
  });

  it('opening another thread aborts the in-flight turn', async () => {
    let other!: string;
    act(() => { other = useChatStore.getState().startThread(PROFILE, CHART); });
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    const { signal, pending } = await startTurn(result);
    act(() => result.current.openThread(other));
    expect(signal.aborted).toBe(true);
    await act(async () => { await pending; });
  });

  it('a cancelled turn leaves no error bubble in the thread it left', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    let started = false;
    const stream = async (input: ChatStreamInput): Promise<string> => new Promise((_resolve, reject) => {
      started = true;
      input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    let pending!: Promise<void>;
    act(() => { pending = result.current.submit('How is work?', stream); });
    await vi.waitFor(() => expect(started).toBe(true));
    const left = result.current.threadId!;
    await act(() => result.current.pin(YEAR));
    await act(async () => { await pending; });
    expect(useChatStore.getState().getMessages(left).filter((m) => m.role === 'assistant')).toEqual([]);
  });
});
