/**
 * OAuth 2.0 session coordinator for Google Drive (`drive.file` implicit flow
 * with 60 s expiry skew, single `prompt=none` silent bounce on user action only,
 * and token revocation on disconnect).
 */
import { portableStatePersistence } from '@almamesh/store';
import { type CredentialStore, credentialStore } from './credentialStore';
import { DriveError } from './backupDrive';
import { beginSignIn, readCallback, scrubCallbackUrl, takePendingSignIn } from './oauthRedirect';
import { effectiveGoogleClientId, GOOGLE_DRIVE_SCOPE, REDIRECT_PATH } from './providerConfig';

export const SILENT_TRIED_KEY = 'almamesh-oauth-silent-tried';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_SECONDS = 3600;

let silentRenewalDepth = 0;
const silentReturnToStack: (string | undefined)[] = [];

/**
 * Scope guard ensuring `prompt=none` full-page redirects run ONLY inside explicit
 * user-initiated Drive button clicks — never during page-load probes or local-file restore.
 */
export async function withSilentRenewalAllowed<T>(
  fn: () => Promise<T>,
  returnToOverride?: string,
): Promise<T> {
  silentRenewalDepth += 1;
  silentReturnToStack.push(returnToOverride);
  try {
    return await fn();
  } finally {
    silentReturnToStack.pop();
    silentRenewalDepth -= 1;
  }
}

export type CallbackOutcome =
  | { readonly ok: true; readonly returnTo: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid_state' | 'consent_denied' | 'reconnect_required';
      readonly returnTo: string;
    };

export interface GoogleSessionDeps {
  readonly credentials?: CredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly origin?: () => string;
  readonly currentPath?: () => string;
  readonly navigate?: (url: string) => void;
  /** Defaults to `true` in standalone unit tests; production wires `() => silentRenewalDepth > 0`. */
  readonly canSilentRenew?: () => boolean;
}

export interface GoogleSession {
  startConnect(returnTo: string): Promise<'redirecting'>;
  isConnected(): Promise<boolean>;
  hasFreshToken(): Promise<boolean>;
  getAccessToken(): Promise<string>;
  disconnect(): Promise<void>;
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function buildGoogleAuthUrl(params: {
  clientId: string;
  origin: string;
  state: string;
  silent: boolean;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', `${params.origin}${REDIRECT_PATH}`);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', GOOGLE_DRIVE_SCOPE);
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', params.state);
  if (params.silent) url.searchParams.set('prompt', 'none');
  return url.toString();
}

export function createGoogleSession(deps: GoogleSessionDeps = {}): GoogleSession {
  const creds = deps.credentials ?? credentialStore;
  const fetchFn = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const origin = deps.origin ?? (() => window.location.origin);
  const currentPath = deps.currentPath ?? (() => `${window.location.pathname}${window.location.search}`);
  const navigate = deps.navigate ?? ((url) => window.location.assign(url));
  const canSilentRenew = deps.canSilentRenew ?? (() => true);

  const redirectForToken = (returnTo: string, silent: boolean): void => {
    if (portableStatePersistence() === 'memory') throw new DriveError('not_connected');
    const clientId = effectiveGoogleClientId();
    if (clientId.length === 0) throw new DriveError('not_connected');
    const state = beginSignIn({ provider: 'google-drive', returnTo, silent }, now());
    navigate(buildGoogleAuthUrl({ clientId, origin: origin(), state, silent }));
  };

  return {
    startConnect: async (returnTo) => {
      safeSession()?.removeItem(SILENT_TRIED_KEY);
      redirectForToken(returnTo, false);
      return 'redirecting';
    },
    isConnected: async () => (await creds.read('google-drive')) !== null,
    hasFreshToken: async () => {
      const stored = await creds.read('google-drive');
      return stored !== null && stored.expiresAt - EXPIRY_SKEW_MS > now();
    },
    getAccessToken: async () => {
      const stored = await creds.read('google-drive');
      if (stored === null) throw new DriveError('not_connected');
      if (stored.expiresAt - EXPIRY_SKEW_MS > now()) return stored.accessToken;
      const session = safeSession();
      if (canSilentRenew() && session?.getItem(SILENT_TRIED_KEY) !== '1') {
        session?.setItem(SILENT_TRIED_KEY, '1');
        const target = silentReturnToStack[silentReturnToStack.length - 1] ?? currentPath();
        redirectForToken(target, true);
      }
      throw new DriveError('token_expired');
    },
    disconnect: async () => {
      const stored = await creds.read('google-drive');
      await creds.remove('google-drive');
      safeSession()?.removeItem(SILENT_TRIED_KEY);
      if (stored === null) return;
      const body = new URLSearchParams({ token: stored.accessToken }).toString();
      await fetchFn(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }).catch(() => undefined);
    },
  };
}

export function isSilentRenewalActive(): boolean {
  return silentRenewalDepth > 0;
}

export async function finishGoogleCallback(
  win: Pick<Window, 'location' | 'history'> = window,
  creds: CredentialStore = credentialStore,
  now: () => number = () => Date.now(),
): Promise<CallbackOutcome> {
  const params = readCallback(win.location);
  scrubCallbackUrl(win);
  const pending = takePendingSignIn(params.state, now());
  if (pending === null) return { ok: false, reason: 'invalid_state', returnTo: '/' };
  if (portableStatePersistence() === 'memory') {
    return { ok: false, reason: 'reconnect_required', returnTo: pending.returnTo };
  }
  if (params.error !== null || params.accessToken === null) {
    if (pending.silent) return { ok: false, reason: 'reconnect_required', returnTo: pending.returnTo };
    const reason = params.error === 'access_denied' ? 'consent_denied' : 'reconnect_required';
    return { ok: false, reason, returnTo: pending.returnTo };
  }
  safeSession()?.removeItem(SILENT_TRIED_KEY);
  const ttlMs = (params.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS) * 1000;
  await creds.write(pending.provider, { accessToken: params.accessToken, expiresAt: now() + ttlMs });
  return { ok: true, returnTo: pending.returnTo };
}
