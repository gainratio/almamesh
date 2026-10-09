/**
 * Chat history store — the on-device, local-first persistence for the dashboard
 * conversation. Chat used to be ephemeral React-local state (lost on reload);
 * this store keeps threads + messages per profile in portable SQLite so a person's
 * conversation survives a refresh / PWA reopen, mirroring `chartLibrary`.
 *
 * Shape is normalized: `threads` keyed by thread id, `messages` keyed by
 * `thread_id` (a flat list per thread). Each thread carries its owning
 * `profile_id` so listing is scoped per person, exactly like charts.
 *
 * No backend, no account. Persistence is a browser-only enhancement — outside a
 * browser (SSR/tests) portable storage is absent and the store runs in-memory.
 */

import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ChatMessage, ChatThread, ChatThreadAsOf, ChatThreadSummary } from '@almamesh/shared-types';
import { hasValidChatSummaryShape, summaryMatchesMessages } from '@almamesh/llm';
import { unlinkMissingChartLinks } from './chatChartLinks';
import { deletionAwareIdbStorage, whenPersistenceCommitted } from './deletionTombstones';
import { whenHydrated, type HydrationOutcome } from './hydrationBarrier';
import { chatAsOfProblem, isChatThreadAsOf } from './chatAsOf';

type ChatRole = ChatMessage['role'];

/** One canonical SQLite row holding the whole chat history, persisted by Zustand. */
const PERSIST_NAME = 'almamesh-chat-history';

/** Bump when the persisted chat shape changes; always pair with `migrate`. */
export const CHAT_PERSIST_VERSION = 3;

/** The slice of the store that `partialize` actually persists. */
export interface PersistedChatState {
  readonly threads: Readonly<Record<string, ChatThread>>;
  readonly messages: Readonly<Record<string, readonly ChatMessage[]>>;
  readonly summaries: Readonly<Record<string, ChatThreadSummary>>;
}

/** A plain (non-array) object — the only shape `threads`/`messages` may take. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** v3 (time travel): a thread whose pin is malformed keeps everything but the pin. */
function withoutMalformedPins(threads: PersistedChatState['threads']): PersistedChatState['threads'] {
  return Object.fromEntries(
    Object.entries(threads).map(([id, thread]) => {
      if (!isPlainRecord(thread) || !('as_of' in thread) || isChatThreadAsOf(thread.as_of)) return [id, thread];
      const { as_of: _malformed, ...kept } = thread as ChatThread;
      return [id, kept];
    }),
  ) as PersistedChatState['threads'];
}

/**
 * Defensive hydration: tolerate ANY old/unknown/corrupt persisted blob and
 * always return valid `{ threads, messages, summaries }` maps. A returning visitor whose
 * stored chat history is malformed (a string, an array, one half missing) must
 * never crash the app — each half independently falls back to an empty map.
 */
export function migrateChatPersistedState(
  persisted: unknown,
  _fromVersion: number,
): PersistedChatState {
  const source = isPlainRecord(persisted) ? persisted : {};
  const threads = withoutMalformedPins(
    isPlainRecord(source.threads) ? (source.threads as PersistedChatState['threads']) : {},
  );
  const messages = isPlainRecord(source.messages)
    ? (source.messages as PersistedChatState['messages'])
    : {};
  const summaries: PersistedChatState['summaries'] = isPlainRecord(source.summaries)
    ? Object.fromEntries(
        Object.entries(source.summaries).filter(
          ([threadId, summary]) =>
            hasValidChatSummaryShape(summary) &&
            summary.thread_id === threadId &&
            threads[threadId]?.profile_id === summary.profile_id,
        ),
      ) as Record<string, ChatThreadSummary>
    : {};
  return {
    threads,
    messages,
    summaries,
  };
}

/**
 * The active profile scope used to resolve "the current thread". Held as a
 * module variable (not a prop) so the profiles store can push it in without
 * chat importing the profiles store — keeping the two decoupled, exactly like
 * `chartLibrary.activeProfileScope`. `null` means "no active profile".
 */
