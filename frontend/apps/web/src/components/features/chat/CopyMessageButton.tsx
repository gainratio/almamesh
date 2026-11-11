/**
 * Accessible Copy button for assistant answers.
 *
 * Follows modern-web-guidance `copy-button`:
 * - Button stays enabled during feedback so keyboard focus never drops.
 * - Live region sits as a sibling OUTSIDE the `<button>` and toggles via
 *   `opacity` (never `display: none` or `visibility: hidden`).
 * - Appends `\u00A0` when repeating the same announcement so VoiceOver speaks
 *   consecutive copies reliably.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface CopyMessageButtonProps {
  readonly text: string;
}

const FEEDBACK_MS = 1800;

export function CopyMessageButton({ text }: CopyMessageButtonProps) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncementRef = useRef('');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (!text.trim()) return null;

  const announce = (baseMessage: string) => {
    const next = lastAnnouncementRef.current === baseMessage ? `${baseMessage}\u00A0` : baseMessage;
    lastAnnouncementRef.current = next;
    setAnnouncement(next);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      announce(t('copy.copied'));
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        setAnnouncement('');
        timerRef.current = null;
      }, FEEDBACK_MS);
    } catch {
      announce(t('copy.failed'));
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={t('copy.button')}
        title={t('copy.button')}
        data-testid="chat-copy-button"
        className="inline-flex min-h-6 min-w-6 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-text-muted transition-colors hover:bg-background-secondary/60 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold/60"
      >
        {copied ? (
          <svg aria-hidden="true" className="h-3.5 w-3.5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
        <span>{copied ? t('copy.copied') : t('copy.button')}</span>
      </button>
      <span
        aria-live="polite"
        aria-atomic="true"
        data-testid="chat-copy-status"
        className={`sr-only transition-opacity ${copied ? 'opacity-100' : 'opacity-0'}`}
      >
        {announcement}
      </span>
    </span>
  );
}
