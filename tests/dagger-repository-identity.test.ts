import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import * as identity from "../dagger/src/repositoryIdentity.ts"
import {
  ALLOWED_OWNERS,
  ALLOWED_REPOSITORIES,
  repositoryGitUrl,
  repositoryOwner,
  requireAllowedRepository,
} from "../dagger/src/repositoryIdentity.ts"

// The run's own `github.repository` reaches the guard, so the identity follows a
// transfer from the hseshadr user to the gainratio org. Only these two exact
// names are accepted: a fork, a look-alike owner, or a sibling repo is refused.
describe("repository identity allow-list", () => {
  test("pins exactly the two owners of this one repository", () => {
    expect(ALLOWED_REPOSITORIES).toEqual(["hseshadr/almamesh", "gainratio/almamesh"])
  })

  // No fallback identity: every caller passes the run's own `github.repository`,
  // so nothing silently keeps acting as hseshadr/almamesh after the transfer.
  test("exports no default repository", () => {
    expect(Object.keys(identity)).not.toContain("DEFAULT_REPOSITORY")
  })

  test.each([undefined, null])("refuses a missing repository (%p)", (repository) => {
    expect(() => requireAllowedRepository(repository as never)).toThrow("is not an allowed repository")
  })

  test("derives the two owners from the allow-list", () => {
    expect(ALLOWED_OWNERS).toEqual(["hseshadr", "gainratio"])
  })

  test.each([
    ["hseshadr/almamesh", "hseshadr"],
    ["gainratio/almamesh", "gainratio"],
  ])("the owner of %s is %s", (repository, owner) => {
    expect(repositoryOwner(repository)).toBe(owner)
  })

  test.each(["attacker/almamesh", "", undefined])("refuses the owner of %p", (repository) => {
    expect(() => repositoryOwner(repository as never)).toThrow("is not an allowed repository")
  })

  test.each(["hseshadr/almamesh", "gainratio/almamesh"])("accepts %s", (repository) => {
    expect(requireAllowedRepository(repository)).toBe(repository)
  })

  test.each([
    "attacker/almamesh",
    "gainratio/aml-filter",
    "hseshadr/almamesh-evil",
    "gainratio-evil/almamesh",
    "",
    "HSESHADR/almamesh",
    " hseshadr/almamesh",
  ])("refuses %p", (repository) => {
    expect(() => requireAllowedRepository(repository)).toThrow("is not an allowed repository")
  })

  test("derives the clone URL from the validated run repository", () => {
    expect(repositoryGitUrl("gainratio/almamesh")).toBe("https://github.com/gainratio/almamesh.git")
    expect(repositoryGitUrl("hseshadr/almamesh")).toBe("https://github.com/hseshadr/almamesh.git")
  })

  test("refuses to derive a clone URL for a repository outside the allow-list", () => {
    expect(() => repositoryGitUrl("attacker/almamesh")).toThrow("is not an allowed repository")
  })
})

// The module's identity lives in one place. Any other `hseshadr/almamesh` literal in
// dagger/src (a clone URL, an image label, a target constant) would keep acting as
// the old owner after the transfer, so the run repository must be threaded instead.
describe("no hardcoded repository identity outside the allow-list", () => {
  const src = resolve(import.meta.dir, "..", "dagger", "src")
  const hardcoded = /(hseshadr|gainratio)\/almamesh(?![-\w])/

  test.each(readdirSync(src).filter((name) => name.endsWith(".ts") && name !== "repositoryIdentity.ts"))(
    "%s names no owner/almamesh literal",
    (name) => {
      expect(readFileSync(join(src, name), "utf8")).not.toMatch(hardcoded)
    },
  )
})
