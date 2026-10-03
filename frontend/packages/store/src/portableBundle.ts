/**
 * Portable backup transport. V3 is a compact binary envelope whose encrypted
 * plaintext is exactly the canonical SQLite file. V2 JSON remains readable.
 */
import { BackupError } from './backup';
import { b64ToBytes, BackupCryptoError } from './backupCrypto';
import { filterPortableSettings, type PortableSettings } from './portableSettings';

export const BUNDLE_FORMAT_VERSION = 3;
export const BUNDLE_PBKDF2_ITERATIONS = 600_000;
export const MIN_BUNDLE_PASSPHRASE_LENGTH = 8;

const MAGIC = new TextEncoder().encode('ALMAMESH');
const KDF_PBKDF2_SHA256 = 1;
const CIPHER_AES_GCM_256 = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HEADER_BYTES = 64;
/** A generous ceiling for local-first state, and a hard cap against hostile files. */
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = HEADER_BYTES + MAX_DATABASE_BYTES + GCM_TAG_BYTES;
const MAX_LEGACY_CIPHERTEXT_CHARACTERS = 128 * 1024 * 1024;

export interface PortableBundlePayload {
  readonly database: Uint8Array;
  /** Populated only by legacy v2 bundles; v3 settings live in SQLite. */
  readonly settings: PortableSettings;
}

interface LegacyBundleHeader {
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

interface LegacySealedBundle extends LegacyBundleHeader {
  readonly ciphertext: string;
}

function hasMagic(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((value, index) => bytes[index] === value);
}

/** Recognize a v3 binary or legacy v2 JSON bundle without authenticating it. */
export function isPortableBundle(candidate: unknown): boolean {
  if (candidate instanceof Uint8Array) return hasMagic(candidate);
  return candidate !== null && typeof candidate === 'object' &&
    (candidate as { format?: unknown }).format === 'almamesh-backup' &&
    (candidate as { formatVersion?: unknown }).formatVersion === 2;
}

/** Seal exact SQLite bytes into a v3 binary bundle. */
export async function sealPortableBundle(
  database: Uint8Array,
  passphrase: string,
  meta: { readonly now: string },
): Promise<Uint8Array> {
  assertPassphrase(passphrase, 'export');
  if (database.byteLength > MAX_DATABASE_BYTES) {
    throw new BackupError('bad_format', 'The AlmaMesh database is too large to export safely.');
  }
  const subtle = requireSubtle();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = buildHeader(database.byteLength + GCM_TAG_BYTES, database.byteLength, salt, iv, meta.now);
  const key = await deriveKey(passphrase, salt);
  const plaintext = Uint8Array.from(database);
  const cipher = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: header }, key, plaintext,
  ));
  const bundle = new Uint8Array(header.byteLength + cipher.byteLength);
  bundle.set(header);
  bundle.set(cipher, header.byteLength);
  return bundle;
}

/** Open a binary v3 bundle or a legacy JSON v2 bundle. */
export async function openPortableBundle(
  candidate: unknown,
  passphrase: string,
): Promise<PortableBundlePayload> {
  if (candidate instanceof Uint8Array) return openBinaryBundle(candidate, passphrase);
  return openLegacyBundle(candidate, passphrase);
}

function buildHeader(
  ciphertextLength: number,
  plaintextLength: number,
  salt: Uint8Array,
  iv: Uint8Array,
  now: string,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[8] = BUNDLE_FORMAT_VERSION;
  header[9] = KDF_PBKDF2_SHA256;
  header[10] = CIPHER_AES_GCM_256;
  header[11] = salt.byteLength;
  header[12] = iv.byteLength;
  const view = new DataView(header.buffer);
  view.setUint32(16, BUNDLE_PBKDF2_ITERATIONS, false);
  view.setBigUint64(20, BigInt(parseTimestamp(now)), false);
  view.setUint32(28, plaintextLength, false);
  view.setUint32(32, ciphertextLength, false);
  header.set(salt, 36);
  header.set(iv, 52);
  return header;
}

function parseTimestamp(now: string): number {
  const timestamp = Date.parse(now);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0;
}

