/**
 * The BackupDrive seam. Adapters move opaque sealed bytes only; encryption
 * stays above this line. See docs/superpowers/specs/2026-10-10-cloud-drive-backup-design.md.
 */

export type DriveProviderId = 'google-drive' | 'dropbox' | 'onedrive';

declare const sealedBrand: unique symbol;
declare const nameBrand: unique symbol;

/** Bytes structured as a binary age v1 file (shape only, see sealedBackupOf) and not a SQLite database. */
export interface SealedBackup {
  readonly bytes: Uint8Array;
  readonly [sealedBrand]: true;
}
/** A name built by backupName.ts and re-checked by its parser. */
export interface BackupFileName {
  readonly value: string;
  readonly [nameBrand]: true;
}

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'samsung' | 'other';
export type OsFamily = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'chromeos' | 'other';

export interface BackupNameMeta {
  readonly createdAt: Date;
  readonly browser: BrowserFamily;
  readonly os: OsFamily;
  readonly deviceCode: string;
}

export interface DriveBackupEntry {
  readonly id: string;
  readonly name: BackupFileName;
  readonly meta: BackupNameMeta;
  readonly sizeBytes: number;
}

export interface BackupDrive {
  readonly provider: DriveProviderId;
  /** Starts consent. May navigate the tab away. */
  connect(returnTo: string): Promise<'connected' | 'redirecting'>;
  isConnected(): Promise<boolean>;
  list(): Promise<readonly DriveBackupEntry[]>;
  upload(name: BackupFileName, sealed: SealedBackup): Promise<DriveBackupEntry>;
  download(id: string): Promise<Uint8Array>;
  /** Moves to the provider's trash / recycle bin. */
  remove(id: string): Promise<void>;
  disconnect(): Promise<void>;
}

export type DriveErrorKind =
  | 'not_connected'
  | 'consent_denied'
  | 'token_expired'
  | 'offline'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'not_found'
  | 'not_sealed'
  | 'bad_name'
  | 'provider_error';

export class DriveError extends Error {
  public override readonly name = 'DriveError';
  public constructor(
    public readonly kind: DriveErrorKind,
    public readonly status?: number,
  ) {
    super(`drive:${kind}${status === undefined ? '' : `:${status}`}`);
  }
}

const AGE_BINARY_PREFIX = 'age-encryption.org/v1\n';
const SQLITE_MAGIC = 'SQLite format 3\0';
/** `-> ` then one or more non-empty space-separated arguments (age v1 stanza line). */
const STANZA_LINE = /^-> [\x21-\x7e]+( [\x21-\x7e]+)*$/;
/** Unpadded base64, at most 64 columns. A line under 64 columns ends the stanza body. */
const STANZA_BODY_LINE = /^[A-Za-z0-9+/]{0,64}$/;
const STANZA_BODY_FULL_WIDTH = 64;
/** `--- ` then the 32-byte header MAC as 43 chars of unpadded base64. */
const MAC_LINE = /^--- [A-Za-z0-9+/]{43}$/;
/** 16-byte payload nonce plus at least one 16-byte Poly1305 tag (an empty plaintext). */
const MIN_AGE_PAYLOAD_BYTES = 32;
const NEWLINE = 0x0a;
/**
 * Longest header line read, in bytes (excluding '\n'). Large enough for
 * post-quantum stanza arguments; checked before decoding, so a giant line is
 * refused as not_sealed instead of allocating (or overflowing) a huge string.
 */
export const MAX_AGE_HEADER_LINE_BYTES = 65_536;
/** Single-byte decode: every byte maps to one char, so offsets stay byte offsets. */
const HEADER_TEXT = new TextDecoder('latin1');

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

interface HeaderLine {
  readonly text: string;
  readonly next: number;
}

/**
 * The '\n'-terminated line at `start` (one char per byte), or null. The line
 * regexes above admit printable ASCII only, so any other byte fails them.
 */
function lineAt(bytes: Uint8Array, start: number): HeaderLine | null {
  const end = bytes.indexOf(NEWLINE, start);
  if (end < 0 || end - start > MAX_AGE_HEADER_LINE_BYTES) return null;
  return { text: HEADER_TEXT.decode(bytes.subarray(start, end)), next: end + 1 };
}

/** Offset after a stanza body that starts at `at`, or null if the body is malformed. */
function stanzaBodyEnd(bytes: Uint8Array, at: number): number | null {
  for (let cursor = at; ; ) {
    const line = lineAt(bytes, cursor);
    if (line === null || !STANZA_BODY_LINE.test(line.text) || line.text.length % 4 === 1) return null;
    if (line.text.length < STANZA_BODY_FULL_WIDTH) return line.next;
    cursor = line.next;
  }
}

/** Offset of the payload (just after the MAC line), or null if the age v1 header is malformed. */
function ageHeaderEnd(bytes: Uint8Array): number | null {
  let stanzas = 0;
  for (let cursor = AGE_BINARY_PREFIX.length; ; stanzas += 1) {
    const line = lineAt(bytes, cursor);
    if (line === null) return null;
    if (MAC_LINE.test(line.text)) return stanzas > 0 ? line.next : null;
    const bodyEnd = STANZA_LINE.test(line.text) ? stanzaBodyEnd(bytes, line.next) : null;
    if (bodyEnd === null) return null;
    cursor = bodyEnd;
  }
}

/**
 * Structural check of a binary age v1 file (https://age-encryption.org/v1):
 * one or more `-> ` stanzas, a `--- <43-char MAC>` line, then a payload of at
 * least MIN_AGE_PAYLOAD_BYTES. Uploads refuse anything not structured as a
 * binary age v1 file. This is a shape check only: it cannot verify the MAC
 * (that needs the key), so it does not prove the payload is ciphertext.
 * The age-encryption package keeps its header parser private (its package.json
 * exports only `.`, and `parseHeader` is not re-exported), so this is local.
 */
function hasAgeV1Structure(bytes: Uint8Array): boolean {
  const payloadStart = ageHeaderEnd(bytes);
  return payloadStart !== null && bytes.length - payloadStart >= MIN_AGE_PAYLOAD_BYTES;
}

/** The only way to make a SealedBackup. Throws DriveError('not_sealed'). */
export function sealedBackupOf(bytes: Uint8Array): SealedBackup {
  // The SQLite check is intentional redundancy: the age-prefix check already
  // refuses SQLite bytes, so deleting it is an equivalent (surviving) mutant.
  // It stays so the "never upload the raw database" rule reads on its own.
  if (startsWith(bytes, SQLITE_MAGIC) || !startsWith(bytes, AGE_BINARY_PREFIX)) {
    throw new DriveError('not_sealed');
  }
  if (!hasAgeV1Structure(bytes)) throw new DriveError('not_sealed');
  return { bytes } as SealedBackup;
}
