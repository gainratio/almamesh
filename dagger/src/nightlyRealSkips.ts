/**
 * Nightly guard: a `[real]` Playwright spec that skips itself is a failure.
 *
 * Regression this guards against: every real-integration spec opens with
 * `test.skip(!process.env.OPENROUTER_API_KEY, ...)`. With the repository secret
 * unset, Playwright reports those tests as "skipped" and exits 0, so the
 * Nightly E2E workflow stayed green while exercising no live model at all.
 *
 * The nightly runs each real config with an extra JSON reporter writing into
 * one directory; this script reads every report there and exits 1 when any
 * real test skipped, when no real test ran, or when the reports are missing or
 * unreadable (fail closed: absent evidence is not a pass).
 *
 * A test counts as real when its title contains `[real]` or its skip reason
 * names the secret. The single exemption is the opt-in local Ollama test,
 * which needs a model on the developer's machine and can never run in CI.
 */
export const NIGHTLY_REAL_SECRET = "OPENROUTER_API_KEY"
export const LOCAL_OPT_IN_REAL_TESTS: readonly string[] = [
  "[real] interpretation renders against a live local Ollama model",
]

/**
 * A self-contained `bun -e` program that checks every `*.json` Playwright
 * report in `dir` (relative to the container's cwd). Like
 * `pagesUploadLimitsCheckScript`, it is generated here so the secret name and
 * exemption list are interpolated from the tested constants above.
 *
 * Every failure path calls `fail()` explicitly. Under `bun -e` (bun 1.3.5) an
 * exception thrown inside an array callback exits 0 with no output, so an
 * uncaught JSON.parse error would have read as a pass.
 */
export function nightlyRealSkipCheckScript(dir: string): string {
  return `const { readdirSync, readFileSync, statSync } = require("node:fs")
const { join } = require("node:path")
const SECRET = ${JSON.stringify(NIGHTLY_REAL_SECRET)}
const EXEMPT = new Set(${JSON.stringify(LOCAL_OPT_IN_REAL_TESTS)})
const root = ${JSON.stringify(dir)}
function fail(message) {
  console.error(message)
  process.exit(1)
}
function reportFiles() {
  let names = []
  try { names = readdirSync(root) } catch { fail(\`Nightly real-spec check: no reports directory at \${root}\`) }
  const files = names.filter((n) => n.endsWith(".json") && statSync(join(root, n)).isFile())
  if (files.length === 0) fail(\`Nightly real-spec check: no Playwright JSON reports in \${root}\`)
  return files.map((n) => join(root, n))
}
function skipReason(t) {
  const notes = [...(t.annotations || []), ...(t.results || []).flatMap((r) => r.annotations || [])]
  const skip = notes.find((a) => a.type === "skip")
  return skip && skip.description ? skip.description : "no reason given"
}
function collect(suite, out) {
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) out.push({ title: spec.title, status: t.status, reason: skipReason(t) })
  }
  for (const child of suite.suites || []) collect(child, out)
  return out
}
function readReport(file) {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch (error) {
    return fail(\`Nightly real-spec check: unreadable report \${file}: \${error.message}\`)
  }
}
const tests = reportFiles().flatMap((file) => (readReport(file).suites || []).flatMap((s) => collect(s, [])))
const isReal = (t) => t.title.includes("[real]") || t.reason.includes(SECRET)
const real = tests.filter((t) => isReal(t) && !EXEMPT.has(t.title))
const skipped = real.filter((t) => t.status === "skipped")
if (skipped.length > 0) {
  const lines = skipped.map((t) => \`  - \${t.title} (\${t.reason})\`).join("\\n")
  fail(\`Nightly real-spec check FAILED: \${skipped.length} real test(s) skipped instead of running:\\n\${lines}\\n\` +
    \`A skip is not a pass. Add the \${SECRET} repository secret (Settings > Secrets and variables > Actions) and re-run.\`)
}
if (real.length === 0) fail("Nightly real-spec check FAILED: no [real] test ran in any report")
console.log(\`Nightly real-spec check passed: \${real.length} [real] test(s) ran, none skipped\`)`
}
