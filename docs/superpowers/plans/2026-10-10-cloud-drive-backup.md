# Cloud Drive Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back up AlmaMesh's existing age-sealed export to the user's own Google Drive (then Dropbox and OneDrive), and restore from a list of backups by date and device, with no server.

**Architecture:** One `BackupDrive` seam with one adapter file per provider; encryption stays above the seam (the upload is exactly today's `.almamesh` file). A `guardedDrive` wrapper refuses anything that isn't age ciphertext with a parseable neutral name. Provider credentials live in a device-local SQLite namespace, AES-GCM encrypted with one non-extractable key in IndexedDB. Restore reuses `useBackupRestore` staging, preview and safety copy.

**Tech Stack:** React + Vite + TypeScript (Bun workspace), Vitest, Playwright, `@gainratio/browser/seal` + `age-encryption` 0.3.1 (already deps), WebCrypto, `oauth4webapi` 3.8.8 (new, PR 4), Google Drive v3 REST, Dropbox v2 REST, Microsoft Graph v1.0.

**Spec:** `docs/superpowers/specs/2026-10-10-cloud-drive-backup-design.md` (approved, with owner rulings R0 and 1–12). Read it before any task.

## Global Constraints

- SQLite on the device is the system of record. The drive holds backup files only. No server, ever.
- Only ciphertext leaves: an upload body must start with `age-encryption.org/v1\n` and must not start with `SQLite format 3\0`.
- File names match exactly `^almamesh-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(chrome|edge|firefox|safari|samsung|other)-(macos|windows|linux|ios|android|chromeos|other)-[0-9a-f]{6}\.almamesh$`.
- Passphrase rule unchanged: `MIN_BACKUP_PASSPHRASE_LENGTH` (12), checked by `checkBackupPassphrase`. Never stored.
- Google scope is exactly `https://www.googleapis.com/auth/drive.file`. No `openid`, `email`, `profile`.
- Dropbox: App folder app, scopes `files.metadata.read files.content.read files.content.write`, `token_access_type=offline`.
- OneDrive: authority `https://login.microsoftonline.com/consumers`, scope `Files.ReadWrite.AppFolder offline_access`.
- Credentials: device-local namespace `device`, key `drive-credential/<provider>`, AES-GCM 256, 96-bit IV, AAD = the row key. Key in IndexedDB `almamesh-device-keys` (owner ruling R0), `extractable: false`.
- Retention: keep 10 newest per device code; older ones go to the provider's trash. Only this device's files are ever pruned.
- Redirect URIs: `https://almamesh.com/oauth/callback` and `http://localhost:4173/oauth/callback`. Drive buttons hide on any other origin.
- `connect-src` additions, exact: Google `https://www.googleapis.com https://oauth2.googleapis.com`; Dropbox `https://api.dropboxapi.com https://content.dropboxapi.com`; Microsoft `https://login.microsoftonline.com https://graph.microsoft.com` plus hosts from a live trace.
- Every PR: TDD, `make gate` green, mutation red runs pasted in the PR body, live checks, northstar A before merge. Stage named files only. `frontend-quality` skill after each frontend change.
- Copy in en, es and pt for every new string (`legal.parity.test.ts` enforces parity for legal).

## Review Focus

1. **A restore brings in a backup made on another device.** The device code and drive credentials on this device must be unchanged afterwards (`importPortableBrowserState` writes canonical keys only, but pin it). Test in Task 1.4.
2. **Site data partly cleared: the IndexedDB key is gone and the SQLite credential rows remain.** The user should see "Reconnect", no crash, no loop. Test in Task 2.2.
3. **The user moves or renames a backup in Drive, or another app drops a file in the folder.** It should silently drop off the list and never be pruned. Test in Task 1.3 (retention) and Task 2.4 (list).
4. **Two tabs press Back up at the same moment.** Both uploads succeed with distinct names, and retention in one tab never trashes the other tab's just-uploaded file. Test in Task 1.3.
5. **The OAuth callback is opened twice (back button, or a reload of `/oauth/callback#access_token=…`).** The second visit must not reuse the token or the state. It should show "That sign-in didn't come from this tab". Test in Task 2.3.

## External dependencies (owner actions, `~/dev/oss/harish_actions.py`)

| Needed by | Step | What |
|---|---|---|
| PR 2 live check, PR 3 merge | 53 | Google OAuth client for almamesh.com (spec "Owner's one-time setup") |
| PR 2 live check, PR 3 merge | 54 | Throwaway Google test account, signed in once via `bun run e2e:drive:google:login` |
| PR 4 merge | 55 | Dropbox app (App key) and a Dropbox test account |
| PR 5 merge | 56 | Entra app registration (client ID) and a personal Microsoft test account |

The coordinator adds steps 53–56 to `harish_actions.py` (that file lives in another repo). Until the client IDs land in `providerConfig.ts`, the stubbed CI journeys cover everything except the "needs the real provider" rows in the spec.

## File map

| File | PR | Responsibility |
|---|---|---|
| `frontend/apps/web/src/lib/drive/backupDrive.ts` | 1 | Types, `DriveError`, `BackupDrive` interface |
| `frontend/apps/web/src/lib/drive/backupName.ts` | 1 | Build and parse names; browser/OS enum from UA |
| `frontend/apps/web/src/lib/drive/guardedDrive.ts` | 1 | Ciphertext, name and offline guards around any adapter |
| `frontend/apps/web/src/lib/drive/retention.ts` | 1 | Pure prune planner |
| `frontend/packages/store/src/portableState.ts` | 1 | `device` namespace + repository methods |
| `frontend/packages/store/src/deviceRows.ts` | 1 | `readDeviceRow` / `writeDeviceRow` / `deleteDeviceRows` / `listDeviceRows`, device code |
| `frontend/apps/web/src/lib/drive/testing/fakeDrive.ts` | 1 | In-memory drive |
| `frontend/apps/web/src/lib/drive/testing/backupDriveContract.ts` | 1 | Shared contract suite |
| `frontend/apps/web/src/lib/drive/deviceKey.ts` | 2 | The only IndexedDB `almamesh-device-keys` user |
| `frontend/apps/web/src/lib/drive/credentialStore.ts` | 2 | Encrypted credential rows |
| `frontend/apps/web/src/lib/drive/oauthRedirect.ts` | 2 | `state`, PKCE verifier, callback parse, fragment scrub |
| `frontend/apps/web/src/lib/drive/providerConfig.ts` | 2 | Client IDs, redirect URI, `driveBackupEnabled()` |
| `frontend/apps/web/src/lib/drive/googleDrive.ts` | 2 | Google adapter |
| `frontend/apps/web/src/lib/drive/driveSession.ts` | 2 | Token lifecycle: load, expiry, renew, disconnect |
| `frontend/apps/web/src/pages/OAuthCallback.tsx` | 2 | `/oauth/callback` route |
| `frontend/apps/web/src/lib/drive/__tests__/driveEgress.test.ts` | 2 | Ciphertext-only egress test |
| `frontend/apps/web/src/lib/__tests__/connectSrc.test.ts` | 2 | Exact `connect-src` pin |
| `frontend/apps/web/src/hooks/useDriveBackup.ts` | 3 | Back up, list, restore, trash |
| `frontend/apps/web/src/components/features/backup/drive/*.tsx` | 3 | Provider picker, passphrase setup, backup list |
| `frontend/apps/web/e2e/drive-backup.spec.ts` + `e2e/driveFake.ts` + `playwright.drive-backup.config.ts` | 3 | Stubbed browser journey |
| `frontend/apps/web/e2e/live/drive-google.live.spec.ts` + `playwright.drive-google-live.config.ts` | 3 | Real Google round trip (manual trigger) |
| `frontend/apps/web/src/lib/drive/oauthClient.ts` | 4 | The only `oauth4webapi` importer |
| `frontend/apps/web/src/lib/drive/dropboxDrive.ts` | 4 | Dropbox adapter |
| `frontend/apps/web/src/lib/drive/oneDrive.ts` | 5 | OneDrive adapter |
| `frontend/packages/store/src/passphraseSeal.ts` | 6 | Adds recipient seal/open (still the only seal-library seam) |
| `frontend/apps/web/src/lib/drive/backupKeyFile.ts` | 6 | Key file on the drive |
| `frontend/apps/web/src/lib/drive/autoBackup.ts` | 6 | Debounced on-change scheduler |

Commands used throughout (from `frontend/apps/web` unless stated):

- One test file: `bunx vitest run src/lib/drive/backupName.test.ts`
- Store package tests: `cd frontend && bun run --filter @almamesh/store test`
- Full gate: `make gate` (repo root)

---

# PR 1: The seam

Branch: `feat/drive-backup-1-seam`. Claim touched: "backups never carry a person's name in their filename" and "the device code never travels in a backup". No network code.

### Task 1.1: Types and `DriveError`

**Files:**
- Create: `frontend/apps/web/src/lib/drive/backupDrive.ts`
- Test: `frontend/apps/web/src/lib/drive/backupDrive.test.ts`

**Interfaces:**
- Produces: `DriveProviderId`, `SealedBackup`, `BackupFileName`, `BackupNameMeta`, `DriveBackupEntry`, `BackupDrive`, `DriveErrorKind`, `DriveError`, `sealedBackupOf(bytes): SealedBackup`.

- [ ] **Step 1: Write the failing test**

```ts
// backupDrive.test.ts
import { describe, expect, it } from 'vitest';
import { DriveError, sealedBackupOf } from './backupDrive';

const AGE = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt abc 18\n');
const SQLITE = new TextEncoder().encode('SQLite format 3\0rest');

describe('sealedBackupOf', () => {
  it('accepts age bytes', () => {
    expect(sealedBackupOf(AGE).bytes).toBe(AGE);
  });
  it.each([
    ['plain SQLite', SQLITE],
    ['JSON', new TextEncoder().encode('{"format":"almamesh-backup"}')],
    ['empty', new Uint8Array()],
  ])('refuses %s', (_label, bytes) => {
    expect(() => sealedBackupOf(bytes)).toThrow(DriveError);
  });
});

describe('DriveError', () => {
  it('carries kind and status, never a body', () => {
    const error = new DriveError('quota_exceeded', 403);
    expect(error.kind).toBe('quota_exceeded');
    expect(error.status).toBe(403);
    expect(error.message).toBe('drive:quota_exceeded:403');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run src/lib/drive/backupDrive.test.ts`
Expected: FAIL, cannot resolve `./backupDrive`.

- [ ] **Step 3: Implement**

```ts
// backupDrive.ts
/**
 * The BackupDrive seam. Adapters move opaque sealed bytes only; encryption
 * stays above this line. See docs/superpowers/specs/2026-10-10-cloud-drive-backup-design.md.
 */
import { isSealedBackup } from '@almamesh/store';

export type DriveProviderId = 'google-drive' | 'dropbox' | 'onedrive';

declare const sealedBrand: unique symbol;
declare const nameBrand: unique symbol;

/** Bytes proven to be an age file and not a SQLite database. */
export interface SealedBackup { readonly bytes: Uint8Array; readonly [sealedBrand]: true }
/** A name built by backupName.ts and re-checked by its parser. */
export interface BackupFileName { readonly value: string; readonly [nameBrand]: true }

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
  | 'not_connected' | 'consent_denied' | 'token_expired' | 'offline'
  | 'quota_exceeded' | 'rate_limited' | 'not_found' | 'not_sealed' | 'bad_name'
  | 'provider_error';

export class DriveError extends Error {
  public override readonly name = 'DriveError';
  public constructor(public readonly kind: DriveErrorKind, public readonly status?: number) {
    super(`drive:${kind}${status === undefined ? '' : `:${status}`}`);
  }
}

const SQLITE_MAGIC = 'SQLite format 3\0';

function startsWithSqlite(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 16)) === SQLITE_MAGIC;
}

/** The only way to make a SealedBackup. Throws DriveError('not_sealed'). */
export function sealedBackupOf(bytes: Uint8Array): SealedBackup {
  if (bytes.length === 0 || startsWithSqlite(bytes) || !isSealedBackup(bytes)) {
    throw new DriveError('not_sealed');
  }
  return { bytes } as SealedBackup;
}
```

Check first that `isSealedBackup` is exported from `@almamesh/store` (`packages/store/src/index.ts` re-exports `./passphraseSeal`?). If not, add `export * from './passphraseSeal';` to `frontend/packages/store/src/index.ts` in this task, and say so in the commit.

- [ ] **Step 4: Run it and watch it pass**

Run: `bunx vitest run src/lib/drive/backupDrive.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/backupDrive.ts frontend/apps/web/src/lib/drive/backupDrive.test.ts
git commit -m "feat(drive): BackupDrive seam types and the sealed-bytes gate"
```

### Task 1.2: Backup names

**Files:**
- Create: `frontend/apps/web/src/lib/drive/backupName.ts`
- Test: `frontend/apps/web/src/lib/drive/backupName.test.ts`
- Read: `frontend/apps/web/src/lib/backupService.ts` (`exportBackupFilename`, `filenameTimestamp` at ~line 245)

**Interfaces:**
- Consumes: `BackupFileName`, `BackupNameMeta`, `BrowserFamily`, `OsFamily`, `DriveError` from Task 1.1.
- Produces: `buildBackupName(now: Date, ua: string, deviceCode: string): BackupFileName`, `parseBackupName(raw: string): BackupNameMeta | null`, `backupNameOf(raw: string): BackupFileName` (throws `bad_name`), `browserFamilyOf(ua)`, `osFamilyOf(ua)`, `BACKUP_NAME_PATTERN`.

- [ ] **Step 1: Write the failing test**

```ts
// backupName.test.ts
import { describe, expect, it } from 'vitest';
import { DriveError } from './backupDrive';
import { BACKUP_NAME_PATTERN, backupNameOf, buildBackupName, parseBackupName } from './backupName';

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const AT = new Date('2026-10-10T18:04:05.123Z');

describe('buildBackupName', () => {
  it('builds the documented shape', () => {
    expect(buildBackupName(AT, MAC_CHROME, '7f3a2c').value)
      .toBe('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
  });
  it.each([[IPHONE_SAFARI, 'safari-ios'], [WIN_EDGE, 'edge-windows'], ['curl/8', 'other-other']])(
    'maps %s', (ua, pair) => {
      expect(buildBackupName(AT, ua, '000000').value).toContain(`-${pair}-000000.`);
    });
  it('refuses a device code that is not 6 lowercase hex', () => {
    expect(() => buildBackupName(AT, MAC_CHROME, 'Alice!')).toThrow(DriveError);
  });
  it('never carries free text from the UA, whatever the UA says', () => {
    for (const ua of ['Priya Sharma 1987-03-14 Pune', '../../etc', 'x'.repeat(5000)]) {
      expect(buildBackupName(AT, ua, 'abcdef').value).toMatch(BACKUP_NAME_PATTERN);
    }
  });
});

describe('parseBackupName', () => {
  it('round-trips', () => {
    const meta = parseBackupName(buildBackupName(AT, MAC_CHROME, '7f3a2c').value);
    expect(meta).toEqual({ createdAt: AT, browser: 'chrome', os: 'macos', deviceCode: '7f3a2c' });
  });
  it.each([
    'almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh.txt',
    'Copy of almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh',
    'almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7F3A2C.almamesh',
    'almamesh-backup-2026-10-10T18-04-05-123Z-netscape-macos-7f3a2c.almamesh',
    'almamesh-backup-2026-13-40T18-04-05-123Z-chrome-macos-7f3a2c.almamesh',
    'almamesh-backup-2026-10-10T18-04-05Z.almamesh',
  ])('rejects %s', (raw) => {
    expect(parseBackupName(raw)).toBeNull();
    expect(() => backupNameOf(raw)).toThrow(DriveError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run src/lib/drive/backupName.test.ts`
Expected: FAIL, cannot resolve `./backupName`.

- [ ] **Step 3: Implement**

```ts
// backupName.ts
/** Neutral backup names: time, browser family, OS family, device code. No free text. */
import { type BackupFileName, type BackupNameMeta, type BrowserFamily, DriveError, type OsFamily } from './backupDrive';

const BROWSERS: readonly BrowserFamily[] = ['chrome', 'edge', 'firefox', 'safari', 'samsung', 'other'];
const SYSTEMS: readonly OsFamily[] = ['macos', 'windows', 'linux', 'ios', 'android', 'chromeos', 'other'];

export const BACKUP_NAME_PATTERN = new RegExp(
  `^almamesh-backup-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z-(${BROWSERS.join('|')})-(${SYSTEMS.join('|')})-([0-9a-f]{6})\\.almamesh$`,
);
const DEVICE_CODE = /^[0-9a-f]{6}$/;

export function browserFamilyOf(ua: string): BrowserFamily {
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (/Edg(A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

export function osFamilyOf(ua: string): OsFamily {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

function stamp(at: Date): string {
  return at.toISOString().replace(/:/g, '-').replace('.', '-');
}

export function buildBackupName(now: Date, ua: string, deviceCode: string): BackupFileName {
  if (!DEVICE_CODE.test(deviceCode)) throw new DriveError('bad_name');
  return backupNameOf(`almamesh-backup-${stamp(now)}-${browserFamilyOf(ua)}-${osFamilyOf(ua)}-${deviceCode}.almamesh`);
}

export function parseBackupName(raw: string): BackupNameMeta | null {
  const m = BACKUP_NAME_PATTERN.exec(raw);
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, browser: m[8] as BrowserFamily, os: m[9] as OsFamily, deviceCode: m[10] as string };
}

export function backupNameOf(raw: string): BackupFileName {
  if (parseBackupName(raw) === null) throw new DriveError('bad_name');
  return { value: raw } as BackupFileName;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bunx vitest run src/lib/drive/backupName.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/backupName.ts frontend/apps/web/src/lib/drive/backupName.test.ts
git commit -m "feat(drive): neutral backup names with a strict parser"
```

### Task 1.3: Retention planner

**Files:**
- Create: `frontend/apps/web/src/lib/drive/retention.ts`
- Test: `frontend/apps/web/src/lib/drive/retention.test.ts`

**Interfaces:**
- Consumes: `DriveBackupEntry` (Task 1.1), `buildBackupName`, `parseBackupName` (Task 1.2).
- Produces: `KEEP_PER_DEVICE = 10`, `planPrune(entries: readonly DriveBackupEntry[], deviceCode: string, justUploadedId: string): readonly string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// retention.test.ts
import { describe, expect, it } from 'vitest';
import type { DriveBackupEntry } from './backupDrive';
import { buildBackupName, parseBackupName } from './backupName';
import { KEEP_PER_DEVICE, planPrune } from './retention';

const UA = 'Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36';
function entry(id: string, minute: number, code: string): DriveBackupEntry {
  const name = buildBackupName(new Date(Date.UTC(2026, 9, 10, 12, minute)), UA, code);
  return { id, name, meta: parseBackupName(name.value)!, sizeBytes: 1 };
}

describe('planPrune', () => {
  it('pins the documented limit', () => { expect(KEEP_PER_DEVICE).toBe(10); });

  it('keeps the 10 newest of this device and trashes the rest, oldest first', () => {
    const mine = Array.from({ length: 13 }, (_, i) => entry(`m${i}`, i, 'aaaaaa'));
    expect(planPrune(mine, 'aaaaaa', 'm12')).toEqual(['m0', 'm1', 'm2']);
  });

  it('never selects another device', () => {
    const others = Array.from({ length: 30 }, (_, i) => entry(`o${i}`, i, 'bbbbbb'));
    expect(planPrune([...others, entry('m', 59, 'aaaaaa')], 'aaaaaa', 'm')).toEqual([]);
  });

  it('never selects the file it just uploaded, even if its clock is behind', () => {
    const mine = Array.from({ length: 10 }, (_, i) => entry(`m${i}`, 30 + i, 'aaaaaa'));
    const late = entry('late', 0, 'aaaaaa');
    expect(planPrune([...mine, late], 'aaaaaa', 'late')).not.toContain('late');
  });

  it('keeps a concurrent tab upload: two newest same-device files both survive', () => {
    const mine = Array.from({ length: 11 }, (_, i) => entry(`m${i}`, i, 'aaaaaa'));
    expect(planPrune(mine, 'aaaaaa', 'm9')).toEqual(['m0']);
  });
});
```

(Unparseable names never reach `planPrune`: the guarded `list()` drops them, tested in Task 1.5.)

- [ ] **Step 2: Run it and watch it fail**

Run: `bunx vitest run src/lib/drive/retention.test.ts`
Expected: FAIL, cannot resolve `./retention`.

- [ ] **Step 3: Implement**

```ts
// retention.ts
import type { DriveBackupEntry } from './backupDrive';

export const KEEP_PER_DEVICE = 10;

/** Ids to move to trash: this device's files beyond the newest KEEP_PER_DEVICE. */
export function planPrune(
  entries: readonly DriveBackupEntry[],
  deviceCode: string,
  justUploadedId: string,
): readonly string[] {
  const mine = entries
    .filter((e) => e.meta.deviceCode === deviceCode)
    .sort((a, b) => b.meta.createdAt.getTime() - a.meta.createdAt.getTime());
  return mine
    .slice(KEEP_PER_DEVICE)
    .filter((e) => e.id !== justUploadedId)
    .map((e) => e.id)
    .reverse();
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bunx vitest run src/lib/drive/retention.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/retention.ts frontend/apps/web/src/lib/drive/retention.test.ts
git commit -m "feat(drive): per-device retention planner (keep 10)"
```

### Task 1.4: Device-local rows and the device code

**Files:**
- Modify: `frontend/packages/store/src/portableState.ts` (add `PORTABLE_DEVICE_NAMESPACE` next to `PORTABLE_SET_ASIDE_NAMESPACE` ~line 48; add repository methods after `releaseSetAside` ~line 431)
- Create: `frontend/packages/store/src/deviceRows.ts`
- Modify: `frontend/packages/store/src/index.ts` (add `export * from './deviceRows';`)
- Test: `frontend/packages/store/src/portableState.test.ts` (reuse its `MemorySqliteStore`), `frontend/packages/store/src/deviceRows.test.ts`

**Interfaces:**
- Consumes: `PortableStateRepository`, `requirePortableStateRepository()` (`deletionTombstones.ts:391`).
- Produces: `PORTABLE_DEVICE_NAMESPACE = 'device'`; repository `readDevice(key): Promise<string|null>`, `writeDevice(key, value): Promise<void>`, `deleteDevice(keys: readonly string[]): Promise<void>`, `listDevice(prefix: string): Promise<ReadonlyMap<string,string>>`; `deviceRows: DeviceRows` and `interface DeviceRows { read; write; remove; list }`; `getDeviceCode(rows?: DeviceRows): Promise<string>`; `DEVICE_CODE_KEY = 'device-code'`.

- [ ] **Step 1: Write the failing tests**

Add to `portableState.test.ts`, inside the existing top-level `describe`:

```ts
it('keeps device rows out of snapshots and exports, and survives a portable import', async () => {
  const sqlite = new MemorySqliteStore();
  const repository = new PortableStateRepository(sqlite, async () => sqlite.epoch, async (canonical) => {
    rebuilt = canonical; return new Uint8Array([sqlite.epoch]);
  });
  let rebuilt: ReadonlyMap<string, string> = new Map();
  await repository.writeDevice('drive-credential/google-drive', 'CANARY-CREDENTIAL');
  await repository.writeDevice('device-code', '7f3a2c');

  const snapshot = await repository.snapshot();
  expect([...snapshot.values.values()].join()).not.toContain('CANARY-CREDENTIAL');
  await repository.exportWithReport();
  expect([...rebuilt.keys()].some((k) => k.includes('device'))).toBe(false);
  expect(await repository.readDevice('device-code')).toBe('7f3a2c');
  expect([...(await repository.listDevice('drive-credential/')).keys()])
    .toEqual(['drive-credential/google-drive']);
  await repository.deleteDevice(['drive-credential/google-drive']);
  expect(await repository.readDevice('drive-credential/google-drive')).toBeNull();
});
```

Create `deviceRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type DeviceRows, getDeviceCode } from './deviceRows';

function memoryRows(): DeviceRows & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    read: async (k) => map.get(k) ?? null,
    write: async (k, v) => { map.set(k, v); },
    remove: async (keys) => { keys.forEach((k) => map.delete(k)); },
    list: async (prefix) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
  };
}

describe('getDeviceCode', () => {
  it('mints 6 lowercase hex once and then returns the same code', async () => {
    const rows = memoryRows();
    const first = await getDeviceCode(rows);
    expect(first).toMatch(/^[0-9a-f]{6}$/);
    expect(await getDeviceCode(rows)).toBe(first);
    expect(rows.map.get('device-code')).toBe(first);
  });
  it('replaces a corrupt stored code', async () => {
    const rows = memoryRows();
    rows.map.set('device-code', 'Priya');
    expect(await getDeviceCode(rows)).toMatch(/^[0-9a-f]{6}$/);
  });
});
```

Add one browser-level assertion to the existing Playwright `e2e/portable-invariants.spec.ts` (it already exports in browser A and imports in browser B): after browser B's import, read the device code via the hooked build's `window.__almameshDeviceCode?.()` hook (add the hook in `src/lib/exitGateHooks` beside the existing hooks, gated by `VITE_EXIT_GATE_HOOKS`) and assert it equals the value B had before the import and differs from A's.

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && bun run --filter @almamesh/store test -- portableState deviceRows`
Expected: FAIL, `writeDevice` is not a function; cannot resolve `./deviceRows`.

- [ ] **Step 3: Implement**

In `portableState.ts`, after line 48:

```ts
/**
 * Device-local rows: this device's backup code and encrypted drive
 * credentials. Like quarantine and set-aside, never part of a snapshot,
 * restore, export, or backup. See the cloud drive backup spec.
 */
export const PORTABLE_DEVICE_NAMESPACE = 'device';
```

In the repository class, after `releaseSetAside`:

```ts
  public async readDevice(key: string): Promise<string | null> {
    const row = await this.#store.get(PORTABLE_DEVICE_NAMESPACE, key);
    return row === undefined ? null : decode(row.value, key);
  }

  public async writeDevice(key: string, value: string): Promise<void> {
    await this.#store.put(PORTABLE_DEVICE_NAMESPACE, key, encoder.encode(value));
  }

  public async deleteDevice(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.#store.batch(keys.map((key) => ({ type: 'delete', namespace: PORTABLE_DEVICE_NAMESPACE, key }) as const));
  }

  public async listDevice(prefix: string): Promise<ReadonlyMap<string, string>> {
    const held = new Map<string, string>();
    let afterKey: string | undefined;
    do {
      const page = await this.#store.list({
        namespace: PORTABLE_DEVICE_NAMESPACE,
        limit: MAX_CANONICAL_ROWS,
        ...(afterKey === undefined ? {} : { afterKey }),
      });
      for (const row of page.rows) if (row.key.startsWith(prefix)) held.set(row.key, decode(row.value, row.key));
      afterKey = page.nextKey;
    } while (afterKey !== undefined);
    return held;
  }
