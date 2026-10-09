/**
 * A chat turn is not finished until its messages are on disk.
 *
 * Regression: the turn ended (spinner off, composer unlocked) the moment the
 * final answer was appended in memory, while its SQLite write was still
 * queued. A full page load right then lost the answer.
 *
 * Ruling: streamed tokens are React-local and never persisted, so only the
 * final append needs a barrier. The turn stays "streaming" until the chat row
 * commits; a failed save ends the turn with a flagged error bubble so the
 * user is never told nothing about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useChatStore } from '@almamesh/store';

const save = vi.hoisted(() => ({
  stores: [] as string[],
  resolve: (): void => undefined,
  reject: (_error: Error): void => undefined,
}));
vi.mock('../../lib/storeSaved', () => ({
  waitForStoreSaved: (store: string) => {
    save.stores.push(store);
    return new Promise<void>((resolve, reject) => {
      save.resolve = resolve;
      save.reject = reject;
    });
  },
}));

import { useChatThread } from '../useChatThread';
import { __resetMemoryForTest, __setMemoryForTest } from '../../lib/chatMemory';

const PROFILE = 'profile-A';
const CHART = 'chart-A';
const ANSWER = 'Saturn is strong this year.';

const stream = vi.fn(async (): Promise<string> => ANSWER);

beforeEach(() => {
  save.stores = [];
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
  __resetMemoryForTest();
  __setMemoryForTest({
    indexMessage: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue([]),
    deleteForProfile: vi.fn().mockResolvedValue(undefined),
    deleteForThread: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  __resetMemoryForTest();
  vi.restoreAllMocks();
});

describe('useChatThread — the turn ends only once the answer is saved', () => {
  it('keeps the turn running until the chat row commits', async () => {
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    let finished = false;
    act(() => {
      void result.current.submit('How is my Saturn?', stream).then(() => {
        finished = true;
      });
    });

    await waitFor(() => expect(save.stores).toEqual(['chat']));
    expect(result.current.messages.map((m) => m.content)).toContain(ANSWER);
    expect(result.current.isStreaming).toBe(true);
    expect(finished).toBe(false);

    await act(async () => save.resolve());
    await waitFor(() => expect(finished).toBe(true));
    expect(result.current.isStreaming).toBe(false);
  });

  it('ends the turn with a flagged notice when the answer could not be saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    act(() => {
      void result.current.submit('How is my Saturn?', stream);
    });

    await waitFor(() => expect(save.stores).toEqual(['chat']));
    await act(async () => save.reject(new Error('disk full')));

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    const last = result.current.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', error: true });
    expect(last?.content).toMatch(/couldn.t be saved/i);
  });

  it('a thread deleted mid-turn ends the turn quietly when its save then fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    act(() => {
      result.current.submit('How is my Saturn?', stream).then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        },
      );
    });

    await waitFor(() => expect(save.stores).toEqual(['chat']));
    const threadId = result.current.threadId;
    expect(threadId).not.toBeNull();
    act(() => useChatStore.getState().deleteThread(threadId ?? ''));
    await act(async () => save.reject(new Error('disk full')));

    await waitFor(() => expect(outcome).toBe('resolved'));
    expect(result.current.isStreaming).toBe(false);
    // Nothing to annotate: no notice is resurrected into a deleted thread.
    expect(useChatStore.getState().threads[threadId ?? '']).toBeUndefined();
    expect(useChatStore.getState().messages[threadId ?? ''] ?? []).toEqual([]);
  });

  it('shows the answer exactly once while its save is pending (draft cleared, spinner kept)', async () => {
    // A real stream emits tokens into the draft before returning the answer.
    const streamed = vi.fn(async (input: { onToken: (t: string) => void }): Promise<string> => {
      input.onToken(ANSWER);
      return ANSWER;
    });
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    act(() => {
      void result.current.submit('How is my Saturn?', streamed);
    });

    await waitFor(() => expect(save.stores).toEqual(['chat']));
    const { messages, isStreaming, streamingDraft } = result.current;
    // What AlmaMeshAssistantRuntime renders: the stored messages, plus the
    // draft as a synthetic bubble while the turn is running.
    const rendered = [
      ...messages.map((m) => m.content),
      ...(isStreaming && streamingDraft.length > 0 ? [streamingDraft] : []),
    ];
    expect(rendered.filter((text) => text === ANSWER)).toHaveLength(1);
    expect(isStreaming).toBe(true);

    await act(async () => save.resolve());
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
  });
});
