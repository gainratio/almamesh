import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { PRODUCT_GATES } from "../dagger/src/gates.ts"
import {
  JOURNEY_GATES,
  JOURNEY_LANES,
  JOURNEY_STEPS,
  journeyCommands,
  journeyLaneOfGate,
  parseJourneyLane,
} from "../dagger/src/journeyLanes.ts"

const root = resolve(import.meta.dir, "..")
const web = resolve(root, "frontend/apps/web")

// The union of the lanes must be the whole journey list, each step exactly once.
// Both sides are derived from the one step list the lanes run; nothing is copied by hand.
describe("browser journey lanes partition the journey list", () => {
  test("there are three lanes, each with its own product gate", () => {
    expect([...JOURNEY_LANES]).toEqual(["a", "b", "c"])
    expect([...JOURNEY_GATES]).toEqual(["browserJourneysA", "browserJourneysB", "browserJourneysC"])
    for (const gate of JOURNEY_GATES) expect(PRODUCT_GATES as readonly string[]).toContain(gate)
    expect(PRODUCT_GATES as readonly string[]).not.toContain("browserJourneys")
  })

  test("every step belongs to exactly one known lane", () => {
    for (const step of JOURNEY_STEPS) expect(JOURNEY_LANES as readonly string[]).toContain(step.lane)
  })

  test("the union of the lanes equals the full journey list, with no overlap and no omission", () => {
    const all = JOURNEY_STEPS.map((step) => step.command)
    const fromLanes = JOURNEY_LANES.flatMap((lane) => journeyCommands(lane))
    expect(new Set(fromLanes).size).toBe(fromLanes.length)
    expect([...fromLanes].sort()).toEqual([...all].sort())
  })

  test("no lane is empty and no lane holds more than half of the original serial time", () => {
    for (const lane of JOURNEY_LANES) expect(journeyCommands(lane).length).toBeGreaterThan(0)
    const share = Math.max(...JOURNEY_LANES.map((lane) => JOURNEY_STEPS.filter((s) => s.lane === lane).reduce((n, s) => n + s.minutes, 0)))
    const total = JOURNEY_STEPS.reduce((n, s) => n + s.minutes, 0)
    expect(share / total).toBeLessThan(0.4)
  })

  test("both time-travel shards run, so the single spec is still split two ways and complete", () => {
    const all = JOURNEY_STEPS.map((step) => step.command).filter((c) => c.includes("e2e/time-travel.spec.ts"))
    expect(all.some((c) => c.includes("--shard=1/2"))).toBe(true)
    expect(all.some((c) => c.includes("--shard=2/2"))).toBe(true)
    expect(all.length).toBe(2)
  })

  test("every spec file, package script and verify script a step names exists on disk", () => {
    const pkg = JSON.parse(readFileSync(resolve(web, "package.json"), "utf8")) as { scripts: Record<string, string> }
    for (const { command } of JOURNEY_STEPS) {
      for (const spec of command.match(/e2e\/[\w.-]+\.spec\.ts/g) ?? []) expect(existsSync(resolve(web, spec))).toBe(true)
      for (const script of command.match(/test:e2e:[\w:-]+/g) ?? []) expect(pkg.scripts[script]).toBeDefined()
      for (const file of command.match(/scripts\/[\w.-]+\.mjs/g) ?? []) expect(existsSync(resolve(web, file))).toBe(true)
    }
  })
})

describe("lane identity parsing", () => {
  test("accepts exactly the known lanes", () => {
    for (const lane of JOURNEY_LANES) expect(parseJourneyLane(lane)).toBe(lane)
    for (const bad of ["", "d", "A", "a ", "a;b", "../a"]) expect(() => parseJourneyLane(bad)).toThrow("lane")
  })

  test("maps a gate name to its lane and refuses anything else", () => {
    expect(journeyLaneOfGate("browserJourneysB")).toBe("b")
    expect(() => journeyLaneOfGate("browserJourneys")).toThrow()
    expect(() => journeyLaneOfGate("browserChromium")).toThrow()
  })
})

describe("lane wiring in the Dagger module", () => {
  const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")

  test("each lane gate function runs its own lane", () => {
    for (const lane of JOURNEY_LANES) {
      const gate = `browserJourneys${lane.toUpperCase()}`
      expect(source).toContain(`  ${gate}(): Container {\n    return this.browserJourneysRun("${lane}")\n  }`)
      expect(journeyLaneOfGate(gate)).toBe(lane)
    }
  })

  test("the status gate and the evidence job use the caller's own lane, never a fixed one", () => {
    const status = source.slice(source.indexOf("async browserJourneysStatus("), source.indexOf("private browserJourneysRun("))
    expect(status).toContain("browserJourneyFetchRequest(parseJourneyLane(lane), repository, runId, commitSha)")
    expect(status).not.toMatch(/"[abc]"/)
    const evidence = source.slice(source.indexOf("async browserJourneysEvidence("), source.indexOf("async browserJourneysStatus("))
    expect(evidence).toContain("this.browserJourneysRun(checked, true)")
    expect(evidence).not.toMatch(/"[abc]"/)
  })

  test("the journey list is pinned: 14 steps including the onboarding AI step", () => {
    expect(JOURNEY_STEPS.length).toBe(14)
    expect(JOURNEY_STEPS.some((s) => s.command.includes("test:e2e:onboarding-ai"))).toBe(true)
  })
})
