# Architecture

**TL;DR:** AlmaMesh is a Vedic astrology app with **no server**. The Python
chart engine — the same `almamesh` package you can run on your laptop — runs
*inside the browser tab* under Pyodide (Python compiled to WebAssembly), fed by
an ed25519-signed, content-addressed bundle cached in durable browser storage.
OPFS is the fast path for the signed engine cache; IndexedDB is that cache's
persistent fallback when a browser exposes OPFS but cannot open it. Canonical
user data is separate: profiles, charts, life events, predictive results, chat,
interpretations, portable preferences, and the optional AI key live together in
one standard SQLite database in OPFS. Neither localStorage nor IndexedDB is an
ongoing user-data mirror. The network carries
delivery metadata and the explicitly disclosed city-search/optional-AI flows;
birth details and computed charts are not sent by the engine or geocoder.
Optional chat memory is also derived entirely on-device: a self-hosted MiniLM
Worker produces embeddings, then the shared `@gainratio/browser/vector/sqlite`
Worker performs exact cosine search with profile and generation filters. Its
SQLite database persists in OPFS; no in-memory JavaScript similarity loop or
IndexedDB vector copy participates in live retrieval.

This page is the orientation map. The deep, always-current reference is
[CLAUDE.md](../CLAUDE.md) (tech stack, package table, data contract, quality
gates); the [README](../README.md) carries the product story. Per the portfolio
standard, this repo is the exemplar for the "Pyodide app engine" pattern
(ENGINEERING-STANDARDS §8.1a).

## The delivery + compute flow

![Signed bundle → OPFS primary path → Pyodide engine](assets/delivery-flow.svg)

The diagram shows the primary OPFS path. IndexedDB implements the same cache
contract when OPFS cannot open and always retains the shared monotonic release
floor, so switching storage backends cannot accept an older signed bundle. That
small IndexedDB control plane is required even on the OPFS fast path; serialized
reads and syncs ensure pruning cannot invalidate an in-flight reader. Successful
syncs prune its content to the active release when Web Locks are available;
otherwise pruning is skipped. Quota failures keep serving the last authenticated
complete release.

*Diagram source: [assets/delivery-flow.d2](assets/delivery-flow.d2) (d2, the
house diagram format).*

1. **Build time** — `almamesh-bundle` (the Python CLI in `backend/`) assembles
   the engine wheel, the JPL DE421 ephemeris, and the Pyodide/Skyfield wheels
   into a content-addressed bundle and signs it with an ed25519 key. The
   private key never enters the repo (CI tree-guard enforces it); the release
   verification key ships from the same origin as `/public.key`, with a
   hash-versioned service-worker fallback for offline boots.
2. **Delivery** — the bundle is static files on Cloudflare Pages. One-way:
   nothing ever flows back.
3. **In the tab** — `@almamesh/browser` verifies the signature (fail-closed:
   a bad signature raises, never downgrades), syncs chunks into a private,
   durable content-addressed cache (**OPFS**, or **IndexedDB** when OPFS cannot
   open), and boots the **unchanged wheel** under
   Pyodide in a Web Worker. Charts compute off the UI thread, byte-identical
   to CPython — `apps/web/scripts/verify-browser-parity.mjs` enforces that
   identity in CI by driving the real Worker in headless Chromium and
   byte-comparing every natal fixture against the committed CPython golden.
   (Transit, predictive, and mesh goldens are enforced CPython-side by the
   backend suite; their Pyodide parity is not yet browser-gated.)
