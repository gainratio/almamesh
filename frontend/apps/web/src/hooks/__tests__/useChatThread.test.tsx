import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
  CHAT_STREAM_ERROR_COPY,
  describeChatStreamError,
  isMappedChatStreamError,
  useChatThread,
} from '../useChatThread';
import {
  LlmRequestError,
  PrivacyViolationError,
} from '@almamesh/llm';
import { useChartLibraryStore, useChatStore, type StoredChart } from '@almamesh/store';
import i18n from '../../i18n/config';
import {
  __setMemoryForTest,
  __resetMemoryForTest,
  type ChatMemoryFacade,
} from '../../lib/chatMemory';

const PROFILE = 'profile-A';
const CHART = 'chart-A';

/** Reset the persisted chat store between tests (in-memory under happy-dom). */
function clearChatStore(): void {
  useChatStore.setState({ threads: {}, messages: {}, summaries: {} });
}

function fakeMemory(): { memory: ChatMemoryFacade; index: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> } {
  const index = vi.fn().mockResolvedValue(undefined);
  const retrieve = vi.fn().mockResolvedValue([
    { text: 'earlier: your Mars is in Scorpio', message_id: 'm0', thread_id: 't0', score: 0.8 },
  ]);
  return {
    memory: {
      indexMessage: index,
      retrieve,
      deleteForProfile: vi.fn().mockResolvedValue(undefined),
      deleteForThread: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    index,
    retrieve,
  };
}

/** A stream function that yields a fixed answer token-by-token via onToken. */
function makeStreamFn(answer: string) {
  return vi.fn(
    async (input: {
      question: string;
      history: readonly { role: string; content: string }[];
      retrievedContext: readonly string[];
      onToken: (t: string) => void;
    }): Promise<string> => {
      for (const ch of answer) {
        input.onToken(ch);
      }
      return answer;
    },
  );
}

describe('useChatThread', () => {
  beforeEach(() => {
    clearChatStore();
    __resetMemoryForTest();
  });

  afterEach(() => {
    clearChatStore();
    __resetMemoryForTest();
    vi.restoreAllMocks();
  });

  it('with equal timestamps the newest-inserted thread is the active one, as in the store', () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const stamp = '2026-10-09T10:00:00.000Z';
    const thread = (id: string) => ({ id, profile_id: PROFILE, title: null, created_at: stamp, updated_at: stamp, archived_at: null, message_count: 0 });
    useChatStore.setState({ threads: { zzz: thread('zzz'), aaa: thread('aaa') }, messages: {}, summaries: {} });
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    expect(result.current.threadId).toBe(useChatStore.getState().listThreads(PROFILE)[0].id);
    expect(result.current.threadId).toBe('aaa');
  });

  it('starts with no messages and no thread for a fresh profile', () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    expect(result.current.messages).toEqual([]);
  });

  it('REGRESSION: a second send before the first re-renders spends exactly one paid answer', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const stream = makeStreamFn('One answer.');
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));

    // Both sends use the same render's `submit` (double Enter, Enter + click
    // landing before React commits): the second must not buy another answer.
    const submit = result.current.submit;
    await act(async () => {
      await Promise.all([submit('Hello?', stream), submit('Hello?', stream)]);
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('persists the user question and the streamed assistant answer to the store', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const stream = makeStreamFn('Mars in Scorpio gives drive.');

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));

    await act(async () => {
      await result.current.submit('What about my Mars?', stream);
    });

    await waitFor(() => expect(result.current.messages.length).toBe(2));
    expect(result.current.messages[0]).toMatchObject({ role: 'user', content: 'What about my Mars?' });
    expect(result.current.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Mars in Scorpio gives drive.',
    });

    // Survives a remount (the store is the source of truth, not React-local state).
    const threadId = result.current.threadId;
    const remount = renderHook(() => useChatThread(PROFILE, CHART));
    expect(remount.result.current.threadId).toBe(threadId);
    expect(remount.result.current.messages.length).toBe(2);
  });

  describe('an answer for an older chart snapshot is dropped, not attached', () => {
    afterEach(() => {
      useChartLibraryStore.setState({ charts: {} });
    });

    function stampedChart(chartId: string, snapshotId: string): StoredChart {
      return {
        chart_id: chartId,
        person_name: 'P',
        is_primary: true,
        profile_id: PROFILE,
        astronomical_calculations: { calculation_timestamp: '2025-01-01T00:00:00.000Z' },
        sidereal_chart: { snapshot: { snapshot_id: snapshotId } },
      } as unknown as StoredChart;
    }

    /** A stream whose answer arrives only after the test releases it. */
    function deferredStream(answer: string) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stream = vi.fn(async () => {
        await gate;
        return answer;
      });
      return { stream, release };
    }

    it('drops the answer when the chart is regenerated (new chart id) mid-stream', async () => {
      const { memory, index } = fakeMemory();
      __setMemoryForTest(memory);
      const { stream, release } = deferredStream('Your Saturn period is ending.');
      const { result, rerender } = renderHook(({ chartId }) => useChatThread(PROFILE, chartId), {
        initialProps: { chartId: CHART },
      });

      let pending!: Promise<void>;
      act(() => {
        pending = result.current.submit('Which period am I in?', stream);
      });
      rerender({ chartId: 'chart-B' });
      await act(async () => {
        release();
        await pending;
      });

      const contents = result.current.messages.map((m) => m.content);
      expect(contents).not.toContain('Your Saturn period is ending.');
      expect(result.current.messages.at(-1)).toMatchObject({ role: 'assistant', error: true });
      expect(index).not.toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Your Saturn period is ending.' }),
      );
    });

    it('drops the answer when the same chart id is recomputed with a new snapshot', async () => {
      const { memory } = fakeMemory();
      __setMemoryForTest(memory);
      useChartLibraryStore.setState({ charts: { [CHART]: stampedChart(CHART, 'a'.repeat(64)) } });
      const { stream, release } = deferredStream('Stale answer.');
      const { result } = renderHook(() => useChatThread(PROFILE, CHART));

      let pending!: Promise<void>;
      act(() => {
        pending = result.current.submit('Which period am I in?', stream);
      });
      useChartLibraryStore.setState({ charts: { [CHART]: stampedChart(CHART, 'b'.repeat(64)) } });
      await act(async () => {
        release();
        await pending;
      });

      expect(result.current.messages.map((m) => m.content)).not.toContain('Stale answer.');
    });

    it('a chart restored from an old backup (no snapshot) keeps its answer, and drops it once recomputed with one', async () => {
      const { memory } = fakeMemory();
      __setMemoryForTest(memory);
      const legacy = { ...stampedChart(CHART, 'unused'), sidereal_chart: {} } as unknown as StoredChart;
      useChartLibraryStore.setState({ charts: { [CHART]: legacy } });
      const { result } = renderHook(() => useChatThread(PROFILE, CHART));

      const kept = deferredStream('Legacy answer.');
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.submit('Which period am I in?', kept.stream);
      });
      await act(async () => {
        kept.release();
        await pending;
      });
      expect(result.current.messages.at(-1)).toMatchObject({ content: 'Legacy answer.' });

      const dropped = deferredStream('Answer about the unstamped chart.');
      act(() => {
        pending = result.current.submit('And now?', dropped.stream);
      });
      useChartLibraryStore.setState({ charts: { [CHART]: stampedChart(CHART, 'c'.repeat(64)) } });
      await act(async () => {
        dropped.release();
        await pending;
      });
      expect(result.current.messages.map((m) => m.content)).not.toContain(
        'Answer about the unstamped chart.',
      );
    });

    it('keeps the answer when the snapshot did not change', async () => {
      const { memory } = fakeMemory();
      __setMemoryForTest(memory);
      useChartLibraryStore.setState({ charts: { [CHART]: stampedChart(CHART, 'a'.repeat(64)) } });
      const { stream, release } = deferredStream('Fresh answer.');
      const { result } = renderHook(() => useChatThread(PROFILE, CHART));

      let pending!: Promise<void>;
      act(() => {
        pending = result.current.submit('Which period am I in?', stream);
      });
      await act(async () => {
        release();
        await pending;
      });

      expect(result.current.messages.at(-1)).toMatchObject({
        role: 'assistant',
        content: 'Fresh answer.',
      });
    });
  });

  it('passes prior turns as history and retrieved snippets as retrievedContext to the stream fn', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));

    const first = makeStreamFn('A1');
    await act(async () => {
      await result.current.submit('Q1', first);
    });

    const second = makeStreamFn('A2');
    await act(async () => {
      await result.current.submit('Q2', second);
    });

    const callInput = second.mock.calls[0][0];
    expect(callInput.question).toBe('Q2');
    // History excludes the brand-new Q2 (sent separately) but includes Q1/A1.
    expect(callInput.history).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]);
    expect(callInput.retrievedContext).toEqual(['earlier: your Mars is in Scorpio']);
  });

  it('indexes BOTH the user message and the assistant answer for RAG/search', async () => {
    const { memory, index } = fakeMemory();
    __setMemoryForTest(memory);
    const stream = makeStreamFn('the answer');

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('the question', stream);
    });

    await waitFor(() => expect(index).toHaveBeenCalledTimes(2));
    const contents = index.mock.calls.map((c) => c[0].content);
    expect(contents).toContain('the question');
    expect(contents).toContain('the answer');
    for (const call of index.mock.calls) {
      expect(call[0].profile_id).toBe(PROFILE);
    }
  });

  it('builds grounded rolling memory after the deterministic threshold without deleting raw turns', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const store = useChatStore.getState();
    const threadId = store.ensureThread(PROFILE, CHART);
    for (let index = 0; index < 12; index += 1) {
      store.appendMessage(threadId, 'user', `Question ${index} ${'q'.repeat(900)}`);
      store.appendMessage(threadId, 'assistant', `Answer ${index} ${'a'.repeat(900)}`);
    }
    const summarize = vi.fn(async (plan) => ({
      draft: {
        items: [
          {
            text: 'The user is exploring a recurring timing question.',
            source_message_ids: plan.source_message_ids.slice(0, 2),
          },
        ],
        open_questions: ['Which timing window should be compared next?'],
      },
      generator: { kind: 'llm' as const, model: 'test/model', prompt_schema_version: 1 },
    }));
    const { result } = renderHook(() => useChatThread(PROFILE, CHART, summarize));

    await act(async () => {
      await result.current.submit('One more question', makeStreamFn('One more answer'));
    });

    await waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useChatStore.getState().getSummary(threadId)).not.toBeNull());
    expect(useChatStore.getState().getMessages(threadId)).toHaveLength(26);
  });

  it('binds the provider before detaching work and keeps only one summary job per thread', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const store = useChatStore.getState();
    const threadId = store.ensureThread(PROFILE, CHART);
    for (let index = 0; index < 12; index += 1) {
      store.appendMessage(threadId, 'user', `Question ${index} ${'q'.repeat(900)}`);
      store.appendMessage(threadId, 'assistant', `Answer ${index} ${'a'.repeat(900)}`);
    }
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const prepared = vi.fn(async (plan) => {
      await blocked;
      return {
        draft: {
          items: [{ text: 'Bounded fact.', source_message_ids: plan.source_message_ids.slice(0, 2) }],
          open_questions: [],
        },
        generator: { kind: 'llm' as const, model: 'bound', prompt_schema_version: 1 },
      };
    });
    const base = vi.fn();
    const summarize = Object.assign(base, { prepare: vi.fn(() => prepared) });
    const { result } = renderHook(() => useChatThread(PROFILE, CHART, summarize));

    await act(async () => result.current.submit('Q one', makeStreamFn('A one')));
    await waitFor(() => expect(prepared).toHaveBeenCalledOnce());
    await act(async () => result.current.submit('Q two', makeStreamFn('A two')));

    expect(summarize.prepare).toHaveBeenCalledOnce();
    expect(base).not.toHaveBeenCalled();
    expect(prepared).toHaveBeenCalledOnce();
    await act(async () => release?.());
    await waitFor(() => expect(useChatStore.getState().getSummary(threadId)).not.toBeNull());
  });

  it('aborts detached summary egress when its thread is deleted', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const store = useChatStore.getState();
    const threadId = store.ensureThread(PROFILE, CHART);
    for (let index = 0; index < 12; index += 1) {
      store.appendMessage(threadId, 'user', `Question ${index} ${'q'.repeat(900)}`);
      store.appendMessage(threadId, 'assistant', `Answer ${index} ${'a'.repeat(900)}`);
    }
    let observedSignal: AbortSignal | undefined;
    const summarize = vi.fn((_plan, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const { result } = renderHook(() => useChatThread(PROFILE, CHART, summarize));

    await act(async () => result.current.submit('Q', makeStreamFn('A')));
    await waitFor(() => expect(summarize).toHaveBeenCalledOnce());
    act(() => useChatStore.getState().deleteThread(threadId));

    await waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(useChatStore.getState().getSummary(threadId)).toBeNull();
  });

  it('aborts detached summary egress on provider change and unmount', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const store = useChatStore.getState();
    const threadId = store.ensureThread(PROFILE, CHART);
    for (let index = 0; index < 12; index += 1) {
      store.appendMessage(threadId, 'user', `Question ${index} ${'q'.repeat(900)}`);
      store.appendMessage(threadId, 'assistant', `Answer ${index} ${'a'.repeat(900)}`);
    }
    const signals: AbortSignal[] = [];
    const summarize = vi.fn((_plan, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const first = renderHook(() => useChatThread(PROFILE, CHART, summarize));
    await act(async () => first.result.current.submit('Q', makeStreamFn('A')));
    await waitFor(() => expect(signals).toHaveLength(1));
    act(() => window.dispatchEvent(new Event('almamesh-llm-settings-changed')));
    await waitFor(() => expect(signals[0].aborted).toBe(true));

    // Once the aborted job has settled, a new job may start and is owned by the
    // new hook lifecycle; unmount must abort that one too.
    const second = renderHook(() => useChatThread(PROFILE, CHART, summarize));
    await act(async () => second.result.current.submit('Q2', makeStreamFn('A2')));
    await waitFor(() => expect(signals).toHaveLength(2));
    second.unmount();
    await waitFor(() => expect(signals[1].aborted).toBe(true));
    first.unmount();
  });

  it('injects only a source-current rolling summary as bounded conversation context', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const store = useChatStore.getState();
    const threadId = store.ensureThread(PROFILE, CHART);
    const user = store.appendMessage(threadId, 'user', 'My recurring concern is timing.');
    const assistant = store.appendMessage(threadId, 'assistant', 'We can compare the stated periods.');
    const { chatSummarySourceHash } = await import('@almamesh/llm');
    const source = [user, assistant];
    await store.commitSummary({
      thread_id: threadId,
      profile_id: PROFILE,
      items: [
        {
          text: 'The user wants timing comparisons.',
          source_message_ids: source.map((message) => message.id),
        },
      ],
      open_questions: ['Which listed period should be compared?'],
      source_message_ids: source.map((message) => message.id),
      source_hash: await chatSummarySourceHash(source),
      source_message_count: source.length,
      through_message_id: assistant.id,
      generated_at: '2026-09-21T00:00:00.000Z',
      generator: { kind: 'llm', model: 'test/model', prompt_schema_version: 1 },
    });
    const stream = makeStreamFn('A2');
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));

    await act(async () => {
      await result.current.submit('What next?', stream);
    });

    expect(stream.mock.calls[0][0].retrievedContext).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Grounded rolling conversation memory'),
        expect.stringContaining('The user wants timing comparisons.'),
        expect.stringContaining('Which listed period should be compared?'),
      ]),
    );
  });

  it('never injects a persisted summary owned by another profile', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    const store = useChatStore.getState();
    const threadId = store.ensureThread(PROFILE, CHART);
    const user = store.appendMessage(threadId, 'user', 'Q1');
    const assistant = store.appendMessage(threadId, 'assistant', 'A1');
    const { chatSummarySourceHash } = await import('@almamesh/llm');
    useChatStore.setState({
      summaries: {
        [threadId]: {
          thread_id: threadId,
          profile_id: 'another-profile',
          items: [{ text: 'Must not cross profiles.', source_message_ids: [user.id] }],
          open_questions: [],
          source_message_ids: [user.id, assistant.id],
          source_hash: await chatSummarySourceHash([user, assistant]),
          source_message_count: 2,
          through_message_id: assistant.id,
          generated_at: '2026-09-21T00:00:00.000Z',
          generator: { kind: 'llm', prompt_schema_version: 1 },
        },
      },
    });
    const stream = makeStreamFn('A2');
    const { result } = renderHook(() => useChatThread(PROFILE, CHART));

    await act(async () => result.current.submit('Q2', stream));

    expect(stream.mock.calls[0][0].retrievedContext).toEqual([
      'earlier: your Mars is in Scorpio',
    ]);
  });

  it('a failing stream still persists the user message and surfaces the error', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = vi.fn().mockRejectedValue(new Error('endpoint down'));

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('hello', stream);
    });

    await waitFor(() => {
      const roles = result.current.messages.map((m) => m.role);
      expect(roles).toContain('user');
      // An assistant error bubble is appended so the user is not left hanging.
      expect(roles).toContain('assistant');
    });
  });

  it('an error turn is flagged and NEVER re-enters the model-visible history', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));

    const failing = vi.fn().mockRejectedValue(new Error('endpoint down'));
    await act(async () => {
      await result.current.submit('Q1', failing);
    });
    await waitFor(() => expect(result.current.messages.length).toBe(2));
    // The error turn carries the flag so the UI can render it as an error bubble.
    expect(result.current.messages[1]).toMatchObject({ role: 'assistant', error: true });

    // The NEXT submit must not feed the error bubble back to the model.
    const second = makeStreamFn('A2');
    await act(async () => {
      await result.current.submit('Q2', second);
    });
    const callInput = second.mock.calls[0][0];
    expect(callInput.history).toEqual([{ role: 'user', content: 'Q1' }]);
  });

  it('a privacy violation surfaces its own fail-closed message, never QA_001', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // SYNTHETIC endpoint: the fence's message is user-facing by design.
    const failing = vi.fn().mockRejectedValue(
      new PrivacyViolationError(
        'local_only privacy mode refuses to send chart data to https://example.invalid',
      ),
    );

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('hello', failing);
    });

    await waitFor(() => expect(result.current.messages.length).toBe(2));
    const bubble = result.current.messages[1];
    expect(bubble.error).toBe(true);
    expect(bubble.content).toContain('local_only');
    expect(bubble.content).not.toContain('QA_001');
  });

  it('a 404 model-not-found from the endpoint gets "pick a different model" guidance', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi.fn().mockRejectedValue(
      new LlmRequestError('HTTP 404: No endpoints found for test-org/retired-model', {
        status: 404,
      }),
    );

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('hello', failing);
    });

    await waitFor(() => expect(result.current.messages.length).toBe(2));
    const bubble = result.current.messages[1];
    expect(bubble.error).toBe(true);
    expect(bubble.content).toContain('Settings → AI');
    expect(bubble.content).toMatch(/model/i);
    expect(bubble.content).not.toContain('QA_001');
  });

  it('an unreachable endpoint (fetch TypeError) points at the endpoint setting', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // What `fetch` throws when the endpoint is down / DNS fails / CORS blocks.
    const failing = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('hello', failing);
    });

    await waitFor(() => expect(result.current.messages.length).toBe(2));
    const bubble = result.current.messages[1];
    expect(bubble.error).toBe(true);
    expect(bubble.content).toMatch(/endpoint/i);
    expect(bubble.content).not.toContain('QA_001');
  });

  it('a 5xx provider outage gets provider-trouble copy (not the generic settings dead-end)', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi.fn().mockRejectedValue(
      new LlmRequestError('HTTP 500 from endpoint', { status: 500 }),
    );

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('hello', failing);
    });

    await waitFor(() => expect(result.current.messages.length).toBe(2));
    const bubble = result.current.messages[1];
    expect(bubble.error).toBe(true);
    // A provider 5xx is out of the user's control — say so and say "try again",
    // never send them to re-check a model/endpoint that is configured correctly.
    expect(bubble.content).toBe(i18n.t('chat:errors.server_error'));
    expect(bubble.content).not.toContain('QA_001');
  });

  it('an unknown failure keeps the generic QA_001 fallback (still flagged)', async () => {
    const { memory } = fakeMemory();
    __setMemoryForTest(memory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi.fn().mockRejectedValue(new Error('mystery'));

    const { result } = renderHook(() => useChatThread(PROFILE, CHART));
    await act(async () => {
      await result.current.submit('hello', failing);
    });

    await waitFor(() => expect(result.current.messages.length).toBe(2));
    const bubble = result.current.messages[1];
    expect(bubble.error).toBe(true);
    expect(bubble.content).toContain('QA_001');
  });
});

