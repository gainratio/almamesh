# Quickstart

**TL;DR:** one command builds and opens the full app — engine in the browser,
no server, no account, no API key.

```bash
git clone https://github.com/gainratio/almamesh && cd almamesh
make demo        # install → fetch/sign dev assets → build → open http://localhost:4173
```

Prerequisites: [uv](https://docs.astral.sh/uv/) and [Bun](https://bun.sh)
(pinned in `frontend/.bun-version`; Bun is this repo's documented package-manager
exception). `make demo` does everything else, including fetching the Pyodide
dist and signing a local dev bundle with a throwaway key.

Then: onboard with any name + birth date/time, search a city, hit **Generate**,
and wait for the ~38 MB engine bootstrap (first run only — it's cached in
durable browser storage after that). A full sidereal chart renders on the
dashboard, computed entirely in your tab.

## Try the engine without the browser

```bash
cd backend && uv sync --extra dev
uv run almamesh-chart "1990-01-15T12:00:00+00:00" 40.7128 -74.0060   # a New York chart, offline
```

## The quality gate

```bash
make gate        # backend (ruff, mypy, xenon, pytest+coverage) + frontend (typecheck, lint, unit tests, build)
```

`dagger check` composes that dual-stack gate with the browser, PDF, and privacy
journeys used by CI. The heavyweight Playwright lanes (live exit gate,
real-onboarding drives, and the nightly full suite) are documented in
[CLAUDE.md](../CLAUDE.md) under
"Playwright e2e tiering".

## More

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the signed bundle → durable cache →
  Pyodide flow works, with the diagram.
- [README](../README.md) — the product story and full command reference.
- [CLAUDE.md](../CLAUDE.md) — the canonical engineering reference (stack,
  contracts, non-negotiable gates).
