# AlmaMesh Documentation

**Last Updated**: 2026-07-11

AlmaMesh is a **free, local-first, in-browser** Vedic astrology app. The chart
engine runs entirely on the user's device (the unchanged Python `almamesh`
package under Pyodide/WASM in a Web Worker), delivered as a signed,
content-addressed bundle. **There is no backend, server-side database, account,
or API.** Canonical user data lives in one portable SQLite database inside the
browser. Export seals the exact SQLite bytes in a timestamped,
password-encrypted `.almamesh` transport file; import decrypts that file once
and installs normal SQLite in another browser, including Chrome → iOS Safari.
The live database does not prompt for a password on later launches.

Start with the top-level docs:

- **[Root README](../README.md)** — what it is, the browser quickstart (clone →
  build → preview → generate a chart offline), and the no-frontend CLI path.
- **[QUICKSTART](QUICKSTART.md)** — `make demo` to a rendered chart, plus the
  one-command quality gate.
- **[ARCHITECTURE](ARCHITECTURE.md)** — the signed-bundle → OPFS → Pyodide flow
  in one diagram (d2 source committed).
- **[Tech stack](tech-stack.md)** — the local-first engine + bundle delivery +
  in-browser Pyodide architecture, with the real commands.
- **[Frontend README](../frontend/README.md)** — the Bun monorepo, the
  `@almamesh/*` packages, how the in-browser engine works, and dev/build/test.
- **[CHANGELOG](../CHANGELOG.md)** — every release, from the SaaS-to-local-first
  pivot onward.
- **[Release notes](releases/v0.4.0.md)** — what v0.4.0 delivers, in plain
  language (this is the GitHub release body).

## Architecture in one diagram

```
Browser (the product, an installable PWA)
  apps/web (React+Vite+Tailwind)
    └─ @almamesh/browser
         ├─ edge-proc bundle sync ─▶ verify ed25519+sha256 fail-closed ─▶ OPFS
         └─ Pyodide Web Worker    ─▶ unchanged almamesh wheel ─▶ SiderealChart
              └─ @almamesh/store adapter ─▶ ChartData ─▶ UI
    └─ @almamesh/store ─▶ OPFS SQLite (all canonical user state + deletion ledger)
         └─ encrypted .almamesh transport ─▶ import once in another browser
    (optional) @almamesh/llm ─ client-side, PII-redacted, fail-closed local_only

Build-time (Python, no server)
  backend/src/almamesh/  — the engine + the `almamesh-bundle` signed-bundle publisher
```

## Where things are

| Area | Path | Notes |
|------|------|-------|
| Engine + publisher | [`../backend/src/almamesh/`](../backend/src/almamesh/) | sidereal calc, dasha, yogas, `edge/` CLIs |
| In-browser engine | [`../frontend/packages/browser/`](../frontend/packages/browser/) | bundle sync + Pyodide chart Worker |
| State + adapter | [`../frontend/packages/store/`](../frontend/packages/store/) | `SiderealChart → ChartData` |
| Web app | [`../frontend/apps/web/`](../frontend/apps/web/) | the PWA |
| Specs | [`specs/`](specs/) | active feature specs (see caveat below) |
| Code guidelines | [`code-guidelines.md`](code-guidelines.md) | development standards |

> **Stale-doc caveat:** the **retired SaaS architecture** docs (the old
> `docs/tech/api/`, `docs/tech/architecture/SYSTEM_ARCHITECTURE.md`,
> `docs/tech/deployment/`, and the private `docs/business/` material) described a
> REST API, SSE streaming, server deployment, and Supabase auth that the shipped
> local-first app **no longer has**. They were **removed** for the public
> open-source release, and the SaaS-era architecture diagrams under
> `docs/diagrams/` were deleted back in v0.3.0; both now live only in git
> history. Treat the root `README.md`, `frontend/README.md`, and `tech-stack.md`
> as the source of truth. The `specs/` feature specs (karma, dasha modifiers)
> describe engine/UI features, not a server.