describe('isMappedChatStreamError — the page-catch rethrow contract', () => {
  it('is true for every typed cause the bubble mapper handles', () => {
    expect(isMappedChatStreamError(new PrivacyViolationError('refused'))).toBe(true);
    expect(isMappedChatStreamError(new LlmRequestError('HTTP 500'))).toBe(true);
    expect(isMappedChatStreamError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('is false for unknown errors (those keep the generic QA_001 wrap)', () => {
    expect(isMappedChatStreamError(new Error('mystery'))).toBe(false);
    expect(isMappedChatStreamError('not an error')).toBe(false);
    expect(isMappedChatStreamError(undefined)).toBe(false);
  });
});

describe('the chat error mapping derives from ONE map (rethrow contract and copy cannot drift)', () => {
  it('covers exactly the typed causes the mapper is contracted to handle', () => {
    expect(Object.keys(CHAT_STREAM_ERROR_COPY).sort()).toEqual([
      'LlmRequestError',
      'PrivacyViolationError',
      'TypeError',
    ]);
  });

  it('every mapped cause name is BOTH rethrown by the page catch AND given non-generic copy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of Object.keys(CHAT_STREAM_ERROR_COPY)) {
      // Name-based match: class identity may be lost across a boundary.
      const error = new Error('synthetic failure');
      error.name = name;
      expect(isMappedChatStreamError(error), `${name} must be rethrown`).toBe(true);
      expect(
        describeChatStreamError(error),
        `${name} must get specific copy`,
      ).not.toContain('QA_001');
    }
  });

  it('an unmapped cause name stays on the generic QA_001 path in BOTH functions', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('mystery');
    error.name = 'SomeUnmappedError';
    expect(isMappedChatStreamError(error)).toBe(false);
    expect(describeChatStreamError(error)).toContain('QA_001');
  });
});

