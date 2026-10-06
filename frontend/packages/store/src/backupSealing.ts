/**
 * Backup encryption for the app: seal a new `.almamesh` file, and open any
 * backup this app has ever written. All cryptography is behind the seam in
 * `passphraseSeal.ts`; this module adds the Worker hop and turns every failure
 * into a typed error the UI can word honestly.
 *
 * - New files are age v1 files (scrypt). Seal and open run in a fresh module
 *   Worker per operation, because scrypt blocks its thread and holds 128 MiB.
 * - Old files (portable v3 binary, v2 and v1 JSON) open through the library's
 *   read-only legacy reader. `isSealedBackup` decides which path a file takes.
 */
import type { BackupStores } from '@almamesh/shared-types';
import { BackupError } from './backup';
import {
  checkBackupPassphrase,
  handleSealRequest,
  isSealedBackup,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  openLegacyBackup,
  type LegacyBackupFormat,
  type LegacyOpenOutcome,
  type OpenOutcome,
  type SealFailure,
  type SealOutcome,
  type SealReply,
  type SealRequest,
} from './passphraseSeal';
import { filterPortableSettings, type PortableSettings } from './portableSettings';

export type BackupCryptoErrorCode =
  | 'bad_passphrase'
  | 'unsupported'
  | 'too_costly'
  | 'out_of_memory'
  | 'unavailable';

/** Typed failure for backup encryption. Only `bad_passphrase` judges the password. */
export class BackupCryptoError extends Error {
  constructor(
    public readonly code: BackupCryptoErrorCode,
    message: string,
    /** For `too_costly`: the file's scrypt work factor (log2 N). */
    public readonly workFactor?: number,
  ) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

/** Runs one seal/open request somewhere: a Worker in browsers, this thread in Node. */
export type SealRunner = (request: SealRequest) => Promise<SealReply>;

/** A backup, decrypted and parsed just far enough for the importer to take over. */
export type OpenedBackup =
  | {
      readonly kind: 'database';
      readonly format: 'age' | Exclude<LegacyBackupFormat, 'almamesh-backup-v1'>;
      /** The canonical SQLite file, exactly as exported. */
      readonly database: Uint8Array;
      /** Only v2 bundles carried settings outside SQLite. */
      readonly settings: PortableSettings;
    }
  | { readonly kind: 'stores'; readonly format: 'almamesh-backup-v1'; readonly stores: BackupStores };

function runInWorker(request: SealRequest): Promise<SealReply> {
  const worker = new Worker(new URL('./passphraseSeal.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<SealReply>((resolve) => {
    worker.addEventListener('message', (event: MessageEvent<SealReply>) => resolve(event.data));
    // A worker that cannot load (offline chunk, CSP) never judged the password.
    worker.addEventListener('error', () => resolve({ ok: false, reason: 'unavailable' }));
    worker.postMessage(request, [request.bytes.buffer]);
  }).finally(() => worker.terminate());
}

/** A fresh Worker per request where Workers exist; the current thread otherwise. */
export function defaultSealRunner(): SealRunner {
  return typeof Worker === 'function' ? runInWorker : handleSealRequest;
}

const SEAL_RETRY = 'The backup could not be encrypted. Try again.';
const SEAL_ERRORS: Record<SealFailure, readonly [BackupCryptoErrorCode, string]> = {
  empty_passphrase: ['bad_passphrase', 'A passphrase is required to export.'],
  invalid_work_factor: ['unavailable', SEAL_RETRY],
  out_of_memory: [
    'out_of_memory',
    'This device ran out of memory encrypting the backup. Close other tabs or apps and try again.',
  ],
  unavailable: ['unavailable', SEAL_RETRY],
};

/** Seal exact database bytes into a new age `.almamesh` file. */
export async function sealBackup(
  database: Uint8Array,
  passphrase: string,
  runner: SealRunner = defaultSealRunner(),
): Promise<Uint8Array> {
  if (checkBackupPassphrase(passphrase, passphrase) !== null) {
    throw new BackupCryptoError(
      'bad_passphrase',
      `A passphrase of at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters is required to export.`,
    );
  }
  const reply = (await runner({ op: 'seal', bytes: Uint8Array.from(database), passphrase })) as SealOutcome;
  if (reply.ok) return reply.bytes;
  const [code, message] = SEAL_ERRORS[reply.reason];
  throw new BackupCryptoError(code, message);
}

function openError(failure: Exclude<OpenOutcome | LegacyOpenOutcome, { ok: true }>): Error {
  switch (failure.reason) {
    case 'wrong_passphrase_or_tampered':
      return new BackupCryptoError(
        'bad_passphrase',
        'Could not unlock the backup — the password is wrong, or the file was changed or damaged.',
      );
    case 'out_of_memory':
      return new BackupCryptoError(
        'out_of_memory',
        'This device ran out of memory unlocking the backup. Close other tabs or apps and try again.',
      );
    case 'unavailable':
      return new BackupCryptoError('unavailable', 'The backup could not be unlocked just now. Try again.');
    case 'unsupported':
      return new BackupCryptoError('unsupported', 'This backup uses encryption settings AlmaMesh does not open.');
    case 'too_costly':
      return new BackupCryptoError(
        'too_costly',
        'This backup needs more memory to unlock than AlmaMesh allows.',
        'workFactor' in failure ? failure.workFactor : undefined,
      );
    default:
      return new BackupError('bad_format', 'This backup file is damaged or incomplete.');
  }
}

const PORTABLE_V3_MAGIC = new TextEncoder().encode('ALMAMESH');

/** The 8-byte magic every pre-age `.almamesh` file starts with. Not authenticated. */
function hasPortableV3Magic(bytes: Uint8Array): boolean {
  return PORTABLE_V3_MAGIC.every((value, index) => bytes[index] === value);
}

function asBytes(content: Uint8Array | string): Uint8Array | undefined {
  if (content instanceof Uint8Array) return content;
  const encoded = new TextEncoder().encode(content);
  return isSealedBackup(encoded) ? encoded : undefined;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BackupError('corrupt', 'The backup unlocked but its contents are not readable.');
  }
}

