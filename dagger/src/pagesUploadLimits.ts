/**
 * Cloudflare Pages direct-upload limits, enforced at PR-CI build time.
 *
 * Regression this guards against (shipped once, CI-green): Dependabot PR #175
 * bumped @huggingface/transformers 3.8.1 -> 4.3.0, which pulled onnxruntime-web
 * 1.22.0-dev -> 1.31.0-dev. The new version's bundling picked the `asyncify`
 * WASM flavor (26.86 MB) instead of the old `jsep` flavor (20.6 MB) for this
 * browser target, pushing one file over Cloudflare Pages' 25 MiB per-file cap.
 * PR CI stayed green; the next production deploy silently failed to upload.
 *
 * Real Cloudflare Pages direct-upload bounds:
 *   https://developers.cloudflare.com/pages/platform/limits/
 */
export const MAX_PAGES_UPLOAD_FILE_BYTES = 26_214_400 // 25 MiB
export const MAX_PAGES_UPLOAD_FILE_COUNT = 20_000

export interface PagesUploadEntry {
  readonly path: string
  readonly bytes: number
}

/**
 * Throws, naming the offending file(s) or the actual count, when the given
 * file listing would be rejected by a Cloudflare Pages direct upload. Pure
 * and side-effect-free: callers own gathering the listing (a real filesystem
 * walk, a Dagger container `find`, or a test fixture).
 */
export function assertPagesUploadLimits(entries: readonly PagesUploadEntry[]): void {
  assertFileCount(entries)
  assertFileSizes(entries)
}

function assertFileCount(entries: readonly PagesUploadEntry[]): void {
  if (entries.length <= MAX_PAGES_UPLOAD_FILE_COUNT) return
  throw new Error(
    `Cloudflare Pages upload exceeds the ${MAX_PAGES_UPLOAD_FILE_COUNT}-file limit: ${entries.length} files`,
  )
}

function assertFileSizes(entries: readonly PagesUploadEntry[]): void {
  const oversize = entries.filter((entry) => entry.bytes > MAX_PAGES_UPLOAD_FILE_BYTES)
  if (oversize.length === 0) return
  const detail = oversize.map((entry) => `${entry.path} (${entry.bytes} bytes)`).join(", ")
  throw new Error(
    `Cloudflare Pages upload exceeds the ${MAX_PAGES_UPLOAD_FILE_BYTES}-byte per-file limit: ${detail}`,
  )
}

/**
 * A self-contained `bun -e` program that walks `dir` (relative to the
 * container's cwd), applies the same two ceilings as `assertPagesUploadLimits`
 * (interpolated here so the numbers cannot drift from the tested constants),
 * and exits non-zero naming the offender when either is exceeded. Mirrors the
 * other inline container-check scripts in this module (see
 * `pagesFunctionsDryRunScript` in index.ts) rather than importing this file
 * at container-execution time.
 */
export function pagesUploadLimitsCheckScript(dir: string): string {
  const quotedDir = JSON.stringify(dir)
  return `const { readdirSync, statSync } = require("node:fs")
const { join, relative } = require("node:path")
const MAX_BYTES = ${MAX_PAGES_UPLOAD_FILE_BYTES}
const MAX_COUNT = ${MAX_PAGES_UPLOAD_FILE_COUNT}
const root = ${quotedDir}
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...walk(full))
    else out.push({ path: relative(root, full), bytes: info.size })
  }
  return out
}
const entries = walk(root)
if (entries.length > MAX_COUNT) {
  console.error(\`Cloudflare Pages upload exceeds the \${MAX_COUNT}-file limit: \${entries.length} files\`)
  process.exit(1)
}
const oversize = entries.filter((entry) => entry.bytes > MAX_BYTES)
if (oversize.length > 0) {
  const detail = oversize.map((entry) => \`\${entry.path} (\${entry.bytes} bytes)\`).join(", ")
  console.error(\`Cloudflare Pages upload exceeds the \${MAX_BYTES}-byte per-file limit: \${detail}\`)
  process.exit(1)
}
const largest = entries.reduce((max, entry) => Math.max(max, entry.bytes), 0)
console.log(\`Cloudflare Pages upload within limits: \${entries.length} files, largest \${largest} bytes\`)`
}
