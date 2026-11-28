/**
 * CSRF-protected OAuth redirect state (`sessionStorage`, one-shot, 10 min TTL)
 * and immediate URL fragment/query scrubbing after callback arrival.
 */
import type { DriveProviderId } from './backupDrive';

export const PENDING_SIGN_IN_KEY = 'almamesh-oauth-pending';
export const PENDING_SIGN_IN_TTL_MS = 10 * 60_000;

export interface PendingSignIn {
  readonly state: string;
  readonly provider: DriveProviderId;
  readonly returnTo: string;
  readonly silent: boolean;
  readonly createdAt: number;
}

export interface OAuthCallbackParams {
  readonly state: string | null;
  readonly accessToken: string | null;
  readonly expiresInSeconds: number | null;
  readonly error: string | null;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function sanitizeReturnTo(returnTo: string): string {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) return '/';
  try {
    const parsed = new URL(returnTo, 'https://almamesh.local');
    if (parsed.origin !== 'https://almamesh.local') return '/';
    if (parsed.pathname.startsWith('/oauth/callback')) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function mintState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function beginSignIn(
  params: { provider: DriveProviderId; returnTo: string; silent?: boolean },
  now: number = Date.now(),
): string {
  const storage = safeSessionStorage();
  if (storage === null) throw new Error('sessionStorage is required for OAuth redirect state.');
  const state = mintState();
  const record: PendingSignIn = {
    state,
    provider: params.provider,
    returnTo: sanitizeReturnTo(params.returnTo),
    silent: Boolean(params.silent),
    createdAt: now,
  };
  storage.setItem(PENDING_SIGN_IN_KEY, JSON.stringify(record));
  return state;
}

function isValidPending(value: unknown): value is PendingSignIn {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.state === 'string' &&
    candidate.state.length >= 16 &&
    (candidate.provider === 'google-drive' || candidate.provider === 'dropbox' || candidate.provider === 'onedrive') &&
    typeof candidate.returnTo === 'string' &&
    typeof candidate.silent === 'boolean' &&
    typeof candidate.createdAt === 'number'
  );
}

export function takePendingSignIn(expectedState: string | null, now: number = Date.now()): PendingSignIn | null {
  const storage = safeSessionStorage();
  if (storage === null) return null;
  const raw = storage.getItem(PENDING_SIGN_IN_KEY);
  storage.removeItem(PENDING_SIGN_IN_KEY);
  if (raw === null || expectedState === null || expectedState.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPending(parsed)) return null;
    const age = now - parsed.createdAt;
    if (age < 0 || age > PENDING_SIGN_IN_TTL_MS || parsed.state !== expectedState) return null;
    return { ...parsed, returnTo: sanitizeReturnTo(parsed.returnTo) };
  } catch {
    return null;
  }
}

export function readCallback(loc: Pick<Location, 'hash' | 'search'>): OAuthCallbackParams {
  const hashParams = new URLSearchParams(loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash);
  const queryParams = new URLSearchParams(loc.search.startsWith('?') ? loc.search.slice(1) : loc.search);
  const rawExpires = hashParams.get('expires_in');
  const parsedExpires = rawExpires !== null && /^\d+$/.test(rawExpires) ? Number(rawExpires) : null;
  return {
    state: hashParams.get('state') ?? queryParams.get('state'),
    // Never accept implicit bearer tokens from the query string (Referer/server-log leak).
    accessToken: hashParams.get('access_token'),
    expiresInSeconds: parsedExpires !== null && parsedExpires > 0 ? parsedExpires : null,
    error: hashParams.get('error') ?? queryParams.get('error'),
  };
}

export function scrubCallbackUrl(win: Pick<Window, 'location' | 'history'> = window): void {
  win.history.replaceState(null, '', win.location.pathname);
}
