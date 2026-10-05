# Spec 061: Portable backup and restore

**Lifecycle:** SHIPPED

**Status:** canonical SQLite with encrypted `.almamesh` transport

**Created:** 2026-07-01

**Updated:** 2026-10-03

## TL;DR

AlmaMesh has no account and no centralized database. The user's browser is the
database, so a reliable Browser A → Browser B transfer is a core product
contract, not an optional convenience.

User data and portable preferences have one system of record: an OPFS SQLite
database. **Export data** downloads that database inside one passphrase-encrypted
binary `.almamesh` file. **Import data** is visible beside Export in Settings
and replaces the destination browser only after the file has been decrypted,
validated, and confirmed. A wrong passphrase, a modified file, or an invalid
database changes nothing.

The primary acceptance story is concrete: a user with all AlmaMesh data in
desktop Chrome exports once, transfers the `.almamesh` file to an iPhone, opens
AlmaMesh in iOS Safari, and imports it. Safari then shows the same durable
profiles, charts, current-timing results, readings, chats, preferences, and AI
configuration. No AlmaMesh server participates.

Example filename:

```text
almamesh-backup-2026-10-03T21-32-18-417Z.almamesh
```

The full UTC timestamp, including milliseconds, avoids the date-only collisions
of the old filename. The file also carries an internal format version; its
extension is not the versioning mechanism.

## What is canonical

The canonical SQLite database contains user-authored state and portable choices:

| SQLite row | Contents |
|---|---|
| `almamesh-profiles` | people, relationships, and active profile |
| `almamesh-chart-library` | saved charts, birth inputs, and lossless engine output |
| `almamesh-life-events` | dated life events |
| `almamesh-rectification-records` | accepted rectified birth times and records |
| `almamesh-chat-history` | chat threads, messages, and summaries |
| `almamesh-interpretations` | saved/generated chart interpretations |
| `almamesh-mesh-readings` | completed AI relationship narrations and their exact input identity |
| `almamesh-predictive` | completed current-timing/predictive results and their source identity |
| `almamesh-language` | language preference |
| `almamesh-preferences` | versioned AI provider/models/API key, content mode, and model-suggestion dismissal |

Existing Zustand version envelopes remain the typed application boundary. The
SQLite file stores those envelopes together so an export observes one coherent
generation. localStorage and legacy user-state IndexedDB values are migration
inputs only: startup copies them into SQLite, verifies the canonical write, and
then deletes them. They are never maintained as ongoing user-data mirrors.
Synchronous UI consumers read hydrated in-memory snapshots; routing derives from
the hydrated canonical chart library.

AlmaMesh does not have account passwords. A profile is a named person on one
device, not a login. The only persistent bearer credential in the app is the
optional AI provider API key, and it is included only inside the encrypted
backup. The live OPFS SQLite database is not password-encrypted: origin isolation
and the browser/OS security boundary protect it, with the limitations described
in the security documentation. The transfer passphrase is requested only when
exporting or importing an encrypted file; it is not required at normal startup.
The backup passphrase itself is never stored in SQLite, localStorage,
the file, logs, or analytics; losing it makes that backup unrecoverable.

## What is deliberately rebuilt

The backup excludes state that is downloaded or deterministically derived:

- the signed engine and Pyodide bundles;
- service-worker, HTTP, and application caches;
- semantic-search vectors and embedding model assets;
- transient relationship-mesh edges and other recomputable working state;
- ephemeral dialogs, progress, and browser UI state; and
- browser cookies, browser credentials, deployment secrets, signing keys, and
  CI secrets, which are not AlmaMesh user data.

After import, the app hydrates routing and UI state directly from canonical
SQLite and rebuilds derived search memory from canonical chats. “Looks
identical” means the same durable user-visible profiles, charts, predictive
results, events, readings, chats, settings, and choices—not identical cache
files or byte-for-byte identical destination storage metadata.

## Current transport contract

The normal user-facing export is always encrypted and requires a passphrase of
at least eight characters. Its `.almamesh` body uses Web Crypto only:

- PBKDF2-HMAC-SHA-256 with 600,000 iterations and a random salt;
- AES-256-GCM with a random IV;
- authenticated, versioned framing; and
- the exact exported SQLite bytes as the encrypted payload.

The framing contains only the non-secret information required to identify and
decrypt the format. The SQLite header, user data, AI settings, and API key do not
appear in plaintext. Import bounds the file and ciphertext sizes, validates the
algorithm parameters, authenticates the entire encrypted payload, and validates
SQLite integrity and its allowlisted rows before offering Replace.

The decrypted payload is ordinary SQLite. The downloadable file is not raw
SQLite because raw SQLite would expose birth data, chats, and the API key to
anyone who obtained it.