async function openBinaryBundle(bytes: Uint8Array, passphrase: string): Promise<PortableBundlePayload> {
  if (bytes.byteLength > MAX_BUNDLE_BYTES || bytes.byteLength < HEADER_BYTES + GCM_TAG_BYTES || !hasMagic(bytes)) {
    throw new BackupError('bad_format', 'This backup file is damaged or incomplete.');
  }
  const header = bytes.slice(0, HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const version = header[8];
  if (version > BUNDLE_FORMAT_VERSION) {
    throw new BackupError('too_new', 'This backup was made by a newer version of AlmaMesh.');
  }
  const iterations = view.getUint32(16, false);
  const plaintextLength = view.getUint32(28, false);
  const ciphertextLength = view.getUint32(32, false);
  const headerValid = version === BUNDLE_FORMAT_VERSION &&
    header[9] === KDF_PBKDF2_SHA256 && header[10] === CIPHER_AES_GCM_256 &&
    header[11] === SALT_BYTES && header[12] === IV_BYTES &&
    header.slice(13, 16).every((value) => value === 0) &&
    iterations === BUNDLE_PBKDF2_ITERATIONS && plaintextLength <= MAX_DATABASE_BYTES &&
    ciphertextLength === plaintextLength + GCM_TAG_BYTES &&
    ciphertextLength <= MAX_DATABASE_BYTES + GCM_TAG_BYTES &&
    bytes.byteLength === HEADER_BYTES + ciphertextLength;
  if (!headerValid) {
    throw new BackupError('bad_format', 'This backup has an unsupported or damaged header.');
  }
  assertPassphrase(passphrase, 'open');
  const salt = header.slice(36, 36 + SALT_BYTES);
  const iv = header.slice(52, 52 + IV_BYTES);
  try {
    const key = await deriveKey(passphrase, salt);
    const plaintext = await requireSubtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: header }, key, bytes.slice(HEADER_BYTES),
    );
    const database = new Uint8Array(plaintext);
    if (database.byteLength !== plaintextLength) throw new Error('Authenticated length mismatch.');
    return { database, settings: {} };
  } catch (error) {
    if (error instanceof BackupCryptoError) throw error;
    throw authenticationError();
  }
}

async function openLegacyBundle(candidate: unknown, passphrase: string): Promise<PortableBundlePayload> {
  const sealed = parseLegacyBundle(candidate);
  assertLegacyPassphrase(passphrase);
  let decoded: unknown;
  try {
    const { ciphertext, ...header } = sealed;
    const salt = b64ToBytes(sealed.kdf.salt);
    const iv = b64ToBytes(sealed.iv);
    if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES) {
      throw new BackupError('bad_format', 'This backup has an unsupported encryption header.');
    }
    const key = await deriveKey(passphrase, salt);
    const plaintext = await requireSubtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: legacyHeaderBytes(header) }, key, b64ToBytes(ciphertext),
    );
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error instanceof BackupError || error instanceof BackupCryptoError) throw error;
    throw authenticationError();
  }
  const record = decoded as { database?: unknown; settings?: unknown } | null;
  if (record === null || typeof record !== 'object' || typeof record.database !== 'string') {
    throw new BackupError('corrupt', 'The backup decrypted but its contents are not readable.');
  }
  const database = b64ToBytes(record.database);
  if (database.byteLength > MAX_DATABASE_BYTES) {
    throw new BackupError('bad_format', 'The backup database is too large to import safely.');
  }
  return { database, settings: filterPortableSettings(record.settings) };
}

function parseLegacyBundle(candidate: unknown): LegacySealedBundle {
  const c = candidate as Partial<LegacySealedBundle> | null;
  const kdf = c?.kdf;
  const valid = isPortableBundle(candidate) && c?.encryption === 'aes-gcm' &&
    typeof c.app?.version === 'string' && c.app.version.length <= 256 &&
    typeof c.exportedAt === 'string' && c.exportedAt.length <= 64 &&
    typeof c.iv === 'string' && c.iv.length <= 64 &&
    typeof c.ciphertext === 'string' && c.ciphertext.length <= MAX_LEGACY_CIPHERTEXT_CHARACTERS &&
    kdf?.name === 'PBKDF2' && kdf.hash === 'SHA-256' &&
    kdf.iterations === BUNDLE_PBKDF2_ITERATIONS &&
    typeof kdf.salt === 'string' && kdf.salt.length <= 64;
  if (!valid) throw new BackupError('bad_format', 'This backup file is damaged or incomplete.');
  return c as LegacySealedBundle;
}

function legacyHeaderBytes(header: LegacyBundleHeader): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([
    header.format, header.formatVersion, header.app.version, header.exportedAt,
    header.encryption, header.kdf.name, header.kdf.hash, header.kdf.iterations,
    header.kdf.salt, header.iv,
  ]));
}

function assertPassphrase(passphrase: string, operation: 'export' | 'open'): void {
  if (passphrase.length < MIN_BUNDLE_PASSPHRASE_LENGTH) {
    throw new BackupCryptoError(
      'bad_passphrase',
      `A passphrase of at least ${MIN_BUNDLE_PASSPHRASE_LENGTH} characters is required to ${operation} this backup.`,
    );
  }
}

/** V2 predated the minimum-length policy; any non-empty historical password must remain usable. */
function assertLegacyPassphrase(passphrase: string): void {
  if (passphrase.length === 0) {
    throw new BackupCryptoError(
      'bad_passphrase',
      'This backup is encrypted — enter its passphrase to open it.',
    );
  }
}

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new BackupCryptoError('unsupported', 'Web Crypto is unavailable in this environment.');
  return subtle;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const subtle = requireSubtle();
  const baseKey = await subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: BUNDLE_PBKDF2_ITERATIONS }, baseKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function authenticationError(): BackupCryptoError {
  return new BackupCryptoError(
    'bad_passphrase',
    'Could not unlock the backup — the password is wrong, or the file was changed or damaged.',
  );
}
