import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  assertAllPassed,
  CI_GATES,
  GATE_TIMEOUT_MS,
  gateVerdict,
  PRODUCT_GATES,
  runConcurrently,
  runPool,
  startGate,
} from "../dagger/src/gates.ts"

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

// CI hang (run 37362447831): one gate never settled and held the run for 74
// minutes. A gate that outlives its budget reports a named failure instead.
describe("every gate is time-bounded", () => {
  test("pins the gate budget: 45 minutes", () => {
    expect(GATE_TIMEOUT_MS).toBe(45 * 60_000)
  })

  test("a gate that never settles fails with its name once the budget runs out", async () => {
    const outcome = await startGate("browser", () => new Promise(() => undefined), 50)
    expect(outcome.failed).toBe(true)
    expect(() => assertAllPassed([outcome])).toThrow("browser: gate timed out after 50 ms")
  })

  test("a gate that settles in time is unaffected by the budget", async () => {
    const outcome = await startGate("pdf", async () => "ok", 1_000)
    expect(outcome).toEqual({ gate: "pdf", failed: false })
  })
})

describe("bounded gate pool", () => {
  // Six heavy gates at once on 4 vCPUs made real-browser and vitest tests time out (three CI
  // runs, three different timeouts), so the product gates run through a pool of N lanes.
  function tracker() {
    let inFlight = 0
    let peak = 0
    const order: string[] = []
    const gate = (name: string, fail = false) => ({
      name,
      run: async () => {
        order.push(name)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((done) => setTimeout(done, 5))
        inFlight -= 1
        if (fail) throw new Error(`${name} red`)
      },
    })
    return { gate, order, peak: () => peak }
  }

  test("never runs more than `limit` gates at once, and runs them all", async () => {
    const t = tracker()
    const outcomes = await runPool(["a", "b", "c", "d", "e"].map((n) => t.gate(n)), 2)
    expect(t.peak()).toBe(2)
    expect(outcomes.map((o) => o.gate).sort()).toEqual(["a", "b", "c", "d", "e"])
  })

  test("starts gates in the order given, so the longest can go first", async () => {
    const t = tracker()
    await runPool(["slow", "b", "c"].map((n) => t.gate(n)), 2)
    expect(t.order[0]).toBe("slow")
  })

  test("a red gate is reported, never swallowed, and does not stop the rest", async () => {
    const t = tracker()
    const outcomes = await runPool([t.gate("a", true), t.gate("b"), t.gate("c")], 1)
    expect(outcomes.filter((o) => o.failed).map((o) => o.gate)).toEqual(["a"])
    expect(t.order).toEqual(["a", "b", "c"])
    expect(() => assertAllPassed(outcomes)).toThrow("a: a red")
  })

  test("a limit below 1 is refused rather than silently running nothing", async () => {
    await expect(runPool([{ name: "a", run: async () => undefined }], 0)).rejects.toThrow("limit")
  })
})

describe("almamesh ci wiring", () => {
  const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
  const ci = source.slice(source.indexOf("async ci("), source.indexOf("secretScan(commitSha: string)"))

  test("names every product gate once, the five browser shards first (they are the longest)", () => {
    expect([...PRODUCT_GATES]).toEqual([
      "browserChromium",
      "browserJourneys",
      "browserSuites",
      "browserWizards",
      "browserWebkitReal",
      "browserMatrix",
      "frontend",
      "backend",
      "pdf",
      "privacy",
    ])
    expect([...CI_GATES]).toEqual(["secretScan", "contracts", ...PRODUCT_GATES])
  })

  test("guards the source first, then runs the product gates through a 2-lane pool", () => {
    expect(ci).toContain("runPool(")
    expect(ci).toContain("PRODUCT_GATE_LANES")
    expect(source).toContain("const PRODUCT_GATE_LANES = 2")
    expect(ci).toContain("PRODUCT_GATES.map(")
    expect(ci).toContain("assertAllPassed(")
    // The guard runs as the run's own repository; -1 (not found) must not pass.
    expect(ci.indexOf("this.secretScan(commitSha, repository)")).toBeGreaterThan(-1)
    expect(ci.indexOf("this.secretScan(commitSha, repository)")).toBeLessThan(ci.indexOf("runPool("))
    expect(ci).not.toContain("for (const gate of gates) await")
  })
})

