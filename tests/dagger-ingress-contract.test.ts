import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

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

function ingressViolations(ingressSteps: Array<Record<string, unknown>>): string[] {
  const expectedUses = [checkout, daggerAction]
  const violations: string[] = []

  if (ingressSteps.length !== expectedUses.length) violations.push("step-count")
  if (JSON.stringify(ingressSteps.map((step) => step.uses)) !== JSON.stringify(expectedUses)) {
    violations.push("step-order")
  }
  if (ingressSteps.some((step) => "run" in step)) {
    violations.push("unexpected-run")
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
  for (const job of Object.values(jobs)) expect(ingressViolations(job.steps)).toEqual([])
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
  "astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9",
  UPLOAD_ARTIFACT,
]
const MACOS_LANE_EVIDENCE = "frontend/apps/web/webkit-lane-artifacts"
const UPLOAD_INPUTS = new Set(["name", "path", "retention-days", "if-no-files-found", "include-hidden-files"])
const LANE_RUN = "bash scripts/webkit-macos-lane.sh"
/**
 * The content check on what the lane is about to upload
 * (frontend/apps/web/scripts/artifactLeakScan.mjs): every non-public
 * environment value and the contents of ~/.gitconfig and ~/.netrc. It runs
 * after the lane, pass or fail, and the upload runs only if it passed; on a
 * match it has already deleted the directory.
 */
const LEAK_SCAN_RUN = "node scripts/artifactLeakScan.mjs webkit-lane-artifacts"
const LEAK_SCAN_ID = "leak-scan"
const UPLOAD_IF = `always() && steps.${LEAK_SCAN_ID}.outcome == 'success'`

function leakScanViolations(jobSteps: Array<Record<string, unknown>>): string[] {
  const scans = jobSteps.filter((step) => String(step.run ?? "").trim() === LEAK_SCAN_RUN)
  if (scans.length !== 1) return ["leak-scan-count"]
  const scan = scans[0] as Record<string, unknown>
  const at = jobSteps.indexOf(scan)
  const violations: string[] = []
  if (scan.id !== LEAK_SCAN_ID) violations.push("leak-scan-id")
  if (scan.if !== "always()") violations.push("leak-scan-not-always")
  if ("continue-on-error" in scan) violations.push("leak-scan-continue-on-error")
  if (at < jobSteps.findIndex((step) => String(step.run ?? "").trim() === LANE_RUN)) violations.push("leak-scan-before-lane")
  if (jobSteps[at + 1]?.uses !== UPLOAD_ARTIFACT) violations.push("leak-scan-not-just-before-upload")
  return violations
}

function evidenceUploadViolations(jobSteps: Array<Record<string, unknown>>): string[] {
  const uploads = jobSteps.filter((step) => step.uses === UPLOAD_ARTIFACT)
  if (uploads.length !== 1) return ["evidence-upload-count"]
  const upload = uploads[0] as Record<string, unknown>
  const inputs = (upload.with ?? {}) as Record<string, unknown>
  const violations: string[] = [...leakScanViolations(jobSteps)]
  if (upload.if !== UPLOAD_IF) violations.push("evidence-upload-not-gated-on-leak-scan")
  if (inputs.path !== MACOS_LANE_EVIDENCE) violations.push("evidence-upload-path")
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
  return { ...parsed, jobs: Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, mutate(job)])) }
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
  'rm -rf "${ARTIFACTS}"',
  'mkdir -p "${ARTIFACTS}/crash-reports"',
  'touch "${ARTIFACTS}/.lane-start"',
  '{ sw_vers; sysctl hw.memsize hw.ncpu hw.model; } > "${ARTIFACTS}/machine.txt" 2>&1 || true',
  'done ) > "${ARTIFACTS}/system-memory.log" 2>&1 &',
  'find "${dir}" -newer "${ARTIFACTS}/.lane-start" -type f 2>/dev/null | while read -r report; do',
  'cp "${report}" "${ARTIFACTS}/crash-reports/" || true',
  '> "${ARTIFACTS}/unified-log.txt" 2>&1 || true',
  'echo "unified log: $(wc -l < "${ARTIFACTS}/unified-log.txt") lines about WebContent, memory kills and jetsam"',
  `grep -iE 'memorystatus.*kill|exceed|crash|terminat' "\${ARTIFACTS}/unified-log.txt" | grep -v 'coalition roles' | head -40 || true`,
  'TIME_TRAVEL_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:time-travel --project=webkit --project=iphone-webkit --retries=0 --output="${ARTIFACTS}/time-travel" || status=1',
  'PORTABLE_INVARIANTS_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0 --output="${ARTIFACTS}/portable-invariants" || status=1',
  'BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:boot-retry --project=webkit --retries=0 --output="${ARTIFACTS}/boot-retry" || status=1',
  `grep -rh "page crashed" "\${ARTIFACTS}" --include='*-browser.log' || true`,
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
    if (copy !== null && copy[1]?.trim() !== '"${report}"') violations.push(`artifacts-copy-source: ${line}`)
  }
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
  const jobs = Object.values(parsed.jobs as Record<string, Record<string, unknown>>)
  if (JSON.stringify(parsed.permissions) !== JSON.stringify({ contents: "read" })) violations.push("workflow-permissions")
  if (jobs.length !== 1) violations.push("job-count")
  for (const job of jobs) {
    if (typeof job["runs-on"] !== "string" || !/^macos-\d+$/.test(job["runs-on"] as string)) violations.push("runner-not-pinned-macos")
    if (typeof job["timeout-minutes"] !== "number" || (job["timeout-minutes"] as number) > 45) violations.push("timeout")
    if ("permissions" in job) violations.push("job-permissions")
    const jobSteps = job.steps as Array<Record<string, unknown>>
    if (jobSteps.some((step) => "uses" in step && !PINNED_ACTION.test(String(step.uses)))) violations.push("unpinned-action")
    const actions = jobSteps.filter((step) => "uses" in step).map((step) => String(step.uses))
    if (JSON.stringify(actions) !== JSON.stringify(MACOS_LANE_ACTIONS)) violations.push("actions")
    violations.push(...evidenceUploadViolations(jobSteps))
    const runs = jobSteps.filter((step) => "run" in step).map((step) => String(step.run).trim())
    if (JSON.stringify(runs) !== JSON.stringify(["bun install --frozen-lockfile", LANE_RUN, LEAK_SCAN_RUN])) {
      violations.push("run-steps")
    }
  }
  if (SECRETS_ACCESS.test(JSON.stringify(parsed))) violations.push("secrets")
  const events = eventsOf(parsed)
  if (events.length === 0 || events.some((event) => !MACOS_LANE_EVENTS.has(event))) violations.push("events")
  for (const job of jobs) {
    const checkouts = (job.steps as Array<Record<string, unknown>>).filter((step) => step.uses === checkout)
    const persists = checkouts.map((step) => ((step.with ?? {}) as Record<string, unknown>)["persist-credentials"])
    if (checkouts.length !== 1 || persists[0] !== false) violations.push("persist-credentials")
  }
  return violations
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

  test("every repository-authored CI/CD workflow only checks out and invokes Dagger", () => {
    for (const name of [
      "dagger.yml",
      "security-audit.yml",
      "nightly-e2e.yml",
      "deploy.yml",
      "live-probe.yml",
    ]) expectThinDaggerIngress(name)
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
    for (const name of Object.keys(NATIVE_MACOS_LANES)) expect(macosLaneViolations(workflow(name))).toEqual([])
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
    // No retries: a WebKit page that crashes once must turn the lane red, not pass on retry.
    expect(script).toContain("bun run test:e2e:time-travel --project=webkit --project=iphone-webkit --retries=0")
    expect(script).toContain("bun run test:e2e:portable-invariants --project=webkit --project=iphone-webkit --retries=0")
    expect(script).not.toMatch(/--retries=[1-9]/)
    for (const config of ["playwright.time-travel.config.ts", "playwright.portable-invariants.config.ts"]) {
      const source = readFileSync(resolve(root, "frontend/apps/web", config), "utf8")
      expect(source).toContain('name: "webkit", use: { ...devices["Desktop Safari"]')
      expect(source).toContain('name: "iphone-webkit", use: { ...devices["iPhone 13"]')
    }
  })

  test("the macOS lane drives the one automatic boot retry on WebKit against the hooked preview", () => {
    const script = readFileSync(resolve(root, MACOS_LANE_SCRIPT), "utf8")
    // The fault switch exists only in the hooks build the lane already serves.
    expect(script).toContain('BOOT_RETRY_E2E_BASE_URL="${BASE_URL}" bun run test:e2e:boot-retry --project=webkit --retries=0')
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
