import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { CI_GATES } from "../dagger/src/gates.ts"
import { JOURNEY_GATES, JOURNEY_LANES, journeyLaneOfGate } from "../dagger/src/journeyLanes.ts"

const root = resolve(import.meta.dir, "..")
const workflowPath = resolve(root, ".github/workflows/dagger.yml")
const deployWorkflowPath = resolve(root, ".github/workflows/deploy.yml")
const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
const daggerAction = "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77"
const expectedDeployFlags = [
  "--github-token",
  "--cloudflare-api-token",
  "--cloudflare-account-id",
  "--bundle-private-key-b-64",
  "--bundle-public-key-b-64",
  "--expected-sha",
  "--workflow-run-id",
  "--run-attempt",
  "--repository",
  "--trigger-workflow",
]

type Mapping = Record<string, unknown>

function mapping(value: unknown): Mapping {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Mapping
    : {}
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Mapping
    const rightRecord = right as Mapping
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    return sameValue(leftKeys, rightKeys)
      && leftKeys.every((key) => sameValue(leftRecord[key], rightRecord[key]))
  }
  return left === right
}

/** The GitHub job key for one Dagger gate: `browserChromium` -> `browser-chromium`. */
function gateJobKey(gate: string): string {
  return gate.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function isJourneyGate(gate: string): boolean {
  return (JOURNEY_GATES as readonly string[]).includes(gate)
}

function journeyLane(gate: string): string {
  return journeyLaneOfGate(gate)
}

function checkoutStep(): Mapping {
  return {
    uses: checkout,
    with: {
      "fetch-depth": 0,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    },
  }
}

function daggerStep(call: string): Mapping {
  return { uses: daggerAction, env: { XDG_CONFIG_HOME: "${{ github.workspace }}/.github/xdg" }, with: { version: "0.21.8", call } }
}

// The browser toolchain image is a private GHCR package, so every gate job may
// read packages and hands its GITHUB_TOKEN to the module as a typed Secret
// (`env:`), which Dagger never prints. The workflow keeps contents:read only.
const GATE_REGISTRY_TOKEN = "--registry-token=env:GITHUB_TOKEN"

const uploadAction = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"
const gateEnv = { XDG_CONFIG_HOME: "${{ github.workspace }}/.github/xdg", GITHUB_TOKEN: "${{ github.token }}" }

function expectedGateJob(gate: string): Mapping {
  if (isJourneyGate(gate)) return expectedJourneyStatusJob(journeyLane(gate))
  return {
    name: `gate / ${gate}`,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 60,
    permissions: { contents: "read", packages: "read" },
    steps: [
      checkoutStep(),
      {
        uses: daggerAction,
        env: gateEnv,
        with: {
          version: "0.21.8",
          call: `${GATE_REGISTRY_TOKEN} gate --name=${gate} --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }}`,
        },
      },
    ],
  }
}

// Fleet rule candidate-order / artifact-identity: an upload job is exactly
// checkout -> Dagger -> upload, its bytes bound to this SHA, kept one day. The
// journeys run once here; their original exit status rides in the receipt.
function expectedJourneyEvidenceJob(lane: string): Mapping {
  return {
  name: `evidence / browserJourneys${lane.toUpperCase()}`,
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 40,
  permissions: { contents: "read", packages: "read" },
  steps: [
    checkoutStep(),
    {
      uses: daggerAction,
      env: gateEnv,
      with: {
        version: "0.21.8",
        call: `${GATE_REGISTRY_TOKEN} browser-journeys-evidence --lane=${lane} --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }} export --path=candidate`,
      },
    },
    {
      uses: uploadAction,
      with: { name: `browser-journeys-evidence-${lane}-\${{ github.sha }}`, path: "candidate", "retention-days": 1, "if-no-files-found": "error" },
    },
  ],
  }
}

// The browserJourneys gate enforces that receipt in Dagger (fleet rule shell-step:
// no run steps). It runs even when the evidence job failed, and then fails closed.
function expectedJourneyStatusJob(lane: string): Mapping {
  return {
  name: `gate / browserJourneys${lane.toUpperCase()}`,
  needs: [`browser-journeys-${lane}-evidence`],
  if: "${{ !cancelled() }}",
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 20,
  permissions: { actions: "read", contents: "read" },
  steps: [
    checkoutStep(),
    {
      uses: daggerAction,
      env: gateEnv,
      with: {
        version: "0.21.8",
        call: `browser-journeys-status --lane=${lane} --github-token=env:GITHUB_TOKEN --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }} --run-id=\${{ github.run_id }}`,
      },
    },
  ],
  }
}

// The one required check. `!cancelled()` makes it run (and go red) when a gate
// job fails; without it a failed dependency SKIPS this job, and branch
// protection reads a skipped required check as passing.
const expectedAggregateJob: Mapping = {
  name: "Dagger",
  needs: CI_GATES.map(gateJobKey),
  if: "${{ !cancelled() }}",
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 20,
  steps: [checkoutStep(), daggerStep("verdict --results=\"${{ join(needs.*.result, ',') }}\"")],
}

function exactDaggerWorkflowViolations(source: string): string[] {
  const workflow = mapping(Bun.YAML.parse(source))
  const triggers = mapping(workflow.on)
  const jobs = mapping(workflow.jobs)
  const violations: string[] = []

  if (workflow.name !== "Dagger") violations.push("workflow-name")
  if (!sameValue(triggers, {
    push: { branches: ["main"] },
    pull_request: null,
  })) violations.push("triggers")
  if (!sameValue(workflow.permissions, { contents: "read" })) violations.push("permissions")
  if (!sameValue(workflow.concurrency, {
    group: "${{ github.workflow }}-${{ github.ref == 'refs/heads/main' && github.run_id || github.ref }}",
    "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}",
  })) violations.push("concurrency")
  const evidenceKeys = JOURNEY_LANES.map((lane) => `browser-journeys-${lane}-evidence`)
  if (!sameValue(Object.keys(jobs).sort(), [...CI_GATES.map(gateJobKey), ...evidenceKeys, "dagger"].sort())) violations.push("jobs")
  for (const lane of JOURNEY_LANES) {
    if (!sameValue(jobs[`browser-journeys-${lane}-evidence`], expectedJourneyEvidenceJob(lane))) violations.push(`journey-evidence-job:${lane}`)
  }
  for (const gate of CI_GATES) {
    if (!sameValue(jobs[gateJobKey(gate)], expectedGateJob(gate))) violations.push(`gate-job:${gate}`)
  }
  if (!sameValue(jobs.dagger, expectedAggregateJob)) violations.push("dagger-job")

  return violations
}

function deployArgumentFlags(source: string): string[] {
  const workflow = mapping(Bun.YAML.parse(source))
  const job = mapping(mapping(workflow.jobs).deploy)
  const steps = Array.isArray(job.steps) ? job.steps : []
  const daggerStep = steps.map(mapping).find((step) => step.uses === daggerAction)
  const args = mapping(daggerStep?.with).args
  if (typeof args !== "string") return []
  return args.split(/\s+/).filter((argument) => argument.startsWith("--"))
    .map((argument) => argument.split("=", 1)[0])
}

function exactDeployWorkflowViolations(source: string): string[] {
  const workflow = mapping(Bun.YAML.parse(source))
  const jobs = mapping(workflow.jobs)
  const job = mapping(jobs.deploy)
  const violations: string[] = []

  if (workflow.name !== "Deploy almamesh.com") violations.push("workflow-name")
  if (!source.includes("on: # zizmor: ignore[dangerous-triggers] deploy-after-CI by design; exact same-repo push/main/success attempt is revalidated before secrets or provider access")) {
    violations.push("dangerous-trigger-exemption")
  }
  if (!sameValue(mapping(workflow.on), {
    workflow_run: {
      workflows: ["Dagger", "Safari (macOS)"],
      types: ["completed"],
      branches: ["main"],
    },
  })) violations.push("triggers")
  if (!sameValue(workflow.permissions, {
    actions: "read",
    checks: "read",
    contents: "read",
    packages: "read",
  })) violations.push("permissions")
  if (!sameValue(workflow.concurrency, {
    group: "deploy-almamesh-com",
    "cancel-in-progress": false,
  })) violations.push("concurrency")
  if (!sameValue(Object.keys(jobs), ["deploy"])) violations.push("jobs")
  if (!sameValue(job, {
    name: "Build + deploy to Cloudflare Pages (Dagger)",
    if: "github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository",
    environment: "production",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 120,
    steps: [
      {
        uses: checkout,
        with: {
          "fetch-depth": 0,
          "persist-credentials": false,
          ref: "${{ github.event.workflow_run.head_sha }}",
        },
      },
      {
        uses: daggerAction,
        env: {
          BUNDLE_PRIVATE_KEY_B64: "${{ secrets.BUNDLE_PRIVATE_KEY_B64 }}",
          BUNDLE_PUBLIC_KEY_B64: "${{ secrets.BUNDLE_PUBLIC_KEY_B64 }}",
          CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
          CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
          GITHUB_TOKEN: "${{ github.token }}",
          HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
          RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}",
          TRIGGER_WORKFLOW: "${{ github.event.workflow_run.path }}",
          WORKFLOW_RUN_ID: "${{ github.event.workflow_run.id }}",
          XDG_CONFIG_HOME: "${{ github.workspace }}/.github/xdg",
        },
        with: {
          version: "0.21.8",
          verb: "call",
          args: "deploy --github-token=env:GITHUB_TOKEN --cloudflare-api-token=env:CLOUDFLARE_API_TOKEN --cloudflare-account-id=env:CLOUDFLARE_ACCOUNT_ID --bundle-private-key-b-64=env:BUNDLE_PRIVATE_KEY_B64 --bundle-public-key-b-64=env:BUNDLE_PUBLIC_KEY_B64 --expected-sha=\"$HEAD_SHA\" --workflow-run-id=\"$WORKFLOW_RUN_ID\" --run-attempt=\"$RUN_ATTEMPT\" --repository=\"$GITHUB_REPOSITORY\" --trigger-workflow=\"$TRIGGER_WORKFLOW\"",
        },
      },
    ],
  })) violations.push("deploy-job")

  return violations
}