describe("aggregate verdict over the per-gate CI jobs", () => {
  const all = (result: string) => CI_GATES.map(() => result).join(",")

  test("passes only when every gate job succeeded", () => {
    expect(gateVerdict(all("success"))).toContain(`${CI_GATES.length} gate jobs passed`)
  })

  for (const bad of ["failure", "cancelled", "skipped"]) {
    test(`a ${bad} gate job turns the aggregate red`, () => {
      const results = CI_GATES.map((_, index) => (index === 3 ? bad : "success")).join(",")
      expect(() => gateVerdict(results)).toThrow(`1 of ${CI_GATES.length} gate jobs did not succeed: ${bad}`)
    })
  }

  test("a gate job missing from the aggregate's needs is refused, not counted as green", () => {
    const short = CI_GATES.slice(1).map(() => "success").join(",")
    expect(() => gateVerdict(short)).toThrow(`expected ${CI_GATES.length} gate job results, got ${CI_GATES.length - 1}`)
  })

  test("an empty result list is refused", () => {
    expect(() => gateVerdict("")).toThrow(`expected ${CI_GATES.length} gate job results, got 0`)
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

describe("browser matrix lane", () => {
  const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
  const lane = source.slice(source.indexOf("browserMatrix(): Container"), source.indexOf("pdf(): Container"))

  test("drives the real journey in Firefox with a clean console", () => {
    expect(lane).toContain('"firefox"')
    expect(lane).toContain("verify-browser-journey.mjs http://127.0.0.1:4199 --browser=firefox")
  })

  test("smokes Microsoft Edge where Microsoft ships a Linux build, and says so where it does not", () => {
    const edge = source.slice(source.indexOf("const EDGE_SMOKE"), source.indexOf("fi`", source.indexOf("const EDGE_SMOKE")))
    expect(lane).toContain("EDGE_SMOKE,")
    expect(edge).toContain("playwright install --with-deps msedge")
    expect(edge).toContain("--channel=msedge")
    expect(edge).toContain('"$(uname -m)" = x86_64')
    expect(edge).toMatch(/no Linux arm64 build of Edge/)
  })

  test("runs a low-end lane: one CPU core for every Worker, a CDP throttle, and asserted budgets", () => {
    expect(lane).toContain("taskset -c 0 node scripts/verify-browser-journey.mjs")
    expect(source).toContain("const LOW_END_CPU_THROTTLE = 4")
    expect(source).toContain("const LOW_END_READY_BUDGET_MS = 15_000")
    expect(source).toContain("const LOW_END_CHART_BUDGET_MS = 90_000")
    expect(lane).toContain("--cpu-throttle=${LOW_END_CPU_THROTTLE}")
    expect(lane).toMatch(/--ready-budget-ms=\$\{LOW_END_READY_BUDGET_MS\}/)
    expect(lane).toMatch(/--chart-budget-ms=\$\{LOW_END_CHART_BUDGET_MS\}/)
    expect(lane).toContain("STORAGE_BLOCKED_CPU_THROTTLE=${LOW_END_CPU_THROTTLE}")
  })

  test("Reset & reload must delete IndexedDB, proven on a build without its engine bundle", () => {
    expect(lane).toContain("rm -rf dist-starved/bundle dist-starved/pyodide dist-starved/public.key")
    for (const browser of ["chromium", "firefox"]) {
      expect(lane).toContain(`verify-reset-deletes.mjs http://127.0.0.1:4198 --browser=${browser}`)
    }
  })
})

describe("browser gate shards", () => {
  const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
  const shards = source.slice(source.indexOf("  browserChromium(): Container {"), source.indexOf("  browserMatrix(): Container {"))
  // Every command the single `browser` gate ran before it was split, verbatim
  // (the four Playwright suites now reuse the lane's hooked build via *_BASE_URL
  // instead of rebuilding the same bundle in their own webServer).
  const commands = [
    '"node", "scripts/verify-precache-redirect.mjs", "dist-verify"',
    "node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4199 --browser=chromium",
    "node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4199 --browser=chromium",
    "node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4199 --browser=chromium --slow-boot-storage-ms=1500",
    "node scripts/verify-storage-blocked.mjs http://127.0.0.1:4199 --browser=chromium --journey",
    "PORTABLE_SQLITE_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:portable-sqlite",
    "PORTABLE_INVARIANTS_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:portable-invariants --project=chromium",
    "FIRST_RUN_RESTORE_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:first-run-restore --project=chromium",
    "LANDING_RESPONSIVE_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:landing-responsive",
    "node scripts/verify-exit-gate.mjs http://127.0.0.1:4199",
    "node scripts/verify-i18n.mjs http://127.0.0.1:4199",
    "node scripts/verify-browser-parity.mjs http://127.0.0.1:4199 --reference-date=2025-01-01T00:00:00+00:00",
    "TIME_HANDLING_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-handling --project=chromium",
    "TIME_TRAVEL_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:time-travel --project=chromium",
    "MESH_PERSIST_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:mesh-add-persist",
    "DURABLE_SAVES_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:durable-saves",
    "node scripts/verify-boot-fault-hook.mjs dist-verify --present",
    "BOOT_RETRY_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:boot-retry --project=chromium",
    "node scripts/verify-cross-origin-isolation.mjs http://127.0.0.1:4200 --browser=webkit",
    "node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4200 --browser=webkit",
    "node scripts/verify-sqlite-memory.mjs http://127.0.0.1:4200 --browser=webkit --slow-boot-storage-ms=1500",
    "node scripts/verify-storage-blocked.mjs http://127.0.0.1:4200 --browser=webkit",
    "node scripts/verify-webkit-engine.mjs http://127.0.0.1:4200",
    "INTERP_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:interp",
    "CHAT_GROUNDING_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:chat:grounding",
    "AI_PANEL_EGRESS_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:ai-panel:egress",
    "RECTIFY_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:rectification",
    "WIZARD_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:wizard",
    '"bun", "run", "test:e2e:returning-visitor"',
    "node scripts/verify-real-onboarding.mjs http://127.0.0.1:4199",
    "node scripts/verify-onboarding-recovery.mjs http://127.0.0.1:4199",
    "MEMORY_BUDGET_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:memory-budget",
    "BIRTH_TIME_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:birth-time-edit --project=chromium",
    "CHART_RELOAD_E2E_BASE_URL=http://127.0.0.1:4199 RELOAD_DELAYS=0,200 bun run test:e2e:chart-durable-reload --project=chromium",
  ]

  for (const command of commands) {
    test(`runs exactly once: ${command}`, () => {
      const literal = command.startsWith('"') ? command : `"${command}"`
      expect(shards.split(literal).length - 1).toBe(1)
    })
  }

  test("the AI panel egress guard runs in the browserSuites shard on Chromium", () => {
    const suites = source.slice(source.indexOf("  browserSuites(): Container {"), source.indexOf("  browserWizards(): Container {"))
    expect(suites).toContain('"AI_PANEL_EGRESS_E2E_BASE_URL=http://127.0.0.1:4199 bun run test:e2e:ai-panel:egress"')
  })

  test("the AI panel egress suite is Chromium-only, matches only its spec, and never diffs pixels", () => {
    const web = resolve(root, "frontend/apps/web")
    const scripts = JSON.parse(readFileSync(resolve(web, "package.json"), "utf8")).scripts as Record<string, string>
    expect(scripts["test:e2e:ai-panel:egress"]).toBe("playwright test --config=playwright.ai-setup-panel.egress.config.ts")
    const config = readFileSync(resolve(web, "playwright.ai-setup-panel.egress.config.ts"), "utf8")
    expect(config).toContain("testMatch: /ai-setup-panel\\.egress\\.spec\\.ts/")
    expect(config).toContain("process.env.AI_PANEL_EGRESS_E2E_BASE_URL")
    expect(config.match(/name: '/g)).toEqual(["name: '"])
    expect(config).toContain("name: 'chromium'")
    const spec = readFileSync(resolve(web, "e2e/ai-setup-panel.egress.spec.ts"), "utf8")
    expect(spec).not.toContain("toHaveScreenshot")
    expect(spec).toContain("expect(errors).toEqual([])")
  })

  test("each shard is one of the product gates and serves the one hooked build", () => {
    for (const shard of PRODUCT_GATES.filter((gate) => gate.startsWith("browser") && gate !== "browserMatrix")) {
      expect(shards).toContain(`  ${shard}(): Container {`)
    }
    expect(shards.split("this.hookedBuild()").length - 1).toBe(5)
  })
})
