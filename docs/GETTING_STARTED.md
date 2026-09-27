# Getting started for developers

**TL;DR:** install uv and Bun, clone, run `cd backend && uv sync --extra dev`
and `cd frontend && bun install`, then `make gate`. That is the same check CI
runs. `make demo` builds the app and opens it at http://localhost:4173.

Every command below was run from a fresh clone on macOS (Apple Silicon) on
2026-09-25. Times are from that run.

## 1. Prerequisites

| Tool | Version | How to get it |
|------|---------|---------------|
| [uv](https://docs.astral.sh/uv/) | any recent release (CI uses 0.12.1; 0.8.5 also works) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Python | 3.13 (`requires-python >= 3.13`) | uv downloads it for you |
| [Bun](https://bun.sh/) | 1.3.5, pinned in `frontend/.bun-version` | `curl -fsSL https://bun.sh/install \| bash -s bun-v1.3.5` |
| Node | 22.x (CI image `node:22`) | runs Vitest, ESLint and the scripts under `frontend/apps/web/scripts/` |
| poppler | any | `brew install poppler` or `sudo apt-get install -y poppler-utils`; only for PDF tests |
| Playwright browsers | from the lockfile | `cd frontend/apps/web && bunx playwright install chromium webkit`; only for e2e journeys |
| [Dagger](https://dagger.io/) | v0.21.8, pinned in `dagger.json` | only to run the full CI pipeline locally (`dagger check`); needs Docker |

Local traps we hit:

- **Run `uv sync --extra dev` in `backend/` first.** `make gate` does not
  install the dev tools. On a fresh clone without it, `uv run` quietly picks up
  whatever `mypy` and `poe` are on your `PATH`, and the gate fails with
  `Library stubs not installed for "yaml"` and two `no-any-return` errors. After
  `uv sync --extra dev` those go away.
- **Run `bun install` in `frontend/` first.** The gate does not install frontend
  packages either.
- **A single backend test file fails on coverage.** `pytest` always enforces the
  90% coverage floor (it is in `addopts`), so one file alone reports
  "Required test coverage of 90% not reached". Add `--no-cov` when running one file.
- **Port 4173 already taken?** Vite does not fail; it quietly uses the next
  free port. Read the `Local:` line it prints, or pass
  `bun run preview --port 4199 --strictPort` in `frontend/apps/web`.
- **Use Node 22 if you can.** On Node 26 the web unit tests passed (1,769 of
  1,769) but Vitest once reported a stray `requestAnimationFrame is not defined`
  from a GSAP timer after a test had finished, which fails the gate. Re-running
  cleared it. CI uses Node 22.
- **`vite dev` cannot run the chart engine.** The engine's module Workers only
  load in a production build. Use `bun run build && bun run preview`, or
  `make demo`.

## 2. Clone, install, run

```bash
git clone https://github.com/hseshadr/almamesh.git && cd almamesh
(cd backend && uv sync --extra dev)     # a few seconds with a warm uv cache
(cd frontend && bun install)            # about 10 s (2,243 packages)
```

Run the app (installs, fetches and signs the dev assets, builds, opens the browser):

```bash
make demo
```

The first run takes about 2 minutes: fetching and signing the dev assets took
27 s and the production build 87 s. Success looks like
`➜  Local:   http://localhost:4173/` and a browser tab
on the AlmaMesh home screen. Click **Generate my chart — free**, fill in a birth
date, time and city, and a full chart appears. Stop the server with Ctrl+C.

Run the engine on its own, with no browser:

```bash
cd backend
uv run almamesh-chart "1990-01-15T12:00:00+00:00" 40.7128 -74.0060
```

Success is a JSON chart on stdout that starts with `"ayanamsa_value": 23.7174`.

## 3. The full check (what CI runs)

```bash
make gate
```

The first run took about 6 minutes; a warm rerun took 2.5 minutes. It runs the
backend (`ruff`, format check, `mypy` strict, `xenon`, `pytest` with a 90%
coverage floor) and then the frontend (type builds,
typecheck, lint, `knip`, unit tests for each package, production build). CI runs
the same two commands inside Dagger.

CI also runs browser journeys (onboarding, offline, byte parity between the
browser and Python engines, privacy/reset, report PDF) on Chromium and WebKit.
To run the whole CI pipeline locally, use `dagger check` (needs Docker; slow on
the first run while images and caches build).

## 4. Map of the code

| Path | What it is |
|------|------------|
| `backend/src/almamesh/calculations.py` | Planet positions and the sidereal chart (Skyfield + DE421 ephemeris). |
| `backend/src/almamesh/dasha/`, `yogas/`, `transits/`, `strength/`, `vargas/` | Timing periods, yoga detection, transits, strength scores, divisional charts. |
| `backend/src/almamesh/mesh/` | Relationship reads between two charts. |
| `backend/src/almamesh/edge/` | The chart runtime the browser calls, plus the `almamesh-chart` and `almamesh-bundle` CLIs. |
| `backend/tests/` | pytest suite, including golden fixtures and the README contract test. |
| `frontend/apps/web/` | The React + Vite app (the whole product surface). |
| `frontend/apps/web/src/locales/{en,es,pt}/` | UI text in three languages, with parity tests. |
| `frontend/packages/browser/` | Runs the Python engine in the browser (Pyodide in a Web Worker) and syncs the signed bundle. |
| `frontend/packages/store/` | Local data (SQLite in the browser) and adapters from engine output to UI types. |
| `frontend/packages/llm/` | Optional AI reading and chat (off by default). |
| `dagger/src/index.ts` | The CI pipeline. `.github/workflows/dagger.yml` just calls it. |

More detail: [ARCHITECTURE.md](ARCHITECTURE.md) and [frontend/README.md](../frontend/README.md).

## 5. Make your first change

A typical small change: add a new line of UI text to the Settings screen.

1. Add a key (say `demoNewKey`) to `frontend/apps/web/src/locales/en/settings.json`.
2. Run the parity test for that file. It fails, because Spanish and Portuguese
   are missing the key:

   ```bash
   cd frontend/apps/web
   bunx vitest run src/locales/settings.parity.test.ts
   ```

   ```text
   × es matches en keys
   × pt matches en keys
   -   "demoNewKey",
         Tests  2 failed (2)
   ```
3. Add the same key to `es/settings.json` and `pt/settings.json` and run the test
   again. It passes.
4. Use the key in a component with `t('your.key')`, run `make gate`, then
   `make demo` and look at the screen you changed.

For an engine change, the same loop runs in `backend/`: write a failing test in
`backend/tests/`, then run just that file:

```bash
cd backend
uv run pytest tests/test_navamsa.py -q --no-cov
```

Success is `13 passed` in a few seconds.

Two rules matter most in review: astrology math lives in Python only (the
TypeScript code reshapes engine output, it never recomputes it), and the same
inputs must give byte-identical charts in Python and in the browser.

## 6. Open a pull request

- Branch off `main` with a short prefix that says what kind of change it is:
  `feat/…`, `fix/…`, `docs/…`, `ci/…`.
- Tests land in the same PR as the code. A bug fix starts with a failing test.
- CI (the `dagger` workflow) runs `make gate` plus the browser, PDF and privacy
  journeys on Chromium and WebKit. It must be green before merge.
- Reviewers look for: the test that proves the change, no new network calls (the
  app is local-first; see the data-flow table in the README), and, for anything
  a user sees, a note on how you checked it in the running app.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the project rules and
[SECURITY.md](../SECURITY.md) for reporting security issues.
