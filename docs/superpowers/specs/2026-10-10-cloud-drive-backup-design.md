# Cloud drive backup: back up to your own drive, restore on any device

Status: draft design for owner review (2026-10-10). Written against `main` at `821bd6e8`.

## TL;DR

Today a backup is a file. You export it, then you have to decide where to keep it, and on a new
device you have to find it again. That is tedious, so most people never do it.

This feature backs up straight to the user's own cloud drive. "Back up to Google Drive" seals the
data on the device with the user's passphrase and uploads the sealed file. "Restore from Google
Drive" lists the backups there by date and device, the user picks one, types the passphrase, and
the existing restore flow takes over. Any device signed in to the same drive sees the same list.

Four things do not change:

| Rule | What it means here |
|---|---|
| SQLite on the device is the system of record | The drive holds backup files only. Nothing syncs, nothing merges, nothing is read from the drive except on an explicit restore. |
| No backend server, ever | The browser talks to the drive provider's API directly. OAuth runs as a browser-only flow. |
| The provider only ever stores ciphertext | The file uploaded is exactly today's `.almamesh` export: an age v1 file sealed with the user's passphrase (scrypt). |
| Opt-in | Nothing touches a drive until the user presses a drive button and grants consent. |

Launch with Google Drive. Dropbox and OneDrive (personal accounts) follow behind the same
`BackupDrive` interface. iCloud and Box are dropped (reasons in the research note, summarised in
[Providers](#providers)).

The work ships in five PRs (see [PR split](#pr-split)):

| PR | What ships | User sees |
|---|---|---|
| 1 | `BackupDrive` seam, ciphertext guard, file naming, retention planner, fake drive, contract suite | Nothing |
| 2 | Google Drive adapter, OAuth redirect, in-memory token, CSP host, ciphertext egress test | Nothing (feature flag off) |
| 3 | Settings and first-run UI, privacy copy in en/es/pt, CLAUDE.md and README egress inventory, live Google round trip | "Back up to Google Drive" and "Restore from Google Drive" |
| 4 | Dropbox adapter + CSP + copy | Dropbox in the provider picker |
| 5 | OneDrive adapter (MSAL v5) + CSP + copy | OneDrive in the provider picker |

## Why

- Export/import works, but it stops at "here is a file". The user still has to save it somewhere
  safe and carry it to the next device. A backup that lives only in `~/Downloads` on the device
  it protects is not a backup.
- People already have a cloud drive. Using it means no AlmaMesh account, no AlmaMesh server, and
  no AlmaMesh storage bill.
- The sealed export already exists and is sound (see [Encryption](#encryption)). This feature is
  mostly plumbing: pick a destination, list, download.

## What exists today (checked)

| Piece | Where | What it does |
|---|---|---|
| Export | `frontend/apps/web/src/lib/backupService.ts` `buildBackupExport` | Reads canonical SQLite bytes (`exportPortableBrowserState`), seals them in a Worker, returns `{ filename, content, repairs }`. Requires a passphrase of at least 12 characters. |
| Seal seam | `frontend/packages/store/src/passphraseSeal.ts` | The only importer of `@gainratio/browser/seal`. New files are standard **age v1** with a **scrypt** passphrase recipient, so `age -d` opens them. Reads older PBKDF2/AES-GCM files (v1–v3) read-only. scrypt runs in `passphraseSeal.worker.ts`. |
| Filename | `exportBackupFilename` | `almamesh-backup-<UTC timestamp>.almamesh`. No person names. |
| Import | `stageBackupImport` then `commitBackupImport` | Detects the format, decrypts, previews, and only then writes. Typed failures: `bad_format`, `too_new`, `bad_passphrase`, `out_of_memory`, `unavailable`. |
| Restore UI | `hooks/useBackupRestore.ts`, `components/features/backup/RestoreFromBackup.tsx`, `pages/settings/DataSettings.tsx` | Password prompt, preview, safety copy of current data before replacing, then reload. Mounted in Settings → Data, the landing Hero and Onboarding. |
| File I/O | `lib/backupFile.ts` | Save picker or download fallback; open picker or `<input type=file>`. 128 MiB cap. |
| Device-local rows | `packages/store/src/portableState.ts` | `quarantine` and `set-aside` namespaces live in SQLite but are never part of a snapshot, restore or backup. |
| CSP | `frontend/apps/web/public/_headers` | Closed `connect-src`: `'self'`, `https://openrouter.ai`, `https://geocoding-api.open-meteo.com`, loopback. Each entry has a justification comment. `previewHeaders.test.ts` parses the real file. |
| Isolation | same file | `COOP: same-origin` + `COEP: require-corp` on every response (SharedArrayBuffer for the OPFS SQLite VFS). |

The notes said "secrets are already encrypted in exports". More precisely: the **whole** export is
sealed, and the optional AI key lives inside the SQLite file, so it travels inside the ciphertext.
There is no separate per-secret encryption to extend.

## User journeys

### 1. First backup on a laptop

1. Settings → Data → **Back up to Google Drive**.
2. A short explainer: "Your backup is locked with a passphrase on this device before it is
   uploaded. Google only stores a locked file. AlmaMesh never sees your Google account."
   Button: **Connect Google Drive**.
3. Full-page redirect to Google's consent screen. It asks for one thing: "See, edit, create and
   delete only the specific Google Drive files you use with this app." No email, no profile.
4. Back on `/oauth/callback`, which hands over to Settings → Data with the token held in memory.
5. Passphrase setup (first time only on this device, see [Passphrase](#passphrase)): type it
   twice, tick "I understand that if I forget this passphrase, nobody can open these backups.
   Not AlmaMesh, not Google."
6. "Sealing your backup…" (scrypt in the Worker), then "Uploading…", then "Checking the upload…".
7. Done: "Backed up to Google Drive at 6:04 PM. 10 most recent backups from this device are kept."
   The file appears in the user's Drive under **AlmaMesh backups**.

### 2. Restore on a new phone

1. Landing page or Onboarding → **Restore from a backup** → **From Google Drive**.
2. Connect (same consent screen).
3. A list, newest first:

   | When | Device | Size |
   |---|---|---|
   | Today, 6:04 PM | Chrome on macOS | 2.1 MB |
   | Yesterday, 9:12 AM | Safari on iOS (this device) | 2.0 MB |
   | 3 Oct, 8:30 PM | Chrome on macOS | 1.9 MB |

4. Pick one. Type the passphrase. The existing preview shows profiles and counts.
5. The existing safety-copy step. Since a drive is connected, the default safety copy is "Back up
   this device to Google Drive first" instead of a download. If the device holds nothing,
   the step is skipped as today.
6. Replace, reload, dashboard.

### 3. Passphrase forgotten

The restore shows "That passphrase doesn't open this backup." after a wrong try, with a link:
"Forgot it?" which says plainly:

> Nobody can recover a lost passphrase. Your backups on Google Drive stay locked forever.
> Your data on this device is not affected. To start a fresh set of backups, choose a new
> passphrase on your next backup. You can delete the old, locked backups from the list.

No reset, no hint, no escrow. That is the price of "Google only stores ciphertext".

### 4. Offline

Both drive buttons stay visible but are disabled with: "You're offline. Your data is safe on
this device. Back up when you're back online." Export to a file still works offline.

## Design

### The seam: `BackupDrive`

One interface, one file per provider, and the provider SDK is imported only inside its adapter
(inject, don't entangle). Encryption sits above the seam, so adapters only ever see sealed bytes.

```ts
// frontend/apps/web/src/lib/drive/backupDrive.ts
export type DriveProviderId = 'google-drive' | 'dropbox' | 'onedrive';

/** Bytes that passed isSealedBackup(). Only sealForDrive() can make one. */
export interface SealedBackup { readonly bytes: Uint8Array; readonly __sealed: unique symbol }

/** A name built by backupName.ts and re-checked by its parser. */
export interface BackupFileName { readonly value: string; readonly __name: unique symbol }

export interface DriveBackupEntry {
  readonly id: string;               // provider file id or path
  readonly name: BackupFileName;
  readonly meta: BackupNameMeta;     // parsed from the name: createdAt, browser, os, deviceCode
  readonly sizeBytes: number;
}

export interface BackupDrive {
  readonly provider: DriveProviderId;
  /** Starts consent. May navigate the tab away; resolves 'connected' only after the callback. */
  connect(returnTo: string): Promise<'connected' | 'redirecting'>;
  isConnected(): boolean;
  list(): Promise<readonly DriveBackupEntry[]>;
  upload(name: BackupFileName, sealed: SealedBackup): Promise<DriveBackupEntry>;
  download(id: string): Promise<Uint8Array>;
  /** Moves to the provider's trash / recycle bin where one exists. */
  remove(id: string): Promise<void>;
  disconnect(): Promise<void>;
}

export type DriveErrorKind =
  | 'not_connected' | 'consent_denied' | 'token_expired' | 'offline'
  | 'quota_exceeded' | 'rate_limited' | 'not_found' | 'provider_error';
export class DriveError extends Error { /* kind: DriveErrorKind; status?: number */ }
```

`guardedDrive(drive)` wraps every adapter. It is the one place the privacy rule is enforced:

- `upload` re-checks `isSealedBackup(sealed.bytes)` and that the bytes do **not** start with the
  SQLite header, and fails closed with `DriveError('provider_error')` before any network call.
- `upload` re-parses the name with the strict name regex and fails closed on any mismatch.
- `list` drops any entry whose name does not parse (another tool's file in the folder).
- Every method maps `navigator.onLine === false` to `offline` up front.

Files:

| File | Owns |
|---|---|
| `lib/drive/backupDrive.ts` | Types, `DriveError` |
| `lib/drive/guardedDrive.ts` | Ciphertext and name guards |
| `lib/drive/backupName.ts` | Build and parse names, device code, browser/OS enum |
| `lib/drive/retention.ts` | Pure "which files to trash" planner |
| `lib/drive/driveSession.ts` | In-memory token holder per provider |
| `lib/drive/oauthRedirect.ts` | `state`, PKCE verifier, callback parsing, fragment scrub |
| `lib/drive/googleDrive.ts` | Google adapter (REST via `fetch`, no SDK) |
| `lib/drive/dropboxDrive.ts` | Dropbox adapter (only importer of `dropbox`, or REST) |
| `lib/drive/oneDrive.ts` | OneDrive adapter (only importer of `@azure/msal-browser`) |
| `lib/drive/providerConfig.ts` | Public client IDs and redirect URIs (not secrets) |
| `lib/drive/testing/fakeDrive.ts` + `backupDrive.contract.ts` | In-memory drive and the shared contract suite |
| `hooks/useDriveBackup.ts` | Back up, list, restore, delete; reuses `buildBackupExport` and `useBackupRestore` staging |
| `components/features/backup/drive/*` | Provider picker, passphrase setup, backup list |
| `pages/OAuthCallback.tsx` | The `/oauth/callback` route |

### Providers

| | Google Drive (PR 2–3) | Dropbox (PR 4) | OneDrive personal (PR 5) |
|---|---|---|---|
| Library | None. Drive v3 REST via `fetch`. (`googleapis` is Node-only; `gapi` is a CDN script COEP blocks.) | `dropbox` 10.47.0 (Dropbox Inc.) or plain REST | `@azure/msal-browser` 5.x (Microsoft); Graph via plain `fetch` |
| Auth flow | OAuth 2.0 for client-side web apps: top-level redirect, `response_type=token`. Google's web clients need a secret for code+PKCE, so this is the supported browser path. | Code + PKCE, public client, no secret, top-level redirect | MSAL v5 redirect flow (its redirect bridge if v5 requires it, see open question 6) |
| Scope | `https://www.googleapis.com/auth/drive.file` only. Non-sensitive. No `openid`, `email` or `profile`. | App folder app; `files.metadata.read`, `files.content.read`, `files.content.write` | `Files.ReadWrite.AppFolder` (delegated, no admin consent) |
| Where files go | Visible folder **AlmaMesh backups** in My Drive, created by the app | `/Apps/AlmaMesh/` | `/Apps/AlmaMesh/` (Graph `special/approot`) |
| Token lifetime | 1 h access token, no refresh token | Short-lived access token; request `token_access_type=online` (no refresh token) in v1 | Access token; MSAL `cacheLocation: 'memoryStorage'` |
| Upload | Resumable session (`uploadType=resumable`), one code path for any size; an unfinished session leaves no file | `/2/files/upload` (≤150 MB, under our 128 MiB cap) | `createUploadSession` for >4 MB, simple PUT below |
| Remove | `files.update {trashed:true}` (recoverable 30 days), not `files.delete` | `delete_v2` (recoverable in Dropbox's deleted files) | `DELETE` item (goes to recycle bin) |
| CSP `connect-src` added | `https://www.googleapis.com`, `https://oauth2.googleapis.com` (token revoke) | `https://api.dropboxapi.com`, `https://content.dropboxapi.com` | `https://login.microsoftonline.com`, `https://graph.microsoft.com`, plus the download hosts a live trace shows |
| Approval needed | Consent screen published to production; brand verification only if we show a logo | Production approval past the development-user cap (500 per long-standing policy; check the console) | None for personal accounts; work/school tenants are out of scope at launch |

Dropped: **iCloud** (no web API for iCloud Drive; CloudKit JS is a CDN script COEP blocks, sign-in
is a popup COOP breaks, and backups would land in an opaque container), **Box** (token exchange
needs a client secret, no app-folder scope).

Why `drive.file` and not `drive.appdata`: both are non-sensitive. `drive.file` puts backups where
the user can see, download and delete them in the Drive UI without AlmaMesh. That is the more
honest promise. A downloaded drive backup is a normal `.almamesh` file, so the existing "Restore
from a file" opens it, and so does `age -d`.

`drive.file` access is per app and per Google account, not per device. A second device using the
same OAuth client sees the files the first device created. This is the property the whole
feature rests on, so the live check proves it (see [Live end-to-end](#live-end-to-end-checks)).

### OAuth under COOP same-origin

COOP `same-origin` cuts a popup off from its opener, so every popup flow (GIS token client, MSAL
popup) is out. We use a **full-page redirect** for all three providers. The tab leaves AlmaMesh,
the provider sends it back to `https://almamesh.com/oauth/callback`, and the SPA picks up.

- `/oauth/callback` is an ordinary client route. Add it to `public/_redirects`, the router in
  `App.tsx`, and the service worker `navigateFallbackAllowlist` in `vite.config.ts`, so a
  returning visitor's SW serves the shell and the URL never reaches the origin server. Mark it
  `noindex` and keep it out of `sitemap.xml`.
- A full-page redirect needs no COOP change. Only MSAL's bridge page (if v5 requires it) would be
  served with `! Cross-Origin-Opener-Policy`, scoped to that one path, in PR 5.
- Before leaving, `oauthRedirect.ts` writes one short-lived record to `sessionStorage`:
  `{ provider, state, pkceVerifier?, returnTo, startedAt }`. `state` is 128 random bits. This is
  protocol state that must survive the redirect, not user data, and it holds no token. It is read
  once and deleted on the callback, and dropped if older than 10 minutes.
- On the callback: compare `state` (mismatch: reject and show "That sign-in didn't come from this
  tab. Try again."), read the token from the fragment (Google) or exchange the code with the
  verifier (Dropbox, MSAL), then immediately `history.replaceState` to strip the fragment or
  query, hand the token to `driveSession.ts`, and client-side navigate to `returnTo`.
- Navigation to the provider uses `location.assign`, not a form, so `form-action 'self'` stays.
- The callback reads the fragment before React mounts any child that could log the URL.
  Diagnostics already emit allowlisted codes only; the callback adds no URL logging.

### Token handling

| Rule | How |
|---|---|
| Memory only | `driveSession.ts` keeps `{ accessToken, expiresAt }` in a module closure. Not in Zustand persist, not in SQLite, not in `localStorage`, not in `sessionStorage`, not in a backup. MSAL uses `memoryStorage`. |
| No refresh tokens in v1 | Google issues none. Dropbox is asked for `online` tokens. MSAL keeps its refresh token in memory only. The user re-consents once per tab session. Consent is remembered by the provider, so the second time is usually one click. |
| Expiry | Before each call, if `expiresAt` is within 60 s, treat as disconnected. A 401 maps to `token_expired` and the UI offers "Reconnect". |
| Disconnect | Drops the token. Google: also `POST https://oauth2.googleapis.com/revoke`. |
| Never logged | Tokens never reach diagnostics, error messages or test snapshots. A test scans storage and captured console output after a connect. |
| No identity | We never ask for email or profile scopes, so AlmaMesh never learns who the user is. The UI says "Connected to Google Drive", never an address. |

### Encryption

**Decision: reuse the existing age v1 seal, unchanged.** The drive upload is byte-for-byte what
"Export to a file" produces today.

| Option | Verdict |
|---|---|
| **age v1, scrypt recipient (today's seal, via `@gainratio/browser/seal`)** | **Use it.** age is a published file format with a reference implementation by its designer, and scrypt (RFC 7914) is memory-hard, the property that matters against GPU guessing of a human passphrase. It already runs in a Worker, already has typed failures, and users can open files with `age -d`. Zero new crypto code. |
| Argon2id via a wasm library + AES-GCM | Comparable strength to scrypt. It would add a dependency, a custom file format nobody else can open, and a second read path forever. No gain. |
| PBKDF2-SHA256 + AES-GCM via WebCrypto | Not memory-hard. This is what the app moved **away** from; legacy files stay read-only. |

What the provider can see: the age header (format line, scrypt salt and work factor, the wrapped
file key, the header MAC), the ciphertext length, the filename, and upload times. No personal data.

### Passphrase

- Same rule as export: at least 12 characters (`MIN_BACKUP_PASSPHRASE_LENGTH`), typed twice.
- First drive backup on a device shows the recovery warning and a required checkbox.
- The passphrase is kept **in memory for the tab session** after the first backup, so a second
  backup in the same session doesn't ask again. A new tab asks again (typed twice). It is never
  stored anywhere.
- A user may use a different passphrase per backup. The UI hint says "Use the same passphrase as
  your other backups", and a wrong-passphrase error on restore adds "This backup may use an older
  passphrase."
- Lost passphrase: see journey 3. Local data is untouched; old backups stay locked; the user can
  trash them from the list.
- The passphrase never leaves the Worker boundary except as the seal input. The egress test plants
  a canary passphrase and asserts it never appears in any request.

### File naming and metadata

Every provider stores only a name and bytes, so the name carries all list metadata. Same prefix
and extension as today's export, so a drive file restores through "Restore from a file" too.

```
almamesh-backup-2026-10-10T18-04-05-123Z-chrome-macos-7f3a2c.almamesh
                └─ UTC time (today's filenameTimestamp) ─┘ └browser┘└ os ┘└device┘
```

| Part | Source | Allowed values |
|---|---|---|
| Time | `filenameTimestamp(now)` (existing) | ISO UTC with `:` and `.` replaced |
| Browser | UA-CH / UA, mapped to an enum | `chrome`, `edge`, `firefox`, `safari`, `samsung`, `other` |
| OS | same | `macos`, `windows`, `linux`, `ios`, `android`, `chromeos`, `other` |
| Device code | 6 random hex chars, generated once per device | `[0-9a-f]{6}` |

- The parser regex is strict:
  `^almamesh-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(chrome|edge|…)-(macos|…)-[0-9a-f]{6}\.almamesh$`.
  No free text can enter a name, so no person name, city, birth date or user-typed device label
  can leak.
- The device code lives in a new **device-local** SQLite namespace (`device`), like `quarantine`
  and `set-aside`: never in a snapshot, restore or backup. This matters: if the device code
  travelled in a backup, a restored phone would claim the laptop's code, and retention on the
  phone would trash the laptop's backups. A test pins it.
- The UI shows "Chrome on macOS" and adds "(this device)" when the code matches. Two devices with
  the same browser and OS are told apart by the code, shown small: "Chrome on macOS · 7f3a2c".
- MIME type `application/octet-stream`, so Drive doesn't try to preview it.
- Google `appProperties` and Dropbox/Graph custom properties are not used. One source of truth
  across providers: the name.

### Versioning and retention

- Every backup is a **new file**. Nothing is ever overwritten, so a failed or interrupted upload
  can never damage an older backup.
- After an upload is verified, `retention.ts` plans what to trash: keep the **10 newest backups
  with this device's code**; trash older ones with this device's code. It never touches another
  device's files. That avoids every cross-device race: each device prunes only what it wrote.
- Trash, not delete, so the provider's 30-day recovery still applies.
- The user can trash any listed backup by hand (with a confirm).
- Verification before pruning: download the file back and compare SHA-256 with what was uploaded.
  Only a byte-equal read-back counts as "Backed up". If verification fails, nothing is pruned and
  the UI says "Uploaded, but the check failed. Try again." (Cost: one extra download per backup.
  See open question 4.)

### Conflicts across devices

There is no sync, so there are no merge conflicts. A backup is a snapshot; a restore replaces the
device's data wholesale through the existing `commitBackupImport` (atomic, multi-tab safe, with a
safety copy). The cases that remain:

| Case | Behaviour |
|---|---|
| Two devices back up at the same moment | Different device codes and timestamps, so different names. Both kept. |
| Same device, two tabs back up at once | Names differ by milliseconds. Both kept; retention trims later. The backup button holds the existing Web Lock for portable state while sealing, so the snapshots are consistent. |
| Restoring an older backup over newer local data | The preview shows the backup's date and this device's last change. If the backup is older than this device's latest backup or latest local change, show "This backup is older than what's on this device" above the Replace button. The safety copy still runs. |
| Restoring device A's backup onto device B | Normal. B keeps its own device code (device-local), so B's retention never trashes A's files. |
| Backup made by a newer AlmaMesh | Existing `too_new` error: "This backup was made by a newer version. Update AlmaMesh and try again." |
| A file in the folder that isn't ours | Dropped by the name parser; never listed, never pruned. |
| User renames or moves a backup in Drive | Google: still reachable by id under `drive.file`, but a renamed file no longer parses, so it drops off the list. Documented in the help text. |

### Offline and failure behaviour

| Situation | Behaviour |
|---|---|
| Offline before starting | Drive buttons disabled with the offline message. File export still works. |
| Connection drops mid-upload | Google resumable session never completes, so no partial file appears. Dropbox and OneDrive single requests fail as a whole; an unfinished OneDrive upload session expires on its own. Local data untouched. Error: "The upload didn't finish. Your data on this device is safe." |
| Token expired mid-flow | `token_expired`, "Reconnect" button, then retry the same sealed bytes (kept in memory, not re-sealed). |
| Drive full | `quota_exceeded`: "Your Google Drive is full. Free some space or trash old AlmaMesh backups." |
| 429 / 5xx | One retry with backoff for idempotent reads (`list`, `download`). Uploads are not auto-retried; the user presses Retry. |
| No background queue | v1 does not queue backups for later or run them on a timer. See open question 1. |

## Privacy

This is a new network egress. It is opt-in, it goes to a provider the user already trusts with
their own files, and it carries only ciphertext and a neutral name. The claim set changes as
follows, and each change lands in the PR that makes the egress reachable (PR 3 for Google).

### The claim, restated

> Your birth date, time and chart stay on your device unless you turn on the optional AI. If you
> turn on cloud backup, they are locked with your passphrase on this device first; your drive
> provider stores only the locked file, and nobody can open it without your passphrase.

### Exact changes

| Place | Change |
|---|---|
| `CLAUDE.md`, "exactly TWO deliberate network egresses" paragraph | Becomes THREE. Add: "(3) **cloud drive backup**: only when the user presses a drive button and consents, the age-sealed backup file and its neutral filename go to the user's own drive provider (Google Drive at launch). Never plaintext, never the passphrase, never a person name in a name. Tokens are memory-only." Update the `connect-src` note to list the new hosts. |
| `README.md` "Runtime network and data flow" table | New row: Trigger "Back up or restore with a cloud drive", Destination "Google Drive (your account)", Data sent "The passphrase-sealed backup file, a filename with time, browser, OS and a random device code, normal request metadata", Explicitly not sent "Plaintext data, your passphrase, names, birth details". One row per provider as each ships. |
| `public/_headers` | Add each host to `connect-src` with a justification comment in the same style as Open-Meteo's. |
| Privacy policy `locales/{en,es,pt}/legal.json` | Section 1: one sentence that a drive backup is an encrypted copy the user chooses to send. Section 2 "What Touches the Network": new bullet `s2_li8` "Optional cloud backup" with the README row's wording. Section 6 "Data Retention": backups on your drive are kept by your drive provider under your account until you trash them; AlmaMesh keeps the 10 newest per device. New short section or bullet: "Google's handling of your files is covered by Google's terms". |
| Data deletion page `pages/legal/DataDeletion.tsx` + `legal.json` | "Reset & reload" and "clear site data" do **not** delete drive backups. How to delete them: from the in-app list, or in Drive under **AlmaMesh backups**, then empty the trash. |
| Landing hero/footer and `why.rows` | No new claim. They keep the scoped wording. If any landing copy mentions backup, it must say "encrypted". |
| `landing.privacyCopy.test.ts` | Extend: any locale string mentioning a drive or cloud backup must also contain the locale's word for encrypted/locked; no string may say backups are "on our servers". |
| `legal.parity.test.ts` | Picks up the new keys in all three locales automatically; confirm. |
| Google consent screen | App name AlmaMesh, privacy and terms URLs on almamesh.com, scope `drive.file` only. |

### The ciphertext-only test (new, PR 2, extended per provider)

`lib/drive/__tests__/driveEgress.test.ts`, run against each adapter with `fetch` replaced by a
recorder that also plays the fake provider:

1. Seed a dataset with canaries: profile name `Zyxwv Canary`, birth date `1987-03-14`, city
   `Qwertyville`, AI key `sk-canary-…`, passphrase `canary-passphrase-123`.
2. Run connect (stubbed), backup, list, download, remove.
3. For every recorded request to a provider host, assert:
   - the URL, query and headers contain none of the canaries;
   - every body is either JSON metadata whose keys are in an allowlist (`name`, `parents`,
     `mimeType`, `trashed`; Dropbox `path`, `mode`; Graph `item`) with a `name` that parses, or
     an upload body that starts with `age-encryption.org/v1\n`, does not start with
     `SQLite format 3\0`, and contains none of the canaries in UTF-8 or UTF-16;
   - no request goes to a host outside the provider's declared list.
4. Assert no request at all goes to a provider host before `connect()`.

A Playwright twin (`e2e/drive-backup.spec.ts`) does the same at the browser level with
`page.route` on the provider hosts and the real built app, so it also covers anything outside
the adapter (the UI, the callback route, the SW).

### CSP tests

`previewHeaders.test.ts` gains: the production `connect-src` equals an exact expected list (not
"contains"), so adding a host without updating the test fails, and a wildcard (`https:`,
`*.googleapis.com`) fails.

## Testing

TDD for every PR: write the failing test, watch it fail for the right reason, then the smallest
change. The `frontend-quality` skill runs after each change; `make gate` is green before every
commit.

### Unit and contract tests

| Area | Tests |
|---|---|
| `backupName` | Round trip build/parse; rejects names with any extra character; enum mapping for real UA strings; profile name never appears in any built name (property test over random profile names). |
| Device code | Generated once and stable across reloads; lives in the `device` namespace; absent from `exportPortableBrowserState` bytes; survives a restore unchanged. |
| `retention` | Keeps 10 newest of this device; never selects another device's file; never selects an unparseable file; nothing pruned when verification failed. |
| `guardedDrive` | Plain SQLite bytes, JSON, or empty bytes refused before `fetch` is called; bad names refused; offline mapped. |
| `oauthRedirect` | State mismatch rejected; record deleted after read; record older than 10 min rejected; fragment scrubbed from `location` after callback. |
| `driveSession` | After connect, `localStorage`, `sessionStorage`, SQLite rows and captured console contain no token. Expiry within 60 s reads as disconnected. |
| Contract suite | `backupDrive.contract.ts` runs against `fakeDrive` and each adapter (with a recorded fake server): upload then list shows it, download is byte-equal, remove hides it, 401 maps to `token_expired`, 403 storage quota maps to `quota_exceeded`, 429 maps to `rate_limited`. |
| `useDriveBackup` | Backup reuses `buildBackupExport` (one seal path); restore hands downloaded bytes to `stageBackupImport` (one import path); safety copy can go to the drive. |
| Egress | `driveEgress.test.ts` above. |

### Mutation red runs (each PR shows these in its description)

A guard counts only after it has been seen failing. For each, mutate the source, run the named
test, paste the red output, then revert.

| Guard | Mutation | Must go red |
|---|---|---|
| Ciphertext only | `upload` sends `exported.bytes` instead of the sealed bytes | `driveEgress.test.ts`, `guardedDrive.test.ts` |
| Guard is load-bearing | Remove the `isSealedBackup` check from `guardedDrive` | `guardedDrive.test.ts` |
| No names in filenames | `buildBackupName` appends the active profile's name | `backupName.test.ts` property test, `driveEgress.test.ts` |
| Device code is device-local | Add the `device` namespace to `PORTABLE_STATE_KEYS` | device-code test, retention cross-device test |
| Retention scope | Planner ignores device code | `retention.test.ts` |
| Token memory-only | `driveSession` also writes to `sessionStorage` | `driveSession.test.ts` |
| CSRF | Callback skips the `state` compare | `oauthRedirect.test.ts` |
| Closed CSP | Add `https:` to `connect-src` | `previewHeaders.test.ts` |
| Passphrase never sent | Put the passphrase in the upload metadata | `driveEgress.test.ts` |
| Verify before prune | Prune runs before read-back | `useDriveBackup.test.ts` |

### Live end-to-end checks

**In CI (stubbed, every PR from 3 on):** `e2e/drive-backup.spec.ts` against the built app
(no hooks, real onboarding). `page.route` stubs:

- `accounts.google.com/o/oauth2/v2/auth`: a stub page that redirects to `/oauth/callback` with a
  fake token and the same `state`;
- `www.googleapis.com/drive/v3/*` and `/upload/drive/v3/*`: an in-memory Drive (the same fake as
  the unit contract, served over routes).

Journey: onboard a chart, back up, open a **second browser context** (a second "device"), restore
from the list, see the same chart on the dashboard, clean console, network log passes the
ciphertext checks. Run in Chromium and WebKit (the redirect and SW callback path is where WebKit
differs).

**Real Google round trip (manual trigger, before PR 3 merges and before each release that touches
the drive code):** `bun run e2e:drive:google:live`, against a local production preview and
against the deployed site after merge.

- Uses a dedicated test Google account the owner provides. The owner signs in once in a headed,
  persistent Playwright profile (`bun run e2e:drive:google:login`); Google blocks scripted
  sign-in, so we never automate the password. The profile directory is outside the repo.
- Steps: connect (real consent), back up, check the file exists in the test account's Drive with a
  neutral name (Drive API list), restore in a second persistent context logged in to the same
  account (proves `drive.file` cross-device visibility), compare the restored dashboard, trash the
  file, record a HAR and run the ciphertext checks on it, assert a clean console.
- Evidence in the PR: the run log, the HAR scan result, screenshots of the list and the
  restored dashboard, and a screenshot of the Drive UI folder.

What can be stubbed, and what can't:

| Can be stubbed (CI) | Needs the real provider |
|---|---|
| Consent page, token issue, Drive REST semantics, errors (401, 403 quota, 429) | Real consent screen wording and scope display |
| The app's redirect, callback, SW and state handling | Real CORS and COEP behaviour of `www.googleapis.com` responses |
| Ciphertext and naming checks | `drive.file` visibility of one device's files from another device |
| | Exact hosts a real download touches (for CSP) |
| | Production consent screen status (no "unverified app" wall) |

### Northstar

Every PR is graded by the `northstar` agent before it merges and must reach **A** on the claim it
touches. A PR that touches no user-facing claim says so in one line.

## PR split

Each PR is one branch off `main`, merged then deleted. Feature flag `driveBackup` (build-time,
default off) keeps PR 2 unreachable until PR 3.

| PR | Scope | Claim touched | Acceptance criteria |
|---|---|---|---|
| **1. Seam** | `backupDrive.ts`, `guardedDrive.ts`, `backupName.ts`, `retention.ts`, `device` namespace + device code, `fakeDrive.ts`, contract suite | "Backups never carry a person name in their filename"; "the device code never travels in a backup" | All unit and contract tests green on `fakeDrive`; mutation runs for naming, device code, retention, ciphertext guard shown red; no network code; `make gate` green; northstar A |
| **2. Google adapter** | `googleDrive.ts`, `oauthRedirect.ts`, `driveSession.ts`, `providerConfig.ts`, `/oauth/callback` route (+ `_redirects`, SW allowlist, `noindex`), CSP hosts + exact-list test, `driveEgress.test.ts` | "Only ciphertext goes to the drive"; "tokens are memory-only"; "connect-src is closed" | Contract suite green against recorded Google responses; egress, token and CSRF mutation runs red; flag off so no UI reaches it (grep proves no production caller outside the flag); `verify-precache-redirect.mjs` green with the new route; northstar A |
| **3. Google UI + claim** | Provider picker, passphrase setup, backup list, restore from drive in Settings → Data, Hero and Onboarding; drive safety copy; offline states; en/es/pt strings; privacy policy, data deletion page, README table, CLAUDE.md egress paragraph; flag on | "Your data stays on your device unless you choose AI or encrypted cloud backup" | Stubbed Playwright journey green in Chromium and WebKit; real Google round trip run with evidence; privacy copy tests updated and red-run (remove "encrypted" from the es string); reachable from all three entry points; clean console; northstar A |
| **4. Dropbox** | `dropboxDrive.ts`, CSP hosts, copy rows, picker entry | Same claims, new host | Contract + egress suites green for Dropbox; live Dropbox round trip with an owner test account; northstar A |
| **5. OneDrive** | `oneDrive.ts` with MSAL v5, bridge page only if required (COOP detached on that path only), CSP hosts from a live trace, copy rows | Same claims, new hosts; "COOP stays on every app page" | Contract + egress suites green; live round trip with a personal Microsoft account in Chromium and WebKit; header test proves COOP is detached only on the bridge path; northstar A |

## Owner's one-time setup (for `~/dev/oss/harish_actions.py`)

Add these as manual checklist steps (next free numbers after 52), in the existing
`MANUAL_CHECKLIST` style. Client IDs and app keys are public identifiers; they go into
`frontend/apps/web/src/lib/drive/providerConfig.ts` in a PR. **No client secret is created or
stored anywhere.** Each step's `is_done` check: the matching constant is non-empty in
`providerConfig.ts` on `origin/main` (`gh api repos/gainratio/almamesh/contents/...`).

```python
# 53: Google Drive backup — OAuth client for almamesh.com (needed before drive-backup PR 3).
DRIVE_GOOGLE_CHECKLIST: Final = (
    "Google Cloud console (console.cloud.google.com), signed in as harish.seshadri@gmail.com:",
    "  1. New project 'almamesh-backup'.",
    "  2. APIs & Services > Library > enable 'Google Drive API'.",
    "  3. Google Auth Platform > Branding: app name 'AlmaMesh', support email, home page",
    "     https://almamesh.com/, privacy https://almamesh.com/privacy, terms",
    "     https://almamesh.com/terms, authorized domain almamesh.com. Skip the logo for now",
    "     (a logo triggers brand verification).",
    "  4. Audience: External. Data access: add ONLY .../auth/drive.file. No email/profile/openid.",
    "  5. Clients > Create client > Web application 'almamesh-web'.",
    "     Authorized JavaScript origins: https://almamesh.com, http://localhost:4173",
    "     Authorized redirect URIs: https://almamesh.com/oauth/callback,",
    "                               http://localhost:4173/oauth/callback",
    "  6. Audience > Publish app (In production). drive.file is non-sensitive, so no review.",
    "  7. Paste the Client ID (ends .apps.googleusercontent.com) to Claude. Do NOT create or",
    "     download a client secret.",
)
# 54: Google test account for the live round trip.
DRIVE_GOOGLE_TEST_ACCOUNT: Final = (
    "Create a throwaway Google account for AlmaMesh e2e (not your main one).",
    "Run `cd ~/dev/oss/almamesh/frontend/apps/web && bun run e2e:drive:google:login`,",
    "sign in to that account in the window that opens, approve the AlmaMesh consent, close it.",
)
# 55: Dropbox app (before drive-backup PR 4).
DRIVE_DROPBOX_CHECKLIST: Final = (
    "dropbox.com/developers/apps > Create app > Scoped access > App folder > name 'AlmaMesh'.",
    "  Permissions: tick files.metadata.read, files.content.read, files.content.write; Submit.",
    "  Settings: Redirect URIs https://almamesh.com/oauth/callback and",
    "  http://localhost:4173/oauth/callback; 'Allow public clients (Implicit Grant & PKCE)': Allow.",
    "  Paste the App key to Claude (never the App secret). Note the development-user cap shown.",
)
# 56: Microsoft Entra app registration (before drive-backup PR 5).
DRIVE_ONEDRIVE_CHECKLIST: Final = (
    "entra.microsoft.com > App registrations > New registration, name 'AlmaMesh'.",
    "  Supported account types: 'Personal Microsoft accounts only'.",
    "  Redirect URI: platform 'Single-page application', https://almamesh.com/oauth/callback;",
    "  then Authentication > add http://localhost:4173/oauth/callback (SPA).",
    "  API permissions: Microsoft Graph > Delegated > Files.ReadWrite.AppFolder. Remove User.Read.",
    "  No client secret, no certificate. Paste the Application (client) ID to Claude.",
)
```

If the deployed preview hosts (`*.pages.dev`) need drive backup too, each gets its own redirect
URI; Google allows no wildcards. Recommendation: leave previews without drive backup (the flag
reads the origin and hides the buttons on unlisted origins).

## Out of scope for v1

- Automatic or scheduled backups, background sync, and any merge of two devices' data.
- Work/school Microsoft accounts, iCloud, Box.
- Persisted refresh tokens.
- Partial restore (one profile out of a backup).
- Changing the passphrase of existing drive backups (re-sealing old files).

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Should backups run automatically (on change, or daily)? | **Not in v1.** Google gives no refresh token without a server, so an automatic run would need the user to re-consent anyway. Show "Last drive backup: 12 days ago" on Settings → Data and a gentle nudge on the dashboard after 14 days. Revisit if users ask. |
| 2 | Should the user type the passphrase on every backup? One-click backup would need an age X25519 key pair: back up to the public key with no passphrase, keep the private key sealed by the passphrase in a small key file on the drive. | **Not in v1.** Ask once per tab session. The key-pair design is a good follow-up (it also gives a cheap passphrase check), but it adds a second file, rotation rules and a recovery story. Ship the simple version, measure whether it is tedious. |
| 3 | How many backups to keep? | **10 newest per device**, trashed (recoverable 30 days) not deleted. Make the number a constant now, not a setting. |
| 4 | Is the read-back verification worth an extra download? | **Yes.** Backups are small (measure in PR 3; expect low MB). "Backed up" should mean "we read it back". If measured sizes are large on mobile data, switch to comparing the provider's reported size and checksum (Drive `sha256Checksum`, Dropbox `content_hash`, Graph `sha256Hash` where present). |
| 5 | Check the passphrase against existing backups when the user types it, so they don't create a set they can't open together? | **Not in v1.** It needs a download plus a scrypt run. Revisit with question 2. The hint text covers it. |
| 6 | Does MSAL v5's redirect flow require the redirect bridge page, or only the popup flow? | **Find out in PR 5 with a spike in WebKit and Chromium.** If required, serve `/oauth/msal-bridge.html` with `! Cross-Origin-Opener-Policy` on that path only, and add a header test pinning that no other path loses COOP. |
| 7 | Google implicit flow is discouraged by the OAuth security BCP. Is that acceptable? | **Yes, for now.** It is Google's documented browser-only path, and we mitigate the known risks: `state` check, fragment scrubbed immediately, strict CSP with no third-party scripts, a 1-hour token, the narrowest scope. Revisit if Google allows PKCE without a secret for web clients. |
| 8 | Show the Google account email so users know which drive they used? | **No.** That needs the `email` scope and makes AlmaMesh learn an identity. Say "Connected to Google Drive". The provider's own consent screen shows the account. |
| 9 | Device label: auto "Chrome on macOS", or let the user name it ("Mum's iPad")? | **Auto only.** A typed label would go into a plaintext filename and could carry a person name. The 6-character code tells same-type devices apart. |
| 10 | Should the safety copy before a drive restore go to the drive or to a local file? | **To the drive by default** when connected (one less file to save), with "Save to this device instead" as a link. It uses the same passphrase prompt. |
| 11 | Keep the "Export to a file" button? | **Yes.** It works offline and needs no account. Drive backup is an extra destination, not a replacement. |
| 12 | Enable on Pages preview deploys? | **No.** Only `almamesh.com` and `localhost:4173` are registered; the buttons hide elsewhere. |
