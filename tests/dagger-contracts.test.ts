import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

  test("production deploy composes one central Pages Functions transaction", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    expect(source).toContain("deliverProduction")
    expect(source).toContain(".greenMainDecision(")
    expect(source).toContain(".source(")
    expect(source).toContain(".guard(")
    expect(source).toContain(".envelope(")
    expect(source).toContain("{ pagesFunctions: request.pagesFunctions }")
    expect(source).toContain("loadCloudflarePagesDeploymentEvidenceFromID")
    expect(source).not.toContain(".preflight(")
    expect(source).not.toContain(".verifyEnvelope(")
    expect(source).not.toContain("dag.cloudflarePages().verify(")
    expect(source).not.toContain("verify-pages-source.mjs")
    expect(source).not.toContain("pagesDeployScript")
  })

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

  test("package installs cannot reuse partially downloaded Bun tarballs", () => {
    const source = readFileSync(resolve(root, "dagger/src/index.ts"), "utf8")
    expect(source).not.toContain('withMountedCache("/root/.bun/install/cache"')
  })

  test("Bun installs time out, clean ephemeral state, retry once, and fail closed", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "almamesh-bun-install-"))
    const installer = resolve(root, "dagger/scripts/install-bun.sh")
    const counter = join(sandbox, "attempts")
    const args = join(sandbox, "args")
    writeFileSync(join(sandbox, "timeout"), [
      "#!/bin/sh", "shift 3", '"$@" &', "pid=$!", '( sleep 1; kill "$pid" 2>/dev/null ) &',
      "watch=$!", 'wait "$pid"', "status=$?", 'kill "$watch" 2>/dev/null || true', "exit $status",
    ].join("\n"))
    writeFileSync(join(sandbox, "bun"), [
      "#!/bin/sh", "set -eu", `counter='${counter}'`, `args='${args}'`,
      'attempt=$(($(cat "$counter" 2>/dev/null || echo 0) + 1))', 'echo "$attempt" > "$counter"',
      'echo "$*" >> "$args"',
      'if [ "${FAKE_FAIL:-}" = always ]; then mkdir -p node_modules "$BUN_INSTALL_CACHE_DIR"; touch node_modules/final-partial "$BUN_INSTALL_CACHE_DIR/final-partial"; exit 9; fi',
      'if [ "$attempt" -eq 1 ]; then sleep 5; fi', "mkdir -p node_modules",
    ].join("\n"))
    chmodSync(join(sandbox, "timeout"), 0o755)
    chmodSync(join(sandbox, "bun"), 0o755)
    const env = {
      ...process.env,
      PATH: `${sandbox}:${process.env.PATH ?? ""}`,
      BUN_INSTALL_CACHE_DIR: join(sandbox, "cache"),
      BUN_INSTALL_TIMEOUT_SECONDS: "1",
    }
    try {
      const recovered = spawnSync("bash", [installer], { cwd: sandbox, env, encoding: "utf8" })
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(readFileSync(counter, "utf8").trim()).toBe("2")
      expect(readFileSync(args, "utf8").trim().split("\n"))
        .toEqual(["install --frozen-lockfile", "install --frozen-lockfile"])
      const failed = spawnSync("bash", [installer], {
        cwd: sandbox, env: { ...env, FAKE_FAIL: "always" }, encoding: "utf8",
      })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain("failed after 2 attempts")
      expect(existsSync(join(sandbox, "node_modules/final-partial"))).toBe(true)
      expect(existsSync(join(sandbox, "cache/final-partial"))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 10_000)
})