```

`deviceRows.ts`:

```ts
/** Device-local SQLite rows (never backed up): the device code and drive credentials. */
import { requirePortableStateRepository } from './deletionTombstones';

export interface DeviceRows {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  list(prefix: string): Promise<ReadonlyMap<string, string>>;
}

export const DEVICE_CODE_KEY = 'device-code';
const DEVICE_CODE = /^[0-9a-f]{6}$/;

export const deviceRows: DeviceRows = {
  read: async (key) => (await requirePortableStateRepository()).readDevice(key),
  write: async (key, value) => (await requirePortableStateRepository()).writeDevice(key, value),
  remove: async (keys) => (await requirePortableStateRepository()).deleteDevice(keys),
  list: async (prefix) => (await requirePortableStateRepository()).listDevice(prefix),
};

function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** This device's 6-hex backup code, minted on first use. */
export async function getDeviceCode(rows: DeviceRows = deviceRows): Promise<string> {
  const stored = await rows.read(DEVICE_CODE_KEY);
  if (stored !== null && DEVICE_CODE.test(stored)) return stored;
  const code = mintCode();
  await rows.write(DEVICE_CODE_KEY, code);
  return code;
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd frontend && bun run --filter @almamesh/store test -- portableState deviceRows`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/packages/store/src/portableState.ts frontend/packages/store/src/portableState.test.ts frontend/packages/store/src/deviceRows.ts frontend/packages/store/src/deviceRows.test.ts frontend/packages/store/src/index.ts frontend/apps/web/e2e/portable-invariants.spec.ts frontend/apps/web/src/lib/exitGateHooks.ts
git commit -m "feat(store): device-local SQLite namespace and the backup device code"
```

(Confirm the hooks file's real name with `ls frontend/apps/web/src/lib | grep -i hook` before staging; stage the file you edited.)

### Task 1.5: Guarded drive, fake drive and the contract suite

**Files:**
- Create: `frontend/apps/web/src/lib/drive/guardedDrive.ts`, `frontend/apps/web/src/lib/drive/testing/fakeDrive.ts`, `frontend/apps/web/src/lib/drive/testing/backupDriveContract.ts`
- Test: `frontend/apps/web/src/lib/drive/guardedDrive.test.ts`, `frontend/apps/web/src/lib/drive/testing/fakeDrive.test.ts`

**Interfaces:**
- Consumes: Tasks 1.1–1.2.
- Produces: `guardedDrive(inner: BackupDrive, isOnline?: () => boolean): BackupDrive`; `createFakeDrive(options?: { failNext?: DriveErrorKind }): BackupDrive & { files: Map<string, { name: string; bytes: Uint8Array; trashed: boolean }> }`; `runBackupDriveContract(label: string, make: () => Promise<BackupDrive>): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// guardedDrive.test.ts
import { describe, expect, it, vi } from 'vitest';
import { type BackupDrive, DriveError, type SealedBackup } from './backupDrive';
import { backupNameOf } from './backupName';
import { guardedDrive } from './guardedDrive';
import { createFakeDrive } from './testing/fakeDrive';

const NAME = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
const AGE = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt x 18\n---\n');

describe('guardedDrive', () => {
  it('refuses forged sealed bytes before the adapter is called', async () => {
    const inner = createFakeDrive();
    const upload = vi.spyOn(inner, 'upload');
    const forged = { bytes: new TextEncoder().encode('SQLite format 3\0') } as unknown as SealedBackup;
    await expect(guardedDrive(inner).upload(NAME, forged)).rejects.toMatchObject({ kind: 'not_sealed' });
    expect(upload).not.toHaveBeenCalled();
  });
  it('refuses a forged name', async () => {
    const inner = createFakeDrive();
    const bad = { value: 'Priya-backup.almamesh' } as never;
    await expect(guardedDrive(inner).upload(bad, { bytes: AGE } as SealedBackup)).rejects.toMatchObject({ kind: 'bad_name' });
  });
  it('drops entries whose names do not parse', async () => {
    const inner = createFakeDrive();
    inner.files.set('x', { name: 'Copy of something.almamesh', bytes: AGE, trashed: false });
    await guardedDrive(inner).upload(NAME, { bytes: AGE } as SealedBackup);
    expect((await guardedDrive(inner).list()).map((e) => e.name.value)).toEqual([NAME.value]);
  });
  it('maps offline before any call', async () => {
    const inner = createFakeDrive();
    const list = vi.spyOn(inner, 'list');
    await expect(guardedDrive(inner, () => false).list()).rejects.toMatchObject({ kind: 'offline' });
    expect(list).not.toHaveBeenCalled();
  });
});
```

```ts
// testing/fakeDrive.test.ts
import { runBackupDriveContract } from './backupDriveContract';
import { createFakeDrive } from './fakeDrive';

runBackupDriveContract('fake drive', async () => createFakeDrive());
```

- [ ] **Step 2: Run and watch them fail**

Run: `bunx vitest run src/lib/drive/guardedDrive.test.ts src/lib/drive/testing/fakeDrive.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

```ts
// guardedDrive.ts
/** The one place the "only ciphertext, only neutral names" rule is enforced. */
import { type BackupDrive, DriveError, sealedBackupOf } from './backupDrive';
import { backupNameOf, parseBackupName } from './backupName';

const browserOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

export function guardedDrive(inner: BackupDrive, isOnline: () => boolean = browserOnline): BackupDrive {
  const online = (): void => { if (!isOnline()) throw new DriveError('offline'); };
  return {
    provider: inner.provider,
    connect: async (returnTo) => { online(); return inner.connect(returnTo); },
    isConnected: () => inner.isConnected(),
    list: async () => {
      online();
      return (await inner.list()).filter((e) => parseBackupName(e.name.value) !== null);
    },
    upload: async (name, sealed) => {
      online();
      const checkedName = backupNameOf(name.value);
      const checked = sealedBackupOf(sealed.bytes);
      return inner.upload(checkedName, checked);
    },
    download: async (id) => { online(); return inner.download(id); },
    remove: async (id) => { online(); return inner.remove(id); },
    disconnect: () => inner.disconnect(),
  };
}
```

```ts
// testing/fakeDrive.ts
import { type BackupDrive, type DriveBackupEntry, DriveError, type DriveErrorKind } from '../backupDrive';
import { parseBackupName } from '../backupName';

interface FakeFile { name: string; bytes: Uint8Array; trashed: boolean }

export function createFakeDrive(options: { failNext?: DriveErrorKind } = {}) {
  const files = new Map<string, FakeFile>();
  let failNext = options.failNext;
  let seq = 0;
  const maybeFail = (): void => {
    if (failNext !== undefined) { const kind = failNext; failNext = undefined; throw new DriveError(kind); }
  };
  const toEntry = (id: string, f: FakeFile): DriveBackupEntry =>
    ({ id, name: { value: f.name } as never, meta: parseBackupName(f.name)!, sizeBytes: f.bytes.length });
  const drive: BackupDrive & { files: Map<string, FakeFile>; failWith(kind: DriveErrorKind): void } = {
    provider: 'google-drive',
    files,
    failWith: (kind) => { failNext = kind; },
    connect: async () => 'connected',
    isConnected: async () => true,
    list: async () => { maybeFail(); return [...files].filter(([, f]) => !f.trashed).map(([id, f]) => toEntry(id, f)); },
    upload: async (name, sealed) => {
      maybeFail();
      const id = `f${++seq}`;
      files.set(id, { name: name.value, bytes: sealed.bytes.slice(), trashed: false });
      return toEntry(id, files.get(id)!);
    },
    download: async (id) => {
      maybeFail();
      const f = files.get(id);
      if (f === undefined || f.trashed) throw new DriveError('not_found', 404);
      return f.bytes.slice();
    },
    remove: async (id) => {
      maybeFail();
      const f = files.get(id);
      if (f === undefined) throw new DriveError('not_found', 404);
      f.trashed = true;
    },
    disconnect: async () => undefined,
  };
  return drive;
}
```

```ts
// testing/backupDriveContract.ts
import { describe, expect, it } from 'vitest';
import type { BackupDrive, SealedBackup } from '../backupDrive';
import { backupNameOf } from '../backupName';

const NAME = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
const BYTES = new TextEncoder().encode('age-encryption.org/v1\n-> scrypt c2FsdA 18\n--- mac\n\u0001\u0002binary');

/** Every adapter must pass this, against a fake or recorded provider. */
export function runBackupDriveContract(label: string, make: () => Promise<BackupDrive>): void {
  describe(`BackupDrive contract: ${label}`, () => {
    it('upload then list shows it, with the parsed meta', async () => {
      const drive = await make();
      const up = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
      const listed = await drive.list();
      expect(listed.map((e) => e.id)).toContain(up.id);
      expect(listed.find((e) => e.id === up.id)?.meta.deviceCode).toBe('7f3a2c');
    });
    it('download is byte-equal', async () => {
      const drive = await make();
      const up = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
      expect(await drive.download(up.id)).toEqual(BYTES);
    });
    it('remove hides it from list', async () => {
      const drive = await make();
      const up = await drive.upload(NAME, { bytes: BYTES } as SealedBackup);
      await drive.remove(up.id);
      expect((await drive.list()).map((e) => e.id)).not.toContain(up.id);
    });
    it('download of a missing id is not_found', async () => {
      await expect((await make()).download('missing')).rejects.toMatchObject({ kind: 'not_found' });
    });
  });
}
```

Adapter-specific error mappings (401, 403 quota, 429) are tested per adapter against recorded responses (Tasks 2.4, 4.2, 5.1).

- [ ] **Step 4: Run and watch them pass**

Run: `bunx vitest run src/lib/drive`
Expected: PASS for every file in `src/lib/drive`.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/guardedDrive.ts frontend/apps/web/src/lib/drive/guardedDrive.test.ts frontend/apps/web/src/lib/drive/testing/fakeDrive.ts frontend/apps/web/src/lib/drive/testing/fakeDrive.test.ts frontend/apps/web/src/lib/drive/testing/backupDriveContract.ts
git commit -m "feat(drive): guarded drive wrapper, fake drive and the adapter contract suite"
```

### Task 1.6: PR 1 close-out

- [ ] **Step 1: Mutation red runs.** For each row, apply the mutation, run the test, paste the red output into the PR body, then `git checkout -- <file>`:

| Mutation | File | Must go red |
|---|---|---|
| `sealedBackupOf` returns `{ bytes }` without checks | `backupDrive.ts` | `backupDrive.test.ts`, `guardedDrive.test.ts` |
| `guardedDrive.upload` skips `sealedBackupOf` | `guardedDrive.ts` | `guardedDrive.test.ts` |
| `buildBackupName` appends `-${ua.slice(0,20)}` | `backupName.ts` | `backupName.test.ts` ("never carries free text") |
| `planPrune` drops the `deviceCode` filter | `retention.ts` | `retention.test.ts` ("never selects another device") |
| `listDevice` reads `PORTABLE_STATE_NAMESPACE` / device rows written to canonical | `portableState.ts` | `portableState.test.ts` device-rows test |

- [ ] **Step 2: Live checks.** No user-visible change. Run `cd frontend/apps/web && bun run build && bun run preview`, onboard through the real UI, confirm the dashboard renders with a clean console, then export and import a backup in Settings → Data (the device namespace touches the repository). Run `bun run test:e2e:portable-invariants --project=chromium` for the device-code assertion.
- [ ] **Step 3: Full gate.** `make gate` green. Paste the tail.
- [ ] **Step 4: Open the PR** with the claim line, mutation table and evidence. Dispatch `northstar`; fix until **A**. Merge, then delete the branch (local and remote) and remove the worktree.

---

# PR 2: Google adapter, credentials, callback (flag off)

Branch: `feat/drive-backup-2-google`. Also closes PR 1's three carry-forwards (CF1–CF3). Claims: "only ciphertext goes to the drive"; "drive credentials are encrypted, device-local, and gone after Disconnect or reset"; "connect-src is closed". **External:** steps 53–54 for the live check only; everything else is stubbed.

### PR 1 carry-forwards (from #330's northstar grade B)

Three findings from PR 1 land here, each with its own red test. Tasks 2.0a and 2.0b come first.
The third is folded into Task 2.7, which must merge in this PR because Task 2.2 is the first code
that writes a credential.

| # | Finding | Where it lands |
|---|---|---|
| CF1 | `guardedDrive.remove` passes any id straight to the adapter, so a bug or the UI could trash another device's backup | Task 2.0a |
| CF2 | `getDeviceCode` is read-then-write. Two tabs racing on first use can mint two codes, and the loser's backups then carry a code the device no longer owns | Task 2.0b |
| CF3 | "Start fresh" only commits a canonical generation (`lib/resetEverything.ts:153`), so the `device` namespace, and with it any `drive-credential/*` row, survives a reset | Task 2.7 (rewritten) |

### Task 2.0a: `guardedDrive.remove` only trashes this device's listed backups (CF1)

**Files:**
- Modify: `frontend/apps/web/src/lib/drive/guardedDrive.ts` (shipped in #330 as `guardedDrive(inner, isOnline = browserOnline)`)
- Test: `frontend/apps/web/src/lib/drive/guardedDrive.test.ts`

**Interfaces:**
- Consumes: `getDeviceCode` from `@almamesh/store` (`deviceRows.ts`), `createFakeDrive` and `sealedFixtureBytes` from `testing/` (both shipped in #330).
- Produces: `guardedDrive(inner: BackupDrive, isOnline: () => boolean = browserOnline, deviceCode: () => Promise<string> = getDeviceCode): BackupDrive`. Its `remove(id)` throws `DriveError('not_found')` with **no adapter call** unless `id` was in the most recent `list()` result of this same guarded instance **and** that entry's `meta.deviceCode` equals `await deviceCode()`. A successful `upload` adds its own entry to the allowed set (so retention can prune right after upload without a second listing race). A successful `remove` drops the id from the set.

- [ ] **Step 1: Write the failing tests**

```ts
describe('guardedDrive.remove ownership (CF1)', () => {
  const MINE = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-aaaaaa.almamesh');
  const THEIRS = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-safari-ios-bbbbbb.almamesh');

  async function seeded() {
    const inner = createFakeDrive();
    const sealed = sealedBackupOf(await sealedFixtureBytes());
    const mine = await inner.upload(MINE, sealed);
    const theirs = await inner.upload(THEIRS, sealed);
    const remove = vi.spyOn(inner, 'remove');
    const drive = guardedDrive(inner, () => true, async () => 'aaaaaa');
    return { inner, drive, mine, theirs, remove };
  }

  it('refuses an id never seen in list()', async () => {
    const { drive, mine, remove } = await seeded();
    await expect(drive.remove(mine.id)).rejects.toMatchObject({ kind: 'not_found' });
    expect(remove).not.toHaveBeenCalled();
  });
  it('refuses another device\'s listed backup', async () => {
    const { drive, theirs, remove } = await seeded();
    await drive.list();
    await expect(drive.remove(theirs.id)).rejects.toMatchObject({ kind: 'not_found' });
    expect(remove).not.toHaveBeenCalled();
  });
  it('allows this device\'s listed backup, once', async () => {
    const { drive, mine, remove } = await seeded();
    await drive.list();
    await drive.remove(mine.id);
    expect(remove).toHaveBeenCalledWith(mine.id);
    await expect(drive.remove(mine.id)).rejects.toMatchObject({ kind: 'not_found' });
  });
  it('a newer list() replaces the allowed set', async () => {
    const { inner, drive, mine, remove } = await seeded();
    await drive.list();
    inner.files.get(mine.id)!.trashed = true; // gone elsewhere
    await drive.list();
    await expect(drive.remove(mine.id)).rejects.toMatchObject({ kind: 'not_found' });
    expect(remove).not.toHaveBeenCalled();
  });
  it('an id this instance just uploaded is removable without a new list()', async () => {
    const { drive, remove } = await seeded();
    const up = await drive.upload(MINE, sealedBackupOf(await sealedFixtureBytes()));
    await drive.remove(up.id);
    expect(remove).toHaveBeenCalledWith(up.id);
  });
});
```

- [ ] **Step 2: Run and watch them fail.** `bunx vitest run src/lib/drive/guardedDrive.test.ts`. Expected: the first four FAIL (remove currently forwards every id).

- [ ] **Step 3: Implement.** Inside `guardedDrive`, keep `let removable = new Set<string>()`. In `list`, after building `checked`: `const code = await deviceCode(); removable = new Set(checked.filter((e) => e.meta.deviceCode === code).map((e) => e.id));`. In `upload`, after the checked entry: `if (entry.meta.deviceCode === (await deviceCode())) removable.add(entry.id);`. In `remove`: `online(); if (!removable.has(id)) throw new DriveError('not_found'); await inner.remove(id); removable.delete(id);`. Update the file's header comment: "…only ciphertext, only neutral names, and only this device's backups are ever trashed."

- [ ] **Step 4: Run and watch them pass,** plus `src/lib/drive/testing/fakeDrive.test.ts` (the contract suite runs on the unguarded fake, so it is unaffected).

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/guardedDrive.ts frontend/apps/web/src/lib/drive/guardedDrive.test.ts
git commit -m "fix(drive): guarded remove only trashes this device's listed backups"
```

### Task 2.0b: First device code is insert-if-absent, then read back (CF2)

**Files:**
- Modify: `frontend/packages/store/src/portableState.ts` (add `insertDeviceIfAbsent` next to `writeDevice`, shipped in #330), `frontend/packages/store/src/deviceRows.ts` (`DeviceRows` gains `insertIfAbsent`; `getDeviceCode` uses it)
- Test: `frontend/packages/store/src/portableState.test.ts` (its `MemorySqliteStore` already honours `expectedEpoch`, line ~68), `frontend/packages/store/src/deviceRows.test.ts`

**Interfaces:**
- Produces: repository `insertDeviceIfAbsent(key: string, value: string): Promise<string>`. It returns the value stored after the call: the existing one if present, else `value`. `DeviceRows.insertIfAbsent(key, value): Promise<string>`. `getDeviceCode` returns the read-back value, never its own mint unless that mint won.
- `SqliteStateStore` (`@gainratio/browser` 0.4.1) has no per-key conditional put. It does have `batch(…, { expectedEpoch })`, which throws `SqliteStateConflictError` when any write landed in between. That is the compare-and-swap.

- [ ] **Step 1: Write the failing tests**

```ts
// portableState.test.ts
it('insertDeviceIfAbsent: two racing inserts agree on the first value', async () => {
  const sqlite = new MemorySqliteStore();
  const a = new PortableStateRepository(sqlite);
  const b = new PortableStateRepository(sqlite);
  const [x, y] = await Promise.all([
    a.insertDeviceIfAbsent('device-code', 'aaaaaa'),
    b.insertDeviceIfAbsent('device-code', 'bbbbbb'),
  ]);
  expect(x).toBe(y);
  expect(await a.readDevice('device-code')).toBe(x);
});
it('insertDeviceIfAbsent never overwrites an existing value', async () => {
  const sqlite = new MemorySqliteStore();
  const repository = new PortableStateRepository(sqlite);
  await repository.writeDevice('device-code', 'cccccc');
  expect(await repository.insertDeviceIfAbsent('device-code', 'dddddd')).toBe('cccccc');
});
```

```ts
// deviceRows.test.ts: a DeviceRows fake whose read() yields to the event loop, so two
// getDeviceCode calls both see "absent" before either writes (the race #330 left open).
function racyRows() {
  const map = new Map<string, string>();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const rows: DeviceRows = {
    read: async (k) => { await tick(); return map.get(k) ?? null; },
    write: async (k, v) => { await tick(); map.set(k, v); },
    insertIfAbsent: async (k, v) => { if (!map.has(k)) map.set(k, v); await tick(); return map.get(k)!; },
    remove: async (ks) => { ks.forEach((k) => map.delete(k)); },
    list: async (p) => new Map([...map].filter(([k]) => k.startsWith(p))),
  };
  return { map, rows };
}

it('two tabs minting at once get the same code (CF2)', async () => {
  const { map, rows } = racyRows();
  const [a, b] = await Promise.all([getDeviceCode(rows), getDeviceCode(rows)]);
  expect(a).toBe(b);
  expect(map.get('device-code')).toBe(a);
});
it('a corrupt stored code is replaced once, and racers agree', async () => {
  const { map, rows } = racyRows();
  map.set('device-code', 'Priya');
  const [a, b] = await Promise.all([getDeviceCode(rows), getDeviceCode(rows)]);
  expect(a).toMatch(/^[0-9a-f]{6}$/);
  expect(a).toBe(b);
});
```

- [ ] **Step 2: Run and watch them fail.** `cd frontend && bun run --filter @almamesh/store test -- portableState deviceRows`. Expected: `insertDeviceIfAbsent is not a function`; the race test FAILS with two different codes.

- [ ] **Step 3: Implement**

```ts
// portableState.ts, in PortableStateRepository
  /** Insert only if absent (multi-tab safe via the store epoch), then return what is stored. */
  public async insertDeviceIfAbsent(key: string, value: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const { epoch } = await this.#store.runtimeInfo();
      const existing = await this.#store.get(PORTABLE_DEVICE_NAMESPACE, key);
      if (existing !== undefined) return decode(existing.value, key);
      try {
        await this.#store.batch(
          [{ type: 'put', namespace: PORTABLE_DEVICE_NAMESPACE, key, value: encoder.encode(value) }],
          { expectedEpoch: epoch },
        );
      } catch (error) {
        if (error instanceof SqliteStateConflictError) continue;
        throw error;
      }
      const stored = await this.#store.get(PORTABLE_DEVICE_NAMESPACE, key);
      if (stored !== undefined) return decode(stored.value, key);
    }
    throw new Error('Device row stayed busy while inserting.');
  }
```

```ts
// deviceRows.ts
export interface DeviceRows {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  /** Insert only if absent; resolves to the value stored afterwards (the winner of any race). */
  insertIfAbsent(key: string, value: string): Promise<string>;
  remove(keys: readonly string[]): Promise<void>;
  list(prefix: string): Promise<ReadonlyMap<string, string>>;
}
// deviceRows: add
//   insertIfAbsent: async (key, value) => (await requirePortableStateRepository()).insertDeviceIfAbsent(key, value),

export async function getDeviceCode(rows: DeviceRows = deviceRows): Promise<string> {
  const stored = await rows.read(DEVICE_CODE_KEY);
  if (stored !== null && DEVICE_CODE.test(stored)) return stored;
  if (stored !== null) await rows.remove([DEVICE_CODE_KEY]); // corrupt: clear, then race fairly
  const winner = await rows.insertIfAbsent(DEVICE_CODE_KEY, mintCode());
  if (!DEVICE_CODE.test(winner)) throw new Error('Device code did not verify in SQLite.');
  return winner;
}
```

Keep #330's 2^-24 collision comment. Every other `DeviceRows` fake in the codebase (`credentialStore.test.ts`, `testing/memoryCredentials.ts`) gains an `insertIfAbsent` that does `if (!map.has(k)) map.set(k, v); return map.get(k)!`.

- [ ] **Step 4: Run and watch them pass.**
- [ ] **Step 5: Commit**

```bash
git add frontend/packages/store/src/portableState.ts frontend/packages/store/src/portableState.test.ts frontend/packages/store/src/deviceRows.ts frontend/packages/store/src/deviceRows.test.ts
git commit -m "fix(store): mint the device code with insert-if-absent and read it back"
```

### Task 2.1: Device key (owner ruling R0)

**Files:**
- Create: `frontend/apps/web/src/lib/drive/deviceKey.ts`
- Test: `frontend/apps/web/src/lib/drive/deviceKey.test.ts` (uses `fake-indexeddb`: check `frontend/apps/web/package.json` devDependencies; if absent, `bun add -d fake-indexeddb` in `frontend/apps/web` and stage `package.json` + `frontend/bun.lock`)

**Interfaces:**
- Produces: `DEVICE_KEY_DB = 'almamesh-device-keys'`, `getDeviceKey(): Promise<CryptoKey>`, `deleteDeviceKey(): Promise<void>`, `readDeviceKeyRecords(): Promise<readonly unknown[]>` (test and audit helper).

- [ ] **Step 1: Write the failing test**

```ts
// deviceKey.test.ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_KEY_DB, deleteDeviceKey, getDeviceKey, readDeviceKeyRecords } from './deviceKey';

beforeEach(async () => { await deleteDeviceKey(); });

describe('device key', () => {
  it('is a non-extractable AES-GCM 256 key, stable across calls', async () => {
    const key = await getDeviceKey();
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([1]));
    const again = await getDeviceKey();
    expect(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, again, sealed))).toEqual(new Uint8Array([1]));
  });
  it('holds exactly one record, and it is a CryptoKey (ruling R0)', async () => {
    await getDeviceKey();
    const records = await readDeviceKeyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toBeInstanceOf(CryptoKey);
    expect(DEVICE_KEY_DB).toBe('almamesh-device-keys');
  });
  it('delete removes the database', async () => {
    await getDeviceKey();
    await deleteDeviceKey();
    expect(await readDeviceKeyRecords()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail.** `bunx vitest run src/lib/drive/deviceKey.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

```ts
// deviceKey.ts
/**
 * Owner ruling R0 (2026-10-10): IndexedDB `almamesh-device-keys` holds exactly
 * one non-extractable AES-GCM CryptoKey. It is a device-bound key handle, not
 * user data, so "SQLite only for user data" stands. This file is its only user.
 */
export const DEVICE_KEY_DB = 'almamesh-device-keys';
const STORE = 'keys';
const ID = 'drive-credentials-v1';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open(): Promise<IDBDatabase> {
  const req = indexedDB.open(DEVICE_KEY_DB, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
  return request(req);
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try { return await request(run(db.transaction(STORE, mode).objectStore(STORE))); } finally { db.close(); }
}

export async function getDeviceKey(): Promise<CryptoKey> {
  const existing = await withStore('readonly', (s) => s.get(ID) as IDBRequest<CryptoKey | undefined>);
  if (existing instanceof CryptoKey) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await withStore('readwrite', (s) => s.put(key, ID));
  return key;
}

export function deleteDeviceKey(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DEVICE_KEY_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

export async function readDeviceKeyRecords(): Promise<readonly unknown[]> {
  return withStore('readonly', (s) => s.getAll());
}
```

- [ ] **Step 4: Run and watch it pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/deviceKey.ts frontend/apps/web/src/lib/drive/deviceKey.test.ts
git commit -m "feat(drive): one non-extractable device key in IndexedDB (owner ruling R0)"
```

### Task 2.2: Encrypted credential store

**Files:**
- Create: `frontend/apps/web/src/lib/drive/credentialStore.ts`
- Test: `frontend/apps/web/src/lib/drive/credentialStore.test.ts`

**Interfaces:**
- Consumes: `getDeviceKey` (2.1), `DeviceRows`, `deviceRows` (1.4), `DriveProviderId` (1.1).
- Produces: `interface StoredCredential { readonly provider: DriveProviderId; readonly accessToken?: string; readonly refreshToken?: string; readonly expiresAt: number }`; `saveCredential(c, deps?)`, `loadCredential(provider, deps?): Promise<StoredCredential | null>`, `deleteCredential(provider, deps?)`, `deleteAllCredentials(deps?)`; `credentialKey(provider) = 'drive-credential/' + provider`; `CredentialDeps { rows: DeviceRows; key: () => Promise<CryptoKey> }`.

- [ ] **Step 1: Write the failing test**

```ts
// credentialStore.test.ts
import { describe, expect, it } from 'vitest';
import type { DeviceRows } from '@almamesh/store';
import { credentialKey, deleteAllCredentials, deleteCredential, loadCredential, saveCredential } from './credentialStore';

const CANARY = 'ya29.CANARY-TOKEN-0123456789';
function setup(keyRef = { current: null as CryptoKey | null }) {
  const map = new Map<string, string>();
  const rows: DeviceRows = {
    read: async (k) => map.get(k) ?? null,
    write: async (k, v) => { map.set(k, v); },
    remove: async (ks) => { ks.forEach((k) => map.delete(k)); },
    list: async (p) => new Map([...map].filter(([k]) => k.startsWith(p))),
  };
  const key = async () => (keyRef.current ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  return { map, deps: { rows, key }, keyRef };
}

describe('credentialStore', () => {
  it('round-trips and never stores the token in plaintext', async () => {
    const { map, deps } = setup();
    await saveCredential({ provider: 'google-drive', accessToken: CANARY, expiresAt: 123 }, deps);
    expect([...map.values()].join()).not.toContain(CANARY);
    expect(await loadCredential('google-drive', deps)).toEqual({ provider: 'google-drive', accessToken: CANARY, expiresAt: 123 });
  });
  it('a row moved to another provider fails to decrypt (AAD) and is removed', async () => {
    const { map, deps } = setup();
    await saveCredential({ provider: 'google-drive', accessToken: CANARY, expiresAt: 1 }, deps);
    map.set(credentialKey('dropbox'), map.get(credentialKey('google-drive'))!);
    expect(await loadCredential('dropbox', deps)).toBeNull();
    expect(map.has(credentialKey('dropbox'))).toBe(false);
  });
  it('a lost device key reads as disconnected and removes the row, without throwing', async () => {
    const { map, deps, keyRef } = setup();
    await saveCredential({ provider: 'dropbox', refreshToken: CANARY, expiresAt: 0 }, deps);
    keyRef.current = null;
    expect(await loadCredential('dropbox', deps)).toBeNull();
    expect(map.size).toBe(0);
  });
  it('delete and deleteAll remove rows', async () => {
    const { map, deps } = setup();
    await saveCredential({ provider: 'google-drive', accessToken: 'a', expiresAt: 1 }, deps);
    await saveCredential({ provider: 'dropbox', refreshToken: 'b', expiresAt: 0 }, deps);
    await deleteCredential('google-drive', deps);
    expect([...map.keys()]).toEqual([credentialKey('dropbox')]);
    await deleteAllCredentials(deps);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail.** `bunx vitest run src/lib/drive/credentialStore.test.ts`. Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

```ts
// credentialStore.ts
/** Drive credentials: device-local SQLite rows, AES-GCM with the device key. Never logged. */
import { type DeviceRows, deviceRows } from '@almamesh/store';
import type { DriveProviderId } from './backupDrive';
import { getDeviceKey } from './deviceKey';

export interface StoredCredential {
  readonly provider: DriveProviderId;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
}
export interface CredentialDeps { readonly rows: DeviceRows; readonly key: () => Promise<CryptoKey> }
const DEFAULT: CredentialDeps = { rows: deviceRows, key: getDeviceKey };
const PREFIX = 'drive-credential/';
export const credentialKey = (provider: DriveProviderId): string => `${PREFIX}${provider}`;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function saveCredential(c: StoredCredential, deps: CredentialDeps = DEFAULT): Promise<void> {
  const rowKey = credentialKey(c.provider);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(c));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(rowKey) }, await deps.key(), plain);
  await deps.rows.write(rowKey, JSON.stringify({ v: 1, iv: b64(iv), ciphertext: b64(new Uint8Array(sealed)) }));
}

export async function loadCredential(provider: DriveProviderId, deps: CredentialDeps = DEFAULT): Promise<StoredCredential | null> {
  const rowKey = credentialKey(provider);
  const raw = await deps.rows.read(rowKey);
  if (raw === null) return null;
  try {
    const row = JSON.parse(raw) as { v: number; iv: string; ciphertext: string };
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(row.iv), additionalData: new TextEncoder().encode(rowKey) },
      await deps.key(), unb64(row.ciphertext));
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as StoredCredential;
    return parsed.provider === provider ? parsed : null;
  } catch {
    // Lost key, moved row, or damage: disconnected. No detail is logged.
    await deps.rows.remove([rowKey]);
    return null;
  }
}

export async function deleteCredential(provider: DriveProviderId, deps: CredentialDeps = DEFAULT): Promise<void> {
  await deps.rows.remove([credentialKey(provider)]);
}

export async function deleteAllCredentials(deps: CredentialDeps = DEFAULT): Promise<void> {
  await deps.rows.remove([...(await deps.rows.list(PREFIX)).keys()]);
}
```

- [ ] **Step 4: Run and watch it pass.** Expected: PASS (4 tests).
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/credentialStore.ts frontend/apps/web/src/lib/drive/credentialStore.test.ts
git commit -m "feat(drive): encrypted device-local credential rows"
```

### Task 2.3: OAuth redirect helper and provider config

**Files:**
- Create: `frontend/apps/web/src/lib/drive/oauthRedirect.ts`, `frontend/apps/web/src/lib/drive/providerConfig.ts`
- Test: `frontend/apps/web/src/lib/drive/oauthRedirect.test.ts`, `frontend/apps/web/src/lib/drive/providerConfig.test.ts`

**Interfaces:**
- Produces: `PendingSignIn { provider; state; returnTo; startedAt; pkceVerifier? }`; `beginSignIn(provider, returnTo, opts?: { pkceVerifier?: string; now?: number }): string` (returns state; writes sessionStorage `almamesh-oauth-pending`); `takePendingSignIn(state: string, now?: number): PendingSignIn` (throws `DriveError('consent_denied')` on missing/mismatch/older than 10 min; always deletes); `readCallback(href: string): { state: string | null; accessToken?: string; expiresIn?: number; code?: string; error?: string }`; `scrubCallbackUrl(): void`.
- `providerConfig.ts`: `REDIRECT_PATH = '/oauth/callback'`, `GOOGLE_CLIENT_ID` (empty string until step 53), `DROPBOX_APP_KEY`, `MICROSOFT_CLIENT_ID`, `redirectUri(origin)`, `driveBackupEnabled(origin: string, flag = import.meta.env.VITE_DRIVE_BACKUP): boolean` (true only when origin is `https://almamesh.com` or `http://localhost:4173` AND flag === '1' AND `GOOGLE_CLIENT_ID !== ''`).

- [ ] **Step 1: Write the failing tests**

```ts
// oauthRedirect.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { beginSignIn, readCallback, takePendingSignIn } from './oauthRedirect';

beforeEach(() => sessionStorage.clear());

describe('sign-in state', () => {
  it('returns the pending record once, then refuses a replay', () => {
    const state = beginSignIn('google-drive', '/settings/data', { now: 1000 });
    expect(takePendingSignIn(state, 2000)).toMatchObject({ provider: 'google-drive', returnTo: '/settings/data' });
    expect(() => takePendingSignIn(state, 2000)).toThrow();
    expect(sessionStorage.length).toBe(0);
  });
  it('refuses a mismatched state and clears the record', () => {
    beginSignIn('google-drive', '/settings/data');
    expect(() => takePendingSignIn('forged')).toThrow();
    expect(sessionStorage.length).toBe(0);
  });
  it('refuses a record older than 10 minutes', () => {
    const state = beginSignIn('google-drive', '/', { now: 0 });
    expect(() => takePendingSignIn(state, 10 * 60_000 + 1)).toThrow();
  });
  it('state is 128 random bits, base64url', () => {
    expect(beginSignIn('dropbox', '/')).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it('only accepts a same-origin path as returnTo', () => {
    expect(() => beginSignIn('dropbox', 'https://evil.example/')).toThrow();
  });
});

describe('readCallback', () => {
  it('reads a Google fragment', () => {
    expect(readCallback('https://almamesh.com/oauth/callback#access_token=T&token_type=Bearer&expires_in=3600&state=S'))
      .toEqual({ state: 'S', accessToken: 'T', expiresIn: 3600 });
  });
  it('reads a PKCE code from the query', () => {
    expect(readCallback('https://almamesh.com/oauth/callback?code=C&state=S')).toEqual({ state: 'S', code: 'C' });
  });
  it('reads an error', () => {
    expect(readCallback('https://almamesh.com/oauth/callback#error=interaction_required&state=S'))
      .toEqual({ state: 'S', error: 'interaction_required' });
  });
});
```

```ts
// providerConfig.test.ts
import { describe, expect, it } from 'vitest';
import { driveBackupEnabled, redirectUri } from './providerConfig';

describe('providerConfig', () => {
  it('builds the registered redirect URI', () => {
    expect(redirectUri('https://almamesh.com')).toBe('https://almamesh.com/oauth/callback');
  });
  it('is off on preview hosts and when the flag is off', () => {
    expect(driveBackupEnabled('https://abc.almamesh.pages.dev', '1', 'id')).toBe(false);
    expect(driveBackupEnabled('https://almamesh.com', undefined, 'id')).toBe(false);
    expect(driveBackupEnabled('https://almamesh.com', '1', '')).toBe(false);
    expect(driveBackupEnabled('http://localhost:4173', '1', 'id')).toBe(true);
  });
});
```

(Signature for testability: `driveBackupEnabled(origin, flag = import.meta.env.VITE_DRIVE_BACKUP, clientId = GOOGLE_CLIENT_ID)`.)

- [ ] **Step 2: Run and watch them fail.** `bunx vitest run src/lib/drive/oauthRedirect.test.ts src/lib/drive/providerConfig.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// oauthRedirect.ts
/** One short-lived sign-in record survives the redirect in sessionStorage. No token is ever stored here. */
import { type DriveProviderId, DriveError } from './backupDrive';

const KEY = 'almamesh-oauth-pending';
const MAX_AGE_MS = 10 * 60_000;

export interface PendingSignIn {
  readonly provider: DriveProviderId;
  readonly state: string;
  readonly returnTo: string;
  readonly startedAt: number;
  readonly pkceVerifier?: string;
}

export function randomUrlToken(bytes = 16): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function beginSignIn(
  provider: DriveProviderId, returnTo: string, opts: { pkceVerifier?: string; now?: number } = {},
): string {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) throw new DriveError('provider_error');
  const pending: PendingSignIn = {
    provider, returnTo, state: randomUrlToken(), startedAt: opts.now ?? Date.now(),
    ...(opts.pkceVerifier === undefined ? {} : { pkceVerifier: opts.pkceVerifier }),
  };
  sessionStorage.setItem(KEY, JSON.stringify(pending));
  return pending.state;
}

export function takePendingSignIn(state: string, now: number = Date.now()): PendingSignIn {
  const raw = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  const pending = raw === null ? null : (JSON.parse(raw) as PendingSignIn);
  if (pending === null || pending.state !== state || now - pending.startedAt > MAX_AGE_MS) {
    throw new DriveError('consent_denied');
  }
  return pending;
}

export function readCallback(href: string): {
  state: string | null; accessToken?: string; expiresIn?: number; code?: string; error?: string;
} {
  const url = new URL(href);
  const params = new URLSearchParams(url.hash.length > 1 ? url.hash.slice(1) : url.search);
  const out: ReturnType<typeof readCallback> = { state: params.get('state') };
  const token = params.get('access_token');
  if (token !== null) { out.accessToken = token; out.expiresIn = Number(params.get('expires_in')); }
  const code = params.get('code');
  if (code !== null) out.code = code;
  const error = params.get('error');
  if (error !== null) out.error = error;
  return out;
}

export function scrubCallbackUrl(): void {
  history.replaceState(null, '', location.pathname);
}
```

```ts
// providerConfig.ts
/** Public OAuth client identifiers (not secrets). Filled from harish_actions steps 53, 55, 56. */
export const REDIRECT_PATH = '/oauth/callback';
export const GOOGLE_CLIENT_ID = '';
export const DROPBOX_APP_KEY = '';
export const MICROSOFT_CLIENT_ID = '';
const REGISTERED_ORIGINS = new Set(['https://almamesh.com', 'http://localhost:4173']);

export const redirectUri = (origin: string): string => `${origin}${REDIRECT_PATH}`;

export function driveBackupEnabled(
  origin: string,
  flag: string | undefined = import.meta.env.VITE_DRIVE_BACKUP,
  clientId: string = GOOGLE_CLIENT_ID,
): boolean {
  return REGISTERED_ORIGINS.has(origin) && flag === '1' && clientId !== '';
}
```

Add `VITE_DRIVE_BACKUP?: string` to the `ImportMetaEnv` interface in `frontend/apps/web/src/vite-env.d.ts`.

- [ ] **Step 4: Run and watch them pass.**
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/oauthRedirect.ts frontend/apps/web/src/lib/drive/oauthRedirect.test.ts frontend/apps/web/src/lib/drive/providerConfig.ts frontend/apps/web/src/lib/drive/providerConfig.test.ts frontend/apps/web/src/vite-env.d.ts
git commit -m "feat(drive): one-shot OAuth sign-in state and provider config behind a flag"
```

### Task 2.4: Google Drive adapter

**Files:**
- Create: `frontend/apps/web/src/lib/drive/googleDrive.ts`, `frontend/apps/web/src/lib/drive/testing/fakeGoogleFetch.ts`
- Test: `frontend/apps/web/src/lib/drive/googleDrive.test.ts`

**Interfaces:**
- Consumes: `BackupDrive`, `DriveError` (1.1), `backupNameOf`, `parseBackupName` (1.2), `runBackupDriveContract` (1.5).
- Produces: `createGoogleDrive(deps: { fetch: typeof fetch; token: () => Promise<string>; navigate: (url: string) => void; origin: string; clientId: string }): BackupDrive`; `googleAuthorizeUrl({ clientId, origin, state, silent }): string`; `FOLDER_NAME = 'AlmaMesh backups'`; `createFakeGoogleFetch(): { fetch: typeof fetch; requests: Request[]; files: Map<…> }` implementing `files.list`, folder create, resumable `POST /upload/drive/v3/files?uploadType=resumable` + `PUT <session>`, `GET ?alt=media`, `PATCH {trashed:true}`, and scripted 401/403-`storageQuotaExceeded`/429.

- [ ] **Step 1: Write the failing test**

```ts
// googleDrive.test.ts
import { describe, expect, it } from 'vitest';
import type { SealedBackup } from './backupDrive';
import { backupNameOf } from './backupName';
import { createGoogleDrive, googleAuthorizeUrl } from './googleDrive';
import { runBackupDriveContract } from './testing/backupDriveContract';
import { createFakeGoogleFetch } from './testing/fakeGoogleFetch';

const make = (fake = createFakeGoogleFetch()) =>
  createGoogleDrive({ fetch: fake.fetch, token: async () => 'tok', navigate: () => undefined, origin: 'https://almamesh.com', clientId: 'cid' });

runBackupDriveContract('google drive (fake REST)', async () => make());

describe('google drive specifics', () => {
  it('authorize URL asks for drive.file only, token flow, and prompt=none when silent', () => {
    const url = new URL(googleAuthorizeUrl({ clientId: 'cid', origin: 'https://almamesh.com', state: 'S', silent: true }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('redirect_uri')).toBe('https://almamesh.com/oauth/callback');
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(new URL(googleAuthorizeUrl({ clientId: 'c', origin: 'https://almamesh.com', state: 'S', silent: false })).searchParams.has('prompt')).toBe(false);
  });
  it('uploads into one "AlmaMesh backups" folder, created once', async () => {
    const fake = createFakeGoogleFetch();
    const drive = make(fake);
    const name = backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh');
    const bytes = new TextEncoder().encode('age-encryption.org/v1\n');
    await drive.upload(name, { bytes } as SealedBackup);
    await drive.upload(name, { bytes } as SealedBackup);
    expect([...fake.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.folder').map((f) => f.name)).toEqual(['AlmaMesh backups']);
  });
  it('remove trashes rather than deletes', async () => {
    const fake = createFakeGoogleFetch();
    const drive = make(fake);
    const up = await drive.upload(backupNameOf('almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh'), { bytes: new Uint8Array([1]) } as SealedBackup);
    await drive.remove(up.id);
    expect(fake.files.get(up.id)?.trashed).toBe(true);
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });
  it.each([[401, 'token_expired'], [403, 'quota_exceeded'], [429, 'rate_limited'], [500, 'provider_error']] as const)(
    'maps HTTP %i to %s', async (status, kind) => {
      const fake = createFakeGoogleFetch();
      fake.failNext(status);
      await expect(make(fake).list()).rejects.toMatchObject({ kind });
    });
});
```

- [ ] **Step 2: Run and watch it fail.** `bunx vitest run src/lib/drive/googleDrive.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `googleDrive.ts`:

```ts
/** Google Drive v3 REST adapter, scope drive.file. No SDK. Sees only sealed bytes. */
import { type BackupDrive, type DriveBackupEntry, DriveError } from './backupDrive';
import { backupNameOf, parseBackupName } from './backupName';
import { redirectUri } from './providerConfig';

export const FOLDER_NAME = 'AlmaMesh backups';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface GoogleDeps {
  readonly fetch: typeof fetch;
  readonly token: () => Promise<string>;
  readonly navigate: (url: string) => void;
  readonly origin: string;
  readonly clientId: string;
}

export function googleAuthorizeUrl(o: { clientId: string; origin: string; state: string; silent: boolean }): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: o.clientId, redirect_uri: redirectUri(o.origin), response_type: 'token',
    scope: SCOPE, state: o.state, include_granted_scopes: 'false',
    ...(o.silent ? { prompt: 'none' } : {}),
  }).toString();
  return url.toString();
}

function errorFor(res: Response, body: string): DriveError {
  if (res.status === 401) return new DriveError('token_expired', 401);
  if (res.status === 404) return new DriveError('not_found', 404);
  if (res.status === 429) return new DriveError('rate_limited', 429);
  if (res.status === 403 && /storageQuotaExceeded|quotaExceeded/.test(body)) return new DriveError('quota_exceeded', 403);
  if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body)) return new DriveError('rate_limited', 403);
  return new DriveError('provider_error', res.status);
}

export function createGoogleDrive(deps: GoogleDeps): BackupDrive {
  let folderId: string | null = null;

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await deps.token()}`);
    const res = await deps.fetch(url, { ...init, headers });
    if (!res.ok) throw errorFor(res, await res.text());
    return res;
  }

  async function folder(): Promise<string> {
    if (folderId !== null) return folderId;
    const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${FOLDER_NAME}' and trashed=false`);
    const found = (await (await call(`${API}/files?q=${q}&fields=files(id)`)).json()) as { files: { id: string }[] };
    folderId = found.files[0]?.id ?? ((await (await call(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    })).json()) as { id: string }).id;
    return folderId;
  }

  function entry(f: { id: string; name: string; size?: string }): DriveBackupEntry | null {
    const meta = parseBackupName(f.name);
    return meta === null ? null : { id: f.id, name: backupNameOf(f.name), meta, sizeBytes: Number(f.size ?? 0) };
  }

  return {
    provider: 'google-drive',
    connect: async () => 'redirecting', // driveSession owns the redirect (Task 2.5)
    isConnected: async () => true,
    list: async () => {
      const q = encodeURIComponent(`'${await folder()}' in parents and trashed=false`);
      const page = (await (await call(`${API}/files?q=${q}&fields=files(id,name,size)&pageSize=1000`)).json()) as { files: { id: string; name: string; size?: string }[] };
      return page.files.flatMap((f) => entry(f) ?? []);
    },
    upload: async (name, sealed) => {
      const start = await call(UPLOAD, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream' },
        body: JSON.stringify({ name: name.value, parents: [await folder()], mimeType: 'application/octet-stream' }),
      });
      const session = start.headers.get('Location');
      if (session === null) throw new DriveError('provider_error');
      const done = (await (await call(session, { method: 'PUT', body: sealed.bytes })).json()) as { id: string; name: string; size?: string };
      return entry(done) ?? (() => { throw new DriveError('provider_error'); })();
    },
    download: async (id) => new Uint8Array(await (await call(`${API}/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer()),
    remove: async (id) => {
      await call(`${API}/files/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
      });
    },
    disconnect: async () => undefined, // driveSession revokes and deletes the credential
  };
}
```

Then `testing/fakeGoogleFetch.ts`: an in-memory implementation of exactly the calls above (parse `q` for the folder lookup and `'<id>' in parents`; return `Location: https://www.googleapis.com/upload/drive/v3/files?upload_id=<n>` on the resumable POST; store the PUT body; `alt=media` returns bytes; PATCH sets `trashed`; `failNext(status)` makes the next call return that status with body `{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}` for 403). Record every `Request` in `requests`. Assert in the fake that every request carries `Authorization: Bearer` and targets `https://www.googleapis.com` (throw otherwise, so a host slip fails tests).

