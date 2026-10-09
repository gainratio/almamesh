import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { ChatThreadSummary } from '@almamesh/shared-types';

import {
  CHAT_PERSIST_VERSION,
  chatStoreCreator,
  migrateChatPersistedState,
  setActiveChatScope,
  type ChatStore,
} from './chat';

// No IndexedDB in the test runtime, so the store runs in-memory and hydration
// resolves immediately — exactly the SSR/test path, mirroring chartLibrary's
// harness. The store creator is exported so each case gets a fresh vanilla store.
function newStore() {
  return createStore<ChatStore>(chatStoreCreator);
}

describe('migrateChatPersistedState (defensive hydration)', () => {
  it('passes a valid previous-shape blob through unchanged', () => {
    const blob = { threads: { t1: { id: 't1' } }, messages: { t1: [] } };
    const out = migrateChatPersistedState(blob, 0);
    expect(out.threads).toEqual({ t1: { id: 't1' } });
    expect(out.messages).toEqual({ t1: [] });
    expect(out.summaries).toEqual({});
  });

  it('does NOT throw on a malformed / corrupt blob, returns clean empty maps', () => {
    for (const corrupt of [null, undefined, 'oops', 42, [], { threads: 'x' }, { messages: 7 }]) {
      expect(() => migrateChatPersistedState(corrupt, 0)).not.toThrow();
      expect(migrateChatPersistedState(corrupt, 0)).toEqual({
        threads: {},
        messages: {},
        summaries: {},
      });
    }
  });

  it('repairs a half-shaped blob (keeps the valid half, defaults the other)', () => {
    expect(migrateChatPersistedState({ threads: { t1: { id: 't1' } } }, 0)).toEqual({
      threads: { t1: { id: 't1' } },
      messages: {},
      summaries: {},
    });
  });

  describe('rolling summaries', () => {
    async function validSummary(store: ReturnType<typeof newStore>): Promise<ChatThreadSummary> {
      const threadId = store.getState().ensureThread('p1');
      const user = store.getState().appendMessage(threadId, 'user', 'question');
      const assistant = store.getState().appendMessage(threadId, 'assistant', 'answer');
      const { chatSummarySourceHash } = await import('@almamesh/llm');
      return {
        thread_id: threadId,
        profile_id: 'p1',
        items: [{ text: 'The grounded exchange.', source_message_ids: [user.id, assistant.id] }],
        open_questions: [],
        source_message_ids: [user.id, assistant.id],
        source_hash: await chatSummarySourceHash([user, assistant]),
        source_message_count: 2,
        through_message_id: assistant.id,
        generated_at: '2026-01-01T00:00:00.000Z',
        generator: { kind: 'llm', model: 'test-model', prompt_schema_version: 1 },
      };
    }

    it('commits a valid summary without deleting raw messages', async () => {
      const store = newStore();
      const summary = await validSummary(store);

      await expect(store.getState().commitSummary(summary)).resolves.toBe(true);
      expect(store.getState().getSummary(summary.thread_id)).toEqual(summary);
      expect(store.getState().getMessages(summary.thread_id)).toHaveLength(2);
    });

    it('rejects a stale summary hash as a no-op', async () => {
      const store = newStore();
      const summary = await validSummary(store);

      await expect(
        store.getState().commitSummary({ ...summary, source_hash: '0'.repeat(64) }),
      ).resolves.toBe(false);
      expect(store.getState().getSummary(summary.thread_id)).toBeNull();
      expect(store.getState().getMessages(summary.thread_id)).toHaveLength(2);
    });

    it('never lets a late candidate regress the committed source prefix', async () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      const first = store.getState().appendMessage(threadId, 'user', 'q1');
      const second = store.getState().appendMessage(threadId, 'assistant', 'a1');
      const third = store.getState().appendMessage(threadId, 'user', 'q2');
      const fourth = store.getState().appendMessage(threadId, 'assistant', 'a2');
      const { chatSummarySourceHash } = await import('@almamesh/llm');
      const make = async (source: (typeof first)[]) => ({
        thread_id: threadId,
        profile_id: 'p1',
        items: [{ text: 'Grounded.', source_message_ids: [source[0].id] }],
        open_questions: [],
        source_message_ids: source.map((message) => message.id),
        source_hash: await chatSummarySourceHash(source),
        source_message_count: source.length,
        through_message_id: source.at(-1)?.id ?? '',
        generated_at: '2026-01-01T00:00:00.000Z',
        generator: { kind: 'llm' as const, model: 'test-model', prompt_schema_version: 1 },
      });
      const newer = await make([first, second, third, fourth]);
      const lateOlder = await make([first, second]);

      await expect(store.getState().commitSummary(newer)).resolves.toBe(true);
      await expect(store.getState().commitSummary(lateOlder)).resolves.toBe(false);
      expect(store.getState().getSummary(threadId)?.through_message_id).toBe(fourth.id);
    });

    it('filters malformed summary bytes during persisted-state migration', () => {
      const out = migrateChatPersistedState(
        {
          threads: { t1: { id: 't1', profile_id: 'p1' } },
          messages: { t1: [] },
          summaries: {
            t1: {
              thread_id: 't1',
              profile_id: 'p1',
              items: [{ text: '', source_message_ids: ['m1'] }],
              open_questions: [],
              source_message_ids: ['m1'],
              source_hash: '0'.repeat(64),
              source_message_count: 1,
              through_message_id: 'm1',
              generated_at: 'not-a-date',
              generator: { kind: 'llm', prompt_schema_version: 999 },
            },
          },
        },
        2,
      );
      expect(out.summaries).toEqual({});
    });

    it('removes summaries with their thread/profile and on clearAll', async () => {
      for (const operation of ['thread', 'profile', 'all'] as const) {
        const store = newStore();
        const summary = await validSummary(store);
        await store.getState().commitSummary(summary);

        if (operation === 'thread') store.getState().deleteThread(summary.thread_id);
        else if (operation === 'profile') store.getState().deleteThreadsForProfile('p1');
        else store.getState().clearAll();

        expect(store.getState().getSummary(summary.thread_id)).toBeNull();
      }
    });

    it('persists a committed summary across a store reconstruction', async () => {
      const before = newStore();
      const summary = await validSummary(before);
      await before.getState().commitSummary(summary);
      const { threads, messages, summaries } = before.getState();

      const after = newStore();
      after.setState(JSON.parse(JSON.stringify({ threads, messages, summaries })) as Partial<ChatStore>);

      expect(after.getState().getSummary(summary.thread_id)).toEqual(summary);
      expect(after.getState().getMessages(summary.thread_id)).toHaveLength(2);
    });
  });
});

