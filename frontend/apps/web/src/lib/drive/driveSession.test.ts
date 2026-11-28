import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGoogleSession,
  finishGoogleCallback,
  isSilentRenewalActive,
  withSilentRenewalAllowed,
} from './driveSession';
import { createFakeGoogleServer } from './testing/fakeGoogleFetch';
import { createMemoryCredentials } from './testing/memoryCredentials';

beforeEach(() => {
  sessionStorage.clear();
  vi.stubEnv('VITE_EXIT_GATE_HOOKS', '1');
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID_OVERRIDE', 'test-client.apps.googleusercontent.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('driveSession', () => {
  it('returns an unexpired token without redirecting', async () => {
    const creds = createMemoryCredentials();
    await creds.write('google-drive', { accessToken: 'ya29.fresh', expiresAt: 1_000_000 });
    const navigate = vi.fn();
    const session = createGoogleSession({ credentials: creds, now: () => 500_000, navigate });
    expect(await session.getAccessToken()).toBe('ya29.fresh');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('triggers at most ONE prompt=none silent bounce on an expired token (no loop)', async () => {
    const creds = createMemoryCredentials();
    await creds.write('google-drive', { accessToken: 'ya29.old', expiresAt: 500_000 });
    const urls: string[] = [];
    const session = createGoogleSession({
      credentials: creds,
      now: () => 500_000,
      origin: () => 'https://almamesh.com',
      currentPath: () => '/settings/data',
      navigate: (url) => urls.push(url),
    });

    await expect(session.getAccessToken()).rejects.toMatchObject({ kind: 'token_expired' });
    expect(urls).toHaveLength(1);
    const authUrl = new URL(urls[0]!);
    expect(authUrl.searchParams.get('prompt')).toBe('none');
    expect(authUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');

    // Second attempt after silent failure must NOT redirect again.
    await expect(session.getAccessToken()).rejects.toMatchObject({ kind: 'token_expired' });
    expect(urls).toHaveLength(1);
  });

  it.each([
    'login_required',
    'interaction_required',
    'consent_required',
    'account_selection_required',
  ])('maps OIDC silent error %s to reconnect_required', async (oidcError) => {
    const creds = createMemoryCredentials();
    await creds.write('google-drive', { accessToken: 'ya29.old', expiresAt: 1_000 });
    let redirected = '';
    const session = createGoogleSession({
      credentials: creds,
      now: () => 2_000,
      origin: () => 'https://almamesh.com',
      currentPath: () => '/settings/data',
      navigate: (url) => {
        redirected = url;
      },
    });
    await expect(session.getAccessToken()).rejects.toMatchObject({ kind: 'token_expired' });
    const state = new URL(redirected).searchParams.get('state')!;
    const replaceState = vi.fn();
    const outcome = await finishGoogleCallback(
      {
        location: { pathname: '/oauth/callback', hash: `#error=${oidcError}&state=${state}`, search: '' } as Location,
        history: { replaceState } as unknown as History,
      },
      creds,
      () => 3_000,
    );
    expect(outcome).toEqual({ ok: false, reason: 'reconnect_required', returnTo: '/settings/data' });
  });

  it('revokes the token at oauth2.googleapis.com and deletes the stored credential on disconnect', async () => {
    const creds = createMemoryCredentials();
    await creds.write('google-drive', { accessToken: 'revoke_me', expiresAt: 9_000_000 });
    const server = createFakeGoogleServer('revoke_me');
    const session = createGoogleSession({ credentials: creds, fetchImpl: server.fetchImpl });

    await session.disconnect();

    expect(await creds.read('google-drive')).toBeNull();
    expect(server.revokedTokens).toEqual(['revoke_me']);
  });

  it('never triggers prompt=none redirect outside withSilentRenewalAllowed', async () => {
    const creds = createMemoryCredentials();
    await creds.write('google-drive', { accessToken: 'ya29.expired', expiresAt: 1_000 });
    const navigate = vi.fn();
    const session = createGoogleSession({
      credentials: creds,
      now: () => 5_000,
      origin: () => 'https://almamesh.com',
      currentPath: () => '/settings/data',
      navigate,
      canSilentRenew: isSilentRenewalActive,
    });
    expect(await session.hasFreshToken()).toBe(false);
    await expect(session.getAccessToken()).rejects.toMatchObject({ kind: 'token_expired' });
    expect(navigate).not.toHaveBeenCalled();

    await expect(withSilentRenewalAllowed(() => session.getAccessToken())).rejects.toMatchObject({
      kind: 'token_expired',
    });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
