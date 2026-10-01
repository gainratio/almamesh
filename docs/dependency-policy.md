# Dependency policy — deliberately held majors

**TL;DR:** Everything not listed here floats on its caret range and should be
kept current. Registry dependencies are trusted through exact versions where
required, the frozen lock, integrity metadata, provenance tests, and unsuppressed
audits—not elapsed time. The majors below are **held on purpose** because each
newer major needs its own validated migration (live-driven, not just CI-green),
and `main` auto-deploys to almamesh.com. A held major must have a one-line
justification here (or at the pin site, cross-linked here); a hold without one is
a bug in this file.

## The holds

| Dependency | Held at | Where | Why (one line) |
|---|---|---|---|
| `vite` | `^6` | `frontend/apps/web/package.json` | The v6→v8 jump swaps the bundler core (rolldown); a bundler swap must land on its own live-driven branch — it must not ride unvalidated into auto-deploy. The standalone browser Lego's own Vite 8 dev toolchain does not enter this consumer runtime. |
| `@vitejs/plugin-react` | `^4` | `frontend/apps/web/package.json` | Paired with Vite 6 and moves in the same separately validated bundler migration. |
| `@mui/material` | `^7` | `frontend/apps/web/package.json` | The v9 migration is its own validated effort (theme + component API churn across every picker/modal surface). |
| `@mui/x-date-pickers` | `^8` | `frontend/apps/web/package.json` | Same v9 effort as MUI core — and the pickers carry a hard-won controlled-input scar (typed dates corrupted by controlled-value resync; only a real-browser probe reproduces it), so any bump needs live-browser validation of onboarding date/time entry. |
| `typescript` | `~5.7` | root + all `frontend/packages/*` and `apps/web` | TS6+ needs ecosystem alignment (typescript-eslint, `tsc -b` project references) across all workspace packages at once — a single-package bump breaks the shared toolchain. The standalone browser Lego ships compiled ESM/types, so its newer build compiler does not enter this workspace. |
| `@huggingface/transformers` | `3.8.1` (exact) | `frontend/apps/web/package.json`, `frontend/packages/memory/package.json` | 4.x pulls `onnxruntime-web` 1.31.0-dev, whose WASM (26.86 MB bundled asyncify, 28.35 MB jsep in `public/models/ort/`) is over Cloudflare Pages' 25 MiB per-file upload limit; Dependabot PR #175 broke the prod deploy with it. 3.8.1 ships `onnxruntime-web` 1.22.0-dev (21.6 MB jsep). Lift only when the new major's WASM fits under 26,214,400 B — `deployDryRun`'s `assertPagesUploadLimits` gates it. |
| `three` (+ `@types/three`) | `^0.172` | `frontend/apps/web/package.json` | three's 0.x minors are de-facto majors; a bump must be validated live against `@react-three/fiber` in the 3D force-field hero, not just typechecked. |
| `pyodide` | `^0.29` | `frontend/packages/browser/package.json` (mirrored by `PYODIDE_VERSION` in `frontend/apps/web/scripts/setup-dev-assets.sh`) | The version-pinned WASM runtime inside the signed bundle: a bump must re-pass the Pyodide==CPython byte-parity gate and re-ships the immutable `pyodide/*` CDN assets — see `docs/deploy/almamesh-com.md`. |
| `tailwindcss` | `^3.4` | `frontend/apps/web/package.json` | The v3→v4 migration replaces the config model (JS `tailwind.config` → CSS-first `@theme`) and the build integration (PostCSS plugin → `@tailwindcss/vite`), and this app's theme rides a shared preset (`@almamesh/constants` `tailwind.preset.js`); the whole visual surface must be re-validated live on its own branch, not ride into auto-deploy. |

## Never cap a security floor

`cryptography` (Python) is **deliberately not held.** It sits at
`>=50.0.0` — floor only, no ceiling — in `backend/pyproject.toml` `[tool.uv]`
`constraint-dependencies`.

It used to be held at `>=48.0.1,<49`, capped "to avoid the untested major." On
2026-08-03 three advisories landed against 48.0.1 (CVE-2026-69247 / -69248 /
-69249) and the scheduled `security-audit.yml` went red on `main`. Upstream's
only fix was a major, so **the cap was the thing blocking the fix.**

The lesson generalises: a ceiling on a floor whose entire job is "stay above
known CVEs" turns every major-delivered fix into a blocked build. These two
bounds want opposite things — do not put them on the same entry. Reproducibility
comes from the committed `uv.lock` plus `uv export --frozen` in CI, so the
ceiling was not buying determinism either.

Hold a Python major the normal way if it ever genuinely needs a migration: add a
row above with a real, specific reason. "Untested major" is not one.

## How to lift a hold

1. Branch off `main`; bump the one dependency (its paired deps may move with it, e.g. vite + `@vitejs/plugin-react`).
2. Run the full gates (`typecheck`, `test:unit`, `build`) **and drive the touched surface live** in the built app — pickers, 3D hero, and engine boot are the scar-bearing surfaces.
3. For `pyodide`: also run the byte-parity gate (`frontend/packages/browser` `bun run test:parity`) and the live exit gate.
4. Merge, delete the branch, and remove the row from this table (or update it if a new major supersedes the hold).
