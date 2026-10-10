# Cloud drive backup: back up to your own drive, restore on any device

Status: approved by the owner (2026-10-10, "go to all"); see [Owner rulings](#owner-rulings-2026-10-10). Written against `main` at `821bd6e8`.
Revision 2 (2026-10-10): drive sign-in is now stored per device, encrypted (owner's question:
"why can't we store a token in SQLite?"). OneDrive moves from MSAL to `oauth4webapi`. Automatic
backup is planned as PR 6.

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

Drive sign-in is remembered per device. Each provider's credential (a Google access token, a
Dropbox refresh token, a Microsoft refresh token) is stored in a **device-local** SQLite row,
encrypted with a non-extractable WebCrypto key, never included in a backup or export, and
deleted on Disconnect or a full reset. See [Stored credentials](#stored-credentials) and the
[threat model](#threat-model).

Launch with Google Drive. Dropbox and OneDrive (personal accounts) follow behind the same
`BackupDrive` interface. iCloud and Box are dropped (reasons in the research note, summarised in
[Providers](#providers)).

The work ships in five PRs (see [PR split](#pr-split)):

| PR | What ships | User sees |
|---|---|---|
| 1 | `BackupDrive` seam, ciphertext guard, file naming, retention planner, fake drive, contract suite | Nothing |
| 2 | Google Drive adapter, OAuth redirect, encrypted device-local credential store, silent renewal, CSP host, ciphertext egress test | Nothing (feature flag off) |
| 3 | Settings and first-run UI, privacy copy in en/es/pt, CLAUDE.md and README egress inventory, live Google round trip | "Back up to Google Drive" and "Restore from Google Drive" |
| 4 | Dropbox adapter (PKCE via `oauth4webapi`, stored refresh token) + CSP + copy | Dropbox in the provider picker; connect once per device |
| 5 | OneDrive adapter (PKCE via `oauth4webapi`, not MSAL) + CSP + copy | OneDrive in the provider picker |
| 6 | Recipient-key sealing + automatic backup (debounced, on change) | "Back up automatically" toggle |

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
4. Back on `/oauth/callback`, which stores the token (encrypted, device-local) and hands over to
   Settings → Data. A reload within the hour does not ask again. After the hour, the next drive
   action bounces through Google with `prompt=none` and comes straight back: no consent screen
   while the user is still signed in to Google.
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
> passphrase on your next backup. You can trash this device's old, locked backups from the list;
> backups made on other devices are trashed from that device or in your drive's own app.

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

/** Bytes that passed isSealedBackup() and are not SQLite. Only sealedBackupOf() can make one. */
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
  isConnected(): Promise<boolean>;
  list(): Promise<readonly DriveBackupEntry[]>;
  upload(name: BackupFileName, sealed: SealedBackup): Promise<DriveBackupEntry>;
  download(id: string): Promise<Uint8Array>;
  /** Moves to the provider's trash / recycle bin where one exists. */
  remove(id: string): Promise<void>;
  disconnect(): Promise<void>;
}

export type DriveErrorKind =
  | 'not_connected' | 'consent_denied' | 'token_expired' | 'offline'
  | 'quota_exceeded' | 'rate_limited' | 'not_found' | 'not_sealed' | 'bad_name'
  | 'provider_error';
export class DriveError extends Error { /* kind: DriveErrorKind; status?: number */ }
```

`guardedDrive(drive)` wraps every adapter. It is the one place the privacy rule is enforced:

- `upload` re-checks the bytes through `sealedBackupOf` (age header, not SQLite) and fails closed
  with `DriveError('not_sealed')` before any network call.
- `upload` re-parses the name with the strict name regex and fails closed with
  `DriveError('bad_name')` on any mismatch.
- `list` rebuilds every entry's meta from its name alone and drops any entry whose name does not
  parse (another tool's file in the folder). The adapter's meta is never trusted.
- `remove` refuses (`DriveError('not_found')`, no network call) any id that was not in the last
  `list()` result with this device's code. So retention, the UI, or a bug can only ever trash
  this device's own backups. (Carry-forward from PR 1, #330; lands in PR 2.)
- Every method maps `navigator.onLine === false` to `offline` up front.

Files:

| File | Owns |
|---|---|
| `lib/drive/backupDrive.ts` | Types, `DriveError` |
| `lib/drive/guardedDrive.ts` | Ciphertext and name guards |
| `lib/drive/backupName.ts` | Build and parse names, device code, browser/OS enum |
| `lib/drive/retention.ts` | Pure "which files to trash" planner |
| `lib/drive/driveSession.ts` | Per-provider credential holder: reads and writes through `credentialStore.ts`, tracks expiry, decides renew vs reconnect |
| `lib/drive/credentialStore.ts` | The only code that touches stored credentials: encrypt/decrypt with the device key, device-local SQLite rows, delete on disconnect/reset |
| `lib/drive/deviceKey.ts` | The only code that touches the non-extractable AES-GCM key and its IndexedDB store |
| `lib/drive/oauthRedirect.ts` | `state`, PKCE verifier, callback parsing, fragment scrub |
| `lib/drive/oauthClient.ts` | The only importer of `oauth4webapi` (PKCE code exchange and refresh for Dropbox and Microsoft) |
| `lib/drive/googleDrive.ts` | Google adapter (REST via `fetch`, no SDK) |
| `lib/drive/dropboxDrive.ts` | Dropbox adapter (REST via `fetch`; auth via `oauthClient.ts`) |
| `lib/drive/oneDrive.ts` | OneDrive adapter (Graph via `fetch`; auth via `oauthClient.ts`) |
| `lib/drive/providerConfig.ts` | Public client IDs and redirect URIs (not secrets) |
| `lib/drive/testing/fakeDrive.ts` + `testing/backupDriveContract.ts` (`runBackupDriveContract`) + `testing/sealedFixture.ts` | In-memory drive, the shared contract suite, real age-sealed fixture bytes |
| `hooks/useDriveBackup.ts` | Back up, list, restore, delete; reuses `buildBackupExport` and `useBackupRestore` staging |
| `components/features/backup/drive/*` | Provider picker, passphrase setup, backup list |
| `pages/OAuthCallback.tsx` | The `/oauth/callback` route |

### Providers

| | Google Drive (PR 2–3) | Dropbox (PR 4) | OneDrive personal (PR 5) |
|---|---|---|---|
| Library | None. Drive v3 REST via `fetch`. (`googleapis` is Node-only; `gapi` is a CDN script COEP blocks.) | `oauth4webapi` 3.8.8 for PKCE (see below); Dropbox REST via `fetch`. The `dropbox` SDK isn't needed. | `oauth4webapi` 3.8.8 for PKCE against the Microsoft identity platform v2.0 endpoints; Graph via `fetch`. **Not MSAL** (see below). |
| Auth flow | OAuth 2.0 for client-side web apps: top-level redirect, `response_type=token`. Google's web clients need a secret for code+PKCE, so this is the supported browser path. Silent renewal: same redirect with `prompt=none`. | Code + PKCE, public client, no secret, `token_access_type=offline`, top-level redirect | Code + PKCE, SPA redirect URI (token redemption over CORS), top-level redirect |
| Scope | `https://www.googleapis.com/auth/drive.file` only. Non-sensitive. No `openid`, `email` or `profile`. | App folder app; `files.metadata.read`, `files.content.read`, `files.content.write` | `Files.ReadWrite.AppFolder` (delegated, no admin consent) |
| Where files go | Visible folder **AlmaMesh backups** in My Drive, created by the app | `/Apps/AlmaMesh/` | `/Apps/AlmaMesh/` (Graph `special/approot`) |
| What we store | The 1 h access token (`expires_in=3600`). There is no refresh token without a client secret. | The long-lived refresh token (Dropbox: "long-lived refresh tokens"); access tokens are short-lived and minted from it | The refresh token. For SPA redirect URIs it expires 24 h after the interactive sign-in, and refreshed tokens "carry over that expiration time", so it is **not** rolling. |
| How often the user sees the provider | Once per device for consent. After each hour, a `prompt=none` bounce with no screen while signed in to Google. | Once per device, until they disconnect or revoke the app in Dropbox | Once a day at most: a `prompt=none` bounce after 24 h, an account screen only if Microsoft needs one |
| Upload | Resumable session (`uploadType=resumable`), one code path for any size; an unfinished session leaves no file | `/2/files/upload` (≤150 MB, under our 128 MiB cap) | `createUploadSession` for >4 MB, simple PUT below |
| Remove | `files.update {trashed:true}` (recoverable 30 days), not `files.delete` | `delete_v2` (recoverable in Dropbox's deleted files) | `DELETE` item (goes to recycle bin) |
| CSP `connect-src` added | `https://www.googleapis.com`, `https://oauth2.googleapis.com` (token revoke) | `https://api.dropboxapi.com` (also the token endpoint), `https://content.dropboxapi.com` | `https://login.microsoftonline.com` (token endpoint), `https://graph.microsoft.com`, plus the download hosts a live trace shows |
| Approval needed | Consent screen published to production; brand verification only if we show a logo | Production approval past the development-user cap (500 per long-standing policy; check the console) | None for personal accounts; work/school tenants are out of scope at launch |

Dropped: **iCloud** (no web API for iCloud Drive; CloudKit JS is a CDN script COEP blocks, sign-in
is a popup COOP breaks, and backups would land in an opaque container), **Box** (token exchange
needs a client secret, no app-folder scope).

**Why not MSAL for OneDrive.** We need the refresh token in our own encrypted SQLite row, and
MSAL won't allow that:

- `@azure/msal-browser` 5.25.0 has no cache plugin. Its `CacheOptions` (checked in
  `types/config/Configuration.d.ts` of the published package) offers only `cacheLocation`:
  `localStorage`, `sessionStorage` or `memoryStorage`. The custom `ICachePlugin` exists in
  `msal-node`, not in the browser library.
- MSAL's caching doc says `memoryStorage` does not support the redirect flow, and we can only use
  redirects under COOP. `localStorage` breaks the "SQLite only" rule and puts tokens outside our
  reset and export controls. MSAL hides the refresh token by design, so we can't copy it out.
- So we run the standard auth-code + PKCE flow ourselves through `oauth4webapi` (Filip Skokan,
  OpenID Certified client, 3.8.8 published 2026-09-05). The same seam file serves Dropbox, so
  there's one OAuth engine for two providers, behind `oauthClient.ts`. This also removes the
  MSAL redirect-bridge question. The cost: we own Microsoft-specific details (the `consumers`
  authority, error codes) that MSAL would handle. That's small for one scope and one flow.

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
- A full-page redirect needs no COOP change, for any of the three providers. No bridge page.
- Before leaving, `oauthRedirect.ts` writes one short-lived record to `sessionStorage`:
  `{ provider, state, pkceVerifier?, returnTo, startedAt }`. `state` is 128 random bits. This is
  protocol state that must survive the redirect, not user data, and it holds no token. It is read
  once and deleted on the callback, and dropped if older than 10 minutes.
- On the callback: compare `state` (mismatch: reject and show "That sign-in didn't come from this
  tab. Try again."), read the token from the fragment (Google) or exchange the code with the
  verifier (Dropbox, Microsoft), then immediately `history.replaceState` to strip the fragment or
  query, hand the token to `driveSession.ts` (which stores it encrypted), and client-side navigate
  to `returnTo`.
- Navigation to the provider uses `location.assign`, not a form, so `form-action 'self'` stays.
- The callback reads the fragment before React mounts any child that could log the URL.
  Diagnostics already emit allowlisted codes only; the callback adds no URL logging.

### Stored credentials

The owner asked why a token can't be kept on the device so the user isn't asked every session.
It can. What we store differs by provider, because what each provider issues to a serverless
browser app differs.

| Provider | Stored | Lifetime | When it runs out |
|---|---|---|---|
| Google | Access token + `expiresAt` | 1 h (`expires_in=3600` in the callback fragment) | Silent renewal: full-page redirect with `prompt=none` (below) |
| Dropbox | Refresh token. Access tokens are minted from it and kept in memory only. | Long-lived, until the user disconnects or revokes the app in Dropbox | Never in normal use. A revoked token gives `invalid_grant`: delete the row and show "Reconnect". |
| OneDrive | Refresh token. Access tokens in memory only. | 24 h from the interactive sign-in, not rolling | `prompt=none` redirect, the same as Google |

**Google silent renewal.** Google's client-side flow lists `prompt=none` as "Don't display any
authentication or consent screens. Must not be specified with other values." ([OAuth 2.0 for
Client-side Web Applications](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow),
checked 2026-10-10). So when the stored token has expired, the next drive action does a full-page
redirect to the same authorize URL with `prompt=none`. If the user is still signed in to Google
and has granted `drive.file`, Google sends a fresh token straight back. The user sees a bounce,
not a screen. If Google can't do that silently, it returns an error to the callback instead of
showing a page. OpenID Connect Core §3.1.2.6 defines these as `login_required`,
`consent_required`, `interaction_required` and `account_selection_required`. Google's page doesn't
list which one it sends here, so the live run records it. On any of them, the app asks the user
to press "Connect Google Drive" again (a normal interactive redirect). It never loops: one silent
try per user action.

The silent bounce runs only when the user presses a drive button, never at page load. It reloads
the app, so it must not interrupt anything else (ruling 1).

**`login_hint`: not possible without asking for identity.** Google says `login_hint` "can be the
user's email address or the `sub` string, which is equivalent to the user's Google ID"
([OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)). With
`drive.file` alone we learn neither. Getting `sub` means adding the `openid` scope and an ID
token, so AlmaMesh would hold a stable Google account ID. We don't do that in v1. Without a hint,
`prompt=none` still works when Google can tell which account to use. A user signed in to several
Google accounts may get `account_selection_required` and see the account picker each hour. The
live run checks this with two accounts signed in (ruling 8).

**Where and how credentials are stored.**

| Rule | How |
|---|---|
| Device-local SQLite | One row per provider, `drive-credential/<provider>`, in the new `device` namespace (the same namespace as the device code). Like `quarantine` and `set-aside`, it is never part of a snapshot, export, restore or backup. A restore never brings another device's credentials in and never wipes this device's. |
| Encrypted at rest | AES-GCM, 256-bit, fresh 96-bit IV per write. The row holds `{ v: 1, iv, ciphertext, provider, expiresAt }`. The additional authenticated data (AAD) is the row key, so a row can't be swapped onto another provider. |
| The key | One `CryptoKey` from `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])`. `extractable: false` means no script, ours included, can read its bytes. |
| Where the key lives | IndexedDB, database `almamesh-device-keys`, one object store, one record. A non-extractable `CryptoKey` has no bytes to put in SQLite. The only way to persist it is the structured clone of the key object, and IndexedDB is the browser store that supports that, keeping it non-extractable. |
| Ruling on "SQLite only for user data" | **The rule holds.** This key handle is not user data. It is not a record, a setting, or a mirror of anything in SQLite. It is an opaque, device-bound capability that can't be serialised. `deviceKey.ts` is the only module that opens this database. A test asserts it holds exactly one record and that the record is a `CryptoKey` with `extractable === false`. Anything else in that database fails the gate. Add a one-line exception to CLAUDE.md where the SQLite rule is stated, naming this database. |
| Lost key, kept rows | If site data is partly cleared and the key is gone but the rows remain, decryption fails. Treat this as disconnected, delete the rows and show "Reconnect". Never a crash, never a retry loop. |
| Deleted on Disconnect | Delete the row. Revoke at the provider where there's an endpoint: Google `POST https://oauth2.googleapis.com/revoke`; Dropbox `POST /2/auth/token/revoke`; Microsoft has no revoke for a single SPA refresh token, so we only delete it. Clear in-memory access tokens. |
| Deleted on full reset | "Reset chart / start fresh" (`lib/resetEverything.ts`) deletes every `drive-*` device row (credentials and drive settings, keeping `device-code`) **and** the `almamesh-device-keys` database; "Reset & reload" (`resetAppData`) already deletes all IndexedDB and OPFS. Today Start fresh only commits a canonical generation (`resetEverything.ts:153`), so the device namespace would survive it: this lands in PR 2, the PR that first writes a credential, with a test that reads storage back. The data deletion page says so. |
| Never logged | Tokens and ciphertext rows never reach diagnostics, error messages, `console`, or test snapshots. `DriveError` messages carry a kind and an HTTP status, never a body or a URL with a token. |
| No identity | No `openid`, `email` or `profile` scope, so AlmaMesh never learns who the user is. The UI says "Connected to Google Drive", never an address. |
| Expiry | Before each call, a token within 60 s of `expiresAt` counts as expired. A 401 maps to `token_expired`, which triggers one refresh (Dropbox, Microsoft) or one silent bounce (Google), and then "Reconnect". |

**What the encryption does and doesn't buy.** It protects against someone reading the OPFS SQLite
file on its own: a copied profile folder without the IndexedDB key, a disk image, or a future bug
that leaks a SQLite row. It does **not** protect against code running in our origin, which can
ask the key to decrypt. MSAL's caching doc says the same about its own encrypted cache: "If a bad
actor gains access to browser storage they would also have access to the key or have the ability
to request tokens on your behalf." The real defences against that are the strict CSP and the
narrow scopes. See the threat model.

### Threat model

What a stolen credential can do, per provider. "Stolen" means an attacker has the decrypted
token: XSS in our origin, malware with the browser profile and its keys, or a token caught in
transit (HTTPS makes the last unlikely).

| Credential | Reach | Can do | Cannot do | For how long |
|---|---|---|---|---|
| Google access token, `drive.file` | Only files AlmaMesh created in that Google account: our backups and their folder | List, download (ciphertext), trash, delete, overwrite them, or upload new files and use up quota | See any other Drive file, read the user's email or profile, open a backup without the passphrase | ≤ 1 h. No refresh token exists to steal. |
| Dropbox refresh token, App folder | `/Apps/AlmaMesh/` only | The same as above, inside the app folder | Anything outside the app folder; decrypt backups | Until the user disconnects or revokes the app in Dropbox's connected-apps settings. The longest-lived credential, so it gets the most care. |
| Microsoft refresh token, `Files.ReadWrite.AppFolder` | `/Apps/AlmaMesh/` in that OneDrive | The same as above | Mail, other files, profile; decrypt backups | ≤ 24 h from sign-in |

In every case the worst outcome is to **availability, not confidentiality**. An attacker can delete
or corrupt backups, but can't read them without the passphrase, and can't reach anything else
in the account. Mitigations:

- The device's SQLite stays the system of record, so losing drive backups loses no live data.
- Prunes and deletes go to the provider's trash or recycle bin, recoverable for about 30 days.
- A planted file can't fool a restore: it must parse as a backup name, open with the user's
  passphrase, and pass the existing `stageBackupImport` validation and preview before anything is
  written. Drive bytes are untrusted input, like any picked file.
- XSS is the path that matters most. `script-src` stays `'self' 'wasm-unsafe-eval'` plus
  Cloudflare Turnstile, with no provider SDK scripts and no CDN. This feature adds no script
  origin. Turnstile is the one third-party script origin; it predates this feature and is listed
  here so nobody forgets it shares the origin with stored tokens.
- The passphrase is never stored, so no stored secret on the device decrypts backups. This is
  why automatic backup needs recipient-key sealing rather than a stored passphrase (ruling 1).

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
  trash this device's ones from the list (other devices' from that device or the drive's own app).
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
- The device code lives in a new **device-local** SQLite namespace (`device`,
  `PORTABLE_DEVICE_NAMESPACE`), like `quarantine` and `set-aside`: never in a snapshot, restore or
  backup. `@almamesh/store`'s `deviceRows.ts` owns it (`getDeviceCode`, `DEVICE_CODE_KEY =
  'device-code'`, the `DeviceRows` seam). The first mint is insert-if-absent and then read back, so
  two tabs racing on first use agree on one code. This matters: if the device code
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
- The user can trash any of **this device's** listed backups by hand (with a confirm). Other
  devices' backups are listed for restore but can't be trashed from here (`guardedDrive.remove`).
- Verification before pruning: download the file back and compare SHA-256 with what was uploaded.
  Only a byte-equal read-back counts as "Backed up". If verification fails, nothing is pruned and
  the UI says "Uploaded, but the check failed. Try again." (Cost: one extra download per backup.
  See ruling 4.)

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
| Token expired mid-flow | One refresh (Dropbox, Microsoft) or one `prompt=none` bounce (Google), then "Reconnect" if that fails. The sealed bytes are kept in memory for a refresh retry; a Google bounce reloads the page, so the user presses Back up again and it re-seals. |
| Drive full | `quota_exceeded`: "Your Google Drive is full. Free some space or trash old AlmaMesh backups." |
| 429 / 5xx | One retry with backoff for idempotent reads (`list`, `download`). Uploads are not auto-retried; the user presses Retry. |
| No background queue in v1 | v1 does not queue backups for later or run them on a timer. PR 6 adds automatic backup; see ruling 1. |

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
| `CLAUDE.md`, "exactly TWO deliberate network egresses" paragraph | Becomes THREE. Add: "(3) **cloud drive backup**: only when the user presses a drive button and consents, the age-sealed backup file and its neutral filename go to the user's own drive provider (Google Drive at launch). Never plaintext, never the passphrase, never a person name in a name. The provider credential is stored encrypted in device-local SQLite and never travels in a backup." Update the `connect-src` note to list the new hosts. Add the one-line `almamesh-device-keys` IndexedDB exception next to the SQLite-only rule. |
| `README.md` "Runtime network and data flow" table | New row: Trigger "Back up or restore with a cloud drive", Destination "Google Drive (your account)", Data sent "The passphrase-sealed backup file, a filename with time, browser, OS and a random device code, normal request metadata", Explicitly not sent "Plaintext data, your passphrase, names, birth details". One row per provider as each ships. |
| `public/_headers` | Add each host to `connect-src` with a justification comment in the same style as Open-Meteo's. |
| Privacy policy `locales/{en,es,pt}/legal.json` | Section 1: one sentence that a drive backup is an encrypted copy the user chooses to send. Section 2 "What Touches the Network": new bullet `s2_li8` "Optional cloud backup" with the README row's wording. Section 6 "Data Retention": backups on your drive are kept by your drive provider under your account until you trash them; AlmaMesh keeps the 10 newest per device. New short section or bullet: "Google's handling of your files is covered by Google's terms". |
| Data deletion page `pages/legal/DataDeletion.tsx` + `legal.json` | Reset deletes the stored drive sign-in and its device key. "Reset & reload" and "clear site data" do **not** delete drive backups. How to delete them: from the in-app list, or in Drive under **AlmaMesh backups**, then empty the trash. |
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
5. Seed a stored credential with a canary token. Assert the canary appears only in the
   `Authorization` header of requests to that provider's own hosts, and in the token-endpoint and
   revoke bodies for that provider. It never appears in a URL, another host's request, the
   console, or any storage other than its encrypted row.

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
| `credentialStore` / `deviceKey` | After connect, the token appears nowhere in plaintext: not in `localStorage`, `sessionStorage`, any SQLite row, IndexedDB, or captured console. The SQLite row decrypts only with the device key; a row moved to another provider's key fails (AAD). The key is a `CryptoKey` with `extractable === false`, and `almamesh-device-keys` holds exactly one record. |
| Not in backups | Seed a credential with a canary token, run `exportPortableBrowserState` and `buildBackupExport`: the canary and the `drive-credential/` key are absent from the bytes. Restoring a backup leaves this device's credential row unchanged. |
| Disconnect and reset | Disconnect deletes the row and calls the revoke endpoint (Google, Dropbox). `resetEverything` deletes every `drive-credential/*` row and the `almamesh-device-keys` database. Both are asserted by reading storage afterwards, not by spying on calls. |
| Renewal | Expired Google token: one `prompt=none` redirect URL built (`prompt=none`, same scope, new `state`), no second attempt after an error. Each of the four OIDC errors maps to "Reconnect". Dropbox `invalid_grant` deletes the row. Microsoft refresh after 24 h falls back to `prompt=none`. |
| Lost key | Rows present, key database deleted: reads as disconnected, rows removed, no throw. |
| Contract suite | `runBackupDriveContract` (`testing/backupDriveContract.ts`) runs against `fakeDrive` and each adapter (with a recorded fake server): upload then list shows it, download is byte-equal, remove hides it, 401 maps to `token_expired`, 403 storage quota maps to `quota_exceeded`, 429 maps to `rate_limited`. |
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
| Token encrypted at rest | `credentialStore` writes the token JSON unencrypted | `credentialStore.test.ts` |
| Key non-extractable | `deviceKey` generates the key with `extractable: true` | `deviceKey.test.ts` |
| Credentials device-local | Put `drive-credential/*` in a portable namespace | not-in-backups test |
| Reset deletes credentials | Drop the credential cleanup from `resetEverything` | reset test |
| Disconnect deletes credentials | Disconnect clears memory only | disconnect test |
| No silent loop | Renewal retries `prompt=none` after an error | renewal test |
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
- Silent renewal: expire the stored token by hand, press Back up, and confirm the `prompt=none`
  bounce returns without a screen. Record which OIDC error Google sends when it can't renew
  silently: signed out of Google, and two Google accounts signed in. Reload inside the hour and
  confirm no redirect at all.
- Disconnect: confirm the revoke call succeeds and the SQLite row and key database are gone.
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
| **2. Google adapter** | `googleDrive.ts`, `oauthRedirect.ts`, `driveSession.ts`, `credentialStore.ts`, `deviceKey.ts`, the `resetEverything` hook, `providerConfig.ts`, `/oauth/callback` route (+ `_redirects`, SW allowlist, `noindex`), CSP hosts + exact-list test, `driveEgress.test.ts` | "Only ciphertext goes to the drive"; "drive credentials are encrypted, device-local, and gone after Disconnect or reset"; "connect-src is closed" | Contract suite green against recorded Google responses; egress, token and CSRF mutation runs red; flag off so no UI reaches it (grep proves no production caller outside the flag); `verify-precache-redirect.mjs` green with the new route; northstar A |
| **3. Google UI + claim** | Provider picker, passphrase setup, backup list, restore from drive in Settings → Data, Hero and Onboarding; drive safety copy; offline states; en/es/pt strings; privacy policy, data deletion page, README table, CLAUDE.md egress paragraph; flag on | "Your data stays on your device unless you choose AI or encrypted cloud backup" | Stubbed Playwright journey green in Chromium and WebKit; real Google round trip run with evidence; privacy copy tests updated and red-run (remove "encrypted" from the es string); reachable from all three entry points; clean console; northstar A |
| **4. Dropbox** | `oauthClient.ts` (`oauth4webapi`), `dropboxDrive.ts`, stored refresh token, revoke on disconnect, CSP hosts, copy rows, picker entry | Same claims, new host; "connect once per device" | Contract + egress suites green for Dropbox; live Dropbox round trip with an owner test account; northstar A |
| **5. OneDrive** | `oneDrive.ts` via `oauthClient.ts` (no MSAL), `consumers` authority, stored 24 h refresh token, CSP hosts from a live trace, copy rows | Same claims, new hosts | Contract + egress suites green; live round trip with a personal Microsoft account in Chromium and WebKit, including a refresh and the 24 h fallback (simulated by expiring the row); northstar A |
| **6. Automatic backup** | age X25519 recipient sealing (`@gainratio/browser/seal` or the `age-encryption` recipient API behind `passphraseSeal.ts`), key file on the drive, "Back up automatically" toggle, debounced on-change trigger | "Your passphrase is never stored"; "automatic backups are ciphertext too" | Restore of an automatic backup needs only the passphrase on a fresh device; no passphrase or private key in any device storage (test); egress suite green for automatic runs; northstar A |

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

- Background sync and any merge of two devices' data. (Automatic backup is PR 6, after launch.)
- Work/school Microsoft accounts, iCloud, Box.
- Partial restore (one profile out of a backup).
- Changing the passphrase of existing drive backups (re-sealing old files).

## Owner rulings (2026-10-10)

The owner approved the spec as written ("go to all"), taking the recommended answer every time.

**Owner ruling R0: the one-key IndexedDB exception.** The `almamesh-device-keys` IndexedDB
database may hold exactly one non-extractable AES-GCM `CryptoKey`. It is a device-bound key
handle, not user data, so the "SQLite only for user data" rule stands unchanged. Only
`deviceKey.ts` opens it, and a test fails the gate if the database ever holds anything else.
CLAUDE.md records the exception next to the SQLite rule.

The twelve open questions are closed:

| # | Question | Ruling |
|---|---|---|
| 1 | Automatic backup in v1? | Ruling: no automatic backup in launch PRs 1–5; PR 6 adds on-change backup (debounced 10 min, at most hourly, only with a token usable without a redirect, never on open), because a sealed backup needs the passphrase, storing it would expose every backup on the drive to whoever steals the device's storage, and recipient-key sealing removes that need; if this is wrong it costs users manual backups until PR 6 ships, which the 14-day nudge softens. |
| 2 | Passphrase on every backup? | Ruling: ask once per tab session at launch; PR 6 switches to an age X25519 key pair whose private key lives only in a passphrase-sealed key file on the drive, because that keeps "restore needs only the passphrase" while letting backups run without it; if this is wrong it costs one passphrase prompt per session until PR 6, and a key-file format we must support afterwards. |
| 3 | How many backups to keep? | Ruling: the 10 newest per device, older ones moved to the provider's trash, as a constant (not a setting), because per-device pruning avoids cross-device races and trash keeps 30 days of recovery; if this is wrong it costs either some drive quota (too many) or a lost older restore point after 30 days (too few), both fixable by changing one constant. |
| 4 | Read-back verification? | Ruling: download every upload back and compare SHA-256 before saying "Backed up" or pruning, because "backed up" must mean "we read it back"; if this is wrong it costs one extra download per backup, and PR 3 measures real sizes so we can switch to provider checksums if that's too heavy on mobile data. |
| 5 | Check the passphrase against existing backups as it's typed? | Ruling: no at launch; PR 6 gets it free by opening the small key file, because checking now means downloading a whole backup and running scrypt; if this is wrong it costs some users a mixed set of backups with different passphrases, which the hint text and the "may use an older passphrase" error mitigate. |
| 6 | MSAL or our own PKCE for OneDrive? | Ruling: our own auth-code + PKCE via `oauth4webapi` (shared with Dropbox), because msal-browser 5.25.0 has no cache plugin, its `memoryStorage` can't do redirects, and it hides the refresh token; if this is wrong it costs us owning Microsoft-specific auth details MSAL would have handled, contained in one seam file. |
| 7 | Google's implicit flow, with a stored token? | Ruling: accept it, with `state`, immediate fragment scrub, strict CSP, a 1 h token encrypted at rest and the `drive.file` scope, because it is Google's only documented browser-only path and a stolen token reaches only our ciphertext for an hour; if this is wrong it costs an hour of delete-or-corrupt access to backups per stolen token, and a move to PKCE if Google ever allows it without a secret. |
| 8 | `openid` for `login_hint`, or show the email? | Ruling: neither in v1; measure the multi-account picker in the live run first, because both make AlmaMesh hold a Google identity; if this is wrong it costs people signed in to several Google accounts an account picker once an hour, fixable later by adding `openid` alone. |
| 9 | Auto device label or user-typed? | Ruling: auto only ("Chrome on macOS" plus a 6-hex code), because a typed label would go into a plaintext filename and could carry a person's name; if this is wrong it costs a little friction telling two same-type devices apart. |
| 10 | Safety copy before a drive restore: drive or local? | Ruling: to the drive by default when connected, with "Save to this device instead", because it's one less file to save and the user is already online; if this is wrong it costs one extra backup in the drive, which retention trims. |
| 11 | Keep "Export to a file"? | Ruling: keep it, because it works offline and without any account; if this is wrong it costs one extra button in Settings → Data. |
| 12 | Drive backup on Pages preview deploys? | Ruling: no, only `almamesh.com` and `localhost:4173` are registered and the buttons hide elsewhere, because Google allows no wildcard redirect URIs; if this is wrong it costs testing drive flows on previews, which the stubbed CI journey covers. |
