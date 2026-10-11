import type { RetrievedChunk } from '@almamesh/memory';
import type { DeletionTombstones, PersistedChatState } from '@almamesh/store';

const MAX_HITS = 8;
const SNIPPET_CHARS = 512;
const SCAN_CHARS = 6_000;
const QUERY_CHARS = 1_024;
const MAX_TERMS = 32;

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Match indices belong to normalized text; snippets preserve original accents. */
function sourceOffset(source: string, normalizedIndex: number): number {
  let offset = 0;
  let consumed = 0;
  for (const character of source) {
    const size = normalize(character).length;
    if (consumed + size > normalizedIndex) return offset;
    consumed += size;
    offset += character.length;
  }
  return source.length;
}

interface Candidate extends RetrievedChunk {
  readonly createdAt: string;
}

/** Deterministic ties: newest first, then thread/message IDs in code-point order. */
function compare(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
  if (a.thread_id !== b.thread_id) return a.thread_id < b.thread_id ? -1 : 1;
  return a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0;
}

/**
 * Constrained devices search the already-hydrated canonical SQLite snapshot.
 * No duplicate corpus or vector index: only eight short candidates and a
 * bounded scan of each message are retained. This is keyword overlap, not
 * semantic similarity; a message without a matching term is never returned.
 */
export function lexicalChatMemory(
  query: string,
  profileId: string,
  k: number,
  chat: PersistedChatState,
  profiles: Readonly<Record<string, unknown>>,
  ledger: DeletionTombstones,
): readonly RetrievedChunk[] {
  const limit = Math.min(MAX_HITS, Math.floor(k));
  if (
    !Number.isFinite(limit) || limit <= 0 ||
    !Object.hasOwn(profiles, profileId) || profiles[profileId] == null ||
    ledger.profileIds.includes(profileId) || ledger.restoreInProgress ||
    ledger.activeEpoch !== ledger.restoreEpoch
  ) return [];

  const terms: string[] = [];
  for (const match of normalize(query.slice(0, QUERY_CHARS)).matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0];
    if (term.length >= 2 && !terms.includes(term)) terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  if (terms.length === 0) return [];

  const best: Candidate[] = [];
  for (const threadId in chat.threads) {
    if (!Object.hasOwn(chat.threads, threadId)) continue;
    const thread = chat.threads[threadId];
    if (
      !thread || thread.id !== threadId || thread.profile_id !== profileId ||
      ledger.threadIds.includes(threadId)
    ) continue;
    const messages = chat.messages[threadId];
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (
        !message || message.thread_id !== threadId ||
        typeof message.id !== 'string' || message.id.length === 0 ||
        message.error === true || (message.role !== 'user' && message.role !== 'assistant') ||
        typeof message.content !== 'string'
      ) continue;
      const source = message.content.slice(0, SCAN_CHARS);
      const normalized = normalize(source);
      const matched: string[] = [];
      let firstMatch = -1;
      for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
        const term = match[0];
        if (!terms.includes(term) || matched.includes(term)) continue;
        matched.push(term);
        if (firstMatch < 0) firstMatch = match.index;
        if (matched.length === terms.length) break;
      }
      if (matched.length === 0) continue;
      const start = Math.max(0, sourceOffset(source, firstMatch) - 96);
      const candidate: Candidate = {
        text: source.slice(start, start + SNIPPET_CHARS).trim(),
        message_id: message.id,
        thread_id: threadId,
        score: matched.length / terms.length,
        createdAt: typeof message.created_at === 'string' ? message.created_at : '',
      };
      // Insertion sort touches at most eight entries, regardless of history size.
      let position = 0;
      while (position < best.length && compare(best[position], candidate) <= 0) position += 1;
      if (position >= limit) continue;
      best.splice(position, 0, candidate);
      if (best.length > limit) best.pop();
    }
  }
  return best.map(({ createdAt: _createdAt, ...chunk }) => chunk);
}
