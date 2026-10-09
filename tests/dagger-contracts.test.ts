// Dagger CLI tests: each one shells out to a host `dagger` (functions, --help,
// `dagger call contracts`, `dagger call deploy-dry-run`), so they run locally only.
// CI's ingress stays checkout + dagger with no host steps (dagger-ingress-contract),
// and the `contracts` gate already runs the contracts and deploy-dry-run pipelines.
// The checks that need no dagger CLI (source text of dagger/src/index.ts and the
// install-bun.sh retry script) live in tests/dagger-foundation-contract.test.ts,
// which the `contracts` gate runs on every PR.
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dir, "..")
const ansi = /\x1b\[[0-9;]*m/g

function daggerFunctions(): string[] {
  const run = spawnSync("dagger", ["functions"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DAGGER_NO_NAG: "1" },
  })
  expect(run.status, run.stderr).toBe(0)
  return run.stdout
    .replaceAll(ansi, "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((name) => /^[a-z][a-z-]+$/.test(name) && name !== "name")
}

function daggerHelp(name: string): string {
  const run = spawnSync("dagger", ["call", name, "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DAGGER_NO_NAG: "1" },
  })
  expect(run.status, run.stderr).toBe(0)
  return run.stdout.replaceAll(ansi, "")
}


describe("Dagger public orchestration contract", () => {
  test("exposes every repository-authored CI/CD operation as a native function", () => {
    expect(daggerFunctions()).toEqual(
      expect.arrayContaining([
        "backend",
        "browser-chromium",
        "browser-journeys",
        "browser-matrix",
        "browser-suites",
        "browser-webkit-real",
        "browser-wizards",
        "contracts",
        "dependency-audit",
        "deploy",
        "deploy-dry-run",
        "frontend",
        "gate",
        "live-probe",
        "nightly",
        "pdf",
        "privacy",
        "production-artifact",
        "secret-scan",
        "verdict",
        "verify-live",
        "web",
      ]),
    )
  }, 30_000)

  test("the PR-safe deploy dry-run needs an identity but no secret", () => {
    const help = daggerHelp("deploy-dry-run")
    const args = help.split("ARGUMENTS", 2)[1]?.split('Use "dagger', 1)[0] ?? ""
    expect(help).toContain("--expected-sha")
    expect(args).not.toContain("Secret")
  }, 30_000)

  test("the canonical CI entrypoint requires an exact non-secret commit identity", () => {
    const help = daggerHelp("ci")
    const args = help.split("ARGUMENTS", 2)[1]?.split('Use "dagger', 1)[0] ?? ""
    expect(help).toContain("--commit-sha")
    expect(args).not.toContain("Secret")
  }, 30_000)

  test("the contract gate executes the pure Foundation and workflow adversaries", () => {
    const run = spawnSync("dagger", ["call", "contracts", "stdout"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DAGGER_NO_NAG: "1" },
      timeout: 120_000,
    })
    const output = `${run.stdout}\n${run.stderr}`
    expect(run.status, output).toBe(0)
    expect(output).toContain("dagger-deployment-contract.test.ts")
    expect(output).toContain("dagger-foundation-contract.test.ts")
    expect(output).toContain("dagger-ingress-contract.test.ts")
    expect(output).toContain("dagger-workflow-contract.test.ts")
  }, 120_000)

  test("deploy dry-run serves the closed compiled feedback route without credentials", () => {
    const expectedSha = "1".repeat(40)
    const run = spawnSync(
      "dagger",
      ["call", "deploy-dry-run", `--expected-sha=${expectedSha}`, "stdout"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, DAGGER_NO_NAG: "1" },
        timeout: 180_000,
      },
    )
    const output = `${run.stdout}\n${run.stderr}`
    expect(run.status, output).toBe(0)
    expect(output).toContain(
      `Wrangler Pages Functions dry-run verified closed feedback route for ${expectedSha}`,
    )
    expect(output).not.toContain("api.cloudflare.com")
  }, 180_000)
})

