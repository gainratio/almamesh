# Spec 061: Backup & Restore (Export / Import your data)

**Lifecycle:** SHIPPED
**Status:** Shipped in v0.4.0
**Created:** 2026-07-01
**Priority:** P1 HIGH
**Dependencies:** none (independent of the in-flight feedback PRs #8/#9)

> **Implementation update:** the original sections below document the legacy
> JSON/IndexedDB design and remain useful for compatibility. The shipped
> primary path now stores canonical user data in one OPFS SQLite database,
> exports standard `.sqlite3` bytes, validates imports in an isolated SQLite
> instance, and commits them as a fresh generation. Existing plaintext and
> encrypted JSON backups remain importable. API keys and derived caches are
> excluded from both formats.
>
> **Format v2 (2026-10, supersedes the API-key exclusion above):** Export now
> requires a password (8+ characters) and writes one encrypted `.json` file
> (`formatVersion: 2`) holding the canonical SQLite database **and** device
> settings, including the AI provider, models, and API key
> (`almamesh-llm-settings`). Nothing but the header is plaintext: PBKDF2-SHA256
> (600,000 iterations) derives an AES-GCM-256 key; the random salt and IV live
> in the header, and the header is bound to the ciphertext as AES-GCM additional
> data. Import asks for the password; a wrong password or any edit to the file
> is refused before anything is written, and settings are applied only after
> the database commit succeeds. v1 `.sqlite3` and legacy JSON backups still
> import (their data restores; AI settings must be reconnected). Derived caches
> are still rebuilt rather than exported. Code: `packages/store/src/portableBundle.ts`,
> `packages/store/src/portableSettings.ts`.

## Goal

Let a user move ALL of their data from one browser to another with a single
downloadable file. AlmaMesh is local-first with no server, so this is a
deliberate, user-driven, offline transfer: **Export** produces one portable file;
**Import** rebuilds the full state on another browser and the user continues
seamlessly. This is the top real-user request that arrived through the feedback
widget ("export the data and import it to another browser").

---

## Pre-implementation state (historical)

Before Spec 061 shipped, all user state lived in the browser across three tiers and was
**siloed per browser** — there was no way to move it. The only "reset" paths were
`resetEverything.ts` (wipe user data, keep engine) and `resetAppData.ts` (nuclear).
Nothing exported.

The persistence surface (authoritative inventory):

**User data — 7 named stores (the export set):**

| persist key | tier | version | migrate fn | holds |
|---|---|---|---|---|
| `almamesh-profiles` | IndexedDB (idb-keyval) | 1 | `migrateProfilesPersistedState` | profiles + members/relationships + activeProfileId |
| `almamesh-chart-library` | IndexedDB | 1 | `migrateChartLibraryPersistedState` | charts + raw engine output + birth data |
| `almamesh-life-events` | IndexedDB | 4 | `migrateLifeEventsPersistedState` | per-profile life events |
| `almamesh-rectification-records` | IndexedDB | 1 | `migrateRectificationRecordsPersistedState` | confirmed rectified birth-times |
| `almamesh-chat-history` | IndexedDB | 1 | `migrateChatPersistedState` | AI chat threads + messages |
| `almamesh-interpretations` | localStorage | 2 | `migrateInterpretationPersistedState` | generated readings per chart |
| `almamesh-language` | localStorage | 1 | `migrateLanguagePersistedState` | language preference |

All five IndexedDB stores live in one idb-keyval DB (`keyval-store` / object
store `keyval`), one key each. Every store already ships a Zustand `persist`
`version` + `migrate` — we reuse those, we do NOT re-implement migration.

**Excluded (re-derivable / re-downloadable / secret):**

| item | why excluded |
|---|---|
| OPFS engine bundle (~38 MB) | re-downloads/re-syncs on first load |
| `almamesh-chat-vectors` (idb) | RAG embeddings; rebuilt from chat history |
| `almamesh-llm-settings` (localStorage) | **contains the API key** — user re-enters once |
| `almamesh-chart` (localStorage flag) | derived route-guard mirror; **re-set on import** |
| `almamesh-feedback-dismissed-*` | UI nag flags |
| Cache Storage / SW caches | app shell, fonts, i18n, model weights, engine chunks |
| transient stores (mesh/predictive/rectification/…) | recomputed on demand from charts |

---

## Requirements

### Must Have
- **Export**: read the 7 stores across both tiers and produce ONE JSON file
  `almamesh-backup-YYYY-MM-DD.json`, downloaded to the user's device.
- **Versioned envelope**: a top-level `formatVersion` guards the file shape; each
  store snapshot carries its own persisted `version` so import stays
  forward/backward compatible.
- **Optional passphrase encryption**: Web Crypto only (no deps) — PBKDF2 (SHA-256)
  → AES-GCM-256, random salt + IV. Blank passphrase ⇒ plain file. Envelope
  metadata (`format`, `app.version`, `exportedAt`, `encryption`) stays plaintext
  so the importer can identify the file before asking for a password.
- **Import = Replace, with a safety net**:
  1. Parse + (decrypt) + validate + stage ALL stores **in memory first**
     (all-or-nothing — a corrupt/partial file NEVER half-restores).
  2. Auto-download a backup of the CURRENT data (`…-before-import-…json`) so
     Replace is undoable.
  3. Confirm dialog, then write each store, **set the `almamesh-chart` flag**,
     **delete `almamesh-chat-vectors`** (so RAG rebuilds), then reload.
- **Exclusions** exactly as the table above (no engine bundle, no API key, no
  RAG vectors, no caches/flags).
- **Reachable UI**: a "Backup & Restore" panel in Settings, discoverable and
  linked, with Export and Import actions, the passphrase field, and the confirm
  dialog. Clean console; correct on screen.
- **i18n**: all new strings in en/es/pt with key parity (parity test + verify-i18n).
- **Determinism / privacy**: no new egress. Nothing leaves the device except the
  file the user chooses to save.

### Should Have
- **Native file pickers** via the File System Access API (`showSaveFilePicker` /
  `showOpenFilePicker`) where supported (lets the user save straight into a synced
  Drive/Dropbox/iCloud folder), falling back to `<a download>` + `<input type=file>`
  on Safari/Firefox.
- **Too-new refuse**: if the file's `formatVersion` (or any store snapshot version)
  exceeds what this app understands, refuse with a clear "update the app first"
  message rather than corrupting state.
- A one-line sensitivity note near Export: "This file contains your birth data and
  chat history — keep it private."

### Out of Scope
- In-app cloud (Google Drive / OAuth) integration — the user saves the file
  themselves; the app never contacts a third party.
- Merge-on-import (replace only for v1).
- Exporting the LLM API key.
- Exporting the engine bundle or any cache.
- Selective / partial export (all-or-nothing bundle for v1).

---

## Technical Design

### Envelope (typed contract, in `@almamesh/shared-types`)

```ts
export interface BackupStoreSnapshot {
  version: number;          // the store's persisted Zustand version
  state: unknown;           // the persisted `state` object (verbatim)
}

export interface BackupEnvelopePlain {
  format: 'almamesh-backup';
  formatVersion: 1;
  app: { version: string }; // build version (from __APP_VERSION__ / 'dev')
  exportedAt: string;       // ISO 8601
  encryption: 'none';
  stores: Record<string, BackupStoreSnapshot>;
}

export interface BackupEnvelopeEncrypted {
  format: 'almamesh-backup';
  formatVersion: 1;
  app: { version: string };
  exportedAt: string;
  encryption: 'aes-gcm';
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string /*b64*/ };
  iv: string;               // b64
  ciphertext: string;       // b64 AES-GCM of JSON.stringify(stores)
}

export type BackupEnvelope = BackupEnvelopePlain | BackupEnvelopeEncrypted;
```

### Store registry — single source of truth (`@almamesh/store`)

```ts
type Tier = 'local' | 'idb';
interface RegistryEntry { key: string; tier: Tier; }

// Adding a future persisted store = one line here.
const BACKUP_STORES: RegistryEntry[] = [
  { key: 'almamesh-profiles',              tier: 'idb'   },
  { key: 'almamesh-chart-library',         tier: 'idb'   },
  { key: 'almamesh-life-events',           tier: 'idb'   },
  { key: 'almamesh-rectification-records', tier: 'idb'   },
  { key: 'almamesh-chat-history',          tier: 'idb'   },
  { key: 'almamesh-interpretations',       tier: 'local' },
  { key: 'almamesh-language',              tier: 'local' },
];

const CHART_FLAG_KEY = 'almamesh-chart';        // set on import if charts exist
const CHAT_VECTORS_KEY = 'almamesh-chat-vectors'; // delete on import → rebuild
```

Each tier is read/written through a tiny injectable `StorageTier` interface
(`get(key)/set(key,val)/del(key)` → `local` = localStorage, `idb` = idb-keyval),
so the module is unit-testable without a real browser.

### Core module (`@almamesh/store/src/backup.ts`)

- `collectBackup(): Promise<BackupEnvelopePlain>` — for each registry entry, read
  the raw persisted JSON string, parse to `{ state, version }`, assemble the
  plaintext envelope. Missing keys are skipped (a fresh store simply isn't
  present). Stamps `app.version` + `exportedAt` (passed in — no `Date.now()` in
  pure core; the caller supplies the timestamp).
- `applyBackup(envelope, opts): Promise<void>` — validate `format`/`formatVersion`;
  refuse too-new; then for each store write `JSON.stringify({ state, version })`
  back to its tier. Post-write: set `CHART_FLAG_KEY='1'` iff chart-library present
  & non-empty; `del(CHAT_VECTORS_KEY)`. Restore is staged in memory and only
  written after full validation (all-or-nothing). Zustand `persist` + each store's
  `migrate` run on the next app load — migration is NOT re-implemented here.
- Crypto helpers (`backupCrypto.ts`): `encryptStores(stores, passphrase)` →
  `{ kdf, iv, ciphertext }`; `decryptStores(encrypted, passphrase)` → `stores`.
  Wrong passphrase ⇒ AES-GCM auth failure ⇒ typed error, no writes.

### UI (`apps/web`)

- `BackupRestorePanel.tsx` (Settings): Export button (+ optional passphrase input),
  Import button, sensitivity note, confirm dialog copy. Wires the core module to
  file I/O.
- `lib/backupFile.ts`: `saveBackupFile(name, json)` (FS Access API → download
  fallback) and `pickBackupFile()` (FS Access API → `<input type=file>`), plus the
  `Date.now()`/`new Date()` timestamp + `app.version` injection at the edge.
- Import orchestration (a hook or handler): pick → read → decrypt-if-needed →
  validate → auto-export current (safety net) → confirm → `applyBackup` → reload.

### Error handling
- Malformed JSON / wrong `format` / too-new `formatVersion` → typed error, nothing
  written, user-facing message.
- Encrypted file + wrong/blank passphrase → typed `bad_passphrase`, retry allowed.
- Empty browser export (nothing to back up) → still produces a valid (near-empty)
  envelope; UI notes there's little to export.
- All-or-nothing: any staging error aborts before the first write.

---

## Files to Create/Modify

| File | Changes |
|------|---------|
| `frontend/packages/shared-types/src/index.ts` | **NEW types** — `BackupEnvelope*`, `BackupStoreSnapshot` |
| `frontend/packages/store/src/backup.ts` | **NEW** — registry, `collectBackup`, `applyBackup`, `StorageTier` |
| `frontend/packages/store/src/backupCrypto.ts` | **NEW** — Web Crypto encrypt/decrypt helpers |
| `frontend/packages/store/src/backup.test.ts` | **NEW** — round-trip, migrate-on-load, all-or-nothing, flags |
| `frontend/packages/store/src/backupCrypto.test.ts` | **NEW** — encrypt/decrypt round-trip + wrong passphrase |
| `frontend/packages/store/src/index.ts` | export the backup API |
| `frontend/apps/web/src/lib/backupFile.ts` | **NEW** — FS Access API save/open + download fallback + edge timestamp |
| `frontend/apps/web/src/lib/backupFile.test.ts` | **NEW** — picker fallback logic |
| `frontend/apps/web/src/pages/settings/BackupRestorePanel.tsx` | **NEW** — the panel UI |
| `frontend/apps/web/src/pages/settings/__tests__/BackupRestorePanel.test.tsx` | **NEW** — component tests |
| settings route / index | mount + link the panel (discoverable) |
| `frontend/apps/web/src/locales/{en,es,pt}/settings.json` (or a new `backup` namespace) | new strings, 3-way parity |
| `frontend/apps/web/src/locales/*.parity.test.ts` | cover the new keys |

---

## Implementation Phases

**Phase 1 — Core (parallelizable):**
- 1a. shared-types envelope contract.
- 1b. `backup.ts` registry + collect/apply (TDD) against injectable tiers.
- 1c. `backupCrypto.ts` encrypt/decrypt (TDD).

**Phase 2 — Edge + UI (depends on Phase 1 API):**
- 2a. `backupFile.ts` file I/O + timestamp/app-version injection (TDD on fallback).
- 2b. `BackupRestorePanel.tsx` + import orchestration + safety-net + confirm (TDD).
- 2c. Mount + link in Settings (reachable).

**Phase 3 — i18n (parallel with Phase 2):**
- en/es/pt keys + parity tests + verify-i18n.

**Phase 4 — Gates + live validation:**
- `bun run --filter '*' typecheck`, `test:unit`, parity gate.
- Build + preview; drive the REAL app: Export on browser A → Import on a fresh
  browser B → charts + chat continue, clean console. Encrypted round-trip. Verify
  the safety-net backup downloads and Replace is undoable.

---

## Testing

**Unit (Vitest):**
- `collectBackup` emits every present store with correct `version` + `state`.
- Export → wipe tiers → `applyBackup` → identical state (round-trip).
- Older store `version` in the file → restored raw → Zustand `migrate` runs on
  reload (assert the persisted envelope is written with the file's version).
- Too-new `formatVersion`/store version → refused, no writes.
- All-or-nothing: a corrupt store aborts before any tier write.
- `almamesh-chart` flag set; `almamesh-chat-vectors` deleted on import.
- Crypto: encrypt→decrypt round-trip; wrong passphrase → typed error, no writes.
- `backupFile`: FS Access API path used when present; download/`<input>` fallback
  when absent.

**Live e2e (Playwright, production build):**
- Seed data on a context, Export, open a FRESH context, Import, confirm the
  dashboard renders the imported charts and chat threads with a clean console.
- Encrypted export → import with the passphrase.
- Reachability: the panel is navigable from Settings.

---

## Non-negotiables (project quality gates)
- No server, no new egress; the engine stays zero-egress.
- TDD (tests land with the code); ≥ the repo's standard gates green.
- Reachable + correct on the real built app (not just the hooked exit gate).
- i18n 3-way parity from the start.