- [ ] **Step 4: Run and watch it pass.** Expected: contract (4) + specifics pass.
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/googleDrive.ts frontend/apps/web/src/lib/drive/googleDrive.test.ts frontend/apps/web/src/lib/drive/testing/fakeGoogleFetch.ts
git commit -m "feat(drive): Google Drive adapter (drive.file, resumable upload, trash)"
```

### Task 2.5: Drive session (stored token, expiry, silent renewal, disconnect)

**Files:**
- Create: `frontend/apps/web/src/lib/drive/driveSession.ts`
- Test: `frontend/apps/web/src/lib/drive/driveSession.test.ts`

**Interfaces:**
- Consumes: `saveCredential`, `loadCredential`, `deleteCredential` (2.2); `beginSignIn`, `takePendingSignIn`, `readCallback`, `scrubCallbackUrl` (2.3); `googleAuthorizeUrl` (2.4).
- Produces: `createGoogleSession(deps: { credentials: CredentialDeps; fetch: typeof fetch; navigate(url: string): void; origin: string; clientId: string; now(): number })` returning `{ token(): Promise<string>; connect(returnTo: string, silent?: boolean): void; finishCallback(href: string): Promise<{ returnTo: string } | { error: DriveErrorKind; silentFailed: boolean }>; disconnect(): Promise<void>; isConnected(): Promise<boolean> }`. Session key in `sessionStorage` `almamesh-oauth-silent-tried` prevents a second silent attempt per user action.

- [ ] **Step 1: Write the failing test** (cover each line of the spec's token table):

```ts
// driveSession.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoogleSession } from './driveSession';
// reuse the memory rows + generated key helper from credentialStore.test.ts by moving it to
// testing/memoryCredentials.ts in this task (export `memoryDeviceRows()` -> { rows, map }, with
// insertIfAbsent, and `memoryCredentialDeps()` built on it).
import { memoryCredentialDeps } from './testing/memoryCredentials';

