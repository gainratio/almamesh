/**
 * The repository identities this module may run as. The run passes its own
 * `github.repository`, so CI, deploy, and the Foundation checks keep working
 * after the planned hseshadr -> gainratio transfer. Exact membership only: a
 * fork, a look-alike owner, or a sibling repository is refused.
 */
export const ALLOWED_REPOSITORIES = ["hseshadr/almamesh", "gainratio/almamesh"] as const

export type AllowedRepository = (typeof ALLOWED_REPOSITORIES)[number]

/** The owners of the allowed repositories (the GHCR namespaces we publish under). */
export const ALLOWED_OWNERS: readonly string[] = ALLOWED_REPOSITORIES.map((repository) => repository.split("/")[0])

// There is deliberately no default repository: every entry point takes the run's
// own `github.repository`, so nothing silently keeps acting as the old owner.

export function requireAllowedRepository(repository: string): AllowedRepository {
  const allowed = ALLOWED_REPOSITORIES.find((candidate) => candidate === repository)
  if (allowed === undefined) {
    throw new Error(
      `"${repository}" is not an allowed repository; expected one of ${ALLOWED_REPOSITORIES.join(", ")}`,
    )
  }
  return allowed
}

/** The HTTPS clone URL of an allowed repository. */
export function repositoryGitUrl(repository: string): string {
  return `https://github.com/${requireAllowedRepository(repository)}.git`
}

/** The owner segment of an allowed repository. */
export function repositoryOwner(repository: string): string {
  return requireAllowedRepository(repository).split("/")[0]
}
