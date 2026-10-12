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
 * The one host-side receipt check, run AFTER export by dagger.yml and by the
 * contract tests. Any missing/corrupt/mismatched receipt fails closed.
 */
export const BROWSER_JOURNEY_STATUS_CHECK = "frontend/apps/web/scripts/browserJourneyStatusCheck.mjs"
