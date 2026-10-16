import { type JourneyLane, parseJourneyLane } from "./journeyLanes.js"
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

/** The evidence job's candidate artifact name, bound to one lane and one commit (fleet rule artifact-identity). */
export function browserJourneyArtifactName(lane: JourneyLane, commitSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Browser journey commit is invalid.")
  return `${BROWSER_JOURNEY_EVIDENCE}-${parseJourneyLane(lane)}-${commitSha}`
}

export const FETCH_RUN_ARTIFACT_SCRIPT = "scripts/fetch_run_artifact.py"
export const FETCHED_EVIDENCE = "/evidence"

/** The validated inputs for fetching this run's evidence artifact for this commit, and nothing else. */
export interface BrowserJourneyFetchRequest {
  readonly repository: string
  readonly runId: string
  readonly artifact: string
}

/**
 * Validates the caller's inputs into data only. The executable and flags stay
 * literal at the withExec call site (gainratio/ci fleet rule arbitrary-command):
 * a whole argv returned from here would read as caller-controlled command structure.
 */
export function browserJourneyFetchRequest(lane: JourneyLane, repository: string, runId: string, commitSha: string): BrowserJourneyFetchRequest {
  const allowed = requireAllowedRepository(repository)
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new Error("Browser journey run id is invalid.")
  return { repository: allowed, runId, artifact: browserJourneyArtifactName(lane, commitSha) }
}
