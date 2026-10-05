/**
 * ChatSearch — discoverable semantic search over this profile's chat history.
 *
 * Reachable directly from the dashboard chat surface (a search input pinned
 * above the conversation), NOT buried in settings. Typing a query runs an
 * on-device embedding search via `@almamesh/memory` (zero egress); each hit
 * shows the matched snippet, the owning thread's title, and a relevance score.
 * Clicking a hit hands its `message_id` + `thread_id` back to the parent so the
 * conversation can scroll to / open that message.
 *
 * Best-effort: a missing/failed embedder degrades to no results (never throws).
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@almamesh/store';
import type { RetrievedChunk } from '@almamesh/memory';

import { searchMemory } from '../../../lib/chatMemory';
import { useEmbedderStatus } from '../../../hooks/useEmbedderStatus';

interface ChatSearchProps {
  /** The active profile whose chat history is searched. */
  readonly profileId: string;
  /** Open the conversation at a specific message (scroll-to / highlight). */
  readonly onOpenResult: (messageId: string, threadId: string) => void;
}

const DEBOUNCE_MS = 200;
const SEARCH_K = 8;

export function ChatSearch({ profileId, onOpenResult }: ChatSearchProps) {
  const { t } = useTranslation('chat');
  const threadsById = useChatStore((s) => s.threads);

  /** A short label for a thread: its title, else a localized fallback. */
  const threadLabel = (title: string | null): string =>
    title?.trim() || t('search.thread_fallback');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly RetrievedChunk[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const modelLoading = useEmbedderStatus() === 'loading';

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const handle = setTimeout(() => {
      void searchMemory(q, profileId, SEARCH_K).then((hits) => {
        if (!cancelled) {
          setResults(hits);
          setIsSearching(false);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, profileId]);

  return (
    <div className="px-4 pt-3" data-testid="chat-search">
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"
          />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.aria_label')}
          data-testid="chat-search-input"
          className="w-full rounded-xl border border-ui-border bg-background-primary py-2 pl-9 pr-3 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-gold/50"
        />
      </div>

      {query.trim().length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto" data-testid="chat-search-results">
          {results.length === 0 && isSearching && modelLoading ? (
            <p
              className="px-1 py-2 text-xs text-text-muted"
              role="status"
              data-testid="chat-search-model-loading"
            >
              {t('search.loading_model')}
            </p>
          ) : results.length === 0 ? (
            <p className="px-1 py-2 text-xs text-text-muted">
              {isSearching ? t('search.searching') : t('search.no_results')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {results.map((hit) => (
                <li key={hit.message_id}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenResult(hit.message_id, hit.thread_id);
                      setQuery('');
                    }}
                    data-testid={`chat-search-result-${hit.message_id}`}
                    className="block w-full rounded-lg border border-ui-border bg-background-tertiary px-3 py-2 text-left transition-colors hover:border-accent-gold hover:bg-background-secondary"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-text-secondary">
                        {threadLabel(threadsById[hit.thread_id]?.title ?? null)}
                      </span>
                      <span className="flex-shrink-0 text-[10px] tabular-nums text-text-muted">
                        {t('search.match', { percent: Math.round(hit.score * 100) })}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-text-primary">{hit.text}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatSearch;