4. **UI** — React reshapes `SiderealChart → ChartData` and renders. TypeScript
   never computes astrology (house rule #2).

## Local semantic-memory flow

When optional chat is used, `@almamesh/memory` chunks messages and asks the
self-hosted MiniLM Worker for 384-dimensional embeddings. A thin AlmaMesh
adapter hands those vectors and flat profile/thread/message metadata to the
shared SQLite Worker. `sqlite-vector` ranks matches inside that Worker and the
database persists in OPFS. Generation-prefixed physical IDs plus durable
deletion-ledger checks prevent a delayed pre-restore write from becoming
visible; profile/thread erasure and full reset are atomic SQLite deletes. Chat
history in the canonical SQLite database remains authoritative, so derived vectors can be rebuilt
after restore or recovery.

Semantic retrieval requires a working Origin Private File System. If a browser
does not provide it—or exposes `getDirectory()` but refuses to open it—the
adapter fails closed before spawning SQLite. There is deliberately no
JavaScript cosine, in-memory, or IndexedDB-vector fallback. The deployed
COOP/COEP headers make the app cross-origin isolated, and the browser gate
proves the SQLite runtime prerequisites (`SharedArrayBuffer` and
`Atomics.waitAsync`) plus an isolated offline reload in Chromium and WebKit. A
separate real-SQLite Chromium gate proves write, query, close, and
OPFS reopen; the WebKit harness proves a stable refusal when its headless OPFS
implementation is unavailable.

## Portable application state

`@almamesh/store` maps each existing, versioned Zustand envelope to a row in a
single `almamesh-user-state` SQLite database. The deletion ledger and those
rows commit through compare-and-swap transactions. Generation fencing prevents
a stale tab from crossing a Replace/delete boundary. Ordinary same-generation
writes use a three-way merge at the SQLite boundary: independent record and
stable-ID list changes survive, either side's deletion wins, and only a true
same-field conflict is local-wins. Paid relationship narrations additionally
use a pair-key CAS merge so separate pairs completed in different tabs are
preserved. On first eligible launch, the old
idb-keyval records are copied, integrity-checked, and only then removed. A crash
before cleanup leaves a redundant source copy and the migration safely resumes.
Legacy localStorage preferences follow the same verify-before-delete rule. An
interpretation row that is not valid JSON (legacy, or a canonical row an older
build copied in unparsed) is never migrated: it moves to the localStorage key
`almamesh-interpretations.quarantine` (timestamped, dropped after 30 days, not
part of canonical SQLite or backups, erased by both reset paths) and boot shows
a notice. A persist hydration error settles the hydration barrier as `failed`
instead of hanging the first render. Once
migration completes, live reads and writes use SQLite only; in-memory snapshots
serve synchronous UI reads without creating another durable authority.

Settings exports one timestamped `.almamesh` file: format v3 seals the exact
canonical SQLite bytes with the user's password (PBKDF2-SHA256 600k +
AES-256-GCM, authenticated binary header). AI provider, models, API key,
language, and content preferences already live in versioned SQLite rows, so
there is no second settings payload to apply after the database commit. Every
restore is staged in an isolated in-memory database before atomically replacing
the live generation. Raw SQLite, encrypted v2, and legacy JSON backups remain
importable. The password protects the transport file only: import decrypts it
once and installs ordinary SQLite into the destination browser's OPFS, so later
launches do not ask for that password. Predictive results travel in canonical
SQLite. Semantic vectors, embedding assets, and signed engine-delivery caches
are not exported; they are rebuilt or downloaded from restored source records.
Restore is disabled
when SQLite is running in session-only memory mode because the required reload
would otherwise erase the imported database.

The key portability path is deliberately browser-independent: Chrome exports
one encrypted `.almamesh` file, the user transfers it to an iPhone, and iOS
Safari imports it. After validation and Replace, Safari hydrates every durable
surface from its newly installed canonical SQLite database. Browser-specific
cache files are neither required nor copied.

## Where things live

| Area | Path | Notes |
|---|---|---|
| Python engine + bundle publisher | `backend/src/almamesh/` | Pydantic models, Skyfield astronomy, dasha/yoga/mesh/rectification engines |
| Signed-bundle delivery core | `edge-proc` (PyPI) | pinned `>=0.5.0` in `backend/pyproject.toml` (0.3.0 was the first release whose anti-replay guard fails closed; 0.5.0 adds the signed `key_id`/`expires_at` pointer fields `release_guard` checks as a device would) |
| Browser engine + PWA | `frontend/` (Bun workspace) | packages table in [CLAUDE.md](../CLAUDE.md#frontend-monorepo-packages-frontendpackages) |
| Specs (numbered) | `docs/specs/` | feature design records |
| CI/CD + deploy | `dagger/src/index.ts` → Cloudflare Pages | typed secrets, key custody, and exact live identity; GitHub workflows are pinned ingress only |

## Load-bearing invariants

- **Determinism:** same inputs → byte-identical chart on CPython and Pyodide.
  The inputs are `(datetimeUtc, latitude, longitude, referenceDate)` — all four,
  including the reference instant that pins the "current" Vimshottari daśā. The
  engine reads no clock: `BirthInput.referenceDate` is REQUIRED and the shipped
  glue raises rather than substituting `now()`
  (`chartWorker.ts` `_almamesh_generate_chart`). The app mints that instant once
  per generation in `packages/store/src/chartReferenceInstant.ts` and stores it
  as the chart's `calculation_timestamp`, so the printed generation date is the
  key that reproduces the chart. Guarded by
  `backend/tests/test_chart_worker_glue.py`, which runs the SHIPPED glue —
  extracted from the TypeScript, not re-implemented — against the CPython golden.
- **Zero egress on the chart path;** exactly two disclosed opt-in egresses
  (cloud AI, birthplace geocoding) — see the data-contract section of
  [CLAUDE.md](../CLAUDE.md#data-contract-no-api-its-a-transform--signed-bundle).
- **Client-side data is sacred:** storage formats, cache names, and the bundle
  verify key are compatibility surfaces for real users — never change them
  casually.
