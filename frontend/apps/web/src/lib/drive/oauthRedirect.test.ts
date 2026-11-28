import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginSignIn,
  PENDING_SIGN_IN_KEY,
  PENDING_SIGN_IN_TTL_MS,
  readCallback,
  scrubCallbackUrl,
  takePendingSignIn,
} from './oauthRedirect';

beforeEach(() => {
  sessionStorage.clear();
});

describe('oauthRedirect', () => {
  it('verifies CSRF state once and deletes the pending record immediately', () => {
    const state = beginSignIn({ provider: 'google-drive', returnTo: '/settings/data' }, 1_000);
    const record = takePendingSignIn(state, 5_000);
    expect(record).toMatchObject({ provider: 'google-drive', returnTo: '/settings/data', silent: false });
    expect(sessionStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
    expect(takePendingSignIn(state, 5_000)).toBeNull();
  });

  it('rejects a mismatched state and burns the pending record', () => {
    const state = beginSignIn({ provider: 'google-drive', returnTo: '/settings/data' }, 1_000);
    expect(takePendingSignIn('wrong-state-value-1234567890', 2_000)).toBeNull();
    expect(takePendingSignIn(state, 2_000)).toBeNull();
  });

  it('rejects a pending sign-in older than 10 minutes', () => {
    const state = beginSignIn({ provider: 'google-drive', returnTo: '/settings/data' }, 1_000);
    expect(takePendingSignIn(state, 1_000 + PENDING_SIGN_IN_TTL_MS + 1)).toBeNull();
  });

  it('sanitizes external, protocol-relative, backslash-prefixed, or callback returnTo paths to /', () => {
    for (const unsafe of [
      'https://evil.example/steal',
      '//evil.example',
      '/\\evil.example',
      '/\\[',
      '/oauth/callback?loop=1',
    ]) {
      const s = beginSignIn({ provider: 'google-drive', returnTo: unsafe }, 100);
      expect(takePendingSignIn(s, 200)?.returnTo, unsafe).toBe('/');
    }
  });

  it('reads access_token exclusively from URL fragment, never query parameters', () => {
    expect(
      readCallback({ hash: '#access_token=tok123&expires_in=3600&state=s1', search: '' }),
    ).toEqual({ state: 's1', accessToken: 'tok123', expiresInSeconds: 3600, error: null });

    expect(
      readCallback({ hash: '', search: '?access_token=leaked&state=s1&error=access_denied' }),
    ).toEqual({ state: 's1', accessToken: null, expiresInSeconds: null, error: 'access_denied' });
  });

  it('scrubs fragment and query from browser history immediately', () => {
    const replaceState = vi.fn();
    scrubCallbackUrl({
      location: { pathname: '/oauth/callback', hash: '#access_token=secret', search: '?state=x' } as Location,
      history: { replaceState } as unknown as History,
    });
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/oauth/callback');
  });
});
