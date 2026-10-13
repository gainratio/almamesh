import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync, truncateSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { parseDeployTrigger } from "../dagger/src/deployTrigger"

// Pure workflow-YAML contracts: no Dagger CLI, so the `contracts` gate runs them
// on every PR (tests/dagger-contracts.test.ts needs a host `dagger` and does not).
const root = resolve(import.meta.dir, "..")

function workflow(name: string): Record<string, unknown> {
  const source = readFileSync(resolve(root, ".github/workflows", name), "utf8")
  return Bun.YAML.parse(source) as Record<string, unknown>
}

function steps(name: string): Array<Record<string, unknown>> {
  const jobs = workflow(name).jobs as Record<string, { steps: Array<Record<string, unknown>> }>
  return Object.values(jobs).flatMap((job) => job.steps)
}

function workflowSource(name: string): string {
  return readFileSync(resolve(root, ".github/workflows", name), "utf8")
}

function workflowNames(): string[] {
  return readdirSync(resolve(root, ".github/workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
}

const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
const daggerAction = "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77"

/**
 * gainratio/ci fleet policy (validate_ingress / validate_candidate): a job is
 * exactly checkout -> Dagger, or, when it uploads, checkout -> Dagger -> upload
 * with the artifact bound to this SHA (fleet rules non-dagger-ingress,
 * candidate-order, artifact-identity). No job runs shell (shell-step).
 */
function ingressViolations(ingressSteps: Array<Record<string, unknown>>): string[] {
  const violations: string[] = []
  const uploads = ingressSteps[2]?.uses === UPLOAD_ARTIFACT
  const expectedUses = uploads ? [checkout, daggerAction, UPLOAD_ARTIFACT] : [checkout, daggerAction]
  if (ingressSteps.length !== expectedUses.length) violations.push("step-count")
  if (JSON.stringify(ingressSteps.map((step) => step.uses)) !== JSON.stringify(expectedUses)) {
    violations.push("step-order")
  }
  if (ingressSteps.some((step) => "run" in step)) violations.push("unexpected-run")
  if (uploads) {
    const upload = (ingressSteps[2].with ?? {}) as Record<string, unknown>
    if (!String(upload.name).includes("${{ github.sha }}")
      || !["candidate", "release"].includes(String(upload.path))
      || upload["if-no-files-found"] !== "error"
      || upload["retention-days"] !== 1) violations.push("artifact-identity")
  }
  return violations
}

/**
 * Fleet rule `dagger-args-expression` (hseshadr/ci#50): dagger-for-github pastes
 * these inputs into bash, so an attacker-influenced `${{ }}` value there is shell
 * injection. Such values must reach the step only through `env:` and be quoted.
 */
const BASH_PASTED_DAGGER_INPUTS = ["args", "call", "shell", "dagger-flags", "workdir", "cloud-token"]
const FORBIDDEN_EXPRESSION = /\$\{\{\s*(inputs\.|github\.event\.|github\.head_ref\b)/

function daggerArgsExpressionViolations(workflowSteps: Array<Record<string, unknown>>): string[] {
  return workflowSteps
    .filter((step) => step.uses === daggerAction)
    .flatMap((step) => {
      const inputs = (step.with ?? {}) as Record<string, unknown>
      return BASH_PASTED_DAGGER_INPUTS.filter((key) =>
        typeof inputs[key] === "string" && FORBIDDEN_EXPRESSION.test(inputs[key] as string))
    })
}

function expectThinDaggerIngress(name: string): void {
  const jobs = workflow(name).jobs as Record<string, { steps: Array<Record<string, unknown>> }>
  for (const [id, job] of Object.entries(jobs)) {
    expect({ id, violations: ingressViolations(job.steps) }).toEqual({ id, violations: [] })
  }
}

/**
 * The only workflows besides dagger.yml allowed a `push` trigger. Each is a
 * post-merge publisher, not a gate: it can never run on a pull request, only on
 * a push to main touching its listed paths, and its one job is checkout + Dagger.
 * Adding a name here needs a reason; publisherViolations() enforces the shape.
 */
const POST_MERGE_PUBLISHERS: Readonly<Record<string, string>> = {
  "toolchain-image.yml":
    "Publishes the prebuilt GHCR toolchain image after its recipe changes on main; gates nothing",
}
const GATING_EVENTS = new Set(["push", "pull_request", "pull_request_target"])

/**
 * The one gating ingress that is not Dagger. Dagger runs Linux containers, and
 * Linux Playwright WebKit cannot open SQLite's nested-Worker OPFS
 * (scripts/verify-webkit-engine.mjs), so the engine never boots there: WebKit
 * journeys that need it can only run on a macOS runner. Adding a name here
 * needs a reason; macosLaneViolations() holds it read-only, secret-free,
 * SHA-pinned, bounded, and to one repository script.
 */
const NATIVE_MACOS_LANES: Readonly<Record<string, string>> = {
  "webkit-macos.yml":
    "Time travel and export/import on desktop Safari and an iPhone profile: macOS WebKit has the OPFS the engine needs",
  "safari-smoke.yml":
    "Advisory smoke in real Safari via safaridriver: Playwright's bundled WebKit is not shipped Safari (version, OPFS)",
}
const MACOS_LANE_SCRIPT = "frontend/apps/web/scripts/webkit-macos-lane.sh"
/**
 * The only actions the lane may use, in order: check out, install Bun and uv,
 * and upload the lane's evidence directory (traces, videos, WebKit logs, crash
 * reports; scripts/webkit-macos-lane.sh) even when the lane fails.
 */
const UPLOAD_ARTIFACT = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
const MACOS_LANE_ACTIONS = [
  checkout,
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "astral-sh/setup-uv@1c37ad07a6a961277cf70c0d37d6f313000f5884",
  UPLOAD_ARTIFACT,
]
const MACOS_LANE_MODES = ["memory", "travel", "portable"] as const
type MacosLaneMode = typeof MACOS_LANE_MODES[number]
const FINALIZE_IF = "always()"
const SCAN_IF = "always() && steps.finalize-evidence.outcome == 'success'"
const UPLOAD_INPUTS = new Set(["name", "path", "retention-days", "if-no-files-found", "include-hidden-files"])
const LANE_RUN = "bash scripts/webkit-macos-lane.sh"
/**
 * The content check on what the lane is about to upload
 * (frontend/apps/web/scripts/artifactLeakScan.mjs): every non-public
 * environment value and the contents of ~/.gitconfig and ~/.netrc. It runs
 * after the lane, pass or fail, and the upload runs only if it passed; on a
 * match it has already deleted the directory.
 */
const LEAK_SCAN_RUN = "node scripts/artifactLeakScan.mjs webkit-lane-evidence-"
const LEAK_SCAN_ID = "leak-scan"
const UPLOAD_IF = `always() && steps.${LEAK_SCAN_ID}.outcome == 'success'`

function leakScanViolations(jobSteps: Array<Record<string, unknown>>, mode: MacosLaneMode): string[] {
  const scans = jobSteps.filter((step) => String(step.run ?? "").trim() === `${LEAK_SCAN_RUN}${mode}`)
  if (scans.length !== 1) return ["leak-scan-count"]
  const scan = scans[0] as Record<string, unknown>
  const at = jobSteps.indexOf(scan)
  const violations: string[] = []
  if (scan.id !== LEAK_SCAN_ID) violations.push("leak-scan-id")
  if (scan.if !== SCAN_IF) violations.push("leak-scan-not-finalized")
  if ("continue-on-error" in scan) violations.push("leak-scan-continue-on-error")
  const finalize = jobSteps[at - 1] ?? {}
  if (finalize.id !== "finalize-evidence" || finalize.if !== FINALIZE_IF || finalize.run !== `${LANE_RUN} --finalize-evidence ${mode}` || "continue-on-error" in finalize) violations.push("evidence-not-finalized")
  const collect = jobSteps[at - 2] ?? {}
  if (JSON.stringify(collect) !== JSON.stringify({ id: "collect-native-evidence", if: "always()", "timeout-minutes": 2, run: `${LANE_RUN} --collect-native-evidence ${mode}` })) violations.push("native-evidence-not-collected")
  if (jobSteps[at - 3]?.run !== `${LANE_RUN} ${mode}`) violations.push("leak-scan-before-lane")
  if (jobSteps[at + 1]?.uses !== UPLOAD_ARTIFACT) violations.push("leak-scan-not-just-before-upload")
  return violations
}

function evidenceUploadViolations(jobSteps: Array<Record<string, unknown>>, mode: MacosLaneMode): string[] {
  const uploads = jobSteps.filter((step) => step.uses === UPLOAD_ARTIFACT)
  if (uploads.length !== 1) return ["evidence-upload-count"]
  const upload = uploads[0] as Record<string, unknown>
  const inputs = (upload.with ?? {}) as Record<string, unknown>
  const violations: string[] = [...leakScanViolations(jobSteps, mode)]
  if (upload.if !== UPLOAD_IF) violations.push("evidence-upload-not-gated-on-leak-scan")
  if (inputs.path !== `frontend/apps/web/webkit-lane-evidence-${mode}`) violations.push("evidence-upload-path")
  if (inputs.name !== `webkit-lane-${mode}-evidence`) violations.push("evidence-upload-name")
  if (inputs["retention-days"] !== 14 || inputs["if-no-files-found"] !== "error") violations.push("evidence-upload-completeness")
  if (Object.keys(inputs).some((key) => !UPLOAD_INPUTS.has(key))) violations.push("evidence-upload-inputs")
  if (jobSteps.at(-1) !== upload) violations.push("evidence-upload-not-last")
  return violations
}
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/

function withJob(
  parsed: Record<string, unknown>,
  mutate: (job: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const jobs = parsed.jobs as Record<string, Record<string, unknown>>
  return { ...parsed, jobs: Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, id === "webkit-macos" ? job : mutate(job)])) }
}

function withSafariJob(
  parsed: Record<string, unknown>,
  mutate: (job: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const jobs = parsed.jobs as Record<string, Record<string, unknown>>
  return { ...parsed, jobs: { ...jobs, "safari-smoke": mutate(structuredClone(jobs["safari-smoke"]) as Record<string, unknown>) } }
}

function withCheckout(
  parsed: Record<string, unknown>,
  mutate: (inputs: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return withJob(parsed, (job) => ({
    ...job,
    steps: (job.steps as Array<Record<string, unknown>>).map((step) =>
      step.uses === checkout ? { ...step, with: mutate((step.with ?? {}) as Record<string, unknown>) } : step),
  }))
}

/**
 * A cheap tripwire, not the guard. Every script line that mentions ARTIFACTS
 * must be one of these exact lines, so an obvious new write into the uploaded
 * directory shows up in review. Shell cannot be guarded by regex: here-docs,
 * `exec >>`, `eval`, a subshell `cd`, line continuations and writes from the
 * Playwright specs (testInfo.outputPath) all get past it. The guard is the
 * content scan that runs before the upload (LEAK_SCAN_RUN,
 * scripts/artifactLeakScan.mjs).
 */
const LANE_ARTIFACT_LINES: readonly string[] = [
  'ARTIFACTS="${WEBKIT_LANE_ARTIFACTS:-webkit-lane-artifacts}"',
  'if [[ "${MODE}" != all && -z "${WEBKIT_LANE_ARTIFACTS:-}" ]]; then ARTIFACTS="webkit-lane-artifacts-${MODE}"; fi',
  '[[ -d "${ARTIFACTS}" && ! -L "${ARTIFACTS}" ]]',
  '[[ -f "${ARTIFACTS}/.lane-cleanup-finished" && ! -L "${ARTIFACTS}/.lane-cleanup-finished" ]]',
  'cp -R "${ARTIFACTS}" "${EVIDENCE_ROOT}"',
  'touch "${ARTIFACTS}/.lane-cleanup-finished"',
  'rm -rf "${ARTIFACTS}"',
  'mkdir -p "${ARTIFACTS}/crash-reports"',
  'touch "${ARTIFACTS}/.lane-start"',
  '{ sw_vers; sysctl hw.memsize hw.ncpu hw.model; } > "${ARTIFACTS}/machine.txt" 2>&1 || true',
  'done ) > "${ARTIFACTS}/system-memory.log" 2>&1 &',
  `node --input-type=module - "\${ARTIFACTS}" "\${BASH_SOURCE[0]:-$0}" "\${HOME}" <<'NATIVE_EVIDENCE'`,
  'node scripts/webkit-memory-baseline.mjs --local-baseline "${TT_WEBKIT_BASELINE_MIB}" --measurement-commit "${MEASUREMENT_REF}" --provenance "${ARTIFACTS}/time-travel-memory-baseline-provenance.json"',
  `TT_MEMORY_BASELINE_REF="\${REFERENCE_REF}" TT_MEMORY_MEASUREMENT_REF="\${MEASUREMENT_REF}" TIME_TRAVEL_E2E_BASE_URL="\${REFERENCE_URL}" run_lane_command bun x playwright test --config=playwright.time-travel.config.ts e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --grep 'boot baseline' --repeat-each=5 --retries=0 --reporter=json --output="\${ARTIFACTS}/time-travel-memory-baseline" > "\${ARTIFACTS}/time-travel-memory-baseline-report.json"`,
  'node scripts/webkit-memory-baseline.mjs --report "${ARTIFACTS}/time-travel-memory-baseline-report.json" --measurement-commit "${MEASUREMENT_REF}" --provenance "${ARTIFACTS}/time-travel-memory-baseline-provenance.json"',
  `TT_MEMORY_PHASE=final TT_MEMORY_GRANULARITY=day TT_MEMORY_REPORT_ONLY=0 TT_WEBKIT_BASELINE_MIB="\${BASELINE_MIB}" TIME_TRAVEL_E2E_BASE_URL="\${MEMORY_URL}" run_lane_command bun run test:e2e:time-travel e2e/time-travel-memory.webkit.spec.ts --project=iphone-15-webkit --grep 'WebContent RSS budget' --repeat-each=5 --retries=0 --output="\${ARTIFACTS}/time-travel-memory" || status=1`,
  'node scripts/webkitFlakeRetry.mjs plan --suite "${suite}" --report "${output}-report.json" --test-list "${output}-retry-list.txt" --reports-dir "${HOME}/Library/Logs/DiagnosticReports" --reports-dir /Library/Logs/DiagnosticReports --since "${ARTIFACTS}/.lane-start" --out "${ARTIFACTS}/flake-retry-${suite}.json" || return "${first}"',
  'node scripts/webkitFlakeRetry.mjs verify --report "${output}-retry-report.json" --plan "${ARTIFACTS}/flake-retry-${suite}.json"',
  'TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" run_suite_with_flake_retry travel test:e2e:time-travel "${ARTIFACTS}/time-travel" e2e/time-travel.spec.ts --project=webkit --project=iphone-webkit --project=iphone-15-webkit || status=1',
  'PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" run_suite_with_flake_retry portable-invariants test:e2e:portable-invariants "${ARTIFACTS}/portable-invariants" --project=webkit --project=iphone-webkit || status=1',
  'BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" run_suite_with_flake_retry boot-retry test:e2e:boot-retry "${ARTIFACTS}/boot-retry" --project=webkit || status=1',
  `grep -rh "page crashed" "\${ARTIFACTS}" --include='*-browser.log' || true`,
  'node scripts/webkitFlakeRetry.mjs summary "${ARTIFACTS}" || true',
]

/** Ways to read the environment or another process's, banned anywhere in the script. */
const LANE_ENV_READS: ReadonlyArray<readonly [string, RegExp]> = [
  ["env-dump", /(^|[\s;&|({`]|\$\()(env|printenv)(\s|$|[>|;)])/],
  ["set-dump", /(^|[;&|({]|\$\()\s*set\s*($|[>|;)])/],
  ["declare", /\b(declare|typeset)\b/],
  ["export-p", /\bexport\s+-\w*p/],
  ["compgen", /\bcompgen\b/],
  ["proc", /\/proc\//],
  ["ps-env", /\bps\s+(-?\w*e\w*)(\s|$)/],
  ["indirect", /\$\{!/],
  ["runner-env", /\$\{?(GITHUB|ACTIONS|RUNNER)_/],
]

function laneScriptViolations(script: string): string[] {
  const violations: string[] = []
  const pinned = new Set(LANE_ARTIFACT_LINES)
  const lines = script.split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
  for (const line of lines) {
    for (const [name, pattern] of LANE_ENV_READS) if (pattern.test(line)) violations.push(`${name}: ${line}`)
    if (!line.includes("ARTIFACTS")) continue
    if (!pinned.has(line)) violations.push(`unpinned-artifacts-line: ${line}`)
    if (/^(?!ARTIFACTS=)\w+=\S*ARTIFACTS/.test(line) || /[;&|]\s*\w+=\S*ARTIFACTS/.test(line)) violations.push(`artifacts-alias: ${line}`)
    if (/\b(cd|pushd|mv|rsync|ln|tee|install)\b/.test(line)) violations.push(`artifacts-move: ${line}`)
    const copy = /\bcp\b(.*?)\s+"?\$\{?ARTIFACTS/.exec(line)
    if (copy !== null && copy[1]?.trim() !== '"${report}"' && line !== 'cp -R "${ARTIFACTS}" "${EVIDENCE_ROOT}"') violations.push(`artifacts-copy-source: ${line}`)
  }
  return violations
}

/** Keep the original/candidate memory comparison separate from seeded hooks journeys. */
const MEMORY_LANE_REQUIREMENTS = [
  'REFERENCE_REF="8d10fbbb76336a8a5efe272912e392e260b3fef5"',
  'MEASUREMENT_REF="$(git rev-parse HEAD)"',
  'REPO_ROOT="$(git rev-parse --show-toplevel)"',
  'git cat-file -e "${REFERENCE_REF}^{commit}"',
  'git -C "${REPO_ROOT}" archive "${REFERENCE_REF}" | tar -x -C "${REFERENCE_ROOT}"',
  'mkdir -p "${REFERENCE_WEB}/public"',
  '( cd "${REFERENCE_ROOT}/frontend" && HUSKY=0 bun install --frozen-lockfile )',
  '( cd "${REFERENCE_WEB}" && DEV_BUNDLE_SEQUENCE="${REFERENCE_SEQUENCE}" bash scripts/setup-dev-assets.sh )',
  '( cd "${REFERENCE_WEB}" && BUILD_COMMIT="${REFERENCE_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ./node_modules/.bin/vite build --outDir "${REFERENCE_DIST}" )',
  '( cd "${REFERENCE_WEB}" && VITE_API_URL= exec ./node_modules/.bin/vite preview --outDir "${REFERENCE_DIST}" --host 127.0.0.1 --port "${REFERENCE_PORT}" --strictPort ) &',
  'BUILD_COMMIT="${MEASUREMENT_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ./node_modules/.bin/vite build --outDir "${MEMORY_DIST}"',
  'VITE_API_URL= ./node_modules/.bin/vite preview --outDir "${MEMORY_DIST}" --host 127.0.0.1 --port "${MEMORY_PORT}" --strictPort &',
] as const

function memoryLaneViolations(script: string): string[] {
  const violations: string[] = MEMORY_LANE_REQUIREMENTS.filter((line) => !script.includes(line))
  const baseline = script.indexOf('TT_MEMORY_BASELINE_REF="${REFERENCE_REF}"')
  const journey = script.indexOf('TT_MEMORY_PHASE=final TT_MEMORY_GRANULARITY=day TT_MEMORY_REPORT_ONLY=0')
  const functional = script.indexOf('TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" run_suite_with_flake_retry travel test:e2e:time-travel')
  if (baseline === -1 || journey <= baseline || functional <= journey) violations.push("memory-comparison-order")
  const archive = script.indexOf('git -C "${REPO_ROOT}" archive "${REFERENCE_REF}"')
  const publicDirectory = script.indexOf('mkdir -p "${REFERENCE_WEB}/public"')
  const pyodideCopy = script.indexOf('cp -R public/pyodide "${REFERENCE_WEB}/public/"')
  const modelsCopy = script.indexOf('cp -R public/models "${REFERENCE_WEB}/public/"')
  if (archive === -1 || publicDirectory <= archive || pyodideCopy <= publicDirectory || modelsCopy <= publicDirectory) violations.push("reference-public-directory-order")
  return violations
}

function withUpload(
  parsed: Record<string, unknown>,
  mutate: (step: Record<string, unknown>) => Record<string, unknown> | null,
): Record<string, unknown> {
  return withJob(parsed, (job) => ({
    ...job,
    steps: (job.steps as Array<Record<string, unknown>>).flatMap((step) => {
      if (step.uses !== UPLOAD_ARTIFACT) return [step]
      const mutated = mutate(step)
      return mutated === null ? [] : [mutated]
    }),
  }))
}

function withSteps(
  parsed: Record<string, unknown>,
  mutate: (steps: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): Record<string, unknown> {
  return withJob(parsed, (job) => ({ ...job, steps: mutate(job.steps as Array<Record<string, unknown>>) }))
}

function moveLeakScan(steps: Array<Record<string, unknown>>, to: number): Array<Record<string, unknown>> {
  const scan = steps.find((step) => step.id === "leak-scan")
  const rest = steps.filter((step) => step !== scan)
  return scan === undefined ? rest : [...rest.slice(0, to), scan, ...rest.slice(to)]
}

function macosLaneViolations(parsed: Record<string, unknown>): string[] {
  const violations: string[] = []
  const jobs = parsed.jobs as Record<string, Record<string, unknown>>
  if (JSON.stringify(parsed.permissions) !== JSON.stringify({ contents: "read" })) violations.push("workflow-permissions")
  if ("env" in parsed) violations.push("workflow-env")
  if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(["webkit-macos", "webkit-memory", "webkit-portable", "webkit-travel"])) violations.push("job-count")
  const aggregate = jobs["webkit-macos"]
  if (JSON.stringify(aggregate) !== JSON.stringify({
    name: "webkit / macOS time travel + export-import",
    needs: ["webkit-memory", "webkit-travel", "webkit-portable"],
    if: "${{ !cancelled() }}",
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": 5,
    steps: [{
      env: {
        MEMORY_RESULT: "${{ needs.webkit-memory.result }}",
        TRAVEL_RESULT: "${{ needs.webkit-travel.result }}",
        PORTABLE_RESULT: "${{ needs.webkit-portable.result }}",
      },
      run: 'test "$MEMORY_RESULT" = success && test "$TRAVEL_RESULT" = success && test "$PORTABLE_RESULT" = success',
    }],
  })) violations.push("aggregate")
  for (const mode of MACOS_LANE_MODES) {
    const job = jobs[`webkit-${mode}`]
    if (!job) { violations.push("missing-lane"); continue }
    if (job["runs-on"] !== "macos-15") violations.push("runner-not-pinned-macos")
    if (job["timeout-minutes"] !== 45) violations.push("timeout")
    if ("permissions" in job) violations.push("job-permissions")
    if ("if" in job || "continue-on-error" in job || "needs" in job) violations.push("lane-bypass")
    if ("env" in job) violations.push("lane-env")
    if (JSON.stringify(job.defaults) !== JSON.stringify({ run: { "working-directory": "frontend/apps/web" } })) violations.push("lane-workdir")
    const jobSteps = job.steps as Array<Record<string, unknown>>
    if (jobSteps.some((step) => "uses" in step && !PINNED_ACTION.test(String(step.uses)))) violations.push("unpinned-action")
    const actions = jobSteps.filter((step) => "uses" in step).map((step) => String(step.uses))
    if (JSON.stringify(actions) !== JSON.stringify(MACOS_LANE_ACTIONS)) violations.push("actions")
    violations.push(...evidenceUploadViolations(jobSteps, mode))
    const runs = jobSteps.filter((step) => "run" in step).map((step) => String(step.run).trim())
    if (JSON.stringify(runs) !== JSON.stringify(["bun install --frozen-lockfile", `${LANE_RUN} ${mode}`, `${LANE_RUN} --collect-native-evidence ${mode}`, `${LANE_RUN} --finalize-evidence ${mode}`, `${LEAK_SCAN_RUN}${mode}`])) violations.push("run-steps")
    if (jobSteps.some((step) => "continue-on-error" in step || "env" in step || "working-directory" in step || "shell" in step)) violations.push("step-bypass")
    if (jobSteps.filter((step) => "run" in step).slice(0, 2).some((step) => "if" in step || "env" in step || "working-directory" in step)) violations.push("run-bypass")
    const checkouts = jobSteps.filter((step) => step.uses === checkout)
    if (checkouts.length !== 1 || ((checkouts[0]?.with ?? {}) as Record<string, unknown>)["persist-credentials"] !== false) violations.push("persist-credentials")
    if (checkouts.some((step) => ((step.with ?? {}) as Record<string, unknown>)["fetch-depth"] !== 0 || ((step.with ?? {}) as Record<string, unknown>).ref !== "${{ github.sha }}")) violations.push("reference-history-unavailable")
  }
  if (SECRETS_ACCESS.test(JSON.stringify(parsed))) violations.push("secrets")
  const events = eventsOf(parsed)
  if (events.length === 0 || events.some((event) => !MACOS_LANE_EVENTS.has(event))) violations.push("events")
  return violations
}

/**
 * The real-Safari smoke (frontend/apps/web/scripts/safari-smoke.mjs) is
 * advisory: its own workflow, so a red smoke never fails the WebKit (macOS)
 * run deploy acceptance reads. Held to this exact shape: read-only, no
 * secrets, SHA-pinned, bounded, evidence uploaded only after its leak scan.
 */
const SAFARI_SMOKE_JOB = {
  name: "safari / macOS smoke",
  "runs-on": "macos-15",
  "timeout-minutes": 30,
  defaults: { run: { "working-directory": "frontend/apps/web" } },
  steps: [
    { uses: checkout, with: { "persist-credentials": false, ref: "${{ github.sha }}" } },
    { uses: MACOS_LANE_ACTIONS[1], with: { "bun-version-file": "frontend/.bun-version" } },
    { uses: MACOS_LANE_ACTIONS[2] },
    { run: "bun install --frozen-lockfile" },
    { run: "sudo safaridriver --enable" },
    { run: "bash scripts/setup-dev-assets.sh" },
    { run: "node scripts/safari-smoke.mjs" },
    { id: LEAK_SCAN_ID, if: "always()", run: "node scripts/artifactLeakScan.mjs safari-smoke-evidence" },
    {
      uses: UPLOAD_ARTIFACT,
      if: UPLOAD_IF,
      with: {
        name: "safari-smoke-evidence",
        path: "frontend/apps/web/safari-smoke-evidence",
        "retention-days": 14,
        "if-no-files-found": "error",
      },
    },
  ],
}

function safariSmokeViolations(parsed: Record<string, unknown>): string[] {
  const violations: string[] = []
  if (JSON.stringify(parsed.permissions) !== JSON.stringify({ contents: "read" })) violations.push("workflow-permissions")
  if ("env" in parsed) violations.push("workflow-env")
  const jobs = parsed.jobs as Record<string, unknown>
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify(["safari-smoke"])) violations.push("job-count")
  if (JSON.stringify(jobs["safari-smoke"]) !== JSON.stringify(SAFARI_SMOKE_JOB)) violations.push("job-shape")
  if (SECRETS_ACCESS.test(JSON.stringify(parsed))) violations.push("secrets")
  const events = eventsOf(parsed)
  if (events.length === 0 || events.some((event) => !MACOS_LANE_EVENTS.has(event))) violations.push("events")
  return violations
}

const NATIVE_MACOS_LANE_CHECKS: Readonly<Record<string, (parsed: Record<string, unknown>) => string[]>> = {
  "webkit-macos.yml": macosLaneViolations,
  "safari-smoke.yml": safariSmokeViolations,
}

/**
 * Any use of the secrets context inside an expression: `secrets.X`,
 * `secrets['X']`, `toJSON(secrets)`, `format('{0}', secrets)`.
 */
const SECRETS_ACCESS = /\$\{\{(?:(?!\}\}).)*\bsecrets\b/s
/** The lane may run only on a pull request or a push: never pull_request_target, workflow_run, or the like. */
const MACOS_LANE_EVENTS = new Set(["pull_request", "push"])

function eventsOf(parsed: Record<string, unknown>): string[] {
  const on = parsed.on
  if (typeof on === "string") return [on]
  if (Array.isArray(on)) return on.map(String)
  return Object.keys((on ?? {}) as Record<string, unknown>)
}

function gatingIngresses(names: string[]): string[] {
  return names.filter((name) =>
    !(name in POST_MERGE_PUBLISHERS) && eventsOf(workflow(name)).some((event) => GATING_EVENTS.has(event)))
}

function onViolations(parsed: Record<string, unknown>): string[] {
  const events = eventsOf(parsed)
  const push = ((parsed.on as Record<string, unknown>).push ?? {}) as Record<string, unknown>
  const violations = events.filter((event) => event !== "push" && event !== "workflow_dispatch")
  if (JSON.stringify(push.branches) !== JSON.stringify(["main"])) violations.push("push-not-main-only")
  if (!Array.isArray(push.paths) || push.paths.length === 0) violations.push("push-not-path-filtered")
  return violations
}

function publisherViolations(name: string): string[] {
  const parsed = workflow(name)
  const jobs = Object.values(parsed.jobs as Record<string, Record<string, unknown>>)
  const violations = onViolations(parsed)
  if (jobs.some((job) => job.if !== "github.ref == 'refs/heads/main'")) violations.push("job-not-main-guarded")
  return violations
}

describe("canonical GitHub ingress contract", () => {
  test("every workflow checkout prevents persisted GitHub credentials", () => {
    for (const name of workflowNames()) {
      for (const step of steps(name).filter((candidate) => candidate.uses === checkout)) {
        expect((step.with as Record<string, unknown> | undefined)?.["persist-credentials"])
          .toBe(false)
      }
    }
  })

  test("CI/CD ingress only checks out and invokes Dagger, plus one SHA-bound candidate upload", () => {
    for (const name of [
      "dagger.yml",
      "security-audit.yml",
      "nightly-e2e.yml",
      "deploy.yml",
      "live-probe.yml",
    ]) expectThinDaggerIngress(name)
  })

  test("the backend gate builds its public-doc manifest in Dagger from the checkout's own Git", () => {
    const jobs = workflow("dagger.yml").jobs as Record<string, { steps: Array<Record<string, unknown>> }>
    expect(ingressViolations(jobs.backend.steps)).toEqual([])
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const backend = source.slice(source.indexOf("  backend(): Container {"), source.indexOf("  frontend(): Container {"))
    expect(backend).toContain("this.publicDocsManifest()")
    const manifest = source.slice(source.indexOf("private publicDocsManifest()"), source.indexOf("private releaseBase("))
    expect(manifest).toContain("scripts/public_docs_manifest.py")
    expect(manifest).toContain("this.gitMetadata")
    expect(source).toContain('workspace.directory("/", { include: [".git/**"], gitignore: false })')
  })

  test("the backend astronomy contract gets its exact browser configuration inputs", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    const uvBase = source.slice(source.indexOf("private uvBase()"), source.indexOf("private releaseBase("))
    const contractsStart = source.indexOf("async contracts()")
    const contractInputs = source.slice(contractsStart, source.indexOf(".withWorkdir(ROOT)", contractsStart))
    for (const path of [
      "frontend/apps/web/src/providers/AlmaMeshRuntimeProvider.tsx",
      "frontend/packages/browser/integration/parity.mjs",
      "frontend/packages/browser/integration/rectification-precision.mjs",
    ]) {
      expect(uvBase).toContain(`"${path}"`)
      expect(contractInputs).toContain(`"${path}"`)
      expect(existsSync(resolve(root, path))).toBe(true)
    }
    expect(uvBase).not.toContain('"frontend/**"')
  })

  test.each([
    ["a mutable artifact name", { name: "browser-journeys-evidence" }],
    ["an arbitrary artifact path", { path: "." }],
    ["a long retention", { "retention-days": 14 }],
    ["a silent empty upload", { "if-no-files-found": "warn" }],
  ])("the candidate upload rejects %s", (_name, change) => {
    const jobs = workflow("dagger.yml").jobs as Record<string, { steps: Array<Record<string, unknown>> }>
    const mutant = structuredClone(jobs["browser-journeys-evidence"].steps)
    mutant[2].with = { ...(mutant[2].with as Record<string, unknown>), ...change }
    expect(ingressViolations(mutant)).toEqual(["artifact-identity"])
  })

  test("the scheduled live probe runs its native function read-only and without secrets", () => {
    const source = workflowSource("live-probe.yml")
    const on = workflow("live-probe.yml").on as Record<string, unknown>
    expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"])
    expect(source).toContain("args: live-probe")
    expect(source).not.toContain("secrets.")
    expect(workflow("live-probe.yml").permissions).toEqual({ contents: "read" })
  })

  test.each([
    {
      name: "extra step",
      mutate: (source: Array<Record<string, unknown>>) => [
        ...source,
        { run: "echo unexpected" },
      ],
    },
    {
      name: "shell step between ingress actions",
      mutate: (source: Array<Record<string, unknown>>) => [
        source[0],
        { run: "dagger call ci --help" },
        source[1],
      ],
    },
    {
      name: "reversed ingress actions",
      mutate: (source: Array<Record<string, unknown>>) => [source[1], source[0]],
    },
  ])("rejects $name in the protected Dagger ingress", ({ mutate }) => {
    const mutant = mutate(structuredClone(steps("dagger.yml")))
    expect(ingressViolations(mutant)).not.toEqual([])
  })

  test("no workflow pastes an event, input, or head_ref expression into a dagger-for-github bash input", () => {
    const violations = workflowNames().flatMap((name) =>
      daggerArgsExpressionViolations(steps(name)).map((key) => `${name}:${key}`))
    expect(violations).toEqual([])
  })

  test.each([
    ["an inputs expression in args", "args", "live-probe --tag=${{ inputs.tag }}"],
    ["an event expression in call", "call", "ci --commit-sha=${{ github.event.pull_request.head.sha }}"],
    ["head_ref in dagger-flags", "dagger-flags", "--progress=${{ github.head_ref }}"],
    ["a spaced event expression in workdir", "workdir", "${{  github.event.workflow_run.head_branch }}"],
  ])("the fleet rule rejects %s", (_name, key, value) => {
    const mutant = structuredClone(steps("live-probe.yml"))
    const dagger = mutant.find((step) => step.uses === daggerAction) as Record<string, unknown>
    dagger.with = { ...(dagger.with as Record<string, unknown>), [key]: value }
    expect(daggerArgsExpressionViolations(mutant)).toEqual([key])
  })

  test("the fleet rule allows env-quoted values and non-event contexts", () => {
    const allowed = [{
      uses: daggerAction,
      env: { HEAD_SHA: "${{ github.event.workflow_run.head_sha }}" },
      with: { args: 'deploy --expected-sha="$HEAD_SHA"', call: "ci --commit-sha=${{ github.sha }}" },
    }]
    expect(daggerArgsExpressionViolations(allowed)).toEqual([])
  })

  test("the security audit invokes its native Dagger function", () => {
    expect(workflowSource("security-audit.yml")).toContain("args: dependency-audit")
  })

  test("Dagger is the only pull-request and push ingress, besides the named macOS WebKit lane", () => {
    expect(gatingIngresses(workflowNames())).toEqual(["dagger.yml", ...Object.keys(NATIVE_MACOS_LANES)].sort())
    expect(existsSync(resolve(root, ".github/workflows/test.yml"))).toBe(false)
  })

  test("the macOS WebKit lane is read-only, secret-free, SHA-pinned, bounded, and runs one repository script", () => {
    expect(Object.keys(NATIVE_MACOS_LANE_CHECKS).sort()).toEqual(Object.keys(NATIVE_MACOS_LANES).sort())
    for (const [name, check] of Object.entries(NATIVE_MACOS_LANE_CHECKS)) expect(check(workflow(name))).toEqual([])
  })

  test("the real-Safari smoke is advisory: outside the workflow and job list deploy acceptance reads", () => {
    const webkit = workflow("webkit-macos.yml").jobs as Record<string, unknown>
    expect(Object.keys(webkit)).not.toContain("safari-smoke")
    const acceptance = readFileSync(resolve(root, "dagger/src/nativeMacAcceptance.ts"), "utf8")
    expect(acceptance).not.toContain("safari")
    expect(() => parseDeployTrigger(".github/workflows/safari-smoke.yml")).toThrow("not allowed")
    const deploy = workflow("deploy.yml").on as { workflow_run: { workflows: string[] } }
    expect(deploy.workflow_run.workflows).not.toContain(workflow("safari-smoke.yml").name)
  })

  test.each([
    ["job-level continue-on-error", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, "continue-on-error": true }))],
    ["a secret", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, env: { KEY: "${{ secrets.OPENROUTER_API_KEY }}" } }))],
    ["write permissions", (w: Record<string, unknown>) => ({ ...w, permissions: { contents: "write" } })],
    ["macos-latest", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, "runs-on": "macos-latest" }))],
    ["an unbounded run", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, "timeout-minutes": 360 }))],
    ["an extra run step", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, steps: [...(job.steps as unknown[]), { run: "curl x | sh" }] }))],
    ["a tag-pinned checkout", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, steps: [{ uses: "actions/checkout@v7" }, ...(job.steps as unknown[]).slice(1)] }))],
    ["an upload not gated on the leak scan", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, steps: (job.steps as Array<Record<string, unknown>>).map((step) => step.uses === UPLOAD_ARTIFACT ? { ...step, if: "always()" } : step) }))],
    ["no leak scan", (w: Record<string, unknown>) => withSafariJob(w, (job) => ({ ...job, steps: (job.steps as Array<Record<string, unknown>>).filter((step) => step.id !== LEAK_SCAN_ID) }))],
    ["a workflow_run trigger", (w: Record<string, unknown>) => ({ ...w, on: { ...(w.on as Record<string, unknown>), workflow_run: { workflows: ["Dagger"] } } })],
    ["a second job", (w: Record<string, unknown>) => ({ ...w, jobs: { ...(w.jobs as Record<string, unknown>), other: { "runs-on": "macos-15", steps: [] } } })],
  ])("the real-Safari smoke contract rejects %s", (_name, mutate) => {
    expect(safariSmokeViolations(mutate(workflow("safari-smoke.yml")))).not.toEqual([])
  })

  test("the Mac gate keeps its acceptance identity while three independent 45-minute lanes must all pass", () => {
    const jobs = workflow("webkit-macos.yml").jobs as Record<string, Record<string, unknown>>
    expect(Object.keys(jobs).sort()).toEqual(["webkit-macos", "webkit-memory", "webkit-portable", "webkit-travel"])
    for (const mode of MACOS_LANE_MODES) {
      const job = jobs[`webkit-${mode}`]
      expect(job["runs-on"]).toBe("macos-15")
      expect(job["timeout-minutes"]).toBe(45)
      expect(job).not.toHaveProperty("env")
      expect((job.steps as Array<Record<string, unknown>>).map((step) => step.run)).toContain(`bash scripts/webkit-macos-lane.sh ${mode}`)
      expect((job.steps as Array<Record<string, unknown>>).map((step) => step.run)).toContain(`bash scripts/webkit-macos-lane.sh --finalize-evidence ${mode}`)
    }
    expect(jobs["webkit-macos"].name).toBe("webkit / macOS time travel + export-import")
    expect(jobs["webkit-macos"].needs).toEqual(["webkit-memory", "webkit-travel", "webkit-portable"])
    expect(jobs["webkit-macos"].if).toBe("${{ !cancelled() }}")
    expect(jobs["webkit-macos"].steps).toEqual([{
      env: {
        MEMORY_RESULT: "${{ needs.webkit-memory.result }}",
        TRAVEL_RESULT: "${{ needs.webkit-travel.result }}",
        PORTABLE_RESULT: "${{ needs.webkit-portable.result }}",
      },
      run: 'test "$MEMORY_RESULT" = success && test "$TRAVEL_RESULT" = success && test "$PORTABLE_RESULT" = success',
    }])
  })

  test("memory, travel and portable commands are isolated behind closed modes, with fail-closed evidence snapshots", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    expect(script).toContain('case "${MODE}" in memory|travel|portable|functional|all) ;; *)')
    expect(script).toContain('run_memory_lane() {')
    expect(script).toContain('start_functional_preview() {')
    expect(script).toContain('run_travel_lane() {')
    expect(script).toContain('run_portable_lane() {')
    expect(script).toContain('if [[ "${MODE}" == memory || "${MODE}" == all ]]; then run_memory_lane; fi')
    expect(script).toContain('if [[ "${MODE}" == travel || "${MODE}" == portable || "${MODE}" == functional || "${MODE}" == all ]]; then start_functional_preview; fi')
    expect(script).toContain('if [[ "${MODE}" == travel || "${MODE}" == functional || "${MODE}" == all ]]; then run_travel_lane; fi')
    expect(script).toContain('if [[ "${MODE}" == portable || "${MODE}" == functional || "${MODE}" == all ]]; then run_portable_lane; fi')
    expect(script).toContain('[[ -f "${ARTIFACTS}/.lane-cleanup-finished" && ! -L "${ARTIFACTS}/.lane-cleanup-finished" ]]')
    expect(script).toContain('cp -R "${ARTIFACTS}" "${EVIDENCE_ROOT}"')
    expect(script).toContain("trap 'exit 130' INT")
    expect(script).toContain("trap 'exit 143' TERM")
  })

  test.each(["memory", "travel", "portable", "functional", "all"])("closed mode %s dispatches only its intended acceptance", (mode) => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    const memory = script.slice(script.indexOf("run_memory_lane() {"), script.indexOf("start_functional_preview() {"))
    const travel = script.slice(script.indexOf("run_travel_lane() {"), script.indexOf("run_portable_lane() {"))
    const portable = script.slice(script.indexOf("run_portable_lane() {"), script.indexOf('if [[ "${MODE}" == memory ||'))
    expect(memory).toContain("e2e/time-travel-memory.webkit.spec.ts")
    expect(memory).not.toContain("e2e/time-travel.spec.ts")
    expect(travel).toContain("e2e/time-travel.spec.ts")
    expect(travel).not.toMatch(/portable-invariants|boot-retry/)
    expect(portable).toContain("test:e2e:portable-invariants")
    expect(portable).toContain("test:e2e:boot-retry")
    expect(portable).not.toContain("test:e2e:time-travel")
    expect(travel + portable).not.toMatch(/TT_MEMORY_|TT_WEBKIT_BASELINE|REFERENCE_|time-travel-memory/)
    const dispatch = script.split("\n").filter((line) => line.startsWith('if [[ "${MODE}" ==') && /run_|start_functional_preview/.test(line)).join("\n")
    const result = spawnSync("bash", ["-c", `MODE="$1"; run_memory_lane() { echo memory; }; start_functional_preview() { echo preview; }; run_travel_lane() { echo travel; }; run_portable_lane() { echo portable; }; ${dispatch}`, "dispatch", mode], { encoding: "utf8" })
    expect(result.status).toBe(0)
    const expected = mode === "memory" ? ["memory"] : mode === "all" ? ["memory", "preview", "travel", "portable"]
      : mode === "functional" ? ["preview", "travel", "portable"] : ["preview", mode]
    expect(result.stdout.trim().split("\n")).toEqual(expected)
  })

  /**
   * Runs a lane mode's suites with stubbed commands. `failing` lists the
   * run_lane_command calls (1-based) that fail; `node` maps the flake-retry
   * subcommand (plan/verify) to its exit status.
   */
  function stubbedLane(mode: string, failing: number[], node: Record<string, number>) {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    const suites = script.slice(script.indexOf("run_suite_with_flake_retry() {"), script.indexOf('if [[ "${MODE}" == memory ||'))
    return spawnSync("bash", ["-c", `set -eu
unset CI
HOME=/home/runner
BASE_URL=http://127.0.0.1:4199
ARTIFACTS=evidence
status=0
calls=0
run_lane_command() { calls=$((calls + 1)); printf '%s\\n' "$*"; [[ " $FAILING " != *" $calls "* ]]; }
node() { printf 'node %s %s\\n' "$1" "$2"; case "$2" in plan) return "$PLAN" ;; verify) return "$VERIFY" ;; esac; }
${suites}
run_${mode}_lane
exit "$status"
`], { encoding: "utf8", env: { PATH: process.env.PATH, FAILING: failing.join(" "), PLAN: String(node.plan ?? 1), VERIFY: String(node.verify ?? 1) } })
  }

  const TRAVEL_RUN = "bun run test:e2e:time-travel e2e/time-travel.spec.ts --project=webkit --project=iphone-webkit --project=iphone-15-webkit"
  const PLAN = "node scripts/webkitFlakeRetry.mjs plan"
  const VERIFY = "node scripts/webkitFlakeRetry.mjs verify"

  test.each(["travel", "portable"])("%s executes every assigned suite with no Playwright retries and retains failure status", (mode) => {
    // The first suite fails with something other than the known flake: the plan
    // refuses, nothing reruns, and the lane stays red.
    const result = stubbedLane(mode, [1], { plan: 1 })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe("")
    expect(result.stdout.trim().split("\n")).toEqual(mode === "travel" ? [
      `${TRAVEL_RUN} --retries=0 --reporter=list,json --output=evidence/time-travel`, PLAN,
    ] : [
      "bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0 --reporter=list,json --output=evidence/portable-invariants", PLAN,
      "bun run test:e2e:boot-retry --project=webkit --retries=0 --reporter=list,json --output=evidence/boot-retry", PLAN,
    ])
  })

  test("a green suite is never rerun", () => {
    const result = stubbedLane("travel", [], { plan: 0, verify: 0 })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual([`${TRAVEL_RUN} --retries=0 --reporter=list,json --output=evidence/time-travel`, PLAN])
  })

  test("a known-flake failure reruns only the planned tests, once, and the passing rerun keeps the lane green", () => {
    const result = stubbedLane("travel", [1], { plan: 0, verify: 0 })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual([
      `${TRAVEL_RUN} --retries=0 --reporter=list,json --output=evidence/time-travel`, PLAN,
      `${TRAVEL_RUN} --test-list=evidence/time-travel-retry-list.txt --retries=0 --reporter=list,json --output=evidence/time-travel-retry`, VERIFY,
    ])
  })

  test.each([
    ["the rerun fails", [1, 2]],
    ["the rerun passes but does not prove every retried test passed", [1]],
  ])("a known-flake rerun stays red when %s", (_name, failing) => {
    const result = stubbedLane("travel", failing, { plan: 0, verify: 1 })
    expect(result.status).toBe(1)
    expect(result.stdout.trim().split("\n").filter((line) => line.startsWith("bun run"))).toHaveLength(2)
  })

  test.each([
    ["success", "success", "success"],
    ...["failure", "cancelled", "skipped"].flatMap((result) => [
      [result, "success", "success"], ["success", result, "success"], ["success", "success", result],
    ]),
  ])("aggregate requires successful memory/travel/portable results: %j / %j / %j", (memory, travel, portable) => {
    const jobs = workflow("webkit-macos.yml").jobs as Record<string, Record<string, unknown>>
    const step = (jobs["webkit-macos"].steps as Array<Record<string, unknown>>)[0]
    const result = spawnSync("bash", ["-c", String(step.run)], {
      env: { PATH: process.env.PATH, MEMORY_RESULT: memory, TRAVEL_RESULT: travel, PORTABLE_RESULT: portable },
      encoding: "utf8",
    })
    expect(result.status === 0).toBe([memory, travel, portable].every((value) => value === "success"))
  })

  test.each([["typo"], ["memory", "unexpected"], ["--finalize-evidence", "typo"], ["--collect-native-evidence", "typo"]])("unknown/extra lane arguments fail before any producer starts: %j", (...args) => {
    const result = spawnSync("bash", [resolve(root, MACOS_LANE_SCRIPT), ...args], { encoding: "utf8" })
    expect(result.status).toBe(64)
    expect(result.stderr).toMatch(/Unknown WebKit lane mode|Unexpected WebKit lane arguments/)
  })

  test.each(["memory", "travel", "portable", "functional", "all"])("%s finalization requires shell cleanup and copies evidence, failing closed on a stale destination", (mode) => {
    const sandbox = mkdtempSync(resolve(tmpdir(), "almamesh-webkit-finalize-"))
    try {
      const source = resolve(sandbox, mode === "all" ? "webkit-lane-artifacts" : `webkit-lane-artifacts-${mode}`)
      const snapshot = resolve(sandbox, `webkit-lane-evidence-${mode}`)
      mkdirSync(source)
      writeFileSync(resolve(source, "completed.log"), "completed evidence\n")
      const finalize = () => spawnSync("bash", [resolve(root, MACOS_LANE_SCRIPT), "--finalize-evidence", mode], {
        cwd: sandbox, env: { PATH: process.env.PATH, HOME: sandbox }, encoding: "utf8",
      })
      expect(finalize().status).not.toBe(0)
      expect(existsSync(snapshot)).toBe(false)
      writeFileSync(resolve(source, ".lane-cleanup-finished"), "")
      expect(finalize().status).toBe(0)
      expect(readFileSync(resolve(snapshot, "completed.log"), "utf8")).toBe("completed evidence\n")
      writeFileSync(resolve(source, "completed.log"), "later source mutation\n")
      rmSync(source, { recursive: true })
      expect(readFileSync(resolve(snapshot, "completed.log"), "utf8")).toBe("completed evidence\n")
      mkdirSync(source)
      writeFileSync(resolve(source, ".lane-cleanup-finished"), "")
      expect(finalize().status).not.toBe(0)
      expect(readFileSync(resolve(snapshot, "completed.log"), "utf8")).toBe("completed evidence\n")
    } finally { rmSync(sandbox, { recursive: true, force: true }) }
  })

  test("TERM performs direct-owned cleanup before the shell-cleanup marker", () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), "almamesh-webkit-cancel-"))
    try {
      const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
      const helpers = script.slice(0, script.indexOf('PORT="'))
      const cleanup = script.slice(script.indexOf("cleanup_lane() {"), script.indexOf("wait_for_preview() {"))
      const harness = `${helpers}
MEMORY_ROOT=""
CRASH_EVIDENCE_COLLECTED=1
mkdir -p "\${ARTIFACTS}"
${cleanup}
( while [[ ! -f "\${ARTIFACTS}/writer.log" ]]; do sleep 0.01; done; kill -TERM "$$" ) &
run_lane_command bash -c 'while true; do printf "sample\\n" >> "$1"; sleep 0.01; done' writer "\${ARTIFACTS}/writer.log"
`
      const source = resolve(sandbox, "evidence")
      const result = spawnSync("bash", ["-c", harness], {
        cwd: sandbox, env: { PATH: process.env.PATH, HOME: sandbox, WEBKIT_LANE_ARTIFACTS: source }, encoding: "utf8", timeout: 10_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(143)
      expect(existsSync(resolve(source, ".lane-cleanup-finished"))).toBe(true)
      expect(readFileSync(resolve(source, "writer.log"), "utf8").length).toBeGreaterThan(0)
    } finally { rmSync(sandbox, { recursive: true, force: true }) }
  })

  test.each(MACOS_LANE_MODES)("%s always collects bounded native diagnostics before finalization", (mode) => {
    const jobs = workflow("webkit-macos.yml").jobs as Record<string, { steps: Array<Record<string, unknown>> }>
    const jobSteps = jobs[`webkit-${mode}`]!.steps
    const at = jobSteps.findIndex((step) => step.id === "collect-native-evidence")
    expect(at).toBeGreaterThan(0)
    expect(jobSteps[at]).toEqual({
      id: "collect-native-evidence", if: "always()", "timeout-minutes": 2,
      run: `${LANE_RUN} --collect-native-evidence ${mode}`,
    })
    expect(jobSteps[at - 1]?.run).toBe(`${LANE_RUN} ${mode}`)
    expect(jobSteps[at + 1]?.id).toBe("finalize-evidence")
  })

  function nativeCollectorSandbox(logProgram = 'printf "synthetic unified log\\n"') {
    const sandbox = mkdtempSync(resolve(tmpdir(), "almamesh-native-evidence-"))
    const source = resolve(sandbox, "evidence")
    const userRoot = resolve(sandbox, "home/Library/Logs/DiagnosticReports")
    const bin = resolve(sandbox, "bin")
    mkdirSync(resolve(source, "crash-reports"), { recursive: true })
    mkdirSync(userRoot, { recursive: true })
    mkdirSync(bin)
    writeFileSync(resolve(source, ".lane-start"), "2000-01-01 00:00:00\n")
    utimesSync(resolve(source, ".lane-start"), new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'))
    const writeCommand = (name: string, program: string) => writeFileSync(resolve(bin, name), `#!/bin/bash\n${program}\n`, { mode: 0o755 })
    // The contracts image has Bun but no Node CLI. Exercise the collector using
    // the current runtime, including its stdin ESM and child-process contracts.
    const runtime = `'${process.execPath.replaceAll("'", "'\\''")}'`
    writeCommand("node", `exec ${runtime} "$@"`)
    writeCommand("find", 'if [[ "$1" == *"/home/Library/Logs/DiagnosticReports" ]]; then cat "' + resolve(sandbox, "reports.txt") + '"; fi')
    writeFileSync(resolve(sandbox, "reports.txt"), "")
    writeCommand("log", logProgram)
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: resolve(sandbox, "home"), WEBKIT_LANE_ARTIFACTS: source }
    const collect = () => spawnSync("bash", [resolve(root, MACOS_LANE_SCRIPT), "--collect-native-evidence", "travel"], {
      cwd: sandbox, env, encoding: "utf8", timeout: 20_000,
    })
    const manifest = () => JSON.parse(readFileSync(resolve(source, "native-collection-status.json"), "utf8")) as {
      state: string; roots: Array<{ name: string; status: string }>;
      reports: Array<{ name: string; status: string }>;
      limits: { maxReports: number; maxReportBytes: number; maxTotalBytes: number };
      copyTotals: { consideredCount: number; readAttempts: number; reservedBytes: number; copiedCount: number; copiedBytes: number };
      unifiedLog: { status: string; exitCode: number | null; timedOut: boolean };
    }
    return { sandbox, source, userRoot, env, collect, manifest, writeCommand }
  }

  test("normal zero-report collection saves a complete manifest and unified log", () => {
    const fixture = nativeCollectorSandbox()
    try {
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().state).toBe("complete")
      expect(fixture.manifest().reports).toEqual([])
      expect(fixture.manifest().unifiedLog).toMatchObject({ status: "collected", exitCode: 0, timedOut: false })
      expect(readFileSync(resolve(fixture.source, "unified-log.txt"), "utf8")).toContain("synthetic unified log")
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("missing report roots are recorded rather than claiming that no crash occurred", () => {
    const fixture = nativeCollectorSandbox()
    try {
      rmSync(fixture.userRoot, { recursive: true })
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().roots[0]).toMatchObject({ name: "user", status: "missing" })
      expect(fixture.manifest().unifiedLog.status).toBe("collected")
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("fresh matching native reports are copied while stale and unrelated reports stay excluded", () => {
    const fixture = nativeCollectorSandbox()
    try {
      const name = "com.apple.WebKit.WebContent.Development-2026-10-11.ips"
      const report = resolve(fixture.userRoot, name)
      const contents = '{}\n{"procName":"com.apple.WebKit.WebContent.Development","termination":{"namespace":"SIGNAL","indicator":"Segmentation fault: 11"}}'
      writeFileSync(report, contents)
      const unrelated = resolve(fixture.userRoot, "WindowServer-2026-10-11.ips")
      writeFileSync(unrelated, "unrelated")
      const staleName = "com.apple.WebKit.WebContent.Development-1999-01-01.ips"
      const stale = resolve(fixture.userRoot, staleName)
      writeFileSync(stale, "stale")
      utimesSync(stale, new Date('1999-01-01T00:00:00Z'), new Date('1999-01-01T00:00:00Z'))
      writeFileSync(resolve(fixture.sandbox, "reports.txt"), `${report}\0${unrelated}\0${stale}\0`)
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().reports).toEqual([{ name, status: "copied", bytes: contents.length }, { name: staleName, status: "stale" }])
      expect(readFileSync(resolve(fixture.source, "crash-reports", name), "utf8")).toBe(contents)
      expect(existsSync(resolve(fixture.source, "crash-reports", "WindowServer-2026-10-11.ips"))).toBe(false)
      expect(existsSync(resolve(fixture.source, "crash-reports", staleName))).toBe(false)
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("failed report searches are recorded without blocking the bounded unified-log query", () => {
    const fixture = nativeCollectorSandbox()
    try {
      fixture.writeCommand("find", 'printf "synthetic permission error\\n" >&2; exit 3')
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().roots[0]).toMatchObject({ name: "user", status: "error", exitCode: 3, stderr: "synthetic permission error\n" })
      expect(fixture.manifest().unifiedLog.status).toBe("collected")
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("a report-copy error is retained in the manifest without becoming a product failure", () => {
    const fixture = nativeCollectorSandbox()
    try {
      const name = "com.apple.WebKit.WebContent.Development-2026-10-11.ips"
      const report = resolve(fixture.userRoot, name)
      writeFileSync(report, '{}\n{}')
      writeFileSync(resolve(fixture.sandbox, "reports.txt"), `${report}\0`)
      mkdirSync(resolve(fixture.source, "crash-reports", name))
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().reports[0]).toMatchObject({ name, status: "copy-error" })
      expect(fixture.manifest().unifiedLog.status).toBe("collected")
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("native report copies have an explicit count ceiling with recorded skips", () => {
    const fixture = nativeCollectorSandbox()
    try {
      const names = Array.from({ length: 33 }, (_, index) => `com.apple.WebKit.WebContent.Development-${index}.ips`)
      const paths = names.map((name) => resolve(fixture.userRoot, name))
      for (const path of paths) writeFileSync(path, '{}\n{}')
      writeFileSync(resolve(fixture.sandbox, "reports.txt"), `${paths.join('\0')}\0`)
      expect(fixture.collect().status).toBe(0)
      const manifest = fixture.manifest()
      expect(manifest.limits).toEqual({ maxReports: 32, maxReportBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })
      expect(manifest.copyTotals).toMatchObject({ consideredCount: 32, readAttempts: 32, copiedCount: 32 })
      expect(manifest.reports[32]).toMatchObject({ name: names[32], status: "skipped-count-limit" })
      expect(existsSync(resolve(fixture.source, "crash-reports", names[32]!))).toBe(false)
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("oversized native reports are explicitly excluded before reading or copying", () => {
    const fixture = nativeCollectorSandbox()
    try {
      const name = "com.apple.WebKit.WebContent.Development-large.ips"
      const report = resolve(fixture.userRoot, name)
      writeFileSync(report, '')
      truncateSync(report, 16 * 1024 * 1024 + 1)
      writeFileSync(resolve(fixture.sandbox, "reports.txt"), `${report}\0`)
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().reports).toEqual([{ name, status: "skipped-size-limit", bytes: 16 * 1024 * 1024 + 1 }])
      expect(fixture.manifest().copyTotals).toMatchObject({ readAttempts: 0, reservedBytes: 0, copiedBytes: 0 })
      expect(existsSync(resolve(fixture.source, "crash-reports", name))).toBe(false)
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("native report copies retain full within-limit files and respect the aggregate byte ceiling", () => {
    const fixture = nativeCollectorSandbox()
    try {
      const names = Array.from({ length: 5 }, (_, index) => `com.apple.WebKit.WebContent.Development-bytes-${index}.ips`)
      const paths = names.map((name) => resolve(fixture.userRoot, name))
      for (const path of paths) { writeFileSync(path, 'native report prefix'); truncateSync(path, 16 * 1024 * 1024) }
      writeFileSync(resolve(fixture.sandbox, "reports.txt"), `${paths.join('\0')}\0`)
      expect(fixture.collect().status).toBe(0)
      const manifest = fixture.manifest()
      expect(manifest.copyTotals).toMatchObject({ readAttempts: 4, reservedBytes: 64 * 1024 * 1024, copiedCount: 4, copiedBytes: 64 * 1024 * 1024 })
      expect(manifest.reports[4]).toMatchObject({ name: names[4], status: "skipped-total-size-limit", bytes: 16 * 1024 * 1024 })
      const copied = readFileSync(resolve(fixture.source, "crash-reports", names[0]!))
      expect(copied.byteLength).toBe(16 * 1024 * 1024)
      expect(copied.subarray(0, 20).toString()).toBe('native report prefix')
      expect(copied.at(-1)).toBe(0)
      expect(existsSync(resolve(fixture.source, "crash-reports", names[4]!))).toBe(false)
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("failed native log queries retain stderr and an explicit failure status without gating product acceptance", () => {
    const fixture = nativeCollectorSandbox('printf "native query unavailable\\n" >&2; exit 7')
    try {
      expect(fixture.collect().status).toBe(0)
      expect(fixture.manifest().unifiedLog).toMatchObject({ status: "error", exitCode: 7, timedOut: false })
      expect(readFileSync(resolve(fixture.source, "unified-log.txt"), "utf8")).toContain("native query unavailable")
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("an independent failed query preserves a prior successful unified-log capture", () => {
    const fixture = nativeCollectorSandbox()
    try {
      expect(fixture.collect().status).toBe(0)
      fixture.writeCommand("log", 'printf "later native query unavailable\\n" >&2; exit 7')
      expect(fixture.collect().status).toBe(0)
      const log = readFileSync(resolve(fixture.source, "unified-log.txt"), "utf8")
      expect(log).toContain("synthetic unified log")
      expect(log).toContain("later native query unavailable")
      expect(fixture.manifest().unifiedLog.status).toBe("error")
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("native log queries time out and still leave a completed diagnostic manifest", () => {
    const fixture = nativeCollectorSandbox('exec node -e "setInterval(() => {}, 1000)"')
    try {
      const result = fixture.collect()
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(fixture.manifest().state).toBe("complete")
      expect(fixture.manifest().unifiedLog).toMatchObject({ status: "timeout", exitCode: null, timedOut: true })
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  }, 20_000)

  test("inability to write the required collection manifest remains fatal", () => {
    const fixture = nativeCollectorSandbox()
    try {
      mkdirSync(resolve(fixture.source, "native-collection-status.json"))
      expect(fixture.collect().status).toBe(1)
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("TERM cleanup attempts native collection and preserves the original signal exit", () => {
    const fixture = nativeCollectorSandbox()
    try {
      const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
      const helpers = script.slice(0, script.indexOf('PORT="'))
      const cleanup = script.slice(script.indexOf("cleanup_lane() {"), script.indexOf("wait_for_preview() {"))
      // Execute a real file as the lane does. Linux bash -c identifies function
      // sources as "environment", so its BASH_SOURCE cannot locate the helper.
      const harness = resolve(fixture.sandbox, "webkit-macos-lane.sh")
      writeFileSync(harness, `${helpers}\nMEMORY_ROOT=""\nCRASH_EVIDENCE_COLLECTED=0\n${cleanup}\nkill -TERM "$$"\n`)
      writeFileSync(resolve(fixture.sandbox, "crashReportSummary.mjs"), readFileSync(resolve(root, "frontend/apps/web/scripts/crashReportSummary.mjs")))
      const result = spawnSync("bash", [harness], {
        cwd: fixture.sandbox, env: fixture.env, encoding: "utf8", timeout: 20_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe("")
      expect(result.status).toBe(143)
      expect(fixture.manifest().state).toBe("complete")
      expect(existsSync(resolve(fixture.source, ".lane-cleanup-finished"))).toBe(true)
    } finally { rmSync(fixture.sandbox, { recursive: true, force: true }) }
  })

  test("normal command completion forgets its PID without any historical process kill", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    const helpers = script.slice(0, script.indexOf('PORT="'))
    const result = spawnSync("bash", ["-c", `${helpers}
KILL_CALLS=0
kill() { KILL_CALLS=$((KILL_CALLS + 1)); return 1; }
run_lane_command true
[[ -z "$PRODUCER_PIDS" && "$KILL_CALLS" == 0 ]]
`], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("unexpected-historical-kill")
  })

  test("a detached source writer may outlive shell cleanup while the finalized snapshot stays unchanged", async () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), "almamesh-webkit-detached-"))
    const source = resolve(sandbox, "webkit-lane-artifacts-functional")
    const snapshot = resolve(sandbox, "webkit-lane-evidence-functional")
    mkdirSync(source)
    writeFileSync(resolve(source, ".lane-cleanup-finished"), "")
    const sourceLog = resolve(source, "detached-writer.log")
    const child = spawn(process.execPath, ["-e", 'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.argv[1],"sample\\n"),10)', sourceLog], {
      detached: true, stdio: ["ignore", "ignore", "pipe"],
    })
    let spawnError: Error | undefined
    let exitDescription: string | undefined
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2048) })
    const exited = new Promise<void>((done) => {
      child.once("error", (error) => { spawnError = error; done() })
      child.once("exit", (code, signal) => { exitDescription = `code=${code}, signal=${signal}`; done() })
    })
    try {
      const waitFor = async (predicate: () => boolean) => {
        const ready = () => {
          if (spawnError) throw spawnError
          if (exitDescription) throw new Error(`Detached writer exited before snapshot verification (${exitDescription}): ${stderr}`)
          return predicate()
        }
        const deadline = Date.now() + 3000
        while (!ready() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10))
        expect(ready()).toBe(true)
      }
      await waitFor(() => existsSync(sourceLog))
      if (child.pid === undefined) throw new Error("Detached writer has no process ID")
      expect(process.kill(-child.pid, 0)).toBe(true)
      const finalize = spawnSync("bash", [resolve(root, MACOS_LANE_SCRIPT), "--finalize-evidence", "functional"], {
        cwd: sandbox, env: { PATH: process.env.PATH, HOME: sandbox }, encoding: "utf8",
      })
      expect(finalize.status).toBe(0)
      const snapshotLog = resolve(snapshot, "detached-writer.log")
      const copied = readFileSync(snapshotLog, "utf8")
      await waitFor(() => readFileSync(sourceLog, "utf8").length > copied.length)
      expect(readFileSync(snapshotLog, "utf8")).toBe(copied)
    } finally {
      child.kill("SIGTERM")
      await exited
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test.each([
    ["missing memory lane", (w: Record<string, unknown>) => { const jobs = { ...(w.jobs as Record<string, unknown>) }; delete jobs["webkit-memory"]; return { ...w, jobs } }],
    ...["travel", "portable"].map((mode) => [`missing ${mode} lane`, (w: Record<string, unknown>) => { const jobs = { ...(w.jobs as Record<string, unknown>) }; delete jobs[`webkit-${mode}`]; return { ...w, jobs } }] as const),
    ...["travel", "portable"].map((mode) => [`aggregate ignores ${mode} result`, (w: Record<string, unknown>) => { const jobs = structuredClone(w.jobs) as Record<string, Record<string, unknown>>; jobs["webkit-macos"].needs = ["webkit-memory", `webkit-${mode === "travel" ? "portable" : "travel"}`]; return { ...w, jobs } }] as const),
    ["aggregate allows failure", (w: Record<string, unknown>) => { const jobs = structuredClone(w.jobs) as Record<string, Record<string, unknown>>; jobs["webkit-macos"].steps = [{ run: "true" }]; return { ...w, jobs } }],
    ["workflow exports artifact path", (w: Record<string, unknown>) => ({ ...w, env: { WEBKIT_LANE_ARTIFACTS: "webkit-lane-artifacts-memory" } })],
    ["lane exports artifact path", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, env: { WEBKIT_LANE_ARTIFACTS: "webkit-lane-artifacts-memory" } }))],
    ["finalizer changes source path", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => step.id === "finalize-evidence" ? { ...step, env: { WEBKIT_LANE_ARTIFACTS: "/tmp/elsewhere" } } : step))],
    ["lane skipped", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, if: "false" }))],
    ["lane allowed failure", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, "continue-on-error": true }))],
    ["expanded time budget", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, "timeout-minutes": 60 }))],
    ["finalization omitted", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.filter((step) => step.id !== "finalize-evidence"))],
    ["native collection omitted", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.filter((step) => step.id !== "collect-native-evidence"))],
    ["native collection conditional", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => step.id === "collect-native-evidence" ? { ...step, if: "success()" } : step))],
    ["native collection unbounded", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => step.id === "collect-native-evidence" ? { ...step, "timeout-minutes": 5 } : step))],
    ["native collection blanket failure exclusion", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => step.id === "collect-native-evidence" ? { ...step, "continue-on-error": true } : step))],
    ["finalization allowed failure", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => step.id === "finalize-evidence" ? { ...step, "continue-on-error": true } : step))],
    ["scan live source", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => step.id === "leak-scan" ? { ...step, run: "node scripts/artifactLeakScan.mjs webkit-lane-artifacts-functional" } : step))],
    ["upload live source", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, with: { ...(step.with as object), path: "frontend/apps/web/webkit-lane-artifacts-functional" } }))],
    ["skip tests", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => typeof step.run === "string" && /^bash scripts\/webkit-macos-lane.sh (memory|travel|portable)$/.test(step.run) ? { ...step, if: "false" } : step))],
  ])("split acceptance rejects %s", (_name, mutate) => {
    expect(macosLaneViolations(mutate(workflow("webkit-macos.yml")))).not.toEqual([])
  })

  test("the secrets check ignores the word outside an expression", () => {
    expect(SECRETS_ACCESS.test("${{ github.sha }} no secrets here ${{ github.ref }}")).toBe(false)
  })

  test.each([
    ["a secret", (w: Record<string, unknown>) => ({ ...w, env: { KEY: "${{ secrets.OPENROUTER_API_KEY }}" } })],
    ["write permissions", (w: Record<string, unknown>) => ({ ...w, permissions: { contents: "write" } })],
    ["macos-latest", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, "runs-on": "macos-latest" }))],
    ["an extra run step", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, steps: [...(job.steps as unknown[]), { run: "curl x | sh" }] }))],
    ["a tag-pinned action", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, steps: [{ uses: "actions/checkout@v7" }, ...(job.steps as unknown[]).slice(1)] }))],
    ["a pull_request_target trigger", (w: Record<string, unknown>) => ({ ...w, on: { ...(w.on as Record<string, unknown>), pull_request_target: null } })],
    ["only a pull_request_target trigger", (w: Record<string, unknown>) => ({ ...w, on: { pull_request_target: null } })],
    ["a workflow_run trigger", (w: Record<string, unknown>) => ({ ...w, on: { ...(w.on as Record<string, unknown>), workflow_run: { workflows: ["Dagger"] } } })],
    ["a bracketed secret", (w: Record<string, unknown>) => ({ ...w, env: { KEY: "${{ secrets['GH_PAT'] }}" } })],
    ["a spaced secret", (w: Record<string, unknown>) => ({ ...w, env: { KEY: "${{ secrets .GH_PAT }}" } })],
    ["the whole secrets context", (w: Record<string, unknown>) => ({ ...w, env: { ALL: "${{ toJSON(secrets) }}" } })],
    ["secrets passed to a function", (w: Record<string, unknown>) => ({ ...w, env: { K: "${{ format('{0}', secrets) }}" } })],
    ["persisted checkout credentials", (w: Record<string, unknown>) => withCheckout(w, (inputs) => ({ ...inputs, "persist-credentials": true }))],
    ["a checkout without persist-credentials", (w: Record<string, unknown>) => withCheckout(w, ({ "persist-credentials": _dropped, ...inputs }) => inputs)],
    ["a shallow checkout without the pinned original release", (w: Record<string, unknown>) => withCheckout(w, (inputs) => ({ ...inputs, "fetch-depth": 1 }))],
    ["an unlisted SHA-pinned action", (w: Record<string, unknown>) => withJob(w, (job) => ({ ...job, steps: [...(job.steps as unknown[]), { uses: `someone/exfiltrate@${"a".repeat(40)}` }] }))],
    ["no evidence upload", (w: Record<string, unknown>) => withUpload(w, () => null)],
    ["an evidence upload of the home directory", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, with: { ...(step.with as object), path: "~" } }))],
    ["an evidence upload of the whole checkout", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, with: { ...(step.with as object), path: "." } }))],
    ["an evidence upload only on success", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, if: "success()" }))],
    ["an evidence upload with extra inputs", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, with: { ...(step.with as object), overwrite: true } }))],
    ["no leak scan", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.filter((step) => step.id !== "leak-scan"))],
    ["a leak scan before the tests", (w: Record<string, unknown>) => withSteps(w, (steps) => moveLeakScan(steps, 3))],
    ["a leak scan after the upload", (w: Record<string, unknown>) => withSteps(w, (steps) => moveLeakScan(steps, steps.length))],
    ["a leak scan that runs only on success", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => (step.id === "leak-scan" ? { ...step, if: "success()" } : step)))],
    ["a leak scan allowed to fail", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => (step.id === "leak-scan" ? { ...step, "continue-on-error": true } : step)))],
    ["a leak scan of another directory", (w: Record<string, unknown>) => withSteps(w, (steps) => steps.map((step) => (step.id === "leak-scan" ? { ...step, run: "node scripts/artifactLeakScan.mjs /tmp/empty" } : step)))],
    ["an upload that does not wait for the leak scan", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, if: "always()" }))],
    ["an upload gated on a different step", (w: Record<string, unknown>) => withUpload(w, (step) => ({ ...step, if: "always() && steps.other.outcome == 'success'" }))],
  ])("the macOS lane contract rejects %s", (_name, mutate) => {
    expect(macosLaneViolations(mutate(workflow("webkit-macos.yml")))).not.toEqual([])
  })

  test("the macOS lane script writes only allowlisted evidence and never the runner's environment", () => {
    expect(laneScriptViolations(readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8"))).toEqual([])
  })

  test.each([
    ["env", 'env > "${ARTIFACTS}/env.txt"'],
    ["printenv", 'printenv >> "${ARTIFACTS}/machine.txt"'],
    ["a bare set", 'set > "${ARTIFACTS}/machine.txt"'],
    ["set piped", "set | grep TOKEN"],
    ["a GITHUB_ variable", 'echo "${GITHUB_TOKEN}" > "${ARTIFACTS}/machine.txt"'],
    ["an ACTIONS_ variable", 'echo "$ACTIONS_RUNTIME_TOKEN" >> "${ARTIFACTS}/unified-log.txt"'],
    ["a write to an unlisted file", 'date > "${ARTIFACTS}/notes.txt"'],
    ["a tee to an unlisted file", 'date | tee "${ARTIFACTS}/notes.txt"'],
    ["a copy to an unlisted place", 'cp ~/.netrc "${ARTIFACTS}/"'],
    ["$(env)", 'echo "$(env)" > "${ARTIFACTS}/machine.txt"'],
    ["declare -p", 'declare -p > "${ARTIFACTS}/machine.txt"'],
    ["export -p", 'export -p >> "${ARTIFACTS}/machine.txt"'],
    ["typeset -p", "typeset -p | grep TOKEN"],
    ["/proc/self/environ", 'cat /proc/self/environ > "${ARTIFACTS}/machine.txt"'],
    ["ps with environment", 'ps eww -A >> "${ARTIFACTS}/machine.txt"'],
    ["ps -e", "ps -eww >> /tmp/x"],
    ["cp ~/.gitconfig into crash-reports", 'cp ~/.gitconfig "${ARTIFACTS}/crash-reports/"'],
    ["cp -R $HOME into crash-reports", 'cp -R "$HOME"/* "${ARTIFACTS}/crash-reports/"'],
    ["an alias then declare", 'A="${ARTIFACTS}"; declare -p > "$A/x.txt"'],
    ["an alias then date", 'A="${ARTIFACTS}"; date > "$A/notes.txt"'],
    ["unquoted ${ARTIFACTS}", "date > ${ARTIFACTS}/notes.txt"],
    ["$ARTIFACTS without braces", 'date > "$ARTIFACTS/notes.txt"'],
    ["an indirect ${!v}", 'v=GITHUB_TOKEN; echo "${!v}" > "${ARTIFACTS}/machine.txt"'],
    ["an indirect ${!v} away from ARTIFACTS", 'v=HOME; echo "${!v}"'],
    ["compgen -e", 'for k in $(compgen -e); do echo "$k=${!k}"; done >> "${ARTIFACTS}/machine.txt"'],
    ["mv into ARTIFACTS", 'mv /tmp/x "${ARTIFACTS}/x"'],
    ["rsync into ARTIFACTS", 'rsync -a "$HOME/.ssh" "${ARTIFACTS}/"'],
    ["ln into ARTIFACTS", 'ln -s "$HOME/.ssh" "${ARTIFACTS}/ssh"'],
    ["install into ARTIFACTS", 'install -m 644 ~/.gitconfig "${ARTIFACTS}/g"'],
    ["cd into ARTIFACTS", 'cd "${ARTIFACTS}" && cp ~/.gitconfig .'],
    ["a pinned line with a second command", 'touch "${ARTIFACTS}/.lane-start"; env > "${ARTIFACTS}/machine.txt"'],
  ])("the macOS lane script contract rejects %s", (_name, line) => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    expect(laneScriptViolations(`${script}\n${line}\n`)).not.toEqual([])
  })

  test("the macOS lane runs time travel and export/import on desktop Safari and an iPhone", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    expect(script).toContain("VITE_EXIT_GATE_HOOKS=1")
    // CONTRACT NARROWED 2026-10-13 (was: "No retries: a WebKit page that crashes
    // once must turn the lane red"). Still no Playwright retries; a crash turns
    // the lane red unless its .ips matches the one known macOS-VM flake
    // (scripts/webkitFlakeRetry.mjs), which earns that test exactly one rerun.
    expect(script).toContain('run_suite_with_flake_retry travel test:e2e:time-travel "${ARTIFACTS}/time-travel" e2e/time-travel.spec.ts --project=webkit --project=iphone-webkit --project=iphone-15-webkit || status=1')
    expect(script).toContain('run_suite_with_flake_retry portable-invariants test:e2e:portable-invariants "${ARTIFACTS}/portable-invariants" --project=webkit --project=iphone-webkit || status=1')
    expect(script).toContain('run_lane_command bun run "${script}" "$@" --retries=0 --reporter="${reporter}" --output="${output}" || first=$?')
    expect(script).toContain('--out "${ARTIFACTS}/flake-retry-${suite}.json" || return "${first}"')
    expect(script).toContain('run_lane_command bun run "${script}" "$@" --test-list="${output}-retry-list.txt" --retries=0')
    expect(script).not.toMatch(/--retries=[1-9]/)
    expect(script).not.toMatch(/--last-failed|--repeat-each=[0-9]+ [^\n]*time-travel\.spec/)
    for (const config of ["playwright.time-travel.config.ts", "playwright.portable-invariants.config.ts"]) {
      const source = readFileSync(resolve(root, "frontend/apps/web", config), "utf8")
      expect(source).toContain('name: "webkit", use: { ...devices["Desktop Safari"]')
      expect(source).toContain('name: "iphone-webkit", use: { ...devices["iPhone 13"]')
    }
  })

  test("the macOS lane compares five original-release boots with five final Day journeys on separate no-hooks builds", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    expect(memoryLaneViolations(script)).toEqual([])
    expect(script).toContain("--grep 'boot baseline' --repeat-each=5 --retries=0 --reporter=json")
    expect(script).toContain("--grep 'WebContent RSS budget' --repeat-each=5 --retries=0")
    expect(script).toContain('TT_WEBKIT_BASELINE_MIB="${BASELINE_MIB}" TIME_TRAVEL_E2E_BASE_URL="${MEMORY_URL}"')
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    expect(source).toContain('"tests/webkit-memory-baseline.test.ts"')
    expect(source).toContain('"frontend/apps/web/scripts/webkit-memory-baseline.mjs"')
  })

  test.each([
    ["a candidate baseline", 'REFERENCE_REF="8d10fbbb76336a8a5efe272912e392e260b3fef5"', 'REFERENCE_REF="${MEASUREMENT_REF}"'],
    ["candidate code signed for the reference", 'cd "${REFERENCE_WEB}" && DEV_BUNDLE_SEQUENCE=', 'cd . && DEV_BUNDLE_SEQUENCE='],
    ["a hooked reference build", 'BUILD_COMMIT="${REFERENCE_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ', 'BUILD_COMMIT="${REFERENCE_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 '],
    ["a hooked candidate memory build", 'BUILD_COMMIT="${MEASUREMENT_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS= ', 'BUILD_COMMIT="${MEASUREMENT_REF}" VITE_API_URL= VITE_EXIT_GATE_HOOKS=1 '],
    ["a report-only candidate", 'TT_MEMORY_REPORT_ONLY=0', 'TT_MEMORY_REPORT_ONLY=1'],
    ["a preliminary candidate", 'TT_MEMORY_PHASE=final', 'TT_MEMORY_PHASE=initial'],
    ["an archive limited to the lane's web working directory", 'git -C "${REPO_ROOT}" archive', 'git archive'],
    ["reference asset copies without a destination directory", 'mkdir -p "${REFERENCE_WEB}/public"', ':'],
  ])("the memory comparison contract rejects %s", (_name, from, to) => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    expect(memoryLaneViolations(script.replace(from, to))).not.toEqual([])
  })

  test("the reference public directory exists before either runtime asset copy", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    const directory = script.indexOf('mkdir -p "${REFERENCE_WEB}/public"')
    expect(directory).toBeGreaterThan(-1)
    expect(directory).toBeLessThan(script.indexOf('cp -R public/pyodide'))
    expect(directory).toBeLessThan(script.indexOf('cp -R public/models'))
    const lateDirectory = script.replace('mkdir -p "${REFERENCE_WEB}/public"', ':') + '\nmkdir -p "${REFERENCE_WEB}/public"\n'
    expect(memoryLaneViolations(lateDirectory)).toContain("reference-public-directory-order")
  })

  test("the macOS lane drives the one automatic boot retry on WebKit against the hooked preview", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    // The fault switch exists only in the hooks build the lane already serves.
    expect(script).toContain('BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" run_suite_with_flake_retry boot-retry test:e2e:boot-retry "${ARTIFACTS}/boot-retry" --project=webkit || status=1')
    const config = readFileSync(resolve(root, "frontend/apps/web/playwright.boot-retry.config.ts"), "utf8")
    expect(config).toContain('name: "webkit", use: { ...devices["Desktop Safari"]')
    expect(config).toContain("process.env.BOOT_RETRY_E2E_BASE_URL")
  })

  test("every post-merge publisher exception is main-only, path-filtered, PR-free, and thin Dagger", () => {
    for (const name of Object.keys(POST_MERGE_PUBLISHERS)) {
      expect(publisherViolations(name)).toEqual([])
      expectThinDaggerIngress(name)
    }
  })

  test.each([
    ["on: push", "on: push\n"],
    ["on: [push]", "on: [push]\n"],
    ["on: pull_request", "on:\n  pull_request:\n"],
    ["on: pull_request_target", "on:\n  pull_request_target:\n"],
    ["on: push with a branch filter", "on:\n  push:\n    branches: [main]\n"],
  ])("a new workflow with %s is caught as a gating ingress", (_name, on) => {
    expect(eventsOf(Bun.YAML.parse(`name: rogue\n${on}`) as Record<string, unknown>))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^(push|pull_request(_target)?)$/)]))
  })

  test.each([
    ["a pull_request trigger", (on: Record<string, unknown>) => ({ ...on, pull_request: null })],
    ["a push to any branch", (on: Record<string, unknown>) => ({ ...on, push: { paths: ["x"] } })],
    ["a push without a path filter", (on: Record<string, unknown>) => ({ ...on, push: { branches: ["main"] } })],
  ])("the toolchain publisher exception rejects %s", (_name, mutate) => {
    const parsed = workflow("toolchain-image.yml")
    const mutant = { ...parsed, on: mutate(parsed.on as Record<string, unknown>) }
    expect(onViolations(mutant)).not.toEqual([])
  })

  test("nightly passes the optional OpenRouter key only as a typed secret provider", () => {
    const source = workflowSource("nightly-e2e.yml")
    expect(source).toContain("OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}")
    expect(source).toContain("--openrouter-api-key=env:OPENROUTER_API_KEY")
    expect(source).not.toContain("VITE_OPENROUTER")
  })

  test("production deployment binds the exact protected run through typed secrets", () => {
    const source = workflowSource("deploy.yml")
    expect(source).not.toContain("workflow_dispatch")
    expect(source).toContain("github.event.workflow_run.event == 'push'")
    expect(source).toContain("github.event.workflow_run.head_repository.full_name == github.repository")
    expect(source).toContain("ref: ${{ github.event.workflow_run.head_sha }}")
    // INVERTED CONTRACT (hseshadr/ci#50, fleet rule dagger-args-expression): this
    // used to REQUIRE `--expected-sha=${{ github.event.workflow_run.head_sha }}` (and
    // the run id / attempt) inside `args`, which dagger-for-github pastes into bash.
    // The event values now reach the step only through env and are quoted.
    expect(source).not.toContain("--expected-sha=${{ github.event.workflow_run.head_sha }}")
    expect(source).not.toContain("--workflow-run-id=${{ github.event.workflow_run.id }}")
    expect(source).not.toContain("--run-attempt=${{ github.event.workflow_run.run_attempt }}")
    expect(source).toContain("HEAD_SHA: ${{ github.event.workflow_run.head_sha }}")
    expect(source).toContain("WORKFLOW_RUN_ID: ${{ github.event.workflow_run.id }}")
    expect(source).toContain("RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}")
    expect(source).toContain('--expected-sha="$HEAD_SHA"')
    expect(source).toContain('--workflow-run-id="$WORKFLOW_RUN_ID"')
    expect(source).toContain('--run-attempt="$RUN_ATTEMPT"')
    expect(source).toContain("--github-token=env:GITHUB_TOKEN")
    expect(source).toContain("environment: production")
    expect(source).not.toMatch(/args:[\s\S]*\$\{\{ secrets\./)
  })

  test("shadow ingress is deleted only after its hosted checks are green", () => {
    expect(existsSync(resolve(root, ".github/workflows/dagger-shadow.yml"))).toBe(false)
    expect(existsSync(resolve(root, ".github/workflows/deploy-dagger-shadow.yml"))).toBe(false)
  })

  test("there is no repository-authored manual production deploy bypass", () => {
    expect(existsSync(resolve(root, "scripts/go-live-almamesh.sh"))).toBe(false)
    expect(workflowSource("deploy.yml")).not.toContain("workflow_dispatch")
  })
})