describe('chatStore', () => {
  beforeEach(() => {
    setActiveChatScope(null);
  });

  describe('threads', () => {
    it('ensureThread creates a thread for a profile and returns its id', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      expect(threadId).toBeTruthy();
      expect(store.getState().listThreads('p1').map((t) => t.id)).toEqual([threadId]);
    });

    it('ensureThread reuses the profile’s current open thread', () => {
      const store = newStore();
      const first = store.getState().ensureThread('p1');
      const second = store.getState().ensureThread('p1');
      expect(second).toBe(first);
      expect(store.getState().listThreads('p1')).toHaveLength(1);
    });

    it('ensureThread records the optional chart_id on the thread', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1', 'chart-9');
      expect(store.getState().getActiveThread('p1')?.chart_id).toBe('chart-9');
    });

    it('renameThread updates the title', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().renameThread(threadId, 'My reading');
      expect(store.getState().getActiveThread('p1')?.title).toBe('My reading');
    });

    it('deleteThread removes the thread and its messages', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().appendMessage(threadId, 'user', 'hello');
      store.getState().deleteThread(threadId);
      expect(store.getState().listThreads('p1')).toHaveLength(0);
      expect(store.getState().getMessages(threadId)).toEqual([]);
    });

    it('deleteThreadsForProfile removes only the target profile history', () => {
      const store = newStore();
      const targetThread = store.getState().ensureThread('target');
      store.getState().appendMessage(targetThread, 'user', 'delete me');
      const survivorThread = store.getState().ensureThread('survivor');
      store.getState().appendMessage(survivorThread, 'user', 'keep me');

      store.getState().deleteThreadsForProfile('target');

      expect(store.getState().listThreads('target')).toEqual([]);
      expect(store.getState().getMessages(targetThread)).toEqual([]);
      expect(store.getState().listThreads('survivor')).toHaveLength(1);
      expect(store.getState().getMessages(survivorThread)).toHaveLength(1);
    });

    it('unlinkMissingCharts drops only links to charts that no longer exist, keeping messages', () => {
      const store = newStore();
      const stale = store.getState().ensureThread('p1', '1e251b81');
      store.getState().appendMessage(stale, 'user', 'When does my Saturn return start?');
      const live = store.getState().ensureThread('p2', 'c2');
      const unlinked = store.getState().ensureThread('p3');

      const repaired = store.getState().unlinkMissingCharts(new Set(['c2']));

      expect(repaired).toEqual([stale]);
      expect(store.getState().threads[stale]).not.toHaveProperty('chart_id');
      expect(store.getState().getMessages(stale)[0]!.content).toBe('When does my Saturn return start?');
      expect(store.getState().threads[live]!.chart_id).toBe('c2');
      expect(store.getState().threads[unlinked]!.chart_id).toBeUndefined();
    });

    it('unlinkMissingCharts leaves state untouched when every link is live', () => {
      const store = newStore();
      store.getState().ensureThread('p1', 'c1');
      const before = store.getState().threads;

      expect(store.getState().unlinkMissingCharts(new Set(['c1']))).toEqual([]);
      expect(store.getState().threads).toBe(before);
    });
  });

  describe('messages', () => {
    it('rejects a late append after its thread was deleted', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().deleteThread(threadId);

      expect(() =>
        store.getState().appendMessage(threadId, 'assistant', 'late answer'),
      ).toThrow(/thread.*does not exist/i);
      expect(store.getState().messages[threadId]).toBeUndefined();
    });

    it('appendMessage + getMessages round-trips in order', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().appendMessage(threadId, 'user', 'What is my moon sign?');
      store.getState().appendMessage(threadId, 'assistant', 'Your moon is in Taurus.');
      const messages = store.getState().getMessages(threadId);
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'What is my moon sign?'],
        ['assistant', 'Your moon is in Taurus.'],
      ]);
      expect(messages[0].thread_id).toBe(threadId);
    });

    it('appendMessage returns the created message with an id and timestamp', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      const message = store.getState().appendMessage(threadId, 'user', 'hi');
      expect(message.id).toBeTruthy();
      expect(message.created_at).toBeTruthy();
      expect(message.role).toBe('user');
    });

    it('maintains message_count and updated_at on the thread', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      const before = store.getState().getActiveThread('p1');
      store.getState().appendMessage(threadId, 'user', 'one');
      store.getState().appendMessage(threadId, 'assistant', 'two');
      const after = store.getState().getActiveThread('p1');
      expect(after?.message_count).toBe(2);
      // `updated_at` is refreshed on every append. Assert monotonic non-decrease
      // against the thread's creation time — robust to sub-millisecond clock
      // resolution (a strict `!==` flakes when both writes land in one ms).
      expect(after?.updated_at).toBeTruthy();
      expect(after?.updated_at.localeCompare(before?.created_at ?? '')).toBeGreaterThanOrEqual(0);
    });

    it('defaults the thread title from the first user message (trimmed)', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().appendMessage(threadId, 'user', '   Tell me about my career   ');
      expect(store.getState().getActiveThread('p1')?.title).toBe('Tell me about my career');
    });

    it('does not derive the title from an assistant message', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().appendMessage(threadId, 'assistant', 'I am ready to help.');
      expect(store.getState().getActiveThread('p1')?.title).toBeNull();
    });

    it('does not overwrite an explicit title with the first user message', () => {
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      store.getState().renameThread(threadId, 'Pinned');
      store.getState().appendMessage(threadId, 'user', 'first question');
      expect(store.getState().getActiveThread('p1')?.title).toBe('Pinned');
    });

    it('appendMessage records the optional error flag (and omits it otherwise)', () => {
      // Error bubbles are rendered in the UI but must be excludable from the
      // model-visible history — the flag rides on the persisted message.
      const store = newStore();
      const threadId = store.getState().ensureThread('p1');
      const ok = store.getState().appendMessage(threadId, 'assistant', 'All good.');
      const failed = store
        .getState()
        .appendMessage(threadId, 'assistant', 'That did not work.', { error: true });
      expect(ok.error).toBeUndefined();
      expect(failed.error).toBe(true);
      const persisted = store.getState().getMessages(threadId);
      expect(persisted[0].error).toBeUndefined();
      expect(persisted[1].error).toBe(true);
    });

    it('the error flag survives a serialize → fresh-store round-trip', () => {
      const before = newStore();
      const threadId = before.getState().ensureThread('p1');
      before.getState().appendMessage(threadId, 'assistant', 'boom', { error: true });
      const snapshot = JSON.stringify({
        threads: before.getState().threads,
        messages: before.getState().messages,
      });
      const after = newStore();
      after.setState(JSON.parse(snapshot) as Partial<ChatStore>);
      expect(after.getState().getMessages(threadId)[0].error).toBe(true);
    });
  });

  describe('profile scoping', () => {
    it('listThreads returns only the requested profile’s threads', () => {
      const store = newStore();
      const a = store.getState().ensureThread('A');
      const b = store.getState().ensureThread('B');
      expect(store.getState().listThreads('A').map((t) => t.id)).toEqual([a]);
      expect(store.getState().listThreads('B').map((t) => t.id)).toEqual([b]);
    });

    it('getActiveThread is scoped per profile', () => {
      const store = newStore();
      store.getState().ensureThread('A');
      store.getState().ensureThread('B');
      expect(store.getState().getActiveThread('A')?.profile_id).toBe('A');
      expect(store.getState().getActiveThread('B')?.profile_id).toBe('B');
    });

    it('getActiveThread is null for a profile with no threads', () => {
      const store = newStore();
      store.getState().ensureThread('A');
      expect(store.getState().getActiveThread('B')).toBeNull();
    });
  });

  describe('persist → rehydrate survival', () => {
    // The store persists only the `threads` + `messages` slices (its
    // `partialize`). Outside a browser there is no IndexedDB, so we model a
    // reload the way zustand `persist` does: serialize that slice to JSON, then
    // hydrate a fresh store from the parsed snapshot. This proves threads +
    // messages survive a store reconstruction (PWA reopen / hard refresh).
    function persistedSnapshot(store: ReturnType<typeof newStore>): string {
      const { threads, messages, summaries } = store.getState();
      return JSON.stringify({ threads, messages, summaries });
    }

    it('threads and messages survive a serialize → fresh-store round-trip', () => {
      const before = newStore();
      const threadId = before.getState().ensureThread('p1', 'chart-7');
      before.getState().appendMessage(threadId, 'user', 'What is my lagna?');
      before.getState().appendMessage(threadId, 'assistant', 'Your lagna is Leo.');

      const snapshot = persistedSnapshot(before) as string;

      // Simulate the reload: a brand-new store hydrated from the persisted slice.
      const after = newStore();
      after.setState(JSON.parse(snapshot) as Partial<ChatStore>);

      const thread = after.getState().getActiveThread('p1');
      expect(thread?.id).toBe(threadId);
      expect(thread?.chart_id).toBe('chart-7');
      expect(thread?.title).toBe('What is my lagna?');
      expect(thread?.message_count).toBe(2);
      expect(after.getState().getMessages(threadId).map((m) => m.content)).toEqual([
        'What is my lagna?',
        'Your lagna is Leo.',
      ]);
    });

    it('keeps threads scoped per profile across the round-trip', () => {
      const before = newStore();
      before.getState().ensureThread('A');
      before.getState().ensureThread('B');
      const snapshot = persistedSnapshot(before) as string;

      const after = newStore();
      after.setState(JSON.parse(snapshot) as Partial<ChatStore>);

      expect(after.getState().listThreads('A')).toHaveLength(1);
      expect(after.getState().listThreads('B')).toHaveLength(1);
      expect(after.getState().getActiveThread('A')?.profile_id).toBe('A');
    });
  });

  describe('orphan claiming (migration support)', () => {
    it('assignOrphanThreadsToProfile claims only profile-less threads, idempotently', () => {
      const store = newStore();
      const orphan = store.getState().ensureThread('');
      const owned = store.getState().ensureThread('p9');
      // Simulate a legacy orphan thread with no profile_id at all.
      store.setState((state) => ({
        threads: {
          ...state.threads,
          [orphan]: { ...state.threads[orphan], profile_id: undefined as unknown as string },
        },
      }));
      const first = store.getState().assignOrphanThreadsToProfile('p1');
      const second = store.getState().assignOrphanThreadsToProfile('p1');
      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(store.getState().listThreads('p1').map((t) => t.id)).toContain(orphan);
      expect(store.getState().listThreads('p9').map((t) => t.id)).toEqual([owned]);
    });
  });
});

