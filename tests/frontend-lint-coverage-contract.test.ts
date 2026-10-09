import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LINT_IGNORES } from "../frontend/eslint.ignores.mjs"

// Every frontend workspace is linted by ONE flat config (frontend/eslint.config.mjs)
// through ONE command (`bun run lint` = `eslint .` from frontend/), which the
// frontend gate, and so the Dagger `frontend` gate, runs. Before this contract,
// lint ran only on apps/web and every packages/* workspace went unchecked.

const frontend = resolve(import.meta.dir, "..", "frontend")
const read = (path: string): string => readFileSync(resolve(frontend, path), "utf8")

interface FrontendManifest {
  readonly workspaces: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
}

const manifest = JSON.parse(read("package.json")) as FrontendManifest

function packageWorkspaces(): string[] {
  const glob = new Bun.Glob("packages/*/package.json")
  return [...glob.scanSync({ cwd: frontend })].map((path) => path.replace(/\/package\.json$/, "")).sort()
}

function ignoredBy(path: string): string[] {
  return LINT_IGNORES.filter((pattern) => new Bun.Glob(pattern).match(path))
}

describe("frontend lint coverage", () => {
  test("finds the package workspaces it guards", () => {
    expect(manifest.workspaces).toContain("packages/*")
    expect(packageWorkspaces()).toEqual(
      expect.arrayContaining(["packages/browser", "packages/llm", "packages/memory", "packages/store"]),
    )
  })

  test("the frontend gate runs the workspace-wide lint", () => {
    expect(manifest.scripts.lint).toBe("eslint .")
    expect(manifest.scripts.gate).toContain("&& bun run lint &&")
  })

  test("no packages/* workspace is ignored by the shared lint config", () => {
    const probes = packageWorkspaces().flatMap((workspace) => [
      `${workspace}/src/index.ts`,
      `${workspace}/src/view.tsx`,
      `${workspace}/scripts/tool.mjs`,
    ])
    const ignored = probes.filter((probe) => ignoredBy(probe).length > 0)
    expect(ignored).toEqual([])
  })

  test("the config takes its ignores only from the shared list", () => {
    const config = read("eslint.config.mjs")
    expect(config).toContain('import { LINT_IGNORES } from "./eslint.ignores.mjs"')
    expect(config.match(/\bignores\s*:/g)).toEqual(["ignores:"])
    expect(config).toContain("{ ignores: LINT_IGNORES }")
    expect(config).not.toContain("globalIgnores")
  })

  test("no workspace carries its own ESLint config that could shadow the shared one", () => {
    const glob = new Bun.Glob("{apps,packages}/**/eslint.config.*")
    const local = [...glob.scanSync({ cwd: frontend })].filter((path) => !path.includes("node_modules/"))
    expect(local).toEqual([])
  })
})