const checkoutFixture = [
  `      - uses: ${checkout} # v7`,
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "          ref: ${{ github.sha }}",
]

function daggerFixture(call: string): string[] {
  return [
    `      - uses: ${daggerAction} # v8.4.1`,
    "        env:",
    "          XDG_CONFIG_HOME: ${{ github.workspace }}/.github/xdg",
    "          GITHUB_TOKEN: ${{ github.token }}",
    "        with:",
    "          version: \"0.21.8\"",
    `          call: ${call}`,
  ]
}

function journeyFixture(lane: string): string[] {
  const upper = lane.toUpperCase()
  return [
    `  browser-journeys-${lane}-evidence:`,
    `    name: evidence / browserJourneys${upper}`,
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 40",
    "    permissions:",
    "      contents: read",
    "      packages: read",
    "    steps:",
    ...checkoutFixture,
    ...daggerFixture(`${GATE_REGISTRY_TOKEN} browser-journeys-evidence --lane=${lane} --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }} export --path=candidate`),
    `      - uses: ${uploadAction} # v7.0.2`,
    "        with:",
    `          name: browser-journeys-evidence-${lane}-\${{ github.sha }}`,
    "          path: candidate",
    "          retention-days: 1",
    "          if-no-files-found: error",
    `  browser-journeys-${lane}:`,
    `    name: gate / browserJourneys${upper}`,
    `    needs: [browser-journeys-${lane}-evidence]`,
    "    if: ${{ !cancelled() }}",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 20",
    "    permissions:",
    "      actions: read",
    "      contents: read",
    "    steps:",
    ...checkoutFixture,
    ...daggerFixture(`browser-journeys-status --lane=${lane} --github-token=env:GITHUB_TOKEN --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }} --run-id=\${{ github.run_id }}`),
  ]
}

