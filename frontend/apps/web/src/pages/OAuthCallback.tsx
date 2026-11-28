/**
 * `/oauth/callback` — completes the Google OAuth 2.0 redirect, scrubs the URL
 * fragment before paint, stores the encrypted device-local token, and returns
 * the user to the page where they initiated cloud backup or restore.
 */
import { type ReactElement, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '../components/ui';
import { type CallbackOutcome, finishGoogleCallback } from '../lib/drive/driveSession';
import { sanitizeReturnTo } from '../lib/drive/oauthRedirect';

function appendDriveStatus(returnTo: string, status: string): string {
  const safe = sanitizeReturnTo(returnTo);
  const url = new URL(safe, 'https://almamesh.local');
  url.searchParams.set('drive', status);
  return `${url.pathname}${url.search}${url.hash}`;
}

function setRobotsNoindex(): () => void {
  const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  const meta = existing ?? document.createElement('meta');
  const previous = existing?.content;
  meta.name = 'robots';
  meta.content = 'noindex, nofollow';
  if (!existing) document.head.appendChild(meta);
  return () => {
    if (!existing) meta.remove();
    else if (previous !== undefined) meta.content = previous;
  };
}

export function OAuthCallback(): ReactElement {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const [failedReason, setFailedReason] = useState<string | null>(null);
  const outcomeRef = useRef<Promise<CallbackOutcome> | null>(null);

  useLayoutEffect(() => {
    const restoreRobots = setRobotsNoindex();
    let active = true;
    outcomeRef.current ??= finishGoogleCallback();
    void outcomeRef.current
      .then((outcome) => {
        if (!active) return;
        if (outcome.ok) {
          navigate(appendDriveStatus(outcome.returnTo, 'connected'), { replace: true });
          return;
        }
        if (outcome.reason === 'invalid_state') {
          setFailedReason(t('drive.callback_invalid_state'));
          return;
        }
        const code = outcome.reason === 'consent_denied' ? 'consent_denied' : 'reconnect';
        navigate(appendDriveStatus(outcome.returnTo, code), { replace: true });
      })
      .catch(() => {
        if (active) setFailedReason(t('drive.callback_storage_error'));
      });
    return () => {
      active = false;
      restoreRobots();
    };
  }, [navigate, t]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-background-primary px-4">
      <div className="max-w-md w-full rounded-lg border border-ui-border bg-background-secondary p-6 text-center space-y-4">
        {failedReason === null ? (
          <>
            <div className="flex justify-center">
              <Spinner />
            </div>
            <p className="text-sm text-text-secondary" data-testid="oauth-callback-pending">
              {t('drive.callback_finishing')}
            </p>
          </>
        ) : (
          <>
            <p role="alert" className="text-sm text-status-error" data-testid="oauth-callback-error">
              {failedReason}
            </p>
            <button
              type="button"
              onClick={() => navigate('/settings/data', { replace: true })}
              className="px-4 py-2 rounded-md bg-accent-gold text-background-primary text-sm font-semibold"
              data-testid="oauth-callback-back"
            >
              {t('drive.callback_back')}
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export default OAuthCallback;