beforeEach(() => sessionStorage.clear());

function setup(now = 0) {
  const navigate = vi.fn();
  const fetch = vi.fn(async () => new Response('', { status: 200 }));
  const creds = memoryCredentialDeps();
  const clock = { now };
  const session = createGoogleSession({ credentials: creds.deps, fetch, navigate, origin: 'https://almamesh.com', clientId: 'cid', now: () => clock.now });
  return { session, navigate, fetch, creds, clock };
}

describe('google session', () => {
  it('stores the callback token and reuses it after a reload within the hour', async () => {
    const a = setup(1_000);
    a.session.connect('/settings/data');
    const state = new URL(a.navigate.mock.calls[0][0]).searchParams.get('state');
    await a.session.finishCallback(`https://almamesh.com/oauth/callback#access_token=T1&expires_in=3600&state=${state}`);
    const b = createGoogleSession({ credentials: a.creds.deps, fetch: a.fetch, navigate: a.navigate, origin: 'https://almamesh.com', clientId: 'cid', now: () => 1_000 + 30 * 60_000 });
    expect(await b.token()).toBe('T1');
  });
  it('treats a token within 60 s of expiry as expired and starts ONE silent bounce', async () => {
    const s = setup(0);
    await s.creds.save({ provider: 'google-drive', accessToken: 'T', expiresAt: 3_600_000 });
    s.clock.now = 3_600_000 - 59_000;
    await expect(s.session.token()).rejects.toMatchObject({ kind: 'token_expired' });
    expect(new URL(s.navigate.mock.calls[0][0]).searchParams.get('prompt')).toBe('none');
    await expect(s.session.token()).rejects.toMatchObject({ kind: 'token_expired' });
    expect(s.navigate).toHaveBeenCalledTimes(1);
  });
  it.each(['login_required', 'consent_required', 'interaction_required', 'account_selection_required'])(
    'a silent %s ends in Reconnect, never a second silent try', async (error) => {
      const s = setup();
      s.session.connect('/settings/data', true);
      const state = new URL(s.navigate.mock.calls[0][0]).searchParams.get('state');
      expect(await s.session.finishCallback(`https://almamesh.com/oauth/callback#error=${error}&state=${state}`))
        .toEqual({ error: 'consent_denied', silentFailed: true });
    });
  it('disconnect revokes at Google and deletes the row', async () => {
    const s = setup();
    await s.creds.save({ provider: 'google-drive', accessToken: 'T', expiresAt: 9e15 });
    await s.session.disconnect();
    expect(s.fetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/revoke', expect.objectContaining({ method: 'POST' }));
    expect(s.creds.map.size).toBe(0);
  });
  it('a replayed callback URL is refused', async () => {
    const s = setup();
    s.session.connect('/settings/data');
    const state = new URL(s.navigate.mock.calls[0][0]).searchParams.get('state');
    const href = `https://almamesh.com/oauth/callback#access_token=T&expires_in=3600&state=${state}`;
    await s.session.finishCallback(href);
    expect(await s.session.finishCallback(href)).toMatchObject({ error: 'consent_denied' });
  });
});
```

- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement** `driveSession.ts`:

```ts
/** Google token lifecycle: stored (encrypted), 60 s skew, one prompt=none bounce per user action. */
import { DriveError, type DriveErrorKind } from './backupDrive';
import { type CredentialDeps, deleteCredential, loadCredential, saveCredential } from './credentialStore';
import { googleAuthorizeUrl } from './googleDrive';
import { beginSignIn, readCallback, scrubCallbackUrl, takePendingSignIn } from './oauthRedirect';

const SKEW_MS = 60_000;
const SILENT_TRIED = 'almamesh-oauth-silent-tried';

export interface GoogleSessionDeps {
  readonly credentials: CredentialDeps;
  readonly fetch: typeof fetch;
  readonly navigate: (url: string) => void;
  readonly origin: string;
  readonly clientId: string;
  readonly now: () => number;
}

export function createGoogleSession(deps: GoogleSessionDeps) {
  function connect(returnTo: string, silent = false): void {
    if (silent) sessionStorage.setItem(SILENT_TRIED, '1');
    const state = beginSignIn('google-drive', returnTo);
    deps.navigate(googleAuthorizeUrl({ clientId: deps.clientId, origin: deps.origin, state, silent }));
  }

  async function token(): Promise<string> {
    const stored = await loadCredential('google-drive', deps.credentials);
    if (stored?.accessToken !== undefined && stored.expiresAt - SKEW_MS > deps.now()) return stored.accessToken;
    if (stored !== null && sessionStorage.getItem(SILENT_TRIED) === null) {
      connect(location.pathname, true);
    }
    throw new DriveError(stored === null ? 'not_connected' : 'token_expired');
  }

  async function finishCallback(href: string): Promise<{ returnTo: string } | { error: DriveErrorKind; silentFailed: boolean }> {
    const result = readCallback(href);
    if (typeof history !== 'undefined') scrubCallbackUrl();
    const silentFailed = sessionStorage.getItem(SILENT_TRIED) !== null;
    try {
      const pending = takePendingSignIn(result.state ?? '', deps.now());
      if (result.error !== undefined || result.accessToken === undefined) {
        return { error: 'consent_denied', silentFailed };
      }
      await saveCredential({ provider: 'google-drive', accessToken: result.accessToken,
        expiresAt: deps.now() + (result.expiresIn ?? 3600) * 1000 }, deps.credentials);
      sessionStorage.removeItem(SILENT_TRIED);
      return { returnTo: pending.returnTo };
    } catch {
      return { error: 'consent_denied', silentFailed };
    }
  }

  async function disconnect(): Promise<void> {
    const stored = await loadCredential('google-drive', deps.credentials);
    await deleteCredential('google-drive', deps.credentials);
    if (stored?.accessToken !== undefined) {
      await deps.fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: stored.accessToken }),
      }).catch(() => undefined);
    }
  }

  return { token, connect, finishCallback, disconnect,
    isConnected: async () => (await loadCredential('google-drive', deps.credentials)) !== null };
}
```

`SILENT_TRIED` is cleared on a successful callback and when the user presses any drive button (Task 3.2 calls `sessionStorage.removeItem('almamesh-oauth-silent-tried')` at the start of each user action). That gives "one silent try per user action".

- [ ] **Step 4: Run and watch it pass.**
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/drive/driveSession.ts frontend/apps/web/src/lib/drive/driveSession.test.ts frontend/apps/web/src/lib/drive/testing/memoryCredentials.ts frontend/apps/web/src/lib/drive/credentialStore.test.ts
git commit -m "feat(drive): Google session with stored token and one silent prompt=none renewal"
```

