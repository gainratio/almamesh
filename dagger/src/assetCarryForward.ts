/**
 * Deploy skew protection, the Dagger side (the tool itself is
 * frontend/apps/web/scripts/carryForwardAssets.mjs).
 *
 * Every Cloudflare Pages deployment is immutable, but the production domain
 * serves only the newest one, so a tab still running the previous release
 * 404s on its lazy chunks the moment this release goes live. Before the
 * upload, the deploy runs the tool against the deployment that is live right
 * now: it downloads the last releases' hashed /assets/* (verified against that
 * deployment's assets-manifest.json) into this release's dist.
 *
 * The Pages limits are passed from pagesUploadLimits.ts so the tool's bounds
 * cannot drift from the upload gate's.
 */
import { MAX_PAGES_UPLOAD_FILE_BYTES, MAX_PAGES_UPLOAD_FILE_COUNT } from "./pagesUploadLimits.js"

/** Where the deploy mounts the tool inside its Node container. */
export const CARRY_FORWARD_TOOL = "/tool/carryForwardAssets.mjs"
export const CARRY_FORWARD_TOOL_SOURCE = "frontend/apps/web/scripts/carryForwardAssets.mjs"

/**
 * The tool's argv. `previousUrl` is the live deployment's own
 * `https://<id>.almamesh.pages.dev` URL (immutable, unlike the production
 * alias), or null where there is no predecessor (the dry run): then the tool
 * only writes this release's manifest.
 */
export function carryForwardCommand(distDir: string, previousUrl: string | null): string[] {
  const source = previousUrl === null ? [] : [requirePagesDeploymentUrl(previousUrl)]
  return [
    "node",
    CARRY_FORWARD_TOOL,
    distDir,
    ...source,
    "--max-files",
    String(MAX_PAGES_UPLOAD_FILE_COUNT),
    "--max-file-bytes",
    String(MAX_PAGES_UPLOAD_FILE_BYTES),
  ]
}

function requirePagesDeploymentUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("carry-forward source must be an https Pages deployment URL")
  }
  const valid = url.protocol === "https:"
    && url.hostname.endsWith(".almamesh.pages.dev")
    && url.username === ""
    && url.password === ""
  if (!valid) throw new Error("carry-forward source must be an https Pages deployment URL")
  return url.origin
}
