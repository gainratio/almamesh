import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

import { LANE_COMMAND_TIMEOUT_SECONDS, laneScript } from "../dagger/src/laneScript.ts"

/** Run a generated lane script with bash, as the Dagger container does. */
function run(script: string) {
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 30_000 })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, signal: result.signal }
}

// CI hang (run 37362447831, 2026-10-05): one lane command waited on a
// service worker that was never registered, printed nothing, and held the
// whole CI run for 74 minutes until it was cancelled. A lane command that
// outlives its budget must FAIL, name itself, and let the next gate report.
describe("Dagger lane commands are bounded", () => {
  test("pins the per-command budget the docs promise: 15 minutes", () => {
    expect(LANE_COMMAND_TIMEOUT_SECONDS).toBe(900)
  })

  test("a command that outlives its budget fails with a message naming it", () => {
    const script = laneScript({ server: "sleep 300", port: 1, commands: ["sleep 30", "echo never-reached"], timeoutSeconds: 2, waitForServer: false })
    const started = Date.now()
    const result = run(script)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("timed out after 2s: sleep 30")
    expect(result.output).not.toContain("never-reached")
  })

  test("commands within budget run in order, and a failing one stops the lane", () => {
    const ok = run(laneScript({ server: "sleep 300", port: 1, commands: ["echo one", "echo 'two words'"], timeoutSeconds: 5, waitForServer: false }))
    expect(ok.status).toBe(0)
    expect(ok.output).toContain("one")
    expect(ok.output).toContain("two words")

    const failed = run(laneScript({ server: "sleep 300", port: 1, commands: ["exit 3", "echo never-reached"], timeoutSeconds: 5, waitForServer: false }))
    expect(failed.status).not.toBe(0)
    expect(failed.output).not.toContain("never-reached")
  })

  test("a command's own quotes survive the wrapping", () => {
    const result = run(laneScript({ server: "sleep 300", port: 1, commands: [`node -e 'console.log("it'"'"'s quoted")'`], timeoutSeconds: 5, waitForServer: false }))
    expect(result.status).toBe(0)
    expect(result.output).toContain("it's quoted")
  })
})