### Task 2.6: Callback route, SW allowlist, CSP and the egress test

**Files:**
- Create: `frontend/apps/web/src/pages/OAuthCallback.tsx`, `frontend/apps/web/src/lib/__tests__/connectSrc.test.ts`, `frontend/apps/web/src/lib/drive/__tests__/driveEgress.test.ts`, `frontend/apps/web/src/pages/__tests__/OAuthCallback.test.tsx`
- Modify: `frontend/apps/web/src/App.tsx` (lazy route next to line 167, before `*`), `frontend/apps/web/public/_redirects` (add `/oauth/callback / 200`), `frontend/apps/web/vite.config.ts` (`navigateFallbackAllowlist` ~line 352: add `/^\/oauth\/callback\/?$/`), `frontend/apps/web/public/_headers` (CSP line 70 + justification comment block), `frontend/apps/web/src/lib/previewHeaders.test.ts` (fix the stale comment pointing at a non-existent `securityHeaders.test.ts`, now `connectSrc.test.ts`)

**Interfaces:**
- Consumes: `createGoogleSession` (2.5), `driveBackupEnabled` (2.3), `cspFromHeadersFile` (existing `src/lib/previewHeaders.ts`).
- Produces: `OAuthCallback` page component (named export), and `createDriveForCurrentOrigin(): { drive: BackupDrive; session }` in `frontend/apps/web/src/lib/drive/index.ts` (the one production wiring point; only Task 3.2 imports it).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/connectSrc.test.ts
// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cspFromHeadersFile } from '../previewHeaders';