function gateJobFixture(gate: string): string[] {
  if (isJourneyGate(gate)) return journeyFixture(journeyLane(gate))
  return [
    `  ${gateJobKey(gate)}:`,
    `    name: gate / ${gate}`,
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 60",
    "    permissions:",
    "      contents: read",
    "      packages: read",
    "    steps:",
    ...checkoutFixture,
    ...daggerFixture(`${GATE_REGISTRY_TOKEN} gate --name=${gate} --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }}`),
  ]
}

const canonicalFixture = [
  "name: Dagger",
  "",
  "on:",
  "  push:",
  "    branches: [main]",
  "  pull_request:",
  "",
  "permissions:",
  "  contents: read",
  "",
  "concurrency:",
  "  group: ${{ github.workflow }}-${{ github.ref == 'refs/heads/main' && github.run_id || github.ref }}",
  "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  "",
  "jobs:",
  ...CI_GATES.flatMap(gateJobFixture),
  "  dagger:",
  "    name: Dagger",
  `    needs: [${CI_GATES.map(gateJobKey).join(", ")}]`,
  "    if: ${{ !cancelled() }}",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 20",
  "    steps:",
  `      - uses: ${checkout} # v7`,
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "          ref: ${{ github.sha }}",
  `      - uses: ${daggerAction} # v8.4.1`,
  "        env:",
  "          XDG_CONFIG_HOME: ${{ github.workspace }}/.github/xdg",
  "        with:",
  "          version: \"0.21.8\"",
  "          call: verdict --results=\"${{ join(needs.*.result, ',') }}\"",
  "",
].join("\n")

