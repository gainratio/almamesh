/**
 * ConversationalAccelerator — streaming multi-turn interview loop (slice 5).
 *
 * A warm, one-question-at-a-time AI chat that elicits DATED life events and
 * flushes them into the life-events store as reviewable draft rows. The
 * transcript is local to this component — only the extracted events persist.
 *
 * GATING — actionable only with a CLOUD AI endpoint (OpenRouter / custom); BYO
 * local endpoints stay gated (no typed-extraction enforcement there). The gated
 * state renders a calm static note so users always have the manual-entry
 * fallback.
 *
 * EGRESS — an explicit one-line warning is shown before every submission so the
 * user knows their message is sent to their configured AI endpoint.
 *
 * INJECTION — streamFn and gatherFn default to the real LLM imports but can be
 * replaced via props for deterministic testing without any network calls.
 *
 * ACCESSIBILITY — ARIA live region on the streaming draft; role="log" on the
 * completed transcript; labeled input; focus returned to input after each turn.
 */
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLifeEventsStore } from '@almamesh/store';
import {
  streamRectificationInterview as defaultStreamFn,
  gatherEventsFromTurn as defaultGatherFn,
  type ChatTurn,
  type InterviewGatheredEvent,
} from '@almamesh/llm';
import type { CanonicalLifeEventDraft } from '@almamesh/shared-types';
import { MessageBubble } from '../chat/MessageBubble';
import { Spinner } from '../../ui/Spinner';
import { isAiUsable, resolveConfig, toPromptLanguage } from './rectifyLlmConfig';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ConversationalAcceleratorProps {
  /** The profile whose life-events store will receive the extracted rows. */
  readonly profileId: string;
  /**
   * Streaming interview function — defaults to the real LLM implementation.
   * Override in tests to yield tokens synchronously without any network call.
   */
  readonly streamFn?: typeof defaultStreamFn;
  /**
   * Event-extraction function — defaults to the real LLM implementation.
   * Override in tests to return synthetic events without any network call.
   */
  readonly gatherFn?: typeof defaultGatherFn;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The PII-safe interview state (Spec 062, LLM delta 2): every STRUCTURED
 * life event already gathered for this profile — manual rows included — as
 * `{date, category, precision}` ONLY. Summaries/notes never cross; the
 * `InterviewGatheredEvent` type is the boundary.
 */
function gatheredInterviewState(profileId: string): InterviewGatheredEvent[] {
  return useLifeEventsStore
    .getState()
    .getEvents(profileId)
    .flatMap((e) =>
      e.date && e.category
        ? [{ date: e.date, category: e.category, precision: e.precision ?? ('exact' as const) }]
        : [],
    );
}

/** Format a captured event as a human-readable chip label. */
function formatChip(ev: CanonicalLifeEventDraft): string {
  const label = ev.category.replace(/_/g, ' ');
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  let date = ev.date;
  const precision = ev.precision ?? 'exact';
  if (precision === 'month') date = ev.date.slice(0, 7);
  else if (precision === 'year' || precision === 'approx') date = ev.date.slice(0, 4);
  return `${cap} · ${date} · ${precision}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ConversationalAccelerator({
  profileId,
  streamFn = defaultStreamFn,
  gatherFn = defaultGatherFn,
}: ConversationalAcceleratorProps): ReactElement {
  const { t, i18n } = useTranslation('rectify');
  const addEvent = useLifeEventsStore((s) => s.addEvent);
  const editEvent = useLifeEventsStore((s) => s.editEvent);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Lazy-initialise with the opening assistant turn so it reflects the current
  // language at mount time. Language changes during an active session are
  // intentionally not tracked — restarting the wizard resets correctly.
  const [messages, setMessages] = useState<readonly ChatTurn[]>(() => [
    { role: 'assistant', content: t('chat.opening') },
  ]);
  const [streamingDraft, setStreamingDraft] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Distinguishes the post-turn event-extraction phase from the streaming phase
  // so the UI can show a distinct "reading your message…" indicator.
  const [gathering, setGathering] = useState(false);
  const [captured, setCaptured] = useState<readonly CanonicalLifeEventDraft[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);

  // Abort any in-flight stream on unmount to avoid setState on an unmounted component.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── AI gate (cloud only; BYO local stays gated) ──────────────────────────
  if (!isAiUsable()) {
    return (
      <div
        data-testid="chat-gated"
        className="rounded-xl border border-ui-border bg-background-secondary p-4"
      >
        <p className="text-sm text-text-secondary">{t('chat.gated_note')}</p>
      </div>
    );
  }

  // ── Submit handler ────────────────────────────────────────────────────────
  const runSubmit = async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;

    setInput('');
    setBusy(true);
    setChatError(null);

    const userTurn: ChatTurn = { role: 'user', content: trimmed };
    // Append user turn first so the history passed to the LLM is up to date.
    const updatedHistory = [...messages, userTurn];
    setMessages(updatedHistory);

    // Cancel any in-flight stream from a previous turn.
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const config = resolveConfig();
      const language = toPromptLanguage(i18n.language);

      // ── Stream assistant reply token-by-token ──────────────────────────
      let draft = '';
      setStreamingDraft('');
      for await (const token of streamFn({
        history: updatedHistory,
        config,
        language,
        // PII-safe gathered-state block (dates + categories + precision only)
        // so the interviewer seeks missing categories instead of re-asking.
        state: gatheredInterviewState(profileId),
        signal: abortRef.current.signal,
      })) {
        draft += token;
        setStreamingDraft(draft);
      }

      // Commit the completed assistant message; clear the draft immediately so
      // the committed message and the streaming draft are never both visible.
      setMessages((prev) => [...prev, { role: 'assistant', content: draft }]);
      setStreamingDraft('');

      // ── Extract and flush life events ──────────────────────────────────
      // Surface a distinct "reading your message…" indicator while the
      // extractor works (the streaming phase is already done here).
      setGathering(true);
      const gathered = await gatherFn(trimmed, config, language);
      setGathering(false);
      if (gathered.status === 'error') {
        // A REAL extraction failure (network/parse) — distinct from a turn with
        // nothing datable. Say so, or the user's dated milestone silently
        // wouldn't count toward the rectification.
        setChatError(t('chat.gather_error'));
        return;
      }
      const extracted = gathered.events;
      if (extracted.length > 0) {
        // Snapshot the current event count so we can identify newly added rows.
        const beforeCount = useLifeEventsStore.getState().getEvents(profileId).length;

        // addEvent accepts LifeEventInput (description + date + summary) —
        // category and precision are patched via editEvent because
        // LifeEventInput has no category field. The summary is the user's own
        // words. A raw-turn fallback is safe only when the turn produced one
        // event; copying one multi-event blob into every row destroys meaning.
        const singleEventFallback = extracted.length === 1 ? trimmed : undefined;
        for (const ev of extracted) {
          const summary = ev.summary ?? singleEventFallback;
          addEvent(profileId, {
            description: ev.category,
            date: ev.date,
            ...(summary ? { summary } : {}),
          });
        }

        const after = useLifeEventsStore.getState().getEvents(profileId);
        for (let i = 0; i < extracted.length; i++) {
          const evt = after[beforeCount + i];
          const ev = extracted[i];
          if (evt && ev) {
            editEvent(profileId, evt.id, {
              category: ev.category,
              ...(ev.precision ? { precision: ev.precision } : {}),
            });
          }
        }

        setCaptured((prev) => [...prev, ...extracted]);
      }
    } catch {
      // Stream or gather error — show inline error; draft + busy cleared in finally.
      setChatError(t('chat.error'));
    } finally {
      setStreamingDraft('');
      setGathering(false);
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  /** Form submit (button click) — prevent default, then run the turn. */
  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void runSubmit();
  };

  /** Enter submits; Shift+Enter inserts a newline (chart-chat parity). */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void runSubmit();
    }
  };

  // Awaiting the model's first token — mirror ChatPanel's typing indicator
  // (busy, no streamed draft yet, and not in the post-turn extraction phase).
  const showThinking = busy && streamingDraft === '' && !gathering;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Egress warning — informs user that transcript text is sent to the configured AI endpoint */}
      <p className="text-xs text-text-muted">{t('accelerator.warning')}</p>

      {/* Completed transcript — role="log" implies aria-live="polite". Messages
          reuse the shared chart-chat MessageBubble so the interview looks and
          feels like "Ask About Your Chart". */}
      <div role="log" aria-label={t('chat.transcript_label')} className="flex flex-col">
        {messages.map((msg, i) => (
          <div
            key={i}
            data-testid={i === 0 && msg.role === 'assistant' ? 'chat-opening' : undefined}
          >
            <MessageBubble role={msg.role} content={msg.content} />
          </div>
        ))}

        {/* Streaming draft — live region so screen readers announce tokens */}
        {streamingDraft && (
          <div aria-live="polite" aria-atomic="false">
            <MessageBubble role="assistant" content={streamingDraft} />
          </div>
        )}

        {/* Thinking indicator — animated dots while awaiting the first token
            (mirrors ChatPanel's typing indicator). */}
        {showThinking && (
          <div className="mb-4 flex justify-start" data-testid="chat-thinking">
            <div className="rounded-2xl rounded-bl-sm bg-background-tertiary px-4 py-3">
              <div className="flex gap-1" aria-label={t('chat.thinking')} role="status">
                <span
                  className="h-2 w-2 animate-bounce rounded-full bg-text-muted"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="h-2 w-2 animate-bounce rounded-full bg-text-muted"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="h-2 w-2 animate-bounce rounded-full bg-text-muted"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Reading indicator — the post-turn event-extraction phase, so the
            user knows their message is being read for dates + event types. */}
        {gathering && (
          <div
            className="mb-4 flex items-center gap-2 text-xs text-text-muted"
            data-testid="chat-reading"
          >
            <Spinner size="sm" className="text-accent-gold" />
            <span>{t('chat.reading')}</span>
          </div>
        )}

        {/* Inline error — transient, calm; cleared on next submit */}
        {chatError && (
          <div role="status" className="rounded-lg px-3 py-2 text-sm text-text-secondary">
            {chatError}
          </div>
        )}
      </div>

      {/* Captured event chips */}
      {captured.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {captured.map((ev, i) => (
            <span
              key={i}
              data-testid="captured-chip"
              className="rounded-full bg-accent-gold/10 px-2 py-0.5 text-xs text-accent-gold"
            >
              {formatChip(ev)}
            </span>
          ))}
        </div>
      )}

      {/* Input row — a roomier textarea mirroring the chart chat's composer.
          Enter submits; Shift+Enter inserts a newline. */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <textarea
          ref={inputRef}
          id="chat-input"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
          placeholder={t('chat.input_placeholder')}
          aria-label={t('chat.input_label')}
          className="min-w-0 flex-1 resize-none rounded-xl border border-ui-border bg-background-primary px-4 py-3 text-sm text-text-primary placeholder-text-muted focus:outline-hidden focus:ring-2 focus:ring-accent-gold/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="self-end rounded-xl bg-accent-gold px-4 py-3 text-sm font-semibold text-background-primary transition-colors hover:bg-accent-gold/90 focus:outline-hidden focus:ring-2 focus:ring-accent-gold/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('chat.send')}
        </button>
      </form>
    </div>
  );
}
