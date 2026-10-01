import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import {
  LOCAL_OPT_IN_REAL_TESTS,
  NIGHTLY_REAL_SECRET,
  nightlyRealSkipCheckScript,
} from "../dagger/src/nightlyRealSkips.ts"

// Fixtures mirror the exact shape Playwright 1.63's JSON reporter writes for an
// in-body `test.skip(!KEY, reason)` (captured from a real run): the skip shows
// up as test.status "skipped" plus a { type: "skip", description } annotation.
type Spec = { title: string; status: "expected" | "skipped" | "unexpected"; reason?: string }

const KEY_REASON = "OPENROUTER_API_KEY not set"
const OLLAMA_TITLE = "[real] interpretation renders against a live local Ollama model"

function report(specs: Spec[]): object {
  const toSpec = ({ title, status, reason }: Spec) => ({
    title,
    tests: [{
      status,
      annotations: reason ? [{ type: "skip", description: reason }] : [],
      results: [{ status: status === "expected" ? "passed" : status === "skipped" ? "skipped" : "failed" }],
    }],
  })
  return {
    config: {},
    errors: [],
    suites: [{ title: "x.spec.ts", specs: [], suites: [{ title: "group", specs: specs.map(toSpec), suites: [] }] }],
  }
}

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function reportsDir(reports: Record<string, object | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nightly-reports-"))
  dirs.push(dir)
  for (const [name, body] of Object.entries(reports)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body))
  }
  return dir
}

function runCheck(dir: string): { status: number | null; out: string; err: string } {
  const run = spawnSync("bun", ["-e", nightlyRealSkipCheckScript(dir)], { encoding: "utf8" })
  return { status: run.status, out: run.stdout, err: run.stderr }
}

describe("nightly fails when a [real] spec skips itself", () => {
  test("pins the secret name and the one local opt-in exemption", () => {
    expect(NIGHTLY_REAL_SECRET).toBe("OPENROUTER_API_KEY")
    expect(LOCAL_OPT_IN_REAL_TESTS).toEqual([OLLAMA_TITLE])
  })

  test("a [real] spec skipped for a missing key exits 1 and names the secret", () => {
    const dir = reportsDir({
      "chat-rag-real.json": report([
        { title: "[real] chat: single-pass streaming", status: "skipped", reason: KEY_REASON },
      ]),
    })
    const run = runCheck(dir)
    expect(run.status).toBe(1)
    expect(run.err).toContain("[real] chat: single-pass streaming")
    expect(run.err).toContain("OPENROUTER_API_KEY")
    expect(run.err).toContain("repository secret")
  })

  test("an untitled spec that skips on the missing key also fails", () => {
    const dir = reportsDir({
      "dual-voice.json": report([
        { title: "B+C: dual-voice summary toggle", status: "skipped", reason: KEY_REASON },
      ]),
    })
    expect(runCheck(dir).status).toBe(1)
  })

  test("all passed exits 0 and reports the count", () => {
    const dir = reportsDir({
      "interp-real.json": report([
        { title: "[real] interpretation renders against live OpenRouter", status: "expected" },
        { title: "plain e2e", status: "expected" },
      ]),
    })
    const run = runCheck(dir)
    expect(run.status).toBe(0)
    expect(run.out).toContain("1 [real] test(s) ran")
  })

  test("the local Ollama opt-in may skip without failing the nightly", () => {
    const dir = reportsDir({
      "interp-real.json": report([
        { title: OLLAMA_TITLE, status: "skipped", reason: "gemma3:4b unavailable" },
        { title: "[real] interpretation renders against live OpenRouter", status: "expected" },
      ]),
    })
    expect(runCheck(dir).status).toBe(0)
  })

  test("a non-real skip for an unrelated reason does not fail", () => {
    const dir = reportsDir({
      "plain.json": report([
        { title: "[real] ran", status: "expected" },
        { title: "webkit only", status: "skipped", reason: "chromium project" },
      ]),
    })
    expect(runCheck(dir).status).toBe(0)
  })

  test("zero [real] tests executed fails closed", () => {
    const dir = reportsDir({ "plain.json": report([{ title: "plain e2e", status: "expected" }]) })
    const run = runCheck(dir)
    expect(run.status).toBe(1)
    expect(run.err).toContain("no [real] test ran")
  })

  test("an empty or missing reports directory fails closed", () => {
    expect(runCheck(reportsDir({})).status).toBe(1)
    const missing = join(reportsDir({}), "absent")
    expect(runCheck(missing).status).toBe(1)
  })

  test("an unparseable report fails closed", () => {
    // Regression: under `bun -e` a JSON.parse throw inside a callback exited 0.
    const run = runCheck(reportsDir({ "broken.json": "{not json" }))
    expect(run.status).toBe(1)
    expect(run.err).toContain("unreadable report")
  })

  test("the nightly function runs the check after every key-dependent suite, and nothing else does", () => {
    const source = readFileSync(resolve(import.meta.dir, "../dagger/src/index.ts"), "utf8")
    const nightly = source.slice(source.indexOf("  nightly(openrouterApiKey"), source.indexOf("  private publicSource("))
    expect(nightly).toContain('.withExec(["bun", "-e", nightlyRealSkipCheckScript(NIGHTLY_REPORTS_DIR)])')
    expect(nightly).toContain('"--reporter=list,json"')
    expect(nightly).toContain("PLAYWRIGHT_JSON_OUTPUT_FILE")
    for (const suite of ["dual-voice", "interp:real", "interp:heal:real", "chat:rag:real", "dashboard:agentic:real", "timeline:real"]) {
      expect(source).toContain(`  "${suite}",\n`)
      expect(nightly).not.toContain(`"test:e2e:${suite}"]`)
    }
    expect(source.split("nightlyRealSkipCheckScript(").length - 1).toBe(1)
    const prWorkflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/dagger.yml"), "utf8")
    expect(prWorkflow).not.toContain("nightly")
  })

  test("non-json files in the directory are ignored", () => {
    const dir = reportsDir({
      "real.json": report([{ title: "[real] ran", status: "expected" }]),
      "notes.txt": "ignore me",
    })
    mkdirSync(join(dir, "subdir"))
    expect(runCheck(dir).status).toBe(0)
  })
})
