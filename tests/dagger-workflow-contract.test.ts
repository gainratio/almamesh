import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { CI_GATES } from "../dagger/src/gates.ts"

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
  return { uses: daggerAction, with: { version: "0.21.8", call } }
}

function expectedGateJob(gate: string): Mapping {
  return {
    name: `gate / ${gate}`,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 60,
    steps: [checkoutStep(), daggerStep(`gate --name=${gate} --commit-sha=\${{ github.sha }}`)],
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
    group: "${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  })) violations.push("concurrency")
  if (!sameValue(Object.keys(jobs).sort(), [...CI_GATES.map(gateJobKey), "dagger"].sort())) violations.push("jobs")
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
      workflows: ["Dagger"],
      types: ["completed"],
      branches: ["main"],
    },
  })) violations.push("triggers")
  if (!sameValue(workflow.permissions, {
    actions: "read",
    checks: "read",
    contents: "read",
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
          WORKFLOW_RUN_ID: "${{ github.event.workflow_run.id }}",
        },
        with: {
          version: "0.21.8",
          verb: "call",
          args: "deploy --github-token=env:GITHUB_TOKEN --cloudflare-api-token=env:CLOUDFLARE_API_TOKEN --cloudflare-account-id=env:CLOUDFLARE_ACCOUNT_ID --bundle-private-key-b-64=env:BUNDLE_PRIVATE_KEY_B64 --bundle-public-key-b-64=env:BUNDLE_PUBLIC_KEY_B64 --expected-sha=\"$HEAD_SHA\" --workflow-run-id=\"$WORKFLOW_RUN_ID\" --run-attempt=\"$RUN_ATTEMPT\"",
        },
      },
    ],
  })) violations.push("deploy-job")

  return violations
}

function gateJobFixture(gate: string): string[] {
  return [
    `  ${gateJobKey(gate)}:`,
    `    name: gate / ${gate}`,
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 60",
    "    steps:",
    `      - uses: ${checkout} # v7`,
    "        with:",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    "          ref: ${{ github.sha }}",
    `      - uses: ${daggerAction} # v8.4.1`,
    "        with:",
    "          version: \"0.21.8\"",
    `          call: gate --name=${gate} --commit-sha=\${{ github.sha }}`,
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
  "  group: ${{ github.workflow }}-${{ github.ref }}",
  "  cancel-in-progress: true",
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
  "        with:",
  "          version: \"0.21.8\"",
  "          call: verdict --results=\"${{ join(needs.*.result, ',') }}\"",
  "",
].join("\n")

const canonicalDeployFixture = [
  "name: Deploy almamesh.com",
  "",
  "on: # zizmor: ignore[dangerous-triggers] deploy-after-CI by design; exact same-repo push/main/success attempt is revalidated before secrets or provider access",
  "  workflow_run:",
  "    workflows: [\"Dagger\"]",
  "    types: [completed]",
  "    branches: [main]",
  "",
  "permissions:",
  "  actions: read",
  "  checks: read",
  "  contents: read",
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
  "",
].join("\n")

describe("atomic hosted Dagger workflow", () => {
  const verdictCall = "          call: verdict --results=\"${{ join(needs.*.result, ',') }}\"\n"
  const browserCall = "          call: gate --name=browserChromium --commit-sha=${{ github.sha }}\n"

  test("the committed workflow runs every Dagger gate as its own job under one required Dagger check", () => {
    const source = readFileSync(workflowPath, "utf8")
    expect(exactDaggerWorkflowViolations(source)).toEqual([])
  })

  test("the canonical fixture is itself clean", () => {
    expect(exactDaggerWorkflowViolations(canonicalFixture)).toEqual([])
  })

  test.each([
    {
      name: "a gate dropped from the aggregate's needs",
      source: canonicalFixture.replace(", browser-chromium,", ","),
      violation: "dagger-job",
    },
    {
      name: "an aggregate that is skipped when a gate fails",
      source: canonicalFixture.replace("    if: ${{ !cancelled() }}\n", ""),
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
      name: "a missing gate job",
      source: canonicalFixture.replace(/  browser-wizards:\n(?: {4}.*\n| {6}.*\n| {8}.*\n| {10}.*\n)+/, ""),
      violation: "jobs",
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
        `      - uses: ${daggerAction} # v8.4.1\n        with:\n          version: "0.21.8"\n${verdictCall}`,
        `      - run: dagger functions\n      - uses: ${daggerAction} # v8.4.1\n        with:\n          version: "0.21.8"\n${verdictCall}`,
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