function mutateGateSteps(gate: string, mutate: (steps: Mapping[]) => void): string {
  const workflow = mapping(Bun.YAML.parse(canonicalFixture))
  const job = mapping(mapping(workflow.jobs)[gateJobKey(gate)])
  mutate(job.steps as Mapping[])
  return Bun.YAML.stringify(workflow)
}

const canonicalDeployFixture = [
  "name: Deploy almamesh.com",
  "",
  "on: # zizmor: ignore[dangerous-triggers] deploy-after-CI by design; exact same-repo push/main/success attempt is revalidated before secrets or provider access",
  "  workflow_run:",
  "    workflows: [\"Dagger\", \"Safari (macOS)\"]",
  "    types: [completed]",
  "    branches: [main]",
  "",
  "permissions:",
  "  actions: read",
  "  checks: read",
  "  contents: read",
  "  packages: read",
  "",
  "concurrency:",
  "  group: deploy-almamesh-com",
  "  cancel-in-progress: false",
  "",
  "jobs:",
  "  deploy:",
  "    name: Build + deploy to Cloudflare Pages (Dagger)",
  "    if: >-",
  "      github.event.workflow_run.event == 'push' &&",
  "      github.event.workflow_run.conclusion == 'success' &&",
  "      github.event.workflow_run.head_branch == 'main' &&",
  "      github.event.workflow_run.head_repository.full_name == github.repository",
  "    environment: production",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 120",
  "    steps:",
  `      - uses: ${checkout} # v7`,
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false",
  "          ref: ${{ github.event.workflow_run.head_sha }}",
  `      - uses: ${daggerAction} # v8.4.1`,
  "        env:",
  "          BUNDLE_PRIVATE_KEY_B64: ${{ secrets.BUNDLE_PRIVATE_KEY_B64 }}",
  "          BUNDLE_PUBLIC_KEY_B64: ${{ secrets.BUNDLE_PUBLIC_KEY_B64 }}",
  "          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
  "          GITHUB_TOKEN: ${{ github.token }}",
  "          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}",
  "          WORKFLOW_RUN_ID: ${{ github.event.workflow_run.id }}",
  "          RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}",
  "          TRIGGER_WORKFLOW: ${{ github.event.workflow_run.path }}",
  "          XDG_CONFIG_HOME: ${{ github.workspace }}/.github/xdg",
  "        with:",
  "          version: \"0.21.8\"",
  "          verb: call",
  "          args: >-",
  "            deploy",
  "            --github-token=env:GITHUB_TOKEN",
  "            --cloudflare-api-token=env:CLOUDFLARE_API_TOKEN",
  "            --cloudflare-account-id=env:CLOUDFLARE_ACCOUNT_ID",
  "            --bundle-private-key-b-64=env:BUNDLE_PRIVATE_KEY_B64",
  "            --bundle-public-key-b-64=env:BUNDLE_PUBLIC_KEY_B64",
  "            --expected-sha=\"$HEAD_SHA\"",
  "            --workflow-run-id=\"$WORKFLOW_RUN_ID\"",
  "            --run-attempt=\"$RUN_ATTEMPT\"",
  "            --repository=\"$GITHUB_REPOSITORY\"",
  "            --trigger-workflow=\"$TRIGGER_WORKFLOW\"",
  "",
].join("\n")

