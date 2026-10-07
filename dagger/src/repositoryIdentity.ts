/**
 * The repository identities this module may run as. The run passes its own
 * `github.repository`, so CI, deploy, and the Foundation checks keep working
 * after the planned hseshadr -> gainratio transfer. Exact membership only: a
 * fork, a look-alike owner, or a sibling repository is refused.
 */
export const ALLOWED_REPOSITORIES = ["hseshadr/almamesh", "gainratio/almamesh"] as const

export type AllowedRepository = (typeof ALLOWED_REPOSITORIES)[number]

/** Today's owner: the default for callers that do not pass the run identity yet. */
export const DEFAULT_REPOSITORY: AllowedRepository = "hseshadr/almamesh"

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
