// frontend/apps/web/e2e/ai-setup-panel.devAssets.ts

/**
 * Shell prefix for the AI panel configs' webServer: regenerate the gitignored
 * engine assets (Pyodide dist, signed dev bundle, its public.key) only when one
 * is missing, before `vite build` copies public/ into dist/.
 *
 * Without them a fresh worktree's build serves the SPA's index.html for
 * /public.key and the bundle, the engine boot parses HTML as JS, and the console
 * gate fails with "Unexpected token '<'". setup-dev-assets.sh re-signs the
 * bundle on every run, so it is not run when the assets are already present.
 *
 * It lives in the webServer command, not a globalSetup: Playwright starts the
 * webServer before globalSetup runs, so a globalSetup would heal too late.
 */
export const ENSURE_DEV_ASSETS =
  'ls public/public.key public/bundle/manifest public/pyodide/v*/pyodide.asm.wasm >/dev/null 2>&1' +
  ' || bash scripts/setup-dev-assets.sh';