const PIN_2027 = { start: '2027-01-01', end: '2027-12-31', granularity: 'year' } as const;
const PIN_JUNE = { start: '2026-06-01', end: '2026-06-30', granularity: 'month' } as const;

describe('chat store v3: time-travel pins', () => {
  it('is persisted as version 3', () => {
    expect(CHAT_PERSIST_VERSION).toBe(3);
  });

  it('migrates a v2 blob with its threads and messages intact (no as_of = a normal thread)', () => {
    const v2 = {
      threads: { t1: { id: 't1', profile_id: 'p1', title: 'Career', message_count: 1 } },
      messages: { t1: [{ id: 'm1', thread_id: 't1', role: 'user', content: 'Hi' }] },
      summaries: {},
    };
    const out = migrateChatPersistedState(v2, 2);
    expect(out.threads.t1).toEqual(v2.threads.t1);
    expect(out.messages.t1).toEqual(v2.messages.t1);
  });

  it('keeps a valid pin and drops a malformed one, keeping that thread', () => {
    const out = migrateChatPersistedState(
      {
        threads: {
          good: { id: 'good', profile_id: 'p1', as_of: PIN_2027 },
          bad: { id: 'bad', profile_id: 'p1', title: 'Kept', as_of: { ...PIN_2027, granularity: 'week' } },
        },
        messages: { good: [], bad: [] },
        summaries: {},
      },
      2,
    );
    expect(out.threads.good?.as_of).toEqual(PIN_2027);
    expect(out.threads.bad).toEqual({ id: 'bad', profile_id: 'p1', title: 'Kept' });
  });

  describe('with a frozen clock', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('startThread always opens a new thread, pinned when asked', () => {
      const store = newStore();
      const normal = store.getState().startThread('p1', 'c1');
      const pinned = store.getState().startThread('p1', 'c1', PIN_2027);
      expect(pinned).not.toBe(normal);
      expect(store.getState().threads[normal]?.as_of).toBeUndefined();
      expect(store.getState().threads[pinned]).toMatchObject({ profile_id: 'p1', chart_id: 'c1', as_of: PIN_2027, title: null });
      expect(store.getState().getActiveThread('p1')?.id).toBe(pinned);
    });

    it('a thread started in the same millisecond is the active one, listed first', () => {
      const store = newStore();
      const first = store.getState().startThread('p1');
      const second = store.getState().startThread('p1');
      expect(store.getState().getActiveThread('p1')?.id).toBe(second);
      expect(store.getState().listThreads('p1').map((t) => t.id)).toEqual([second, first]);
    });
  });

  it('startThread refuses a malformed pin and creates nothing', () => {
    const store = newStore();
    expect(() => store.getState().startThread('p1', undefined, { ...PIN_2027, end: '2027-12-30' })).toThrow(
      'Invalid time-travel period: as_of.end',
    );
    expect(store.getState().listThreads('p1')).toEqual([]);
  });

  it('setThreadAsOf changes a pin and keeps the messages', () => {
    const store = newStore();
    const id = store.getState().startThread('p1', undefined, PIN_2027);
    store.getState().appendMessage(id, 'user', 'Will work get easier?');
    store.getState().setThreadAsOf(id, PIN_JUNE);
    expect(store.getState().threads[id]?.as_of).toEqual(PIN_JUNE);
    expect(store.getState().getMessages(id)).toHaveLength(1);
  });

  it('setThreadAsOf refuses a malformed pin, a missing thread and a normal thread', () => {
    const store = newStore();
    const pinned = store.getState().startThread('p1', undefined, PIN_2027);
    const normal = store.getState().startThread('p1');
    expect(() => store.getState().setThreadAsOf(pinned, { ...PIN_JUNE, start: '2026-06-02' })).toThrow(
      'Invalid time-travel period: as_of.start',
    );
    expect(() => store.getState().setThreadAsOf('gone', PIN_JUNE)).toThrow('does not exist');
    expect(() => store.getState().setThreadAsOf(normal, PIN_JUNE)).toThrow(
      'Only a time-travel thread can change its period.',
    );
    expect(store.getState().threads[pinned]?.as_of).toEqual(PIN_2027);
  });

  it('a pin survives the serialize → fresh-store round trip', () => {
    const before = newStore();
    const id = before.getState().startThread('p1', 'c1', PIN_2027);
    const { threads, messages, summaries } = before.getState();
    const after = newStore();
    after.setState(JSON.parse(JSON.stringify({ threads, messages, summaries })) as Partial<ChatStore>);
    expect(after.getState().threads[id]?.as_of).toEqual(PIN_2027);
  });
});