let activeChatScope: string | null = null;

/**
 * Set the active chat scope. Called by the profiles store on hydrate and on
 * every active-profile change. Idempotent; no chat state mutation.
 */
export function setActiveChatScope(profileId: string | null): void {
  activeChatScope = profileId;
}

/** Read the active chat scope (test/coordination helper). */
export function getActiveChatScope(): string | null {
  return activeChatScope;
}

/**
 * Generate an id. Uses `crypto.randomUUID` where available (all real browsers +
 * the Node test env), with a counter fallback so the store never throws in an
 * exotic runtime. Mirrors `profiles.nextProfileId`.
 */
let idFallbackCounter = 0;
function nextId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  idFallbackCounter += 1;
  return `${prefix}-${Date.now()}-${idFallbackCounter}`;
}

export interface ChatStore {
  /** All threads, keyed by thread id. */
  readonly threads: Readonly<Record<string, ChatThread>>;
  /** Messages keyed by `thread_id` (a flat, ordered list per thread). */
  readonly messages: Readonly<Record<string, readonly ChatMessage[]>>;
  readonly summaries: Readonly<Record<string, ChatThreadSummary>>;
  /** True once Zustand has rehydrated from portable storage. */
  readonly hydrated: boolean;

  /**
   * Return the profile's current open thread, creating one when none exists.
   * Returns the thread id. `chartId` links a freshly-created thread to a chart.
   */
  ensureThread: (profileId: string, chartId?: string) => string;
  /** Open a NEW thread (never reuses one); pinned to a period when `asOf` is given. */
  startThread: (profileId: string, chartId?: string, asOf?: ChatThreadAsOf) => string;
  /** Change a time-travel thread's period; its messages stay. */
  setThreadAsOf: (threadId: string, asOf: ChatThreadAsOf) => void;
  /**
   * Append a message. `options.error` marks a failed-turn notice: rendered as
   * an error bubble, excluded from the model-visible history by consumers.
   */
  appendMessage: (
    threadId: string,
    role: ChatRole,
    content: string,
    options?: { readonly error?: true },
  ) => ChatMessage;
  getMessages: (threadId: string) => ChatMessage[];
  getSummary: (threadId: string) => ChatThreadSummary | null;
  /** Commit only a source-current summary; invalid/stale candidates are a no-op. */
  commitSummary: (summary: ChatThreadSummary) => Promise<boolean>;
  /** All threads for a profile, newest-updated first; ties go to the newest-inserted thread. */
  listThreads: (profileId: string) => ChatThread[];
  /** The profile's most-recently-updated thread, or null when it has none. */
  getActiveThread: (profileId: string) => ChatThread | null;
  renameThread: (threadId: string, title: string) => void;
  deleteThread: (threadId: string) => void;
  /** Remove every thread and message owned by one profile. */
  deleteThreadsForProfile: (profileId: string) => void;
  /**
   * Drop `chart_id` from threads whose chart is not in `liveChartIds` (a
   * regenerated or deleted chart), keeping every message. Returns their ids.
   */
  unlinkMissingCharts: (liveChartIds: ReadonlySet<string>) => readonly string[];
  /** Assign all profile-less (orphan) threads to a profile — idempotent migration. */
  assignOrphanThreadsToProfile: (profileId: string) => number;
  /** Wipe all threads and messages — the "start fresh" reset. */
  clearAll: () => void;
}

/** Newest-updated first (stable thread ordering for listing + active resolution). */
function byUpdatedDesc(a: ChatThread, b: ChatThread): number {
  return b.updated_at.localeCompare(a.updated_at);
}

function assertPin(asOf: ChatThreadAsOf): void {
  const problem = chatAsOfProblem(asOf);
  if (problem) throw new Error(`Invalid time-travel period: ${problem}`);
}

