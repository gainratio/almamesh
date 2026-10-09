import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

// Every frontend workspace is linted by ONE flat config (frontend/eslint.config.mjs)
// through ONE command (`bun run lint` = `eslint .` from frontend/), which the
// frontend gate, and so the Dagger `frontend` gate, runs. Before this contract,
// lint ran only on apps/web and every packages/* workspace went unchecked.
//
// Coverage is proved by asking ESLint itself, so every way a file can drop out
// of lint counts: the shared LINT_IGNORES, the .gitignore files the config
// includes, a workspace-local config, or a `files` glob that stops matching.
// That needs the installed toolchain, so the frontend gate runs this test
// (`bun test ../tests/frontend-lint-coverage-contract.test.ts`), not the
// dependency-free Dagger contracts gate.

const frontend = resolve(import.meta.dir, "..", "frontend")
const read = (path: string): string => readFileSync(resolve(frontend, path), "utf8")

interface FrontendManifest {
  readonly workspaces: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
}

interface LintConfig {
  readonly rules?: Readonly<Record<string, unknown>>
}

interface ESLintApi {
  isPathIgnored(path: string): Promise<boolean>
  calculateConfigForFile(path: string): Promise<LintConfig | undefined>
}

type ESLintCtor = new (options: { cwd: string }) => ESLintApi

const manifest = JSON.parse(read("package.json")) as FrontendManifest
// Resolve ESLint the way `bun run lint` does: from the frontend workspace root.
const { ESLint } = createRequire(resolve(frontend, "package.json"))("eslint") as { ESLint: ESLintCtor }
const eslint = new ESLint({ cwd: frontend })

function scan(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: frontend })].filter((path) => !path.includes("node_modules/"))
}

function packageWorkspaces(): string[] {
  return scan("packages/*/package.json").map((path) => path.replace(/\/package\.json$/, "")).sort()
}

/** One real TypeScript source file per workspace: the file ESLint must lint. */
function probeFor(workspace: string): string {
  const [probe] = scan(`${workspace}/src/**/*.ts`).sort()
  if (probe === undefined) throw new Error(`${workspace} has no src/**/*.ts file to probe`)
  return resolve(frontend, probe)
}

async function coverageGap(workspace: string): Promise<string | null> {
  const probe = probeFor(workspace)
  if (await eslint.isPathIgnored(probe)) return `${workspace}: ${probe} is ignored`
  const config = await eslint.calculateConfigForFile(probe)
  if (config?.rules?.["@typescript-eslint/no-unused-vars"] === undefined) {
    return `${workspace}: ${probe} gets no TypeScript rules`
  }
  return null
}

describe("frontend lint coverage", () => {
  test("finds the package workspaces it guards", () => {
    expect(manifest.workspaces).toContain("packages/*")
    expect(packageWorkspaces()).toEqual(
      expect.arrayContaining(["packages/browser", "packages/llm", "packages/memory", "packages/store"]),
    )
  })

  test("the frontend gate runs the workspace-wide lint and this contract", () => {
    expect(manifest.scripts.lint).toBe("eslint .")
    expect(manifest.scripts.gate).toContain("&& bun run lint &&")
    expect(manifest.scripts.gate).toContain("bun test ../tests/frontend-lint-coverage-contract.test.ts")
  })

  test("ESLint lints a real source file in every workspace with the TypeScript rules", async () => {
    const workspaces = ["apps/web", ...packageWorkspaces()]
    const gaps = (await Promise.all(workspaces.map(coverageGap))).filter((gap) => gap !== null)
    expect(gaps).toEqual([])
  })

  test("no workspace carries its own ESLint config that could shadow the shared one", () => {
    expect([...scan("apps/**/eslint.config.*"), ...scan("packages/**/eslint.config.*")]).toEqual([])
  })
})