Encryption belongs to the exported transport, not the live database. Import
asks for the file password once, decrypts and validates the payload in memory,
then installs normal SQLite bytes in the destination origin's OPFS. The user is
not prompted again on page load.

### Chrome to iOS Safari

1. In Chrome, open **Settings → Data → Export my data**.
2. Choose a transfer password and save the timestamped `.almamesh` file.
3. Move the file to the iPhone using Files, AirDrop, iCloud Drive, or another
   transport the user controls.
4. Open the same AlmaMesh origin in a normal iOS Safari tab, then choose
   **Settings → Data → Import a backup**.
5. Select the file and enter the transfer password once.
6. AlmaMesh validates it, downloads an encrypted safety backup of any Safari
   data already present, asks for Replace confirmation, installs the canonical
   SQLite database, and reloads.
7. Safari now reads the restored state from its own OPFS database. Future loads
   do not need the transfer password.

### Compatibility

The application can import older AlmaMesh backups so existing users are not
stranded:

- encrypted v2 JSON bundles;
- legacy JSON store envelopes; and
- raw `.sqlite3` data-only exports.

Those formats are **import-only**. New Export and automatic pre-import safety
backups use the encrypted `.almamesh` format. Older data-only formats cannot
restore settings they never contained, such as an AI API key.

## Import lifecycle

1. The user chooses **Import data** in Settings and selects a file.
2. The app reads and stages it without mutating current state.
3. For `.almamesh`, the user enters the backup passphrase. Authentication fails
   closed: a wrong passphrase and ciphertext tampering are indistinguishable and
   neither can reach the database commit.
4. The app validates the transport version, size limits, SQLite integrity,
   schema version, allowlisted canonical rows, store envelopes, and settled
   generation ledger.
5. The UI shows a Replace confirmation before changing local data.
6. Before Replace, the app downloads an encrypted
   `almamesh-backup-before-import-<full-UTC-timestamp>.almamesh` safety backup of
   the destination. If saving that safety backup is cancelled or fails, import
   stops without changing data. Browsers with the native save picker confirm
   completion directly; the ordinary-download fallback cannot, so the user must
   explicitly confirm that the file appeared in Downloads before Replace.
7. One restore operation replaces canonical SQLite state and reloads the app;
   UI and routing hydrate from that database without recreating durable mirrors.
8. Semantic chat memory and other derived state rebuild from canonical records.

Restore is replace-only. Merge and selective restore are intentionally out of
scope until they can preserve the same atomicity and deletion guarantees.

## Failure and privacy guarantees

- No backup bytes are uploaded; save and open happen entirely in the browser.
- Export requires encryption; there is no normal plaintext export action.
- Import stages before commit and never partially applies a malformed file.
- Import requires durable SQLite storage. There is no session-only memory
  fallback (2026-10-05): when OPFS is refused the app shows its storage block
  screen, so Import and Export are never reachable without durable SQLite.
- Wrong-passphrase, tamper, unsupported-version, oversized-file, invalid-SQLite,
  and foreign-row failures leave existing data unchanged.
- Restore carries deletion/generation metadata so another tab cannot resurrect
  deleted data during Replace.
- A cancelled safety-backup download cancels Replace.
- An unverified fallback download pauses Replace until the user confirms the
  encrypted safety file is present.
- Native file pickers are used where available, with ordinary download/file
  input fallbacks for browsers that do not implement them.

## Acceptance evidence

Unit coverage owns cryptographic framing, size/parameter limits, legacy import,
SQLite validation, relationship-narration and predictive portability, migration
cleanup, SQLite hydration, and atomic failure behavior.

`frontend/apps/web/e2e/portable-sqlite-state.spec.ts` exercises the real built
PWA and browser storage path:

- migrate pre-SQLite state into canonical OPFS SQLite;
- show both Export and Import in Settings;
- export a timestamped encrypted `.almamesh` file;
- prove the file contains neither the API key nor the SQLite header;
- prove a wrong passphrase and a one-byte modification do not mutate an empty
  destination;
- restore in a fresh browser context; and
- verify profile, language, AI settings/API key, content mode, and a saved
  relationship narration rendered from restored SQLite, including
  `/` routing from the hydrated chart library to the dashboard; and
- prove migrated localStorage and user-state IndexedDB inputs are removed rather
  than retained as mirrors.

The browser test also watches for external network requests, failed requests,
uncaught page errors, and console errors.

## Non-goals

- account-based cloud sync (AlmaMesh has no account service);
- storing or recovering a forgotten backup passphrase;
- exporting browser/OS credentials or repository/deployment secrets;
- copying recomputable caches or the signed engine bundle; and
- claiming byte-identical destination database metadata after a restore.
