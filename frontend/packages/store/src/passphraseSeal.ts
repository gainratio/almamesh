/**
 * The passphrase seam: the ONLY module that imports `@gainratio/browser/seal`.
 *
 * New backups are standard age v1 files (scrypt passphrase recipient), so a
 * user can also open one with `age -d`. Every file an older AlmaMesh wrote
 * (portable v3 binary, v2 and v1 JSON) is read-only and opens through the
 * library's legacy PBKDF2 reader. Everything else in the app calls this file,
 * so upgrading or swapping the library touches one module.
 *
 * scrypt is synchronous and holds 128 MiB: `sealInThread`/`openSealedInThread`
 * are meant to run in `passphraseSeal.worker.ts` (see `backupSealing.ts`).
 * The age library itself is loaded lazily on the first seal or open, so
 * importing this file for the cheap checks costs nothing at boot.
 */
import {
  checkNewPassphrase,
  DEFAULT_MIN_PASSPHRASE_LENGTH,
  isSealed,
  openLegacyPbkdf2AesGcm,
  openWithPassphrase,
  sealWithPassphrase,
} from '@gainratio/browser/seal';

/** Shortest passphrase a NEW backup accepts, in characters (code points after NFC). */
export const MIN_BACKUP_PASSPHRASE_LENGTH: number = DEFAULT_MIN_PASSPHRASE_LENGTH;

/** Why a passphrase the user is choosing was refused. */
export type BackupPassphraseProblem = 'empty' | 'too_short' | 'mismatch';

/** Why sealing failed. Nothing was written. */
export type SealFailure = 'empty_passphrase' | 'invalid_work_factor' | 'out_of_memory' | 'unavailable';

/** Why opening failed. Only `wrong_passphrase_or_tampered` judges the passphrase. */
type OpenFailure =
  | 'wrong_passphrase_or_tampered'
  | 'not_sealed'
  | 'malformed'
  | 'unsupported'
  | 'too_large'
  | 'out_of_memory'
  | 'unavailable';

export type SealOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: SealFailure };

export type OpenOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: OpenFailure }
  | { readonly ok: false; readonly reason: 'too_costly'; readonly workFactor: number };

/** The old formats this app still reads (never writes). */
export type LegacyBackupFormat = 'almamesh-portable-v3' | 'almamesh-backup-v2' | 'almamesh-backup-v1';

export type LegacyOpenOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly format: LegacyBackupFormat }
  | { readonly ok: false; readonly reason: OpenFailure | 'too_costly' };

/** Check a NEW passphrase and its confirmation: empty, then too short, then mismatch. */
export function checkBackupPassphrase(
  passphrase: string,
  confirmation: string,
): BackupPassphraseProblem | null {
  const check = checkNewPassphrase(passphrase, confirmation);
  return check.ok ? null : check.reason;
}

/** True for an age file (binary or armored). Does not authenticate. */
export function isSealedBackup(bytes: Uint8Array): boolean {
  return isSealed(bytes);
}

/** Seal on the CURRENT thread. Call from the worker; scrypt blocks. */
export function sealInThread(plaintext: Uint8Array, passphrase: string): Promise<SealOutcome> {
  return sealWithPassphrase(plaintext, passphrase);
}

/** Open an age file on the CURRENT thread. Call from the worker; scrypt blocks. */
export function openSealedInThread(sealed: Uint8Array, passphrase: string): Promise<OpenOutcome> {
  return openWithPassphrase(sealed, passphrase);
}

/** One seal or open, as posted to `passphraseSeal.worker.ts`. */
export interface SealRequest {
  readonly op: 'seal' | 'open';
  readonly bytes: Uint8Array;
  readonly passphrase: string;
}

/** What the worker posts back. Never a thrown error: every failure is a reason. */
export type SealReply = SealOutcome | OpenOutcome;

/** Run one request on the current thread (the worker's body, and the no-Worker fallback). */
export function handleSealRequest(request: SealRequest): Promise<SealReply> {
  return request.op === 'seal'
    ? sealInThread(request.bytes, request.passphrase)
    : openSealedInThread(request.bytes, request.passphrase);
}

/**
 * Open a backup an older AlmaMesh wrote. PBKDF2 runs in Web Crypto (async, off
 * the main thread's critical path), so this needs no worker.
 */
export async function openLegacyBackup(
  file: Uint8Array | string,
  passphrase: string,
): Promise<LegacyOpenOutcome> {
  const result = await openLegacyPbkdf2AesGcm(file, passphrase);
  if (!result.ok) return { ok: false, reason: result.reason };
  if (result.format === 'amlfilter-install-key-v1') return { ok: false, reason: 'not_sealed' };
  return { ok: true, bytes: result.bytes, format: result.format };
}
