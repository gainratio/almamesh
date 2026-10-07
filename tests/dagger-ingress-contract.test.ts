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

  test("Dagger is the only pull-request and push ingress", () => {
    expect(gatingIngresses(workflowNames())).toEqual(["dagger.yml"])
    expect(existsSync(resolve(root, ".github/workflows/test.yml"))).toBe(false)
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
