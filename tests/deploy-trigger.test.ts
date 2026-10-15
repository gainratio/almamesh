import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  bindDeployTrigger,
  daggerAttemptScript,
  liveCommitScript,
  parseDaggerAttempt,
  parseDeployTrigger,
  parseLiveCommit,
  type DaggerAttempt,
} from "../dagger/src/deployTrigger.ts"

const repository = "gainratio/almamesh"
const sha = "d".repeat(40)
const otherSha = "e".repeat(40)
const token = "PRIVATE-GITHUB-TOKEN-never-print"
const triggerAttempt = { workflowRunId: "900", runAttempt: 2 }

function port(live: string | null, attempt: DaggerAttempt) {
  const calls: string[] = []
  return {
    calls,
    port: {
      liveCommit: async () => { calls.push("live"); return live },
      daggerAttempt: async () => { calls.push("dagger"); return attempt },
    },
  }
}

describe("deploy trigger binding", () => {
  test("only the Dagger and Safari (macOS) workflow paths may trigger production", () => {
    expect(parseDeployTrigger(".github/workflows/dagger.yml")).toBe("dagger")
    expect(parseDeployTrigger(".github/workflows/safari-smoke.yml")).toBe("safari")
    // The macOS WebKit lane reports crashes as issues; it never gates a deploy.
    for (const path of [".github/workflows/webkit-macos.yml", "Dagger", ".github/workflows/nightly-e2e.yml", "", "toString", "__proto__"]) {
      expect(() => parseDeployTrigger(path)).toThrow("not allowed")
    }
  })

  test("a Dagger completion binds exactly its own attempt", async () => {
    const { port: p, calls } = port(otherSha, { state: "red" })
    expect(await bindDeployTrigger(p, "dagger", sha, triggerAttempt)).toEqual(triggerAttempt)
    expect(calls).toEqual(["live"])
  })

  test("a Safari rerun binds the newest green Dagger attempt, never its own run id", async () => {
    const { port: p } = port(otherSha, { state: "green", workflowRunId: "781", runAttempt: 3 })
    expect(await bindDeployTrigger(p, "safari", sha, triggerAttempt)).toEqual({ workflowRunId: "781", runAttempt: 3 })
  })

  test("a Safari completion skips while Dagger is still running: the Dagger completion deploys", async () => {
    const { port: p } = port(otherSha, { state: "pending" })
    expect(await bindDeployTrigger(p, "safari", sha, triggerAttempt)).toEqual({
      skip: `SKIP ${sha}: Dagger is still running; its completion deploys this commit`,
    })
  })

  test("a Safari completion skips when the newest Dagger attempt is red", async () => {
    const { port: p } = port(null, { state: "red" })
    expect(await bindDeployTrigger(p, "safari", sha, triggerAttempt)).toEqual({
      skip: `SKIP ${sha}: the newest Dagger attempt is not green; nothing to deploy`,
    })
  })

  test.each(["dagger", "safari"] as const)("a %s completion never redeploys a SHA production already serves", async (trigger) => {
    const { port: p, calls } = port(sha, { state: "green", workflowRunId: "781", runAttempt: 3 })
    expect(await bindDeployTrigger(p, trigger, sha, triggerAttempt)).toEqual({
      skip: `SKIP ${sha}: production already serves this commit`,
    })
    expect(calls).toEqual(["live"])
  })

  test("an unreadable live identity does not block a deploy", async () => {
    const { port: p } = port(null, { state: "green", workflowRunId: "781", runAttempt: 3 })
    expect(await bindDeployTrigger(p, "safari", sha, triggerAttempt)).toEqual({ workflowRunId: "781", runAttempt: 3 })
  })

  test("the Dagger deploy function routes every delivery through the bound attempt", () => {
    const source = readFileSync(resolve(import.meta.dir, "../dagger/src/index.ts"), "utf8")
    const deploy = source.slice(source.indexOf("  async deploy("), source.indexOf("  verifyLive(expectedSha"))
    expect(deploy).toContain("parseDeployTrigger(triggerWorkflow)")
    expect(deploy).toContain('if ("skip" in bound) return bound.skip')
    expect(deploy).toContain("expectedSha, bound.workflowRunId, bound.runAttempt, CENTRAL_MODULE_SHA")
  })
})

describe("Dagger attempt receipt", () => {
  test("parses only closed receipts", () => {
    expect(parseDaggerAttempt('{"state":"green","runId":781,"runAttempt":3}')).toEqual({ state: "green", workflowRunId: "781", runAttempt: 3 })
    expect(parseDaggerAttempt('{"state":"pending"}')).toEqual({ state: "pending" })
    expect(parseDaggerAttempt('{"state":"red"}')).toEqual({ state: "red" })
    for (const bad of ['{"state":"green","runId":0,"runAttempt":1}', '{"state":"green","runId":"781","runAttempt":1}', '{"state":"done"}', "[]", "null", "PRIVATE"]) {
      expect(() => parseDaggerAttempt(bad)).toThrow()
    }
  })
})

function daggerRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 781, run_attempt: 3, name: "Dagger", path: ".github/workflows/dagger.yml", head_sha: sha,
    head_branch: "main", event: "push", status: "completed", conclusion: "success",
    repository: { full_name: repository }, head_repository: { full_name: repository }, ...overrides,
  }
}

function runScript(script: string, fixture: { status?: number; body?: unknown; contentType?: string }) {
  const harness = `
const fixture = ${JSON.stringify(fixture)};
globalThis.fetch = async (url, options = {}) => {
  console.log("TEST_REQUEST=" + JSON.stringify({ url: String(url), authorized: options.headers?.Authorization === ${JSON.stringify(`Bearer ${token}`)} }));
  const status = fixture.status ?? 200;
  return { ok: status >= 200 && status < 300, status,
    headers: { get: () => fixture.contentType ?? "application/json" },
    json: async () => fixture.body, text: async () => "PRIVATE API body" };
};
${script}
`
  const child = spawnSync("node", ["--eval", harness], { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: token }, timeout: 10_000 })
  const lines = child.stdout.trim().split("\n")
  const request = lines.find((line) => line.startsWith("TEST_REQUEST="))
  return {
    ...child,
    request: request ? JSON.parse(request.slice("TEST_REQUEST=".length)) : undefined,
    receipt: lines.find((line) => line.startsWith("{")),
  }
}

describe("Dagger attempt lookup script", () => {
  const listing = (runs: unknown[]) => ({ body: { total_count: runs.length, workflow_runs: runs } })

  test("asks for this SHA's main push runs and reports the newest green attempt", () => {
    const result = runScript(daggerAttemptScript(repository, sha), listing([daggerRun({ id: 700, conclusion: "failure" }), daggerRun()]))
    expect(result.status, result.stderr).toBe(0)
    expect(result.request).toEqual({
      url: `https://api.github.com/repos/${repository}/actions/workflows/dagger.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100&page=1`,
      authorized: true,
    })
    expect(parseDaggerAttempt(result.receipt!)).toEqual({ state: "green", workflowRunId: "781", runAttempt: 3 })
  })

  test.each([
    ["no run yet", [], { state: "pending" }],
    ["the newest attempt still running", [daggerRun({ status: "in_progress", conclusion: null })], { state: "pending" }],
    ["the newest attempt red after an older green", [daggerRun({ id: 700 }), daggerRun({ id: 800, conclusion: "failure" })], { state: "red" }],
  ])("reports %s", (_name, runs, expected) => {
    const result = runScript(daggerAttemptScript(repository, sha), listing(runs))
    expect(result.status, result.stderr).toBe(0)
    expect(parseDaggerAttempt(result.receipt!)).toEqual(expected as DaggerAttempt)
  })

  test.each([
    ["another commit", { head_sha: otherSha }],
    ["a pull request run", { event: "pull_request" }],
    ["another branch", { head_branch: "feature" }],
    ["a fork", { head_repository: { full_name: "fork/almamesh" } }],
    ["another workflow", { path: ".github/workflows/webkit-macos.yml" }],
  ])("fails closed on %s without printing the API body or token", (_name, overrides) => {
    const result = runScript(daggerAttemptScript(repository, sha), listing([daggerRun(overrides)]))
    expect(result.status).toBe(1)
    expect(result.receipt).toBeUndefined()
    expect(result.stdout + result.stderr).not.toContain("PRIVATE")
    expect(result.stderr).toBe("Dagger attempt lookup failed.\n")
  })

  test("fails closed on an API error", () => {
    expect(runScript(daggerAttemptScript(repository, sha), { status: 403, body: {} }).status).toBe(1)
  })

  test("refuses a foreign repository or a short SHA before any request", () => {
    expect(() => daggerAttemptScript("someone/else", sha)).toThrow()
    expect(() => daggerAttemptScript(repository, "abc")).toThrow()
  })
})

describe("live commit script", () => {
  test("reads the commit from the JSON build identity", () => {
    const result = runScript(liveCommitScript("https://almamesh.com"), { body: { commit: sha } })
    expect(result.request.url).toStartWith("https://almamesh.com/build.json?t=")
    expect(parseLiveCommit(result.receipt!)).toBe(sha)
  })

  test("an SPA fallback page or an error is unknown, never a match", () => {
    expect(parseLiveCommit(runScript(liveCommitScript("https://almamesh.com"), { body: { commit: sha }, contentType: "text/html" }).receipt!)).toBeNull()
    expect(parseLiveCommit(runScript(liveCommitScript("https://almamesh.com"), { status: 500, body: { commit: sha } }).receipt!)).toBeNull()
    expect(parseLiveCommit("PRIVATE")).toBeNull()
  })
})
