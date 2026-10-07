import { describe, expect, test } from "bun:test"
import {
  ALLOWED_REPOSITORIES,
  DEFAULT_REPOSITORY,
  repositoryGitUrl,
  requireAllowedRepository,
} from "../dagger/src/repositoryIdentity.ts"

// The run's own `github.repository` reaches the guard, so the identity follows a
// transfer from the hseshadr user to the gainratio org. Only these two exact
// names are accepted: a fork, a look-alike owner, or a sibling repo is refused.
describe("repository identity allow-list", () => {
  test("pins exactly the two owners of this one repository", () => {
    expect(ALLOWED_REPOSITORIES).toEqual(["hseshadr/almamesh", "gainratio/almamesh"])
  })

  test("defaults to today's owner so existing callers do not change", () => {
    expect(DEFAULT_REPOSITORY).toBe("hseshadr/almamesh")
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