/** A fresh, empty thread owned by a profile; `as_of` stays the last key. */
function makeThread(profileId: string, chartId?: string, asOf?: ChatThreadAsOf): ChatThread {
  const now = new Date().toISOString();
  return {
    id: nextId('thread'),
    profile_id: profileId,
    chart_id: chartId,
    title: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
    message_count: 0,
    ...(asOf ? { as_of: asOf } : {}),
  };
}

/** The first user message becomes the title only when the thread is untitled. */
function deriveTitle(thread: ChatThread, role: ChatRole, content: string): string | null {
  if (thread.title !== null || role !== 'user') {
    return thread.title;
  }
  return content.trim() || null;
}

export const chatStoreCreator: StateCreator<ChatStore> = (set, get) => ({
  threads: {},
  messages: {},
  summaries: {},
  hydrated: false,

  ensureThread: (profileId, chartId) => {
    const existing = get().getActiveThread(profileId);
    if (existing) {
      return existing.id;
    }
    const thread = makeThread(profileId, chartId);
    set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
    return thread.id;
  },

  startThread: (profileId, chartId, asOf) => {
    if (asOf) assertPin(asOf);
    const thread = makeThread(profileId, chartId, asOf);
    set((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
    return thread.id;
  },

  setThreadAsOf: (threadId, asOf) => {
    assertPin(asOf);
    const thread = get().threads[threadId];
    if (!thread) throw new Error(`Cannot change the period: thread ${threadId} does not exist.`);
    if (!thread.as_of) throw new Error('Only a time-travel thread can change its period.');
    const next: ChatThread = { ...thread, as_of: asOf, updated_at: new Date().toISOString() };
    set((state) => ({ threads: { ...state.threads, [threadId]: next } }));
  },

  appendMessage: (threadId, role, content, options) => {
    if (!get().threads[threadId]) {
      throw new Error(`Cannot append message: thread ${threadId} does not exist.`);
    }
    const now = new Date().toISOString();
    const message: ChatMessage = {
      id: nextId('msg'),
      thread_id: threadId,
      role,
      content,
      created_at: now,
      ...(options?.error ? { error: true as const } : {}),
    };
    set((state) => {
      const thread = state.threads[threadId];
      if (!thread) {
        return state;
      }
      const list = state.messages[threadId] ?? [];
      const nextMessages = { ...state.messages, [threadId]: [...list, message] };
      const nextThread: ChatThread = {
        ...thread,
        title: deriveTitle(thread, role, content),
        message_count: list.length + 1,
        updated_at: now,
      };
      return { threads: { ...state.threads, [threadId]: nextThread }, messages: nextMessages };
    });
    return message;
  },

  getMessages: (threadId) => [...(get().messages[threadId] ?? [])],

  getSummary: (threadId) => get().summaries[threadId] ?? null,

  commitSummary: async (summary) => {
    const initial = get();
    const thread = initial.threads[summary.thread_id];
    const initialMessages = initial.messages[summary.thread_id] ?? [];
    if (
      thread === undefined ||
      thread.profile_id !== summary.profile_id ||
      !(await summaryMatchesMessages(summary, initialMessages)) ||
      get().messages[summary.thread_id] !== initialMessages
    ) {
      return false;
    }
    let committed = false;
    set((state) => {
      const currentThread = state.threads[summary.thread_id];
      const currentMessages = state.messages[summary.thread_id] ?? [];
      const sourceIds = new Set(currentMessages.map((message) => message.id));
      const previous = state.summaries[summary.thread_id];
      const extendsPrevious =
        previous === undefined ||
        previous.source_message_ids.every(
          (id, index) => summary.source_message_ids[index] === id,
        );
      if (
        currentThread?.profile_id !== summary.profile_id ||
        summary.source_message_ids.some((id) => !sourceIds.has(id)) ||
        !extendsPrevious
      ) {
        return state;
      }
      committed = true;
      return { summaries: { ...state.summaries, [summary.thread_id]: summary } };
    });
    return committed;
  },

  listThreads: (profileId) =>
    Object.values(get().threads)
      .filter((t) => t.profile_id === profileId)
      .reverse()
      .sort(byUpdatedDesc),

  getActiveThread: (profileId) => get().listThreads(profileId)[0] ?? null,

  renameThread: (threadId, title) => {
    set((state) => {
      const thread = state.threads[threadId];
      if (!thread) {
        return state;
      }
      const next: ChatThread = { ...thread, title: title.trim() || thread.title };
      return { threads: { ...state.threads, [threadId]: next } };
    });
  },

  deleteThread: (threadId) => {
    set((state) => {
      const threads = { ...state.threads };
      delete threads[threadId];
      const messages = { ...state.messages };
      delete messages[threadId];
      const summaries = { ...state.summaries };
      delete summaries[threadId];
      return { threads, messages, summaries };
    });
  },

  unlinkMissingCharts: (liveChartIds) => {
    const repair = unlinkMissingChartLinks(get().threads, liveChartIds);
    if (repair.unlinkedThreadIds.length > 0) set({ threads: repair.threads });
    return repair.unlinkedThreadIds;
  },

  deleteThreadsForProfile: (profileId) => {
    set((state) => {
      const targetIds = new Set(
        Object.values(state.threads)
          .filter((thread) => thread.profile_id === profileId)
          .map((thread) => thread.id),
      );
      return {
        threads: Object.fromEntries(
          Object.entries(state.threads).filter(([threadId]) => !targetIds.has(threadId)),
        ),
        messages: Object.fromEntries(
          Object.entries(state.messages).filter(([threadId]) => !targetIds.has(threadId)),
        ),
        summaries: Object.fromEntries(
          Object.entries(state.summaries).filter(([threadId]) => !targetIds.has(threadId)),
        ),
      };
    });
  },

  assignOrphanThreadsToProfile: (profileId) => {
    let claimed = 0;
    set((state) => {
      const next: Record<string, ChatThread> = {};
      for (const [id, thread] of Object.entries(state.threads)) {
        if (thread.profile_id === undefined || thread.profile_id === null) {
          next[id] = { ...thread, profile_id: profileId };
          claimed += 1;
        } else {
          next[id] = thread;
        }
      }
      return { threads: next };
    });
    return claimed;
  },

  clearAll: () => {
    set({ threads: {}, messages: {}, summaries: {} });
  },
});

export const useChatStore = create<ChatStore>()(
  persist<ChatStore, [], [], PersistedChatState>(chatStoreCreator, {
    name: PERSIST_NAME,
    version: CHAT_PERSIST_VERSION,
    migrate: migrateChatPersistedState,
    storage: createJSONStorage(() => deletionAwareIdbStorage),
    partialize: (state) => ({
      threads: state.threads,
      messages: state.messages,
      summaries: state.summaries,
    }),
    onRehydrateStorage: () => () => {
      useChatStore.setState({ hydrated: true });
    },
  }),
);

/**
 * Resolve once the chat store has finished rehydrating from portable storage. Mirrors
 * `whenChartLibraryHydrated` / `whenProfilesHydrated` — await before any read
 * that must reflect the persisted truth (avoids the async-rehydrate race).
 */
export function whenChatHydrated(): Promise<HydrationOutcome> {
  return whenHydrated(useChatStore.persist);
}

/**
 * Assign every profile-less (orphan) chat thread to a profile — the chat
 * analogue of `chartLibrary.assignOrphanChartsToProfile`. Thin wrapper over the
 * store action so the profiles store stays chat-agnostic and imports only this
 * one helper plus `whenChatHydrated` / `setActiveChatScope`.
 */
export function assignOrphanChatThreads(profileId: string): number {
  return useChatStore.getState().assignOrphanThreadsToProfile(profileId);
}

/**
 * Resolve once every queued chat-history write has committed to SQLite; reject with
 * the error when the last one failed. The store changes memory at once and
 * persists later: a surface that says "saved" or moves on awaits this first.
 */
export function whenChatCommitted(): Promise<void> {
  return whenPersistenceCommitted(PERSIST_NAME);
}
