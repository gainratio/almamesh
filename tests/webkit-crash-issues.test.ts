import { describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import {
  fileCrashIssues,
  githubIssuesPort,
  parseCrashOutputs,
  type CrashIssue,
  type IssuesPort,
} from "../dagger/src/webkitCrashIssues.ts"

const run = { runUrl: "https://github.com/gainratio/almamesh/actions/runs/123", date: "2026-10-14" }
const SIGSEGV_KEY = "WebCore: Worker | SIGSEGV | JSC::JSWebAssemblyArray::visitChildren"
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function signature(key = SIGSEGV_KEY, lane = "travel", frames = ["JavaScriptCore JSC::JSWebAssemblyArray::visitChildren(JSC::JSCell*, JSC::AbstractSlotVisitor&)"]) {
  return { key, lane, process: "com.apple.WebKit.WebContent.Development", exception: "EXC_BAD_ACCESS SIGSEGV", frames }
}

/** `toJSON(needs.*.outputs.crashes)`: one JSON string per lane, empty when a lane wrote nothing. */
function outputs(...lanes: unknown[][]): string {
  return JSON.stringify([...lanes.map((lane) => JSON.stringify(lane)), ""])
}

function fakePort(existing: CrashIssue[] = []) {
  const calls: string[] = []
  const bodies: string[] = []
  const port: IssuesPort = {
    list: async () => existing,
    create: async (title, body) => { calls.push(`create ${title}`); bodies.push(body); return 77 },
    comment: async (number, body) => { calls.push(`comment #${number}`); bodies.push(body) },
    reopen: async (number) => { calls.push(`reopen #${number}`) },
  }
  return { port, calls, bodies }
}

describe("macOS WebKit crash issues", () => {
  test("a new signature opens one issue labelled webkit-crash with the signature in the title", async () => {
    const { port, calls, bodies } = fakePort()
    const lines = await fileCrashIssues(port, parseCrashOutputs(outputs([signature()])), run)
    expect(calls).toEqual([`create WebKit crash: ${SIGSEGV_KEY}`])
    expect(bodies[0]).toContain(run.runUrl)
    expect(bodies[0]).toContain(run.date)
    expect(bodies[0]).toContain("webkit-lane-travel-evidence")
    expect(bodies[0]).toContain("JSC::JSWebAssemblyArray::visitChildren(JSC::JSCell*")
    expect(lines).toEqual([`created #77: ${SIGSEGV_KEY}`])
  })

  test("a repeat signature comments on the existing issue with the run URL and date", async () => {
    const { port, calls, bodies } = fakePort([{ number: 12, title: `WebKit crash: ${SIGSEGV_KEY}`, state: "open" }])
    await fileCrashIssues(port, parseCrashOutputs(outputs([signature()])), run)
    expect(calls).toEqual(["comment #12"])
    expect(bodies[0]).toContain(run.runUrl)
    expect(bodies[0]).toContain(run.date)
  })

  test("a closed issue whose crash comes back is reopened, not duplicated", async () => {
    const { port, calls } = fakePort([{ number: 12, title: `WebKit crash: ${SIGSEGV_KEY}`, state: "closed" }])
    await fileCrashIssues(port, parseCrashOutputs(outputs([signature()])), run)
    expect(calls).toEqual(["reopen #12", "comment #12"])
  })

  test("the same signature from two lanes files once and names both lanes' evidence", async () => {
    const { port, calls, bodies } = fakePort()
    await fileCrashIssues(port, parseCrashOutputs(outputs([signature()], [signature(SIGSEGV_KEY, "portable")])), run)
    expect(calls).toHaveLength(1)
    expect(bodies[0]).toContain("webkit-lane-travel-evidence")
    expect(bodies[0]).toContain("webkit-lane-portable-evidence")
  })

  test("no crash files nothing", async () => {
    const { port, calls } = fakePort()
    expect(await fileCrashIssues(port, parseCrashOutputs(outputs([], [], [])), run)).toEqual(["no WebKit crash in this run"])
    expect(calls).toEqual([])
  })

  test("never writes a crash reporter key or a UUID into an issue", async () => {
    const reporterKey = randomBytes(20).toString("hex")
    const uuid = randomUUID()
    const leaky = signature(`WebCore: Worker | SIGSEGV | f_${uuid}`, "memory", [`JavaScriptCore ${uuid}`, `crashReporterKey ${reporterKey}`])
    const { port, calls, bodies } = fakePort()
    await fileCrashIssues(port, parseCrashOutputs(outputs([leaky])), run)
    for (const text of [...calls, ...bodies]) {
      expect(text).not.toContain(uuid)
      expect(text).not.toContain(reporterKey)
      expect(text).not.toMatch(UUID)
    }
  })

  test.each([
    ["not JSON", "crashes"],
    ["not a list of lane outputs", JSON.stringify({ crashes: [] })],
    ["a lane output that is not a list", JSON.stringify([JSON.stringify({ key: "x" })])],
    ["a signature with a missing field", JSON.stringify([JSON.stringify([{ key: "x", lane: "travel" }])])],
    ["an unknown lane", JSON.stringify([JSON.stringify([signature(SIGSEGV_KEY, "../../etc")])])],
    ["an oversized key", JSON.stringify([JSON.stringify([signature("x".repeat(400))])])],
    ["too many frames", JSON.stringify([JSON.stringify([signature(SIGSEGV_KEY, "travel", Array(40).fill("f"))])])],
  ])("refuses %s instead of filing it", (_name, raw) => {
    expect(() => parseCrashOutputs(raw)).toThrow("crash signatures differ")
  })
})

describe("GitHub issues port", () => {
  test("reads only webkit-crash issues (never pull requests), page by page, then writes with the token", async () => {
    const requests: Array<{ url: string; method: string; auth: string; body?: string }> = []
    const pages = [
      [{ number: 1, title: "WebKit crash: a", state: "open" }, { number: 2, title: "PR", state: "open", pull_request: {} }],
      [],
    ]
    const fetcher = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      requests.push({ url, method: init.method ?? "GET", auth: headers.Authorization, body: init.body as string | undefined })
      const payload = init.method === "POST" && url.endsWith("/issues") ? { number: 9 } : (pages.shift() ?? [])
      return new Response(JSON.stringify(payload), { status: init.method === "POST" ? 201 : 200 })
    }) as typeof fetch
    const port = githubIssuesPort("gainratio/almamesh", async () => "TOKEN", fetcher)
    expect(await port.list()).toEqual([{ number: 1, title: "WebKit crash: a", state: "open" }])
    expect(requests[0].url).toBe("https://api.github.com/repos/gainratio/almamesh/issues?labels=webkit-crash&state=all&per_page=100&page=1")
    expect(await port.create("WebKit crash: b", "body")).toBe(9)
    expect(JSON.parse(requests.at(-1)?.body ?? "{}")).toEqual({ title: "WebKit crash: b", body: "body", labels: ["webkit-crash"] })
    expect(requests.every((request) => request.auth === "Bearer TOKEN")).toBe(true)
  })

  test("fails on an HTTP error without printing the response body", async () => {
    const fetcher = (async () => new Response("PRIVATE body", { status: 403 })) as unknown as typeof fetch
    const port = githubIssuesPort("gainratio/almamesh", async () => "TOKEN", fetcher)
    await expect(port.list()).rejects.toThrow("GitHub issues request failed: 403")
    await expect(port.list()).rejects.not.toThrow("PRIVATE")
  })

  test("refuses a repository outside the allowlist before any request", () => {
    expect(() => githubIssuesPort("attacker/almamesh", async () => "TOKEN")).toThrow()
  })
})