const here = path.dirname(fileURLToPath(import.meta.url));
const csp = cspFromHeadersFile(readFileSync(path.resolve(here, '../../../public/_headers'), 'utf-8'));
const connectSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src '))!.split(/\s+/).slice(1);

describe('connect-src is a closed, exact allowlist', () => {
  it('equals the declared list exactly', () => {
    expect(connectSrc).toEqual([
      "'self'", 'https://openrouter.ai', 'https://geocoding-api.open-meteo.com',
      'https://www.googleapis.com', 'https://oauth2.googleapis.com',
      'http://localhost:*', 'http://127.0.0.1:*',
    ]);
  });
  it('has no scheme or wildcard-host source', () => {
    for (const src of connectSrc) expect(src).not.toMatch(/^(https?:|\*|https:\/\/\*)/);
  });
});
```

`driveEgress.test.ts`: build a Google drive on `createFakeGoogleFetch()`, seal a real canonical-shaped payload containing canaries with the real `sealBackup` (from `@almamesh/store`) using passphrase `canary-passphrase-123`, store a credential holding token `ya29.CANARY-TOKEN`, then run upload, list, download, remove and disconnect through `guardedDrive`. Assert over `fake.requests`:

```ts
const CANARIES = ['Zyxwv Canary', '1987-03-14', 'Qwertyville', 'sk-canary-0123', 'canary-passphrase-123'];
for (const req of fake.requests) {
  const url = new URL(req.url);
  expect(['https://www.googleapis.com', 'https://oauth2.googleapis.com']).toContain(url.origin);
  for (const c of CANARIES) expect(req.url + JSON.stringify([...req.headers])).not.toContain(c);
  const body = new Uint8Array(await req.clone().arrayBuffer());
  if (body.length === 0) continue;
  const text = new TextDecoder().decode(body);
  if (text.startsWith('{')) {
    expect(Object.keys(JSON.parse(text)).every((k) => ['name', 'parents', 'mimeType', 'trashed'].includes(k))).toBe(true);
  } else if (url.origin === 'https://oauth2.googleapis.com') {
    expect(text).toBe('token=ya29.CANARY-TOKEN');
  } else {
    expect(text.startsWith('age-encryption.org/v1\n')).toBe(true);
    expect(text.startsWith('SQLite format 3\0')).toBe(false);
  }
  for (const c of CANARIES) {
    expect(text).not.toContain(c);
    expect(new TextDecoder('utf-16le').decode(body)).not.toContain(c);
  }
}
const withToken = fake.requests.filter((r) => (r.headers.get('Authorization') ?? '').includes('ya29.CANARY-TOKEN'));
expect(withToken.every((r) => r.url.startsWith('https://www.googleapis.com/'))).toBe(true);
```

Also assert `fake.requests.length === 0` after constructing the drive and before `upload` (no request before use).

`OAuthCallback.test.tsx`: render at `/oauth/callback#access_token=T&expires_in=3600&state=<pending>` with an injected session; assert it navigates to `returnTo` and `location.hash` is empty afterwards; for a mismatched state assert the text "That sign-in didn't come from this tab. Try again." is shown.

- [ ] **Step 2: Run and watch them fail.** `bunx vitest run src/lib/__tests__/connectSrc.test.ts src/lib/drive/__tests__/driveEgress.test.ts src/pages/__tests__/OAuthCallback.test.tsx`. Expected: connect-src FAIL (Google hosts missing), others FAIL (modules missing).

- [ ] **Step 3: Implement.**
  - `_headers`: insert ` https://www.googleapis.com https://oauth2.googleapis.com` after `https://geocoding-api.open-meteo.com` in the CSP, and add to the comment block:
    ```
    #   https://www.googleapis.com          opt-in cloud drive backup (Google Drive v3,
    #                                       scope drive.file). Only the passphrase-sealed
    #                                       age file and a neutral filename are sent.
    #   https://oauth2.googleapis.com       token revoke on Disconnect.
    ```
  - `OAuthCallback.tsx`: reads `window.location.href` in a `useLayoutEffect` before children render, calls `session.finishCallback(href)`, then `navigate(returnTo, { replace: true })`, or shows the error text and a "Back to settings" link. Add `<meta name="robots" content="noindex">` via the existing page head pattern (check `pages/legal/LegalPageLayout.tsx` for how head tags are set).
  - `App.tsx`: `const OAuthCallbackPage = lazyWithRetry(() => import('./pages/OAuthCallback').then((m) => ({ default: m.OAuthCallback })), 'OAuthCallback')` and `<Route path="/oauth/callback" element={page(<OAuthCallbackPage />)} />`. Confirm `sitemap.xml` and `prerender-entry.tsx` do not list it.
  - `lib/drive/index.ts`: `createDriveForCurrentOrigin()` builds `guardedDrive(createGoogleDrive({ fetch: window.fetch.bind(window), token: session.token, navigate: (u) => window.location.assign(u), origin: location.origin, clientId: GOOGLE_CLIENT_ID }))`.

- [ ] **Step 4: Run and watch them pass.** Then `cd frontend/apps/web && bun run build && node scripts/verify-precache-redirect.mjs` (the new route must not add a redirecting precache key).
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/pages/OAuthCallback.tsx frontend/apps/web/src/pages/__tests__/OAuthCallback.test.tsx frontend/apps/web/src/App.tsx frontend/apps/web/public/_redirects frontend/apps/web/vite.config.ts frontend/apps/web/public/_headers frontend/apps/web/src/lib/__tests__/connectSrc.test.ts frontend/apps/web/src/lib/previewHeaders.test.ts frontend/apps/web/src/lib/drive/__tests__/driveEgress.test.ts frontend/apps/web/src/lib/drive/index.ts
git commit -m "feat(drive): OAuth callback route, Google CSP hosts, exact connect-src pin, egress test"
```

### Task 2.7: Start fresh deletes drive rows and the device key (CF3)

This must merge in PR 2, because Task 2.2 is the first code that writes a `drive-credential/*`
row. Today "Start fresh" only commits a canonical generation (`lib/resetEverything.ts:153`,
`clearPersisted` → `commitDatasetGeneration`), so every `device` row survives it.

**Files:**
- Modify: `frontend/apps/web/src/lib/resetEverything.ts`. In `ResetEverythingDeps` (~line 111) add `clearDriveState?: () => Promise<void>`. In `DEFAULT_DEPS`: `clearDriveState: async () => { if (supportsPortableState()) await deleteDriveDeviceRows(); await deleteDeviceKey(); }`. Call it right after `await deps.clearSetAside?.();` (before the generation commit: a crash after it leaves less data, never more, matching the set-aside rule). Add "stored drive sign-in and drive settings (credentials, the device key)" to the header's CLEARED list and "this device's backup code" to PRESERVED.
- Modify: `frontend/apps/web/src/lib/drive/credentialStore.ts`: add `deleteDriveDeviceRows(deps?)`, which removes every device row whose key starts with `drive-` (covers `drive-credential/*` now, and `drive-last-backup/*`, `drive-recipient/*` and `drive-auto/*` from later PRs). It keeps `device-code`.
- Test: `frontend/apps/web/src/lib/resetEverything.test.ts`, `frontend/packages/store/src/portableState.test.ts`, `frontend/apps/web/src/lib/resetAppData.test.ts`

- [ ] **Step 1: Write the failing tests.** Each reads storage back; none just spies on calls.

```ts
// resetEverything.test.ts: wire the real credential store to an in-memory DeviceRows and a
// fake-indexeddb device key, run the real DEFAULT clearDriveState through resetEverything's deps.
it('Start fresh leaves no drive rows and no device key, and keeps the device code (CF3)', async () => {
  const { rows, map } = memoryDeviceRows(); // the shared helper from testing/memoryCredentials.ts
  map.set('device-code', '7f3a2c');
  await saveCredential({ provider: 'google-drive', accessToken: 'ya29.CANARY', expiresAt: 9e15 }, { rows, key: getDeviceKey });
  map.set('drive-last-backup/google-drive', '2026-10-10T18:04:05.123Z');

  await resetEverything({ ...testDeps(), clearDriveState: async () => { await deleteDriveDeviceRows({ rows, key: getDeviceKey }); await deleteDeviceKey(); } });

  expect([...map.keys()]).toEqual(['device-code']);
  expect(await readDeviceKeyRecords()).toEqual([]);
});
it('the default deps include clearDriveState', () => {
  expect(DEFAULT_RESET_DEPS.clearDriveState).toBeTypeOf('function'); // export DEFAULT_DEPS as DEFAULT_RESET_DEPS for this
});
```

```ts
// portableState.test.ts: the namespace really is outside the generation commit, which is why
// the explicit delete is needed. Pins the premise so nobody "simplifies" Task 2.7 away.
it('a canonical generation commit does not touch device rows', async () => {
  const sqlite = new MemorySqliteStore();
  const repository = new PortableStateRepository(sqlite);
  await repository.writeDevice('drive-credential/google-drive', 'sealed');
  await repository.transact(async () => [{ type: 'delete', key: 'almamesh-profiles' }]); // use the file's existing generation helper if transact's shape differs
  expect(await repository.readDevice('drive-credential/google-drive')).toBe('sealed');
});
```

Add to `resetAppData.test.ts`: with `almamesh-device-keys` present in the faked `indexedDB.databases()`, it is among the deleted names.

Use the file's existing deps factory (check its name at the top of `resetEverything.test.ts`) in place of `testDeps()`.

- [ ] **Step 2: Run and watch them fail.** `bunx vitest run src/lib/resetEverything.test.ts` (FAIL: `credential` row still present; `clearDriveState` undefined). The `portableState` premise test should PASS at once. It documents behaviour; it is not a red test.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run and watch them pass.**
- [ ] **Step 5: Commit**

```bash
git add frontend/apps/web/src/lib/resetEverything.ts frontend/apps/web/src/lib/resetEverything.test.ts frontend/apps/web/src/lib/drive/credentialStore.ts frontend/packages/store/src/portableState.test.ts frontend/apps/web/src/lib/resetAppData.test.ts
git commit -m "fix(drive): Start fresh deletes drive rows and the device key, keeps the device code"
```

### Task 2.8: PR 2 close-out

- [ ] **Step 1: Mutation red runs** (paste red output, then revert):

| Mutation | Must go red |
|---|---|
| Google adapter PUTs `exported.bytes` (simulate: in `driveEgress.test.ts` setup, pass the plaintext SQLite through a forged `SealedBackup` with `guardedDrive` bypassed) | `driveEgress.test.ts` |
| `credentialStore.saveCredential` writes `JSON.stringify(c)` unencrypted | `credentialStore.test.ts` |
| `deviceKey` generates with `extractable: true` | `deviceKey.test.ts` |
| `takePendingSignIn` skips the state comparison | `oauthRedirect.test.ts`, `driveSession.test.ts` replay test |
| `driveSession.token` drops the `SILENT_TRIED` check | `driveSession.test.ts` ("ONE silent bounce") |
| Add `https:` to `connect-src` in `_headers` | `connectSrc.test.ts` |
| CF1: `guardedDrive.remove` forwards every id (drop the `removable` check) | `guardedDrive.test.ts` ownership tests |
| CF2: `getDeviceCode` goes back to `read` → `write(mintCode())` | `deviceRows.test.ts` race test |
| CF3: drop `clearDriveState` from `DEFAULT_DEPS` | `resetEverything.test.ts` storage read-back |
| Upload metadata adds `description: passphrase` | `driveEgress.test.ts` |

- [ ] **Step 2: Live checks.**
  - Flag is off: `grep -rn "createDriveForCurrentOrigin" frontend/apps/web/src --include='*.ts*' | grep -v test` shows only its definition (no production caller yet, by design until PR 3). Build, preview, and drive real onboarding: dashboard renders, clean console. Open `/oauth/callback` directly: the error card shows, clean console, no redirect loop.
  - **Real Google (needs harish_actions 53–54):** once `GOOGLE_CLIENT_ID` exists, build with `VITE_DRIVE_BACKUP=1`, preview on `localhost:4173`, and from the browser console call the session `connect('/settings/data')` via the hooked build. Confirm the real consent screen shows `drive.file` only, the callback stores a token, a reload doesn't redirect, and an hour-expired row (edit `expiresAt` via the hook) bounces with `prompt=none` and no screen. Record the error Google sends with two accounts signed in. If 53–54 aren't done, write "Real Google: unverified, waiting on harish_actions 53–54" in the PR.
- [ ] **Step 3: Full gate.** `make gate`.
- [ ] **Step 4: PR, northstar A, merge, cleanup.**

---

# PR 3: Google UI, safety copy to the drive, and the privacy claim

Branch: `feat/drive-backup-3-ui`. Claim: "Your data stays on your device unless you choose the optional AI or encrypted cloud backup." **External: harish_actions 53–54 are required before merge** (the real round trip is a merge condition).

### Task 3.1: `useBackupRestore` accepts drive bytes and a drive safety target

**Files:**
- Modify: `frontend/apps/web/src/hooks/useBackupRestore.ts` (`BackupRestoreOptions` ~line 49; `BackupRestore` ~line 54; `confirm()` ~line 259 where `openBackupSaveTarget(...)` is called)
- Test: `frontend/apps/web/src/hooks/__tests__/useBackupRestore.drive.test.tsx`

**Interfaces:**
- Produces: `BackupRestoreOptions.safetyTarget?: (suggestedName: string) => BackupSaveTarget`; `BackupRestore.stageContent(content: BackupFileContent): Promise<void>` (the same `stageFile` path `chooseFile` uses, so the passphrase prompt, preview and safety copy all apply).

- [ ] **Step 1: Failing test.** Render the hook with `safetyTarget` returning a recording target `{ choice: Promise.resolve('chosen'), write: vi.fn(async () => 'saved'), discard: vi.fn() }`; call `stageContent(sealedBytes)` with a real sealed export (build one with `buildBackupExport('drive test passphrase', overrideWithFixture)`, following `backupService.test.ts`); unlock with the passphrase; call `confirm()`; assert `write` received bytes starting with `age-encryption.org/v1` and that `openBackupSaveTarget` was **not** called (spy on the module).
- [ ] **Step 2: Run, watch it fail.**
- [ ] **Step 3: Implement.** Expose `stageContent: (c) => stageFile(c)` and in `confirm()` replace the `openBackupSaveTarget(...)` call with `(options.safetyTarget ?? openBackupSaveTarget)(safetyBackupFilename(exportBackupFilename()))`.
- [ ] **Step 4: Run, watch it pass,** plus the existing `useBackupRestore` and `DataSettings` tests unchanged.
- [ ] **Step 5: Commit** `git add` the hook and its test; message `feat(backup): restore hook takes drive bytes and a pluggable safety target`.

### Task 3.2: `useDriveBackup`

**Files:**
- Create: `frontend/apps/web/src/hooks/useDriveBackup.ts`, `frontend/apps/web/src/lib/drive/driveSafetyTarget.ts`
- Test: `frontend/apps/web/src/hooks/__tests__/useDriveBackup.test.tsx`

**Interfaces:**
- Consumes: `buildBackupExport(passphrase)` (`lib/backupService.ts:217`), `sealedBackupOf`, `buildBackupName`, `getDeviceCode`, `planPrune`, `BackupDrive`.
- Produces: `useDriveBackup(drive: BackupDrive | null)` → `{ connected: boolean; entries: readonly DriveBackupEntry[] | null; status: 'idle' | 'sealing' | 'uploading' | 'verifying' | 'done' | 'error'; error: DriveErrorKind | 'verify_failed' | null; lastBackupAt: Date | null; backUp(passphrase: string): Promise<void>; refresh(): Promise<void>; download(id: string): Promise<Uint8Array>; trash(id: string): Promise<void>; connect(): void; disconnect(): Promise<void> }`. `openDriveSafetyTarget(drive, ua, deviceCode): (suggestedName: string) => BackupSaveTarget` (ignores the suggested local name, builds a neutral drive name, uploads on `write`, returns `'saved'` only after read-back).
- Session passphrase: kept in a module-level `let` inside `useDriveBackup.ts` (memory only, tab lifetime). Never written anywhere.

- [ ] **Step 1: Failing tests** against `createFakeDrive()`:

```ts
it('seals with the passphrase, uploads, verifies by read-back, then prunes this device only', async () => { /* 12 prior own + 3 other-device files; after backUp: 10 own kept, others untouched, status 'done' */ });
it('does not prune when read-back differs', async () => { /* wrap fake.download to flip a byte; expect error 'verify_failed' and no trashed files */ });
it('never uploads when sealing fails', async () => { /* passphrase 'short'; expect fake.files.size unchanged */ });
it('the uploaded name carries no profile name', async () => { /* seed profile "Zyxwv Canary"; expect every fake file name to match BACKUP_NAME_PATTERN and not contain "Zyxwv" */ });
it('clears the silent-renew marker at the start of each user action', async () => { /* sessionStorage almamesh-oauth-silent-tried set; backUp(); expect removed */ });
it('offline: backUp rejects offline without sealing', async () => { /* navigator.onLine=false via guardedDrive isOnline */ });
```

Write each body in full in the test file (fixtures: `buildBackupExport` override from `backupService.test.ts`, `crypto.subtle.digest('SHA-256', …)` for comparison).

- [ ] **Step 2: Run, watch them fail.**
- [ ] **Step 3: Implement** `backUp`: clear the silent marker → `status='sealing'` → `buildBackupExport(passphrase)` → `sealedBackupOf(content)` → `status='uploading'` → `drive.upload(buildBackupName(new Date(), navigator.userAgent, await getDeviceCode()), sealed)` → `status='verifying'` → `drive.download(id)` and compare SHA-256 → on match `planPrune(await drive.list(), code, id)` then `drive.remove` each → `status='done'`, `lastBackupAt`. Store `lastBackupAt` per provider in device rows (`drive-last-backup/<provider>`, plain ISO time, not secret) for the nudge.
- [ ] **Step 4: Run, watch them pass.**
- [ ] **Step 5: Commit** hook, safety target, tests: `feat(drive): back up, verify by read-back, prune own device`.

### Task 3.3: Settings → Data UI

**Files:**
- Create: `frontend/apps/web/src/components/features/backup/drive/DriveBackupPanel.tsx`, `DrivePassphraseSetup.tsx`, `DriveBackupList.tsx`
- Modify: `frontend/apps/web/src/pages/settings/DataSettings.tsx` (render `<DriveBackupPanel />` between the export and import sections, ~line 205), `frontend/apps/web/src/locales/{en,es,pt}/settings.json` (`backup.drive.*` keys; also change `backup.subtitle` "Nothing is uploaded." to "Nothing is uploaded unless you back up to your own cloud drive, and then only as an encrypted file.")
- Test: `frontend/apps/web/src/components/features/backup/drive/__tests__/DriveBackupPanel.test.tsx`

**Behaviour to test (one `it` each, Testing Library, fake drive injected via a `drive` prop):**
1. Hidden entirely when `driveBackupEnabled(location.origin)` is false.
2. Not connected: shows the explainer text and a "Connect Google Drive" button.
3. First backup on this device: passphrase twice plus the required checkbox "I understand that if I forget this passphrase, nobody can open these backups. Not AlmaMesh, not Google."; the Back up button stays disabled until both match, are ≥12 characters, and the box is ticked.
4. Second backup in the same tab: no passphrase prompt.
5. Offline: both buttons disabled with "You're offline. Your data is safe on this device. Back up when you're back online."
6. List: newest first; "Chrome on macOS · 7f3a2c (this device)"; local time; size in MB; a Restore button on every row; a Trash button only on this device's rows (CF1: `guardedDrive.remove` refuses the others); Trash asks to confirm.
7. Each `DriveErrorKind` shows its sentence from the spec (`quota_exceeded`: "Your Google Drive is full. Free some space or trash old AlmaMesh backups.", `token_expired`/`not_connected`: "Reconnect", `verify_failed`: "Uploaded, but the check failed. Try again.").
8. Restore → `restore.stageContent(bytes)` with `useBackupRestore({ afterRestoreHref: '/dashboard', safetyTarget: openDriveSafetyTarget(...) })`; the confirm dialog offers "Save to this device instead" which swaps to `openBackupSaveTarget`.
9. "Last drive backup: 12 days ago" when `lastBackupAt` is 12 days old.
10. Disconnect button deletes the credential (assert via the memory credential deps).

- [ ] **Step 1: Write the 10 failing tests.** **Step 2:** run, see red. **Step 3:** implement the three components with existing `components/ui/` primitives (check `DataSettings.tsx` imports for the button, dialog and input components used there). Every string through `t('backup.drive.…')` in en/es/pt. **Step 4:** run green; run `frontend-quality`. **Step 5:** commit the components, tests, `DataSettings.tsx` and the three `settings.json` files: `feat(drive): Settings → Data back up to and restore from Google Drive`.

### Task 3.4: First-run entry points

**Files:**
- Modify: `frontend/apps/web/src/components/features/backup/RestoreFromBackup.tsx` (add a "From Google Drive" button beside the existing file restore, shown only when `driveBackupEnabled`; it connects with `returnTo='/?restore=drive'` and, on return, opens `DriveBackupList` in restore-only mode), `frontend/apps/web/src/components/features/landing/Hero.tsx` and `frontend/apps/web/src/pages/Onboarding.tsx` (no change if they already render `RestoreFromBackup`; confirm)
- Test: `frontend/apps/web/src/components/features/backup/__tests__/RestoreFromBackup.test.tsx` (extend)

- [ ] Steps 1–5 as above: failing test that the drive button appears with the flag on and not with it off, and that `?restore=drive` with a connected fake drive shows the list. Implement, pass, commit `feat(drive): restore from Google Drive on the landing page and onboarding`.

### Task 3.5: Privacy copy, CLAUDE.md, README

**Files:**
- Modify: `frontend/apps/web/src/locales/{en,es,pt}/legal.json` (`privacy.s1_*` one sentence; new `privacy.s2_li8`; `privacy.s6_*` retention sentence; `data_deletion.*` reset vs drive backups and how to delete them), `frontend/apps/web/src/pages/legal/PrivacyPolicy.tsx` (render `s2_li8`), `frontend/apps/web/src/pages/legal/DataDeletion.tsx`, `frontend/apps/web/src/locales/landing.privacyCopy.test.ts`, `CLAUDE.md` (egress paragraph: "TWO" → "THREE" with item (3) exactly as the spec's "Exact changes" table; plus the R0 exception line next to the SQLite rule), `README.md` (network inventory row)
- Test: `landing.privacyCopy.test.ts`, `legal.parity.test.ts`, a new `src/locales/__tests__/driveDisclosure.test.ts`

- [ ] **Step 1: Failing tests.**

```ts
// driveDisclosure.test.ts
import { describe, expect, it } from 'vitest';
import en from '../en/legal.json'; import es from '../es/legal.json'; import pt from '../pt/legal.json';
import enS from '../en/settings.json'; import esS from '../es/settings.json'; import ptS from '../pt/settings.json';

