import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { safeError } from '@almamesh/shared-types';

import { Button, cn } from '../../ui';
import {
  submitFeedback,
  type FeedbackFailureReason,
  type FeedbackSentiment,
} from '../../../lib/submitFeedback';

/**
 * FeedbackWidget — a quiet, ANONYMOUS, RE-OPENABLE product-feedback prompt.
 *
 * A compact trigger button (fits a toolbar/actions row) opens a small modal:
 * one question ("Was this helpful?" 👍/👎) plus an optional note, POSTed as a
 * no-identity payload to the `/api/feedback` Cloudflare Pages Function — no
 * account, no cookie, no tracking. Feedback is ONGOING, not one-time: after a
 * thank-you the user can "Send more" (each submit is its own D1 row) and the
 * trigger re-opens the form anytime. A short post-submit cooldown curbs rapid
 * re-spam from the UI.
 *
 * Bot protection is Cloudflare Turnstile, rendered only when a site key is
 * configured (`VITE_TURNSTILE_SITE_KEY`). With no key (local dev / tests) the
 * widget still works and sends the `'dev'` token the function tolerates. The
 * Turnstile script is loaded lazily, once, only while the panel is open, and
 * fails soft so it never blocks render or breaks offline.
 */

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_ACTION = 'turnstile-spin-v1';

/** Default post-submit cooldown (ms) before another note can be sent. */
const DEFAULT_COOLDOWN_MS = 4000;

// --- Turnstile (lazy, once, fail-soft) ---------------------------------------

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<TurnstileApi | null> | null = null;

function loadTurnstile(): Promise<TurnstileApi | null> {
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile ?? null);
    script.onerror = () => resolve(null); // offline / blocked — fail soft
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

function readTurnstileSiteKey(): string | undefined {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return env.VITE_TURNSTILE_SITE_KEY;
}

type Status = 'idle' | 'submitting' | 'thanks' | 'error';

export interface FeedbackWidgetProps {
  /** Stable identifier for the surface (e.g. 'dashboard'). */
  page: string;
  className?: string;
  /**
   * Post-submit cooldown before another note can be sent (ms). Injectable so
   * tests don't have to wait real time; defaults to a few seconds in the app.
   */
  cooldownMs?: number;
}