describe("atomic hosted Dagger workflow", () => {
  const verdictCall = "          call: verdict --results=\"${{ join(needs.*.result, ',') }}\"\n"
  const browserCall = "          call: --registry-token=env:GITHUB_TOKEN gate --name=browserChromium --commit-sha=${{ github.sha }} --repository=${{ github.repository }}\n"

  test("the committed workflow runs every Dagger gate as its own job under one required Dagger check", () => {
    const source = readFileSync(workflowPath, "utf8")
    expect(exactDaggerWorkflowViolations(source)).toEqual([])
  })

  test("the canonical fixture is itself clean", () => {
    expect(exactDaggerWorkflowViolations(canonicalFixture)).toEqual([])
  })

  function mutateJobSteps(job: string, mutate: (steps: Mapping[]) => void): string {
    const workflow = mapping(Bun.YAML.parse(canonicalFixture))
    mutate(mapping(mapping(workflow.jobs)[job]).steps as Mapping[])
    return Bun.YAML.stringify(workflow)
  }

  describe.each([...JOURNEY_LANES])("browser journey lane %s", (lane) => {
    const upper = lane.toUpperCase()
    test.each([
      ["a second browser execution", (steps: Mapping[]) => { steps.push(structuredClone(steps[1])) }],
      ["an export failure allowed to pass", (steps: Mapping[]) => { steps[1]["continue-on-error"] = true }],
      ["another artifact path", (steps: Mapping[]) => { (steps[2].with as Mapping).path = "." }],
      ["an artifact not bound to the SHA", (steps: Mapping[]) => { (steps[2].with as Mapping).name = `browser-journeys-evidence-${lane}` }],
      ["an artifact not bound to the lane", (steps: Mapping[]) => { (steps[2].with as Mapping).name = "browser-journeys-evidence-${{ github.sha }}" }],
      ["a lane that runs another lane's journeys", (steps: Mapping[]) => { (steps[1].with as Mapping).call = String((steps[1].with as Mapping).call).replace(`--lane=${lane}`, "--lane=other") }],
      ["a shell step before upload", (steps: Mapping[]) => { steps.splice(2, 0, { run: "true" }) }],
    ] as const)("rejects browser-journey evidence bypass: %s", (_name, mutate) => {
      expect(exactDaggerWorkflowViolations(mutateJobSteps(`browser-journeys-${lane}-evidence`, mutate))).toContain(`journey-evidence-job:${lane}`)
    })

    test.each([
      ["missing original-status enforcement", (steps: Mapping[]) => { steps.splice(1, 1) }],
      ["ignored original failure", (steps: Mapping[]) => { steps[1]["continue-on-error"] = true }],
      ["status bound to another run", (steps: Mapping[]) => { (steps[1].with as Mapping).call = `browser-journeys-status --lane=${lane} --github-token=env:GITHUB_TOKEN --commit-sha=\${{ github.sha }} --repository=\${{ github.repository }} --run-id=1` }],
      ["status reading another lane's receipt", (steps: Mapping[]) => { (steps[1].with as Mapping).call = String((steps[1].with as Mapping).call).replace(`--lane=${lane}`, "--lane=other") }],
      ["status enforced by shell", (steps: Mapping[]) => { steps[1] = { run: "node frontend/apps/web/scripts/browserJourneyStatusCheck.mjs" } }],
    ] as const)("rejects browser-journey status bypass: %s", (_name, mutate) => {
      expect(exactDaggerWorkflowViolations(mutateJobSteps(`browser-journeys-${lane}`, mutate))).toContain(`gate-job:browserJourneys${upper}`)
    })

    test("the gate still runs, and fails closed, when its evidence job failed", () => {
      const needs = `    needs: [browser-journeys-${lane}-evidence]\n`
      expect(exactDaggerWorkflowViolations(canonicalFixture.replace(`${needs}    if: \${{ !cancelled() }}\n`, needs))).toContain(`gate-job:browserJourneys${upper}`)
    })
  })

  test("no gate job runs a shell step (fleet rule shell-step)", () => {
    expect(exactDaggerWorkflowViolations(mutateGateSteps("backend", (steps) => { steps.splice(1, 0, { name: "Export public documentation paths", run: "python3 scripts/public_docs_manifest.py --repo-root . --output .almamesh-public-docs.json" }) }))).toContain("gate-job:backend")
  })

  test.each([
    {
      name: "a gate dropped from the aggregate's needs",
      source: canonicalFixture.replace(", browser-chromium,", ","),
      violation: "dagger-job",
    },
    {
      name: "an aggregate that is skipped when a gate fails",
      source: canonicalFixture.replace("    if: ${{ !cancelled() }}\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:", "    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:"),
      violation: "dagger-job",
    },
    {
      name: "an aggregate that ignores the gate results",
      source: canonicalFixture.replace(verdictCall, "          call: contracts\n"),
      violation: "dagger-job",
    },
    {
      name: "a gate job without the commit identity",
      source: canonicalFixture.replace(browserCall, "          call: gate --name=browserChromium\n"),
      violation: "gate-job:browserChromium",
    },
    {
      name: "a gate job that runs a different gate",
      source: canonicalFixture.replace(browserCall, browserCall.replace("browserChromium", "privacy")),
      violation: "gate-job:browserChromium",
    },
    {
      name: "a gate job that pulls the private toolchain without registry auth",
      source: canonicalFixture.replace(browserCall, browserCall.replace("--registry-token=env:GITHUB_TOKEN ", "")),
      violation: "gate-job:browserChromium",
    },
    {
      name: "a gate job whose token cannot read packages",
      source: canonicalFixture.replace(
        "    permissions:\n      contents: read\n      packages: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n          ref: ${{ github.sha }}\n      - uses: dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77 # v8.4.1\n        env:\n          XDG_CONFIG_HOME: ${{ github.workspace }}/.github/xdg\n          GITHUB_TOKEN: ${{ github.token }}\n        with:\n          version: \"0.21.8\"\n          call: --registry-token=env:GITHUB_TOKEN gate --name=secretScan",
        "    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n          ref: ${{ github.sha }}\n      - uses: dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77 # v8.4.1\n        env:\n          XDG_CONFIG_HOME: ${{ github.workspace }}/.github/xdg\n          GITHUB_TOKEN: ${{ github.token }}\n        with:\n          version: \"0.21.8\"\n          call: --registry-token=env:GITHUB_TOKEN gate --name=secretScan",
      ),
      violation: "gate-job:secretScan",
    },
    {
      name: "a gate job that pastes the token value into the bash-pasted call",
      source: canonicalFixture.replace(browserCall, browserCall.replace("env:GITHUB_TOKEN", "${{ github.token }}")),
      violation: "gate-job:browserChromium",
    },
    {
      name: "a missing gate job",
      source: canonicalFixture.replace(/  browser-wizards:\n(?: {4}.*\n| {6}.*\n| {8}.*\n| {10}.*\n)+/, ""),
      violation: "jobs",
    },
    {
      // Every main merge must finish so it can deploy; only superseded PR runs cancel.
      name: "main runs that cancel each other",
      source: canonicalFixture.replace(
        "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
        "  cancel-in-progress: true",
      ),
      violation: "concurrency",
    },
    {
      // One group per ref holds one pending run: a third stacked main merge
      // would cancel the pending second one. Main runs get a group each.
      name: "main runs sharing one concurrency group",
      source: canonicalFixture.replace(
        "  group: ${{ github.workflow }}-${{ github.ref == 'refs/heads/main' && github.run_id || github.ref }}",
        "  group: ${{ github.workflow }}-${{ github.ref }}",
      ),
      violation: "concurrency",
    },
    {
      name: "PR runs that never cancel superseded ones",
      source: canonicalFixture.replace(
        "  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
        "  cancel-in-progress: false",
      ),
      violation: "concurrency",
    },
    {
      name: "manual dispatch",
      source: canonicalFixture.replace("  pull_request:\n", "  pull_request:\n  workflow_dispatch:\n"),
      violation: "triggers",
    },
    {
      name: "extra module selection",
      source: canonicalFixture.replace(verdictCall, `          module: ./dagger\n${verdictCall}`),
      violation: "dagger-job",
    },
    {
      name: "permissive checkout ref",
      source: canonicalFixture.replace("          ref: ${{ github.sha }}", "          ref: refs/heads/main"),
      violation: "gate-job:secretScan",
    },
    {
      name: "renamed protected check",
      source: canonicalFixture.replace("    name: Dagger", "    name: CI"),
      violation: "dagger-job",
    },
    {
      name: "post-Dagger shell step",
      source: canonicalFixture.replace(verdictCall, `${verdictCall}      - run: dagger call deploy --help\n`),
      violation: "dagger-job",
    },
    {
      name: "pre-Dagger shell step",
      source: canonicalFixture.replace(
        `      - uses: ${daggerAction} # v8.4.1\n        env:\n          XDG_CONFIG_HOME: \${{ github.workspace }}/.github/xdg\n        with:\n          version: "0.21.8"\n${verdictCall}`,
        `      - run: dagger functions\n      - uses: ${daggerAction} # v8.4.1\n        env:\n          XDG_CONFIG_HOME: \${{ github.workspace }}/.github/xdg\n        with:\n          version: "0.21.8"\n${verdictCall}`,
      ),
      violation: "dagger-job",
    },
    {
      name: "post-Dagger action step in a gate job",
      source: canonicalFixture.replace(browserCall, `${browserCall}      - uses: actions/setup-node@v4\n`),
      violation: "gate-job:browserChromium",
    },
  ])("rejects $name", ({ source, violation }) => {
    expect(source).not.toBe(canonicalFixture)
    expect(exactDaggerWorkflowViolations(source)).toContain(violation)
  })
})

