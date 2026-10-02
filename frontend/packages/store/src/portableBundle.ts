/**
 * Backup format v2: one passphrase-encrypted file that carries EVERYTHING a
 * user needs on another browser — the canonical SQLite database plus device
 * settings, including the AI provider API key.
 *
 * Crypto is the browser's own Web Crypto (no hand-rolled primitives):
 * PBKDF2-SHA256 (600,000 iterations, OWASP 2023 guidance) derives an AES-GCM-256
 * key from the passphrase. A random 16-byte salt and 12-byte IV are stored in
 * the readable header. The header is bound to the ciphertext as AES-GCM
 * additional data, so editing any header field (or a ciphertext byte) fails
 * authentication. Nothing in the file is plaintext except the header.
 */
import { BackupError } from './backup';
import { b64ToBytes, BackupCryptoError, bytesToB64 } from './backupCrypto';
import { filterPortableSettings, type PortableSettings } from './portableSettings';

export const BUNDLE_FORMAT_VERSION = 2;
export const BUNDLE_PBKDF2_ITERATIONS = 600_000;
/** Upper bound so a hostile header cannot pin the CPU for minutes. */
const MAX_PBKDF2_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** What a bundle carries once decrypted. */
export interface PortableBundlePayload {
  readonly database: Uint8Array;
  readonly settings: PortableSettings;
}

interface BundleHeader {
  readonly format: 'almamesh-backup';
  readonly formatVersion: 2;
  readonly app: { readonly version: string };
  readonly exportedAt: string;
  readonly encryption: 'aes-gcm';
  readonly kdf: {
    readonly name: 'PBKDF2';
    readonly hash: 'SHA-256';
    readonly iterations: number;
    readonly salt: string;
  };
  readonly iv: string;
}

interface SealedBundle extends BundleHeader {
  readonly ciphertext: string;
}

/** True for a parsed object that claims to be a v2 bundle (not yet verified). */
export function isPortableBundle(candidate: unknown): boolean {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    (candidate as { format?: unknown }).format === 'almamesh-backup' &&
    (candidate as { formatVersion?: unknown }).formatVersion === BUNDLE_FORMAT_VERSION
  );
}

/** Seal the payload under a passphrase and return the file's JSON text. */
export async function sealPortableBundle(
  payload: PortableBundlePayload,
  passphrase: string,
  meta: { readonly appVersion: string; readonly now: string },
): Promise<string> {
  if (!passphrase) {
    throw new BackupCryptoError('bad_passphrase', 'A passphrase is required to export.');
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header: BundleHeader = {
    format: 'almamesh-backup',
    formatVersion: BUNDLE_FORMAT_VERSION,
    app: { version: meta.appVersion },
    exportedAt: meta.now,
    encryption: 'aes-gcm',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: BUNDLE_PBKDF2_ITERATIONS, salt: bytesToB64(salt) },
    iv: bytesToB64(iv),
  };
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ database: bytesToB64(payload.database), settings: payload.settings }),
  );
  const key = await deriveKey(passphrase, salt, BUNDLE_PBKDF2_ITERATIONS);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: headerBytes(header) },
    key,
    plaintext,
  );
  const sealed: SealedBundle = { ...header, ciphertext: bytesToB64(new Uint8Array(cipher)) };
  return JSON.stringify(sealed, null, 2);
}

/**
 * Verify and decrypt a parsed v2 bundle. Malformed header ⇒ BackupError
 * `bad_format`; wrong passphrase or any tampering ⇒ BackupCryptoError
 * `bad_passphrase` (AES-GCM cannot tell the two apart, by design).
 */
export async function openPortableBundle(
  candidate: unknown,
  passphrase: string,
): Promise<PortableBundlePayload> {
  const sealed = parseSealedBundle(candidate);
  if (!passphrase) {
    throw new BackupCryptoError('bad_passphrase', 'A passphrase is required to open this backup.');
  }
  let decoded: unknown;
  try {
    const { ciphertext, ...header } = sealed;
    const key = await deriveKey(passphrase, b64ToBytes(sealed.kdf.salt), sealed.kdf.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(sealed.iv), additionalData: headerBytes(header) },
      key,
      b64ToBytes(ciphertext),
    );
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error instanceof BackupCryptoError) throw error; // e.g. no Web Crypto at all
    throw new BackupCryptoError(
      'bad_passphrase',
      'Could not unlock the backup — the password is wrong, or the file was changed or damaged.',
    );
  }
  return parsePayload(decoded);
}

function parsePayload(decoded: unknown): PortableBundlePayload {
  const record = decoded as { database?: unknown; settings?: unknown } | null;
  if (record === null || typeof record !== 'object' || typeof record.database !== 'string') {
    throw new BackupError('corrupt', 'The backup decrypted but its contents are not readable.');
  }
  return { database: b64ToBytes(record.database), settings: filterPortableSettings(record.settings) };
}

function parseSealedBundle(candidate: unknown): SealedBundle {
  const c = candidate as Partial<SealedBundle> | null;
  const kdf = c?.kdf;
  const valid =
    isPortableBundle(candidate) &&
    c?.encryption === 'aes-gcm' &&
    typeof c.app?.version === 'string' &&
    typeof c.exportedAt === 'string' &&
    typeof c.iv === 'string' &&
    typeof c.ciphertext === 'string' &&
    kdf?.name === 'PBKDF2' &&
    kdf.hash === 'SHA-256' &&
    typeof kdf.salt === 'string';
  if (!valid) {
    throw new BackupError('bad_format', 'This backup file is damaged or incomplete.');
  }
  const iterations = kdf.iterations;
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < BUNDLE_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new BackupError('bad_format', 'This backup uses an unsupported key-derivation setting.');
  }
  return c as SealedBundle;
}

/** Canonical bytes of the header fields, in fixed order, used as GCM additional data. */
function headerBytes(header: BundleHeader): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      header.format,
      header.formatVersion,
      header.app.version,
      header.exportedAt,
      header.encryption,
      header.kdf.name,
      header.kdf.hash,
      header.kdf.iterations,
      header.kdf.salt,
      header.iv,
    ]),
  );
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new BackupCryptoError('unsupported', 'Web Crypto is unavailable in this environment.');
  }
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