export function FeedbackWidget({ page, className, cooldownMs = DEFAULT_COOLDOWN_MS }: FeedbackWidgetProps) {
  const { t } = useTranslation('feedback');
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<FeedbackSentiment>(null);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorReason, setErrorReason] = useState<FeedbackFailureReason | null>(null);
  const [coolingDown, setCoolingDown] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const siteKey = readTurnstileSiteKey();
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const resetForm = useCallback(() => {
    setSentiment(null);
    setMessage('');
    setStatus('idle');
    setErrorReason(null);
    setTurnstileToken(null);
  }, []);

  const openPanel = () => {
    resetForm();
    setOpen(true);
  };
  const closePanel = useCallback(() => {
    setOpen(false);
    resetForm();
  }, [resetForm]);

  // Esc closes the modal (a dialog affordance users expect).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closePanel]);

  // Dialog focus management (WAI-ARIA): move focus INTO the dialog on open and
  // restore it to the trigger on close, so keyboard/AT users aren't stranded.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Capture the trigger now (it's stable while mounted) so the cleanup restores
    // focus to it without reading a possibly-changed ref.
    const trigger = triggerRef.current;
    // Defer to after the portal paints so the ref is populated.
    const id = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      (trigger ?? previouslyFocused)?.focus?.();
    };
  }, [open]);

  // Keep Tab inside the open dialog (a lightweight focus trap).
  const trapFocus = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Render Turnstile only while the panel is open AND a site key is configured.
  // Lazy-loaded, fail-soft, cleaned up when the panel closes/unmounts.
  useEffect(() => {
    if (!open || status === 'thanks' || !siteKey || !turnstileRef.current) return;
    const container = turnstileRef.current;
    let widgetId: string | undefined;
    let cancelled = false;
    void loadTurnstile()
      .then((api) => {
        if (!api || cancelled) return;
        widgetId = api.render(container, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          callback: (token) => setTurnstileToken(token),
          'error-callback': () => setTurnstileToken(null),
          'expired-callback': () => setTurnstileToken(null),
        });
      })
      .catch((err) => {
        // A synchronous render() throw (or a load hiccup) must not become an
        // unhandled rejection; degrade to no-token (Turnstile fails soft).
        safeError('feedback.turnstile_init_failed', err);
        setTurnstileToken(null);
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [open, status, siteKey]);

  // Never leak the cooldown timer.
  useEffect(
    () => () => {
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    },
    [],
  );

  const trimmed = message.trim();
  // A send needs signal (sentiment or note), no in-flight request, and — the
  // anti-spam gate — no active post-submit cooldown.
  const canSend = (sentiment !== null || trimmed.length > 0) && status !== 'submitting' && !coolingDown;

  const handleSend = async () => {
    setStatus('submitting');
    const result = await submitFeedback({
      page,
      sentiment,
      message: trimmed.length > 0 ? trimmed : null,
      turnstileToken: siteKey ? (turnstileToken ?? '') : 'dev',
    });
    if (result.ok) {
      setStatus('thanks');
      // Post-submit cooldown: briefly gate the next send to curb rapid re-spam.
      setCoolingDown(true);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      cooldownTimer.current = setTimeout(() => setCoolingDown(false), cooldownMs);
    } else {
      // Carry the typed reason so the message is honest — a 429 says "slow down",
      // a 403 says "verification failed", not a generic "try again" into the wall.
      setErrorReason(result.reason);
      setStatus('error');
    }
  };

  const errorKey: string =
    errorReason === 'rate_limited'
      ? 'error_rate_limited'
      : errorReason === 'forbidden'
        ? 'error_forbidden'
        : errorReason === 'bad_request'
          ? 'error_bad_request'
          : 'error';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openPanel}
        data-testid="feedback-open"
        title={t('open_title')}
        aria-label={t('open_title')}
        aria-haspopup="dialog"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-ui-border px-3 py-1.5 text-sm',
          'text-text-secondary transition-colors hover:border-accent-gold/40 hover:text-text-primary',
          className,
        )}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.83L3 20l1.17-3.5A7.9 7.9 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
        <span>{t('open')}</span>
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={t('title')}
            data-testid="feedback-dialog"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closePanel();
            }}
          >
            <div
              ref={dialogRef}
              tabIndex={-1}
              onKeyDown={trapFocus}
              className="w-full max-w-md rounded-xl border border-ui-border bg-background-secondary p-5 shadow-2xl focus:outline-hidden"
              data-testid="feedback-widget"
            >
              {status === 'thanks' ? (
                <div className="space-y-4">
                  <ThankYou title={t('thanks_title')} body={t('thanks_body')} />
                  {coolingDown && (
                    <p className="text-xs text-text-tertiary" data-testid="feedback-cooldown">
                      {t('cooldown')}
                    </p>
                  )}
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="feedback-send-more"
                      disabled={coolingDown}
                      onClick={resetForm}
                    >
                      {t('send_more')}
                    </Button>
                    <button
                      type="button"
                      data-testid="feedback-close"
                      onClick={closePanel}
                      className="text-xs text-text-muted underline-offset-2 transition-colors hover:text-text-secondary hover:underline"
                    >
                      {t('close')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <h3 className="font-display text-base text-text-primary">{t('title')}</h3>
                    <p className="text-sm text-text-secondary">{t('subtitle')}</p>
                  </div>

                  <div className="flex items-center gap-2" role="group" aria-label={t('title')}>
                    <SentimentButton
                      testId="feedback-up"
                      label={t('helpful_yes')}
                      selected={sentiment === 'up'}
                      onClick={() => setSentiment(sentiment === 'up' ? null : 'up')}
                    >
                      <span aria-hidden="true">👍</span>
                    </SentimentButton>
                    <SentimentButton
                      testId="feedback-down"
                      label={t('helpful_no')}
                      selected={sentiment === 'down'}
                      onClick={() => setSentiment(sentiment === 'down' ? null : 'down')}
                    >
                      <span aria-hidden="true">👎</span>
                    </SentimentButton>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="feedback-message" className="block text-sm text-text-secondary">
                      {t('message_label')}
                    </label>
                    <textarea
                      id="feedback-message"
                      data-testid="feedback-message"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      rows={3}
                      maxLength={1000}
                      placeholder={t('message_placeholder')}
                      className={cn(
                        'w-full rounded-md border border-ui-border bg-background-darker px-3 py-2',
                        'font-sans text-sm text-text-primary placeholder:text-text-muted',
                        'transition-colors duration-200 ease-orbital resize-none',
                        'focus-visible:outline-hidden focus-visible:border-accent-gold/60',
                        'focus-visible:ring-2 focus-visible:ring-ui-focus/40',
                      )}
                    />
                  </div>

                  {siteKey && <div ref={turnstileRef} data-action={TURNSTILE_ACTION} className="min-h-[1px]" />}

                  <p className="text-xs text-text-tertiary" data-testid="feedback-anonymous-note">
                    {t('anonymous_note')}
                  </p>

                  {status === 'error' && (
                    <p className="text-sm text-status-error" data-testid="feedback-error">
                      {t(errorKey)}
                    </p>
                  )}

                  {coolingDown && (
                    <p className="text-xs text-text-tertiary" data-testid="feedback-cooldown">
                      {t('cooldown')}
                    </p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="feedback-send"
                      disabled={!canSend}
                      onClick={() => void handleSend()}
                    >
                      {status === 'submitting'
                        ? t('sending')
                        : status === 'error'
                          ? t('retry')
                          : t('send')}
                    </Button>
                    <button
                      type="button"
                      data-testid="feedback-close"
                      onClick={closePanel}
                      className="text-xs text-text-muted underline-offset-2 transition-colors hover:text-text-secondary hover:underline"
                    >
                      {t('close')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function ThankYou({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-1" data-testid="feedback-thanks">
      <h3 className="font-display text-base text-accent-gold">{title}</h3>
      <p className="text-sm text-text-secondary">{body}</p>
    </div>
  );
}

interface SentimentButtonProps {
  testId: string;
  label: string;
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}

function SentimentButton({ testId, label, selected, onClick, children }: SentimentButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
        'transition-colors duration-200 ease-orbital',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ui-focus/40',
        selected
          ? 'border-accent-gold/60 bg-accent-gold/10 text-text-primary'
          : 'border-ui-border bg-background-darker text-text-secondary hover:border-accent-gold/40 hover:text-text-primary',
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
