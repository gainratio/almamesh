/**
 * Pure ranking for chat search: thread-title matching, stopword-aware token
 * extraction, and reciprocal-rank fusion (RRF) of semantic, keyword, and title
 * result lists.
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

/**
 * Common conversational filler tokens stripped from multi-word keyword/FTS
 * queries when at least one content-bearing token remains (note: month names
 * like "may" are deliberately preserved so period queries keep matching).
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being',
  'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of',
  'on', 'or', 'our', 'please', 'should', 'so', 'tell', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'us', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

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

/**
 * Content-bearing search tokens: strips conversational stopwords when at least
 * one non-stopword token exists, otherwise keeps the full token list so queries
 * composed solely of stopwords (e.g. "what is this") still match verbatim.
 */
export function informativeSearchTerms(query: string): readonly string[] {
  const all = searchTerms(query);
  if (all.length <= 1) return all;
  const filtered = all.filter((term) => !QUERY_STOPWORDS.has(term));
  return filtered.length > 0 ? filtered : all;
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
  const terms = informativeSearchTerms(query);
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
  const terms = informativeSearchTerms(query);
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
  bestContribution: number;
  order: number;
}

const SINGLE_LIST_TOP_WEIGHT = 0.95;
const MULTI_LIST_BONUS_WEIGHT = 0.05;

function normalizeFusedScore(entry: Fused, listCount: number, k: number): number {
  const singleTop = 1 / (k + 1);
  if (listCount <= 1) return Math.min(1, entry.bestContribution / singleTop);
  const base = SINGLE_LIST_TOP_WEIGHT * (entry.bestContribution / singleTop);
  const bonus = MULTI_LIST_BONUS_WEIGHT * ((entry.score - entry.bestContribution) / singleTop);
  return Math.min(1, base + bonus);
}

/**
 * Merge ranked lists by reciprocal rank. Each item counts once per list, at
 * its best rank there. Ordering uses pure RRF sum; display score normalizes a
 * single-retriever #1 match to 0.95 (95%) and boosts multi-retriever agreement
 * smoothly up to 1.0 (100%), avoiding the misleading 33% ceiling when only one
 * of three retrievers applies (e.g. thread title or exact keyword hit).
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
      if (entry) {
        entry.score += contribution;
        if (contribution > entry.bestContribution) entry.bestContribution = contribution;
      } else {
        fused.set(key, { hit, score: contribution, bestContribution: contribution, order: fused.size });
      }
    }
  }
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const messageThreads = new Set(ranked.filter((entry) => entry.hit.source === 'message').map((entry) => entry.hit.thread_id));
  return ranked
    .filter((entry) => entry.hit.source === 'message' || !messageThreads.has(entry.hit.thread_id))
    .slice(0, Math.max(0, limit))
    .map((entry) => ({ ...entry.hit, score: normalizeFusedScore(entry, lists.length, k) }));
}