const ENCRYPTED = { en: /encrypt|locked/i, es: /cifrad|encriptad|bloquead/i, pt: /criptografad|cifrad|bloquead/i };
const DRIVE = /drive|dropbox|onedrive|nube|nuvem|cloud/i;

function strings(o: unknown): string[] {
  return typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : [];
}

describe('drive backup disclosure', () => {
  it.each([['en', en, enS], ['es', es, esS], ['pt', pt, ptS]] as const)('%s: every drive mention says encrypted', (lang, legal, settings) => {
    for (const s of [...strings(legal), ...strings(settings)].filter((x) => DRIVE.test(x))) {
      expect(s, s).toMatch(ENCRYPTED[lang]);
    }
  });
  it('the privacy policy lists the drive as a network touchpoint in every locale', () => {
    for (const l of [en, es, pt]) expect((l as { privacy: Record<string, string> }).privacy.s2_li8).toBeTruthy();
  });
});
```

Also extend `landing.privacyCopy.test.ts`: no locale string may say backups are kept "on our servers" (`/our servers|nuestros servidores|nossos servidores/` together with a backup word must not match).

- [ ] **Step 2:** run, red. **Step 3:** write the copy (en authoritative, es/pt translated). **Step 4:** green, including `legal.parity.test.ts`. **Mutation for the PR body:** remove "cifrada" from the es `s2_li8` and show `driveDisclosure.test.ts` red.
- [ ] **Step 5: Commit** the locale files, the two legal pages, the tests, `CLAUDE.md` and `README.md`: `docs(privacy): disclose encrypted cloud drive backup as the third egress`.

### Task 3.6: Stubbed browser journey in CI

**Files:**
- Create: `frontend/apps/web/e2e/driveFake.ts` (Playwright `context.route` stubs: `https://accounts.google.com/o/oauth2/v2/auth**` → 302 to `/oauth/callback#access_token=e2e-token&expires_in=3600&state=<state from the request>`, or `#error=interaction_required` when `prompt=none` and the test set `silentFails`; `https://www.googleapis.com/**` → an in-memory Drive shared across contexts in the same test, mirroring `fakeGoogleFetch`; records every request with body), `frontend/apps/web/e2e/drive-backup.spec.ts`, `frontend/apps/web/playwright.drive-backup.config.ts` (copy `playwright.first-run-restore.config.ts`, `testMatch: /drive-backup\.spec\.ts/`, env `DRIVE_BACKUP_E2E_BASE_URL`)
- Modify: `frontend/apps/web/package.json` (`"test:e2e:drive-backup": "playwright test --config=playwright.drive-backup.config.ts"`), `dagger/src/index.ts` (`browserJourneys()` ~line 490: add `"DRIVE_BACKUP_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:drive-backup --project=chromium"`; the hooked build must be built with `VITE_DRIVE_BACKUP=1` and a test `GOOGLE_CLIENT_ID`: add `VITE_GOOGLE_CLIENT_ID_OVERRIDE` read by `providerConfig.ts` only when `VITE_EXIT_GATE_HOOKS === '1'`), the WebKit macOS lane script `frontend/apps/web/scripts/webkit-macos-lane.sh` (add the same suite for WebKit)

**Journey (one test, uses `portableInvariants.helpers.ts`: `onboard`, `expectDashboardChart`, `watchBrowser`, `expectCleanBrowser`, `fakeThirdParties`):**
1. Context A: onboard "Zyxwv Canary", born 1987-03-14 in a city the fake geocoder returns as "Qwertyville". Settings → Data → Connect Google Drive (stubbed consent) → passphrase twice + checkbox → Back up → "Backed up to Google Drive".
2. Reload A: still connected, no navigation to `accounts.google.com` (assert from the recorded requests).
3. Context B (fresh "device"): `/` → Restore from a backup → From Google Drive → list shows one row "… (Chrome on …)" without "(this device)" → Restore → passphrase → confirm (empty device, no safety copy) → dashboard shows "Zyxwv Canary".
4. Every recorded request to `www.googleapis.com` passes the same ciphertext and canary checks as `driveEgress.test.ts` (move the checker into `e2e/driveFake.ts` as `assertDriveEgress(requests)`).
5. Clean console in both contexts.
6. Silent renewal: in A, set the stored token's `expiresAt` to the past via the hooked `window.__almameshExpireDriveToken()`; press Back up; assert one navigation with `prompt=none` and back, then success. With `silentFails`, assert the Reconnect button and no second `prompt=none` request.

- [ ] **Step 1:** write the spec; run against a hooked preview and watch it fail (no UI wiring yet if run before 3.3/3.4, otherwise fail on the missing hooks). **Step 2–4:** add the hooks and config until green in Chromium; run the WebKit lane locally on macOS (`bash scripts/webkit-macos-lane.sh`) and record the result. **Step 5: Commit** the e2e files, config, package.json, dagger and lane changes: `test(drive): stubbed two-device Google Drive journey in CI`.

### Task 3.7: Real Google round trip (manual trigger)

**Files:**
- Create: `frontend/apps/web/e2e/live/drive-google.live.spec.ts`, `frontend/apps/web/playwright.drive-google-live.config.ts` (persistent context at `process.env.DRIVE_GOOGLE_PROFILE ?? ~/.almamesh-e2e/google-profile`, headed allowed, `baseURL` from `DRIVE_GOOGLE_BASE_URL` defaulting to `http://localhost:4173`)
- Modify: `frontend/apps/web/package.json`: `"e2e:drive:google:login": "playwright test --config=playwright.drive-google-live.config.ts --grep @login --headed"`, `"e2e:drive:google:live": "playwright test --config=playwright.drive-google-live.config.ts --grep @live"`

**Depends on harish_actions 53–54.**

Steps in `@live`: connect (real consent; already granted via `@login`), back up, list via the Drive API with the stored token and assert the name matches `BACKUP_NAME_PATTERN`, restore in a second persistent context logged in to the same account (proves `drive.file` cross-device visibility), compare the dashboard, record a HAR (`recordHar`) and run `assertDriveEgress` over it, expire the token and observe the silent bounce, Disconnect and assert the revoke returned 200, trash the file, clean console. Save screenshots of the list, the restored dashboard and the Drive folder (`page.goto('https://drive.google.com/drive/search?q=almamesh-backup')`) to `test-results/drive-google-live/`.

- [ ] Write it, run `@login` once (owner), run `@live` against local preview, then against `https://almamesh.com` after merge. Commit the spec, config and scripts: `test(drive): real Google Drive round trip (manual trigger)`.

### Task 3.8: Turn the flag on and close out PR 3