function fromBase64(text: string): Uint8Array {
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    throw new BackupError('corrupt', 'The backup unlocked but its contents are not readable.');
  }
}

function legacyPayload(bytes: Uint8Array, format: LegacyBackupFormat): OpenedBackup {
  if (format === 'almamesh-portable-v3') return { kind: 'database', format, database: bytes, settings: {} };
  const record = parseJson(bytes) as { database?: unknown; settings?: unknown } | null;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new BackupError('corrupt', 'The backup unlocked but its contents are not readable.');
  }
  if (format === 'almamesh-backup-v1') return { kind: 'stores', format, stores: record as BackupStores };
  if (typeof record.database !== 'string') {
    throw new BackupError('corrupt', 'The backup unlocked but its contents are not readable.');
  }
  return {
    kind: 'database',
    format,
    database: fromBase64(record.database),
    settings: filterPortableSettings(record.settings),
  };
}

/**
 * Open an encrypted backup of any format this app has written. A missing
 * passphrase is `bad_passphrase` (so the UI prompts); nothing is opened.
 */
export async function openBackup(
  content: Uint8Array | string,
  passphrase: string | undefined,
  runner: SealRunner = defaultSealRunner(),
): Promise<OpenedBackup> {
  const sealed = asBytes(content);
  if (content instanceof Uint8Array && !isSealedBackup(content) && !hasPortableV3Magic(content)) {
    throw new BackupError('bad_format', 'This file is not an AlmaMesh backup.');
  }
  if (!passphrase) {
    throw new BackupCryptoError('bad_passphrase', 'This backup is encrypted — enter its passphrase to open it.');
  }
  if (sealed !== undefined && isSealedBackup(sealed)) {
    const reply = (await runner({ op: 'open', bytes: Uint8Array.from(sealed), passphrase })) as OpenOutcome;
    if (!reply.ok) throw openError(reply);
    return { kind: 'database', format: 'age', database: reply.bytes, settings: {} };
  }
  const legacy = await openLegacyBackup(content, passphrase);
  if (!legacy.ok) throw openError(legacy);
  return legacyPayload(legacy.bytes, legacy.format);
}
