import { requireAllowedRepository } from "./repositoryIdentity.js"

/** The one closed output tree exported by the browser-journeys CI job. */
export const BROWSER_JOURNEY_ARTIFACTS = "browser-journeys-artifacts"
export const BROWSER_JOURNEY_EVIDENCE = "browser-journeys-evidence"

export function validateBrowserJourneyExitCode(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error("Browser journey exit status is invalid.")
  }
  return value
}

/** Run on the completed container snapshot, before returning any exportable directory. */
export function browserJourneyEvidenceScript(exitCode: number, commitSha: string): string {
  validateBrowserJourneyExitCode(exitCode)
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Browser journey commit is invalid.")
  const receipt = JSON.stringify({ schemaVersion: 1, commitSha, exitCode, scanned: true })
  return `set -euo pipefail
test -d ${BROWSER_JOURNEY_ARTIFACTS}
test ! -e ${BROWSER_JOURNEY_EVIDENCE}
cp -R ${BROWSER_JOURNEY_ARTIFACTS} ${BROWSER_JOURNEY_EVIDENCE}
printf '%s\\n' '${receipt}' > ${BROWSER_JOURNEY_EVIDENCE}/journey-status.json
bun scripts/artifactLeakScan.mjs ${BROWSER_JOURNEY_EVIDENCE}`
}

/**
 * The one receipt check, run by the Dagger browserJourneysStatus gate on the
 * evidence it fetched back from this run, and by the contract tests. Any
 * missing/corrupt/mismatched receipt fails closed.
 */
export const BROWSER_JOURNEY_STATUS_CHECK = "frontend/apps/web/scripts/browserJourneyStatusCheck.mjs"

/** The evidence job's candidate artifact name, bound to one commit (fleet rule artifact-identity). */
export function browserJourneyArtifactName(commitSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Browser journey commit is invalid.")
  return `${BROWSER_JOURNEY_EVIDENCE}-${commitSha}`
}

export const FETCH_RUN_ARTIFACT_SCRIPT = "scripts/fetch_run_artifact.py"
export const FETCHED_EVIDENCE = "/evidence"

/** argv that downloads this run's evidence artifact for this commit, and nothing else. */
export function browserJourneyFetchArgs(repository: string, runId: string, commitSha: string): string[] {
  const allowed = requireAllowedRepository(repository)
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new Error("Browser journey run id is invalid.")
  return [
    "python3", "/opt/fetch_run_artifact.py", "--repository", allowed, "--run-id", runId,
    "--name", browserJourneyArtifactName(commitSha), "--output", FETCHED_EVIDENCE,
  ]
}