describe("privileged production delivery workflow", () => {
  test("the canonical production fixture is closed", () => {
    expect(exactDeployWorkflowViolations(canonicalDeployFixture)).toEqual([])
  })

  test("binds one same-repository green-main Dagger attempt to production", () => {
    const source = readFileSync(deployWorkflowPath, "utf8")
    expect(exactDeployWorkflowViolations(source)).toEqual([])
  })

  test("deploys wait on the lanes that represent real users, never on the macOS WebKit lane", () => {
    // Chromium and the rest of the product gates (Dagger) plus real Safari
    // (safaridriver) gate production. The macOS WebKit lane files crash issues.
    const deploy = readFileSync(deployWorkflowPath, "utf8")
    const acceptance = readFileSync(resolve(root, "dagger/src/nativeMacAcceptance.ts"), "utf8")
    const trigger = readFileSync(resolve(root, "dagger/src/deployTrigger.ts"), "utf8")
    for (const source of [deploy, acceptance, trigger]) {
      expect(source).not.toMatch(/WebKit \(macOS\)|webkit-macos/)
    }
    expect(acceptance).toContain('".github/workflows/safari-smoke.yml"')
    expect(acceptance).toContain('"safari / macOS smoke"')
  })

  test("the deploy workflow uses exactly the Dagger 0.21.8 typed flags", () => {
    const source = readFileSync(deployWorkflowPath, "utf8")
    expect(deployArgumentFlags(source)).toEqual(expectedDeployFlags)
  })

  test.each([
    [
      "legacy private-key spelling",
      canonicalDeployFixture.replace("private-key-b-64", ["private-key-b", "64"].join("")),
    ],
    ["missing run attempt", canonicalDeployFixture.replace(/\s+--run-attempt=\S+/, "")],

    ["unexpected argument", canonicalDeployFixture.replace("deploy\n", "deploy --project=almamesh\n")],
  ])("rejects %s in the static deploy flag contract", (_name, source) => {
    expect(deployArgumentFlags(source)).not.toEqual(expectedDeployFlags)
  })

  test.each([
    {
      name: "manual bypass",
      source: canonicalDeployFixture.replace(
        "  workflow_run:\n",
        "  workflow_dispatch:\n  workflow_run:\n",
      ),
      violation: "triggers",
    },
    {
      name: "fork authorization removed",
      source: canonicalDeployFixture.replace(
        "      github.event.workflow_run.head_repository.full_name == github.repository",
        "      true",
      ),
      violation: "deploy-job",
    },
    {
      name: "checks permission removed",
      source: canonicalDeployFixture.replace("  checks: read\n", ""),
      violation: "permissions",
    },
    {
      name: "GitHub token interpolated",
      source: canonicalDeployFixture.replace(
        "--github-token=env:GITHUB_TOKEN",
        "--github-token=${{ github.token }}",
      ),
      violation: "deploy-job",
    },
    {
      name: "an event expression pasted back into bash-pasted args (hseshadr/ci#50)",
      source: canonicalDeployFixture.replace(
        '--expected-sha="$HEAD_SHA"',
        "--expected-sha=${{ github.event.workflow_run.head_sha }}",
      ),
      violation: "deploy-job",
    },
    {
      name: "unquoted env reference",
      source: canonicalDeployFixture.replace('--expected-sha="$HEAD_SHA"', "--expected-sha=$HEAD_SHA"),
      violation: "deploy-job",
    },
    {
      name: "deploy workflow run id",
      source: canonicalDeployFixture.replace(
        "WORKFLOW_RUN_ID: ${{ github.event.workflow_run.id }}",
        "WORKFLOW_RUN_ID: ${{ github.run_id }}",
      ),
      violation: "deploy-job",
    },
    {
      name: "deploy workflow attempt",
      source: canonicalDeployFixture.replace(
        "RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}",
        "RUN_ATTEMPT: ${{ github.run_attempt }}",
      ),
      violation: "deploy-job",
    },
    {
      name: "legacy generated secret flag spelling",
      source: canonicalDeployFixture.replace(
        "--bundle-private-key-b-64=env:BUNDLE_PRIVATE_KEY_B64",
        "--bundle-private-key-b64=env:BUNDLE_PRIVATE_KEY_B64",
      ),
      violation: "deploy-job",
    },
    {
      name: "terminal deploy subcommand",
      source: canonicalDeployFixture.replace(
        '--run-attempt="$RUN_ATTEMPT"',
        '--run-attempt="$RUN_ATTEMPT" sync',
      ),
      violation: "deploy-job",
    },
    {
      name: "the Safari (macOS) re-trigger removed",
      source: canonicalDeployFixture.replace('["Dagger", "Safari (macOS)"]', '["Dagger"]'),
      violation: "triggers",
    },
    {
      // The macOS WebKit lane reports crashes as issues; it never gates a deploy.
      name: "the macOS WebKit lane re-added as a deploy gate",
      source: canonicalDeployFixture.replace('["Dagger", "Safari (macOS)"]', '["Dagger", "Safari (macOS)", "WebKit (macOS)"]'),
      violation: "triggers",
    },
    {
      name: "an unrelated workflow added as a trigger",
      source: canonicalDeployFixture.replace('["Dagger", "Safari (macOS)"]', '["Dagger", "Safari (macOS)", "Nightly E2E"]'),
      violation: "triggers",
    },
    {
      name: "trigger workflow taken from the run name instead of its path",
      source: canonicalDeployFixture.replace(
        "TRIGGER_WORKFLOW: ${{ github.event.workflow_run.path }}",
        "TRIGGER_WORKFLOW: ${{ github.event.workflow_run.name }}",
      ),
      violation: "deploy-job",
    },
    {
      name: "canceling mutex",
      source: canonicalDeployFixture.replace(
        "  cancel-in-progress: false",
        "  cancel-in-progress: true",
      ),
      violation: "concurrency",
    },
    {
      name: "no production environment",
      source: canonicalDeployFixture.replace("    environment: production\n", ""),
      violation: "deploy-job",
    },
  ])("rejects $name", ({ source, violation }) => {
    expect(source).not.toBe(canonicalDeployFixture)
    expect(exactDeployWorkflowViolations(source)).toContain(violation)
  })
})
