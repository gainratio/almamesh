/**
 * Pure ranking for chat search: thread-title matching and reciprocal-rank
 * fusion (RRF) of the semantic, keyword and title result lists.
 *
 * RRF scores an item by the sum of 1 / (k + rank) over every list it appears
 * in, so a hit found by two retrievers outranks one found by a single
 * retriever, without comparing their incompatible raw scores (cosine vs bm25).
 */
import type { RetrievedChunk } from '@almamesh/memory';

/** The standard RRF constant (Cormack, Clarke & Buettcher, SIGIR 2009). */
export const RRF_K = 60;

/** A search result: a message snippet, or a whole thread matched by its title. */
export interface ChatSearchHit extends RetrievedChunk {
  readonly source: 'message' | 'thread';
}

/** Searchable title text of one thread (title, period label and place). */
export interface ThreadTitle {
  readonly thread_id: string;
  readonly profile_id: string;
  readonly text: string;
}

const MAX_TERMS = 16;

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Letter/number tokens, accent- and case-folded. */
export function searchTerms(query: string): readonly string[] {
  const terms: string[] = [];
  for (const match of fold(query).matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!terms.includes(match[0])) terms.push(match[0]);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/** Longest keyword snippet, before its ellipses. */
export const SNIPPET_CHARS = 200;
/** Context kept before the first matched word. */
const SNIPPET_LEAD = 60;

/**
 * A short excerpt of a canonical message around the first word that starts
 * with a query term, accents and case kept. The keyword index stores no text,
 * so this is how a keyword hit shows what it matched.
 */
export function snippetAround(text: string, query: string): string {
  if (text.length <= SNIPPET_CHARS) return text;
  const terms = searchTerms(query);
  let first = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = fold(match[0]);
    if (terms.some((term) => word.startsWith(term))) { first = match.index; break; }
  }
  const start = Math.max(0, Math.min(first - SNIPPET_LEAD, text.length - SNIPPET_CHARS));
  const end = start + SNIPPET_CHARS;
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Threads of `profileId` whose title text contains a token starting with a
 * query term ("singa" finds "Singapore"), ranked by the share of terms matched.
 */
export function matchThreadTitles(
  query: string,
  titles: readonly ThreadTitle[],
  profileId: string,
): readonly ChatSearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const hits: ChatSearchHit[] = [];
  for (const title of titles) {
    if (title.profile_id !== profileId) continue;
    const tokens = searchTerms(title.text);
    const matched = terms.filter((term) => tokens.some((token) => token.startsWith(term))).length;
    if (matched === 0) continue;
    hits.push({ source: 'thread', thread_id: title.thread_id, message_id: '', text: title.text, score: matched / terms.length });
  }
  // Array.prototype.sort is stable: equal scores keep the caller's order.
  return hits.sort((a, b) => b.score - a.score);
}

function hitKey(hit: ChatSearchHit): string {
  return hit.source === 'thread' ? `thread:${hit.thread_id}` : `message:${hit.message_id}`;
}

interface Fused {
  hit: ChatSearchHit;
  score: number;
  order: number;
}

/**
 * Merge ranked lists by reciprocal rank. Each item counts once per list, at
 * its best rank there. The fused score is normalized so rank 1 in every list
 * is 1.0. A thread-title hit is dropped when a message from that thread is
 * already in the results: the message is the more specific link.
 */
export function fuseByReciprocalRank(
  lists: readonly (readonly ChatSearchHit[])[],
  limit: number,
  k: number = RRF_K,
): readonly ChatSearchHit[] {
  const fused = new Map<string, Fused>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const hit of list) {
      const key = hitKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      const contribution = 1 / (k + seen.size);
      const entry = fused.get(key);
      if (entry) entry.score += contribution;
      else fused.set(key, { hit, score: contribution, order: fused.size });
    }
  }
  const best = lists.length / (k + 1);
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const messageThreads = new Set(ranked.filter((entry) => entry.hit.source === 'message').map((entry) => entry.hit.thread_id));
  return ranked
    .filter((entry) => entry.hit.source === 'message' || !messageThreads.has(entry.hit.thread_id))
    .slice(0, Math.max(0, limit))
    .map((entry) => ({ ...entry.hit, score: entry.score / best }));
}
