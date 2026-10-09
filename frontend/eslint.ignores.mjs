// The ONE list of paths ESLint skips across the whole frontend workspace
// (apps/web and every packages/* workspace). eslint.config.mjs imports it, and
// tests/frontend-lint-coverage-contract.test.ts imports it too, so the contract
// can prove no frontend/packages/* source is ignored without loading ESLint.
// This module must stay dependency-free for that reason.
//
// Patterns resolve against frontend/ (the config's base path) and are written
// as `**/<dir>/**` so they apply inside every workspace.
export const LINT_IGNORES = [
  // Build / generated output.
  "**/dist/**",
  "**/dist-verify/**",
  // The no-hooks real-journey build (report-pdf/dual-voice configs + the
  // documented local live-validation flow) — same generated output, 4900+
  // false positives if linted. Without this, running the exit gate locally
  // breaks the next `git commit` (lint-staged runs the lint).
  "**/dist-real/**",
  // The two builds the service-worker update gate compares
  // (scripts/build-sw-update-fixtures.mjs) — linting a minified sw.js alone
  // is ~15k false positives.
  "**/dist-sw-update/**",
  "**/node_modules/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/coverage/**",
  // apps/web/public ships the prebuilt Pyodide runtime verbatim; it is not our
  // source (4900+ no-undef false positives otherwise).
  "apps/web/public/**",
  // wrangler's scratch dir — `wrangler pages dev dist` (the documented local
  // Cloudflare Pages check, docs/deploy/almamesh-com.md) drops generated shims.
  "**/.wrangler/**",
];