describe('describeChatStreamError — coded messages per HTTP status (live-bug fix)', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));

  it('a 402 out-of-credits shows the billing copy, NEVER the generic request_failed', () => {
    const msg = describeChatStreamError(
      new LlmRequestError('LLM endpoint returned 402 Payment Required: Insufficient credits', {
        status: 402,
      }),
    );
    expect(msg).toBe(i18n.t('chat:errors.insufficient_credits'));
    expect(msg).not.toBe(i18n.t('chat:errors.request_failed'));
  });

  it('a 401 rejected key shows the auth-failed copy', () => {
    expect(
      describeChatStreamError(new LlmRequestError('LLM endpoint returned 401 Unauthorized', { status: 401 })),
    ).toBe(i18n.t('chat:errors.auth_failed'));
  });

  it('a 429 shows the rate-limited copy', () => {
    expect(
      describeChatStreamError(new LlmRequestError('LLM endpoint returned 429 Too Many Requests', { status: 429 })),
    ).toBe(i18n.t('chat:errors.rate_limited'));
  });

  it('a 404 dead model still shows the model-unavailable copy (regression guard)', () => {
    expect(
      describeChatStreamError(
        new LlmRequestError('LLM endpoint returned 404: No endpoints found for x/y', { status: 404 }),
      ),
    ).toBe(i18n.t('chat:errors.model_unavailable'));
  });

  it('a 500 shows the server-error copy', () => {
    expect(
      describeChatStreamError(new LlmRequestError('LLM endpoint returned 500', { status: 500 })),
    ).toBe(i18n.t('chat:errors.server_error'));
  });
});
