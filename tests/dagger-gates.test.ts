import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { assertAllPassed, runConcurrently, startGate } from "../dagger/src/gates.ts"

const root = resolve(import.meta.dir, "..")

/** Resolves once `count` callers have arrived; rejects if they never all do. */
function barrier(count: number, timeoutMs = 1500): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const opened = new Promise<void>((resolveOpen) => {
    release = resolveOpen
  })
  return () => {
    arrived += 1
    if (arrived === count) release()
    return Promise.race([
      opened,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`gates ran serially: only ${arrived}/${count} started`)), timeoutMs),
      ),
    ])
  }
}

describe("concurrent gate runner", () => {
  test("starts every gate before any of them finishes", async () => {
    const meet = barrier(4)
    const gates = ["backend", "frontend", "browser", "pdf"].map((name) => ({ name, run: meet }))
    await runConcurrently(gates)
  })

  test("one failing gate fails the whole run and is named with its output", async () => {
    const finished: string[] = []
    const gates = [
      { name: "backend", run: async () => void finished.push("backend") },
      { name: "browser", run: async () => { throw new Error("exit code 1: verify-exit-gate failed") } },
      { name: "pdf", run: async () => void finished.push("pdf") },
    ]
    const failure = await runConcurrently(gates).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toContain("browser")
    expect(failure?.message).toContain("verify-exit-gate failed")
    expect(failure?.message).not.toContain("backend:")
    // Every gate is allowed to finish, so one red gate never hides another.
    expect(finished.sort()).toEqual(["backend", "pdf"])
  })

  test("reports every failed gate, not just the first", async () => {
    const gates = [
      { name: "backend", run: async () => { throw new Error("pytest red") } },
      { name: "privacy", run: async () => { throw new Error("reset leaked") } },
    ]
    const failure = await runConcurrently(gates).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(failure?.message).toContain("backend: pytest red")
    expect(failure?.message).toContain("privacy: reset leaked")
  })

  test("a gate that throws synchronously still fails the run", async () => {
    const gates = [
      {
        name: "frontend",
        run: () => {
          throw new Error("sync boom")
        },
      },
    ]
    await expect(runConcurrently(gates)).rejects.toThrow("frontend: sync boom")
  })

  test("passes when every gate passes", async () => {
    await expect(runConcurrently([{ name: "a", run: async () => undefined }])).resolves.toBeUndefined()
  })

  test("startGate never rejects and assertAllPassed rethrows the named failure", async () => {
    const outcome = await startGate("pdf", async () => {
      throw new Error("chromium crashed")
    })
    expect(outcome.failed).toBe(true)
    expect(() => assertAllPassed([outcome])).toThrow("pdf: chromium crashed")
  })
})

describe("almamesh ci wiring", () => {
  const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
  const ci = source.slice(source.indexOf("async ci("), source.indexOf("secretScan(commitSha: string)"))

  test("guards the source first, then runs the product gates through the concurrent runner", () => {
    expect(ci).toContain("startGate(")
    expect(ci).toContain("assertAllPassed(")
    expect(ci.indexOf("this.secretScan(commitSha)")).toBeLessThan(ci.indexOf("assertAllPassed("))
    expect(ci).not.toContain("for (const gate of gates) await")
    for (const gate of ["backend", "frontend", "browser", "pdf", "privacy"]) {
      expect(ci).toContain(`"${gate}"`)
    }
  })
})

describe("frontend unit tests survive a loaded runner", () => {
  // The frontend gate now shares 4 vCPUs with the browser, pdf and backend gates. On the
  // first concurrent CI run vitest's default 5s test / 10s hook limits fired on two heavy
  // tests (renderToBytes, reportSectionParity) that pass in ~1s on an idle box.
  const config = readFileSync(resolve(root, "frontend/apps/web/vitest.config.ts"), "utf8")

  test("vitest limits are 30s so CPU contention is not read as a failing test", () => {
    expect(config).toContain("testTimeout: 30_000")
    expect(config).toContain("hookTimeout: 30_000")
  })
})
