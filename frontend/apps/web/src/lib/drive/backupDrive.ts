/**
 * The BackupDrive seam. Adapters move opaque sealed bytes only; encryption
 * stays above this line. See docs/superpowers/specs/2026-10-10-cloud-drive-backup-design.md.
 */

export type DriveProviderId = 'google-drive' | 'dropbox' | 'onedrive';

declare const sealedBrand: unique symbol;
declare const nameBrand: unique symbol;

/** Bytes proven to be a binary age file and not a SQLite database. */
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

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** The only way to make a SealedBackup. Throws DriveError('not_sealed'). */
export function sealedBackupOf(bytes: Uint8Array): SealedBackup {
  // The SQLite check is intentional redundancy: the age-prefix check already
  // refuses SQLite bytes, so deleting it is an equivalent (surviving) mutant.
  // It stays so the "never upload the raw database" rule reads on its own.
  if (startsWith(bytes, SQLITE_MAGIC) || !startsWith(bytes, AGE_BINARY_PREFIX)) {
    throw new DriveError('not_sealed');
  }
  return { bytes } as SealedBackup;
}