- [ ] **Step 1:** set `VITE_DRIVE_BACKUP=1` for production builds (the repo's production build env file or the Pages build config; find where `VITE_` vars are set for production with `grep -rn "VITE_" frontend/apps/web/.env* dagger/src/*.ts .github/workflows/*.yml`), and fill `GOOGLE_CLIENT_ID` from step 53.
- [ ] **Step 2: Mutation red runs:**

| Mutation | Must go red |
|---|---|
| `useDriveBackup.backUp` prunes before verifying | `useDriveBackup.test.ts` |
| `useDriveBackup` uploads `exported.bytes` | `useDriveBackup.test.ts` + `drive-backup.spec.ts` egress check |
| Remove "cifrada" from es `privacy.s2_li8` | `driveDisclosure.test.ts` |
| Panel ignores `driveBackupEnabled` | `DriveBackupPanel.test.tsx` |
| Safety copy always uses `openBackupSaveTarget` | `useBackupRestore.drive.test.tsx` |

- [ ] **Step 3: Live end-to-end.** Stubbed: `bun run test:e2e:drive-backup` green in Chromium (CI) and WebKit (macOS lane). Real: `bun run e2e:drive:google:live` green against local preview with the evidence files listed in 3.7. Real onboarding without hooks: build, preview, onboard, back up to the real drive, restore in a second browser profile. Reachable from Settings → Data, the landing Hero and Onboarding.
- [ ] **Step 4:** `make gate`. **Step 5:** PR, northstar A, merge, deploy, run `@live` against `https://almamesh.com`, confirm the deployed `build.json` SHA equals the merge SHA, cleanup.

---

# PR 4: Dropbox

Branch: `feat/drive-backup-4-dropbox`. Claims: same as PR 2 for a new host; "connect once per device". **External: harish_actions 55.**

### Task 4.1: `oauthClient.ts` (the only `oauth4webapi` importer)

**Files:**
- Modify: `frontend/apps/web/package.json` (`bun add oauth4webapi@3.8.8` in `frontend/apps/web`; stage `package.json` and `frontend/bun.lock`)
- Create: `frontend/apps/web/src/lib/drive/oauthClient.ts`
- Test: `frontend/apps/web/src/lib/drive/oauthClient.test.ts`

**Interfaces:**
- Produces: `interface PkceProvider { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; scope: string; extraAuthParams?: Record<string,string> }`; `startPkce(p: PkceProvider, origin: string, state: string): Promise<{ url: string; verifier: string }>`; `redeemCode(p, origin, code, verifier, fetchImpl?): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }>`; `refresh(p, refreshToken, fetchImpl?): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }>`; errors map `invalid_grant` → `DriveError('not_connected')`.

- [ ] **Step 1: Failing tests:** `startPkce` URL has `code_challenge_method=S256`, a 43-char `code_challenge`, `response_type=code`, the redirect URI, and the extra params; `redeemCode` posts `grant_type=authorization_code`, `code_verifier`, `client_id`, and no `client_secret` (inspect the recorded request body); `refresh` posts `grant_type=refresh_token`; `invalid_grant` maps to `not_connected`.
- [ ] **Step 2:** red. **Step 3:** implement with `oauth4webapi`: `generateRandomCodeVerifier`, `calculatePKCECodeChallenge`, `authorizationCodeGrantRequest` / `processAuthorizationCodeResponse`, `refreshTokenGrantRequest` / `processRefreshTokenResponse`, using `{ client_id, token_endpoint_auth_method: 'none' }` and `None()` client auth, and `[customFetch]` for injection. Read the 3.8.8 README for the exact names before writing; adjust if a name differs and note it in the commit. **Step 4:** green. **Step 5:** commit `feat(drive): PKCE client seam over oauth4webapi`.

### Task 4.2: Dropbox adapter

**Files:**
- Create: `frontend/apps/web/src/lib/drive/dropboxDrive.ts`, `frontend/apps/web/src/lib/drive/testing/fakeDropboxFetch.ts`
- Test: `frontend/apps/web/src/lib/drive/dropboxDrive.test.ts`

**Interfaces:**
- Produces: `DROPBOX_PROVIDER: PkceProvider` (`https://www.dropbox.com/oauth2/authorize`, `https://api.dropboxapi.com/oauth2/token`, `extraAuthParams: { token_access_type: 'offline' }`), `createDropboxDrive(deps: { fetch; session: { token(): Promise<string> } }): BackupDrive`, `createDropboxSession(deps)` mirroring `createGoogleSession` but storing `refreshToken` and minting access tokens in memory via `refresh`; disconnect calls `POST https://api.dropboxapi.com/2/auth/token/revoke`.

REST calls: list `POST /2/files/list_folder {"path":""}` (+ `list_folder/continue`), upload `POST https://content.dropboxapi.com/2/files/upload` with `Dropbox-API-Arg: {"path":"/<name>","mode":"add","autorename":false}`, download `POST https://content.dropboxapi.com/2/files/download` with `Dropbox-API-Arg: {"path":"<id>"}`, remove `POST /2/files/delete_v2 {"path":"<id>"}`. Errors: 401 → `token_expired`, 409 with `path/not_found` → `not_found`, 507 or `insufficient_space` → `quota_exceeded`, 429 → `rate_limited`.

- [ ] **Step 1:** failing tests: `runBackupDriveContract('dropbox (fake REST)', …)` plus the error mapping table, the upload arg JSON has only `path`, `mode`, `autorename` (egress allowlist), and a stored refresh token survives a "reload" (new session object) without any navigation. **Step 2:** red. **Step 3:** implement. **Step 4:** green. **Step 5:** commit `feat(drive): Dropbox adapter with a stored PKCE refresh token`.

### Task 4.3: Wire Dropbox in

**Files:**
- Modify: `frontend/apps/web/public/_headers` (+ `https://api.dropboxapi.com https://content.dropboxapi.com` with justification comments), `frontend/apps/web/src/lib/__tests__/connectSrc.test.ts` (exact list), `frontend/apps/web/src/lib/drive/__tests__/driveEgress.test.ts` (parametrise over providers; Dropbox metadata allowlist `path`, `mode`, `autorename`), `frontend/apps/web/src/lib/drive/index.ts` (`createDrive(provider)`), `OAuthCallback.tsx` (dispatch on `pending.provider`), `DriveBackupPanel.tsx` (provider picker: Google Drive, Dropbox), locales en/es/pt, `legal.json` `s2_li8` wording to name Dropbox, `README.md` row, `CLAUDE.md` egress item (3) host list, `e2e/driveFake.ts` + `drive-backup.spec.ts` (a Dropbox variant of the journey), `providerConfig.ts` (`DROPBOX_APP_KEY` from step 55)
- [ ] Failing tests first (connect-src exact list, egress for Dropbox, picker shows Dropbox, callback dispatch). Implement, green, commit `feat(drive): Dropbox in the provider picker`.

### Task 4.4: PR 4 close-out

- [ ] **Mutation red runs:** `redeemCode` adds `client_secret: 'x'` → `oauthClient.test.ts`; Dropbox session writes the refresh token unencrypted → `credentialStore`-level test in `dropboxDrive.test.ts`; Dropbox upload arg adds `"client_modified"` → egress allowlist test; drop the Dropbox hosts from `_headers` → `connectSrc.test.ts`.
- [ ] **Live:** stubbed Dropbox journey in CI; real Dropbox round trip with the step-55 test account (connect once, reload and close and reopen the browser: no reconnect; back up; restore in a second profile; disconnect revokes). Unverified rows stated if 55 isn't done.
- [ ] `make gate`; PR; northstar A; merge; cleanup.

---

# PR 5: OneDrive (personal)

Branch: `feat/drive-backup-5-onedrive`. **External: harish_actions 56.**

### Task 5.1: OneDrive adapter and session

**Files:**
- Create: `frontend/apps/web/src/lib/drive/oneDrive.ts`, `frontend/apps/web/src/lib/drive/testing/fakeGraphFetch.ts`
- Test: `frontend/apps/web/src/lib/drive/oneDrive.test.ts`

**Interfaces:**
- `MICROSOFT_PROVIDER: PkceProvider` with `authorizationEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'`, `tokenEndpoint: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'`, `scope: 'Files.ReadWrite.AppFolder offline_access'`.
- `createOneDrive(deps): BackupDrive` over Graph: list `GET https://graph.microsoft.com/v1.0/me/drive/special/approot/children?$select=id,name,size,@microsoft.graph.downloadUrl`; upload ≤4 MiB `PUT /me/drive/special/approot:/<name>:/content?@microsoft.graph.conflictBehavior=fail`, larger via `POST …:/<name>:/createUploadSession` then chunked `PUT`s (320 KiB multiples) to the session URL; download by fetching the item's `@microsoft.graph.downloadUrl` (no `Authorization` header to that host); remove `DELETE /me/drive/items/<id>` (recycle bin).
- `createOneDriveSession(deps)`: stores the refresh token with `expiresAt = signInTime + 24 h` (not rolling: keep the original `expiresAt` across refreshes); when past it, one `prompt=none` redirect (`extraAuthParams: { prompt: 'none' }` for that call), then Reconnect.

- [ ] **Step 1:** failing tests: contract suite on the fake; small vs large upload paths (5 MiB fixture uses the session); download sends no `Authorization` to the pre-authenticated URL; a refresh keeps the original `expiresAt`; past 24 h → one `prompt=none` navigation; error mapping (401, 507 `quotaLimitReached` → `quota_exceeded`, 429). **Step 2:** red. **Step 3:** implement. **Step 4:** green. **Step 5:** commit `feat(drive): OneDrive adapter with PKCE and a 24 h refresh token`.

### Task 5.2: Wire OneDrive in, with hosts from a live trace

- [ ] **Step 1:** with the step-56 client ID, run a real download in a headed browser and record the hosts the download URL resolves to (for personal accounts expect `*.files.1drv.com` or similar). List the exact hosts; if they vary by account, use the narrowest stable host suffix Microsoft documents and say so in the `_headers` comment.
- [ ] **Step 2:** failing tests: `connectSrc.test.ts` exact list including the Microsoft hosts; egress test parametrised for OneDrive (Graph JSON metadata allowlist `item`, `@microsoft.graph.conflictBehavior`, `name`); picker shows OneDrive.
- [ ] **Step 3–5:** implement the `_headers`, `index.ts`, callback dispatch, picker, locales, `legal.json`, README, CLAUDE.md and e2e variant. Green. Commit `feat(drive): OneDrive (personal accounts) in the provider picker`.

### Task 5.3: PR 5 close-out

- [ ] **Mutations:** refresh resets `expiresAt` to now + 24 h → `oneDrive.test.ts`; download sends `Authorization` to the pre-authenticated host → `oneDrive.test.ts` + egress test (token must only go to `graph.microsoft.com`/`login.microsoftonline.com`); drop a Microsoft host from `_headers` → `connectSrc.test.ts`.
- [ ] **Live:** stubbed OneDrive journey (CI Chromium, macOS WebKit); real round trip with a personal Microsoft account in Chromium and WebKit, including a refresh and a simulated 24 h expiry (edit the row's `expiresAt` via the hook). Confirm COOP is present on every response (`verify-cross-origin-isolation.mjs`); no path had COOP removed.
- [ ] `make gate`; PR; northstar A; merge; cleanup.

---

# PR 6: Recipient-key sealing and automatic backup

Branch: `feat/drive-backup-6-auto`. Claims: "your passphrase is never stored"; "automatic backups are ciphertext too". Rulings 1, 2 and 5.

### Task 6.1: Recipient seal and open in the seal seam

**Files:**
- Modify: `frontend/packages/store/src/passphraseSeal.ts` (still the only seal-library seam; import `Encrypter`, `Decrypter`, `generateX25519Identity`, `identityToRecipient` from `age-encryption`, which `packages/store/package.json` already depends on at ^0.3.1)
- Test: `frontend/packages/store/src/passphraseSeal.recipient.test.ts`

**Interfaces:**
- Produces: `generateBackupIdentity(): Promise<{ identity: string; recipient: string }>` (`AGE-SECRET-KEY-1…` / `age1…`); `sealToRecipient(plaintext: Uint8Array, recipient: string): Promise<Uint8Array>`; `openWithIdentity(sealed: Uint8Array, identity: string): Promise<OpenOutcome>`.

- [ ] **Step 1:** failing tests: round trip; the sealed bytes start with `age-encryption.org/v1` and contain an `X25519` stanza, not `scrypt`; the wrong identity gives `{ ok: false, reason: 'wrong_passphrase_or_tampered' }`; `isSealedBackup` is true for recipient files. **Step 2:** red. **Step 3:** implement (`const e = new Encrypter(); e.addRecipient(recipient); return e.encrypt(plaintext);` and `const d = new Decrypter(); d.addIdentity(identity); d.decrypt(sealed, 'uint8array')` wrapped into `OpenOutcome`). **Step 4:** green. **Step 5:** commit `feat(seal): age X25519 recipient sealing behind the seal seam`.

### Task 6.2: Key file on the drive

**Files:**
- Create: `frontend/apps/web/src/lib/drive/backupKeyFile.ts`
- Modify: `backupName.ts` (add the one key-file name per drive, exactly `almamesh-backup-key.almamesh-key`, plus `isKeyFileName()`), `guardedDrive.ts` (allow that one name; `list()` still returns backups only, plus a `findKeyFile()` on the adapters via a `kind` filter)
- Test: `frontend/apps/web/src/lib/drive/backupKeyFile.test.ts`

**Interfaces:**
- Produces: `ensureKeyFile(drive, passphrase): Promise<{ recipient: string }>` (creates the identity, seals the identity text with the **passphrase** via `sealBackup`-equivalent scrypt seal, uploads it; if it exists, opens it with the passphrase to check it, which closes ruling 5); `openKeyFile(drive, passphrase): Promise<string>` (identity); device stores **only** `drive-recipient/<provider>` (the public key) in device rows.

- [ ] Steps 1–5. Tests: a fresh drive gets exactly one key file; the device rows hold only an `age1…` string and no `AGE-SECRET-KEY`; a wrong passphrase on an existing key file returns `bad_passphrase`; restoring a recipient-sealed backup on a fresh device with only the passphrase works (open key file → identity → `openWithIdentity`). `stageBackupImport` gains recipient support by trying the identity when the age header has an X25519 stanza (modify `backupService.ts` `stageOpenedBackup` path; test in `backupService.test.ts`). Commit `feat(drive): passphrase-sealed key file; restore needs only the passphrase`.

### Task 6.3: Automatic backup scheduler

**Files:**
- Create: `frontend/apps/web/src/lib/drive/autoBackup.ts`
- Test: `frontend/apps/web/src/lib/drive/autoBackup.test.ts` (fake timers)

**Interfaces:**
- Produces: `startAutoBackup(deps: { subscribe(onChange: () => void): () => void; canUseTokenWithoutRedirect(): Promise<boolean>; backUpToRecipient(): Promise<void>; now(): number; setTimeout; clearTimeout }): () => void`. Constants: `DEBOUNCE_MS = 10 * 60_000`, `MIN_INTERVAL_MS = 60 * 60_000`.
- `subscribe` uses the existing portable-state change notifications (find the publisher with `grep -n "publishDeletionNotice\|subscribe" frontend/packages/store/src/deletionTombstones.ts`; use whatever the stores already emit on a committed write).

- [ ] Tests: a burst of changes produces one backup 10 min after the last; two backups are never closer than 1 h; no backup when `canUseTokenWithoutRedirect()` is false (and `window.location.assign` is never called); nothing scheduled at boot without a change; a failed run doesn't retry in a loop (next change reschedules). Implement; green; commit `feat(drive): debounced on-change automatic backup, never a redirect`.

### Task 6.4: UI toggle

**Files:**
- Modify: `DriveBackupPanel.tsx` ("Back up automatically" toggle, off by default; turning it on runs `ensureKeyFile` with the passphrase once), locales en/es/pt, `privacy.s2_li8` sentence about automatic encrypted backups, the toggle's state in device rows `drive-auto/<provider>` (device-local, not a portable preference, so a restore doesn't switch it on elsewhere)
- Test: panel tests for toggle on/off, the Google past-the-hour text "Last drive backup: 3 h ago. Back up now", and that the toggle never triggers navigation.
- [ ] Steps 1–5; commit `feat(drive): Back up automatically toggle`.

### Task 6.5: PR 6 close-out

- [ ] **Mutations:** store the identity (secret key) in device rows → `backupKeyFile.test.ts` ("only an age1… string"); `autoBackup` calls `session.connect(…, true)` when the token needs a redirect → `autoBackup.test.ts`; debounce set to 0 → `autoBackup.test.ts`; recipient seal falls back to plaintext on error → egress test (parametrise `driveEgress.test.ts` with an automatic run).
- [ ] **Live:** stubbed journey: enable auto, edit a profile, advance the clock hook 10 min, one upload appears with a recipient-sealed body; fresh context B restores it with the passphrase only. Real Google: enable auto, edit, wait (or use the hook), see the file in Drive; restore it in a second profile.
- [ ] `make gate`; PR; northstar A; merge; cleanup.

---

## Self-review notes (done while writing)

- **Spec coverage:** seam, guard, naming, retention, device code (PR 1); credentials + R0 key, OAuth state, Google adapter, silent renewal, callback route, CSP pin, egress test, reset deletion (PR 2); UI, safety copy to drive, first-run entry, privacy/CLAUDE/README edits, stubbed + real e2e (PR 3); Dropbox and `oauth4webapi` (PR 4); OneDrive without MSAL, live host trace (PR 5); recipient sealing, key file, automatic backup (PR 6). The threat-model mitigations map to Tasks 2.2 (encryption), 2.4 (trash not delete), 3.2 (restore through `stageBackupImport`), 2.6 (CSP).
- **Known lookups the executor must do** (named, not placeholders): the exit-gate hooks file name (Task 1.4), the `resetEverything.test.ts` deps factory name (Task 2.7), where production `VITE_` vars are set (Task 3.8), the exact `oauth4webapi` 3.8.8 function names (Task 4.1), and the store change-notification hook (Task 6.3). Each step says how to find it.
- **Types:** `BackupDrive.isConnected()` returns `Promise<boolean>` everywhere; `DriveErrorKind` gains `not_sealed` and `bad_name` in Task 1.1 and is used consistently; `StoredCredential.expiresAt` is ms since the epoch in every task.
