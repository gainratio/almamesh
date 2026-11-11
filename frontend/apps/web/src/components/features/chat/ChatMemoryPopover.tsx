/**
 * Durable profile memory & context popover (`🧠`) in the Chat Context Bar.
 *
 * Displays saved profile context facts (`useProfileMemoryFacts`) with 1-click
 * delete + Clear All, current city status, and rolling thread summary indicator.
 * Restores keyboard focus to its trigger button whenever closed from inside.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentPlace, useChatStore, useProfileMemoryFacts, useProfilesStore } from '@almamesh/store';

interface ChatMemoryPopoverProps {
  readonly profileId: string | null;
  readonly threadId: string | null;
}

export function ChatMemoryPopover({ profileId, threadId }: ChatMemoryPopoverProps) {
  const { t } = useTranslation('chat');
  const activeProfileId = useProfilesStore((s) => s.activeProfileId);
  const targetId = profileId && useProfilesStore.getState().profiles[profileId] ? profileId : activeProfileId;
  const facts = useProfileMemoryFacts(targetId);
  const place = useProfilesStore((s) => (targetId ? getCurrentPlace(s.profiles[targetId]) : undefined));
  const removeFact = useProfilesStore((s) => s.removeProfileMemoryFact);
  const clearFacts = useProfilesStore((s) => s.clearProfileMemoryFacts);
  const hasThreadSummary = useChatStore((s) => Boolean(threadId && s.summaries[threadId]));

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('context.memory_button_aria', { count: facts.length })}
        title={t('context.memory_button_aria', { count: facts.length })}
        data-testid="chat-memory-button"
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60 ${
          facts.length > 0
            ? 'border-accent-purple/40 bg-accent-purple/10 text-text-primary hover:border-accent-purple'
            : 'border-ui-border bg-background-tertiary text-text-secondary hover:border-accent-gold/60 hover:text-text-primary'
        }`}
      >
        <span aria-hidden="true">🧠</span>
        <span>{t('context.memory_label')}</span>
        {facts.length > 0 && (
          <span
            data-testid="chat-memory-count"
            className="rounded-full bg-accent-purple/20 px-1.5 text-[10px] font-semibold text-accent-purple"
          >
            {facts.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('context.memory_popover_title')}
          data-testid="chat-memory-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeAndRestoreFocus();
            }
          }}
          className="absolute right-0 top-full z-30 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-ui-border bg-background-secondary p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-text-primary">{t('context.memory_popover_title')}</span>
            <button
              type="button"
              onClick={closeAndRestoreFocus}
              data-testid="chat-memory-close"
              className="min-h-6 min-w-6 rounded px-1.5 text-xs text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
            >
              {t('context.close')}
            </button>
          </div>

          <div className="mb-2 space-y-1 rounded-lg bg-background-tertiary/60 p-2 text-[11px] text-text-secondary">
            <p>
              <span aria-hidden="true">📍 </span>
              {place ? place.label : t('context.location_device_zone')}
            </p>
            {hasThreadSummary && (
              <p data-testid="chat-memory-summary-active" className="text-accent-gold">
                {t('context.thread_summary_active')}
              </p>
            )}
          </div>

          {facts.length === 0 ? (
            <p className="text-xs text-text-muted" data-testid="chat-memory-empty">
              {t('context.memory_empty')}
            </p>
          ) : (
            <>
              <ul className="max-h-48 space-y-1.5 overflow-y-auto" data-testid="chat-memory-list">
                {facts.map((fact) => (
                  <li
                    key={fact.id}
                    data-testid={`chat-memory-fact-${fact.id}`}
                    className="flex items-start justify-between gap-2 rounded-lg border border-ui-border/70 bg-background-primary p-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="inline-block rounded bg-background-tertiary px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
                        {fact.category}
                      </span>
                      <p className="mt-1 break-words text-text-primary">{fact.text}</p>
                    </div>
                    {targetId && (
                      <button
                        type="button"
                        aria-label={t('context.delete_fact')}
                        data-testid={`chat-memory-delete-${fact.id}`}
                        onClick={() => removeFact(targetId, fact.id)}
                        className="min-h-6 min-w-6 shrink-0 rounded px-1.5 text-xs text-text-muted hover:bg-status-error/10 hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {targetId && (
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    data-testid="chat-memory-clear-all"
                    onClick={() => clearFacts(targetId)}
                    className="min-h-6 rounded px-2 py-0.5 text-xs text-text-muted underline hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
                  >
                    {t('context.clear_all_facts')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
